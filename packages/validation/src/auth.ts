import { z } from 'zod';
import { passwordProblems } from '@eticketsgo/shared-types';
import { emailSchema, passwordSchema, registrableEmailSchema } from './common';

export const registerSchema = z
  .object({
    email: registrableEmailSchema,
    password: passwordSchema,
    fullName: z.string().trim().min(2, 'Please enter your name.').max(120),
  })
  .superRefine((value, ctx) => {
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
