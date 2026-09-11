/**
 * What makes a password acceptable on this platform.
 *
 * ── WHY THESE RULES, AND NOT "ONE UPPERCASE, ONE NUMBER, ONE SYMBOL" ───────────────
 * Composition rules are what most sites use, and they measure the wrong thing. They turn
 * `password` into `Password1!`, which satisfies all three and is still among the first
 * guesses in every cracking list, while refusing a long phrase of ordinary words that is far
 * harder to guess. NIST SP 800-63B says the same: require length, refuse passwords known to
 * be bad, and do not impose composition.
 *
 * So the rules are: long enough; not on the common list, after stripping the decoration
 * people add to make a common password "count"; not an obvious pattern; and not the person's
 * own name or address.
 *
 * ── WHY IT LIVES IN SHARED-TYPES ───────────────────────────────────────────────────
 * The API refuses a password; the web apps show a strength meter while somebody types. Two
 * implementations would disagree, and a meter that says "strong" about a password the server
 * then refuses is worse than no meter at all. One function, read by both.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────────────
 * It does not call a breached-password service. That would put an outbound dependency in the
 * sign-up path and send a hash prefix of every new password to a third party; the bundled
 * list covers the passwords that actually get tried first.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblemCode =
  'TOO_SHORT' | 'TOO_LONG' | 'CONTAINS_PERSONAL_INFO' | 'TOO_COMMON' | 'TOO_PREDICTABLE';

export interface PasswordProblem {
  code: PasswordProblemCode;
  /** English, for the API. The web apps translate by `code`. */
  message: string;
}

/** Who the password belongs to, when that is known. */
export interface PasswordContext {
  email?: string | null;
  name?: string | null;
}

export type PasswordStrengthScore = 0 | 1 | 2 | 3;

export interface PasswordStrength {
  score: PasswordStrengthScore;
  label: 'Not accepted' | 'Acceptable' | 'Good' | 'Strong';
}

const MESSAGES: Record<PasswordProblemCode, string> = {
  TOO_SHORT: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  TOO_LONG: `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`,
  CONTAINS_PERSONAL_INFO: 'Do not use your name or email address in your password.',
  TOO_COMMON: 'This is one of the most commonly used passwords. Choose something less guessable.',
  TOO_PREDICTABLE: 'Avoid plain numbers, repeated characters and sequences like 12345 or qwerty.',
};

/**
 * The bases of the passwords tried first, after decoration is stripped.
 *
 * Bases rather than full passwords, because nobody types `password` any more — they type
 * `Password123!`, `P@ssw0rd2026`, `!!password!!`. Stripping leading and trailing digits and
 * symbols and undoing letter-for-digit substitution turns all of those back into the word
 * they are, which is what an attacker's list is built from.
 *
 * Matched EXACTLY, never as a substring: `my-password-manager-rocks` contains a common word
 * and is a perfectly good password, and a check that refused it would train people to stop
 * reading the message.
 *
 * Includes the markets this platform sells in, and its own name — the first thing anybody
 * attacking an account here would try.
 */
const COMMON_BASES = new Set<string>([
  'password',
  'passwort',
  'pass',
  'passw',
  'pwd',
  'secret',
  'letmein',
  'welcome',
  'admin',
  'administrator',
  'root',
  'login',
  'guest',
  'user',
  'test',
  'testing',
  'default',
  'changeme',
  'qwerty',
  'qwertyuiop',
  'qwertyui',
  'asdf',
  'asdfgh',
  'asdfghjkl',
  'zxcvbn',
  'zxcvbnm',
  'abc',
  'abcd',
  'abcdef',
  'abcdefg',
  'abcdefgh',
  'iloveyou',
  'iloveu',
  'love',
  'lovely',
  'loveme',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'soccer',
  'baseball',
  'basketball',
  'cricket',
  'hockey',
  'shadow',
  'master',
  'superman',
  'batman',
  'spiderman',
  'trustno',
  'freedom',
  'whatever',
  'hello',
  'hellothere',
  'starwars',
  'pokemon',
  'michael',
  'jennifer',
  'jordan',
  'charlie',
  'daniel',
  'thomas',
  'killer',
  'ninja',
  'mustang',
  'access',
  'flower',
  'summer',
  'winter',
  'spring',
  'autumn',
  'computer',
  'internet',
  'samsung',
  'apple',
  'google',
  'facebook',
  'instagram',
  'whatsapp',
  'india',
  'bharat',
  'hindustan',
  'jaihind',
  'mumbai',
  'delhi',
  'chennai',
  'kolkata',
  'bangalore',
  'bengaluru',
  'hyderabad',
  'pune',
  'vijayawada',
  'telangana',
  'andhra',
  'sachin',
  'virat',
  'dhoni',
  'canada',
  'quebec',
  'toronto',
  'montreal',
  'america',
  'usa',
  'newyork',
  'eticketsgo',
  'etickets',
  'eticket',
  'ticket',
  'tickets',
  'movie',
  'movies',
  'cinema',
  'bookmyshow',
  'paytm',
  'phonepe',
]);

