'use client'

import { Tabs, TabsContent } from "@/components/ui/tabs"
import { Files, Highlighter, PanelsTopLeft } from "lucide-react"
import { FileSidebar } from "./file"
import { NoteSidebar } from "./mark"
import { FileActions } from "./file/file-actions"
import { MarkActions } from "./mark/mark-actions"
import { useTranslations } from "next-intl"
import { useSidebarStore } from "@/stores/sidebar"
import { ExpandableTabs } from "@/components/ui/expandable-tabs"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { CanvasActions, CanvasSidebar } from './canvas/canvas-sidebar'

const SIDEBAR_TABS = [
  { title: "files", icon: Files },
  { title: "notes", icon: Highlighter },
  { title: "canvases", icon: PanelsTopLeft },
] as const

export function LeftSidebar() {
  const { leftSidebarTab, setLeftSidebarTab } = useSidebarStore()
  const t = useTranslations()

  const handleTabChange = (index: number | null) => {
    if (index !== null) {
      setLeftSidebarTab(SIDEBAR_TABS[index].title)
    }
  }

  const getSelectedIndex = () => {
    return SIDEBAR_TABS.findIndex(tab => tab.title === leftSidebarTab)
  }

  // Prepare tabs with translated titles
  const tabs = SIDEBAR_TABS.map(tab => ({
    ...tab,
    title: t(`navigation.${tab.title === 'notes' ? 'record' : tab.title}`),
  }))

  return (
    <div className="w-full h-full flex flex-col">
      <Tabs value={leftSidebarTab} className="h-full w-full gap-0 overflow-hidden">
        <div className="flex h-12 w-full shrink-0 items-center justify-between border-b px-2">
          <ExpandableTabs
            tabs={tabs}
            onChange={handleTabChange}
            selected={getSelectedIndex()}
            className="shrink-0 flex-nowrap"
          />
          <div className="grid shrink-0">
            <motion.div
              initial={false}
              animate={leftSidebarTab === "files"
                ? { opacity: 1, x: 0 }
                : { opacity: 0, x: -10 }}
              transition={{ duration: 0.2 }}
              className={cn(
                "col-start-1 row-start-1",
                leftSidebarTab !== "files" && "pointer-events-none"
              )}
            >
              <FileActions />
            </motion.div>
            <motion.div
              initial={false}
              animate={leftSidebarTab === "notes"
                ? { opacity: 1, x: 0 }
                : { opacity: 0, x: 10 }}
              transition={{ duration: 0.2 }}
              className={cn(
                "col-start-1 row-start-1",
                leftSidebarTab !== "notes" && "pointer-events-none"
              )}
            >
              <MarkActions />
            </motion.div>
            <motion.div
              initial={false}
              animate={leftSidebarTab === "canvases"
                ? { opacity: 1, x: 0 }
                : { opacity: 0, x: 10 }}
              transition={{ duration: 0.2 }}
              className={cn(
                "col-start-1 row-start-1",
                leftSidebarTab !== "canvases" && "pointer-events-none"
              )}
            >
              <CanvasActions />
            </motion.div>
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <TabsContent
            forceMount
            value="files"
            className="absolute inset-0 m-0 overflow-hidden data-[state=inactive]:hidden"
          >
            <FileSidebar />
          </TabsContent>
          <TabsContent
            forceMount
            value="notes"
            className="absolute inset-0 m-0 overflow-hidden data-[state=inactive]:hidden"
          >
            <NoteSidebar />
          </TabsContent>
          <TabsContent
            forceMount
            value="canvases"
            className="absolute inset-0 m-0 overflow-hidden data-[state=inactive]:hidden"
          >
            <CanvasSidebar />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
