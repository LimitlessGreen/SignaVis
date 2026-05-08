/**
 * anywidget ESM module for SignaVis.
 *
 * Communicates with the Python AudioWorkbenchWidget via the anywidget
 * model.get / model.set / model.on / model.send protocol.
 *
 * Trait sync (model ↔ Python):
 *   annotations, spectrogram_labels, current_time, duration, playing
 *
 * Custom messages (model.send / model.on("msg:custom")):
 *   Python → JS:  { type: "call", method, args }
 *   JS → Python:  { type: "event", event, detail }
 *
 * The IIFE bundle is prepended to this file by Python at import time,
 * so BirdNETPlayerModule is available as a module-scoped variable — no
 * eval() or script injection needed (works under strict CSP / Colab).
 */

function _ensureWaveSurfer() {
  return new Promise((resolve, reject) => {
    if (window.WaveSurfer) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/wavesurfer@7";
    script.onload = resolve;
    script.onerror = () =>
      reject(new Error("Failed to load WaveSurfer.js from CDN"));
    document.head.appendChild(script);
  });
}

/**
 * Decode base64 audio string to Uint8Array.
 */
function _decodeBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Serialize annotation regions to plain objects for Python sync.
 */
function _serializeAnnotations(player) {
  // player.annotations is the AnnotationLayer — it exposes .regions
  const layer = player.annotations;
  if (!layer || !layer.regions) return [];
  return layer.regions.map((r) => ({
    id: r.id,
    start: r.start,
    end: r.end,
    species: r.content?.textContent || r.species || "",
    color: r.color || "",
  }));
}

/**
 * Serialize spectrogram labels to plain objects for Python sync.
 */
function _serializeSpectrogramLabels(player) {
  const layer = player.spectrogramLabels;
  if (!layer || !layer.labels) return [];
  return layer.labels.map((l) => ({
    id: l.id,
    start: l.start,
    end: l.end,
    freqMin: l.freqMin,
    freqMax: l.freqMax,
    label: l.label || l.species || "",
    color: l.color || "",
  }));
}

/**
 * Push current player state to model traits.
 */
function _syncToModel(player, model) {
  model.set("annotations", _serializeAnnotations(player));
  model.set("spectrogram_labels", _serializeSpectrogramLabels(player));
  model.set("current_time", player.currentTime || 0);
  model.set("duration", player.duration || 0);
  model.save_changes();
}

// ── anywidget lifecycle ──────────────────────────────────────────────

export async function initialize({ model }) {
  // Load WaveSurfer from CDN (once)
  await _ensureWaveSurfer();
}

export async function render({ model, el }) {
  // ── DOM setup ──
  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";
  el.appendChild(container);

  // Inject CSS
  const style = document.createElement("style");
  style.textContent = model.get("_player_css");
  el.appendChild(style);

  // ── Player options ──
  const playerOpts = JSON.parse(model.get("_player_options") || "{}");

  // ── Create player (BirdNETPlayerModule is module-scoped, prepended by Python) ──
  const BirdNETPlayer = BirdNETPlayerModule?.BirdNETPlayer;
  if (!BirdNETPlayer) {
    el.innerHTML =
      '<pre style="padding:12px;color:#b91c1c">BirdNETPlayer failed to load</pre>';
    return;
  }

  const player = new BirdNETPlayer(container, playerOpts);
  await player.ready;

  // ── Load audio ──
  const audioB64 = model.get("_audio_b64");
  if (audioB64) {
    const audioBytes = _decodeBase64(audioB64);
    const file = new File([audioBytes], "audio.wav", { type: "audio/wav" });
    await player.loadFile(file);
  }

  // ── Inject spectrogram (if provided) ──
  const spectB64 = model.get("_spectrogram_b64");
  const spectMeta = model.get("_spectrogram_meta");
  if (spectB64 && spectMeta) {
    const meta = JSON.parse(spectMeta);
    if (meta.type === "data") {
      const specBin = atob(spectB64);
      const specBytes = new Uint8Array(specBin.length);
      for (let i = 0; i < specBin.length; i++)
        specBytes[i] = specBin.charCodeAt(i);
      await player.setSpectrogramData(
        new Float32Array(specBytes.buffer),
        meta.n_frames,
        meta.n_mels,
        { mode: meta.mode || "perch", sampleRate: meta.sample_rate || 16000 }
      );
    } else if (meta.type === "image") {
      const imgSrc = meta.is_url
        ? spectB64
        : "data:image/png;base64," + spectB64;
      await player.setSpectrogramImage(imgSrc, {
        sampleRate: meta.sample_rate || undefined,
      });
    }
  }

  // ── Initial sync ──
  model.set("duration", player.duration || 0);
  model.set("playing", false);
  _syncToModel(player, model);

  // ── JS → Python: forward player events ──
  const SYNC_EVENTS = [
    "annotationcreate",
    "annotationupdate",
    "spectrogramlabelcreate",
    "spectrogramlabelupdate",
  ];

  for (const evt of SYNC_EVENTS) {
    player.on(evt, (detail) => {
      _syncToModel(player, model);
      model.send({ type: "event", event: evt, detail: detail || {} });
    });
  }

  player.on("timeupdate", (detail) => {
    model.set("current_time", detail?.currentTime ?? player.currentTime ?? 0);
    model.set("duration", detail?.duration ?? player.duration ?? 0);
    model.save_changes();
  });

  player.on("transportstatechange", (detail) => {
    const state = detail?.state || "";
    model.set("playing", state === "playing");
    model.save_changes();
    model.send({
      type: "event",
      event: "transportstatechange",
      detail: { state },
    });
  });

  // ── Python → JS: handle custom messages ──
  model.on("msg:custom", (msg) => {
    if (msg.type === "call" && typeof player[msg.method] === "function") {
      const args = msg.args || [];
      const result = player[msg.method](...args);
      // If it returns a promise, sync after resolution
      if (result && typeof result.then === "function") {
        result.then(() => _syncToModel(player, model));
      } else {
        _syncToModel(player, model);
      }
    } else if (msg.type === "sync") {
      _syncToModel(player, model);
    }
  });

  // ── Python → JS: react to trait changes ──
  model.on("change:_annotations_in", () => {
    const annots = model.get("_annotations_in");
    if (annots && Array.isArray(annots)) {
      player.setAnnotations(annots);
      _syncToModel(player, model);
    }
  });

  model.on("change:_spectrogram_labels_in", () => {
    const labels = model.get("_spectrogram_labels_in");
    if (labels && Array.isArray(labels)) {
      player.setSpectrogramLabels(labels);
      _syncToModel(player, model);
    }
  });

  // ── Cleanup ──
  return () => {
    player.destroy();
  };
}
