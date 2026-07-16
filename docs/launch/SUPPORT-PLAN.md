# ETicketsGo — Launch Support Plan

Support coverage for the pilot and early launch. Operational workflows live in
[SUPPORT-WORKFLOWS.md](../commercial/SUPPORT-WORKFLOWS.md); this is the staffing/coverage plan.

## Coverage
| Window | Coverage | Notes |
| --- | --- | --- |
| Business hours | Tier-1 support | Email + in-app; FAQ deflection first. |
| Pilot event days | Tier-1 + Engineering on-call | Hotline for organizers at live events. |
| Off-hours (pilot) | On-call escalation for SEV1/SEV2 | Per [INCIDENT-RESPONSE](INCIDENT-RESPONSE.md). |

## SLAs (pilot)
| Priority | First response | Target resolution |
| --- | --- | --- |
| P1 (event-day blocking) | 15 min | Same day |
| P2 (transactional) | 4 business hours | 1 business day |
| P3 (general) | 1 business day | 3 business days |

## Channels
Help center + [FAQ](../commercial/FAQ.md), support email, in-app contact form, organizer
escalation, event-day hotline. See [SUPPORT-WORKFLOWS](../commercial/SUPPORT-WORKFLOWS.md).

## Escalation ladder
Tier-1 → Tier-2 (senior support / ops) → Engineering on-call (P1/incidents) → Finance
(payouts) / Legal (privacy/disputes).

## Knowledge & tooling
- Agents use: admin reports, ops health, audit trail, booking/payment lookup, reconciliation
  + refunds consoles, correlation IDs for tracing.
- Maintain a living internal runbook of common issues + resolutions (seed from SUPPORT-WORKFLOWS).

## Readiness before launch
- [ ] Channels live and monitored; SLAs agreed and staffed.
- [ ] FAQ + help center published.
- [ ] On-call rota set; escalation contacts current.
- [ ] DSAR/privacy request handling defined (until self-serve export/erasure ships).
- [ ] Pilot organizers have a named point of contact.
