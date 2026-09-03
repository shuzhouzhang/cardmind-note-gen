'use client'

import { useEffect, useMemo, useState } from "react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  ExternalLink,
  GitBranch,
  MessageSquareText,
  Network,
  RefreshCw,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { KnowledgeCardWithReview } from "@/db/cards"

type KnowledgeRole = "mainline" | "derived"

interface SourceGroup {
  key: string
  title: string
  type: string
  updatedAt: number
  cards: KnowledgeCardWithReview[]
}

interface GraphNode {
  card: KnowledgeCardWithReview
  role: KnowledgeRole
  parentId: number | null
  x: number
  y: number
}

interface GraphEdge {
  fromId: number
  toId: number
  role: KnowledgeRole
}

const MAINLINE_TAGS = new Set(["主线", "核心", "关键", "基础", "mainline", "core"])
const DERIVED_TAGS = new Set(["衍生", "扩展", "延伸", "补充", "进阶", "derived"])
const ROLE_TAGS = new Set([...MAINLINE_TAGS, ...DERIVED_TAGS])

function tagsFromJson(tagsJson: string) {
  try {
    const value = JSON.parse(tagsJson)
    return Array.isArray(value) ? value.map(String).map(tag => tag.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function shortLabel(value: string, length = 16) {
  const label = value.replace(/[？?。.!！]+$/g, "").trim()
  return label.length > length ? `${label.slice(0, length)}…` : label
}

function formatUpdatedAt(timestamp: number) {
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  }
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
}

function sourceTypeLabel(type: string) {
  if (type === "chat") return "对话"
  if (type === "record") return "记录"
  if (type === "article") return "笔记"
  return "手动"
}

function cardTags(card: KnowledgeCardWithReview) {
  return tagsFromJson(card.tagsJson)
}

function hasRoleTag(card: KnowledgeCardWithReview, roleTags: Set<string>) {
  return cardTags(card).some(tag => roleTags.has(tag.toLowerCase()))
}

function sharedTopicCount(a: KnowledgeCardWithReview, b: KnowledgeCardWithReview) {
  const aTags = new Set(cardTags(a).map(tag => tag.toLowerCase()).filter(tag => !ROLE_TAGS.has(tag)))
  return cardTags(b).filter(tag => aTags.has(tag.toLowerCase()) && !ROLE_TAGS.has(tag.toLowerCase())).length
}

function sourceKey(card: KnowledgeCardWithReview) {
  return card.sourceRef || `${card.sourceType}:${card.sourceTitle || "未分类"}`
}

// 这是 knowledge_cards 的展示图：关系由结构标签、共享主题和创建顺序推导。
// 它目前不读取 cm_knowledge_edges，避免把展示连线误认为结构化知识引擎中的事实边。
function buildGraph(cards: KnowledgeCardWithReview[]) {
  const ordered = [...cards].sort((a, b) => a.createdAt - b.createdAt).slice(0, 24)
  if (ordered.length === 0) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] }

  const explicitMainline = ordered.filter(card => hasRoleTag(card, MAINLINE_TAGS))
  const explicitDerived = new Set(ordered.filter(card => hasRoleTag(card, DERIVED_TAGS)).map(card => card.id))
  const targetMainlineCount = Math.min(6, Math.max(2, Math.ceil(ordered.length * 0.38)))
  const mainlineIds = new Set(explicitMainline.slice(0, 6).map(card => card.id))

  if (mainlineIds.size < targetMainlineCount) {
    const denominator = Math.max(targetMainlineCount - 1, 1)
    for (let step = 0; step < targetMainlineCount; step += 1) {
      const candidate = ordered[Math.round((ordered.length - 1) * step / denominator)]
      if (candidate && !explicitDerived.has(candidate.id)) mainlineIds.add(candidate.id)
    }
  }

  for (const card of ordered) {
    if (mainlineIds.size >= targetMainlineCount) break
    if (!explicitDerived.has(card.id)) mainlineIds.add(card.id)
  }

  const mainlineCards = ordered.filter(card => mainlineIds.has(card.id)).slice(0, 6)
  if (mainlineCards.length === 0) mainlineCards.push(ordered[0])
  const derivedCards = ordered.filter(card => !mainlineCards.some(main => main.id === card.id))
  const mainlineNodes: GraphNode[] = mainlineCards.map((card, index) => ({
    card,
    role: "mainline",
    parentId: null,
    x: mainlineCards.length === 1 ? 500 : 130 + index * (740 / (mainlineCards.length - 1)),
    y: 300,
  }))

  const childrenByParent = new Map<number, KnowledgeCardWithReview[]>()
  derivedCards.forEach((card, cardIndex) => {
    const parent = mainlineCards.reduce((best, candidate, candidateIndex) => {
      const score = sharedTopicCount(card, candidate) * 10 - Math.abs(cardIndex - candidateIndex)
      return score > best.score ? { card: candidate, score } : best
    }, { card: mainlineCards[Math.min(cardIndex, mainlineCards.length - 1)], score: Number.NEGATIVE_INFINITY })
    childrenByParent.set(parent.card.id, [...(childrenByParent.get(parent.card.id) || []), card])
  })

  const derivedNodes: GraphNode[] = []
  mainlineNodes.forEach((parent, parentIndex) => {
    const children = childrenByParent.get(parent.card.id) || []
    children.forEach((card, childIndex) => {
      const side = childIndex % 2 === 0 ? -1 : 1
      const lane = Math.floor(childIndex / 2)
      const horizontalDirection = parentIndex < mainlineNodes.length / 2 ? -1 : 1
      derivedNodes.push({
        card,
        role: "derived",
        parentId: parent.card.id,
        x: Math.max(74, Math.min(926, parent.x + horizontalDirection * (34 + lane * 48))),
        y: parent.y + side * (118 + lane * 42),
      })
    })
  })

  const edges: GraphEdge[] = []
  mainlineNodes.slice(1).forEach((node, index) => {
    edges.push({ fromId: mainlineNodes[index].card.id, toId: node.card.id, role: "mainline" })
  })
  derivedNodes.forEach(node => {
    if (node.parentId) edges.push({ fromId: node.parentId, toId: node.card.id, role: "derived" })
  })

  return { nodes: [...mainlineNodes, ...derivedNodes], edges }
}

