import { mcpServerManager } from '@/lib/mcp/server-manager'
import type { MCPToolAnnotations } from '@/lib/mcp/types'
import type { AgentPermissionMode, AgentTool, AgentToolRisk } from './types'

export interface PermissionDecision {
  allowed: boolean
  requiresApproval: boolean
  reason?: string
  canApproveForSession?: boolean
  sessionApprovalType?: 'runtime-script-skill'
  sessionApprovalSkillId?: string
}

const LOCAL_WRITE_RISKS = new Set<AgentToolRisk>([
  'editor-write',
  'file-create',
  'file-update',
  'medium',
])

function getMcpToolAnnotations(input: Record<string, unknown>): MCPToolAnnotations | undefined {
  const serverId = typeof input.serverId === 'string' ? input.serverId : ''
  const toolName = typeof input.toolName === 'string' ? input.toolName : ''

  if (!serverId || !toolName) {
    return undefined
  }

  return mcpServerManager.getServerTools(serverId).find(tool => tool.name === toolName)?.annotations
}

/**
 * Evaluates a concrete, structured tool call. Natural-language intent belongs to
 * the model planner and must not be re-classified in the permission boundary.
 */
export class AgentPermissionEngine {
  evaluate(
    tool: AgentTool,
    input: Record<string, unknown>,
    mode: AgentPermissionMode = 'ask'
  ): PermissionDecision {
    if (tool.risk === 'read') {
      return {
        allowed: true,
        requiresApproval: false,
      }
    }

    if (tool.risk === 'external') {
      const annotations = getMcpToolAnnotations(input)
      const isReadOnly = annotations?.readOnlyHint === true

      if (mode === 'read-only' && !isReadOnly) {
        return {
          allowed: false,
          requiresApproval: false,
          reason: '当前为只读模式，无法执行可能修改外部数据的操作。',
        }
      }

      return {
        allowed: true,
        requiresApproval: !isReadOnly,
      }
    }

    if (mode === 'read-only') {
      return {
        allowed: false,
        requiresApproval: false,
        reason: '当前为只读模式。请切换权限模式后再执行修改操作。',
      }
    }

    if (tool.risk === 'delete') {
      return {
        allowed: true,
        requiresApproval: true,
      }
    }

    if (tool.risk === 'script') {
      const skillId = typeof input.skill_id === 'string'
        ? input.skill_id
        : typeof input.skillId === 'string'
          ? input.skillId
          : undefined

      return {
        allowed: true,
        requiresApproval: true,
        canApproveForSession: Boolean(skillId),
        sessionApprovalType: skillId ? 'runtime-script-skill' : undefined,
        sessionApprovalSkillId: skillId,
      }
    }

    if (mode === 'auto-edit' && LOCAL_WRITE_RISKS.has(tool.risk)) {
      return {
        allowed: true,
        requiresApproval: false,
      }
    }

    return {
      allowed: true,
      requiresApproval: true,
    }
  }
}

export function isWriteLikeRisk(risk: AgentToolRisk) {
  return LOCAL_WRITE_RISKS.has(risk)
}
