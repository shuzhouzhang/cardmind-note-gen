'use client'

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeftFromLine, Brain, Check, Clock3, Edit3, GitBranch, LibraryBig, MessageSquareText, Network, Plus, RotateCcw, Save, Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import useArticleStore from "@/stores/article"
import useMarkStore from "@/stores/mark"
import useCardsStore, { GeneratedCard } from "@/stores/cards"
import type { CardSourceType, KnowledgeCardWithReview, ReviewRating } from "@/db/cards"
import { createRecordTab, getRecordIdFromTabPath, getRecordTabPath } from "@/app/core/main/mark/mark-record-tab"
import { ChatGptImportDialog } from "./chatgpt-import-dialog"
import { CardKnowledgeGraph } from "./card-knowledge-graph"
import type { ImportedChatConversation } from "@/lib/chatgpt-import"
import { openUrl } from "@tauri-apps/plugin-opener"

interface DraftCard {
  question: string
  answer: string
  tags: string
  sourceSnippet?: string
}

interface ReadScope {
  mode: "current-note" | "current-record" | "imported-chat"
  title: string
  path: string | null
  characters: number
}

function tagsFromJson(tagsJson: string) {
  try {
    const tags = JSON.parse(tagsJson)
    return Array.isArray(tags) ? tags.map(tag => String(tag)).filter(Boolean) : []
  } catch {
    return []
  }
}

function splitTags(value: string) {
  return value.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean)
}

function cardToDraft(card: KnowledgeCardWithReview): DraftCard {
  return {
    question: card.question,
    answer: card.answer,
    tags: tagsFromJson(card.tagsJson).join(", "),
    sourceSnippet: card.sourceSnippet || "",
  }
}

function generatedToDraft(card: GeneratedCard): DraftCard {
  return {
    question: card.question,
    answer: card.answer,
    tags: card.tags.join(", "),
    sourceSnippet: card.sourceSnippet || "",
  }
}

function getSourceTitle(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path || "当前笔记"
}

function countReadableCharacters(text: string) {
  return text.replace(/\s+/g, "").length
}

function normalizeCardIdentity(value: string) {
  return value.toLowerCase().replace(/[\s，。！？、,.!?：:；;（）()《》<>\-—_]/g, "")
}

function getRecordText(record: { desc?: string; content?: string; url: string }) {
  return [record.desc, record.content, record.url]
    .map(value => value?.trim())
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join("\n")
}

function getRecordTitle(record: { desc?: string; content?: string; url: string }) {
  const title = record.desc?.trim() || record.content?.trim() || record.url.trim() || "快速记录"
  return title.length > 36 ? `${title.slice(0, 36).trim()}...` : title
}

