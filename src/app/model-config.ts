import { AiConfig } from '@/app/core/setting/config'

// Metadata only. CardMind never ships a provider credential in source code.
// Existing user-managed NoteGen configurations remain in the local Tauri store.
export const noteGenDefaultModels: AiConfig[] = [
  {
    apiKey: '',
    baseURL: 'https://api.notegen.top/v1',
    key: 'note-gen-free',
    title: 'NoteGen Free',
    models: [
      {
        id: 'note-gen-chat',
        model: 'Qwen/Qwen3-8B',
        modelType: 'chat',
        temperature: 0.7,
        topP: 1,
        enableStream: true,
      },
      {
        id: 'note-gen-embedding',
        model: 'BAAI/bge-m3',
        modelType: 'embedding',
        temperature: 0.7,
        topP: 1,
      },
      {
        id: 'note-gen-vlm',
        model: 'THUDM/GLM-4.1V-9B-Thinking',
        modelType: 'chat',
        temperature: 0.7,
        topP: 1,
        enableStream: true,
      },
    ],
  },
]

export const noteGenModelKeys = ['note-gen-free', 'note-gen-limited', 'note-gen-chat', 'note-gen-embedding', 'note-gen-vlm']
