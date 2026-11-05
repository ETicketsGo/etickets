import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { palette } from '@/theme';
import { Text, type TextTone } from './text';
import { haptics } from './haptics';

/**
 * A surface: white, 16px corners, a hairline edge, NO shadow (DESIGN-SYSTEM.md section 3:
 * two levels only, flat for everything on the page and one overlay shadow for what floats).
 * `tone="sunken"` is the inset panel a step below the paper (the website's "Buy as a guest").
 */
export function Card({
  children,
  className = '',
  padded = true,
  tone = 'surface',
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  tone?: 'surface' | 'sunken';
}) {
  return (
    <View
      className={[
        'overflow-hidden rounded-card',
        tone === 'surface' ? 'border border-border bg-background-surface' : 'bg-sunken',
        padded ? 'p-4' : '',
        className,
      ].join(' ')}
    >
      {children}
    </View>
  );
}

/** Capitalised section label: "BEFORE YOU PAY", "RESERVATION". */
export function Eyebrow({
  children,
  tone = 'muted',
  className = '',
}: {
  children: string;
  tone?: TextTone;
  className?: string;
}) {
  return (
    <Text variant="eyebrow" tone={tone} className={className}>
      {children}
    </Text>
  );
}

/** The short gold rule under an event title. Decorative gold: a fill, never text. */
export function GoldRule({ className = '' }: { className?: string }) {
  return <View className={`h-[2px] w-12 bg-gold ${className}`} />;
}

/**
 * A stage band: "the lights go down" (brand.css data-brand-tone="stage"). Not a dark mode, a
 * lighting change inside a light page, for a film header, the seat map, the ticket pass.
 */
export function StageBand({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <View className={`bg-stage ${className}`}>{children}</View>;
}

/** Section heading in the display face, with an optional "See all" link on the right. */
export function SectionHeader({
  title,
  actionLabel,
  onAction,
  className = '',
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}) {
  return (
    <View className={`flex-row items-end justify-between gap-4 ${className}`}>
      <Text variant="d2" accessibilityRole="header" className="flex-1">
        {title}
      </Text>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${actionLabel}, ${title}`}
          onPress={() => {
            haptics.tap();
            onAction();
          }}
          hitSlop={12}
          className="border-b border-gold pb-0.5 active:opacity-60"
        >
          <Text variant="ui" className="font-semibold">
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Full-width tappable row for settings and menus. */
export function ListRow({
  label,
  value,
  icon,
  onPress,
  destructive = false,
  showChevron = true,
  accessibilityHint,
  right,
}: {
  label: string;
  value?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  destructive?: boolean;
  showChevron?: boolean;
  accessibilityHint?: string;
  /**
   * A control at the trailing edge, usually a switch.
   *
   * The row itself stays non-interactive when one is present: two hit targets stacked on
   * top of each other means a tap near the switch does whichever the layout put on top,
   * and a screen reader announces one element that does two different things.
   */
  right?: ReactNode;
}) {
  // A row with its own control is not itself a button; see `right`.
  const interactive = Boolean(onPress) && !right;

  return (
    <Pressable
      accessibilityRole={interactive ? 'button' : 'text'}
      // One string per element, so "Currency" and "INR" are not two unrelated stops.
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={accessibilityHint}
      disabled={!interactive}
      onPress={() => {
        haptics.tap();
        onPress?.();
      }}
      style={{ minHeight: 52 }}
      className="flex-row items-center gap-3 px-4 py-3 active:bg-sunken"
    >
      {icon ? (
        <Ionicons name={icon} size={20} color={destructive ? palette.critical : palette.text} />
      ) : null}
      <Text variant="body" tone={destructive ? 'danger' : 'primary'} className="flex-1 font-medium">
        {label}
      </Text>
      {value ? (
        <Text variant="ui" tone="muted" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {interactive && showChevron ? (
        <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
      ) : null}
    </Pressable>
  );
}

/** Groups ListRows into one card with hairline separators between them. */
export function ListGroup({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <View
      className={`overflow-hidden rounded-card border border-border bg-background-surface ${className}`}
    >
      {children}
    </View>
  );
}

/** Hairline separator, inset to align with row text rather than the card edge. */
export function Separator({ inset = false }: { inset?: boolean }) {
  return <View className={`h-px bg-border ${inset ? 'ml-4' : ''}`} />;
}
