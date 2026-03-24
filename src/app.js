// ═══════════════════════════════════════════════════════════════════════
// app.js — Application entry point
// ═══════════════════════════════════════════════════════════════════════

import { BirdNETPlayer } from './BirdNETPlayer.js';

const container = document.getElementById('player-root');
if (container) {
    /** @type {any} */ (window).player = new BirdNETPlayer(container);
}
