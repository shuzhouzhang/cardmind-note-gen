'use client'

import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import {
  BotMessageSquare,
  Drama,
  Database,
  Clipboard,
  GripVertical
} from 'lucide-react'
import useSettingStore, { ChatToolbarItem } from '@/stores/setting'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// 工具配置：图标和描述键
const TOOL_CONFIGS = {
  modelSelect: {
    icon: <BotMessageSquare className="size-4" />,
    titleKey: 'record.chat.input.modelSelect.tooltip',
    descKey: 'settings.chat.toolbar.chatToolbar.modelSelect.desc',
  },
  promptSelect: {
    icon: <Drama className="size-4" />,
    titleKey: 'record.chat.input.promptSelect.tooltip',
    descKey: 'settings.chat.toolbar.chatToolbar.promptSelect.desc',
  },
  ragSwitch: {
    icon: <Database className="size-4" />,
    titleKey: 'settings.chat.toolbar.chatToolbar.ragSwitch.title',
    descKey: 'settings.chat.toolbar.chatToolbar.ragSwitch.desc',
  },
  clipboardMonitor: {
    icon: <Clipboard className="size-4" />,
    titleKey: 'settings.chat.toolbar.chatToolbar.clipboardMonitor.title',
    descKey: 'settings.chat.toolbar.chatToolbar.clipboardMonitor.desc',
  },
}

// 可排序的工具栏项组件
interface SortableItemProps {
  item: ChatToolbarItem
  config: typeof TOOL_CONFIGS[keyof typeof TOOL_CONFIGS]
  onToggle: (id: string) => void
  t: (key: string) => string
}

function SortableItem({ item, config, onToggle, t }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style}>
      <div className="flex items-center gap-3 p-3 border rounded-lg bg-background hover:bg-accent/50 transition-colors">
        {/* 拖拽句柄 */}
        <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing shrink-0">
          <GripVertical className="size-4 text-muted-foreground" />
        </div>

        {/* 工具图标 */}
        <div className="shrink-0 text-muted-foreground">
          {config?.icon}
        </div>

        {/* 标题和描述 */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{config ? t(config.titleKey) : item.id}</div>
          <div className="text-xs text-muted-foreground truncate">{config ? t(config.descKey) : ''}</div>
        </div>

        {/* 开关 */}
        <div onClick={(e) => e.stopPropagation()} className="shrink-0">
          <Switch
            checked={item.enabled}
            onCheckedChange={() => onToggle(item.id)}
          />
        </div>
      </div>
    </div>
  )
}

export function ToolbarSettings() {
  const t = useTranslations()
  const { chatToolbarConfigPc, setChatToolbarConfigPc, chatToolbarConfigMobile, setChatToolbarConfigMobile } = useSettingStore()

  // 根据设备类型选择配置
  const config = chatToolbarConfigMobile.length > 0 ? chatToolbarConfigMobile : chatToolbarConfigPc
  const setConfig = chatToolbarConfigMobile.length > 0 ? setChatToolbarConfigMobile : setChatToolbarConfigPc

  // 拖拽传感器配置
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  )

  const handleToggle = async (id: string) => {
    const newConfig = config.map(item =>
      item.id === id ? { ...item, enabled: !item.enabled } : item
    )
    await setConfig(newConfig)
  }

  // 处理拖拽结束
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      const oldIndex = config.findIndex((item) => item.id === active.id)
      const newIndex = config.findIndex((item) => item.id === over.id)
      const newItems = arrayMove(config, oldIndex, newIndex)
      const updatedItems = newItems.map((item, index) => ({
        ...item,
        order: index,
      }))
      await setConfig(updatedItems)
    }
  }

  // 获取可排序的工具列表（排除 newChat 和不在 TOOL_CONFIGS 中的项）
  const sortableItems = config
    .filter(item => item.id !== 'newChat' && item.id in TOOL_CONFIGS)
    .sort((a, b) => a.order - b.order)

  return (
    <div className="space-y-4">
      {/* 标题 */}
      <h3 className="text-lg font-semibold">{t('settings.chat.toolbar.title')}</h3>

      {/* 工具列表 */}
      <div className="space-y-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sortableItems.map(item => item.id)}
            strategy={verticalListSortingStrategy}
          >
            {sortableItems.map((item) => (
              <SortableItem
                key={item.id}
                item={item}
                config={TOOL_CONFIGS[item.id as keyof typeof TOOL_CONFIGS]}
                onToggle={handleToggle}
                t={t}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  )
}
