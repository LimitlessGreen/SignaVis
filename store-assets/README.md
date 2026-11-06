# Microsoft Store assets (SignaVis Lite / "SignAvis Lite")

`screenshots/` — 1920×1080 PNGs for the Store listing, made with

```sh
cd src-tauri-lite && npx tauri build --no-bundle --features store && cd ..
node scripts/lite-store-screenshots.mjs            # → store-assets/screenshots/
node scripts/lite-store-screenshots.mjs --only=02-birdnet --size=2560x1440
```

The app runs with a throw-away profile (`SIGNAVIS_LITE_DATA_DIR`), so your own projects are not touched;
the Xeno-canto key comes from `XC_API_KEY` or `~/.signavis-xc-key`. Scenes: `scripts/lite-store-scenes.mjs`.
Close a running SignaVis Lite first (single instance: a second start would hand over and exit).

Package: `node scripts/lite-msix.mjs <signavis-lite.exe>` (see `src-tauri-lite/msix/`).
Privacy policy: `docs/signavis-lite-privacy.md`.
