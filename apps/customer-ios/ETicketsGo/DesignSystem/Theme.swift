import SwiftUI
import UIKit

/// The storefront's "Luxury Editorial" palette, from packages/design-tokens/src/brand.css
/// (`--etg-*` and the customer `--brand-*` blocks). Light is ivory paper; dark is the
/// storefront's stage tone. Change a value there first, then mirror it here.
enum ETGColor {
    static let canvas = dynamic(light: 0xF6F2EA, dark: 0x16130F)
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x221E19)
    static let sunken = dynamic(light: 0xF0EBE1, dark: 0x2E2922)
    static let ink = dynamic(light: 0x16130F, dark: 0xF6F2EA)
    static let inkSecondary = dynamic(light: 0x3D3830, dark: 0xCFC7BA)
    static let muted = dynamic(light: 0x6A6359, dark: 0xADA497)
    static let rule = dynamic(light: 0xDDD5C7, dark: 0x3A342C)
    static let ruleStrong = dynamic(light: 0xC9BFAE, dark: 0x4D463C)
    /// The primary action: ink on paper, gold on the dark band.
    static let action = dynamic(light: 0x16130F, dark: 0xE3CFA5)
    static let onAction = dynamic(light: 0xF6F2EA, dark: 0x16130F)
    /// Decorative only — a dot, a rule. Never text on ivory (2.5:1); use `goldText`.
    static let gold = Color(hex: 0xB8955A)
    static let goldText = dynamic(light: 0x84652F, dark: 0xE3CFA5)
    static let success = dynamic(light: 0x2F5E45, dark: 0x8FC1A3)
    static let critical = dynamic(light: 0xB51D29, dark: 0xF4787D)
    static let imageFallback = Color(hex: 0x2A221A)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

/// Spacing and corner radii (brand.css `--brand-radius-control` 10px, `--brand-radius-card` 16px).
enum ETGSpace {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    /// Horizontal page gutter.
    static let gutter: CGFloat = 20
}

enum ETGRadius {
    static let control: CGFloat = 10
    static let card: CGFloat = 16
}

/// Type scale. Built on text styles so every size follows Dynamic Type. The web uses Inter;
/// the app uses the system face for now (see README, Phase 2: bundling Inter).
enum ETGFont {
    static let display = Font.system(.largeTitle, weight: .bold)
    static let title = Font.system(.title2, weight: .bold)
    static let section = Font.system(.title3, weight: .semibold)
    static let headline = Font.system(.headline)
    static let body = Font.system(.body)
    static let subheadline = Font.system(.subheadline)
    static let caption = Font.system(.caption)
    /// Small uppercase label, e.g. a category above a title.
    static let eyebrow = Font.system(.caption, weight: .semibold)
}

extension Color {
    init(hex: UInt32) { self.init(UIColor(hex: hex)) }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1)
    }
}
