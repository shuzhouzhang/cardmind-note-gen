from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
import uuid
import zipfile
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Iterable


SCHEMA = """
create table if not exists cm_topics (
  id text primary key,
  slug text not null unique,
  title text not null,
  description text not null default '',
  createdAt integer not null,
  updatedAt integer not null
);

create table if not exists cm_conversations (
  id text primary key,
  provider text not null default 'chatgpt',
  externalId text not null,
  title text not null,
  sourceType text not null,
  sourceRef text,
  contentHash text not null,
  createdAt integer,
  updatedAt integer not null,
  importedAt integer not null,
  unique(provider, externalId)
);

create table if not exists cm_messages (
  id text primary key,
  conversationId text not null,
  externalId text not null,
  ordinal integer not null,
  role text not null,
  content text not null,
  contentHash text not null,
  createdAt integer,
  processedAt integer,
  foreign key(conversationId) references cm_conversations(id) on delete cascade,
  unique(conversationId, externalId)
);

create table if not exists cm_conversation_topics (
  conversationId text not null,
  topicId text not null,
  confidence real not null default 1,
  createdAt integer not null,
  primary key(conversationId, topicId),
  foreign key(conversationId) references cm_conversations(id) on delete cascade,
  foreign key(topicId) references cm_topics(id) on delete cascade
);

create table if not exists cm_knowledge_points (
  id text primary key,
  topicId text not null,
  canonicalKey text not null,
  title text not null,
  question text not null,
  answer text not null,
  kind text not null check(kind in ('mainline', 'derived')),
  confidence real not null default 1,
  status text not null default 'active' check(status in ('active', 'quarantine', 'archived')),
  sortOrder real not null default 0,
  createdAt integer not null,
  updatedAt integer not null,
  foreign key(topicId) references cm_topics(id) on delete cascade,
  unique(topicId, canonicalKey)
);

create table if not exists cm_knowledge_sources (
  knowledgePointId text not null,
  messageId text not null,
  excerpt text not null default '',
  createdAt integer not null,
  primary key(knowledgePointId, messageId),
  foreign key(knowledgePointId) references cm_knowledge_points(id) on delete cascade,
  foreign key(messageId) references cm_messages(id) on delete cascade
);

create table if not exists cm_knowledge_edges (
  id text primary key,
  topicId text not null,
  fromPointId text not null,
  toPointId text not null,
  relation text not null,
  strength real not null default 1,
  createdAt integer not null,
  updatedAt integer not null,
  foreign key(topicId) references cm_topics(id) on delete cascade,
  foreign key(fromPointId) references cm_knowledge_points(id) on delete cascade,
  foreign key(toPointId) references cm_knowledge_points(id) on delete cascade,
  unique(topicId, fromPointId, toPointId, relation)
);

create table if not exists cm_ingestion_runs (
  id text primary key,
  sourceRef text,
  status text not null,
  inputConversations integer not null default 0,
  inputMessages integer not null default 0,
  newMessages integer not null default 0,
  createdPoints integer not null default 0,
  updatedPoints integer not null default 0,
  skippedPoints integer not null default 0,
  error text,
  startedAt integer not null,
  finishedAt integer
);

create index if not exists idx_cm_messages_pending on cm_messages(processedAt);
create index if not exists idx_cm_messages_conversation on cm_messages(conversationId, ordinal);
create index if not exists idx_cm_points_topic on cm_knowledge_points(topicId, status, sortOrder);
create index if not exists idx_cm_edges_topic on cm_knowledge_edges(topicId);
create index if not exists idx_cm_runs_started on cm_ingestion_runs(startedAt desc);
"""


@dataclass(frozen=True)
class ImportedMessage:
    external_id: str
    ordinal: int
    role: str
    content: str
    created_at: int | None


@dataclass(frozen=True)
class ImportedConversation:
    external_id: str
    title: str
    created_at: int | None
    updated_at: int | None
    messages: list[ImportedMessage]


def now_ms() -> int:
    return int(time.time() * 1000)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def stable_id(prefix: str, *values: str) -> str:
    digest = sha256_text("\x1f".join(values))[:24]
    return f"{prefix}_{digest}"


