'use client';
import { UserRoundCog } from "lucide-react"
import { SettingType } from "../components/setting-base";
import { useTranslations } from 'next-intl';
import TypewriterMode from './typewriter-mode';

export default function EditorSettingPage() {
  const t = useTranslations('settings.editor');
  return <SettingType id="editorSetting" icon={<UserRoundCog />} title={t('title')}>
    <TypewriterMode />
  </SettingType>
}
