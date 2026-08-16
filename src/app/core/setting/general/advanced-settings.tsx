'use client'

import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message } from '@tauri-apps/plugin-dialog'
import { BaseDirectory, exists, remove } from '@tauri-apps/plugin-fs'
import { Store } from '@tauri-apps/plugin-store'
import { useTranslations } from 'next-intl'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import useSettingStore from '@/stores/setting'
import { ConfigFileActions } from './config-file-actions'
import { Activity, AlertTriangle, Code2, Database, FolderX, Gauge, Network, Server } from 'lucide-react'
import { SettingSection } from '../components/setting-base'
import { DeveloperDiagnostics } from './developer-diagnostics'

export function AdvancedSettings({ showConfigFileActions = true }: { showConfigFileActions?: boolean }) {
  const t = useTranslations('settings.dev')
  const [proxy, setProxy] = useState('')
  const [pendingAction, setPendingAction] = useState<'data' | 'files' | null>(null)
  const developerMode = useSettingStore(state => state.developerMode)
  const setDeveloperMode = useSettingStore(state => state.setDeveloperMode)
  const experimentalFeatures = useSettingStore(state => state.experimentalFeatures)
  const setExperimentalFeature = useSettingStore(state => state.setExperimentalFeature)
  const { toast } = useToast()

  async function handleClearData() {
    setPendingAction('data')
    try {
      const store = await Store.load('store.json')
      await store.clear()
      await remove('store.json', { baseDir: BaseDirectory.AppData })
      await remove('note.db', { baseDir: BaseDirectory.AppData })
      await message(t('dataClearedRestartDesc'), {
        title: t('dataClearedRestartTitle'),
        kind: 'info',
      })
      await getCurrentWindow().close()
    } finally {
      setPendingAction(null)
    }
  }

  async function handleClearFile() {
    setPendingAction('files')
    try {
      const folders = ['screenshot', 'article', 'clipboard', 'image']
      for (const folder of folders) {
        if (await exists(folder, { baseDir: BaseDirectory.AppData })) {
          await remove(folder, { baseDir: BaseDirectory.AppData, recursive: true })
        }
      }
      toast({ title: t('filesCleared') })
    } finally {
      setPendingAction(null)
    }
  }

  async function handleProxyBlur() {
    const store = await Store.load('store.json')
    await store.set('proxy', proxy.trim())
    await store.save()
  }

  useEffect(() => {
    async function loadProxy() {
      const store = await Store.load('store.json')
      const storedProxy = await store.get<string>('proxy')
      if (storedProxy) setProxy(storedProxy)
    }

    void loadProxy()
  }, [])

  return (
    <>
      <SettingSection title={t('title')} desc={t('desc')}>
        <ItemGroup className="gap-3">
          <Item variant="outline">
            <ItemMedia variant="icon"><Network /></ItemMedia>
            <ItemContent>
              <ItemTitle>{t('proxyTitle')}</ItemTitle>
              <ItemDescription>{t('proxy')}</ItemDescription>
            </ItemContent>
            <ItemActions className="basis-full sm:ml-auto sm:basis-auto">
              <Input
                className="w-full sm:w-[280px]"
                placeholder={t('proxyPlaceholder')}
                value={proxy}
                onChange={(event) => setProxy(event.target.value)}
                onBlur={() => void handleProxyBlur()}
              />
            </ItemActions>
          </Item>
          {showConfigFileActions ? <ConfigFileActions /> : null}
        </ItemGroup>
      </SettingSection>

      <SettingSection title={t('dangerZoneTitle')} desc={t('dangerZoneDesc')}>
        <ItemGroup className="gap-3">
          <Item variant="warning">
            <ItemMedia variant="icon"><Code2 /></ItemMedia>
            <ItemContent>
              <ItemTitle>{t('developerModeTitle')}</ItemTitle>
              <ItemDescription>{t('developerModeDesc')}</ItemDescription>
            </ItemContent>
            <ItemActions className="ml-auto">
              <Switch
                checked={developerMode}
                onCheckedChange={(enabled) => void setDeveloperMode(enabled)}
                aria-label={t('developerModeTitle')}
              />
            </ItemActions>
          </Item>

          {developerMode ? (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed p-2">
              <Item variant="outline" size="sm">
                <ItemMedia variant="icon"><Server /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{t('experimentalSelfHostedSyncTitle')}</ItemTitle>
                  <ItemDescription>{t('experimentalSelfHostedSyncDesc')}</ItemDescription>
                </ItemContent>
                <ItemActions className="ml-auto">
                  <Switch
                    checked={experimentalFeatures.selfHostedSync}
                    onCheckedChange={(enabled) => void setExperimentalFeature('selfHostedSync', enabled)}
                    aria-label={t('experimentalSelfHostedSyncTitle')}
                  />
                </ItemActions>
              </Item>
              <Item variant="outline" size="sm">
                <ItemMedia variant="icon"><Activity /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{t('experimentalDiagnosticsTitle')}</ItemTitle>
                  <ItemDescription>{t('experimentalDiagnosticsDesc')}</ItemDescription>
                </ItemContent>
                <ItemActions className="ml-auto">
                  <Switch
                    checked={experimentalFeatures.diagnosticsAndLogs}
                    onCheckedChange={(enabled) => void setExperimentalFeature('diagnosticsAndLogs', enabled)}
                    aria-label={t('experimentalDiagnosticsTitle')}
                  />
                </ItemActions>
              </Item>
              {experimentalFeatures.diagnosticsAndLogs ? (
                <DeveloperDiagnostics />
              ) : null}
              <Item variant="outline" size="sm">
                <ItemMedia variant="icon"><Gauge /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{t('experimentalPerformanceInfoTitle')}</ItemTitle>
                  <ItemDescription>{t('experimentalPerformanceInfoDesc')}</ItemDescription>
                </ItemContent>
                <ItemActions className="ml-auto">
                  <Switch
                    checked={experimentalFeatures.performanceInfo}
                    onCheckedChange={(enabled) => void setExperimentalFeature('performanceInfo', enabled)}
                    aria-label={t('experimentalPerformanceInfoTitle')}
                  />
                </ItemActions>
              </Item>
            </div>
          ) : null}

          <Item variant="outline">
            <ItemMedia variant="icon"><Database /></ItemMedia>
            <ItemContent>
              <ItemTitle>{t('clearDataTitle')}</ItemTitle>
              <ItemDescription>{t('clearDataDesc')}</ItemDescription>
            </ItemContent>
            <ItemActions className="ml-auto">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" disabled={pendingAction !== null}>
                    {t('clearButton')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogMedia><AlertTriangle /></AlertDialogMedia>
                    <AlertDialogTitle>{t('clearDataTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('clearDataConfirm')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('cancelButton')}</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void handleClearData()}>
                      {t('confirmClearButton')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </ItemActions>
          </Item>

          <Item variant="outline">
            <ItemMedia variant="icon"><FolderX /></ItemMedia>
            <ItemContent>
              <ItemTitle>{t('clearFileTitle')}</ItemTitle>
              <ItemDescription>{t('clearFileDesc')}</ItemDescription>
            </ItemContent>
            <ItemActions className="ml-auto">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" disabled={pendingAction !== null}>
                    {t('clearButton')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogMedia><AlertTriangle /></AlertDialogMedia>
                    <AlertDialogTitle>{t('clearFileTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('clearFilesConfirm')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('cancelButton')}</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void handleClearFile()}>
                      {t('confirmClearButton')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingSection>
    </>
  )
}
