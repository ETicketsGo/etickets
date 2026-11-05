# ETicketsGo: Data Model (as built)

Status: current reference, generated 2026-11-01 from `apps/api/prisma/schema.prisma` on `main`
(`d5144d3f`). Audience: solution architects and senior engineers.

| Fact                     | Value (from the repository)                                                  |
| ------------------------ | ---------------------------------------------------------------------------- |
| Prisma models            | **139** (`grep -c '^model ' apps/api/prisma/schema.prisma`)                  |
| Prisma enums             | **104** (`grep -c '^enum ' apps/api/prisma/schema.prisma`)                   |
| Migrations               | **151** folders in `apps/api/prisma/migrations` (plus `migration_lock.toml`) |
| First / latest migration | `20260712080238_init` / `20261030100000_fee_schedule_drafts`                 |
| Database                 | PostgreSQL, accessed only through Prisma 5 (`apps/api/src/prisma`)           |
| Money                    | Integer minor units (`*Minor` columns) plus an ISO `currency` column         |

How to read the diagrams:

- A small script that reads the schema generated the diagrams. They show primary keys, foreign
  keys (fields named in a Prisma `@relation(fields: [...])`), unique keys, and the important
  status, money, currency and version columns. They do not show every column (at most 16 per
  model).
- `"logical ref, no FK"` marks a scalar id column (for example `organizationId`) that has **no**
  Prisma relation and so **no database foreign key**. Several newer domains (billing, growth,
  CRM, finance ledgers) do this on purpose. Service code enforces these references.
- A relationship to a model in another domain is drawn only when the target is a hub (`User`,
  `Organization`, `Event`, `EventSession`, `Booking`, `Payment`, `Refund`, `Settlement`,
  `Ticket`, `Venue`, `Screen`). The hub then shows as an empty box in that diagram.
- `||--o{` means one parent to zero or more children. `|o` on the parent side means the
  foreign key can be null. `o|` on the child side means the foreign key is unique (one-to-one).
- To check a claim: `npx prisma validate --schema apps/api/prisma/schema.prisma`, then read the
  model with `grep -n -A40 '^model <Name> {' apps/api/prisma/schema.prisma`.

Related: [ARCHITECTURE](ARCHITECTURE.md) · [FLOWS](FLOWS.md) ·
[BOOKING-STATE-TRANSITION-MATRIX](BOOKING-STATE-TRANSITION-MATRIX.md) ·
[EVENT-CATALOGUE](EVENT-CATALOGUE.md) · [REVIEW-GUIDE](REVIEW-GUIDE.md)

## 1. Domain diagrams

Each of the 139 models is in exactly one domain below. The generator fails if a model is
missing or listed twice.

### Identity and access

Models (12): `User`, `AccountInvitation`, `PhoneOtp`, `PasswordResetToken`, `AuthHandoff`, `EmailVerificationCode`, `RefreshToken`, `RefreshTokenMfa`, `AdminMfaCredential`, `AdminMfaRecoveryCode`, `AdminMfaBreakGlassUse`, `AdminGrant`.

```mermaid
erDiagram
  User ||--o| AccountInvitation : "user"
  User ||--o{ AccountInvitation : "invitedBy"
  User ||--o{ PasswordResetToken : "user"
  User ||--o{ AuthHandoff : "user"
  User ||--o{ EmailVerificationCode : "user"
  User ||--o{ RefreshToken : "user"
  RefreshToken ||--o{ RefreshTokenMfa : "refreshToken"
  User ||--o| AdminMfaCredential : "user"
  User ||--o{ AdminMfaRecoveryCode : "user"
  User ||--o{ AdminGrant : "user"
  User |o--o{ AdminGrant : "grantedBy"
  User {
    String id PK
    UserStatus status
    String countryOfResidence
  }
  AccountInvitation {
    String id PK
    String userId FK,UK
    String organizationMemberId FK,UK
    String invitedByUserId FK
  }
  PhoneOtp {
    String id PK
    String provider
    String deliveryStatus
  }
  PasswordResetToken {
    String id PK
    String userId FK
  }
  AuthHandoff {
    String id PK
    String userId FK
  }
  EmailVerificationCode {
    String id PK
    String userId FK
  }
  RefreshToken {
    String id PK
    String userId FK
  }
  RefreshTokenMfa {
    String refreshTokenId PK,FK
  }
  AdminMfaCredential {
    String id PK
    String userId FK,UK
  }
  AdminMfaRecoveryCode {
    String id PK
    String userId FK
  }
  AdminMfaBreakGlassUse {
    String id PK
    String userId "logical ref, no FK"
  }
  AdminGrant {
    String id PK
    String userId FK
    String grantedByUserId FK
  }
```

### Organizations and venues

Models (7): `Organization`, `OrganizationMember`, `OrganizationImage`, `Venue`, `VenueArea`, `Cinema`, `Screen`.

```mermaid
erDiagram
  Organization ||--o{ OrganizationMember : "organization"
  User ||--o{ OrganizationMember : "user"
  Organization ||--o{ OrganizationImage : "organization"
  Organization ||--o{ Venue : "organization"
  Venue ||--o{ VenueArea : "venue"
  Organization ||--o{ Cinema : "organization"
  Venue |o--o{ Cinema : "venue"
  Venue |o--o{ Screen : "venue"
  Cinema |o--o{ Screen : "cinema"
  Organization {
    String id PK
    OrganizationStatus status
  }
  OrganizationMember {
    String id PK
    String organizationId FK
    String userId FK
    Role role
    MemberStatus status
  }
  OrganizationImage {
    String id PK
    String organizationId FK
    String kind
  }
  Venue {
    String id PK
    String organizationId FK
    String country
    String status
  }
  VenueArea {
    String id PK
    String venueId FK
  }
  Cinema {
    String id PK
    String organizationId FK
    String venueId FK
    String status
    String country
  }
  Screen {
    String id PK
    String venueId FK
    String cinemaId FK
    ScreenStatus status
    SpaceKind kind
  }
```

