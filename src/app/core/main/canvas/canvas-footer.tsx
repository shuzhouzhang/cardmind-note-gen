'use client'

import {
  ClipboardPaste,
  Download,
  FileCode2,
  FileInput,
  Grid3X3,
  ImageDown,
  Magnet,
  Maximize2,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface CanvasFooterProps {
  showGrid: boolean
  snapToGrid: boolean
  zoom: number
  onToggleGrid: () => void
  onToggleSnap: () => void
  onZoomChange: (zoom: number) => void
  onFitView: () => void
  onLayout: () => void
  onExport: (format: 'png' | 'svg', pixelRatio: number) => void
  onExportSource: (format: 'canvas' | 'mermaid') => void
  onImportFile: () => void
  onImportContent: () => void
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
  showGrid,
  snapToGrid,
  zoom,
  onToggleGrid,
  onToggleSnap,
  onZoomChange,
  onFitView,
  onLayout,
  onExport,
  onExportSource,
  onImportFile,
  onImportContent,
}: CanvasFooterProps) {
  const t = useTranslations('canvas.footer')

  return (
    <div className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-3 text-xs text-muted-foreground">
      <div className="flex shrink-0 items-center gap-0.5">
        <FooterButton label={t('grid')} active={showGrid} onClick={onToggleGrid}>
          <Grid3X3 />
        </FooterButton>
        <FooterButton label={t('snap')} active={snapToGrid} onClick={onToggleSnap}>
          <Magnet />
        </FooterButton>
        <FooterButton label={t('layout')} onClick={onLayout}>
          <WandSparkles />
        </FooterButton>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={t('import.title')}>
                  <FileInput />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{t('import.title')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem onSelect={onImportFile}>
              <FileInput />
              {t('import.file')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onImportContent}>
              <ClipboardPaste />
              {t('import.content')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuLabel>{t('exportMenu.computer')}</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => onExport('png', 2)}>
                <ImageDown />
                {t('exportMenu.png2x')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport('png', 4)}>
                <ImageDown />
                {t('exportMenu.png4x')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport('svg', 1)}>
                <FileCode2 />
                {t('exportMenu.svg')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('exportMenu.source')}</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => onExportSource('canvas')}>
                <FileCode2 />
                {t('exportMenu.canvasFile')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExportSource('mermaid')}>
                <FileCode2 />
                {t('exportMenu.mermaid')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <div className="flex items-center gap-1.5 px-1">
          <ZoomOut className="size-3" aria-hidden="true" />
          <Slider
            min={0.25}
            max={2}
            step={0.05}
            value={[zoom]}
            onValueChange={value => onZoomChange(value[0] ?? zoom)}
            aria-label={`${t('zoomOut')} / ${t('zoomIn')}`}
            className="w-20"
          />
          <ZoomIn className="size-3" aria-hidden="true" />
          <span className="w-9 text-right tabular-nums">{Math.round(zoom * 100)}%</span>
        </div>
        <FooterButton label={t('fit')} onClick={onFitView}>
          <Maximize2 />
        </FooterButton>
      </div>
    </div>
  )
}
