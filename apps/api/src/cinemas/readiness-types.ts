/**
 * The shape of a readiness verdict, shared by the rule modules.
 *
 * Extracted because the two of them legitimately need each other: `pilot-readiness.ts` calls
 * into `payment-readiness.ts` for the PAYMENTS section, and `payment-readiness.ts` needs to
 * return a `ReadinessCheck`. Importing the type back across that edge made a cycle — harmless
 * at runtime, since TypeScript erases type-only imports, but the repository gates on
 * `madge --circular` and is right to: a cycle that is currently type-only becomes a real one
 * the first time somebody imports a value across it.
 *
 * Types only. No rules live here, so there is still exactly one place that decides whether a
 * cinema can open.
 */
export type ReadinessLevel = 'READY' | 'WARNING' | 'BLOCKED';

export type ReadinessSection =
  | 'BUSINESS'
  | 'CINEMA'
  | 'SCREENS'
  | 'LAYOUTS'
  | 'STAFF'
  | 'PRICING'
  | 'FEES'
  | 'POLICIES'
  | 'PAYMENTS'
  | 'SHOWS'
  | 'CUSTOMER'
  | 'OPERATIONS';

export interface ReadinessCheck {
  section: ReadinessSection;
  /** Stable identifier. The UI maps this to a fix link; never match on the message. */
  code: string;
  level: ReadinessLevel;
  /** One sentence an operator can act on, naming what is actually missing. */
  message: string;
  /** Where to go to fix it, relative to the organizer app. Null when there is nowhere useful. */
  fixPath: string | null;
}
