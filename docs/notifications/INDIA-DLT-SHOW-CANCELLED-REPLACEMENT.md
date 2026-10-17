# India DLT registration pack: corrected show-cancelled SMS

Owner requirement (2026-10-16): "Prepare the corrected Indian cancellation SMS for DLT
registration. Preserve the existing approved template until the replacement is approved."

This page is what to paste into the DLT portal and MSG91. The texts are copied from
`DLT_SMS_REPLACEMENTS` in `apps/api/src/notifications/templates/dlt-sms-templates.ts`, and the
unit test `dlt-sms-templates.spec.ts` fails if this page and the code differ. The general India
SMS setup (entity, header, MSG91 linking) is in [INDIA-DLT-TEMPLATES.md](INDIA-DLT-TEMPLATES.md).

Nothing on this page is a secret. No template id appears in the repository, and none should.

---

## 1. Why the change

The registered show-cancelled template (INDIA-DLT-TEMPLATES.md, section 2.2) is:

```text
ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. Check your email for refund details. - DeepTrics
```

"Check your email for refund details" is wrong in two ways:

1. **It is false for a cash buyer.** A buyer who paid cash at the counter gets no refund. The
   box office at the venue gives the cash back (PR #415). A walk-up buyer often gave no email,
   so there is no email to check. The show-cancelled email already has the correct cash wording.
2. **It is weak for an online buyer.** This SMS is a fallback. It is sent only when email, push
   and WhatsApp reached nobody after 30 minutes. A buyer who signed in with a phone number has
   no real email address. Sending that buyer to their email sends them to nothing.

DLT wording cannot be edited. New wording is a new template with a new id. So the fix is two new
templates, one for each kind of buyer.

---

## 2. Templates to register

Register both under:

| Item             | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Principal Entity | DeepTrics Software Solutions Private Limited (PE ID 1701179092181018311) |
| Sender header    | **DPTRCS** (header ID 1705179188054799869). Never ETKTGO (rejected).     |
| Template type    | Transactional (service)                                                  |
| Content category | **Service Implicit**                                                     |
| Language         | English, plain ASCII (GSM-7). No Unicode, no rupee sign.                 |
| URLs             | None. Neither text has a link, so no URL whitelisting is needed.         |

Copy each text exactly. One changed character, space or full stop and the operator drops the
message.

### Template A: show cancelled, paid online (replaces the registered 2.2 for online buyers)

```text
ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. Your refund will go to the account you paid from. - DeepTrics
```

| #   | Variable    | Example                 | Max length | Source                                                      |
| --- | ----------- | ----------------------- | ---------- | ----------------------------------------------------------- |
| 1   | `event`     | `Kalki 2898 AD`         | 30         | event title; longer titles are cut to 27 characters + `...` |
| 2   | `when`      | `01 Nov 2026, 07:00 PM` | 21         | show start, in the venue's time zone                        |
| 3   | `reference` | `ETG-IN-2026-000042`    | 30         | booking reference; a booking without one is never texted    |

- MSG91 template content:
  `ETicketsGo: ##event## on ##when## is cancelled. Booking ##reference##. Your refund will go to the account you paid from. - DeepTrics`
- Env: `MSG91_SMS_TEMPLATE_SHOW_CANCELLED_ONLINE`, `DLT_TEMPLATE_ID_SHOW_CANCELLED_ONLINE`
- Length: 123 characters as registered, 102 fixed. Sample below: **154 characters, 1 segment**.
  Every variable at its 30-character maximum: 192 characters, 2 segments.

Sample rendered message:

```text
ETicketsGo: Kalki 2898 AD on 01 Nov 2026, 07:00 PM is cancelled. Booking ETG-IN-2026-000042. Your refund will go to the account you paid from. - DeepTrics
```

### Template B: show cancelled, paid in cash (new; cash buyers get no SMS until it is approved)

```text
ETicketsGo: {#var#} on {#var#} is cancelled. Booking {#var#}. You paid {#var#} in cash. Show this booking at the venue box office to get your cash back. - DeepTrics
```

| #   | Variable    | Example                 | Max length | Source                                                      |
| --- | ----------- | ----------------------- | ---------- | ----------------------------------------------------------- |
| 1   | `event`     | `Kalki 2898 AD`         | 30         | event title; longer titles are cut to 27 characters + `...` |
| 2   | `when`      | `01 Nov 2026, 07:00 PM` | 21         | show start, in the venue's time zone                        |
| 3   | `reference` | `ETG-IN-2026-000042`    | 30         | booking reference                                           |
| 4   | `amount`    | `Rs 1650.36`            | 30         | the booking total, from integer paise, ASCII `Rs`           |

- MSG91 template content:
  `ETicketsGo: ##event## on ##when## is cancelled. Booking ##reference##. You paid ##amount## in cash. Show this booking at the venue box office to get your cash back. - DeepTrics`
- Env: `MSG91_SMS_TEMPLATE_SHOW_CANCELLED_CASH`, `DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH`
- Length: 164 characters as registered, 136 fixed. Sample below: **198 characters, 2 segments**.
  Every variable at its 30-character maximum: 256 characters, 2 segments.

Sample rendered message:

```text
ETicketsGo: Kalki 2898 AD on 01 Nov 2026, 07:00 PM is cancelled. Booking ETG-IN-2026-000042. You paid Rs 1650.36 in cash. Show this booking at the venue box office to get your cash back. - DeepTrics
```

Segment arithmetic: GSM-7, 160 characters in one SMS, 153 per part when split. Two parts hold
306 characters, so neither text can reach a third part.

If the portal asks for a variable type for each `{#var#}` (some portals offer types such as
numeric or alphanumeric), choose the free-text or alphanumeric type for all of them. Event
titles, dates and references contain letters, digits, spaces and punctuation.

---

## 3. What the platform does, before and after approval

| Buyer                                         | Neither new id set (today)                                                    | After approval and both ids set |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| Paid online                                   | the registered template (INDIA-DLT-TEMPLATES 2.2), unchanged                  | template A                      |
| Paid in cash at the counter                   | **no SMS**; the send is refused as `TEMPLATE_NOT_FOUND`, naming the cash keys | template B                      |
| Walk-up with no email (copy to the organizer) | no SMS, ever; that copy is for the organization and goes by email             | no SMS                          |

Why a cash buyer gets no SMS rather than the old text: the old text tells them to check their
email for refund details. There is no refund, and often no email. A false statement about their
money is worse than no text. The email (PR #415) already tells a cash buyer the truth, and a
cash buyer who goes to the venue meets the box office that holds their cash.

Rules the code keeps:

- A new template takes effect only when its **DLT id** is set. The DLT id is the evidence that
  the wording was approved. With the DLT id set and the MSG91 id missing, the send is refused
  and names the missing key. It never falls back to the old template's MSG91 id.
- The rendered message is checked against the registered wording before it is sent (fixed text
  identical, each variable at most 30 characters). Text that does not match a registered
  template is never sent.
- A DLT id that is set and is not 19 digits stops the API from starting when MSG91 carries SMS.
- SMS stays in log mode on QA and production. Nothing on this page sends a real SMS.

---

## 4. Owner steps

1. **Check the old template's state.** INDIA-DLT-TEMPLATES.md section 1 records that no content
   template had been submitted as of 2026-10-16. If 2.2 there is already approved, keep it and
   its ids exactly as they are. If it was never submitted, you may submit only the two texts on
   this page; online buyers then use template A once it is approved.
2. On the DLT portal, signed in as DeepTrics Software Solutions Private Limited: Templates >
   Content Template > add. For each of templates A and B: header DPTRCS, type
   Transactional / Service Implicit, paste the text exactly. Submit. Approval usually takes 1-2
   working days per template.
3. When each is approved, write down its 19-digit Content Template ID.
4. In MSG91: SMS > Templates > add. Paste the MSG91 template content shown above (each
   `{#var#}` written as `##name##` with the names in the tables), enter the DLT template ID,
   choose sender DPTRCS. MSG91 shows its own template id. Write it down.
5. Set, on the **api and worker** services of the environment, both keys for each approved
   template (values out of band, never in the repository):
   - online: `MSG91_SMS_TEMPLATE_SHOW_CANCELLED_ONLINE`, `DLT_TEMPLATE_ID_SHOW_CANCELLED_ONLINE`
   - cash: `MSG91_SMS_TEMPLATE_SHOW_CANCELLED_CASH`, `DLT_TEMPLATE_ID_SHOW_CANCELLED_CASH`

   Set the MSG91 id first, or in the same change as the DLT id. A DLT id alone makes the send
   refuse, by design. Remember that a Railway variable change redeploys the latest main.

6. Leave `MSG91_SMS_TEMPLATE_SHOW_CANCELLED` and `DLT_TEMPLATE_ID_SHOW_CANCELLED` (the old
   template) in place until the online replacement is set and proven. Then they may stay; they
   are no longer used for any buyer once both new ids are set.
7. Before switching SMS on for customers (`SMS_ENABLED=true`, `SMS_PROVIDER_BY_MARKET=IN=msg91`),
   send one cancelled-show text of each kind to a team phone on Jio, Airtel and Vi, and check
   the wording and the delivery report.
