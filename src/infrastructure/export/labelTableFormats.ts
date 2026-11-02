// ═══════════════════════════════════════════════════════════════════════
// infrastructure/export/labelTableFormats.ts — label exports from the table view
//
// Every exporter takes the rows the table currently shows (filter + sort applied)
// and returns file text. Frequencies are Hz unless the format says otherwise.
//
//   csv       — the visible table columns, comma separated (Excel / R / pandas)
//   raven     — Raven Pro selection table (see ravenSelectionTable.ts)
//   audacity  — Audacity label track incl. frequency lines (File → Import → Labels)
//   sonicvis  — Sonic Visualiser region layer CSV (time, duration, label)
//   json      — SignaVis label JSON (same shape as the main JSON export)
// ═══════════════════════════════════════════════════════════════════════

import { buildRavenSelectionTable, ravenTablePath } from './ravenSelectionTable.ts';

export type LabelExportFormat = 'csv' | 'raven' | 'audacity' | 'sonicvis' | 'json';

export interface LabelExportColumn {
    title: string;
    /** Raw (machine readable) value for a label. */
    value: (l: any) => string | number | null | undefined;
}

export interface LabelExportOptions {
    sampleRate?: number | null;
    setName?: (setId: string) => string;
    /** Columns for CSV (the table's visible columns). */
    columns?: LabelExportColumn[];
    /** Display name for a label (common name in the UI language). */
    displayName?: (l: any) => string;
}

export const LABEL_EXPORT_FORMATS: { id: LabelExportFormat; label: string; hint: string }[] = [
    { id: 'csv', label: 'CSV (visible columns)', hint: 'Excel, R, pandas' },
    { id: 'raven', label: 'Raven selection table', hint: '.selections.txt' },
    { id: 'audacity', label: 'Audacity labels', hint: '.txt, with frequency range' },
    { id: 'sonicvis', label: 'Sonic Visualiser regions', hint: '.csv' },
    { id: 'json', label: 'SignaVis JSON', hint: '.json' },
];

const csvCell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const n6 = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '';
};
const oneLine = (v: unknown) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

export function buildLabelsCsv(labels: any[], columns: LabelExportColumn[]): string {
    const head = columns.map((c) => csvCell(c.title)).join(',');
    const rows = labels.map((l) => columns.map((c) => csvCell(c.value(l))).join(','));
    return [head, ...rows].join('\r\n') + '\r\n';
}

/** Audacity label track: "start\tend\tlabel" plus "\\\tfmin\tfmax" for spectral selections. */
export function buildAudacityLabels(labels: any[], opts: LabelExportOptions = {}): string {
    const out: string[] = [];
    for (const l of labels) {
        const name = oneLine(opts.displayName?.(l) || l.label || l.scientificName || 'Label');
        out.push(`${n6(l.start)}\t${n6(l.end)}\t${name}`);
        const lo = Number(l.freqMin), hi = Number(l.freqMax);
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi > 0 && !l.freqUnset) out.push(`\\\t${n6(lo)}\t${n6(hi)}`);
    }
    return out.join('\n') + '\n';
}

/** Sonic Visualiser region layer import: time, duration, label (no header). */
export function buildSonicVisualiserRegions(labels: any[], opts: LabelExportOptions = {}): string {
    return labels.map((l) => [
        n6(l.start), n6(Number(l.end) - Number(l.start)),
        csvCell(oneLine(opts.displayName?.(l) || l.label || '')),
    ].join(',')).join('\n') + '\n';
}

export function buildLabelsJson(labels: any[]): string {
    return JSON.stringify({
        labels: labels.map((l) => ({
            id: l.id, label: l.label, scientificName: l.scientificName || '', commonName: l.commonName || '',
            start: l.start, end: l.end, freqMin: l.freqMin, freqMax: l.freqMax, color: l.color || '',
            confidence: l.confidence != null ? l.confidence : '', origin: l.origin || '', author: l.author || '',
            tags: l.tags || {},
        })),
    }, null, 2);
}

/** Build the file for one format. `baseName` is the audio file name without extension. */
export function buildLabelExport(format: LabelExportFormat, labels: any[], baseName: string, opts: LabelExportOptions = {}) {
    switch (format) {
        case 'raven':
            return { name: ravenTablePath(`${baseName}.wav`), mime: 'text/plain', text: buildRavenSelectionTable(labels, opts) };
        case 'audacity':
            return { name: `${baseName}.labels.txt`, mime: 'text/plain', text: buildAudacityLabels(labels, opts) };
        case 'sonicvis':
            return { name: `${baseName}.regions.csv`, mime: 'text/csv', text: buildSonicVisualiserRegions(labels, opts) };
        case 'json':
            return { name: `${baseName}.labels.json`, mime: 'application/json', text: buildLabelsJson(labels) };
        case 'csv':
        default:
            return { name: `${baseName}.labels.csv`, mime: 'text/csv', text: '﻿' + buildLabelsCsv(labels, opts.columns || []) };
    }
}
