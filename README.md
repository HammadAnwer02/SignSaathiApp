# Sign Saathi

Type English or Urdu and a 3D avatar signs it in Pakistan Sign Language (PSL). The app runs entirely
on the device: no account, no server, nothing typed leaves the phone.

A rebuild of the GIKI final year project (Imagine Cup 2024 semi-finalist), now as an iOS app built with
React + three.js inside Capacitor (Android and web can come from the same code later).

## Run it

```bash
npm install
npm run dev            # http://localhost:5190
npm test               # text engine tests
```

iOS (Xcode installed; `xcode-select` on this Mac points at the Command Line Tools, hence `DEVELOPER_DIR`):

```bash
npm run ios            # production build + cap sync
open ios/App/App.xcodeproj
```

or headless for the simulator:

```bash
cd ios/App && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -derivedDataPath ../DerivedData CODE_SIGNING_ALLOWED=NO build > /tmp/xcodebuild.log 2>&1
```

Capacitor is held at 8.4.1, the version already in this Mac's Swift package cache, because github.com could not be
reached when the iOS project was set up. If Xcode can't reach GitHub, add `-skipPackageUpdates` to the command above
to build from the cache. To move to the latest Capacitor once GitHub is reachable:

```bash
npm i @capacitor/core@latest @capacitor/ios@latest && npm i -D @capacitor/cli@latest && npm run ios
```

The native shell in `ios/App` matches Capacitor 8.4.1's template. Newer templates add a `SceneDelegate`, so compare
against a fresh `npx cap add ios` when upgrading.

## How it works

```
sign videos ──► pipeline/extract.py ──► pipeline/bake.py ──► public/signs/ ──► app
 (CC BY 4.0)     MediaPipe holistic       clean, gap-fill,      index.json        text → signs → avatar
                 per frame                smooth, trim, pack    clips/*.bin
```

**Pipeline** (`pipeline/`, Python 3.12 + MediaPipe, run once; output is committed):

| step | what it does |
| --- | --- |
| `fetch.py` | downloads the dictionary videos, word mapping and MediaPipe models into `pipeline/.cache/` |
| `extract.py` | runs MediaPipe's HolisticLandmarker on every frame (plus a crop pass for missed hands) |
| `bake.py` | converts axes, decides when each hand is actually signing, fills tracking gaps using the pose's coarse hand points, smooths, turns every signer to face the viewer, trims rest frames and writes `public/signs/` |

```bash
cd pipeline && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python fetch.py && .venv/bin/python extract.py && .venv/bin/python bake.py
```

Adding signs later means adding videos plus mapping entries and re-running `extract.py` / `bake.py`.

**App** (`src/`):

- `text/translate.ts` normalises English/Urdu, matches multi-word signs first, tries simple word forms
  (plurals, tenses, Urdu endings), and fingerspells anything left. Small function words with no sign are dropped.
- `avatar/solver.ts` turns each frame of landmarks into rotations for the avatar's bones (arms with the elbow's
  bend plane, palm orientation from the hand, every finger joint), blending idle arms back to rest.
- `avatar/player.ts` strings signs together with eased transitions, keeps hands up between signs, and plays
  only the held handshape of fingerspelled letters.
- `avatar/engine.ts` is the three.js scene (VRM avatar via three-vrm, interpreter framing, blinking, breathing).

QA: `window.__engine.debugPose(signId, frame)` freezes the avatar on one frame, so it can be screenshotted
next to the source video frame (`start` in `index.json` is the trimmed clip's first video frame).

## Data and licences

- **Signs:** PSL dictionary `pk-hfad-1` (775 usable signs) recorded at Hamza Foundation Academy for the Deaf,
  Lahore, published by the [sign-language-translator](https://github.com/sign-language-translator/sign-language-datasets)
  project under **CC BY 4.0**. The credit in the About screen is required by the licence.
- **Avatar (stand-in):** `VRM1_Constraint_Twist_Sample` © 2022 pixiv Inc., VRM Public License 1.0 (commercial use
  and redistribution allowed). Its top is recoloured at runtime so hands read clearly.
- **Fonts:** Atkinson Hyperlegible Next and Noto Nastaliq Urdu (SIL Open Font License).

## Known gaps before publishing

- **Vocabulary:** the dictionary has no signs for everyday words such as *where, water, eat, thank you, yes, hello*,
  or the digit 0 (2 and 3 use the V and W handshapes). Those words are fingerspelled for now.
- **Grammar:** sentences keep English/Urdu word order; real PSL grammar needs a fluent signer's input.
- **Source check:** some clips (e.g. *house*) carry a TV channel logo and a different signer, so confirm with the
  dataset authors that every video is covered by CC BY 4.0.
- **Review:** every sign should be checked by a fluent (ideally Deaf) PSL signer.
- **Avatar:** replace the stand-in with a custom VRM (VRoid Studio is free), ideally in local dress.
- **Not built yet:** voice input, lessons and quizzes, camera practice.
