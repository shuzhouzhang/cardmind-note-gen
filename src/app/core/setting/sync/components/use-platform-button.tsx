'use client'

import { Check, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import useSettingStore from '@/stores/setting'
import type { PrimarySyncPlatform } from '@/types/sync'

interface UsePlatformButtonProps {
  platform: PrimarySyncPlatform
  disabled?: boolean
  size?: 'default' | 'sm'
}

export function UsePlatformButton({
  platform,
  disabled = false,
  size = 'sm',
}: UsePlatformButtonProps) {
  const t = useTranslations()
  const { primaryBackupMethod, setPrimaryBackupMethod } = useSettingStore()
  const [isSaving, setIsSaving] = useState(false)
  const isCurrent = primaryBackupMethod === platform

  async function handleClick() {
    setIsSaving(true)
    try {
      await setPrimaryBackupMethod(platform)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Button
      type="button"
      variant={isCurrent ? 'secondary' : 'default'}
      size={size}
      disabled={disabled || isCurrent || isSaving}
      onClick={() => void handleClick()}
    >
      {isSaving ? (
        <Loader2 data-icon="inline-start" className="animate-spin" />
      ) : isCurrent ? (
        <Check data-icon="inline-start" />
      ) : null}
      {isCurrent
        ? t('settings.sync.currentPlatform')
        : t('settings.sync.setCurrentPlatform')}
    </Button>
  )
}
