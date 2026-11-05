import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Field, Text } from '@/ui';
import { useDebounced } from '@/hooks/use-debounced';
import { useTheme } from '@/theme';
import { useSellableCities, type CityPreference } from './api';

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
  const { city } = preference;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`City: ${city ?? 'all cities'}. Tap to change.`}
        onPress={() => setOpen(true)}
        // The storefront's city button: an outlined pill, always visible in the top bar.
        style={{ minHeight: 44 }}
        className={`flex-row items-center gap-1.5 rounded-full border border-border-strong bg-paper px-3.5 active:bg-sunken ${className}`}
      >
        <Ionicons name="location-outline" size={17} color={colors.text} />
        <Text variant="ui" className="font-semibold" numberOfLines={1} style={{ maxWidth: 150 }}>
          {city ?? 'All cities'}
        </Text>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        // Full screen, and padded for the status bar below: with target SDK 35+ Android
        // draws every window edge to edge, so a modal's title sat under the clock.
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        {open ? <CitySheet preference={preference} onClose={() => setOpen(false)} /> : null}
      </Modal>
    </>
  );
}

/**
 * The storefront's city sheet: search, the cities near the customer, then every city with
 * something on sale grouped by country. Grouped because the same name exists in more than
 * one country, and a flat list makes a multi-market platform look like a mistake.
 */
function CitySheet({ preference, onClose }: { preference: CityPreference; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { city, topCities, setCity } = preference;
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 250);
  const all = useSellableCities(debounced, true);

  const choose = (next: string | null) => {
    setCity(next);
    onClose();
  };

  const searching = debounced.trim().length > 0;
  const nearby = searching ? [] : topCities;
  const nearbyKeys = new Set(nearby.map((c) => `${c.country}|${c.city}`));
  const rest = (all.data ?? []).filter((c) => !nearbyKeys.has(`${c.country}|${c.city}`));
  const byCountry = new Map<string, typeof rest>();
  for (const c of rest) {
    const list = byCountry.get(c.country) ?? [];
    list.push(c);
    byCountry.set(c.country, list);
  }

  return (
    <View className="flex-1 bg-paper" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-4 pb-2 pt-3">
        <Text variant="d2" accessibilityRole="header">
          Choose your city
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          hitSlop={12}
          style={{ minHeight: 44, minWidth: 44 }}
          className="items-center justify-center rounded-full border border-border-strong"
        >
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
      </View>

      <View className="px-4 pb-3">
        <Field
          label="Search cities"
          placeholder="City name"
          icon="search"
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {!searching ? (
          <CityRow
            label="All cities"
            icon="globe-outline"
            selected={city === null}
            onPress={() => choose(null)}
          />
        ) : null}

        {nearby.length > 0 ? (
          <View>
            <Text variant="eyebrow" tone="muted" className="px-4 pb-1 pt-5">
              Near you
            </Text>
            {nearby.map((c) => (
              <CityRow
                key={`near-${c.country}-${c.city}`}
                label={c.city}
                // The count is the honest reason to pick one city over another.
                trailing={eventCount(c.eventCount)}
                selected={city === c.city}
                onPress={() => choose(c.city)}
              />
            ))}
          </View>
        ) : null}

        {[...byCountry.entries()].map(([country, list]) => (
          <View key={country}>
            <Text variant="eyebrow" tone="muted" className="px-4 pb-1 pt-5">
              {country}
            </Text>
            {list.map((c) => (
              <CityRow
                key={`${country}-${c.city}`}
                label={c.city}
                trailing={eventCount(c.eventCount)}
                selected={city === c.city}
                onPress={() => choose(c.city)}
              />
            ))}
          </View>
        ))}

        {all.isSuccess && rest.length === 0 && nearby.length === 0 ? (
          <Text variant="ui" tone="muted" className="px-4 py-6">
            {searching
              ? `No city with events on sale matches "${debounced.trim()}".`
              : 'No cities have events on sale yet.'}
          </Text>
        ) : null}
        {all.isError ? (
          <Text variant="ui" tone="muted" className="px-4 py-6">
            We could not load the list of cities. Check your connection.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function eventCount(n: number): string {
  return `${n} ${n === 1 ? 'event' : 'events'}`;
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
      accessibilityLabel={trailing ? `${label}, ${trailing}` : label}
      onPress={onPress}
      style={{ minHeight: 52 }}
      className="flex-row items-center gap-3 border-b border-border px-4 active:bg-sunken"
    >
      {icon ? <Ionicons name={icon} size={19} color={colors.textMuted} /> : null}
      <Text variant="body" className={`flex-1 ${selected ? 'font-semibold' : ''}`}>
        {label}
      </Text>
      {trailing ? (
        <Text variant="meta" tone="muted">
          {trailing}
        </Text>
      ) : null}
      {selected ? <Ionicons name="checkmark" size={19} color={colors.text} /> : null}
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
      className="flex-row items-center gap-3 border-b border-border bg-background-surface px-5 py-3"
    >
      <Ionicons name="location-outline" size={18} color={colors.textMuted} />
      <Text variant="footnote" className="flex-1">
        Looks like you are near {suggestion.city}.
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
