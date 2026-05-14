// ═══════════════════════════════════════════════════════════════════════
// src/app/desktop-app.ts — Desktop application entry point (Tauri only)
//
// Views:
//   Labeling  — Existing labeling tool (project list + player + jobs)
//   Dataset   — New dataset browser (v2 architecture: Dataset/Recording/Import)
// ═══════════════════════════════════════════════════════════════════════

import { BirdNETPlayer } from './BirdNETPlayer.ts';
import { TauriConnectionBridge } from '../infrastructure/tauri/TauriConnectionBridge.ts';
import type { ConnectionStatus } from '../infrastructure/tauri/TauriConnectionBridge.ts';
import { TauriProjectRepository, isTauriContext } from '../infrastructure/tauri/TauriProjectRepository.ts';
import {
    tauriProjectCreate,
    tauriAssetImportLocal,
    tauriAnalysisRunLocal,
    tauriListLocalJobs,
    tauriCancelLocalJob,
    type LocalAnalysisJob,
} from '../infrastructure/tauri/TauriPlatformScaffold.ts';
import type { ProjectSummary } from '../domain/project/types.ts';
import type { Dataset, Recording, SoundEvent, SoundEvents } from '../domain/corpus/types.ts';
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

// ── DOM refs ──────────────────────────────────────────────────────────

const projectList         = document.getElementById('projectList')!;
const newProjectBtn       = document.getElementById('newProjectBtn')!;
const openFolderBtn       = document.getElementById('openFolderBtn')!;
const importFileBtn       = document.getElementById('importFileBtn')!;
const runAnalysisBtn      = document.getElementById('runAnalysisBtn')!;
const refreshJobsBtn      = document.getElementById('refreshJobsBtn')!;
const jobList             = document.getElementById('jobList')!;
const statusBar           = document.getElementById('statusBar')!;
const fileBrowserPanel    = document.getElementById('fileBrowserPanel')!;
const fileList            = document.getElementById('fileList')!;
const folderLabel         = document.getElementById('folderLabel')!;
const playerContainer     = document.getElementById('playerContainer')!;
const centrePlaceholder   = document.getElementById('centrePlaceholder')!;
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

// ── State ─────────────────────────────────────────────────────────────

const repo       = new TauriProjectRepository();
const connection = new TauriConnectionBridge();
let activeProjectId: string | null = null;
let player: BirdNETPlayer | null = null;

// ── Dataset Browser State ─────────────────────────────────────────────

type AppView = 'labeling' | 'dataset';
let activeView: AppView = 'labeling';
let datasetBrowserPanel: DatasetBrowserPanel | null = null;
let currentDataset: Dataset | null = null;
let recordingDetailPanel: RecordingDetailPanel | null = null;
let similarityBrowserPanel: SimilarityBrowserPanel | null = null;
let embeddingScatterPanel: EmbeddingScatterPanel | null = null;
let clusterBrowserPanel: ClusterBrowserPanel | null = null;
let xcImportPanel: XcImportPanel | null = null;
let jobMonitorPanel: JobMonitorPanel | null = null;

/** Switches between "labeling" and "dataset" view. */
function switchView(view: AppView): void {
    activeView = view;
    const labelingEl = document.getElementById('labelingView')!;
    const datasetEl  = document.getElementById('datasetBrowserView')!;

    if (view === 'dataset') {
        labelingEl.style.display = 'none';
        datasetEl.style.display  = 'flex';
        initDatasetView();
    } else {
        labelingEl.style.display = '';
        datasetEl.style.display  = 'none';
    }

    document.querySelectorAll<HTMLButtonElement>('.view-tab').forEach((btn) => {
        btn.classList.toggle('view-tab--active', btn.dataset.view === view);
    });
}

function initDatasetView(): void {
    const mount = document.getElementById('datasetBrowserMount')!;

    // Mount the job monitor once
    if (!jobMonitorPanel) {
        const jobMount = document.getElementById('jobMonitorMount');
        if (jobMount) {
            jobMonitorPanel = new JobMonitorPanel({
                container: jobMount,
                onOpenDataset: (_id) => { /* dataset navigation handled by gallery */ },
            });
            jobMonitorPanel.mount().catch(console.error);
        }
    }

    if (!datasetBrowserPanel) {
        datasetBrowserPanel = new DatasetBrowserPanel({
            container: mount,
            onDatasetSelect: (dataset) => showRecordingGallery(dataset),
            onStatusMessage: setStatus,
        });
        datasetBrowserPanel.mount().catch((e) => setStatus(`Dataset error: ${e}`));
    }
}

