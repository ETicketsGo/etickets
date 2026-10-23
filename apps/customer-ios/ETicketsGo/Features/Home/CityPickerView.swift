import SwiftUI

/// City choice (GET /public/location/cities). Scopes Home and Explore.
struct CityPickerView: View {
    @Environment(AppContainer.self) private var container
    @Environment(\.dismiss) private var dismiss
    @State private var cities: Loadable<[City]> = .idle

    var body: some View {
        NavigationStack {
            List {
                Button { container.city.choose(nil) } label: { row("All cities", detail: nil, selected: container.city.selected == nil) }
                LoadableView(state: cities, retry: { Task { await load() } }) { cities in
                    ForEach(cities) { city in
                        Button { container.city.choose(city) } label: {
                            row(city.city, detail: [city.country, city.eventCount.map { "\($0) events" }].compactMap { $0 }.joined(separator: " · "),
                                selected: container.city.selected?.id == city.id)
                        }
                    }
                }
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .etgScreenBackground()
            .navigationTitle("Choose a city")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task { if cities.value == nil { await load() } }
        }
    }

    private func load() async {
        cities = .loading
        do { cities = .loaded(try await container.booking.cities()) } catch { cities = .failed(error.userMessage) }
    }

    private func row(_ title: String, detail: String?, selected: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(ETGFont.headline).foregroundStyle(ETGColor.ink)
                if let detail { Text(detail).font(ETGFont.caption).foregroundStyle(ETGColor.muted) }
            }
            Spacer()
            if selected { Image(systemName: "checkmark").foregroundStyle(ETGColor.goldText) }
        }
        .contentShape(Rectangle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
