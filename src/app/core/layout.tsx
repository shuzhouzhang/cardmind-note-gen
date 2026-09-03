'use client'

import { ThemeProvider } from "@/components/theme-provider"
import useSettingStore from "@/stores/setting"
import { useEffect, useState } from "react";
import { initAllDatabases } from "@/db"
import dayjs from "dayjs"
import zh from "dayjs/locale/zh-cn";
import en from "dayjs/locale/en";
import { useI18n } from "@/hooks/useI18n"
import useVectorStore from "@/stores/vector"
import useShortcutStore from "@/stores/shortcut"
import useEditorShortcutStore from "@/stores/editor-shortcut"
import initQuickRecordText from "@/lib/shortcut/quick-record-text"
import { useRouter, usePathname } from "next/navigation"
import initShowWindow from "@/lib/shortcut/show-window"
import { SearchDialog } from "@/components/search-dialog"
import { ActivityDrawer } from "@/components/activity/activity-drawer"
import { reportAppStart } from "@/lib/event-report"
import { TitleBar } from "@/components/title-bar"
import { Store } from '@tauri-apps/plugin-store'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { TextSizeProvider } from "@/contexts/text-size-context"
import { applyThemeColors } from "@/lib/theme-utils"
import { applyAppFontFamily } from "@/lib/font-settings"
import emitter from "@/lib/emitter"
import { isEditableKeyboardTarget } from "@/lib/is-editable-keyboard-target"
import useArticleStore from "@/stores/article"
import { resolveOpenedMarkdownPath } from "@/lib/opened-files"
import { useToast } from "@/hooks/use-toast"
import { useSidebarStore } from "@/stores/sidebar"
import { useTranslations } from "next-intl"

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { initSettingData, uiScale, customThemeColors, recordToolbarConfig, appFontFamily } = useSettingStore()
  const { currentLocale } = useI18n()
  const { initShortcut } = useShortcutStore()
  const { initEditorShortcuts } = useEditorShortcutStore()
  const { initVectorDb } = useVectorStore()
  const router = useRouter()
  const pathname = usePathname()
  const t = useTranslations()
  const { toast } = useToast()
  const [searchOpen, setSearchOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    let unlistenOpenFiles: (() => void) | undefined

    const openMarkdownFiles = async (paths: string[]) => {
      if (paths.length === 0) {
        return
      }

      const articleStore = useArticleStore.getState()
      let openedCount = 0

      for (const path of paths) {
        const resolvedPath = await resolveOpenedMarkdownPath(path)
        if (!resolvedPath) {
          continue
        }

        await articleStore.setActiveFilePath(resolvedPath)
        openedCount += 1
      }

      if (openedCount > 0 && pathname !== '/core/main') {
        router.replace('/core/main')
      }

      if (openedCount === 0) {
        toast({
          title: '无法打开文件',
          description: '请选择存在的 Markdown 文件',
          variant: 'destructive',
        })
      }
    }

    const registerOpenFileListener = async () => {
      const window = getCurrentWindow()
      const unlisten = await window.listen<string[]>('open-files', (event) => {
        void openMarkdownFiles(event.payload)
      })

      if (cancelled) {
        unlisten()
        return
      }
      unlistenOpenFiles = unlisten

      const pendingPaths = await invoke<string[]>('drain_pending_open_files')
      await openMarkdownFiles(pendingPaths)
    }

    void registerOpenFileListener()

    return () => {
      cancelled = true
      unlistenOpenFiles?.()
    }
  }, [pathname, router, toast])

  useEffect(() => {
    const recordToolLabels: Record<string, string> = {
      text: t('record.mark.type.text'),
      recording: t('record.mark.type.recording'),
      scan: t('record.mark.type.screenshot'),
      image: t('record.mark.type.image'),
      link: t('record.mark.type.link'),
      file: t('record.mark.type.file'),
      todo: t('record.mark.type.todo'),
    }

    void invoke('update_tray_record_toolbar_config', {
      config: recordToolbarConfig.map((item) => ({
        ...item,
        label: recordToolLabels[item.id] || item.id,
      })),
      labels: {
        quickRecord: t('tray.quickRecord'),
        moreRecord: t('tray.moreRecord'),
        open: t('tray.open'),
        showMain: t('tray.showMain'),
        newNote: t('tray.newNote'),
        newFolder: t('tray.newFolder'),
        settings: t('tray.settings'),
        window: t('tray.window'),
        pinToggle: t('tray.pinToggle'),
        hideWindow: t('tray.hideWindow'),
        quit: t('tray.quit'),
      },
    }).catch((error) => {
      console.debug('Failed to sync tray record toolbar config:', error)
    })
  }, [recordToolbarConfig, t])

  useEffect(() => {
    let cancelled = false
    let unlistenTrayAction: (() => void) | undefined
    let unlistenOpenSettings: (() => void) | undefined

    const navigateToMain = async () => {
      const store = await Store.load('store.json')
      await store.set('currentPage', '/core/main')
      await store.save()

      if (pathname !== '/core/main') {
        router.replace('/core/main')
      }
    }

    const showSidebarTab = async (tab: 'files' | 'notes') => {
      await navigateToMain()

      const sidebar = useSidebarStore.getState()
      if (!sidebar.leftSidebarVisible) {
        await sidebar.toggleLeftSidebar()
      }
      await useSidebarStore.getState().setLeftSidebarTab(tab)
    }

    const togglePin = async () => {
      const store = await Store.load('store.json')
      const currentPin = await store.get<boolean>('pin')
      const nextPin = !currentPin

      await getCurrentWindow().setAlwaysOnTop(nextPin)
      await store.set('pin', nextPin)
      await store.save()
      emitter.emit('window-pin-changed', nextPin)
    }

    const ensureFileTreeLoaded = async () => {
      const articleStore = useArticleStore.getState()
      if (articleStore.fileTree.length === 0) {
        await articleStore.loadFileTree()
      }
    }

    const handleTrayAction = async (action: string) => {
      switch (action) {
        case 'new-note':
          await showSidebarTab('files')
          await ensureFileTreeLoaded()
          await useArticleStore.getState().newFile()
          break
        case 'new-folder':
          await showSidebarTab('files')
          await ensureFileTreeLoaded()
          await useArticleStore.getState().newFolder()
          break
        case 'record-audio':
          await showSidebarTab('notes')
          emitter.emit('toolbar-shortcut-recording')
          break
        case 'record-screenshot':
        case 'screenshot':
          await showSidebarTab('notes')
          emitter.emit('toolbar-shortcut-scan')
          break
        case 'record-text':
        case 'text':
          await showSidebarTab('notes')
          emitter.emit('toolbar-shortcut-text')
          break
        case 'record-link':
        case 'link':
          await showSidebarTab('notes')
          emitter.emit('toolbar-shortcut-link')
          break
        case 'record-image':
          await showSidebarTab('notes')
          emitter.emit('toolbar-shortcut-image')
          break
        case 'record-file':
          await showSidebarTab('notes')
          emitter.emit('toolbar-shortcut-file')
          break
        case 'record-todo':
          await showSidebarTab('notes')
          emitter.emit('toolbar-shortcut-todo')
          break
        case 'pin-window':
        case 'pin':
          await togglePin()
          break
        default:
          break
      }
    }

    const registerTrayListeners = async () => {
      const window = getCurrentWindow()
      const trayActionUnlisten = await window.listen<string>('tray-action', (event) => {
        void handleTrayAction(event.payload)
      })
      const openSettingsUnlisten = await window.listen<string>('open-settings', async () => {
        const store = await Store.load('store.json')
        await store.set('currentPage', '/core/setting')
        await store.save()
        router.replace('/core/setting')
      })

      if (cancelled) {
        trayActionUnlisten()
        openSettingsUnlisten()
        return
      }

      unlistenTrayAction = trayActionUnlisten
      unlistenOpenSettings = openSettingsUnlisten
    }

    void registerTrayListeners()

    return () => {
      cancelled = true
      unlistenTrayAction?.()
      unlistenOpenSettings?.()
    }
  }, [pathname, router])

  // 重定向旧路径到新的 /core/main
  useEffect(() => {
    async function redirectOldPaths() {
      if (pathname === '/core/article' || pathname === '/core/record') {
        const store = await Store.load('store.json')
        await store.set('currentPage', '/core/main')
        await store.save()
        router.replace('/core/main')
      }
    }
    redirectOldPaths()
  }, [pathname, router])

  useEffect(() => {
    let cancelled = false

    void reportAppStart()

    const initializeApp = async () => {
      try {
        initSettingData()
        // 先完成数据库和默认工作区初始化，避免首次启动时其他逻辑抢先读取空目录或未建表数据库。
        await initAllDatabases()
        if (cancelled) return

        initShortcut()
        initEditorShortcuts()
        await initVectorDb()
        if (cancelled) return

        initQuickRecordText()
        initShowWindow()

      } catch (error) {
        console.error('Failed to initialize app core:', error)
      }
    }

    void initializeApp()

    return () => {
      cancelled = true
    }
  }, [])

  // 应用界面缩放
  useEffect(() => {
    if (uiScale && uiScale !== 100) {
      document.documentElement.style.fontSize = `${uiScale}%`
    }
  }, [uiScale])

  // 应用字体
  useEffect(() => {
    applyAppFontFamily(appFontFamily)
  }, [appFontFamily])

  // 应用自定义主题颜色
  useEffect(() => {
    applyThemeColors(customThemeColors)
  }, [customThemeColors])

  useEffect(() => {
    switch (currentLocale) {
      case 'zh':
        dayjs.locale(zh);
        break;
      case 'en':
        dayjs.locale(en);
        break;
      default:
        break;
    }
  }, [currentLocale])

  // 禁用浏览器后退快捷键（Backspace）和添加搜索快捷键（Cmd/Ctrl+F）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 搜索快捷键：Cmd+F (macOS) 或 Ctrl+F (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        // 检查焦点是否在编辑器内
        const target = e.target as HTMLElement
        const editorElement = document.getElementById('aritcle-md-editor')
        const isFocusInEditor = editorElement && editorElement.contains(target)

        // 如果焦点在编辑器内，触发编辑器搜索
        if (isFocusInEditor) {
          e.preventDefault()
          // 触发编辑器内搜索
          emitter.emit('editor-search-trigger' as any)
          return
        }

        // 否则打开全局搜索
        e.preventDefault()
        setSearchOpen(true)
        return
      }

      // 如果按下 Backspace 键，且不在可编辑元素中
      if (e.key === 'Backspace') {
        const editableTarget = isEditableKeyboardTarget(e.target)
        if (editableTarget) {
          return
        }

        // 否则阻止默认的后退行为
        e.preventDefault()
      }

    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <TextSizeProvider>
        <TitleBar
          onSearchClick={() => setSearchOpen(true)}
          onActivityClick={() => setActivityOpen(open => !open)}
          activityOpen={activityOpen}
        />
        <main className="flex flex-1 flex-col overflow-hidden w-full h-[calc(100vh-36px)] mt-9">
          {children}
        </main>
        <ActivityDrawer open={activityOpen} onOpenChange={setActivityOpen} />
        <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      </TextSizeProvider>
    </ThemeProvider>
  );
}
