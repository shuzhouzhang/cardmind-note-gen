import React from 'react'
import useChatStore from '@/stores/chat'
import useTagStore from '@/stores/tag'
import { ArrowDownToLine, X, Loader2, QuoteIcon, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Chat } from '@/db/chats'
import ChatPreview from './chat-preview'
import './chat.css'
import { NoteOutput } from './message-control/note-output'
import { MarkText } from './message-control/mark-text'
import { ChatClipboard } from './chat-clipboard'
import MessageControl from './message-control'
import ChatEmpty from './chat-empty'
import { useTranslations } from 'next-intl'
import ChatThinking from './chat-thinking'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { AgentExecutionStatus } from './agent-execution-status'
import { AgentPanelWithRag } from './agent-panel-with-rag'
import { AgentChangesPanel } from './agent-changes-panel'
import { ChatImages } from "./chat-images"
import { useIsMobile } from '@/hooks/use-mobile'
import type { AgentChange } from '@/lib/agent/types'

const BOTTOM_THRESHOLD = 24
const USER_SCROLL_GRACE_MS = 300

const ChatContent = React.memo(function ChatContent() {
  const { chats, init, agentState, loading } = useChatStore()
  const { currentTagId } = useTagStore()
  const [isOnBottom, setIsOnBottom] = useState(true)
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const bottomAnchorRef = React.useRef<HTMLDivElement>(null)
  const programmaticScrollRef = React.useRef(false)
  const autoScrollEnabledRef = React.useRef(true)
  const delayedScrollTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastUserScrollAtRef = React.useRef(0)

  const isNearBottom = useCallback((element: Element) => {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD
  }, [])

  const handleScroll = useCallback(() => {
    const md = wrapperRef.current
    if (!md) return

    const onBottom = isNearBottom(md)
    setIsOnBottom(onBottom)

    if (programmaticScrollRef.current) {
      if (onBottom) {
        programmaticScrollRef.current = false
      }
      return
    }

    const isLikelyUserScroll = Date.now() - lastUserScrollAtRef.current < USER_SCROLL_GRACE_MS

    // 只有用户主动离开底部时才关闭自动滚动
    if (onBottom) {
      setAutoScrollEnabled(true)
    } else if (isLikelyUserScroll) {
      setAutoScrollEnabled(false)
    }
  }, [isNearBottom])

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollAtRef.current = Date.now()
  }, [])

  const performAutoScroll = useCallback(() => {
    programmaticScrollRef.current = true
    bottomAnchorRef.current?.scrollIntoView({ block: 'end' })
    setIsOnBottom(true)

    requestAnimationFrame(() => {
      setTimeout(() => {
        programmaticScrollRef.current = false
        const md = wrapperRef.current
        if (md) {
          setIsOnBottom(isNearBottom(md))
        }
      }, 0)
    })

    if (delayedScrollTimeoutRef.current) {
      clearTimeout(delayedScrollTimeoutRef.current)
    }

    delayedScrollTimeoutRef.current = setTimeout(() => {
      if (!autoScrollEnabledRef.current) return

      programmaticScrollRef.current = true
      bottomAnchorRef.current?.scrollIntoView({ block: 'end' })
      setIsOnBottom(true)

      requestAnimationFrame(() => {
        setTimeout(() => {
          programmaticScrollRef.current = false
          const md = wrapperRef.current
          if (md) {
            setIsOnBottom(isNearBottom(md))
          }
        }, 0)
      })
    }, 500)
  }, [isNearBottom])

  // 手动滚动到底部并启用自动滚动
  const handleScrollToBottom = useCallback(() => {
    performAutoScroll()
    setAutoScrollEnabled(true)
  }, [performAutoScroll])

  useEffect(() => {
    const md = wrapperRef.current
    if (!md) return

    const handleTouchStart = () => markUserScrollIntent()
    const handleTouchMove = () => markUserScrollIntent()
    const handleWheel = () => markUserScrollIntent()
    const handlePointerDown = () => markUserScrollIntent()

    md.addEventListener('scroll', handleScroll)
    md.addEventListener('touchstart', handleTouchStart, { passive: true })
    md.addEventListener('touchmove', handleTouchMove, { passive: true })
    md.addEventListener('wheel', handleWheel, { passive: true })
    md.addEventListener('pointerdown', handlePointerDown, { passive: true })

    return () => {
      md.removeEventListener('scroll', handleScroll)
      md.removeEventListener('touchstart', handleTouchStart)
      md.removeEventListener('touchmove', handleTouchMove)
      md.removeEventListener('wheel', handleWheel)
      md.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [handleScroll, markUserScrollIntent])

  useEffect(() => {
    init(currentTagId)
  }, [currentTagId, init])

  useEffect(() => {
    autoScrollEnabledRef.current = autoScrollEnabled
  }, [autoScrollEnabled])

  useEffect(() => {
    const md = wrapperRef.current
    const content = contentRef.current
    if (!md || !content) return

    const syncScrollState = () => {
      const onBottom = isNearBottom(md)

      if (autoScrollEnabled) {
        performAutoScroll()
        return
      }

      setIsOnBottom(onBottom)
    }

    const observer = new ResizeObserver(syncScrollState)
    const mutationObserver = new MutationObserver(() => {
      syncScrollState()
    })

    observer.observe(content)
    mutationObserver.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    return () => {
      observer.disconnect()
      mutationObserver.disconnect()
    }
  }, [autoScrollEnabled, isNearBottom, performAutoScroll])

  // 监听消息变化，仅在启用自动滚动时才滚动
  useEffect(() => {
    if (autoScrollEnabled) {
      performAutoScroll()
    }
  }, [chats, autoScrollEnabled, performAutoScroll])

  // Agent 执行时，仅在启用自动滚动时才滚动到底部
  useEffect(() => {
    if (autoScrollEnabled && agentState.isRunning) {
      performAutoScroll()
    }
  }, [agentState.currentThought, agentState.thoughtHistory, agentState.traceEvents, agentState.changes, agentState.pendingConfirmation, agentState.isRunning, autoScrollEnabled, performAutoScroll])

  // Loading 状态变化时，仅在启用自动滚动时才滚动到底部
  useEffect(() => {
    if (autoScrollEnabled && loading) {
      performAutoScroll()
    }
  }, [loading, autoScrollEnabled, performAutoScroll])

  useEffect(() => {
    return () => {
      if (delayedScrollTimeoutRef.current) {
        clearTimeout(delayedScrollTimeoutRef.current)
      }
    }
  }, [])

  // 判断是否应该显示 loading：loading=true 且最后一个 AI 消息还没有内容
  const shouldShowLoading = useMemo(() => {
    if (!loading) return false
    if (agentState.isRunning) return false

    const lastChat = chats[chats.length - 1]
    // 如果最后一个消息是 system 角色且有内容或思考内容，说明 AI 已经开始输出了
    if (lastChat?.role === 'system' && (lastChat.content || lastChat.thinking)) {
      return false
    }

    return true
  }, [loading, agentState.isRunning, chats])

  return <div ref={wrapperRef} id="chats-wrapper" className="relative flex min-h-0 flex-1 flex-col items-end gap-5 overflow-y-auto overflow-x-hidden w-full px-4 py-5 [overflow-anchor:none]">
    <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col items-end gap-5">
      {
        chats.length ? chats.map((chat) => {
          return <Message key={chat.id} chat={chat} />
        }) : <ChatEmpty />
      }

      {/* Loading 指示器 - 服务器等待时显示 */}
      {shouldShowLoading && (
        <div className="flex w-full min-w-0">
          <div className='flex flex-1 items-center gap-2 rounded-xl border border-border/70 bg-background px-4 py-3 text-sm leading-6 text-muted-foreground shadow-sm'>
            <Loader2 className="size-4 animate-spin" />
            <span>正在思考...</span>
          </div>
        </div>
      )}

      <div ref={bottomAnchorRef} className="h-px w-full" />
    </div>

    {
      !isOnBottom && <Button variant="outline" className='sticky bottom-0 size-8 right-0' onClick={handleScrollToBottom}>
        <ArrowDownToLine className='size-4' />
      </Button>
    }
  </div>
})
ChatContent.displayName = 'ChatContent'

