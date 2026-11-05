import Foundation

/// The customer endpoints Phase 1 reads, each verified against apps/api (see README,
/// "API contract inventory"). Paths are relative to the `/api` base in the configuration.
enum CustomerAPI {
    /// GET /public/discovery — discovery/discovery.controller.ts
    static func discovery(city: String? = nil) -> Endpoint<DiscoveryFeed> {
        Endpoint(path: "/public/discovery", query: items(["city": city]))
    }

    /// GET /public/events — events/events.controller.ts; paginated { data, meta }.
    static func events(_ query: EventQuery) -> Endpoint<Page<EventSummary>> {
        Endpoint(path: "/public/events", query: items([
            "q": query.text,
            "category": query.category,
            "page": String(query.page),
            "pageSize": String(query.pageSize),
        ]))
    }

    /// GET /public/events/:slug
    static func event(slug: String) -> Endpoint<EventDetail> {
        Endpoint(path: "/public/events/\(escaped(slug))")
    }

    /// GET /public/movies/:slug/shows — movies/movies.controller.ts
    static func movieShows(slug: String) -> Endpoint<MovieShows> {
        Endpoint(path: "/public/movies/\(escaped(slug))/shows")
    }

    /// GET /tickets — the signed-in customer's wallet (bearer).
    static func tickets() -> Endpoint<[Ticket]> {
        Endpoint(path: "/tickets", requiresAuth: true)
    }

    /// GET /auth/me (bearer)
    static func me() -> Endpoint<AuthenticatedUser> {
        Endpoint(path: "/auth/me", requiresAuth: true)
    }

    private static func items(_ pairs: KeyValuePairs<String, String?>) -> [URLQueryItem] {
        pairs.compactMap { key, value in
            guard let value, !value.isEmpty else { return nil }
            return URLQueryItem(name: key, value: value)
        }
    }

    private static func escaped(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? segment
    }
}

struct EventQuery: Sendable, Equatable {
    var text: String?
    var category: String?
    var page = 1
    var pageSize = 20
}
