import type { SignIndex } from '../signs/data'
import logo from '../assets/logo.svg'

export function AboutPanel({ index }: { index: SignIndex | null }) {
  return (
    <div className="about">
      <div className="about-head">
        <img src={logo} alt="" width={68} height={68} />
        <h1 className="tagline">Bridging Silence, Building Connections</h1>
      </div>
      <p className="lede">
        Sign Saathi turns English and Urdu into Pakistan Sign Language, so families and teachers can start talking with
        the deaf children in their lives.
      </p>

      <h2>How it works</h2>
      <p>
        Every sign comes from a video recorded at a school for the Deaf in Lahore. The app reads the body and hand
        movement from each video and replays it on the avatar, joining signs together into sentences. Words that
        aren't in the dictionary are fingerspelled letter by letter.
      </p>
      <p>Everything runs on your phone. Nothing you type leaves the device.</p>

      <h2>Please check with a signer</h2>
      <p>
        The movement is read from video by software, so some signs are not exact, and sentences follow English or Urdu
        word order rather than full PSL grammar. If you are learning, practise with a Deaf signer or a PSL teacher.
      </p>

      <h2>Credits</h2>
      <dl className="credits">
        <dt>Signs</dt>
        <dd>
          {index?.source.name ?? 'Pakistan Sign Language dictionary'}, recorded at{' '}
          {index?.source.recordedAt ?? 'Hamza Foundation Academy for the Deaf, Lahore'}, published by the{' '}
          <a href={index?.source.url ?? 'https://github.com/sign-language-translator/sign-language-datasets'}>
            sign-language-translator project
          </a>{' '}
          under {index?.source.license ?? 'CC BY 4.0'}. {index?.source.changes}
        </dd>
        <dt>Signers</dt>
        <dd>
          Made for Sign Saathi in Blender with MPFB, from MakeHuman's CC0 bodies, faces and expressions. The woman
          wears a shalwar kameez and hijab, the man a kameez shalwar.
        </dd>
        <dt>Built with</dt>
        <dd>three.js, three-vrm, MediaPipe, React and Capacitor.</dd>
      </dl>
      <p className="fine">Sign Saathi began as a final year project at GIK Institute and was an Imagine Cup 2024 semi-finalist.</p>
    </div>
  )
}
