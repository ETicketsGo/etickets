import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';

/**
 * The app's answer to the API's human check: a Google Play Integrity token.
 *
 * The storefront answers with a Cloudflare Turnstile widget. A native app has no page to draw
 * one on, so a challenged request (428 HUMAN_CHECK_REQUIRED, or 403 HUMAN_CHECK_FAILED) whose
 * details name a Play `cloudProjectNumber` is answered with Play's verdict about this install
 * instead. The server decodes it with Google and checks it (apps/api/src/human-check/
 * play-integrity-verifier.ts); nothing here decides anything. When the environment has no Play
 * Integrity configured, or this is not Android, there is no answer and the original refusal
 * stands, exactly as before.
 *
 * ── WHAT BINDS THE TOKEN TO THIS REQUEST ───────────────────────────────────────────
 * A fresh random nonce per attempt, and Play's `requestHash` = SHA-256 of
 * `eticketsgo:<action>:<nonce>`, the same string the server rebuilds. A token made for the
 * support form therefore cannot open the phone-code route, and the server accepts each nonce
 * once.
 */

export const PLAY_INTEGRITY_HEADERS = {
  token: 'x-play-integrity-token',
  nonce: 'x-play-integrity-nonce',
  packageName: 'x-play-integrity-package',
} as const;

/** The two calls this needs from `@expo/app-integrity` (its Android half). */
export interface IntegrityModule {
  prepareIntegrityTokenProviderAsync(cloudProjectNumber: string): Promise<void>;
  requestIntegrityCheckAsync(requestHash: string): Promise<string>;
}

let override: IntegrityModule | null | undefined;
let loaded: IntegrityModule | null | undefined;

/** Lazily required, like the Razorpay SDK: the web build and Jest never load native code. */
function integrityModule(): IntegrityModule | null {
  if (override !== undefined) return override;
  if (loaded !== undefined) return loaded;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('@expo/app-integrity') as IntegrityModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

/** Tests only: stand in for Play, or pass `null` for "no module". `undefined` restores it. */
export function setIntegrityModuleForTests(mod: IntegrityModule | null | undefined): void {
  override = mod;
  prepared.clear();
}

/**
 * Preparing the provider costs a round trip to Play, once per project per launch. A failed
 * preparation is forgotten, so the next challenge tries again instead of failing forever.
 */
const prepared = new Map<string, Promise<void>>();

function prepare(mod: IntegrityModule, cloudProjectNumber: string): Promise<void> {
  let ready = prepared.get(cloudProjectNumber);
  if (!ready) {
    ready = mod.prepareIntegrityTokenProviderAsync(cloudProjectNumber).catch((err: unknown) => {
      prepared.delete(cloudProjectNumber);
      throw err;
    });
    prepared.set(cloudProjectNumber, ready);
  }
  return ready;
}

/** The same string the server hashes. Exported for the test that pins the two together. */
export function requestHashInput(action: string, nonce: string): string {
  return `eticketsgo:${action}:${nonce}`;
}

/** What the API's challenge says, when it says Play Integrity can answer it. */
export interface HumanCheckChallenge {
  action: string;
  cloudProjectNumber: string;
}

/** Reads a refusal body; null unless it is a human-check challenge Play can answer. */
export function playIntegrityChallenge(body: unknown): HumanCheckChallenge | null {
  if (typeof body !== 'object' || body === null) return null;
  const { code, details } = body as { code?: unknown; details?: unknown };
  if (code !== 'HUMAN_CHECK_REQUIRED' && code !== 'HUMAN_CHECK_FAILED') return null;
  if (typeof details !== 'object' || details === null) return null;
  const { action, playIntegrity } = details as { action?: unknown; playIntegrity?: unknown };
  const project =
    typeof playIntegrity === 'object' && playIntegrity !== null
      ? (playIntegrity as { cloudProjectNumber?: unknown }).cloudProjectNumber
      : undefined;
  if (typeof action !== 'string' || typeof project !== 'string' || !project) return null;
  return { action, cloudProjectNumber: project };
}

/**
 * The headers that answer `challenge`, or null when this install cannot answer it (not
 * Android, no Play services, Play refused). Never throws: a check the app cannot pass is
 * the server's refusal to explain, not a crash.
 */
export async function playIntegrityHeaders(
  challenge: HumanCheckChallenge,
): Promise<Record<string, string> | null> {
  if (Platform.OS !== 'android') return null;
  const packageName = Constants.expoConfig?.android?.package;
  const mod = integrityModule();
  if (!packageName || !mod) return null;
  try {
    const nonce = Crypto.randomUUID().replace(/-/g, '');
    const requestHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      requestHashInput(challenge.action, nonce),
      { encoding: Crypto.CryptoEncoding.HEX },
    );
    await prepare(mod, challenge.cloudProjectNumber);
    const token = await mod.requestIntegrityCheckAsync(requestHash);
    if (!token) return null;
    return {
      [PLAY_INTEGRITY_HEADERS.token]: token,
      [PLAY_INTEGRITY_HEADERS.nonce]: nonce,
      [PLAY_INTEGRITY_HEADERS.packageName]: packageName,
    };
  } catch {
    return null;
  }
}
