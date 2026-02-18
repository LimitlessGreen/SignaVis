// src/template.js
var DEFAULT_OPTIONS = {
  showFileOpen: true,
  // Open-button + file input
  showTransport: true,
  // Play/Pause/Stop/Skip
  showTime: true,
  // Time display
  showVolume: true,
  // Volume slider + mute
  showViewToggles: true,
  // Follow / Loop / Fit / Reset
  showZoom: true,
  // Zoom slider
  showFFTControls: true,
  // FFT size, Freq, AF, Color
  showDisplayGain: true,
  // Floor / Ceil / AC sliders
  showStatusbar: true,
  // Bottom status bar
  showOverview: true,
  // Bottom overview navigator
  viewMode: "both",
  // both | waveform | spectrogram
  transportStyle: "default",
  // default | hero
  transportOverlay: false,
  // Overlay mode: centered play button without toolbar height
  showWaveformTimeline: true,
  // Draw bottom timeline row in waveform view
  compactToolbar: "auto",
  // auto | on | off
  followGuardLeftRatio: 0.35,
  // Follow mode lower guard (0..1)
  followGuardRightRatio: 0.65,
  // Follow mode upper guard (0..1)
  followTargetRatio: 0.5,
  // Viewport target position for catchup
  followCatchupDurationMs: 240,
  // Follow catchup animation duration
  followCatchupSeekDurationMs: 360,
  // Follow catchup duration after manual seek
  smoothLerp: 0.18,
  // Smooth mode interpolation factor
  smoothSeekLerp: 0.08,
  // Smooth mode interpolation after manual seek
  smoothMinStepRatio: 0.03,
  // Smooth mode minimum step ratio
  smoothSeekMinStepRatio: 8e-3,
  // Smooth mode minimum step ratio after seek
  smoothSeekFocusMs: 1400
  // Slow-follow focus window after manual seek
};
function createPlayerHTML(opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const hide = (flag) => flag ? "" : ' style="display:none"';
  const viewMode = ["both", "waveform", "spectrogram"].includes(o.viewMode) ? o.viewMode : "both";
  const transportStyle = o.transportStyle === "hero" ? "hero" : "default";
  const compactToolbar = ["auto", "on", "off"].includes(o.compactToolbar) ? o.compactToolbar : "auto";
  const shellClass = [
    "daw-shell",
    `view-mode-${viewMode}`,
    `transport-style-${transportStyle}`,
    `compact-toolbar-${compactToolbar}`,
    o.transportOverlay ? "transport-overlay" : ""
  ].join(" ");
  return `<div class="${shellClass}">

    <!-- \u2550\u2550\u2550 Top Toolbar \u2550\u2550\u2550 -->
    <div class="toolbar" id="toolbarRoot">
      <div class="toolbar-primary">
        <button class="toolbar-btn file-btn" id="openFileBtn" title="Audio-Datei laden"${hide(o.showFileOpen)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Open
        </button>
        <input type="file" id="audioFile" accept="audio/*" hidden>

        <div class="toolbar-sep"${hide(o.showFileOpen)}></div>

        <!-- Transport -->
        <div class="transport"${hide(o.showTransport)}>
            <button class="transport-btn" id="jumpStartBtn" disabled title="Zum Anfang (Home)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="3" height="14"/><polygon points="20 5 10 12 20 19"/></svg>
            </button>
            <button class="transport-btn" id="backwardBtn" disabled title="-5s (J)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 5 9 12 19 19"/><polygon points="12 5 2 12 12 19"/></svg>
            </button>
            <button class="transport-btn play-btn" id="playPauseBtn" disabled title="Play / Pause (Space)">
                <svg class="icon-play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21"/></svg>
            </button>
            <button class="transport-btn" id="stopBtn" disabled title="Stop">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            </button>
            <button class="transport-btn" id="forwardBtn" disabled title="+5s (L)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 5 15 12 5 19"/><polygon points="12 5 22 12 12 19"/></svg>
            </button>
            <button class="transport-btn" id="jumpEndBtn" disabled title="Zum Ende (End)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="4 5 14 12 4 19"/><rect x="18" y="5" width="3" height="14"/></svg>
            </button>
        </div>

        <!-- Time -->
        <div class="time-display" id="timeDisplay" role="status" aria-live="polite"${hide(o.showTime)}>
            <span id="currentTime">00:00.0</span><span class="time-sep">/</span><span id="totalTime">00:00.0</span>
        </div>
        <button class="toolbar-btn compact-more-btn" id="compactMoreBtn" aria-expanded="false" title="Weitere Controls anzeigen">More</button>
      </div>

      <div class="toolbar-secondary" id="toolbarSecondary">

        <div class="toolbar-sep"${hide(o.showVolume)}></div>

        <!-- Volume -->
        <button class="toolbar-btn icon-btn" id="volumeToggleBtn" title="Mute / Unmute"${hide(o.showVolume)}>
            <svg id="volumeIcon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path id="volumeWaves" d="M15 8.5a4 4 0 010 7M18 5a9 9 0 010 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
        </button>
        <input type="range" id="volumeSlider" class="toolbar-range toolbar-range-sm" min="0" max="100" value="80" title="Lautst\xE4rke"${hide(o.showVolume)}>

        <div class="toolbar-sep"${hide(o.showViewToggles)}></div>

        <!-- Toggle tools -->
        <span${hide(o.showViewToggles)}>
            <button class="toolbar-btn toggle-btn active" id="followToggleBtn" disabled title="Free / Follow / Smooth umschalten">Follow</button>
            <button class="toolbar-btn toggle-btn" id="loopToggleBtn" disabled title="Loop">Loop</button>
            <button class="toolbar-btn" id="fitViewBtn" disabled title="Fit to view">Fit</button>
            <button class="toolbar-btn" id="resetViewBtn" disabled title="Reset zoom">Reset</button>
        </span>

        <div class="toolbar-sep"${hide(o.showZoom)}></div>

        <!-- Zoom -->
        <span${hide(o.showZoom)}>
            <label class="toolbar-label" for="zoomSlider">Zoom</label>
            <input type="range" id="zoomSlider" class="toolbar-range" min="20" max="600" value="100" step="5">
            <span class="toolbar-value" id="zoomValue">100 px/s</span>
        </span>

        <div class="toolbar-sep"${hide(o.showFFTControls)}></div>

        <!-- Settings -->
        <span${hide(o.showFFTControls)}>
            <label class="toolbar-label" for="fftSize">FFT</label>
            <select id="fftSize" class="toolbar-select">
                <option value="1024">1024</option>
                <option value="2048" selected>2048</option>
                <option value="4096">4096</option>
            </select>

            <label class="toolbar-label" for="maxFreqSelect">Freq</label>
            <select id="maxFreqSelect" class="toolbar-select">
                <option value="4000">4k</option>
                <option value="6000">6k</option>
                <option value="8000">8k</option>
                <option value="10000" selected>10k</option>
                <option value="12000">12k</option>
                <option value="16000">16k</option>
            </select>
            <button class="toolbar-btn mini-btn" id="autoFreqBtn" disabled title="Frequenzbereich automatisch erkennen">AF</button>

            <label class="toolbar-label" for="colorSchemeSelect">Color</label>
            <select id="colorSchemeSelect" class="toolbar-select">
                <option value="fire" selected>Fire</option>
                <option value="grayscale">B/W</option>
                <option value="inferno">Inferno</option>
                <option value="viridis">Viridis</option>
                <option value="magma">Magma</option>
                <option value="plasma">Plasma</option>
            </select>
        </span>

        <div class="toolbar-sep"${hide(o.showDisplayGain)}></div>

        <!-- Display gain: SDR#-style floor / ceiling -->
        <span${hide(o.showDisplayGain)}>
            <label class="toolbar-label">Floor</label>
            <input type="range" id="floorSlider" class="toolbar-range toolbar-range-sm" min="0" max="100" value="0" title="Spectrogram Floor (Schwarzpunkt)">
            <label class="toolbar-label">Ceil</label>
            <input type="range" id="ceilSlider" class="toolbar-range toolbar-range-sm" min="0" max="100" value="100" title="Spectrogram Ceiling (Wei\xDFpunkt)">
            <button class="toolbar-btn mini-btn" id="autoContrastBtn" disabled title="Kontrast automatisch optimieren">AC</button>
        </span>
      </div>
    </div>

    <!-- \u2550\u2550\u2550 Main Content \u2550\u2550\u2550 -->
    <div class="views-panel">
        <!-- Waveform -->
        <div class="waveform-container" id="waveformContainer">
            <div class="time-aligned-row">
                <div class="axis-spacer">
                    <div class="amplitude-labels" id="amplitudeLabels"></div>
                </div>
                <div class="time-pane">
                    <div class="waveform-wrapper" id="waveformWrapper">
                        <div class="waveform-content" id="waveformContent">
                            <canvas id="amplitudeCanvas"></canvas>
                            <canvas id="waveformTimelineCanvas"></canvas>
                        </div>
                        <div class="playhead playhead-secondary" id="waveformPlayhead"></div>
                    </div>
                </div>
            </div>
            <div id="audioEngineHost" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;"></div>
        </div>

        <!-- Split handle -->
        <div class="view-split-handle" id="viewSplitHandle" title="Amplitude/Spektrogramm Verh\xE4ltnis anpassen"></div>

        <!-- Spectrogram -->
        <div class="spectrogram-container" id="spectrogramContainer">
            <div class="time-aligned-row">
                <div class="axis-spacer freq-axis-spacer">
                    <div class="frequency-labels" id="freqLabels"></div>
                </div>
                <div class="time-pane">
                    <div class="canvas-wrapper" id="canvasWrapper"
                         role="slider"
                         aria-label="Playback position"
                         aria-valuemin="0"
                         aria-valuemax="0"
                         aria-valuenow="0"
                         aria-valuetext="00:00.0 of 00:00.0"
                         tabindex="0">
                        <canvas id="spectrogramCanvas"></canvas>
                        <div class="playhead" id="playhead"></div>
                    </div>
                </div>
            </div>
            <div class="spectrogram-resize-handle" id="spectrogramResizeHandle" title="Spektrogramm-H\xF6he anpassen"></div>
        </div>

        <!-- Overview -->
        <div class="overview-container" id="overviewContainer"${hide(o.showOverview)}>
            <canvas id="overviewCanvas"></canvas>
            <div class="overview-window" id="overviewWindow">
                <div class="handle left" id="overviewHandleLeft"></div>
                <div class="handle right" id="overviewHandleRight"></div>
            </div>
        </div>
    </div>

    <!-- \u2550\u2550\u2550 Status Bar \u2550\u2550\u2550 -->
    <div class="statusbar"${hide(o.showStatusbar)}>
        <div class="statusbar-section" id="fileInfo">
            <span class="statusbar-label">No file</span>
        </div>
        <div class="statusbar-section">
            <span class="statusbar-label" id="sampleRateInfo"></span>
        </div>
        <div class="statusbar-spacer"></div>
        <div class="statusbar-section">
            <span id="viewRange"></span>
        </div>
        <div class="statusbar-section">
            <span id="playState">Idle</span>
        </div>
    </div>
</div>`;
}

// src/constants.js
var DEFAULT_ZOOM_PPS = 100;
var DEFAULT_WAVEFORM_HEIGHT = 100;
var DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT = DEFAULT_WAVEFORM_HEIGHT * 2;
var MIN_WAVEFORM_HEIGHT = 64;
var MIN_SPECTROGRAM_DISPLAY_HEIGHT = 140;
var SEEK_FINE_SEC = 0.5;
var SEEK_COARSE_SEC = 5;
var SPECTROGRAM_HEIGHT = 512;
var MAX_BASE_SPECTROGRAM_WIDTH = 24e3;
var MIN_WINDOW_NORM = 0.02;
var PROGRESSIVE_CHUNK_SECONDS = 10;
var PROGRESSIVE_MIN_DURATION_SEC = 60;
var PERCH_FRAME_RATE = 100;
var PERCH_N_MELS = 160;
var PERCH_PCEN_GAIN = 0.8;
var PERCH_PCEN_BIAS = 0.01;
var PERCH_PCEN_ROOT = 4;
var PERCH_PCEN_SMOOTHING = 0.025;

