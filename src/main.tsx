import { createRoot } from 'react-dom/client'
import '@fontsource-variable/atkinson-hyperlegible-next'
import '@fontsource-variable/noto-nastaliq-urdu'
import './styles.css'
import { App } from './App'
import { hideSplash, watchKeyboard } from './native'

watchKeyboard()
// The splash normally hides once the avatar is ready; never leave someone stuck behind it.
setTimeout(hideSplash, 10_000)
createRoot(document.getElementById('root')!).render(<App />)
