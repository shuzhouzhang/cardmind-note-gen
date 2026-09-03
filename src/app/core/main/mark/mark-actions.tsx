"use client"

import { TooltipButton } from "@/components/tooltip-button"
import { Network, Trash2, XCircle, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import useMarkStore from "@/stores/mark"
import { OrganizeNotes } from "./organize-notes"
import { useEffect, useRef } from "react"
import { MarkFilterPopover } from "./mark-filter-popover"

export function MarkActions() {
  const t = useTranslations('record.mark')
  const navigationT = useTranslations('navigation')
  const router = useRouter()
  const { trashState, setTrashState, initRecordFilters } = useMarkStore()
  const organizeRef = useRef<{ openOrganize: () => void }>(null)

  useEffect(() => {
    initRecordFilters()
  }, [initRecordFilters])

  const handleToggleTrash = () => {
    setTrashState(!trashState)
  }

  const handleOrganize = () => {
    organizeRef.current?.openOrganize()
  }

  return (
    <div className="flex items-center gap-1">
      {!trashState && (
        <>
          <TooltipButton
            icon={<Network className="h-4 w-4" />}
            tooltipText={navigationT('cards')}
            onClick={() => router.push('/core/cards?import=1')}
            variant="ghost"
            side="bottom"
          />
          <TooltipButton
            buttonId="onboarding-target-organize-notes"
            icon={<Sparkles className="h-4 w-4" />}
            tooltipText={t('toolbar.organizeNotes')}
            onClick={handleOrganize}
            variant="ghost"
            side="bottom"
          />
        </>
      )}
      <MarkFilterPopover />
      <TooltipButton 
        icon={trashState ? <XCircle className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />} 
        tooltipText={trashState ? t('toolbar.closeTrash') : t('toolbar.trash')} 
        onClick={handleToggleTrash}
        variant={trashState ? "default" : "ghost"}
        side="bottom"
      />
      <OrganizeNotes ref={organizeRef} />
    </div>
  )
}