// src/utils.js
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(4, "0")}`;
}
function formatSecondsShort(seconds) {
  return `${seconds.toFixed(2)}s`;
}
function isTypingContext(target) {
  if (!target || !target.tagName) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}
function getTimeGridSteps(pixelsPerSecond) {
  const majorStep = pixelsPerSecond >= 320 ? 0.5 : pixelsPerSecond >= 180 ? 1 : pixelsPerSecond >= 90 ? 2 : pixelsPerSecond >= 45 ? 5 : 10;
  return { majorStep, minorStep: majorStep / 2 };
}

// src/gestures.js
function distance(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}
function midpoint(a, b) {
  return {
    x: (a.clientX + b.clientX) * 0.5,
    y: (a.clientY + b.clientY) * 0.5
  };
}
var GestureRecognizer = class {
  constructor(element) {
    this.element = element;
    this.handlers = /* @__PURE__ */ new Map();
    this.cleanups = [];
    this.lastTapTime = 0;
    this.lastTapX = 0;
    this.lastTapY = 0;
    this.touchMode = null;
    this.swipeStartX = 0;
    this.swipeStartY = 0;
    this.swipeLastX = 0;
    this.swipeLastY = 0;
    this.lastPinchDistance = 0;
    this.lastPinchCenter = null;
    this._bind();
  }
  on(event, callback) {
    const arr = this.handlers.get(event) || [];
    arr.push(callback);
    this.handlers.set(event, arr);
    return () => this.off(event, callback);
  }
  off(event, callback) {
    const arr = this.handlers.get(event);
    if (!arr) return;
    this.handlers.set(event, arr.filter((cb) => cb !== callback));
  }
  emit(event, detail) {
    const arr = this.handlers.get(event);
    if (!arr) return;
    for (const cb of arr) cb(detail);
  }
  dispose() {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.handlers.clear();
  }
  _bind() {
    const on = (name, fn, options = { passive: false }) => {
      this.element.addEventListener(name, fn, options);
      this.cleanups.push(() => this.element.removeEventListener(name, fn, options));
    };
    on("touchstart", (e) => this._onTouchStart(e));
    on("touchmove", (e) => this._onTouchMove(e));
    on("touchend", (e) => this._onTouchEnd(e));
    on("touchcancel", () => this._reset());
  }
  _onTouchStart(e) {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      this.touchMode = "swipe";
      this.swipeStartX = t.clientX;
      this.swipeStartY = t.clientY;
      this.swipeLastX = t.clientX;
      this.swipeLastY = t.clientY;
      return;
    }
    if (e.touches.length >= 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      this.touchMode = "pinch";
      this.lastPinchDistance = distance(a, b);
      this.lastPinchCenter = midpoint(a, b);
      e.preventDefault();
    }
  }
  _onTouchMove(e) {
    if (this.touchMode === "pinch" && e.touches.length >= 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      const d = Math.max(1, distance(a, b));
      const center = midpoint(a, b);
      const scale = d / Math.max(1, this.lastPinchDistance);
      this.lastPinchDistance = d;
      this.lastPinchCenter = center;
      this.emit("pinch", { scale, centerX: center.x, centerY: center.y });
      e.preventDefault();
      return;
    }
    if (this.touchMode === "swipe" && e.touches.length === 1) {
      this.swipeLastX = e.touches[0].clientX;
      this.swipeLastY = e.touches[0].clientY;
    }
  }
  _onTouchEnd(e) {
    if (this.touchMode === "pinch") {
      if (e.touches.length < 2) this._reset();
      return;
    }
    if (this.touchMode === "swipe" && e.touches.length === 0) {
      const dx = this.swipeLastX - this.swipeStartX;
      const dy = Math.abs(this.swipeLastY - this.swipeStartY);
      if (Math.abs(dx) > 24 && dy < 48) {
        this.emit("swipe", { dx });
      } else {
        const now = performance.now();
        const withinTime = now - this.lastTapTime < 280;
        const nearLast = Math.hypot(this.swipeStartX - this.lastTapX, this.swipeStartY - this.lastTapY) < 24;
        if (withinTime && nearLast) {
          this.emit("doubletap", { x: this.swipeStartX, y: this.swipeStartY });
          this.lastTapTime = 0;
        } else {
          this.lastTapTime = now;
          this.lastTapX = this.swipeStartX;
          this.lastTapY = this.swipeStartY;
        }
      }
    }
    this._reset();
  }
  _reset() {
    this.touchMode = null;
    this.swipeStartX = 0;
    this.swipeStartY = 0;
    this.swipeLastX = 0;
    this.swipeLastY = 0;
    this.lastPinchDistance = 0;
    this.lastPinchCenter = null;
  }
};

// src/transportState.js
var TRANSPORT_STATE_LABELS = {
  idle: "Idle",
  loading: "Loading",
  ready: "Ready",
  rendering: "Rendering...",
  playing: "Playing",
  playing_loop: "Playing (Loop)",
  playing_segment: "Playing (Segment)",
  paused: "Paused",
  paused_segment: "Paused (Segment)",
  stopped: "Stopped",
  error: "Error"
};
var ALLOWED_TRANSITIONS = {
  "": /* @__PURE__ */ new Set(["idle", "loading", "ready", "error"]),
  idle: /* @__PURE__ */ new Set(["loading", "ready", "error"]),
  loading: /* @__PURE__ */ new Set(["ready", "error", "idle"]),
  ready: /* @__PURE__ */ new Set(["rendering", "playing", "playing_loop", "playing_segment", "paused", "stopped", "loading", "error"]),
  rendering: /* @__PURE__ */ new Set(["ready", "error", "loading"]),
  playing: /* @__PURE__ */ new Set(["paused", "stopped", "playing_loop", "playing_segment", "ready"]),
  playing_loop: /* @__PURE__ */ new Set(["paused", "stopped", "playing", "ready"]),
  playing_segment: /* @__PURE__ */ new Set(["paused_segment", "stopped", "ready"]),
  paused: /* @__PURE__ */ new Set(["playing", "playing_loop", "stopped", "ready", "loading"]),
  paused_segment: /* @__PURE__ */ new Set(["playing_segment", "stopped", "ready", "paused"]),
  stopped: /* @__PURE__ */ new Set(["playing", "playing_loop", "playing_segment", "ready", "loading"]),
  error: /* @__PURE__ */ new Set(["loading", "idle", "ready"])
};
function canTransitionTransportState(fromState, toState) {
  if (!toState) return false;
  if (fromState === toState) return true;
  const allowed = ALLOWED_TRANSITIONS[fromState] || ALLOWED_TRANSITIONS[""];
  return allowed.has(toState);
}

// src/spectrogram.js
var CACHE_DB_NAME = "audio-workbench-cache";
var CACHE_DB_VERSION = 1;
var CACHE_STORE = "spectrograms";
function computeAmplitudePeak(channelData) {
  let peak = 0;
  for (let i = 0; i < channelData.length; i++) {
    const abs = Math.abs(channelData[i]);
    if (abs > peak) peak = abs;
  }
  return Math.max(1e-6, peak);
}
function buildMelFrequencies(sampleRate, nMels) {
  const melToHz = (mel) => 700 * (Math.pow(10, mel / 2595) - 1);
  const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const melMin = hzToMel(0);
  const melMax = hzToMel(sampleRate / 2);
  const freqs = new Float32Array(nMels);
  for (let i = 0; i < nMels; i++) {
    const mel = melMin + i / Math.max(1, nMels - 1) * (melMax - melMin);
    freqs[i] = melToHz(mel);
  }
  return freqs;
}
var COLOR_MAPS = {
  inferno: [
    [0, 0, 4],
    [31, 12, 72],
    [85, 15, 109],
    [136, 34, 106],
    [186, 54, 85],
    [227, 89, 51],
    [249, 140, 10],
    [252, 201, 40],
    [252, 255, 164]
  ],
  // Keep this table in sync with `web-demo/src/spectrogram.ts` (VIRIDIS_COLORS).
  viridis: [
    [68, 1, 84],
    [68, 2, 86],
    [69, 4, 87],
    [69, 5, 89],
    [70, 7, 90],
    [70, 8, 92],
    [70, 10, 93],
    [70, 11, 94],
    [71, 13, 96],
    [71, 14, 97],
    [71, 16, 99],
    [71, 17, 100],
    [71, 19, 101],
    [72, 20, 103],
    [72, 22, 104],
    [72, 23, 105],
    [72, 24, 106],
    [72, 26, 108],
    [72, 27, 109],
    [72, 28, 110],
    [72, 29, 111],
    [72, 31, 112],
    [72, 32, 113],
    [72, 33, 115],
    [72, 35, 116],
    [72, 36, 117],
    [72, 37, 118],
    [72, 38, 119],
    [72, 40, 120],
    [72, 41, 121],
    [71, 42, 122],
    [71, 44, 122],
    [71, 45, 123],
    [71, 46, 124],
    [71, 47, 125],
    [70, 48, 126],
    [70, 50, 126],
    [70, 51, 127],
    [69, 52, 128],
    [69, 53, 129],
    [69, 55, 129],
    [68, 56, 130],
    [68, 57, 131],
    [68, 58, 131],
    [67, 60, 132],
    [67, 61, 132],
    [66, 62, 133],
    [66, 63, 133],
    [66, 64, 134],
    [65, 66, 134],
    [65, 67, 135],
    [64, 68, 135],
    [64, 69, 136],
    [63, 71, 136],
    [63, 72, 137],
    [62, 73, 137],
    [62, 74, 137],
    [62, 76, 138],
    [61, 77, 138],
    [61, 78, 138],
    [60, 79, 139],
    [60, 80, 139],
    [59, 82, 139],
    [59, 83, 140],
    [58, 84, 140],
    [58, 85, 140],
    [57, 86, 141],
    [57, 88, 141],
    [56, 89, 141],
    [56, 90, 141],
    [55, 91, 142],
    [55, 92, 142],
    [54, 94, 142],
    [54, 95, 142],
    [53, 96, 142],
    [53, 97, 143],
    [52, 98, 143],
    [52, 99, 143],
    [51, 101, 143],
    [51, 102, 143],
    [50, 103, 144],
    [50, 104, 144],
    [49, 105, 144],
    [49, 106, 144],
    [49, 108, 144],
    [48, 109, 144],
    [48, 110, 144],
    [47, 111, 145],
    [47, 112, 145],
    [46, 113, 145],
    [46, 114, 145],
    [45, 116, 145],
    [45, 117, 145],
    [44, 118, 145],
    [44, 119, 145],
    [44, 120, 146],
    [43, 121, 146],
    [43, 122, 146],
    [42, 123, 146],
    [42, 125, 146],
    [42, 126, 146],
    [41, 127, 146],
    [41, 128, 146],
    [40, 129, 146],
    [40, 130, 146],
    [40, 131, 146],
    [39, 132, 146],
    [39, 133, 146],
    [38, 134, 146],
    [38, 136, 146],
    [38, 137, 146],
    [37, 138, 146],
    [37, 139, 146],
    [36, 140, 146],
    [36, 141, 146],
    [36, 142, 146],
    [35, 143, 146],
    [35, 144, 146],
    [35, 145, 146],
    [34, 146, 146],
    [34, 147, 146],
    [33, 148, 146],
    [33, 149, 146],
    [33, 150, 146],
    [32, 151, 145],
    [32, 152, 145],
    [32, 153, 145],
    [31, 154, 145],
    [31, 155, 145],
    [31, 156, 145],
    [30, 157, 144],
    [30, 158, 144],
    [30, 159, 144],
    [30, 160, 144],
    [29, 161, 143],
    [29, 162, 143],
    [29, 163, 143],
    [29, 164, 142],
    [28, 165, 142],
    [28, 166, 142],
    [28, 167, 141],
    [28, 168, 141],
    [28, 169, 141],
    [27, 170, 140],
    [27, 171, 140],
    [27, 172, 139],
    [27, 173, 139],
    [27, 174, 138],
    [27, 175, 138],
    [27, 176, 137],
    [27, 177, 137],
    [27, 178, 136],
    [27, 179, 136],
    [27, 180, 135],
    [27, 181, 135],
    [27, 182, 134],
    [27, 183, 133],
    [28, 184, 133],
    [28, 185, 132],
    [28, 186, 131],
    [29, 187, 131],
    [29, 188, 130],
    [29, 189, 129],
    [30, 190, 129],
    [30, 190, 128],
    [31, 191, 127],
    [31, 192, 126],
    [32, 193, 126],
    [33, 194, 125],
    [33, 195, 124],
    [34, 196, 123],
    [35, 197, 123],
    [36, 198, 122],
    [37, 198, 121],
    [37, 199, 120],
    [38, 200, 119],
    [39, 201, 118],
    [40, 202, 118],
    [41, 203, 117],
    [42, 203, 116],
    [44, 204, 115],
    [45, 205, 114],
    [46, 206, 113],
    [47, 207, 112],
    [49, 207, 111],
    [50, 208, 110],
    [51, 209, 109],
    [53, 210, 108],
    [54, 210, 107],
    [56, 211, 106],
    [57, 212, 105],
    [59, 213, 104],
    [60, 213, 103],
    [62, 214, 102],
    [64, 215, 101],
    [65, 215, 100],
    [67, 216, 98],
    [69, 217, 97],
    [70, 217, 96],
    [72, 218, 95],
    [74, 219, 94],
    [76, 219, 93],
    [78, 220, 91],
    [80, 221, 90],
    [82, 221, 89],
    [83, 222, 88],
    [85, 222, 86],
    [87, 223, 85],
    [89, 224, 84],
    [91, 224, 83],
    [94, 225, 81],
    [96, 225, 80],
    [98, 226, 79],
    [100, 226, 77],
    [102, 227, 76],
    [104, 227, 75],
    [106, 228, 73],
    [109, 228, 72],
    [111, 229, 71],
    [113, 229, 69],
    [115, 230, 68],
    [118, 230, 66],
    [120, 231, 65],
    [122, 231, 64],
    [125, 232, 62],
    [127, 232, 61],
    [129, 232, 59],
    [132, 233, 58],
    [134, 233, 56],
    [137, 234, 55],
    [139, 234, 53],
    [141, 235, 52],
    [144, 235, 50],
    [146, 235, 49],
    [149, 236, 47],
    [151, 236, 46],
    [154, 236, 45],
    [156, 237, 43],
    [159, 237, 42],
    [161, 237, 40],
    [163, 238, 39],
    [166, 238, 38],
    [168, 238, 36],
    [171, 239, 35],
    [173, 239, 34],
    [176, 239, 32],
    [178, 239, 31],
    [181, 240, 30],
    [183, 240, 29],
    [186, 240, 28],
    [188, 240, 27],
    [191, 241, 26],
    [193, 241, 25],
    [195, 241, 24],
    [198, 241, 23],
    [200, 241, 23],
    [203, 241, 22],
    [205, 242, 22],
    [207, 242, 21],
    [210, 242, 21],
    [212, 242, 21],
    [214, 242, 21],
    [217, 242, 20],
    [219, 242, 20],
    [221, 243, 20],
    [224, 243, 21],
    [226, 243, 21],
    [228, 243, 21],
    [230, 243, 22],
    [232, 243, 22],
    [235, 243, 23],
    [237, 244, 24],
    [239, 244, 25],
    [241, 244, 26],
    [243, 244, 27],
    [245, 244, 28],
    [247, 244, 30],
    [249, 244, 31],
    [251, 245, 33],
    [253, 245, 35]
  ],
  magma: [
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191]
  ],
  plasma: [
    [13, 8, 135],
    [75, 3, 161],
    [125, 3, 168],
    [168, 34, 150],
    [203, 70, 121],
    [229, 107, 93],
    [248, 148, 65],
    [253, 195, 40],
    [240, 249, 33]
  ]
};
function sampleColorMap(stops, t) {
  if (!stops || stops.length === 0) return { r: 0, g: 0, b: 0 };
  if (stops.length === 1) return { r: stops[0][0], g: stops[0][1], b: stops[0][2] };
  const pos = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const idx = Math.floor(pos);
  const frac = pos - idx;
  const a = stops[idx];
  const b = stops[Math.min(stops.length - 1, idx + 1)];
  return {
    r: Math.round(a[0] + (b[0] - a[0]) * frac),
    g: Math.round(a[1] + (b[1] - a[1]) * frac),
    b: Math.round(a[2] + (b[2] - a[2]) * frac)
  };
}
function getSpectrogramColor(value, colorScheme) {
  const x = Math.max(0, Math.min(1, value));
  if (colorScheme === "grayscale") {
    const v = Math.round(x * 255);
    return { r: v, g: v, b: v };
  }
  if (colorScheme === "viridis") {
    const palette = COLOR_MAPS.viridis;
    const idx = Math.min(palette.length - 1, Math.floor(x * (palette.length - 1)));
    const color = palette[idx];
    return { r: color[0], g: color[1], b: color[2] };
  }
  if (colorScheme === "fire") {
    const r = Math.round(255 * Math.pow(x, 0.7));
    const g = Math.round(255 * Math.max(0, Math.min(1, (x - 0.15) / 0.85)));
    const b = Math.round(255 * Math.max(0, Math.min(1, (x - 0.45) / 0.55)));
    return { r, g, b };
  }
  return sampleColorMap(COLOR_MAPS[colorScheme] || COLOR_MAPS.inferno, x);
}
var _VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;
var _FS = `#version 300 es
precision mediump float;
uniform sampler2D u_gray;
uniform sampler2D u_lut;
uniform float u_floor;
uniform float u_rcpRange;
in vec2 v_uv;
out vec4 fragColor;
void main() {
    float g = texture(u_gray, v_uv).r;
    float t = clamp((g - u_floor) * u_rcpRange, 0.0, 1.0);
    fragColor = texture(u_lut, vec2(t, 0.5));
}`;
var GpuColorizer = class {
  constructor() {
    this._canvas = document.createElement("canvas");
    const gl = this._canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false
    });
    if (!gl) {
      this._gl = null;
      return;
    }
    this._gl = gl;
    this._maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const vs = this._sh(gl.VERTEX_SHADER, _VS);
    const fs = this._sh(gl.FRAGMENT_SHADER, _FS);
    if (!vs || !fs) {
      this._gl = null;
      return;
    }
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      this._gl = null;
      return;
    }
    this._prog = p;
    this._uFloor = gl.getUniformLocation(p, "u_floor");
    this._uRcpRange = gl.getUniformLocation(p, "u_rcpRange");
    this._uGray = gl.getUniformLocation(p, "u_gray");
    this._uLut = gl.getUniformLocation(p, "u_lut");
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this._vao = vao;
    this._grayTex = gl.createTexture();
    this._lutTex = gl.createTexture();
    this._w = 0;
    this._h = 0;
    this._lutScheme = null;
  }
  /** @private */
  _sh(type, src) {
    const gl = this._gl, s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s);
      return null;
    }
    return s;
  }
  get ok() {
    return !!this._gl;
  }
  get canvas() {
    return this._canvas;
  }
  /** Upload 8-bit grayscale map as a RED channel texture. Returns success. */
  uploadGrayscale(gray, width, height) {
    const gl = this._gl;
    if (!gl || width > this._maxTex || height > this._maxTex) return false;
    this._w = width;
    this._h = height;
    this._canvas.width = width;
    this._canvas.height = height;
    gl.bindTexture(gl.TEXTURE_2D, this._grayTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, gray);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return true;
  }
  /** Build 256-entry RGBA color look-up texture from a color scheme. */
  uploadColorLut(scheme) {
    if (scheme === this._lutScheme) return;
    const gl = this._gl;
    if (!gl) return;
    this._lutScheme = scheme;
    const d = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const c = getSpectrogramColor(i / 255, scheme);
      const o = i * 4;
      d[o] = c.r;
      d[o + 1] = c.g;
      d[o + 2] = c.b;
      d[o + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  /** Render colorized spectrogram. floor01/ceil01 ∈ [0,1]. ~0.1 ms. */
  render(floor01, ceil01) {
    const gl = this._gl;
    if (!gl || !this._w) return;
    gl.viewport(0, 0, this._w, this._h);
    gl.useProgram(this._prog);
    gl.bindVertexArray(this._vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._grayTex);
    gl.uniform1i(this._uGray, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
    gl.uniform1i(this._uLut, 1);
    gl.uniform1f(this._uFloor, floor01);
    gl.uniform1f(this._uRcpRange, 1 / Math.max(1e-4, ceil01 - floor01));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  dispose() {
    const gl = this._gl;
    if (!gl) return;
    gl.deleteTexture(this._grayTex);
    gl.deleteTexture(this._lutTex);
    gl.deleteProgram(this._prog);
    gl.deleteVertexArray(this._vao);
    this._gl = null;
  }
};
function updateSpectrogramStats(spectrogramData) {
  if (!spectrogramData || spectrogramData.length === 0) {
    return { logMin: 0, logMax: 1 };
  }
  let minLog = Number.POSITIVE_INFINITY;
  let maxLog = Number.NEGATIVE_INFINITY;
  const stride = Math.max(1, Math.floor(spectrogramData.length / 12e4));
  for (let i = 0; i < spectrogramData.length; i += stride) {
    const mapped = Math.log1p((spectrogramData[i] || 0) * 12);
    if (mapped < minLog) minLog = mapped;
    if (mapped > maxLog) maxLog = mapped;
  }
  if (!Number.isFinite(minLog) || !Number.isFinite(maxLog) || maxLog - minLog < 1e-6) {
    return { logMin: 0, logMax: 1 };
  }
  return { logMin: minLog, logMax: maxLog };
}
function autoContrastStats(spectrogramData, loPercentile = 2, hiPercentile = 98) {
  if (!spectrogramData || spectrogramData.length === 0) return { logMin: 0, logMax: 1 };
  const stride = Math.max(1, Math.floor(spectrogramData.length / 2e5));
  const mapped = [];
  for (let i = 0; i < spectrogramData.length; i += stride) {
    mapped.push(Math.log1p((spectrogramData[i] || 0) * 12));
  }
  mapped.sort((a, b) => a - b);
  const loIdx = Math.floor(mapped.length * loPercentile / 100);
  const hiIdx = Math.min(mapped.length - 1, Math.floor(mapped.length * hiPercentile / 100));
  const logMin = mapped[loIdx];
  const logMax = mapped[hiIdx];
  if (!Number.isFinite(logMin) || !Number.isFinite(logMax) || logMax - logMin < 1e-6) {
    return { logMin: 0, logMax: 1 };
  }
  return { logMin, logMax };
}
function detectMaxFrequency(spectrogramData, nFrames, nMels, sampleRate, energyThreshold = 0.08) {
  if (!spectrogramData || nFrames <= 0 || nMels <= 0) return sampleRate / 2;
  const binEnergy = new Float64Array(nMels);
  const stride = Math.max(1, Math.floor(nFrames / 2e3));
  let sampledFrames = 0;
  for (let f = 0; f < nFrames; f += stride) {
    const base = f * nMels;
    for (let m = 0; m < nMels; m++) {
      binEnergy[m] += spectrogramData[base + m] || 0;
    }
    sampledFrames++;
  }
  for (let m = 0; m < nMels; m++) binEnergy[m] /= sampledFrames;
  let peakEnergy = 0;
  for (let m = 0; m < nMels; m++) {
    if (binEnergy[m] > peakEnergy) peakEnergy = binEnergy[m];
  }
  if (peakEnergy < 1e-12) return sampleRate / 2;
  const threshold = peakEnergy * energyThreshold;
  let highestActiveBin = 0;
  for (let m = nMels - 1; m >= 0; m--) {
    if (binEnergy[m] > threshold) {
      highestActiveBin = m;
      break;
    }
  }
  const melFreqs = buildMelFrequencies(sampleRate, nMels);
  const detectedHz = melFreqs[Math.min(nMels - 1, highestActiveBin + 2)] || sampleRate / 2;
  const withMargin = detectedHz * 1.1;
  const steps = [2e3, 3e3, 4e3, 5e3, 6e3, 8e3, 1e4, 12e3, 16e3, 2e4, 22050];
  const nyquist = sampleRate / 2;
  let best = nyquist;
  for (const s of steps) {
    if (s >= withMargin && s <= nyquist) {
      best = s;
      break;
    }
  }
  return best;
}
function drawTimeGrid({ ctx, width, height, duration, pixelsPerSecond }) {
  if (width <= 0) return;
  const css = getComputedStyle(document.documentElement);
  const majorColor = css.getPropertyValue("--color-text-secondary").trim() || "#cbd5e1";
  const { majorStep, minorStep } = getTimeGridSteps(pixelsPerSecond);
  ctx.save();
  ctx.font = "11px monospace";
  ctx.textBaseline = "top";
  for (let t = 0; t <= duration; t += minorStep) {
    const x = Math.round(t * pixelsPerSecond) + 0.5;
    if (x < 0 || x > width) continue;
    const isMajor = Math.abs(t / majorStep - Math.round(t / majorStep)) < 1e-4;
    ctx.strokeStyle = isMajor ? "rgba(148,163,184,0.35)" : "rgba(148,163,184,0.18)";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = majorColor;
      ctx.fillText(`${t.toFixed(1)}s`, x + 3, 4);
    }
  }
  ctx.restore();
}
function buildSpectrogramGrayscale({
  spectrogramData,
  spectrogramFrames,
  spectrogramMels,
  sampleRateHz,
  maxFreq,
  spectrogramAbsLogMin,
  spectrogramAbsLogMax
}) {
  if (!spectrogramData || spectrogramFrames <= 0 || spectrogramMels <= 0) return null;
  const width = Math.max(1, Math.min(spectrogramFrames, MAX_BASE_SPECTROGRAM_WIDTH));
  const height = SPECTROGRAM_HEIGHT;
  const framesPerPixel = spectrogramFrames / width;
  const boundedMaxFreq = Math.min(maxFreq, sampleRateHz / 2);
  const melFreqs = buildMelFrequencies(sampleRateHz, spectrogramMels);
  let maxMelBin = spectrogramMels - 1;
  for (let i = 0; i < melFreqs.length; i++) {
    if (melFreqs[i] > boundedMaxFreq) {
      maxMelBin = Math.max(1, i - 1);
      break;
    }
  }
  const yToMel = new Int16Array(height);
  for (let y = 0; y < height; y++) {
    const freqIndex = Math.floor((height - y) / height * (maxMelBin + 1));
    yToMel[y] = Math.max(0, Math.min(maxMelBin, freqIndex));
  }
  const logRange = Math.max(1e-6, spectrogramAbsLogMax - spectrogramAbsLogMin);
  const gray = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    const frameStart = Math.max(0, Math.floor(x * framesPerPixel));
    const frameEnd = Math.max(frameStart + 1, Math.min(spectrogramFrames, Math.ceil((x + 1) * framesPerPixel)));
    const sampleStep = Math.max(1, Math.floor((frameEnd - frameStart) / 4));
    for (let y = 0; y < height; y++) {
      const melBin = yToMel[y];
      let sum = 0, count = 0;
      for (let frame = frameStart; frame < frameEnd; frame += sampleStep) {
        sum += spectrogramData[frame * spectrogramMels + melBin] || 0;
        count++;
      }
      if (frameEnd - 1 > frameStart) {
        sum += spectrogramData[(frameEnd - 1) * spectrogramMels + melBin] || 0;
        count++;
      }
      const magnitude = sum / Math.max(1, count);
      const normalized = (Math.log1p(magnitude * 12) - spectrogramAbsLogMin) / logRange;
      gray[y * width + x] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
    }
  }
  return { gray, width, height };
}
function colorizeSpectrogram(grayInfo, floor01, ceil01, colorScheme) {
  if (!grayInfo) return null;
  const { gray, width, height } = grayInfo;
  const lut = new Uint32Array(256);
  const range = Math.max(1e-6, ceil01 - floor01);
  const view = new DataView(lut.buffer);
  for (let i = 0; i < 256; i++) {
    const raw = i / 255;
    const remapped = Math.max(0, Math.min(1, (raw - floor01) / range));
    const c = getSpectrogramColor(remapped, colorScheme);
    view.setUint32(i * 4, 255 << 24 | c.b << 16 | c.g << 8 | c.r, true);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const imageData = ctx.createImageData(width, height);
  const pixels = new Uint32Array(imageData.data.buffer);
  const len = width * height;
  for (let i = 0; i < len; i++) {
    pixels[i] = lut[gray[i]];
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}
function renderSpectrogram({
  duration,
  spectrogramCanvas,
  pixelsPerSecond,
  canvasHeight,
  baseCanvas,
  sampleRate,
  frameRate,
  spectrogramFrames
}) {
  if (!baseCanvas) return;
  const ctx = spectrogramCanvas.getContext("2d");
  if (!ctx) return;
  const width = Math.max(1, Math.floor(duration * pixelsPerSecond));
  const height = Math.max(140, Math.floor(canvasHeight));
  spectrogramCanvas.width = width;
  spectrogramCanvas.height = height;
  ctx.clearRect(0, 0, width, height);
  const hopSize = Math.floor(sampleRate / frameRate);
  const frameCenterSec = 2 * hopSize / sampleRate;
  const x0 = Math.round(frameCenterSec * pixelsPerSecond);
  const drawWidth = Math.round(spectrogramFrames * hopSize / sampleRate * pixelsPerSecond);
  ctx.imageSmoothingEnabled = drawWidth < baseCanvas.width;
  ctx.drawImage(
    baseCanvas,
    0,
    0,
    baseCanvas.width,
    baseCanvas.height,
    x0,
    0,
    drawWidth,
    height
  );
  drawTimeGrid({ ctx, width, height, duration, pixelsPerSecond });
}
function openSpectrogramCacheDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: "cacheKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open cache DB"));
  });
}
async function sha256ArrayBuffer(arrayBuffer) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("crypto.subtle unavailable");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", arrayBuffer);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
function buildSpectrogramCacheKey({
  fileHash,
  fftSize,
  sampleRate,
  frameRate,
  nMels,
  pcenGain,
  pcenBias,
  pcenRoot,
  pcenSmoothing
}) {
  return [
    fileHash,
    `fft=${fftSize}`,
    `sr=${sampleRate}`,
    `fr=${frameRate}`,
    `mels=${nMels}`,
    `g=${pcenGain}`,
    `b=${pcenBias}`,
    `r=${pcenRoot}`,
    `s=${pcenSmoothing}`
  ].join("|");
}
async function getSpectrogramCacheEntry(cacheKey) {
  try {
    const db = await openSpectrogramCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readonly");
      const store = tx.objectStore(CACHE_STORE);
      const req = store.get(cacheKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("Cache read failed"));
    });
  } catch {
    return null;
  }
}
async function putSpectrogramCacheEntry(entry) {
  try {
    const db = await openSpectrogramCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      const store = tx.objectStore(CACHE_STORE);
      store.put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Cache write failed"));
    });
    return true;
  } catch {
    return false;
  }
}
var WORKER_CODE = `
self.onmessage = (event) => {
    const {
        requestId,
        channelData,
        fftSize,
        sampleRate,
        frameRate,
        nMels,
        pcenGain,
        pcenBias,
        pcenRoot,
        pcenSmoothing,
    } = event.data;

    const audio = new Float32Array(channelData);
    const hopSize = Math.max(1, Math.floor(sampleRate / frameRate));
    const winLength = 4 * hopSize;
    const numFrames = Math.max(1, Math.floor((audio.length - winLength) / hopSize) + 1);

    const melFilterbank = createMelFilterbank(sampleRate, fftSize, nMels, 0, sampleRate / 2);
    const pcenOutput = new Float32Array(numFrames * nMels);
    const smooth = new Float32Array(nMels);
    const pcenPower = 1.0 / pcenRoot;

    for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
        const offset = frameIdx * hopSize;
        const powerSpectrum = fftPowerSpectrum(audio, offset, winLength, fftSize);
        const melSpectrum = applyMelFilterbank(powerSpectrum, melFilterbank);

        const base = frameIdx * nMels;
        for (let m = 0; m < nMels; m++) {
            const e = melSpectrum[m];
            smooth[m] = (1 - pcenSmoothing) * smooth[m] + pcenSmoothing * e;
            const denominator = Math.pow(1e-12 + smooth[m], pcenGain);
            const normalized = e / denominator;
            pcenOutput[base + m] = Math.pow(normalized + pcenBias, pcenPower) - Math.pow(pcenBias, pcenPower);
        }
    }

    self.postMessage(
        { requestId, data: pcenOutput.buffer, nFrames: numFrames, nMels },
        [pcenOutput.buffer]
    );
};

function fftPowerSpectrum(audio, offset, winLength, fftSize) {
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    const maxCopy = Math.min(winLength, fftSize);
    for (let i = 0; i < maxCopy; i++) {
        const sample = audio[offset + i] || 0;
        const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / Math.max(1, winLength - 1)));
        real[i] = sample * window;
    }

    iterativeFFT(real, imag);

    const out = new Float32Array(fftSize / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = real[i] * real[i] + imag[i] * imag[i];
    }
    return out;
}

function iterativeFFT(real, imag) {
    const n = real.length;

    let j = 0;
    for (let i = 1; i < n; i++) {
        let bit = n >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;

        if (i < j) {
            let tmp = real[i];
            real[i] = real[j];
            real[j] = tmp;
            tmp = imag[i];
            imag[i] = imag[j];
            imag[j] = tmp;
        }
    }

    for (let len = 2; len <= n; len <<= 1) {
        const halfLen = len >> 1;
        const angleStep = -2 * Math.PI / len;

        for (let i = 0; i < n; i += len) {
            for (let k = 0; k < halfLen; k++) {
                const angle = angleStep * k;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);

                const evenIndex = i + k;
                const oddIndex = evenIndex + halfLen;

                const tr = cos * real[oddIndex] - sin * imag[oddIndex];
                const ti = sin * real[oddIndex] + cos * imag[oddIndex];

                real[oddIndex] = real[evenIndex] - tr;
                imag[oddIndex] = imag[evenIndex] - ti;
                real[evenIndex] += tr;
                imag[evenIndex] += ti;
            }
        }
    }
}

function hzToMel(hz) {
    return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
    return 700 * (Math.pow(10, mel / 2595) - 1);
}

function createMelFilterbank(sampleRate, fftSize, nMels, fMin, fMax) {
    const nFftBins = Math.floor(fftSize / 2);
    const melMin = hzToMel(fMin);
    const melMax = hzToMel(fMax);
    const melPoints = [];

    for (let i = 0; i < nMels + 2; i++) {
        melPoints.push(melMin + (i / (nMels + 1)) * (melMax - melMin));
    }

    const hzPoints = melPoints.map(melToHz);
    const binPoints = hzPoints.map((hz) => Math.floor((fftSize + 1) * hz / sampleRate));

    const filterbank = [];
    for (let m = 1; m <= nMels; m++) {
        const filter = new Float32Array(nFftBins);
        const left = Math.max(0, Math.min(nFftBins - 1, binPoints[m - 1]));
        const center = Math.max(0, Math.min(nFftBins - 1, binPoints[m]));
        const right = Math.max(0, Math.min(nFftBins - 1, binPoints[m + 1]));

        for (let k = left; k < center; k++) {
            const denom = center - left || 1;
            filter[k] = (k - left) / denom;
        }
        for (let k = center; k < right; k++) {
            const denom = right - center || 1;
            filter[k] = (right - k) / denom;
        }

        filterbank.push(filter);
    }

    return filterbank;
}