function showRecordingGallery(dataset: Dataset): void {
    currentDataset = dataset;
    const mount = document.getElementById('datasetBrowserMount')!;
    const detailMount = document.getElementById('datasetDetailMount')!;

    // Initialise detail panel (right column)
    if (!recordingDetailPanel) {
        recordingDetailPanel = new RecordingDetailPanel({
            container: detailMount,
            onOpenInLabeler: (rec) => openRecordingInLabeler(rec),
            onStatusMessage: setStatus,
            onFindSimilar: (rec) => showSimilarRecordings(rec, detailMount, dataset),
        });
    }
    // Initialise similarity browser (reused across calls)
    if (!similarityBrowserPanel) {
        const simMount = document.getElementById('similarityMount') ?? createSimilarityMount(detailMount);
        similarityBrowserPanel = new SimilarityBrowserPanel({
            container: simMount,
            onOpenRecording: (rec) => recordingDetailPanel?.show(rec),
            onStatusMessage: setStatus,
        });
    }

    const gallery = new RecordingGalleryPanel({
        container: mount,
        dataset,
        onBack: () => {
            datasetBrowserPanel = null;
            recordingDetailPanel = null;
            similarityBrowserPanel = null;
            embeddingScatterPanel = null;
            clusterBrowserPanel = null;
            const newPanel = new DatasetBrowserPanel({
                container: mount,
                onDatasetSelect: showRecordingGallery,
                onStatusMessage: setStatus,
            });
            datasetBrowserPanel = newPanel;
            newPanel.mount().catch((e) => setStatus(`Error: ${e}`));
            // Clear detail panel
            detailMount.innerHTML = '';
        },
        onImport: () => showImportWizard(dataset),
        onImportFromXc: () => showXcImportPanel(dataset),
        onOpenRecording: (rec) => {
            showRecordingDetail(rec, detailMount);
        },
        onShowClusters: () => showClusterBrowser(dataset),
        onShowScatter: () => {
            // Lazy-init the scatter panel in the main mount area
            const scatterMount = document.getElementById('datasetBrowserMount')!;
            if (!embeddingScatterPanel) {
                embeddingScatterPanel = new EmbeddingScatterPanel({
                    container: scatterMount,
                    dataset,
                    onOpenRecording: (rec) => showRecordingDetail(rec, detailMount),
                    onStatusMessage: setStatus,
                    onShowClusters: () => showClusterBrowser(dataset),
                });
            }
            embeddingScatterPanel.mount([]).catch((e) => setStatus(`Scatter error: ${e}`));
        },
        onStatusMessage: setStatus,
    });
    gallery.mount().catch((e) => setStatus(`Gallery error: ${e}`));
}

/** Shows the recording detail panel in the detail sidebar. */
function showRecordingDetail(rec: Recording, detailMount: HTMLElement): void {
    // Ensure the detail panel is visible (similarity may have swapped it)
    if (!recordingDetailPanel) return;
    const simMount = document.getElementById('similarityMount');
    if (simMount) simMount.style.display = 'none';
    const detailWrapper = detailMount.querySelector<HTMLElement>('.detail-panel-wrapper');
    if (detailWrapper) detailWrapper.style.display = '';
    recordingDetailPanel.show(rec);
}

/** Shows the similarity browser in the detail sidebar for the given recording. */
function showSimilarRecordings(rec: Recording, detailMount: HTMLElement, _dataset: Dataset): void {
    if (!similarityBrowserPanel) return;
    // Hide the recording detail panel, show the similarity panel
    const simMount = document.getElementById('similarityMount');
    if (!simMount) return;
    const detailWrapper = detailMount.querySelector<HTMLElement>('.detail-panel-wrapper');
    if (detailWrapper) detailWrapper.style.display = 'none';
    simMount.style.display = '';
    similarityBrowserPanel.showSimilarTo(rec).catch((e) => setStatus(`Similarity error: ${e}`));
}

