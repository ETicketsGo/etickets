'use client';

import { useTranslations } from 'next-intl';
import type { PasswordFieldCopy } from '@eticketsgo/web-kit';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@eticketsgo/shared-types';

/**
 * The password field's words, in the storefront's language.
 *
 * Problems are translated by CODE rather than by passing the API's English sentence through,
 * so a French shopper reads French however the refusal was reached — typed locally, or
 * returned by the server.
 */
export function usePasswordCopy(): PasswordFieldCopy {
  const a = useTranslations('storefront.auth');
  return {
    label: a('choosePassword'),
    hint: a('passwordHint'),
    strength: (level) => a('passwordStrength', { level }),
    levels: {
      0: a('passwordLevelNotAccepted'),
      1: a('passwordLevelAcceptable'),
      2: a('passwordLevelGood'),
      3: a('passwordLevelStrong'),
    },
    problems: {
      TOO_SHORT: a('passwordTooShort', { min: PASSWORD_MIN_LENGTH }),
      TOO_LONG: a('passwordTooLong', { max: PASSWORD_MAX_LENGTH }),
      CONTAINS_PERSONAL_INFO: a('passwordPersonal'),
      TOO_COMMON: a('passwordTooCommon'),
      TOO_PREDICTABLE: a('passwordTooPredictable'),
    },
  };
}
