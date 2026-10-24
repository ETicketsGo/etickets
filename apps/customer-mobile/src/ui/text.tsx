import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

/**
 * The app's only text primitive, set to the storefront's type system
 * (docs/design/DESIGN-SYSTEM.md section 2): Bricolage Grotesque for titles and nothing
 * else, Inter for everything a person reads, every label and every number.
 *
 * Screens pick a `variant`; they do not compose size, weight and colour by hand.
 */
export type TextVariant =
  // The storefront scale
  | 'hero'
  | 'd1'
  | 'd2'
  | 'd3'
  | 'card'
  | 'lead'
  | 'body'
  | 'ui'
  | 'uiStrong'
  | 'meta'
  | 'eyebrow'
  | 'figure'
  | 'figureSm'
  // Older names, kept so a screen not yet rebuilt still lands on the new scale
  | 'largeTitle'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'callout'
  | 'subhead'
  | 'footnote'
  | 'caption';

export type TextTone =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'accent'
  | 'gold'
  | 'danger'
  | 'success'
  | 'onAccent'
  | 'onStage'
  | 'onStage2'
  | 'onStage3'
  | 'goldOnStage';

type Face = 'display-heavy' | 'display' | 'display-semibold' | 'text' | 'text-semibold';

const SCALE: Record<TextVariant, { size: string; face: Face; caps?: boolean; tabular?: boolean }> =
  {
    hero: { size: 'text-hero', face: 'display-heavy' },
    d1: { size: 'text-d1', face: 'display' },
    d2: { size: 'text-d2', face: 'display' },
    d3: { size: 'text-d3', face: 'display' },
    // 700, not 600: Bricolage's static 600 renders close to regular on Android, and the
    // storefront's card titles read clearly bold.
    card: { size: 'text-card', face: 'display' },
    lead: { size: 'text-lead', face: 'text' },
    body: { size: 'text-body', face: 'text' },
    ui: { size: 'text-ui', face: 'text' },
    uiStrong: { size: 'text-ui', face: 'text-semibold' },
    meta: { size: 'text-meta', face: 'text' },
    eyebrow: { size: 'text-eyebrow', face: 'text-semibold', caps: true },
    figure: { size: 'text-figure', face: 'text-semibold', tabular: true },
    figureSm: { size: 'text-figure-sm', face: 'text-semibold', tabular: true },
    largeTitle: { size: 'text-d1', face: 'display' },
    title1: { size: 'text-d2', face: 'display' },
    title2: { size: 'text-d3', face: 'display' },
    title3: { size: 'text-d3', face: 'display' },
    headline: { size: 'text-card', face: 'display' },
    callout: { size: 'text-body', face: 'text' },
    subhead: { size: 'text-ui', face: 'text' },
    footnote: { size: 'text-meta', face: 'text' },
    caption: { size: 'text-meta', face: 'text' },
  };

const TONE: Record<TextTone, string> = {
  primary: 'text-ink',
  secondary: 'text-ink-2',
  muted: 'text-ink-3',
  // The action colour on paper is ink, not a hue.
  accent: 'text-ink',
  // Gold WORDS on paper: the text strength. Decorative gold is never text (2.5:1).
  gold: 'text-gold-text',
  danger: 'text-critical',
  success: 'text-positive',
  onAccent: 'text-paper',
  onStage: 'text-stage-ink',
  onStage2: 'text-stage-ink-2',
  onStage3: 'text-stage-ink-3',
  goldOnStage: 'text-gold-on-ink',
};

/**
 * Android does not synthesise a bold from a custom font: `font-bold` on an "Inter" family
 * renders the regular face. A weight class in `className` is therefore turned into the
 * matching face, so `<Text className="font-semibold">` means what it says on a phone.
 */
const WEIGHT = /\bfont-(medium|semibold|bold|extrabold)\b/;

function faceFor(face: Face, className: string): string {
  const weight = className.match(WEIGHT)?.[1];
  if (!weight) return `font-${face}`;
  if (face.startsWith('display')) {
    if (weight === 'extrabold') return 'font-display-heavy';
    return weight === 'bold' ? 'font-display' : `font-${face}`;
  }
  if (weight === 'medium') return 'font-text-medium';
  return weight === 'semibold' ? 'font-text-semibold' : 'font-text-bold';
}

/**
 * Ceiling on OS text scaling. Accessibility sizes go past 300%, which turns a two-line
 * card title into a full screen and pushes the price out of view. Reading text gets more
 * headroom than titles because it wraps gracefully; nothing is capped below 130%.
 */
function maxScale(variant: TextVariant): number {
  const { face, size } = SCALE[variant];
  if (size === 'text-hero' || size === 'text-d1') return 1.3;
  if (face.startsWith('display')) return 1.5;
  return 2;
}

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  className?: string;
  /** Tabular figures, for money, counts and times in a column. */
  tabular?: boolean;
}

export function Text({
  variant = 'body',
  tone = 'primary',
  className = '',
  tabular,
  maxFontSizeMultiplier,
  style,
  children,
  ...rest
}: TextProps) {
  const spec = SCALE[variant];
  const cleaned = className.replace(WEIGHT, '').trim();
  const numeric = tabular ?? spec.tabular;
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? maxScale(variant)}
      className={`${faceFor(spec.face, className)} ${spec.size} ${TONE[tone]} ${cleaned}`}
      style={numeric ? [{ fontVariant: ['tabular-nums'] }, style] : style}
      {...rest}
    >
      {spec.caps && typeof children === 'string' ? children.toUpperCase() : children}
    </RNText>
  );
}
