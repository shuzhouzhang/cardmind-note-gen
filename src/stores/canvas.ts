import { create } from 'zustand'
import { initAllDatabases } from '@/db'
import {
  getCanvasProject,
  getCanvasProjects,
  insertCanvasProject,
  permanentlyDeleteCanvasProject,
  renameCanvasProject,
  restoreCanvasProject,
  setCanvasPinnedAt,
  softDeleteCanvasProject,
  updateCanvasDocument,
  updateCanvasHistory,
  updateCanvasThumbnailPath,
} from '@/db/canvases'
import { createCanvasDocument } from '@/lib/canvas/templates'
import { CANVAS_THUMBNAIL_VERSION, generateCanvasThumbnail, removeCanvasThumbnail } from '@/lib/canvas/thumbnail'
import { purgeCanvas, uploadCanvas } from '@/lib/sync/canvas-sync'
import { enqueueAutoDataSync } from '@/lib/sync/auto-data-sync-bridge'
import { isAutoDataSyncProviderConfigured } from '@/lib/sync/auto-data-sync-queue'
import type {
  CanvasDocument,
  CanvasHistoryState,
  CanvasProject,
  CanvasProjectType,
  CanvasSelectionContext,
} from '@/types/canvas'

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const thumbnailTimers = new Map<string, ReturnType<typeof setTimeout>>()
const thumbnailGenerationPromises = new Map<string, Promise<void>>()
const thumbnailRepairAttempts = new Set<string>()
const historySaveChains = new Map<string, Promise<void>>()
const canvasSaveInFlight = new Set<string>()
const canvasSaveQueued = new Set<string>()
const remotelyDeletedCanvasIds = new Set<string>()
const MAX_THUMBNAIL_REPAIR_ATTEMPTS = 256

function persistCanvasHistory(id: string, history: CanvasHistoryState) {
  const previousSave = historySaveChains.get(id) || Promise.resolve()
  const nextSave = previousSave
    .catch(() => undefined)
    .then(() => updateCanvasHistory(id, history))
  historySaveChains.set(id, nextSave)
  void nextSave.then(() => {
    if (historySaveChains.get(id) === nextSave) historySaveChains.delete(id)
  }, () => {
    if (historySaveChains.get(id) === nextSave) historySaveChains.delete(id)
  })
}

function hasCurrentThumbnail(project: Pick<CanvasProject, 'thumbnailPath'>) {
  return Boolean(project.thumbnailPath?.endsWith(`-v${CANVAS_THUMBNAIL_VERSION}.png`))
}

function getThumbnailRepairKey(project: Pick<CanvasProject, 'id' | 'updatedAt' | 'thumbnailPath'>) {
  return `${project.id}:${project.updatedAt}:${project.thumbnailPath || 'missing'}`
}

function rememberThumbnailRepairAttempt(key: string) {
  thumbnailRepairAttempts.add(key)
  if (thumbnailRepairAttempts.size <= MAX_THUMBNAIL_REPAIR_ATTEMPTS) return
  const oldestKey = thumbnailRepairAttempts.values().next().value
  if (oldestKey) thumbnailRepairAttempts.delete(oldestKey)
}

export type CanvasDeleteResult = 'local' | 'synced' | 'pending'

interface CanvasState {
  projects: CanvasProject[]
  deletedProjects: CanvasProject[]
  documents: Record<string, CanvasDocument>
  activeCanvasId: string | null
  selectionContext: CanvasSelectionContext | null
  pendingFocus: { canvasId: string; nodeIds: string[] } | null
  loading: boolean
  trashMode: boolean
  loadProjects: () => Promise<void>
  createProject: (canvasType?: CanvasProjectType, title?: string) => Promise<CanvasProject | null>
  createProjectFromDocument: (document: CanvasDocument, title: string, canvasType?: CanvasProjectType) => Promise<CanvasProject | null>
  duplicateProject: (id: string, title?: string) => Promise<CanvasProject | null>
  openProject: (id: string) => Promise<CanvasProject | null>
  setActiveCanvasId: (id: string | null) => void
  setSelectionContext: (context: CanvasSelectionContext | null) => void
  setPendingFocus: (focus: { canvasId: string; nodeIds: string[] } | null) => void
  updateDocument: (id: string, document: CanvasDocument) => void
  updateHistory: (id: string, history: CanvasHistoryState) => void
  saveProject: (id: string) => Promise<void>
  refreshThumbnail: (id: string) => Promise<void>
  repairThumbnail: (id: string) => Promise<void>
  refreshAllThumbnails: () => Promise<void>
  setTrashMode: (open: boolean) => void
  togglePin: (id: string) => Promise<void>
  renameProject: (id: string, title: string) => Promise<void>
  deleteProject: (id: string, syncConfigured?: boolean) => Promise<CanvasDeleteResult>
  permanentlyDeleteProject: (id: string, syncConfigured?: boolean) => Promise<boolean>
  restoreProject: (id: string) => Promise<CanvasProject | null>
}

