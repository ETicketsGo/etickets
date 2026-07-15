import { z } from 'zod';

/**
 * Secure Experience Sharing input (ADR-032). `permission` selects the capability
 * (view-only / temporary guest access / ownership transfer); `expiry` is a named
 * preset resolved server-side (event_end uses the session end). Generic across
 * resource types — the same shape will serve memberships, passes and vouchers.
 */
export const shareExpiryValues = ['1h', '6h', '24h', 'event_end', 'never'] as const;
export type ShareExpiry = (typeof shareExpiryValues)[number];

export const createShareSchema = z.object({
  permission: z.enum(['VIEW', 'GUEST', 'TRANSFER']).default('VIEW'),
  expiry: z.enum(shareExpiryValues).default('24h'),
  maxOpens: z.number().int().min(1).max(10_000).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  label: z.string().trim().max(120).optional(),
});
export type CreateShareInput = z.infer<typeof createShareSchema>;

export const extendShareSchema = z.object({
  expiry: z.enum(shareExpiryValues),
});
export type ExtendShareInput = z.infer<typeof extendShareSchema>;

export const changeSharePermissionSchema = z.object({
  permission: z.enum(['VIEW', 'GUEST', 'TRANSFER']),
});
export type ChangeSharePermissionInput = z.infer<typeof changeSharePermissionSchema>;
