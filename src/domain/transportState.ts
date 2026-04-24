// ═══════════════════════════════════════════════════════════════════════
// transportState.ts — Transport state labels and transition policy
// ═══════════════════════════════════════════════════════════════════════

export type TransportStateName =
    | 'idle' | 'loading' | 'ready' | 'rendering'
    | 'playing' | 'playing_loop' | 'playing_segment'
    | 'paused' | 'paused_segment' | 'stopped' | 'error'
    | '';

export const TRANSPORT_STATE_LABELS: Record<TransportStateName, string> = {
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
};

const ALLOWED_TRANSITIONS: Record<TransportStateName, Set<string>> = {
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
};

export function canTransitionTransportState(
    fromState: string,
    toState: string | undefined | null,
): boolean {
    if (!toState) return false;
    if (fromState === toState) return true;
    const allowed = ALLOWED_TRANSITIONS[fromState as TransportStateName]
        ?? ALLOWED_TRANSITIONS[''];
    return allowed.has(toState);
}