function applyMelFilterbank(powerSpectrum, melFilterbank) {
    const melSpectrum = new Float32Array(melFilterbank.length);
    for (let m = 0; m < melFilterbank.length; m++) {
        const filter = melFilterbank[m];
        let sum = 0;
        for (let k = 0; k < filter.length; k++) {
            if (filter[k] !== 0) {
                sum += powerSpectrum[k] * filter[k];
            }
        }
        melSpectrum[m] = sum;
    }
    return melSpectrum;
}
`;
function createSpectrogramProcessor() {
  let worker = null;
  let workerFailed = false;
  let requestCounter = 0;
  const pendingRequests = /* @__PURE__ */ new Map();
  let _mainThreadFn = null;
  const getMainThreadFn = () => {
    if (_mainThreadFn) return _mainThreadFn;
    _mainThreadFn = new Function("params", `
            const {
                channelData, fftSize, sampleRate, frameRate,
                nMels, pcenGain, pcenBias, pcenRoot, pcenSmoothing,
            } = params;

            const audio = new Float32Array(channelData);
            const hopSize = Math.max(1, Math.floor(sampleRate / frameRate));
            const winLength = 4 * hopSize;
            const numFrames = Math.max(1, Math.floor((audio.length - winLength) / hopSize) + 1);

            ${/* inline helpers from WORKER_CODE */
    ""}
            function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
            function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

            function createMelFB(sr, fft, nm, fMin, fMax) {
                const nBins = Math.floor(fft / 2);
                const mMin = hzToMel(fMin), mMax = hzToMel(fMax);
                const mPts = [];
                for (let i = 0; i < nm + 2; i++) mPts.push(mMin + (i / (nm + 1)) * (mMax - mMin));
                const hPts = mPts.map(melToHz);
                const bPts = hPts.map(hz => Math.floor((fft + 1) * hz / sr));
                const fb = [];
                for (let m = 1; m <= nm; m++) {
                    const f = new Float32Array(nBins);
                    const l = Math.max(0, Math.min(nBins-1, bPts[m-1]));
                    const c = Math.max(0, Math.min(nBins-1, bPts[m]));
                    const r = Math.max(0, Math.min(nBins-1, bPts[m+1]));
                    for (let k = l; k < c; k++) f[k] = (k - l) / (c - l || 1);
                    for (let k = c; k < r; k++) f[k] = (r - k) / (r - c || 1);
                    fb.push(f);
                }
                return fb;
            }

            function iterativeFFT(re, im) {
                const n = re.length;
                let j = 0;
                for (let i = 1; i < n; i++) {
                    let bit = n >> 1;
                    while (j & bit) { j ^= bit; bit >>= 1; }
                    j ^= bit;
                    if (i < j) {
                        let t = re[i]; re[i] = re[j]; re[j] = t;
                        t = im[i]; im[i] = im[j]; im[j] = t;
                    }
                }
                for (let len = 2; len <= n; len <<= 1) {
                    const half = len >> 1, step = -2 * Math.PI / len;
                    for (let i = 0; i < n; i += len) {
                        for (let k = 0; k < half; k++) {
                            const a = step * k, cos = Math.cos(a), sin = Math.sin(a);
                            const ei = i + k, oi = ei + half;
                            const tr = cos * re[oi] - sin * im[oi];
                            const ti = sin * re[oi] + cos * im[oi];
                            re[oi] = re[ei] - tr; im[oi] = im[ei] - ti;
                            re[ei] += tr; im[ei] += ti;
                        }
                    }
                }
            }

            function fftPow(audio, off, wl, fft) {
                const re = new Float32Array(fft), im = new Float32Array(fft);
                const mc = Math.min(wl, fft);
                for (let i = 0; i < mc; i++) {
                    const s = audio[off + i] || 0;
                    re[i] = s * 0.5 * (1 - Math.cos(2 * Math.PI * i / Math.max(1, wl - 1)));
                }
                iterativeFFT(re, im);
                const o = new Float32Array(fft / 2);
                for (let i = 0; i < o.length; i++) o[i] = re[i]*re[i] + im[i]*im[i];
                return o;
            }

            function applyMel(ps, fb) {
                const ms = new Float32Array(fb.length);
                for (let m = 0; m < fb.length; m++) {
                    let s = 0;
                    for (let k = 0; k < fb[m].length; k++) if (fb[m][k]) s += ps[k]*fb[m][k];
                    ms[m] = s;
                }
                return ms;
            }

            const melFB = createMelFB(sampleRate, fftSize, nMels, 0, sampleRate / 2);
            const out = new Float32Array(numFrames * nMels);
            const smooth = new Float32Array(nMels);
            const pcenPower = 1.0 / pcenRoot;

            for (let fi = 0; fi < numFrames; fi++) {
                const ps = fftPow(audio, fi * hopSize, winLength, fftSize);
                const ms = applyMel(ps, melFB);
                const base = fi * nMels;
                for (let m = 0; m < nMels; m++) {
                    const e = ms[m];
                    smooth[m] = (1 - pcenSmoothing) * smooth[m] + pcenSmoothing * e;
                    const den = Math.pow(1e-12 + smooth[m], pcenGain);
                    out[base + m] = Math.pow(e / den + pcenBias, pcenPower) - Math.pow(pcenBias, pcenPower);
                }
            }
            return { data: out, nFrames: numFrames, nMels };
        `);
    return _mainThreadFn;
  };
  const computeMainThread = (channelData, options) => {
    const fn = getMainThreadFn();
    return fn({
      channelData: channelData.buffer.slice(
        channelData.byteOffset,
        channelData.byteOffset + channelData.byteLength
      ),
      ...options
    });
  };
  const ensureWorker = () => {
    if (worker || workerFailed) return;
    try {
      const blob = new Blob([WORKER_CODE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
      worker.onmessage = (event) => {
        const { requestId, data, nFrames, nMels } = event.data;
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        pending.resolve({ data: new Float32Array(data), nFrames, nMels });
      };
      worker.onerror = (error) => {
        console.warn("Spectrogram Worker failed, using main-thread fallback:", error);
        workerFailed = true;
        worker?.terminate();
        worker = null;
        pendingRequests.forEach(({ reject }) => reject(error));
        pendingRequests.clear();
      };
    } catch (e) {
      console.warn("Cannot create Worker, using main-thread fallback:", e);
      workerFailed = true;
      worker = null;
    }
  };
  const compute = async (channelData, options) => {
    if (workerFailed) {
      return computeMainThread(channelData, options);
    }
    ensureWorker();
    if (workerFailed) {
      return computeMainThread(channelData, options);
    }
    const requestId = ++requestCounter;
    const audioCopy = new Float32Array(channelData);
    const workerPromise = new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
    });
    worker.postMessage(
      { requestId, channelData: audioCopy.buffer, ...options },
      [audioCopy.buffer]
    );
    try {
      const result = await Promise.race([
        workerPromise,
        new Promise(
          (_, reject) => setTimeout(() => reject(new Error("Worker timeout")), 8e3)
        )
      ]);
      return result;
    } catch (e) {
      console.warn("Worker failed/timed out, computing on main thread:", e.message);
      pendingRequests.delete(requestId);
      workerFailed = true;
      worker?.terminate();
      worker = null;
      return computeMainThread(channelData, options);
    }
  };
  const computeProgressive = async function* (channelData, options) {
    const sampleRate = Math.max(1, options.sampleRate || 0);
    const chunkSeconds = Math.max(1, options.chunkSeconds || 10);
    const samplesPerChunk = Math.max(1, Math.floor(chunkSeconds * sampleRate));
    const totalChunks = Math.max(1, Math.ceil(channelData.length / samplesPerChunk));
    for (let chunk = 0; chunk < totalChunks; chunk++) {
      const startSample = chunk * samplesPerChunk;
      const endSample = Math.min(channelData.length, startSample + samplesPerChunk);
      const chunkData = channelData.subarray(startSample, endSample);
      const result = await compute(chunkData, options);
      yield {
        chunk,
        totalChunks,
        percent: (chunk + 1) / totalChunks * 100,
        result
      };
    }
  };
  const dispose = () => {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    pendingRequests.clear();
  };
  return { compute, computeProgressive, dispose };
}

// src/waveform.js
function drawWaveformTimeline({ ctx, width, height, duration, pixelsPerSecond }) {
  if (width <= 0) return;
  const css = getComputedStyle(document.documentElement);
  const textColor = css.getPropertyValue("--color-text-secondary").trim() || "#cbd5e1";
  const { majorStep, minorStep } = getTimeGridSteps(pixelsPerSecond);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = css.getPropertyValue("--color-bg-secondary").trim() || "#1e293b";
  ctx.fillRect(0, 0, width, height);
  ctx.font = "11px monospace";
  ctx.textBaseline = "middle";
  ctx.fillStyle = textColor;
  ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
  for (let t = 0; t <= duration; t += minorStep) {
    const x = Math.round(t * pixelsPerSecond) + 0.5;
    if (x < 0 || x > width) continue;
    const isMajor = Math.abs(t / majorStep - Math.round(t / majorStep)) < 1e-4;
    const lineHeight = isMajor ? 14 : 8;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, lineHeight);
    ctx.stroke();
    if (isMajor) {
      ctx.fillText(`${t.toFixed(1)}s`, x + 3, height / 2);
    }
  }
}
function renderMainWaveform({
  audioBuffer,
  amplitudeCanvas,
  waveformTimelineCanvas,
  waveformContent,
  pixelsPerSecond,
  waveformHeight = 100,
  amplitudePeakAbs,
  showTimeline = true
}) {
  if (!audioBuffer) return;
  const ampCtx = amplitudeCanvas.getContext("2d");
  const timelineCtx = waveformTimelineCanvas.getContext("2d");
  if (!ampCtx || !timelineCtx) return;
  const width = Math.max(1, Math.floor(audioBuffer.duration * pixelsPerSecond));
  const clampedWaveformHeight = Math.max(64, Math.floor(waveformHeight));
  const timelineHeight = showTimeline ? Math.max(18, Math.min(32, Math.round(clampedWaveformHeight * 0.22))) : 0;
  const ampHeight = Math.max(32, clampedWaveformHeight - timelineHeight);
  amplitudeCanvas.width = width;
  amplitudeCanvas.height = ampHeight;
  waveformTimelineCanvas.width = width;
  waveformTimelineCanvas.height = timelineHeight;
  waveformTimelineCanvas.style.display = showTimeline ? "block" : "none";
  waveformContent.style.width = `${width}px`;
  const channelData = audioBuffer.getChannelData(0);
  const totalSamples = channelData.length;
  const midY = ampHeight / 2;
  const ampScale = 1 / Math.max(1e-6, amplitudePeakAbs);
  const { majorStep, minorStep } = getTimeGridSteps(pixelsPerSecond);
  ampCtx.clearRect(0, 0, width, ampHeight);
  ampCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-tertiary");
  ampCtx.fillRect(0, 0, width, ampHeight);
  for (let t = 0; t <= audioBuffer.duration; t += minorStep) {
    const x = Math.round(t * pixelsPerSecond) + 0.5;
    const isMajor = Math.abs(t / majorStep - Math.round(t / majorStep)) < 1e-4;
    ampCtx.strokeStyle = isMajor ? "rgba(148,163,184,0.22)" : "rgba(148,163,184,0.12)";
    ampCtx.beginPath();
    ampCtx.moveTo(x, 0);
    ampCtx.lineTo(x, ampHeight);
    ampCtx.stroke();
  }
  ampCtx.strokeStyle = "rgba(148, 163, 184, 0.35)";
  ampCtx.beginPath();
  ampCtx.moveTo(0, midY + 0.5);
  ampCtx.lineTo(width, midY + 0.5);
  ampCtx.stroke();
  ampCtx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-accent");
  ampCtx.lineWidth = 1;
  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * totalSamples / width);
    const end = Math.min(totalSamples, Math.floor((x + 1) * totalSamples / width));
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const v = Math.max(-1, Math.min(1, channelData[i] * ampScale));
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ampCtx.beginPath();
    ampCtx.moveTo(x + 0.5, (1 + min) * midY);
    ampCtx.lineTo(x + 0.5, (1 + max) * midY);
    ampCtx.stroke();
  }
  if (showTimeline && timelineHeight > 0) {
    drawWaveformTimeline({
      ctx: timelineCtx,
      width,
      height: timelineHeight,
      duration: audioBuffer.duration,
      pixelsPerSecond
    });
  }
}
function renderOverviewWaveform({
  audioBuffer,
  overviewCanvas,
  overviewContainer,
  amplitudePeakAbs
}) {
  if (!audioBuffer) return;
  const ctx = overviewCanvas.getContext("2d");
  if (!ctx) return;
  const rect = overviewContainer.getBoundingClientRect();
  overviewCanvas.width = Math.max(1, Math.floor(rect.width));
  overviewCanvas.height = Math.max(1, Math.floor(rect.height));
  ctx.clearRect(0, 0, overviewCanvas.width, overviewCanvas.height);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-tertiary");
  ctx.fillRect(0, 0, overviewCanvas.width, overviewCanvas.height);
  const channelData = audioBuffer.getChannelData(0);
  const totalSamples = channelData.length;
  const amp = overviewCanvas.height / 2;
  const ampScale = 1 / Math.max(1e-6, amplitudePeakAbs);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-accent");
  ctx.lineWidth = 1;
  for (let x = 0; x < overviewCanvas.width; x++) {
    const start = Math.floor(x * totalSamples / overviewCanvas.width);
    const end = Math.min(totalSamples, Math.floor((x + 1) * totalSamples / overviewCanvas.width));
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const v = Math.max(-1, Math.min(1, channelData[i] * ampScale));
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.beginPath();
    ctx.moveTo(x, (1 + min) * amp);
    ctx.lineTo(x, (1 + max) * amp);
    ctx.stroke();
  }
}
function renderFrequencyLabels({ labelsElement, maxFreq, sampleRateHz }) {
  labelsElement.innerHTML = "";
  const boundedMaxFreq = Math.min(maxFreq, sampleRateHz / 2);
  const frequencies = [
    boundedMaxFreq,
    boundedMaxFreq * 0.8,
    boundedMaxFreq * 0.6,
    boundedMaxFreq * 0.4,
    boundedMaxFreq * 0.2,
    1e3,
    0
  ];
  frequencies.forEach((freq) => {
    const span = document.createElement("span");
    span.textContent = freq >= 1e3 ? `${(freq / 1e3).toFixed(freq % 1e3 === 0 ? 0 : 1)}k` : `${Math.round(freq)}Hz`;
    labelsElement.appendChild(span);
  });
}

// src/PlayerState.js
async function decodeArrayBuffer(arrayBuffer) {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext wird von diesem Browser nicht unterst\xFCtzt.");
  const ctx = new Ctor();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close?.().catch(() => {
    });
  }
}
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
var PlayerState = class {
  constructor(container, WaveSurfer, emitHostEvent = null, options = {}) {
    if (!container) throw new Error("PlayerState: container element required");
    if (!WaveSurfer) throw new Error("PlayerState: WaveSurfer reference required");
    this.container = container;
    this.d = this._queryDom(container);
    this.WaveSurfer = WaveSurfer;
    this._emitHostEvent = typeof emitHostEvent === "function" ? emitHostEvent : null;
    this.options = options || {};
    this._viewMode = this.options.viewMode === "waveform" || this.options.viewMode === "spectrogram" ? this.options.viewMode : "both";
    this._showWaveform = this._viewMode !== "spectrogram";
    this._showSpectrogram = this._viewMode !== "waveform";
    this._showOverview = this.options.showOverview !== false;
    this._transportOverlay = this.options.transportOverlay === true;
    this._compactToolbarMode = ["auto", "on", "off"].includes(this.options.compactToolbar) ? this.options.compactToolbar : "auto";
    this._compactToolbarOpen = false;
    this._compactToolbarLayoutRaf = 0;
    this._showWaveformTimeline = this.options.showWaveformTimeline !== false && !(this.options.transportOverlay && this._viewMode === "waveform");
    this._playbackViewportConfig = this._sanitizePlaybackViewportConfig(this.options || {});
    this.processor = createSpectrogramProcessor();
    this.colorizer = new GpuColorizer();
    this.audioBuffer = null;
    this.wavesurfer = null;
    this.spectrogramData = null;
    this.spectrogramFrames = 0;
    this.spectrogramMels = 0;
    this.spectrogramBaseCanvas = null;
    this.spectrogramGrayInfo = null;
    this._gpuReady = false;
    this.spectrogramAbsLogMin = 0;
    this.spectrogramAbsLogMax = 1;
    this.sampleRateHz = 32e3;
    this.audioHash = null;
    this.amplitudePeakAbs = 1;
    this.currentColorScheme = this.d.colorSchemeSelect.value || "fire";
    this.volume = 0.8;
    this.muted = false;
    this.preMuteVolume = 0.8;
    this.pixelsPerSecond = DEFAULT_ZOOM_PPS;
    this._zoomRedrawRafId = 0;
    this.scrollSyncLock = false;
    this.windowStartNorm = 0;
    this.windowEndNorm = 1;
    this.followMode = "follow";
    this.followPlayback = true;
    this.loopPlayback = false;
    this.playbackMode = "normal";
    this.transportState = "";
    this._activeSegmentLabelId = null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = null;
    this._activeSegmentEnd = null;
    this._suppressNextPauseHandler = false;
    this._segmentPlayToken = 0;
    this._customSegmentPlayback = null;
    this._smoothSeekFocusUntil = 0;
    this._lastTimeupdateEmitAt = 0;
    this._lastSelectionEmitAt = 0;
    this._lastSelectionStart = NaN;
    this._lastSelectionEnd = NaN;
    this._lastViewRangeTextStart = NaN;
    this._lastViewRangeTextEnd = NaN;
    this._lastTimeReadoutText = "";
    this._uiFrameId = 0;
    this._uiPending = null;
    this._followCatchupRafId = 0;
    this._followCatchupAnim = null;
    this._perf = {
      enabled: false,
      panel: null,
      intervalId: 0,
      frames: 0,
      fps: 0,
      lastFrameTs: 0,
      longFrames: 0,
      maxFrameMs: 0,
      uiFlushes: 0,
      timeupdateEvents: 0,
      selectionEvents: 0,
      seekEvents: 0,
      transitionEvents: 0,
      blockedTransitions: 0,
      lastTransition: ""
    };
    this.draggingPlayhead = false;
    this.draggingPlayheadSource = null;
    this.draggingViewport = false;
    this.viewportPanStartX = 0;
    this.viewportPanStartScroll = 0;
    this.suppressSeekClick = false;
    this._blockSeekClickUntil = 0;
    this.overviewMode = null;
    this.overviewDragStartX = 0;
    this.overviewDragStart = 0;
    this.overviewDragEnd = 1;
    this._overviewDragMoved = false;
    this._overviewSuppressClickUntil = 0;
    this._overviewViewportRafId = 0;
    this._overviewNeedsFinalRedraw = false;
    this.waveformDisplayHeight = DEFAULT_WAVEFORM_HEIGHT;
    this.spectrogramDisplayHeight = DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT;
    this.viewResizeMode = null;
    this.viewResizeStartY = 0;
    this.viewResizeStartWaveformHeight = DEFAULT_WAVEFORM_HEIGHT;
    this.viewResizeStartSpectrogramHeight = DEFAULT_SPECTROGRAM_DISPLAY_HEIGHT;
    this._viewResizeFrameId = 0;
    this._viewResizeNeedsWaveformRedraw = false;
    this._viewResizeNeedsSpectrogramRedraw = false;
    this._applyLocalViewHeights();
    this._updateAmplitudeLabels();
    this._setInitialPlayheadPositions();
    this._updateToggleButtons();
    this._updateAriaPlaybackPosition(0);
    this._setCompactToolbarOpen(false);
    this._setTransportState("idle", "init");
    this._initPerfOverlay();
    this._cleanups = [];
    this._bindEvents();
    if (this.options.enableTouchGestures !== false) {
      this._bindTouchGestures();
    }
    this._refreshCompactToolbarLayout();
    requestAnimationFrame(() => this._refreshCompactToolbarLayout());
  }
  _emit(event, detail = {}) {
    if (!this._emitHostEvent) return;
    this._emitHostEvent(event, detail);
  }
  _sanitizePlaybackViewportConfig(partial = {}) {
    const cfg = this._playbackViewportConfig || {};
    return {
      followGuardLeftRatio: clampNumber(partial.followGuardLeftRatio, 0.05, 0.95, cfg.followGuardLeftRatio ?? 0.35),
      followGuardRightRatio: clampNumber(partial.followGuardRightRatio, 0.05, 0.95, cfg.followGuardRightRatio ?? 0.65),
      followTargetRatio: clampNumber(partial.followTargetRatio, 0.1, 0.9, cfg.followTargetRatio ?? 0.5),
      followCatchupDurationMs: clampNumber(partial.followCatchupDurationMs, 80, 2500, cfg.followCatchupDurationMs ?? 240),
      followCatchupSeekDurationMs: clampNumber(partial.followCatchupSeekDurationMs, 100, 3e3, cfg.followCatchupSeekDurationMs ?? 360),
      smoothLerp: clampNumber(partial.smoothLerp, 0.02, 0.95, cfg.smoothLerp ?? 0.18),
      smoothSeekLerp: clampNumber(partial.smoothSeekLerp, 0.01, 0.9, cfg.smoothSeekLerp ?? 0.08),
      smoothMinStepRatio: clampNumber(partial.smoothMinStepRatio, 1e-3, 0.25, cfg.smoothMinStepRatio ?? 0.03),
      smoothSeekMinStepRatio: clampNumber(partial.smoothSeekMinStepRatio, 1e-3, 0.2, cfg.smoothSeekMinStepRatio ?? 8e-3),
      smoothSeekFocusMs: clampNumber(partial.smoothSeekFocusMs, 150, 5e3, cfg.smoothSeekFocusMs ?? 1400)
    };
  }
  updatePlaybackViewportConfig(partial = {}) {
    this._playbackViewportConfig = this._sanitizePlaybackViewportConfig(partial);
    if (this._playbackViewportConfig.followGuardLeftRatio >= this._playbackViewportConfig.followGuardRightRatio) {
      this._playbackViewportConfig.followGuardLeftRatio = 0.35;
      this._playbackViewportConfig.followGuardRightRatio = 0.65;
    }
    this._emit("followconfigchange", { ...this._playbackViewportConfig });
    return { ...this._playbackViewportConfig };
  }
  getPlaybackViewportConfig() {
    return { ...this._playbackViewportConfig };
  }
  _initPerfOverlay() {
    const byOption = this.options?.enablePerfOverlay === true;
    let byQuery = false;
    try {
      const params = new URLSearchParams(window.location.search || "");
      byQuery = params.get("perf") === "1";
    } catch {
      byQuery = false;
    }
    if (!byOption && !byQuery) return;
    this._perf.enabled = true;
    const panel = document.createElement("div");
    panel.className = "abp-perf-overlay";
    panel.style.position = "absolute";
    panel.style.top = "8px";
    panel.style.right = "8px";
    panel.style.left = "auto";
    panel.style.bottom = "auto";
    panel.style.transform = "none";
    panel.style.zIndex = "60";
    panel.innerHTML = `
            <div class="abp-perf-title">PERF</div>
            <div class="abp-perf-body">Initializing...</div>
        `;
    this.container.appendChild(panel);
    this._perf.panel = panel;
    this._perf.intervalId = window.setInterval(() => {
      this._renderPerfOverlay();
    }, 500);
  }
  _perfOnFrame(ts) {
    if (!this._perf.enabled) return;
    this._perf.frames += 1;
    if (this._perf.lastFrameTs > 0) {
      const frameMs = ts - this._perf.lastFrameTs;
      if (frameMs > 0) {
        const fps = 1e3 / frameMs;
        this._perf.fps = this._perf.fps <= 0 ? fps : this._perf.fps * 0.85 + fps * 0.15;
      }
      this._perf.maxFrameMs = Math.max(this._perf.maxFrameMs, frameMs);
      if (frameMs > 32) this._perf.longFrames += 1;
    }
    this._perf.lastFrameTs = ts;
  }
  _renderPerfOverlay() {
    if (!this._perf.enabled || !this._perf.panel) return;
    const body = this._perf.panel.querySelector(".abp-perf-body");
    if (!body) return;
    body.innerHTML = [
      `state: ${this.transportState || "n/a"}`,
      `fps: ${this._perf.fps.toFixed(1)} | long>${32}ms: ${this._perf.longFrames}`,
      `max frame: ${this._perf.maxFrameMs.toFixed(1)}ms | ui flushes: ${this._perf.uiFlushes}`,
      `timeupdate: ${this._perf.timeupdateEvents} | selection: ${this._perf.selectionEvents} | seek: ${this._perf.seekEvents}`,
      `transitions: ${this._perf.transitionEvents} | blocked: ${this._perf.blockedTransitions}`,
      `last: ${this._perf.lastTransition || "-"}`
    ].join("<br>");
    this._perf.uiFlushes = 0;
    this._perf.timeupdateEvents = 0;
    this._perf.selectionEvents = 0;
    this._perf.seekEvents = 0;
    this._perf.maxFrameMs = 0;
  }
  _setTransportState(nextState, reason = "") {
    if (!nextState || this.transportState === nextState) return;
    const fromState = this.transportState || "";
    if (!canTransitionTransportState(fromState, nextState)) {
      this._perf.blockedTransitions += 1;
      this._emit("transporttransitionblocked", { from: fromState, to: nextState, reason });
    }
    this.transportState = nextState;
    this._perf.transitionEvents += 1;
    this._perf.lastTransition = `${fromState || "\u2205"} \u2192 ${nextState}${reason ? ` (${reason})` : ""}`;
    this._setPlayState(TRANSPORT_STATE_LABELS[nextState] || nextState);
    this._emit("transportstatechange", { state: nextState, reason });
  }
  _scheduleUiUpdate({
    time = this._getCurrentTime(),
    fromPlayback = false,
    centerView = false,
    emitSeek = false,
    immediate = false
  } = {}) {
    this._uiPending = this._uiPending || {
      time: 0,
      fromPlayback: false,
      centerView: false,
      emitSeek: false
    };
    this._uiPending.time = time;
    this._uiPending.fromPlayback = fromPlayback;
    this._uiPending.centerView = this._uiPending.centerView || centerView;
    this._uiPending.emitSeek = this._uiPending.emitSeek || emitSeek;
    if (immediate) {
      if (this._uiFrameId) {
        cancelAnimationFrame(this._uiFrameId);
        this._uiFrameId = 0;
      }
      this._flushUiUpdate(performance.now());
      return;
    }
    if (this._uiFrameId) return;
    this._uiFrameId = requestAnimationFrame((ts) => this._flushUiUpdate(ts));
  }
  _flushUiUpdate(_ts) {
    this._uiFrameId = 0;
    const pending = this._uiPending;
    this._uiPending = null;
    if (!pending || !this.audioBuffer) return;
    this._perfOnFrame(_ts);
    this._perf.uiFlushes += 1;
    const duration = Math.max(0, this.audioBuffer.duration || 0);
    const t = Math.max(0, Math.min(pending.time || 0, duration || pending.time || 0));
    this._updateTimeReadout(t);
    this._updatePlayhead(t, pending.fromPlayback);
    if (pending.centerView) this._centerViewportAtTime(t);
    if (pending.emitSeek) {
      this._perf.seekEvents += 1;
      this._emit("seek", {
        currentTime: t,
        duration: this.audioBuffer?.duration || 0
      });
    }
  }
  // ═════════════════════════════════════════════════════════════════
  //  DOM Query (scoped to container)
  // ═════════════════════════════════════════════════════════════════
  _queryDom(root) {
    const q = (id) => root.querySelector(`#${id}`);
    return {
      openFileBtn: q("openFileBtn"),
      toolbarRoot: q("toolbarRoot"),
      compactMoreBtn: q("compactMoreBtn"),
      toolbarSecondary: q("toolbarSecondary"),
      audioFile: q("audioFile"),
      playPauseBtn: q("playPauseBtn"),
      stopBtn: q("stopBtn"),
      jumpStartBtn: q("jumpStartBtn"),
      jumpEndBtn: q("jumpEndBtn"),
      backwardBtn: q("backwardBtn"),
      forwardBtn: q("forwardBtn"),
      followToggleBtn: q("followToggleBtn"),
      loopToggleBtn: q("loopToggleBtn"),
      fitViewBtn: q("fitViewBtn"),
      resetViewBtn: q("resetViewBtn"),
      currentTimeDisplay: q("currentTime"),
      totalTimeDisplay: q("totalTime"),
      playStateDisplay: q("playState"),
      viewRangeDisplay: q("viewRange"),
      spectrogramCanvas: q("spectrogramCanvas"),
      spectrogramContainer: q("spectrogramContainer"),
      waveformContainer: q("waveformContainer"),
      waveformWrapper: q("waveformWrapper"),
      waveformContent: q("waveformContent"),
      amplitudeLabels: q("amplitudeLabels"),
      amplitudeCanvas: q("amplitudeCanvas"),
      waveformTimelineCanvas: q("waveformTimelineCanvas"),
      waveformPlayhead: q("waveformPlayhead"),
      audioEngineHost: q("audioEngineHost"),
      playhead: q("playhead"),
      canvasWrapper: q("canvasWrapper"),
      viewSplitHandle: q("viewSplitHandle"),
      spectrogramResizeHandle: q("spectrogramResizeHandle"),
      overviewCanvas: q("overviewCanvas"),
      overviewContainer: q("overviewContainer"),
      overviewWindow: q("overviewWindow"),
      overviewHandleLeft: q("overviewHandleLeft"),
      overviewHandleRight: q("overviewHandleRight"),
      fileInfo: q("fileInfo"),
      sampleRateInfo: q("sampleRateInfo"),
      fftSizeSelect: q("fftSize"),
      zoomSlider: q("zoomSlider"),
      zoomValue: q("zoomValue"),
      maxFreqSelect: q("maxFreqSelect"),
      colorSchemeSelect: q("colorSchemeSelect"),
      freqLabels: q("freqLabels"),
      volumeToggleBtn: q("volumeToggleBtn"),
      volumeIcon: q("volumeIcon"),
      volumeWaves: q("volumeWaves"),
      volumeSlider: q("volumeSlider"),
      floorSlider: q("floorSlider"),
      ceilSlider: q("ceilSlider"),
      autoContrastBtn: q("autoContrastBtn"),
      autoFreqBtn: q("autoFreqBtn")
    };
  }
  // ═════════════════════════════════════════════════════════════════
  //  Disposal
  // ═════════════════════════════════════════════════════════════════
  dispose() {
    this._stopCustomSegmentPlayback("stopped", this._getCurrentTime());
    this._cancelFollowCatchupAnimation();
    if (this._viewResizeFrameId) {
      cancelAnimationFrame(this._viewResizeFrameId);
      this._viewResizeFrameId = 0;
    }
    if (this._uiFrameId) {
      cancelAnimationFrame(this._uiFrameId);
      this._uiFrameId = 0;
    }
    if (this._zoomRedrawRafId) {
      cancelAnimationFrame(this._zoomRedrawRafId);
      this._zoomRedrawRafId = 0;
    }
    if (this._overviewViewportRafId) {
      cancelAnimationFrame(this._overviewViewportRafId);
      this._overviewViewportRafId = 0;
    }
    if (this._compactToolbarLayoutRaf) {
      cancelAnimationFrame(this._compactToolbarLayoutRaf);
      this._compactToolbarLayoutRaf = 0;
    }
    if (this._perf.intervalId) {
      clearInterval(this._perf.intervalId);
      this._perf.intervalId = 0;
    }
    if (this._perf.panel?.parentNode) {
      this._perf.panel.parentNode.removeChild(this._perf.panel);
      this._perf.panel = null;
    }
    for (let i = this._cleanups.length - 1; i >= 0; i--) this._cleanups[i]();
    this._cleanups.length = 0;
    this.processor.dispose();
    this.colorizer.dispose();
  }
  // ═════════════════════════════════════════════════════════════════
  //  File Loading
  // ═════════════════════════════════════════════════════════════════
  async _handleFileSelect(e) {
    const file = e?.target?.files?.[0];
    if (!file) return;
    this.d.fileInfo.innerHTML = `<span class="statusbar-label">${file.name}</span>`;
    this.d.fileInfo.classList.add("loading");
    this._setTransportState("loading", "file-load");
    try {
      const fileBuffer = await file.arrayBuffer();
      const audioBuffer = await decodeArrayBuffer(fileBuffer);
      this.audioBuffer = audioBuffer;
      this.sampleRateHz = audioBuffer.sampleRate;
      this.audioHash = await sha256ArrayBuffer(fileBuffer).catch(() => null);
      this.amplitudePeakAbs = computeAmplitudePeak(audioBuffer.getChannelData(0));
      this._updateAmplitudeLabels();
      this.d.fileInfo.innerHTML = `<span class="statusbar-label">${file.name}</span> <span>${formatTime(audioBuffer.duration)}</span>`;
      this.d.sampleRateInfo.textContent = `${audioBuffer.sampleRate} Hz`;
      this.d.totalTimeDisplay.textContent = formatTime(audioBuffer.duration);
      this.d.currentTimeDisplay.textContent = formatTime(0);
      this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, false);
      this._setTransportEnabled(true);
      this._updateToggleButtons();
      this._setTransportState("ready", "file-loaded");
      this.d.fileInfo.classList.remove("loading");
      this._setupWaveSurfer(file);
      await this._generateSpectrogram();
      this._drawMainWaveform();
      this._drawOverviewWaveform();
      this._createFrequencyLabels();
      this._seekToTime(0, true);
    } catch (error) {
      console.error("Fehler beim Laden der Datei:", error);
      this._setTransportState("error", "file-load-failed");
      this.d.fileInfo.classList.remove("loading");
      this._emit("error", { message: error?.message || String(error), source: "file" });
      alert("Fehler beim Laden der Audio-Datei");
    }
  }
  // ═════════════════════════════════════════════════════════════════
  //  Load from URL (programmatic)
  // ═════════════════════════════════════════════════════════════════
  async loadUrl(url) {
    this.d.fileInfo.innerHTML = `<span class="statusbar-label">Loading\u2026</span>`;
    this.d.fileInfo.classList.add("loading");
    this._setTransportState("loading", "url-load");
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await decodeArrayBuffer(arrayBuffer);
      this.audioBuffer = audioBuffer;
      this.sampleRateHz = audioBuffer.sampleRate;
      this.audioHash = await sha256ArrayBuffer(arrayBuffer).catch(() => null);
      this.amplitudePeakAbs = computeAmplitudePeak(audioBuffer.getChannelData(0));
      this._updateAmplitudeLabels();
      const name = decodeURIComponent(
        new URL(url, location.href).pathname.split("/").pop() || "audio"
      );
      this.d.fileInfo.innerHTML = `<span class="statusbar-label">${name}</span> <span>${formatTime(audioBuffer.duration)}</span>`;
      this.d.sampleRateInfo.textContent = `${audioBuffer.sampleRate} Hz`;
      this.d.totalTimeDisplay.textContent = formatTime(audioBuffer.duration);
      this.d.currentTimeDisplay.textContent = formatTime(0);
      this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, false);
      this._setTransportEnabled(true);
      this._updateToggleButtons();
      this._setTransportState("ready", "url-loaded");
      this.d.fileInfo.classList.remove("loading");
      this._setupWaveSurfer(url);
      await this._generateSpectrogram();
      this._drawMainWaveform();
      this._drawOverviewWaveform();
      this._createFrequencyLabels();
      this._seekToTime(0, true);
    } catch (error) {
      console.error("Error loading audio URL:", error);
      this._setTransportState("error", "url-load-failed");
      this.d.fileInfo.classList.remove("loading");
      this._emit("error", { message: error?.message || String(error), source: "url" });
    }
  }
  // ═════════════════════════════════════════════════════════════════
  //  WaveSurfer Engine
  // ═════════════════════════════════════════════════════════════════
  _setupWaveSurfer(source) {
    if (this.wavesurfer) this.wavesurfer.destroy();
    const ws = this.WaveSurfer.create({
      container: this.d.audioEngineHost,
      height: 1,
      waveColor: "#38bdf8",
      progressColor: "#0ea5e9",
      cursorColor: "#ef4444",
      normalize: true,
      minPxPerSec: this.pixelsPerSecond,
      autoScroll: false,
      autoCenter: false
    });
    if (typeof source === "string") {
      ws.load(source);
    } else {
      ws.loadBlob(source);
    }
    ws.on("ready", () => {
      ws.zoom(this.pixelsPerSecond);
      ws.setVolume(this.volume);
      this._seekToTime(0, true);
      this._lastTimeupdateEmitAt = 0;
      this._lastSelectionEmitAt = 0;
      this._lastSelectionStart = NaN;
      this._lastSelectionEnd = NaN;
    });
    ws.on("timeupdate", (t) => {
      this._perf.timeupdateEvents += 1;
      this._scheduleUiUpdate({ time: t, fromPlayback: true });
      const now = performance.now();
      if (now - this._lastTimeupdateEmitAt >= 66) {
        this._lastTimeupdateEmitAt = now;
        this._emit("timeupdate", {
          currentTime: t,
          duration: this.audioBuffer?.duration || 0
        });
      }
    });
    ws.on("play", () => {
      this.d.playPauseBtn.classList.add("playing");
      if (this.playbackMode === "segment") {
        this._setTransportState("playing_segment", "engine-play");
        return;
      }
      this._setTransportState(this.loopPlayback ? "playing_loop" : "playing", "engine-play");
    });
    ws.on("pause", () => {
      if (this._suppressNextPauseHandler) {
        this._suppressNextPauseHandler = false;
        return;
      }
      this.d.playPauseBtn.classList.remove("playing");
      if (this.playbackMode === "segment" && this._activeSegmentEnd != null) {
        this._setTransportState("paused_segment", "engine-pause");
      } else if (this.audioBuffer) {
        const atEnd = ws.getCurrentTime() >= this.audioBuffer.duration - 0.01;
        this._setTransportState(atEnd ? "stopped" : "paused", "engine-pause");
      } else {
        this._setTransportState("paused", "engine-pause");
      }
    });
    ws.on("finish", () => {
      if (this.playbackMode === "segment") {
        this.playbackMode = "normal";
        this._activeSegmentLabelId = null;
        this._activeSegmentFilter = null;
        this._activeSegmentStart = null;
        this._activeSegmentEnd = null;
        this._segmentPlayToken++;
      }
      if (this.loopPlayback) {
        this._seekToTime(0, this.followPlayback);
        ws.play();
        return;
      }
      this.d.playPauseBtn.classList.remove("playing");
      this._setTransportState("stopped", "engine-finish");
      if (this.audioBuffer) this._scheduleUiUpdate({ time: this.audioBuffer.duration, fromPlayback: false, immediate: true });
    });
    this.wavesurfer = ws;
  }
  // ═════════════════════════════════════════════════════════════════
  //  Transport Controls
  // ═════════════════════════════════════════════════════════════════
  _togglePlayPause() {
    if (this._customSegmentPlayback) {
      this._stopCustomSegmentPlayback("paused", this._customSegmentPlayback.currentTimeSec);
      return;
    }
    this.playbackMode = "normal";
    this._activeSegmentLabelId = null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = null;
    this._activeSegmentEnd = null;
    this._segmentPlayToken++;
    if (this.wavesurfer && this.audioBuffer) this.wavesurfer.playPause();
  }
  _stopPlayback() {
    if (this._customSegmentPlayback) {
      this._stopCustomSegmentPlayback("stopped", 0);
    }
    if (!this.wavesurfer) return;
    this.playbackMode = "normal";
    this._activeSegmentLabelId = null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = null;
    this._activeSegmentEnd = null;
    this._segmentPlayToken++;
    this.wavesurfer.pause();
    this._seekToTime(0, true);
    this._setTransportState("stopped", "stop-control");
    this.d.playPauseBtn.classList.remove("playing");
  }
  playSegment(startSec, endSec, options = {}) {
    if (!this.audioBuffer || !this.wavesurfer) return;
    this._clearPlaybackFilter();
    const dur = this.audioBuffer.duration;
    const start = Math.max(0, Math.min(startSec, dur));
    const end = Math.max(0, Math.min(endSec, dur));
    if (end - start < 0.01) return;
    const token = ++this._segmentPlayToken;
    this.playbackMode = "segment";
    this._activeSegmentLabelId = options?.labelId || null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = start;
    this._activeSegmentEnd = end;
    if (this.wavesurfer.isPlaying()) {
      this._suppressNextPauseHandler = true;
      this.wavesurfer.pause();
    }
    this._seekToTime(start, false);
    if (token !== this._segmentPlayToken) return;
    const runPlay = () => {
      if (token !== this._segmentPlayToken) return;
      try {
        if (this.loopPlayback) {
          this._seekToTime(start, false, { allowCustomPlayback: true });
          this.wavesurfer.play();
          this._emit("segmentplaystart", { start, end, loop: true });
          return;
        }
        const maybePromise = this.wavesurfer.play(start, end);
        this._emit("segmentplaystart", { start, end });
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.catch(() => {
            if (token !== this._segmentPlayToken) return;
            this._seekToTime(start, false);
            this.wavesurfer?.play();
          });
        }
      } catch {
        if (token !== this._segmentPlayToken) return;
        this._seekToTime(start, false);
        this.wavesurfer?.play();
        this._emit("segmentplaystart", { start, end });
      }
    };
    try {
      window.requestAnimationFrame(runPlay);
    } catch {
      runPlay();
    }
  }
  playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options = {}) {
    if (!this.audioBuffer) return;
    const dur = this.audioBuffer.duration;
    const start = Math.max(0, Math.min(startSec, dur));
    const end = Math.max(0, Math.min(endSec, dur));
    if (end - start < 0.01) return;
    const nyquist = Math.max(100, this.audioBuffer.sampleRate * 0.5 - 10);
    const fLo = Math.max(20, Math.min(freqMinHz, freqMaxHz, nyquist - 5));
    const fHi = Math.max(fLo + 5, Math.min(Math.max(freqMinHz, freqMaxHz), nyquist));
    const center = Math.sqrt(fLo * fHi);
    const bandwidth = Math.max(10, fHi - fLo);
    const q = Math.max(0.25, Math.min(40, center / bandwidth));
    this._stopCustomSegmentPlayback("stopped", start);
    this._clearPlaybackFilter();
    if (this.wavesurfer?.isPlaying()) {
      this._suppressNextPauseHandler = true;
      this.wavesurfer.pause();
    }
    this._seekToTime(start, false, { allowCustomPlayback: true });
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      this.playSegment(start, end, { labelId: options?.labelId });
      return;
    }
    const token = ++this._segmentPlayToken;
    this.playbackMode = "segment";
    this._activeSegmentLabelId = options?.labelId || null;
    this._activeSegmentStart = start;
    this._activeSegmentEnd = end;
    this._activeSegmentFilter = {
      type: "bandpass",
      freqMinHz: fLo,
      freqMaxHz: fHi
    };
    const ctx = new Ctor();
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = center;
    bandpass.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : this.volume;
    bandpass.connect(gain);
    gain.connect(ctx.destination);
    const playback = {
      token,
      ctx,
      source: null,
      bandpass,
      gain,
      startSec: start,
      endSec: end,
      startAtCtx: 0,
      runStartSec: start,
      sourceGeneration: 0,
      rafId: 0,
      currentTimeSec: start
    };
    this._customSegmentPlayback = playback;
    this._startCustomSegmentSource(playback);
    this._setTransportState("playing_segment", "bandpass-segment-start");
    this._emit("segmentplaystart", { start, end, filter: { type: "bandpass", freqMinHz: fLo, freqMaxHz: fHi } });
    const onFrame = () => {
      if (!this._customSegmentPlayback || this._customSegmentPlayback.token !== token) return;
      const elapsed = Math.max(0, ctx.currentTime - playback.startAtCtx);
      const t = Math.min(playback.endSec, playback.runStartSec + elapsed);
      playback.currentTimeSec = t;
      this._scheduleUiUpdate({ time: t, fromPlayback: true });
      if (t >= playback.endSec - 2e-3) {
        if (this.loopPlayback) {
          this._loopCustomSegmentPlayback(playback);
          playback.rafId = requestAnimationFrame(onFrame);
          return;
        }
        this._stopCustomSegmentPlayback("stopped", playback.endSec, { emitEnd: true });
        return;
      }
      playback.rafId = requestAnimationFrame(onFrame);
    };
    playback.rafId = requestAnimationFrame(onFrame);
  }
  _startCustomSegmentSource(playback, source = null, startAtSec = null) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.sourceGeneration = (playback.sourceGeneration || 0) + 1;
    const generation = playback.sourceGeneration;
    const nextSource = source || playback.ctx.createBufferSource();
    nextSource.buffer = this.audioBuffer;
    nextSource.connect(playback.bandpass);
    nextSource.onended = () => {
      if (!this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
      if (playback.sourceGeneration !== generation) return;
      if (this.loopPlayback) {
        this._loopCustomSegmentPlayback(playback);
        return;
      }
      this._stopCustomSegmentPlayback("stopped", playback.endSec, { emitEnd: true });
    };
    playback.source = nextSource;
    playback.runStartSec = startAtSec == null ? playback.startSec : Math.max(playback.startSec, Math.min(startAtSec, playback.endSec - 1e-3));
    playback.startAtCtx = playback.ctx.currentTime + 5e-3;
    nextSource.start(playback.startAtCtx, playback.runStartSec, playback.endSec - playback.runStartSec);
  }
  _loopCustomSegmentPlayback(playback) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.currentTimeSec = playback.startSec;
    this._scheduleUiUpdate({
      time: playback.startSec,
      fromPlayback: false,
      immediate: true
    });
    this._emit("segmentloop", { start: playback.startSec, end: playback.endSec, filter: "bandpass" });
    this._startCustomSegmentSource(playback);
  }
  updateActiveSegmentFromLabel(label) {
    if (!label || this.playbackMode !== "segment") return;
    const labelId = label.id || null;
    if (this._activeSegmentLabelId && labelId && this._activeSegmentLabelId !== labelId) return;
    const dur = this.audioBuffer?.duration || 0;
    if (dur <= 0) return;
    const start = Math.max(0, Math.min(Number(label.start ?? 0), dur));
    const end = Math.max(start + 0.01, Math.min(Number(label.end ?? start + 0.01), dur));
    this._activeSegmentStart = start;
    this._activeSegmentEnd = end;
    if (this._customSegmentPlayback) {
      this._retargetCustomSegmentPlayback({
        start,
        end,
        freqMinHz: Number(label.freqMin),
        freqMaxHz: Number(label.freqMax)
      });
      return;
    }
    const now = this._getCurrentTime();
    if (now < start || now > end) {
      this._seekToTime(start, false, { allowCustomPlayback: true });
      if (this.loopPlayback && !this.wavesurfer?.isPlaying()) this.wavesurfer?.play();
    }
  }
  _retargetCustomSegmentPlayback({ start, end, freqMinHz, freqMaxHz }) {
    const playback = this._customSegmentPlayback;
    if (!playback || !this.audioBuffer) return;
    playback.startSec = start;
    playback.endSec = end;
    const hasFreq = Number.isFinite(freqMinHz) && Number.isFinite(freqMaxHz);
    if (hasFreq) {
      const nyquist = Math.max(100, this.audioBuffer.sampleRate * 0.5 - 10);
      const fLo = Math.max(20, Math.min(freqMinHz, freqMaxHz, nyquist - 5));
      const fHi = Math.max(fLo + 5, Math.min(Math.max(freqMinHz, freqMaxHz), nyquist));
      const center = Math.sqrt(fLo * fHi);
      const bandwidth = Math.max(10, fHi - fLo);
      const q = Math.max(0.25, Math.min(40, center / bandwidth));
      playback.bandpass.frequency.value = center;
      playback.bandpass.Q.value = q;
      this._activeSegmentFilter = { type: "bandpass", freqMinHz: fLo, freqMaxHz: fHi };
    }
    const desiredStart = Math.max(start, Math.min(playback.currentTimeSec || start, end - 1e-3));
    this._restartCustomSegmentSource(playback, desiredStart);
  }
  _restartCustomSegmentSource(playback, atSec) {
    if (!playback || !this._customSegmentPlayback || this._customSegmentPlayback.token !== playback.token) return;
    playback.sourceGeneration = (playback.sourceGeneration || 0) + 1;
    if (playback.source) {
      playback.source.onended = null;
      try {
        playback.source.stop();
      } catch {
      }
      try {
        playback.source.disconnect();
      } catch {
      }
      playback.source = null;
    }
    playback.currentTimeSec = atSec;
    this._scheduleUiUpdate({ time: atSec, fromPlayback: false, immediate: true });
    this._startCustomSegmentSource(playback, null, atSec);
  }
  _stopCustomSegmentPlayback(reason = "stopped", targetTimeSec = null, options = {}) {
    const active = this._customSegmentPlayback;
    if (!active) return;
    if (active.rafId) cancelAnimationFrame(active.rafId);
    active.rafId = 0;
    if (active.source) {
      active.source.onended = null;
      try {
        active.source.stop();
      } catch {
      }
      try {
        active.source.disconnect();
      } catch {
      }
    }
    try {
      active.bandpass?.disconnect();
    } catch {
    }
    try {
      active.gain.disconnect();
    } catch {
    }
    try {
      active.ctx.close();
    } catch {
    }
    this._customSegmentPlayback = null;
    this._activeSegmentLabelId = null;
    this._activeSegmentFilter = null;
    this._activeSegmentStart = null;
    this._activeSegmentEnd = null;
    this.playbackMode = "normal";
    this._segmentPlayToken++;
    if (Number.isFinite(targetTimeSec)) {
      this._scheduleUiUpdate({ time: targetTimeSec, fromPlayback: false, immediate: true });
    }
    this.d.playPauseBtn.classList.remove("playing");
    this._setTransportState(reason === "paused" ? "paused_segment" : "stopped", "bandpass-segment-stop");
    if (options.emitEnd) {
      this._emit("segmentplayend", { end: targetTimeSec ?? 0 });
    }
  }
  _clearPlaybackFilter() {
    if (!this.wavesurfer) return;
    if (typeof this.wavesurfer.setFilter === "function") {
      try {
        this.wavesurfer.setFilter(null);
      } catch {
      }
    }
  }
  _seekToTime(timeSec, centerView = false, options = {}) {
    if (!this.audioBuffer) return;
    if (options.userInitiated) {
      this._smoothSeekFocusUntil = performance.now() + this._playbackViewportConfig.smoothSeekFocusMs;
    }
    if (this._customSegmentPlayback && options.allowCustomPlayback !== true) {
      this._stopCustomSegmentPlayback("paused", this._customSegmentPlayback.currentTimeSec);
    }
    const t = Math.max(0, Math.min(timeSec, this.audioBuffer.duration));
    if (this.wavesurfer) this.wavesurfer.setTime(t);
    this._scheduleUiUpdate({
      time: t,
      fromPlayback: false,
      centerView,
      emitSeek: true,
      immediate: true
    });
  }
  _seekByDelta(deltaSec) {
    if (!this.audioBuffer) return;
    this._seekToTime(this._getCurrentTime() + deltaSec, false);
  }
  _seekRelative(deltaSec) {
    this._seekByDelta(deltaSec);
  }
  _getCurrentTime() {
    if (this._customSegmentPlayback) return this._customSegmentPlayback.currentTimeSec;
    return this.wavesurfer ? this.wavesurfer.getCurrentTime() : 0;
  }
  _updateTimeReadout(t) {
    const nextText = formatTime(t);
    if (nextText !== this._lastTimeReadoutText) {
      this._lastTimeReadoutText = nextText;
      this.d.currentTimeDisplay.textContent = nextText;
    }
    this._updateAriaPlaybackPosition(t);
  }
  _updateAriaPlaybackPosition(currentTimeSec) {
    const slider = this.d.canvasWrapper;
    if (!slider) return;
    const duration = this.audioBuffer?.duration || 0;
    const now = Math.max(0, Math.min(currentTimeSec || 0, duration || currentTimeSec || 0));
    slider.setAttribute("aria-valuemin", "0");
    slider.setAttribute("aria-valuemax", String(duration.toFixed(3)));
    slider.setAttribute("aria-valuenow", String(now.toFixed(3)));
    slider.setAttribute("aria-valuetext", `${formatTime(now)} of ${formatTime(duration)}`);
  }
  // ═════════════════════════════════════════════════════════════════
  //  Playhead & Follow
  // ═════════════════════════════════════════════════════════════════
  _updatePlayhead(currentTime, fromPlayback) {
    if (!this.audioBuffer) return;
    const duration = Math.max(1e-3, this.audioBuffer.duration);
    const canvasWidth = Math.max(1, this.d.spectrogramCanvas.width || this.d.amplitudeCanvas.width || 0);
    const position = currentTime / duration * canvasWidth;
    this.d.playhead.style.transform = `translateX(${position}px)`;
    this.d.waveformPlayhead.style.transform = `translateX(${position}px)`;
    if (fromPlayback && this.followPlayback && this.wavesurfer?.isPlaying()) {
      const vw = this._getViewportWidth();
      if (this.followMode === "smooth") {
        this._applySmoothFollow(position, vw);
      } else {
        const scrollLeft = this._getPrimaryScrollLeft();
        const guardLeft = scrollLeft + vw * this._playbackViewportConfig.followGuardLeftRatio;
        const guardRight = scrollLeft + vw * this._playbackViewportConfig.followGuardRightRatio;
        if (position < guardLeft || position > guardRight) {
          this._animateFollowCatchupTo(Math.max(0, position - vw * this._playbackViewportConfig.followTargetRatio));
        }
      }
    }
    this._syncOverviewWindowToViewport();
    if (!this._customSegmentPlayback && this._activeSegmentEnd != null && currentTime >= this._activeSegmentEnd - 5e-3) {
      const start = this._activeSegmentStart ?? 0;
      const end = this._activeSegmentEnd;
      if (this.loopPlayback && this.wavesurfer?.isPlaying()) {
        this._seekToTime(start, false, { allowCustomPlayback: true });
        this._emit("segmentloop", { start, end, filter: "none" });
        return;
      }
      this._activeSegmentStart = null;
      this._activeSegmentLabelId = null;
      this._activeSegmentFilter = null;
      this._activeSegmentEnd = null;
      this.playbackMode = "normal";
      this._segmentPlayToken++;
      this._suppressNextPauseHandler = true;
      this.wavesurfer?.pause();
      this._seekToTime(end, false);
      this.d.playPauseBtn.classList.remove("playing");
      this._setTransportState("stopped", "segment-end");
      this._emit("segmentplayend", { end });
    }
  }
  // ═════════════════════════════════════════════════════════════════
  //  Spectrogram Pipeline
  // ═════════════════════════════════════════════════════════════════
  async _generateSpectrogram() {
    if (!this.audioBuffer) return;
    this._setTransportState("rendering", "spectrogram-generate");
    const options = {
      fftSize: parseInt(this.d.fftSizeSelect.value, 10),
      sampleRate: this.audioBuffer.sampleRate,
      frameRate: PERCH_FRAME_RATE,
      nMels: PERCH_N_MELS,
      pcenGain: PERCH_PCEN_GAIN,
      pcenBias: PERCH_PCEN_BIAS,
      pcenRoot: PERCH_PCEN_ROOT,
      pcenSmoothing: PERCH_PCEN_SMOOTHING
    };
    try {
      const channelData = this.audioBuffer.getChannelData(0);
      let result;
      let fromCache = false;
      let cacheEntry = null;
      const cacheKey = this.audioHash ? buildSpectrogramCacheKey({
        fileHash: this.audioHash,
        ...options
      }) : null;
      if (cacheKey) {
        const cached = await getSpectrogramCacheEntry(cacheKey);
        cacheEntry = cached;
        if (cached?.spectrogramData && cached?.nFrames && cached?.nMels) {
          this._emit("cachehit", { cacheKey });
          result = {
            data: new Float32Array(cached.spectrogramData),
            nFrames: cached.nFrames,
            nMels: cached.nMels
          };
          fromCache = true;
          this.spectrogramAbsLogMin = cached.absLogMin ?? 0;
          this.spectrogramAbsLogMax = cached.absLogMax ?? 1;
          if (Number.isFinite(cached.floorPct) && Number.isFinite(cached.ceilPct)) {
            this.d.floorSlider.value = Math.round(cached.floorPct);
            this.d.ceilSlider.value = Math.round(cached.ceilPct);
          }
          if (Number.isFinite(cached.maxFreq)) {
            const optionsList = Array.from(this.d.maxFreqSelect.options);
            let best = optionsList[optionsList.length - 1];
            for (const opt of optionsList) {
              if (parseFloat(opt.value) >= cached.maxFreq) {
                best = opt;
                break;
              }
            }
            this.d.maxFreqSelect.value = best.value;
          }
        } else {
          this._emit("cachemiss", { cacheKey });
        }
      }
      const shouldUseProgressive = this.options.enableProgressiveSpectrogram === true && this.audioBuffer.duration >= PROGRESSIVE_MIN_DURATION_SEC && typeof this.processor.computeProgressive === "function";
      if (!result) {
        if (shouldUseProgressive) {
          const chunkResults = [];
          for await (const progress of this.processor.computeProgressive(channelData, {
            ...options,
            chunkSeconds: PROGRESSIVE_CHUNK_SECONDS
          })) {
            chunkResults.push(progress.result);
            this._emit("progress", {
              chunk: progress.chunk,
              totalChunks: progress.totalChunks,
              percent: progress.percent
            });
          }
          result = this._mergeProgressiveResults(chunkResults, options.nMels);
        } else {
          result = await this.processor.compute(channelData, options);
        }
      }
      this.spectrogramData = result.data;
      this.spectrogramFrames = result.nFrames;
      this.spectrogramMels = result.nMels;
      if (!fromCache) {
        this._updateSpectrogramStats();
        this._autoContrast();
        this._autoFrequency();
      }
      const cachedGray = cacheEntry?.grayscaleTexture;
      const selectedMaxFreq = parseFloat(this.d.maxFreqSelect.value);
      const canReuseGray = fromCache && cachedGray && Number.isFinite(cachedGray.maxFreq) && Math.abs(cachedGray.maxFreq - selectedMaxFreq) < 1e-6 && cachedGray.width > 0 && cachedGray.height > 0;
      if (canReuseGray) {
        this.spectrogramGrayInfo = {
          gray: new Uint8Array(cachedGray.gray),
          width: cachedGray.width,
          height: cachedGray.height
        };
        if (this.colorizer.ok) {
          const { gray, width, height } = this.spectrogramGrayInfo;
          this._gpuReady = this.colorizer.uploadGrayscale(gray, width, height);
        } else {
          this._gpuReady = false;
        }
      } else {
        this._buildSpectrogramGrayscale();
      }
      this._buildSpectrogramBaseImage();
      this._drawSpectrogram();
      this._syncOverviewWindowToViewport();
      this._setTransportState("ready", "spectrogram-ready");
      if (cacheKey && this.spectrogramData?.length) {
        const cacheWriteOk = await putSpectrogramCacheEntry({
          cacheKey,
          createdAt: Date.now(),
          nFrames: this.spectrogramFrames,
          nMels: this.spectrogramMels,
          absLogMin: this.spectrogramAbsLogMin,
          absLogMax: this.spectrogramAbsLogMax,
          floorPct: parseFloat(this.d.floorSlider.value),
          ceilPct: parseFloat(this.d.ceilSlider.value),
          maxFreq: parseFloat(this.d.maxFreqSelect.value),
          spectrogramData: new Float32Array(this.spectrogramData),
          grayscaleTexture: this.spectrogramGrayInfo ? {
            gray: new Uint8Array(this.spectrogramGrayInfo.gray),
            width: this.spectrogramGrayInfo.width,
            height: this.spectrogramGrayInfo.height,
            maxFreq: parseFloat(this.d.maxFreqSelect.value)
          } : null,
          metadata: {
            sampleRate: this.audioBuffer.sampleRate,
            duration: this.audioBuffer.duration,
            fftSize: options.fftSize
          }
        });
        if (cacheWriteOk) this._emit("cachewrite", { cacheKey });
      }
      this._emit("ready", {
        duration: this.audioBuffer.duration,
        sampleRate: this.audioBuffer.sampleRate,
        nFrames: this.spectrogramFrames,
        nMels: this.spectrogramMels
      });
    } catch (error) {
      this._setTransportState("error", "spectrogram-error");
      this._emit("error", { message: error?.message || String(error), source: "spectrogram" });
      throw error;
    }
  }
  _mergeProgressiveResults(chunkResults, nMels) {
    let totalFrames = 0;
    for (const chunk of chunkResults) totalFrames += chunk.nFrames;
    const data = new Float32Array(totalFrames * nMels);
    let frameOffset = 0;
    for (const chunk of chunkResults) {
      data.set(chunk.data, frameOffset * nMels);
      frameOffset += chunk.nFrames;
    }
    return { data, nFrames: totalFrames, nMels };
  }
  _updateSpectrogramStats() {
    const stats = updateSpectrogramStats(this.spectrogramData);
    this.spectrogramAbsLogMin = stats.logMin;
    this.spectrogramAbsLogMax = stats.logMax;
  }
  // ── Auto-Contrast ───────────────────────────────────────────────
  /** Compute optimal floor/ceil from percentiles.
   *  Pass redraw=true when called from a button click. */
  _autoContrast(redraw = false) {
    if (!this.spectrogramData) return;
    const stats = autoContrastStats(this.spectrogramData, 2, 98);
    const range = this.spectrogramAbsLogMax - this.spectrogramAbsLogMin;
    if (range < 1e-8) return;
    const floorPct = Math.max(0, Math.min(
      100,
      (stats.logMin - this.spectrogramAbsLogMin) / range * 100
    ));
    const ceilPct = Math.max(0, Math.min(
      100,
      (stats.logMax - this.spectrogramAbsLogMin) / range * 100
    ));
    this.d.floorSlider.value = Math.round(floorPct);
    this.d.ceilSlider.value = Math.round(ceilPct);
    if (redraw) {
      this._buildSpectrogramBaseImage();
      this._drawSpectrogram();
    }
  }
  // ── Auto-Frequency ──────────────────────────────────────────────
  /** Detect best maxFreq. Pass redraw=true when called from button click. */
  _autoFrequency(redraw = false) {
    if (!this.spectrogramData) return;
    const hzValue = detectMaxFrequency(
      this.spectrogramData,
      this.spectrogramFrames,
      this.spectrogramMels,
      this.sampleRateHz
    );
    const options = Array.from(this.d.maxFreqSelect.options);
    let best = options[options.length - 1];
    for (const opt of options) {
      if (parseFloat(opt.value) >= hzValue) {
        best = opt;
        break;
      }
    }
    this.d.maxFreqSelect.value = best.value;
    this._emit("spectrogramscalechange", { maxFreq: parseFloat(this.d.maxFreqSelect.value) });
    this._createFrequencyLabels();
    if (redraw) {
      this._buildSpectrogramGrayscale();
      this._buildSpectrogramBaseImage();
      this._drawSpectrogram();
    }
  }
  // ── Volume ──────────────────────────────────────────────────────
  _setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.wavesurfer) this.wavesurfer.setVolume(this.volume);
    if (this._customSegmentPlayback?.gain) {
      this._customSegmentPlayback.gain.gain.value = this.muted ? 0 : this.volume;
    }
    this._updateVolumeIcon();
  }
  _toggleMute() {
    if (this.muted) {
      this.muted = false;
      this._setVolume(this.preMuteVolume);
      this.d.volumeSlider.value = Math.round(this.preMuteVolume * 100);
    } else {
      this.preMuteVolume = this.volume;
      this.muted = true;
      if (this.wavesurfer) this.wavesurfer.setVolume(0);
      if (this._customSegmentPlayback?.gain) this._customSegmentPlayback.gain.gain.value = 0;
      this._updateVolumeIcon();
    }
  }
  _updateVolumeIcon() {
    const waves = this.d.volumeWaves;
    const btn = this.d.volumeToggleBtn;
    if (!waves || !btn) return;
    const vol = this.muted ? 0 : this.volume;
    waves.style.display = vol < 0.01 ? "none" : "";
    waves.setAttribute(
      "d",
      vol < 0.4 ? "M15 8.5a4 4 0 010 7" : "M15 8.5a4 4 0 010 7M18 5a9 9 0 010 14"
    );
    btn.classList.toggle("muted", vol < 0.01);
  }
  /** Stage 1 — expensive: PCEN → 8-bit grayscale. Run once per audio/fft/freq change. */
  _buildSpectrogramGrayscale() {
    this.spectrogramGrayInfo = buildSpectrogramGrayscale({
      spectrogramData: this.spectrogramData,
      spectrogramFrames: this.spectrogramFrames,
      spectrogramMels: this.spectrogramMels,
      sampleRateHz: this.sampleRateHz,
      maxFreq: parseFloat(this.d.maxFreqSelect.value),
      spectrogramAbsLogMin: this.spectrogramAbsLogMin,
      spectrogramAbsLogMax: this.spectrogramAbsLogMax
    });
    if (this.spectrogramGrayInfo && this.colorizer.ok) {
      const { gray, width, height } = this.spectrogramGrayInfo;
      this._gpuReady = this.colorizer.uploadGrayscale(gray, width, height);
    } else {
      this._gpuReady = false;
    }
  }
  /** Stage 2 — fast: grayscale → colored canvas.
   *  GPU path: ~0.1 ms.  JS fallback: ~20-80 ms. */
  _buildSpectrogramBaseImage() {
    if (!this.spectrogramGrayInfo) this._buildSpectrogramGrayscale();
    const floor01 = parseFloat(this.d.floorSlider.value) / 100;
    const ceil01 = parseFloat(this.d.ceilSlider.value) / 100;
    if (this._gpuReady && this.spectrogramGrayInfo) {
      this.colorizer.uploadColorLut(this.currentColorScheme);
      this.colorizer.render(floor01, ceil01);
      this.spectrogramBaseCanvas = this.colorizer.canvas;
    } else {
      this.spectrogramBaseCanvas = colorizeSpectrogram(
        this.spectrogramGrayInfo,
        floor01,
        ceil01,
        this.currentColorScheme
      );
    }
    return this.spectrogramBaseCanvas;
  }
  _drawSpectrogram() {
    if (!this._showSpectrogram) return;
    if (!this.audioBuffer || !this.spectrogramData || this.spectrogramFrames <= 0) return;
    if (!this.spectrogramBaseCanvas) this._buildSpectrogramBaseImage();
    if (!this.spectrogramBaseCanvas) return;
    const effectiveSpectrogramHeight = this._getEffectiveSpectrogramHeight();
    renderSpectrogram({
      duration: this.audioBuffer.duration,
      spectrogramCanvas: this.d.spectrogramCanvas,
      pixelsPerSecond: this.pixelsPerSecond,
      canvasHeight: effectiveSpectrogramHeight,
      baseCanvas: this.spectrogramBaseCanvas,
      sampleRate: this.audioBuffer.sampleRate,
      frameRate: PERCH_FRAME_RATE,
      spectrogramFrames: this.spectrogramFrames
    });
    this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false, immediate: true });
  }
  _requestSpectrogramRedraw() {
    if (this._zoomRedrawRafId) return;
    this._zoomRedrawRafId = requestAnimationFrame(() => {
      this._zoomRedrawRafId = 0;
      if (!this.audioBuffer) return;
      if (this.spectrogramData && this.spectrogramFrames > 0) this._drawSpectrogram();
      this._drawMainWaveform();
    });
  }
  // ═════════════════════════════════════════════════════════════════
  //  Waveform Rendering
  // ═════════════════════════════════════════════════════════════════
  _drawMainWaveform() {
    if (!this._showWaveform) return;
    const effectiveWaveformHeight = this._getEffectiveWaveformHeight();
    renderMainWaveform({
      audioBuffer: this.audioBuffer,
      amplitudeCanvas: this.d.amplitudeCanvas,
      waveformTimelineCanvas: this.d.waveformTimelineCanvas,
      waveformContent: this.d.waveformContent,
      pixelsPerSecond: this.pixelsPerSecond,
      waveformHeight: effectiveWaveformHeight,
      amplitudePeakAbs: this.amplitudePeakAbs,
      showTimeline: this._showWaveformTimeline
    });
    this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false, immediate: true });
  }
  _drawOverviewWaveform() {
    if (!this._showOverview) return;
    renderOverviewWaveform({
      audioBuffer: this.audioBuffer,
      overviewCanvas: this.d.overviewCanvas,
      overviewContainer: this.d.overviewContainer,
      amplitudePeakAbs: this.amplitudePeakAbs
    });
    this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false, immediate: true });
  }
  _createFrequencyLabels() {
    renderFrequencyLabels({
      labelsElement: this.d.freqLabels,
      maxFreq: parseFloat(this.d.maxFreqSelect.value),
      sampleRateHz: this.sampleRateHz
    });
  }
  _updateAmplitudeLabels() {
    const el = this.d.amplitudeLabels;
    if (!el) return;
    el.innerHTML = "";
    const peak = Math.max(1e-6, this.amplitudePeakAbs || 1);
    const clampedH = this._getEffectiveWaveformHeight();
    const timelineH = this._showWaveformTimeline ? Math.max(18, Math.min(32, Math.round(clampedH * 0.22))) : 0;
    const ampH = Math.max(32, clampedH - timelineH);
    const fmt = (v) => {
      const a = Math.abs(v);
      return a >= 1 ? v.toFixed(2) : a >= 0.1 ? v.toFixed(3) : v.toFixed(4);
    };
    const positions = [4, ampH / 2, Math.max(4, ampH - 4)];
    [peak, 0, -peak].forEach((value, i) => {
      const span = document.createElement("span");
      span.textContent = value === 0 ? "0.000" : `${value > 0 ? "+" : ""}${fmt(value)}`;
      span.style.top = `${positions[i]}px`;
      el.appendChild(span);
    });
  }
  // ═════════════════════════════════════════════════════════════════
  //  Viewport & Scroll
  // ═════════════════════════════════════════════════════════════════
  _getPrimaryScrollWrapper() {
    if (!this._showSpectrogram && this._showWaveform) return this.d.waveformWrapper;
    return this.d.canvasWrapper || this.d.waveformWrapper;
  }
  _getSecondaryScrollWrapper() {
    const primary = this._getPrimaryScrollWrapper();
    if (primary === this.d.canvasWrapper) return this.d.waveformWrapper;
    if (primary === this.d.waveformWrapper) return this.d.canvasWrapper;
    return null;
  }
  _getPrimaryScrollLeft() {
    return this._getPrimaryScrollWrapper()?.scrollLeft || 0;
  }
  _getViewportWidth() {
    const primary = this._getPrimaryScrollWrapper();
    const secondary = this._getSecondaryScrollWrapper();
    return Math.max(1, primary?.clientWidth || secondary?.clientWidth || 0);
  }
  _setLinkedScrollLeft(nextLeft) {
    if (this.scrollSyncLock) return;
    this.scrollSyncLock = true;
    const vw = this._getViewportWidth();
    const tw = this.audioBuffer ? Math.max(1, Math.floor(this.audioBuffer.duration * this.pixelsPerSecond)) : 0;
    const maxScroll = Math.max(0, tw - vw);
    const bounded = Math.max(0, Math.min(nextLeft, maxScroll));
    const primary = this._getPrimaryScrollWrapper();
    const secondary = this._getSecondaryScrollWrapper();
    if (primary) primary.scrollLeft = bounded;
    if (secondary) secondary.scrollLeft = primary?.scrollLeft ?? bounded;
    this.scrollSyncLock = false;
    this._scheduleUiUpdate({ time: this._getCurrentTime(), fromPlayback: false });
  }
  _setPixelsPerSecond(nextPps, redraw, anchorTime, anchorPixel) {
    const minPps = Number(this.d.zoomSlider.min);
    const maxPps = Number(this.d.zoomSlider.max);
    const sliderStep = Number(this.d.zoomSlider.step || 1);
    const vw = this._getViewportWidth();
    const duration = this.audioBuffer?.duration || 0;
    const clamped = Math.max(minPps, Math.min(maxPps, nextPps));
    const changed = Math.abs(clamped - this.pixelsPerSecond) >= 0.01;
    const fallbackTime = (this._getPrimaryScrollLeft() + vw / 2) / Math.max(this.pixelsPerSecond, 0.01);
    const aTime = anchorTime ?? fallbackTime;
    const aPixel = anchorPixel ?? vw / 2;
    const effectivePps = changed ? clamped : this.pixelsPerSecond;
    const estWidth = duration ? Math.max(1, Math.floor(duration * effectivePps)) : 0;
    const maxScroll = Math.max(0, estWidth - vw);
    const nextScroll = aTime * effectivePps - aPixel;
    const bounded = Math.max(0, Math.min(maxScroll, nextScroll));
    if (changed) {
      this.pixelsPerSecond = effectivePps;
      this.d.zoomSlider.value = String(Math.round(effectivePps / sliderStep) * sliderStep);
      this.d.zoomValue.textContent = `${Math.round(effectivePps)} px/s`;
      this._emit("zoomchange", { pixelsPerSecond: this.pixelsPerSecond });
      if (this.wavesurfer) this.wavesurfer.zoom(effectivePps);
      if (this.audioBuffer && redraw) {
        if (this.spectrogramData && this.spectrogramFrames > 0) this._drawSpectrogram();
        this._drawMainWaveform();
      }
    }
    this._setLinkedScrollLeft(bounded);
  }
  _fitEntireTrackInView() {
    if (!this.audioBuffer) return;
    const fitPps = this._getViewportWidth() / Math.max(0.05, this.audioBuffer.duration);
    this._setPixelsPerSecond(fitPps, true, 0, 0);
  }
  _zoomByScale(scale, centerClientX, source = "spectrogram") {
    if (!this.audioBuffer) return;
    const wrapper = source === "waveform" ? this.d.waveformWrapper : this.d.canvasWrapper;
    const rect = wrapper.getBoundingClientRect();
    const localX = Math.max(0, Math.min(rect.width, centerClientX - rect.left));
    const anchorTime = (wrapper.scrollLeft + localX) / Math.max(this.pixelsPerSecond, 0.01);
    this._setPixelsPerSecond(this.pixelsPerSecond * scale, true, anchorTime, localX);
  }
  _centerViewportAtTime(timeSec) {
    if (!this.audioBuffer) return;
    const vw = this._getViewportWidth();
    const viewDur = vw / this.pixelsPerSecond;
    let start = timeSec - viewDur / 2;
    start = Math.max(0, Math.min(start, Math.max(0, this.audioBuffer.duration - viewDur)));
    this._setLinkedScrollLeft(start * this.pixelsPerSecond);
  }
  _clientXToTime(clientX, source = "spectrogram") {
    const wrapper = source === "waveform" ? this.d.waveformWrapper : this.d.canvasWrapper;
    const rect = wrapper.getBoundingClientRect();
    const x = clientX - rect.left + wrapper.scrollLeft;
    const refWidth = source === "waveform" ? this.d.amplitudeCanvas.width : this.d.spectrogramCanvas.width;
    const dur = this.audioBuffer?.duration || 0;
    const t = x / Math.max(1, refWidth) * dur;
    return Math.max(0, Math.min(t, dur));
  }
  // ═════════════════════════════════════════════════════════════════
  //  Overview Navigator
  // ═════════════════════════════════════════════════════════════════
  _syncOverviewWindowToViewport() {
    if (!this._showOverview || !this.audioBuffer) return;
    if (this.overviewMode) return;
    const trackWidth = Math.max(
      this.d.spectrogramCanvas.width || 0,
      this.d.amplitudeCanvas.width || 0,
      Math.floor(this.audioBuffer.duration * this.pixelsPerSecond)
    );
    if (trackWidth <= 0) return;
    const vw = this._getViewportWidth();
    const viewTime = vw / this.pixelsPerSecond;
    const startTime = this._getPrimaryScrollLeft() / this.pixelsPerSecond;
    const endTime = Math.min(this.audioBuffer.duration, startTime + viewTime);
    const nextStartNorm = startTime / this.audioBuffer.duration;
    const nextEndNorm = endTime / this.audioBuffer.duration;
    const moved = Math.abs(nextStartNorm - this.windowStartNorm) > 1e-5 || Math.abs(nextEndNorm - this.windowEndNorm) > 1e-5;
    this.windowStartNorm = nextStartNorm;
    this.windowEndNorm = nextEndNorm;
    if (moved) this._updateOverviewWindowElement();
    const rangeChanged = Math.abs(startTime - this._lastViewRangeTextStart) > 0.05 || Math.abs(endTime - this._lastViewRangeTextEnd) > 0.05;
    if (rangeChanged) {
      this._lastViewRangeTextStart = startTime;
      this._lastViewRangeTextEnd = endTime;
      this.d.viewRangeDisplay.textContent = `${formatSecondsShort(startTime)} \u2013 ${formatSecondsShort(endTime)}`;
    }
    const now = performance.now();
    const selectionChanged = !Number.isFinite(this._lastSelectionStart) || Math.abs(startTime - this._lastSelectionStart) > 0.03 || Math.abs(endTime - this._lastSelectionEnd) > 0.03;
    if (selectionChanged && now - this._lastSelectionEmitAt >= 80) {
      this._lastSelectionEmitAt = now;
      this._lastSelectionStart = startTime;
      this._lastSelectionEnd = endTime;
      this._perf.selectionEvents += 1;
      this._emit("selection", { start: startTime, end: endTime });
    }
  }
  _updateOverviewWindowElement() {
    if (!this._showOverview) return;
    const cw = this.d.overviewContainer.clientWidth;
    const left = this.windowStartNorm * cw;
    const width = Math.max(8, this.windowEndNorm * cw - left);
    this.d.overviewWindow.style.left = `${left}px`;
    this.d.overviewWindow.style.width = `${width}px`;
  }
  _getOverviewSpanConstraints() {
    const duration = Math.max(1e-3, this.audioBuffer?.duration || 1e-3);
    const vw = Math.max(1, this._getViewportWidth());
    const minPps = Math.max(1, Number(this.d.zoomSlider?.min || 20));
    const maxPps = Math.max(minPps, Number(this.d.zoomSlider?.max || 600));
    const minSpanNorm = Math.max(MIN_WINDOW_NORM, vw / maxPps / duration);
    const maxSpanNorm = Math.min(1, vw / minPps / duration);
    return {
      minSpanNorm: Math.min(minSpanNorm, 1),
      maxSpanNorm: Math.max(minSpanNorm, maxSpanNorm)
    };
  }
  _startOverviewDrag(mode, clientX) {
    this.overviewMode = mode;
    this.overviewDragStartX = clientX;
    this.overviewDragStart = this.windowStartNorm;
    this.overviewDragEnd = this.windowEndNorm;
    this._overviewDragMoved = false;
  }
  _updateOverviewDrag(clientX) {
    if (!this._showOverview || !this.audioBuffer || !this.overviewMode) return;
    if (Math.abs(clientX - this.overviewDragStartX) > 2) this._overviewDragMoved = true;
    const cw = this.d.overviewContainer.clientWidth;
    const deltaNorm = (clientX - this.overviewDragStartX) / cw;
    const { minSpanNorm, maxSpanNorm } = this._getOverviewSpanConstraints();
    const fixedStart = this.overviewDragStart;
    const fixedEnd = this.overviewDragEnd;
    if (this.overviewMode === "move") {
      let s = fixedStart + deltaNorm;
      let e = fixedEnd + deltaNorm;
      const span = e - s;
      if (s < 0) {
        s = 0;
        e = span;
      }
      if (e > 1) {
        e = 1;
        s = 1 - span;
      }
      this.windowStartNorm = s;
      this.windowEndNorm = e;
    } else if (this.overviewMode === "left") {
      const nextStart = fixedStart + deltaNorm;
      const right = fixedEnd;
      const minStart = Math.max(0, right - maxSpanNorm);
      const maxStart = Math.max(minStart, right - minSpanNorm);
      this.windowStartNorm = Math.max(minStart, Math.min(maxStart, nextStart));
      this.windowEndNorm = right;
    } else if (this.overviewMode === "right") {
      const nextEnd = fixedEnd + deltaNorm;
      const left = fixedStart;
      const minEnd = Math.min(1, left + minSpanNorm);
      const maxEnd = Math.min(1, left + maxSpanNorm);
      this.windowEndNorm = Math.max(minEnd, Math.min(maxEnd, nextEnd));
      this.windowStartNorm = left;
    }
    this._updateOverviewWindowElement();
    this._queueOverviewViewportApply(false);
  }
  _queueOverviewViewportApply(redrawFinal = false) {
    this._overviewNeedsFinalRedraw = this._overviewNeedsFinalRedraw || redrawFinal;
    if (this._overviewViewportRafId) return;
    this._overviewViewportRafId = requestAnimationFrame(() => {
      this._overviewViewportRafId = 0;
      const redraw = this._overviewNeedsFinalRedraw;
      this._overviewNeedsFinalRedraw = false;
      this._applyOverviewWindowToViewport(redraw);
      if (!redraw) this._requestSpectrogramRedraw();
    });
  }
  _applyOverviewWindowToViewport(redraw = true) {
    if (!this._showOverview || !this.audioBuffer) return;
    const dur = this.audioBuffer.duration;
    const viewDur = Math.max(0.01, (this.windowEndNorm - this.windowStartNorm) * dur);
    const targetPps = this._getViewportWidth() / viewDur;
    this._setPixelsPerSecond(targetPps, redraw, this.windowStartNorm * dur, 0);
  }
  // ═════════════════════════════════════════════════════════════════
  //  Click / Pointer / Drag
  // ═════════════════════════════════════════════════════════════════
  _handleCanvasClick(e) {
    if (performance.now() < this._blockSeekClickUntil) return;
    if (this.suppressSeekClick) {
      this.suppressSeekClick = false;
      return;
    }
    if (!this.audioBuffer) return;
    this._cancelFollowCatchupAnimation();
    this._seekToTime(this._clientXToTime(e.clientX, "spectrogram"), false, { userInitiated: true });
  }
  _handleWaveformClick(e) {
    if (performance.now() < this._blockSeekClickUntil) return;
    if (this.suppressSeekClick) {
      this.suppressSeekClick = false;
      return;
    }
    if (!this.audioBuffer) return;
    this._cancelFollowCatchupAnimation();
    this._seekToTime(this._clientXToTime(e.clientX, "waveform"), false, { userInitiated: true });
  }
  _blockSeekClicks(ms = 220) {
    this._blockSeekClickUntil = Math.max(this._blockSeekClickUntil, performance.now() + ms);
    this.suppressSeekClick = true;
  }
  _startPlayheadDrag(event, source) {
    if (!this.audioBuffer) return;
    event.preventDefault();
    this.draggingPlayhead = true;
    this.draggingPlayheadSource = source;
    this._seekFromClientX(event.clientX, source);
  }
  _seekFromClientX(clientX, source = "spectrogram") {
    if (!this.audioBuffer) return;
    this._seekToTime(this._clientXToTime(clientX, source), false);
  }
  _startViewportPan(event, source) {
    if (!this.audioBuffer) return;
    this._cancelFollowCatchupAnimation();
    if (event.target === this.d.playhead || event.target === this.d.waveformPlayhead) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault();
    this.draggingViewport = true;
    this.viewportPanStartX = event.clientX;
    this.viewportPanStartScroll = source === "waveform" ? this.d.waveformWrapper.scrollLeft : this.d.canvasWrapper.scrollLeft;
    this.suppressSeekClick = false;
    document.body.style.cursor = "grabbing";
  }
  _updateViewportPan(clientX) {
    const dx = clientX - this.viewportPanStartX;
    this.suppressSeekClick = Math.abs(dx) > 3;
    this._setLinkedScrollLeft(this.viewportPanStartScroll - dx);
  }
  // ═════════════════════════════════════════════════════════════════
  //  Wheel Zoom / Scroll
  // ═════════════════════════════════════════════════════════════════
  _handleWheel(event, source) {
    if (!this.audioBuffer) return;
    this._cancelFollowCatchupAnimation();
    const wrapper = source === "waveform" ? this.d.waveformWrapper : this.d.canvasWrapper;
    const rect = wrapper.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const timeAtCursor = (wrapper.scrollLeft + localX) / this.pixelsPerSecond;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      this._setPixelsPerSecond(this.pixelsPerSecond * factor, true, timeAtCursor, localX);
      return;
    }
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      this._setLinkedScrollLeft(Math.max(0, wrapper.scrollLeft + event.deltaY));
    }
  }
  // ═════════════════════════════════════════════════════════════════
  //  View Resize
  // ═════════════════════════════════════════════════════════════════
  _applyLocalViewHeights() {
    const overlaySingleWaveform = this._transportOverlay && this._showWaveform && !this._showSpectrogram;
    const overlaySingleSpectrogram = this._transportOverlay && this._showSpectrogram && !this._showWaveform;
    if (this._showWaveform) {
      if (overlaySingleWaveform) {
        this.d.waveformContainer.style.height = "auto";
      } else {
        this.d.waveformContainer.style.height = `${Math.round(this.waveformDisplayHeight)}px`;
      }
    }
    if (this._showSpectrogram) {
      if (overlaySingleSpectrogram) {
        this.d.spectrogramContainer.style.height = "auto";
      } else {
        this.d.spectrogramContainer.style.height = `${Math.round(this.spectrogramDisplayHeight)}px`;
      }
    }
  }
  _getEffectiveWaveformHeight() {
    if (this._transportOverlay && this._showWaveform && !this._showSpectrogram) {
      const h = this.d.waveformContainer?.clientHeight || 0;
      return Math.max(MIN_WAVEFORM_HEIGHT, Math.floor(h || this.waveformDisplayHeight));
    }
    return Math.max(MIN_WAVEFORM_HEIGHT, Math.floor(this.waveformDisplayHeight));
  }
  _getEffectiveSpectrogramHeight() {
    if (this._transportOverlay && this._showSpectrogram && !this._showWaveform) {
      const h = this.d.spectrogramContainer?.clientHeight || 0;
      return Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, Math.floor(h || this.spectrogramDisplayHeight));
    }
    return Math.max(MIN_SPECTROGRAM_DISPLAY_HEIGHT, Math.floor(this.spectrogramDisplayHeight));
  }
  _startViewResize(mode, clientY) {
    this.viewResizeMode = mode;
    this.viewResizeStartY = clientY;
    this.viewResizeStartWaveformHeight = this.waveformDisplayHeight;
    this.viewResizeStartSpectrogramHeight = this.spectrogramDisplayHeight;
    document.body.style.cursor = "row-resize";
  }
  _updateViewResize(clientY) {
    if (!this.viewResizeMode) return;
    if (this.viewResizeMode === "split" && (!this._showWaveform || !this._showSpectrogram) || this.viewResizeMode === "spectrogram" && !this._showSpectrogram) return;
    const dy = clientY - this.viewResizeStartY;
    let redrawWav = false;
    if (this.viewResizeMode === "split") {
      const total = this.viewResizeStartWaveformHeight + this.viewResizeStartSpectrogramHeight;
      let nextWav = this.viewResizeStartWaveformHeight + dy;
      nextWav = Math.max(MIN_WAVEFORM_HEIGHT, Math.min(total - MIN_SPECTROGRAM_DISPLAY_HEIGHT, nextWav));
      this.waveformDisplayHeight = nextWav;
      this.spectrogramDisplayHeight = total - nextWav;
      redrawWav = true;
    } else {
      this.spectrogramDisplayHeight = Math.max(
        MIN_SPECTROGRAM_DISPLAY_HEIGHT,
        this.viewResizeStartSpectrogramHeight + dy
      );
    }
    this._applyLocalViewHeights();
    if (redrawWav) this._updateAmplitudeLabels();
    if (!this.audioBuffer) return;
    this._queueResizeRedraw({
      redrawWaveform: redrawWav,
      redrawSpectrogram: this.spectrogramData && this.spectrogramFrames > 0
    });
  }
  _stopViewResize() {
    if (!this.viewResizeMode) return;
    this._flushResizeRedraw(true);
    this.viewResizeMode = null;
    document.body.style.cursor = "";
  }
  _queueResizeRedraw({ redrawWaveform = false, redrawSpectrogram = false } = {}) {
    this._viewResizeNeedsWaveformRedraw = this._viewResizeNeedsWaveformRedraw || redrawWaveform;
    this._viewResizeNeedsSpectrogramRedraw = this._viewResizeNeedsSpectrogramRedraw || redrawSpectrogram;
    if (this._viewResizeFrameId) return;
    this._viewResizeFrameId = requestAnimationFrame(() => this._flushResizeRedraw(false));
  }
  _flushResizeRedraw(force) {
    if (!this.audioBuffer) return;
    if (this._viewResizeFrameId) {
      cancelAnimationFrame(this._viewResizeFrameId);
      this._viewResizeFrameId = 0;
    }
    const redrawWaveform = force || this._viewResizeNeedsWaveformRedraw;
    const redrawSpectrogram = force || this._viewResizeNeedsSpectrogramRedraw;
    this._viewResizeNeedsWaveformRedraw = false;
    this._viewResizeNeedsSpectrogramRedraw = false;
    const savedScroll = this._getPrimaryScrollLeft();
    if (redrawWaveform) this._drawMainWaveform();
    if (redrawSpectrogram) this._drawSpectrogram();
    this._setLinkedScrollLeft(savedScroll);
    this._emit("viewresize", {
      waveformHeight: this.waveformDisplayHeight,
      spectrogramHeight: this.spectrogramDisplayHeight
    });
  }
  // ═════════════════════════════════════════════════════════════════
  //  UI State Helpers
  // ═════════════════════════════════════════════════════════════════
  _setPlayState(text) {
    this.d.playStateDisplay.textContent = text;
  }
  _shouldCompactToolbarBeActive() {
    if (this._transportOverlay) return false;
    if (this._compactToolbarMode === "off") return false;
    if (this._compactToolbarMode === "on") return true;
    const root = this.d.toolbarRoot;
    if (!root) return false;
    const hadActive = this.container.classList.contains("compact-toolbar-active");
    const hadOpen = this.container.classList.contains("compact-toolbar-open");
    if (hadActive) this.container.classList.remove("compact-toolbar-active");
    if (hadOpen) this.container.classList.remove("compact-toolbar-open");
    const needsCompact = root.scrollWidth > root.clientWidth + 4;
    if (hadActive) this.container.classList.add("compact-toolbar-active");
    if (hadOpen) this.container.classList.add("compact-toolbar-open");
    return needsCompact;
  }
  _isCompactToolbarActive() {
    return this.container.classList.contains("compact-toolbar-active");
  }
  _queueCompactToolbarLayoutRefresh() {
    if (this._compactToolbarLayoutRaf) return;
    this._compactToolbarLayoutRaf = requestAnimationFrame(() => {
      this._compactToolbarLayoutRaf = 0;
      this._refreshCompactToolbarLayout();
    });
  }
  _refreshCompactToolbarLayout() {
    const active = this._shouldCompactToolbarBeActive();
    this.container.classList.toggle("compact-toolbar-active", active);
    if (!active && this._compactToolbarOpen) this._setCompactToolbarOpen(false);
    if (this.d.compactMoreBtn) {
      this.d.compactMoreBtn.disabled = !active;
      this.d.compactMoreBtn.setAttribute("aria-hidden", active ? "false" : "true");
    }
  }
  _setCompactToolbarOpen(nextOpen) {
    const open = this._isCompactToolbarActive() && !!nextOpen;
    this._compactToolbarOpen = open;
    this.container.classList.toggle("compact-toolbar-open", open);
    if (this.d.compactMoreBtn) this.d.compactMoreBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  _setTransportEnabled(enabled) {
    [
      this.d.playPauseBtn,
      this.d.stopBtn,
      this.d.jumpStartBtn,
      this.d.jumpEndBtn,
      this.d.backwardBtn,
      this.d.forwardBtn,
      this.d.followToggleBtn,
      this.d.loopToggleBtn,
      this.d.fitViewBtn,
      this.d.resetViewBtn,
      this.d.autoContrastBtn,
      this.d.autoFreqBtn
    ].forEach((btn) => {
      btn.disabled = !enabled;
    });
    this._queueCompactToolbarLayoutRefresh();
  }
  _updateToggleButtons() {
    this.followPlayback = this.followMode !== "free";
    if (this.d.followToggleBtn) {
      this.d.followToggleBtn.classList.toggle("active", this.followPlayback);
      this.d.followToggleBtn.textContent = this.followMode === "smooth" ? "Smooth" : this.followPlayback ? "Follow" : "Free";
      this.d.followToggleBtn.title = this.followMode === "smooth" ? "Smooth follow (continuous)" : this.followPlayback ? "Follow playhead" : "Free navigation";
    }
    if (this.d.loopToggleBtn) {
      this.d.loopToggleBtn.classList.toggle("active", this.loopPlayback);
      this.d.loopToggleBtn.textContent = this.loopPlayback ? "Loop On" : "Loop";
    }
    this._queueCompactToolbarLayoutRefresh();
  }
  _cycleFollowMode() {
    this.followMode = this.followMode === "free" ? "follow" : this.followMode === "follow" ? "smooth" : "free";
    if (this.followMode !== "follow") this._cancelFollowCatchupAnimation();
    this._updateToggleButtons();
    this._emit("followmodechange", { mode: this.followMode });
  }
  _cancelFollowCatchupAnimation() {
    if (this._followCatchupRafId) {
      cancelAnimationFrame(this._followCatchupRafId);
      this._followCatchupRafId = 0;
    }
    this._followCatchupAnim = null;
  }
  _animateFollowCatchupTo(targetScrollLeft) {
    if (!this.audioBuffer) return;
    const vw = this._getViewportWidth();
    const tw = Math.max(1, Math.floor(this.audioBuffer.duration * this.pixelsPerSecond));
    const maxScroll = Math.max(0, tw - vw);
    const target = Math.max(0, Math.min(maxScroll, targetScrollLeft));
    const start = this._getPrimaryScrollLeft();
    const delta = target - start;
    if (Math.abs(delta) < 1) return;
    const now = performance.now();
    const inSeekFocus = now < this._smoothSeekFocusUntil;
    const duration = inSeekFocus ? this._playbackViewportConfig.followCatchupSeekDurationMs : this._playbackViewportConfig.followCatchupDurationMs;
    if (this._followCatchupAnim) {
      const pending = this._followCatchupAnim.target;
      if (Math.abs(pending - target) < 6) return;
    }
    this._cancelFollowCatchupAnimation();
    this._followCatchupAnim = { start, target, startedAt: now, duration };
    const easeOutCubic = (t) => 1 - (1 - t) ** 3;
    const tick = (ts) => {
      const anim = this._followCatchupAnim;
      if (!anim) return;
      const t = Math.max(0, Math.min(1, (ts - anim.startedAt) / Math.max(1, anim.duration)));
      const eased = easeOutCubic(t);
      const next = anim.start + (anim.target - anim.start) * eased;
      this._setLinkedScrollLeft(next);
      if (t >= 1) {
        this._cancelFollowCatchupAnimation();
        return;
      }
      this._followCatchupRafId = requestAnimationFrame(tick);
    };
    this._followCatchupRafId = requestAnimationFrame(tick);
  }
  _applySmoothFollow(position, viewportWidth) {
    const vw = Math.max(1, viewportWidth || this._getViewportWidth());
    const totalWidth = this.audioBuffer ? Math.max(1, Math.floor(this.audioBuffer.duration * this.pixelsPerSecond)) : 0;
    const maxScroll = Math.max(0, totalWidth - vw);
    const target = Math.max(0, Math.min(maxScroll, position - vw * this._playbackViewportConfig.followTargetRatio));
    const current = this._getPrimaryScrollLeft();
    const delta = target - current;
    if (Math.abs(delta) < 0.6) return;
    const inSeekFocus = performance.now() < this._smoothSeekFocusUntil;
    const lerp = inSeekFocus ? this._playbackViewportConfig.smoothSeekLerp : this._playbackViewportConfig.smoothLerp;
    const minStep = inSeekFocus ? vw * this._playbackViewportConfig.smoothSeekMinStepRatio : vw * this._playbackViewportConfig.smoothMinStepRatio;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), Math.max(minStep, Math.abs(delta) * lerp, 1));
    this._setLinkedScrollLeft(current + step);
  }
  _setInitialPlayheadPositions() {
    this.d.playhead.style.left = "0px";
    this.d.waveformPlayhead.style.left = "0px";
    this.d.playhead.style.transform = "translateX(0px)";
    this.d.waveformPlayhead.style.transform = "translateX(0px)";
  }
  // ═════════════════════════════════════════════════════════════════
  //  Keyboard
  // ═════════════════════════════════════════════════════════════════
  _handleKeyboardShortcuts(event) {
    if (!this.audioBuffer || isTypingContext(event.target)) return;
    switch (event.code) {
      case "Space":
        event.preventDefault();
        this._togglePlayPause();
        break;
      case "Home":
        event.preventDefault();
        this._seekToTime(0, true);
        break;
      case "End":
        event.preventDefault();
        this._seekToTime(this.audioBuffer.duration, true);
        break;
      case "KeyJ":
        event.preventDefault();
        this._seekByDelta(-SEEK_COARSE_SEC);
        break;
      case "KeyL":
        event.preventDefault();
        this._seekByDelta(SEEK_COARSE_SEC);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this._seekByDelta(-SEEK_FINE_SEC);
        break;
      case "ArrowRight":
        event.preventDefault();
        this._seekByDelta(SEEK_FINE_SEC);
        break;
    }
  }
  // ═════════════════════════════════════════════════════════════════
  //  Event Binding
  // ═════════════════════════════════════════════════════════════════
  _bindEvents() {
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._cleanups.push(() => target.removeEventListener(type, fn, opts));
    };
    on(this.d.openFileBtn, "click", () => this.d.audioFile.click());
    on(this.d.compactMoreBtn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._setCompactToolbarOpen(!this._compactToolbarOpen);
    });
    on(this.d.audioFile, "change", (e) => this._handleFileSelect(e));
    on(this.d.playPauseBtn, "click", () => this._togglePlayPause());
    on(this.d.stopBtn, "click", () => this._stopPlayback());
    on(this.d.jumpStartBtn, "click", () => this._seekToTime(0, true));
    on(this.d.jumpEndBtn, "click", () => this._seekToTime(this.audioBuffer?.duration ?? 0, true));
    on(this.d.backwardBtn, "click", () => this._seekByDelta(-SEEK_COARSE_SEC));
    on(this.d.forwardBtn, "click", () => this._seekByDelta(SEEK_COARSE_SEC));
    on(this.d.followToggleBtn, "click", () => this._cycleFollowMode());
    on(this.d.loopToggleBtn, "click", () => {
      this.loopPlayback = !this.loopPlayback;
      this._updateToggleButtons();
    });
    on(this.d.fitViewBtn, "click", () => this._fitEntireTrackInView());
    on(this.d.resetViewBtn, "click", () => {
      this._setPixelsPerSecond(DEFAULT_ZOOM_PPS, true);
      this._setLinkedScrollLeft(0);
      this._syncOverviewWindowToViewport();
    });
    on(this.d.fftSizeSelect, "change", () => {
      if (this.audioBuffer) this._generateSpectrogram();
    });
    on(this.d.maxFreqSelect, "change", () => {
      if (this.audioBuffer && this.spectrogramData && this.spectrogramFrames > 0) {
        this._emit("spectrogramscalechange", { maxFreq: parseFloat(this.d.maxFreqSelect.value) });
        this._createFrequencyLabels();
        this._buildSpectrogramGrayscale();
        this._buildSpectrogramBaseImage();
        this._drawSpectrogram();
      }
    });
    on(this.d.colorSchemeSelect, "change", () => {
      this.currentColorScheme = this.d.colorSchemeSelect.value;
      if (this.audioBuffer && this.spectrogramData && this.spectrogramFrames > 0) {
        this._buildSpectrogramBaseImage();
        this._drawSpectrogram();
      }
    });
    on(this.d.zoomSlider, "input", (e) => {
      this._setPixelsPerSecond(parseFloat(e.target.value), false);
      this._requestSpectrogramRedraw();
    });
    on(this.d.zoomSlider, "change", () => {
      if (this.spectrogramData && this.spectrogramFrames > 0) this._drawSpectrogram();
    });
    on(this.d.volumeSlider, "input", (e) => {
      this.muted = false;
      this._setVolume(parseFloat(e.target.value) / 100);
    });
    on(this.d.volumeToggleBtn, "click", () => this._toggleMute());
    const rebuildDisplay = () => {
      if (!this.spectrogramData || this.spectrogramFrames <= 0) return;
      this._buildSpectrogramBaseImage();
      this._drawSpectrogram();
    };
    on(this.d.floorSlider, "input", rebuildDisplay);
    on(this.d.ceilSlider, "input", rebuildDisplay);
    on(this.d.autoContrastBtn, "click", () => this._autoContrast(true));
    on(this.d.autoFreqBtn, "click", () => this._autoFrequency(true));
    on(this.d.canvasWrapper, "click", (e) => this._handleCanvasClick(e));
    on(this.d.waveformWrapper, "click", (e) => this._handleWaveformClick(e));
    on(this.d.canvasWrapper, "scroll", () => {
      if (this.scrollSyncLock) return;
      if (this._getPrimaryScrollWrapper() !== this.d.canvasWrapper) return;
      this._setLinkedScrollLeft(this.d.canvasWrapper.scrollLeft);
    });
    on(this.d.waveformWrapper, "scroll", () => {
      if (this.scrollSyncLock) return;
      if (this._getPrimaryScrollWrapper() !== this.d.waveformWrapper) return;
      this._setLinkedScrollLeft(this.d.waveformWrapper.scrollLeft);
    });
    on(this.d.canvasWrapper, "wheel", (e) => this._handleWheel(e, "spectrogram"), { passive: false });
    on(this.d.waveformWrapper, "wheel", (e) => this._handleWheel(e, "waveform"), { passive: false });
    on(this.d.canvasWrapper, "keydown", (e) => {
      if (!this.audioBuffer) return;
      if (isTypingContext(e.target)) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          this._seekByDelta(-SEEK_FINE_SEC);
          break;
        case "ArrowRight":
          e.preventDefault();
          this._seekByDelta(SEEK_FINE_SEC);
          break;
        case "Home":
          e.preventDefault();
          this._seekToTime(0, true);
          break;
        case "End":
          e.preventDefault();
          this._seekToTime(this.audioBuffer.duration, true);
          break;
        default:
          break;
      }
    });
    on(this.d.canvasWrapper, "pointerdown", (e) => this._startViewportPan(e, "spectrogram"));
    on(this.d.waveformWrapper, "pointerdown", (e) => this._startViewportPan(e, "waveform"));
    on(this.d.playhead, "pointerdown", (e) => this._startPlayheadDrag(e, "spectrogram"));
    on(this.d.waveformPlayhead, "pointerdown", (e) => this._startPlayheadDrag(e, "waveform"));
    on(this.d.viewSplitHandle, "pointerdown", (e) => {
      if (!this._showWaveform || !this._showSpectrogram) return;
      e.preventDefault();
      this._startViewResize("split", e.clientY);
    });
    on(this.d.spectrogramResizeHandle, "pointerdown", (e) => {
      if (!this._showSpectrogram) return;
      e.preventDefault();
      this._startViewResize("spectrogram", e.clientY);
    });
    on(document, "pointermove", (e) => {
      if (this.viewResizeMode) {
        this._updateViewResize(e.clientY);
        return;
      }
      if (this.draggingViewport) this._updateViewportPan(e.clientX);
      if (this.draggingPlayhead) this._seekFromClientX(e.clientX, this.draggingPlayheadSource);
      if (this.overviewMode) this._updateOverviewDrag(e.clientX);
    });
    const releaseAll = () => {
      this._stopViewResize();
      if (this.draggingViewport) {
        this.draggingViewport = false;
        document.body.style.cursor = "";
      }
      this.draggingPlayhead = false;
      this.draggingPlayheadSource = null;
      if (this.overviewMode) this._queueOverviewViewportApply(true);
      if (this.overviewMode && this._overviewDragMoved) {
        this._overviewSuppressClickUntil = performance.now() + 260;
      }
      this.overviewMode = null;
    };
    on(document, "pointerup", releaseAll);
    on(document, "pointercancel", releaseAll);
    on(document, "keydown", (e) => this._handleKeyboardShortcuts(e));
    on(document, "keydown", (e) => {
      if (e.key === "Escape" && this._compactToolbarOpen) this._setCompactToolbarOpen(false);
    });
    on(document, "pointerdown", (e) => {
      if (!this._compactToolbarOpen) return;
      if (this.d.toolbarRoot?.contains(e.target)) return;
      this._setCompactToolbarOpen(false);
    });
    on(this.d.overviewHandleLeft, "pointerdown", (e) => {
      if (!this._showOverview) return;
      e.preventDefault();
      this._startOverviewDrag("left", e.clientX);
    });
    on(this.d.overviewHandleRight, "pointerdown", (e) => {
      if (!this._showOverview) return;
      e.preventDefault();
      this._startOverviewDrag("right", e.clientX);
    });
    on(this.d.overviewWindow, "pointerdown", (e) => {
      if (!this._showOverview) return;
      if (e.target === this.d.overviewHandleLeft || e.target === this.d.overviewHandleRight) return;
      e.preventDefault();
      this._startOverviewDrag("move", e.clientX);
    });
    on(this.d.overviewCanvas, "click", (e) => {
      if (performance.now() < this._overviewSuppressClickUntil) return;
      if (!this._showOverview) return;
      if (!this.audioBuffer) return;
      const rect = this.d.overviewCanvas.getBoundingClientRect();
      const xNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this._seekToTime(xNorm * this.audioBuffer.duration, true);
    });
    on(window, "resize", () => {
      this._queueCompactToolbarLayoutRefresh();
      if (!this._shouldCompactToolbarBeActive()) this._setCompactToolbarOpen(false);
      if (!this.audioBuffer) return;
      this._drawMainWaveform();
      this._drawOverviewWaveform();
      this._syncOverviewWindowToViewport();
      this._emit("viewresize", {
        waveformHeight: this.waveformDisplayHeight,
        spectrogramHeight: this.spectrogramDisplayHeight
      });
    });
    on(window, "beforeunload", () => this.dispose());
  }
  _bindTouchGestures() {
    const bindRecognizer = (element, source) => {
      if (!element) return;
      const rec = new GestureRecognizer(element);
      const offSwipe = rec.on("swipe", ({ dx }) => {
        if (!this.audioBuffer) return;
        this._seekRelative(dx / Math.max(1, this.pixelsPerSecond));
      });
      const offPinch = rec.on("pinch", ({ scale, centerX }) => {
        if (!this.audioBuffer) return;
        const clampedScale = Math.max(0.85, Math.min(1.15, scale));
        this._zoomByScale(clampedScale, centerX, source);
      });
      const offDoubleTap = rec.on("doubletap", () => {
        if (!this.audioBuffer) return;
        this._fitEntireTrackInView();
      });
      this._cleanups.push(() => {
        offSwipe();
        offPinch();
        offDoubleTap();
        rec.dispose();
      });
    };
    bindRecognizer(this.d.waveformWrapper, "waveform");
    bindRecognizer(this.d.canvasWrapper, "spectrogram");
  }
};