### Events and sessions

Models (13): `Event`, `EventImage`, `EventImageVariant`, `StoredObject`, `Movie`, `Review`, `EventSession`, `TicketType`, `TicketInventory`, `AddOn`, `AddOnInventory`, `Bundle`, `BundleItem`.

```mermaid
erDiagram
  Organization ||--o{ Event : "organization"
  Venue ||--o{ Event : "venue"
  Movie |o--o{ Event : "movie"
  Event ||--o{ EventImage : "event"
  EventImage ||--o{ EventImageVariant : "image"
  Organization ||--o{ Movie : "organization"
  Event ||--o{ Review : "event"
  User ||--o{ Review : "user"
  Event ||--o{ EventSession : "event"
  Screen |o--o{ EventSession : "screen"
  Screen |o--o{ EventSession : "standingSpace"
  EventSession ||--o{ TicketType : "eventSession"
  TicketType ||--o| TicketInventory : "ticketType"
  Event ||--o{ AddOn : "event"
  AddOn ||--o| AddOnInventory : "addOn"
  Event ||--o{ Bundle : "event"
  Bundle ||--o{ BundleItem : "bundle"
  TicketType |o--o{ BundleItem : "ticketType"
  AddOn |o--o{ BundleItem : "addOn"
  Event {
    String id PK
    String organizationId FK
    String venueId FK
    String movieId FK
    EventStatus status
  }
  EventImage {
    String id PK
    String eventId FK
  }
  EventImageVariant {
    String id PK
    String imageId FK
  }
  StoredObject {
    String key PK
  }
  Movie {
    String id PK
    String organizationId FK
    MovieStatus status
  }
  Review {
    String id PK
    String eventId FK
    String userId FK
  }
  EventSession {
    String id PK
    String eventId FK
    String screenId FK
    String seatMapId FK
    String standingSpaceId FK
    SessionStatus status
  }
  TicketType {
    String id PK
    String eventSessionId FK
    String seatCategoryId FK
    String seatZoneId FK
    Int priceMinor
    String currency
    String status
  }
  TicketInventory {
    String id PK
    String ticketTypeId FK,UK
    Int version
  }
  AddOn {
    String id PK
    String eventId FK
    AddOnType type
    Int priceMinor
    String currency
  }
  AddOnInventory {
    String id PK
    String addOnId FK,UK
    Int version
  }
  Bundle {
    String id PK
    String eventId FK
    BundleType type
    String currency
    Int priceMinor
  }
  BundleItem {
    String id PK
    String bundleId FK
    String ticketTypeId FK
    String addOnId FK
  }
```

### Seating

Models (8): `SeatMap`, `SeatCategory`, `SeatSection`, `SeatRow`, `Seat`, `ShowSeat`, `SeatZone`, `ShowZone`.

```mermaid
erDiagram
  Screen ||--o{ SeatMap : "screen"
  SeatMap |o--o{ SeatMap : "clonedFrom"
  SeatMap ||--o{ SeatCategory : "seatMap"
  SeatMap ||--o{ SeatSection : "seatMap"
  SeatSection ||--o{ SeatRow : "section"
  SeatMap ||--o{ Seat : "seatMap"
  SeatRow ||--o{ Seat : "row"
  SeatCategory ||--o{ Seat : "seatCategory"
  EventSession ||--o{ ShowSeat : "eventSession"
  Seat ||--o{ ShowSeat : "seat"
  Booking |o--o{ ShowSeat : "holdBooking"
  User |o--o{ ShowSeat : "overrideBy"
  SeatMap ||--o{ SeatZone : "seatMap"
  SeatCategory |o--o{ SeatZone : "category"
  EventSession ||--o{ ShowZone : "eventSession"
  SeatZone ||--o{ ShowZone : "zone"
  SeatMap {
    String id PK
    String screenId FK
    Int version
    SeatLayoutStatus status
    String clonedFromId FK
  }
  SeatCategory {
    String id PK
    String seatMapId FK
    Int basePriceMinor
  }
  SeatSection {
    String id PK
    String seatMapId FK
  }
  SeatRow {
    String id PK
    String sectionId FK
  }
  Seat {
    String id PK
    String seatMapId FK
    String rowId FK
    String seatCategoryId FK
    String kind
  }
  ShowSeat {
    String id PK
    String eventSessionId FK
    String seatId FK
    String status
    String holdBookingId FK
    Int version
    String overrideByUserId FK
  }
  SeatZone {
    String id PK
    String seatMapId FK
    String categoryId FK
  }
  ShowZone {
    String id PK
    String eventSessionId FK
    String zoneId FK
    Int version
  }
```

### External inventory sourcing and sync

Models (4): `ProviderMapping`, `ProviderSyncCheckpoint`, `ProviderInventoryState`, `RawProviderEvent`.

```mermaid
erDiagram
  ProviderMapping {
    String id PK
    ProviderMappingStatus status
  }
  ProviderSyncCheckpoint {
    String id PK
  }
  ProviderInventoryState {
    String id PK
    Int version
  }
  RawProviderEvent {
    String id PK
    String signatureStatus
    SyncEventStatus processingStatus
  }
```

