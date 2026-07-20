# App assets

These are **1×1 placeholder PNGs** so Expo builds. Replace with real branded art before
any store build:

| File                    | Purpose                           | Recommended size                              |
| ----------------------- | --------------------------------- | --------------------------------------------- |
| `icon.png`              | App icon                          | 1024×1024                                     |
| `adaptive-icon.png`     | Android adaptive foreground       | 1024×1024 (safe zone)                         |
| `splash.png`            | Splash image                      | 1284×2778 (or a centered logo on transparent) |
| `favicon.png`           | Web favicon                       | 48×48                                         |
| `notification-icon.png` | Android notification (monochrome) | 96×96                                         |

Brand: premium, minimal, blue `#2563EB` on `#0B0E15` (dark) / white (light).

## 🚫 BLOCKING GATE — placeholder assets must be replaced before any external release

The 1×1 placeholders are acceptable **only** for engineering compilation/CI. They MUST be
replaced with real branded artwork before:

- [ ] iOS **TestFlight**
- [ ] Google Play **internal testing**
- [ ] any **pilot** demonstration
- [ ] any **preview/production** EAS build
- [ ] **App Store / Play Store** submission

Required real assets: iOS app icon · Android adaptive icon (foreground + background) ·
splash artwork · notification icon · web favicon. A release build with placeholder assets
is a launch blocker, not a warning.
