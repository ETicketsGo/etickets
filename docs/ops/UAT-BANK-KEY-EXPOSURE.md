# UAT payout bank encryption key - exposure, containment and rotation plan

Status: **contained, rotation planned, awaiting owner approval to rotate.** No value appears in this
document.

## What happened

On 2026-10-08, during UAT configuration work, the value of `PAYOUT_BANK_ENCRYPTION_KEY` on the
UAT `api` service was printed into an engineering session transcript by mistake. It was disclosed
to the owner immediately. The key encrypts organizer bank account numbers at rest
(`OrganizerPayoutAccount.accountCipher`, AES-256-GCM, `apps/api/src/payouts/bank-secret.ts`).

## Inventory (verified 2026-10-09, read-only)

| Question                                 | Answer                                                                               | How it was checked                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Which services hold this key?            | UAT `api` only                                                                       | SHA-256 fingerprint comparison of the variable across QA, UAT and PROD `api`, `worker`, `db-seed`; no value printed |
| Is it reused in QA or PROD?              | **No** - QA and PROD `api` each have a different key; no worker or db-seed has one   | same fingerprint comparison                                                                                         |
| How many records are encrypted under it? | **0** - UAT has 0 payout accounts, 0 organizations with one                          | `select count(*), count("accountCipher") from "OrganizerPayoutAccount"` on UAT Postgres over Railway SSH            |
| Can anything be decrypted with it?       | Nothing exists to decrypt on UAT; it cannot decrypt QA or PROD data (different keys) | the two rows above                                                                                                  |

**Impact today: none.** The exposed key protects no data anywhere.

## Containment already in place

- The key is not reused anywhere else, so exposure is confined to one non-production environment.
- UAT holds no encrypted bank details, so there is nothing to recover and nothing at risk.
- The session that printed it has stopped printing variable values; every later script compares
  names or fingerprints only.

## Why rotation still matters

Any bank details saved on UAT from now on would be encrypted with a key that has been seen. UAT is
used for organizer onboarding rehearsals, so the key should be replaced before anyone enters real
bank details there.

## Why rotation needs care in general (not on UAT today)

The current design holds **one** key and stores no key version with the ciphertext
(`iv:tag:ciphertext`). Replacing the key makes every existing record undecryptable
(`decryptAccountNumber` throws). For an environment WITH encrypted records a safe rotation needs:

1. Code: accept `PAYOUT_BANK_ENCRYPTION_KEY_PREVIOUS` for decryption only, and prefix new
   ciphertexts with a key id (`k2:iv:tag:ciphertext`); unprefixed rows are the previous key.
2. Deploy that code with both keys set.
3. Re-encrypt every row under the new key in one audited job, verifying each round-trip before
   writing; abort on the first failure.
4. Remove the previous key only after a full read-back of every row succeeds.

## Recommended action for UAT (needs owner approval)

Because UAT has **zero** encrypted records, the simple path is safe and loses nothing:

1. Generate a new 32-byte base64 key (`scripts/deploy/rotate-environment-secrets.mjs` already has
   the generator for this variable).
2. Set it on the UAT `api` service with `skipDeploys: true`.
3. Redeploy the UAT `api` service's **existing** deployment (same commit - a variable change must
   never deploy latest `main`, see the 2026-10-08 incident).
4. Verify: the fingerprint changed; `GET /health` is ok; a test payout account can be saved and
   read back on UAT.

Steps 2-3 restart the UAT api, which is why this waits for approval. The dual-key code (above) is
the right follow-up before production ever holds real bank details.
