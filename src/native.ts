// Thin wrappers over Capacitor plugins that also work in a plain browser.

import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { SplashScreen } from '@capacitor/splash-screen'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

export const isNative = Capacitor.isNativePlatform()

export const prefs = {
  async get(key: string): Promise<string | null> {
    try {
      return (await Preferences.get({ key })).value
    } catch {
      return null
    }
  },
  async set(key: string, value: string) {
    try {
      await Preferences.set({ key, value })
    } catch {
      /* preferences are a convenience; ignore failures */
    }
  },
}

export function hideSplash() {
  if (isNative) SplashScreen.hide().catch(() => {})
}

/** Toggle a class on <html> while the on-screen keyboard is up (the web view shrinks to fit). */
export function watchKeyboard() {
  if (!isNative) return
  import('@capacitor/keyboard').then(({ Keyboard }) => {
    Keyboard.addListener('keyboardWillShow', () => document.documentElement.classList.add('kb-open'))
    Keyboard.addListener('keyboardWillHide', () => document.documentElement.classList.remove('kb-open'))
  })
}

export function tap() {
  if (isNative) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {})
}

/** the tap you feel for a right or a wrong answer */
export function buzz(right: boolean) {
  if (isNative) Haptics.notification({ type: right ? NotificationType.Success : NotificationType.Error }).catch(() => {})
}
