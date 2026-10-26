/*
  The one way to read a phone number, now shared with the organizer console's phone sign-in
  (packages/web-kit/src/phone-number.ts). Re-exported so every storefront import keeps working.
*/
export {
  PHONE_COUNTRIES,
  isPhoneCountry,
  phoneCountryGuess,
  readTypedNumber,
  toE164,
} from '@eticketsgo/web-kit';
