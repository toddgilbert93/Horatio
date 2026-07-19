import { useEffect, useRef } from 'react'

/** Glyphs cycled while a character is still "scrambling". */
const SCRAMBLE_CHARS = 'XABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?#@'

function rand(pool: string): string {
  return pool[Math.floor(Math.random() * pool.length)]
}

type ScrambleTextProps = {
  /** Final text to reveal. */
  text: string
  className?: string
  /** Total scramble duration in ms (last char locks near the end). */
  duration?: number
}

/**
 * Pixel/scramble reveal. Renders the final text at rest and replays the
 * left-to-right lock-in whenever the enclosing button (or the span itself)
 * is hovered. Self-contained — no per-button wiring needed.
 */
export function ScrambleText({ text, className, duration = 520 }: ScrambleTextProps) {
  const spanRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = spanRef.current
    if (!el) return

    let rafId = 0
    let startTime: number | null = null

    const play = () => {
      cancelAnimationFrame(rafId)
      startTime = null

      const chars = [...text]
      const n = chars.length
      el.innerHTML = chars
        .map((ch, i) => {
          if (ch === ' ')
            return '<span style="display:inline-block;width:0.4em"> </span>'
          return `<span data-i="${i}" data-final="${ch}" style="display:inline-block">${rand(
            SCRAMBLE_CHARS
          )}</span>`
        })
        .join('')

      const slots = el.querySelectorAll<HTMLSpanElement>('[data-i]')
      const lockTimes = Array.from({ length: n }, (_, i) => {
        const progress = i / Math.max(n - 1, 1)
        return duration * (0.1 + 0.9 * Math.pow(progress, 0.85))
      })

      const tick = (now: number) => {
        if (startTime === null) startTime = now
        const elapsed = now - startTime
        let allDone = true
        slots.forEach((slot) => {
          const i = Number(slot.dataset.i)
          if (slot.dataset.done) return
          if (elapsed >= lockTimes[i]) {
            slot.textContent = slot.dataset.final ?? ''
            slot.dataset.done = '1'
          } else {
            slot.textContent = rand(SCRAMBLE_CHARS)
            allDone = false
          }
        })
        if (!allDone) rafId = requestAnimationFrame(tick)
      }

      rafId = requestAnimationFrame(tick)
    }

    // Trigger on the enclosing button so the whole hit area works.
    const trigger: HTMLElement = el.closest('button') ?? el
    trigger.addEventListener('mouseenter', play)

    return () => {
      trigger.removeEventListener('mouseenter', play)
      cancelAnimationFrame(rafId)
    }
  }, [text, duration])

  return (
    <span ref={spanRef} className={className} aria-label={text}>
      {text}
    </span>
  )
}
