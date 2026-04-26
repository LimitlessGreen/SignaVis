// Minimal Node ESM loader to stub out style imports during tests.
// Returns an empty module for .css/.scss/.sass/.less imports so the
// test runner can import TypeScript modules that reference styles.

export async function resolve(specifier, context, defaultResolve) {
  if (typeof specifier === 'string' && (specifier.endsWith('.css') || specifier.endsWith('.scss') || specifier.endsWith('.sass') || specifier.endsWith('.less'))) {
    return { url: 'data:application/javascript,export%20default%20{}', shortCircuit: true };
  }
  return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
  if (typeof url === 'string' && url.startsWith('data:application/javascript')) {
    return { format: 'module', source: 'export default {}', shortCircuit: true };
  }
  return defaultLoad(url, context, defaultLoad);
}
