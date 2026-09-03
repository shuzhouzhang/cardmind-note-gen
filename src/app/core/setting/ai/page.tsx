'use client'
import { useState, useEffect } from "react";
import { useTranslations } from 'next-intl';
import { useLocalStorage } from 'react-use';
import { Store } from "@tauri-apps/plugin-store";
import { v4 } from 'uuid';
import { confirm } from '@tauri-apps/plugin-dialog';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select"
import {
  Accordion,
} from "@/components/ui/accordion"
import Image from "next/image";

import { SettingType, FormItem } from "../components/setting-base";
import { AiConfig, ModelConfig, builtinProviderTemplates } from "../config";
import useSettingStore from "@/stores/setting";
import { noteGenModelKeys } from "@/app/model-config";
import { BotMessageSquare, Check, Circle, Copy, Eye, EyeOff, LoaderCircle, Plus, Trash2, Waypoints, X } from "lucide-react";
import { OpenBroswer } from "@/components/open-broswer";
import DefaultModelsSection from "./default-models";
import ModelCard from "./model-card";
import CreateConfig from "./create";
import { getCachedProviderTemplates, getProviderTemplateMatch, loadProviderTemplates } from "@/lib/ai/provider-templates-runtime";


export default function AiPage() {
  const t = useTranslations('settings.ai');
  const {
    aiModelList,
    setAiModelList
  } = useSettingStore()

  // 过滤掉默认模型，只显示用户自定义模型
  const userCustomModels = aiModelList.filter(model => !noteGenModelKeys.includes(model.key) && model.title !== 'NoteGen Limited')
  const [apiKeyVisible, setApiKeyVisible] = useState<boolean>(false)
  const [headerPairs, setHeaderPairs] = useState<Array<{key: string, value: string, id: string}>>([])
  const [expandedModels, setExpandedModels] = useState<string[]>([])
  const [verifiedModelIds, setVerifiedModelIds] = useState<string[]>([])
  const [providerTemplates, setProviderTemplates] = useState<AiConfig[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  
  // 使用 useLocalStorage 记录当前选择的AI配置
  const [selectedAiConfig, setSelectedAiConfig] = useLocalStorage<string>('ai-config-selected', '')
  
  // 当前选中的AI配置
  const currentConfig = userCustomModels.find(model => model.key === selectedAiConfig)
  const currentProviderTemplate = getProviderTemplateMatch(currentConfig, providerTemplates)
  const apiKeyReady = Boolean(currentConfig?.apiKey?.trim())
  const configuredModels = (currentConfig?.models || []).filter(model => model.model.trim())
  const connectionReady = configuredModels.some(model => verifiedModelIds.includes(model.id))
  
  const parseHeadersToKeyValue = (headers: Record<string, string> = {}) => {
    return Object.entries(headers).map(([key, value]) => ({
      key, value: String(value), id: Math.random().toString(36).substr(2, 9)
    }))
  }

  const convertKeyValueToJson = (pairs: Array<{key: string, value: string}>) => {
    const obj: Record<string, string> = {}
    pairs.forEach(pair => { if (pair.key.trim()) obj[pair.key.trim()] = pair.value })
    return obj
  }

  // 添加新模型
  const addNewModel = async () => {
    if (!currentConfig) return
    
    const newModelId = v4()
    const newModel: ModelConfig = {
      id: newModelId,
      model: '',
      modelType: 'chat',
      temperature: 0.7,
      topP: 1.0,
      enableStream: true
    }
    
    const updatedConfig = {
      ...currentConfig,
      models: [...(currentConfig.models || []), newModel]
    }
    
    await updateAiConfig(updatedConfig)
    
    // 自动展开新创建的模型
    setExpandedModels(prev => [...prev, newModelId])
  }

  // 删除模型
  const deleteModel = async (modelId: string) => {
    if (!currentConfig) return
    
    const confirmed = await confirm('确定要删除这个模型吗？')
    if (!confirmed) return
    
    const updatedConfig = {
      ...currentConfig,
      models: (currentConfig.models || []).filter(m => m.id !== modelId)
    }
    
    await updateAiConfig(updatedConfig)
    
    // 从展开列表中移除被删除的模型
    setExpandedModels(prev => prev.filter(id => id !== modelId))
  }

  // 更新模型配置
  const updateModelConfig = async (modelId: string, field: keyof ModelConfig, value: any) => {
    if (!currentConfig) return
    
    const updatedModels = (currentConfig.models || []).map(model => 
      model.id === modelId ? { ...model, [field]: value } : model
    )
    
    const updatedConfig = {
      ...currentConfig,
      models: updatedModels
    }
    
    await updateAiConfig(updatedConfig)
  }

  // 更新AI配置到store
  const updateAiConfig = async (config: AiConfig) => {
    const store = await Store.load('store.json')
    const aiModelList = await store.get<AiConfig[]>('aiModelList') || []
    const index = aiModelList.findIndex(item => item.key === config.key)
    
    if (index >= 0) {
      aiModelList[index] = config
      await store.set('aiModelList', aiModelList)
      setAiModelList(aiModelList)
    }
  }

  // 复制当前配置
  const copyConfig = async () => {
    if (!currentConfig) return

    const id = v4()
    const newConfig: AiConfig = {
      ...currentConfig,
      key: id,
      title: `${currentConfig.title || 'Copy'} (Copy)`,
      // 复制models数组
      models: currentConfig.models?.map(model => ({
        ...model,
        id: v4() // 给每个模型生成新的ID
      })) || []
    }

    const store = await Store.load('store.json')
    const aiModelList = await store.get<AiConfig[]>('aiModelList') || []
    const updatedList = [...aiModelList, newConfig]
    
    await store.set('aiModelList', updatedList)
    setAiModelList(updatedList)
    setSelectedAiConfig(newConfig.key)
  }

  // 删除当前配置
  const deleteCurrentConfig = async () => {
    if (!currentConfig) return
    
    // 检查是否是NoteGen默认模型
    if (noteGenModelKeys.includes(currentConfig.key)) {
      return // 不能删除默认模型
    }

    const confirmed = await confirm(t('deleteCustomModelConfirm'))
    if (!confirmed) return

    const store = await Store.load('store.json')
    const aiModelList = await store.get<AiConfig[]>('aiModelList') || []
    const updatedList = aiModelList.filter(item => item.key !== currentConfig.key)
    
    await store.set('aiModelList', updatedList)
    setAiModelList(updatedList)

    // 删除后选择下一个用户自定义模型
    const remainingUserModels = updatedList.filter(model => !noteGenModelKeys.includes(model.key))
    if (remainingUserModels.length > 0) {
      setSelectedAiConfig(remainingUserModels[0].key)
    } else {
      setSelectedAiConfig('')
    }
  }


  // 迁移旧配置到新格式
  const migrateOldConfig = (config: AiConfig): AiConfig => {
    // 如果已经有models数组，直接返回
    if (config.models && config.models.length > 0) {
      return config
    }
    
    // 如果有旧的model配置，迁移到models数组
    if (config.model) {
      const migratedModel: ModelConfig = {
        id: v4(),
        model: config.model,
        modelType: config.modelType || 'chat',
        temperature: config.temperature,
        topP: config.topP,
        voice: config.voice,
        enableStream: config.enableStream
      }
      
      return {
        ...config,
        models: [migratedModel]
      }
    }
    
    return config
  }

  // 当选中的配置改变时，更新headers
  useEffect(() => {
    if (currentConfig) {
      setHeaderPairs(parseHeadersToKeyValue(currentConfig.customHeaders))
    } else {
      setHeaderPairs([])
    }
  }, [currentConfig])

  useEffect(() => {
    async function init() {
      const store = await Store.load('store.json');
      const aiModelList = await store.get<AiConfig[]>('aiModelList')
      try {
        const cachedTemplates = await getCachedProviderTemplates()
        if (cachedTemplates.length > 0) {
          setProviderTemplates(cachedTemplates)
          setLoadingTemplates(false)
        }

        const templates = await loadProviderTemplates(builtinProviderTemplates)
        setProviderTemplates(templates)
      } finally {
        setLoadingTemplates(false)
      }
      
      if (aiModelList) {
        // 迁移旧配置
        const migratedList = aiModelList.map(migrateOldConfig)
        
        // 检查是否有配置被迁移，如果有则保存
        const hasChanges = migratedList.some((config, index) => 
          JSON.stringify(config) !== JSON.stringify(aiModelList[index])
        )
        
        if (hasChanges) {
          await store.set('aiModelList', migratedList)
          setAiModelList(migratedList)
        }
      }
      
      // 过滤出用户自定义模型
      const userModels = aiModelList?.filter(model => !noteGenModelKeys.includes(model.key)) || []
      
      // 如果已经有保存的选择，且该配置仍然存在，则使用它
      if (selectedAiConfig && userModels.find(model => model.key === selectedAiConfig)) {
        // 已经有保存的选择，不需要做任何事情
        return
      } else if (userModels.length > 0) {
        // 如果没有保存的选择或选择的配置不存在，选择第一个
        const firstUserModel = userModels[0]
        setSelectedAiConfig(firstUserModel.key)
      } else {
        // 如果没有用户自定义模型，清空选择
        setSelectedAiConfig('')
      }
    }
    init()
  }, [])

  return (
    <SettingType id="ai" icon={<BotMessageSquare />} title={t('title')} desc={t('desc')}>
      {/* Fresh installs have no source-shipped credential or provider. */}
      {aiModelList.length === 0 && <DefaultModelsSection />}
      
      <CreateConfig 
        hasCustomModels={userCustomModels.length > 0} 
        onConfigCreated={(configId) => {
          setSelectedAiConfig(configId)
        }}
      />
      
      {userCustomModels.length > 0 && (
        <div className="space-y-6">
          {/* AI配置选择 */}
          <FormItem title={t('modelConfigTitle')} desc={t('modelConfigDesc')}>
              <div className="flex items-center gap-2 md:flex-row flex-col">
                <Select value={selectedAiConfig} onValueChange={setSelectedAiConfig}>
                  <SelectTrigger className="w-full">
                    <div className="flex items-center gap-2">
                      {currentConfig?.title || t('selectConfig')}
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    {userCustomModels.map((item) => (
                      <SelectItem value={item.key} key={item.key}>
                        {item.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2 md:w-auto w-full">
                  <Button 
                    disabled={!currentConfig} 
                    variant="outline" 
                    onClick={copyConfig}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    {t('copyConfig')}
                  </Button>
                  <Button 
                    disabled={!currentConfig || noteGenModelKeys.includes(currentConfig?.key || '')} 
                    variant="destructive" 
                    onClick={deleteCurrentConfig}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    {t('deleteCustomModel')}
                  </Button>
                </div>
              </div>
          </FormItem>

          {/* 当前配置的基础设置 */}
          {currentConfig && (
            <>
              <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 px-5 py-5 text-slate-50 shadow-lg shadow-slate-950/10 dark:border-slate-800">
                <div className="pointer-events-none absolute -right-12 -top-16 size-44 rounded-full border-[22px] border-amber-300/10" />
                <div className="relative">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.18em] text-amber-300">
                        <Waypoints className="size-4" /> Model connection
                      </div>
                      <h2 className="mt-2 text-xl font-semibold tracking-tight">让 CardMind 使用你的模型</h2>
                      <p className="mt-1 text-sm text-slate-300">完成下面三步，就能开始聊天、总结和生成复习卡片。</p>
                    </div>
                    <div className="rounded-full border border-white/10 bg-white/[.06] px-3 py-1.5 text-xs text-slate-300">
                      {currentConfig.title} · {configuredModels.length} 个模型
                    </div>
                  </div>

                  <div className="mt-5 grid gap-2 sm:grid-cols-3">
                    {[
                      { label: '连接账号', desc: apiKeyReady ? 'API Key 已填写' : '等待填写 API Key', done: apiKeyReady },
                      { label: '选择模型', desc: configuredModels[0]?.model || '等待选择模型', done: configuredModels.length > 0 },
                      { label: '检测连接', desc: connectionReady ? '模型连接成功' : configuredModels.length > 0 ? '点击模型右侧检测' : '选择模型后可检测', done: connectionReady },
                    ].map((step, index) => (
                      <div key={step.label} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.05] px-3 py-3">
                        <div className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.done ? 'bg-emerald-400 text-slate-950' : 'bg-white/10 text-slate-300'}`}>
                          {step.done ? <Check className="size-4" /> : index + 1}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{step.label}</div>
                          <div className="truncate text-[11px] text-slate-400">{step.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              {/* 供应商模板配置信息显示 */}
              {currentProviderTemplate && (
                <FormItem title={t('providerInfo')}>
                    <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                      {currentProviderTemplate.icon && (
                        <Image 
                          src={currentProviderTemplate.icon || ''} 
                          alt={currentConfig.title}
                          width={32}
                          height={32}
                          className="w-8 h-8 rounded"
                        />
                      )}
                      <div>
                        <div className="font-medium">{currentConfig.title}</div>
                        <div className="text-sm text-muted-foreground">{currentConfig.baseURL}</div>
                      </div>
                    </div>
                </FormItem>
              )}
              {loadingTemplates && currentConfig?.templateSource === 'remote' && !currentProviderTemplate && (
                <FormItem title={t('providerInfo')}>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" />
                    <span>正在获取供应商模板信息...</span>
                  </div>
                </FormItem>
              )}

              {/* 配置名称 - 只有非供应商模板配置才显示 */}
              {!currentProviderTemplate && (
                <FormItem title={t('modelTitle')} desc={t('modelTitleDesc')}>
                    <Input 
                      value={currentConfig.title} 
                      onChange={(e) => updateAiConfig({...currentConfig, title: e.target.value})} 
                    />
                </FormItem>
              )}

              {/* BaseURL - 只有非供应商模板配置才显示 */}
              {!currentProviderTemplate && (
                <FormItem title="BaseURL" desc={t('modelBaseUrlDesc')}>
                    <Input 
                      value={currentConfig.baseURL || ''} 
                      onChange={(e) => updateAiConfig({...currentConfig, baseURL: e.target.value})} 
                    />
                </FormItem>
              )}

              {/* API Key */}
              <FormItem title="API Key" desc="默认以圆点隐藏。请只在你信任的设备上保存和使用密钥。">
                  <div className="rounded-xl border bg-muted/25 p-3">
                    <div className="flex gap-2">
                    <Input 
                      className="flex-1" 
                      value={currentConfig.apiKey || ''} 
                      type={apiKeyVisible ? 'text' : 'password'} 
                      onChange={(e) => updateAiConfig({...currentConfig, apiKey: e.target.value})} 
                    />
                    <Button variant="outline" size="icon" onClick={() => setApiKeyVisible(!apiKeyVisible)}>
                      {apiKeyVisible ? <Eye /> : <EyeOff />}
                    </Button>
                    {currentProviderTemplate?.apiKeyUrl && (
                      <OpenBroswer
                        type="button"
                        url={currentProviderTemplate.apiKeyUrl || ''}
                        title={t('apiKeyUrl')}
                      />
                    )}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      {apiKeyReady ? <Check className="size-3.5 text-emerald-600" /> : <Circle className="size-3.5" />}
                      <span>{apiKeyReady ? '已填写，可以继续选择模型' : '请粘贴以 sk- 开头的 OpenAI API Key'}</span>
                    </div>
                  </div>
              </FormItem>

              {/* 自定义Headers */}
              {!currentProviderTemplate && (
                <FormItem title={t('customHeaders')} desc={t('customHeadersDesc')}>
                    <div className="space-y-2">
                      {headerPairs.map((pair, index) => (
                        <div key={pair.id} className="flex gap-2 items-center">
                          <Input
                            placeholder={t('headerKey')}
                            value={pair.key}
                            onChange={(e) => {
                              const newPairs = [...headerPairs]
                              newPairs[index].key = e.target.value
                              setHeaderPairs(newPairs)
                            }}
                            onBlur={() => {
                              const jsonObj = convertKeyValueToJson(headerPairs)
                              updateAiConfig({...currentConfig, customHeaders: jsonObj})
                            }}
                            className="flex-1"
                          />
                          <Input
                            placeholder={t('headerValue')}
                            value={pair.value}
                            onChange={(e) => {
                              const newPairs = [...headerPairs]
                              newPairs[index].value = e.target.value
                              setHeaderPairs(newPairs)
                            }}
                            onBlur={() => {
                              const jsonObj = convertKeyValueToJson(headerPairs)
                              updateAiConfig({...currentConfig, customHeaders: jsonObj})
                            }}
                            className="flex-1"
                          />
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => {
                              const newPairs = headerPairs.filter((_, i) => i !== index)
                              setHeaderPairs(newPairs)
                              updateAiConfig({...currentConfig, customHeaders: convertKeyValueToJson(newPairs)})
                            }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        onClick={() => setHeaderPairs([...headerPairs, {
                          key: '', value: '', id: Math.random().toString(36).substr(2, 9)
                        }])}
                        className="w-full"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        {t('addHeader')}
                      </Button>
                    </div>
                </FormItem>
              )}

              {/* 模型配置区域 */}
              <FormItem title={t('models')}>
                  <div className="space-y-4">
                    {/* 模型卡片列表 */}
                    <Accordion 
                      type="multiple" 
                      className="space-y-2"
                      value={expandedModels}
                      onValueChange={setExpandedModels}
                    >
                      {(currentConfig.models || []).map((modelConfig) => (
                        <ModelCard
                          key={modelConfig.id}
                          modelConfig={modelConfig}
                          aiConfig={currentConfig}
                          onUpdate={updateModelConfig}
                          onDelete={deleteModel}
                          onConnectionStateChange={(modelId, state) => {
                            setVerifiedModelIds(current => state === 'ok'
                              ? Array.from(new Set([...current, modelId]))
                              : current.filter(id => id !== modelId))
                          }}
                        />
                      ))}
                    </Accordion>
                    {/* 添加模型按钮 */}
                    <Button onClick={addNewModel} variant="outline" className="h-11 w-full border-dashed">
                      <Plus className="h-4 w-4 mr-2" />
                      添加另一个模型
                    </Button>
                  </div>
              </FormItem>
            </>
          )}
        </div>
      )}
    </SettingType>
  )
}
