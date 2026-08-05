# App store readiness

**Verdict: not submittable.** Several items below are hard review rejections, not polish.

## Hard blockers

### 1. Account deletion — required by both stores

Apple guideline 5.1.1(v) and Google's data-deletion policy both require an in-app path to
delete an account for any app that lets you create one. The API has no such endpoint:
`/users/me` supports GET and PATCH only.

Needed: `DELETE /users/me` (soft-delete and anonymise) or
`POST /users/me/deletion-request`, plus the screen that calls it and a web-accessible
deletion URL for the Play listing.

### 2. No device testing whatsoever

The app has never run on Android or iOS. Submitting a binary nobody has opened is not a
defensible position regardless of store rules.

### 3. Privacy manifest and data-safety declarations

Neither exists. Required: an iOS `PrivacyInfo.xcprivacy` declaring the data collected
(email, name, purchase history) and the required-reason APIs used, and a completed Play
Data Safety form. The app also uses camera and notification permissions that need
purpose strings reviewed — the camera string currently references check-in scanning,
which is an organizer feature and not something a customer build should be asking for.

### 4. No published privacy policy or terms URL wired into the app

Profile has no legal links. The store listings require reachable URLs.

## Should fix before submission

| Item                         | State                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Password reset               | No API endpoint; users who forget a password have no route                    |
| Push notifications           | Architecture only; permission prompt with nothing behind it would look broken |
| Universal / app links        | Association files not served, so https links open the website                 |
| Cinema booking               | Discovery gap means film posters lead to a "not available yet" card           |
| Guest booking claim          | No endpoint; guests cannot attach a booking to a new account                  |
| App icons and splash         | Placeholder assets from the original scaffold                                 |
| Screenshots and listing copy | Not produced                                                                  |
| Age rating questionnaire     | Not completed                                                                 |

## Already satisfied

- No third-party payment SDK, so no in-app-purchase entanglement — ticketing for a
  real-world event is explicitly outside Apple's IAP requirement, and the app takes
  payment through a hosted page rather than embedding a provider.
- No secrets, keys or signing material in the bundle.
- Distinct bundle ids per environment.
- HTTPS only; production builds refuse a localhost API.
- Dark mode, Dynamic Type, and 44pt touch targets.
- No account required to browse, which avoids the "sign-in wall" rejection under 5.1.1(i).
