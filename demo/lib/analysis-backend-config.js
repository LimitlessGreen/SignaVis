const MODE_KEY = 'audio-workbench.analysis.mode.v1';
const ENDPOINT_KEY = 'audio-workbench.analysis.endpoint.v1';

const DEFAULT_MODE = 'local';
const DEFAULT_ENDPOINT = 'http://localhost:8787';

function normalizeMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (value === 'server' || value === 'cloud') return value;
  return 'local';
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

export function loadAnalysisBackendConfig() {
  const fromUrl = readUrlConfig();
  let mode = DEFAULT_MODE;
  let endpoint = DEFAULT_ENDPOINT;

  try {
    const storedMode = localStorage.getItem(MODE_KEY);
    const storedEndpoint = localStorage.getItem(ENDPOINT_KEY);
    if (storedMode) mode = normalizeMode(storedMode);
    if (storedEndpoint) endpoint = String(storedEndpoint).trim() || DEFAULT_ENDPOINT;
  } catch {
    // Ignore storage errors and keep defaults.
  }

  if (fromUrl.mode) mode = fromUrl.mode;
  if (fromUrl.endpoint) endpoint = fromUrl.endpoint;

  return { mode, endpoint };
}

export function saveAnalysisBackendConfig({ mode, endpoint }) {
  try {
    localStorage.setItem(MODE_KEY, normalizeMode(mode));
    if (endpoint && String(endpoint).trim()) {
      localStorage.setItem(ENDPOINT_KEY, String(endpoint).trim());
    }
  } catch {
    // Ignore storage errors in demo.
  }
}

export function normalizeAnalysisBackendConfig({ mode, endpoint }) {
  return {
    mode: normalizeMode(mode),
    endpoint: String(endpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT,
  };
}
