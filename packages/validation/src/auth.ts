import { z } from 'zod';
import { passwordProblems } from '@eticketsgo/shared-types';
import { emailSchema, passwordSchema, registrableEmailSchema } from './common';

export const registerSchema = z
  .object({
    email: registrableEmailSchema,
    password: passwordSchema,
    fullName: z.string().trim().min(2, 'Please enter your name.').max(120),
    /*
      Optional, and it stays optional. Somebody must be able to create an account and buy a
      ticket with an email address alone; a mobile number is how we can also text them about
      that booking, not a condition of having one.

      Carries its country code - `normalisePhone` refuses a bare national number, because ten
      digits is national length in India, the United States and Canada alike and guessing
      wrong sends somebody's code to a stranger.
    */
    phone: z.string().trim().max(32).optional(),
    /*
      Agreement to be TEXTED about your own bookings. Separate from accepting the terms,
      separate from any marketing, and false unless the person acted.

      Never inferred from `phone`. Giving us a number so we can reach you about a problem is
      not the same as asking to be messaged, and treating it as consent is the exact mistake
      the consent record exists to make impossible.
    */
    smsConsent: z.boolean().optional(),
    /** The market whose disclosure was shown. The VERSION is resolved server-side. */
    country: z.string().trim().max(40).optional(),
  })
  .superRefine((value, ctx) => {
    /*
      Consent needs something to consent ABOUT. Ticking the box with no number is an
      intention we cannot honour, so it is a validation error on the FIELD THAT IS EMPTY -
      pointing at the checkbox would tell somebody to undo the thing they meant.

      The reverse is deliberately NOT an error: a number without the box is a perfectly good
      account, and it grants nothing.
    */
    if (value.smsConsent === true && !value.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phone'],
        message: 'Add your mobile number so we can text you, or clear the text message box.',
      });
    }

    /*
      The one password rule that needs the rest of the form. `passwordSchema` has already
      raised the context-free problems, and repeating them here would list each one twice.
    */
    if (typeof value.password !== 'string') return;
    for (const problem of passwordProblems(value.password, {
      email: value.email,
      name: value.fullName,
    })) {
      if (problem.code !== 'CONTAINS_PERSONAL_INFO') continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: problem.message,
        params: { passwordProblem: problem.code },
      });
    }
  });
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required.'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/**
 * Asking for a reset link. Only an address — deliberately nothing else, because the reply
 * is identical whether or not the address is known.
 */
export const forgotPasswordSchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/** Completing a reset. The token is the credential; the password must meet the usual bar. */
export const resetPasswordSchema = z.object({
  token: z.string().trim().min(20),
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
