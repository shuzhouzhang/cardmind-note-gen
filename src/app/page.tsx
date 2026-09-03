'use client'
import { Store } from '@tauri-apps/plugin-store'
import { useRouter  } from 'next/navigation'
import { useEffect } from 'react'

export default function Home() {
  const router = useRouter()
  async function init() {
    const store = await Store.load('store.json')
    let currentPage = await store.get<string>('currentPage')
    
    if (currentPage === '/core/article' || currentPage === '/core/record' || currentPage?.includes('/mobile')) {
      currentPage = '/core/main'
      await store.set('currentPage', '/core/main')
      await store.save()
    }

    router.push(currentPage || '/core/main')
  }
  useEffect(() => {
    init()
  }, [])
}
