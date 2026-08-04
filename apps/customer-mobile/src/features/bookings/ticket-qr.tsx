import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { Image } from 'expo-image';
import * as Brightness from 'expo-brightness';
import { Text } from '@/ui';
import type { CachedTicket } from '@/services/ticket-cache';

/**
 * The scannable code.
 *
 * It renders `qrDataUrl` — a QR image the API generated — rather than encoding
 * `qrToken` locally. That is a security decision, not a convenience one: the token is a
 * signed payload whose exact encoding the venue scanner was built against, and a
 * client-side QR library would be this app guessing at that format. If the guess is
 * wrong, nothing fails in testing and the failure surfaces as a queue of people whose
 * tickets will not scan. The server owns the payload; the app only displays it.
 *
 * `qrToken` is never rendered as text, copied, logged or sent anywhere — printing it
 * would put a valid ticket credential on screen in a form anyone nearby can photograph.
 */
export function TicketQr({ ticket }: { ticket: CachedTicket }) {
  useMaxBrightnessWhileVisible();

  const usable = ticket.qrDataUrl?.startsWith('data:image');

  if (!usable) {
    return (
      <View className="h-56 w-56 items-center justify-center rounded-md border border-border bg-background-subtle px-4">
        <Text variant="subhead" tone="muted" className="text-center">
          This ticket&rsquo;s code isn&rsquo;t available. Show your booking reference at the door.
        </Text>
      </View>
    );
  }

  return (
    <View
      // White plate regardless of theme: a QR needs light quiet-zone contrast, and a
      // dark-mode card behind a dark code is the classic "scanner won't read it" bug.
      className="rounded-md bg-white p-3"
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Entry code for ${ticket.ticketType}${
        ticket.seatLabel ? `, seat ${ticket.seatLabel}` : ''
      }. Show this at the door.`}
    >
      <Image
        source={{ uri: ticket.qrDataUrl }}
        style={{ width: 216, height: 216 }}
        contentFit="contain"
        // A data: URI carries its own bytes, so this works with no connection at all —
        // which is the point, since venue wifi is exactly where it will be needed.
        cachePolicy="memory-disk"
        accessible={false}
      />
    </View>
  );
}

/**
 * Pushes the screen to full brightness while a ticket is on screen and restores it on
 * the way out. Venue scanners struggle with a dimmed phone, and asking someone to find
 * their brightness slider in a queue is not a plan.
 *
 * Failure is silent by design: brightness needs a runtime permission on Android and is
 * unavailable on web, and none of that should stop a ticket from being shown.
 */
function useMaxBrightnessWhileVisible() {
  const [restore, setRestore] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (Platform.OS === 'web') return;
        const { granted } = await Brightness.requestPermissionsAsync();
        if (!granted || cancelled) return;
        const previous = await Brightness.getBrightnessAsync();
        if (cancelled) return;
        setRestore(previous);
        await Brightness.setBrightnessAsync(1);
      } catch {
        // Brightness is a nicety; a ticket that displays dim still gets someone in.
      }
    })();

    return () => {
      cancelled = true;
      if (restore != null) {
        Brightness.setBrightnessAsync(restore).catch(() => undefined);
      }
    };
    // `restore` is intentionally excluded: including it would re-run the effect the
    // moment the previous brightness is recorded, and immediately undo itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
