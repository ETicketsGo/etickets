# Development

## Setup

```bash
npm install                       # from the repo ROOT — this is an npm workspace
cd apps/customer-mobile
cp .env.example .env
npm start
```

Android emulator: `localhost` means the emulator, not your machine. Use
`http://10.0.2.2:4000/api`. Physical device: your LAN IP.

## The React 18 / 19 split — do not "fix" it by hoisting

The root has React 18 for the three Next.js web apps. This app needs React 19 with
react-native 0.85.3. They cannot be the same version.

Hoisting react-native to the root **fails** (npm ERESOLVE: RN 0.85.3 requires React 19)
and would break the web apps if it succeeded. The nesting is a consequence of a correct
decision, so every fix belongs at a **resolver**, not in the dependency tree:

| File                                            | Pins                                                     | For      |
| ----------------------------------------------- | -------------------------------------------------------- | -------- |
| `metro.config.js` → `resolver.extraNodeModules` | react, react-dom, react-native, react-native-css-interop | Bundling |
| `tsconfig.typecheck.json` → `paths`             | react, react-native                                      | `tsc`    |
| `package.json` → jest `moduleNameMapper`        | react, react-dom, react-native-css-interop               | Tests    |

`tsconfig.typecheck.json` is separate from `tsconfig.json` on purpose: Metro and
jest-expo both read `tsconfig.json`'s `paths` and would map the runtime `react` import to
the types-only `@types/react`.

`react-native-css-interop` needs its own entry in all three. It is NativeWind's runtime,
nested under `nativewind/node_modules`, and third-party packages import it by bare
specifier — `react-native-safe-area-context` does, after NativeWind patches it. Without
the Metro entry **the bundle does not build at all**.

## Why mobile sits outside the root typecheck task

The root `turbo typecheck` covers 13 packages. Mobile is separate
(`npm run typecheck:mobile`) because it needs the React 19 `paths` override that would be
wrong for every other workspace.

## Gates before you push

```bash
cd apps/customer-mobile
npm run lint:mobile
npm run typecheck:mobile
npm run test:mobile
npm run smoke:web            # exports and drives the app in Chromium against QA

cd ../..
npm run verify               # whole monorepo
```

## Conventions

- Screens live in `app/`, logic in `src/features/<domain>/`.
- A feature owns its Zod contract; reads go through `getParsed()`.
- Import UI from `@/ui`, never from the individual files.
- Money stays in integer minor units until the moment it is formatted.
- `Date.now()` in render or a memo is impure — use `useNow()`.
- Do not sync props into state in an effect; derive with an override (see
  `app/checkout.tsx`).

## Gotchas that have already bitten

1. **jest mock factories are hoisted.** A variable referenced inside `jest.mock()` must
   be named `mock*` or the suite fails to start.
2. **`extra` values are not what you wrote.** Expo turns `null` into `{}`, which is
   truthy. Read through the string guard in `env.ts`.
3. **Metro caches aggressively.** Use `expo export --clear` when a config change appears
   not to apply.
4. **NativeWind styles nothing it has not been told about.** `className` on
   `@expo/vector-icons` is silently dropped — icons take a `color` prop.
5. **`tailwind.config.js` must extend `fontSize`**, or semantic classes such as
   `text-caption` resolve to nothing, silently.
