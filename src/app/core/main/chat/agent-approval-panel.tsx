"use client"

import * as React from "react"
import { CheckCircle2, ChevronDown, ChevronRight, ShieldAlert, XCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { DiffViewer } from "@/components/ui/diff-viewer"
import { formatConfirmationPreview } from "@/lib/agent/tool-confirmation-display"
import { formatAgentToolName } from "./agent-display-utils"

export interface PendingAgentConfirmation {
  toolName: string
  params: Record<string, unknown>
  previewParams?: Record<string, unknown>
  originalContent?: string
  modifiedContent?: string
  filePath?: string
  canApproveForSession?: boolean
}

interface AgentApprovalPanelProps {
  pendingConfirmation?: PendingAgentConfirmation
  onConfirm?: (scope?: "once" | "session") => void
  onCancel?: () => void
}

export function AgentApprovalPanel({
  pendingConfirmation,
  onConfirm,
  onCancel,
}: AgentApprovalPanelProps) {
  const t = useTranslations()
  const [expanded, setExpanded] = React.useState(false)

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
  const hasDiff =
    pendingConfirmation.originalContent !== undefined &&
    pendingConfirmation.modifiedContent !== undefined
  const hasDetails = hasDiff || approvalPreview.fields.length > 0

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
          <XCircle className="size-3.5" />
          拒绝
        </Button>
        <Button
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => onConfirm?.("once")}
        >
          <CheckCircle2 className="size-3.5" />
          允许一次
        </Button>
        {pendingConfirmation.canApproveForSession && (
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2 text-xs"
            onClick={() => onConfirm?.("session")}
          >
            本会话允许
          </Button>
        )}
      </div>

      {expanded && hasDetails && (
        <div className="mt-2 border-t pt-2">
          {hasDiff && (
            <DiffViewer
              original={pendingConfirmation.originalContent || ""}
              modified={pendingConfirmation.modifiedContent || ""}
              maxHeight={220}
              className="text-xs"
            />
          )}

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
                      <pre className="whitespace-pre-wrap break-words rounded bg-muted/60 px-2 py-1 text-foreground">
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
