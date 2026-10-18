'use client';

import type { ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog as KitDialog,
  Drawer as KitDrawer,
  ErrorState as KitErrorState,
  RatingStars as KitRatingStars,
  Stepper as KitStepper,
} from '@eticketsgo/web-kit';

/*
  The shared kit's components, with their built-in words in the reader's language.

  web-kit is also the organizer and admin consoles' kit, and those are English-only, so its
  components keep English defaults and take the words as optional props. The storefront passes
  them here, once, instead of at every call site: "Try again", "Close", "Progress" and the star
  ratings' accessible names were English on every French page that showed one.

  The same goes for the brand frame. The kit's dialog, drawer and stars paint themselves in the
  old system unless asked not to (the consoles still use that look), so every storefront page
  that opened one showed a grey panel with a blue-black title on top of a paper page. The
  storefront asks once, here.

  An explicit prop at the call site still wins over the translation.
*/

export function ErrorState(props: ComponentProps<typeof KitErrorState>) {
  const tx = useTranslations('common');
  return <KitErrorState retryLabel={tx('action.retry')} {...props} />;
}

/** The kit's dialog in the storefront's brand frame: paper panel, ink title, display face. */
export function Dialog(props: ComponentProps<typeof KitDialog>) {
  return <KitDialog brand {...props} />;
}

export function Drawer(props: ComponentProps<typeof KitDrawer>) {
  const tx = useTranslations('common');
  return <KitDrawer brand closeLabel={tx('action.close')} {...props} />;
}

export function Stepper(props: ComponentProps<typeof KitStepper>) {
  const tx = useTranslations('common');
  return <KitStepper label={tx('a11y.progress')} {...props} />;
}

export function RatingStars(props: ComponentProps<typeof KitRatingStars>) {
  const tx = useTranslations('common');
  return (
    <KitRatingStars
      brand
      valueLabel={(value) => tx('a11y.ratingOutOf5', { value })}
      starLabel={(count) => tx('a11y.stars', { count })}
      {...props}
    />
  );
}
