'use client'

import { Brain, FileText, MessageSquareText, FolderOpen } from 'lucide-react'
import useArticleStore from '@/stores/article'
import { useTranslations } from 'next-intl'
import { open } from '@tauri-apps/plugin-dialog'
import { Store } from '@tauri-apps/plugin-store'
import emitter from '@/lib/emitter'
import { useEffect, useState } from 'react'
import useShortcutStore from '@/stores/shortcut'
import useSettingStore from '@/stores/setting'
import { useSidebarStore } from '@/stores/sidebar'
import { getActiveOnboardingStep, getNextOnboardingStep, type OnboardingProgress, type OnboardingStepId } from './onboarding-state'
import { createNewNoteFromEmptyState } from './empty-state-actions'
import { useRouter } from 'next/navigation'

interface ActionItem {
  icon: React.ReactNode
  title: string
  description: string
  shortcut?: string
  onClick: () => void
}

interface EmptyStateProps {
  onboardingProgress: OnboardingProgress
  activeOnboardingStep: OnboardingStepId | null
  visibleOnboardingStep: OnboardingStepId | null
  completedOnboardingStep: OnboardingStepId | null
  onStartOnboardingStep: (step: OnboardingStepId) => void | Promise<void>
  onContinueToNextStep: () => void | Promise<void>
  onDismissOnboarding: () => void | Promise<void>
}

