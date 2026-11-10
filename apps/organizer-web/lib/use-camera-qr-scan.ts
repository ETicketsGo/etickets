'use client';

import { useEffect, useRef, useState } from 'react';
import {
  cameraErrorMessage,
  cameraUnavailableReason,
  createQrReader,
  openCamera,
  REPEAT_SCAN_WINDOW_MS,
} from './qr-camera';

/**
 * Continuous QR scanning from the device camera, for the door screen.
 *
 * The same camera handling as the event's Check-in tab (lib/qr-camera.ts: the native detector
 * where it exists, jsQR otherwise), with one difference that matters at a door: the camera
 * stays open after a read, so the next person in the queue only has to hold up their ticket.
 *
 * - One decode at a time, and none while a check is still waiting for its answer (`busy`).
 * - The same code is ignored for a few seconds, so a ticket held up to the lens is sent once.
 * - The camera is released on Stop, on leaving the page and when the tab is hidden.
 */
export function useCameraQrScan({
  onCode,
  busy,
}: {
  onCode: (value: string) => void;
  busy: boolean;
}) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Read through refs: the decode loop is started once and must see the latest values.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let last = { value: '', at: 0 };

    const stop = () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') setScanning(false);
    };
    document.addEventListener('visibilitychange', onHidden);

    (async () => {
      const unavailable = cameraUnavailableReason();
      if (unavailable) {
        setError(unavailable);
        setScanning(false);
        return;
      }
      try {
        stream = await openCamera();
        if (cancelled) return stop();
        const video = videoRef.current;
        if (!video) return stop();
        video.srcObject = stream;
        await video.play();
        setError(null);
        const reader = await createQrReader();
        const tick = async () => {
          if (cancelled) return;
          if (!busyRef.current) {
            try {
              const value = await reader.detect(video);
              const now = Date.now();
              if (value && !(value === last.value && now - last.at < REPEAT_SCAN_WINDOW_MS)) {
                last = { value, at: now };
                onCodeRef.current(value);
              }
            } catch {
              /* a frame that is not ready yet */
            }
          }
          if (!cancelled) timer = setTimeout(tick, 250);
        };
        void tick();
      } catch (err) {
        setError(cameraErrorMessage(err));
        setScanning(false);
      }
    })();

    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      stop();
    };
  }, [scanning]);

  return {
    scanning,
    error,
    videoRef,
    start: () => {
      setError(null);
      setScanning(true);
    },
    stop: () => setScanning(false),
  };
}