def canonical_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(char for char in normalized if char.isalnum())


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    slug = re.sub(r"[^\w\u4e00-\u9fff]+", "-", normalized, flags=re.UNICODE).strip("-")
    return slug or f"topic-{sha256_text(value)[:8]}"


def timestamp_ms(value: Any) -> int | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return int(number if number > 10_000_000_000 else number * 1000)


def default_db_path() -> Path:
    override = os.environ.get("CARDMIND_DATABASE_PATH") or os.environ.get("CARDMIND_DB_PATH")
    if override:
        return Path(override).expanduser().resolve()

    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        return base / "com.cardmind.app" / "note.db"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "com.cardmind.app" / "note.db"
    base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "com.cardmind.app" / "note.db"


def connect_db(path: str | Path | None = None) -> sqlite3.Connection:
    db_path = Path(path) if path else default_db_path()
    db_path = db_path.expanduser().resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row
    connection.execute("pragma foreign_keys = on")
    connection.execute("pragma journal_mode = wal")
    ensure_schema(connection)
    return connection


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA)
    connection.commit()


def _text_from_part(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(filter(None, (_text_from_part(item) for item in value)))
    if not isinstance(value, dict):
        return ""
    for key in ("text", "content", "caption", "title"):
        text = _text_from_part(value.get(key))
        if text:
            return text
    return ""


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, dict):
        parts = content.get("parts", [])
        if isinstance(parts, list):
            return "\n".join(filter(None, (_text_from_part(part) for part in parts))).strip()
        return _text_from_part(content).strip()
    return _text_from_part(content).strip()


