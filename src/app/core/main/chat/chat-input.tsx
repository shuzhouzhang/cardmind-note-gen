"use client"
import * as React from "react"
import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import useSettingStore from "@/stores/setting"
import { Textarea } from "@/components/ui/textarea"
import useChatStore from "@/stores/chat"
import useMarkStore from "@/stores/mark"
import useArticleStore from "@/stores/article"
import { fetchAiQuickPrompts } from "@/lib/ai/placeholder"
import { useTranslations } from 'next-intl'
import { useLocalStorage } from 'react-use';
import { ModelSelect } from "./model-select"
import { getWorkspacePath } from "@/lib/workspace"
import { ChatSend } from "./chat-send"
import { LinkedFileDisplay } from "./file-link"
import { LinkedResource, MarkdownFile, LinkedFolder } from "@/lib/files"
import { ClipboardMonitor } from "./clipboard-monitor"
import emitter from "@/lib/emitter"
import { ChatToolsDrawer } from "@/app/mobile/chat/components/chat-tools-drawer"
import { useIsMobile } from '@/hooks/use-mobile'
import { ImageAttachments, ImageAttachment } from "./image-attachments"
import { ImageIcon } from "lucide-react"
import { TooltipButton } from "@/components/tooltip-button"
import { isMobileDevice } from '@/lib/check'
import { QuoteDisplay } from "./quote-display"
import type { PendingQuote } from "@/stores/chat"
import { AgentApprovalPanel } from "./agent-approval-panel"
import { cancelPendingAgentAction, confirmPendingAgentAction } from "./agent-approval-actions"
import { convertFileSrc } from "@tauri-apps/api/core"
import { readTextFile, writeFile, BaseDirectory, exists, mkdir, stat } from "@tauri-apps/plugin-fs"
import { ShineBorder } from "@/components/ui/shine-border"
import { toast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { buildTypingFrames } from './onboarding-typing'

const MAX_IMAGE_ATTACHMENTS = 6
const MAX_IMAGE_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024
const IMAGE_ATTACHMENT_DIR = 'screenshot'
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

function getFileName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

function getExtension(fileName: string) {
  return fileName.split('.').pop()?.toLowerCase() || ''
}

function isSupportedImageName(fileName: string) {
  return IMAGE_EXTENSIONS.has(getExtension(fileName))
}

function isSupportedImageType(type: string) {
  return Object.prototype.hasOwnProperty.call(MIME_EXTENSION_MAP, type)
}

function getImageExtension(fileName: string, type: string) {
  const extension = getExtension(fileName)
  if (IMAGE_EXTENSIONS.has(extension)) {
    return extension
  }

  return MIME_EXTENSION_MAP[type] || 'png'
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`
  }

  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`
}

function createImageAttachmentId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// 可排序的工具栏项组件 - 定义在外部以避免每次 ChatInput re-render 时重新创建
interface SortableToolbarItemProps {
  id: string
}

const SortableToolbarItem = React.memo(function SortableToolbarItem({ id }: SortableToolbarItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  // 渲染对应的工具栏组件
  const renderToolbarItem = () => {
    switch (id) {
      case 'modelSelect':
        return <ModelSelect />
      case 'clipboardMonitor':
        return <ClipboardMonitor />
      default:
        return null
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="cursor-grab active:cursor-grabbing"
    >
      {renderToolbarItem()}
    </div>
  )
})
SortableToolbarItem.displayName = 'SortableToolbarItem'


export const ChatInput = React.memo(function ChatInput() {
  const [text, setText] = useState("")
  const { primaryModel, chatToolbarConfigPc, setChatToolbarConfigPc } = useSettingStore()
  const {
    chats,
    loading,
    setLinkedResource: setChatLinkedResource,
    setLinkedResourcePreview,
    onboardingPromptDraft,
    setOnboardingPromptDraft,
    pendingQuote,
    setPendingQuote,
    clearPendingQuote,
    editorSelectionQuote,
    clearEditorSelectionQuote,
    agentState,
  } = useChatStore()
  const { marks, trashState } = useMarkStore()
  const { activeFilePath } = useArticleStore()
  const [isComposing, setIsComposing] = useState(false)
  const [placeholder, setPlaceholder] = useState('')
  const t = useTranslations()
  const defaultPlaceholder = t('record.chat.input.placeholder.default')
  const [inputHistory, setInputHistory] = useLocalStorage<string[]>('chat-input-history', [])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [tempInput, setTempInput] = useState('')
  const [linkedResource, setLinkedResource] = useState<LinkedResource | null>(null)
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([])
  const [isImageDragOver, setIsImageDragOver] = useState(false)
  const chatSendRef = useRef<{ sendChat: () => void } | null>(null)
  const isMobile = useIsMobile()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const placeholderTimerRef = useRef<NodeJS.Timeout | null>(null)
  const placeholderRequestIdRef = useRef(0)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const isMobileDevice_ = isMobileDevice()
  const imageDragDepthRef = useRef(0)
  const onboardingAgentPromptArmedRef = useRef(false)
  const onboardingTypingTimerRefs = useRef<number[]>([])
  const maxImageSizeLabel = formatFileSize(MAX_IMAGE_ATTACHMENT_SIZE_BYTES)
  const activeQuote = pendingQuote || editorSelectionQuote

  const applyTypedText = useCallback((value: string) => {
    setText(value)

    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    window.requestAnimationFrame(() => {
      textarea.style.height = 'auto'
      const newHeight = Math.min(textarea.scrollHeight, 240)
      textarea.style.height = `${newHeight}px`
    })
  }, [])

  // 拖拽传感器配置（仅桌面端）
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 移动8px后才开始拖拽，避免误触
      },
    })
  )


  // 添加输入到历史记录
  function addToHistory(input: string) {
    if (!input.trim()) return
    
    const newHistory = [input, ...(inputHistory || []).filter(item => item !== input)]
    // 限制历史记录数量为50条
    const limitedHistory = newHistory.slice(0, 50)
    setInputHistory(limitedHistory)
  }

  // 处理历史记录导航
  function navigateHistory(direction: 'up' | 'down', currentText: string) {
    if (!inputHistory || inputHistory.length === 0) return

    let newIndex: number
    if (direction === 'up') {
      // 保存当前输入内容（第一次向上时）
      if (historyIndex === -1) {
        setTempInput(currentText)
      }
      newIndex = historyIndex + 1
      if (newIndex >= inputHistory.length) {
        newIndex = inputHistory.length - 1
      }
    } else {
      newIndex = historyIndex - 1
      if (newIndex < -1) {
        newIndex = -1
      }
    }

    setHistoryIndex(newIndex)

    if (newIndex === -1) {
      // 恢复到原本输入的内容
      setText(tempInput)
    } else {
      setText(inputHistory[newIndex])
    }
  }

  // 移除关联文件
  function removeLinkedFile() {
    setLinkedResource(null)
    setChatLinkedResource(null)
  }

  function removeImage(id: string) {
    setAttachedImages(prev => prev.filter(img => img.id !== id))
  }

  function removeQuote() {
    clearPendingQuote()
    clearEditorSelectionQuote()
  }

  function showImageSuccessToast(count: number, key: 'selectSuccess' | 'pasteSuccess' | 'dropSuccess') {
    toast({
      description: t(`record.chat.input.imageAttachment.${key}`, { count })
    })
  }

  function showImageFailureToast(description: string) {
    toast({
      variant: "destructive",
      description
    })
  }

  function showSkippedImageToasts(skipped: {
    unsupported: string[]
    oversized: string[]
    failed: number
  }) {
    if (skipped.unsupported.length === 1) {
      showImageFailureToast(t('record.chat.input.imageAttachment.unsupported', {
        name: skipped.unsupported[0],
      }))
    } else if (skipped.unsupported.length > 1) {
      showImageFailureToast(t('record.chat.input.imageAttachment.unsupportedMultiple', {
        count: skipped.unsupported.length,
      }))
    }

    if (skipped.oversized.length === 1) {
      showImageFailureToast(t('record.chat.input.imageAttachment.oversized', {
        name: skipped.oversized[0],
        size: maxImageSizeLabel,
      }))
    } else if (skipped.oversized.length > 1) {
      showImageFailureToast(t('record.chat.input.imageAttachment.oversizedMultiple', {
        count: skipped.oversized.length,
        size: maxImageSizeLabel,
      }))
    }

    if (skipped.failed === 1) {
      showImageFailureToast(t('record.chat.input.imageAttachment.saveFailed'))
    } else if (skipped.failed > 1) {
      showImageFailureToast(t('record.chat.input.imageAttachment.saveFailedMultiple', {
        count: skipped.failed,
      }))
    }
  }

  function appendImageAttachments(images: ImageAttachment[], successKey: 'selectSuccess' | 'pasteSuccess' | 'dropSuccess') {
    if (images.length === 0) {
      return 0
    }

    const remainingCount = MAX_IMAGE_ATTACHMENTS - attachedImages.length
    if (remainingCount <= 0) {
      showImageFailureToast(t('record.chat.input.imageAttachment.maxCount', {
        count: MAX_IMAGE_ATTACHMENTS,
      }))
      return 0
    }

    const acceptedImages = images.slice(0, remainingCount)
    if (images.length > remainingCount) {
      showImageFailureToast(t('record.chat.input.imageAttachment.maxCount', {
        count: MAX_IMAGE_ATTACHMENTS,
      }))
    }

    setAttachedImages(prev => [...prev, ...acceptedImages])
    showImageSuccessToast(acceptedImages.length, successKey)
    return acceptedImages.length
  }

  async function ensureImageAttachmentDir() {
    const dirExists = await exists(IMAGE_ATTACHMENT_DIR, { baseDir: BaseDirectory.AppData })
    if (!dirExists) {
      await mkdir(IMAGE_ATTACHMENT_DIR, { baseDir: BaseDirectory.AppData })
    }
  }

  async function resolveAppDataFilePath(filePath: string) {
    const { appDataDir, join } = await import('@tauri-apps/api/path')
    const appData = await appDataDir()
    return await join(appData, filePath)
  }

  async function createAttachmentFromBlob(blob: Blob, name: string, source: 'file' | 'paste') {
    const extension = getImageExtension(name, blob.type)
    const fileName = `${source}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`
    const filePath = `${IMAGE_ATTACHMENT_DIR}/${fileName}`
    const arrayBuffer = await blob.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)

    await ensureImageAttachmentDir()
    await writeFile(filePath, uint8Array, { baseDir: BaseDirectory.AppData })

    const fullPath = await resolveAppDataFilePath(filePath)
    return {
      id: createImageAttachmentId(source),
      url: convertFileSrc(fullPath),
      name: fileName,
      source
    } satisfies ImageAttachment
  }

  async function buildAttachmentsFromBrowserFiles(files: File[], source: 'file' | 'paste', maxCount: number) {
    const newImages: ImageAttachment[] = []
    const skipped = {
      unsupported: [] as string[],
      oversized: [] as string[],
      failed: 0,
    }

    for (const file of files) {
      if (newImages.length >= maxCount) {
        break
      }

      const fileName = file.name || `${source}-image`
      if (!isSupportedImageType(file.type) && !isSupportedImageName(fileName)) {
        skipped.unsupported.push(fileName)
        continue
      }

      if (file.size > MAX_IMAGE_ATTACHMENT_SIZE_BYTES) {
        skipped.oversized.push(fileName)
        continue
      }

      try {
        newImages.push(await createAttachmentFromBlob(file, fileName, source))
      } catch (error) {
        console.error('Failed to save image attachment:', error)
        skipped.failed += 1
      }
    }

    showSkippedImageToasts(skipped)
    return newImages
  }

  async function buildAttachmentsFromLocalPaths(paths: string[], maxCount: number) {
    const newImages: ImageAttachment[] = []
    const skipped = {
      unsupported: [] as string[],
      oversized: [] as string[],
      failed: 0,
    }

    for (const path of paths) {
      if (newImages.length >= maxCount) {
        break
      }

      const fileName = getFileName(path)
      if (!isSupportedImageName(fileName)) {
        skipped.unsupported.push(fileName)
        continue
      }

      try {
        const fileStat = await stat(path)
        if (typeof fileStat.size === 'number' && fileStat.size > MAX_IMAGE_ATTACHMENT_SIZE_BYTES) {
          skipped.oversized.push(fileName)
          continue
        }

        newImages.push({
          id: createImageAttachmentId('local'),
          url: convertFileSrc(path),
          name: fileName,
          source: 'file' as const
        })
      } catch (error) {
        console.error('Failed to read selected image:', error)
        skipped.failed += 1
      }
    }

    showSkippedImageToasts(skipped)
    return newImages
  }

  async function handleSelectLocalImages() {
    try {
      if (attachedImages.length >= MAX_IMAGE_ATTACHMENTS) {
        showImageFailureToast(t('record.chat.input.imageAttachment.maxCount', {
          count: MAX_IMAGE_ATTACHMENTS,
        }))
        return
      }

      // 移动端使用 HTML5 file input
      if (isMobileDevice_) {
        imageInputRef.current?.click()
        return
      }

      // PC端使用 Tauri dialog
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: true,
        filters: [{
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
        }]
      })

      if (selected && Array.isArray(selected)) {
        const remainingCount = MAX_IMAGE_ATTACHMENTS - attachedImages.length
        if (selected.length > remainingCount) {
          showImageFailureToast(t('record.chat.input.imageAttachment.maxCount', {
            count: MAX_IMAGE_ATTACHMENTS,
          }))
        }

        const newImages = await buildAttachmentsFromLocalPaths(selected, remainingCount)
        appendImageAttachments(newImages, 'selectSuccess')
      }
    } catch (error) {
      console.error('Failed to select files:', error)
      showImageFailureToast(t('record.chat.input.imageAttachment.selectFailed'))
    }
  }

  // 移动端图片选择，交给系统决定从相册还是相机获取
  async function handleSelectFromGallery() {
    if (attachedImages.length >= MAX_IMAGE_ATTACHMENTS) {
      showImageFailureToast(t('record.chat.input.imageAttachment.maxCount', {
        count: MAX_IMAGE_ATTACHMENTS,
      }))
      return
    }

    if (isMobileDevice_) {
      if (imageInputRef.current) {
        imageInputRef.current.removeAttribute('capture')
        imageInputRef.current.click()
      }
    }
  }

  // 处理移动端文件选择
  async function handleImageInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    try {
      const files = event.target.files
      if (!files || files.length === 0) return

      const selectedFiles = Array.from(files)
      const remainingCount = MAX_IMAGE_ATTACHMENTS - attachedImages.length
      const imageCandidateCount = selectedFiles.filter(file => isSupportedImageType(file.type) || isSupportedImageName(file.name)).length
      if (imageCandidateCount > remainingCount) {
        showImageFailureToast(t('record.chat.input.imageAttachment.maxCount', {
          count: MAX_IMAGE_ATTACHMENTS,
        }))
      }

      const newImages = await buildAttachmentsFromBrowserFiles(selectedFiles, 'file', remainingCount)
      appendImageAttachments(newImages, 'selectSuccess')
      
      // 重置 input
      event.target.value = ''
    } catch (error) {
      console.error('Error in handleImageInputChange:', error)
      showImageFailureToast(t('record.chat.input.imageAttachment.selectFailed'))
    }
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return

    const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'))
    if (imageItems.length === 0) return

    e.preventDefault()

    const files = imageItems
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file))

    const remainingCount = MAX_IMAGE_ATTACHMENTS - attachedImages.length
    const imageCandidateCount = files.filter(file => isSupportedImageType(file.type) || isSupportedImageName(file.name)).length
    if (imageCandidateCount > remainingCount) {
      showImageFailureToast(t('record.chat.input.imageAttachment.maxCount', {
        count: MAX_IMAGE_ATTACHMENTS,
      }))
    }

    const newImages = await buildAttachmentsFromBrowserFiles(files, 'paste', remainingCount)
    appendImageAttachments(newImages, 'pasteSuccess')
  }

  function hasImageTransfer(dataTransfer: DataTransfer) {
    const items = Array.from(dataTransfer.items || [])
    if (items.some(item => item.kind === 'file' && isSupportedImageType(item.type))) {
      return true
    }

    return Array.from(dataTransfer.files || []).some(file => isSupportedImageType(file.type) || isSupportedImageName(file.name))
  }

  function hasFileTransfer(dataTransfer: DataTransfer) {
    const items = Array.from(dataTransfer.items || [])
    return items.some(item => item.kind === 'file') || Array.from(dataTransfer.files || []).length > 0
  }

  function handleImageDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (loading || !primaryModel || !hasFileTransfer(e.dataTransfer)) {
      return
    }

    e.preventDefault()
    if (!hasImageTransfer(e.dataTransfer)) {
      return
    }

    imageDragDepthRef.current += 1
    setIsImageDragOver(true)
  }

  function handleImageDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (loading || !primaryModel || !hasFileTransfer(e.dataTransfer)) {
      return
    }

    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (hasImageTransfer(e.dataTransfer)) {
      setIsImageDragOver(true)
    }
  }

  function handleImageDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!isImageDragOver && !hasImageTransfer(e.dataTransfer)) {
      return
    }

    imageDragDepthRef.current = Math.max(0, imageDragDepthRef.current - 1)
    if (imageDragDepthRef.current === 0) {
      setIsImageDragOver(false)
    }
  }

  async function handleImageDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!hasFileTransfer(e.dataTransfer)) {
      imageDragDepthRef.current = 0
      setIsImageDragOver(false)
      return
    }

    e.preventDefault()
    imageDragDepthRef.current = 0
    setIsImageDragOver(false)

    if (loading || !primaryModel) {
      return
    }

    const files = Array.from(e.dataTransfer.files || [])
    const remainingCount = MAX_IMAGE_ATTACHMENTS - attachedImages.length
    const imageCandidateCount = files.filter(file => isSupportedImageType(file.type) || isSupportedImageName(file.name)).length
    if (imageCandidateCount > remainingCount) {
      showImageFailureToast(t('record.chat.input.imageAttachment.maxCount', {
        count: MAX_IMAGE_ATTACHMENTS,
      }))
    }

    const newImages = await buildAttachmentsFromBrowserFiles(files, 'file', remainingCount)
    appendImageAttachments(newImages, 'dropSuccess')
  }

  // 处理发送后的清理工作
  function handleSent() {
    if (onboardingAgentPromptArmedRef.current) {
      onboardingAgentPromptArmedRef.current = false
      emitter.emit('onboarding-step-complete', { step: 'ai-polish' })
    }
    addToHistory(text)
    setText('')
    setHistoryIndex(-1)
    setAttachedImages([])
    clearPendingQuote()
    if (isMobileDevice_) {
      clearEditorSelectionQuote()
    }
    const textarea = document.querySelector('textarea')
    if (textarea) {
      textarea.style.height = 'auto'
    }
  }

  const normalizePlaceholderText = useCallback((value: unknown) => {
    return typeof value === 'string' ? value.trim() : ''
  }, [])

  // 获取输入框占位符
  const genInputPlaceholder = useCallback(async () => {
    const requestId = placeholderRequestIdRef.current + 1
    placeholderRequestIdRef.current = requestId
    setPlaceholder(defaultPlaceholder)

    if (!primaryModel) return
    if (trashState) return
    const lastClearIndex = chats.findLastIndex(item => item.type === 'clear')
    const chatsAfterClear = chats.slice(lastClearIndex + 1)
    const request_content = `
      ${chatsAfterClear.slice(0, 5).map(item => item.content?.slice(0, 60)).join(';\n\n')}
    `.trim()

    try {
      // 使用 fetchAiQuickPrompts 获取4条提示词
      const prompts = await fetchAiQuickPrompts(request_content)
      if (requestId !== placeholderRequestIdRef.current) {
        return
      }

      const validPrompts = prompts
        .map(prompt => ({
          ...prompt,
          text: normalizePlaceholderText(prompt.text),
        }))
        .filter(prompt => prompt.text.length > 0)

      // 发送事件给 chat-empty 组件，显示前3条
      if (validPrompts.length >= 3) {
        emitter.emit('ai-prompts-generated', validPrompts)
      }

      // 取第4条作为 placeholder
      const placeholderText = validPrompts[3]?.text
      setPlaceholder(placeholderText ? `${placeholderText} [Tab]` : defaultPlaceholder)
    } catch {
      if (requestId === placeholderRequestIdRef.current) {
        setPlaceholder(defaultPlaceholder)
      }
    }
  }, [chats, defaultPlaceholder, normalizePlaceholderText, primaryModel, trashState])

  // 防抖的 placeholder 生成函数，延迟 1.5 秒执行，只执行最后一次
  const debouncedGenPlaceholder = useCallback(() => {
    // 清除之前的定时器
    if (placeholderTimerRef.current) {
      clearTimeout(placeholderTimerRef.current)
    }
    placeholderRequestIdRef.current += 1
    setPlaceholder(defaultPlaceholder)
    
    // 设置新的定时器
    placeholderTimerRef.current = setTimeout(() => {
      genInputPlaceholder()
    }, 1500) // 1.5秒延迟
  }, [defaultPlaceholder, genInputPlaceholder])


  // 插入占位符
  function insertPlaceholder() {
    if (placeholder.includes('[Tab]')) {
      setText(placeholder.replace('[Tab]', ''))
      placeholderRequestIdRef.current += 1
      setPlaceholder(defaultPlaceholder)
    }
  }

  // 处理拖拽结束（底部工具栏）
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      const enabledItems = chatToolbarConfigPc.filter(item => item.enabled)
      const oldIndex = enabledItems.findIndex((item) => item.id === active.id)
      const newIndex = enabledItems.findIndex((item) => item.id === over.id)

      const reorderedItems = arrayMove(enabledItems, oldIndex, newIndex)
      const allItems = [...chatToolbarConfigPc]

      reorderedItems.forEach((item, index) => {
        const globalIndex = allItems.findIndex(i => i.id === item.id)
        if (globalIndex !== -1) {
          allItems[globalIndex] = { ...item, order: enabledItems[0].order + index }
        }
      })

      setChatToolbarConfigPc(allItems)
    }
  }, [chatToolbarConfigPc, setChatToolbarConfigPc])

  // 使用 useMemo 优化工具栏项过滤 - 显示底部工具栏（排除 newChat）
  const bottomToolbarItems = useMemo(() => {
    return chatToolbarConfigPc
      .filter(item => item.enabled && ['modelSelect', 'clipboardMonitor'].includes(item.id))
      .sort((a, b) => a.order - b.order)
  }, [chatToolbarConfigPc])

  useEffect(() => {
    // 如果有 marks，生成 AI 提示词作为 placeholder
    if (marks.length > 0) {
      genInputPlaceholder()
    } else {
      setPlaceholder(defaultPlaceholder)
    }
  }, [defaultPlaceholder, genInputPlaceholder, marks, primaryModel])

  useEffect(() => {
    emitter.on('revertChat', (event: unknown) => {
      setText(event as string)
    })
    emitter.on('fileSelected', (event: unknown) => {
      setLinkedResource(event as MarkdownFile)
      setChatLinkedResource(event as MarkdownFile)
    })
    emitter.on('folderSelected', (event: unknown) => {
      setLinkedResource(event as LinkedFolder)
      setChatLinkedResource(event as LinkedFolder)
    })
    emitter.on('insert-quote', (event: unknown) => {
      const data = event as PendingQuote
      setPendingQuote(data)
      // 延迟聚焦到输入框
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 50)
      // 触发防抖的 placeholder 重新生成
      debouncedGenPlaceholder()
    })
    emitter.on('quick-prompt-insert', (prompt: string) => {
      setText(prompt)
      textareaRef.current?.focus()
    })
    emitter.on('ai-placeholder-generated', (event: unknown) => {
      const promptText = normalizePlaceholderText(event)
      setPlaceholder(promptText || defaultPlaceholder)
    })
    return () => {
      if (placeholderTimerRef.current) {
        clearTimeout(placeholderTimerRef.current)
      }
      onboardingTypingTimerRefs.current.forEach((timerId) => window.clearTimeout(timerId))
      onboardingTypingTimerRefs.current = []
      emitter.off('revertChat')
      emitter.off('fileSelected')
      emitter.off('folderSelected')
      emitter.off('insert-quote')
      emitter.off('quick-prompt-insert')
      emitter.off('ai-placeholder-generated')
    }
  }, [debouncedGenPlaceholder, defaultPlaceholder, normalizePlaceholderText, setPendingQuote])

  useEffect(() => {
    if (!onboardingPromptDraft) {
      return
    }

    onboardingAgentPromptArmedRef.current = true
    onboardingTypingTimerRefs.current.forEach((timerId) => window.clearTimeout(timerId))
    onboardingTypingTimerRefs.current = []
    setText('')
    setTimeout(() => {
      textareaRef.current?.focus()
    }, 50)

    const frames = buildTypingFrames(onboardingPromptDraft, 2)
    frames.forEach((frame, index) => {
      const timerId = window.setTimeout(() => {
        applyTypedText(frame)
        if (index === frames.length - 1) {
          onboardingTypingTimerRefs.current = []
          setOnboardingPromptDraft(null)
        }
      }, 160 + index * 42)
      onboardingTypingTimerRefs.current.push(timerId)
    })
  }, [applyTypedText, onboardingPromptDraft, setOnboardingPromptDraft])

  // 生成文件的行号预览（用于 AI 对话）
  async function generateFilePreview(filePath: string, isCustom: boolean, preferEditorContent: boolean = false): Promise<string> {
    try {
      if (preferEditorContent) {
        const editorContent = await new Promise<{
          markdown: string
          totalLines?: number
          numberedLines?: string
          version: number
        } | null>((resolve) => {
          emitter.emit('editor-get-content', {
            resolve: (data: { markdown: string; totalLines?: number; numberedLines?: string; version: number }) => {
              resolve(data)
            },
          })

          window.setTimeout(() => resolve(null), 300)
        })

        if (editorContent?.numberedLines) {
          const numberedLines = editorContent.numberedLines.split('\n')
          const previewLines = numberedLines.slice(0, 100)
          const totalLines = editorContent.totalLines || numberedLines.length
          const truncatedNote = totalLines > 100 ? `\n... (共 ${totalLines} 行，后 ${totalLines - 100} 行省略)` : ''

          return `已关联当前编辑器文件：${filePath.split('/').pop() || filePath}
你可以直接基于下面的行号和版本使用 editor_replace_lines。

编辑器版本：v${editorContent.version}
行号预览：
\`\`\`
${previewLines.join('\n')}
\`\`\`${truncatedNote}

优先使用：
- 修改某个区块/列表：editor_replace_lines({startLine: 4, endLine: 5, replaceContent: "新内容", version: ${editorContent.version}})
- 仅在有精确选区位置时才使用 from/to
`
        }
      }

      // 检查文件是否存在
      const fileExists = isCustom
        ? await exists(filePath)
        : await exists(filePath, { baseDir: BaseDirectory.AppData })

      if (!fileExists) {
        return `文件 ${filePath.split('/').pop() || filePath} 不存在或已被删除`
      }

      let content: string
      if (isCustom) {
        content = await readTextFile(filePath)
      } else {
        content = await readTextFile(filePath, { baseDir: BaseDirectory.AppData })
      }

      const lines = content.split('\n')
      const previewLines = lines.slice(0, 100).map((line, index) => {
        const lineNum = index + 1
        const preview = line.length > 60 ? line.slice(0, 60) + '...' : line
        return `${String(lineNum).padStart(4)} | ${preview}`
      })

      const totalLines = lines.length
      const truncatedNote = totalLines > 100 ? `\n... (共 ${totalLines} 行，后 ${totalLines - 100} 行省略)` : ''

      return `已关联文件：${filePath.split('/').pop() || filePath}
如需修改这个非当前编辑器文件，请基于完整内容生成更新后的 Markdown，并使用 note_update_file 写入。

行号预览：
\`\`\`
${previewLines.join('\n')}
\`\`\`${truncatedNote}

使用示例：
- 更新文件：note_update_file({filePath: "${filePath}", content: "完整更新后的 Markdown"})
`
    } catch (error) {
      console.error('生成文件预览失败:', error)
      return `已关联文件：${filePath.split('/').pop() || filePath}
（无法读取文件内容）`
    }
  }

  // 自动关联当前打开的 markdown 文件或文件夹
  useEffect(() => {
    async function linkCurrentResource() {
      if (!activeFilePath) {
        setLinkedResource(null)
        setChatLinkedResource(null)
        setLinkedResourcePreview(null)
        return
      }

      const workspace = await getWorkspacePath()

      // 检查是否是支持的文件类型（包括 markdown、代码文件等）
      if (activeFilePath.match(/\.(md|txt|markdown|py|js|ts|jsx|tsx|css|scss|less|html|xml|json|yaml|yml|sh|bash|java|c|cpp|h|go|rs|sql|rb|php|vue|svelte|astro|toml|ini|conf|cfg|gitignore|env|example|template)$/i)) {
        // 文件关联逻辑
        const fileName = activeFilePath.split('/').pop() || activeFilePath

        // 构建完整路径
        let fullPath: string
        if (workspace.isCustom) {
          const pathParts = activeFilePath.split('/')
          fullPath = workspace.path + '/' + pathParts.join('/')
        } else {
          fullPath = activeFilePath
        }

        const resource = {
          name: fileName,
          path: fullPath,
          relativePath: activeFilePath
        }
        setLinkedResource(resource)
        setChatLinkedResource(resource)

        // 生成并设置文件预览
        const preview = await generateFilePreview(fullPath, workspace.isCustom, activeFilePath === resource.relativePath)
        setLinkedResourcePreview(preview)
      } else if (!activeFilePath.includes('.')) {
        // 文件夹关联逻辑 - 只有当路径不包含 . 时才可能是文件夹
        const folderName = activeFilePath.split('/').pop() || activeFilePath

        // 构建完整路径
        let fullPath: string
        if (workspace.isCustom) {
          const pathParts = activeFilePath.split('/')
          fullPath = workspace.path + '/' + pathParts.join('/')
        } else {
          fullPath = activeFilePath
        }

        // 计算文件夹中的文件数量和索引状态
        const { collectMarkdownFiles } = await import('@/lib/files')
        const files = await collectMarkdownFiles(activeFilePath)
        const { vectorIndexedFiles } = useArticleStore.getState()
        const indexedCount = files.filter(f =>
          vectorIndexedFiles.has(f.path)
        ).length

        // 只有在有索引文件时才关联文件夹
        if (indexedCount > 0) {
          const resource = {
            name: folderName,
            path: fullPath,
            relativePath: activeFilePath,
            fileCount: files.length,
            indexedCount: indexedCount
          }
          setLinkedResource(resource)
          setChatLinkedResource(resource)
          // 文件夹不生成行号预览
          setLinkedResourcePreview(null)
        } else {
          // 没有索引文件，清除关联
          setLinkedResource(null)
          setChatLinkedResource(null)
          setLinkedResourcePreview(null)
        }
      } else {
        // 不支持的文件类型（如 .docx, .pdf 等），不进行关联
        setLinkedResource(null)
        setChatLinkedResource(null)
        setLinkedResourcePreview(null)
      }
    }

    linkCurrentResource()
  }, [activeFilePath])

  // 当关联文件变化时，触发防抖的 placeholder 重新生成
  useEffect(() => {
    if (linkedResource) {
      debouncedGenPlaceholder()
    }
  }, [linkedResource, debouncedGenPlaceholder])

  return (
    <footer
      id="onboarding-target-chat-input"
      className={cn(
        "flex w-full flex-col items-center justify-between",
        isMobile ? "px-2 pb-1 pt-0" : "p-1"
      )}
    >
      {/* 移动端图片选择 */}
      {isMobileDevice_ && (
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleImageInputChange}
          className="hidden"
        />
      )}
      <AgentApprovalPanel
        pendingConfirmation={agentState.pendingConfirmation}
        onConfirm={confirmPendingAgentAction}
        onCancel={cancelPendingAgentAction}
      />
      <LinkedFileDisplay
        linkedResource={linkedResource}
        onFileRemove={removeLinkedFile}
        mobileDockStyle={isMobile}
      />
      <div
        className={cn(
          "group relative z-10 flex w-full flex-col overflow-hidden border",
          isMobile
            ? "mobile-dock-surface gap-1 rounded-[1.35rem] p-1.5 transition-[background-color,border-color,transform] duration-200 focus-within:border-border/80"
            : "gap-1 rounded-xl bg-background p-1 transition-colors focus-within:border-primary",
          isImageDragOver && (
            isMobile
              ? "border-primary/50 bg-[hsl(var(--component-active-bg))]"
              : "border-primary bg-primary/5"
          )
        )}
        onDragEnter={handleImageDragEnter}
        onDragOver={handleImageDragOver}
        onDragLeave={handleImageDragLeave}
        onDrop={handleImageDrop}
      >
        {loading && (
          <ShineBorder
            borderWidth={1}
            duration={5}
            shineColor={["#FF6B6B", "#4ECDC4", "#45B7D1", "#FFA07A"]}
          />
        )}
        {isImageDragOver && (
          <div
            className={cn(
              "pointer-events-none absolute inset-0 z-20 flex items-center justify-center",
              isMobile ? "bg-background/60 backdrop-blur-xl" : "bg-background/80 backdrop-blur-[1px]"
            )}
          >
            <div
              className={cn(
                "flex items-center gap-2 border px-3 py-2 text-sm text-foreground",
                isMobile ? "mobile-dock-surface rounded-2xl" : "rounded-md bg-background shadow-sm"
              )}
            >
              <ImageIcon className="size-4 text-primary" />
              <span>{t('record.chat.input.imageAttachment.dropHint')}</span>
            </div>
          </div>
        )}
        {activeQuote && (
          <QuoteDisplay quoteData={activeQuote} onRemove={removeQuote} />
        )}
        <ImageAttachments images={attachedImages} onRemove={removeImage} />
        <div className="relative w-full flex items-start">
          <Textarea
            ref={textareaRef}
            className={cn(
              "relative flex-1 resize-none overflow-y-auto border-none p-2 shadow-none focus-visible:ring-0",
              isMobile
                ? "min-h-[40px] max-h-[220px] bg-transparent text-sm placeholder:text-sm"
                : "min-h-[36px] max-h-[240px] text-xs placeholder:text-sm md:placeholder:text-sm md:text-sm"
            )}
            rows={1}
            disabled={!primaryModel || loading}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              const textarea = e.target
              textarea.style.height = 'auto'
              const newHeight = Math.min(textarea.scrollHeight, 240)
              textarea.style.height = `${newHeight}px`
            }}
            placeholder={placeholder || defaultPlaceholder}
            onKeyDown={(e) => {
              const textarea = e.target as HTMLTextAreaElement
              const cursorPosition = textarea.selectionStart
              const isAtStart = cursorPosition === 0
              const isAtEnd = cursorPosition === text.length

              if (e.key === "Enter" && !isComposing && !e.shiftKey && e.keyCode === 13) {
                e.preventDefault()
                chatSendRef.current?.sendChat()
              }
              if (e.key === "Tab") {
                e.preventDefault()
                insertPlaceholder()
              }
              if (e.key === "ArrowUp" && !isComposing) {
                if (isAtStart) {
                  e.preventDefault()
                  navigateHistory('up', text)
                } else if (isAtEnd) {
                  e.preventDefault()
                  // 移动光标到开头
                  textarea.setSelectionRange(0, 0)
                }
              }
              if (e.key === "ArrowDown" && !isComposing) {
                if (isAtStart) {
                  e.preventDefault()
                  navigateHistory('down', text)
                } else if (isAtEnd) {
                  e.preventDefault()
                  // 移动光标到开头
                  textarea.setSelectionRange(0, 0)
                }
              }
              if (e.key === "Backspace") {
                if (text === '') {
                  setPlaceholder(defaultPlaceholder)
                }
              }
            }}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setTimeout(() => {
              setIsComposing(false)
            }, 0)}
            onPaste={handlePaste}
          />
        </div>
        
        <div className="flex justify-between items-center w-full">
          <div className="flex-1">
            {/* 可拖拽排序的按钮容器（桌面端）或普通容器（移动端） */}
            {!isMobile ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={bottomToolbarItems.map(item => item.id)}
                  strategy={horizontalListSortingStrategy}
                >
                  <div className="flex overflow-x-auto scrollbar-hide md:overflow-visible">
                    {bottomToolbarItems.map(item => (
                      <SortableToolbarItem
                        key={item.id}
                        id={item.id}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <div className="flex overflow-x-auto scrollbar-hide md:overflow-visible gap-1">
                <ChatToolsDrawer />
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 pr-1">
            <TooltipButton
              variant={isMobile ? "ghost" : "link"}
              size="sm"
              icon={<ImageIcon className="size-4" />}
              tooltipText={t('record.chat.input.attachImage')}
              onClick={isMobile ? handleSelectFromGallery : handleSelectLocalImages}
              disabled={!primaryModel || loading}
              buttonClassName={isMobile ? "rounded-2xl text-[hsl(var(--component-inactive-color))] hover:bg-[hsl(var(--component-active-bg))] hover:text-foreground" : undefined}
            />
            <ChatSend inputValue={text} onSent={handleSent} linkedResource={linkedResource} attachedImages={attachedImages} quoteData={activeQuote} dockStyle={isMobile} ref={chatSendRef} />
          </div>
        </div>

      </div>
    </footer>
  )
})
ChatInput.displayName = 'ChatInput'
