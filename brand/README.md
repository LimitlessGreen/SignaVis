# SignaVis brand mark

An S-shaped call contour (frequency modulation as seen in a spectrogram) inside four
selection corners: a signal that a person selects and confirms.

| File | Use |
|---|---|
| `signavis-mark.svg` | Main mark, 48 px and up (app icons, website, README) |
| `signavis-mark-small.svg` | Simplified mark with thicker strokes for 16–44 px (favicons, taskbar, small tiles) |
| `signavis-mark-fg.svg`, `signavis-mark-bg.svg` | Android adaptive icon foreground / background |
| `signavis-mark-mono.svg` | Single colour (Android themed icon, print, stamps) |
| `icon-manifest.json` | Input for `tauri icon` |

## Colours

The mark shows the roles: the night-blue ground and selection corners are the
interface, the amber contour is the signal.

| Role | Hex | Use |
|---|---|---|
| Operating colour (blue) | `#38BDF8` dark theme, `#0284C7` light theme | buttons, selection, waveform, links (`--color-accent`) |
| Signal colour (call amber) | `#F2B544` | the contour in the mark; optional accent theme in the app (dark theme only, amber turns brown on white) |
| Night blue | `#102A35` | ground of the mark, tint of the website neutrals |
| Paper | `#F3F5F2` | selection corners in the mark |

The website derives its Material 3 colours from these (`site/scripts/m3-tokens.mjs`):
primary blue, secondary and neutrals night blue, tertiary amber.

## Regenerating icons

```sh
node scripts/brand-icons.mjs
```

Writes `src-tauri/icons/`, `src-tauri-lite/icons/` (desktop, MSIX, Android, iOS),
`demo/favicon.svg` and `site/public/favicon.svg`. Sizes up to 44 px and the 16/24/32 px
entries of `icon.ico` come from the small mark. Needs ImageMagick (`convert`) for the `.ico`.
