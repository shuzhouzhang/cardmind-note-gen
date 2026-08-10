'use client'

import { Suspense, useEffect } from 'react'
import { ConsoleFilter } from '@/components/console-filter'
import { SyncDeletionGuard } from '@/components/sync-deletion-guard'
import { SyncConflictAutoResolver } from '@/components/sync-conflict-auto-resolver'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { getSyncPushQueue } from '@/lib/sync/sync-push-queue'
import { NextIntlProvider } from './NextIntlProvider'

export function RootClientProviders({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    getSyncPushQueue()
  }, [])

  return (
    <>
      <ConsoleFilter />
      <Suspense>
        <TooltipProvider>
          <NextIntlProvider>
            <SyncDeletionGuard />
            <SyncConflictAutoResolver />
            {children}
          </NextIntlProvider>
        </TooltipProvider>
      </Suspense>
      <Toaster closeButton richColors position="bottom-right" />
    </>
  )
}
