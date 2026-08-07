'use client'
import { Store } from '@tauri-apps/plugin-store'
import { useRouter  } from 'next/navigation'
import { useEffect } from 'react'
import { isMobileDevice } from '@/lib/check'

const MOBILE_CURRENT_PAGE_CACHE_KEY = 'noteGenMobileCurrentPage'

function getCachedMobilePage() {
  try {
    const cachedPage = window.localStorage.getItem(MOBILE_CURRENT_PAGE_CACHE_KEY)
    return cachedPage?.startsWith('/mobile') ? cachedPage : '/mobile/chat'
  } catch {
    return '/mobile/chat'
  }
}

export default function Home() {
  const router = useRouter()

  async function initDesktop() {
    const store = await Store.load('store.json')
    let currentPage = await store.get<string>('currentPage')

    // PC 端逻辑：将旧路径重定向到新的 /core/main
    if (currentPage === '/core/article' || currentPage === '/core/record') {
      currentPage = '/core/main'
      await store.set('currentPage', '/core/main')
      await store.save()
    }

    if (!currentPage?.includes('/mobile')) {
      router.replace(currentPage || '/core/main')
    } else {
      router.replace('/core/main')
    }
  }

  useEffect(() => {
    // iOS/Android 的 store.json 可能包含较大的同步缓存。首屏路由不能为了读取
    // currentPage 等待整个 Store 反序列化，否则 WebView 会长时间保持纯白。
    if (isMobileDevice()) {
      router.replace(getCachedMobilePage())
      return
    }

    void initDesktop()
  }, [router])

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
        <div className="flex size-12 items-center justify-center rounded-xl bg-foreground text-lg font-semibold text-background">
          N
        </div>
        <div className="text-base font-semibold">NoteGen</div>
        <div className="text-sm text-muted-foreground">正在启动…</div>
      </div>
    </main>
  )
}