def _linear_nodes(conversation: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    mapping = conversation.get("mapping")
    if not isinstance(mapping, dict):
        linear = conversation.get("linear_conversation")
        if isinstance(linear, list):
            return [(str(index), node) for index, node in enumerate(linear) if isinstance(node, dict)]
        return []

    current = conversation.get("current_node")
    if isinstance(current, str) and current in mapping:
        branch: list[tuple[str, dict[str, Any]]] = []
        seen: set[str] = set()
        node_id: str | None = current
        while node_id and node_id in mapping and node_id not in seen:
            seen.add(node_id)
            node = mapping[node_id]
            if not isinstance(node, dict):
                break
            branch.append((node_id, node))
            parent = node.get("parent")
            node_id = parent if isinstance(parent, str) else None
        branch.reverse()
        return branch

    return [(str(node_id), node) for node_id, node in mapping.items() if isinstance(node, dict)]


def parse_chatgpt_conversation(raw: dict[str, Any]) -> ImportedConversation:
    title = str(raw.get("title") or "ChatGPT 对话").strip() or "ChatGPT 对话"
    fallback_identity = f"{title}:{raw.get('create_time')}:{raw.get('update_time')}"
    external_id = str(raw.get("id") or raw.get("conversation_id") or stable_id("chat", fallback_identity))
    messages: list[ImportedMessage] = []

    for node_id, node in _linear_nodes(raw):
        message = node.get("message") if isinstance(node.get("message"), dict) else node
        if not isinstance(message, dict):
            continue
        author = message.get("author") if isinstance(message.get("author"), dict) else {}
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        role = str(author.get("role") or message.get("role") or "")
        if role not in {"user", "assistant"}:
            continue
        if metadata.get("is_visually_hidden_from_conversation") is True:
            continue
        content = _message_text(message)
        if not content or content == "Original custom instructions no longer available":
            continue
        message_id = str(message.get("id") or node_id or stable_id("msg", external_id, str(len(messages)), content))
        messages.append(
            ImportedMessage(
                external_id=message_id,
                ordinal=len(messages),
                role=role,
                content=content,
                created_at=timestamp_ms(message.get("create_time")),
            )
        )

    return ImportedConversation(
        external_id=external_id,
        title=title,
        created_at=timestamp_ms(raw.get("create_time")),
        updated_at=timestamp_ms(raw.get("update_time")),
        messages=messages,
    )


def parse_pasted_chat(text: str, source_name: str = "pasted-chat") -> ImportedConversation:
    normalized = text.strip()
    marker = re.compile(r"^(?:#{1,3}\s*)?(我|用户|User|GPT|ChatGPT|助手|Assistant)\s*[:：]?\s*$", re.I | re.M)
    matches = list(marker.finditer(normalized))
    messages: list[ImportedMessage] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(normalized)
        content = normalized[match.end():end].strip()
        if not content:
            continue
        role = "user" if match.group(1).casefold() in {"我", "用户", "user"} else "assistant"
        # 文本来源没有上游消息 ID，使用来源、顺序和角色保持重导入稳定；
        # 内容变化会更新同一条消息，而不是静默新增一条重复消息。
        external_id = stable_id("msg", source_name, str(index), role)
        messages.append(ImportedMessage(external_id, len(messages), role, content, None))

    if not messages and normalized:
        external_id = stable_id("msg", source_name, "0", "user")
        messages.append(ImportedMessage(external_id, 0, "user", normalized, None))

    title = re.sub(r"\s+", " ", messages[0].content if messages else source_name)[:48] or source_name
    conversation_id = stable_id("chat", source_name)
    return ImportedConversation(conversation_id, title, None, None, messages)


def _json_conversation_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        conversations = value.get("conversations")
        if isinstance(conversations, list):
            return [item for item in conversations if isinstance(item, dict)]
        if "mapping" in value or "linear_conversation" in value:
            return [value]
    raise ValueError("输入 JSON 不是 ChatGPT conversations.json 或单个对话对象")


def load_conversations(path: str | Path) -> list[ImportedConversation]:
    source = Path(path).expanduser().resolve()
    if not source.exists():
        raise FileNotFoundError(f"输入文件不存在: {source}")

    raw_values: list[dict[str, Any]] = []
    if source.suffix.casefold() == ".zip":
        with zipfile.ZipFile(source) as archive:
            candidates = [
                name for name in archive.namelist()
                if re.search(r"(^|/)conversations(?:-\d+)?\.json$", name, re.I)
            ]
            if not candidates:
                raise ValueError("ZIP 中没有找到 conversations.json")
            for name in sorted(candidates):
                with archive.open(name) as handle:
                    raw_values.extend(_json_conversation_list(json.load(handle)))
    elif source.suffix.casefold() == ".json":
        with source.open("r", encoding="utf-8-sig") as handle:
            raw_values = _json_conversation_list(json.load(handle))
    else:
        text = source.read_text(encoding="utf-8-sig")
        return [parse_pasted_chat(text, str(source))]

    conversations = [parse_chatgpt_conversation(raw) for raw in raw_values]
    return [conversation for conversation in conversations if conversation.messages]


def _conversation_hash(conversation: ImportedConversation) -> str:
    payload = "\n".join(
        f"{message.external_id}\x1f{message.role}\x1f{message.content}"
        for message in conversation.messages
    )
    return sha256_text(payload)


def _start_run(connection: sqlite3.Connection, source_ref: str | None) -> tuple[str, int]:
    run_id = f"run_{uuid.uuid4().hex}"
    started_at = now_ms()
    connection.execute(
        "insert into cm_ingestion_runs (id, sourceRef, status, startedAt) values (?, ?, 'running', ?)",
        (run_id, source_ref, started_at),
    )
    connection.commit()
    return run_id, started_at


def ingest_conversations(
    connection: sqlite3.Connection,
    conversations: Iterable[ImportedConversation],
    source_ref: str | None,
    provider: str = "chatgpt",
) -> dict[str, Any]:
    items = list(conversations)
    run_id, _ = _start_run(connection, source_ref)
    input_messages = sum(len(item.messages) for item in items)
    new_messages = 0
    changed_messages = 0
    imported_at = now_ms()

    try:
        with connection:
            for conversation in items:
                conversation_id = stable_id("conv", provider, conversation.external_id)
                content_hash = _conversation_hash(conversation)
                connection.execute(
                    """
                    insert into cm_conversations
                      (id, provider, externalId, title, sourceType, sourceRef, contentHash, createdAt, updatedAt, importedAt)
                    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    on conflict(provider, externalId) do update set
                      title = excluded.title,
                      sourceRef = excluded.sourceRef,
                      contentHash = excluded.contentHash,
                      updatedAt = excluded.updatedAt,
                      importedAt = excluded.importedAt
                    """,
                    (
                        conversation_id,
                        provider,
                        conversation.external_id,
                        conversation.title,
                        "export" if source_ref and source_ref.casefold().endswith((".json", ".zip")) else "text",
                        source_ref,
                        content_hash,
                        conversation.created_at,
                        conversation.updated_at or imported_at,
                        imported_at,
                    ),
                )

                for message in conversation.messages:
                    message_id = stable_id("msg", provider, conversation.external_id, message.external_id)
                    content_hash = sha256_text(f"{message.role}\x1f{message.content}")
                    existing = connection.execute(
                        "select contentHash from cm_messages where conversationId = ? and externalId = ?",
                        (conversation_id, message.external_id),
                    ).fetchone()
                    if existing is None:
                        connection.execute(
                            """
                            insert into cm_messages
                              (id, conversationId, externalId, ordinal, role, content, contentHash, createdAt, processedAt)
                            values (?, ?, ?, ?, ?, ?, ?, ?, null)
                            """,
                            (
                                message_id,
                                conversation_id,
                                message.external_id,
                                message.ordinal,
                                message.role,
                                message.content,
                                content_hash,
                                message.created_at,
                            ),
                        )
                        new_messages += 1
                    elif existing["contentHash"] != content_hash:
                        connection.execute(
                            """
                            update cm_messages
                            set ordinal = ?, role = ?, content = ?, contentHash = ?, createdAt = ?, processedAt = null
                            where conversationId = ? and externalId = ?
                            """,
                            (
                                message.ordinal,
                                message.role,
                                message.content,
                                content_hash,
                                message.created_at,
                                conversation_id,
                                message.external_id,
                            ),
                        )
                        changed_messages += 1

            finished_at = now_ms()
            connection.execute(
                """
                update cm_ingestion_runs
                set status = 'completed', inputConversations = ?, inputMessages = ?, newMessages = ?, finishedAt = ?
                where id = ?
                """,
                (len(items), input_messages, new_messages + changed_messages, finished_at, run_id),
            )
    except Exception as error:
        connection.execute(
            "update cm_ingestion_runs set status = 'failed', error = ?, finishedAt = ? where id = ?",
            (str(error), now_ms(), run_id),
        )
        connection.commit()
        raise

    return {
        "runId": run_id,
        "inputConversations": len(items),
        "inputMessages": input_messages,
        "newMessages": new_messages,
        "changedMessages": changed_messages,
        "pendingMessages": pending_message_count(connection),
    }


def ingest_path(connection: sqlite3.Connection, path: str | Path) -> dict[str, Any]:
    source = str(Path(path).expanduser().resolve())
    return ingest_conversations(connection, load_conversations(source), source)


def ingest_record(connection: sqlite3.Connection, mark_id: int) -> dict[str, Any]:
    if not _table_exists(connection, "marks"):
        raise ValueError("当前数据库没有快速记录表 marks")
    record = connection.execute(
        "select id, content, desc, url from marks where id = ? and deleted = 0",
        (mark_id,),
    ).fetchone()
    if record is None:
        raise ValueError(f"没有找到可导入的记录: {mark_id}")

    content = str(record["content"] or "").strip()
    if not content:
        raise ValueError(f"记录 {mark_id} 没有可导入的正文")

    source_identity = f"cardmind-record:{mark_id}"
    conversation = parse_pasted_chat(content, source_identity)
    description = str(record["desc"] or "").strip()
    title = (description.splitlines()[0].strip() if description else "") or conversation.title
    conversation = replace(conversation, title=title)
    source_ref = str(record["url"] or "").strip() or source_identity
    return ingest_conversations(connection, [conversation], source_ref, provider="cardmind-record")


def pending_message_count(connection: sqlite3.Connection) -> int:
    row = connection.execute("select count(*) as count from cm_messages where processedAt is null").fetchone()
    return int(row["count"] if row else 0)


def pending_conversations(connection: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        select
          c.id as conversationId,
          c.externalId as externalConversationId,
          c.title,
          c.provider,
          c.sourceRef,
          m.id as messageId,
          m.externalId as externalMessageId,
          m.ordinal,
          m.role,
          m.content,
          m.createdAt
        from cm_messages m
        join cm_conversations c on c.id = m.conversationId
        where m.processedAt is null
        order by coalesce(m.createdAt, c.updatedAt), m.ordinal
        limit ?
        """,
        (limit,),
    ).fetchall()
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        conversation = grouped.setdefault(
            row["conversationId"],
            {
                "conversationId": row["conversationId"],
                "externalConversationId": row["externalConversationId"],
                "title": row["title"],
                "provider": row["provider"],
                "sourceRef": row["sourceRef"],
                "messages": [],
            },
        )
        conversation["messages"].append(
            {
                "messageId": row["messageId"],
                "externalMessageId": row["externalMessageId"],
                "ordinal": row["ordinal"],
                "role": row["role"],
                "content": row["content"],
                "createdAt": row["createdAt"],
            }
        )
    return list(grouped.values())


def _resolve_conversation(connection: sqlite3.Connection, value: str | None) -> sqlite3.Row | None:
    if not value:
        return None
    return connection.execute(
        "select * from cm_conversations where id = ? or externalId = ? limit 1",
        (value, value),
    ).fetchone()


def _resolve_message_id(connection: sqlite3.Connection, conversation_id: str | None, value: str) -> str | None:
    if conversation_id:
        row = connection.execute(
            """
            select id from cm_messages
            where conversationId = ? and (id = ? or externalId = ?)
            limit 1
            """,
            (conversation_id, value, value),
        ).fetchone()
    else:
        row = connection.execute(
            "select id from cm_messages where id = ? or externalId = ? limit 1",
            (value, value),
        ).fetchone()
    return str(row["id"]) if row else None


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "select 1 from sqlite_master where type = 'table' and name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _mirror_legacy_card(
    connection: sqlite3.Connection,
    point_id: str,
    topic_title: str,
    topic_slug: str,
    title: str,
    question: str,
    answer: str,
    kind: str,
    status: str,
) -> None:
    if not _table_exists(connection, "knowledge_cards"):
        return
    source_ref = f"cardmind://knowledge/{point_id}"
    timestamp = now_ms()
    tags = json.dumps([kind, topic_slug, topic_title], ensure_ascii=False)
    existing = connection.execute(
        "select id from knowledge_cards where sourceRef = ? order by id limit 1",
        (source_ref,),
    ).fetchone()
    if status != "active":
        if existing:
            connection.execute(
                "update knowledge_cards set deleted = 1, updatedAt = ? where id = ?",
                (timestamp, existing["id"]),
            )
        return
    if existing:
        connection.execute(
            """
            update knowledge_cards
            set question = ?, answer = ?, tagsJson = ?, sourceTitle = ?, sourceSnippet = ?, updatedAt = ?, deleted = 0
            where id = ?
            """,
            (question, answer, tags, topic_title, title, timestamp, existing["id"]),
        )
    else:
        connection.execute(
            """
            insert into knowledge_cards
              (question, answer, tagsJson, sourceType, sourceRef, sourceTitle, sourceSnippet, createdAt, updatedAt, deleted)
            values (?, ?, ?, 'chat', ?, ?, ?, ?, ?, 0)
            """,
            (question, answer, tags, source_ref, topic_title, title, timestamp, timestamp),
        )


def apply_knowledge_payload(connection: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    conversation = _resolve_conversation(connection, payload.get("conversationId"))
    conversation_id = str(conversation["id"]) if conversation else None
    created_points = 0
    updated_points = 0
    skipped_points = 0
    created_edges = 0
    quarantined_points = 0
    processed_message_ids: set[str] = set()
    applied_at = now_ms()

    topics = payload.get("topics")
    if not isinstance(topics, list) or not topics:
        raise ValueError("知识载荷必须包含非空 topics 数组")

    with connection:
        for raw_topic in topics:
            if not isinstance(raw_topic, dict):
                continue
            title = str(raw_topic.get("title") or "").strip()
            if not title:
                raise ValueError("每个主题都必须包含 title")
            slug = slugify(str(raw_topic.get("slug") or title))
            description = str(raw_topic.get("description") or "").strip()
            topic_id = stable_id("topic", slug)
            connection.execute(
                """
                insert into cm_topics (id, slug, title, description, createdAt, updatedAt)
                values (?, ?, ?, ?, ?, ?)
                on conflict(slug) do update set
                  title = excluded.title,
                  description = case when excluded.description <> '' then excluded.description else cm_topics.description end,
                  updatedAt = excluded.updatedAt
                """,
                (topic_id, slug, title, description, applied_at, applied_at),
            )
            topic_row = connection.execute("select id from cm_topics where slug = ?", (slug,)).fetchone()
            topic_id = str(topic_row["id"])
            if conversation_id:
                topic_confidence = float(raw_topic.get("confidence", 1))
                connection.execute(
                    """
                    insert into cm_conversation_topics (conversationId, topicId, confidence, createdAt)
                    values (?, ?, ?, ?)
                    on conflict(conversationId, topicId) do update set confidence = excluded.confidence
                    """,
                    (conversation_id, topic_id, topic_confidence, applied_at),
                )

            key_to_id: dict[str, str] = {}
            points = raw_topic.get("knowledge")
            if not isinstance(points, list):
                points = []
            for index, raw_point in enumerate(points):
                if not isinstance(raw_point, dict):
                    continue
                point_title = str(raw_point.get("title") or raw_point.get("question") or "").strip()
                question = str(raw_point.get("question") or point_title).strip()
                answer = str(raw_point.get("answer") or "").strip()
                if not point_title or not question or not answer:
                    raise ValueError(f"主题 {title} 的第 {index + 1} 个知识点缺少 title/question/answer")
                canonical_key = canonical_text(str(raw_point.get("canonicalKey") or point_title or question))
                if not canonical_key:
                    canonical_key = sha256_text(f"{question}\x1f{answer}")[:24]
                kind = str(raw_point.get("kind") or "derived").casefold()
                if kind not in {"mainline", "derived"}:
                    raise ValueError(f"知识点 {point_title} 的 kind 必须是 mainline 或 derived")
                confidence = max(0.0, min(1.0, float(raw_point.get("confidence", 1))))
                status = str(raw_point.get("status") or ("active" if confidence >= 0.85 else "quarantine"))
                if status not in {"active", "quarantine", "archived"}:
                    raise ValueError(f"知识点 {point_title} 的 status 不合法")
                sort_order = float(raw_point.get("sortOrder", index))
                existing = connection.execute(
                    "select * from cm_knowledge_points where topicId = ? and canonicalKey = ?",
                    (topic_id, canonical_key),
                ).fetchone()
                if existing is None:
                    point_id = stable_id("point", topic_id, canonical_key)
                    connection.execute(
                        """
                        insert into cm_knowledge_points
                          (id, topicId, canonicalKey, title, question, answer, kind, confidence, status, sortOrder, createdAt, updatedAt)
                        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            point_id,
                            topic_id,
                            canonical_key,
                            point_title,
                            question,
                            answer,
                            kind,
                            confidence,
                            status,
                            sort_order,
                            applied_at,
                            applied_at,
                        ),
                    )
                    created_points += 1
                else:
                    point_id = str(existing["id"])
                    changed = any(
                        [
                            existing["title"] != point_title,
                            existing["question"] != question,
                            existing["answer"] != answer,
                            existing["kind"] != kind,
                            float(existing["confidence"]) != confidence,
                            existing["status"] != status,
                            float(existing["sortOrder"]) != sort_order,
                        ]
                    )
                    if changed:
                        connection.execute(
                            """
                            update cm_knowledge_points
                            set title = ?, question = ?, answer = ?, kind = ?, confidence = ?, status = ?, sortOrder = ?, updatedAt = ?
                            where id = ?
                            """,
                            (point_title, question, answer, kind, confidence, status, sort_order, applied_at, point_id),
                        )
                        updated_points += 1
                    else:
                        skipped_points += 1
                if status == "quarantine":
                    quarantined_points += 1
                key_to_id[canonical_key] = point_id
                _mirror_legacy_card(connection, point_id, title, slug, point_title, question, answer, kind, status)

                source_ids = raw_point.get("sourceMessageIds")
                if isinstance(source_ids, list):
                    for source_id in source_ids:
                        resolved_id = _resolve_message_id(connection, conversation_id, str(source_id))
                        if not resolved_id:
                            continue
                        excerpt = str(raw_point.get("sourceExcerpt") or "").strip()
                        connection.execute(
                            """
                            insert into cm_knowledge_sources (knowledgePointId, messageId, excerpt, createdAt)
                            values (?, ?, ?, ?)
                            on conflict(knowledgePointId, messageId) do update set excerpt = excluded.excerpt
                            """,
                            (point_id, resolved_id, excerpt, applied_at),
                        )
                        processed_message_ids.add(resolved_id)

            edges = raw_topic.get("edges")
            if not isinstance(edges, list):
                edges = []
            for raw_edge in edges:
                if not isinstance(raw_edge, dict):
                    continue
                from_key = canonical_text(str(raw_edge.get("from") or ""))
                to_key = canonical_text(str(raw_edge.get("to") or ""))
                from_id = key_to_id.get(from_key)
                to_id = key_to_id.get(to_key)
                if not from_id or not to_id or from_id == to_id:
                    continue
                relation = str(raw_edge.get("relation") or "related").strip() or "related"
                strength = max(0.0, min(1.0, float(raw_edge.get("strength", 1))))
                edge_id = stable_id("edge", topic_id, from_id, to_id, relation)
                before = connection.total_changes
                connection.execute(
                    """
                    insert into cm_knowledge_edges
                      (id, topicId, fromPointId, toPointId, relation, strength, createdAt, updatedAt)
                    values (?, ?, ?, ?, ?, ?, ?, ?)
                    on conflict(topicId, fromPointId, toPointId, relation) do update set
                      strength = excluded.strength,
                      updatedAt = excluded.updatedAt
                    """,
                    (edge_id, topic_id, from_id, to_id, relation, strength, applied_at, applied_at),
                )
                if connection.total_changes > before:
                    created_edges += 1

        if processed_message_ids:
            placeholders = ",".join("?" for _ in processed_message_ids)
            connection.execute(
                f"update cm_messages set processedAt = ? where id in ({placeholders})",
                (applied_at, *sorted(processed_message_ids)),
            )

    return {
        "createdPoints": created_points,
        "updatedPoints": updated_points,
        "skippedPoints": skipped_points,
        "createdOrUpdatedEdges": created_edges,
        "quarantinedPoints": quarantined_points,
        "processedMessages": len(processed_message_ids),
        "pendingMessages": pending_message_count(connection),
    }


