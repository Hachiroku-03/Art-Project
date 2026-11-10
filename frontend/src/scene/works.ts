/* Artwork lives in src/art — imported so Vite bundles it and resolves the URL.
   (A bare '/art/a0.jpg' string only works for files in public/.) */
import a0 from '../art/a0.jpg'
import a1 from '../art/a1.jpg'
import a2 from '../art/a2.jpg'
import a3 from '../art/a3.jpg'
import a4 from '../art/a4.jpg'
import a5 from '../art/a5.jpg'
import a6 from '../art/a6.jpg'

export type Work = { src: string; title: string; artist: string; year: string; medium: string; w: number; h: number }

/** The wall. Sizes are metres-ish; the corridor lays them out left→right. */
export const WORKS: Work[] = [
  { src: a0, title: 'Untitled (Ochre Field)', artist: 'Mara Vance',     year: '2024', medium: 'Oil on linen',           w: 3.2, h: 1.8 },
  { src: a1, title: 'Indigo Vespers',         artist: 'Julian Reyes',   year: '2023', medium: 'Acrylic on canvas',      w: 1.7, h: 2.1 },
  { src: a3, title: 'Three Marks',            artist: 'Anouk Deveraux', year: '2025', medium: 'Ink and gesso on board', w: 2.5, h: 2.0 },
  { src: a2, title: 'Two Seated',             artist: 'Mara Vance',     year: '2022', medium: 'Oil on canvas',          w: 1.7, h: 2.1 },
  { src: a4, title: 'Cadmium Argument',       artist: 'Elias Thorne',   year: '2024', medium: 'Oil stick on paper',     w: 2.0, h: 2.0 },
  { src: a5, title: 'Indigo Grid',            artist: 'Nadia Brandt',   year: '2025', medium: 'Indigo dye on cotton',   w: 1.7, h: 2.1 },
  { src: a6, title: 'Coastal Haze',           artist: 'Julian Reyes',   year: '2024', medium: 'Oil on linen',           w: 3.0, h: 2.0 },
]

const GAP = 1.9
export const X = WORKS.reduce<number[]>((acc, w, i) => {
  if (i === 0) return [0]
  const prev = WORKS[i - 1]
  acc.push(acc[i - 1] + prev.w / 2 + GAP + w.w / 2)
  return acc
}, [])
export const LAST_X = X[X.length - 1]