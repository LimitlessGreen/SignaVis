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

| Name | Hex |
|---|---|
| Night blue (ground) | `#102A35` |
| Call amber (contour, accent) | `#F2B544` |
| Paper (selection corners) | `#F3F5F2` |

## Regenerating icons

```sh
node scripts/brand-icons.mjs
```

Writes `src-tauri/icons/`, `src-tauri-lite/icons/` (desktop, MSIX, Android, iOS),
`demo/favicon.svg` and `site/public/favicon.svg`. Sizes up to 44 px and the 16/24/32 px
entries of `icon.ico` come from the small mark. Needs ImageMagick (`convert`) for the `.ico`.
