import { create } from 'zustand'
import {
  getCanvasProject,
  getCanvasProjects,
  insertCanvasProject,
  renameCanvasProject,
  restoreCanvasProject,
  setCanvasPinnedAt,
  softDeleteCanvasProject,
  updateCanvasDocument,
  updateCanvasHistory,
  updateCanvasThumbnailPath,
} from '@/db/canvases'
import { createCanvasDocument } from '@/lib/canvas/templates'
import { CANVAS_THUMBNAIL_VERSION, generateCanvasThumbnail } from '@/lib/canvas/thumbnail'
import type { CanvasDocument, CanvasHistoryState, CanvasProject, CanvasProjectType } from '@/types/canvas'

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const thumbnailTimers = new Map<string, ReturnType<typeof setTimeout>>()
const historySaveChains = new Map<string, Promise<void>>()

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

export type CanvasSortMode = 'updated' | 'created' | 'name'

interface CanvasState {
  projects: CanvasProject[]
  deletedProjects: CanvasProject[]
  documents: Record<string, CanvasDocument>
  activeCanvasId: string | null
  loading: boolean
  viewMode: 'grid' | 'list'
  sortMode: CanvasSortMode
  trashMode: boolean
  loadProjects: () => Promise<void>
  createProject: (canvasType?: CanvasProjectType, title?: string) => Promise<CanvasProject | null>
  createProjectFromDocument: (document: CanvasDocument, title: string, canvasType?: CanvasProjectType) => Promise<CanvasProject | null>
  duplicateProject: (id: string, title?: string) => Promise<CanvasProject | null>
  openProject: (id: string) => Promise<CanvasProject | null>
  setActiveCanvasId: (id: string | null) => void
  updateDocument: (id: string, document: CanvasDocument) => void
  updateHistory: (id: string, history: CanvasHistoryState) => void
  saveProject: (id: string) => Promise<void>
  refreshThumbnail: (id: string) => Promise<void>
  refreshAllThumbnails: () => Promise<void>
  setViewMode: (mode: 'grid' | 'list') => void
  setSortMode: (mode: CanvasSortMode) => void
  setTrashMode: (open: boolean) => void
  togglePin: (id: string) => Promise<void>
  renameProject: (id: string, title: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  restoreProject: (id: string) => Promise<CanvasProject | null>
}

const useCanvasStore = create<CanvasState>((set, get) => ({
  projects: [],
  deletedProjects: [],
  documents: {},
  activeCanvasId: null,
  loading: false,
  viewMode: 'grid',
  sortMode: 'updated',
  trashMode: false,

  loadProjects: async () => {
    set({ loading: true })
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
        await get().refreshThumbnail(project.id)
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
    }))
    return project
  },

  setActiveCanvasId: (id) => set({ activeCanvasId: id }),

  updateDocument: (id, document) => {
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
  },

  refreshThumbnail: async (id) => {
    const document = get().documents[id]
    if (!document) return
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
  },

  refreshAllThumbnails: async () => {
    for (const project of get().projects) {
      await get().refreshThumbnail(project.id)
    }
  },

  setViewMode: (viewMode) => set({ viewMode }),

  setSortMode: (sortMode) => set({ sortMode }),

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

  deleteProject: async (id) => {
    const timer = saveTimers.get(id)
    if (timer) clearTimeout(timer)
    saveTimers.delete(id)
    const thumbnailTimer = thumbnailTimers.get(id)
    if (thumbnailTimer) clearTimeout(thumbnailTimer)
    thumbnailTimers.delete(id)
    await softDeleteCanvasProject(id)
    set(state => {
      const deletedProject = state.projects.find(project => project.id === id)
      const documents = { ...state.documents }
      delete documents[id]
      return {
        projects: state.projects.filter(project => project.id !== id),
        deletedProjects: deletedProject
          ? [{ ...deletedProject, deletedAt: Date.now() }, ...state.deletedProjects]
          : state.deletedProjects,
        documents,
        activeCanvasId: state.activeCanvasId === id ? null : state.activeCanvasId,
      }
    })
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
