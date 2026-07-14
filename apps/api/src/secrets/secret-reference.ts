/**
 * Pure helpers for secret references + masking (ADR-024). No I/O — unit-testable.
 *
 * A reference is a slash-delimited path of lowercase segments, e.g.
 *   payments/stripe/live/secret-key
 * Each segment is [a-z0-9] with internal hyphens; 2–8 segments. This keeps
 * references safe to log (they are NOT secrets) and predictably mappable to a
 * backend key (env var name, Key Vault name, AWS secret id, GCP secret id).
 */

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when a reference is well-formed. */
export function isValidReference(reference: string): boolean {
  if (typeof reference !== 'string') return false;
  const trimmed = reference.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  const segments = trimmed.split('/');
  if (segments.length < 2 || segments.length > 8) return false;
  return segments.every((s) => SEGMENT.test(s));
}

/**
 * Env var name for the EnvironmentSecretManager, e.g.
 *   payments/stripe/live/secret-key → PAYMENTS_STRIPE_LIVE_SECRET_KEY
 */
export function deriveEnvVarName(reference: string): string {
  return reference.replace(/[/-]/g, '_').toUpperCase();
}

/** Azure Key Vault secret name (letters, digits, hyphens): slashes → hyphens. */
export function deriveKeyVaultName(reference: string): string {
  return reference.replace(/\//g, '-');
}

/**
 * Mask a secret value for safe display: keep at most the last 4 chars, replace the
 * rest with •. Short/empty values are fully masked. NEVER returns the raw value.
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '••••';
  if (value.length <= 6) return '••••';
  return `${'•'.repeat(4)}${value.slice(-4)}`;
}

/**
 * Redact any occurrence of known secret values from an arbitrary error message so
 * a leaked secret never reaches logs. Also strips common credential-looking tokens.
 */
export function redactSecrets(message: string, knownSecrets: readonly string[] = []): string {
  let out = message;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('«redacted»');
    }
  }
  // Defensive: redact long bearer/base64/hex-looking runs that may be credentials.
  out = out.replace(/\b[A-Za-z0-9_\-]{24,}\b/g, (m) => `«redacted:${m.length}»`);
  return out;
}
