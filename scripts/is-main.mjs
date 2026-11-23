// True when the module with this import.meta.url was started directly (node script.mjs),
// false when it was imported. Compares file URLs, so Windows paths (file:///C:/…) and
// paths with spaces (%20) match.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMain(metaUrl, argv1 = process.argv[1]) {
    if (!argv1) return false;
    return metaUrl === pathToFileURL(path.resolve(argv1)).href;
}
