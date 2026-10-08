# Pre-deployment location audit (QA, then production)

**Status:** READY. **Not executed.** It needs authorised database access, which this procedure
does not grant or obtain.

**Run it before** deploying the venue/space migrations to an environment:

| Migration                                          | What it does to existing data                                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261007090000_space_belongs_to_venue`            | gives every screen a venue; creates a venue for each screened cinema that has none; **aborts the deploy** if any cinema points at another organization's venue |
| `20261007110000_venue_location_is_answerable`      | removes the India defaults from `Venue.country` / `Venue.timezone`; rewrites no row                                                                            |
| `20261007120000_a_space_has_named_layouts`         | names unnamed layouts `Default`; re-keys layouts by name                                                                                                       |
| `20261007130000_ticket_types_reference_seat_zones` | adds a nullable column; no data change                                                                                                                         |

**And again before** any later migration that drops `Cinema`'s legacy location columns
(`city`, `address`, `country`, `region`, `timezone`, `latitude`, `longitude`). That drop is
deferred until both QA and production have been audited.

---

## 1. Why a separate SQL file

QA, UAT and production run commits from before PR #240, on the **pre-migration** schema.
`apps/api/scripts/audit-space-location.mjs` is for databases that are already migrated: it reads
`Screen."venueId"`, which doesn't exist yet on those environments, so it would fail there. This
procedure uses plain SQL written against the pre-migration tables:
**`apps/api/scripts/pre-deploy-location-audit.sql`**.

It has been verified two ways:

- against the full 92-table schema generated from QA's deployed commit `08a476d`, with one
  seeded row for each finding;
- in CI by `pre-deploy-location-audit.integration-postgres.spec.ts`, which also proves it
  cannot write. That proof was falsified both ways: disabling the cross-tenant check fails the
  test, and so does adding a write to the file.

## 2. Safety properties

- It runs inside `BEGIN TRANSACTION READ ONLY`, so the server refuses any write in it.
- It sets a 60-second statement timeout and a 5-second lock timeout, so it cannot hold up the
  live service.
- It ends with `ROLLBACK`. Nothing is created, changed or deleted.
- It outputs ids and place names only: no customer data, no credentials and no money.

## 3. Who runs it, and how

1. **Authorisation.** The owner approves the run for one named environment. QA comes first;
   production is a separate approval.
2. **Access.** Use one of these, in order of preference. None of them may put a credential in
   chat, a ticket, a commit or a log.
   - Run it from inside the environment, for example a one-off shell in the api service that
     already has `DATABASE_URL`.
   - Use a short-lived read-only database role, if one is provisioned.
   - Use a temporary TCP proxy, removed straight afterwards. Least preferred, because it
     exposes the database.
3. **Command**, from a checkout of `main` at or after the follow-up PR:

   ```
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/scripts/pre-deploy-location-audit.sql
   ```

4. **Record** the output table, with the environment name and date, in the deployment ticket.
   The output contains no secrets and is safe to share.

## 4. Reading the result

The output is one table with the columns `section, verdict, entity_id, detail`.

| Section                  | Verdict               | Meaning                                                                                                                                                   | Action                                                                                                                                                                                    |
| ------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0 FINGERPRINT`          | INFO                  | Latest migration, whether `090000` is already applied, whether `Screen.venueId` exists                                                                    | If it says **applied: YES**, this is the wrong audit. Use `audit-space-location.mjs` instead                                                                                              |
| `A CROSS_TENANT`         | **BLOCKS_DEPLOY**     | A cinema owned by one organization points at another organization's venue. Migration `090000` **will abort**                                              | Do **not** deploy. The owner decides which organization is right; the repair is a separately authorised, reviewed change. Never edit the migration to skip the check                      |
| `B CINEMA_WITHOUT_VENUE` | NEEDS_DECISION / INFO | A screened cinema has no venue; the migration will create one from the cinema's own columns                                                               | NEEDS_DECISION means the cinema has **no country**, so the new venue cannot price and checkout will fail closed. Supply the country after deploy, or before deploy through a reviewed fix |
| `C LOCATION_CONFLICT`    | NEEDS_DECISION        | A cinema and its venue disagree about city, country, region, timezone or address                                                                          | Doesn't block this deploy. Decide which value is true **before** the Cinema columns are dropped, because the cinema's value is lost at that point                                         |
| `D SUSPECT_DEFAULT`      | NEEDS_DECISION        | A venue holds `India` / `Asia/Kolkata` while its own cinema says otherwise. This is probably a default rather than a real answer (the Sydney 06:00 shape) | Doesn't block this deploy, since `spaceTimezone` falls back to the cinema. Correct the venue before relying on it, and before dropping the Cinema columns                                 |
| `E VENUE_AREA`           | INFO / NEEDS_DECISION | Rows in the unused standing-area table                                                                                                                    | Rows here must be considered before that table is ever removed                                                                                                                            |
| `F SUMMARY`              | INFO                  | Counts of venues, cinemas and screens                                                                                                                     | Context                                                                                                                                                                                   |

**Deploy decision:** go ahead only when section **A is empty**. Sections B to E never block
the deploy, but each must be recorded and owned.

## 5. What this procedure never does

- It never changes data: no backfill, no repair and no "quick fix" while connected.
- It never drops or renames Cinema location columns.
- It never deploys anything.
- It never runs without authorisation for that specific environment.

## 6. Production

Use the same file and the same steps, with a separate authorisation, after QA. Production's
deploy decision depends on production's own section A. A clean QA result does not stand in for
a production one.