export function EmptyState({
  onboardingProgress,
  activeOnboardingStep,
  visibleOnboardingStep,
  completedOnboardingStep,
  onStartOnboardingStep,
  onContinueToNextStep,
  onDismissOnboarding,
}: EmptyStateProps) {
  const { newFile } = useArticleStore()
  const { setLeftSidebarTab } = useSidebarStore()
  const t = useTranslations('article.emptyState')
  const { shortcuts } = useShortcutStore()
  const { addWorkspaceHistory } = useSettingStore()
  const router = useRouter()
  const [textRecordShortcut, setTextRecordShortcut] = useState('')

  const handleCreateNote = async () => {
    await createNewNoteFromEmptyState({
      setLeftSidebarTab,
      newFile,
    })
  }

  // 注册快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + N 创建笔记
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        void handleCreateNote()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [newFile, setLeftSidebarTab])

  // 读取文本记录快捷键
  useEffect(() => {
    const shortcut = shortcuts.find(s => s.key === 'quickRecordText')
    if (shortcut) {
      // 转换快捷键格式：CommandOrControl+Shift+T -> ⌘ ⇧ T
      const formatted = shortcut.value
        .replace('CommandOrControl', '⌘')
        .replace('Command', '⌘')
        .replace('Control', 'Ctrl')
        .replace('Shift', '⇧')
        .replace('Alt', '⌥')
        .replace('+', ' ')
      setTextRecordShortcut(formatted)
    }
  }, [shortcuts])

  const handleOpenWorkspace = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择工作区目录'
      })
      
      if (selected && typeof selected === 'string') {
        const store = await Store.load('store.json')
        await store.set('workspacePath', selected)
        await store.save()
        
        // 添加到历史记录
        await addWorkspaceHistory(selected)
        
        // 重新加载页面以应用新工作区
        window.location.reload()
      }
    } catch (error) {
      console.error('Failed to open workspace:', error)
    }
  }

  const handleOpenRecord = () => {
    // 触发文本记录弹窗
    emitter.emit('quickRecordTextHandler')
  }

  const actions: ActionItem[] = [
    {
      icon: <FileText className="w-5 h-5" />,
      title: t('actions.newNote.title'),
      description: t('actions.newNote.desc'),
      shortcut: '⌘ N',
      onClick: () => void handleCreateNote()
    },
    {
      icon: <MessageSquareText className="w-5 h-5" />,
      title: t('actions.newRecord.title'),
      description: t('actions.newRecord.desc'),
      shortcut: textRecordShortcut,
      onClick: handleOpenRecord
    },
    {
      icon: <Brain className="w-5 h-5" />,
      title: t('actions.cards.title'),
      description: t('actions.cards.desc'),
      onClick: () => router.push('/core/cards')
    },
    {
      icon: <FolderOpen className="w-5 h-5" />,
      title: t('actions.openWorkspace.title'),
      description: t('actions.openWorkspace.desc'),
      onClick: handleOpenWorkspace
    }
  ]

  const onboardingSteps: Array<{ id: OnboardingStepId; title: string; description: string }> = [
    {
      id: 'create-record',
      title: t('onboarding.steps.createRecord.title'),
      description: t('onboarding.steps.createRecord.desc'),
    },
    {
      id: 'organize-note',
      title: t('onboarding.steps.organizeNote.title'),
      description: t('onboarding.steps.organizeNote.desc'),
    },
    {
      id: 'ai-polish',
      title: t('onboarding.steps.aiPolish.title'),
      description: t('onboarding.steps.aiPolish.desc'),
    },
  ]
  const completedStep = onboardingSteps.find((step) => step.id === completedOnboardingStep) || null
  const nextOnboardingStepId = getNextOnboardingStep(onboardingProgress, completedOnboardingStep)
  const hasPendingNextStep = getActiveOnboardingStep(onboardingProgress) !== null
  const currentOnboardingStep = onboardingSteps.find((step) => step.id === activeOnboardingStep)
    || onboardingSteps.find((step) => step.id === nextOnboardingStepId)
    || null
  const currentOnboardingIndex = currentOnboardingStep
    ? onboardingSteps.findIndex((step) => step.id === currentOnboardingStep.id)
    : -1
  const completedOnboardingIndex = completedStep
    ? onboardingSteps.findIndex((step) => step.id === completedStep.id)
    : -1
  const showCompletedCard = Boolean(completedStep && hasPendingNextStep)
  const showOnboardingCard = !onboardingProgress.dismissed && (showCompletedCard || Boolean(currentOnboardingStep))

  return (
    <div className="flex h-full flex-1 items-center justify-center bg-background px-6 py-10">
      <div className="w-full max-w-3xl">
        <div className="cardmind-memory-line pl-6">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.16em] text-muted-foreground">
            <Brain className="size-4 text-amber-600" />
            CARDMIND
          </div>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
            {t('title')}
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>

        <div className="mt-9 grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <button
            onClick={actions[0].onClick}
            className="cardmind-surface group flex min-h-28 items-center gap-4 rounded-xl p-5 text-left transition-colors hover:border-amber-500/50 hover:bg-amber-500/[.035] focus-visible:outline-2 focus-visible:outline-ring"
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
              {actions[0].icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{actions[0].title}</div>
              <div className="mt-1 text-xs text-muted-foreground">{actions[0].description}</div>
            </div>
            <kbd className="rounded border bg-muted/70 px-2 py-1 font-mono text-[10px] text-muted-foreground">{actions[0].shortcut}</kbd>
          </button>

          <div className="cardmind-surface divide-y rounded-xl px-4">
            {actions.slice(1).map((action) => (
              <button
                key={action.title}
                onClick={action.onClick}
                className="group flex w-full items-center gap-3 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
                  {action.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{action.title}</div>
                  <div className="truncate text-xs text-muted-foreground">{action.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {showOnboardingCard && (
          <div className="mt-5 rounded-xl border border-dashed bg-muted/20 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{t('onboarding.title')}</h3>
                <p className="text-xs text-muted-foreground">{t('onboarding.subtitle')}</p>
              </div>
              <button
                onClick={() => void onDismissOnboarding()}
                className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('onboarding.dismiss')}
              </button>
            </div>

            {showCompletedCard && completedStep ? (
              <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-emerald-500/5 px-3 py-2.5">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">
                      {t('onboarding.stepCompletedLabel', { current: completedOnboardingIndex + 1, total: onboardingSteps.length })}
                    </p>
                    <h4 className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
                      {t(`onboarding.completedStates.${completedStep.id}.title`)}
                    </h4>
                    <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80">
                      {t(`onboarding.completedStates.${completedStep.id}.desc`)}
                    </p>
                  </div>
                </div>
                <button onClick={() => void onContinueToNextStep()} className="shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500">{t('onboarding.continue')}</button>
              </div>
            ) : currentOnboardingStep ? (
              <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-background px-3 py-2.5">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      {t('onboarding.stepLabel', { current: currentOnboardingIndex + 1, total: onboardingSteps.length })}
                    </p>
                    <h4 className="text-sm font-medium">{currentOnboardingStep.title}</h4>
                    <p className="text-xs text-muted-foreground">{currentOnboardingStep.description}</p>
                  </div>
                </div>
                <button onClick={() => void onStartOnboardingStep(currentOnboardingStep.id)} className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">{visibleOnboardingStep === currentOnboardingStep.id ? t('onboarding.viewHint') : t('onboarding.start')}</button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
