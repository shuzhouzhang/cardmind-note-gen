"use client"
import useSettingStore, { GenTemplate, GenTemplateRange } from "@/stores/setting"
import useMarkStore from "@/stores/mark"
import useArticleStore, { type DirTree } from "@/stores/article"
import useTagStore from "@/stores/tag"
import { fetchAiStream } from "@/lib/ai/chat"
import { cn, convertImage } from "@/lib/utils"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { useCallback, useEffect, useMemo, useImperativeHandle, forwardRef, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Store } from "@tauri-apps/plugin-store"
import { Label } from "@/components/ui/label"
import { useSidebarStore } from "@/stores/sidebar"
import { useRouter } from "next/navigation"
import dayjs, { Dayjs } from "dayjs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { useTranslations } from "next-intl"
import { writeTextFile, exists } from "@tauri-apps/plugin-fs"
import { getFilePathOptions, getWorkspacePath } from "@/lib/workspace"
import { joinRelativePath } from "@/lib/path"
import { toast } from "@/hooks/use-toast"
import emitter from "@/lib/emitter"
import { shouldEmitOrganizeOnboardingComplete } from "./organize-onboarding"
import { useIsMobile } from "@/hooks/use-mobile"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { getTemplateRangeLabel } from "@/lib/template-range-utils"
import { ArrowLeft, ArrowRight, Check, ChevronDown, FileText, FolderOpen, Home, ListChecks, Search, Settings2, X, Zap } from "lucide-react"
import type { Mark } from "@/db/marks"
import { MarkItem } from "./mark-item"

function shouldAutoSyncOnInitialRead(options?: { isNewFile?: boolean }) {
  return options?.isNewFile !== true
}

interface OrganizeNotesProps {
  inputValue?: string;
}

type OrganizeStep = 'template' | 'records' | 'settings'

const ROOT_FOLDER_VALUE = '__root__'
const ORGANIZE_STEP_ORDER: OrganizeStep[] = ['template', 'records', 'settings']

