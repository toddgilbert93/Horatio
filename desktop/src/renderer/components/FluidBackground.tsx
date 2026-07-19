import fallback from '@/assets/bg/fluid-bg.jpg'

/** Noise · AURORA · Dither — embed flag set for full-bleed background mode. */
const FLUID_EMBED =
  'https://fluid.krackeddevs.com/#p=1.25,2.05,5.2,0.13,1,6,0,0,11.34,0,0.95,1,0,1,13,3,0,0,0,0,0,0,0,0,-0.24,0,5,52,1'

/**
 * Translucent dither wash over the theme ground + bust. Opacity/hue are theme-
 * tuned in CSS so Ember doesn’t pick up the AURORA teal cast.
 */
export function FluidBackground() {
  return (
    <div
      aria-hidden
      data-fluid-bg=""
      className="pointer-events-none absolute inset-0 z-[1] overflow-hidden"
      style={{
        backgroundImage: `url(${fallback})`,
        backgroundPosition: 'center',
        backgroundSize: 'cover',
        backgroundRepeat: 'no-repeat',
      }}
    >
      <iframe
        src={FLUID_EMBED}
        title="Background"
        className="block size-full border-0"
      />
    </div>
  )
}
