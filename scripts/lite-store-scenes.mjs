// Scenes for scripts/lite-store-screenshots.mjs, in Store order.
// url: page to open (relative to demo/labeling-app.html; omit to stay on the page
// of the previous scene); setup: JS run in the page with S = { sleep, waitFor,
// click, ready, tab }; settle: ms to wait before the capture.

// Fresh profile: no daily tip on top of the first screenshot.
export const PREPARE = `localStorage.setItem('signavis.daily-tips.disabled', '1');`;

// Extra helpers for the scenes.
export const HELPERS = `
  // Recording loaded and the spectrogram drawn.
  S.ready = () => S.waitFor(() => {
    const name = document.getElementById('fileLabel')?.textContent || '';
    const overlay = document.querySelector('[data-aw="recomputingOverlay"]');
    return name && !/No file loaded|Decoding|download/i.test(name) && overlay?.hidden;
  }, 120000);
  // Open a sidebar tab (left or right activity bar) by its panel id.
  S.tab = (id) => {
    const btn = document.querySelector('.activity-btn[data-panel="' + id + '"]');
    if (!btn) throw new Error('no tab ' + id);
    if (!btn.classList.contains('active')) btn.click();
  };
`;

const XC = 'labeling-app.html?xc=XC1089065&lang=en';

export const SCENES = [
  {
    name: '01-overview',
    url: XC,
    // Zoom the frequency axis to ~0–12 kHz (0–26 kHz would be mostly empty;
    // "Auto" finds nothing to cut here because of a few high sweeps).
    setup: `await S.ready(); S.tab('project');
      S.click('[data-aw="freqZoomInBtn"]'); S.click('[data-aw="freqZoomInBtn"]');`,
    settle: 3000,
  },
  {
    name: '02-birdnet',
    // Running BirdNET switches to the Labels tab; go back to show the run.
    setup: `
      S.tab('analyse');
      S.click('#birdnetAnalyzeBtn');
      await S.sleep(3000);
      await S.waitFor(() => /^(Done|Error)/.test(document.getElementById('birdnetStatus')?.textContent || ''), 300000);
      await S.sleep(500);
      S.tab('analyse');`,
    settle: 2500,
  },
  {
    name: '03-labels',
    // The Tracks tab is already active (clicking it again would collapse the tracks).
    setup: `S.tab('labels');`,
    settle: 2000,
  },
  {
    name: '04-table',
    setup: `S.click('.overview-label-view-tab[data-view="table"]');`,
    settle: 2000,
  },
  {
    name: '05-display',
    setup: `S.click('.overview-label-view-tab[data-view="tracks"]'); S.tab('spectrogram');`,
    settle: 2500,
  },
];