### Pricing, fees and tax

Models (9): `FeeRule`, `FeeScheduleDraft`, `PlatformFeePolicy`, `PlatformFeePolicyEvent`, `Coupon`, `TaxRule`, `BookingTaxLine`, `CinemaPricingPolicy`, `RegulatoryDocument`.

```mermaid
erDiagram
  PlatformFeePolicy ||--o{ PlatformFeePolicyEvent : "policy"
  Booking ||--o{ BookingTaxLine : "booking"
  CinemaPricingPolicy |o--o| CinemaPricingPolicy : "supersedes"
  RegulatoryDocument |o--o{ CinemaPricingPolicy : "regulatoryDocument"
  FeeRule {
    String id PK
    Int minMinor
    Int maxMinor
    Int feeMinor
    String currency
    Int minFeeMinor
    Int maxFeeMinor
    String country
  }
  FeeScheduleDraft {
    String id PK
    String currency
    FeeScheduleDraftStatus status
    Int version
  }
  PlatformFeePolicy {
    String id PK
    PlatformFeePolicyScope scope
    String eventId "logical ref, no FK"
    String organizationId "logical ref, no FK"
    PlatformFeePolicyKind kind
    Int feeMinor
    Int minFeeMinor
    Int maxFeeMinor
    String currency
    PlatformFeePolicyStatus status
    Int version
  }
  PlatformFeePolicyEvent {
    String id PK
    String policyId FK
  }
  Coupon {
    String id PK
    String organizationId "logical ref, no FK"
    String code UK
    CouponType type
    String status
    String currency
  }
  TaxRule {
    String id PK
    String country
    String currency
    Int minUnitMinor
    Int maxUnitMinor
  }
  BookingTaxLine {
    String id PK
    String bookingId FK
    Int baseMinor
    Int amountMinor
  }
  CinemaPricingPolicy {
    String id PK
    Int version
    String country
    String currency
    Int maintenanceChargeMinor
    Int onlineFeeCapMinor
    Int ticketPriceMinMinor
    Int ticketPriceMaxMinor
    CinemaPricingPolicyStatus status
    String supersedesId FK,UK
    String regulatoryDocumentId FK
  }
  RegulatoryDocument {
    String id PK
    String reference UK
    String country
  }
```

### Bookings, tickets and check-in

Models (18): `Booking`, `BookingItem`, `GuestBookingAccess`, `BookingReferenceCounter`, `ReadableReferenceCounter`, `BookingWorkflow`, `BookingCompensation`, `Ticket`, `TicketInvite`, `Receipt`, `ReceiptCounter`, `CheckIn`, `CheckInDevice`, `CheckInManifest`, `OfflineActivation`, `OfflineDrillRun`, `OfflineReconciliationRecord`, `OfflineAlertAck`.

```mermaid
erDiagram
  Event ||--o{ Booking : "event"
  EventSession ||--o{ Booking : "eventSession"
  User |o--o{ Booking : "user"
  User |o--o{ Booking : "cashCollectedBy"
  User |o--o{ Booking : "cashReturnedBy"
  Booking ||--o{ BookingItem : "booking"
  Booking ||--o{ GuestBookingAccess : "booking"
  Booking ||--o{ Ticket : "booking"
  EventSession ||--o{ Ticket : "eventSession"
  User |o--o{ Ticket : "attendeeUser"
  Ticket ||--o{ TicketInvite : "ticket"
  Organization ||--o{ Receipt : "organization"
  Booking ||--o{ Receipt : "booking"
  Refund |o--o| Receipt : "refund"
  Receipt |o--o{ Receipt : "reverses"
  Ticket ||--o{ CheckIn : "ticket"
  EventSession ||--o{ CheckIn : "eventSession"
  User |o--o{ CheckIn : "by"
  Booking {
    String id PK
    String organizationId "logical ref, no FK"
    String eventId FK
    String eventSessionId FK
    String userId FK
    String couponId FK
    String reference UK
    BookingStatus status
    String cashCollectedByUserId FK
    String cashReturnedByUserId FK
    String currency
    Int subtotalMinor
    Int bookingFeeMinor
    Int paymentFeeMinor
    Int discountMinor
    Int customerFeeMinor
  }
  BookingItem {
    String id PK
    String bookingId FK
    BookingItemKind kind
    String ticketTypeId FK
    String addOnId FK
    String bundleId FK
    Int unitPriceMinor
    Int lineTotalMinor
  }
  GuestBookingAccess {
    String id PK
    String bookingId FK
  }
  BookingReferenceCounter {
    String scope PK
  }
  ReadableReferenceCounter {
    String scope PK
  }
  BookingWorkflow {
    String id PK
    String bookingId UK "logical ref, no FK"
    BookingWorkflowState state
    Int version
    String providerStatus
    String allocationAccountingState
  }
  BookingCompensation {
    String id PK
    String bookingId "logical ref, no FK"
    CompensationState state
    Int version
    Int amountMinor
    String currency
  }
  Ticket {
    String id PK
    String bookingId FK
    String ticketTypeId FK
    String eventSessionId FK
    String organizationId "logical ref, no FK"
    TicketStatus status
    String seatId FK
    AttendeeAssignmentStatus assignmentStatus
    String attendeeUserId FK
  }
  TicketInvite {
    String id PK
    String ticketId FK
    String organizationId "logical ref, no FK"
    TicketInviteKind kind
    TicketInviteStatus status
  }
  Receipt {
    String id PK
    ReceiptKind kind
    String organizationId FK
    String bookingId FK
    String refundId FK,UK
    String reversesId FK
    String currency
    Int subtotalMinor
    Int discountMinor
    Int feeMinor
    Int taxMinor
    Int totalMinor
  }
  ReceiptCounter {
    String scope PK
  }
  CheckIn {
    String id PK
    String ticketId FK
    String eventSessionId FK
    String byUserId FK
  }
  CheckInDevice {
    String id PK
    String organizationId "logical ref, no FK"
    String eventId "logical ref, no FK"
    CheckInDeviceStatus status
  }
  CheckInManifest {
    String id PK
    String organizationId "logical ref, no FK"
    String eventId "logical ref, no FK"
    Int version
  }
  OfflineActivation {
    String id PK
    String organizationId "logical ref, no FK"
    String eventId "logical ref, no FK"
    OfflineActivationState state
  }
  OfflineDrillRun {
    String id PK
    String organizationId "logical ref, no FK"
    String eventId "logical ref, no FK"
  }
  OfflineReconciliationRecord {
    String id PK
    String organizationId "logical ref, no FK"
    String eventId "logical ref, no FK"
    String ticketId "logical ref, no FK"
    ReconcileReviewState reviewState
  }
  OfflineAlertAck {
    String id PK
    String organizationId "logical ref, no FK"
  }
```

