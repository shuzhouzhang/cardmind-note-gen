'use client'
import { 
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Trash2, CircleCheck, CircleX, LoaderCircle, Settings2, Sparkles } from "lucide-react"
import { ModelConfig, ModelType, AiConfig } from "../config"
import { useTranslations } from 'next-intl'
import ModelSelect from "./modelSelect"
import { useState, useRef } from "react"
import { createOpenAIClient } from "@/lib/ai/utils"
import { toast } from "@/hooks/use-toast"
import { blobToBytes, invokeAiBinary, invokeAiJson, invokeAiMultipart } from "@/lib/ai/tauri-client"

interface ModelCardProps {
  modelConfig: ModelConfig
  aiConfig: AiConfig
  onUpdate: (modelId: string, field: keyof ModelConfig, value: any) => void
  onDelete: (modelId: string) => void
  onConnectionStateChange?: (modelId: string, state: 'ok' | 'error' | 'checking' | 'init') => void
}

export default function ModelCard({ modelConfig, aiConfig, onUpdate, onDelete, onConnectionStateChange }: ModelCardProps) {
  const t = useTranslations('settings.ai')
  const [checkState, setCheckState] = useState<'ok' | 'error' | 'checking' | 'init'>('init')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  const handleCheck = async () => {
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    
    setCheckState('checking')
    onConnectionStateChange?.(modelConfig.id, 'checking')
    abortControllerRef.current = new AbortController()
    
    try {
      const aiStatus = await checkModelStatus(modelConfig, aiConfig, abortControllerRef.current.signal)
      if (aiStatus) {
        setCheckState('ok')
        onConnectionStateChange?.(modelConfig.id, 'ok')
        toast({
          description: t('connectionSuccess'),
          className: 'border-green-500 bg-green-50 text-green-800'
        })
      } else {
        setCheckState('error')
        onConnectionStateChange?.(modelConfig.id, 'error')
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return
      }
      setCheckState('error')
      onConnectionStateChange?.(modelConfig.id, 'error')
    }
  }

  const checkModelStatus = async (model: ModelConfig, aiConfig: AiConfig, signal?: AbortSignal) => {
    try {
      if (!model.model || !aiConfig.baseURL) return false

      const fullAiConfig: AiConfig = {
        ...aiConfig,
        model: model.model,
        modelType: model.modelType,
        temperature: model.temperature,
        topP: model.topP,
        voice: model.voice,
        enableStream: model.enableStream
      }

      switch (model.modelType) {
        case 'rerank':
          const query = 'Apple'
          const documents = ["apple","banana","fruit","vegetable"]
          const rerankData = await invokeAiJson<any>({
            config: {
              baseUrl: aiConfig.baseURL,
              apiKey: aiConfig.apiKey,
              customHeaders: aiConfig.customHeaders,
            },
            path: '/rerank',
            method: 'POST',
            body: {
              model: model.model,
              query,
              documents
            }
          }, signal)
          if (!rerankData || !rerankData.results) {
            throw new Error('重排序结果格式不正确')
          }
          return true

        case 'embedding':
          const testText = '测试文本'
          const embeddingDataJson = await invokeAiJson<any>({
            config: {
              baseUrl: aiConfig.baseURL,
              apiKey: aiConfig.apiKey,
              customHeaders: aiConfig.customHeaders,
            },
            path: '/embeddings',
            method: 'POST',
            body: {
              model: model.model,
              input: testText,
              encoding_format: 'float'
            }
          }, signal)
          if (!embeddingDataJson || !embeddingDataJson.data || !embeddingDataJson.data[0] || !embeddingDataJson.data[0].embedding) {
            throw new Error('嵌入结果格式不正确')
          }
          return true

        case 'tts':
          const testAudioText = '测试音频生成'
          const ttsBuffer = await invokeAiBinary({
            config: {
              baseUrl: aiConfig.baseURL,
              apiKey: aiConfig.apiKey,
              customHeaders: aiConfig.customHeaders,
            },
            path: '/audio/speech',
            method: 'POST',
            body: {
              model: model.model,
              input: testAudioText,
              voice: model.voice || 'alloy'
            }
          }, signal)
          if (!ttsBuffer.byteLength) {
            throw new Error('TTS模型返回格式不正确')
          }
          return true

        case 'stt':
          const testAudioBlob = new Blob([new Uint8Array(100)], { type: 'audio/webm' })
          try {
            await invokeAiMultipart({
              config: {
                baseUrl: aiConfig.baseURL,
                apiKey: aiConfig.apiKey,
                customHeaders: aiConfig.customHeaders,
              },
              path: '/audio/transcriptions',
              fileFieldName: 'file',
              fields: {
                model: model.model
              },
              file: {
                bytes: await blobToBytes(testAudioBlob),
                fileName: 'test.webm',
                contentType: 'audio/webm',
              }
            }, signal)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes('401') || message.includes('403')) {
              throw new Error(message)
            }
          }
          return true

        default:
          const openai = await createOpenAIClient(fullAiConfig)
          await openai.chat.completions.create({
            model: model.model,
            messages: [{
              role: 'user' as const,
              content: 'Hello'
            }],
          })
          return true
      }
    } catch (error) {
      toast({
        description: error instanceof Error ? error.message : 'Error',
        variant: 'destructive'
      })
      return false
    }
  }

  const renderCheckIcon = () => {
    switch (checkState) {
      case 'ok':
        return <CircleCheck className="text-green-500 size-4" />
      case 'error':
        return <CircleX className="text-red-500 size-4" />
      case 'checking':
        return <LoaderCircle className="animate-spin size-4" />
      default:
        return null
    }
  }

  return (
    <AccordionItem value={modelConfig.id} className="overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="flex items-center justify-between flex-wrap">
        <div className="flex-1">
          <AccordionTrigger className="w-full px-4 py-4 hover:no-underline">
            <div className="flex min-w-0 items-center gap-3 text-left">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <Sparkles className="size-4" />
              </div>
              <div className="min-w-0">
                <span className="block truncate text-base font-semibold">
                {modelConfig.model || t('newModel')}
                </span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  {modelConfig.model ? '用于聊天、总结和生成卡片' : '先选择一个模型'}
                </span>
              </div>
              <Badge variant="secondary" className="ml-1 shrink-0">{t(`modelType.${modelConfig.modelType}`)}</Badge>
            </div>
          </AccordionTrigger>
        </div>
        <div className="flex items-center justify-end gap-2 p-2">
          <Button
            variant={checkState === 'ok' ? 'secondary' : 'outline'}
            size="sm"
            onClick={handleCheck}
            disabled={!modelConfig.model || checkState === 'checking'}
          >
            {renderCheckIcon()}
            {t('checkConnection')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onDelete(modelConfig.id)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>      
      <AccordionContent className="px-4 pb-4 space-y-4">
        {/* 模型选择 */}
        <div className="space-y-2">
          <Label>{t('model')}</Label>
          <ModelSelect
            model={modelConfig.model}
            setModel={(model) => {
              setCheckState('init')
              onConnectionStateChange?.(modelConfig.id, 'init')
              onUpdate(modelConfig.id, 'model', model)
            }}
            aiConfig={aiConfig}
          />
          <p className="text-xs text-muted-foreground">推荐先选择一个通用对话模型。更换模型不会删除已有卡片。</p>
        </div>

        <button
          type="button"
          onClick={() => setAdvancedOpen(value => !value)}
          className="flex w-full items-center justify-between rounded-lg border bg-muted/25 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-center gap-2 font-medium"><Settings2 className="size-4" />高级参数</span>
          <span className="text-xs text-muted-foreground">{advancedOpen ? '收起' : '模型类型、随机性与流式响应'}</span>
        </button>

        {advancedOpen && <div className="space-y-5 rounded-xl border bg-muted/15 p-4">
        {/* 模型类型 */}
        <div className="space-y-2">
          <Label>{t('modelType.title')}</Label>
          <RadioGroup
            value={modelConfig.modelType}
            onValueChange={(value) => onUpdate(modelConfig.id, 'modelType', value as ModelType)}
            className="flex flex-wrap gap-4"
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="chat" id={`chat-${modelConfig.id}`} />
              <Label htmlFor={`chat-${modelConfig.id}`}>{t('modelType.chat')}</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="tts" id={`tts-${modelConfig.id}`} />
              <Label htmlFor={`tts-${modelConfig.id}`}>{t('modelType.tts')}</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="stt" id={`stt-${modelConfig.id}`} />
              <Label htmlFor={`stt-${modelConfig.id}`}>{t('modelType.stt')}</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="embedding" id={`embedding-${modelConfig.id}`} />
              <Label htmlFor={`embedding-${modelConfig.id}`}>{t('modelType.embedding')}</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="rerank" id={`rerank-${modelConfig.id}`} />
              <Label htmlFor={`rerank-${modelConfig.id}`}>{t('modelType.rerank')}</Label>
            </div>
          </RadioGroup>
        </div>

        {/* Chat模型的特殊配置 */}
        {modelConfig.modelType === 'chat' && (
          <>
            <div className="space-y-2">
              <Label>Temperature</Label>
              <div className="flex gap-2 items-center">
                <Slider
                  className="flex-1"
                  value={[modelConfig.temperature || 0.7]}
                  max={2}
                  step={0.01}
                  onValueChange={(value) => onUpdate(modelConfig.id, 'temperature', value[0])}
                />
                <span className="text-sm text-muted-foreground w-12">
                  {(modelConfig.temperature || 0.7).toFixed(2)}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Top P</Label>
              <div className="flex gap-2 items-center">
                <Slider
                  className="flex-1"
                  value={[modelConfig.topP || 1.0]}
                  max={1}
                  min={0}
                  step={0.01}
                  onValueChange={(value) => onUpdate(modelConfig.id, 'topP', value[0])}
                />
                <span className="text-sm text-muted-foreground w-12">
                  {(modelConfig.topP || 1.0).toFixed(2)}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>{t('enableStream')}</Label>
                <div className="text-sm text-muted-foreground">
                  {t('enableStreamDesc')}
                </div>
              </div>
              <Switch
                checked={modelConfig.enableStream !== false}
                onCheckedChange={(checked) => onUpdate(modelConfig.id, 'enableStream', checked)}
              />
            </div>
          </>
        )}

        {/* TTS模型的特殊配置 */}
        {modelConfig.modelType === 'tts' && (
          <div className="space-y-2">
            <Label>{t('voice')}</Label>
            <Input
              value={modelConfig.voice || ''}
              onChange={(e) => onUpdate(modelConfig.id, 'voice', e.target.value)}
              placeholder={t('voicePlaceholder')}
            />
          </div>
        )}
        </div>}
      </AccordionContent>
    </AccordionItem>
  )
}
