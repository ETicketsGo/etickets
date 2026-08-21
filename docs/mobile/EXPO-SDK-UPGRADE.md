# Expo SDK 57 upgrade (outstanding)

`expo-doctor` reports a **Hermes V1 memory regression** affecting every build of this app.

```
This project uses Hermes V1 with expo@56.0.20, which is affected by a known memory regression.
Detected Hermes V1 250829098.0.10 from React Native.
250829098.0.15 and earlier are affected; 250829098.0.16 is the first version with the fix.
```

## Why it is deferred rather than fixed

The only remedy Expo offers is **SDK 57** — a major upgrade of Expo and React Native
together. There is no patch for SDK 56.

It appeared with no change on our side. `expo-doctor` compares the project against
advisories Expo publishes, so this went red on every branch at once, `main` included. Left
blocking, it would have stopped every unrelated mobile PR until somebody did an SDK
migration in a hurry — which is the worst possible way to schedule one.

So the CI gate accepts this specific advisory and **every other doctor check stays
blocking**. It is echoed as a `::warning::` annotation on every run so it cannot quietly
become normal.

## What the upgrade involves

- `npx expo install expo@^57.0.9 --fix` in `apps/customer-mobile`
- React Native moves to 0.86.2+
- Re-run: `typecheck:mobile`, `test:mobile`, `lint:mobile`, `smoke:web`, and the autolinking
  gate — the last one matters most, since a major RN bump is exactly when a native module
  starts resolving to a nested copy
- Verify on a **physical Android device**, not only the web export. The last two mobile
  defects found here — the empty POST body on the payment action, and the missing `kind` on
  the support form — were both invisible to the web export and to every unit test.

## Risk of leaving it

A memory regression, not a correctness one. It degrades long sessions rather than producing
wrong results, which is why it is tolerable briefly and not indefinitely.
