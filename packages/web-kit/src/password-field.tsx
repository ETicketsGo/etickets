'use client';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblems,
  passwordStrength,
  type PasswordContext,
  type PasswordProblemCode,
  type PasswordStrengthScore,
} from '@eticketsgo/shared-types';
import { Input } from './components';

/**
 * Every word the field shows, so the storefront can supply French and the consoles English
 * without two copies of the component.
 */
export interface PasswordFieldCopy {
  label: string;
  hint: string;
  strength: (level: string) => string;
  levels: Record<PasswordStrengthScore, string>;
  problems: Record<PasswordProblemCode, string>;
}

export const DEFAULT_PASSWORD_FIELD_COPY: PasswordFieldCopy = {
  label: 'Password',
  hint: `At least ${PASSWORD_MIN_LENGTH} characters. Longer is stronger — a few unrelated words works well.`,
  strength: (level) => `Strength: ${level}`,
  levels: { 0: 'not accepted yet', 1: 'acceptable', 2: 'good', 3: 'strong' },
  problems: {
    TOO_SHORT: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
    TOO_LONG: `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`,
    CONTAINS_PERSONAL_INFO: 'Do not use your name or email address in your password.',
    TOO_COMMON: 'This is one of the most commonly used passwords. Choose something less guessable.',
    TOO_PREDICTABLE: 'Avoid plain numbers, repeated characters and sequences like 12345 or qwerty.',
  },
};

/** Whether the server will accept this password — the same rule, so a form can gate on it. */
export function passwordAcceptable(value: string, context?: PasswordContext): boolean {
  return passwordProblems(value, context).length === 0;
}

/**
 * A password input that says, while it is typed, whether it will be accepted and why not.
 *
 * ── WHY THE METER IS NEVER KINDER THAN THE SERVER ──────────────────────────────────
 * It reads the same policy function the API enforces. A meter written separately would
 * eventually call something "strong" that the server then refuses, and the person would learn
 * to ignore it.
 *
 * Nothing is shown until something is typed: an empty field is not a mistake, and greeting
 * somebody with a red warning before they have started is a kind of accusation.
 */
export function PasswordField({
  id,
  value,
  onChange,
  context,
  copy = DEFAULT_PASSWORD_FIELD_COPY,
  serverError,
  autoComplete = 'new-password',
  required,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** The person's name and email, when known, so their own details are refused as they type. */
  context?: PasswordContext;
  copy?: PasswordFieldCopy;
  /** A refusal the server returned, shown in place of the local reading. */
  serverError?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  const typed = value.length > 0;
  const problems = typed ? passwordProblems(value, context) : [];
  const { score } = passwordStrength(value, context);
  const message = serverError ?? (problems[0] ? copy.problems[problems[0].code] : undefined);
  const statusId = `${id}-strength`;

  const fill =
    score === 0 ? 'bg-status-error' : score === 1 ? 'bg-status-warning' : 'bg-status-success';
  // One bar even for a refused password, so "not accepted" reads as a level rather than blank.
  const filled = Math.max(score, 1);

  return (
    <div>
      <Input
        id={id}
        label={copy.label}
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        hint={copy.hint}
        maxLength={PASSWORD_MAX_LENGTH}
        required={required}
        aria-invalid={!!message}
        // Only pointed at the status once it exists; a reference to a missing id is itself an
        // accessibility fault.
        {...(typed ? { 'aria-describedby': statusId } : {})}
      />
      {typed && (
        <div id={statusId} className="mt-2" aria-live="polite">
          <div className="flex gap-1" aria-hidden="true">
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={`h-1.5 flex-1 rounded-full ${n <= filled ? fill : 'bg-border'}`}
              />
            ))}
          </div>
          <p className="mt-1 text-caption text-text-secondary" data-testid="password-strength">
            {copy.strength(copy.levels[score])}
          </p>
          {message && (
            <p className="mt-1 text-caption text-status-error" data-testid="password-problem">
              {message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