const MessageWrapper = React.memo(function MessageWrapper({ chat, children }: { chat: Chat, children: React.ReactNode }) {
  const { deleteChat } = useChatStore()
  const [showDelete, setShowDelete] = useState(false)
  const isMobile = useIsMobile()

  const handleDelete = useCallback(() => {
    deleteChat(chat.id)
  }, [chat.id, deleteChat])
  const shouldShowDelete = showDelete

  // 用户消息：右对齐，用深色气泡与 AI 回复形成明确区分
  if (chat.role === 'user') {
    return (
      <div className="flex w-full justify-end">
        <div
          className="group relative max-w-[86%] rounded-2xl rounded-tr-md bg-foreground px-4 py-3 text-background shadow-sm"
          onMouseEnter={() => {
            if (!isMobile) setShowDelete(true)
          }}
          onMouseLeave={() => {
            if (!isMobile) setShowDelete(false)
          }}
          onClick={() => {
            if (isMobile) setShowDelete((prev) => !prev)
          }}
        >
          <div className='wrap-break-word text-sm leading-6'>
            {children}
          </div>
          {shouldShowDelete && (
            <Button
              onClick={(event) => {
                event.stopPropagation()
                handleDelete()
              }}
              size="icon"
              variant="ghost"
              className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-background border shadow-sm"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    )
  }

  // AI 消息：用稳定的内容卡片承载回答、工具过程与操作区
  return (
    <div className="flex w-full min-w-0">
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-border/70 bg-background px-4 py-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
          <span className="flex size-6 items-center justify-center rounded-lg bg-foreground text-background">
            <Sparkles className="size-3.5" />
          </span>
          <span>CardMind AI</span>
        </div>
        <div className='word-break min-w-0 overflow-hidden text-sm leading-6'>
          {children}
        </div>
      </div>
    </div>
  )
})
MessageWrapper.displayName = 'MessageWrapper'

const Message = React.memo(function Message({ chat }: { chat: Chat }) {
  const t = useTranslations()
  const { chats, deleteChat, loading, agentState } = useChatStore()
  const content = chat.content
  const isActiveAgentMessage = chat.role === 'system' && agentState.activeChatId === chat.id
  const latestChatId = chats[chats.length - 1]?.id
  const isLatestSystemMessage = chat.role === 'system' && latestChatId === chat.id
  const isGeneratingMessage = chat.role === 'system' && (
    (loading && isLatestSystemMessage) ||
    (isActiveAgentMessage && agentState.isRunning)
  )
  const hasLiveAgentTrace = Boolean(
    agentState.completedSteps?.length ||
    agentState.traceEvents?.some((event) => event.type !== 'final') ||
    agentState.changes?.length ||
    agentState.pendingConfirmation
  )
  const isLiveAgentVisible = isActiveAgentMessage && (agentState.isRunning || agentState.isFinalAnswerMode || hasLiveAgentTrace)

  const handleRemoveClearContext = useCallback(() => {
    deleteChat(chat.id)
  }, [chat.id, deleteChat])

  // 解析 RAG 来源
  const ragSources = useMemo(() => {
    if (!chat.ragSources) return []
    try {
      return JSON.parse(chat.ragSources) as string[]
    } catch {
      return []
    }
  }, [chat.ragSources])

  // 解析 RAG 来源详情
  const ragSourceDetails = useMemo(() => {
    if (!chat.ragSourceDetails) return []
    try {
      return JSON.parse(chat.ragSourceDetails) as Array<{
        filepath: string
        filename: string
        content: string
      }>
    } catch {
      return []
    }
  }, [chat.ragSourceDetails])

  // 解析图片数组
  const images = useMemo(() => {
    if (!chat.images) return []
    try {
      return JSON.parse(chat.images) as string[]
    } catch {
      return []
    }
  }, [chat.images])

  const agentHistoryChanges = useMemo(() => {
    if (!chat.agentHistory) return []

    try {
      const parsed = JSON.parse(chat.agentHistory) as { changes?: AgentChange[] }
      return Array.isArray(parsed?.changes) ? parsed.changes : []
    } catch {
      return []
    }
  }, [chat.agentHistory])

  // 解析引用数据
  const quoteData = useMemo(() => {
    if (!chat.quoteData) return null
    try {
      return JSON.parse(chat.quoteData) as {
        quote: string
        fullContent: string
        fileName: string
        startLine: number
        endLine: number
        from: number
        to: number
        articlePath: string
      }
    } catch {
      return null
    }
  }, [chat.quoteData])

  switch (chat.type) {
    case 'clear':
      return <div className="w-full flex justify-center items-center gap-4 px-10">
        <Separator className='flex-1' />
        <div className="flex justify-center items-center gap-2 w-32 group h-8">
          <p className="text-sm text-center text-muted-foreground">{t('record.chat.input.clearContext.tooltip')}</p>
          <X className="size-4 hidden group-hover:flex cursor-pointer" onClick={handleRemoveClearContext} />
        </div>
        <Separator className='flex-1' />
      </div>

    case 'clipboard':
      return <MessageWrapper chat={chat}>
        <ChatClipboard chat={chat} />
      </MessageWrapper>

    case 'note':
      return <MessageWrapper chat={chat}>
        {
          <div className='w-full overflow-x-hidden'>
            <div className='flex justify-between'>
              <p>{t('record.chat.content.organize')}</p>
            </div>
            <ChatThinking chat={chat} />
            {
              <div className={`${content ? 'note-wrapper border w-full overflow-y-auto overflow-x-hidden my-2 p-4 rounded-lg' : ''}`}>
                <ChatPreview text={content || ''} streaming={loading && chat.role === 'system'} />
              </div>
            }
            {!isGeneratingMessage && (
              <MessageControl chat={chat}>
                <NoteOutput chat={chat} />
              </MessageControl>
            )}
          </div>
        }
      </MessageWrapper>

    default:
      // 检查 AI 消息是否有实际内容（没有内容时不渲染）
      const hasContent = chat.role === 'system' && (
        !!content ||
        !!chat.thinking ||
        (chat.agentHistory && chat.agentHistory.length > 0) ||
        ragSources.length > 0 ||
        ragSourceDetails.length > 0 ||
        isLiveAgentVisible
      )

      // 用户消息或有内容的 AI 消息才渲染
      if (chat.role === 'system' && !hasContent) {
        return null
      }

      return <MessageWrapper chat={chat}>
        {chat.role === 'system' ? (
          // AI 消息：所有内容放在一个容器中
          <div className="w-full space-y-4">
            {/* 合并的 RAG 和 Agent 面板 - 只在有 agentHistory 时显示（历史模式） */}
            {/* 实时执行时，RAG 和 Agent 步骤在 AgentExecutionStatusWrapper 中统一显示 */}
            {chat.agentHistory && (
              <AgentPanelWithRag
                ragSources={ragSources}
                ragSourceDetails={ragSourceDetails}
                agentHistoryJson={chat.agentHistory}
                showChanges={false}
              />
            )}

            {isLiveAgentVisible && (
              <div className="space-y-2">
                {(agentState.isRunning || hasLiveAgentTrace) && (
                  <AgentExecutionStatus />
                )}
                {agentState.isFinalAnswerMode && agentState.finalAnswerContent && (
                  <ChatPreview
                    text={agentState.finalAnswerContent}
                    streaming={loading && isActiveAgentMessage}
                  />
                )}
              </div>
            )}

            <ChatThinking chat={chat} />
            <ChatPreview text={content || ''} streaming={loading && isActiveAgentMessage} />
            {!isGeneratingMessage && (
              <AgentChangesPanel changes={isLiveAgentVisible ? agentState.changes || [] : agentHistoryChanges} />
            )}
            {!isGeneratingMessage && (
              <MessageControl chat={chat}>
                <MarkText chat={chat} />
              </MessageControl>
            )}
          </div>
        ) : (
          // 用户消息
          <div className="w-full space-y-3 text-inherit">
            {/* 显示用户消息中的图片 */}
            {images.length > 0 && <ChatImages images={images} />}
            {/* 显示用户消息中的引用 */}
            {quoteData && (
              <div className="flex flex-col gap-1 text-[11px]">
                <div className="flex items-center gap-1">
                  <QuoteIcon className="size-3 text-background/75" />
                  <span className="text-background/75">
                    {quoteData.startLine !== -1 && quoteData.endLine !== -1 ? (
                      quoteData.startLine === quoteData.endLine ? (
                        t('record.chat.quote.lineSingle', { fileName: quoteData.fileName, line: quoteData.startLine })
                      ) : (
                        t('record.chat.quote.lineRange', { fileName: quoteData.fileName, startLine: quoteData.startLine, endLine: quoteData.endLine })
                      )
                    ) : (
                      t('record.chat.quote.noLine', { fileName: quoteData.fileName })
                    )}
                  </span>
                </div>
                <div className="line-clamp-2 whitespace-pre-wrap pl-4 text-background/55">
                  {quoteData.fullContent}
                </div>
              </div>
            )}
            {content && (
              <div className="whitespace-pre-wrap">{content}</div>
            )}
          </div>
        )}
      </MessageWrapper>
  }
})
Message.displayName = 'Message'

export default ChatContent
