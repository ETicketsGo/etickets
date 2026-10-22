# App assets

These are the storefront's "E." mark (`apps/customer-web/public/icon.svg`: ink E, gold dot, on
ivory) rendered at each size. The app icon is a full-bleed square because iOS masks the corners:

| File                    | Purpose                           | Recommended size                              |
| ----------------------- | --------------------------------- | --------------------------------------------- |
| `icon.png`              | App icon                          | 1024×1024                                     |
| `adaptive-icon.png`     | Android adaptive foreground       | 1024×1024 (safe zone)                         |
| `splash.png`            | Splash image                      | 1284×2778 (or a centered logo on transparent) |
| `favicon.png`           | Web favicon                       | 48×48                                         |
| `notification-icon.png` | Android notification (monochrome) | 96×96                                         |

Brand: Luxury Editorial - ink `#16130F`, gold `#B8955A`, on ivory `#F6F2EA`.

## 🚫 BLOCKING GATE — placeholder assets must be replaced before any external release

The flat-colour placeholders are acceptable **only** for engineering compilation/CI. They MUST
be replaced with real branded artwork before:

- [ ] iOS **TestFlight**
- [ ] Google Play **internal testing**
- [ ] any **pilot** demonstration
- [ ] any **preview/production** EAS build
- [ ] **App Store / Play Store** submission

Required real assets: iOS app icon · Android adaptive icon (foreground + background) ·
splash artwork · notification icon · web favicon. A release build with placeholder assets
is a launch blocker, not a warning.
