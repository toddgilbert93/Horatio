import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import App from './App'
import PreferencesApp from './PreferencesApp'
import './styles.css'

const params = new URLSearchParams(window.location.search)
const view = params.get('view')
const isPrefs = view === 'preferences'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>
      {isPrefs ? <PreferencesApp /> : <App />}
      <Toaster
        theme={isPrefs ? 'light' : 'dark'}
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast:
              'rounded-sm border border-border bg-card text-card-foreground font-[family-name:var(--font-body)] shadow-none',
          },
        }}
      />
    </TooltipProvider>
  </StrictMode>
)
