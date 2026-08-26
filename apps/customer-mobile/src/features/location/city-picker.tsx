import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/ui';
import { useTheme } from '@/theme';
import type { CityPreference } from './api';

/**
 * The city control and the sheet behind it.
 *
 * A chip in the header rather than a filter tucked into a search screen, for the same
 * reason as on the web: a customer who does not notice they are filtered to Delhi reports
 * the Mumbai show as missing. Whatever is applied has to be readable from the screen they
 * are already on.
 */
export function CityChip({
  preference,
  className = '',
}: {
  preference: CityPreference;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { colors } = useTheme();
  const { city, cities, setCity } = preference;

  // Grouped by country: the same city name exists in more than one, and a flat list makes
  // a multi-market platform look like a mistake.
  const byCountry = new Map<string, typeof cities>();
  for (const c of cities) {
    const list = byCountry.get(c.country) ?? [];
    list.push(c);
    byCountry.set(c.country, list);
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`City: ${city ?? 'all cities'}. Tap to change.`}
        onPress={() => setOpen(true)}
        className={`flex-row items-center gap-1 ${className}`}
      >
        <Ionicons name="location-outline" size={16} color={colors.textMuted} />
        <Text variant="footnote" tone="muted" numberOfLines={1}>
          {city ?? 'All cities'}
        </Text>
        <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 bg-canvas">
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text variant="title1" accessibilityRole="header">
              Choose your city
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setOpen(false)}
              hitSlop={12}
            >
              <Ionicons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView contentContainerClassName="pb-10">
            <CityRow
              label="All cities"
              icon="globe-outline"
              selected={city === null}
              onPress={() => {
                setCity(null);
                setOpen(false);
              }}
            />
            {cities.length === 0 ? (
              <Text variant="footnote" tone="muted" className="px-5 py-4">
                No cities have events on sale yet.
              </Text>
            ) : (
              [...byCountry.entries()].map(([country, list]) => (
                <View key={country}>
                  <Text variant="footnote" tone="muted" className="px-5 pb-1 pt-4 uppercase">
                    {country}
                  </Text>
                  {list.map((c) => (
                    <CityRow
                      key={`${country}-${c.city}`}
                      label={c.city}
                      // The count is the honest reason to pick one city over another.
                      trailing={String(c.eventCount)}
                      selected={city === c.city}
                      onPress={() => {
                        setCity(c.city);
                        setOpen(false);
                      }}
                    />
                  ))}
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

function CityRow({
  label,
  trailing,
  icon,
  selected,
  onPress,
}: {
  label: string;
  trailing?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      className="flex-row items-center gap-3 px-5 py-3.5"
    >
      {icon ? <Ionicons name={icon} size={18} color={colors.textMuted} /> : null}
      <Text className="flex-1">{label}</Text>
      {trailing ? (
        <Text variant="footnote" tone="muted">
          {trailing}
        </Text>
      ) : null}
      {selected ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
    </Pressable>
  );
}

/**
 * The "looks like you're in X" bar.
 *
 * Offers both answers. A prompt that only offers "yes" is a prompt people learn to
 * dismiss, and the guess behind this one — a device region or an IP — is wrong often
 * enough that accepting it has to be a choice.
 */
export function CitySuggestionBar({ preference }: { preference: CityPreference }) {
  const { suggestion, setCity, dismissSuggestion } = preference;
  const { colors } = useTheme();
  if (!suggestion?.city) return null;

  return (
    <View
      accessibilityRole="alert"
      className="flex-row items-center gap-3 border-b border-border bg-surface px-5 py-3"
    >
      <Ionicons name="location-outline" size={18} color={colors.textMuted} />
      <Text variant="footnote" className="flex-1">
        Looks like you&apos;re near {suggestion.city}.
      </Text>
      <Pressable accessibilityRole="button" onPress={() => setCity(suggestion.city)} hitSlop={8}>
        <Text variant="footnote" className="font-semibold" style={{ color: colors.primary }}>
          Show it
        </Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={dismissSuggestion} hitSlop={8}>
        <Text variant="footnote" tone="muted">
          Not now
        </Text>
      </Pressable>
    </View>
  );
}
