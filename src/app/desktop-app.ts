// ═══════════════════════════════════════════════════════════════════════
// src/app/desktop-app.ts — SignaVis Desktop entry point
//
// Workflow tabs: Datasets | Gallery | Analyze | Annotate | Export
// ═══════════════════════════════════════════════════════════════════════

import '../styles/main.scss'; // Vite compiles SCSS in dev, extracts CSS in prod

import { BirdNETPlayer } from './BirdNETPlayer.ts';
import { TauriConnectionBridge } from '../infrastructure/tauri/TauriConnectionBridge.ts';
import type { ConnectionStatus } from '../infrastructure/tauri/TauriConnectionBridge.ts';
import { TauriProjectRepository, isTauriContext } from '../infrastructure/tauri/TauriProjectRepository.ts';
import type { Dataset, Recording, SoundEvents } from '../domain/corpus/types.ts';
import type { LinkedLabel } from '../shared/label.types.ts';
import { DatasetBrowserPanel } from '../ui/panels/CorpusBrowserPanel.ts';
import { RecordingGalleryPanel } from '../ui/panels/RecordingGalleryPanel.ts';
import { ImportWizardPanel } from '../ui/panels/ImportWizardPanel.ts';
import { RecordingDetailPanel } from '../ui/panels/RecordingDetailPanel.ts';
import { SimilarityBrowserPanel } from '../ui/panels/SimilarityBrowserPanel.ts';
import { EmbeddingScatterPanel } from '../ui/panels/EmbeddingScatterPanel.ts';
import { ClusterBrowserPanel } from '../ui/panels/ClusterBrowserPanel.ts';
import { XcImportPanel } from '../ui/panels/XcImportPanel.ts';
import { JobMonitorPanel } from '../ui/panels/JobMonitorPanel.ts';
import { ExportPanel } from '../ui/panels/ExportPanel.ts';

// ── DOM refs ──────────────────────────────────────────────────────────

const statusBar           = document.getElementById('statusBar')!;
const connSegment         = document.getElementById('connSegment')!;
const connLabel           = document.getElementById('connLabel')!;
const connPopover         = document.getElementById('connPopover')!;
const connPopoverBackdrop = document.getElementById('connPopoverBackdrop')!;
const connModeSelect      = document.getElementById('connModeSelect') as HTMLSelectElement;
const connEndpointInput   = document.getElementById('connEndpointInput') as HTMLInputElement;
const connEndpointRow     = document.getElementById('connEndpointRow')!;
const connDbEndpointRow   = document.getElementById('connDbEndpointRow')!;
const connDbEndpointInput = document.getElementById('connDbEndpointInput') as HTMLInputElement;
const connNamespaceRow    = document.getElementById('connNamespaceRow')!;
const connNamespaceInput  = document.getElementById('connNamespaceInput') as HTMLInputElement;
const connDatabaseRow     = document.getElementById('connDatabaseRow')!;
const connDatabaseInput   = document.getElementById('connDatabaseInput') as HTMLInputElement;
const connLoggedInRow     = document.getElementById('connLoggedInRow')!;
const connLoggedInAs      = document.getElementById('connLoggedInAs')!;
const connLogoutBtn       = document.getElementById('connLogoutBtn')!;
const connLoginRow        = document.getElementById('connLoginRow')!;
const connUsernameInput   = document.getElementById('connUsernameInput') as HTMLInputElement;
const connPasswordInput   = document.getElementById('connPasswordInput') as HTMLInputElement;
const connLoginBtn        = document.getElementById('connLoginBtn')!;
const connApplyBtn        = document.getElementById('connApplyBtn')!;
const connCancelBtn       = document.getElementById('connCancelBtn')!;

// Stub refs for legacy IPC code that still references these elements
const repo                = new TauriProjectRepository();
const connection          = new TauriConnectionBridge();
let activeProjectId: string | null = null;
let player: BirdNETPlayer | null = null;

// ── Workflow tab state ────────────────────────────────────────────────

type WorkflowTab = 'datasets' | 'gallery' | 'analyze' | 'annotate' | 'export';
let activeTab: WorkflowTab = 'datasets';
let currentDataset: Dataset | null = null;
let currentRecording: Recording | null = null;

// Panel instances (created once, reused)
let recordingDetailPanel: RecordingDetailPanel | null = null;
let similarityBrowserPanel: SimilarityBrowserPanel | null = null;
let clusterBrowserPanel: ClusterBrowserPanel | null = null;
let xcImportPanel: XcImportPanel | null = null;
let jobMonitorPanel: JobMonitorPanel | null = null;
let exportPanelInstance: ExportPanel | null = null;

