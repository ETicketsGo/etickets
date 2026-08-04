# Architecture

## Why this lives in the monorepo

It was specified as a standalone repo, with an exception if a workspace already existed
and was intentionally placed. It did, and it is.

The app consumes `@eticketsgo/shared-types`, `@eticketsgo/validation` and
`@eticketsgo/design-tokens`. Extracting it means copying the DTOs, the Zod schemas the
API validates against, and the brand tokens — and then maintaining three copies. A
mobile client that disagrees with the backend contract is the specific failure this
avoids, and it is not hypothetical: a phone can run a build from months ago.

The real cost is release independence: the app cannot ship on its own cadence while
those packages are unpublished. Worth revisiting once they are on a registry.

## Layers

```
app/                    Expo Router routes — screens only, no business logic
src/ui/                 Design system primitives (Text, Button, Card, Field, …)
src/components/         Cross-feature composites (Screen, AuthGate, states)
src/features/<domain>/  schema.ts (Zod contract) + api.ts (queries) + components
src/services/           API client, env, storage, formatting, deep links, errors
src/application/        Global stores (auth) and the QueryClient
src/hooks/              Reusable hooks
```

A feature owns its contract. `src/features/cinema/schema.ts` is the written-down
expectation of `GET /public/shows/:sessionId/seats`, and every read goes through
`getParsed()` so a drifted response fails at the network boundary rather than three
components deep as `undefined.city`.

## State

| Kind         | Owner                                 | Why                                               |
| ------------ | ------------------------------------- | ------------------------------------------------- |
| Server data  | TanStack Query                        | Caching, retries, refetch-on-reconnect            |
| Session      | Zustand (`auth-store`)                | Read outside React (the API client's 401 handler) |
| Screen state | `useState`                            | Seat selection, form fields, filters              |
| Time         | `useNow()` via `useSyncExternalStore` | `Date.now()` in render is impure                  |

There is no global cart. A selection lives on the screen that made it and is passed to
checkout as route params; checkout re-reads authoritative prices from the API regardless.

## Boundaries that are enforced, not just intended

- **Money is integer minor units** everywhere. Zod asserts `.int()`. Formatting happens
  only at render, via `formatMoney`.
- **The client never picks a payment provider.** See [PAYMENTS.md](PAYMENTS.md).
- **The server owns seat state.** Local selection is intent; an unrecognised status is
  treated as unavailable.
- **The QR credential is never persisted or rendered.** See [SECURITY.md](SECURITY.md).

## Rendering

NativeWind 4 (Tailwind for RN). Colour, radius and spacing come from
`@eticketsgo/design-tokens` so the app matches the web. Type size does NOT — the shared
scale is desktop-oriented (`hero` is 3rem) and would render a 48px heading on a phone,
so `tailwind.config.js` defines an Apple-HIG scale in px.

Seats are drawn as plain Views rather than SVG/Canvas: the seeded auditorium is 80 seats
and a large multiplex screen is ~300, where Views are fast enough and bring focus, hit
targets and screen-reader semantics for free. Revisit above ~1000 seats.