/** Shows (or creates) the Cluster Browser in the corpus main area. */
function showClusterBrowser(dataset: Dataset): void {
    const mount = document.getElementById('datasetBrowserMount')!;

    if (clusterBrowserPanel) {
        clusterBrowserPanel.updateDataset(dataset);
        clusterBrowserPanel.load().catch((e) => setStatus(`Cluster-Fehler: ${e}`));
        return;
    }

    clusterBrowserPanel = new ClusterBrowserPanel({
        container: mount,
        dataset,
        onOpenRecording: (rec) => {
            const detailMount = document.getElementById('datasetDetailMount')!;
            showRecordingDetail(rec, detailMount);
        },
        onStatusMessage: setStatus,
    });
    clusterBrowserPanel.load().catch((e) => setStatus(`Cluster-Fehler: ${e}`));
}

/** Creates a hidden similarity panel mount inside the detail sidebar. */
function createSimilarityMount(detailMount: HTMLElement): HTMLElement {
    // Wrap existing content
    const existing = detailMount.innerHTML;
    detailMount.innerHTML = `
        <div class="detail-panel-wrapper" style="height:100%;overflow:auto;">${existing}</div>
        <div id="similarityMount" style="display:none;height:100%;overflow:auto;"></div>
    `;
    return detailMount.querySelector('#similarityMount') as HTMLElement;
}

function showImportWizard(dataset: Dataset): void {
    const mount = document.getElementById('datasetBrowserMount')!;

    const wizard = new ImportWizardPanel({
        container: mount,
        dataset,
        onDone: (result) => {
            setStatus(`Import: ${result.imported} imported, ${result.skipped} skipped.`);
            showRecordingGallery(dataset);
        },
        onCancel: () => showRecordingGallery(dataset),
        onStatusMessage: setStatus,
        openFolderDialog: () => openFolderDialogPath(),
    });
    wizard.mount();
}

function showXcImportPanel(dataset: Dataset): void {
    const mount = document.getElementById('datasetBrowserMount')!;
    xcImportPanel = new XcImportPanel({
        container: mount,
        dataset,
        onBack: () => {
            xcImportPanel = null;
            showRecordingGallery(dataset);
        },
        onStatusMessage: setStatus,
        onImported: (count) => {
            if (count > 0) setStatus(`XC import: ${count} recordings added.`);
        },
    });
    xcImportPanel.mount();
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
    // Switch to labeling view and load the file
    switchView('labeling');
    const labels = extractSpectrogramLabels(recording);
    loadAudioFile(recording.filepath).then(() => {
        if (labels.length > 0) {
            ensurePlayer().then((p) => p.setSpectrogramLabels(labels)).catch(() => { /* ignore */ });
        }
    }).catch(() => { /* error already shown in status bar */ });
    setStatus(`Opening: ${recording.filepath.split('/').pop()}`);
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

// ── File browser ──────────────────────────────────────────────────────

async function openFolder(): Promise<void> {
    const dir = await openFolderDialog();
    if (!dir) return;

    folderLabel.textContent = dir.split(/[/\\]/).pop() ?? dir;
    setStatus(`Scanning ${dir}…`);
    fileList.innerHTML = '<li class="empty-hint">Scanning…</li>';
    fileBrowserPanel.hidden = false;

    let files: FsEntry[];
    try {
        files = await readDirFlat(dir);
    } catch (err) {
        setStatus(`Could not read folder: ${err}`);
        fileList.innerHTML = '<li class="empty-hint">Could not read folder.</li>';
        return;
    }

    if (files.length === 0) {
        fileList.innerHTML = '<li class="empty-hint">No audio files found.</li>';
        setStatus('No audio files in selected folder.');
        return;
    }

    setStatus(`Found ${files.length} audio file(s)`);
    fileList.innerHTML = files.map((f) => `
        <li class="file-item" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
            <svg class="file-item__icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
            <span class="file-item__name">${escapeHtml(f.name ?? f.path.split(/[/\\]/).pop() ?? '')}</span>
            <button class="tb-btn file-item__load-btn" data-path="${escapeHtml(f.path)}" type="button">Open</button>
        </li>
    `).join('');

    fileList.querySelectorAll<HTMLButtonElement>('.file-item__load-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            loadAudioFile(btn.dataset.path!);
        });
    });
    fileList.querySelectorAll<HTMLLIElement>('.file-item').forEach((li) => {
        li.addEventListener('dblclick', () => loadAudioFile(li.dataset.path!));
    });
}

// ── Player ────────────────────────────────────────────────────────────

