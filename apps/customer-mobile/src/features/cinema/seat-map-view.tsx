import { useMemo } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useTheme } from '@/theme';
import { Text, haptics } from '@/ui';
import { seatStyle, SEAT_STATE_LABEL } from './seat-colors';
import { isSelectable, seatName, seatVisualState, type SeatMap, type Seat } from './schema';

/**
 * The graphical seat map: pinch to zoom, drag to pan, tap to select.
 *
 * A note on what this is NOT doing. It draws plain Views rather than SVG or Canvas.
 * The seeded auditorium is 80 seats; a large multiplex screen is ~300. At that size
 * Views are comfortably fast and they come with focus, hit targets and screen-reader
 * semantics for free — all of which have to be rebuilt by hand on a canvas. If a venue
 * with thousands of seats appears, this is the component to revisit, and the seat-list
 * view beside it already covers the accessibility case that a canvas would break.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 3;
/** Below this on-screen size a seat is not a reliable tap target, so we zoom instead. */
const MIN_SEAT_PX = 18;
const SEAT_GAP = 4;

export function SeatMapView({
  map,
  selectedSeatIds,
  onToggleSeat,
  onSeatBlocked,
}: {
  map: SeatMap;
  selectedSeatIds: string[];
  onToggleSeat: (seat: Seat, rowLabel: string) => void;
  /** Called when the user taps a seat they cannot have, so the screen can explain why. */
  onSeatBlocked: (seat: Seat, rowLabel: string) => void;
}) {
  const { scheme, colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const selected = useMemo(() => new Set(selectedSeatIds), [selectedSeatIds]);
  const categoryById = useMemo(
    () => new Map(map.categories.map((c) => [c.id, c])),
    [map.categories],
  );

  /**
   * Seat size is derived from the WIDEST row and the current window, so the whole
   * auditorium fits across the screen at rest and rotation just recomputes it. Rows are
   * laid out by colIndex rather than array position, so a hole in the sequence (an
   * aisle) renders as a gap instead of closing up.
   */
  const maxCol = useMemo(() => {
    let max = 1;
    for (const section of map.sections)
      for (const row of section.rows)
        for (const seat of row.seats) if (seat.colIndex > max) max = seat.colIndex;
    return max;
  }, [map.sections]);

  // 44 = row-label gutter, 32 = horizontal padding.
  const available = windowWidth - 44 - 32;
  const seatSize = Math.max(MIN_SEAT_PX, Math.min(30, available / maxCol - SEAT_GAP));
  const rowWidth = maxCol * (seatSize + SEAT_GAP);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      // Snapping back to origin at 1x stops the map drifting off-screen after a
      // pinch-out-then-in, which otherwise leaves the user looking at blank canvas.
      if (scale.value <= MIN_SCALE) {
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedX.value = 0;
        savedY.value = 0;
      }
    });

  const pan = Gesture.Pan()
    // Two fingers so a one-finger drag still scrolls the page the map sits on.
    .minPointers(2)
    .onUpdate((e) => {
      translateX.value = savedX.value + e.translationX;
      translateY.value = savedY.value + e.translationY;
    })
    .onEnd(() => {
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = scale.value > 1.2 ? 1 : 2;
      scale.value = withTiming(next);
      savedScale.value = next;
      if (next === 1) {
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedX.value = 0;
        savedY.value = 0;
      }
      runOnJS(haptics.tap)();
    });

  const composed = Gesture.Simultaneous(pinch, pan, doubleTap);

  const mapStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <View
        className="overflow-hidden py-4"
        accessibilityLabel="Seat map. Pinch to zoom, drag with two fingers to move."
      >
        <Animated.View style={mapStyle} className="items-center gap-5">
          {/* Screen indicator — the map is meaningless without knowing which way the
              audience faces. */}
          <View className="items-center gap-1" style={{ width: rowWidth }}>
            <View className="h-1 w-3/5 rounded-full" style={{ backgroundColor: colors.border }} />
            <Text variant="caption" tone="muted">
              SCREEN
            </Text>
          </View>

          {map.sections.map((section) => (
            <View key={section.name} className="gap-1.5">
              {map.sections.length > 1 ? (
                <Text variant="caption" tone="muted" className="pl-11 uppercase">
                  {section.name}
                </Text>
              ) : null}

              {section.rows.map((row) => (
                <View key={`${section.name}-${row.label}`} className="flex-row items-center">
                  <View style={{ width: 44 }}>
                    <Text variant="caption" tone="muted" className="text-center">
                      {row.label}
                    </Text>
                  </View>
                  <View style={{ width: rowWidth, height: seatSize }}>
                    {row.seats.map((seat) => {
                      const category = categoryById.get(seat.categoryId);
                      const state = seatVisualState(seat, category, selected.has(seat.id));
                      const style = seatStyle(state, scheme);
                      const selectable = isSelectable(seat, category);
                      const name = seatName(row.label, seat);

                      return (
                        <Pressable
                          key={seat.id}
                          accessibilityRole="button"
                          accessibilityState={{
                            selected: state === 'selected',
                            disabled: !selectable,
                          }}
                          accessibilityLabel={`Seat ${name}, ${category?.name ?? 'seat'}, ${
                            SEAT_STATE_LABEL[state]
                          }`}
                          onPress={() =>
                            selectable
                              ? onToggleSeat(seat, row.label)
                              : onSeatBlocked(seat, row.label)
                          }
                          style={{
                            position: 'absolute',
                            // colIndex is 1-based.
                            left: (seat.colIndex - 1) * (seatSize + SEAT_GAP),
                            width: seatSize,
                            height: seatSize,
                            backgroundColor: style.fill,
                            borderColor: style.border,
                            opacity: style.opacity,
                            borderWidth: state === 'selected' ? 2 : 1,
                            borderRadius: 4,
                          }}
                        />
                      );
                    })}
                  </View>
                </View>
              ))}
            </View>
          ))}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
