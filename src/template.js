// ═══════════════════════════════════════════════════════════════════════
// template.js — Player HTML template (injected into container)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Default options for the player UI.
 * Every key corresponds to a visible section that can be toggled off.
 */
export const DEFAULT_OPTIONS = {
    showFileOpen:       true,   // Open-button + file input
    showTransport:      true,   // Play/Pause/Stop/Skip
    showTime:           true,   // Time display
    showVolume:         true,   // Volume slider + mute
    showViewToggles:    true,   // Follow / Loop / Fit / Reset
    showZoom:           true,   // Zoom slider
    showFFTControls:    true,   // FFT size, Freq, AF, Color
    showDisplayGain:    true,   // Floor / Ceil / AC sliders
    showStatusbar:      true,   // Bottom status bar
    showOverview:       true,   // Bottom overview navigator
    viewMode:           'both', // both | waveform | spectrogram
    transportStyle:     'default', // default | hero
    transportOverlay:   false,  // Overlay mode: centered play button without toolbar height
    showWaveformTimeline: true, // Draw bottom timeline row in waveform view
    compactToolbar:     'auto', // auto | on | off
    followGuardLeftRatio: 0.35,       // Follow mode lower guard (0..1)
    followGuardRightRatio: 0.65,      // Follow mode upper guard (0..1)
    followTargetRatio: 0.5,           // Viewport target position for catchup
    followCatchupDurationMs: 240,     // Follow catchup animation duration
    followCatchupSeekDurationMs: 360, // Follow catchup duration after manual seek
    smoothLerp: 0.18,                 // Smooth mode interpolation factor
    smoothSeekLerp: 0.08,             // Smooth mode interpolation after manual seek
    smoothMinStepRatio: 0.03,         // Smooth mode minimum step ratio
    smoothSeekMinStepRatio: 0.008,    // Smooth mode minimum step ratio after seek
    smoothSeekFocusMs: 1400,          // Slow-follow focus window after manual seek
};

/**
 * @param {Partial<typeof DEFAULT_OPTIONS>} opts
 */
export function createPlayerHTML(opts = {}) {
    const o = { ...DEFAULT_OPTIONS, ...opts };
    const hide = (flag) => flag ? '' : ' style="display:none"';
    const viewMode = ['both', 'waveform', 'spectrogram'].includes(o.viewMode) ? o.viewMode : 'both';
    const transportStyle = o.transportStyle === 'hero' ? 'hero' : 'default';
    const compactToolbar = ['auto', 'on', 'off'].includes(o.compactToolbar) ? o.compactToolbar : 'auto';
    const shellClass = [
        'daw-shell',
        `view-mode-${viewMode}`,
        `transport-style-${transportStyle}`,
        `compact-toolbar-${compactToolbar}`,
        o.transportOverlay ? 'transport-overlay' : '',
    ].join(' ');

    return `<div class="${shellClass}">

    <!-- ═══ Top Toolbar ═══ -->
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
        <input type="range" id="volumeSlider" class="toolbar-range toolbar-range-sm" min="0" max="100" value="80" title="Lautstärke"${hide(o.showVolume)}>

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
                <option value="grayscale" selected>B/W</option>
                <option value="fire">Fire</option>
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
            <input type="range" id="ceilSlider" class="toolbar-range toolbar-range-sm" min="0" max="100" value="100" title="Spectrogram Ceiling (Weißpunkt)">
            <button class="toolbar-btn mini-btn" id="autoContrastBtn" disabled title="Kontrast automatisch optimieren">AC</button>
        </span>
      </div>
    </div>

    <!-- ═══ Main Content ═══ -->
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
        <div class="view-split-handle" id="viewSplitHandle" title="Amplitude/Spektrogramm Verhältnis anpassen"></div>

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
            <div class="spectrogram-resize-handle" id="spectrogramResizeHandle" title="Spektrogramm-Höhe anpassen"></div>
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

    <!-- ═══ Status Bar ═══ -->
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