### Payments, refunds and disputes

Models (12): `Payment`, `PaymentAttempt`, `Refund`, `RefundProviderAttempt`, `Dispute`, `PaymentProviderConfig`, `PaymentRoute`, `MerchantAccount`, `MerchantOnboarding`, `MerchantCertification`, `PromotionRequest`, `ReconciliationDiscrepancy`.

```mermaid
erDiagram
  Booking ||--o| Payment : "booking"
  Settlement |o--o{ Payment : "settlement"
  Payment ||--o{ PaymentAttempt : "payment"
  Booking ||--o{ Refund : "booking"
  Organization ||--o{ Refund : "organization"
  Refund ||--o{ RefundProviderAttempt : "refund"
  Payment |o--o{ Dispute : "payment"
  Organization |o--o{ Dispute : "organization"
  PaymentProviderConfig ||--o{ MerchantAccount : "config"
  Organization |o--o{ MerchantOnboarding : "organization"
  Payment {
    String id PK
    String bookingId FK,UK
    String provider
    PaymentStatus status
    Int amountMinor
    String currency
    String providerStatus
    Int subtotalMinor
    Int taxMinor
    Int platformFeeMinor
    Int processingFeeMinor
    Int organizerNetMinor
    Int refundedMinor
    String settlementId FK
  }
  PaymentAttempt {
    String id PK
    String paymentId FK
    PaymentAttemptStatus status
  }
  Refund {
    String id PK
    String bookingId FK
    String organizationId FK
    Int amountMinor
    Int taxMinor
    Int taxAddedMinor
    Int platformFeeRefundedMinor
    RefundStatus status
  }
  RefundProviderAttempt {
    String id PK
    String refundId FK
  }
  Dispute {
    String id PK
    String provider
    String paymentId FK
    String bookingId "logical ref, no FK"
    String organizationId FK
    String eventId "logical ref, no FK"
    Int amountMinor
    String currency
    DisputeStatus status
    String stripeStatus
  }
  PaymentProviderConfig {
    String id PK
    PaymentEnv env
    String provider
    PaymentProviderMode mode
  }
  PaymentRoute {
    String id PK
    PaymentEnv env
    String country
    String currency
    String provider
  }
  MerchantAccount {
    String id PK
    String configId FK
    String country
    String currency
  }
  MerchantOnboarding {
    String id PK
    PaymentEnv env
    String organizationId FK
    String country
    String provider
    PaymentProviderMode mode
    String webhookEndpointStatus
    String verificationStatus
    MerchantOnboardingStatus status
  }
  MerchantCertification {
    String id PK
    PaymentEnv env
    String provider
  }
  PromotionRequest {
    String id PK
    String provider
    PromotionStatus status
  }
  ReconciliationDiscrepancy {
    String id PK
    PaymentEnv env
    DiscrepancyType type
    String provider
    Int amountMinor
    String currency
    DiscrepancyStatus status
  }
```

### Settlements, payouts and allocations

Models (10): `Settlement`, `SettlementTransferAttempt`, `SettlementReversalAttempt`, `SettlementReconciliationFinding`, `PayoutAllocation`, `Payout`, `PayoutSetting`, `OrganizerPaymentAccount`, `OrganizerPayoutAccount`, `OrganizerPayoutAccountVersion`.

