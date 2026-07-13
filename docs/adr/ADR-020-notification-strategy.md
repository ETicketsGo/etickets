# ADR-020: Notification Strategy

- **Status:** Accepted
- **Date:** 2026-07-13
- **Scope:** Notification Platform sprint (Prompt 3)

## Context

Notifications were a single `NotificationService.send()` that persisted a row and
logged an email. The platform needs pluggable channels (email/SMS/WhatsApp/push/
in-app), templates, localization, per-user preferences, and scheduled/retryable/
cancelable delivery — without changing the current behaviour of the four callers
(bookings/payments/refunds/check-in).

## Decision

- **Channel strategy**: `NotificationChannel` interface + a registry, with
  Email/SMS/WhatsApp/Push/InApp implementations (log-only MVP stubs where a real
  provider binds). Channels only _deliver_; persistence stays in the service.
- **Templates + localization**: `NotificationTemplateService.render(type, locale,
payload)` with `en` templates for every type, generic + `en` fallbacks.
- **Preferences**: additive `NotificationPreference (userId, type, channel,
enabled)`; `resolveChannels` treats absence of a row as enabled (guests pass
  through) — so nothing is suppressed by default.
- **Lifecycle**: `Notification` gained `locale/scheduledFor/attempts/lastError/
cancelledAt` (additive). `send` = immediate; `schedule` = deferred (SCHEDULED);
  `cancel` = atomic guard on PENDING/SCHEDULED; `dispatchDue` = worker-driven
  delivery with retry (FAILED only at max attempts). A worker repeatable job
  sweeps due notifications.

**Backward compatibility:** `send()` keeps its signature (channels/locale are new
optional fields) and defaults channel resolution to `['email']`, so the existing
callers still produce exactly one email row + log. The four call sites are
unchanged.

## Consequences

- New channels/templates/locales are drop-in; scheduling/retry/preferences are
  first-class.
- Providers remain unimplemented (log-only) — the extension surface is defined and
  tested; binding SendGrid/Twilio/FCM is a later, isolated change.
- Verified: typecheck (api + worker), 21 suites/116 tests, build, e2e green.