interface CardKnowledgeGraphProps {
  cards: KnowledgeCardWithReview[]
  onOpenSource?: (card: KnowledgeCardWithReview) => void | Promise<void>
  onRequestImport?: (sourceRef?: string) => void
}

export function CardKnowledgeGraph({ cards, onOpenSource, onRequestImport }: CardKnowledgeGraphProps) {
  const sourceGroups = useMemo<SourceGroup[]>(() => {
    const groups = new Map<string, SourceGroup>()
    cards.forEach(card => {
      const key = sourceKey(card)
      const existing = groups.get(key)
      if (existing) {
        existing.cards.push(card)
        existing.updatedAt = Math.max(existing.updatedAt, card.updatedAt)
      } else {
        groups.set(key, {
          key,
          title: card.sourceTitle || (card.sourceType === "manual" ? "手动创建" : "未命名来源"),
          type: card.sourceType,
          updatedAt: card.updatedAt,
          cards: [card],
        })
      }
    })
    return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [cards])

  const [selectedSourceKey, setSelectedSourceKey] = useState("")
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [sourcePanelOpen, setSourcePanelOpen] = useState(true)
  const [sourcePanelWidth, setSourcePanelWidth] = useState(248)

  useEffect(() => {
    if (sourceGroups.length > 0 && !sourceGroups.some(group => group.key === selectedSourceKey)) {
      setSelectedSourceKey(sourceGroups[0].key)
    }
  }, [selectedSourceKey, sourceGroups])

  const visibleCards = useMemo(() => {
    return sourceGroups.find(group => group.key === selectedSourceKey)?.cards || []
  }, [selectedSourceKey, sourceGroups])
  const graph = useMemo(() => buildGraph(visibleCards), [visibleCards])
  const selectedNode = graph.nodes.find(node => node.card.id === selectedCardId) || null
  const selectedGroup = sourceGroups.find(group => group.key === selectedSourceKey)
  const nodeById = useMemo(() => new Map(graph.nodes.map(node => [node.card.id, node])), [graph.nodes])

  useEffect(() => {
    if (selectedCardId && !nodeById.has(selectedCardId)) setSelectedCardId(null)
  }, [nodeById, selectedCardId])

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sourcePanelWidth
    const onMove = (moveEvent: PointerEvent) => {
      setSourcePanelWidth(Math.max(210, Math.min(360, startWidth + moveEvent.clientX - startX)))
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  if (cards.length === 0) {
    return (
      <div className="flex min-h-[520px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-background text-center text-sm text-muted-foreground">
        <Network className="size-9" />
        <div>
          <div className="font-medium text-foreground">还没有可以连接的知识</div>
          <p className="mt-1">先导入一段对话并保存卡片，知识图谱会自动出现。</p>
          {onRequestImport && <Button className="mt-3 bg-violet-600 text-white hover:bg-violet-700" onClick={() => onRequestImport()}><MessageSquareText className="size-4" />导入第一段对话</Button>}
        </div>
      </div>
    )
  }

  return (
    <section className="relative flex min-h-[620px] overflow-hidden rounded-xl border bg-[#f8f9fb] text-slate-800 shadow-sm dark:bg-slate-950 dark:text-slate-100">
      {sourcePanelOpen && (
        <aside
          className="relative hidden shrink-0 flex-col border-r bg-white/85 md:flex dark:bg-slate-950/90"
          style={{ width: sourcePanelWidth }}
        >
          <div className="flex h-14 items-center justify-between border-b px-4">
            <div>
              <p className="text-sm font-semibold">学习图谱</p>
              <p className="text-[11px] text-muted-foreground">{sourceGroups.length} 张独立图谱</p>
            </div>
            <Button variant="ghost" size="icon" className="size-8" onClick={() => setSourcePanelOpen(false)} aria-label="收起来源栏">
              <ChevronLeft className="size-4" />
            </Button>
          </div>

          <div className="m-3 rounded-lg border border-emerald-200/70 bg-emerald-50/70 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-800 dark:text-emerald-300">
              <span className="flex size-5 items-center justify-center rounded-full bg-emerald-600 text-white"><Check className="size-3" /></span>
              同源导入自动合并
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-emerald-700/80 dark:text-emerald-400/80">再次导入同一对话时，只保留新增知识点。</p>
            {onRequestImport && (
              <button
                type="button"
                onClick={() => onRequestImport(selectedGroup?.key)}
                className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-emerald-800 hover:underline dark:text-emerald-300"
              >
                <RefreshCw className="size-3" />检查新内容
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
            {sourceGroups.map(group => (
              <button
                key={group.key}
                type="button"
                onClick={() => setSelectedSourceKey(group.key)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${selectedSourceKey === group.key ? "bg-violet-50 text-violet-900 dark:bg-violet-950/50 dark:text-violet-200" : "hover:bg-slate-100 dark:hover:bg-slate-900"}`}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background"><GitBranch className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{group.title}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{sourceTypeLabel(group.type)}</span><span>·</span><span>{group.cards.length} 点</span><span>·</span><span>{formatUpdatedAt(group.updatedAt)}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div
            role="separator"
            aria-label="调整来源栏宽度"
            aria-orientation="vertical"
            onPointerDown={startResize}
            className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none hover:bg-violet-400/20"
          />
        </aside>
      )}

      <div className="relative min-w-0 flex-1 overflow-hidden">
        <header className="flex h-14 items-center justify-between border-b bg-white/75 px-4 backdrop-blur dark:bg-slate-950/75">
          <div className="flex min-w-0 items-center gap-3">
            {!sourcePanelOpen && (
              <Button variant="outline" size="icon" className="size-8 shrink-0" onClick={() => setSourcePanelOpen(true)} aria-label="展开来源栏">
                <ChevronRight className="size-4" />
              </Button>
            )}
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">{selectedGroup?.title || "选择一张学习图谱"}</h2>
              <p className="truncate text-[11px] text-muted-foreground">每个来源独立成图；主线保持固定，衍生知识围绕对应节点展开</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border-2 border-violet-500 bg-white dark:bg-slate-950" />主线</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full border-2 border-emerald-500 bg-white dark:bg-slate-950" />衍生</span>
          </div>
        </header>

        <div className="h-[565px] overflow-auto">
          <svg viewBox="0 0 1000 600" className="min-h-[560px] min-w-[820px] w-full" role="img" aria-label="知识卡片关系图">
            <defs>
              <marker id="mainline-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6" fill="none" stroke="#8b8fd6" strokeWidth="1.2" />
              </marker>
            </defs>
            <path d="M76 300 H924" stroke="rgba(139,143,214,.09)" strokeWidth="38" strokeLinecap="round" />
            {graph.edges.map(edge => {
              const from = nodeById.get(edge.fromId)
              const to = nodeById.get(edge.toId)
              if (!from || !to) return null
              const isMainline = edge.role === "mainline"
              return (
                <line
                  key={`${edge.fromId}-${edge.toId}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={isMainline ? "#8b8fd6" : "#b8c9c2"}
                  strokeWidth={isMainline ? 2 : 1.25}
                  strokeDasharray={isMainline ? undefined : "3 4"}
                  markerEnd={isMainline ? "url(#mainline-arrow)" : undefined}
                />
              )
            })}
            {graph.nodes.map(node => {
              const selected = node.card.id === selectedCardId
              const mainline = node.role === "mainline"
              const radius = mainline ? 22 : 13
              return (
                <g
                  key={node.card.id}
                  transform={`translate(${node.x} ${node.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${mainline ? "主线" : "衍生"}知识：${node.card.question}`}
                  onClick={() => setSelectedCardId(node.card.id)}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") setSelectedCardId(node.card.id)
                  }}
                  className="cursor-pointer outline-none"
                >
                  <circle r={radius + 8} fill={selected ? "rgba(139,143,214,.12)" : "transparent"} />
                  <circle
                    r={radius}
                    className={selected
                      ? (mainline ? "fill-[#777bd0]" : "fill-[#63a88e]")
                      : "fill-white dark:fill-slate-950"}
                    stroke={mainline ? "#777bd0" : "#63a88e"}
                    strokeWidth={mainline ? 2.5 : 2}
                  />
                  {mainline ? (
                    <circle r="4" fill={selected ? "white" : "#777bd0"} />
                  ) : (
                    <CircleDot x="-6" y="-6" width="12" height="12" color={selected ? "white" : "#63a88e"} />
                  )}
                  <foreignObject x={mainline ? -78 : -66} y={mainline ? 34 : (node.y < 300 ? -46 : 23)} width={mainline ? 156 : 132} height="42">
                    <div className={`rounded-md px-2 py-1 text-center leading-4 ${mainline ? "text-[11px] font-medium text-slate-800 dark:text-slate-100" : "text-[10px] text-slate-600 dark:text-slate-300"}`}>
                      {shortLabel(node.card.question, mainline ? 20 : 15)}
                    </div>
                  </foreignObject>
                </g>
              )
            })}
          </svg>
        </div>

        <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-white/90 px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur dark:bg-slate-950/90">
          <RefreshCw className="size-3" />
          图谱会在保存新知识点后自动重排
        </div>

        {selectedNode && (
          <aside className="absolute inset-y-0 right-0 z-30 flex w-[min(360px,88%)] flex-col border-l bg-background/98 shadow-[-18px_0_42px_rgba(15,23,42,.10)] backdrop-blur">
            <div className="flex h-14 items-center justify-between border-b px-5">
              <div className="flex items-center gap-2">
                <span className={`size-2.5 rounded-full ${selectedNode.role === "mainline" ? "bg-violet-500" : "bg-emerald-500"}`} />
                <span className="text-xs font-medium">{selectedNode.role === "mainline" ? "主线知识" : "衍生知识"}</span>
              </div>
              <Button variant="ghost" size="icon" className="size-8" onClick={() => setSelectedCardId(null)} aria-label="关闭知识卡片">
                <X className="size-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
              <div className="mb-5 flex flex-wrap gap-1.5">
                {cardTags(selectedNode.card).filter(tag => !ROLE_TAGS.has(tag.toLowerCase())).map(tag => (
                  <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>
                ))}
              </div>
              <h3 className="text-lg font-semibold leading-7 tracking-[-.02em]">{selectedNode.card.question}</h3>
              <div className="my-5 h-px bg-border" />
              <p className="whitespace-pre-wrap text-sm leading-7 text-foreground/85">{selectedNode.card.answer}</p>
              {selectedNode.card.sourceSnippet && (
                <blockquote className="mt-6 border-l-2 border-violet-300 pl-3 text-xs leading-5 text-muted-foreground">
                  {selectedNode.card.sourceSnippet}
                </blockquote>
              )}
              <div className="mt-7 rounded-lg border bg-muted/35 p-3 text-xs text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <span>来源</span>
                  <span className="truncate font-medium text-foreground">{selectedNode.card.sourceTitle || "手动创建"}</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span>最近更新</span>
                  <span>{formatUpdatedAt(selectedNode.card.updatedAt)}</span>
                </div>
              </div>
            </div>
            {selectedNode.card.sourceRef && onOpenSource && (
              <div className="border-t p-4">
                <Button variant="outline" className="w-full" onClick={() => void onOpenSource(selectedNode.card)}>
                  <ExternalLink className="size-4" />查看原始内容
                </Button>
              </div>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}
