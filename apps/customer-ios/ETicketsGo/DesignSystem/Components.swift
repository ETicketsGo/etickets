import SwiftUI

// MARK: - Buttons

/// Filled ink button — the one primary action on a screen.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ETGFont.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, ETGSpace.lg)
            .foregroundStyle(ETGColor.onAction)
            .background(ETGColor.action, in: RoundedRectangle(cornerRadius: ETGRadius.control))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
    }
}

/// Ink outline on paper — secondary actions.
struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ETGFont.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, ETGSpace.lg)
            .foregroundStyle(ETGColor.ink)
            .overlay(RoundedRectangle(cornerRadius: ETGRadius.control).strokeBorder(ETGColor.ink, lineWidth: 1))
            .contentShape(Rectangle())
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var etgPrimary: PrimaryButtonStyle { PrimaryButtonStyle() }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    static var etgSecondary: SecondaryButtonStyle { SecondaryButtonStyle() }
}

// MARK: - Chips and pills

/// A selectable filter chip: transparent with a rule edge; ink when selected.
struct FilterChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(ETGFont.subheadline.weight(.medium))
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .foregroundStyle(isSelected ? ETGColor.onAction : ETGColor.ink)
                .background(Capsule().fill(isSelected ? ETGColor.action : .clear))
                .overlay(Capsule().strokeBorder(isSelected ? .clear : ETGColor.rule, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Small status / rating pill: text plus a 1pt ring in the same colour.
struct Pill: View {
    let text: String
    var tint: Color = ETGColor.muted

    var body: some View {
        Text(text)
            .font(ETGFont.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .overlay(Capsule().strokeBorder(tint.opacity(0.6), lineWidth: 1))
    }
}

/// Uppercase gold label above a title.
struct Eyebrow: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(ETGFont.eyebrow)
            .tracking(0.8)
            .foregroundStyle(ETGColor.goldText)
    }
}

// MARK: - Section header

struct SectionHeader<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(ETGFont.section)
                .foregroundStyle(ETGColor.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            trailing()
        }
        .padding(.horizontal, ETGSpace.gutter)
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(title: String) {
        self.init(title: title) { EmptyView() }
    }
}

// MARK: - Brand

/// The storefront's "E." mark beside the ETicketsGo wordmark (apps/customer-web/public/icon.svg).
struct BrandMark: View {
    var body: some View {
        HStack(alignment: .lastTextBaseline, spacing: ETGSpace.sm) {
            HStack(alignment: .lastTextBaseline, spacing: 1) {
                Text("E").font(.system(size: 28, weight: .black))
                Circle().fill(ETGColor.gold).frame(width: 7, height: 7)
            }
            Text("ETicketsGo").font(.system(.title3, weight: .bold))
        }
        .foregroundStyle(ETGColor.ink)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("ETicketsGo")
        .accessibilityAddTraits(.isHeader)
    }
}

/// Small environment badge so a QA or MOCK build is never mistaken for production.
struct EnvironmentBadge: View {
    let environment: AppEnvironment

    var body: some View {
        if environment != .prod {
            Text(environment.displayName)
                .font(.system(.caption2, weight: .bold))
                .tracking(1)
                .foregroundStyle(ETGColor.goldText)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .overlay(Capsule().strokeBorder(ETGColor.gold, style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
                .accessibilityLabel("\(environment.displayName) build")
        }
    }
}

#Preview("Components") {
    VStack(alignment: .leading, spacing: ETGSpace.lg) {
        BrandMark()
        EnvironmentBadge(environment: .mock)
        Eyebrow(text: "Live music")
        HStack {
            FilterChip(title: "All", isSelected: true) {}
            FilterChip(title: "Comedy", isSelected: false) {}
            Pill(text: "UA13+")
        }
        Button("Get tickets") {}.buttonStyle(.etgPrimary)
        Button("Share") {}.buttonStyle(.etgSecondary)
        Button("Disabled") {}.buttonStyle(.etgPrimary).disabled(true)
    }
    .padding()
    .background(ETGColor.canvas)
}
