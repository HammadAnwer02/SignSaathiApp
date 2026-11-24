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

The native shell in `ios/App` is Capacitor 8.4.1's template plus a `SceneDelegate` and the scene manifest in
`Info.plist`: iOS 27 refuses to launch an app that hasn't adopted the scene life cycle (it traps at launch). Compare
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
| `bake.py` | converts axes, decides when each hand is actually signing, cleans the hand tracking (below), fills tracking gaps using the pose's coarse hand points, smooths, turns every signer to face the viewer, trims rest frames and writes `public/signs/` |

The hand tracking needs cleaning before an avatar can follow it smoothly. `bake.py` drops finds that aren't the
signer's hand: bits of the face, and one hand found twice, once for each side (which side a copy belongs to comes
from the nearest frames where both hands were seen apart). It puts right the mirror images the tracker returns
(thumb and little finger swapped, or fingers bent backwards) and leaves out plain misreadings, picking the path
through each hand's readings that turns and changes shape least. Hand shapes are smoothed trusting still frames over
fast, blurred ones, and palms read squashed edge-on less. Through longer gaps the palm follows the pose's coarse hand
only while that turns the way a hand can.

```bash
cd pipeline && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python fetch.py && .venv/bin/python extract.py && .venv/bin/python bake.py
```

Adding signs later means adding videos plus mapping entries and re-running `extract.py` / `bake.py`.

**App** (`src/`):

- `text/translate.ts` normalises English/Urdu, matches multi-word signs first, tries simple word forms
  (plurals, tenses, Urdu endings), and fingerspells anything left. Small function words with no sign are dropped.
- `avatar/solver.ts` turns each frame of landmarks into rotations for the avatar's bones (arms with the elbow's
  bend plane, palm orientation from the hand, every finger joint), blending idle arms back to rest. The forearm's
  twist is planned over the whole clip so a palm turning up doesn't snap round, joints are kept to what they can
  do, and frames where the tracked hand bends back further than a wrist goes are bridged from the frames either side.
