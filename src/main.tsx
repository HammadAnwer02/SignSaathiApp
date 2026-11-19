import { createRoot } from 'react-dom/client'
import '@fontsource/lato/400.css'
import '@fontsource/lato/700.css'
import '@fontsource/lato/900.css'
import '@fontsource-variable/noto-nastaliq-urdu'
import './styles.css'
import { App } from './App'
import { hideSplash, watchKeyboard } from './native'

watchKeyboard()
// The splash normally hides once the avatar is ready; never leave someone stuck behind it.
setTimeout(hideSplash, 10_000)
createRoot(document.getElementById('root')!).render(<App />)

// a speed test of the sign check, in builds made for it (VITE_BENCH=1) only
if (import.meta.env.VITE_BENCH) void import('./check/bench').then((m) => m.runBench())
