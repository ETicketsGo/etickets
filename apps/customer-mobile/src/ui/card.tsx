import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme';
import { Text } from './text';
import { haptics } from './haptics';

/**
 * A raised surface. Elevation is a hairline border rather than a shadow: shadows are
 * expensive to rasterise in long scrolling lists, render differently on the two
 * platforms, and all but vanish on the dark canvas. The border reads the same
 * everywhere and costs nothing.
 */
export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <View
      className={[
        'overflow-hidden rounded-md border border-border bg-background-surface',
        padded ? 'p-4' : '',
        className,
      ].join(' ')}
    >
      {children}
    </View>
  );
}

/** Section heading with an optional trailing action ("Near you" / "See all"). */
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
    <View className={`flex-row items-center justify-between ${className}`}>
      <Text variant="title3" accessibilityRole="header">
        {title}
      </Text>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${actionLabel}, ${title}`}
          onPress={() => {
            haptics.tap();
            onAction();
          }}
          hitSlop={12}
          className="active:opacity-60"
        >
          <Text variant="subhead" tone="accent" className="font-semibold">
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
}: {
  label: string;
  value?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  destructive?: boolean;
  showChevron?: boolean;
  accessibilityHint?: string;
}) {
  const { colors } = useTheme();
  const interactive = Boolean(onPress);

  return (
    <Pressable
      accessibilityRole={interactive ? 'button' : 'text'}
      // Screen readers read one string per element, so the label and its value are
      // joined here — otherwise "Currency" and "INR" arrive as two unrelated stops.
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={accessibilityHint}
      disabled={!interactive}
      onPress={() => {
        haptics.tap();
        onPress?.();
      }}
      style={{ minHeight: 48 }}
      className="flex-row items-center gap-3 px-4 py-3 active:bg-background-subtle"
    >
      {icon ? (
        <Ionicons name={icon} size={20} color={destructive ? '#DC2626' : colors.textMuted} />
      ) : null}
      <Text variant="body" tone={destructive ? 'danger' : 'primary'} className="flex-1">
        {label}
      </Text>
      {value ? (
        <Text variant="subhead" tone="muted" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {interactive && showChevron ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      ) : null}
    </Pressable>
  );
}

/** Groups ListRows into an inset card with hairline separators between them. */
export function ListGroup({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <View
      className={`overflow-hidden rounded-md border border-border bg-background-surface ${className}`}
    >
      {children}
    </View>
  );
}

/** Hairline separator, inset to align with row text rather than the card edge. */
export function Separator({ inset = false }: { inset?: boolean }) {
  return <View className={`h-px bg-border ${inset ? 'ml-4' : ''}`} />;
}
