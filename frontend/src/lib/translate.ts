const TRANSLATE_API = 'http://localhost:8002'

export function viewerLang(): string {
  return (navigator.language || 'en').slice(0, 2)
}

export async function translateText(text: string, target: string = viewerLang()): Promise<string> {
  const res = await fetch(`${TRANSLATE_API}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error ?? 'translation failed')
  return data.translation as string
}

export async function translateMany(texts: string[], target: string = viewerLang()): Promise<string[]> {
  const res = await fetch(`${TRANSLATE_API}/translate_many`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, target }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error ?? 'translation failed')
  return data.translations as string[]
}