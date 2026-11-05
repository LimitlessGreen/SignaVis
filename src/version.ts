/**
 * SignaVis version as baked in at build time (see scripts/build-version.mjs).
 * Unreleased builds carry the commit, e.g. "1.0.4+a3113f0".
 * When the source runs unbundled (tests, tsx) the value is "dev".
 */
declare const __SIGNAVIS_VERSION__: string | undefined;
declare const __SIGNAVIS_COMMIT__: string | undefined;

export const SIGNAVIS_VERSION: string =
    typeof __SIGNAVIS_VERSION__ === 'string' && __SIGNAVIS_VERSION__ ? __SIGNAVIS_VERSION__ : 'dev';

export const SIGNAVIS_COMMIT: string =
    typeof __SIGNAVIS_COMMIT__ === 'string' ? __SIGNAVIS_COMMIT__ : '';

/**
 * Value for Annota `annotation_software_name_and_version`.
 * An explicit override (e.g. a host app wrapping SignaVis) wins.
 */
export function softwareNameAndVersion(override?: string | null): string {
    const v = (override ?? '').toString().trim() || SIGNAVIS_VERSION;
    return `SignaVis ${v}`;
}
