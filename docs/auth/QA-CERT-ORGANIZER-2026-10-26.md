# QA certification: organizer identity, invitations, suspension (2026-10-26)

**Environment:** QA, all five services on `e6d751e1` (verify-deployed: "Everything running is what is merged").
Migrations `20261026120000_auth_handoff_and_email_verification` and `20261026150000_team_invitation_delivery`
applied 09:11 UTC, no failed or rolled-back rows.

**Method:** real Chromium against the deployed QA hosts, direct API calls, and SQL on the QA database
(read-only transactions). SMS codes were read from the QA Twilio log for the owner's own number.

**Inbox substitution (QA only, written down so nobody mistakes it for a bypass):** email codes are
bcrypt-hashed and invitation links are sha256-hashed; neither is stored readably, and QA mail goes to
the SES simulator, which has no readable inbox. For rows this run created
(`success+...@simulator.amazonses.com` addresses), the stored hash was replaced with the hash of a known
value. This is what reading the inbox would give. Nothing else was written, and no product check was relaxed.
A wrong code was tried first each time and refused.

**Synthetic data left on QA:**

- organization "QA-ORG Phone Owner 1026", APPROVED so suspension could be tested, then reinstated;
- two simulator email accounts (manager invitees);
- the owner's phone account now has a verified simulator email for organizer messages.

## Part 1: storefront phone sign-in to the organizer console

```
PASS  J1 sign-in code delivered
PASS  J1 storefront session belongs to the phone account - cmv0m1y4
PASS  J2 email step offered to a phone-only organizer (no password asked) - email step=1, already=1
PASS  J2 no password field on the onboarding page
PASS  J3 handoff arrived at the console - https://organizer-qa.eticketsgo.com/organizer
PASS  J3 code only in the fragment (not query) - https://organizer-qa.eticketsgo.com/handoff#code=<redacted>
PASS  J3 no JWT in any navigated URL
PASS  J3 final address bar has no code
PASS  J3 console shows the organization
PASS  J4 replaying a used code is refused
PASS  J5 "create organizer account" link targets the QA storefront - https://qa.eticketsgo.com/register?intent=organizer
PASS  J5 console offers "Continue with your ETicketsGo account"
PASS  J6 non-member refused a handoff - 403

13/13 passed
```

## Part 2: email addition, invitations, admin MFA, unauthorised access, suspension, sign-out

Final run:

```
PASS  S0 phone owner has an organization (from part 1) - QA-ORG Phone Owner 1026
PASS  S0 phone owner storefront session still valid
PASS  E1 profile offers "Add an email for organizer messages" to a phone-only organizer - already added + verified by the earlier run (see part2.log first run)
PASS  I1 invite created from the console - 201
PASS  I1 response never contains the link
PASS  I1 page never shows the link
PASS  I1 owner told the email was sent
PASS  I1 DB: invitation stored as a hash only, member INVITED - t|INVITED
PASS  I1 DB: no Notification row holds the invitation (link never stored) - none
PASS  I2 accept with no session: 401 - 401
PASS  I3 the inviting organizer cannot accept it: 403 INVITATION_WRONG_ACCOUNT - 403 INVITATION_WRONG_ACCOUNT
PASS  I3 DB: member still INVITED, invitation still open
PASS  I4 invitee asks for a code to the invited address - 201
PASS  I4 wrong code cannot claim - 400 VALIDATION_FAILED
PASS  I5 invitee with the emailed code claims and joins - 201
PASS  I5 DB: after claiming, still INVITED until the invitee accepts
PASS  I6 invitee signs in with their own password - 201
PASS  I7 the invited person, signed in with the verified invited email, accepts - 201
PASS  I7 DB: member ACTIVE, invitation spent (hash removed), email verified - ACTIVE|t|t|t
PASS  I8 the spent link is refused, even for the invitee - 404 NOT_FOUND
PASS  I8 invitee can now open the organization - 200
FAIL  I9 DB: audit records the refusals and the acceptance - INVITED_ACCOUNT_CLAIMED
PASS  M1 admin password sign-in asks for a code, issues no session - 201
PASS  M2 wrong authenticator code refused - 401 MFA_INVALID_CODE
PASS  M3 right code: admin session - 201
PASS  U1 an organizer/customer token is refused on admin routes - 403
PASS  U2 no token on admin routes: 401 - 401
PASS  U3 no token on organizer routes: 401 - 401
PASS  S0 admin approves the synthetic QA organization (suspension applies to approved ones) - 201
PASS  S1 admin suspends the organization - 201
PASS  S1 DB: organization SUSPENDED
PASS  S2 phone-signed owner refused: 403 ORGANIZATION_SUSPENDED - 403 ORGANIZATION_SUSPENDED
PASS  S3 password-signed staff refused: 403 ORGANIZATION_SUSPENDED - 403 ORGANIZATION_SUSPENDED
PASS  S4 one-click handoff refused while suspended - 403 TENANT_FORBIDDEN
PASS  S5 writes refused too (invite while suspended) - 403 ORGANIZATION_SUSPENDED
PASS  S6 console shows the suspended screen (existing session)
PASS  S6 suspended screen offers the support path and sign-out
PASS  S6 no console navigation behind it - nav links=0
PASS  S7 the person can still use the storefront (account not suspended)
PASS  S8 admin still manages the suspended organization - 200
PASS  S9 admin reinstates - 201
PASS  S9 access returns after reinstatement - 200
PASS  L1 after console sign-out, the console asks to sign in - https://organizer-qa.eticketsgo.com/login?next=%2Forganizer
PASS  L2 the signed-out refresh token is revoked on the server - 401

43/44 passed
```

