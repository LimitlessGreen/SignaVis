---
title: Future Plans
---

## Important
- [ ] **Find a proper name for the app** (Audio Workbench is a working title)

## UI

- [ ] Improve Help UI (especially shortcuts)
- [ ] Visually emphasise sets and their hierarchy (SCSS / UX)
- [ ] Replace compact inline edit with highlighting of `Properties` tab (visual affordance)
- [x] Show language selector in the top bar
- [x] Accept editable/persistent dropdown options (Song Type, etc.)
- [x] Provide preset Labeling App settings (optional)

## Labeling & Taxonomy

- [ ] Import / create custom species lists
- [x] Move with axis lock & bounds (x/y)
- [ ] Autoshrink: adapt labels to call when moving (resize automatically)
- [x] Split attributes into groups (e.g. "Xeno Canto Labels" / "Manual Labels")
- [ ] Better synchronise and unify multiple suggestion sources
- [x] Group BirdNET labels under a default "BirdNET" set
- [x] Support annotation sets spanning multiple recordings
- [x] Drag & drop to reassign labels between species inside a set
- [x] Context menu for annotation sets (duplicate, delete, rename)

## Editing & Interaction

- [x] Undo/Redo (implemented)
- [ ] Select and show targets on the map

## Export & Persistence

- [ ] Export / import annotations (JSON, Raven, etc.)
- [ ] Persist current state so reload preserves session
- [x] Persist labeler metadata in Xeno‑Canto tab (author, licence, ...)

## Features & Analysis

- [ ] Implement similarity detector / suggestion system


## Distribution / Standalone

- [ ] Provide a standalone app build
- [ ] In standalone: allow marking audio files/folders for batch analysis

## UX / Misc

- [ ] Show download progress when audio files are downloaded
- [ ] Support very long recordings (multi-hour) (maybe use static XC sonogram generation for long recordings)
- [ ] Clean up quickfixes and workarounds
- [ ] Validate single source of truth for state
- [ ] Save labels immediately on modification (not only on leaving a recording)
