import { Link } from 'react-router-dom'
import s from './Footer.module.css'

/* Blank href = icon not rendered. Fill with the product's real accounts. */
const SOCIAL: { key: string; href: string; label: string }[] = [
  { key: 'instagram', href: '', label: 'Instagram' },
  { key: 'x', href: '', label: 'X' },
  { key: 'youtube', href: '', label: 'YouTube' },
]

/* public:false entries are hidden until you confirm the route is open to logged-out visitors. */
const NAV = [
  { title: 'Get started', links: [
    { to: '/signup', label: 'Create account', public: true },
    { to: '/login', label: 'Log in', public: true },
    { to: '/#vip', label: 'Membership', public: true },
  ] },
  { title: 'Explore', links: [
    { to: '/auctions', label: 'Live & upcoming rooms', public: false },
    { to: '/community', label: 'Community', public: false },
    { to: '/house/apply', label: 'Accredit your house', public: false },
  ] },
  { title: 'The house', links: [
    { to: '/#how', label: 'How the floor works', public: true },
    { to: '/#manifesto', label: 'What we hold to', public: true },
    { to: '/terms', label: 'Terms', public: false },
    { to: '/privacy', label: 'Privacy', public: false },
  ] },
]

export function Footer() {
  const year = new Date().getFullYear()
  const social = SOCIAL.filter(x => x.href.trim())
  return (
    <footer className={s.foot}>
      <div className={s.inner}>
        <div className={s.brand}>
          <span className={s.wordmark}>THE SPACE</span>
          <p className={s.tag}>Contemporary art · social gallery · live auction floor</p>
          <p className={s.mission}>Artists hang on the wall, accredited houses run the room, and every paddle raised is a real bid.</p>
        </div>

        {NAV.map(col => {
          const vis = col.links.filter(l => l.public)
          if (!vis.length) return null
          return (
            <div key={col.title} className={s.col}>
              <p className={s.colTitle}>{col.title}</p>
              {vis.map(l => l.to.startsWith('/#')
                ? <a key={l.to} href={l.to.slice(1)} className={s.link}>{l.label}</a>
                : <Link key={l.to} to={l.to} className={s.link}>{l.label}</Link>)}
            </div>
          )
        })}

        <div className={s.bottom}>
          <p className={s.legal}>© {year} The Space. All works remain the property of their makers.</p>
          <p className={s.meta}>Port Harcourt · Lagos · Abuja</p>
          {social.length > 0 && (
            <div className={s.social} aria-label="Follow The Space">
              {social.map(x => <a key={x.key} href={x.href} target="_blank" rel="noopener noreferrer">{x.label}</a>)}
            </div>
          )}
        </div>
      </div>
    </footer>
  )
}
