export interface ImportedChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface ImportedChatConversation {
  title: string
  sourceUrl: string | null
  messages: ImportedChatMessage[]
  markdown: string
}

type UnknownRecord = Record<string, unknown>

const CHATGPT_SHARE_PATTERN = /^https:\/\/chatgpt\.com\/share\/[^/?#]+/i

export function isChatGptShareUrl(value: string) {
  return CHATGPT_SHARE_PATTERN.test(value.trim())
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function decodeTurboStream(values: unknown[]) {
  const cache = new Map<number, unknown>()

  function decode(reference: unknown): unknown {
    if (typeof reference !== "number") return reference
    if (reference < 0) return null
    if (cache.has(reference)) return cache.get(reference)

    const value = values[reference]
    if (Array.isArray(value)) {
      const result: unknown[] = []
      cache.set(reference, result)
      value.forEach(item => result.push(decode(item)))
      return result
    }

    if (isRecord(value)) {
      const result: UnknownRecord = {}
      cache.set(reference, result)
      Object.entries(value).forEach(([rawKey, rawValue]) => {
        const key = rawKey.startsWith("_")
          ? String(decode(Number(rawKey.slice(1))))
          : rawKey
        result[key] = decode(rawValue)
      })
      return result
    }

    return value
  }

  return decode(0)
}

function textFromPart(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textFromPart).filter(Boolean).join("\n")
  if (!isRecord(value)) return ""

  for (const key of ["text", "content", "caption", "title"]) {
    const text = textFromPart(value[key])
    if (text) return text
  }
  return ""
}

function messageText(message: UnknownRecord) {
  const content = isRecord(message.content) ? message.content : {}
  const parts = Array.isArray(content.parts) ? content.parts : []
  return parts.map(textFromPart).filter(Boolean).join("\n").trim()
}

function toMarkdown(title: string, messages: ImportedChatMessage[]) {
  return [
    `# ${title}`,
    "",
    ...messages.flatMap(message => [
      `## ${message.role === "user" ? "我" : "GPT"}`,
      "",
      message.content,
      "",
    ]),
  ].join("\n").trim()
}

function findConversationData(root: unknown): UnknownRecord | null {
  if (!isRecord(root)) return null
  const loaderData = isRecord(root.loaderData) ? root.loaderData : null
  if (!loaderData) return null

  for (const route of Object.values(loaderData)) {
    if (!isRecord(route)) continue
    const serverResponse = isRecord(route.serverResponse) ? route.serverResponse : null
    const data = serverResponse && isRecord(serverResponse.data) ? serverResponse.data : null
    if (data && (Array.isArray(data.linear_conversation) || isRecord(data.mapping))) {
      return data
    }
  }
  return null
}

export function parseChatGptShareHtml(html: string, sourceUrl: string): ImportedChatConversation {
  const enqueuePattern = /streamController\.enqueue\(("(?:\\[\s\S]|[^"\\])*")\)/g
  const chunks = Array.from(html.matchAll(enqueuePattern))
  let conversationData: UnknownRecord | null = null

  for (const chunk of chunks) {
    try {
      const serialized = JSON.parse(chunk[1]) as string
      const values = JSON.parse(serialized) as unknown
      if (!Array.isArray(values)) continue
      conversationData = findConversationData(decodeTurboStream(values))
      if (conversationData) break
    } catch {
      // ChatGPT also streams non-JSON bootstrap chunks; skip those.
    }
  }

  if (!conversationData) {
    throw new Error("没有在分享页中找到对话内容。请确认链接仍然公开，或改用“粘贴对话文本”。")
  }

  const linearConversation = Array.isArray(conversationData.linear_conversation)
    ? conversationData.linear_conversation
    : Object.values(isRecord(conversationData.mapping) ? conversationData.mapping : {})

  const messages = linearConversation.flatMap((node): ImportedChatMessage[] => {
    if (!isRecord(node) || !isRecord(node.message)) return []
    const message = node.message
    const author = isRecord(message.author) ? message.author : {}
    const metadata = isRecord(message.metadata) ? message.metadata : {}
    const role = author.role
    if (role !== "user" && role !== "assistant") return []
    if (metadata.is_visually_hidden_from_conversation === true) return []

    const content = messageText(message)
    if (!content || content === "Original custom instructions no longer available") return []
    return [{ role, content }]
  })

  if (messages.length === 0) {
    throw new Error("分享页可以打开，但没有读取到可见的用户或 GPT 消息。")
  }

  const title = String(conversationData.title || "ChatGPT 对话").trim() || "ChatGPT 对话"
  return { title, sourceUrl, messages, markdown: toMarkdown(title, messages) }
}

export function parsePastedChatText(text: string): ImportedChatConversation {
  const normalized = text.trim()
  if (!normalized) throw new Error("请先粘贴对话内容。")

  const markerPattern = /^(?:#{1,3}\s*)?(我|用户|User|GPT|ChatGPT|助手|Assistant)\s*[:：]?\s*$/gim
  const markers = Array.from(normalized.matchAll(markerPattern))
  const messages: ImportedChatMessage[] = []

  markers.forEach((marker, index) => {
    const contentStart = (marker.index || 0) + marker[0].length
    const contentEnd = markers[index + 1]?.index ?? normalized.length
    const content = normalized.slice(contentStart, contentEnd).trim()
    if (!content) return
    const isUser = /^(我|用户|user)$/i.test(marker[1])
    messages.push({ role: isUser ? "user" : "assistant", content })
  })

  if (messages.length === 0) {
    messages.push({ role: "user", content: normalized })
  }

  const title = messages[0].content.replace(/\s+/g, " ").slice(0, 32) || "粘贴的 ChatGPT 对话"
  return { title, sourceUrl: null, messages, markdown: toMarkdown(title, messages) }
}
