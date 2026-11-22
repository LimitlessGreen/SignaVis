import { prefs } from '../infrastructure/storage/prefs.ts';
const MODE_KEY = 'audio-workbench.analysis.mode.v1';
const ENDPOINT_KEY = 'audio-workbench.analysis.endpoint.v1';
const PLATFORM_LOCAL_KEY = 'audio-workbench.platform.local.v1';

const DEFAULT_MODE = 'local';
const DEFAULT_ENDPOINT = 'http://localhost:8787';
const PLATFORM_LOCAL_MODE = 'hybrid';
const PLATFORM_LOCAL_ENDPOINT = 'http://localhost:8788';

function normalizeMode(mode: any) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'server' || value === 'cloud' || value === 'hybrid') return value;
  return 'local';
}

function normalizeEndpoint(endpoint: any) {
  return String(endpoint ?? '').trim();
}

function readUrlConfig() {
  try {
    const u = new URL(location.href);
    const mode = u.searchParams.get('analysisMode');
    const endpoint = u.searchParams.get('analysisEndpoint');
    return {
      mode: mode ? normalizeMode(mode) : null,
      endpoint: endpoint ? String(endpoint).trim() : null,
    };
  } catch {
    return { mode: null, endpoint: null };
  }
}

function parseBooleanFlag(value: any) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function readUrlPlatformLocalFlag() {
  try {
    const u = new URL(location.href);
    return parseBooleanFlag(u.searchParams.get('platformLocal'));
  } catch {
    return null;
  }
}

export function loadPlatformLocalFlag() {
  let value = parseBooleanFlag(prefs.get(PLATFORM_LOCAL_KEY)) ?? false;

  const fromUrl = readUrlPlatformLocalFlag();
  if (fromUrl !== null) {
    value = fromUrl;
    prefs.set(PLATFORM_LOCAL_KEY, String(fromUrl));
  }

  return value;
}

export function loadAnalysisBackendConfig() {
  const platformLocal = loadPlatformLocalFlag();
  const fromUrl = readUrlConfig();
  let mode = platformLocal ? PLATFORM_LOCAL_MODE : DEFAULT_MODE;
  let endpoint = '';

  try {
    const storedMode = prefs.get(MODE_KEY);
    const storedEndpoint = prefs.get(ENDPOINT_KEY);
    if (storedMode) mode = normalizeMode(storedMode);
    if (storedEndpoint !== null) endpoint = normalizeEndpoint(storedEndpoint);
  } catch {
    // Ignore storage errors and keep defaults.
  }

  if (fromUrl.mode) mode = fromUrl.mode;
  if (fromUrl.endpoint !== null) endpoint = normalizeEndpoint(fromUrl.endpoint);

  return normalizeAnalysisBackendConfig({
    mode,
    endpoint: endpoint || (platformLocal ? PLATFORM_LOCAL_ENDPOINT : DEFAULT_ENDPOINT),
  });
}

export function saveAnalysisBackendConfig({ mode, endpoint }: any) {
  try {
    const normalizedMode = normalizeMode(mode);
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    prefs.set(MODE_KEY, normalizedMode);
    if (normalizedEndpoint) {
      prefs.set(ENDPOINT_KEY, normalizedEndpoint);
    } else {
      prefs.remove(ENDPOINT_KEY);
    }
  } catch {
    // Ignore storage errors in demo.
  }
}

export function normalizeAnalysisBackendConfig({ mode, endpoint }: any) {
  const platformLocal = loadPlatformLocalFlag();
  const defaultEndpoint = platformLocal ? PLATFORM_LOCAL_ENDPOINT : DEFAULT_ENDPOINT;
  const normalizedMode = normalizeMode(mode);
  const normalizedEndpoint = normalizeEndpoint(endpoint);

  if (normalizedMode === 'hybrid') {
    return {
      mode: normalizedMode,
      endpoint: normalizedEndpoint,
    };
  }

  return {
    mode: normalizedMode,
    endpoint: normalizedEndpoint || defaultEndpoint,
  };
}
