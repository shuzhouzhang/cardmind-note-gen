"use client"

import * as React from "react"
import { CheckCircle2, ChevronDown, ChevronRight, ShieldAlert, XCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { formatConfirmationPreview } from "@/lib/agent/tool-confirmation-display"
import emitter from "@/lib/emitter"
import { cn } from "@/lib/utils"
import { formatAgentToolName } from "./agent-display-utils"

export interface PendingAgentConfirmation {
  toolName: string
  params: Record<string, unknown>
  previewParams?: Record<string, unknown>
  originalContent?: string
  modifiedContent?: string
  filePath?: string
  from?: number
  to?: number
  canApproveForSession?: boolean
  sessionApprovalType?: "runtime-script"
  sessionApprovalKey?: string
}

interface AgentApprovalPanelProps {
  pendingConfirmation?: PendingAgentConfirmation
  onConfirm?: (scope?: "once" | "conversation") => void
  onCancel?: () => void
}

export function AgentApprovalPanel({
  pendingConfirmation,
  onConfirm,
  onCancel,
}: AgentApprovalPanelProps) {
  const t = useTranslations()
  const [expanded, setExpanded] = React.useState(true)

  React.useEffect(() => {
    setExpanded(true)
  }, [pendingConfirmation?.toolName, pendingConfirmation?.params])

  React.useEffect(() => {
    if (
      pendingConfirmation?.originalContent === undefined ||
      pendingConfirmation.modifiedContent === undefined
    ) {
      emitter.emit("editor-agent-diff-clear")
      return
    }

    emitter.emit("editor-agent-diff-preview", {
      originalContent: pendingConfirmation.originalContent,
      modifiedContent: pendingConfirmation.modifiedContent,
      filePath: pendingConfirmation.filePath,
      from: pendingConfirmation.from,
      to: pendingConfirmation.to,
    })

    return () => {
      emitter.emit("editor-agent-diff-clear")
    }
  }, [pendingConfirmation])

  React.useEffect(() => {
    if (pendingConfirmation?.toolName !== "canvas_apply_operations") {
      emitter.emit("canvas-agent-preview-clear")
      return
    }

    const operations = pendingConfirmation.params.operations
    if (!Array.isArray(operations)) {
      emitter.emit("canvas-agent-preview-clear")
      return
    }

    emitter.emit("canvas-agent-preview", { operations })
    return () => emitter.emit("canvas-agent-preview-clear")
  }, [pendingConfirmation])

  const approvalPreview = React.useMemo(() => {
    if (!pendingConfirmation) return null
    return formatConfirmationPreview(
      pendingConfirmation.toolName,
      pendingConfirmation.previewParams ?? pendingConfirmation.params ?? {}
    )
  }, [pendingConfirmation])

  const translateKey = React.useCallback((key: string, fallback: string) => {
    return t.has(key) ? t(key) : fallback
  }, [t])

  const formatFieldValue = React.useCallback((value: unknown) => {
    if (typeof value === "string") {
      return value
    }

    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    ) {
      return String(value)
    }

    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }, [])

  if (!pendingConfirmation || !approvalPreview) {
    return null
  }

  const title = translateKey(
    approvalPreview.titleKey,
    formatAgentToolName(pendingConfirmation.toolName)
  )
  const description = translateKey(
    approvalPreview.descriptionKey,
    "Agent 请求执行需要确认的操作。"
  )
  const hasDetails = approvalPreview.fields.length > 0

  return (
    <div className="flex w-full flex-col gap-2 rounded-md border bg-background p-2 shadow-sm">
      <div>
        <button
          type="button"
          className="flex w-full min-w-0 items-start gap-2 text-left"
          onClick={() => hasDetails && setExpanded((value) => !value)}
          disabled={!hasDetails}
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium">{title}</span>
              {hasDetails && (
                expanded ? (
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                )
              )}
            </span>
            <span className="block max-w-full truncate text-xs text-muted-foreground">
              {pendingConfirmation.filePath || description}
            </span>
          </span>
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={onCancel}
        >
          <XCircle data-icon="inline-start" />
          {t("record.chat.input.agent.confirmation.cancel")}
        </Button>
        <Button
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => onConfirm?.("once")}
        >
          <CheckCircle2 data-icon="inline-start" />
          {t("record.chat.input.agent.confirmation.confirm")}
        </Button>
        {pendingConfirmation.canApproveForSession && (
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2 text-xs"
            onClick={() => onConfirm?.("conversation")}
          >
            {t("record.chat.input.agent.confirmation.session")}
          </Button>
        )}
      </div>

      {expanded && hasDetails && (
        <div className="mt-2 border-t pt-2">
          {approvalPreview.fields.length > 0 && (
            <div className="mt-2 flex max-h-56 flex-col gap-2 overflow-auto text-xs">
              {approvalPreview.fields.map((field) => {
                const formattedValue = formatFieldValue(field.value)

                return (
                  <div key={field.name} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                    <span className="truncate text-muted-foreground">
                      {translateKey(field.labelKey, field.name)}
                    </span>
                    {field.displayType === "content" || field.displayType === "json" ? (
                      <pre
                        className={cn(
                          "whitespace-pre-wrap break-words rounded bg-muted/60 px-2 py-1 text-foreground",
                          field.displayType === "content" && "max-h-[6.75rem] overflow-y-auto leading-5",
                        )}
                      >
                        {formattedValue}
                      </pre>
                    ) : (
                      <span className="break-words text-foreground">{formattedValue}</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