```mermaid
erDiagram
  Organization ||--o{ Settlement : "organization"
  Event ||--o{ Settlement : "event"
  OrganizerPaymentAccount |o--o{ Settlement : "account"
  Settlement ||--o{ SettlementTransferAttempt : "settlement"
  Settlement ||--o{ SettlementReversalAttempt : "settlement"
  SettlementReversalAttempt |o--o| SettlementReversalAttempt : "supersedes"
  Settlement ||--o{ SettlementReconciliationFinding : "settlement"
  SettlementTransferAttempt ||--o{ SettlementReconciliationFinding : "transferAttempt"
  Payout ||--o{ PayoutAllocation : "payout"
  Organization ||--o{ Payout : "organization"
  Organization |o--o| PayoutSetting : "organization"
  User |o--o{ PayoutSetting : "updatedBy"
  Organization ||--o{ OrganizerPaymentAccount : "organization"
  Organization ||--o{ OrganizerPayoutAccount : "organization"
  OrganizerPayoutAccount ||--o{ OrganizerPayoutAccountVersion : "account"
  Settlement {
    String id PK
    String organizationId FK
    String eventId FK
    String accountId FK
    String provider
    String currency
    Int grossSalesMinor
    Int refundsMinor
    Int disputesMinor
    Int platformFeesMinor
    Int reserveMinor
    Int payableMinor
    Int transferredMinor
    Int releasedMinor
    SettlementStatus status
  }
  SettlementTransferAttempt {
    String id PK
    String settlementId FK
    Int requestedMinor
    String currency
    String provider
    SettlementTransferStatus status
    String providerStatusRaw
  }
  SettlementReversalAttempt {
    String id PK
    String settlementId FK
    String refundId "logical ref, no FK"
    Int requestedMinor
    String currency
    String provider
    SettlementReversalStatus status
    Int confirmedMinor
    String providerStatusRaw
    String supersedesId FK,UK
  }
  SettlementReconciliationFinding {
    String id PK
    String settlementId FK
    String organizationId "logical ref, no FK"
    String transferAttemptId FK
    SettlementFindingKind kind
    SettlementFindingStatus status
    String localStatus
    Int localAmountMinor
    Int providerAmountMinor
    String providerStatusRaw
  }
  PayoutAllocation {
    String id PK
    String payoutId FK
    String bookingId "logical ref, no FK"
    String eventId "logical ref, no FK"
    String currency
    Int allocatedNetMinor
    Int subtotalMinor
    Int discountMinor
    Int organizerFeeMinor
    Int refundShareMinor
    Int bookingFeeMinor
    Int paymentFeeMinor
  }
  Payout {
    String id PK
    String organizationId FK
    String eventId "logical ref, no FK"
    Int grossMinor
    Int bookingFeeMinor
    Int paymentFeeMinor
    Int refundMinor
    Int netMinor
    String currency
    PayoutStatus status
  }
  PayoutSetting {
    String id PK
    String organizationId FK,UK
    String updatedByUserId FK
  }
  OrganizerPaymentAccount {
    String id PK
    String organizationId FK
    String provider
    ConnectOnboardingStatus onboardingStatus
    String country
  }
  OrganizerPayoutAccount {
    String id PK
    String organizationId FK
    String currency
    Int version
  }
  OrganizerPayoutAccountVersion {
    String id PK
    String accountId FK
    String organizationId "logical ref, no FK"
    String currency
    Int version
    PayoutAccountVersionStatus status
  }
```

### Notifications, consent and suppression

Models (10): `Notification`, `NotificationDelivery`, `NotificationPreference`, `NotificationRate`, `NotificationCertification`, `SnsPendingConfirmation`, `SuppressedDestination`, `MarketingConsent`, `UserDevice`, `PushSubscription`.

```mermaid
erDiagram
  User |o--o{ Notification : "user"
  Notification ||--o{ NotificationDelivery : "notification"
  User ||--o{ NotificationPreference : "user"
  User |o--o{ NotificationCertification : "certifiedBy"
  User |o--o{ MarketingConsent : "user"
  User ||--o{ UserDevice : "user"
  User ||--o{ PushSubscription : "user"
  Notification {
    String id PK
    String userId FK
    NotificationType type
    String status
    String provider
    String bookingId "logical ref, no FK"
  }
  NotificationDelivery {
    String id PK
    String notificationId FK
    String provider
    String status
    String providerStatus
  }
  NotificationPreference {
    String id PK
    String userId FK
    NotificationType type
  }
  NotificationRate {
    String id PK
    String provider
    String country
    String currency
  }
  NotificationCertification {
    String id PK
    String provider
    String market
    String state
    String certifiedByUserId FK
  }
  SnsPendingConfirmation {
    String id PK
    SnsConfirmationStatus status
  }
  SuppressedDestination {
    String id PK
    String scope
    String provider
  }
  MarketingConsent {
    String id PK
    String userId FK
    String country
  }
  UserDevice {
    String id PK
    String userId FK
    String provider
    String permissionStatus
  }
  PushSubscription {
    String id PK
    String userId FK
  }
```

### Growth: follows, audience and campaigns

Models (10): `OrganizerFollow`, `OrganizerNotificationPreference`, `CommunicationConsent`, `OrganizerSuppression`, `SavedSegment`, `Campaign`, `CampaignRecipient`, `CampaignEvent`, `CampaignLink`, `CampaignClick`.

```mermaid
erDiagram
  User ||--o{ OrganizerFollow : "user"
  Organization ||--o{ OrganizerFollow : "organization"
  User ||--o{ OrganizerNotificationPreference : "user"
  Organization ||--o{ OrganizerNotificationPreference : "organization"
  User |o--o{ CommunicationConsent : "user"
  OrganizerFollow {
    String id PK
    String userId FK
    String organizationId FK
  }
  OrganizerNotificationPreference {
    String id PK
    String userId FK
    String organizationId FK
  }
  CommunicationConsent {
    String id PK
    String userId FK
    String organizationId "logical ref, no FK"
  }
  OrganizerSuppression {
    String id PK
    String organizationId "logical ref, no FK"
  }
  SavedSegment {
    String id PK
    String organizationId "logical ref, no FK"
  }
  Campaign {
    String id PK
    String organizationId "logical ref, no FK"
    String eventId "logical ref, no FK"
    CampaignStatus status
    Int version
  }
  CampaignRecipient {
    String id PK
    String campaignId "logical ref, no FK"
    String organizationId "logical ref, no FK"
    String userId "logical ref, no FK"
    CampaignRecipientStatus status
    String provider
  }
  CampaignEvent {
    String id PK
    String campaignId "logical ref, no FK"
    String type
  }
  CampaignLink {
    String id PK
    String campaignId "logical ref, no FK"
  }
  CampaignClick {
    String id PK
    String campaignId "logical ref, no FK"
  }
```