async function ensurePlayer(): Promise<BirdNETPlayer> {
    if (player) return player;

    centrePlaceholder.hidden = true;
    playerContainer.hidden = false;

    // Wait one animation frame so the browser computes layout before the player
    // reads container dimensions for canvas sizing.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    player = new BirdNETPlayer(playerContainer, {
        showFileOpen: false,
        enableProgressiveSpectrogram: true,
        showOverview: true,
        showTransport: true,
    });
    await player.ready;
    // Trigger a resize so canvas dimensions match the now-visible container.
    player.resize();
    return player;
}

// Tracks the current blob URL so we can revoke it when a new file is loaded.
let _currentBlobUrl: string | null = null;

async function loadAudioFile(filePath: string): Promise<void> {
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    setStatus(`Loading ${fileName}…`);

    fileList.querySelectorAll('.file-item').forEach((li) => {
        (li as HTMLElement).classList.toggle(
            'file-item--active',
            (li as HTMLElement).dataset.path === filePath,
        );
    });

    try {
        // Read the file as binary via tauri-plugin-fs, then wrap in a Blob URL.
        // This avoids asset-protocol CSP/scope issues entirely.
        const bytes = await tauriInvoke<number[]>('plugin:fs|read_file', { path: filePath });
        const ext = (filePath.split('.').pop() ?? 'wav').toLowerCase();
        const mimeMap: Record<string, string> = {
            wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac',
            ogg: 'audio/ogg', aac: 'audio/aac', m4a: 'audio/mp4',
            opus: 'audio/ogg; codecs=opus', aif: 'audio/aiff', aiff: 'audio/aiff',
        };
        const mime = mimeMap[ext] ?? 'audio/wav';
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });

        if (_currentBlobUrl) URL.revokeObjectURL(_currentBlobUrl);
        _currentBlobUrl = URL.createObjectURL(blob);

        const p = await ensurePlayer();
        await p.loadUrl(_currentBlobUrl);
        setStatus(`Loaded: ${fileName}`);
    } catch (err) {
        setStatus(`Failed to load file: ${err}`);
    }
}

// ── Import single file ─────────────────────────────────────────────────

async function importSingleFile(): Promise<void> {
    if (!activeProjectId) {
        setStatus('Select or create a project first.');
        return;
    }
    const filePath = await openFileDialog();
    if (!filePath) return;

    setStatus(`Importing ${filePath.split(/[/\\]/).pop()}…`);
    try {
        const asset = await tauriAssetImportLocal(activeProjectId, filePath);
        setStatus(`Imported: ${filePath.split(/[/\\]/).pop()} (${(asset.sizeBytes / 1024).toFixed(1)} KB)`);
        await refreshProjects();
        // Also open in player
        await loadAudioFile(filePath);
    } catch (err) {
        setStatus(`Import failed: ${err}`);
    }
}

// ── Project list ──────────────────────────────────────────────────────

async function refreshProjects(): Promise<void> {
    let summaries: ProjectSummary[];
    try {
        summaries = await repo.list();
    } catch (err) {
        setStatus(`Failed to load projects: ${err}`);
        return;
    }
    if (summaries.length === 0) {
        projectList.innerHTML = '<li class="empty-hint">No projects yet.</li>';
        return;
    }
    projectList.innerHTML = summaries.map((p) => `
        <li class="project-item${p.id === activeProjectId ? ' project-item--active' : ''}"
            data-project-id="${p.id}">
            <span class="project-item__name">${escapeHtml(p.name)}</span>
            <span class="project-item__meta">${p.labelCount} labels · ${formatDate(p.updatedAt)}</span>
        </li>
    `).join('');
    projectList.querySelectorAll<HTMLLIElement>('.project-item').forEach((el) => {
        el.addEventListener('click', () => selectProject(el.dataset.projectId!));
    });
}

function selectProject(id: string): void {
    activeProjectId = id;
    projectList.querySelectorAll<HTMLLIElement>('.project-item').forEach((el) => {
        el.classList.toggle('project-item--active', el.dataset.projectId === id);
    });
    setStatus(`Project selected`);
    refreshJobs();
}

async function createProject(): Promise<void> {
    const name = prompt('Project name:', 'New Project');
    if (name === null) return;
    try {
        const created = await tauriProjectCreate(name.trim() || undefined);
        setStatus(`Created project: ${created.name}`);
        activeProjectId = created.id;
        await refreshProjects();
    } catch (err) {
        setStatus(`Error creating project: ${err}`);
    }
}

