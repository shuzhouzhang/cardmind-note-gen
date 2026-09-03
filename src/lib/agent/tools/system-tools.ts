import type { Tool, ToolResult } from '../types'

export const getCurrentTimeTool: Tool = {
  name: 'get_current_time',
  description: 'Get the current date in YYYY-MM-DD format for safe filename use.',
  category: 'system',
  requiresConfirmation: false,
  parameters: [],
  execute: async (): Promise<ToolResult> => {
    try {
      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const safeFileNameDate = `${year}-${month}-${day}`
      return {
        success: true,
        data: safeFileNameDate,
        message: `当前日期：${safeFileNameDate}`,
      }
    } catch (error) {
      return {
        success: false,
        error: `获取时间失败: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
}

export const systemTools: Tool[] = [getCurrentTimeTool]