function formatDue(dueAt: number | null) {
  if (!dueAt) return "现在"
  const delta = dueAt - Date.now()
  if (delta <= 0) return "已到期"
  const minutes = Math.round(delta / 60000)
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时后`
  return `${Math.round(hours / 24)} 天后`
}

export default function CardsPage() {
  const router = useRouter()
  const articleStore = useArticleStore()
  const markStore = useMarkStore()
  const cardsStore = useCardsStore()
  const [previewCards, setPreviewCards] = useState<DraftCard[]>([])
  const [manualDraft, setManualDraft] = useState<DraftCard>({ question: "", answer: "", tags: "" })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingDraft, setEditingDraft] = useState<DraftCard>({ question: "", answer: "", tags: "" })
  const [reviewIndex, setReviewIndex] = useState(0)
  const [answerVisible, setAnswerVisible] = useState(false)
  const [lastReadScope, setLastReadScope] = useState<ReadScope | null>(null)
  const [importedConversation, setImportedConversation] = useState<ImportedChatConversation | null>(null)
  const [activeTab, setActiveTab] = useState("generate")
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importInitialUrl, setImportInitialUrl] = useState("")
  const [mergeSummary, setMergeSummary] = useState<{ saved: number; skipped: number; title: string } | null>(null)

  useEffect(() => {
    void cardsStore.loadCards()
    void markStore.fetchAllMarks()

    const params = new URLSearchParams(window.location.search)
    if (params.get("import") === "1") {
      setActiveTab("generate")
      setImportDialogOpen(true)
    }
  }, [])

  const activeRecord = useMemo(() => {
    if (!markStore.activeMarkId) return null
    return markStore.marks.find(mark => mark.id === markStore.activeMarkId)
      || markStore.allMarks.find(mark => mark.id === markStore.activeMarkId)
      || null
  }, [markStore.activeMarkId, markStore.allMarks, markStore.marks])

  const currentRecordText = activeRecord ? getRecordText(activeRecord) : ""
  const hasCurrentNote = Boolean(articleStore.activeFilePath)
  const currentText = importedConversation?.markdown || (hasCurrentNote ? articleStore.currentArticle : currentRecordText)
  const currentSource = useMemo(() => {
    if (importedConversation) {
      return {
        sourceType: "chat" as CardSourceType,
        sourceRef: importedConversation.sourceUrl || `chat-import:${importedConversation.title}:${importedConversation.messages.length}`,
        sourceTitle: importedConversation.title,
      }
    }

    if (articleStore.activeFilePath) {
      return {
        sourceType: "article" as CardSourceType,
        sourceRef: articleStore.activeFilePath,
        sourceTitle: getSourceTitle(articleStore.activeFilePath),
      }
    }

    if (activeRecord) {
      return {
        sourceType: "record" as CardSourceType,
        sourceRef: getRecordTabPath(activeRecord.id),
        sourceTitle: getRecordTitle(activeRecord),
      }
    }

    return {
      sourceType: "article" as CardSourceType,
      sourceRef: null,
      sourceTitle: "尚未选择内容",
    }
  }, [activeRecord, articleStore.activeFilePath, importedConversation])

  const stats = useMemo(() => {
    const now = Date.now()
    return {
      total: cardsStore.cards.length,
      due: cardsStore.dueCards.length,
      mastered: cardsStore.cards.filter(card => card.reviewCount >= 3 && card.dueAt && card.dueAt > now).length,
    }
  }, [cardsStore.cards, cardsStore.dueCards])

  const activeReviewCard = cardsStore.dueCards[reviewIndex] || cardsStore.dueCards[0]
  const currentCharacters = countReadableCharacters(currentText || "")
  const currentSourceLabel = currentSource.sourceType === "chat"
    ? "刚导入的 ChatGPT 对话"
    : currentSource.sourceType === "record" ? "当前打开的记录" : "当前打开的笔记"
  const canReadCurrentSource = Boolean(currentSource.sourceRef) && currentCharacters > 0
  const flowStep = activeTab !== "generate" ? 4 : cardsStore.generating ? 2 : previewCards.length > 0 ? 3 : 1

  function openImportDialog(sourceRef?: string) {
    setImportInitialUrl(sourceRef && /^https:\/\//i.test(sourceRef) ? sourceRef : "")
    setActiveTab("generate")
    setImportDialogOpen(true)
  }

  async function generateFromCurrentNote() {
    const text = currentText.trim()
    if (!text) {
      useCardsStore.setState({ error: "当前没有可制卡的内容。请先打开一篇笔记或一条快速记录。" })
      setLastReadScope(null)
      return
    }

    setLastReadScope({
      mode: currentSource.sourceType === "chat"
        ? "imported-chat"
        : currentSource.sourceType === "record" ? "current-record" : "current-note",
      title: currentSource.sourceTitle,
      path: currentSource.sourceRef,
      characters: text.length,
    })
    const generated = await cardsStore.generateCardsFromText(text, currentSource)
    setPreviewCards(generated.map(generatedToDraft))
  }

  async function importAndGenerate(conversation: ImportedChatConversation) {
    setMergeSummary(null)
    setActiveTab("generate")
    setImportedConversation(conversation)
    const source = {
      sourceType: "chat" as CardSourceType,
      sourceRef: conversation.sourceUrl || `chat-import:${conversation.title}:${conversation.messages.length}`,
      sourceTitle: conversation.title,
    }
    setLastReadScope({
      mode: "imported-chat",
      title: conversation.title,
      path: conversation.sourceUrl,
      characters: conversation.markdown.length,
    })
    const generated = await cardsStore.generateCardsFromText(conversation.markdown, source)
    setPreviewCards(generated.map(generatedToDraft))
  }

  async function savePreviewCards() {
    const knownQuestions = new Set(
      cardsStore.cards
        .filter(card => card.sourceRef === currentSource.sourceRef)
        .map(card => normalizeCardIdentity(card.question))
    )

    let saved = 0
    let skipped = 0
    for (const card of previewCards) {
      if (!card.question.trim() || !card.answer.trim()) continue
      const identity = normalizeCardIdentity(card.question)
      if (knownQuestions.has(identity)) {
        skipped += 1
        continue
      }
      await cardsStore.createCard({
        question: card.question,
        answer: card.answer,
        tags: splitTags(card.tags),
        sourceType: currentSource.sourceType,
        sourceRef: currentSource.sourceRef,
        sourceTitle: currentSource.sourceTitle,
        sourceSnippet: card.sourceSnippet,
      })
      knownQuestions.add(identity)
      saved += 1
    }
    setPreviewCards([])
    setMergeSummary({ saved, skipped, title: currentSource.sourceTitle })
    setActiveTab("graph")
  }

  async function saveManualCard() {
    if (!manualDraft.question.trim() || !manualDraft.answer.trim()) {
      useCardsStore.setState({ error: "手动建卡需要填写问题和答案。" })
      return
    }

    await cardsStore.createCard({
      question: manualDraft.question,
      answer: manualDraft.answer,
      tags: splitTags(manualDraft.tags),
      sourceType: "manual",
    })
    setManualDraft({ question: "", answer: "", tags: "" })
  }

  async function saveEditingCard(card: KnowledgeCardWithReview) {
    await cardsStore.updateCard({
      id: card.id,
      question: editingDraft.question,
      answer: editingDraft.answer,
      tags: splitTags(editingDraft.tags),
      sourceType: card.sourceType,
      sourceRef: card.sourceRef,
      sourceTitle: card.sourceTitle,
      sourceSnippet: editingDraft.sourceSnippet,
    })
    setEditingId(null)
  }

  async function openRecordSource(markId: number | null) {
    if (!markId) return
    const mark = markStore.marks.find(item => item.id === markId)
      || markStore.allMarks.find(item => item.id === markId)
    if (!mark) return

    markStore.setActiveMarkId(mark.id)
    const recordTab = createRecordTab(mark, "快速记录")
    const existingTab = articleStore.openTabs.find(tab => tab.path === recordTab.path)
    if (existingTab) {
      await articleStore.setActiveTabId(existingTab.id)
    } else {
      await articleStore.addTab(recordTab)
    }
    await articleStore.setActiveFilePath("")
    router.push("/core/main")
  }

  async function openSource(card: KnowledgeCardWithReview) {
    if (!card.sourceRef) return

    if (card.sourceType === "chat") {
      if (/^https?:\/\//i.test(card.sourceRef)) await openUrl(card.sourceRef)
      return
    }

    if (card.sourceType === "record") {
      await openRecordSource(getRecordIdFromTabPath(card.sourceRef))
      return
    }

    await articleStore.setActiveFilePath(card.sourceRef)
    router.push("/core/main")
  }

  async function openCurrentSource() {
    if (currentSource.sourceType === "record" && activeRecord) {
      await openRecordSource(activeRecord.id)
      return
    }
    if (articleStore.activeFilePath) {
      await articleStore.setActiveFilePath(articleStore.activeFilePath)
    }
    router.push("/core/main")
  }

  async function review(rating: ReviewRating) {
    if (!activeReviewCard) return
    await cardsStore.reviewCard(activeReviewCard.id, rating)
    setAnswerVisible(false)
    setReviewIndex(0)
  }

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-5 py-6 lg:px-8">
        <header className="cardmind-memory-line flex flex-col gap-5 border-b pb-6 pl-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[.16em] text-muted-foreground">
              <Brain className="size-4 text-violet-600" />
              CARDMIND · 知识路径
            </div>
            <h1 className="text-2xl font-semibold tracking-[-.035em] sm:text-3xl">把对话变成一条能继续生长的知识主线。</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">导入一次，AI 拆分主线与衍生知识；以后继续学习时，只合并新增内容。</p>
          </div>
          <div className="flex items-center gap-5 text-sm">
            <div><span className="text-xl font-semibold">{stats.total}</span><span className="ml-1.5 text-xs text-muted-foreground">全部</span></div>
            <div><span className="text-xl font-semibold text-amber-700 dark:text-amber-400">{stats.due}</span><span className="ml-1.5 text-xs text-muted-foreground">待复习</span></div>
            <div><span className="text-xl font-semibold text-emerald-700 dark:text-emerald-400">{stats.mastered}</span><span className="ml-1.5 text-xs text-muted-foreground">已掌握</span></div>
          </div>
        </header>

        <div className="grid grid-cols-4 overflow-hidden rounded-xl border bg-background">
          {["导入对话", "AI 拆分", "确认知识点", "进入图谱"].map((label, index) => {
            const step = index + 1
            const active = step === flowStep
            const done = step < flowStep
            return (
              <div key={label} className={`relative flex items-center gap-2 border-r px-3 py-3 last:border-r-0 ${active ? "bg-violet-50/70 dark:bg-violet-950/25" : ""}`}>
                <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${done ? "bg-emerald-600 text-white" : active ? "bg-violet-600 text-white" : "bg-muted text-muted-foreground"}`}>
                  {done ? <Check className="size-3.5" /> : step}
                </span>
                <span className={`truncate text-xs ${active || done ? "font-medium text-foreground" : "text-muted-foreground"}`}>{label}</span>
              </div>
            )
          })}
        </div>

        {cardsStore.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {cardsStore.error}
          </div>
        )}

        {mergeSummary && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/25">
            <div className="flex items-center gap-2">
              <Check className="size-4 text-emerald-600" />
              <span><strong>{mergeSummary.title}</strong> 已更新：新增 {mergeSummary.saved} 个知识点{mergeSummary.skipped > 0 ? `，自动合并 ${mergeSummary.skipped} 个重复项` : ""}。</span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setMergeSummary(null)}>知道了</Button>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="h-auto w-full justify-start gap-5 rounded-none border-b bg-transparent p-0 sm:w-fit">
            <TabsTrigger className="rounded-none border-b-2 border-transparent px-0 pb-2.5 text-sm shadow-none data-[state=active]:border-violet-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none" value="generate">导入与拆分</TabsTrigger>
            <TabsTrigger className="rounded-none border-b-2 border-transparent px-0 pb-2.5 text-sm shadow-none data-[state=active]:border-violet-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none" value="graph">知识图谱</TabsTrigger>
            <TabsTrigger className="rounded-none border-b-2 border-transparent px-0 pb-2.5 text-sm shadow-none data-[state=active]:border-violet-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none" value="cards">知识卡片</TabsTrigger>
            <TabsTrigger className="rounded-none border-b-2 border-transparent px-0 pb-2.5 text-sm shadow-none data-[state=active]:border-violet-600 data-[state=active]:bg-transparent data-[state=active]:shadow-none" value="review">复习</TabsTrigger>
          </TabsList>

          <TabsContent value="review" className="mt-4">
            <section className={cardsStore.dueCards.length > 0 ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]" : ""}>
              <div className={activeReviewCard ? "cardmind-surface rounded-xl p-5 sm:p-7" : "border-y border-border/70 py-8"}>
                {activeReviewCard ? (
                  <div className="space-y-5">
                    <div className="flex items-center justify-between gap-3">
                      <Badge variant="outline">{reviewIndex + 1} / {cardsStore.dueCards.length}</Badge>
                      <span className="text-xs text-muted-foreground">下次到期：{formatDue(activeReviewCard.dueAt)}</span>
                    </div>
                    <div className="relative min-h-48 overflow-hidden rounded-xl border border-amber-200/70 bg-[linear-gradient(135deg,hsl(43_100%_96%)_0%,hsl(var(--background))_78%)] p-6 dark:border-amber-900/60 dark:bg-[linear-gradient(135deg,hsl(35_28%_16%)_0%,hsl(var(--background))_78%)]">
                      <div className="absolute right-5 top-4 text-5xl font-serif text-amber-500/15">?</div>
                      <div className="mb-3 text-[11px] font-semibold uppercase tracking-[.2em] text-amber-700 dark:text-amber-300">先回忆，再翻答案</div>
                      <div className="max-w-2xl text-xl font-medium leading-relaxed tracking-[-.02em]">{activeReviewCard.question}</div>
                    </div>
                    {answerVisible ? (
                      <div className="rounded-md border border-emerald-600/30 bg-emerald-500/10 p-5">
                        <div className="mb-2 text-xs uppercase text-muted-foreground">Answer</div>
                        <div className="whitespace-pre-wrap leading-relaxed">{activeReviewCard.answer}</div>
                      </div>
                    ) : (
                      <Button onClick={() => setAnswerVisible(true)}>
                        <Sparkles className="size-4" />
                        显示答案
                      </Button>
                    )}
                    {answerVisible && (
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                        <Button variant="outline" onClick={() => review("again")}>忘记了</Button>
                        <Button variant="outline" onClick={() => review("hard")}>有点难</Button>
                        <Button onClick={() => review("good")}>记得</Button>
                        <Button variant="secondary" onClick={() => review("easy")}>很熟练</Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center">
                    <Check className="size-10 text-emerald-600" />
                    <div className="text-lg font-medium">今天没有待复习卡片</div>
                    <p className="max-w-md text-sm text-muted-foreground">新卡片会自动进入复习队列。现在可以去生成卡片，或先继续整理笔记。</p>
                  </div>
                )}
              </div>
              {cardsStore.dueCards.length > 0 && <aside className="cardmind-surface rounded-xl p-4">
                <div className="mb-3 flex items-center gap-2 font-medium">
                  <Clock3 className="size-4" />
                  待复习队列
                </div>
                <div className="space-y-2">
                  {cardsStore.dueCards.slice(0, 8).map((card, index) => (
                    <button
                      key={card.id}
                      className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => {
                        setReviewIndex(index)
                        setAnswerVisible(false)
                      }}
                    >
                      <div className="line-clamp-2">{card.question}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{card.sourceTitle || "手动卡片"}</div>
                    </button>
                  ))}
                </div>
              </aside>}
            </section>
          </TabsContent>

          <TabsContent value="generate" className="mt-4">
            <section className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
              <div className="cardmind-surface rounded-xl p-5 sm:p-6">
                <div className="mb-4 space-y-1">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[.18em] text-violet-600">第一步</div>
                  <h2 className="text-lg font-semibold tracking-tight">选择要学习的内容</h2>
                  <p className="text-sm text-muted-foreground">优先导入完整对话，也可以使用当前打开的笔记或记录。</p>
                </div>

                <div className="mb-4 rounded-xl border border-violet-200/70 bg-violet-50/60 p-4 dark:border-violet-900/60 dark:bg-violet-950/20">
                  <div className="flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-violet-600 shadow-sm dark:bg-violet-950"><MessageSquareText className="size-4" /></span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">导入 ChatGPT 对话</h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">AI 会按学习顺序拆出主线，并把例子、补充和进阶内容放到对应节点周围。</p>
                      <div className="mt-3">
                        <ChatGptImportDialog
                          busy={cardsStore.generating}
                          onImport={importAndGenerate}
                          open={importDialogOpen}
                          onOpenChange={setImportDialogOpen}
                          initialUrl={importInitialUrl}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mb-4 rounded-xl border bg-muted/20 p-4 text-sm">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-medium">或者使用当前内容</span>
                    <Badge variant={canReadCurrentSource ? "secondary" : "outline"}>
                      {canReadCurrentSource ? "可读取" : "没有打开内容"}
                    </Badge>
                  </div>
                  <div className="space-y-1 text-muted-foreground">
                    <div className="flex justify-between gap-3">
                      <span>范围</span>
                      <span className="text-right text-foreground">{currentSourceLabel}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span>文件</span>
                      <span className="max-w-64 truncate text-right text-foreground">
                        {currentSource.sourceTitle}
                      </span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span>正文</span>
                      <span className="text-right text-foreground">{currentCharacters} 字</span>
                    </div>
                  </div>
                  {!canReadCurrentSource && (
                    <p className="mt-3 rounded-md bg-background px-3 py-2 text-xs text-muted-foreground">
                      先回到记录页打开一条记录，或者直接使用上面的“导入对话”。
                    </p>
                  )}
                </div>

                <div className="mb-4 grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={openCurrentSource}>
                    <ArrowLeftFromLine className="size-4" />
                    回到笔记
                  </Button>
                  <Button onClick={generateFromCurrentNote} disabled={cardsStore.generating || !canReadCurrentSource}>
                    <Sparkles className="size-4" />
                    {cardsStore.generating && cardsStore.generationProgress
                      ? `正在处理 ${cardsStore.generationProgress.processedChunks}/${cardsStore.generationProgress.totalChunks}`
                      : "拆分当前内容"}
                  </Button>
                </div>
                {cardsStore.rawModelOutput && previewCards.length === 0 && (
                  <div className="mt-4 space-y-2">
                    <div className="text-sm font-medium">模型原始输出</div>
                    <Textarea className="min-h-40 font-mono text-xs" value={cardsStore.rawModelOutput} readOnly />
                  </div>
                )}
                <details className="mt-5 border-t pt-4">
                  <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">手动添加卡片</summary>
                  <div className="mt-4 space-y-3">
                    <Input placeholder="问题" value={manualDraft.question} onChange={(e) => setManualDraft({ ...manualDraft, question: e.target.value })} />
                    <Textarea placeholder="答案" value={manualDraft.answer} onChange={(e) => setManualDraft({ ...manualDraft, answer: e.target.value })} />
                    <Input placeholder="标签，用逗号或空格分隔" value={manualDraft.tags} onChange={(e) => setManualDraft({ ...manualDraft, tags: e.target.value })} />
                    <Button variant="secondary" onClick={saveManualCard}><Plus className="size-4" />添加卡片</Button>
                  </div>
                </details>
              </div>

              <div className="cardmind-surface rounded-xl p-5 sm:p-6">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.18em] text-violet-600">第三步</div>
                    <h2 className="text-lg font-semibold tracking-tight">确认知识点</h2>
                    <p className="text-sm text-muted-foreground">确认主线是否清楚；保存后会自动进入知识图谱。</p>
                  </div>
                  <Button className="bg-violet-600 text-white hover:bg-violet-700" disabled={previewCards.length === 0} onClick={savePreviewCards}>
                    <Network className="size-4" />
                    放入知识图谱
                  </Button>
                </div>
                {lastReadScope && cardsStore.generationProgress && (
                  <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${cardsStore.generationProgress.complete ? "border-emerald-600/30 bg-emerald-500/10" : "border-amber-600/30 bg-amber-500/10"}`}>
                    <div className={`font-medium ${cardsStore.generationProgress.complete ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>
                      {cardsStore.generationProgress.complete ? "本次已完整处理" : "本次处理未完成"}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {lastReadScope.mode === "imported-chat" ? "ChatGPT 对话" : lastReadScope.mode === "current-record" ? "当前记录" : "当前笔记"}：
                      <span className="text-foreground">{lastReadScope.title}</span>
                      ，源文本 {lastReadScope.characters} 字符
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      已处理 {cardsStore.generationProgress.processedCharacters}/{cardsStore.generationProgress.totalCharacters} 字符
                      · {cardsStore.generationProgress.processedChunks}/{cardsStore.generationProgress.totalChunks} 个分块
                      · {cardsStore.generationProgress.percentage}%
                    </div>
                    {lastReadScope.path && (
                      <div className="mt-1 truncate text-xs text-muted-foreground">{lastReadScope.path}</div>
                    )}
                  </div>
                )}
                {previewCards.length === 0 ? (
                  <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed text-center text-sm text-muted-foreground">
                    <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-violet-50 text-violet-500 dark:bg-violet-950/40"><GitBranch className="size-5" /></span>
                    <span className="font-medium text-foreground">等待拆分知识点</span>
                    <span className="mt-1 max-w-xs text-xs leading-5">导入对话后，主线知识和衍生知识会在这里按顺序出现。</span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {previewCards.map((card, index) => (
                      <div key={index} className="rounded-xl border bg-background p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className={`size-2.5 rounded-full ${splitTags(card.tags).includes("主线") ? "bg-violet-500" : "bg-emerald-500"}`} />
                            <span className="text-xs font-medium">{splitTags(card.tags).includes("主线") ? `主线 ${index + 1}` : "衍生知识"}</span>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => setPreviewCards(previewCards.filter((_, itemIndex) => itemIndex !== index))}>
                            <Trash2 className="size-3.5" />移除
                          </Button>
                        </div>
                        <Input className="mb-2 font-medium" value={card.question} onChange={(e) => {
                          const next = [...previewCards]
                          next[index] = { ...card, question: e.target.value }
                          setPreviewCards(next)
                        }} />
                        <Textarea className="mb-2" value={card.answer} onChange={(e) => {
                          const next = [...previewCards]
                          next[index] = { ...card, answer: e.target.value }
                          setPreviewCards(next)
                        }} />
                        <Input className="mb-2 text-xs" value={card.tags} onChange={(e) => {
                          const next = [...previewCards]
                          next[index] = { ...card, tags: e.target.value }
                          setPreviewCards(next)
                        }} />
                        <Textarea className="min-h-16 text-xs text-muted-foreground" placeholder="来源片段" value={card.sourceSnippet || ""} onChange={(e) => {
                          const next = [...previewCards]
                          next[index] = { ...card, sourceSnippet: e.target.value }
                          setPreviewCards(next)
                        }} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </TabsContent>

          <TabsContent value="cards" className="mt-4">
            <section className="rounded-md border bg-background p-4">
              <div className="mb-4 flex items-center gap-2 font-medium">
                <LibraryBig className="size-4" />
                卡片库
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {cardsStore.cards.map(card => {
                  const tags = tagsFromJson(card.tagsJson)
                  const isEditing = editingId === card.id
                  return (
                    <article key={card.id} className="rounded-md border p-4">
                      {isEditing ? (
                        <div className="space-y-2">
                          <Input value={editingDraft.question} onChange={(e) => setEditingDraft({ ...editingDraft, question: e.target.value })} />
                          <Textarea value={editingDraft.answer} onChange={(e) => setEditingDraft({ ...editingDraft, answer: e.target.value })} />
                          <Input value={editingDraft.tags} onChange={(e) => setEditingDraft({ ...editingDraft, tags: e.target.value })} />
                          <Textarea value={editingDraft.sourceSnippet || ""} onChange={(e) => setEditingDraft({ ...editingDraft, sourceSnippet: e.target.value })} />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => saveEditingCard(card)}>
                              <Save className="size-4" />
                              保存
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>取消</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div>
                            <h3 className="font-medium leading-relaxed">{card.question}</h3>
                            <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{card.answer}</p>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {tags.map(tag => <Badge key={tag} variant="secondary">{tag}</Badge>)}
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                            <span>复习 {card.reviewCount} 次 · 下次 {formatDue(card.dueAt)}</span>
                            <div className="flex gap-1">
                              {card.sourceRef && (
                                <Button size="sm" variant="ghost" onClick={() => openSource(card)}>
                                  <ArrowLeftFromLine className="size-4" />
                                  来源
                                </Button>
                              )}
                              <Button size="sm" variant="ghost" onClick={() => {
                                setEditingId(card.id)
                                setEditingDraft(cardToDraft(card))
                              }}>
                                <Edit3 className="size-4" />
                                编辑
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => cardsStore.deleteCard(card.id)}>
                                <Trash2 className="size-4" />
                                删除
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
              {cardsStore.cards.length === 0 && (
                <div className="flex min-h-60 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
                  <RotateCcw className="size-8" />
                  还没有卡片。先从当前笔记生成，或手动添加第一张。
                </div>
              )}
            </section>
          </TabsContent>

          <TabsContent value="graph" className="mt-4">
            <CardKnowledgeGraph cards={cardsStore.cards} onOpenSource={openSource} onRequestImport={openImportDialog} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
