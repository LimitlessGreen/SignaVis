// ═══════════════════════════════════════════════════════════════════════
// app.js — Application entry point
// ═══════════════════════════════════════════════════════════════════════

import { BirdNETPlayer } from './index.ts';

const container = document.getElementById('player-root');
if (container) {
    /** @type {any} */ (window).player = new BirdNETPlayer(container);
}
