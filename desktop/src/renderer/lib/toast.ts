import { toast as sonnerToast } from 'sonner'

export function showToast(message: string, error = false, holdMs = 4000) {
  const opts = { duration: holdMs > 0 ? holdMs : Infinity }
  if (error) sonnerToast.error(message, opts)
  else sonnerToast(message, opts)
}
