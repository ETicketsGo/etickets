import Foundation

// Wire models for the customer API. Field names and optionality follow the API exactly,
// cross-checked against the zod schemas the Expo app validates with
// (apps/customer-mobile/src/features/**/schema.ts). They double as Phase 1's domain models;
// keep them in step with the API rather than reshaping them here.

struct Venue: Codable, Hashable, Sendable {
    let name: String
    let city: String
    let country: String
}

struct EventImageVariants: Codable, Hashable, Sendable {
    let thumb: String?
    let cardSmall: String?
    let card: String?
    let bannerSmall: String?
    let banner: String?

    enum CodingKeys: String, CodingKey {
        case thumb, card, banner
        case cardSmall = "card-sm"
        case bannerSmall = "banner-sm"
    }
}

enum EventImageUse: Sendable { case card, banner, thumb }

/// Events carry a picture as server paths. Same preference order as the Expo app
/// (features/events/event-image.ts): the cut for the use, then the original upload.
protocol HasEventImage {
    var imagePath: String? { get }
    var imageVariants: EventImageVariants? { get }
}

extension HasEventImage {
    func imageURL(for use: EventImageUse, base: URL?) -> URL? {
        let candidates: [String?] = switch use {
        case .card: [imageVariants?.card, imageVariants?.cardSmall]
        case .banner: [imageVariants?.banner, imageVariants?.bannerSmall]
        case .thumb: [imageVariants?.thumb, imageVariants?.cardSmall]
        }
        guard let path = (candidates + [imagePath]).compactMap({ $0 }).first(where: { !$0.isEmpty })
        else { return nil }
        if path.hasPrefix("http://") || path.hasPrefix("https://") { return URL(string: path) }
        guard let base else { return nil }
        return URL(string: base.absoluteString + (path.hasPrefix("/") ? path : "/" + path))
    }
}

struct EventSummary: Codable, Hashable, Identifiable, Sendable, HasEventImage {
    let id: String
    let title: String
    let slug: String
    let category: String
    let venue: Venue
    let organizer: String
    let nextSessionAt: Date?
    let fromPriceMinor: Int?
    let currency: String
    let imagePath: String?
    let imageVariants: EventImageVariants?
}

struct MovieSummary: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    let slug: String
    let posterUrl: String?
    let certificate: String?
    let language: String?
    let genres: [String]
    let runtimeMinutes: Int?
}

/// GET /public/discovery
struct DiscoveryFeed: Codable, Hashable, Sendable {
    let nowShowing: [MovieSummary]
    let trendingEvents: [EventSummary]
    let thisWeekend: [EventSummary]
    let categories: [String]
}

struct PageMeta: Codable, Hashable, Sendable {
    let page: Int
    let pageSize: Int
    let total: Int
    let totalPages: Int
}

/// The API's pagination envelope (packages/shared-types/src/api.ts).
struct Page<Item: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
    let data: [Item]
    let meta: PageMeta
}

struct TicketTypeOption: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let priceMinor: Int
    let currency: String
    let maxPerOrder: Int
    let available: Int
}

struct EventSession: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let startsAt: Date
    let endsAt: Date
    let status: String
    let seatBased: Bool?
    let ticketTypes: [TicketTypeOption]
}

/// GET /public/events/:slug
struct EventDetail: Codable, Hashable, Identifiable, Sendable, HasEventImage {
    struct DetailVenue: Codable, Hashable, Sendable {
        let id: String
        let name: String
        let city: String
        let country: String
        let address: String?
    }

    struct Organizer: Codable, Hashable, Sendable {
        let id: String
        let name: String
    }

    let id: String
    let title: String
    let slug: String
    let experienceType: String
    let category: String
    let description: String?
    let refundPolicy: String?
    let feeMode: String
    let venue: DetailVenue
    let organizer: Organizer
    let sessions: [EventSession]
    let imagePath: String?
    let imageVariants: EventImageVariants?
}

struct Movie: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    let slug: String
    let synopsis: String?
    let runtimeMinutes: Int
    let certificate: String?
    let language: String
    let genres: [String]
    let releaseDate: String?
    let posterUrl: String?
    let trailerUrl: String?
    let cast: [String]
    let director: String?
}

struct MovieShow: Codable, Hashable, Identifiable, Sendable {
    struct ShowVenue: Codable, Hashable, Sendable {
        let id: String
        let name: String
        let city: String
        let country: String
    }

    struct Cinema: Codable, Hashable, Sendable {
        let id: String
        let name: String
        let brand: String?
    }

    struct Screen: Codable, Hashable, Sendable {
        let id: String
        let name: String
    }

    let sessionId: String
    let eventId: String
    let eventSlug: String
    let startsAt: Date
    let endsAt: Date
    let venue: ShowVenue
    let cinema: Cinema?
    let screen: Screen?
    let format: String?
    let language: String
    let currency: String
    let fromPriceMinor: Int?
    let seatingType: String
    let availability: String
    let seatsAvailable: Int?
    let seatsTotal: Int?

    var id: String { sessionId }
}

/// GET /public/movies/:slug/shows
struct MovieShows: Codable, Hashable, Sendable {
    let movie: Movie
    let shows: [MovieShow]
}

/// GET /tickets
struct Ticket: Codable, Hashable, Identifiable, Sendable {
    struct TicketEvent: Codable, Hashable, Sendable {
        let title: String
        let slug: String
    }

    let id: String
    let serial: String
    let status: String
    let holderName: String?
    let ticketType: String
    let event: TicketEvent
    let startsAt: Date
    /// Optional on purpose: tickets.service.ts withholds the presentable value from a viewer
    /// who may see a ticket but not present it.
    let qrToken: String?
    /// The server-rendered code (PNG data URL). The only thing the app shows at the gate: the
    /// server decides what is presentable (it may be a vendor barcode), so the app never
    /// builds a code from the token itself.
    let qrDataUrl: String?
    let bookingId: String
    let bookingRef: String?
    let experienceType: String
    let seatLabel: String?
    let venueName: String?
    let screenName: String?
    let cinemaName: String?
    let assignmentStatus: String
    let attendeeName: String?
    let ownedByViewer: Bool
    let assignedToViewer: Bool
}

/// GET /auth/me — `AuthenticatedUser` in packages/shared-types/src/api.ts.
struct AuthenticatedUser: Codable, Hashable, Sendable {
    let id: String
    let email: String
    let fullName: String
    let roles: [String]
    let organizationId: String?
}
