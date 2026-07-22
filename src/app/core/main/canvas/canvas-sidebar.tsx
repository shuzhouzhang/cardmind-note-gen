'use client'

import { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { convertFileSrc } from '@tauri-apps/api/core'
import { ArrowDownAZ, BrainCircuit, CalendarDays, CopyPlus, EllipsisVertical, FilePlus2, LayoutGrid, List, MoreHorizontal, Pencil, Pin, PinOff, RefreshCw, RotateCcw, Shapes, Trash2, Workflow, XCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import useCanvasStore from '@/stores/canvas'
import type { CanvasSortMode } from '@/stores/canvas'
import type { CanvasProject, CanvasProjectType } from '@/types/canvas'
import useArticleStore from '@/stores/article'
import { createCanvasTab, getCanvasTabPath } from './canvas-tab'
import { setCanvasDragData } from '@/lib/canvas/canvas-dnd'
import { canvasDocumentToSvg } from '@/lib/canvas/static-export'

function CanvasThumbnail({ project, compact = false }: { project: CanvasProject; compact?: boolean }) {
  const fallback = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(canvasDocumentToSvg(project.document))}`
  const source = project.thumbnailPath
    ? `${convertFileSrc(project.thumbnailPath)}?v=${project.updatedAt}`
    : fallback

  return (
    <span className={cn(
      'relative block shrink-0 overflow-hidden border bg-muted/30',
      compact ? 'h-10 w-14 rounded-md' : 'aspect-[4/3] w-full rounded-t-lg border-x-0 border-t-0'
    )}>
      <Image
        src={source}
        alt=""
        fill
        unoptimized
        sizes={compact ? '56px' : '140px'}
        className="object-cover"
      />
    </span>
  )
}

export function CanvasActions() {
  const t = useTranslations('canvas')
  const createProject = useCanvasStore(state => state.createProject)
  const viewMode = useCanvasStore(state => state.viewMode)
  const setViewMode = useCanvasStore(state => state.setViewMode)
  const refreshAllThumbnails = useCanvasStore(state => state.refreshAllThumbnails)
  const sortMode = useCanvasStore(state => state.sortMode)
  const setSortMode = useCanvasStore(state => state.setSortMode)
  const trashMode = useCanvasStore(state => state.trashMode)
  const setTrashMode = useCanvasStore(state => state.setTrashMode)
  const addTab = useArticleStore(state => state.addTab)
  const [refreshing, setRefreshing] = useState(false)

  const handleCreate = async (canvasType: CanvasProjectType) => {
    const project = await createProject(canvasType, t(`templates.${canvasType}`))
    if (project) await addTab(createCanvasTab(project))
  }

  const changeViewMode = (mode: string) => {
    if (mode !== 'grid' && mode !== 'list') return
    setViewMode(mode)
    window.localStorage.setItem('canvas-manager-view-mode', mode)
  }

  const handleRefreshThumbnails = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refreshAllThumbnails()
    } finally {
      setRefreshing(false)
    }
  }

  const changeSortMode = (mode: string) => {
    if (mode !== 'updated' && mode !== 'created' && mode !== 'name') return
    setSortMode(mode as CanvasSortMode)
    window.localStorage.setItem('canvas-manager-sort-mode', mode)
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" title={t('new')} aria-label={t('new')}>
            <FilePlus2 />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t('chooseTemplate')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => void handleCreate('blank')}><FilePlus2 />{t('templates.blank')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleCreate('flowchart')}><Workflow />{t('templates.flowchart')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleCreate('mindmap')}><BrainCircuit />{t('templates.mindmap')}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={viewMode === 'grid' ? t('manager.switchToList') : t('manager.switchToGrid')}
        aria-label={viewMode === 'grid' ? t('manager.switchToList') : t('manager.switchToGrid')}
        onClick={() => changeViewMode(viewMode === 'grid' ? 'list' : 'grid')}
      >
        {viewMode === 'grid' ? <LayoutGrid /> : <List />}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" title={t('more')} aria-label={t('more')}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('manager.view')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={viewMode} onValueChange={changeViewMode}>
              <DropdownMenuRadioItem value="grid"><LayoutGrid />{t('manager.grid')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="list"><List />{t('manager.list')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('manager.sort.title')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sortMode} onValueChange={changeSortMode}>
              <DropdownMenuRadioItem value="updated"><RefreshCw />{t('manager.sort.updated')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="created"><CalendarDays />{t('manager.sort.created')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="name"><ArrowDownAZ />{t('manager.sort.name')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={refreshing} onSelect={() => void handleRefreshThumbnails()}>
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
              {t('manager.refreshThumbnails')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => setTrashMode(!trashMode)}>
              {trashMode ? <XCircle /> : <Trash2 />}
              {trashMode ? t('manager.closeTrash') : t('trash')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function CanvasSidebar() {
  const t = useTranslations('canvas')
  const projects = useCanvasStore(state => state.projects)
  const deletedProjects = useCanvasStore(state => state.deletedProjects)
  const loadProjects = useCanvasStore(state => state.loadProjects)
  const openProject = useCanvasStore(state => state.openProject)
  const createProject = useCanvasStore(state => state.createProject)
  const duplicateProject = useCanvasStore(state => state.duplicateProject)
  const deleteProject = useCanvasStore(state => state.deleteProject)
  const renameProject = useCanvasStore(state => state.renameProject)
  const restoreProject = useCanvasStore(state => state.restoreProject)
  const togglePin = useCanvasStore(state => state.togglePin)
  const activeCanvasId = useCanvasStore(state => state.activeCanvasId)
  const sortMode = useCanvasStore(state => state.sortMode)
  const setSortMode = useCanvasStore(state => state.setSortMode)
  const trashMode = useCanvasStore(state => state.trashMode)
  const addTab = useArticleStore(state => state.addTab)
  const removeTab = useArticleStore(state => state.removeTab)
  const openTabs = useArticleStore(state => state.openTabs)
  const setOpenTabs = useArticleStore(state => state.setOpenTabs)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [pendingDelete, setPendingDelete] = useState<CanvasProject | null>(null)
  const viewMode = useCanvasStore(state => state.viewMode)
  const setViewMode = useCanvasStore(state => state.setViewMode)

  useEffect(() => {
    void loadProjects()
    const savedMode = window.localStorage.getItem('canvas-manager-view-mode')
    if (savedMode === 'grid' || savedMode === 'list') setViewMode(savedMode)
    const savedSort = window.localStorage.getItem('canvas-manager-sort-mode')
    if (savedSort === 'updated' || savedSort === 'created' || savedSort === 'name') setSortMode(savedSort)
  }, [loadProjects, setSortMode, setViewMode])

  const visibleProjects = useMemo(() => {
    const source = trashMode ? deletedProjects : projects
    return [...source].sort((left, right) => {
      if (!trashMode && Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1
      if (!trashMode && left.pinnedAt && right.pinnedAt) return right.pinnedAt - left.pinnedAt
      if (sortMode === 'created') return right.createdAt - left.createdAt
      if (sortMode === 'name') return left.title.localeCompare(right.title)
      return right.updatedAt - left.updatedAt
    })
  }, [deletedProjects, projects, sortMode, trashMode])

  const handleOpen = async (id: string) => {
    const project = await openProject(id)
    if (project) await addTab(createCanvasTab(project))
  }

  const handleCreate = async (canvasType: CanvasProjectType = 'blank') => {
    const project = await createProject(canvasType, t(`templates.${canvasType}`))
    if (project) await addTab(createCanvasTab(project))
  }

  const handleRestore = async (id: string) => {
    const project = await restoreProject(id)
    if (project) await addTab(createCanvasTab(project))
  }

  const handleDuplicate = async (project: CanvasProject) => {
    const duplicate = await duplicateProject(
      project.id,
      t('duplicateTitle', { title: project.title })
    )
    if (duplicate) await addTab(createCanvasTab(duplicate))
  }

  const handleDelete = async (id: string) => {
    const tabId = getCanvasTabPath(id)
    const wasActive = useArticleStore.getState().activeTabId === tabId
    await deleteProject(id)
    await removeTab(tabId)
    if (wasActive) {
      await useArticleStore.getState().setActiveTabId('')
      await useArticleStore.getState().setActiveFilePath('')
    }
  }

  const finishRename = async () => {
    if (!editingId) return
    const normalizedTitle = editingTitle.trim()
    await renameProject(editingId, normalizedTitle)
    if (normalizedTitle) {
      await setOpenTabs(openTabs.map(tab => (
        tab.canvasId === editingId ? { ...tab, name: normalizedTitle } : tab
      )))
    }
    setEditingId(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {visibleProjects.length === 0 ? (
          <Empty className="min-h-72 border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">{trashMode ? <Trash2 /> : <Shapes />}</EmptyMedia>
              <EmptyTitle>{trashMode ? t('manager.trashEmpty') : t('empty.title')}</EmptyTitle>
              <EmptyDescription>{trashMode ? t('manager.trashEmptyDescription') : t('empty.description')}</EmptyDescription>
            </EmptyHeader>
            {!trashMode && (
              <EmptyContent>
                <Button onClick={() => void handleCreate('blank')}>
                  <Shapes data-icon="inline-start" />
                  {t('new')}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <div className={cn('p-2', viewMode === 'grid' ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-1')}>
        {visibleProjects.map(project => (
          <ContextMenu key={project.id}>
            <ContextMenuTrigger asChild>
          <div className={cn(
            'group relative overflow-hidden rounded-lg border bg-card transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-sm',
            viewMode === 'list' && 'flex items-center gap-2 p-1',
            !trashMode && activeCanvasId === project.id && 'border-primary ring-1 ring-primary/30',
            trashMode && 'opacity-75 hover:opacity-100'
          )}
            draggable={!trashMode && editingId !== project.id}
            onDragStart={event => !trashMode && setCanvasDragData(event.dataTransfer, project.id)}
          >
            {!trashMode && editingId === project.id ? (
              <div className={cn('flex min-w-0 flex-1 items-center gap-2', viewMode === 'grid' ? 'p-2' : 'px-1')}>
                {viewMode === 'list' && <CanvasThumbnail project={project} compact />}
                <Input
                  autoFocus
                  value={editingTitle}
                  onChange={event => setEditingTitle(event.target.value)}
                  onBlur={() => void finishRename()}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void finishRename()
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                  className="h-7"
                />
              </div>
            ) : (
              <button
                type="button"
                draggable={!trashMode}
                onDragStart={event => !trashMode && setCanvasDragData(event.dataTransfer, project.id)}
                className={cn(
                  'min-w-0 text-left',
                  viewMode === 'grid' ? 'block w-full' : 'flex flex-1 items-center gap-2'
                )}
                onClick={() => void (trashMode ? handleRestore(project.id) : handleOpen(project.id))}
              >
                <CanvasThumbnail project={project} compact={viewMode === 'list'} />
                <span className={cn(
                  'block min-w-0 flex-1 truncate text-sm font-medium',
                  viewMode === 'grid' ? 'px-2 py-2 pr-8' : 'pr-7'
                )}>{project.title}</span>
              </button>
            )}
            {!trashMode && project.pinnedAt && (
              <span className="pointer-events-none absolute left-1 top-1 rounded-md bg-background/85 p-1 text-primary shadow-sm">
                <Pin className="size-3" />
              </span>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    'absolute right-1 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100',
                    viewMode === 'grid' ? 'bottom-1' : 'top-1/2 -translate-y-1/2'
                  )}
                >
                  <MoreHorizontal />
                  <span className="sr-only">{t('more')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {trashMode ? (
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => void handleRestore(project.id)}>
                      <RotateCcw />
                      {t('restore')}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                ) : (<>
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => void togglePin(project.id)}>
                    {project.pinnedAt ? <PinOff /> : <Pin />}
                    {project.pinnedAt ? t('manager.unpin') : t('manager.pin')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    setEditingId(project.id)
                    setEditingTitle(project.title)
                  }}>
                    <Pencil />
                    {t('rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleDuplicate(project)}>
                    <CopyPlus />
                    {t('duplicate')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onSelect={() => setPendingDelete(project)}>
                    <Trash2 />
                    {t('delete')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                </>) }
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {trashMode ? (
                <ContextMenuGroup>
                  <ContextMenuItem onSelect={() => void handleRestore(project.id)}>
                    <RotateCcw />
                    {t('restore')}
                  </ContextMenuItem>
                </ContextMenuGroup>
              ) : (<>
              <ContextMenuGroup>
                <ContextMenuItem onSelect={() => void handleOpen(project.id)}>
                  <Shapes />
                  {t('open')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void togglePin(project.id)}>
                  {project.pinnedAt ? <PinOff /> : <Pin />}
                  {project.pinnedAt ? t('manager.unpin') : t('manager.pin')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => {
                  setEditingId(project.id)
                  setEditingTitle(project.title)
                }}>
                  <Pencil />
                  {t('rename')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void handleDuplicate(project)}>
                  <CopyPlus />
                  {t('duplicate')}
                </ContextMenuItem>
              </ContextMenuGroup>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => setPendingDelete(project)}>
                <Trash2 />
                {t('delete')}
              </ContextMenuItem>
              </>) }
            </ContextMenuContent>
          </ContextMenu>
          ))}
          </div>
        )}

      </ScrollArea>

      {(projects.length > 0 || deletedProjects.length > 0) && (
        <div className="flex h-6 shrink-0 items-center overflow-hidden border-t border-border bg-background px-2 text-xs text-muted-foreground">
          <span>{trashMode
            ? t('manager.trashCount', { count: visibleProjects.length })
            : t('manager.count', { count: visibleProjects.length })}</span>
        </div>
      )}

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={open => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteDialog.description', { title: pendingDelete?.title || '' })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) void handleDelete(pendingDelete.id)
                setPendingDelete(null)
              }}
            >
              {t('deleteDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
