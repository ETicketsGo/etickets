/**
 * The Phase 1 channel policy, now a view onto the fuller one.
 *
 * ── WHY THIS FILE STILL EXISTS ─────────────────────────────────────────────────────
 * Phase 3 needed three more facts alongside "which channels may this type use" -- what a
 * preference may not remove, when a fallback fires, and which channels need an opt-in -- and
 * all four are properties of the event, so they belong in one declaration. That is
 * `notification-policy.ts`.
 *
 * Deleting this one would touch every import for no behavioural reason. Re-exporting keeps
 * one source of truth and one place to read it.
 */
export {
  CHANNEL_POLICY,
  CRITICAL_TYPES,
  FALLBACK_CHANNELS,
  channelsFor,
  immediateChannels,
  isCritical,
  permittedChannels,
  policyFor,
  EVENT_POLICY,
  FALLBACK_POLICY,
  type EventPolicy,
  type FallbackPolicy,
  type Urgency,
} from './notification-policy';
