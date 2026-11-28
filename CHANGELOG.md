# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.4.4] - 2026-11-28

### Added
- **New brand mark**: app icons, favicons, the topbar logo and the About
  dialog use the new SignaVis mark; the website derives its Material 3
  colours from the brand palette. Optional amber accent theme
  (Display → Accent colour, dark mode).
- **Community on Telegram** (<https://t.me/SignaVis>): linked from the help
  menu, the About dialog, the website and the README. The labeling app shows
  a one-time hint from the second start on; closing it hides it for good.

### Fixed
- **WAV files with a `bext`/`JUNK`/`LIST` chunk before `fmt `** (common on
  field recorders, e.g. Xeno-canto XC1197283) failed to load with
  "The hardware sample rate provided … is outside the range". The sample
  rate is now read from the `fmt ` chunk, and an implausible value falls
  back to the default AudioContext rate instead of aborting the load.

## [1.4.3] - 2026-11-24

### Fixed
- **SignaVis Lite: updating a .deb install** failed with "invalid updater
  binary format" (the updater downloaded the AppImage). The release now
  publishes the .deb signature and lists the .deb for .deb installs.

## [1.4.2] - 2026-11-24

### Added
- **Waveform scale** (Settings → Waveform): linear or dB (a mirrored loudness
  envelope in dBFS with a selectable range), height fitted to the peak or full
  scale (±1 / 0 dBFS, comparable between files); also in the overview strip.
  Player API: `waveformDisplay` option, `setWaveformDisplay()`,
  `waveformDisplay` and the `waveformdisplaychange` event.
- **RMS** body inside the min/max outline of the waveform (can be turned off).
- **Waveform band** (Settings → Waveform → Band → Visible band): the waveform
  and the overview strip are filtered (4th-order Butterworth) to the frequency
  range the spectrogram shows, so calls stand out from wind and traffic
  rumble; zoom the frequency axis to pick the band. Clipping is still judged
  on the unfiltered signal. The filter is loaded only when the band is on.
- **Clipping** marked red in the waveform and the overview strip; a badge
  shows the file's peak in dBFS.
- **Channel selection**: also under Settings → Display. Player API: `channel`
  option, `setChannel()`, `getChannel()` and the `channelselectionchange` event.
- Labels remember the **channel** they were made on (drawn, stamped, pasted,
  BirdNET, BirdBox); labels on the mix or on mono recordings carry none. The
  Raven export writes it to the Channel column (1-based), the JSON exports as
  `channel` (0-based); the label table has an optional "Ch" column.
- Player options for host apps (used by the BirdNET-Analyzer GUI):
  `locale` (German translation, loaded on demand; English otherwise),
  `spectrogramSettings` / `setSpectrogramSettings()` (colour map, FFT size,
  overlap, oversampling, scale and contrast range set by the host; colour
  changes only recolour), `autoFreqView` / `setAutoFreqView()` and
  `playOnLabelClick`. New colour map **jet**.
- Read-only lanes: hovering the spectrogram below a strip highlights its
  label, a click plays it.
- Gradio wrapper: `player_value(spectrogram=…, auto_freq_view=…)`; the player
  sends `signavis-timeupdate` so the host can mark the table row being played.

### Changed
- **Lanes** are calm again: framed strips in the species colour with a
  confidence fill; no dashes, dot or bar meter. Label colours come from a
  palette with clearly distinct neighbours. Tooltip says `[read-only]`.

### Fixed
- Playback starts without the output start-up delay and resumes where it was
  paused (Chromium jumped ~0.3 s ahead); smoother playhead without run-up,
  stop and leap.
- Gradio wrapper: ▶ in the table selects the detection and plays it.
- Log frequency scale: no empty strip below 32.7 Hz.
- The spectrogram no longer grows for one frame and shrinks after loading.
- Amplitude axis: round values at their true positions, as many as fit; the
  old labels were rounded differently (0.01 at the top over 0.006 at half).
  Positive samples are drawn upwards (they were drawn downwards).

## [1.4.1] - 2026-11-23

### Changed
- **Labels** look the same in spectrogram, waveform and phone viewer: frame
  only, no fill; name, buttons and dimensions outside the box. Colour shows
  the species or set, the stroke shows the origin (own, detector, similar
  call, imported), the weight shows the state (hover, playing, selected).
- **Frequency axis**: Audacity-style ruler with as many labels as the axis
  height allows, round values on mel/log axes, minor ticks, `kHz` once at
  the top; finer steps when zoomed into a frequency range.
- **Adopting a detection** (✓) converts it into a label instead of copying
  it, so an adopted call no longer shows twice; deleting the label or undo
  brings the detection back. Labels without frequency bounds (BirdNET
  windows) can be fitted to the call.

### Fixed
- Accept/reject buttons are back on lane strips and stay in view on strips
  that run past the right edge.
- The on-disk spectrogram cache of long recordings (OPFS, about 60 MB per
  minute of audio) no longer grows without bound: whenever a recording is
  opened, the least recently used stores are removed until all together fit
  1 GiB. The open recording's store stays even if it alone is larger, and
  stores still open in another page are skipped. New player option
  `spectrogramCacheMaxBytes` (`0` = no disk cache).

## [1.4.0] - 2026-11-22

### Added
- **Channel selection** for multichannel recordings: a picker in the status
  bar (Mix / L / R / Ch n), shown only for multichannel files. Spectrogram,
  waveform and the analyses (BirdNET, BirdBox, SNR, snap, similar calls) use
  the selected channel or the mix; playback keeps all channels. Default: mix,
  remembered between sessions.
- Properties: **Light** section for recordings with location and date — sun
  altitude over the day with twilight phases and day length over the year,
  as charts or as dials.
- Phone UI: **Details** screen with the recording's properties; BirdNET model
  and BirdBox settings in Analyse; Xeno-canto API key in Settings.
- Player: `defaultPreset` option and a *Classic small* preset; the view mode
  can be switched at runtime (a hidden spectrogram is not computed).

### Changed
- **Long recordings (1–3 h)**: audio is decoded in slices, spectrogram and
  waveform peaks are computed in blocks and off the main thread. 180 min
  recordings: peak memory about 7 GB → 2.7 GB, longest main-thread task up
  to 7.8 s → about 0.3 s; 120 and 180 min recordings now load at all.
- Many labels: only labels near the view are drawn (3000 labels: 99k → 9k
  DOM nodes); faster drag preview and label list.
- Keyboard: player shortcuts also work while a dropdown, button or slider has
  focus; all shortcuts go through one dispatcher (review, label, player, app).
- The playhead wins over the label tools (wider grab area); the player and the
  label layers run one interaction at a time.

### Fixed
- `npm i signavis` failed: the package ran a postinstall script it does not
  ship.
- Times just below a full minute showed as `00:60.0`.
- Bandpass and detector playback did not move the label highlight and table.
- 180 min MP3/FLAC files failed to load in incognito windows (no storage
  quota); whole-file spectrograms over 1 GiB are now skipped with a note.
- The labeling app no longer flashes unstyled markup while it starts.
- Analyzer embedding: labels are kept when a value carries no detections; the
  loading overlay ends when the spectrogram is hidden.

## [1.3.2] - 2026-11-19

### Fixed
- SignaVis Lite AppImage: Xeno-canto recordings (and other compressed audio)
  no longer hang at "Decoding". The AppImage now ships its own GStreamer
  plugins instead of relying on the host's, which may not match.

## [1.3.1] - 2026-11-19

Same features as 1.3.0, which was tagged but not published on GitHub because
the Windows SignaVis Lite build failed.

### Fixed
- Windows SignaVis Lite installers build again and ship `DirectML.dll`.

## [1.3.0] - 2026-11-18

### Added
- Labeling app: **BirdBox call boxes** (Analyse → Call boxes) draw a
  time/frequency box around every bird call; detection streams while it runs.
- **Similar calls**: after one label, SignaVis suggests the repeats of that
  call (also in other recordings) for a quick accept/reject review; the search
  runs off the main thread. In SignaVis Lite, Perch 2 embeddings pick them.
- **Label template**: species + tags for new labels; accepting a detection
  takes over its BirdBox box; Snap uses BirdBox only around the click.
- **Species lists** (new Species tab): own lists that limit BirdNET analysis,
  like BirdNET-Analyzer's `--slist`.
- **AnuraPAM** model preset (BirdNET V2.4 + 14 European anurans).
- Phone UI (≤ 600 px or touch landscape) with Recordings · Review · Live ·
  Species, review queue and live detection.
- Onboarding wizard on first run; help popover with search; rewarding sponsor
  card.

### Changed
- Species taxonomy follows **BirdNET+ V3.0** (about 1,900 more classes: frogs,
  insects, mammals …), is built from the BirdNET species API, and species
  images come from that API.
- Species search shows grouped results (recent, this project, taxonomy) with
  ranking by location and short codes.
- Overview strip: clearer visible-range window and a detail strip for long
  recordings.
- Redesigned Analyse, Upload, Project and Audio tabs; modern app dialogs with
  a filled primary button; selects drawn by the app (readable with any GTK
  theme in SignaVis Lite on Linux).
- SignaVis Lite: no browser wording for the default project.
- Faster label rendering (keyed updates) and a restructured labeling app
  (label store, commands, feature modules).
- `onnxruntime-web` 1.31.1.

### Fixed
- Taxonomy 404 on GitHub Pages; two wrong Xeno-canto names in the taxonomy.
- Full-band labels are no longer band-filtered on playback.
- Waveform-track edits and Escape in the label editor.
- The BirdNET model picker no longer overlaps long model names.

## [1.2.0] - 2026-11-16

### Added
- `overviewMode: 'spectrogram'` (and `player.setOverviewMode()`): the overview
  strip shows the whole recording as a spectrogram, max-pooled so short calls
  stay visible; the waveform stands in while the spectrogram is computed.
  The labeling app offers the choice under Display → Overview.
- Recording start time from AudioMoth, GUANO, BWF `bext` and WAV INFO metadata
  or a date and time in the file name (adapted from the BirdNET website demo,
  MIT): shown in the status bar, `player.recordingStart`,
  `player.clockTimeAt(seconds)`, and Raven selection tables get
  Begin Date / Begin Clock Time / End Clock Time.
- Microphone recording: `player.startRecording()` / `stopRecording()` show a
  live spectrogram that flies in from the right while recording, then load
  the recording (a WAV with its start time in the INFO chunk). Events
  `recordingstart`, `recordingcomplete`, `recordingstop`. The labeling app
  adds "Record from microphone" under Add recordings.

### Changed
- npm package: much smaller. The library build is minified, the aw-dsp WASM
  ships once as `dist/aw_dsp_wasm_bg.wasm` (loaded on demand, next to the
  bundle; override with `globalThis.SIGNAVIS_WASM_URL`) instead of being
  inlined three times, and the BirdNET models are no longer part of the
  package.

### Removed
- The `signavis/models/birdnet-v2.4` export. Pass `BIRDNET_V24_MODEL_URL`
  (now exported, GitHub Pages) or a URL you host the model at to
  `BirdNETInference.load({ modelUrl })` instead.

## [1.1.3] - 2026-11-14

### Added
- Label confidence as a meter: lane strips fill their bottom edge, boxes get
  a mini bar next to the number, tinted from red (low) to green (high).
- Labeling app: BirdNET detections are drawn as lanes; a new
  "Automatic behaviour" settings section switches auto contrast, the
  frequency zoom fit, normalized playback, the ultrasound prompt, opening the
  label list after a BirdNET run and the confidence display.
- Desktop app: sound events without frequency range are shown as lanes with
  their confidence.

### Fixed
- Reading a label's name back (loupe window) no longer includes its confidence.

## [1.1.2] - 2026-11-14

### Added
- Label display `'lanes'`: labels without frequency bounds as stacked strips
  along the top of the spectrogram; the selected one shades its time span.
- `labelConfidence` option shows the confidence next to label names
  (`player_value(show_confidence=...)` in `signavis.gradio`).
- Toolbar items `'contrast'` (floor/range sliders and Auto Contrast),
  `'play'` and `'seek'` (split from `'transport'`).
- Download and decode progress while loading audio from a URL.
- `signavis.gradio`: `GRADIO_THEME_CSS` makes the player follow the Gradio
  theme; `player_value(select=..., play=False, select_id=...)` selects a
  detection without playing it.

### Fixed
- Gradio: the player follows Gradio's dark mode and spans the full width.
- A spectrogram resized taller fills its pane when the host sets no height.

## [1.1.1] - 2026-11-14

### Fixed
- Linux desktop bundles (SignaVis Lite AppImage/deb and the full desktop
  AppImage) are built on Ubuntu 22.04 again. The 1.1.0 bundles were built on
  Ubuntu 26 and failed to start on older systems (`GLIBC_2.43 not found`).
- `scripts/check-version-sync.sh` uses `python3` when `python` is missing.

## [1.1.0] - 2026-11-14

### Added
- **SignaVis Lite**: the labeling app as a lightweight desktop app for
  Windows, macOS and Linux (`src-tauri-lite/`). Native project folders and a
  default project on disk, local audio opened by path (reopens after a
  restart), exports through a save dialog, species images and the BirdNET
  model loaded on demand (optional offline download), native menu with
  Open Recent, remembered window state, close guard.
- `signavis://open?xc=…&lang=…` deep links, single instance and
  "Open with" for audio files.
- Web app: "Open in app" hands the current recording over to SignaVis Lite,
  with an opt-in to always open links in the app.
- Self-update for SignaVis Lite over GitHub Releases; Lite installers and
  `latest.json` are attached to releases (installers are unsigned, see
  `docs/signavis-lite.md`).
- Microsoft Store (MSIX) package, privacy policy and Store screenshots.

### Fixed
- Xeno-canto recording search uses API v3 (v2 was retired and returned 404).

## [1.0.5] - 2026-11-05

### Fixed
- Show the visible spectrogram sooner for long recordings while building the full pyramid in the background.
- Reduce peak memory used by spectrogram workers and cache maintenance.
- Cap preview tile requests when zoomed out.
- Sample preview contrast statistics across the whole recording.

### Changed
- `scripts/release.sh` also refuses to release when `main` is behind `origin/main`.

## [1.0.4] - 2026-11-05

### Added
- `signavis.gradio.SignaVisPlayer`: the player as a native Gradio 6
  component (`gr.HTML` subclass). Assets, including WaveSurfer, are served
  from the Python package, so it works offline; audio is streamed by URL
  instead of being base64-inlined. Detections are drawn as read-only labels
  and a `select` value scrolls to and plays a span. Built for the
  BirdNET-Analyzer GUI.
- Player options `toolbar` (keep only the listed controls), `labelDisplay: 'focus'`
  (draw only the hovered/selected label on the spectrogram) and `labelTable` /
  `labelTableColumns` (built-in sortable label table). `SignaVisPlayer` uses
  them by default for a compact detection viewer.
- Embedded players (Gradio) load a stylesheet scoped to the player root, so
  host page styles and the player no longer affect each other.
- XC sets record the exact build in `annotation_software_name_and_version`
  (`SignaVis 1.0.4`, or `SignaVis 1.0.4+<commit>` for unreleased builds).

### Changed
- Release tooling: `scripts/release.sh` refuses to tag off `main`, with a dirty
  tree or without a CHANGELOG section, and runs typecheck and tests first.
- The Python package is now dual-licensed: MIT or AGPL-3.0, at your choice.

## [1.0.3] - 2026-11-04

### Changed
- Slimmed down README.md: moved the Player Options table and framework
  integration examples to the docs site (docs/usage/), consolidated the
  release workflow into DEVELOPER.md, and added a dedicated
  CONTRIBUTING.md.

### Added
- CITATION.cff so GitHub shows a "Cite this repository" button; added a
  Citation section with a Zenodo DOI badge to README.md.
- Citation info (CITATION.cff link, DOI badge, BibTeX) in the labeling
  app's "?" help menu (About panel).

## [1.0.2] - 2026-11-02


### Added
- Open Graph / Twitter preview image (1200x630) for shared links to the
  labeling app and the GitHub Pages start page.

## [1.0.1] - 2026-11-02

### Added
- Privacy policy in the "?" help menu of the labeling app (hosting, local
  processing, analytics, third-party services, GDPR rights).
- Cookieless, self-hosted Umami analytics for the web version (respects
  "Do Not Track"; not loaded in the desktop app).
- SEO: page description, canonical URL, Open Graph / Twitter tags and
  schema.org metadata; improved GitHub Pages start page, sitemap.xml,
  robots.txt and Google Search Console verification.

## [1.0.0] - 2026-11-02

First stable release. The static labeling app (GitHub Pages) and the `signavis`
npm / PyPI packages are considered production-ready; the Tauri desktop app is
still a preview.

### Highlights
- **New spectrogram engine** — all spectrograms are computed in Rust (`aw_dsp`,
  WebAssembly in the browser) and rendered on the GPU straight from dB data,
  including PCEN, magnitude and phase. Tiled pyramid for long recordings; the
  old JS DSP engine and the v1 engine are gone.
- **Labeling workflow for Xeno-canto** — labels are uploaded as Annota-JSON
  sets: upload assistant with a live checklist, label metadata from the XC
  value lists, recording context and map, selectable live / test server,
  import of XC "Download set" files, uploads kept as snapshots.
- **Project folders** — projects live in the browser (OPFS) or in a local
  folder via the File System Access API (`signavis-project/1` format), with a
  persistent XC audio cache and Raven export.
- **Unified explorer** — local files and Xeno-canto recordings in one folder
  tree; own labels in layers, imported sets shown as read-only layers that can
  be copied to your own labels.
- **Label table** — below the overview a "Tracks | Table" tab strip switches
  to a Raven-like table of all labels (own, BirdNET, XC): source filters,
  text filter, "In view", follow playhead, sortable and resizable columns,
  spreadsheet-style inline editing (multi-row edits, live box updates) and
  export of the shown rows as CSV, Raven, Audacity, Sonic Visualiser or JSON.
- **Full Annota field support** — remarks, animal seen, playback used, overlap,
  collection date / specimen and temperature are editable per label (table,
  properties panel), imported from XC and uploaded; yes/no fields are
  checkboxes with a reset to "not specified"; the computed SNR of each box is stored
  and uploaded as `signal_noise_ratio`.
- **Snap to call** — box a call from a single click.
- **Zoom box and edit loupe** — drag a field to zoom time and frequency onto
  it; a magnified view (with its own fine STFT) follows the cursor while moving
  or resizing labels; Shift for fine 1/4-speed dragging.
- **Reference calls** — dockable side-by-side comparison with XC references on
  the same time scale, filter chips, pinned references, GBIF species info.
- **Bat recordings** — time expansion, heterodyne (carrier tunable on the
  spectrogram), frequency division and real-time pitch shift; bat recordings
  are detected on load and a popup offers the modes with a preview.
- **Labels tab** — source → species → label tree with playback per segment.

### Added
- Spectrogram presets with *Classic* as default plus a spectrolipi preset;
  colour schemes W/B (inverse) and SpectroFlare; auto contrast from the visible
  spectrogram; auto vertical zoom to the active frequency band on load.
- Zoom widget with separate time / frequency halves, visible span and an Auto
  button; maximum zoom raised from 450 to 2000 px/s.
- Expert mode in the display panel hides advanced spectrogram settings.
- Smooth playhead follow with look-ahead; de-jittered playback position.
- Long MP3 recordings load via chunked decoding.
- Recording quality shown as an A–E traffic light; mini map in Properties.
- Time axis shows m:ss / h:mm:ss from one minute on.
- In-app dialogs replace browser `alert` / `confirm` / `prompt`.
- `tools/demo-gifs/` — scripted Playwright recordings of the demo GIFs.

### Changed
- Left sidebar reorganised into Project · Labels · Analysis · Upload; neutral
  surfaces, button tiers and clearer section headers throughout.
- Xeno-canto ids are always stored with prefix (`XC123`).
- BirdNET detections can no longer be uploaded to Xeno-canto, only own labels.
- Licence is sent with version (CC-BY-NC-SA-4.0).
- npm package no longer ships `docs/img/`; demo GIFs are attached to the
  GitHub release instead. `@tauri-apps/plugin-dialog` is now a dev dependency.
- Release notes are taken from this changelog.

### Fixed
- Scrolling, zooming and overview dragging stay at frame rate (channel-data
  cache, no per-frame `getChannelData`).
- Time-expanded segment playback no longer ends early.
- Stale view and overview window after container resize.
- Spectrogram coordinate mapping offset by the scrollbar height.
- Waveform label dragging no longer stops when the cursor leaves the area.
- Desktop: local recordings load through the asset protocol.

## [0.7.6] - 2026-05-11

### Added
- SNR computation in the Properties panel.
- Tauri 2 desktop app with installers (AppImage, MSI, DMG) built in CI;
  optional local gRPC analysis backend with HTTP passthrough (preview).
- Multi-user platform scaffold (auth/RBAC, jobs API, worker queue) for
  testing (preview).

### Changed
- Rebranded from Audio-Workbench to **SignaVis**.
- Demo libraries migrated from `demo/lib/*.js` to TypeScript in `src/`;
  PlayerState split into dedicated controllers.

### Fixed
- Release and version-sync scripts cover the Tauri files.

## [0.6.0] - 2026-04-27

### Added
- Reference view and initial tiling support.
- MkDocs documentation site.

### Changed
- Types are generated from TypeScript; tests run with Node's strip-types.

### Fixed
- Bulk rename applies tags to all selected labels; properties panel refreshes
  after inline edits.

## [0.5.0] - 2026-04-20

### Added
- IndexedDB-backed spectrogram cache.
- Read-only / AI annotations, annotator profile, recording manager and explorer.
- Geo map modal; BirdNET area-model infobox; context menu.
- Demo footer with deployed version.

### Fixed
- Duplicate XC annotations on save and export.
- Session set id restored on reload.

## [0.4.0] - 2026-04-17

### Added
- Multi-select bulk actions for labels with spectrogram selection sync.
- ModalManager and daily tips.
- Accordion label list.

### Changed
- AudioEngine introduced; PlayerState migrated to it.
- npm publishing via OIDC trusted publishing.

## [0.3.0] - 2026-04-09

### Added
- **Vertical frequency zoom** — Shift+Wheel on spectrogram, dedicated V-slider,
  draggable frequency scrollbar, left-drag on freq axis for panning.
- **Suggestion labels** — BirdNET detections rendered with diagonal-stripe
  "construction fence" border; accept (✓) promotes to manual, discard (✕) removes.
- **Xeno-canto loading UX** — no-key modal with inline key input, topbar API key
  indicator, auto re-import on key change, URL sync.
- **Right sidebar** — collapsible spectrogram settings panel and properties panel
  (pin or hover for label detail inspection with inline editing).
- **Overview label tracks** — grouped by origin with color-coded bars.
- **Label sidebar** — hierarchical grouping by origin → species with sticky headers,
  inline editing, tag badges, confidence scores.
- **Annotation action toolbar** — draw-mode toggle, copy/paste, undo/redo buttons.
- **Language selector** moved to top bar for quick taxonomy language switching.
- **Toolbar wrapping** — toolbar now wraps to two rows instead of hiding controls
  behind a "More" button.

### Fixed
- **Label positions on window resize / monitor change** — spectrogram now redraws
  in the resize handler, keeping CoordinateSystem and annotation overlay in sync.
- **Label horizontal jitter on zoom slider** — `zoomchange` event deferred until
  canvas dimensions and coords are actually updated.
- **Middle-mouse vertical drag inversion** — corrected sign in `_updateViewportPan()`.
- **Freq axis left-drag** — new vertical panning when already vertically zoomed.

### Changed
- Time axis zoom capped at 450 px/s (was 600) for better performance.
- Preset manager redesigned from modal to inline panel.
- Generic tags system for label metadata.
- Lucide icons throughout the UI.

## [0.2.0] - 2026-03-25

### Added
- **CoordinateSystem** — single source of truth for all time↔pixel, frequency↔pixel,
  frequency↔bin, frame and client→canvas coordinate mappings (`src/coordinateSystem.js`).
- **Crosshair overlay** with toggleable time/frequency/amplitude readout on the spectrogram.
- **Non-blocking recomputing overlay** shown during spectrogram recalculation.
- **`computeTime` event** emitted after the DSP pipeline completes, reporting duration.
- **Event filter panel** in Storybook event monitor (toggleable per event type).
- **Subtle pause icon on hover** in compact/hero transport overlay while playing.
- **Extensibility API** — window functions, DSP profiles, overlap zones, toolbar groups.
- **Slide-out settings panel** replacing the old toolbar settings groups.
- **Presets + direct DSP parameters** replacing the former Mode dropdown; PCEN is now
  independently toggleable.
- **Label drag uses pixel-space deltas** for perceptually linear feel on mel scale.
- **InteractionState FSM** (`src/interactionState.js`) replacing scattered interaction flags.
- **TypeScript `checkJs`** — zero errors across all source files.
- **Dependabot** for automated dependency updates.
- **GitHub Pages CI** for demo deployment.
- **110 tests** (up from 25) — coordinate-system (44), spectrogram pipeline (20),
  transport/player state, DSP, and more.

### Fixed
- **Playhead position in waveform-only hero mode** — `_updatePlayhead()` used
  `spectrogramCanvas.width` (default 300 px) instead of `coords.timeToScrollX()`.
- **Stale CoordinateSystem after zoom** — `_updateCoords()` now called when
  `pixelsPerSecond` changes.
- **All scroll↔time math** routed through `CoordinateSystem` (5 inline calculations removed).
- **Click-to-seek in hero/transport-overlay** now uses `scrollWidth` and auto-fit-view.
- **Auto-fit-on-ready removed** in transport-overlay — restores scrolling in compact views.
- **Mel filterbank power-normalisation** (rows sum to 1) and PCEN epsilon set to 1 × 10⁻¹⁰.
- **`detectMaxFrequency`** uses 95th-percentile energy; dynamic worker timeout.
- **Spectrogram shadow artifacts** in `buildSpectrogramGrayscale` eliminated.
- **Mel-aware frequency↔pixel mapping** for frequency labels, annotation boxes and axis.
- **Crosshair coordinate mapping** corrected for overlay, readout and mel bins.
- **Three spectrogram math bugs** fixed; PCEN constant hoisted.
- **Native sample rate preserved** with dynamic max-frequency options.

### Changed
- `_clientXToTime()` delegates to `coords.scrollXToTime()` — DOM-independent and testable.
- `spectrogramMode` removed — Perch / Classic are pure presets only.
- Deprecated `ui.js` and legacy `buildSpectrogramBaseImage` wrapper removed.
- README rewritten in English, converted to AsciiDoc with TOC and feature list.
- Storybook redesigned with global file loading.
- Vite updated from 7.3.1 to 8.0.2; `actions/checkout` 4→6, `actions/setup-node` 4→6,
  `actions/setup-python` 5→6.
- Build artifacts removed from version control.

## [0.1.0] - 2026-02-19

### Added
- **External spectrogram injection API** — two new modes:
  - `setSpectrogramData(data, nFrames, nMels, opts)` — inject raw Float32 spectrogram
    data (or base64-encoded). The player applies its own colorization pipeline.
  - `setSpectrogramImage(image, opts)` — inject a pre-rendered spectrogram image
    (data-URL, URL, HTMLImageElement, or HTMLCanvasElement). Bypasses all DSP.
  - `clearExternalSpectrogram()` — re-enables auto-compute from audio.
- **Python wrapper: `spectrogram_data` / `spectrogram_image` params** on
  `render_daw_player()` — pass pre-computed spectrograms from Python directly.
- **Python `_coerce_image_to_png_bytes()`** — accepts `matplotlib.figure.Figure`,
  `PIL.Image.Image`, `numpy.ndarray` (uint8), `io.BytesIO`, and raw `bytes`.
  Drop-in replacement for BirdNET-Analyzer's matplotlib spectrogram displays.
- **Python wrapper unit tests** (`python-wrapper/tests/test_renderer.py`).

### Fixed
- `detectMaxFrequency()` now correctly uses linear bin→Hz mapping in Classic
  mode (was using Mel mapping, yielding wrong frequencies).
- Mel filterbank now receives power spectrum (mag²) instead of magnitude,
  matching PCEN's expectation.
- FFT twiddle factors (cos/sin) are precomputed and cached per FFT size,
  reducing repeated trigonometric calls.
- Progressive PCEN smooth-state accumulator is now carried across chunk
  boundaries, eliminating discontinuity artifacts.

## [0.0.9] - 2026-02-19

### Added
- **Classic spectrogram mode** (XC-style): Linear frequency axis, power→dB scaling,
  Xeno-Canto warm-body color palette. Selectable via Mode dropdown.
- **Vite build system**: Library mode producing ESM + IIFE + CSS with sourcemaps.
  IIFE build has Web Worker inlined; ESM references separate worker file.
- **`src/dsp.js`**: Single source of truth for all DSP functions (FFT, Mel scale,
  filterbank, `computeSpectrogram`). Replaces 3× duplicated code.
- **`src/spectrogram.worker.js`**: Proper module worker importing from `dsp.js`.
- **24 new tests** (25 total): DSP functions, spectrogram utilities, transport state.
- **Vite dev mode**: `npm run dev` with HMR, root `index.html` for ESM development.
- **`REFACTORING.md`**: Architecture documentation and future decomposition plan.

### Changed
- CSS scoped to `.daw-shell *` — no more global `*{}` or `body{}` resets that
  break host pages.
- All template `id="..."` replaced with `data-aw="..."` data attributes —
  multiple player instances on the same page no longer conflict.
- CSS `#id` selectors replaced with `[data-aw]` attribute selectors.
- `spectrogram.js` reduced from 1177 to ~760 lines (DSP code + cache removed).
- `_generateSpectrogram()` always computes fresh — no stale cached data.
- Bundle size reduced: ESM 200 KB, IIFE 216 KB (down from 223 KB).

### Removed
- **IndexedDB spectrogram cache**: Removed all cache logic (`openSpectrogramCacheDb`,
  `getSpectrogramCacheEntry`, `putSpectrogramCacheEntry`, `buildSpectrogramCacheKey`,
  `sha256ArrayBuffer`). Was causing stale/incorrect spectrograms.

## [0.0.1] - 2026-02-18
- Initial standalone packaging of SignaVis Player library.
- Added npm package metadata and exports for ESM, IIFE, and CSS.
- Added TypeScript definitions in `types/index.d.ts`.
- Added interactive demo in `demo/index.html`.
- Added Python wrapper skeleton for Streamlit/HTML embedding.
- Added CI workflow and publish helper scripts.
