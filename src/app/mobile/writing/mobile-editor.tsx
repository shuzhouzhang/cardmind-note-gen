'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TipTapEditor } from '@/app/core/main/editor/markdown/tiptap-editor'
import type { Editor } from '@tiptap/react'
import { Loader2 } from 'lucide-react'
import useArticleStore from '@/stores/article'
import { MarkdownConflictEditor } from '@/app/core/main/editor/markdown/sync/markdown-conflict-editor'

interface MobileEditorProps {
  onEditorReady?: (editor: Editor | null) => void
}

export function MobileEditor({ onEditorReady }: MobileEditorProps) {
  const tEditor = useTranslations('editor')
  const {
    saveCurrentArticle,
    activeFilePath,
    currentArticle,
    loading: articleLoading,
  } = useArticleStore()

  const [content, setContent] = useState('')
  const [isLoading, setIsLoading] = useState(Boolean(activeFilePath))
  const [isEditorReady, setIsEditorReady] = useState(false)
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null)

  const activePathRef = useRef<string>('')
  const contentRef = useRef<string>('')
  const awaitingInitialContentRef = useRef(Boolean(activeFilePath))
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const isSavingRef = useRef(false)

  // 监听 activeFilePath 变化
  useEffect(() => {
    if (activeFilePath && activeFilePath !== activePathRef.current) {
      activePathRef.current = activeFilePath
      awaitingInitialContentRef.current = true
      setIsLoading(true)
      setIsEditorReady(false)
    } else if (!activeFilePath && activePathRef.current) {
      activePathRef.current = ''
      awaitingInitialContentRef.current = false
      setContent('')
      contentRef.current = ''
      setIsLoading(false)
      setIsEditorReady(false)
      setEditorInstance(null)
    }
  }, [activeFilePath])

  // The article store owns the single disk read. Wait for its completed value so
  // large-document detection never runs against a temporary empty string.
  useEffect(() => {
    if (
      !activeFilePath
      || activePathRef.current !== activeFilePath
      || !awaitingInitialContentRef.current
      || articleLoading
    ) {
      return
    }

    awaitingInitialContentRef.current = false
    setContent(currentArticle)
    contentRef.current = currentArticle
    setIsLoading(false)
  }, [activeFilePath, articleLoading, currentArticle])

  // 保存文件
  const doSave = useCallback(async () => {
    const path = activePathRef.current
    const newContent = contentRef.current

    if (!path || isSavingRef.current || !isEditorReady) {
      return
    }

    isSavingRef.current = true
    try {
      await saveCurrentArticle(newContent, path)
    } finally {
      isSavingRef.current = false
    }
  }, [isEditorReady, saveCurrentArticle])

  // 处理内容变化
  const handleContentChange = useCallback((newContent: string) => {
    setContent(newContent)
    contentRef.current = newContent

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(() => {
      doSave()
    }, 500)
  }, [doSave])

  // 处理编辑器就绪
  const handleEditorReady = useCallback(() => {
    setIsEditorReady(true)
  }, [])

  const handleEditorInstance = useCallback((editor: Editor | null) => {
    setEditorInstance(editor)
    onEditorReady?.(editor)
  }, [onEditorReady])

  // 清理定时器
  useEffect(() => {
    return () => {
      onEditorReady?.(null)
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [onEditorReady])

  // 显示加载状态
  if (isLoading || articleLoading || activeFilePath !== activePathRef.current) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex-1 relative w-full h-full flex flex-col">
      <TipTapEditor
        initialContent={content}
        onChange={handleContentChange}
        placeholder={tEditor('placeholder')}
        activeFilePath={activeFilePath}
        onReady={handleEditorReady}
        onEditorReady={handleEditorInstance}
        mobileMode
        applyLayoutPreferences
        topContent={<MarkdownConflictEditor filePath={activeFilePath} editor={editorInstance} />}
      />
    </div>
  )
}

export default MobileEditor
