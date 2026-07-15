import { z } from 'zod';

/**
 * Attendee identity input (ADR-031). `assign` sets the attendee directly; `invite`
 * / `transfer` send a tokenised claim link. Kept generic so every experience type
 * (events, movies, attractions, memberships) reuses the same shape.
 */

const optionalTrimmed = z.string().trim().max(120).optional();

export const assignAttendeeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(32).optional(),
  country: optionalTrimmed,
  company: optionalTrimmed,
  designation: optionalTrimmed,
  studentId: optionalTrimmed,
  memberId: optionalTrimmed,
  // Configurable per-experience custom fields: { [label]: value }.
  customFields: z.record(z.string().max(500)).optional(),
});
export type AssignAttendeeInput = z.infer<typeof assignAttendeeSchema>;

export const inviteAttendeeSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(32).optional(),
  name: z.string().trim().max(120).optional(),
});
export type InviteAttendeeInput = z.infer<typeof inviteAttendeeSchema>;

export const transferTicketSchema = inviteAttendeeSchema;
export type TransferTicketInput = z.infer<typeof transferTicketSchema>;
