import test from 'node:test';
import assert from 'node:assert/strict';

import { projectMenu, settingsMenu } from '../src/app/lite/top-menus.ts';

const ids = (entries) => entries.filter((e) => e.id).map((e) => e.id);
const base = { kind: 'folder', hasCatalog: true, canRecord: true, xcToFolder: false, recentCount: 2 };

test('projectMenu: folder project with catalog has every entry of mockup B3', () => {
    assert.deepEqual(ids(projectMenu(base)), [
        'add-file', 'record', 'add-xc', 'catalog-import',
        'open-folder', 'open-recent', 'sites', 'xc-to-folder', 'rescan',
        'import-labels', 'export-labels', 'upload', 'new-session',
    ]);
    const toggle = projectMenu({ ...base, xcToFolder: true }).find((e) => e.id === 'xc-to-folder');
    assert.equal(toggle.checked, true);
});

test('projectMenu: default project has no folder entries; no microphone, no recent', () => {
    const m = projectMenu({ ...base, kind: 'browser', hasCatalog: false, canRecord: false, recentCount: 0 });
    const got = ids(m);
    for (const id of ['record', 'catalog-import', 'sites', 'xc-to-folder', 'rescan']) assert.ok(!got.includes(id), id);
    assert.equal(m.find((e) => e.id === 'open-recent').disabled, true);
    assert.ok(m.find((e) => e.id === 'new-session').danger);
});

test('projectMenu: a folder without catalog offers the import but not sites', () => {
    const got = ids(projectMenu({ ...base, hasCatalog: false }));
    assert.ok(got.includes('catalog-import'));
    assert.ok(!got.includes('sites'));
});

test('settingsMenu: shows language, key state and theme', () => {
    const m = settingsMenu({ language: 'de', hasXcKey: true, dark: false });
    assert.equal(m.find((e) => e.id === 'language').hint, 'de');
    assert.equal(m.find((e) => e.id === 'xc-key').hint, 'saved ✓');
    assert.equal(m.find((e) => e.id === 'theme').checked, false);
    assert.equal(settingsMenu({ language: 'en', hasXcKey: false, dark: true }).find((e) => e.id === 'xc-key').hint, 'not set');
    // AI assistants only where the app can run the MCP server
    assert.equal(m.find((e) => e.id === 'ai-assistants'), undefined);
    assert.equal(settingsMenu({ language: 'en', hasXcKey: false, dark: true, ai: true }).find((e) => e.id === 'ai-assistants').checked, true);
    // "Don't ask" only while the assistants are on
    assert.equal(m.find((e) => e.id === 'ai-no-ask'), undefined);
    assert.equal(settingsMenu({ language: 'en', hasXcKey: false, dark: true, ai: false }).find((e) => e.id === 'ai-no-ask'), undefined);
    assert.equal(settingsMenu({ language: 'en', hasXcKey: false, dark: true, ai: true }).find((e) => e.id === 'ai-no-ask').checked, false);
    assert.equal(settingsMenu({ language: 'en', hasXcKey: false, dark: true, ai: true, aiNoAsk: true }).find((e) => e.id === 'ai-no-ask').checked, true);
});