// src/annotations.js
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
var _colorCtx = (() => {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("2d");
  } catch {
    return null;
  }
})();
function _parseColorToRgb(color) {
  const raw = String(color || "").trim();
  if (!raw || !_colorCtx) return null;
  try {
    _colorCtx.fillStyle = "#000000";
    _colorCtx.fillStyle = raw;
    const normalized = _colorCtx.fillStyle;
    if (!normalized) return null;
    if (normalized.startsWith("#")) {
      const hex = normalized.slice(1);
      if (hex.length === 3) {
        return {
          r: parseInt(hex[0] + hex[0], 16),
          g: parseInt(hex[1] + hex[1], 16),
          b: parseInt(hex[2] + hex[2], 16)
        };
      }
      if (hex.length === 6) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16)
        };
      }
    }
    const m = normalized.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const parts = m[1].split(",").map((x) => Number(x.trim()));
    if (parts.length < 3 || parts.some((n, i) => i < 3 && !Number.isFinite(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2] };
  } catch {
    return null;
  }
}
function _rgbToHex({ r, g, b }) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function getOverlayColorStyle(color) {
  const rgb = _parseColorToRgb(color);
  if (!rgb) return null;
  return {
    fill: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`,
    edge: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.95)`,
    soft: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.55)`,
    hex: _rgbToHex(rgb)
  };
}
function openLabelNameEditor({ player, anchorEl, initialValue, initialColor, onSubmit }) {
  const host = player?.root || player?.container || document.body;
  if (!host || !anchorEl || typeof onSubmit !== "function") return;
  const panel = document.createElement("div");
  panel.className = "label-name-editor";
  panel.innerHTML = `
        <input class="label-name-input" type="text" maxlength="96" />
        <div class="label-name-color">
            <span>Color</span>
            <input class="label-color-input" type="color" />
        </div>
        <div class="label-name-suggestions"></div>
        <div class="label-name-actions">
            <button type="button" class="label-name-btn cancel">Cancel</button>
            <button type="button" class="label-name-btn save">Save</button>
        </div>
    `;
  host.appendChild(panel);
  const input = panel.querySelector(".label-name-input");
  const colorInput = panel.querySelector(".label-color-input");
  const sugg = panel.querySelector(".label-name-suggestions");
  const saveBtn = panel.querySelector(".label-name-btn.save");
  const cancelBtn = panel.querySelector(".label-name-btn.cancel");
  input.value = String(initialValue || "").trim();
  const initialStyle = getOverlayColorStyle(initialColor);
  colorInput.value = initialStyle?.hex || "#0ea5e9";
  const anchorRect = anchorEl.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  panel.style.left = `${Math.max(4, anchorRect.left - hostRect.left)}px`;
  panel.style.top = `${Math.max(4, anchorRect.bottom - hostRect.top + 6)}px`;
  const close = () => {
    if (panel.parentNode) panel.parentNode.removeChild(panel);
  };
  const submit = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return;
    onSubmit({ name: trimmed, color: colorInput.value });
    close();
  };
  const renderSuggestions = () => {
    const taxonomy = player?.getLabelTaxonomy?.() || [];
    const recent = player?.getLabelSuggestions?.("", 8) || [];
    const filtered = player?.getLabelSuggestions?.(input.value, 8) || [];
    const names = [];
    const seen = /* @__PURE__ */ new Set();
    for (const name of recent) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    for (const name of filtered) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    sugg.innerHTML = "";
    for (const item of taxonomy) {
      if (!item?.name) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "label-name-chip taxonomy";
      chip.textContent = item.shortcut ? `${item.shortcut}: ${item.name}` : item.name;
      if (item.color) chip.style.setProperty("--chip-color", item.color);
      chip.addEventListener("click", () => {
        if (item.color) colorInput.value = getOverlayColorStyle(item.color)?.hex || colorInput.value;
        submit(item.name);
      });
      sugg.appendChild(chip);
    }
    for (const name of names) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "label-name-chip";
      chip.textContent = name;
      chip.addEventListener("click", () => submit(name));
      sugg.appendChild(chip);
    }
  };
  input.addEventListener("input", renderSuggestions);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  saveBtn.addEventListener("click", () => submit(input.value));
  cancelBtn.addEventListener("click", close);
  setTimeout(() => input.focus(), 0);
  input.select();
  renderSuggestions();
}
var AnnotationLayer = class {
  constructor() {
    this.player = null;
    this.overlay = null;
    this.annotations = [];
    this._liveLinkedId = null;
    this._unsubs = [];
    this._domCleanups = [];
    this._editing = null;
    this._suppressClickUntil = 0;
  }
  attach(player) {
    this.detach();
    this.player = player;
    const root = this.player?._state?.d?.waveformContent || this.player?.root?.querySelector(".waveform-content");
    if (!root) return;
    this.overlay = document.createElement("div");
    this.overlay.className = "annotation-layer";
    root.appendChild(this.overlay);
    this._unsubs.push(this.player.on("ready", () => this.render()));
    this._unsubs.push(this.player.on("zoomchange", () => this.render()));
    this._unsubs.push(this.player.on("viewresize", () => this.render()));
    this._unsubs.push(this.player.on("seek", (e) => this.highlightActiveRegion(e.detail.currentTime)));
    this._unsubs.push(this.player.on("timeupdate", (e) => this.highlightActiveRegion(e.detail.currentTime)));
    this._bindEditingInteractions(root);
    this.render();
  }
  detach() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    for (const cleanup of this._domCleanups) cleanup();
    this._domCleanups = [];
    if (this.overlay?.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
    this.player = null;
    this._editing = null;
  }
  add(annotation) {
    const region = this._normalize(annotation);
    this.annotations.push(region);
    this.render();
    this.player?._emit?.("annotationcreate", { annotation: { ...region } });
    return region.id;
  }
  set(regions = []) {
    this.annotations = regions.map((r) => this._normalize(r));
    this.render();
  }
  clear() {
    this.annotations = [];
    this.render();
  }
  remove(id) {
    this.annotations = this.annotations.filter((a) => a.id !== id);
    this.render();
  }
  getAll() {
    return [...this.annotations];
  }
  setLiveLinkedId(id = null) {
    this._liveLinkedId = id || null;
  }
  highlightActiveRegion(currentTime) {
    if (!this.overlay) return;
    for (const el of this.overlay.querySelectorAll(".annotation-region")) {
      const start = parseFloat(el.dataset.start || "0");
      const end = parseFloat(el.dataset.end || "0");
      el.classList.toggle("active", currentTime >= start && currentTime <= end);
    }
  }
  exportRavenFormat(regions = this.annotations) {
    return regions.map((r) => `${r.start}	${r.end}	${r.species || ""}	${r.confidence ?? ""}`).join("\n");
  }
  render() {
    if (!this.overlay || !this.player) return;
    const pps = this.player._state?.pixelsPerSecond || 100;
    const duration = this.player.duration || this.player._state?.audioBuffer?.duration || 0;
    const width = Math.max(1, Math.floor(duration * pps));
    this.overlay.style.width = `${width}px`;
    this.overlay.innerHTML = "";
    for (const region of this.annotations) {
      const el = this._createRegionElement(region, pps);
      this.overlay.appendChild(el);
    }
  }
  _createRegionElement(region, pixelsPerSecond) {
    const el = document.createElement("div");
    el.className = "annotation-region";
    if (this._liveLinkedId && region.id === this._liveLinkedId) el.classList.add("linked-live");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.style.left = `${Math.max(0, region.start * pixelsPerSecond)}px`;
    el.style.width = `${Math.max(1, (region.end - region.start) * pixelsPerSecond)}px`;
    const colorStyle = getOverlayColorStyle(region.color);
    if (colorStyle) {
      el.style.setProperty("--annotation-color-fill", colorStyle.fill);
      el.style.setProperty("--annotation-color-edge", colorStyle.edge);
      el.style.setProperty("--annotation-color-soft", colorStyle.soft);
    }
    el.dataset.id = region.id;
    el.dataset.start = String(region.start);
    el.dataset.end = String(region.end);
    el.title = `${region.species || "Annotation"} (${region.start.toFixed(2)}s\u2013${region.end.toFixed(2)}s)`;
    el.innerHTML = `
            <span class="annotation-label">${region.species || "Annotation"}</span>
            <span class="annotation-confidence">${region.confidence != null ? `${Math.round(region.confidence * 100)}%` : ""}</span>
            <span class="annotation-handle handle-l" data-mode="resize-l"></span>
            <span class="annotation-handle handle-r" data-mode="resize-r"></span>
        `;
    el.addEventListener("click", (event) => {
      if (performance.now() < this._suppressClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
      this.player?._emit?.("labelfocus", { id: region.id, source: "waveform" });
      this.player?._state?._blockSeekClicks?.(260);
      this.player?.playSegment?.(region.start, region.end, { labelId: region.id });
    });
    el.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._suppressClickUntil = performance.now() + 250;
      this._renameRegionPrompt(region.id);
    });
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this.player?._emit?.("labelfocus", { id: region.id, source: "waveform" });
      const handle = event.target?.closest?.(".annotation-handle");
      const mode = handle?.dataset?.mode || "move";
      this._startEditInteraction(region.id, mode, event.clientX, el);
      event.preventDefault();
      event.stopPropagation();
    });
    return el;
  }
  _bindEditingInteractions(root) {
    const onPointerMove = (e) => {
      if (!this._editing) return;
      this._updateEditInteraction(e.clientX);
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerUp = (e) => {
      if (!this._editing) return;
      this._finishEditInteraction();
      e.preventDefault();
      e.stopPropagation();
    };
    root.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    this._domCleanups.push(() => root.removeEventListener("pointermove", onPointerMove, true));
    this._domCleanups.push(() => document.removeEventListener("pointerup", onPointerUp, true));
    this._domCleanups.push(() => document.removeEventListener("pointercancel", onPointerUp, true));
  }
  _startEditInteraction(id, mode, clientX, element) {
    const region = this.annotations.find((a) => a.id === id);
    if (!region) return;
    this._editing = {
      id,
      mode,
      startX: clientX,
      startRegion: { ...region },
      element,
      pending: mode === "move",
      moved: mode !== "move",
      forceSuppressClick: mode !== "move"
    };
    if (mode !== "move") element.classList.add("editing");
  }
  _updateEditInteraction(clientX) {
    if (!this._editing) return;
    const region = this.annotations.find((a) => a.id === this._editing.id);
    if (!region) return;
    const pps = this.player?._state?.pixelsPerSecond || 100;
    const duration = Math.max(1e-3, this.player?.duration || this.player?._state?.audioBuffer?.duration || 1e-3);
    const dt = (clientX - this._editing.startX) / Math.max(1, pps);
    const src = this._editing.startRegion;
    let next = { ...region };
    if (this._editing.pending) {
      if (Math.abs(clientX - this._editing.startX) < 4) return;
      this._editing.pending = false;
      this._editing.moved = true;
      this._editing.element?.classList?.add("editing");
    }
    if (this._editing.mode === "move") {
      const span = src.end - src.start;
      next.start = clamp(src.start + dt, 0, Math.max(0, duration - span));
      next.end = next.start + span;
    } else if (this._editing.mode === "resize-l") {
      next.start = clamp(src.start + dt, 0, src.end - 0.01);
    } else if (this._editing.mode === "resize-r") {
      next.end = clamp(src.end + dt, src.start + 0.01, duration);
    }
    Object.assign(region, this._normalize({ ...src, ...next, id: src.id }));
    this.player?._state?.updateActiveSegmentFromLabel?.(region);
    this.player?._emit?.("annotationpreview", { annotation: { ...region } });
    const el = this._editing.element;
    if (el) {
      el.dataset.start = String(region.start);
      el.dataset.end = String(region.end);
      el.style.left = `${Math.max(0, region.start * pps)}px`;
      el.style.width = `${Math.max(1, (region.end - region.start) * pps)}px`;
    }
  }
  _finishEditInteraction() {
    if (!this._editing) return;
    const shouldSuppressClick = this._editing.forceSuppressClick || this._editing.moved;
    this._editing.element?.classList?.remove("editing");
    const region = this.annotations.find((a) => a.id === this._editing.id);
    if (region && this._editing.moved) this.player?._emit?.("annotationupdate", { annotation: { ...region } });
    this._editing = null;
    if (shouldSuppressClick) {
      this._suppressClickUntil = performance.now() + 250;
      this.render();
    }
  }
  _renameRegionPrompt(id) {
    const region = this.annotations.find((a) => a.id === id);
    if (!region) return;
    const current = region.species || "Annotation";
    const el = this.overlay?.querySelector?.(`.annotation-region[data-id="${region.id}"]`);
    openLabelNameEditor({
      player: this.player,
      anchorEl: el || this.overlay,
      initialValue: current,
      initialColor: region.color,
      onSubmit: ({ name, color }) => {
        const currentHex = getOverlayColorStyle(region.color)?.hex || "";
        if (name === current && color === currentHex) return;
        region.species = name;
        region.color = color;
        this.player?._emit?.("annotationupdate", { annotation: { ...region } });
        this.render();
      }
    });
  }
  _normalize(annotation) {
    const start = Number(annotation?.start ?? 0);
    const end = Number(annotation?.end ?? start);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error("AnnotationLayer: start/end must be finite numbers");
    }
    const s = Math.max(0, Math.min(start, end));
    const e = Math.max(0, Math.max(start, end));
    return {
      id: annotation?.id || `ann_${Math.random().toString(36).slice(2, 10)}`,
      start: s,
      end: Math.max(s + 0.01, e),
      species: annotation?.species || "",
      confidence: annotation?.confidence,
      color: String(annotation?.color || "").trim()
    };
  }
};
var SpectrogramLabelLayer = class {
  constructor() {
    this.player = null;
    this.overlay = null;
    this.labels = [];
    this._liveLinkedId = null;
    this._unsubs = [];
    this._domCleanups = [];
    this._draftEl = null;
    this._drawing = null;
    this._editing = null;
    this._counter = 1;
    this._suppressClickUntil = 0;
  }
  attach(player) {
    this.detach();
    this.player = player;
    const root = this.player?._state?.d?.canvasWrapper || this.player?.root?.querySelector(".canvas-wrapper");
    if (!root) return;
    this.overlay = document.createElement("div");
    this.overlay.className = "spectrogram-label-layer";
    root.appendChild(this.overlay);
    this._unsubs.push(this.player.on("ready", () => this.render()));
    this._unsubs.push(this.player.on("zoomchange", () => this.render()));
    this._unsubs.push(this.player.on("viewresize", () => this.render()));
    this._unsubs.push(this.player.on("spectrogramscalechange", () => this.render()));
    this._unsubs.push(this.player.on("timeupdate", (e) => this.highlightActiveLabel(e.detail.currentTime)));
    this._bindDrawingInteractions(root);
    this.render();
  }
  detach() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    for (const cleanup of this._domCleanups) cleanup();
    this._domCleanups = [];
    if (this.overlay?.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
    this.player = null;
    this._draftEl = null;
    this._drawing = null;
    this._editing = null;
  }
  add(label) {
    const region = this._normalize(label);
    this.labels.push(region);
    this.render();
    this.player?._emit?.("spectrogramlabelcreate", { label: region });
    return region.id;
  }
  set(labels = []) {
    this.labels = labels.map((l) => this._normalize(l));
    this.render();
  }
  clear() {
    this.labels = [];
    this.render();
  }
  remove(id) {
    this.labels = this.labels.filter((l) => l.id !== id);
    this.render();
  }
  getAll() {
    return [...this.labels];
  }
  setLiveLinkedId(id = null) {
    this._liveLinkedId = id || null;
  }
  highlightActiveLabel(currentTime) {
    if (!this.overlay) return;
    for (const el of this.overlay.querySelectorAll(".spectrogram-label-region")) {
      const start = parseFloat(el.dataset.start || "0");
      const end = parseFloat(el.dataset.end || "0");
      el.classList.toggle("active", currentTime >= start && currentTime <= end);
    }
  }
  render() {
    if (!this.overlay || !this.player) return;
    const state = this.player._state;
    const duration = this.player.duration || state?.audioBuffer?.duration || 0;
    const width = Math.max(1, state?.d?.spectrogramCanvas?.width || Math.floor(duration * (state?.pixelsPerSecond || 100)));
    const height = Math.max(1, state?.d?.spectrogramCanvas?.height || 1);
    this.overlay.style.width = `${width}px`;
    this.overlay.style.height = `${height}px`;
    this.overlay.innerHTML = "";
    for (const label of this.labels) {
      const el = this._createLabelElement(label, width, height);
      this.overlay.appendChild(el);
    }
  }
  _createLabelElement(label, canvasWidth, canvasHeight) {
    const el = document.createElement("div");
    el.className = "spectrogram-label-region";
    if (this._liveLinkedId && label.id === this._liveLinkedId) el.classList.add("linked-live");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    this._applyGeometryToElement(el, this._toGeometry(label, canvasWidth, canvasHeight));
    const colorStyle = getOverlayColorStyle(label.color);
    if (colorStyle) {
      el.style.setProperty("--spectrogram-label-color", colorStyle.fill);
      el.style.setProperty("--spectrogram-label-edge", colorStyle.edge);
      el.style.setProperty("--spectrogram-label-soft", colorStyle.soft);
    }
    el.dataset.id = label.id;
    el.dataset.start = String(label.start);
    el.dataset.end = String(label.end);
    el.title = `${label.label || "Label"} ${label.start.toFixed(2)}s\u2013${label.end.toFixed(2)}s / ${Math.round(label.freqMin)}-${Math.round(label.freqMax)} Hz`;
    el.innerHTML = `
            <span class="spectrogram-label-text">${label.label || "Label"}</span>
            <span class="spectrogram-label-meta">${Math.round(label.freqMin)}-${Math.round(label.freqMax)} Hz</span>
            <span class="label-handle handle-tl" data-mode="resize-tl"></span>
            <span class="label-handle handle-tr" data-mode="resize-tr"></span>
            <span class="label-handle handle-bl" data-mode="resize-bl"></span>
            <span class="label-handle handle-br" data-mode="resize-br"></span>
            <span class="label-handle handle-l" data-mode="resize-l"></span>
            <span class="label-handle handle-r" data-mode="resize-r"></span>
            <span class="label-handle handle-t" data-mode="resize-t"></span>
            <span class="label-handle handle-b" data-mode="resize-b"></span>
        `;
    el.addEventListener("click", (event) => {
      if (performance.now() < this._suppressClickUntil) return;
      event.stopPropagation();
      event.preventDefault();
      this.player?._emit?.("labelfocus", { id: label.id, source: "spectrogram" });
      this.player?._state?._blockSeekClicks?.(260);
      this.player?.playBandpassedSegment?.(
        label.start,
        label.end,
        label.freqMin,
        label.freqMax,
        { labelId: label.id }
      );
    });
    el.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._suppressClickUntil = performance.now() + 250;
      this._renameSpectrogramLabelPrompt(label.id);
    });
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this.player?._emit?.("labelfocus", { id: label.id, source: "spectrogram" });
      const handle = event.target?.closest?.(".label-handle");
      const mode = handle?.dataset?.mode || "move";
      this._startEditInteraction(label.id, mode, event.clientX, event.clientY, el);
      event.preventDefault();
      event.stopPropagation();
    });
    return el;
  }
  _applyGeometryToElement(el, geometry) {
    el.style.left = `${geometry.left}px`;
    el.style.top = `${geometry.top}px`;
    el.style.width = `${geometry.width}px`;
    el.style.height = `${geometry.height}px`;
  }
  _toGeometry(label, canvasWidth, canvasHeight) {
    const state = this.player?._state;
    const duration = Math.max(1e-3, this.player?.duration || state?.audioBuffer?.duration || 1e-3);
    const maxFreq = this._getMaxFreq();
    const x1 = clamp(label.start / duration * canvasWidth, 0, canvasWidth);
    const x2 = clamp(label.end / duration * canvasWidth, 0, canvasWidth);
    const yHigh = clamp((1 - label.freqMax / maxFreq) * canvasHeight, 0, canvasHeight);
    const yLow = clamp((1 - label.freqMin / maxFreq) * canvasHeight, 0, canvasHeight);
    return {
      left: Math.min(x1, x2),
      top: Math.min(yHigh, yLow),
      width: Math.max(1, Math.abs(x2 - x1)),
      height: Math.max(1, Math.abs(yLow - yHigh))
    };
  }
  _bindDrawingInteractions(wrapper) {
    const onPointerDown = (e) => {
      if (e.target?.closest?.(".spectrogram-label-region")) return;
      if (!e.shiftKey || e.button !== 0) return;
      if (!this.player?._state?.audioBuffer) return;
      const start = this._clientXToTime(e.clientX);
      const freq = this._clientYToFreq(e.clientY);
      this._drawing = { startTime: start, startFreq: freq, endTime: start, endFreq: freq };
      this._ensureDraft();
      this._updateDraft();
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerMove = (e) => {
      if (this._editing) {
        this._updateEditInteraction(e.clientX, e.clientY);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this._drawing) {
        this._drawing.endTime = this._clientXToTime(e.clientX);
        this._drawing.endFreq = this._clientYToFreq(e.clientY);
        this._updateDraft();
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onPointerUp = (e) => {
      if (this._editing) {
        this._finishEditInteraction();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this._drawing) {
        const region = this._finalizeDraft();
        if (region) this.add(region);
        this._clearDraft();
        e.preventDefault();
        e.stopPropagation();
      }
    };
    wrapper.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    this._domCleanups.push(() => wrapper.removeEventListener("pointerdown", onPointerDown, true));
    this._domCleanups.push(() => document.removeEventListener("pointermove", onPointerMove, true));
    this._domCleanups.push(() => document.removeEventListener("pointerup", onPointerUp, true));
    this._domCleanups.push(() => document.removeEventListener("pointercancel", onPointerUp, true));
  }
  _ensureDraft() {
    if (!this.overlay || this._draftEl) return;
    this._draftEl = document.createElement("div");
    this._draftEl.className = "spectrogram-label-draft";
    this.overlay.appendChild(this._draftEl);
  }
  _updateDraft() {
    if (!this._drawing || !this._draftEl || !this.overlay) return;
    const width = parseFloat(this.overlay.style.width) || 1;
    const height = parseFloat(this.overlay.style.height) || 1;
    const preview = this._normalize({
      start: this._drawing.startTime,
      end: this._drawing.endTime,
      freqMin: Math.min(this._drawing.startFreq, this._drawing.endFreq),
      freqMax: Math.max(this._drawing.startFreq, this._drawing.endFreq),
      label: "New label"
    });
    const g = this._toGeometry(preview, width, height);
    this._draftEl.style.left = `${g.left}px`;
    this._draftEl.style.top = `${g.top}px`;
    this._draftEl.style.width = `${g.width}px`;
    this._draftEl.style.height = `${g.height}px`;
  }
  _finalizeDraft() {
    if (!this._drawing) return null;
    const region = this._normalize({
      start: this._drawing.startTime,
      end: this._drawing.endTime,
      freqMin: Math.min(this._drawing.startFreq, this._drawing.endFreq),
      freqMax: Math.max(this._drawing.startFreq, this._drawing.endFreq),
      label: `Label ${this._counter++}`
    });
    const duration = Math.abs(region.end - region.start);
    const freqSpan = Math.abs(region.freqMax - region.freqMin);
    if (duration < 0.02 || freqSpan < 20) return null;
    return region;
  }
  _clearDraft() {
    this._drawing = null;
    if (this._draftEl?.parentNode) this._draftEl.parentNode.removeChild(this._draftEl);
    this._draftEl = null;
  }
  _startEditInteraction(labelId, mode, clientX, clientY, element) {
    const label = this.labels.find((l) => l.id === labelId);
    if (!label) return;
    this._editing = {
      id: labelId,
      mode,
      startX: clientX,
      startY: clientY,
      startLabel: { ...label },
      element,
      pending: mode === "move",
      moved: mode !== "move",
      forceSuppressClick: mode !== "move"
    };
    if (mode !== "move") element.classList.add("editing");
  }
  _updateEditInteraction(clientX, clientY) {
    if (!this._editing) return;
    const label = this.labels.find((l) => l.id === this._editing.id);
    if (!label) return;
    const duration = Math.max(1e-3, this.player?.duration || this.player?._state?.audioBuffer?.duration || 1e-3);
    const maxFreq = this._getMaxFreq();
    const width = Math.max(1, this.player?._state?.d?.spectrogramCanvas?.width || 1);
    const height = Math.max(1, this.player?._state?.d?.spectrogramCanvas?.height || 1);
    const dt = (clientX - this._editing.startX) / width * duration;
    const df = -(clientY - this._editing.startY) / height * maxFreq;
    const src = this._editing.startLabel;
    if (this._editing.pending) {
      if (Math.abs(clientX - this._editing.startX) < 4 && Math.abs(clientY - this._editing.startY) < 4) return;
      this._editing.pending = false;
      this._editing.moved = true;
      this._editing.element?.classList?.add("editing");
    }
    let next = { ...label };
    switch (this._editing.mode) {
      case "move":
        next.start = src.start + dt;
        next.end = src.end + dt;
        next.freqMin = src.freqMin + df;
        next.freqMax = src.freqMax + df;
        break;
      case "resize-l":
        next.start = src.start + dt;
        break;
      case "resize-r":
        next.end = src.end + dt;
        break;
      case "resize-t":
        next.freqMax = src.freqMax + df;
        break;
      case "resize-b":
        next.freqMin = src.freqMin + df;
        break;
      case "resize-tl":
        next.start = src.start + dt;
        next.freqMax = src.freqMax + df;
        break;
      case "resize-tr":
        next.end = src.end + dt;
        next.freqMax = src.freqMax + df;
        break;
      case "resize-bl":
        next.start = src.start + dt;
        next.freqMin = src.freqMin + df;
        break;
      case "resize-br":
        next.end = src.end + dt;
        next.freqMin = src.freqMin + df;
        break;
      default:
        break;
    }
    next = this._normalize({ ...src, ...next, id: src.id, label: src.label, color: src.color });
    if (this._editing.mode === "move") {
      const timeSpan = Math.max(0.01, src.end - src.start);
      const freqSpan = Math.max(1, src.freqMax - src.freqMin);
      next.end = next.start + timeSpan;
      next.freqMax = next.freqMin + freqSpan;
      if (next.end > duration) {
        const shift = next.end - duration;
        next.start = Math.max(0, next.start - shift);
        next.end = duration;
      }
      if (next.freqMax > maxFreq) {
        const shift = next.freqMax - maxFreq;
        next.freqMin = Math.max(0, next.freqMin - shift);
        next.freqMax = maxFreq;
      }
    }
    Object.assign(label, next);
    this.player?._state?.updateActiveSegmentFromLabel?.(label);
    this.player?._emit?.("spectrogramlabelpreview", { label: { ...label } });
    if (this._editing.element) {
      this._editing.element.dataset.start = String(label.start);
      this._editing.element.dataset.end = String(label.end);
      this._editing.element.title = `${label.label || "Label"} ${label.start.toFixed(2)}s\u2013${label.end.toFixed(2)}s / ${Math.round(label.freqMin)}-${Math.round(label.freqMax)} Hz`;
      const geometry = this._toGeometry(label, width, height);
      this._applyGeometryToElement(this._editing.element, geometry);
      const meta = this._editing.element.querySelector(".spectrogram-label-meta");
      if (meta) meta.textContent = `${Math.round(label.freqMin)}-${Math.round(label.freqMax)} Hz`;
    }
  }
  _finishEditInteraction() {
    if (!this._editing) return;
    const shouldSuppressClick = this._editing.forceSuppressClick || this._editing.moved;
    this._editing.element?.classList?.remove("editing");
    const label = this.labels.find((l) => l.id === this._editing.id);
    if (label && this._editing.moved) this.player?._emit?.("spectrogramlabelupdate", { label });
    this._editing = null;
    if (shouldSuppressClick) {
      this._suppressClickUntil = performance.now() + 250;
      this.render();
    }
  }
  _renameSpectrogramLabelPrompt(id) {
    const label = this.labels.find((l) => l.id === id);
    if (!label) return;
    const current = label.label || "Label";
    const el = this.overlay?.querySelector?.(`.spectrogram-label-region[data-id="${label.id}"]`);
    openLabelNameEditor({
      player: this.player,
      anchorEl: el || this.overlay,
      initialValue: current,
      initialColor: label.color,
      onSubmit: ({ name, color }) => {
        const currentHex = getOverlayColorStyle(label.color)?.hex || "";
        if (name === current && color === currentHex) return;
        label.label = name;
        label.color = color;
        this.player?._emit?.("spectrogramlabelupdate", { label: { ...label } });
        this.render();
      }
    });
  }
  _clientXToTime(clientX) {
    return this.player?._state?._clientXToTime?.(clientX, "spectrogram") || 0;
  }
  _clientYToFreq(clientY) {
    const state = this.player?._state;
    const wrapper = state?.d?.canvasWrapper;
    const canvas = state?.d?.spectrogramCanvas;
    if (!wrapper || !canvas) return 0;
    const rect = wrapper.getBoundingClientRect();
    const y = clamp(clientY - rect.top, 0, Math.max(1, canvas.height));
    const normalized = 1 - y / Math.max(1, canvas.height);
    return normalized * this._getMaxFreq();
  }
  _getMaxFreq() {
    const state = this.player?._state;
    const selected = parseFloat(state?.d?.maxFreqSelect?.value || "10000");
    const nyquist = (state?.sampleRateHz || 32e3) / 2;
    return Math.max(1, Math.min(selected, nyquist));
  }
  _normalize(label) {
    const start = Number(label?.start ?? 0);
    const end = Number(label?.end ?? start);
    const freqMin = Number(label?.freqMin ?? 0);
    const freqMax = Number(label?.freqMax ?? freqMin);
    if (![start, end, freqMin, freqMax].every(Number.isFinite)) {
      throw new Error("SpectrogramLabelLayer: numeric start/end/freqMin/freqMax required");
    }
    const maxFreq = this._getMaxFreq();
    const s = Math.max(0, Math.min(start, end));
    const duration = Math.max(1e-3, this.player?.duration || this.player?._state?.audioBuffer?.duration || Math.max(start, end, 1e-3));
    const e = Math.min(duration, Math.max(0, Math.max(start, end)));
    const f0 = clamp(Math.min(freqMin, freqMax), 0, maxFreq);
    const f1 = clamp(Math.max(freqMin, freqMax), 0, maxFreq);
    return {
      id: label?.id || `slabel_${Math.random().toString(36).slice(2, 10)}`,
      start: s,
      end: Math.max(s + 0.01, e),
      freqMin: f0,
      freqMax: Math.max(f0 + 1, f1),
      label: label?.label || "",
      color: String(label?.color || "").trim()
    };
  }
};

// src/BirdNETPlayer.js
var WAVESURFER_CDN = "https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js";
var DEFAULT_LABEL_TAXONOMY = [
  { name: "Bird Call", color: "#0ea5e9", shortcut: "1" },
  { name: "Song", color: "#22c55e", shortcut: "2" },
  { name: "Chirp", color: "#f59e0b", shortcut: "3" },
  { name: "Noise", color: "#ef4444", shortcut: "4" }
];
var BirdNETPlayer = class {
  /**
   * @param {HTMLElement} container — the DOM element to mount the player into
   * @param {Object}      [options]
   * @param {Object}      [options.WaveSurfer]     — pre-loaded WaveSurfer constructor
   * @param {boolean}     [options.showFileOpen]    — show Open button (default: true)
   * @param {boolean}     [options.showTransport]   — show transport controls (default: true)
   * @param {boolean}     [options.showTime]        — show time display (default: true)
   * @param {boolean}     [options.showVolume]      — show volume controls (default: true)
   * @param {boolean}     [options.showViewToggles] — show Follow/Loop/Fit/Reset (default: true)
   * @param {boolean}     [options.showZoom]        — show zoom slider (default: true)
   * @param {boolean}     [options.showFFTControls] — show FFT/Freq/Color selects (default: true)
   * @param {boolean}     [options.showDisplayGain] — show Floor/Ceil sliders (default: true)
   * @param {boolean}     [options.showStatusbar]   — show bottom status bar (default: true)
   * @param {boolean}     [options.showOverview]    — show overview navigator (default: true)
   * @param {'both'|'waveform'|'spectrogram'} [options.viewMode] — visible analysis view(s) (default: both)
   * @param {'default'|'hero'} [options.transportStyle] — transport button style (default: default)
   * @param {boolean}     [options.transportOverlay] — centered play overlay without toolbar height (default: false)
   * @param {boolean}     [options.showWaveformTimeline] — show bottom waveform timeline (default: true)
   * @param {'auto'|'on'|'off'} [options.compactToolbar] — responsive toolbar compaction mode (default: auto)
   * @param {number}      [options.followGuardLeftRatio] — left follow guard ratio (default: 0.35)
   * @param {number}      [options.followGuardRightRatio] — right follow guard ratio (default: 0.65)
   * @param {number}      [options.followTargetRatio] — target ratio for viewport centering (default: 0.5)
   * @param {number}      [options.followCatchupDurationMs] — follow catchup tween duration (default: 240)
   * @param {number}      [options.followCatchupSeekDurationMs] — slower follow tween after manual seek (default: 360)
   * @param {number}      [options.smoothLerp] — smooth mode lerp factor (default: 0.18)
   * @param {number}      [options.smoothSeekLerp] — smooth mode lerp after manual seek (default: 0.08)
   * @param {number}      [options.smoothMinStepRatio] — smooth min step ratio (default: 0.03)
   * @param {number}      [options.smoothSeekMinStepRatio] — smooth min step ratio after seek (default: 0.008)
   * @param {number}      [options.smoothSeekFocusMs] — slow-follow window after manual seek (default: 1400)
   */
  constructor(container, options = {}) {
    if (!container) throw new Error("BirdNETPlayer: container element required");
    this.container = container;
    this.options = options;
    this._state = null;
    this._events = new EventTarget();
    this.annotations = new AnnotationLayer();
    this.spectrogramLabels = new SpectrogramLabelLayer();
    this._linkedLabels = /* @__PURE__ */ new Map();
    this._isSyncingLabels = false;
    this._labelLibrary = /* @__PURE__ */ new Map();
    this._labelTaxonomy = this._normalizeTaxonomy(options.labelTaxonomy || DEFAULT_LABEL_TAXONOMY);
    this._activeLabelId = null;
    this._globalKeyHandler = null;
    this.on = (event, callback, options2) => {
      this._events.addEventListener(event, callback, options2);
      return () => this.off(event, callback, options2);
    };
    this.off = (event, callback, options2) => {
      this._events.removeEventListener(event, callback, options2);
    };
    this.ready = this._init();
  }
  // ── Initialization ──────────────────────────────────────────────
  async _init() {
    this.container.innerHTML = createPlayerHTML(this.options);
    this.root = this.container.querySelector(".daw-shell");
    const WaveSurfer = this.options.WaveSurfer || window.WaveSurfer || (await import(
      /* @vite-ignore */
      WAVESURFER_CDN
    )).default;
    this._state = new PlayerState(
      this.root,
      WaveSurfer,
      (event, detail) => this._emit(event, detail),
      this.options
    );
    this.annotations.attach(this);
    this.spectrogramLabels.attach(this);
    this._bindLinkedLabelSync();
    this._bindGlobalHotkeys();
    this._emit("ready", { phase: "init" });
    return this;
  }
  _emit(event, detail = {}) {
    this._events.dispatchEvent(new CustomEvent(event, { detail }));
  }
  // ── Public API ──────────────────────────────────────────────────
  /** Load audio from a URL (http, blob:, data: URLs all supported) */
  async loadUrl(url) {
    await this.ready;
    return this._state.loadUrl(url);
  }
  /** Load audio from a File object (e.g. from an <input type="file">) */
  async loadFile(file) {
    await this.ready;
    return this._state._handleFileSelect({ target: { files: [file] } });
  }
  /** Current playback time in seconds */
  get currentTime() {
    return this._state?._getCurrentTime() || 0;
  }
  /** Duration of loaded audio in seconds */
  get duration() {
    return this._state?.audioBuffer?.duration || 0;
  }
  play() {
    this._state?.wavesurfer?.play();
  }
  pause() {
    this._state?.wavesurfer?.pause();
  }
  stop() {
    this._state?._stopPlayback();
  }
  togglePlayPause() {
    this._state?._togglePlayPause();
  }
  playSegment(startSec, endSec, options) {
    this._state?.playSegment(startSec, endSec, options);
  }
  playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options) {
    this._state?.playBandpassedSegment(startSec, endSec, freqMinHz, freqMaxHz, options);
  }
  addAnnotation(annotation) {
    const id = annotation?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
    const existing = this._linkedLabels.get(id);
    const merged = this._normalizeLinkedLabel({
      ...existing,
      ...annotation,
      id,
      label: annotation?.label ?? annotation?.species ?? existing?.label ?? "Label"
    });
    this._linkedLabels.set(id, merged);
    this._syncLinkedLabelsToLayers();
    return id;
  }
  setAnnotations(annotations) {
    const next = /* @__PURE__ */ new Map();
    for (const ann of annotations || []) {
      const id = ann?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
      const existing = this._linkedLabels.get(id);
      next.set(id, this._normalizeLinkedLabel({
        ...existing,
        ...ann,
        id,
        label: ann?.label ?? ann?.species ?? existing?.label ?? "Label"
      }));
    }
    this._linkedLabels = next;
    this._syncLinkedLabelsToLayers();
  }
  clearAnnotations() {
    this._linkedLabels.clear();
    this._syncLinkedLabelsToLayers();
  }
  exportAnnotationsRaven() {
    return this.annotations.exportRavenFormat(this._toAnnotationList());
  }
  addSpectrogramLabel(label) {
    const id = label?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
    const existing = this._linkedLabels.get(id);
    const merged = this._normalizeLinkedLabel({
      ...existing,
      ...label,
      id,
      species: label?.species ?? label?.label ?? existing?.species ?? "",
      label: label?.label ?? existing?.label ?? label?.species ?? "Label"
    });
    this._linkedLabels.set(id, merged);
    this._syncLinkedLabelsToLayers();
    return id;
  }
  setSpectrogramLabels(labels) {
    const next = /* @__PURE__ */ new Map();
    for (const lbl of labels || []) {
      const id = lbl?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
      const existing = this._linkedLabels.get(id);
      next.set(id, this._normalizeLinkedLabel({
        ...existing,
        ...lbl,
        id,
        species: lbl?.species ?? lbl?.label ?? existing?.species ?? "",
        label: lbl?.label ?? existing?.label ?? lbl?.species ?? "Label"
      }));
    }
    this._linkedLabels = next;
    this._syncLinkedLabelsToLayers();
  }
  clearSpectrogramLabels() {
    this._linkedLabels.clear();
    this._syncLinkedLabelsToLayers();
  }
  renameLabel(id, name) {
    const key = String(id || "").trim();
    const value = String(name || "").trim();
    if (!key || !value) return false;
    const current = this._linkedLabels.get(key);
    if (!current) return false;
    this._linkedLabels.set(key, this._normalizeLinkedLabel({
      ...current,
      id: key,
      label: value,
      species: value
    }));
    this._syncLinkedLabelsToLayers();
    return true;
  }
  getLabelSuggestions(prefix = "", limit = 10) {
    const q = String(prefix || "").trim().toLowerCase();
    const ranked = Array.from(this._labelLibrary.entries()).filter(([name]) => !q || name.toLowerCase().includes(q)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.max(1, limit)).map(([name]) => name);
    return ranked;
  }
  getLabelTaxonomy() {
    return this._labelTaxonomy.map((item) => ({ ...item }));
  }
  setLabelTaxonomy(taxonomy = []) {
    this._labelTaxonomy = this._normalizeTaxonomy(taxonomy);
    this._syncLinkedLabelsToLayers();
  }
  applyTaxonomyToLabel(id, shortcutOrIndex) {
    const key = String(id || "").trim();
    const current = this._linkedLabels.get(key);
    if (!current) return false;
    const index = typeof shortcutOrIndex === "number" ? shortcutOrIndex : this._labelTaxonomy.findIndex((t) => t.shortcut === String(shortcutOrIndex));
    if (index < 0 || index >= this._labelTaxonomy.length) return false;
    const tax = this._labelTaxonomy[index];
    const next = this._normalizeLinkedLabel({
      ...current,
      id: key,
      label: tax.name,
      species: tax.name,
      color: tax.color || current.color
    });
    this._linkedLabels.set(key, next);
    this._activeLabelId = key;
    this._syncLinkedLabelsToLayers();
    this._emit("labeltaxonomyapply", { id: key, taxonomy: { ...tax } });
    return true;
  }
  setPlaybackViewportConfig(config = {}) {
    return this._state?.updatePlaybackViewportConfig?.(config) || null;
  }
  getPlaybackViewportConfig() {
    return this._state?.getPlaybackViewportConfig?.() || null;
  }
  /** Tear down the player and free resources */
  destroy() {
    if (this._globalKeyHandler) {
      document.removeEventListener("keydown", this._globalKeyHandler, true);
      this._globalKeyHandler = null;
    }
    this.annotations.detach();
    this.spectrogramLabels.detach();
    this._state?.dispose();
    this._state = null;
    this.container.innerHTML = "";
  }
  _bindLinkedLabelSync() {
    this.on("labelfocus", (e) => {
      const id = String(e?.detail?.id || "").trim();
      this._activeLabelId = id || null;
    });
    this.on("annotationpreview", (e) => this._previewFromAnnotationEvent(e.detail.annotation));
    this.on("spectrogramlabelpreview", (e) => this._previewFromSpectrogramEvent(e.detail.label));
    this.on("annotationcreate", (e) => this._upsertFromAnnotationEvent(e.detail.annotation));
    this.on("annotationupdate", (e) => this._upsertFromAnnotationEvent(e.detail.annotation));
    this.on("spectrogramlabelcreate", (e) => this._upsertFromSpectrogramEvent(e.detail.label));
    this.on("spectrogramlabelupdate", (e) => this._upsertFromSpectrogramEvent(e.detail.label));
  }
  _bindGlobalHotkeys() {
    this._globalKeyHandler = (event) => {
      if (!this._activeLabelId) return;
      const tag = event?.target?.tagName?.toLowerCase?.() || "";
      const typing = tag === "input" || tag === "textarea" || event?.target?.isContentEditable;
      if (typing) return;
      const key = String(event.key || "");
      if (!/^[1-9]$/.test(key)) return;
      const idx = Number(key) - 1;
      if (idx >= this._labelTaxonomy.length) return;
      event.preventDefault();
      this.applyTaxonomyToLabel(this._activeLabelId, idx);
    };
    document.addEventListener("keydown", this._globalKeyHandler, true);
  }
  _previewFromAnnotationEvent(annotation) {
    if (this._isSyncingLabels || !annotation) return;
    const id = annotation.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
    const existing = this._linkedLabels.get(id);
    const next = this._normalizeLinkedLabel({
      ...existing,
      ...annotation,
      id,
      label: annotation?.species ?? existing?.label ?? "Label"
    });
    this._linkedLabels.set(id, next);
    this._state?.updateActiveSegmentFromLabel?.(next);
    this.spectrogramLabels.setLiveLinkedId(id);
    this.spectrogramLabels.set(this._toSpectrogramLabelList());
  }
  _previewFromSpectrogramEvent(label) {
    if (this._isSyncingLabels || !label) return;
    const id = label.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
    const existing = this._linkedLabels.get(id);
    const nextName = String(label?.label || label?.species || existing?.label || existing?.species || "Label").trim();
    const next = this._normalizeLinkedLabel({
      ...existing,
      ...label,
      id,
      species: nextName,
      label: nextName
    });
    this._linkedLabels.set(id, next);
    this._state?.updateActiveSegmentFromLabel?.(next);
    this.annotations.setLiveLinkedId(id);
    this.annotations.set(this._toAnnotationList());
  }
  _upsertFromAnnotationEvent(annotation) {
    if (this._isSyncingLabels || !annotation) return;
    const id = annotation.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
    const existing = this._linkedLabels.get(id);
    const next = this._normalizeLinkedLabel({
      ...existing,
      ...annotation,
      id,
      label: annotation?.species ?? existing?.label ?? "Label"
    });
    this._linkedLabels.set(id, next);
    this._state?.updateActiveSegmentFromLabel?.(next);
    this.annotations.setLiveLinkedId(null);
    this.spectrogramLabels.setLiveLinkedId(null);
    this._syncLinkedLabelsToLayers();
  }
  _upsertFromSpectrogramEvent(label) {
    if (this._isSyncingLabels || !label) return;
    const id = label.id || `lbl_${Math.random().toString(36).slice(2, 10)}`;
    const existing = this._linkedLabels.get(id);
    const nextName = String(label?.label || label?.species || existing?.label || existing?.species || "Label").trim();
    const next = this._normalizeLinkedLabel({
      ...existing,
      ...label,
      id,
      species: nextName,
      label: nextName
    });
    this._linkedLabels.set(id, next);
    this._state?.updateActiveSegmentFromLabel?.(next);
    this.annotations.setLiveLinkedId(null);
    this.spectrogramLabels.setLiveLinkedId(null);
    this._syncLinkedLabelsToLayers();
  }
  _syncLinkedLabelsToLayers() {
    this._isSyncingLabels = true;
    try {
      this.annotations.set(this._toAnnotationList());
      this.spectrogramLabels.set(this._toSpectrogramLabelList());
      this._rebuildLabelLibrary();
    } finally {
      this._isSyncingLabels = false;
    }
  }
  _rebuildLabelLibrary() {
    const next = /* @__PURE__ */ new Map();
    for (const item of this._linkedLabels.values()) {
      const label = String(item?.label || item?.species || "").trim();
      if (!label) continue;
      next.set(label, (next.get(label) || 0) + 1);
    }
    this._labelLibrary = next;
  }
  _normalizeTaxonomy(taxonomy) {
    const used = /* @__PURE__ */ new Set();
    const list = [];
    for (const item of taxonomy || []) {
      const name = String(item?.name || "").trim();
      if (!name) continue;
      const shortcut = String(item?.shortcut || "").trim();
      const normalizedShortcut = /^[1-9]$/.test(shortcut) && !used.has(shortcut) ? shortcut : "";
      if (normalizedShortcut) used.add(normalizedShortcut);
      list.push({
        name,
        color: item?.color ? String(item.color) : "",
        shortcut: normalizedShortcut
      });
      if (list.length >= 9) break;
    }
    return list;
  }
  _toAnnotationList() {
    return Array.from(this._linkedLabels.values()).map((l) => ({
      id: l.id,
      start: l.start,
      end: l.end,
      species: l.species || l.label || "",
      confidence: l.confidence,
      color: l.color
    }));
  }
  _toSpectrogramLabelList() {
    return Array.from(this._linkedLabels.values()).map((l) => ({
      id: l.id,
      start: l.start,
      end: l.end,
      freqMin: l.freqMin,
      freqMax: l.freqMax,
      label: l.label || l.species || "",
      color: l.color
    }));
  }
  _normalizeLinkedLabel(label) {
    const duration = Math.max(1e-3, this.duration || this._state?.audioBuffer?.duration || 1e-3);
    const nyquist = (this._state?.sampleRateHz || 32e3) / 2;
    const selected = parseFloat(this._state?.d?.maxFreqSelect?.value || `${nyquist}`);
    const maxFreq = Math.max(1, Math.min(selected, nyquist));
    const start = Math.max(0, Math.min(Number(label?.start ?? 0), duration));
    const end = Math.max(start + 0.01, Math.min(duration, Number(label?.end ?? start + 0.01)));
    const freqMinRaw = Number(label?.freqMin ?? 0);
    const freqMaxRaw = Number(label?.freqMax ?? maxFreq);
    const freqMin = Math.max(0, Math.min(freqMinRaw, maxFreq));
    const freqMax = Math.max(freqMin + 1, Math.min(maxFreq, freqMaxRaw));
    const labelName = String(label?.label || label?.species || "").trim();
    const tax = labelName ? this._labelTaxonomy.find((t) => t.name.toLowerCase() === labelName.toLowerCase()) : null;
    return {
      id: label?.id || `lbl_${Math.random().toString(36).slice(2, 10)}`,
      start,
      end,
      freqMin,
      freqMax,
      species: label?.species || "",
      label: label?.label || label?.species || "",
      confidence: label?.confidence,
      color: label?.color || tax?.color || ""
    };
  }
};
export {
  BirdNETPlayer,
  DEFAULT_OPTIONS
};