### Organizer billing

Models (13): `BillingPlan`, `BillingPrice`, `PlanEntitlement`, `EntitlementOverride`, `OrganizerBillingAccount`, `OrganizerSubscription`, `OrganizerInvoice`, `BillingPayment`, `BillingAdjustment`, `BillingWebhookEvent`, `UsageLedger`, `CreditPackPrice`, `CreditPackPurchase`.

```mermaid
erDiagram
  BillingPlan ||--o{ BillingPrice : "plan"
  BillingPlan ||--o{ PlanEntitlement : "plan"
  OrganizerBillingAccount ||--o{ OrganizerSubscription : "account"
  BillingPlan ||--o{ OrganizerSubscription : "plan"
  BillingPrice |o--o{ OrganizerSubscription : "price"
  BillingPlan |o--o{ OrganizerSubscription : "scheduledPlan"
  OrganizerBillingAccount ||--o{ OrganizerInvoice : "account"
  OrganizerSubscription |o--o{ OrganizerInvoice : "subscription"
  OrganizerBillingAccount ||--o{ BillingPayment : "account"
  OrganizerInvoice |o--o{ BillingPayment : "invoice"
  OrganizerBillingAccount ||--o{ BillingAdjustment : "account"
  OrganizerInvoice |o--o{ BillingAdjustment : "invoice"
  OrganizerSubscription |o--o{ BillingAdjustment : "subscription"
  BillingPlan {
    String id PK
    BillingPlanCode code UK
  }
  BillingPrice {
    String id PK
    String planId FK
    String country
    String currency
    Int amountMinor
  }
  PlanEntitlement {
    String id PK
    String planId FK
    String key
  }
  EntitlementOverride {
    String id PK
    String organizationId "logical ref, no FK"
    String key
  }
  OrganizerBillingAccount {
    String id PK
    String organizationId UK "logical ref, no FK"
    String country
    String currency
    BillingProviderName provider
  }
  OrganizerSubscription {
    String id PK
    String accountId FK
    String planId FK
    String priceId FK
    OrganizerSubscriptionStatus status
    String scheduledPlanId FK
    Int version
  }
  OrganizerInvoice {
    String id PK
    String accountId FK
    String subscriptionId FK
    OrganizerInvoiceStatus status
    Int subtotalMinor
    Int taxMinor
    Int totalMinor
    String currency
    BillingProviderName provider
  }
  BillingPayment {
    String id PK
    String accountId FK
    String invoiceId FK
    BillingProviderName provider
    Int amountMinor
    String currency
    BillingPaymentStatus status
    Int taxMinor
  }
  BillingAdjustment {
    String id PK
    String accountId FK
    BillingAdjustmentKind kind
    String invoiceId FK
    String subscriptionId FK
    Int amountMinor
    String currency
  }
  BillingWebhookEvent {
    String id PK
    BillingProviderName provider
    BillingWebhookStatus status
    String accountId "logical ref, no FK"
  }
  UsageLedger {
    String id PK
    String organizationId "logical ref, no FK"
    String key
  }
  CreditPackPrice {
    String id PK
    String country
    String currency
    Int amountMinor
    Int version
  }
  CreditPackPurchase {
    String id PK
    String organizationId "logical ref, no FK"
    String accountId "logical ref, no FK"
    String country
    String currency
    Int netMinor
    Int taxMinor
    Int totalMinor
    BillingProviderName provider
    String status
  }
```

### CRM, admin and audit

Models (9): `CrmTeam`, `CrmTeamMember`, `CrmLead`, `CrmLeadStageChange`, `CrmActivity`, `CrmFollowUp`, `AuditLog`, `Feedback`, `AiUsage`.

```mermaid
erDiagram
  CrmTeam ||--o{ CrmTeamMember : "team"
  User ||--o{ CrmTeamMember : "user"
  CrmTeam ||--o{ CrmLead : "team"
  User |o--o{ CrmLead : "assignedTo"
  User |o--o{ CrmLead : "createdBy"
  Organization |o--o| CrmLead : "organization"
  CrmLead ||--o{ CrmLeadStageChange : "lead"
  User |o--o{ CrmLeadStageChange : "changedBy"
  CrmLead ||--o{ CrmActivity : "lead"
  User ||--o{ CrmActivity : "responsible"
  CrmLead ||--o{ CrmFollowUp : "lead"
  User ||--o{ CrmFollowUp : "owner"
  User |o--o{ AuditLog : "actor"
  User |o--o{ Feedback : "user"
  CrmTeam {
    String id PK
    String key UK
    String country
  }
  CrmTeamMember {
    String id PK
    String teamId FK
    String userId FK
    CrmTeamRole role
  }
  CrmLead {
    String id PK
    String teamId FK
    String country
    String state
    String assignedToUserId FK
    String createdByUserId FK
    String organizationId FK,UK
    Int version
  }
  CrmLeadStageChange {
    String id PK
    String leadId FK
    String changedByUserId FK
  }
  CrmActivity {
    String id PK
    String leadId FK
    CrmActivityType type
    String responsibleUserId FK
  }
  CrmFollowUp {
    String id PK
    String leadId FK
    String ownerUserId FK
    CrmFollowUpStatus status
    Int version
  }
  AuditLog {
    String id PK
    String actorUserId FK
    String organizationId "logical ref, no FK"
  }
  Feedback {
    String id PK
    String reference UK
    FeedbackKind kind
    String userId FK
    String organizationId "logical ref, no FK"
    String bookingId "logical ref, no FK"
    String status
  }
  AiUsage {
    String id PK
    String provider
    String status
    Int costMinor
    String organizationId "logical ref, no FK"
  }
```