def load_knowledge_payload(path: str | Path) -> dict[str, Any]:
    with Path(path).expanduser().resolve().open("r", encoding="utf-8-sig") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("知识载荷必须是 JSON 对象")
    return value


def get_status(connection: sqlite3.Connection) -> dict[str, Any]:
    def count(table: str, where: str = "") -> int:
        row = connection.execute(f"select count(*) as count from {table} {where}").fetchone()
        return int(row["count"] if row else 0)

    last_run = connection.execute(
        """
        select id, sourceRef, status, inputConversations, inputMessages, newMessages,
               createdPoints, updatedPoints, skippedPoints, error, startedAt, finishedAt
        from cm_ingestion_runs order by startedAt desc limit 1
        """
    ).fetchone()
    return {
        "topics": count("cm_topics"),
        "conversations": count("cm_conversations"),
        "messages": count("cm_messages"),
        "pendingMessages": count("cm_messages", "where processedAt is null"),
        "knowledgePoints": count("cm_knowledge_points", "where status = 'active'"),
        "quarantinedPoints": count("cm_knowledge_points", "where status = 'quarantine'"),
        "edges": count("cm_knowledge_edges"),
        "lastRun": dict(last_run) if last_run else None,
    }


def list_topics(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        select
          t.id, t.slug, t.title, t.description, t.updatedAt,
          count(distinct case when p.status = 'active' then p.id end) as knowledgePoints,
          count(distinct case when p.status = 'quarantine' then p.id end) as quarantinedPoints,
          count(distinct e.id) as edges
        from cm_topics t
        left join cm_knowledge_points p on p.topicId = t.id
        left join cm_knowledge_edges e on e.topicId = t.id
        group by t.id
        order by t.updatedAt desc, t.title asc
        """
    ).fetchall()
    return [dict(row) for row in rows]


def conversation_to_dict(conversation: ImportedConversation) -> dict[str, Any]:
    value = asdict(conversation)
    value["messages"] = [asdict(message) for message in conversation.messages]
    return value
