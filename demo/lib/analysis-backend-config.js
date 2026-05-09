const MODE_KEY = 'audio-workbench.analysis.mode.v1';
const ENDPOINT_KEY = 'audio-workbench.analysis.endpoint.v1';
const PLATFORM_LOCAL_KEY = 'audio-workbench.platform.local.v1';

const DEFAULT_MODE = 'local';
const DEFAULT_ENDPOINT = 'http://localhost:8787';
const PLATFORM_LOCAL_MODE = 'hybrid';
const PLATFORM_LOCAL_ENDPOINT = 'http://localhost:8788';

function normalizeMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'server' || value === 'cloud' || value === 'hybrid') return value;
  return 'local';
}

function normalizeEndpoint(endpoint) {
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

function parseBooleanFlag(value) {
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
  let value = false;
  try {
    value = parseBooleanFlag(localStorage.getItem(PLATFORM_LOCAL_KEY)) ?? false;
  } catch {
    value = false;
  }

  const fromUrl = readUrlPlatformLocalFlag();
  if (fromUrl !== null) {
    value = fromUrl;
    try {
      localStorage.setItem(PLATFORM_LOCAL_KEY, String(fromUrl));
    } catch {
      // Ignore storage errors in demo.
    }
  }

  return value;
}

export function loadAnalysisBackendConfig() {
  const platformLocal = loadPlatformLocalFlag();
  const fromUrl = readUrlConfig();
  let mode = platformLocal ? PLATFORM_LOCAL_MODE : DEFAULT_MODE;
  let endpoint = '';

  try {
    const storedMode = localStorage.getItem(MODE_KEY);
    const storedEndpoint = localStorage.getItem(ENDPOINT_KEY);
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

export function saveAnalysisBackendConfig({ mode, endpoint }) {
  try {
    const normalizedMode = normalizeMode(mode);
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    localStorage.setItem(MODE_KEY, normalizedMode);
    if (normalizedEndpoint) {
      localStorage.setItem(ENDPOINT_KEY, normalizedEndpoint);
    } else {
      localStorage.removeItem(ENDPOINT_KEY);
    }
  } catch {
    // Ignore storage errors in demo.
  }
}

export function normalizeAnalysisBackendConfig({ mode, endpoint }) {
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