### Outbox, webhooks and idempotency

Models (4): `OutboxEvent`, `ProcessedDomainEvent`, `WebhookEvent`, `IdempotencyRecord`.

```mermaid
erDiagram
  OutboxEvent {
    String id PK
    String eventId UK "logical ref, no FK"
    OutboxStatus status
  }
  ProcessedDomainEvent {
    String id PK
    String eventId "logical ref, no FK"
    HandlerDeliveryStatus status
  }
  WebhookEvent {
    String id PK
    String provider
    WebhookProcessingStatus processingStatus
  }
  IdempotencyRecord {
    String id PK
    String scope
    String key
    String status
  }
```

## 2. Key state machines

Enum values are copied from `schema.prisma`. A state diagram is drawn only where the code holds
an explicit transition table or a pure transition function. Where the code has no table, the
services enforce the moves with guarded writes (`updateMany ... where: { status: <expected> }`),
and the section says so.

### 2.1 Booking (`BookingStatus`)

`PENDING_PAYMENT, CONFIRMED, PARTIALLY_REFUNDED, REFUNDED, CANCELLED, EXPIRED, DISPUTED`

There is no transition table for `BookingStatus`. Guarded writes in
`apps/api/src/bookings/bookings.service.ts`, `apps/api/src/payments/payments.service.ts` and
`apps/api/src/refunds/refunds.service.ts` enforce the moves. The internal orchestration
workflow (`BookingWorkflowState`, model `BookingWorkflow`) does have a table:
`apps/api/src/bookings/orchestration/booking-workflow.transitions.ts`, documented in
[BOOKING-STATE-TRANSITION-MATRIX](BOOKING-STATE-TRANSITION-MATRIX.md). The orchestrator is off
by default (`BOOKING_ORCHESTRATOR_ENABLED`, `BOOKING_ORCHESTRATOR_MODE=shadow`).

### 2.2 Payment (`PaymentStatus`) and refund (`RefundStatus`)

- `PaymentStatus`: `REQUIRES_PAYMENT, PROCESSING, AUTHORIZED, SUCCEEDED, FAILED, VOIDED, REFUNDED, PARTIALLY_REFUNDED`
- `PaymentAttemptStatus` tracks each provider attempt separately (model `PaymentAttempt`).
- `RefundStatus`: `REQUESTED, APPROVED, REJECTED, PROCESSING, COMPLETED, FAILED`
- `DisputeStatus`: `NEEDS_RESPONSE, UNDER_REVIEW, WON, LOST, WARNING_CLOSED, CLOSED`

There is no transition table for these. Guarded writes in the payment and refund services and
the webhook processor (`apps/api/src/payments/webhooks/`) enforce the moves. A refund is
claimed atomically before the provider is called, and each provider call is a
`RefundProviderAttempt` row.

### 2.3 Settlement (`SettlementStatus`)

Table: `SETTLEMENT_TRANSITIONS` in `packages/shared-types/src/marketplace.ts`.

```mermaid
stateDiagram-v2
  [*] --> PENDING
  PENDING --> HELD
  PENDING --> ELIGIBLE
  PENDING --> BLOCKED
  HELD --> ELIGIBLE
  HELD --> BLOCKED
  ELIGIBLE --> APPROVED
  ELIGIBLE --> BLOCKED
  ELIGIBLE --> HELD
  APPROVED --> TRANSFER_PROCESSING
  APPROVED --> BLOCKED
  TRANSFER_PROCESSING --> TRANSFERRED
  TRANSFER_PROCESSING --> FAILED
  TRANSFERRED --> PARTIALLY_REFUNDED
  TRANSFERRED --> REVERSED
  PARTIALLY_REFUNDED --> REVERSED
  BLOCKED --> ELIGIBLE
  BLOCKED --> HELD
  BLOCKED --> PENDING
  FAILED --> APPROVED
  FAILED --> BLOCKED
  REVERSED --> [*]
```

Unverified: no code path was found that writes `PARTIALLY_REFUNDED` or `REVERSED`. A refund
after transfer changes the amounts (`refundsMinor`, `transferredMinor`) and creates
`SettlementReversalAttempt` rows; the settlement status itself stays `TRANSFERRED`.

Only `APPROVED` and `FAILED` can be released (`isReleasableSettlementStatus`). The release
service also moves a claimed settlement to `BLOCKED` when a gate refuses (see
[FLOWS](FLOWS.md) section 8).

### 2.4 Settlement reversal (`SettlementReversalStatus`)

Table: `REVERSAL_TRANSITIONS` in `packages/shared-types/src/settlement-reversal.ts`.

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> PROCESSING
  REQUESTED --> COMPLETED
  REQUESTED --> FAILED
  REQUESTED --> UNKNOWN
  PROCESSING --> COMPLETED
  PROCESSING --> FAILED
  PROCESSING --> UNKNOWN
  UNKNOWN --> COMPLETED
  UNKNOWN --> FAILED
  COMPLETED --> [*]
  FAILED --> [*]