const useCanvasStore = create<CanvasState>((set, get) => ({
  projects: [],
  deletedProjects: [],
  documents: {},
  activeCanvasId: null,
  selectionContext: null,
  pendingFocus: null,
  loading: false,
  trashMode: false,

  loadProjects: async () => {
    set({ loading: true })
    // 子组件的 effect 可能早于布局初始化执行，查询画布前必须等待所有表和迁移就绪。
    await initAllDatabases()
    const allProjects = await getCanvasProjects({ includeDeleted: true })
    const projects = allProjects.filter(project => !project.deletedAt)
    set({
      projects,
      deletedProjects: allProjects.filter(project => project.deletedAt),
      documents: Object.fromEntries(projects.map(project => [project.id, project.document])),
      loading: false,
    })
    void (async () => {
      for (const project of projects.filter(project => !hasCurrentThumbnail(project))) {
        await get().repairThumbnail(project.id)
      }
    })()
  },

  createProject: async (canvasType = 'blank', title = '未命名画布') => {
    const id = crypto.randomUUID()
    const project = await insertCanvasProject({
      id,
      title,
      canvasType,
      document: createCanvasDocument(canvasType),
    })
    if (!project) return null
    set(state => ({
      projects: [project, ...state.projects],
      documents: { ...state.documents, [project.id]: project.document },
      activeCanvasId: project.id,
      selectionContext: null,
    }))
    void get().refreshThumbnail(project.id)
    return project
  },

  createProjectFromDocument: async (document, title, canvasType = 'blank') => {
    const project = await insertCanvasProject({
      id: crypto.randomUUID(),
      title: title.trim() || '未命名画布',
      canvasType,
      document: structuredClone(document),
    })
    if (!project) return null
    set(state => ({
      projects: [project, ...state.projects],
      documents: { ...state.documents, [project.id]: project.document },
      activeCanvasId: project.id,
      selectionContext: null,
    }))
    void get().refreshThumbnail(project.id)
    return project
  },

  duplicateProject: async (id, title) => {
    const source = get().projects.find(project => project.id === id)
    if (!source) return null
    const project = await insertCanvasProject({
      id: crypto.randomUUID(),
      title: title?.trim() || `${source.title} copy`,
      canvasType: source.canvasType,
      document: structuredClone(get().documents[id] || source.document),
    })
    if (!project) return null
    set(state => ({
      projects: [project, ...state.projects],
      documents: { ...state.documents, [project.id]: project.document },
      activeCanvasId: project.id,
      selectionContext: null,
    }))
    void get().refreshThumbnail(project.id)
    return project
  },

  openProject: async (id) => {
    const cached = get().projects.find(project => project.id === id)
    const project = cached || await getCanvasProject(id)
    if (!project || project.deletedAt) return null
    set(state => ({
      activeCanvasId: id,
      documents: { ...state.documents, [id]: project.document },
      selectionContext: state.selectionContext?.canvasId === id ? state.selectionContext : null,
    }))
    return project
  },

  setActiveCanvasId: (id) => set(state => ({
    activeCanvasId: id,
    selectionContext: state.selectionContext?.canvasId === id ? state.selectionContext : null,
  })),
  setSelectionContext: (selectionContext) => set({ selectionContext }),
  setPendingFocus: (pendingFocus) => set({ pendingFocus }),

  updateDocument: (id, document) => {
    if (remotelyDeletedCanvasIds.has(id)) return
    set(state => ({ documents: { ...state.documents, [id]: document } }))
    const previousTimer = saveTimers.get(id)
    if (previousTimer) clearTimeout(previousTimer)
    saveTimers.set(id, setTimeout(() => {
      saveTimers.delete(id)
      void get().saveProject(id)
    }, 1000))
  },

  updateHistory: (id, history) => {
    const nextHistory = structuredClone(history)
    set(state => ({
      projects: state.projects.map(project => (
        project.id === id ? { ...project, history: nextHistory } : project
      )),
      deletedProjects: state.deletedProjects.map(project => (
        project.id === id ? { ...project, history: nextHistory } : project
      )),
    }))
    persistCanvasHistory(id, nextHistory)
  },

  saveProject: async (id) => {
    if (remotelyDeletedCanvasIds.has(id)) return
    if (canvasSaveInFlight.has(id)) {
      canvasSaveQueued.add(id)
      return
    }
    canvasSaveInFlight.add(id)
    try {
      const document = get().documents[id]
      if (!document) return
      const cachedProject = get().projects.find(project => project.id === id)
      const hasDocumentChanges = !cachedProject
        || JSON.stringify(cachedProject.document) !== JSON.stringify(document)
      if (!hasDocumentChanges) {
        if (!cachedProject?.thumbnailPath) void get().refreshThumbnail(id)
        return
      }
      const updatedAt = await updateCanvasDocument(id, document)
      set(state => ({
        projects: state.projects
          .map(project => project.id === id ? { ...project, document, updatedAt } : project)
          .sort((left, right) => right.updatedAt - left.updatedAt),
      }))
      const previousThumbnailTimer = thumbnailTimers.get(id)
      if (previousThumbnailTimer) clearTimeout(previousThumbnailTimer)
      thumbnailTimers.set(id, setTimeout(() => {
        thumbnailTimers.delete(id)
        void get().refreshThumbnail(id)
      }, 1500))
    } finally {
      canvasSaveInFlight.delete(id)
      if (canvasSaveQueued.delete(id)) void get().saveProject(id)
    }
  },

  refreshThumbnail: async (id) => {
    const pendingGeneration = thumbnailGenerationPromises.get(id)
    if (pendingGeneration) return pendingGeneration
    const project = get().projects.find(item => item.id === id)
      || get().deletedProjects.find(item => item.id === id)
    const document = get().documents[id] || project?.document
    if (!document) return
    const generation = (async () => {
      try {
        const thumbnailPath = await generateCanvasThumbnail(id, document)
        await updateCanvasThumbnailPath(id, thumbnailPath)
        set(state => ({
          projects: state.projects.map(project => project.id === id
            ? { ...project, thumbnailPath, thumbnailRevision: Date.now() }
            : project),
          deletedProjects: state.deletedProjects.map(project => project.id === id
            ? { ...project, thumbnailPath, thumbnailRevision: Date.now() }
            : project),
        }))
      } catch (error) {
        console.error('Failed to generate canvas thumbnail:', error)
      }
    })()
    thumbnailGenerationPromises.set(id, generation)
    try {
      await generation
    } finally {
      if (thumbnailGenerationPromises.get(id) === generation) {
        thumbnailGenerationPromises.delete(id)
      }
    }
  },

  repairThumbnail: async (id) => {
    const project = get().projects.find(item => item.id === id)
      || get().deletedProjects.find(item => item.id === id)
    if (!project) return
    const repairKey = getThumbnailRepairKey(project)
    if (thumbnailRepairAttempts.has(repairKey)) return
    rememberThumbnailRepairAttempt(repairKey)
    await get().refreshThumbnail(id)
  },

  refreshAllThumbnails: async () => {
    for (const project of get().projects) {
      await get().refreshThumbnail(project.id)
    }
  },

  setTrashMode: (trashMode) => set({ trashMode }),

  togglePin: async (id) => {
    const project = get().projects.find(item => item.id === id)
    if (!project) return
    const pinnedAt = project.pinnedAt ? null : Date.now()
    const updatedAt = await setCanvasPinnedAt(id, pinnedAt)
    set(state => ({
      projects: state.projects.map(item => item.id === id ? { ...item, pinnedAt, updatedAt } : item),
    }))
  },

  renameProject: async (id, title) => {
    const normalized = title.trim()
    if (!normalized) return
    const updatedAt = await renameCanvasProject(id, normalized)
    set(state => ({
      projects: state.projects.map(project => (
        project.id === id ? { ...project, title: normalized, updatedAt } : project
      )),
    }))
  },

  deleteProject: async (id, configured) => {
    const timer = saveTimers.get(id)
    if (timer) clearTimeout(timer)
    saveTimers.delete(id)
    const thumbnailTimer = thumbnailTimers.get(id)
    if (thumbnailTimer) clearTimeout(thumbnailTimer)
    thumbnailTimers.delete(id)
    for (const key of thumbnailRepairAttempts) {
      if (key.startsWith(`${id}:`)) thumbnailRepairAttempts.delete(key)
    }
    const deletedAt = await softDeleteCanvasProject(id, { enqueueSync: false })
    const syncConfigured = configured ?? await isAutoDataSyncProviderConfigured()
    let synced = false
    if (syncConfigured) {
      try {
        synced = await uploadCanvas(id)
      } catch {
        synced = false
      }
    }
    // NoteGen Server does not use the legacy canvas storage adapter, so it is
    // intentionally not reported by isAutoDataSyncProviderConfigured(). The
    // shared queue is still the authoritative route for its object tombstone.
    // It also provides the retry path when a legacy provider's direct upload
    // fails.
    if (!synced) enqueueAutoDataSync('records', 'canvas-deleted')
    set(state => {
      const deletedProject = state.projects.find(project => project.id === id)
      const documents = { ...state.documents }
      delete documents[id]
      return {
        projects: state.projects.filter(project => project.id !== id),
        deletedProjects: deletedProject
          ? [{ ...deletedProject, deletedAt, updatedAt: deletedAt }, ...state.deletedProjects]
          : state.deletedProjects,
        documents,
        activeCanvasId: state.activeCanvasId === id ? null : state.activeCanvasId,
        selectionContext: state.selectionContext?.canvasId === id ? null : state.selectionContext,
      }
    })
    if (!syncConfigured) return 'local'
    return synced ? 'synced' : 'pending'
  },

  permanentlyDeleteProject: async (id, configured) => {
    const project = get().deletedProjects.find(item => item.id === id)
    if (!project) return false
    const syncConfigured = configured ?? await isAutoDataSyncProviderConfigured()
    if (syncConfigured && !await purgeCanvas(id)) return false
    await permanentlyDeleteCanvasProject(id)
    try {
      await removeCanvasThumbnail(project.thumbnailPath)
    } catch (error) {
      console.error('Failed to remove canvas thumbnail:', error)
    }
    set(state => ({
      deletedProjects: state.deletedProjects.filter(item => item.id !== id),
    }))
    return true
  },

  restoreProject: async (id) => {
    const project = await restoreCanvasProject(id)
    if (!project) return null
    set(state => ({
      projects: [project, ...state.projects],
      deletedProjects: state.deletedProjects.filter(item => item.id !== id),
      documents: { ...state.documents, [id]: project.document },
    }))
    if (!hasCurrentThumbnail(project)) void get().refreshThumbnail(id)
    return project
  },
}))

export default useCanvasStore

export function acceptCanvasProjectFromSync(id: string): void {
  remotelyDeletedCanvasIds.delete(id)
}

export function discardCanvasProjectFromSync(id: string): void {
  remotelyDeletedCanvasIds.add(id)
  const saveTimer = saveTimers.get(id)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimers.delete(id)
  const thumbnailTimer = thumbnailTimers.get(id)
  if (thumbnailTimer) clearTimeout(thumbnailTimer)
  thumbnailTimers.delete(id)
  canvasSaveQueued.delete(id)
  useCanvasStore.setState(state => {
    const documents = { ...state.documents }
    delete documents[id]
    return {
      projects: state.projects.filter(project => project.id !== id),
      deletedProjects: state.deletedProjects.filter(project => project.id !== id),
      documents,
      activeCanvasId: state.activeCanvasId === id ? null : state.activeCanvasId,
      selectionContext: state.selectionContext?.canvasId === id ? null : state.selectionContext,
      pendingFocus: state.pendingFocus?.canvasId === id ? null : state.pendingFocus,
    }
  })
}
