use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, SqlitePool};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const MAX_OPERATIONS: usize = 1_500;
const MAX_STATEMENT_BYTES: usize = 32 * 1024;

#[derive(Default)]
pub struct SyncAtomicDatabase {
    pool: Mutex<Option<SqlitePool>>,
}

impl SyncAtomicDatabase {
    async fn get_pool(&self, app: &AppHandle) -> Result<SqlitePool, String> {
        let mut guard = self.pool.lock().await;
        if let Some(pool) = guard.as_ref() {
            return Ok(pool.clone());
        }

        let database_path = app
            .path()
            .app_config_dir()
            .map_err(|error| format!("无法定位同步数据库目录：{error}"))?
            .join("note.db");
        if !database_path.is_file() {
            return Err("同步数据库尚未初始化".into());
        }
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .create_if_missing(false)
            .foreign_keys(true)
            .disable_statement_logging();
        let pool = SqlitePool::connect_with(options)
            .await
            .map_err(|error| format!("无法连接同步数据库：{error}"))?;
        *guard = Some(pool.clone());
        Ok(pool)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAtomicStatement {
    statement: String,
    #[serde(default)]
    values: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAtomicBatchResult {
    rows_affected: u64,
}

fn validate_statement(statement: &str) -> Result<(), String> {
    let normalized = statement.trim().to_ascii_lowercase();
    if statement.len() > MAX_STATEMENT_BYTES {
        return Err("同步原子批处理中的 SQL 过长".into());
    }
    if statement.contains(';') || normalized.contains("--") || normalized.contains("/*") {
        return Err("同步原子批处理不允许多语句或 SQL 注释".into());
    }
    if !(normalized.starts_with("insert ")
        || normalized.starts_with("update ")
        || normalized.starts_with("delete "))
    {
        return Err("同步原子批处理只允许参数化的 INSERT、UPDATE 和 DELETE".into());
    }
    const FORBIDDEN: [&str; 10] = [
        " attach ", " detach ", " pragma ", " vacuum ", " reindex ",
        " sqlite_master", " sqlite_schema", " load_extension", " alter ", " drop ",
    ];
    let padded = format!(" {normalized} ");
    if FORBIDDEN.iter().any(|token| padded.contains(token)) {
        return Err("同步原子批处理包含不允许的 SQLite 操作".into());
    }
    const ALLOWED_TABLES: [&str; 24] = [
        "sync_v2_state", "sync_v2_entities", "sync_v2_outbox", "sync_v2_inbox",
        "sync_v2_apply_journal", "sync_v2_conflicts", "sync_v2_transfers",
        "sync_v2_mutation_journal", "sync_v2_documents", "note_gen_server_sync_objects",
        "note_gen_server_sync_outbox", "note_gen_server_sync_inbox", "tags", "tag_sync_aliases", "marks",
        "canvases", "conversations", "chats", "memories", "notes", "conversation_messages",
        "conversation_tombstones", "settings_sync_state",
        "sync_v2_resource_refs",
    ];
    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    let target = match tokens.as_slice() {
        ["insert", "into", table, ..] => Some(*table),
        ["update", table, ..] => Some(*table),
        ["delete", "from", table, ..] => Some(*table),
        _ => None,
    }
    .map(|table| table.trim_matches(|character: char| character == '`' || character == '"'))
    .map(|table| table.split('(').next().unwrap_or(table));
    if !target.is_some_and(|table| ALLOWED_TABLES.contains(&table)) {
        return Err("同步原子批处理只能修改同步索引或受支持的业务表".into());
    }
    Ok(())
}

fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: &'q Value,
) -> Result<sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>, String> {
    Ok(match value {
        Value::Null => query.bind(Option::<String>::None),
        Value::Bool(value) => query.bind(if *value { 1_i64 } else { 0_i64 }),
        Value::Number(value) if value.is_i64() => query.bind(value.as_i64().unwrap_or_default()),
        Value::Number(value) if value.is_u64() => {
            let number = i64::try_from(value.as_u64().unwrap_or_default())
                .map_err(|_| "同步 SQL 整数超出 SQLite 范围".to_string())?;
            query.bind(number)
        }
        Value::Number(value) => query.bind(value.as_f64().unwrap_or_default()),
        Value::String(value) => query.bind(value),
        Value::Array(_) | Value::Object(_) => query.bind(value.to_string()),
    })
}

#[tauri::command]
pub async fn apply_sync_atomic_batch(
    app: AppHandle,
    database: State<'_, SyncAtomicDatabase>,
    operations: Vec<SyncAtomicStatement>,
) -> Result<SyncAtomicBatchResult, String> {
    if operations.is_empty() || operations.len() > MAX_OPERATIONS {
        return Err(format!("同步原子批处理操作数必须在 1 到 {MAX_OPERATIONS} 之间"));
    }
    for operation in &operations {
        validate_statement(&operation.statement)?;
    }

    let pool = database.get_pool(&app).await?;
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("无法开始同步原子事务：{error}"))?;
    let mut rows_affected = 0_u64;
    for operation in &operations {
        let mut query = sqlx::query(&operation.statement);
        for value in &operation.values {
            query = bind_value(query, value)?;
        }
        let result = query
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("同步原子事务执行失败：{error}"))?;
        rows_affected += result.rows_affected();
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("同步原子事务提交失败：{error}"))?;
    Ok(SyncAtomicBatchResult { rows_affected })
}
