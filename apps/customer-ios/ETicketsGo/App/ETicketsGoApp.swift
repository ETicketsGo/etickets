import SwiftUI

@main
struct ETicketsGoApp: App {
    @State private var container = AppContainer.make(for: .load())
    @State private var router = AppRouter()

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environment(container)
                .environment(router)
        }
    }
}