// Analyze sub-tab
type AnalyzeSubTab = 'birdnet' | 'scatter' | 'clusters';
let activeAnalyzeSubTab: AnalyzeSubTab = 'birdnet';

// ── Tab controller ────────────────────────────────────────────────────

function setWorkflowTab(tab: WorkflowTab, force = false): void {
    if (tab === activeTab && !force) return;
    activeTab = tab;

    // Show/hide panes
    document.querySelectorAll<HTMLElement>('.wf-pane').forEach((pane) => {
        pane.classList.toggle('wf-pane--active', pane.id === `pane-${tab}`);
    });

    // Update tab buttons
    document.querySelectorAll<HTMLButtonElement>('[data-wf-tab]').forEach((btn) => {
        btn.classList.toggle('wf-tab--active', btn.dataset.wfTab === tab);
    });
}

/** Unlock tabs that require an open dataset. */
function updateTabState(): void {
    const hasDataset = !!currentDataset;
    const hasRecording = !!currentRecording;

    (['gallery', 'analyze', 'annotate', 'export'] as const).forEach((tab) => {
        const btn = document.querySelector<HTMLButtonElement>(`[data-wf-tab="${tab}"]`);
        if (!btn) return;
        const enabled = hasDataset || (tab === 'annotate' && hasRecording);
        btn.disabled = !enabled;
        btn.classList.toggle('wf-tab--disabled', !enabled);
    });

    // Update topbar dataset pill
    const pill      = document.getElementById('topbarDatasetPill');
    const pillName  = document.getElementById('topbarDatasetName');
    const pillCount = document.getElementById('topbarDatasetCount');
    if (pill && pillName && pillCount) {
        if (currentDataset) {
            pill.style.display = 'flex';
            pillName.textContent = currentDataset.name;
            pillCount.textContent = `${currentDataset.recordingCount.toLocaleString()} recordings`;
        } else {
            pill.style.display = 'none';
        }
    }
}

// ── Sidebar ───────────────────────────────────────────────────────────

async function refreshSidebar(datasets?: Dataset[]): Promise<void> {
    const listEl    = document.getElementById('sidebarDatasetList');
    const contextEl = document.getElementById('sidebarContext');
    if (!listEl) return;

    if (!datasets) {
        try {
            const { datasetList } = await import('../infrastructure/tauri/TauriCorpusAdapter.ts');
            datasets = await datasetList();
        } catch { datasets = []; }
    }

    if (datasets.length === 0) {
        listEl.innerHTML = '<div class="ds-sidebar__empty">No datasets yet.<br>Click + to create one.</div>';
    } else {
        listEl.innerHTML = datasets
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((d) => `
                <button class="ds-sidebar__dataset-item ${d.id === currentDataset?.id ? 'ds-sidebar__dataset-item--active' : ''}"
                    data-sidebar-dataset="${escapeHtml(d.id)}" title="${escapeHtml(d.name)}">
                    <span class="ds-sidebar__dataset-name">${escapeHtml(d.name)}</span>
                    <span class="ds-sidebar__dataset-count">${d.recordingCount.toLocaleString()}</span>
                </button>
            `).join('');
        listEl.querySelectorAll<HTMLButtonElement>('[data-sidebar-dataset]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const ds = datasets!.find((d) => d.id === btn.dataset.sidebarDataset);
                if (ds) openDataset(ds);
            });
        });
    }

    // Context: saved views + runs of current dataset
    if (contextEl && currentDataset) {
        contextEl.style.display = '';
        const viewsEl = document.getElementById('sidebarViews');
        const runsEl  = document.getElementById('sidebarRuns');

        if (viewsEl) {
            const views = currentDataset.savedViews ?? [];
            viewsEl.innerHTML = views.length === 0
                ? '<div class="ds-sidebar__empty-sm">No saved views</div>'
                : views.map((v) => `
                    <button class="ds-sidebar__view-item" data-sidebar-view="${escapeHtml(v.name)}">${escapeHtml(v.name)}</button>
                `).join('');
        }

        if (runsEl) {
            const runs = Object.values(currentDataset.analysisRuns ?? {});
            runsEl.innerHTML = runs.length === 0
                ? '<div class="ds-sidebar__empty-sm">No runs yet</div>'
                : runs.slice(-5).reverse().map((r) => {
                    const icon = r.status === 'completed' ? '✓' : r.status === 'failed' ? '✕' : '⏳';
                    const cls  = `run--${r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'err' : 'pending'}`;
                    const label = (r.config as { outputField?: string })?.outputField ?? r.type ?? 'run';
                    return `<div class="ds-sidebar__run-item ${cls}">${icon} ${escapeHtml(label)}</div>`;
                }).join('');
        }
    } else if (contextEl) {
        contextEl.style.display = 'none';
    }
}