// ── Job queue ──────────────────────────────────────────────────────────

async function refreshJobs(): Promise<void> {
    let jobs: LocalAnalysisJob[];
    try {
        jobs = await tauriListLocalJobs(activeProjectId ?? undefined);
    } catch (err) {
        setStatus(`Failed to load jobs: ${err}`);
        return;
    }
    if (jobs.length === 0) {
        jobList.innerHTML = '<li class="empty-hint">No analysis jobs for this project.</li>';
        return;
    }
    jobList.innerHTML = jobs.map((j) => `
        <li class="job-item">
            <span class="job-item__id">${escapeHtml(j.id.slice(0, 18))}…</span>
            ${jobStatusBadge(j.status)}
            <span class="job-item__meta">${formatDate(j.createdAt)}</span>
            ${j.status === 'running' || j.status === 'queued'
                ? `<button class="tb-btn tb-btn--danger cancel-job-btn" data-job-id="${escapeHtml(j.id)}" type="button">Cancel</button>`
                : ''}
        </li>
    `).join('');
    jobList.querySelectorAll<HTMLButtonElement>('.cancel-job-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await tauriCancelLocalJob(btn.dataset.jobId!);
                setStatus('Job cancelled');
                await refreshJobs();
            } catch (err) {
                setStatus(`Cancel failed: ${err}`);
            }
        });
    });
}

async function runAnalysis(): Promise<void> {
    if (!activeProjectId) { setStatus('Select a project first.'); return; }
    setStatus('Starting analysis…');
    try {
        const job = await tauriAnalysisRunLocal(activeProjectId, undefined, 'local');
        setStatus(`Analysis started — status: ${job.status}`);
        await refreshJobs();
    } catch (err) {
        setStatus(`Analysis failed: ${err}`);
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
                await MenuItem.new({ id: 'new-project',  text: 'New Project',        accelerator: 'CmdOrCtrl+N', action: createProject }),
                await PredefinedMenuItem.new({ item: 'Separator' }),
                await MenuItem.new({ id: 'open-folder',  text: 'Open Folder…',       accelerator: 'CmdOrCtrl+O', action: openFolder }),
                await MenuItem.new({ id: 'import-file',  text: 'Import Audio File…', accelerator: 'CmdOrCtrl+I', action: importSingleFile }),
                await PredefinedMenuItem.new({ item: 'Separator' }),
                await PredefinedMenuItem.new({ item: 'CloseWindow' }),
            ],
        });

        const analysisMenu = await Submenu.new({
            text: 'Analysis',
            items: [
                await MenuItem.new({ id: 'run-analysis',      text: 'Run Analysis',         accelerator: 'CmdOrCtrl+R',       action: runAnalysis }),
                await MenuItem.new({ id: 'refresh-jobs',      text: 'Refresh Job List',     accelerator: 'CmdOrCtrl+Shift+R', action: refreshJobs }),
                await PredefinedMenuItem.new({ item: 'Separator' }),
                await MenuItem.new({ id: 'backend-settings',  text: 'Backend Settings…',    accelerator: 'CmdOrCtrl+,',       action: openConnPopover }),
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

    // ── View switcher tabs ───────────────────────────────────────────────
    document.querySelectorAll<HTMLButtonElement>('.view-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view as AppView | undefined;
            if (view) switchView(view);
        });
    });

    newProjectBtn.addEventListener('click', createProject);
    openFolderBtn.addEventListener('click', openFolder);
    importFileBtn.addEventListener('click', importSingleFile);
    runAnalysisBtn.addEventListener('click', runAnalysis);
    refreshJobsBtn.addEventListener('click', refreshJobs);

    applyTheme(currentTheme());
    await initConnectionUI();

    // Theme toggle button in topbar (mirrors the menu item).
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
        const updateThemeBtn = () => {
            const isDark = currentTheme() === 'dark';
            themeBtn.textContent = isDark ? '☀' : '☾';
            themeBtn.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
        };
        updateThemeBtn();
        themeBtn.addEventListener('click', () => {
            applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
            updateThemeBtn();
        });
    }

    await Promise.all([
        refreshProjects(),
        buildNativeMenu(),
    ]);
    setStatus('Ready');
}

boot().catch((err) => console.error('[desktop-app] boot failed:', err));
