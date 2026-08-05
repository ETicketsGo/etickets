import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

/**
 * The app's only text primitive. Screens use `variant` rather than composing size,
 * weight and colour by hand, so type stays consistent and a scale change is one edit.
 */
export type TextVariant =
  | 'largeTitle'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'callout'
  | 'subhead'
  | 'footnote'
  | 'caption';

export type TextTone =
  'primary' | 'secondary' | 'muted' | 'accent' | 'danger' | 'success' | 'onAccent';

const VARIANT: Record<TextVariant, string> = {
  largeTitle: 'text-large-title font-bold',
  title1: 'text-title1 font-bold',
  title2: 'text-title2 font-semibold',
  title3: 'text-title3 font-semibold',
  headline: 'text-headline font-semibold',
  body: 'text-body',
  callout: 'text-callout',
  subhead: 'text-subhead',
  footnote: 'text-footnote',
  caption: 'text-caption',
};

const TONE: Record<TextTone, string> = {
  primary: 'text-text-primary',
  secondary: 'text-text-secondary',
  muted: 'text-text-muted',
  accent: 'text-action-primary',
  danger: 'text-status-error',
  success: 'text-status-success',
  onAccent: 'text-action-primary-foreground',
};

/**
 * Ceiling on OS text scaling. Accessibility text sizes go past 300%, which turns a
 * two-line card title into a full screen and pushes the price out of view — worse for
 * the user than slightly-smaller text. Body copy gets more headroom than headings
 * because it wraps gracefully; nothing is capped below 130%, so the common
 * "large text" settings are honoured in full.
 */
const MAX_SCALE: Record<TextVariant, number> = {
  largeTitle: 1.4,
  title1: 1.4,
  title2: 1.5,
  title3: 1.5,
  headline: 1.6,
  body: 2,
  callout: 2,
  subhead: 2,
  footnote: 2,
  caption: 1.8,
};

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  className?: string;
}

export function Text({
  variant = 'body',
  tone = 'primary',
  className = '',
  maxFontSizeMultiplier,
  ...rest
}: TextProps) {
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? MAX_SCALE[variant]}
      className={`font-sans ${VARIANT[variant]} ${TONE[tone]} ${className}`}
      {...rest}
    />
  );
}