// ── Dataset navigation ────────────────────────────────────────────────

function openDataset(dataset: Dataset): void {
    currentDataset = dataset;
    currentRecording = null;

    try { localStorage.setItem('signavis:lastDatasetId', dataset.id); } catch { /* ignore */ }

    updateTabState();
    refreshSidebar();
    showGallery();
}

function showDatasets(): void {
    currentDataset = null;
    currentRecording = null;
    updateTabState();
    refreshSidebar();
    setWorkflowTab('datasets');

    const mount = document.getElementById('datasetBrowserMount')!;
    const panel = new DatasetBrowserPanel({
        container: mount,
        onDatasetSelect: openDataset,
        onStatusMessage: setStatus,
    });
    panel.mount().catch((e) => setStatus(`Dataset error: ${e}`));
}

function showGallery(): void {
    if (!currentDataset) return;
    setWorkflowTab('gallery');

    // Ensure detail + similarity panels are mounted once
    initDetailPanels();

    const mount   = document.getElementById('galleryMount')!;
    const dataset = currentDataset;

    const gallery = new RecordingGalleryPanel({
        container: mount,
        dataset,
        onBack: () => { setWorkflowTab('datasets'); showDatasets(); },
        onImport: () => showImportWizard(dataset),
        onImportFromXc: () => showXcImportPanel(dataset),
        onOpenRecording: (rec) => {
            currentRecording = rec;
            updateTabState();
            switchDetailTab('detail');
            recordingDetailPanel?.show(rec);
        },
        onDatasetUpdated: (updated) => {
            currentDataset = updated;
            updateTabState();
            refreshSidebar();
        },
        onShowClusters: () => showAnalyzeTab('clusters'),
        onShowScatter:  () => showAnalyzeTab('scatter'),
        onStatusMessage: setStatus,
    });
    gallery.mount().catch((e) => setStatus(`Gallery error: ${e}`));
}

function showAnalyzeTab(sub: AnalyzeSubTab = activeAnalyzeSubTab): void {
    if (!currentDataset) return;
    setWorkflowTab('analyze');
    switchAnalyzeSubTab(sub);
}

