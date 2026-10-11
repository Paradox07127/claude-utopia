export type Lang = 'zh-CN' | 'en'

const CHINESE = /^zh\b|chinese|中文|汉语|漢語|简体|繁體|mandarin/i

/** `language` userConfig → UI language; `auto` follows settings `language`, then the locale, else English. */
export function pickLang(option: unknown, settingsLanguage: unknown, locale: string | undefined): Lang {
  if (option === 'zh-CN' || option === 'en') return option
  if (typeof settingsLanguage === 'string' && settingsLanguage.trim() !== '') return CHINESE.test(settingsLanguage.trim()) ? 'zh-CN' : 'en'
  return locale !== undefined && /^zh/i.test(locale) ? 'zh-CN' : 'en'
}

const zh = {
  idleCompacted: '空闲将满缓存时效，已自动压缩上下文',
}

const en: typeof zh = {
  idleCompacted: 'Idle near cache expiry: context compacted',
}

export const strings: Record<Lang, typeof zh> = { 'zh-CN': zh, en }
