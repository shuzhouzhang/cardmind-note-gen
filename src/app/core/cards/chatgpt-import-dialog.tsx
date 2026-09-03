'use client'

import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Check, GitBranch, Link2, LoaderCircle, MessageSquareText, Network, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  isChatGptShareUrl,
  parseChatGptShareHtml,
  parsePastedChatText,
  type ImportedChatConversation,
} from "@/lib/chatgpt-import"

interface ChatGptImportDialogProps {
  busy: boolean
  onImport: (conversation: ImportedChatConversation) => Promise<void>
  open?: boolean
  onOpenChange?: (open: boolean) => void
  initialUrl?: string
}

type ProgressStage = "idle" | "reading" | "generating"

export function ChatGptImportDialog({ busy, onImport, open, onOpenChange, initialUrl }: ChatGptImportDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [mode, setMode] = useState("link")
  const [url, setUrl] = useState("")
  const [pastedText, setPastedText] = useState("")
  const [loading, setLoading] = useState(false)
  const [progressStage, setProgressStage] = useState<ProgressStage>("idle")
  const [error, setError] = useState("")
  const actualOpen = open ?? internalOpen
  const isWorking = loading || busy

  useEffect(() => {
    if (!actualOpen || !initialUrl) return
    setMode("link")
    setUrl(initialUrl)
  }, [actualOpen, initialUrl])

  function changeOpen(nextOpen: boolean) {
    if (isWorking && !nextOpen) return
    if (onOpenChange) onOpenChange(nextOpen)
    else setInternalOpen(nextOpen)
    if (!nextOpen) setError("")
  }

  async function importConversation() {
    setLoading(true)
    setProgressStage("reading")
    setError("")
    try {
      let conversation: ImportedChatConversation
      if (mode === "link") {
        const targetUrl = url.trim()
        if (!isChatGptShareUrl(targetUrl)) {
          throw new Error("请输入以 https://chatgpt.com/share/ 开头的公开分享链接。")
        }
        const html = await invoke<string>("fetch_chatgpt_share_html", { url: targetUrl })
        conversation = parseChatGptShareHtml(html, targetUrl)
      } else {
        conversation = parsePastedChatText(pastedText)
      }

      setProgressStage("generating")
      await onImport(conversation)
      if (onOpenChange) onOpenChange(false)
      else setInternalOpen(false)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught || "")
      setError(message || "对话导入失败。")
    } finally {
      setLoading(false)
      setProgressStage("idle")
    }
  }

  const canSubmit = mode === "link" ? Boolean(url.trim()) : Boolean(pastedText.trim())
  const progressItems = [
    { label: "读取对话", icon: MessageSquareText, state: progressStage === "reading" ? "active" : "done" },
    { label: "拆分知识点", icon: Sparkles, state: progressStage === "generating" ? "active" : "pending" },
    { label: "区分主线与衍生", icon: GitBranch, state: "pending" },
    { label: "准备知识图谱", icon: Network, state: "pending" },
  ] as const

  return (
    <Dialog open={actualOpen} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button className="bg-violet-600 text-white hover:bg-violet-700">
          <MessageSquareText className="size-4" />
          导入对话
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <div className="border-b px-6 py-5">
          <DialogHeader>
            <div className="mb-1 flex items-center gap-2 text-xs font-medium text-violet-600">
              <span className="flex size-6 items-center justify-center rounded-full bg-violet-50"><Sparkles className="size-3.5" /></span>
              对话导入
            </div>
            <DialogTitle className="text-xl tracking-[-.02em]">把对话拆成可继续学习的知识</DialogTitle>
            <DialogDescription>
              AI 会先识别主线和衍生知识，生成结果确认后才会写入图谱。
            </DialogDescription>
          </DialogHeader>
        </div>

        {isWorking ? (
          <div className="px-6 py-8">
            <div className="mb-7 text-center">
              <LoaderCircle className="mx-auto size-7 animate-spin text-violet-600" />
              <h3 className="mt-3 font-medium">{progressStage === "reading" ? "正在读取对话" : "正在理解知识结构"}</h3>
              <p className="mt-1 text-xs text-muted-foreground">你可以留在这里，完成后会进入知识点确认页。</p>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {progressItems.map((item, index) => {
                const Icon = item.icon
                const active = item.state === "active"
                const done = item.state === "done"
                return (
                  <div key={item.label} className="relative text-center">
                    {index < progressItems.length - 1 && <span className="absolute left-[60%] top-4 h-px w-[80%] bg-border" />}
                    <span className={`relative mx-auto flex size-8 items-center justify-center rounded-full border ${done ? "border-emerald-500 bg-emerald-50 text-emerald-600" : active ? "border-violet-500 bg-violet-50 text-violet-600" : "bg-background text-muted-foreground"}`}>
                      {done ? <Check className="size-4" /> : <Icon className="size-4" />}
                    </span>
                    <span className={`mt-2 block text-[11px] ${active || done ? "text-foreground" : "text-muted-foreground"}`}>{item.label}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <>
            <div className="px-6 py-5">
              <Tabs value={mode} onValueChange={setMode}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="link"><Link2 className="mr-2 size-4" />分享链接</TabsTrigger>
                  <TabsTrigger value="paste"><MessageSquareText className="mr-2 size-4" />粘贴文本</TabsTrigger>
                </TabsList>
                <TabsContent value="link" className="mt-4 space-y-3">
                  <Input
                    value={url}
                    onChange={event => setUrl(event.target.value)}
                    placeholder="https://chatgpt.com/share/..."
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    普通分享链接是一次快照。继续学习后，请先在 ChatGPT 更新分享内容，再回到这里检查新增知识。
                  </p>
                </TabsContent>
                <TabsContent value="paste" className="mt-4 space-y-3">
                  <Textarea
                    value={pastedText}
                    onChange={event => setPastedText(event.target.value)}
                    placeholder={'我：\n问题内容\n\nGPT：\n回答内容'}
                    className="min-h-52 resize-y"
                  />
                  <p className="text-xs leading-5 text-muted-foreground">支持“我 / 用户 / User”和“GPT / 助手 / Assistant”作为消息分隔。</p>
                </TabsContent>
              </Tabs>

              {error && (
                <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>

            <DialogFooter className="border-t bg-muted/20 px-6 py-4 sm:justify-between">
              <Button variant="ghost" onClick={() => changeOpen(false)}>取消</Button>
              <Button className="bg-violet-600 text-white hover:bg-violet-700" onClick={importConversation} disabled={!canSubmit}>
                <Sparkles className="size-4" />
                开始拆分
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
