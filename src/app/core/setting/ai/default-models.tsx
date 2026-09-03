'use client'

import { KeyRound, ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function DefaultModelsSection() {
  const t = useTranslations('settings.ai')

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          {t('credentialNoticeTitle')}
        </CardTitle>
        <CardDescription>
          {t('credentialNoticeDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t('credentialPreserveDesc')}</p>
        </div>
      </CardContent>
    </Card>
  )
}
