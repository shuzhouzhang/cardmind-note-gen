'use client'

import {
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  Check,
  Download,
  FileCode2,
  FolderDown,
  Grid3X3,
  History,
  ImageDown,
  Magnet,
  Maximize2,
  WandSparkles,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface CanvasFooterProps {
  nodeCount: number
  edgeCount: number
  selectedCount: number
  showGrid: boolean
  snapToGrid: boolean
  layoutDirection: 'TB' | 'LR'
  onToggleGrid: () => void
  onToggleSnap: () => void
  onDirectionChange: (direction: 'TB' | 'LR') => void
  onFitView: () => void
  onLayout: () => void
  onHistory: () => void
  onExport: (format: 'png' | 'svg', pixelRatio: number, destination: 'computer' | 'workspace') => void
}

function FooterButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active === true ? 'secondary' : 'ghost'}
          size="icon-xs"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

export function CanvasFooter({
  nodeCount,
  edgeCount,
  selectedCount,
  showGrid,
  snapToGrid,
  layoutDirection,
  onToggleGrid,
  onToggleSnap,
  onDirectionChange,
  onFitView,
  onLayout,
  onHistory,
  onExport,
}: CanvasFooterProps) {
  const t = useTranslations('canvas.footer')
  const DirectionIcon = layoutDirection === 'TB' ? AlignVerticalSpaceAround : AlignHorizontalSpaceAround

  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <span>{t('nodes', { count: nodeCount })}</span>
        <span aria-hidden="true">•</span>
        <span>{t('edges', { count: edgeCount })}</span>
        {selectedCount > 0 && (
          <>
            <span aria-hidden="true">•</span>
            <span>{t('selected', { count: selectedCount })}</span>
          </>
        )}
        <span className="hidden items-center gap-1 sm:flex">
          <Check className="size-3" />
          {t('localSave')}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <FooterButton label={t('grid')} active={showGrid} onClick={onToggleGrid}>
          <Grid3X3 />
        </FooterButton>
        <FooterButton label={t('snap')} active={snapToGrid} onClick={onToggleSnap}>
          <Magnet />
        </FooterButton>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={t('direction.title')}>
                  <DirectionIcon />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{t('direction.title')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuLabel>{t('direction.title')}</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup value={layoutDirection} onValueChange={value => onDirectionChange(value as 'TB' | 'LR')}>
                <DropdownMenuRadioItem value="TB">
                  <AlignVerticalSpaceAround />
                  {t('direction.vertical')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="LR">
                  <AlignHorizontalSpaceAround />
                  {t('direction.horizontal')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <FooterButton label={t('fit')} onClick={onFitView}>
          <Maximize2 />
        </FooterButton>
        <FooterButton label={t('layout')} onClick={onLayout}>
          <WandSparkles />
        </FooterButton>
        <FooterButton label={t('history')} onClick={onHistory}>
          <History />
        </FooterButton>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={t('export')}>
                  <Download />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{t('export')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" side="top" className="w-56">
            <DropdownMenuLabel>{t('exportMenu.computer')}</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => onExport('png', 2, 'computer')}>
                <ImageDown />
                {t('exportMenu.png2x')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport('png', 4, 'computer')}>
                <ImageDown />
                {t('exportMenu.png4x')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport('svg', 1, 'computer')}>
                <FileCode2 />
                {t('exportMenu.svg')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('exportMenu.workspace')}</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => onExport('png', 2, 'workspace')}>
                <FolderDown />
                {t('exportMenu.workspacePng')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport('svg', 1, 'workspace')}>
                <FolderDown />
                {t('exportMenu.workspaceSvg')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
