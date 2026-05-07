// ═══════════════════════════════════════════════════════════════════════
// shared/stateMachine.ts — Lightweight state-machine helpers
//
// Eliminates the pattern where state names are declared three times:
//   1. as a TypeScript union type
//   2. as a human-readable labels Record
//   3. as an allowed-transitions Record<state, Set<state>>
//
// Usage:
//   export const TRANSPORT_MACHINE = defineStateMachine({
//       states: TRANSPORT_STATES,
//       labels: { idle: 'Idle', ... },
//       transitions: { idle: new Set(['loading']), ... },
//   });
//   type TransportStateName = StateName<typeof TRANSPORT_MACHINE>;
// ═══════════════════════════════════════════════════════════════════════

export interface StateMachineDefinition<S extends string> {
    readonly states:      ReadonlyArray<S>;
    readonly labels:      Readonly<Record<S, string>>;
    readonly transitions: Readonly<Record<S, ReadonlySet<S>>>;
}

/** Infer the state-name union type from a StateMachineDefinition. */
export type StateName<M> =
    M extends StateMachineDefinition<infer S> ? S : never;

/**
 * Type-safe factory — ensures `states`, `labels` and `transitions` all
 * reference exactly the same set of state names.
 */
export function defineStateMachine<S extends string>(
    def: StateMachineDefinition<S>,
): StateMachineDefinition<S> {
    return def;
}

/** Returns true when the transition from → to is allowed by the transitions table. */
export function canTransition<S extends string>(
    def: StateMachineDefinition<S>,
    from: S,
    to: S,
): boolean {
    return def.transitions[from]?.has(to) === true;
}