function switchAnalyzeSubTab(sub: AnalyzeSubTab): void {
    activeAnalyzeSubTab = sub;

    document.querySelectorAll<HTMLButtonElement>('[data-analyze-tab]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.analyzeTab === sub);
    });

    const panels: Record<AnalyzeSubTab, string> = {
        birdnet:  'analyzeBirdnetMount',
        scatter:  'analyzeScatterMount',
        clusters: 'analyzeClustersMount',
    };
    Object.entries(panels).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = key === sub ? '' : 'none';
    });

    if (!currentDataset) return;
    const dataset = currentDataset;

    if (sub === 'scatter') {
        const mount = document.getElementById('analyzeScatterMount')!;
        if (!mount.dataset.mounted) {
            mount.dataset.mounted = '1';
            const panel = new EmbeddingScatterPanel({
                container: mount,
                dataset,
                onOpenRecording: (rec) => { currentRecording = rec; updateTabState(); setWorkflowTab('annotate'); openInAnnotate(rec); },
                onStatusMessage: setStatus,
                onShowClusters: () => switchAnalyzeSubTab('clusters'),
            });
            // Load all recordings, then mount scatter with their embedding data
            import('../infrastructure/tauri/TauriCorpusAdapter.ts').then(async ({ recordingList }) => {
                const recordings = await recordingList({ datasetId: dataset.id, limit: 10000 });
                panel.mount(recordings).catch((e) => setStatus(`Scatter error: ${e}`));
            }).catch((e) => setStatus(`Scatter load error: ${e}`));
        }
    }

    if (sub === 'clusters') {
        const mount = document.getElementById('analyzeClustersMount')!;
        if (!clusterBrowserPanel) {
            clusterBrowserPanel = new ClusterBrowserPanel({
                container: mount,
                dataset,
                onOpenRecording: (rec) => { currentRecording = rec; updateTabState(); setWorkflowTab('annotate'); openInAnnotate(rec); },
                onStatusMessage: setStatus,
            });
        } else {
            clusterBrowserPanel.updateDataset(dataset);
        }
        clusterBrowserPanel.load().catch((e) => setStatus(`Cluster error: ${e}`));
    }

    if (sub === 'birdnet') {
        const mount = document.getElementById('analyzeBirdnetMount')!;
        if (!mount.dataset.mounted) {
            mount.dataset.mounted = '1';
            // Show a simple BirdNET run panel — same dialog trigger as gallery but in a pane
            mount.innerHTML = `
                <div style="padding:24px;max-width:540px">
                    <h3 style="margin-bottom:12px;font-size:15px;font-weight:600">BirdNET Inference</h3>
                    <p style="font-size:13px;color:var(--color-text-secondary);margin-bottom:16px;line-height:1.6">
                        Run BirdNET on your dataset to detect species in recordings.
                        Results are stored as SoundEvents fields on each recording.
                    </p>
                    <button class="btn btn--primary" id="analyzeRunBirdnetBtn">🔍 Run BirdNET on dataset…</button>
                    <div style="margin-top:20px" id="analyzeBirdnetResults"></div>
                </div>
            `;
            mount.querySelector('#analyzeRunBirdnetBtn')?.addEventListener('click', () => {
                // Switch to gallery and wait for mount before triggering the BirdNET dialog
                showGallery();
                const galleryMount = document.getElementById('galleryMount')!;
                const observer = new MutationObserver(() => {
                    const btn = galleryMount.querySelector<HTMLButtonElement>('#galleryBirdnetBtn');
                    if (btn) {
                        observer.disconnect();
                        btn.click();
                    }
                });
                observer.observe(galleryMount, { childList: true, subtree: true });
                // Safety timeout to avoid observer leak
                setTimeout(() => observer.disconnect(), 3000);
            });
        }
    }
}

function showImportWizard(dataset: Dataset): void {
    const mount = document.getElementById('galleryMount')!;
    const wizard = new ImportWizardPanel({
        container: mount,
        dataset,
        onDone: (result) => {
            setStatus(`Import: ${result.imported} imported, ${result.skipped} skipped.`);
            showGallery();
        },
        onCancel: () => showGallery(),
        onStatusMessage: setStatus,
        openFolderDialog: () => openFolderDialogPath(),
    });
    wizard.mount();
}

function showXcImportPanel(dataset: Dataset): void {
    const mount = document.getElementById('galleryMount')!;
    xcImportPanel = new XcImportPanel({
        container: mount,
        dataset,
        onBack: () => { xcImportPanel = null; showGallery(); },
        onStatusMessage: setStatus,
        onImported: (count) => { if (count > 0) setStatus(`XC import: ${count} recordings added.`); },
    });
    xcImportPanel.mount();
}

/** Open a recording in the Annotate tab. */
function openInAnnotate(rec: Recording): void {
    currentRecording = rec;
    updateTabState();
    setWorkflowTab('annotate');

    const hint = document.getElementById('annotateHint');
    const playerEl = document.getElementById('playerContainer');
    if (hint) hint.style.display = 'none';
    if (playerEl) playerEl.hidden = false;

    loadAudioFile(rec.filepath);
    setStatus(`Annotating: ${rec.filepath.split('/').pop()}`);
}

// ── Detail panel helpers ──────────────────────────────────────────────

function initDetailPanels(): void {
    // Mount similarity browser once
    if (!similarityBrowserPanel) {
        const simMount = document.getElementById('similarityMount');
        if (simMount) {
            similarityBrowserPanel = new SimilarityBrowserPanel({
                container: simMount,
                onOpenRecording: (rec) => { switchDetailTab('detail'); recordingDetailPanel?.show(rec); },
                onStatusMessage: setStatus,
            });
        }
    }

    // Mount detail panel once
    if (!recordingDetailPanel) {
        const wrapper = document.getElementById('detailPanelWrapper');
        if (wrapper) {
            recordingDetailPanel = new RecordingDetailPanel({
                container: wrapper,
                onOpenInLabeler: (rec) => openInAnnotate(rec),
                onStatusMessage: setStatus,
                onFindSimilar: (rec) => {
                    switchDetailTab('similar');
                    similarityBrowserPanel?.showSimilarTo(rec).catch((e) => setStatus(`Similarity error: ${e}`));
                },
            });
        }
    }
}

