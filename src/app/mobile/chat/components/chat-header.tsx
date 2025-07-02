"use client"

import { BotMessageSquare, BotOff, Check, Drama } from "lucide-react"
import usePromptStore from "@/stores/prompt"
import useSettingStore from "@/stores/setting"
import { Store } from "@tauri-apps/plugin-store"
import { AiConfig } from "@/app/core/setting/config"
import { useEffect, useState } from "react"
import * as React from "react"
import { cn } from "@/lib/utils"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

export function ChatHeader() {
  const { promptList, currentPrompt, setCurrentPrompt } = usePromptStore()
  const { primaryModel, setPrimaryModel } = useSettingStore()

  const [models, setModels] = useState<AiConfig[]>([])
  const [promptOpen, setPromptOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)

  async function getModels() {
    const store = await Store.load('store.json');
    const aiModelList = await store.get<AiConfig[]>('aiModelList');
    if (!aiModelList) return [];
    const filteredModels = aiModelList.filter(item => {
      return item.apiKey && item.model && item.baseURL
    })
    setModels(filteredModels)
    return filteredModels;
  }

  async function modelSelectChangeHandler(key: string) {
    setPrimaryModel(key)
    const store = await Store.load('store.json');
    store.set('primaryModel', key)
    setModelOpen(false)
  }

  async function promptSelectChangeHandler(id: string) {
    const selectedPrompt = promptList.find(item => item.id === id)
    if (!selectedPrompt) return
    await setCurrentPrompt(selectedPrompt)
    setPromptOpen(false)
  }

  useEffect(() => {
    getModels()
  }, [])

  return (
    <header className="h-12 w-full flex justify-between items-center border-b px-4 text-sm gap-4">
      <Popover open={promptOpen} onOpenChange={setPromptOpen}>
        <PopoverTrigger asChild>
          <div className="flex items-center gap-1 cursor-pointer hover:opacity-80">
            <Drama className="size-4" />
            <span className="line-clamp-1">
              {currentPrompt?.title}
            </span>
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-[180px] p-0">
          <Command>
            <CommandInput placeholder="Search prompt..." className="h-9" />
            <CommandList>
              <CommandGroup>
                {promptList?.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={(currentValue) => {
                      promptSelectChangeHandler(currentValue)
                    }}
                  >
                    {item.title}
                    <Check
                      className={cn(
                        "ml-auto",
                        currentPrompt?.id === item.id ? "opacity-100" : "opacity-0"
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Popover open={modelOpen} onOpenChange={setModelOpen}>
        <PopoverTrigger asChild>
          <div className="flex items-center justify-center gap-1 cursor-pointer hover:opacity-80">
            {models.length > 0 ? <BotMessageSquare className="!size-4" /> : <BotOff className="size-4" />}
            <span className="line-clamp-1 flex-1 lg:flex-none">
              {models.find(model => model.key === primaryModel)?.model}
            </span>
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0">
          <Command>
            <CommandInput placeholder="Search model..." className="h-9" />
            <CommandList>
              <CommandEmpty>No model found.</CommandEmpty>
              <CommandGroup>
                {models.filter(item => item.modelType === 'chat' || !item.modelType).map((item) => (
                  <CommandItem
                    key={item.key}
                    value={item.key}
                    onSelect={(currentValue) => {
                      modelSelectChangeHandler(currentValue)
                    }}
                  >
                    {`${item.model}(${item.title})`}
                    <Check
                      className={cn(
                        "ml-auto",
                        primaryModel === item.key ? "opacity-100" : "opacity-0"
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </header>
  )
}
