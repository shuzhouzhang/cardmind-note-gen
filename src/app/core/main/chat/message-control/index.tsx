import { Chat } from "@/db/chats"
import useChatStore from "@/stores/chat"
import useCardsStore from "@/stores/cards"
import { Brain, Check, XIcon } from "lucide-react"
import { clear, hasText, readText } from "tauri-plugin-clipboard-api"
import { useState } from "react"
import { MessageInfo } from "./message-info"
import { CondensedIndicator } from "./condensed-indicator"
import { TranslateControl } from "./translate-control"
import { CopyControl } from "./copy-control"
import { ReadAloudControl } from "./read-aloud-control"
import { TooltipButton } from "@/components/tooltip-button"
import { useTranslations } from 'next-intl';

export default function MessageControl({chat, children}: {chat: Chat, children: React.ReactNode}) {
  const { deleteChat } = useChatStore()
  const chats = useChatStore((state) => state.chats)
  const createCard = useCardsStore((state) => state.createCard)
  const [translatedContent, setTranslatedContent] = useState<string>('')
  const [savedAsCard, setSavedAsCard] = useState(false)
  const t = useTranslations('common')
  
  async function deleteHandler() {
    if (chat.type === "clipboard" && !chat.image) {
      const hasTextRes = await hasText()
      if (hasTextRes) {
        try {
          const text = await readText()
          if (text === chat.content) {
            await clear()
          }
        } catch {}
      }
    }
    deleteChat(chat.id)
  }

  async function saveAsCard() {
    const answer = chat.content?.trim()
    if (!answer || savedAsCard) return

    const currentIndex = chats.findIndex(item => item.id === chat.id)
    const previousQuestion = chats
      .slice(0, currentIndex)
      .reverse()
      .find(item => item.role === 'user' && item.content?.trim())

    await createCard({
      question: previousQuestion?.content?.trim() || '这段 AI 回答的核心内容是什么？',
      answer,
      tags: ['AI 对话'],
      sourceType: 'chat',
      sourceTitle: 'AI 对话',
      sourceSnippet: answer.slice(0, 240),
    })
    setSavedAsCard(true)
  }

  return (
    <>
      <div className='flex items-center justify-between mt-2'>

        <div className="flex items-center gap-2">
          <MessageInfo chat={chat} />
          <CondensedIndicator chat={chat} />
        </div>

        <div className='flex items-center'>
          {children || null}

          <CopyControl
            chat={chat}
            translatedContent={translatedContent}
          />

          <TranslateControl
            chat={chat}
            onTranslatedContent={setTranslatedContent}
          />

          <ReadAloudControl
            chat={chat}
            translatedContent={translatedContent}
          />

          {chat.role === 'system' && chat.content?.trim() && (
            <TooltipButton
              icon={savedAsCard ? <Check className='size-4 text-emerald-600' /> : <Brain className='size-4' />}
              tooltipText={savedAsCard ? '已保存到卡片库' : '保存为复习卡片'}
              variant={"ghost"}
              size={"icon"}
              disabled={savedAsCard}
              onClick={() => void saveAsCard()}
            />
          )}

          <TooltipButton icon={<XIcon className='size-4' />} tooltipText={t('delete')} variant={"ghost"} size={"icon"} onClick={deleteHandler}/>
        </div>
      </div>

      {/* 显示翻译结果 */}
      {translatedContent && (
        <div className="mt-2 pt-2 border-t border-border">
          <div className="whitespace-pre-wrap">{translatedContent}</div>
        </div>
      )}
    </>
  )
}
