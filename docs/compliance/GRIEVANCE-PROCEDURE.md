# Privacy requests and grievances

**Status:** procedure ready. It needs a named Grievance Officer and a privacy mailbox from the owner before it is published (see `PRIVACY-NOTICE-UPDATES-2026-11.md`).

**Who handles it:** ETicketsGo is founder-operated (`SOLE_OPERATOR_MODE`), so the owner is the Grievance Officer until someone else is appointed.

## Channels

- **Privacy mailbox:** «privacy email». It is the address published in the notice. Forward it to the owner, and keep the mailbox, not a personal inbox, as the record.
- **Contact page:** `/contact`, topic "Privacy". The support reference (ETG-SUP-…) is the case number.

## Clock

| Step                              | Target  | Legal ceiling                                                                                            |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| Acknowledge, with the case number | 48 h    | —                                                                                                        |
| Verify the requester (see below)  | 5 days  | —                                                                                                        |
| Resolve                           | 30 days | India: 90 days (DPDP Rule 14, from 13 May 2027); state laws where applicable (for example CCPA: 45 days) |

## Verifying the requester

1. Reply only to the email or phone already on the account, or on the booking for a guest.
2. Never act on an address the request merely names.
3. Signed-in requests through the app count as verified.

## Request types and how to fulfil them today

| Request                          | How                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Erase**                        | Ask the user to delete the account in-app or via `/delete-account` (self-service, immediate). For a guest-only buyer, an operator anonymises the booking's buyer fields with the same fields `account-deletion.service.ts` uses. Financial records are kept with identity removed (CGST s.36, Companies Act s.128). |
| **Access / copy**                | There is no self-service export yet (audit S11, P2). The operator compiles from the admin console: account, bookings, tickets, consents, support cases. Send it as a password-protected file to the verified address; the password goes by a separate channel.                                                      |
| **Correct**                      | The user can edit their profile. Booking buyer names are fixed after purchase; correct them only with an ID check.                                                                                                                                                                                                  |
| **Withdraw marketing consent**   | Unsubscribe link or SMS STOP (honoured automatically). In-app preferences.                                                                                                                                                                                                                                          |
| **Nominate** (India)             | Record the nominee on the support case; act on the nominee's request with proof of death or incapacity.                                                                                                                                                                                                             |
| **Complaint about an organizer** | Organizers are separate businesses. Pass it to the organizer's grievance contact (`Organization` grievance fields) and keep the case open until they answer.                                                                                                                                                        |

## Record

Log every request on the support case with:

- type;
- date received;
- the verification method;
- what was done;
- date closed.

Keep the case for 3 years. It holds no more personal data than the request itself.

Report each quarter: count by type and median days to close. This is evidence of compliance, not marketing.
