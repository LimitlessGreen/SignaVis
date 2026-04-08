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
    <div class="toolbar" data-aw="toolbarRoot">
      <div class="toolbar-primary">
        <button class="toolbar-btn file-btn" data-aw="openFileBtn" title="Audio-Datei laden"${hide(o.showFileOpen)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Open
        </button>
        <input type="file" data-aw="audioFile" accept="audio/*" hidden>

        <div class="toolbar-sep"${hide(o.showFileOpen)}></div>

        <!-- Transport -->
        <div class="transport"${hide(o.showTransport)}>
            <button class="transport-btn" data-aw="jumpStartBtn" disabled title="Zum Anfang (Home)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="3" height="14"/><polygon points="20 5 10 12 20 19"/></svg>
            </button>
            <button class="transport-btn" data-aw="backwardBtn" disabled title="-5s (J)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 5 9 12 19 19"/><polygon points="12 5 2 12 12 19"/></svg>
            </button>
            <button class="transport-btn play-btn" data-aw="playPauseBtn" disabled title="Play / Pause (Space)">
                <svg class="icon-play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21"/></svg>
            </button>
            <button class="transport-btn" data-aw="stopBtn" disabled title="Stop">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            </button>
            <button class="transport-btn" data-aw="forwardBtn" disabled title="+5s (L)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 5 15 12 5 19"/><polygon points="12 5 22 12 12 19"/></svg>
            </button>
            <button class="transport-btn" data-aw="jumpEndBtn" disabled title="Zum Ende (End)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="4 5 14 12 4 19"/><rect x="18" y="5" width="3" height="14"/></svg>
            </button>
        </div>

        <!-- Time -->
        <div class="time-display" data-aw="timeDisplay" role="status" aria-live="polite"${hide(o.showTime)}>
            <span data-aw="currentTime">00:00.0</span><span class="time-sep">/</span><span data-aw="totalTime">00:00.0</span>
        </div>
        <button class="toolbar-btn compact-more-btn" data-aw="compactMoreBtn" aria-expanded="false" title="Weitere Controls anzeigen">More</button>
      </div>

      <div class="toolbar-secondary" data-aw="toolbarSecondary">

        <div class="toolbar-sep"${hide(o.showVolume)}></div>

        <!-- Volume -->
        <button class="toolbar-btn icon-btn" data-aw="volumeToggleBtn" title="Mute / Unmute"${hide(o.showVolume)}>
            <svg data-aw="volumeIcon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path data-aw="volumeWaves" d="M15 8.5a4 4 0 010 7M18 5a9 9 0 010 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
        </button>
        <input type="range" data-aw="volumeSlider" class="toolbar-range toolbar-range-sm" min="0" max="100" value="80" title="Lautstärke"${hide(o.showVolume)}>

        <div class="toolbar-sep"${hide(o.showViewToggles)}></div>

        <!-- Toggle tools -->
        <span${hide(o.showViewToggles)}>
            <button class="toolbar-btn toggle-btn active" data-aw="followToggleBtn" disabled title="Free / Follow / Smooth umschalten">Follow</button>
            <button class="toolbar-btn toggle-btn" data-aw="loopToggleBtn" disabled title="Loop">Loop</button>
            <button class="toolbar-btn toggle-btn" data-aw="crosshairToggleBtn" disabled title="Crosshair ein/aus">Crosshair</button>
            <button class="toolbar-btn" data-aw="fitViewBtn" disabled title="Fit to view">Fit</button>
            <button class="toolbar-btn" data-aw="resetViewBtn" disabled title="Reset zoom">Reset</button>
        </span>

        <div class="toolbar-sep"${hide(o.showZoom)}></div>

        <!-- Zoom -->
        <span${hide(o.showZoom)}>
            <label class="toolbar-label">Zoom</label>
            <input type="range" data-aw="zoomSlider" class="toolbar-range" min="20" max="600" value="100" step="5">
            <span class="toolbar-value" data-aw="zoomValue">100 px/s</span>
        </span>

        <div class="toolbar-sep"${hide(o.showFFTControls)}></div>

        <!-- Settings toggle (opens side panel) -->
        <button class="toolbar-btn settings-toggle-btn" data-aw="settingsToggleBtn" title="Settings-Panel öffnen"${hide(o.showFFTControls)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
            Settings
        </button>
      </div>
    </div>

    <!-- ═══ Settings Side-Panel ═══ -->
    <div class="settings-panel" data-aw="settingsPanel">
        <div class="settings-panel-header">
            <span class="settings-panel-title">Settings</span>
            <button class="settings-panel-close" data-aw="settingsPanelClose" title="Schließen">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>

        <div class="settings-section">
            <div class="settings-row">
                <label class="settings-label">Engine</label>
                <select data-aw="engineSelect" class="settings-select">
                </select>
            </div>
            <div class="settings-row">
                <label class="settings-label">Preset</label>
                <select data-aw="presetSelect" class="settings-select">
                </select>
            </div>
        </div>

        <div class="settings-section quality-slider-section">
            <h3 class="settings-section-title">Quality</h3>
            <div class="settings-row quality-slider-row">
                <span class="quality-end-label">⚡</span>
                <input type="range" data-aw="qualitySlider" class="settings-range quality-range" min="0" max="4" value="2" step="1" list="qualityStops">
                <span class="quality-end-label">🔬</span>
                <datalist id="qualityStops">
                    <option value="0"></option><option value="1"></option><option value="2"></option><option value="3"></option><option value="4"></option>
                </datalist>
            </div>
            <div class="quality-label-bar">
                <span>Performance</span><span>Balanced</span><span>Quality</span><span>High</span><span>Ultra</span>
            </div>
            <div class="quality-level-display" data-aw="qualityLevelDisplay">Quality</div>
        </div>

        <div class="settings-section">
            <h3 class="settings-section-title">DSP</h3>
            <div class="settings-row">
                <label class="settings-label">Frequency</label>
                <select data-aw="scaleSelect" class="settings-select">
                    <option value="mel" selected>Mel</option>
                    <option value="linear">Linear</option>
                    <option value="cqt">CQT</option>
                </select>
            </div>
            <div class="settings-row">
                <label class="settings-label">Colour Scale</label>
                <select data-aw="colourScaleSelect" class="settings-select">
                    <option value="dbSquared" selected>dB²</option>
                    <option value="db">dB</option>
                    <option value="linear">Linear</option>
                    <option value="meter">Meter</option>
                    <option value="phase">Phase</option>
                </select>
            </div>
            <div class="settings-row">
                <label class="settings-label">Window</label>
                <select data-aw="windowSize" class="settings-select" title="Window Size (samples)">
                    <option value="256">256</option>
                    <option value="512">512</option>
                    <option value="1024" selected>1024</option>
                    <option value="2048">2048</option>
                    <option value="4096">4096</option>
                    <option value="8192">8192</option>
                </select>
            </div>
            <div class="settings-row">
                <label class="settings-label">Window Fn</label>
                <select data-aw="windowFunction" class="settings-select" title="Window Function">
                    <option value="hann" selected>Hann</option>
                    <option value="hamming">Hamming</option>
                    <option value="blackman">Blackman</option>
                    <option value="blackmanHarris">Blackman-Harris</option>
                    <option value="kaiser">Kaiser (β=6)</option>
                    <option value="flatTop">Flat Top</option>
                </select>
            </div>
            <div class="settings-row">
                <label class="settings-label" title="Time-frequency reassignment sharpens spectral peaks">
                    <input type="checkbox" data-aw="reassignedCheck"> Reassigned
                </label>
            </div>
            </div>
            <div class="settings-row">
                <label class="settings-label">Overlap</label>
                <select data-aw="overlapSelect" class="settings-select" title="Window Overlap — higher = smoother time axis">
                    <option value="0">None</option>
                    <option value="1">25 %</option>
                    <option value="2" selected>50 %</option>
                    <option value="3">75 %</option>
                    <option value="4">87.5 %</option>
                    <option value="5">93.75 %</option>
                </select>
            </div>
            <div class="settings-row">
                <label class="settings-label">Oversampling</label>
                <select data-aw="oversamplingSelect" class="settings-select" title="Zero-pad FFT — higher = finer frequency resolution">
                    <option value="0" selected>1×</option>
                    <option value="1">2×</option>
                    <option value="2">4×</option>
                    <option value="3">8×</option>
                </select>
            </div>
            <div class="settings-row">
                <label class="settings-label">Mel Bins</label>
                <input type="number" data-aw="nMelsInput" class="settings-number" value="160" min="16" max="512" step="16" title="Anzahl Mel-Frequenzbänder">
            </div>
        </div>

        <div class="settings-section" data-aw="pcenSection">
            <h3 class="settings-section-title">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                    <input type="checkbox" data-aw="pcenEnabledCheck" checked>
                    PCEN
                </label>
            </h3>
            <div class="settings-row">
                <label class="settings-label">Gain</label>
                <input type="number" data-aw="pcenGainInput" class="settings-number" value="0.8" min="0" max="2" step="0.05">
            </div>
            <div class="settings-row">
                <label class="settings-label">Bias</label>
                <input type="number" data-aw="pcenBiasInput" class="settings-number" value="0.01" min="0" max="1" step="0.005">
            </div>
            <div class="settings-row">
                <label class="settings-label">Root</label>
                <input type="number" data-aw="pcenRootInput" class="settings-number" value="4.0" min="1" max="10" step="0.5">
            </div>
            <div class="settings-row">
                <label class="settings-label">Smoothing</label>
                <input type="number" data-aw="pcenSmoothingInput" class="settings-number" value="0.025" min="0" max="0.5" step="0.005">
            </div>
        </div>

        <div class="settings-section">
            <h3 class="settings-section-title">Display</h3>
            <div class="settings-row">
                <label class="settings-label">Max Freq</label>
                <select data-aw="maxFreqSelect" class="settings-select">
                    <option value="10000" selected>10 kHz</option>
                </select>
                <button class="toolbar-btn mini-btn" data-aw="autoFreqBtn" disabled title="Frequenzbereich automatisch erkennen">AF</button>
            </div>
            <div class="settings-row">
                <label class="settings-label">Color</label>
                <select data-aw="colorSchemeSelect" class="settings-select">
                    <option value="grayscale" selected>B/W</option>
                    <option value="xenocanto">XC</option>
                    <option value="fire">Fire</option>
                    <option value="inferno">Inferno</option>
                    <option value="viridis">Viridis</option>
                    <option value="magma">Magma</option>
                    <option value="plasma">Plasma</option>
                </select>
            </div>
            <div class="settings-row">
                <label class="settings-label" title="Median-based spectral noise floor subtraction">
                    <input type="checkbox" data-aw="noiseReductionCheck"> Noise Reduction
                </label>
            </div>
            <div class="settings-row">
                <label class="settings-label" title="Contrast Limited Adaptive Histogram Equalization — enhances local detail">
                    <input type="checkbox" data-aw="claheCheck"> Adaptive Contrast
                </label>
            </div>
        </div>

        <div class="settings-section">
            <h3 class="settings-section-title">Gain</h3>
            <div class="settings-row">
                <label class="settings-label">Floor</label>
                <input type="range" data-aw="floorSlider" class="settings-range" min="0" max="100" value="0" title="Spectrogram Floor (Schwarzpunkt)">
            </div>
            <div class="settings-row">
                <label class="settings-label">Ceiling</label>
                <input type="range" data-aw="ceilSlider" class="settings-range" min="0" max="100" value="100" title="Spectrogram Ceiling (Weißpunkt)">
            </div>
            <div class="settings-row">
                <button class="toolbar-btn mini-btn" data-aw="autoContrastBtn" disabled title="Kontrast automatisch optimieren">Auto Contrast</button>
            </div>
        </div>
    </div>

    <!-- ═══ Main Content ═══ -->
    <div class="views-panel">
        <!-- Waveform -->
        <div class="waveform-container" data-aw="waveformContainer">
            <div class="time-aligned-row">
                <div class="axis-spacer">
                    <div class="amplitude-labels" data-aw="amplitudeLabels"></div>
                </div>
                <div class="time-pane">
                    <div class="waveform-wrapper" data-aw="waveformWrapper">
                        <div class="waveform-content" data-aw="waveformContent">
                            <canvas data-aw="amplitudeCanvas"></canvas>
                            <canvas data-aw="waveformTimelineCanvas"></canvas>
                        </div>
                        <div class="playhead playhead-secondary" data-aw="waveformPlayhead"></div>
                    </div>
                </div>
            </div>
            <div data-aw="audioEngineHost" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;"></div>
        </div>

        <!-- Split handle -->
        <div class="view-split-handle" data-aw="viewSplitHandle" title="Adjust amplitude/spectrogram ratio"></div>

        <!-- Spectrogram -->
        <div class="spectrogram-container" data-aw="spectrogramContainer">
            <div class="time-aligned-row">
                <div class="axis-spacer freq-axis-spacer">
                    <div class="frequency-labels" data-aw="freqLabels"></div>
                </div>
                <div class="time-pane">
                    <div class="canvas-wrapper" data-aw="canvasWrapper"
                         role="slider"
                         aria-label="Playback position"
                         aria-valuemin="0"
                         aria-valuemax="0"
                         aria-valuenow="0"
                         aria-valuetext="00:00.0 of 00:00.0"
                         tabindex="0">
                        <canvas data-aw="spectrogramCanvas"></canvas>
                        <canvas class="crosshair-overlay" data-aw="crosshairCanvas"></canvas>
                        <div class="crosshair-readout" data-aw="crosshairReadout"></div>
                        <div class="playhead" data-aw="playhead"></div>
                        <div class="recomputing-overlay" data-aw="recomputingOverlay" aria-live="polite" hidden>
                            <span class="recomputing-spinner"></span>
                            <span>Computing…</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="spectrogram-resize-handle" data-aw="spectrogramResizeHandle" title="Adjust spectrogram height"></div>
        </div>

        <!-- Overview -->
        <div class="overview-container" data-aw="overviewContainer"${hide(o.showOverview)}>
            <canvas data-aw="overviewCanvas"></canvas>
            <div class="overview-window" data-aw="overviewWindow">
                <div class="handle left" data-aw="overviewHandleLeft"></div>
                <div class="handle right" data-aw="overviewHandleRight"></div>
            </div>
        </div>
        <div class="overview-label-tracks" data-aw="overviewLabelTracks"${hide(o.showOverview)}></div>
    </div>

    <!-- ═══ Status Bar ═══ -->
    <div class="statusbar"${hide(o.showStatusbar)}>
        <div class="statusbar-section" data-aw="fileInfo">
            <span class="statusbar-label">No file</span>
        </div>
        <div class="statusbar-section">
            <span class="statusbar-label" data-aw="sampleRateInfo"></span>
        </div>
        <div class="statusbar-spacer"></div>
        <div class="statusbar-section">
            <span data-aw="viewRange"></span>
        </div>
        <div class="statusbar-section">
            <span data-aw="playState">Idle</span>
        </div>
    </div>
</div>`;
}
