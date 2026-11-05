import type { MfaSetupCode } from '@eticketsgo/web-kit';

/**
 * The console's step-up dialog, reachable from a request this app makes itself.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Every call through the shared `api` client already opens the "Confirm it is you" dialog on
 * MFA_STEP_UP_REQUIRED and repeats the request (`setStepUpHandler` in web-kit). A page whose
 * endpoints the shared client does not list yet (see `lib/fee-policies.ts`) cannot reach that
 * handler, because web-kit keeps it private. `StepUpProvider` registers the SAME `ask` here, so
 * both kinds of request open one dialog and an operator never sees two ways of being asked.
 *
 * Nothing registered (a test, or a page outside the provider) means "no step-up available":
 * the request fails with the API's own sentence, as it would anywhere else.
 */

let ask: (() => Promise<boolean>) | null = null;
let setup: ((code: MfaSetupCode, message: string) => void) | null = null;

export function registerStepUp(
  askFn: (() => Promise<boolean>) | null,
  setupFn: ((code: MfaSetupCode, message: string) => void) | null,
): void {
  ask = askFn;
  setup = setupFn;
}

/** Open the step-up dialog. Resolves true once a fresh code was accepted. */
export function askForStepUp(): Promise<boolean> {
  return ask ? ask() : Promise.resolve(false);
}

/** Tell the operator they must set up (or cannot use) an authenticator first. */
export function reportMfaSetup(code: MfaSetupCode, message: string): void {
  setup?.(code, message);
}
