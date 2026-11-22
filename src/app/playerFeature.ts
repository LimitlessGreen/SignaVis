// ═══════════════════════════════════════════════════════════════════════
// playerFeature.ts — optional building blocks of the player
//
// A feature installs itself on a player through its public API and returns
// a teardown. The core imports no feature; a host passes the ones it wants:
//
//   import { BirdNETPlayer } from 'signavis/core';
//   import { labelTable } from 'signavis/label-table';
//   new BirdNETPlayer(el, { features: [labelTable()] });
//
// 'signavis' (the full entry) knows every feature, so boolean options such as
// { labelTable: true } keep working there (BirdNETPlayer.optionFeatures).
// ═══════════════════════════════════════════════════════════════════════

import type { BirdNETPlayer } from './BirdNETPlayer.ts';

export interface PlayerFeature {
    /** Unique per player; installing the same name twice is a no-op. */
    readonly name: string;
    /** Called once the player is ready. May return a teardown, run on destroy(). */
    install(player: BirdNETPlayer): void | (() => void);
}

/** Builds the feature for a boolean/config player option, e.g. labelTable: true. */
export type OptionFeatureFactory = (player: BirdNETPlayer) => PlayerFeature;
