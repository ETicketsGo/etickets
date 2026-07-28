# ETicketsGo — Privacy Policy (DRAFT) + Data Map

> ⚠️ **DRAFT / TEMPLATE — NOT LEGAL ADVICE.** Engineering-authored, reflecting the data the
> platform actually collects and stores. **Must be reviewed and finalized by qualified
> privacy/legal counsel** (GDPR/CCPA/DPDP applicability depends on your markets) before
> publication. **[Brackets]** need business input.

**Controller:** [Legal Entity Name] · **Effective date:** [date] · **DPO/contact:** [email]

## 1. Data we collect (actual, from the schema)

| Data                                              | Where stored       | Purpose                                                      |
| ------------------------------------------------- | ------------------ | ------------------------------------------------------------ |
| Name, email, password hash (bcrypt), roles        | `User`             | Account, auth, RBAC                                          |
| Buyer name/email                                  | `Booking`          | Order + receipts                                             |
| Ticket holder name/email                          | `Ticket`           | Entry + delivery                                             |
| Payment references (no card data)                 | `Payment`/attempts | Payment status (card data held by the provider, never by us) |
| Refresh-token hashes, IP, user-agent              | `RefreshToken`     | Session security                                             |
| Audit events (actor, action, IP, correlationId)   | audit log          | Security/forensics                                           |
| Notification recipients (email/phone/push tokens) | notifications      | Delivery                                                     |

We **do not** store raw card numbers, CVV, or full PANs — payment card handling is delegated
to PCI-compliant providers via hosted/redirect flows.

## 2. How we use data

Provide the service (accounts, ticketing, payments, entry), security/fraud prevention,
support, legal compliance, and — where permitted — service communications.

## 3. Sharing

- **Organizers** receive attendee data necessary to run their events.
- **Payment providers** process payments.
- **Service sub-processors** (email/SMS/push, hosting, monitoring) under contract.
- Legal/authority disclosures where required.

## 4. Retention

[Define concrete retention periods per data category with counsel.] Current technical notes:
refresh tokens carry an expiry; audit is retained for forensics; drill evidence has a 90-day
TTL. **A user-data export/erasure workflow is a documented Phase-2 follow-up** (see
[KNOWN-LIMITATIONS](../release/KNOWN-LIMITATIONS.md)) — until built, handle DSAR requests
operationally per [SUPPORT-WORKFLOWS.md](SUPPORT-WORKFLOWS.md).

## 5. Your rights

[Access, rectification, erasure, portability, objection — scope by jurisdiction.] Requests
via [privacy email].

## 6. Security

Encryption in transit (TLS), hashed passwords, least-privilege authorization, audit
logging, secret management, and fail-closed production configuration.

## 7. International transfers

[If applicable, describe transfer mechanisms.]

## 8. Children

The service is not directed to children under [age]; we do not knowingly collect their data.

## 9. Changes & contact

We may update this policy; material changes will be communicated. Contact: [privacy email].

---

_Retention periods (§4) and rights mechanics (§5) require counsel + an operational DSAR
process. Do not publish as-is._
