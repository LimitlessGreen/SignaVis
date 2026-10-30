/**
 * Fetch the XC value lists (sound type, sex, life stage) for the species group of one recording.
 * Endpoint: `/api/3/recording/{nr}?key=…&group_properties`.
 */

import { parseGroupProperties, recordingGroup, type Vocabulary } from '../../app/tag-vocabulary.ts';
import { normalizeXcNr } from './annotaPayload.ts';

export const XC_RECORDING_ENDPOINT = 'https://xeno-canto.org/api/3/recording';

export async function fetchXcGroupProperties(
    xcNr: any,
    { apiKey, fetchImpl, endpoint = XC_RECORDING_ENDPOINT }: { apiKey?: string; fetchImpl?: typeof fetch; endpoint?: string } = {},
): Promise<{ group: string; vocab: Partial<Vocabulary> } | null> {
    const nr = normalizeXcNr(xcNr);
    const key = String(apiKey || '').trim();
    if (!nr || !key) return null;
    const fetchFn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return null;
    const res = await fetchFn(`${endpoint}/${nr}?key=${encodeURIComponent(key)}&group_properties`);
    if (!res.ok) throw new Error(`XC group properties: HTTP ${res.status}`);
    const json = await res.json();
    const vocab = parseGroupProperties(json);
    if (!vocab) return null;
    const group = recordingGroup(json?.recording ?? json?.recordings?.[0] ?? json) || recordingGroup(json?.group_properties);
    return { group, vocab };
}