function switchDetailTab(tab: 'detail' | 'similar'): void {
    const wrapper  = document.getElementById('detailPanelWrapper');
    const simMount = document.getElementById('similarityMount');
    document.querySelectorAll<HTMLButtonElement>('[data-detail-tab]').forEach((btn) => {
        btn.classList.toggle('ds-detail__tab--active', btn.dataset.detailTab === tab);
    });
    if (wrapper)  wrapper.style.display  = tab === 'detail' ? '' : 'none';
    if (simMount) simMount.style.display = tab === 'similar' ? '' : 'none';
}

async function openFolderDialogPath(): Promise<string | null> {
    try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const result = await open({ directory: true, multiple: false });
        if (typeof result === 'string') return result;
        return null;
    } catch {
        // Fallback: Tauri v1 API
        return openFolderDialog();
    }
}

function openRecordingInLabeler(recording: Recording): void {
    openInAnnotate(recording);
    const labels = extractSpectrogramLabels(recording);
    loadAudioFile(recording.filepath).then(() => {
        if (labels.length > 0) {
            ensurePlayer().then((p) => p.setSpectrogramLabels(labels)).catch(() => { /* ignore */ });
        }
    }).catch(() => { /* error already shown in status bar */ });
}

/** Converts all SoundEvents fields on a recording to spectrogram labels. */
function extractSpectrogramLabels(recording: Recording): Partial<LinkedLabel>[] {
    const labels: Partial<LinkedLabel>[] = [];
    for (const [fieldName, fieldValue] of Object.entries(recording.fields ?? {})) {
        if (!isSoundEventsField(fieldValue)) continue;
        const events = (fieldValue as SoundEvents).soundEvents;
        for (const evt of events) {
            const confirmed = evt.tags?.includes('confirmed');
            const rejected  = evt.tags?.includes('rejected');
            labels.push({
                id:          `${fieldName}_${evt.support[0]}_${evt.support[1]}_${evt.label}`,
                start:       evt.support[0],
                end:         evt.support[1],
                label:       evt.label,
                species:     evt.label,
                confidence:  evt.confidence,
                freqMin:     evt.freqRange?.[0],
                freqMax:     evt.freqRange?.[1],
                readonly:    true,
                aiSuggested: { model: 'BirdNET', version: fieldName },
                color:       confirmed ? '#22c55e' : rejected ? '#ef4444' : '#0ea5e9',
            });
        }
    }
    return labels;
}

function isSoundEventsField(value: unknown): value is SoundEvents {
    if (!value || typeof value !== 'object') return false;
    return Array.isArray((value as Record<string, unknown>).soundEvents);
}

// ── Utilities ─────────────────────────────────────────────────────────

function setStatus(msg: string): void {
    statusBar.textContent = msg;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function jobStatusBadge(status: string): string {
    const cls: Record<string, string> = {
        queued: 'badge--neutral', running: 'badge--accent',
        done: 'badge--success', failed: 'badge--danger', cancelled: 'badge--neutral',
    };
    return `<span class="badge ${cls[status] ?? 'badge--neutral'}">${status}</span>`;
}

const AUDIO_EXTS = new Set(['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a', 'opus', 'wv', 'aif', 'aiff']);

function isAudioFile(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return AUDIO_EXTS.has(ext);
}

// ── Tauri IPC helpers ─────────────────────────────────────────────────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
}

async function openFolderDialog(): Promise<string | null> {
    try {
        const result = await tauriInvoke<string | null>('plugin:dialog|open', {
            options: { title: 'Open audio folder', directory: true, multiple: false },
        });
        return result;
    } catch {
        return null;
    }
}

async function openFileDialog(): Promise<string | null> {
    try {
        const result = await tauriInvoke<string | null>('plugin:dialog|open', {
            options: {
                title: 'Select audio file',
                multiple: false,
                filters: [{ name: 'Audio', extensions: [...AUDIO_EXTS] }],
            },
        });
        return result;
    } catch {
        return null;
    }
}

type FsEntry = { name: string; path: string; children?: FsEntry[] | null; isDirectory?: boolean };

