'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Files, Highlighter } from "lucide-react"
import { FileSidebar } from "./file"
import { NoteSidebar } from "./mark"
import { FileActions } from "./file/file-actions"
import { MarkActions } from "./mark/mark-actions"
import { useTranslations } from "next-intl"
import { useSidebarStore } from "@/stores/sidebar"

const SIDEBAR_TABS = [
  { title: "notes", icon: Highlighter },
  { title: "files", icon: Files },
] as const

export function LeftSidebar() {
  const { leftSidebarTab, setLeftSidebarTab } = useSidebarStore()
  const t = useTranslations()

  return (
    <div className="flex h-full w-full flex-col bg-[hsl(var(--workspace-sidebar))]">
      <Tabs value={leftSidebarTab} onValueChange={value => setLeftSidebarTab(value as 'files' | 'notes')} className="flex h-full w-full flex-col">
        <div className="flex h-12 w-full items-center gap-2 border-b border-border/70 px-3">
          <TabsList className="grid h-8 flex-1 grid-cols-2 rounded-md bg-transparent p-0">
            {SIDEBAR_TABS.map(tab => {
              const Icon = tab.icon
              return (
                <TabsTrigger key={tab.title} value={tab.title} className="gap-1.5 rounded-md border border-transparent text-xs text-muted-foreground shadow-none data-[state=active]:border-border data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none">
                  <Icon className="size-3.5" />
                  {t(`navigation.${tab.title === 'notes' ? 'record' : tab.title}`)}
                </TabsTrigger>
              )
            })}
          </TabsList>
          <div className="relative">
            {leftSidebarTab === "files" ? <FileActions /> : <MarkActions />}
          </div>
        </div>
        <TabsContent value="files" className="flex-1 m-0 overflow-hidden">
          <FileSidebar />
        </TabsContent>
        <TabsContent value="notes" className="flex-1 m-0 overflow-hidden">
          <NoteSidebar />
        </TabsContent>
      </Tabs>
    </div>
  )
}
