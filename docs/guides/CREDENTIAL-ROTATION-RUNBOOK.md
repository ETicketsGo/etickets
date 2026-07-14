# Credential Rotation Runbook

Rotate a provider's secret (API key / webhook secret) without downtime. Secrets live
in the secret manager; the platform holds only references and a short-TTL cache.

## Standard rotation (same reference path)

1. In the secret manager, add the **new** secret value at the same reference (a new
   version), keeping the old version enabled if the provider supports overlap.
2. Wait up to `SECRET_CACHE_TTL_MS` for the cache to expire, **or** force it:
   - Provider config edit (any save) invalidates + rebuilds, **or**
   - call `PaymentProviderFactory.refresh(<provider>)` (exposed via the admin
     test-connection / re-enable flow).
3. Verify: `GET /admin/payments/live-readiness?provider=<name>` stays **GO** and a
   test transaction succeeds.
4. Disable/delete the old secret version.

## Webhook secret rotation

1. Add the new webhook secret in the provider dashboard + secret manager.
2. Refresh as above. During overlap the provider may sign with either secret; keep
   both valid until traffic confirms the new one, then retire the old.

## Reference change (path migration)

If the reference path itself changes, update the provider config's `secretKeyRef` /
`webhookSecretRef` in the admin console (audited). The factory rebuilds on the new
fingerprint automatically.

## Emergency revocation

1. In the provider dashboard, revoke the compromised key.
2. Suspend the provider: `POST /admin/payments/outage/provider/:provider/suspend
{ "suspended": true }` (or maintenance mode) to stop new intents.
3. Rotate to a new secret, refresh, verify readiness, then resume.

## Notes

- Rotation never requires a redeploy.
- The cache holds values only in memory; nothing is written to disk or logs.
- Every config change is audited.
