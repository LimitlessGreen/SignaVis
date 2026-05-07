// ═══════════════════════════════════════════════════════════════════════
// transportState.ts — Transport state labels and transition policy
// ═══════════════════════════════════════════════════════════════════════

import { defineStateMachine, canTransition } from '../shared/stateMachine.ts';

const TRANSPORT_STATES = [
    '', 'idle', 'loading', 'ready', 'rendering',
    'playing', 'playing_loop', 'playing_segment',
    'paused', 'paused_segment', 'stopped', 'error',
] as const;

export type TransportStateName = typeof TRANSPORT_STATES[number];

export const TRANSPORT_MACHINE = defineStateMachine<TransportStateName>({
    states: TRANSPORT_STATES,
    labels: {
        '':               '',
        idle:             'Idle',
        loading:          'Loading',
        ready:            'Ready',
        rendering:        'Rendering...',
        playing:          'Playing',
        playing_loop:     'Playing (Loop)',
        playing_segment:  'Playing (Segment)',
        paused:           'Paused',
        paused_segment:   'Paused (Segment)',
        stopped:          'Stopped',
        error:            'Error',
    },
    transitions: {
        '':              new Set(['idle', 'loading', 'ready', 'error']),
        idle:            new Set(['loading', 'ready', 'error']),
        loading:         new Set(['ready', 'error', 'idle']),
        ready:           new Set(['rendering', 'playing', 'playing_loop', 'playing_segment', 'paused', 'stopped', 'loading', 'error']),
        rendering:       new Set(['ready', 'error', 'loading']),
        playing:         new Set(['paused', 'stopped', 'playing_loop', 'playing_segment', 'ready']),
        playing_loop:    new Set(['paused', 'stopped', 'playing', 'ready']),
        playing_segment: new Set(['paused_segment', 'stopped', 'ready']),
        paused:          new Set(['playing', 'playing_loop', 'stopped', 'ready', 'loading']),
        paused_segment:  new Set(['playing_segment', 'stopped', 'ready', 'paused']),
        stopped:         new Set(['playing', 'playing_loop', 'playing_segment', 'ready', 'loading']),
        error:           new Set(['loading', 'idle', 'ready']),
    },
});

/** Human-readable label for each transport state. */
export const TRANSPORT_STATE_LABELS = TRANSPORT_MACHINE.labels;

export function canTransitionTransportState(
    fromState: string,
    toState: string | undefined | null,
): boolean {
    if (!toState) return false;
    const from = (TRANSPORT_STATES as ReadonlyArray<string>).includes(fromState)
        ? fromState as TransportStateName
        : '' as TransportStateName;
    return canTransition(TRANSPORT_MACHINE, from, toState as TransportStateName);
}
