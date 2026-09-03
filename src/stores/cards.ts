import { create } from "zustand"
import { createCard, deleteCard, getDueCards, listCards, reviewCard, updateCard } from "@/db/cards"
import type { CardInput, CardUpdateInput, KnowledgeCardWithReview, ReviewRating } from "@/db/cards"
import { fetchAi } from "@/lib/ai/chat"
import { calculateGenerationCoverage, splitCardGenerationText } from "@/lib/card-generation-chunks.mjs"

// 用户可见的直接制卡链路：来源文本 -> AI 卡片 -> knowledge_cards。
// 它与 scripts/cardmind.py 驱动的 cm_* 结构化知识摄取是两条不同路径。

export interface GeneratedCard {
  question: string
  answer: string
  tags: string[]
  sourceSnippet?: string
}

export interface CardGenerationProgress {
  totalCharacters: number
  processedCharacters: number
  totalChunks: number
  processedChunks: number
  percentage: number
  complete: boolean
}

interface GenerateSource {
  sourceType: CardInput["sourceType"]
  sourceRef?: string | null
  sourceTitle?: string | null
}

interface CardsState {
  cards: KnowledgeCardWithReview[]
  dueCards: KnowledgeCardWithReview[]
  loading: boolean
  generating: boolean
  rawModelOutput: string
  error: string
  generationProgress: CardGenerationProgress | null
  loadCards: () => Promise<void>
  createCard: (input: CardInput) => Promise<void>
  updateCard: (input: CardUpdateInput) => Promise<void>
  deleteCard: (id: number) => Promise<void>
  generateCardsFromText: (text: string, source: GenerateSource) => Promise<GeneratedCard[]>
  getDueCards: (now?: number) => Promise<void>
  reviewCard: (cardId: number, rating: ReviewRating) => Promise<void>
}

function extractJsonArray(text: string) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced?.[1]?.trim() || trimmed
  const start = body.indexOf("[")
  const end = body.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) {
    throw new Error("AI did not return a JSON array.")
  }
  return body.slice(start, end + 1)
}

function normalizeGeneratedCards(value: unknown): GeneratedCard[] {
  if (!Array.isArray(value)) {
    throw new Error("AI JSON result is not an array.")
  }

  return value
    .map((item) => {
      const record = item as Record<string, unknown>
      return {
        question: String(record.question || "").trim(),
        answer: String(record.answer || "").trim(),
        tags: Array.isArray(record.tags) ? record.tags.map(tag => String(tag).trim()).filter(Boolean) : [],
        sourceSnippet: String(record.sourceSnippet || "").trim(),
      }
    })
    .filter(card => card.question && card.answer)
}

function normalizeCardIdentity(value: string) {
  return value.toLowerCase().replace(/[\s，。！？、,.!?：:；;（）()《》<>\-—_]/g, "")
}

const useCardsStore = create<CardsState>((set, get) => ({
  cards: [],
  dueCards: [],
  loading: false,
  generating: false,
  rawModelOutput: "",
  error: "",
  generationProgress: null,

  loadCards: async () => {
    set({ loading: true, error: "" })
    try {
      const [cards, dueCards] = await Promise.all([listCards(), getDueCards(Date.now())])
      set({ cards, dueCards })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Failed to load cards." })
    } finally {
      set({ loading: false })
    }
  },

  createCard: async (input) => {
    await createCard(input)
    await get().loadCards()
  },

  updateCard: async (input) => {
    await updateCard(input)
    await get().loadCards()
  },

  deleteCard: async (id) => {
    await deleteCard(id)
    await get().loadCards()
  },

  generateCardsFromText: async (text, source) => {
    const chunks = splitCardGenerationText(text)
    const initialProgress = calculateGenerationCoverage(chunks, 0)
    set({ generating: true, rawModelOutput: "", error: "", generationProgress: initialProgress })
    try {
      if (chunks.length === 0) {
        throw new Error("当前没有可处理的内容。")
      }

      const outputs: string[] = []
      const mergedCards: GeneratedCard[] = []
      const knownQuestions = new Set<string>()

      for (const [index, chunk] of chunks.entries()) {
        const prompt = [
          `你是 CardMind 的制卡助手。下面是来源内容的第 ${index + 1}/${chunks.length} 个分块。`,
          `请从本分块提取 ${chunks.length === 1 ? "3-5" : "2-4"} 张高质量问答复习卡，不要假设未出现在本分块中的信息。`,
          "要求：只返回 JSON 数组，不要 Markdown，不要解释。数组每项必须包含 question、answer、tags、sourceSnippet。",
          "question 要具体、可复习；answer 要简洁但足以自测；tags 是字符串数组；sourceSnippet 从本分块原文摘取一句相关依据。",
          "先识别学习主线，再识别例子、补充、延伸和进阶内容。",
          "每张卡的 tags 必须包含且只包含一个结构标签：主线 或 衍生。主线卡片按学习顺序组织；衍生卡片复用其所属主线卡片的至少一个主题标签。",
          "除结构标签外，再使用 2-5 个稳定主题词；有关联的卡片应复用相同标签，以便生成知识关系图。",
          `来源类型：${source.sourceType || "article"}`,
          `来源标题：${source.sourceTitle || ""}`,
          "",
          "本分块内容：",
          chunk,
        ].join("\n")

        let output: string
        try {
          output = await fetchAi(prompt)
        } catch (error) {
          throw new Error(`第 ${index + 1}/${chunks.length} 个分块处理失败：${error instanceof Error ? error.message : String(error)}`)
        }
        outputs.push(`--- 分块 ${index + 1}/${chunks.length} ---\n${output}`)

        let cards: GeneratedCard[]
        try {
          cards = normalizeGeneratedCards(JSON.parse(extractJsonArray(output)))
        } catch (error) {
          throw new Error(`第 ${index + 1}/${chunks.length} 个分块返回格式不正确：${error instanceof Error ? error.message : String(error)}`)
        }
        if (cards.length === 0) {
          throw new Error(`第 ${index + 1}/${chunks.length} 个分块没有返回可用卡片。`)
        }

        for (const card of cards) {
          const identity = normalizeCardIdentity(card.question)
          if (!identity || knownQuestions.has(identity)) continue
          knownQuestions.add(identity)
          mergedCards.push(card)
        }

        set({
          rawModelOutput: outputs.join("\n\n"),
          generationProgress: calculateGenerationCoverage(chunks, index + 1),
        })
      }

      if (mergedCards.length === 0) {
        throw new Error("全部分块均已处理，但没有得到可用卡片。")
      }
      return mergedCards
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Failed to generate cards." })
      return []
    } finally {
      set({ generating: false })
    }
  },

  getDueCards: async (now = Date.now()) => {
    const dueCards = await getDueCards(now)
    set({ dueCards })
  },

  reviewCard: async (cardId, rating) => {
    await reviewCard(cardId, rating)
    await get().loadCards()
  },
}))

export default useCardsStore
