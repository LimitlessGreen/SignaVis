// ═══════════════════════════════════════════════════════════════════════
// app.js — Application entry point
// ═══════════════════════════════════════════════════════════════════════

import { BirdNETPlayer } from './app/BirdNETPlayer.ts';

const container = document.getElementById('player-root');
if (container) {
    /** @type {any} */ (window).player = new BirdNETPlayer(container);
}
