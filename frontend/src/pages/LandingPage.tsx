import { TopBar } from './landing/TopBar'
import { Hero } from './landing/Hero'
import { HowItWorks } from './landing/HowItWorks'
import { Product } from './landing/Product'
import { GalleryMotif } from './landing/GalleryMotif'
import { Houses } from './landing/Houses'
import { Manifesto } from './landing/Manifesto'
import { Vip } from './landing/Vip'
import { Closer } from './landing/Closer'
import { Footer } from './landing/Footer'
import styles from './LandingPage.module.css'

/** Orchestrator — owns only the root shell. Each section owns its own motion. */
export function LandingPage() {
  return (
    <div className={styles.page} id="top">
      <TopBar />
      <main>
        <Hero />
        <HowItWorks />
        <Product />
        <GalleryMotif />
        <Houses />
        <Manifesto />
        <Vip />
        <Closer />
      </main>
      <Footer />
    </div>
  )
}

export default LandingPage
