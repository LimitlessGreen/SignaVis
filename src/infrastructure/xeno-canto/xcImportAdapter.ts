// ═══════════════════════════════════════════════════════════════════════
// xcImportAdapter.ts — Maps XC recording metadata to Recording fields
// ═══════════════════════════════════════════════════════════════════════

import type { XcRecording } from './xcSearchApi.ts';
import type { GeoLocation } from '../../domain/corpus/types.ts';

/**
 * Result of mapping a XC recording to Recording fields.
 * Ready to be sent to the `xc_download_recording` Tauri command,
 * which will persist the audio file and create a RecordingRecord.
 */
export interface XcImportPayload {
    xcId: string;
    /** Audio URL (direct mp3 link from XC). */
    audioUrl: string;
    /** Suggested local filename (XC<id>.mp3). */
    filename: string;
    /** ISO-8601 recording timestamp, or undefined. */
    recordedAt?: string;
    /** Geographic position if lat/lng are valid. */
    location?: GeoLocation;
    /**
     * Flat key→value metadata stored in Recording.fields.
     * All values are strings to match the Rust HashMap<String,String>.
     */
    fields: Record<string, string>;
}

// Parse XC "len" (m:ss or mm:ss) → seconds as string, or ''
function xcLenToSeconds(len: string): string {
    if (!len) return '';
    const parts = len.trim().split(':').map(Number);
    if (parts.some(isNaN)) return '';
    if (parts.length === 2) return String(parts[0] * 60 + parts[1]);
    if (parts.length === 3) return String(parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return '';
}

// Parse XC date + time → ISO-8601, or undefined
function xcDateTime(date: string, time: string): string | undefined {
    if (!date) return undefined;
    const d = date.trim();
    const t = time ? time.trim() : '';
    if (t && /^\d{2}:\d{2}$/.test(t)) return `${d}T${t}:00`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d}T00:00:00`;
    return undefined;
}

/**
 * Maps a XcRecording object (from xcSearchApi) into an XcImportPayload
 * ready to hand to the Tauri download command.
 */
export function mapXcRecordingToPayload(rec: XcRecording): XcImportPayload {
    const xcId = String(rec.id);
    const audioUrl = rec.file ?? '';
    const filename = `XC${xcId}.mp3`;

    const scientificName = [rec.gen, rec.sp].filter(Boolean).join(' ').trim();

    const fields: Record<string, string> = {};
    if (xcId)               fields['xc_id']       = xcId;
    if (scientificName)     fields['xc_species']   = scientificName;
    if (rec.en)             fields['xc_species_en']= rec.en;
    if (rec.cnt)            fields['xc_country']   = rec.cnt;
    if (rec.loc)            fields['xc_locality']  = rec.loc;
    if (rec.rec)            fields['xc_recordist'] = rec.rec;
    if (rec.type)           fields['xc_type']      = rec.type;
    if (rec.q)              fields['xc_quality']   = rec.q;
    if (rec.lic)            fields['xc_license']   = rec.lic;
    if (rec.url)            fields['xc_url']       = rec.url;
    if (rec.lat)            fields['lat']          = rec.lat;
    if (rec.lng)            fields['lng']          = rec.lng;
    if (rec.alt)            fields['xc_altitude']  = rec.alt;
    const durSec = xcLenToSeconds(rec.len);
    if (durSec)             fields['xc_duration_s']= durSec;

    const recordedAt = xcDateTime(rec.date, rec.time);

    let location: GeoLocation | undefined;
    const lat = parseFloat(rec.lat);
    const lon = parseFloat(rec.lng);
    if (isFinite(lat) && isFinite(lon)) {
        const alt = parseFloat(rec.alt);
        location = {
            latitude: lat,
            longitude: lon,
            ...(isFinite(alt) ? { altitude: alt } : {}),
        };
    }

    return { xcId, audioUrl, filename, recordedAt, location, fields };
}