I9 failed only because the audit filter looked for actions starting `INVIT`. The audit rows written (SQL, last 3 hours):

- ACCOUNT_EMAIL_CODE_SENT 4, ACCOUNT_EMAIL_CONFIRMED 2, ACCOUNT_EMAIL_ADDED 1;
- AUTH_HANDOFF_CREATED 3, AUTH_HANDOFF_EXCHANGED 2, AUTH_HANDOFF_REFUSED 4;
- MEMBER_INVITED 4, MEMBER_INVITE_REFUSED 6, INVITED_ACCOUNT_CLAIMED 2, MEMBER_INVITE_ACCEPTED 1;
- ORGANIZATION_SUSPENDED 2.

Earlier runs:

- Run 1: the email-addition checks E1-E2 passed (below). Its claim failed on the password policy, which
  refused a password containing part of the email address; that was the test data, not a defect.
  Its suspension got 409 because an organization still in review cannot be suspended, by design.
- Run 2: the claim worked. It showed that claiming does not activate the member; only the invitee's own
  signed-in accept does, by design. The script was corrected to add that step.

```
PASS  E1 profile offers "Add an email for organizer messages" to a phone-only organizer
PASS  E1 code sent to the new address
PASS  E1 DB: one pending code row, bcrypt-hashed, for that address - success+orgcert-1793007759857@simulator.amazonses.com|t|t
PASS  E2 wrong code refused, email not verified
PASS  E2 right code: "Done. Organizer messages will go to ..."
PASS  E2 DB: address saved and verified on the SAME account - success+orgcert-1793007759857@simulator.amazonses.com|t|t
PASS  E2 DB: still exactly one account for the number
```

## Customer phone-identity regression on the new build

```
before: 1 user row(s) for the number; name ""; consent rows 0
PASS  C0 exactly one account holds the number
PASS  C1 wrong code refused - 401 INVALID_CREDENTIALS
PASS  C2 request-code accepted, generic answer - 201 {"sent":true,"expiresInMinutes":10}
PASS  C2 code delivered (read from our Twilio log)
PASS  C2 verify signs in, isNewAccount=false - 201 isNewAccount=false
PASS  C2 session is the EXISTING account - cmv0m1y4 vs cmv0m1y4
PASS  C2 still exactly one account row
PASS  C2 existing account NOT renamed by sign-up data - ""
PASS  C2 no sign-up consent row written - 0 -> 0
waiting 65 s for the per-number cooldown...
FAIL  C3 differently formatted number accepted - 429 RATE_LIMITED
FAIL  C3 resolves to the same account - 400
PASS  C3 still exactly one account row
PASS  C4 residence not set from the +1 prefix - residence|detected|source = ||

11/13 passed
```

C3 got 429 RATE_LIMITED: the per-number limit (5 codes per hour) was used up by this certification.
C3 passed on `f956c424` (MASTER-READINESS ID5) and is rerun after the hour (ID18).

## Mobile width (Pixel 5 emulation)

None of these pages scrolls sideways (0 px): console login, `/handoff` with a bad code, storefront `/register?intent=organizer`.

## Production 404, reproduced 2026-10-26 (read-only GETs)

| Check                                                                  | Result                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------- |
| PROD console `organizer.eticketsgo.com/login`, register link (browser) | `https://eticketsgo.com/register?intent=organizer`    |
| That URL                                                               | **404**                                               |
| `https://www.eticketsgo.com/register?intent=organizer`                 | 200                                                   |
| QA console register link after #493                                    | `https://qa.eticketsgo.com/register?intent=organizer` |

PROD changes only when organizer-web is deployed from the release request. Re-check the link then.

## Not covered here

- A Moto G31 walk of the console (MASTER-READINESS ID19).
- The invitee's emailed link opened from a real inbox (the hash was substituted instead).
