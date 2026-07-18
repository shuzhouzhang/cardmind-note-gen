import { agentDebugLog } from "@/lib/agent/debug-log"
import useChatStore from "@/stores/chat"

export type AgentApprovalScope = "once" | "conversation"

export function confirmPendingAgentAction(scope: AgentApprovalScope = "once") {
  const latestState = useChatStore.getState()
  const pendingConfirmation = latestState.agentState.pendingConfirmation
  if (!pendingConfirmation) return

  const effectiveScope = scope
  const confirmationRecord = {
    toolName: pendingConfirmation.toolName,
    params: pendingConfirmation.params,
    status: "confirmed" as const,
    timestamp: Date.now(),
    scope: effectiveScope,
    sessionApprovalType: pendingConfirmation.sessionApprovalType,
    sessionApprovalSkillId: pendingConfirmation.sessionApprovalSkillId,
  }

  if (effectiveScope === "conversation" && latestState.currentConversationId !== null) {
    latestState.setAgentAutoApproveConversationId(latestState.currentConversationId)
    latestState.setAgentAutoApproveRuntimeSkillId(
      pendingConfirmation.sessionApprovalType === "runtime-script-skill"
        ? pendingConfirmation.sessionApprovalSkillId || null
        : null
    )
  }

  agentDebugLog("approval_user_confirmed", confirmationRecord)

  latestState.setAgentState({
    pendingConfirmation: undefined,
    confirmationHistory: [...latestState.agentState.confirmationHistory, confirmationRecord],
    isRunning: true,
  })
}

export function cancelPendingAgentAction() {
  const latestState = useChatStore.getState()
  const pendingConfirmation = latestState.agentState.pendingConfirmation
  if (!pendingConfirmation) return

  const confirmationRecord = {
    toolName: pendingConfirmation.toolName,
    params: pendingConfirmation.params,
    status: "cancelled" as const,
    timestamp: Date.now(),
  }

  agentDebugLog("approval_user_cancelled", confirmationRecord)

  latestState.setAgentState({
    pendingConfirmation: undefined,
    confirmationHistory: [...latestState.agentState.confirmationHistory, confirmationRecord],
    isRunning: true,
  })
}
