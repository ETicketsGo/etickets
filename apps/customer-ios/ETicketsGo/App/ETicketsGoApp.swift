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
                // At the window, so a link still lands while a sheet or cover is showing.
                .onOpenURL { openedWith($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { openedWith(url) }
                }
                #if DEBUG
                // Debug only: `-ETGOpenURL <url>` behaves as if the app was opened with that link.
                .task {
                    let args = ProcessInfo.processInfo.arguments
                    if let i = args.firstIndex(of: "-ETGOpenURL"), args.indices.contains(i + 1), let url = URL(string: args[i + 1]) {
                        openedWith(url)
                    }
                }
                #endif
        }
    }

    private func openedWith(_ url: URL) {
        let config = container.configuration
        if let found = PaymentReturn.parse(url, appScheme: config.appURLScheme, webHost: config.webHost) {
            router.paymentReturn = found
        } else if let link = SharedLink.parse(url, webHost: config.webHost) {
            router.open(link)
        }
    }
}
