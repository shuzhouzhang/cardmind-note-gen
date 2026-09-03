import { getDb } from "./index"

// cm_* 表保存结构化知识、来源与显式关系。
// 当前写入主流程在 scripts/cardmind_engine.py；前端卡片图仍主要读取 knowledge_cards。

export type KnowledgeKind = "mainline" | "derived"
export type KnowledgeStatus = "active" | "quarantine" | "archived"

export interface KnowledgeTopic {
  id: string
  slug: string
  title: string
  description: string
  createdAt: number
  updatedAt: number
}

export async function initKnowledgeEngineDb() {
  const db = await getDb()

  await db.execute(`
    create table if not exists cm_topics (
      id text primary key,
      slug text not null unique,
      title text not null,
      description text not null default '',
      createdAt integer not null,
      updatedAt integer not null
    )
  `)

  await db.execute(`
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
    )
  `)

  await db.execute(`
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
    )
  `)

  await db.execute(`
    create table if not exists cm_conversation_topics (
      conversationId text not null,
      topicId text not null,
      confidence real not null default 1,
      createdAt integer not null,
      primary key(conversationId, topicId),
      foreign key(conversationId) references cm_conversations(id) on delete cascade,
      foreign key(topicId) references cm_topics(id) on delete cascade
    )
  `)

  await db.execute(`
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
    )
  `)

  await db.execute(`
    create table if not exists cm_knowledge_sources (
      knowledgePointId text not null,
      messageId text not null,
      excerpt text not null default '',
      createdAt integer not null,
      primary key(knowledgePointId, messageId),
      foreign key(knowledgePointId) references cm_knowledge_points(id) on delete cascade,
      foreign key(messageId) references cm_messages(id) on delete cascade
    )
  `)

  await db.execute(`
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
    )
  `)

  await db.execute(`
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
    )
  `)

  const indexes = [
    "create index if not exists idx_cm_messages_pending on cm_messages(processedAt)",
    "create index if not exists idx_cm_messages_conversation on cm_messages(conversationId, ordinal)",
    "create index if not exists idx_cm_points_topic on cm_knowledge_points(topicId, status, sortOrder)",
    "create index if not exists idx_cm_edges_topic on cm_knowledge_edges(topicId)",
    "create index if not exists idx_cm_runs_started on cm_ingestion_runs(startedAt desc)",
  ]
  for (const sql of indexes) await db.execute(sql)
}

export async function listKnowledgeTopics() {
  const db = await getDb()
  return db.select<KnowledgeTopic[]>(`
    select id, slug, title, description, createdAt, updatedAt
    from cm_topics
    order by updatedAt desc, title asc
  `)
}