async function readDirFlat(dirPath: string): Promise<FsEntry[]> {
    // plugin:fs|read_dir — returns array of DirEntry { name, path, children? }
    const entries = await tauriInvoke<FsEntry[]>('plugin:fs|read_dir', { path: dirPath });
    const result: FsEntry[] = [];
    for (const entry of entries) {
        if (entry.children !== undefined && entry.children !== null) {
            // It's a directory — recurse one level for a flat audio list
            try {
                const sub = await tauriInvoke<FsEntry[]>('plugin:fs|read_dir', { path: entry.path });
                for (const s of sub) {
                    if (isAudioFile(s.name ?? '')) result.push(s);
                }
            } catch { /* skip unreadable subdirs */ }
        } else if (isAudioFile(entry.name ?? '')) {
            result.push(entry);
        }
    }
    return result;
}


// ── Player (Annotate tab) ─────────────────────────────────────────────

async function ensurePlayer(): Promise<BirdNETPlayer> {
    const container = document.getElementById('playerContainer')!;
    if (!player) {
        player = new BirdNETPlayer(container, {});
    }
    return player;
}

async function loadAudioFile(filePath: string): Promise<void> {
    const p = await ensurePlayer();
    try {
        const { convertFileSrc } = await import('@tauri-apps/api/core') as { convertFileSrc?: (p: string) => string };
        const url = convertFileSrc ? convertFileSrc(filePath) : filePath;
        await p.loadUrl(url);
    } catch (e) {
        setStatus(`Could not load audio: ${e}`);
    }
}

// ── Connection status UI ──────────────────────────────────────────────
//
// The button at the bottom-left shows the current operating mode (Local / Server / Cloud)
// and opens a popover on click to switch modes.
//
// DEV NOTE — starting a server for testing:
//   Browser dev server (no Tauri, no backend):
//     npm run dev                          → http://localhost:5173
//
//   Tauri desktop app (recommended for Dataset/Recording features):
//     npm run desktop:dev                  → starts Vite + Tauri, opens window
//     npm run desktop:dev:grpc             → same, with gRPC analysis backend
//
//   Platform backend (SurrealDB server, Postgres etc. via Docker):
//     npm run platform:testenv:up          → bring up Docker Compose
//     npm run desktop:dev:platform-local   → desktop against local platform backend
//     npm run desktop:dev:platform-local:reset  → same, reset DB
//
//   Mock analysis server (no Python/BirdNET):
//     npm run dev:analysis-mock            → starts mock server on :7999
//
// In local mode SurrealDB runs embedded in the Tauri process — no separate daemon.

function renderConnSegment(status: ConnectionStatus): void {
    connSegment.dataset.state = status.state;
    const modeLabel: Record<string, string> = { local: 'Local', server: 'Server', cloud: 'Cloud' };
    if (status.state === 'local') {
        connLabel.textContent = 'Local';
    } else if (status.state === 'connecting') {
        connLabel.textContent = `Connecting… ${status.endpoint}`;
    } else if (status.state === 'connected') {
        const user = status.loggedInAs ? ` (${status.loggedInAs})` : '';
        connLabel.textContent = `${modeLabel[status.mode] ?? status.mode} — ${status.endpoint}${user}`;
    } else {
        connLabel.textContent = `${modeLabel[status.mode] ?? status.mode} — ${status.errorMessage ?? 'error'}`;
    }
}

async function openConnPopover(): Promise<void> {
    const config = await connection.getConfig();
    connModeSelect.value = config.mode;
    connEndpointInput.value = config.endpoint;
    connDbEndpointInput.value = config.dbEndpoint ?? '';
    connNamespaceInput.value = config.namespace ?? '';
    connDatabaseInput.value = config.database ?? '';
    connUsernameInput.value = config.username ?? '';
    connPasswordInput.value = '';

    const isServer = config.mode !== 'local';
    connEndpointRow.style.display     = isServer ? 'flex' : 'none';
    connDbEndpointRow.style.display   = isServer ? 'flex' : 'none';
    connNamespaceRow.style.display    = isServer ? 'flex' : 'none';
    connDatabaseRow.style.display     = isServer ? 'flex' : 'none';

    const whoami = isServer ? await connection.getWhoAmI() : null;
    connLoggedInRow.style.display = whoami ? 'flex' : 'none';
    connLoginRow.style.display    = isServer && !whoami ? 'flex' : 'none';
    connLoggedInAs.textContent    = whoami ?? '';

    connPopover.hidden = false;
    connPopoverBackdrop.hidden = false;
    connEndpointInput.focus();
}

function closeConnPopover(): void {
    connPopover.hidden = true;
    connPopoverBackdrop.hidden = true;
}

