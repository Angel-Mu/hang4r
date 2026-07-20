import '@fontsource-variable/bricolage-grotesque'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import './style.css'
import './sections.css'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'

gsap.registerPlugin(ScrollTrigger)

/** Cloudflare Pages Function — adds the email to the Resend audience and
 *  sends the confirmation. Same-origin, so no CORS dance. */
const WAITLIST_ENDPOINT = '/api/waitlist'

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

/* ---------- smooth scroll ---------- */
if (!reducedMotion) {
  const lenis = new Lenis({ autoRaf: false })
  lenis.on('scroll', ScrollTrigger.update)
  gsap.ticker.add((time) => lenis.raf(time * 1000))
  gsap.ticker.lagSmoothing(0)
  // anchor links go through lenis so they inherit the easing
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const target = document.querySelector(a.getAttribute('href') ?? '')
      if (target) {
        e.preventDefault()
        lenis.scrollTo(target as HTMLElement, { offset: -70 })
      }
    })
  })
}

/* ---------- on-load hero reveal ---------- */
if (!reducedMotion) {
  gsap.to('.hero [data-reveal]', {
    opacity: 1,
    y: 0,
    duration: 0.7,
    ease: 'power3.out',
    stagger: 0.09,
    delay: 0.15
  })

  /* hero window: tilted on load, flattens as you scroll (transform-only) */
  gsap.to('.app-window', {
    rotateX: 0,
    scale: 1,
    ease: 'none',
    scrollTrigger: {
      trigger: '[data-stage]',
      start: 'top 85%',
      end: 'top 30%',
      scrub: 0.6
    }
  })

  /* ---------- scroll reveals for sections ---------- */
  gsap.utils.toArray<HTMLElement>('main > :not(.hero) [data-reveal], .section [data-reveal]').forEach((el) => {
    gsap.to(el, {
      opacity: 1,
      y: 0,
      duration: 0.65,
      ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 82%' }
    })
  })
} else {
  gsap.set('[data-reveal]', { opacity: 1, y: 0 })
}

/* ---------- the living app window ---------- */
function streamTimeline(): gsap.core.Timeline {
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 2.5, defaults: { ease: 'power2.out' } })
  const show = { opacity: 1, y: 0, duration: 0.32 }
  const prep = (sel: string): void => {
    gsap.set(sel, { opacity: 0, y: 6 })
  }

  ;['[data-t]', '[data-d]'].forEach(prep)

  // tile 1 — claude chat streams: prompt, turn, worked steps, tool, done
  tl.to('[data-t="1"]', show, 0.4)
    .to('[data-t="2"]', show, 1.2)
    .to('[data-t="3"]', show, 1.9)
    .to('[data-t="4"]', show, 2.5)
    .to('[data-t="5"]', show, 3.3)
    .to('[data-t="6"]', show, 4.1)

  // tile 2 — diff review builds up while tile 1 streams
  tl.to('[data-d="1"]', show, 2.0)
    .to('[data-d="2"]', show, 2.6)
    .to('[data-d="3"]', show, 3.2)
    .to('[data-d="4"]', show, 3.5)
    .to('[data-d="5"]', show, 3.8)
    .to('[data-d="6"]', show, 4.1)
    .to('[data-d="7"]', { ...show, duration: 0.4 }, 5.0)

  // sidebar — the idle pg-17 session wakes up, then settles back
  tl.add(() => {
    document.querySelector('[data-codex-led]')?.classList.replace('led-idle', 'led-run')
  }, 6.0)
  tl.add(() => {
    document.querySelector('[data-codex-led]')?.classList.replace('led-run', 'led-idle')
  }, 10.5)

  tl.duration(Math.max(tl.duration(), 11))
  return tl
}

if (!reducedMotion) {
  const stream = streamTimeline()
  stream.pause()
  ScrollTrigger.create({
    trigger: '[data-stage]',
    start: 'top 95%',
    onEnter: () => stream.play(),
    onLeave: () => stream.pause(),
    onEnterBack: () => stream.play(),
    onLeaveBack: () => stream.pause()
  })

  /* capability visuals */
  // 02 — branch draw
  gsap.utils.toArray<SVGPathElement>('.vb-branch').forEach((p, i) => {
    gsap.to(p, {
      strokeDashoffset: 0,
      duration: 1.1,
      delay: i * 0.25,
      ease: 'power2.inOut',
      scrollTrigger: { trigger: '[data-viz="branches"]', start: 'top 80%' }
    })
  })
  gsap.to('.vb-node', {
    opacity: 1,
    duration: 0.3,
    stagger: 0.16,
    delay: 0.5,
    scrollTrigger: { trigger: '[data-viz="branches"]', start: 'top 80%' }
  })

  // 01 — tiles pop in
  gsap.from('.viz-tiles i', {
    opacity: 0,
    scale: 0.85,
    duration: 0.35,
    stagger: 0.1,
    ease: 'back.out(1.6)',
    scrollTrigger: { trigger: '[data-viz="tiles"]', start: 'top 80%' }
  })

  // 03 — review conversation
  gsap.from('.viz-review > *', {
    opacity: 0,
    y: 8,
    duration: 0.4,
    stagger: 0.35,
    scrollTrigger: { trigger: '[data-viz="review"]', start: 'top 80%' }
  })

  // 04 — badges
  gsap.from('.viz-badges span', {
    opacity: 0,
    y: 6,
    duration: 0.3,
    stagger: 0.08,
    scrollTrigger: { trigger: '[data-viz="cli"]', start: 'top 80%' }
  })
} else {
  gsap.set('[data-t], [data-d]', { opacity: 1 })
}

/* ---------- waitlist ---------- */
document.querySelectorAll<HTMLFormElement>('.waitlist').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = form.querySelector<HTMLInputElement>('input[name="email"]')
    const note = form.querySelector<HTMLParagraphElement>('.waitlist-note')
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    const email = input?.value.trim()
    if (!email || !note) return

    if (button) button.disabled = true
    note.textContent = '… adding you'
    try {
      const res = await fetch(WAITLIST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })
      if (res.ok) {
        note.textContent = "✓ subscribed — check your inbox"
        form.reset()
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        note.textContent = body?.error ?? 'something broke — try again?'
      }
    } catch {
      note.textContent = 'something broke — try again?'
    } finally {
      if (button) button.disabled = false
    }
  })
})