function sanitizeMarkdownTitle(title: string) {
  const sanitized = title.trim().replace(/[\/\\:*?"<>|]/g, '_').substring(0, 50)
  return sanitized || '整理笔记'
}

function normalizeOutputFolder(folderValue: string) {
  return folderValue === ROOT_FOLDER_VALUE ? '' : folderValue
}

function buildOutputPath(folder: string, fileName: string) {
  return folder ? joinRelativePath(folder, fileName) : fileName
}

function ensurePreferredHeading(content: string, title: string) {
  const normalizedTitle = title.trim()
  if (!normalizedTitle) return content

  const headingPattern = /^#{1,6}\s+.+$/m
  if (headingPattern.test(content)) {
    return content.replace(headingPattern, `# ${normalizedTitle}`)
  }

  return `# ${normalizedTitle}\n\n${content}`
}

async function getAvailableOutputPath(folder: string, rawTitle: string, isCustomWorkspace: boolean) {
  const sanitizedTitle = sanitizeMarkdownTitle(rawTitle)
  let fileName = `${sanitizedTitle}.md`
  let filePath = buildOutputPath(folder, fileName)
  let pathOptions = await getFilePathOptions(filePath)
  let counter = 1

  while (await exists(pathOptions.path, isCustomWorkspace ? undefined : { baseDir: pathOptions.baseDir })) {
    fileName = `${sanitizedTitle}(${counter}).md`
    filePath = buildOutputPath(folder, fileName)
    pathOptions = await getFilePathOptions(filePath)
    counter++
  }

  return { fileName, filePath, pathOptions, sanitizedTitle }
}

export const OrganizeNotes = forwardRef<{ openOrganize: () => void }, OrganizeNotesProps>(({ inputValue }, ref) => {
  const [open, setOpen] = useState(false)
  const { primaryModel } = useSettingStore()
  const { marks, fetchAllMarks, allMarks } = useMarkStore()
  const { currentTagId, tags, fetchTags } = useTagStore()
  const { activeFilePath, fileTree, setActiveFilePath, loadFileTree, readArticle, setCurrentArticle, setSkipSyncOnSave, setAiGeneratingFilePath, setAiTerminateFn } = useArticleStore()
  const { setLeftSidebarTab } = useSidebarStore()
  const router = useRouter()
  const isMobile = useIsMobile()
  const [tab, setTab] = useState('0')
  const [genTemplate, setGenTemplate] = useState<GenTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const organizingRef = useRef(false)
  const [isRemoveThinking, setIsRemoveThinking] = useState(true)
  const [isTemplatePreviewExpanded, setIsTemplatePreviewExpanded] = useState(false)
  const [templateSearch, setTemplateSearch] = useState('')
  const [organizeStep, setOrganizeStep] = useState<OrganizeStep>('template')
  const [selectedRecordTagId, setSelectedRecordTagId] = useState<number | null>(currentTagId || null)
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<number>>(new Set())
  const [outputTitle, setOutputTitle] = useState('')
  const [outputFolderValue, setOutputFolderValue] = useState(ROOT_FOLDER_VALUE)
  const [isFolderTreeOpen, setIsFolderTreeOpen] = useState(false)
  const [includeImages, setIncludeImages] = useState(true)
  const [includeReferences, setIncludeReferences] = useState(true)
  const [additionalRequirement, setAdditionalRequirement] = useState('')
  const t = useTranslations('record.chat.note')
  const tGlobal = useTranslations()
  const tMark = useTranslations('record.mark')

  async function initGenTemplates() {
    const store = await Store.load('store.json')
    const template = await store.get<GenTemplate[]>('templateList') || []
    const enabledTemplates = template.filter(item => item.status !== false)
    const lastTemplateId = await store.get<string>('lastOrganizeTemplateId')
    setGenTemplate(template)
    setTab(() => {
      if (lastTemplateId && enabledTemplates.some((item) => item.id === lastTemplateId)) {
        return lastTemplateId
      }
      return enabledTemplates[0]?.id ?? template[0]?.id ?? '0'
    })
  }

  const persistLastTemplateId = useCallback(async (templateId: string) => {
    const store = await Store.load('store.json')
    await store.set('lastOrganizeTemplateId', templateId)
  }, [])

  const handleTemplateChange = useCallback((templateId: string) => {
    setTab(templateId)
    setTemplateSearch('')
    setIsTemplatePreviewExpanded(false)
    setOrganizeStep('template')
    void persistLastTemplateId(templateId)
  }, [persistLastTemplateId])

  const availableTemplates = useMemo(() => {
    return genTemplate.filter(item => item.status !== false)
  }, [genTemplate])

  const primaryTemplates = useMemo(() => {
    const primaryTemplateIds = new Set<string>()
    availableTemplates.slice(0, 6).forEach(item => primaryTemplateIds.add(item.id))
    if (availableTemplates.some(item => item.id === tab)) {
      primaryTemplateIds.add(tab)
    }
    return availableTemplates.filter(item => primaryTemplateIds.has(item.id))
  }, [availableTemplates, tab])

  const overflowTemplates = useMemo(() => {
    const primaryTemplateIds = new Set(primaryTemplates.map(item => item.id))
    return availableTemplates.filter(item => !primaryTemplateIds.has(item.id))
  }, [availableTemplates, primaryTemplates])

  const filteredOverflowTemplates = useMemo(() => {
    const normalizedSearch = templateSearch.trim().toLowerCase()
    if (!normalizedSearch) {
      return overflowTemplates
    }
    return overflowTemplates.filter(item =>
      item.title.toLowerCase().includes(normalizedSearch) ||
      item.content.toLowerCase().includes(normalizedSearch)
    )
  }, [overflowTemplates, templateSearch])

  const recordSourceMarks = useMemo(() => {
    if (!selectedRecordTagId) return marks

    const marksForSelectedTag = allMarks.filter(item => item.tagId === selectedRecordTagId)
    if (marksForSelectedTag.length > 0 || selectedRecordTagId !== currentTagId) {
      return marksForSelectedTag
    }

    return marks.filter(item => item.tagId === selectedRecordTagId)
  }, [allMarks, currentTagId, marks, selectedRecordTagId])

  // 使用 useMemo 优化过滤的记录
  const marksByRange = useMemo(() => {
    const range = availableTemplates.find(item => item.id === tab)?.range
    let subtractDate: Dayjs
    switch (range) {
      case GenTemplateRange.All:
        subtractDate = dayjs().subtract(99, 'year')
        break
      case GenTemplateRange.Today:
        subtractDate = dayjs().subtract(1, 'day')
        break
      case GenTemplateRange.Week:
        subtractDate = dayjs().subtract(1, 'week')
        break
      case GenTemplateRange.Month:
        subtractDate = dayjs().subtract(1, 'month')
        break
      case GenTemplateRange.ThreeMonth:
        subtractDate = dayjs().subtract(3, 'month')
        break
      case GenTemplateRange.Year:
        subtractDate = dayjs().subtract(1, 'year')
        break
      default:
        subtractDate = dayjs().subtract(99, 'year')
        break
    }
    return recordSourceMarks.filter(item => dayjs(item.createdAt).isAfter(subtractDate))
  }, [recordSourceMarks, availableTemplates, tab])

  const recordPreviewMarks = useMemo(() => {
    return [...marksByRange]
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [marksByRange])

  const selectedMarksByRange = useMemo(() => {
    return marksByRange.filter(item => selectedRecordIds.has(item.id))
  }, [marksByRange, selectedRecordIds])

  const recordTypeCounts = useMemo(() => {
    return selectedMarksByRange.reduce<Record<Mark['type'], number>>((counts, item) => {
      counts[item.type] += 1
      return counts
    }, {
      scan: 0,
      text: 0,
      image: 0,
      link: 0,
      file: 0,
      recording: 0,
      todo: 0,
    })
  }, [selectedMarksByRange])

  // 使用 useMemo 优化选中的模板
  const selectedTemplate = useMemo(() => {
    return availableTemplates.find(item => item.id === tab)
  }, [availableTemplates, tab])

  const selectedTemplateRangeLabel = useMemo(() => {
    return selectedTemplate ? getTemplateRangeLabel(selectedTemplate.range, tGlobal) : '-'
  }, [selectedTemplate, tGlobal])

  const shouldShowTemplateExpand = useMemo(() => {
    const content = selectedTemplate?.content ?? ''
    return content.length > 180 || content.split('\n').length > 5
  }, [selectedTemplate])

  const organizeDisabledReason = useMemo(() => {
    if (loading) return ''
    if (!primaryModel) return tGlobal('record.chat.input.placeholder.noPrimaryModel')
    if (!selectedTemplate) return t('noTemplateAvailable')
    if (recordSourceMarks.length === 0) return t('noRecords')
    if (marksByRange.length === 0) return t('noRecordsInRange')
    if (selectedMarksByRange.length === 0) return t('noRecordsSelected')
    return ''
  }, [loading, primaryModel, selectedTemplate, recordSourceMarks.length, marksByRange.length, selectedMarksByRange.length, t, tGlobal])

  const isOrganizeDisabled = Boolean(organizeDisabledReason) || loading
  const organizeStepIndex = ORGANIZE_STEP_ORDER.indexOf(organizeStep)
  const stepItems = useMemo(() => ([
    {
      value: 'template' as const,
      number: '1',
      title: t('stepTemplate'),
      meta: t('templateStepDescription'),
      icon: FileText,
      disabled: false,
    },
    {
      value: 'records' as const,
      number: '2',
      title: t('stepRecords'),
      meta: t('recordsStepDescription'),
      icon: ListChecks,
      disabled: marksByRange.length === 0,
    },
    {
      value: 'settings' as const,
      number: '3',
      title: t('stepSettings'),
      meta: t('settingsStepDescription'),
      icon: Settings2,
      disabled: selectedMarksByRange.length === 0,
    },
  ]), [
    marksByRange.length,
    selectedMarksByRange.length,
    selectedTemplate,
    t,
  ])
  const activeStepItem = stepItems[organizeStepIndex] ?? stepItems[0]

  const getMarkTypeLabel = useCallback((type: Mark['type']) => {
    return tGlobal(`record.mark.type.${type}`)
  }, [tGlobal])

  const getFolderLabel = useCallback((folderValue: string) => {
    return folderValue === ROOT_FOLDER_VALUE ? t('saveFolderRoot') : folderValue
  }, [t])

  const handleSelectOutputFolder = useCallback((folderValue: string) => {
    setOutputFolderValue(folderValue)
    setIsFolderTreeOpen(false)
  }, [])

  const renderFolderTree = useCallback((items: DirTree[], parentPath = '', level = 0): ReactNode => {
    return items
      .filter(item => item.isDirectory)
      .map(item => {
        const folderPath = joinRelativePath(parentPath, item.name)
        const selected = outputFolderValue === folderPath
        const hasChildren = item.children?.some(child => child.isDirectory)

        return (
          <div key={folderPath} className="min-w-0">
            <button
              className={cn(
                "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-accent",
                selected && 'bg-accent text-accent-foreground'
              )}
              style={{ paddingLeft: `${8 + level * 16}px` }}
              type="button"
              onClick={() => handleSelectOutputFolder(folderPath)}
              title={folderPath}
            >
              {
                hasChildren ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )
              }
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.name}</span>
              {selected ? <Check className="ml-auto size-4 shrink-0" /> : null}
            </button>
            {
              hasChildren ? (
                <div className="min-w-0">
                  {renderFolderTree(item.children ?? [], folderPath, level + 1)}
                </div>
              ) : null
            }
          </div>
        )
      })
  }, [handleSelectOutputFolder, outputFolderValue])

  const toggleSelectedRecord = useCallback((recordId: number) => {
    setSelectedRecordIds(current => {
      const next = new Set(current)
      if (next.has(recordId)) {
        next.delete(recordId)
      } else {
        next.add(recordId)
      }
      return next
    })
  }, [])

  const selectAllPreviewRecords = useCallback(() => {
    setSelectedRecordIds(new Set(marksByRange.map(item => item.id)))
  }, [marksByRange])

  const clearSelectedPreviewRecords = useCallback(() => {
    setSelectedRecordIds(new Set())
  }, [])

  const terminateGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
      setLoading(false)
    }
  }, [])

  const openOrganize = useCallback(() => {
    setOpen(true)
    setOrganizeStep('template')
    setSelectedRecordTagId(currentTagId || null)
    setAdditionalRequirement(inputValue ?? '')
    setOutputTitle('')
    setOutputFolderValue(activeFilePath.includes('/') ? activeFilePath.split('/').slice(0, -1).join('/') : ROOT_FOLDER_VALUE)
    void initGenTemplates()
    void fetchTags()
    void fetchAllMarks()
  }, [activeFilePath, currentTagId, fetchAllMarks, fetchTags, inputValue])

  const handleOrganize = useCallback(async (options?: { quick?: boolean }) => {
    if (loading || organizingRef.current) {
      return
    }

    const quickMode = options?.quick === true
    const recordIdsToUse = new Set(quickMode ? marksByRange.map(item => item.id) : selectedRecordIds)

    if (!primaryModel || !selectedTemplate || recordIdsToUse.size === 0) return

    organizingRef.current = true
    setOpen(false)
    setLoading(true)

    // Prepare file path outside try block for access in finally
    const timestamp = new Date().getTime()
    const outputFolder = normalizeOutputFolder(outputFolderValue)
    const preferredTitle = outputTitle.trim()
    const extraRequirement = additionalRequirement.trim()
    const fileName = `整理笔记_${timestamp}.md`
    const filePath = buildOutputPath(outputFolder, fileName)

    try {
      const workspace = await getWorkspacePath()
      const pathOptions = await getFilePathOptions(filePath)

      if (workspace.isCustom) {
        await writeTextFile(pathOptions.path, '')
      } else {
        await writeTextFile(pathOptions.path, '', { baseDir: pathOptions.baseDir })
      }

      await loadFileTree()
      await setActiveFilePath(filePath)

      // Switch to files tab in sidebar
      await setLeftSidebarTab('files')

      if (isMobile) {
        router.push('/mobile/writing')
      }

      await new Promise(resolve => setTimeout(resolve, 500))

      await fetchAllMarks()

      // Get latest marks from store after fetch
      const latestMarks = useMarkStore.getState().allMarks
        .filter(item => !selectedRecordTagId || item.tagId === selectedRecordTagId)

      // Calculate marksByRange with latest marks
      const range = selectedTemplate?.range
      let subtractDate: Dayjs
      switch (range) {
        case GenTemplateRange.All:
          subtractDate = dayjs().subtract(99, 'year')
          break
        case GenTemplateRange.Today:
          subtractDate = dayjs().subtract(1, 'day')
          break
        case GenTemplateRange.Week:
          subtractDate = dayjs().subtract(1, 'week')
          break
        case GenTemplateRange.Month:
          subtractDate = dayjs().subtract(1, 'month')
          break
        case GenTemplateRange.ThreeMonth:
          subtractDate = dayjs().subtract(3, 'month')
          break
        case GenTemplateRange.Year:
          subtractDate = dayjs().subtract(1, 'year')
          break
        default:
          subtractDate = dayjs().subtract(99, 'year')
          break
      }
      const marksByRange = latestMarks
        .filter(item => dayjs(item.createdAt).isAfter(subtractDate))
        .filter(item => quickMode || recordIdsToUse.has(item.id))

      // Calculate categorizedMarks with latest marks
      const categorizedMarks = {
        scanMarks: marksByRange.filter(item => item.type === 'scan'),
        textMarks: marksByRange.filter(item => item.type === 'text'),
        imageMarks: marksByRange.filter(item => item.type === 'image'),
        linkMarks: marksByRange.filter(item => item.type === 'link'),
        fileMarks: marksByRange.filter(item => item.type === 'file'),
        recordingMarks: marksByRange.filter(item => item.type === 'recording'),
        todoMarks: marksByRange.filter(item => item.type === 'todo'),
      }

      // Process image marks
      const processedImageMarks = includeImages ? await Promise.all(
        categorizedMarks.imageMarks.map(async (image) => {
          if (image.url && !image.url.includes('http')) {
            return {
              ...image,
              url: await convertImage(`/image/${image.url}`)
            }
          }
          return image
        })
      ) : categorizedMarks.imageMarks

      const store = await Store.load('store.json')
      const locale = await store.get<string>('locale') || 'zh'

      const request_content = `
        Here are text fragments recognized by OCR after screenshots:
        ${categorizedMarks.scanMarks.map((item, index) => `Record ${index + 1}: ${item.content}. Created at ${dayjs(item.createdAt).format('YYYY-MM-DD HH:mm:ss')}`).join(';\n\n')}.
        Here are text fragments copied and recorded:
        ${categorizedMarks.textMarks.map((item, index) => `Record ${index + 1}: ${item.content}. Created at ${dayjs(item.createdAt).format('YYYY-MM-DD HH:mm:ss')}`).join(';\n\n')}.
        Here are recording transcripts:
        ${categorizedMarks.recordingMarks.map((item, index) => `Recording record ${index + 1}: ${item.content}. Created at ${dayjs(item.createdAt).format('YYYY-MM-DD HH:mm:ss')}`).join(';\n\n')}.
        Here are todo records:
        ${categorizedMarks.todoMarks.map((item, index) => `Todo record ${index + 1}: ${item.content || item.desc}. Created at ${dayjs(item.createdAt).format('YYYY-MM-DD HH:mm:ss')}`).join(';\n\n')}.
        Here are image record descriptions:
        ${processedImageMarks.map(item => `
          Description: ${item.content},
          ${includeImages ? `Image URL: ${item.url}` : 'Use the description only. Do not embed this image.'}
        `).join(';\n\n')}.
        Here are link record contents:
        ${categorizedMarks.linkMarks.map((item, index) => `Link record ${index + 1}:
          Title: ${item.desc}
          URL: ${item.url}
          Content: ${item.content}
          Created at: ${dayjs(item.createdAt).format('YYYY-MM-DD HH:mm:ss')}`).join(';\n\n')}.
        Here are file record descriptions:
        ${categorizedMarks.fileMarks.map(item => `
          Content: ${item.content},
        `).join(';\n\n')}.
        ---
        ${extraRequirement ? 'Additional requirements: '+extraRequirement : ''}
        If the record content is empty, return that there is no record information in this organization.
        Format requirements:
        - Use ${locale} language for the output.
        - Use Markdown syntax.
        - Ensure there is a level 1 heading (H1).
        ${preferredTitle ? `- The H1 title must be exactly: ${preferredTitle}` : '- Generate a clear H1 title based on the selected records.'}
        - The note order may be incorrect, arrange them in the correct order.
        ${isRemoveThinking ? '- Remove thinking-process or reasoning fragments from records before composing the final note.' : ''}
        ${includeReferences ? `- If there are link records, place them as reference links at the end of the article in the following format:
          ## References
          1. [Title1](Link1)
          2. [Title2](Link2)` : '- Do not add a References section. Use link contents only when they are relevant to the note.'}

        ${
          includeImages && processedImageMarks.length > 0 ?
          '- If there are image records, place the image links in appropriate positions in the note based on the image descriptions. The image URLs contain uuid, please return them completely, and add a brief description for each image.'
          : processedImageMarks.length > 0 ?
          '- Do not embed image links in the note. You may use image descriptions as source material if they are relevant.'
          : ''
        }
        ${selectedTemplate?.content}
      `

      // Emit AI streaming start event with target file path
      emitter.emit('editor-ai-streaming', {
        isStreaming: true,
        targetFilePath: filePath,
        terminate: () => {
          terminateGeneration()
        }
      })

      // 5. Stream generation to editor

      // Skip sync for AI-generated content
      setSkipSyncOnSave(true)
      setAiGeneratingFilePath(filePath)
      setAiTerminateFn(() => {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort()
          abortControllerRef.current = null
          setLoading(false)
        }
      })

      abortControllerRef.current = new AbortController()
      const signal = abortControllerRef.current.signal
      const targetFilePath = filePath // 保存目标文件路径

      let fullContent = ''
      let streamFinished = false
      await fetchAiStream(request_content, async (content) => {
        // Check if user switched to a different file - stop writing if so
        const currentActivePath = useArticleStore.getState().activeFilePath
        if (currentActivePath !== targetFilePath) {
          return
        }

        fullContent = content
        // Update editor content in real-time without reloading file
        setCurrentArticle(content)
        emitter.emit('external-content-update', content)
        // Also write to file
        if (workspace.isCustom) {
          await writeTextFile(pathOptions.path, content)
        } else {
          await writeTextFile(pathOptions.path, content, { baseDir: pathOptions.baseDir })
        }
      }, signal)
      streamFinished = true

      // Re-enable sync after AI generation
      setSkipSyncOnSave(false)
      setAiGeneratingFilePath(null)
      setAiTerminateFn(null)

      // Emit AI streaming end event
      emitter.emit('editor-ai-streaming', {
        isStreaming: false,
        targetFilePath: filePath
      })

      // 6. Extract title and rename file
      let cleanedContent = fullContent
      if (preferredTitle) {
        cleanedContent = ensurePreferredHeading(cleanedContent, preferredTitle)
      }

      // Try to extract title: H1 -> H2 -> H3
      let titleMatch = cleanedContent.match(/^#\s+(.+)$/m)
      if (!titleMatch) {
        titleMatch = cleanedContent.match(/^##\s+(.+)$/m)
      }
      if (!titleMatch) {
        titleMatch = cleanedContent.match(/^###\s+(.+)$/m)
      }

      if ((titleMatch && titleMatch[1]) || preferredTitle) {
        const title = preferredTitle || titleMatch?.[1]?.trim() || fileName.replace(/\.md$/, '')
        const { filePath: newFilePath, pathOptions: newPathOptions, sanitizedTitle } = await getAvailableOutputPath(outputFolder, title, workspace.isCustom)

        // Write to new file
        if (workspace.isCustom) {
          await writeTextFile(newPathOptions.path, cleanedContent)
        } else {
          await writeTextFile(newPathOptions.path, cleanedContent, { baseDir: newPathOptions.baseDir })
        }

        // Delete old file
        const { remove } = await import('@tauri-apps/plugin-fs')
        if (newFilePath !== filePath) {
          if (workspace.isCustom) {
            await remove(pathOptions.path)
          } else {
            await remove(pathOptions.path, { baseDir: pathOptions.baseDir })
          }
        }

        // Update file tree and active file
        await loadFileTree()
        setActiveFilePath(newFilePath)
        await readArticle(newFilePath, '', shouldAutoSyncOnInitialRead({ isNewFile: true }))
        if (shouldEmitOrganizeOnboardingComplete({ streamFinished, aborted: signal.aborted })) {
          emitter.emit('onboarding-step-complete', { step: 'organize-note', filePath: newFilePath })
        }

        toast({
          description: tMark('toolbar.organizeSuccess', { title: sanitizedTitle }),
        })
      } else {
        // No title found, just save the cleaned content
        if (workspace.isCustom) {
          await writeTextFile(pathOptions.path, cleanedContent)
        } else {
          await writeTextFile(pathOptions.path, cleanedContent, { baseDir: pathOptions.baseDir })
        }
        await readArticle(filePath, '', shouldAutoSyncOnInitialRead())
        if (shouldEmitOrganizeOnboardingComplete({ streamFinished, aborted: signal.aborted })) {
          emitter.emit('onboarding-step-complete', { step: 'organize-note', filePath })
        }

        toast({
          description: tMark('toolbar.organizeSuccess', { title: fileName }),
        })
      }

    } catch (error: unknown) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        console.error('Organize error:', error)
        toast({
          description: tMark('toolbar.organizeError'),
          variant: 'destructive',
        })
      }
    } finally {
      organizingRef.current = false
      abortControllerRef.current = null
      setLoading(false)
      // Re-enable sync in case of termination
      setSkipSyncOnSave(false)
      setAiGeneratingFilePath(null)
      setAiTerminateFn(null)
      // Emit AI streaming end event
      emitter.emit('editor-ai-streaming', {
        isStreaming: false,
        targetFilePath: filePath
      })
    }
  }, [
    additionalRequirement,
    fetchAllMarks,
    includeImages,
    includeReferences,
    isRemoveThinking,
    loadFileTree,
    loading,
    outputFolderValue,
    outputTitle,
    primaryModel,
    readArticle,
    marksByRange,
    selectedRecordIds,
    selectedRecordTagId,
    selectedTemplate,
    setActiveFilePath,
    setAiGeneratingFilePath,
    setAiTerminateFn,
    setCurrentArticle,
    setLeftSidebarTab,
    setSkipSyncOnSave,
    isMobile,
    tMark,
    router,
    terminateGeneration,
  ])

  useImperativeHandle(ref, () => ({
    openOrganize
  }))

  // Listen for abort event from editor
  useEffect(() => {
    const handleAbortAiStreaming = () => {
      if (loading) {
        terminateGeneration()
      }
    }
    emitter.on('abort-ai-streaming', handleAbortAiStreaming)
    return () => {
      emitter.off('abort-ai-streaming', handleAbortAiStreaming)
    }
  }, [loading, terminateGeneration])

  useEffect(() => {
    if (!open) return
    setSelectedRecordIds(new Set(marksByRange.map(item => item.id)))
  }, [marksByRange, open])

  const handleDialogKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || e.nativeEvent.isComposing) return

    if (e.key === 'Escape') {
      e.preventDefault()
      if (loading) {
        terminateGeneration()
      } else {
        setOpen(false)
      }
    }
  }, [open, loading, terminateGeneration])

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          isMobile
            ? "left-0 top-0 h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 duration-0 data-[state=closed]:animate-none data-[state=open]:animate-none sm:rounded-none"
            : "h-[calc(100vh-2rem)] max-h-[760px] w-[calc(100vw-2rem)] max-w-5xl"
        )}
        onKeyDown={handleDialogKeyDown}
        style={isMobile ? { animation: 'none' } : undefined}
      >
        <AlertDialogHeader
          className={cn(
            "shrink-0 min-w-0 border-b",
            isMobile ? "px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]" : "px-6 py-4"
          )}
        >
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <AlertDialogTitle className={cn(isMobile ? "text-lg leading-6" : "text-xl")}>{t('organizeAs')}</AlertDialogTitle>
              {
                isMobile ? (
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {activeStepItem.title} · {selectedTemplateRangeLabel}
                  </p>
                ) : null
              }
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="secondary">
                {activeStepItem.number}/3
              </Badge>
              <Button
                aria-label={tGlobal('common.close')}
                className="size-8 p-0"
                disabled={loading}
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
        </AlertDialogHeader>
        <div
          className={cn(
            "shrink-0 border-b",
            isMobile ? "bg-background px-3 py-2" : "bg-muted/20 px-5 py-4"
          )}
        >
          <div className={cn("w-full min-w-0", !isMobile && "overflow-x-auto")}>
            <div className={cn("grid grid-cols-3 gap-2", !isMobile && "min-w-[42rem]")}>
              {
                stepItems.map((item, index) => {
                  const Icon = item.icon
                  const isActive = item.value === organizeStep
                  const isComplete = index < organizeStepIndex
                  return (
                    <div
                      aria-current={isActive ? 'step' : undefined}
                      className={cn(
                        "min-w-0 rounded-md border text-left",
                        isMobile ? "flex flex-col items-center gap-1.5 px-2 py-2" : "flex items-center gap-3 p-3",
                        isActive && 'border-primary bg-background shadow-sm',
                        !isActive && isComplete && 'border-border bg-background/80',
                        !isActive && !isComplete && 'border-transparent',
                        item.disabled && 'opacity-50'
                      )}
                      key={item.value}
                    >
                      <span
                        className={cn(
                          "flex shrink-0 items-center justify-center rounded-full border font-semibold",
                          isMobile ? "size-7 text-xs" : "size-9 text-sm",
                          isActive && 'border-primary bg-primary text-primary-foreground',
                          !isActive && isComplete && 'border-primary bg-primary/10 text-primary',
                          !isActive && !isComplete && 'bg-background text-muted-foreground'
                        )}
                      >
                        {isComplete ? <Check className={cn(isMobile ? "size-3.5" : "size-4")} /> : item.number}
                      </span>
                      <span className={cn("min-w-0", isMobile && "text-center")}>
                        <span className={cn("flex min-w-0 items-center gap-1.5 font-medium", isMobile ? "justify-center text-xs" : "text-sm")}>
                          <Icon className="size-4 shrink-0" />
                          <span className="truncate">{item.title}</span>
                        </span>
                        <span className={cn("mt-0.5 truncate text-xs text-muted-foreground", isMobile ? "hidden" : "block")}>{item.meta}</span>
                      </span>
                    </div>
                  )
                })
              }
            </div>
          </div>
        </div>
        <main className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", isMobile ? "px-3 py-3" : "px-6 py-5")}>
          <div className={cn("flex h-full w-full min-h-0 min-w-0 flex-col", isMobile ? "gap-3" : "gap-4")}>
          {
            organizeStep === 'template' ? (
              <div className={cn(
                "flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-y-auto",
                isMobile ? "gap-3 pb-2" : "gap-4 pr-1"
              )}>
                <div className={cn("flex min-w-0 flex-col gap-2", isMobile && "rounded-2xl border bg-background p-3")}>
                  <Label>{t('selectTemplate')}</Label>
                  <Tabs className="min-w-0" value={tab} onValueChange={handleTemplateChange}>
                    <div className="w-full min-w-0 overflow-x-auto pb-1">
                    <TabsList className={cn(
                      "min-w-full justify-start",
                      isMobile && "h-auto min-w-max gap-1 bg-transparent p-0"
                    )}>
                      {
                        primaryTemplates.map(item => (
                          <TabsTrigger
                            className={cn(
                              "shrink-0",
                              isMobile && "rounded-full border bg-background px-3 py-1.5 text-xs shadow-none data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none"
                            )}
                            value={item.id}
                            key={item.id}
                            title={item.title}
                          >
                            <span className="max-w-32 truncate">{item.title}</span>
                          </TabsTrigger>
                        ))
                      }
                      {
                        overflowTemplates.length > 0 ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button className={cn("h-7 shrink-0 gap-1 rounded-md px-2 text-sm", isMobile && "rounded-full border bg-background text-xs")} variant="ghost">
                                {t('moreTemplates')}
                                <ChevronDown className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className={cn("w-72", isMobile && "w-[calc(100vw-2rem)]")}>
                              <div className="flex items-center gap-2 px-2 py-1.5">
                                <Search className="size-4 text-muted-foreground" />
                                <Input
                                  className="h-8"
                                  value={templateSearch}
                                  onChange={(event) => setTemplateSearch(event.target.value)}
                                  onKeyDown={(event) => event.stopPropagation()}
                                  placeholder={t('searchTemplates')}
                                />
                              </div>
                              <ScrollArea className="h-64">
                                <div className="p-1">
                                  {
                                    filteredOverflowTemplates.length > 0 ? (
                                      filteredOverflowTemplates.map(item => (
                                        <DropdownMenuItem key={item.id} onSelect={() => handleTemplateChange(item.id)}>
                                          <Check className="size-4 opacity-0" />
                                          <span className="truncate" title={item.title}>{item.title}</span>
                                        </DropdownMenuItem>
                                      ))
                                    ) : (
                                      <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t('noTemplateAvailable')}</div>
                                    )
                                  }
                                </div>
                              </ScrollArea>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null
                      }
                    </TabsList>
                    </div>
                  </Tabs>
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Badge className="gap-1" variant="outline">
                      <span>{t('recordRange')}</span>
                      <span className="font-normal">{selectedTemplateRangeLabel}</span>
                    </Badge>
                  </div>
                </div>
                <div className={cn("flex min-w-0 flex-col gap-1", isMobile && "rounded-2xl border bg-background p-3")}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="name">{t('templateContent')}</Label>
                    {
                      shouldShowTemplateExpand ? (
                        <Button
                          className={cn("h-7 px-2 text-xs", isMobile && "rounded-full")}
                          variant="ghost"
                          onClick={() => setIsTemplatePreviewExpanded(current => !current)}
                        >
                          {isTemplatePreviewExpanded ? t('showLess') : t('showMore')}
                        </Button>
                      ) : null
                    }
                  </div>
                  <ScrollArea
                    className={cn(
                      "w-full min-w-0 rounded-md border p-2",
                      isTemplatePreviewExpanded ? (isMobile ? "h-72" : "h-64") : (isMobile ? "h-40" : "h-28")
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      { selectedTemplate?.content || tGlobal('settings.template.noContent') }
                    </p>
                  </ScrollArea>
                </div>
              </div>
            ) : organizeStep === 'records' ? (
              <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3">
                <div className={cn(
                  "flex min-w-0 gap-2",
                  isMobile ? "flex-col rounded-2xl border bg-background p-3" : "flex-wrap items-center justify-between"
                )}>
                  <div className={cn(
                    "flex min-w-0 gap-1.5",
                    isMobile ? "flex-nowrap overflow-x-auto pb-1" : "flex-wrap"
                  )}>
                    {
                      Object.entries(recordTypeCounts)
                        .filter(([, count]) => count > 0)
                        .map(([type, count]) => (
                          <Badge key={type} className="gap-1" variant="outline">
                            <span>{getMarkTypeLabel(type as Mark['type'])}</span>
                            <span className="font-normal">{count}</span>
                          </Badge>
                        ))
                    }
                  </div>
                  <div className={cn(
                    "shrink-0 gap-2",
                    isMobile ? "grid grid-cols-2" : "flex flex-wrap items-center justify-end"
                  )}>
                    <div className={cn(isMobile && "col-span-2")}>
                      <Select
                        value={selectedRecordTagId ? String(selectedRecordTagId) : ''}
                        onValueChange={(value) => setSelectedRecordTagId(Number(value))}
                      >
                        <SelectTrigger className={cn("h-8 w-40", isMobile && "h-9 w-full rounded-xl")}>
                          <SelectValue placeholder={tMark('toolbar.filter.tag')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {
                              tags.map(tag => (
                                <SelectItem key={tag.id} value={String(tag.id)}>{tag.name}</SelectItem>
                              ))
                            }
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button className={cn("h-8 px-2", isMobile && "h-9 rounded-xl")} variant="outline" onClick={selectAllPreviewRecords}>{t('selectAllRecords')}</Button>
                    <Button className={cn("h-8 px-2", isMobile && "h-9 rounded-xl")} variant="outline" onClick={clearSelectedPreviewRecords}>{t('clearRecordSelection')}</Button>
                  </div>
                </div>
                <ScrollArea className={cn("min-h-0 flex-1 border bg-muted/20", isMobile ? "rounded-2xl" : "rounded-md")}>
                  <div className={cn("flex flex-col gap-2", isMobile ? "p-2.5" : "p-2")}>
                    {
                      recordPreviewMarks.length > 0 ? (
                        recordPreviewMarks.map(mark => (
                          <div
                            className={cn(
                              "flex min-w-0 items-start gap-2",
                              isMobile && "rounded-xl bg-background/80 p-2",
                              !selectedRecordIds.has(mark.id) && 'opacity-60'
                            )}
                            key={mark.id}
                          >
                            <div className="flex shrink-0 items-center gap-2 pt-3">
                              <Checkbox
                                checked={selectedRecordIds.has(mark.id)}
                                id={`organize-record-${mark.id}`}
                                onCheckedChange={() => toggleSelectedRecord(mark.id)}
                              />
                            </div>
                            <div className="min-w-0 flex-1">
                              <MarkItem mark={mark} variant="list" interactive={false} />
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-md bg-background p-3 text-center text-xs text-muted-foreground">{t('previewEmpty')}</div>
                      )
                    }
                  </div>
                </ScrollArea>
              </div>
            ) : (
              <div className={cn("min-h-0 w-full flex-1 overflow-y-auto", isMobile ? "pb-2" : "p-1 pr-2")}>
                <div className={cn("grid min-w-0", isMobile ? "gap-3" : "gap-4")}>
                  <div className={cn("grid min-w-0 md:grid-cols-2", isMobile ? "gap-3" : "gap-4")}>
                    <div className={cn("grid min-w-0 gap-2", isMobile && "rounded-2xl border bg-background p-3")}>
                      <Label htmlFor="organize-save-folder">{t('saveFolder')}</Label>
                      <Popover open={isFolderTreeOpen} onOpenChange={setIsFolderTreeOpen}>
                        <PopoverTrigger asChild>
                          <button
                            id="organize-save-folder"
                            className={cn(
                              "flex h-9 w-full min-w-0 items-center gap-2 rounded-md border bg-background px-3 text-left text-sm transition-colors hover:bg-accent",
                              isMobile && "rounded-xl"
                            )}
                            type="button"
                          >
                            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate">{getFolderLabel(outputFolderValue)}</span>
                            <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className={cn("w-80 p-0", isMobile && "w-[calc(100vw-2rem)]")} portalled={false}>
                          <div className="border-b px-3 py-2 text-sm font-medium">{t('saveFolder')}</div>
                          <div className="p-1">
                            <button
                              className={cn(
                                "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-accent",
                                outputFolderValue === ROOT_FOLDER_VALUE && 'bg-accent text-accent-foreground'
                              )}
                              type="button"
                              onClick={() => handleSelectOutputFolder(ROOT_FOLDER_VALUE)}
                            >
                              <Home className="size-4 shrink-0 text-muted-foreground" />
                              <span className="truncate">{t('saveFolderRoot')}</span>
                              {outputFolderValue === ROOT_FOLDER_VALUE ? <Check className="ml-auto size-4 shrink-0" /> : null}
                            </button>
                          </div>
                          <div className="h-64 overflow-y-auto border-t">
                            <div className="p-1">
                              {
                                fileTree.some(item => item.isDirectory) ? (
                                  renderFolderTree(fileTree)
                                ) : (
                                  <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t('noFolderAvailable')}</div>
                                )
                              }
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className={cn("grid min-w-0 gap-2 md:col-span-2", isMobile && "rounded-2xl border bg-background p-3")}>
                      <Label htmlFor="organize-output-title">{t('articleTitle')}</Label>
                      <Input
                        className={cn(isMobile && "rounded-xl")}
                        id="organize-output-title"
                        value={outputTitle}
                        onChange={(event) => setOutputTitle(event.target.value)}
                        placeholder={t('articleTitlePlaceholder')}
                      />
                    </div>
                    <div className={cn("flex min-w-0 items-center justify-between gap-3 rounded-md border bg-background p-3", isMobile && "rounded-2xl")}>
                      <div className="min-w-0">
                        <Label htmlFor="organize-include-images">{t('includeImages')}</Label>
                      </div>
                      <Switch id="organize-include-images" checked={includeImages} onCheckedChange={setIncludeImages} />
                    </div>
                    <div className={cn("flex min-w-0 items-center justify-between gap-3 rounded-md border bg-background p-3", isMobile && "rounded-2xl")}>
                      <div className="min-w-0">
                        <Label htmlFor="organize-include-references">{t('includeReferences')}</Label>
                      </div>
                      <Switch id="organize-include-references" checked={includeReferences} onCheckedChange={setIncludeReferences} />
                    </div>
                    <div className={cn("flex min-w-0 items-center justify-between gap-3 rounded-md border bg-background p-3", isMobile && "rounded-2xl")}>
                      <div className="min-w-0">
                        <Label htmlFor="remove-thinking">{t('filterThinkingContent')}</Label>
                      </div>
                      <Switch id="remove-thinking" checked={isRemoveThinking} onCheckedChange={setIsRemoveThinking} />
                    </div>
                    <div className={cn("grid min-w-0 gap-2 md:col-span-2", isMobile && "rounded-2xl border bg-background p-3")}>
                      <Label htmlFor="organize-additional-requirement">{t('additionalRequirement')}</Label>
                      <Textarea
                        className={cn("resize-none", isMobile ? "min-h-32 rounded-xl" : "min-h-28")}
                        id="organize-additional-requirement"
                        value={additionalRequirement}
                        onChange={(event) => setAdditionalRequirement(event.target.value)}
                        placeholder={t('additionalRequirementPlaceholder')}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )
          }
          {
            organizeStep !== 'template' && organizeDisabledReason ? (
              <p className={cn("text-xs text-muted-foreground", isMobile && "rounded-xl bg-muted/40 px-3 py-2")}>{organizeDisabledReason}</p>
            ) : null
          }
            </div>
          </main>
        <AlertDialogFooter
          className={cn(
            "shrink-0 border-t",
            isMobile
              ? "flex-row items-center justify-between gap-2 space-x-0 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3"
              : "px-6 py-4"
          )}
        >
          {
            organizeStep !== 'template' ? (
              <Button
                className={cn(isMobile && "h-10 shrink-0 rounded-xl px-3")}
                variant="ghost"
                disabled={loading}
                onClick={() => setOrganizeStep(organizeStep === 'settings' ? 'records' : 'template')}
              >
                <ArrowLeft className="size-4" />
                {t('previousStep')}
              </Button>
            ) : null
          }
          {
            organizeStep === 'template' ? (
              <>
                <Button
                  className={cn(isMobile && "h-10 flex-1 rounded-xl px-3")}
                  onClick={() => handleOrganize({ quick: true })}
                  disabled={!primaryModel || !selectedTemplate || marksByRange.length === 0 || loading}
                  title={!primaryModel ? tGlobal('record.chat.input.placeholder.noPrimaryModel') : !selectedTemplate ? t('noTemplateAvailable') : marksByRange.length === 0 ? t('noRecordsInRange') : t('quickOrganizeHelp')}
                >
                  <Zap className="size-4" />
                  {t('quickOrganize')}
                </Button>
                <Button
                  className={cn(isMobile && "h-10 flex-1 rounded-xl px-3")}
                  onClick={() => setOrganizeStep('records')}
                  disabled={!selectedTemplate || marksByRange.length === 0 || loading}
                  title={!selectedTemplate ? t('noTemplateAvailable') : marksByRange.length === 0 ? t('noRecordsInRange') : undefined}
                >
                  {t('nextStep')}
                  <ArrowRight className="size-4" />
                </Button>
              </>
            ) : organizeStep === 'records' ? (
              <Button
                className={cn(isMobile && "h-10 flex-1 rounded-xl px-3")}
                onClick={() => setOrganizeStep('settings')}
                disabled={selectedMarksByRange.length === 0 || loading}
                title={selectedMarksByRange.length === 0 ? t('noRecordsSelected') : undefined}
              >
                {t('nextStep')}
                <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button
                className={cn(isMobile && "h-10 flex-1 rounded-xl px-3")}
                onClick={() => handleOrganize()}
                disabled={isOrganizeDisabled}
                title={organizeDisabledReason || undefined}
              >
                {t('startOrganize')}
              </Button>
            )
          }
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
})

OrganizeNotes.displayName = 'OrganizeNotes';
