# Production release request (2026-10-26)

**Status: PRs merged and QA-certified (`e6d751e1`); production NOT approved, NOT run.** Supersedes the scope of
`PROD-API-DEPLOY-REQUEST-2026-10-25.md`; its procedure, gates and kit commands still apply.

## 1. Where production is

| Service       | Running    | Rollback deployment                    |
| ------------- | ---------- | -------------------------------------- |
| api           | `2439e254` | `ab71fb7e-734e-44e1-8bbc-5380a1d1ebbc` |
| worker        | `2439e254` | `a2566b03-933c-4ff8-9b80-225cf2df5ce6` |
| admin-web     | `2439e254` | `da92a8ac-2772-460a-8fc1-41016aad3981` |
| organizer-web | `2439e254` | `d2cd0146-8615-4fdd-b660-edf04ac6b97b` |
| customer-web  | `62d6d453` | `7305672b-bdf1-4573-a99b-a34e96776639` |

## 2. Target

`main` at **`e6d751e1`**. Merged 2026-10-26, in order: #493 (7e7eacab), #495 (0ad5ef16), #492
(74fee3f2), #494 (e6d751e1). Running on QA since 2026-10-26 09:11 UTC and certified there
(`docs/auth/QA-CERT-ORGANIZER-2026-10-26.md`). Re-run `git diff --stat` against section 1 before deploying.

## 3. What reaches production

| Area                                                                                                                     | PRs  | Runtime change                       |
| ------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------ |
| Support references `ETG-SUP-YYYY-NNNNNN`, official links in emails                                                       | #487 | api, worker, admin-web, customer-web |
| Privacy v2 consent version                                                                                               | #484 | api (registry)                       |
| Deletion clears phone                                                                                                    | #478 | api                                  |
| Play Integrity human check (off until configured)                                                                        | #479 | api                                  |
| Phone sign-up shows existing account; country evidence                                                                   | #490 | api, customer-web, admin-web         |
| ETKTGO sender header accepted                                                                                            | #489 | api (config)                         |
| Organizer console phone sign-in, storefront-to-console handoff, organizer email verification, server sign-out, www links | #493 | api, organizer-web, customer-web     |
| Invitations need the invitee's own verified session; suspended organizations refused everywhere                          | #495 | api, organizer-web, admin-web        |
| Notification sweep tolerates a vanished row                                                                              | #492 | api, worker                          |

No change to bookings, payments, refunds, payouts, pricing, Razorpay or SMS sending logic.

## 4. Migrations (all additive; old code keeps working against them)

| Migration                                            | Adds                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `20261025120000_support_request_reference`           | `Feedback.reference` (nullable, unique), counter table, function, insert trigger, backfill |
| `20261025180000_user_country_evidence`               | 3 nullable `User` columns                                                                  |
| `20261026120000_auth_handoff_and_email_verification` | 2 tables, 1 nullable column, 1 enum value                                                  |
| `20261026150000_team_invitation_delivery`            | 1 enum value, nullable `AccountInvitation.revokedAt`                                       |

Behaviour change to communicate: invitation links copied by owners before the release only
work for the invited person after they sign in and prove their email.

## 5. Order and gates

1. Approval of this document.
2. Fresh `predeploy-backup.sh` with `RESULT: restored copy matches live`, and an off-Railway
   copy.
3. URL variables (`CUSTOMER_WEB_URL`, `ADMIN_WEB_URL`, `ORGANIZER_WEB_URL` on api and worker)
   with `set-var.mjs` (skipDeploys).
4. Pinned deploys: api (runs the 4 migrations), worker, customer-web, organizer-web, admin-web.
5. Checks: migrations applied (`_prisma_migrations`), seo-check 23/23, `/delete-account`
   `/privacy` `/terms` `/contact` 200, support request returns `ETG-SUP-...`, organizer
   console login page links to `https://www.eticketsgo.com/register?intent=organizer`,
   capabilities unchanged.

## 6. Rollback

`rollback.mjs` per service to the ids in section 1 (old image + old variable snapshot). The
migrations stay; every one is compatible with the old code (nullable columns, new tables,
enum values unused by old code, the reference trigger fills old inserts).

## 7. Needs from the owner

Permission for the engineering tool to merge PRs and to run production writes (variables +
deploys), or the owner runs them; this document's approval.