async function initConnectionUI(): Promise<void> {
    // Subscribe to Rust events first, then read the current status.
    await connection.start();
    connection.onStatus(renderConnSegment);
    const status = await connection.getStatus();
    renderConnSegment(status);

    connSegment.addEventListener('click', () => openConnPopover());
    connPopoverBackdrop.addEventListener('click', closeConnPopover);
    connCancelBtn.addEventListener('click', closeConnPopover);

    connModeSelect.addEventListener('change', () => {
        const isServer = connModeSelect.value !== 'local';
        connEndpointRow.style.display   = isServer ? 'flex' : 'none';
        connDbEndpointRow.style.display = isServer ? 'flex' : 'none';
        connNamespaceRow.style.display  = isServer ? 'flex' : 'none';
        connDatabaseRow.style.display   = isServer ? 'flex' : 'none';
        // When switching back to local, hide auth rows
        if (!isServer) {
            connLoggedInRow.style.display = 'none';
            connLoginRow.style.display    = 'none';
        }
    });

    connApplyBtn.addEventListener('click', async () => {
        closeConnPopover();
        const mode = connModeSelect.value as 'local' | 'server' | 'cloud';
        const endpoint = connEndpointInput.value.trim();
        const dbEndpoint = connDbEndpointInput.value.trim() || undefined;
        const namespace = connNamespaceInput.value.trim() || undefined;
        const database = connDatabaseInput.value.trim() || undefined;
        const status = await connection.setConfig({ mode, endpoint, dbEndpoint, namespace, database });
        renderConnSegment(status);
    });

    connLoginBtn.addEventListener('click', async () => {
        const username = connUsernameInput.value.trim();
        const password = connPasswordInput.value;
        if (!username || !password) { setStatus('Enter username and password.'); return; }
        try {
            await connection.login({ username, password });
            connPasswordInput.value = '';
            connLoggedInAs.textContent = username;
            connLoggedInRow.style.display = 'flex';
            connLoginRow.style.display = 'none';
            const status = await connection.getStatus();
            renderConnSegment(status);
            setStatus(`Logged in as ${username}`);
        } catch (err) {
            setStatus(`Login failed: ${err}`);
        }
    });

    connLogoutBtn.addEventListener('click', async () => {
        try {
            await connection.logout();
            connLoggedInRow.style.display = 'none';
            connLoginRow.style.display = connModeSelect.value !== 'local' ? 'flex' : 'none';
            const status = await connection.getStatus();
            renderConnSegment(status);
            setStatus('Logged out');
        } catch (err) {
            setStatus(`Logout failed: ${err}`);
        }
    });
}

// ── Theme ─────────────────────────────────────────────────────────────

