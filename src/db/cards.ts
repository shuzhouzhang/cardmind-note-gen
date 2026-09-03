import { getDb } from "./index"

export type CardSourceType = "article" | "record" | "chat" | "manual"
export type ReviewRating = "again" | "hard" | "good" | "easy"

export interface KnowledgeCard {
  id: number
  question: string
  answer: string
  tagsJson: string
  sourceType: CardSourceType
  sourceRef: string | null
  sourceTitle: string | null
  sourceSnippet: string | null
  createdAt: number
  updatedAt: number
  deleted: number
}

export interface KnowledgeCardWithReview extends KnowledgeCard {
  reviewCount: number
  intervalDays: number
  easeFactor: number
  dueAt: number | null
  lastReviewedAt: number | null
  lastRating: ReviewRating | null
}

export interface CardInput {
  question: string
  answer: string
  tags?: string[]
  sourceType?: CardSourceType
  sourceRef?: string | null
  sourceTitle?: string | null
  sourceSnippet?: string | null
}

export interface CardUpdateInput extends CardInput {
  id: number
}

export async function initCardsDb() {
  const db = await getDb()

  await db.execute(`
    create table if not exists knowledge_cards (
      id integer primary key autoincrement,
      question text not null,
      answer text not null,
      tagsJson text not null default '[]',
      sourceType text not null default 'manual',
      sourceRef text default null,
      sourceTitle text default null,
      sourceSnippet text default null,
      createdAt integer not null,
      updatedAt integer not null,
      deleted integer not null default 0
    )
  `)

  await db.execute(`
    create table if not exists card_reviews (
      id integer primary key autoincrement,
      cardId integer not null,
      rating text not null,
      reviewedAt integer not null,
      intervalDays integer not null,
      easeFactor real not null,
      dueAt integer not null,
      foreign key(cardId) references knowledge_cards(id) on delete cascade
    )
  `)

  await db.execute("create index if not exists idx_knowledge_cards_deleted on knowledge_cards(deleted)")
  await db.execute("create index if not exists idx_card_reviews_card_id on card_reviews(cardId)")
  await db.execute("create index if not exists idx_card_reviews_due_at on card_reviews(dueAt)")
}

function normalizeTags(tags?: string[]) {
  return JSON.stringify((tags || []).map(tag => tag.trim()).filter(Boolean))
}

function cardSelectSql(where = "") {
  return `
    select
      c.*,
      (
        select count(*)
        from card_reviews review_count
        where review_count.cardId = c.id
      ) as reviewCount,
      coalesce(r.intervalDays, 0) as intervalDays,
      coalesce(r.easeFactor, 2.5) as easeFactor,
      r.dueAt as dueAt,
      r.reviewedAt as lastReviewedAt,
      r.rating as lastRating
    from knowledge_cards c
    left join (
      select cr.*
      from card_reviews cr
      inner join (
        select cardId, max(reviewedAt) as maxReviewedAt
        from card_reviews
        group by cardId
      ) latest on latest.cardId = cr.cardId and latest.maxReviewedAt = cr.reviewedAt
    ) r on r.cardId = c.id
    ${where}
  `
}

export async function listCards() {
  const db = await getDb()
  return await db.select<KnowledgeCardWithReview[]>(
    `${cardSelectSql("where c.deleted = 0")} order by c.updatedAt desc`
  )
}

export async function createCard(input: CardInput) {
  const db = await getDb()
  const now = Date.now()
  return await db.execute(
    `insert into knowledge_cards
      (question, answer, tagsJson, sourceType, sourceRef, sourceTitle, sourceSnippet, createdAt, updatedAt, deleted)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)`,
    [
      input.question.trim(),
      input.answer.trim(),
      normalizeTags(input.tags),
      input.sourceType || "manual",
      input.sourceRef || null,
      input.sourceTitle || null,
      input.sourceSnippet || null,
      now,
      now,
    ]
  )
}

export async function updateCard(input: CardUpdateInput) {
  const db = await getDb()
  return await db.execute(
    `update knowledge_cards
     set question = $1,
         answer = $2,
         tagsJson = $3,
         sourceType = $4,
         sourceRef = $5,
         sourceTitle = $6,
         sourceSnippet = $7,
         updatedAt = $8
     where id = $9 and deleted = 0`,
    [
      input.question.trim(),
      input.answer.trim(),
      normalizeTags(input.tags),
      input.sourceType || "manual",
      input.sourceRef || null,
      input.sourceTitle || null,
      input.sourceSnippet || null,
      Date.now(),
      input.id,
    ]
  )
}

export async function deleteCard(id: number) {
  const db = await getDb()
  return await db.execute(
    "update knowledge_cards set deleted = 1, updatedAt = $1 where id = $2",
    [Date.now(), id]
  )
}

export async function getDueCards(now = Date.now()) {
  const db = await getDb()
  return await db.select<KnowledgeCardWithReview[]>(
    `${cardSelectSql("where c.deleted = 0 and (r.dueAt is null or r.dueAt <= $1)")} order by coalesce(r.dueAt, c.createdAt) asc`,
    [now]
  )
}

export async function reviewCard(cardId: number, rating: ReviewRating) {
  const db = await getDb()
  const previous = (await db.select<Array<{
    intervalDays: number
    easeFactor: number
    reviewCount: number
  }>>(
    `select cr.intervalDays, cr.easeFactor, count(all_reviews.id) as reviewCount
     from card_reviews cr
     left join card_reviews all_reviews on all_reviews.cardId = cr.cardId
     where cr.cardId = $1
     group by cr.id
     order by cr.reviewedAt desc
     limit 1`,
    [cardId]
  ))[0]

  const now = Date.now()
  const lastInterval = previous?.intervalDays || 0
  const lastEase = previous?.easeFactor || 2.5
  const reviewCount = previous?.reviewCount || 0
  const next = calculateSm2Review(rating, lastInterval, lastEase, reviewCount)

  return await db.execute(
    `insert into card_reviews (cardId, rating, reviewedAt, intervalDays, easeFactor, dueAt)
     values ($1, $2, $3, $4, $5, $6)`,
    [cardId, rating, now, next.intervalDays, next.easeFactor, next.dueAt]
  )
}

function calculateSm2Review(
  rating: ReviewRating,
  lastInterval: number,
  lastEase: number,
  reviewCount: number
) {
  let easeFactor = lastEase
  let intervalDays = 1

  if (rating === "again") {
    easeFactor = Math.max(1.3, easeFactor - 0.2)
    intervalDays = 0
  } else if (rating === "hard") {
    easeFactor = Math.max(1.3, easeFactor - 0.15)
    intervalDays = Math.max(1, Math.round(Math.max(1, lastInterval) * 1.2))
  } else if (rating === "good") {
    intervalDays = reviewCount === 0 ? 1 : reviewCount === 1 ? 3 : Math.round(Math.max(1, lastInterval) * easeFactor)
  } else {
    easeFactor = easeFactor + 0.15
    intervalDays = reviewCount === 0 ? 4 : Math.round(Math.max(1, lastInterval) * easeFactor * 1.3)
  }

  const dueAt = rating === "again"
    ? Date.now() + 10 * 60 * 1000
    : Date.now() + intervalDays * 24 * 60 * 60 * 1000

  return { intervalDays, easeFactor, dueAt }
}
