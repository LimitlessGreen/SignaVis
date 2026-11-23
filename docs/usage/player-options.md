# Player Options

`BirdNETPlayer` accepts an options object as the second constructor argument, e.g.
`new BirdNETPlayer(el, { viewMode: 'spectrogram' })`.

| Option | Type | Default | Description |
|---|---|---|---|
| `viewMode` | string | `'both'` | `'both'`, `'waveform'`, `'spectrogram'` — visible analysis views |
| `transportStyle` | string | `'default'` | `'default'`, `'hero'` — transport button style |
| `transportOverlay` | boolean | `false` | Centered play overlay, no toolbar height |
| `showFileOpen` | boolean | `true` | Show Open button and file input |
| `showTransport` | boolean | `true` | Show transport controls (play/pause/stop) |
| `showTime` | boolean | `true` | Show time display |
| `showVolume` | boolean | `true` | Show volume controls |
| `showViewToggles` | boolean | `true` | Show Follow/Loop/Fit/Reset buttons |
| `showZoom` | boolean | `true` | Show zoom slider |
| `showFFTControls` | boolean | `true` | Show FFT size, max frequency, color scheme |
| `showDisplayGain` | boolean | `true` | Show floor/ceiling sliders, auto contrast |
| `showStatusbar` | boolean | `true` | Show bottom status bar |
| `showOverview` | boolean | `true` | Show overview navigator |
| `overviewMode` | string | `'waveform'` | `'waveform'` or `'spectrogram'` — the whole recording as a max-pooled spectrogram (short calls stay visible); switch at runtime with `player.setOverviewMode(mode)` |
| `showWaveformTimeline` | boolean | `true` | Show bottom timeline in waveform view |
| `compactToolbar` | string | `'auto'` | `'auto'`, `'on'`, `'off'` — responsive toolbar compaction |
| `labelTaxonomy` | array | see docs | Custom label presets (name, color, shortcut) |
| `spectrogramCacheMaxBytes` | number | `1073741824` | Target size for the on-disk (OPFS) spectrogram cache of long recordings, all recordings together. Checked whenever a recording is opened: least recently used stores are removed first. Not a hard cap: the store of the open recording stays even if it alone is larger, and stores another page has open cannot be removed. `0` keeps the spectrogram in memory only and removes existing stores |
| ... | ... | ... | ... |

See [Integration examples](integration.md) for usage in different frameworks.