/** Letters people swap for digits and symbols, undone. */
const SUBSTITUTIONS: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
};

/** Keyboard rows and runs. Anything lying wholly inside one is a pattern, not a secret. */
const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '01234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'qazwsxedcrfvtgbyhnujmikolp',
];

function undoSubstitutions(value: string): string {
  return value
    .split('')
    .map((ch) => SUBSTITUTIONS[ch] ?? ch)
    .join('');
}

/** A password reduced to the word it is dressed up as. */
function baseOf(password: string): string {
  const lower = password.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const core = lower.replace(/^[\d\W_]+|[\d\W_]+$/g, '');
  return undoSubstitutions(core).replace(/[^a-z]/g, '');
}

/** `passwordpassword` is `password` said twice. */
function repeatedUnit(value: string): string {
  for (let size = 1; size <= value.length / 2; size += 1) {
    if (value.length % size !== 0) continue;
    const unit = value.slice(0, size);
    if (unit.repeat(value.length / size) === value) return unit;
  }
  return value;
}

function isCommon(password: string): boolean {
  const base = baseOf(password);
  if (!base) return false;
  return COMMON_BASES.has(base) || COMMON_BASES.has(repeatedUnit(base));
}

function isPredictable(password: string): boolean {
  const lower = password.toLowerCase();
  // A phone number, a date of birth, a PIN. All digits is the shape of something knowable.
  if (/^\d+$/.test(lower)) return true;
  if (/^(.)\1+$/.test(lower)) return true;
  // "abababababab" — long, and made of almost nothing.
  if (new Set(lower.split('')).size <= 3) return true;
  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (compact.length < 6) return false;
  for (const run of SEQUENCES) {
    const reversed = run.split('').reverse().join('');
    if ((run + run).includes(compact) || (reversed + reversed).includes(compact)) return true;
  }
  return false;
}

/**
 * Pieces of the person's own identity worth refusing.
 *
 * Four characters or more: a name like "Jo" or "Li" occurs inside plenty of unrelated
 * passwords, and refusing on it would be refusing at random.
 */
function personalTokens(context: PasswordContext): string[] {
  const tokens = new Set<string>();
  const add = (raw: string) => {
    const token = raw.replace(/[^a-z0-9]/g, '');
    if (token.length >= 4) tokens.add(token);
  };
  const local = (context.email ?? '').toLowerCase().split('@')[0] ?? '';
  add(local);
  for (const part of local.split(/[._+-]+/)) add(part);
  const name = (context.name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const part of name.split(/\s+/)) add(part);
  return Array.from(tokens);
}

function containsPersonalInfo(password: string, context: PasswordContext): boolean {
  const tokens = personalTokens(context);
  if (tokens.length === 0) return false;
  const lower = password.toLowerCase();
  // Both as typed and with substitutions undone, so "M3n0n" is still Menon.
  const forms = [
    lower.replace(/[^a-z0-9]/g, ''),
    undoSubstitutions(lower).replace(/[^a-z0-9]/g, ''),
  ];
  return tokens.some((token) => forms.some((form) => form.includes(token)));
}

/**
 * Everything wrong with a password, most fundamental first. Empty means acceptable.
 *
 * `context` is optional because some callers do not know who the password belongs to yet;
 * without it the personal-information rule simply does not apply, which is why the server
 * checks again wherever it does know.
 */
export function passwordProblems(
  password: string | null | undefined,
  context: PasswordContext = {},
): PasswordProblem[] {
  const value = password ?? '';
  const problem = (code: PasswordProblemCode): PasswordProblem => ({
    code,
    message: MESSAGES[code],
  });

  // Checked before anything else, so a megabyte of pasted text is refused without being
  // pattern-matched first.
  if (value.length > PASSWORD_MAX_LENGTH) return [problem('TOO_LONG')];

  const problems: PasswordProblem[] = [];
  if (value.length < PASSWORD_MIN_LENGTH) problems.push(problem('TOO_SHORT'));
  if (!value) return problems;
  if (containsPersonalInfo(value, context)) problems.push(problem('CONTAINS_PERSONAL_INFO'));
  if (isCommon(value)) problems.push(problem('TOO_COMMON'));
  if (isPredictable(value)) problems.push(problem('TOO_PREDICTABLE'));
  return problems;
}

/**
 * How strong an acceptable password is, for a meter.
 *
 * Never higher than zero for a password `passwordProblems` refuses — the meter and the server
 * must not disagree. Above that, length does most of the work and variety the rest.
 */
export function passwordStrength(
  password: string | null | undefined,
  context: PasswordContext = {},
): PasswordStrength {
  const value = password ?? '';
  if (!value || passwordProblems(value, context).length > 0) {
    return { score: 0, label: 'Not accepted' };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (value.length >= 16 || (value.length >= 12 && classes >= 3)) {
    return { score: 3, label: 'Strong' };
  }
  if (value.length >= 12 || classes >= 3) return { score: 2, label: 'Good' };
  return { score: 1, label: 'Acceptable' };
}
