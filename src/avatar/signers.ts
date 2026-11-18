// The signers that ship with the app. A signer is a VRM file in src/assets/avatars/ named after its id
// (female.vrm, male.vrm). Vite finds whichever exist at build time, so adding the second model is enough
// for the signer switch to appear.

export type SignerId = 'female' | 'male'

export interface Signer {
  id: SignerId
  label: string
  url: string
}

const files = import.meta.glob<string>('../assets/avatars/*.vrm', { query: '?url', import: 'default', eager: true })

const KNOWN: { id: SignerId; label: string }[] = [
  { id: 'female', label: 'Female' },
  { id: 'male', label: 'Male' },
]

export const SIGNERS: Signer[] = KNOWN.flatMap((s) => {
  const url = files[`../assets/avatars/${s.id}.vrm`]
  return url ? [{ ...s, url }] : []
})

export function signerById(id: string | null | undefined): Signer {
  return SIGNERS.find((s) => s.id === id) ?? SIGNERS[0]
}
