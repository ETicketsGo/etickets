# Experience Wallet Platform (ADR-033)

The wallet is no longer a "ticket wallet" — it's a generic **Experience Wallet**
where a Ticket is just one `WalletItem`. Memberships, parking, coupons,
merchandise, rewards and any future asset plug in as new providers **without
touching the wallet UI or engine**. Pure + framework-free core (in `web-kit`);
the UI renders it generically.

## The model

```
WalletItem              // normalized shape every item exposes (no type branching)
WalletProvider          // turns a source into WalletItem[] for one type
WALLET_PROVIDERS        // the registry — providers append here, never a switch
buildWallet(sources, flags)   // runs enabled providers → WalletItem[]
search / filter / sort / group / sectionize   // pluggable strategies
assetCapabilities(item) // ExperienceAsset lifecycle view (CTO abstraction)
```

`WalletItem` carries everything the renderer needs: `type`, `title`, `subtitle`,
`status` + `statusTone`, `badge`, `icon`, `artworkSeed`, `startsAt`/`expiresAt`,
`reference`, `sections`, `filters`, `groupKeys`, `searchText`, `capabilities`,
`primaryAction` / `secondaryActions`, `progress`, `metadata`. The `WalletCard`
draws only from these — **no `if (type === 'TICKET')` anywhere**.

### ExperienceAsset lifecycle (CTO abstraction)

`assetCapabilities(item)` projects an item onto the common lifecycle —
`canView / canShare / canTransfer / canArchive / canExpire / canNotify` — derived
from its declared `capabilities` + `expiresAt`. Every asset (ticket, membership,
coupon, collectible …) shares these behaviors while staying modular.

## Providers & the registry

```ts
export interface WalletProvider {
  type: WalletItemType;
  enabled(flags: WalletFlags): boolean;   // real providers → true; placeholders → flag
  build(sources: WalletSources): WalletItem[];
}
export const WALLET_PROVIDERS = [ticketWalletProvider, membershipWalletProvider, …];
```

`buildWallet` filters providers by `enabled(flags)` and flat-maps their items — no
knowledge of any concrete type. The **ticket provider** reuses `groupWalletTickets`
(one item per booking), so the existing wallet behaviour (group cards, check-in
progress, "View tickets") is preserved exactly.

## Wallet home

`/account/tickets` is now **"My experiences"**: search + filter chips + items
bucketed into ordered **sections** (Today, Active, Upcoming, Memberships, Parking,
Coupons, Rewards, Completed, Cancelled). Each item lands in its highest-priority
section, so the wallet stays uncluttered. Backward-compatible — tickets still
render as booking-group `<article>`s.

## Feature flags & placeholders

Placeholder items (Membership, Parking, Coupon — real `WalletItem`
implementations, **no backend business logic**, mock providers) are **OFF by
default**. Enable them to demo the architecture via `?preview=memberships,coupons,
parking`. This proves a new asset type is a **drop-in**, not a redesign.

## Wallet Extension Example — add a new item in 3 steps

```ts
// 1. A provider (mock or real) that emits WalletItems of the new type.
export const seasonPassWalletProvider: WalletProvider = {
  type: 'SEASON_PASS',
  enabled: (f) => f.seasonPasses,
  build: (sources) =>
    sources.seasonPasses.map((p) => ({
      id: `season:${p.id}`,
      type: 'SEASON_PASS',
      title: p.name,
      subtitle: `${p.eventsLeft} events left`,
      status: 'Active',
      statusTone: 'success',
      icon: 'SEASON_PASS',
      artworkSeed: p.id,
      sections: ['active'],
      filters: ['seasonPasses'],
      capabilities: ['view', 'share', 'transfer', 'renew'],
      primaryAction: { label: 'Open pass', href: `/account/passes/${p.id}` },
      /* …the rest of the WalletItem fields… */
    })),
};

// 2. Register it.
WALLET_PROVIDERS.push(seasonPassWalletProvider);

// 3. Map its icon in WalletCard's TYPE_ICON. Done — no wallet/UI engine changes.
```

The card, sections, filters, search, grouping, sharing (via ShareableResource),
assignment and offline cache all work immediately.

## API / DB

**None.** Sprint 6 is a platform + presentation layer over the existing wallet API
(`GET /tickets`) and the Sprint 4–5 identity/sharing work. No schema change; no
booking/payment/inventory change; fully backward-compatible.

## Accessibility

Semantic sections + headings, labeled search, `aria-pressed` filter chips,
status by text + icon + dot (never colour alone), progress as `role="img"` with a
label, keyboard/touch, WCAG AA — consistent with the shared kit.

## Performance

Grouping/sectionizing are memoized; the pure engine is allocation-light; cards are
simple and render-cheap. Renderers are ready to code-split per type and to
virtualize long sections (extension points noted; not needed at current scale).

## Security

Ownership/assignment/transfer/sharing are unchanged — they run through the Sprint
4–5 identity + `ShareableResource` layers, which the wallet composes but never
bypasses. Placeholder items carry no real data.

## Competitive review

| Capability                            | ETicketsGo     | Apple Wallet | Google Wallet | BookMyShow | Ticketmaster | Eventbrite | DICE | Humanitix | District |
| ------------------------------------- | -------------- | ------------ | ------------- | ---------- | ------------ | ---------- | ---- | --------- | -------- |
| One wallet, many asset types          | ✅ (pluggable) | ✅           | ✅            | ❌         | ⚠️           | ❌         | ⚠️   | ❌        | ⚠️       |
| Movies **and** events in one wallet   | ✅             | n/a          | n/a           | ⚠️         | ⚠️           | ❌         | ⚠️   | ❌        | ⚠️       |
| Generic item model (no per-type UI)   | ✅             | ✅ (passes)  | ✅            | ❌         | ❌           | ❌         | ❌   | ❌        | ❌       |
| Sections + filter + search            | ✅             | ⚠️           | ⚠️            | ⚠️         | ⚠️           | ⚠️         | ⚠️   | ⚠️        | ⚠️       |
| Secure share/transfer built in        | ✅             | ⚠️           | ⚠️            | ❌         | ✅           | ⚠️         | ✅   | ❌        | ⚠️       |
| Memberships/coupons/parking in-wallet | ⚠️ scaffolded  | ✅           | ✅            | ❌         | ⚠️           | ❌         | ⚠️   | ❌        | ⚠️       |
| Native OS wallet passes (.pkpass)     | ⚠️ roadmap     | ✅           | ✅            | ❌         | ✅           | ⚠️         | ✅   | ❌        | ⚠️       |

**Advantages:** a single, extensible Experience Wallet spanning movies + events +
future assets, with sharing/transfer/identity built in — closer to Apple/Google
Wallet's generality than any ticketing incumbent, while owning the commerce layer
they don't. **Weaknesses:** membership/parking/coupon are scaffolded (no backend
yet); no native `.pkpass`/Google Wallet export yet. **Next:** ship a real wallet
item (memberships or F&B), add OS wallet-pass export, and the PWA/offline sync
(Sprint 7) — all now drop-ins on this platform.

## Backward compatibility

`/account/tickets` keeps working (tickets render as before); placeholders are
off by default; older payloads/clients are unaffected. No breaking changes.