```

`SettlementTransferStatus` (`REQUESTED, SUCCEEDED, FAILED, UNKNOWN`) has no table. An
exception from the provider is recorded as `UNKNOWN`, never as `FAILED`.

### 2.5 Booking compensation (`CompensationState`)

Table: `ALLOWED_COMPENSATION_TRANSITIONS` in
`apps/api/src/bookings/compensation/compensation-state.ts`.

```mermaid
stateDiagram-v2
  [*] --> PLANNED
  PLANNED --> READY
  PLANNED --> MANUAL_REVIEW
  PLANNED --> CANCELLED
  READY --> PROCESSING
  READY --> MANUAL_REVIEW
  READY --> CANCELLED
  PROCESSING --> COMPLETED
  PROCESSING --> RETRYABLE_FAILURE
  PROCESSING --> MANUAL_REVIEW
  PROCESSING --> DEAD_LETTERED
  PROCESSING --> CANCELLED
  RETRYABLE_FAILURE --> READY
  RETRYABLE_FAILURE --> MANUAL_REVIEW
  RETRYABLE_FAILURE --> DEAD_LETTERED
  MANUAL_REVIEW --> READY
  MANUAL_REVIEW --> CANCELLED
  MANUAL_REVIEW --> DEAD_LETTERED
  COMPLETED --> [*]
  DEAD_LETTERED --> [*]
  CANCELLED --> [*]
```

### 2.6 Organizer subscription (`OrganizerSubscriptionStatus`)

Pure function `transition()` in `apps/api/src/billing/subscription-state-machine.ts`.
`ACTIVATE`, `RENEW` and `CHANGE_PLAN_NOW` need verified payment evidence. `CANCELLED` and
`EXPIRED` are terminal: starting again creates a new subscription row.

```mermaid
stateDiagram-v2
  [*] --> TRIALING : START_TRIAL
  [*] --> ACTIVE : ACTIVATE (verified payment)
  [*] --> COMPLIMENTARY : GRANT_COMPLIMENTARY
  TRIALING --> ACTIVE : ACTIVATE (verified payment)
  TRIALING --> COMPLIMENTARY : GRANT_COMPLIMENTARY
  TRIALING --> EXPIRED : TRIAL_ENDED or REVOKE
  COMPLIMENTARY --> ACTIVE : ACTIVATE (verified payment)
  COMPLIMENTARY --> EXPIRED : COMPLIMENTARY_ENDED or REVOKE
  ACTIVE --> ACTIVE : RENEW, CHANGE_PLAN_NOW, schedule or cancel-at-period-end flags
  ACTIVE --> PAST_DUE : PAYMENT_FAILED
  ACTIVE --> CANCELLED : PERIOD_ENDED (cancelAtPeriodEnd) or CANCEL_NOW
  PAST_DUE --> ACTIVE : RENEW (verified payment)
  PAST_DUE --> GRACE : ENTER_GRACE
  PAST_DUE --> CANCELLED : CANCEL_NOW
  GRACE --> ACTIVE : RENEW (verified payment)
  GRACE --> EXPIRED : GRACE_ENDED
  GRACE --> CANCELLED : CANCEL_NOW
  CANCELLED --> [*]
  EXPIRED --> [*]
```

Related enums: `OrganizerInvoiceStatus` (`DRAFT, OPEN, PAID, VOID, REFUNDED`),
`BillingPaymentStatus` (`PENDING, SUCCEEDED, FAILED, REFUNDED`), `BillingWebhookStatus`
(`RECEIVED, PROCESSED, IGNORED, FAILED`).

### 2.7 Fee schedule draft (`FeeScheduleDraftStatus`)

`OPEN, PUBLISHED, DISCARDED`. One `OPEN` draft per currency. `version` is set only on publish
and is unique per currency. Service: `apps/api/src/admin/fee-schedules.service.ts`.

```mermaid
stateDiagram-v2
  [*] --> OPEN : createDraft (copies live FeeRule bands)
  OPEN --> OPEN : saveDraft
  OPEN --> PUBLISHED : publish (lock, fingerprint, validate, version + 1)
  OPEN --> DISCARDED : discardDraft
  PUBLISHED --> [*]
  DISCARDED --> [*]
```

### 2.8 Other status enums worth knowing

- `OutboxStatus`: `PENDING, PROCESSING, DELIVERED, RETRYABLE_FAILURE, DEAD_LETTERED, MANUAL_REVIEW, CANCELLED`
- `WebhookProcessingStatus` (ticket payment webhooks): `RECEIVED, PROCESSING, PROCESSED, FAILED, DEAD_LETTER, IGNORED, AWAITING_CORRELATION`
- `TicketStatus`: `ACTIVE, TRANSFERRED, CHECKED_IN, CANCELLED, REFUNDED, VOID`
- `PayoutStatus` (ledger rows, not provider transfers): `PENDING, SCHEDULED, PAID, FAILED`
- `CampaignStatus`: `DRAFT, SCHEDULED, PENDING_APPROVAL, QUEUED, SENDING, PAUSED, COMPLETED, PARTIALLY_FAILED, FAILED, CANCELLED` (`PENDING_APPROVAL` exists in `apps/api/src/campaigns/campaign-state.ts`, but no route uses it yet)
- `CampaignRecipientStatus`: `PENDING, SKIPPED_CONSENT, SKIPPED_SUPPRESSED, QUEUED, ACCEPTED, DELIVERED, DEFERRED, BOUNCED, COMPLAINED, FAILED, UNSUBSCRIBED`
- `PlatformFeePolicyStatus`: `ACTIVE, INACTIVE, EXPIRED, EXHAUSTED`
- `Role`: `CUSTOMER, ORGANIZER_OWNER, ORGANIZER_MANAGER, CHECKIN_STAFF, ADMIN, SUPER_ADMIN`
