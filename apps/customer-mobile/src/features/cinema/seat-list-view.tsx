import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Chip, ListRow, Text } from '@/ui';
import { formatMoney } from '@/services/locale';
import { SEAT_STATE_LABEL } from './seat-colors';
import { isSelectable, seatName, seatVisualState, type Seat, type SeatMap } from './schema';

/**
 * The seat map as a list, row by row.
 *
 * This is the accessible equivalent of the graphical map, not a lesser fallback. A
 * pinch-to-zoom grid of 80 unlabelled squares is close to unusable with a screen reader
 * — the spatial arrangement that makes it work for a sighted user carries no meaning
 * when read linearly, and the tap targets are below the reliable minimum when zoomed out.
 *
 * It is offered to everyone via a visible toggle rather than being hidden behind a
 * screen-reader check: it is genuinely faster for "I want any two seats together in the
 * back row", and it works with a keyboard and with switch control.
 */
export function SeatListView({
  map,
  selectedSeatIds,
  onToggleSeat,
  currency,
}: {
  map: SeatMap;
  selectedSeatIds: string[];
  onToggleSeat: (seat: Seat, rowLabel: string) => void;
  currency: string;
}) {
  const selected = useMemo(() => new Set(selectedSeatIds), [selectedSeatIds]);
  const categoryById = useMemo(
    () => new Map(map.categories.map((c) => [c.id, c])),
    [map.categories],
  );
  const [onlyAvailable, setOnlyAvailable] = useState(true);

  const rows = useMemo(
    () =>
      map.sections.flatMap((section) =>
        section.rows.map((row) => {
          const seats = onlyAvailable
            ? row.seats.filter((s) => isSelectable(s, categoryById.get(s.categoryId)))
            : row.seats;
          return { sectionName: section.name, label: row.label, seats };
        }),
      ),
    [map.sections, onlyAvailable, categoryById],
  );

  const visibleRows = rows.filter((r) => r.seats.length > 0);

  return (
    <View className="gap-3">
      <View className="flex-row gap-2">
        <Chip
          label="Available only"
          selected={onlyAvailable}
          onPress={() => setOnlyAvailable(true)}
        />
        <Chip label="All seats" selected={!onlyAvailable} onPress={() => setOnlyAvailable(false)} />
      </View>

      {visibleRows.length === 0 ? (
        <Text variant="subhead" tone="muted">
          No seats are available for this screening.
        </Text>
      ) : (
        <ScrollView className="max-h-[420px]" nestedScrollEnabled>
          {visibleRows.map((row) => (
            <View key={`${row.sectionName}-${row.label}`} className="mb-3 gap-1">
              <Text variant="footnote" tone="muted" accessibilityRole="header">
                Row {row.label}
                {map.sections.length > 1 ? ` · ${row.sectionName}` : ''} · {row.seats.length}{' '}
                {row.seats.length === 1 ? 'seat' : 'seats'}
              </Text>
              <View className="overflow-hidden rounded-md border border-border">
                {row.seats.map((seat) => {
                  const category = categoryById.get(seat.categoryId);
                  const isSelected = selected.has(seat.id);
                  const state = seatVisualState(seat, category, isSelected);
                  const selectable = isSelectable(seat, category);
                  const name = seatName(row.label, seat);

                  return (
                    <ListRow
                      key={seat.id}
                      label={`Seat ${name}`}
                      value={
                        selectable
                          ? `${category?.name ?? ''} · ${formatMoney(category?.priceMinor ?? 0, currency)}${
                              isSelected ? ' · selected' : ''
                            }`
                          : SEAT_STATE_LABEL[state]
                      }
                      showChevron={false}
                      // Only selectable seats get a press handler; the rest are read-only
                      // rows, which is what makes them announce as text rather than as
                      // buttons that do nothing.
                      onPress={selectable ? () => onToggleSeat(seat, row.label) : undefined}
                      accessibilityHint={
                        selectable
                          ? isSelected
                            ? 'Double tap to deselect this seat'
                            : 'Double tap to select this seat'
                          : undefined
                      }
                    />
                  );
                })}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