function currentTheme(): 'dark' | 'light' {
    const saved = localStorage.getItem('aw:theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme: 'dark' | 'light'): void {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('aw:theme', theme);
}

// ── Native menu ───────────────────────────────────────────────────────

async function buildNativeMenu(): Promise<void> {
    try {
        const { Menu, Submenu, MenuItem, CheckMenuItem, PredefinedMenuItem } = await import('@tauri-apps/api/menu');

        const fileMenu = await Submenu.new({
            text: 'File',
            items: [
                await MenuItem.new({ id: 'new-dataset',  text: 'New Dataset',        accelerator: 'CmdOrCtrl+N', action: () => { setWorkflowTab('datasets'); document.querySelector<HTMLButtonElement>('#datasetNewBtn')?.click(); } }),
                await PredefinedMenuItem.new({ item: 'Separator' }),
                await PredefinedMenuItem.new({ item: 'CloseWindow' }),
            ],
        });

        const analysisMenu = await Submenu.new({
            text: 'Analysis',
            items: [
                await MenuItem.new({ id: 'go-analyze', text: 'Run Analysis…', accelerator: 'CmdOrCtrl+R', action: () => showAnalyzeTab() }),
                await PredefinedMenuItem.new({ item: 'Separator' }),
                await MenuItem.new({ id: 'backend-settings', text: 'Backend Settings…', accelerator: 'CmdOrCtrl+,', action: openConnPopover }),
            ],
        });

        const lightModeItem = await CheckMenuItem.new({
            id: 'light-mode',
            text: 'Light Mode',
            checked: currentTheme() === 'light',
            action: async () => {
                const next = currentTheme() === 'light' ? 'dark' : 'light';
                applyTheme(next);
                await lightModeItem.setChecked(next === 'light');
            },
        });

        const viewMenu = await Submenu.new({
            text: 'View',
            items: [
                lightModeItem,
                await PredefinedMenuItem.new({ item: 'Separator' }),
                await PredefinedMenuItem.new({ item: 'Fullscreen' }),
                await PredefinedMenuItem.new({ item: 'Minimize' }),
            ],
        });

        const menu = await Menu.new({ items: [fileMenu, analysisMenu, viewMenu] });
        await menu.setAsWindowMenu();
    } catch (err) {
        // Native menu is best-effort — toolbar buttons remain as fallback.
        console.warn('[desktop-app] native menu unavailable:', err);
    }
}

// ── Boot ──────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
    if (!isTauriContext()) {
        document.body.innerHTML =
            '<p style="padding:2rem;color:#f87171">This page requires the SignaVis desktop app.</p>';
        return;
    }

    applyTheme(currentTheme());
    await initConnectionUI();

    // Theme toggle
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
        const sync = () => {
            const dark = currentTheme() === 'dark';
            themeBtn.textContent = dark ? '☀' : '☾';
            themeBtn.title = dark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
        };
        sync();
        themeBtn.addEventListener('click', () => { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); sync(); });
    }

    // Wire workflow tab buttons
    document.querySelectorAll<HTMLButtonElement>('[data-wf-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.wfTab as WorkflowTab;
            if (btn.disabled) return;
            if (tab === 'gallery')  showGallery();
            else if (tab === 'analyze') showAnalyzeTab();
            else if (tab === 'annotate') setWorkflowTab('annotate');
            else if (tab === 'export')  showExportTab();
            else if (tab === 'datasets') showDatasets();
        });
    });

    // Wire analyze sub-tabs
    document.querySelectorAll<HTMLButtonElement>('[data-analyze-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            switchAnalyzeSubTab(btn.dataset.analyzeTab as AnalyzeSubTab);
        });
    });

    // Wire detail sidebar tabs
    document.querySelectorAll<HTMLButtonElement>('[data-detail-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            switchDetailTab(btn.dataset.detailTab as 'detail' | 'similar');
        });
    });

    // Wire annotate hint button
    document.getElementById('annotateGoGalleryBtn')?.addEventListener('click', () => showGallery());

    // Mount job monitor
    const jobMount = document.getElementById('jobMonitorMount');
    if (jobMount && !jobMonitorPanel) {
        jobMonitorPanel = new JobMonitorPanel({
            container: jobMount,
            onOpenDataset: (id) => {
                if (currentDataset?.id !== id) return;
                showGallery();
            },
        });
        jobMonitorPanel.mount().catch(console.error);
    }

    // Sidebar new-dataset button: navigate to Datasets tab, then open create form
    document.getElementById('sidebarNewDatasetBtn')?.addEventListener('click', () => {
        showDatasets();
        // Wait for DatasetBrowserPanel to render its button
        const mount = document.getElementById('datasetBrowserMount')!;
        const tryClick = () => {
            const btn = mount.querySelector<HTMLButtonElement>('#datasetNewBtn');
            if (btn) { btn.click(); return; }
        };
        tryClick();
        const obs = new MutationObserver(() => { tryClick(); obs.disconnect(); });
        obs.observe(mount, { childList: true, subtree: true });
        setTimeout(() => obs.disconnect(), 2000);
    });

    await buildNativeMenu();

    // Boot the datasets pane: load sidebar, then restore last dataset or show list
    const { datasetGet, datasetList } = await import('../infrastructure/tauri/TauriCorpusAdapter.ts');
    const lastId = (() => { try { return localStorage.getItem('signavis:lastDatasetId'); } catch { return null; } })();
    const allDatasets = await datasetList().catch(() => []);
    await refreshSidebar(allDatasets);

    if (lastId) {
        try {
            const ds = await datasetGet(lastId);
            openDataset(ds);
        } catch {
            showDatasets();
        }
    } else {
        showDatasets();
    }

    updateTabState();
    setStatus('Ready');
}

function showExportTab(): void {
    if (!currentDataset) return;
    setWorkflowTab('export');
    const mount = document.getElementById('exportPaneMount')!;
    if (!exportPanelInstance) {
        exportPanelInstance = new ExportPanel({
            container: mount,
            dataset: currentDataset,
            onStatusMessage: setStatus,
        });
        exportPanelInstance.mount();
    }
}

boot().catch((err) => console.error('[desktop-app] boot failed:', err));
