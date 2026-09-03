import OpenAI from 'openai';
import { getAISettings, validateAIService, prepareMessages, createOpenAIClient, handleAIError, convertImageToBase64 } from './utils';

/**
 * 非流式方式获取AI结果
 * @param text 请求文本
 * @param modelType 模型类型（可选）
 * @param messages 消息数组（可选，如果提供则忽略 text 参数）
 */
export async function fetchAi(
  text: string,
  modelType?: string,
  messages?: OpenAI.Chat.ChatCompletionMessageParam[]
): Promise<string> {
  try {
    // 获取AI设置
    const aiConfig = await getAISettings(modelType)

    // 验证AI服务
    if (await validateAIService(aiConfig?.baseURL) === null) return ''

    // 准备消息
    const prepared = await prepareMessages(text, messages)
    const finalMessages = prepared.messages

    const openai = await createOpenAIClient(aiConfig)

    const completion = await openai.chat.completions.create({
      model: aiConfig?.model || '',
      messages: finalMessages,
      temperature: aiConfig?.temperature || 1,
      top_p: aiConfig?.topP || 1,
    })

    return completion.choices[0].message.content || ''
  } catch (error) {
    return handleAIError(error) || ''
  }
}

/**
 * 流式方式获取 AI 结果。Agent Reliability v1 does not expose MCP
 * tools through this generic completion path.
 *
 * @param text 请求文本
 * @param onUpdate 每次收到流式内容时的回调函数
 * @param abortSignal 用于终止请求的信号
 * @param imageUrls 图片 URL 数组（可选）
 * @param onThinkingUpdate 每次收到思考内容时的回调函数（可选）
 * @param messages 消息数组（可选，如果提供则忽略 text 参数）
 */
export async function fetchAiStream(
  text: string,
  onUpdate: (content: string) => void,
  abortSignal?: AbortSignal,
  imageUrls?: string[],
  onThinkingUpdate?: (thinking: string) => void,
  messages?: OpenAI.Chat.ChatCompletionMessageParam[]
): Promise<string> {
  try {
    const aiConfig = await getAISettings()
    const validatedBaseURL = await validateAIService(aiConfig?.baseURL)
    if (validatedBaseURL === null) {
      return ''
    }

    let preparedMessages: OpenAI.Chat.ChatCompletionMessageParam[]
    if (messages && messages.length > 0) {
      const prepared = await prepareMessages('', messages)
      preparedMessages = prepared.messages
    } else {
      const prepared = await prepareMessages(text)
      preparedMessages = prepared.messages
    }

    if (imageUrls && imageUrls.length > 0) {
      const lastMessage = preparedMessages[preparedMessages.length - 1]
      if (lastMessage && lastMessage.role === 'user') {
        const content: OpenAI.Chat.ChatCompletionContentPart[] = []

        for (const imageUrl of imageUrls) {
          try {
            const base64Image = await convertImageToBase64(imageUrl)
            if (base64Image) {
              content.push({
                type: 'image_url',
                image_url: { url: base64Image },
              })
            }
          } catch (error) {
            console.error('Failed to convert image to base64:', error)
          }
        }

        content.push({
          type: 'text',
          text: typeof lastMessage.content === 'string' ? lastMessage.content : '',
        })
        preparedMessages[preparedMessages.length - 1] = {
          role: 'user',
          content,
        }
      }
    }

    const openai = await createOpenAIClient(aiConfig)
    const stream = await openai.chat.completions.create({
      model: aiConfig?.model || '',
      messages: preparedMessages,
      temperature: aiConfig?.temperature,
      top_p: aiConfig?.topP,
      stream: true,
    }, {
      signal: abortSignal,
    }) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

    let thinking = ''
    let fullContent = ''
    for await (const chunk of stream) {
      if (abortSignal?.aborted) break

      const delta = chunk.choices?.[0]?.delta
      const thinkingContent = (delta as { reasoning_content?: string } | undefined)?.reasoning_content || ''
      const content = delta?.content || ''

      if (thinkingContent) {
        thinking += thinkingContent
        onThinkingUpdate?.(thinking)
      }
      if (content) {
        fullContent += content
      }
      onUpdate(fullContent)
    }

    return fullContent
  } catch (error) {
    console.error('[fetchAiStream] Error:', error)
    return handleAIError(error) || ''
  }
}
/**
 * 流式方式获取AI结果，每次返回本次 token
 * @param text 请求文本
 * @param onUpdate 每次收到流式内容时的回调函数
 * @param abortSignal 用于终止请求的信号
 */
export async function fetchAiStreamToken(text: string, onUpdate: (content: string) => void, abortSignal?: AbortSignal): Promise<string> {
  try {
    // 获取AI设置
    const aiConfig = await getAISettings()
    
    // 验证AI服务
    if (await validateAIService(aiConfig?.baseURL) === null) return ''
    
    // 准备消息
    const { messages } = await prepareMessages(text)
  
    const openai = await createOpenAIClient(aiConfig)

    const stream = await openai.chat.completions.create({
      model: aiConfig?.model || '',
      messages: messages,
      temperature: aiConfig?.temperature,
      top_p: aiConfig?.topP,
      stream: true,
    }, {
      signal: abortSignal
    })
    
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        break;
      }
      
      const content = chunk.choices?.[0]?.delta?.content || ''
      if (content) {
        onUpdate(content)
      }
    }
    
    return ''
  } catch (error) {
    return handleAIError(error) || ''
  }
}
