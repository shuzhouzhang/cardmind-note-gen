import { SettingPanel } from "../components/setting-base";
import { useTranslations } from 'next-intl';
import { ModelSelect } from "./model-select";
import { Bot, Highlighter, Languages, Lightbulb } from "lucide-react";

export function Setting() {
  const t = useTranslations('settings.defaultModel');

  const options = [
    {
      title: t('options.primaryModel.title'),
      desc: t('options.primaryModel.desc'),
      modelKey: 'primaryModel',
      icon: <Bot className="size-4" />
    },
    {
      title: t('options.markDesc.title'),
      desc: t('options.markDesc.desc'),
      modelKey: 'markDesc',
      icon: <Highlighter className="size-4" />
    },
    {
      title: t('options.placeholder.title'),
      desc: t('options.placeholder.desc'),
      modelKey: 'placeholder',
      icon: <Lightbulb className="size-4" />
    },
    {
      title: t('options.translate.title'),
      desc: t('options.translate.desc'),
      modelKey: 'translate',
      icon: <Languages className="size-4" />
    },
  ]

  return (
    options.map((option) => (
      <SettingPanel key={option.modelKey} title={option.title} desc={option.desc} icon={option.icon}>
        <ModelSelect modelKey={option.modelKey} />
      </SettingPanel>
    ))
  )
}