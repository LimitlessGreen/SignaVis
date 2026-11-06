# SignaVis Lite

SignaVis Lite is the [labeling app](https://limitlessgreen.github.io/SignaVis/demo/labeling-app.html) as a small desktop program for Windows, macOS and Linux:

- projects live in real folders, your own audio files reopen after a restart,
- works offline (the BirdNET model can be stored via *File › Download BirdNET Model for Offline Use*),
- `signavis://` links and *Open with › SignaVis Lite* for audio files,
- updates itself (*Help › Check for Updates…*, and a quiet check once a day).

## Download

Get the installer for your system from the [latest release](https://github.com/LimitlessGreen/SignaVis/releases/latest):

| System | File |
|---|---|
| Windows 10/11 (64-bit) | `SignaVis-Lite_<version>_x64-setup.exe` (or the `.msi`) |
| macOS (Apple silicon) | `SignaVis-Lite_<version>_aarch64.dmg` |
| Linux (x86-64) | `SignaVis-Lite_<version>_amd64.AppImage` (or the `.deb`) |

## The installers are not code-signed (yet)

Your system will warn about an "unknown publisher". The app is the same open-source code as on GitHub; the files are built by GitHub Actions from the tagged commit. Updates are verified with SignaVis' own update key, independent of OS signing.

**Windows** — SmartScreen says *"Windows protected your PC"*: click **More info → Run anyway**.

**macOS** — *"SignaVis Lite cannot be opened because the developer cannot be verified"*:
open the DMG, drag the app to *Applications*, then **right-click (Ctrl-click) the app → Open → Open**.
Only needed the first time. On macOS 15+ you may have to allow it under
*System Settings › Privacy & Security › "Open Anyway"*.

**Linux** — make the AppImage executable (`chmod +x SignaVis-Lite_*.AppImage`) and start it.
Self-update works for the AppImage; the `.deb` is updated by installing the new `.deb`.

## Opening web links in the app

In the web app, the 🖥 button *Open in SignaVis Lite* hands the current Xeno-canto recording over to the app.
Tick *Always open SignaVis links in the app on this computer* to be forwarded automatically; add `?browser=1` to a link to stay in the browser.