- `avatar/contact.ts` keeps the two arms out of each other. The avatar's build differs from the person filmed, so
  where the video's arms cross or touch, aiming the bones the same way can sink one arm into the other. After a clip
  is solved, the arms (as capsules sized from the avatar's bones) are parted along one line for each stretch of
  contact, by turning at the shoulder and bending the elbow, so the same arm stays on top all through it (the one the
  video has on top, unless only the other way keeps them apart or the video's way moves them much further). The hands
  keep their angle. How far to part them is planned frame by frame over the stretch and a few frames either side
  (every distance up to 20 cm is tried in every frame, and the smoothest run that keeps them clear is kept), so they
  part and meet smoothly and aren't pushed into each other as they come together. Fingers, which can lace and hook,
  are only kept out where a little more of a move does it.
- `avatar/player.ts` strings signs together with eased transitions, keeps hands up between signs, and plays
  only the held handshape of fingerspelled letters.
- `avatar/engine.ts` is the three.js scene (VRM avatar via three-vrm, interpreter framing, blinking, breathing).
- `ui/Practice.tsx` is practising along: the front camera as a mirror under the signer, with the sign repeating.
- `learn/` is the Learn tab's course: units of dictionary signs, lessons of three or four new signs with
  watch-and-choose exercises, XP, a streak and spaced review, all kept on the device.
- `check/` checks a learner's signing in a lesson's "Sign it" step. MediaPipe's holistic tracker follows the front
  camera in a worker (`tracker.worker.ts`), and `match.ts` compares each hand's shape, facing and place against the
  shoulders with the sign's recording, allowing for a slower pace and for the other hand. A sign passes when it's
  close enough (`PASS`) and no other course sign fits the same signing clearly better (`MARGIN`). `bench.ts` times
  the tracker on a device (see its header).

QA: `window.__engine.debugPose(signId, frame)` freezes the avatar on one frame, so it can be screenshotted
next to the source video frame (`start` in `index.json` is the trimmed clip's first video frame).

## Data and licences

- **Signs:** PSL dictionary `pk-hfad-1` (775 usable signs) recorded at Hamza Foundation Academy for the Deaf,
  Lahore, published by the [sign-language-translator](https://github.com/sign-language-translator/sign-language-datasets)
  project under **CC BY 4.0**. The credit in the About screen is required by the licence.
- **Hand tracking:** Google's MediaPipe Tasks Vision (`@mediapipe/tasks-vision`) and its holistic landmarker model,
  copied from `pipeline/.cache/models/` to `public/models/holistic_landmarker.task`, both Apache 2.0.
- **Signers:** made for Sign Saathi in Blender with MPFB, from MakeHuman's CC0 assets, and exported as VRM 1.0 with
  the VRM Add-on for Blender. The woman wears a shalwar kameez and hijab, the man a kameez shalwar; the scripts that
  build both are in `tools/avatar-build/`.
- **Fonts:** Lato and Noto Nastaliq Urdu (SIL Open Font License).
- **Brand:** logo, colours (petrol `#053B50`, teal `#176B87`, aqua `#64CCC5`, cream `#F6F4EB`) and type come from the
  SignSaathi Figma file. The logo is `src/assets/logo.svg` exactly as exported; the app icon and launch images in
  `ios/App/App/Assets.xcassets` are rendered from it (`rsvg-convert` for the SVG, `ffmpeg` to place it on the
  petrol or cream background).

## Known gaps before publishing

- **Vocabulary:** the dictionary has no signs for everyday words such as *where, water, eat, thank you, yes, hello*,
  or the digit 0 (2 and 3 use the V and W handshapes). Those words are fingerspelled for now.
- **Grammar:** sentences keep English/Urdu word order; real PSL grammar needs a fluent signer's input.
- **Source check:** some clips (e.g. *house*) carry a TV channel logo and a different signer, so confirm with the
  dataset authors that every video is covered by CC BY 4.0.
- **Review:** every sign should be checked by a fluent (ideally Deaf) PSL signer.
- **Signers:** both are built by script from MakeHuman's stock characters (see Signers below). A fluent signer should
  check that handshapes read clearly on them, and their memory use on an iPhone hasn't been measured. The brief for a
  3D artist under Signers is there if a hand-made pair is wanted later.
- **Course:** the Learn tab's lessons haven't been checked by a Deaf PSL teacher (the app says so).
- **Sign check:** tested on the dictionary's own videos and timed on an iPhone 17 Pro Max (about 50 ms a frame), but
  not yet with learners signing, so how strict `PASS` should be is still open. It also lets through signs that
  contain the one asked for (*mother* contains *woman*) and letters a finger apart (m and n, u and r).
- **Not built yet:** voice input.

## Signers (female and male)

Each signer is a VRM file in `src/assets/avatars/`, named `female.vrm` or `male.vrm`. The build picks up whichever
exist, and a Female / Male switch appears on the stage once there are two (the choice is remembered). Today's pair
is built by script from MakeHuman (below). The brief after that is for a hand-made pair, if one is wanted later: it
is written to send to a 3D artist as it stands, and it also lists what the app needs from any signer.

### The current signers

A South Asian woman in a plum kameez and shalwar under a berry hijab with a cream band, and a clean-shaven South
Asian man in a deep green kameez shalwar with a band collar, both adults of natural proportions. `tools/avatar-build/`
builds them in Blender run headless, with MPFB 2.0.18 and MakeHuman's CC0 system assets for the bodies, faces and
skin, and the VRM Add-on for Blender 4.10.5 to export VRM 1.0:

- `female.py` and `male.py` set up each body and face, add the game-engine rig in a T-pose with eye bones, and mix
  MakeHuman's expression units into the seven VRM expressions the app drives.
- `clothes.py` fits the kameez (with the man's collar, placket and buttons) and the shalwar round the body.
  `hijab.py` drapes the hijab over hulls of the head and shoulders, with an under-cap below the chin so a nod never
  shows skin.
- `export_female.py` and `export_male.py` write `signsaathi_female.vrm` and `signsaathi_male.vrm` (about 20 seconds
  each); `dress_female.py` and `test_dress.py` render stills.
- `preview.mjs` loads a VRM into the running dev app in headless Microsoft Edge and saves screenshots of it idle,
  signing and in each expression. It needs `playwright-core`, which isn't one of the app's dependencies.

Setting up: Blender 5.3 from blender.org, MPFB and the VRM Add-on from extensions.blender.org, and MakeHuman's CC0
system assets (`makehuman_system_assets_cc0.zip`) from makehumancommunity.org, installed into MPFB. Keep Blender's
user folder (with the add-ons and assets) in a build folder; the scripts find it through `SS_BUILD` and write to
`$SS_WORK/out`:

```bash
BLENDER_USER_RESOURCES=<build>/blender-user SS_BUILD=<build> SS_WORK=<work> \
  <Blender.app>/Contents/MacOS/Blender -b -P tools/avatar-build/export_female.py
```

Preview new exports with `preview.mjs` and check them as under Installing new signers before copying them over the
files in `src/assets/avatars/`.

### Brief: two signing characters for Sign Saathi

Sign Saathi is an iPhone app that turns English and Urdu text into Pakistan Sign Language (PSL). A 3D character signs
each sentence on the phone screen, moved by body, hand and face motion read from videos of PSL signers. We need two
characters, a Pakistani man and a Pakistani woman, who look like a pair. In sign language the hands and the face
carry the meaning, so they matter more than anything else. The app's current pair is built from MakeHuman's stock
characters; we can send their files to show the clothes, colours and proportions we have in mind.

**Style.** Semi-realistic cartoon with natural adult proportions, warm and approachable, never anime or chibi. Both
are adults of about 25 to 35. The look we like is
[pakistani cartoon Character](https://sketchfab.com/3d-models/pakistani-cartoon-character-da8450cb06dd4cdfb90043390903412b)
by Chenzoss. It is CC BY 4.0, so you may build on it, but it has no rig or face shapes and its fingers are fused.

**The man.** South Asian skin tone, short black hair, clean-shaven, dark brown eyes. A
plain kameez in one solid colour (deep teal or navy works well) with a band collar and a buttoned placket, sleeves to
the wrist, and shalwar.

**The woman.** South Asian skin tone, dark brown eyes, and a hijab in a rich colour (berry or rose, say) wrapped
closely round the face, so the eyebrows, cheeks and chin stay fully visible and its ends tuck in or fall behind the
shoulders. A plain, full-sleeved kameez or abaya in a darker colour that sets off the hands, and shalwar.

**Clothes for both**

- Plain, solid, mid-to-dark colours that contrast with the skin, as a TV interpreter wears. Embroidery only as a
  subtle texture at the collar or neckline; no prints, sequins or shine.
- Sleeves end at the wrist and sit close to it: no wide, flared or rolled cuffs.
- Nothing hangs in front of the chest, where the hands work: no loose dupatta, long necklace, or hair over the
  shoulders.
- No rings, bangles, watches or long nails, so every finger reads clearly.
- The app frames them from the waist up, so the legs and feet can be simple, but please model the full body.

**Proportions.** Natural adult proportions: a head about one seventh of the height, a man about 1.75 m tall and a
woman about 1.62 m. The app copies the angle of every joint from video of real signers, so where a hand lands (chin,
cheek, forehead, chest) depends on the character's own arm length and head size; a big head or short arms makes
those signs miss. Hands at natural size, or up to about 10% larger, which reads better on a phone.

**Hands** (the most important part)

- Five separate fingers, modelled relaxed and slightly spread, with clean edge loops at every knuckle. If you start
  from a generated, scanned or sculpted mesh, retopologise it.
- Three joints in every finger and the thumb, on both hands.
- Weighted so these poses deform without collapsing or poking through: a tight fist, a flat hand, a pointing index
  finger, thumb tip on index tip (an O), fingers spread, thumb across the palm under the fingers, index and middle
  crossed, one hand's fingertips on the other palm, and fingertips on the chin and on the chest.
- The forearm twists up to 90° each way without pinching at the wrist. A twist bone driven by a VRM roll constraint
  is welcome; the app runs them.

**Face**

- Separate eyes, eyelids that close fully, and a mouth that opens onto teeth and a tongue.
- Eye bones, or VRM look-at set up, so the eyes can follow the viewer.
- Shape keys set up as VRM expressions: blink, blinkLeft, blinkRight, aa, ih, ou, ee, oh, happy, angry, sad,
  surprised and relaxed. The app drives blink, aa, ou, happy, surprised, angry and sad today.
- Two more shape keys, browRaise and browFurrow, for questions, which PSL marks with the eyebrows.
- Expressions that read clearly at phone size, mostly through the brows, eyelids and mouth, and a neutral face that
  is calm and friendly. ARKit's 52 blendshapes are a welcome extra, not a requirement.

**Phone budget** (each character)

- About 50,000 triangles at most, with the density in the hands and the face.
- Up to 4 materials and textures up to 2048 × 2048; the finished file under 15 MB.
- MToon or standard glTF PBR (metallic-roughness) materials, no custom shaders. The app lights the scene simply (a
  key light, a fill light, ambient light and, for PBR materials, a soft room light), so keep the look readable
  without strong reflections.
- Hair and beard as solid mesh or alpha-cutout cards, not alpha-blended layers, which draw in the wrong order.
- Spring bones only behind the body (the back of the hijab, say): nothing in front of the chest may swing.

**Rig and export**

- A standard humanoid skeleton (VRM / Unity Humanoid bones), fingers and eyes included, with the same layout for
  both characters.
- T-pose or A-pose, real-world scale in metres, standing on the origin and facing forward.
- Exported as VRM 1.0 (with the VRM Add-on for Blender or UniVRM); VRM 0.x also works.
- VRM metadata: names "Sign Saathi Female" and "Sign Saathi Male", you as author, and licence fields that match our
  agreement.

**Deliverables**

1. Front and side sketches, or a quick 3D block-out, of both characters, approved before modelling.
2. Modelled and textured characters, shown in turnaround renders, approved before rigging.
3. Rigged VRM files with renders of the hand poses above and of each expression. We test them in the app and send
   back any fixes.
4. The final VRM files, plus the source files (.blend or .fbx, and textures) so small changes can be made later.

**Rights.** Full rights to use, modify and distribute both characters inside Sign Saathi, free or paid, on any
platform, and in its marketing (App Store, website, social media), worldwide and royalty-free. We'll credit you by
name in the app's About screen.

Please quote a price and a timeline for both characters together.

### Installing new signers

Save the files as `src/assets/avatars/female.vrm` and `src/assets/avatars/male.vrm`, then run `npm run ios`. Before
shipping, check each signer:

- fingerspelling and a few signs that touch the face, frozen with `window.__engine.debugPose(id, frame)` in a browser
  and compared with the source video frame;
- the seven expressions;
- load time and memory on an iPhone.

The stage lights PBR materials with a soft room light (three's `RoomEnvironment` through a `PMREMGenerator`, in
`src/avatar/engine.ts`) as well as its directional and ambient lights; toon (MToon) materials ignore it. Then update
the signer credits in `src/ui/AboutPanel.tsx` and under Data and licences.
