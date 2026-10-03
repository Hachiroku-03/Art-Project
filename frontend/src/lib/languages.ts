export type LanguageCode =
  | 'en'
  | 'fr'
  | 'es'
  | 'de'
  | 'pt'
  | 'it'
  | 'nl'
  | 'ru'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'hi'
  | 'sw'
  | 'ar'

export type LanguageOption = {
  code: LanguageCode
  label: string
  native: string
  dir: 'ltr' | 'rtl'
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'en', label: 'English', native: 'English', dir: 'ltr' },
  { code: 'fr', label: 'French', native: 'Français', dir: 'ltr' },
  { code: 'es', label: 'Spanish', native: 'Español', dir: 'ltr' },
  { code: 'de', label: 'German', native: 'Deutsch', dir: 'ltr' },
  { code: 'pt', label: 'Portuguese', native: 'Português', dir: 'ltr' },
  { code: 'it', label: 'Italian', native: 'Italiano', dir: 'ltr' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands', dir: 'ltr' },
  { code: 'ru', label: 'Russian', native: 'Русский', dir: 'ltr' },
  { code: 'zh', label: 'Chinese', native: '中文', dir: 'ltr' },
  { code: 'ja', label: 'Japanese', native: '日本語', dir: 'ltr' },
  { code: 'ko', label: 'Korean', native: '한국어', dir: 'ltr' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
  { code: 'sw', label: 'Swahili', native: 'Kiswahili', dir: 'ltr' },
  { code: 'ar', label: 'Arabic', native: 'العربية', dir: 'rtl' },
]

export const LANGUAGE_CODES = new Set(LANGUAGES.map(l => l.code))

export function getLanguage(code: string): LanguageOption | undefined {
  return LANGUAGES.find(l => l.code === code)
}

export function getLanguageLabel(code: string): string {
  return getLanguage(code)?.native || code.toUpperCase()
}

export function getLanguageDir(code: string): 'ltr' | 'rtl' {
  return getLanguage(code)?.dir || 'ltr'
}