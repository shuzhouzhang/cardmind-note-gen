import { create } from 'zustand';
import { Store } from "@tauri-apps/plugin-store";
import { toast } from '@/hooks/use-toast';

// RAG 设置参数接口
export interface RagSettings {
  // 文本分块的最大字符数
  chunkSize: number;
  // 分块之间的重叠字符数
  chunkOverlap: number;
  // 检索返回的相关文档数量
  resultCount: number;
  // 文档相似度阈值 (0.0-1.0)
  similarityThreshold: number;
}

// 默认参数值
export const DEFAULT_RAG_SETTINGS: RagSettings = {
  chunkSize: 1000,
  chunkOverlap: 200,
  resultCount: 5,
  similarityThreshold: 0.7
};

// RAG 设置状态接口
interface RagSettingsState extends RagSettings {
  // 初始化设置
  initSettings: () => Promise<void>;
  // 更新单个设置项
  updateSetting: <K extends keyof RagSettings>(key: K, value: RagSettings[K]) => Promise<void>;
  // 重置所有设置为默认值
  resetToDefaults: () => Promise<void>;
}

// 创建状态存储
const useRagSettingsStore = create<RagSettingsState>((set) => ({
  ...DEFAULT_RAG_SETTINGS,

  // 初始化设置
  initSettings: async () => {
    try {
      const store = await Store.load('store.json');
      
      // 从存储中读取各个设置项，如果不存在则使用默认值
      const chunkSize = await store.get<number>('ragChunkSize') || DEFAULT_RAG_SETTINGS.chunkSize;
      const chunkOverlap = await store.get<number>('ragChunkOverlap') || DEFAULT_RAG_SETTINGS.chunkOverlap;
      const resultCount = await store.get<number>('ragResultCount') || DEFAULT_RAG_SETTINGS.resultCount;
      const similarityThreshold = await store.get<number>('ragSimilarityThreshold') || DEFAULT_RAG_SETTINGS.similarityThreshold;
      
      set({
        chunkSize,
        chunkOverlap,
        resultCount,
        similarityThreshold
      });
    } catch (error) {
      console.error('初始化 RAG 设置失败:', error);
    }
  },

  // 更新单个设置项
  updateSetting: async <K extends keyof RagSettings>(key: K, value: RagSettings[K]) => {
    try {
      // 更新本地状态
      set({ [key]: value } as Pick<RagSettings, K>);
      
      // 保存到存储
      const store = await Store.load('store.json');
      await store.set(`rag${key.charAt(0).toUpperCase() + key.slice(1)}`, value);
    } catch (error) {
      console.error(`更新 RAG 设置 ${key} 失败:`, error);
    }
  },

  // 重置所有设置为默认值
  resetToDefaults: async () => {
    try {
      // 更新本地状态
      set(DEFAULT_RAG_SETTINGS);
      
      // 保存到存储
      const store = await Store.load('store.json');
      await store.set('ragChunkSize', DEFAULT_RAG_SETTINGS.chunkSize);
      await store.set('ragChunkOverlap', DEFAULT_RAG_SETTINGS.chunkOverlap);
      await store.set('ragResultCount', DEFAULT_RAG_SETTINGS.resultCount);
      await store.set('ragSimilarityThreshold', DEFAULT_RAG_SETTINGS.similarityThreshold);
    } catch (error) {
      toast({
        title: '重置 RAG 设置失败',
        description: error as string,
        variant: 'destructive',
      });
    }
  }
}));

export default useRagSettingsStore;
