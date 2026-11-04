import { forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react'
import styles from './Band.module.css'
import { useReveal } from '../../lib/motion'

/**
 * Band exports its own stylesheet as `bandStyles` so a section can reuse the
 * canonical button set (btnPrimary / btnGhost / btnDark / btnLight / btnVip) and
 * the eyebrow WITHOUT a shared atoms file:
 *
 *   import { Band, bandStyles } from './Band'
 *   <Link className={bandStyles.btnDark}>…</Link>
 *
 * Everything else a section renders stays in that section's own *.module.css.
 */
export const bandStyles = styles

type BandProps = {
  /** Background + text tone. Defaults to 'paper'. */
  tone?: 'paper' | 'wall' | 'ink'
  /** "01" — printed in purple before the eyebrow. */
  index?: string
  /** Optional glyph/badge above the eyebrow; styled by the CALLING section's module. */
  lead?: ReactNode
  /** Small uppercase label above the title. */
  eyebrow?: string
  /** Heading node. <em> inside gets the purple rule. */
  title?: ReactNode
  /** Short paragraph under the title. */
  intro?: ReactNode
  /** Center the inner column + text. */
  center?: boolean
  /** Tighter max-width on the inner column. */
  narrow?: boolean
  /** Extra classes from the OWNING section's module. */
  className?: string
  id?: string
  children?: ReactNode
}

/**
 * Band — the shared section wrapper. The forwarded ref is the <section>, so a
 * section can run its own ScrollTrigger on it. Band itself reveals any
 * [data-reveal] children (grouped stagger) via useReveal.
 */
export const Band = forwardRef<HTMLElement, BandProps>(function Band(
  { tone = 'paper', index, lead, eyebrow, title, intro, center, narrow, className, id, children },
  ref,
) {
  const el = useRef<HTMLElement>(null)
  useImperativeHandle(ref, () => el.current as HTMLElement)
  useReveal(el)

  const sectionClasses = [styles.band, styles[tone], center && styles.center, narrow && styles.narrow, className]
    .filter(Boolean)
    .join(' ')
  const hasHead = lead || eyebrow || title || intro

  return (
    <section ref={el} id={id} className={sectionClasses}>
      <div className={styles.inner}>
        {hasHead ? (
          <div className={styles.head}>
            {lead ?? null}
            {eyebrow ? (
              <p className={styles.eyebrow} data-reveal="head">
                {index ? <b>{index}</b> : null}
                {eyebrow}
              </p>
            ) : null}
            {title ? <h2 className={styles.title} data-reveal="head">{title}</h2> : null}
            {intro ? <p className={styles.intro} data-reveal="head">{intro}</p> : null}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  )
})
