import hMarkAccent from '@/assets/tray/h-mark-accent.svg'
import hMarkDark from '@/assets/tray/h-mark-dark.svg'
import hMarkLight from '@/assets/tray/h-mark.svg'
import { cn } from '@/lib/utils'

type HMarkProps = {
  variant?: 'accent' | 'dark' | 'light'
  className?: string
  size?: number
}

const srcByVariant = {
  accent: hMarkAccent,
  dark: hMarkDark,
  light: hMarkLight,
} as const

export function HMark({ variant = 'accent', className, size = 22 }: HMarkProps) {
  return (
    <img
      src={srcByVariant[variant]}
      alt=""
      width={size}
      height={size}
      className={cn('shrink-0 select-none', className)}
      draggable={false}
    />
  )
}
