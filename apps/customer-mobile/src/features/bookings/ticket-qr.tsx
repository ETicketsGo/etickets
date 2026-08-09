import { useEffect, useRef } from 'react';
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
 * NO PERMISSION IS REQUESTED, and that is the point.
 *
 * `setBrightnessAsync` changes the brightness of this app's own window and needs
 * nothing granted. Only `setSystemBrightnessAsync` — which changes the device-wide
 * setting and is not what anyone wants a ticket app doing — requires Android's
 * WRITE_SETTINGS.
 *
 * This used to call `Brightness.requestPermissionsAsync()` first, which on Android
 * requests exactly that: "modify system settings". It would have sent someone standing
 * in a queue out to a system settings screen to grant an alarming-sounding special
 * permission, just to brighten a QR code — and the permission was never needed for the
 * call that follows. Found by generating the native project and reading the manifest.
 *
 * Failure stays silent: brightness is unavailable on web and can fail on a device, and
 * neither should stop a ticket being shown.
 */
function useMaxBrightnessWhileVisible() {
  /**
   * The previous brightness lives in a REF, not in state, and that is the whole fix.
   *
   * It was `useState`, and the cleanup read it directly. An effect's cleanup closes over
   * the render in which the effect ran — the first one — where the value was still null.
   * The async work then set it a moment later, but the cleanup was already holding the
   * stale null, so `if (restore != null)` never passed and the brightness was NEVER put
   * back. Excluding it from the deps (which the old comment defended) is what made the
   * closure stale in the first place; adding it to the deps would instead re-run the
   * effect and immediately undo the boost. A ref is the only option that is correct in
   * both directions: stable identity, current value at cleanup time.
   *
   * Caught on a physical Android runtime, not in review. After leaving the ticket
   * screen, `dumpsys display` still reported `mBrightnessReason=override` — the screen
   * stayed at 100% for the rest of the session, and only dropped back when the app was
   * backgrounded and Android reclaimed the window. Burning a phone's battery at full
   * brightness is at its worst precisely where this screen gets used: at a venue, on a
   * nearly-flat phone, with a ticket still to show at the gate.
   */
  const previousBrightness = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (Platform.OS === 'web') return;
        const previous = await Brightness.getBrightnessAsync();
        if (cancelled) return;
        previousBrightness.current = previous;
        await Brightness.setBrightnessAsync(1);
      } catch {
        // Brightness is a nicety; a ticket that displays dim still gets someone in.
      }
    })();

    return () => {
      cancelled = true;
      const previous = previousBrightness.current;
      previousBrightness.current = null;
      if (previous != null) {
        Brightness.setBrightnessAsync(previous).catch(() => undefined);
      }
    };
  }, []);
}
