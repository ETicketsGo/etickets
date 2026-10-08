import type { Metadata } from 'next';
import { PrimaryLink } from '@/components/marketing/kit';
import { PageHero, Prose } from '@/components/marketing/blocks';
import { Link } from '@/i18n/navigation';
import {
  PolicyUpdated,
  OperatorLine,
  LegalDocument,
  BackToLegal,
} from '@/components/legal/policy-chrome';
import { resolveJurisdiction } from '@/lib/market';
import { BUSINESS_DETAILS, publishedDetail } from '@eticketsgo/web-kit';

/**
 * The public description of the text-message programme.
 *
 * -- WHY THIS PAGE EXISTS -------------------------------------------------------------
 * A messaging campaign is reviewed by the carriers before a single message can be sent, and
 * the reviewer starts from the public website with no inside knowledge. They have to be able
 * to find, unaided, who sends the messages, what the messages are, how often they arrive,
 * who pays for them, how to stop them, and how to get help. None of that was published
 * anywhere, so this page publishes it.
 *
 * -- WHY THERE IS NO PUBLIC PHONE FORM HERE -------------------------------------------
 * Deliberate. A box on a public page that accepts any mobile number is weaker consent than
 * what the platform already records, and it is an abuse vector: anybody can type somebody
 * else's number into it. Consent here is taken from a signed-in person in their notification
 * settings, where `MarketingConsent` records who agreed, through what, when, and from which
 * address - an append-only log that can be produced on request. That is the stronger
 * evidence, so it is the mechanism this page sends people to.
 *
 * Every sentence below is true of the platform as built. Nothing here claims a legal review,
 * an approval, or a business detail that has not been published.
 */
export const metadata: Metadata = {
  title: 'Text messages',
  description:
    'What text messages ETicketsGo sends, how often, how to agree to them, and how to stop them.',
  alternates: { canonical: '/sms' },
  // Indexable, unlike the other legal pages: a campaign reviewer is told to find the opt-in
  // description from the public site, and a page excluded from search is harder to find.
  robots: { index: true, follow: true },
};

export default async function SmsPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string | string[] }>;
}) {
  const country = await resolveJurisdiction((await searchParams).country);
  const supportEmail = publishedDetail(BUSINESS_DETAILS.supportEmail);
  const supportPhone = publishedDetail(BUSINESS_DETAILS.supportPhone);
  const legalName = publishedDetail(BUSINESS_DETAILS.legalName);

  return (
    <>
      <PageHero
        eyebrow="Text messages"
        title="ETicketsGo text messages"
        lead="What we send, how often, and how to stop at any time."
      />
      <LegalDocument>
        <BackToLegal />
        <PolicyUpdated type="SMS" country={country} />
        <Prose>
          <h2>Who sends these messages</h2>
          <p>
            Text messages come from <strong>ETicketsGo</strong>
            {legalName ? <> ({legalName})</> : null}, the ticketing platform you booked through. We
            sell tickets for events and check guests in at the door.
          </p>

          <h2>What we send</h2>
          <p>Messages about your account and the tickets you bought. For example:</p>
          <ul>
            <li>A one-time code when you sign in with your mobile number.</li>
            <li>Confirmation that a booking succeeded, with your ticket details.</li>
            <li>Entry details and reminders for an event you booked.</li>
            <li>A change to an event you booked, such as a new time or a cancellation.</li>
            <li>Confirmation that a refund has been sent.</li>
          </ul>
          <p>
            If you separately agree to it, we may also tell you about other events. That is a
            different choice, and you do not have to make it.
          </p>

          <h2>How often</h2>
          <p>
            Message frequency depends on what you do. Most messages answer something you just did,
            such as signing in or buying a ticket, so a booking usually means a small number of
            messages around that booking and the event itself.
          </p>

          <h2>Cost</h2>
          <p>
            <strong>Message and data rates may apply.</strong> We do not charge you for messages;
            your mobile operator may, according to your plan.
          </p>

          <h2>How to agree to text messages</h2>
          <p>
            Sign in, open your notification settings, and turn on text messages. Nothing is turned
            on for you: the setting starts off, and we record your choice, when you made it, and how
            - so we can show that you agreed rather than that we assumed it.
          </p>
          <p>
            <strong>Agreeing to text messages is not a condition of buying a ticket.</strong> You
            can buy tickets, get your tickets and get a refund without ever agreeing to text
            messages.
          </p>
        </Prose>

        {/*
            OUTSIDE `Prose`, and that is the whole point.

            `Prose` styles every descendant anchor with `[&_a]:text-action-primary`, which has
            higher specificity than the button's own `text-action-primary-foreground`. Inside
            it, this button rendered as a solid blue pill with its label in the same blue - a
            control that looks broken while working perfectly. `not-prose` does not help: these
            are plain arbitrary variants, not Tailwind Typography. Only a screenshot showed it.
          */}
        {/*
            `mx-auto max-w-3xl` mirrors `Prose` exactly. The Container is `max-w-shell`, and
            Prose centres its own narrower column inside it - so a direct child of the
            Container lands against the far left edge, a lone button adrift beside a centred
            page. Matching Prose's own box is what keeps it in the text column.
          */}
        <div className="mx-auto max-w-3xl">
          <PrimaryLink href="/account/notification-settings">
            Open notification settings
          </PrimaryLink>
        </div>

        <Prose>
          <h2>How to stop them</h2>
          <p>
            Reply <strong>STOP</strong> to any message from us and we stop sending them to that
            number. You can also turn text messages off in your notification settings at any time.
            If you change your mind, reply <strong>START</strong> to begin again.
          </p>

          <h2>How to get help</h2>
          <p>
            Reply <strong>HELP</strong> to any message from us for help and these contact details.
          </p>
          <p>
            You can also reach us through the <Link href="/contact">contact page</Link>
            {supportEmail ? (
              <>
                , or by email at <strong>{supportEmail}</strong>
              </>
            ) : null}
            {supportPhone ? (
              <>
                , or by phone on <strong>{supportPhone}</strong>
              </>
            ) : null}
            .
          </p>

          <h2>Your privacy</h2>
          <p>
            <strong>
              We do not sell your mobile number, and we do not share it with third parties or
              affiliates for their own marketing.
            </strong>{' '}
            It goes only to the messaging providers that deliver our messages, who may use it only
            for that, and where the law requires disclosure. The{' '}
            <Link href="/privacy">Privacy Policy</Link> explains what we collect and why, and the{' '}
            <Link href="/terms">Terms and Conditions</Link> cover your use of ETicketsGo.
          </p>
        </Prose>
        <OperatorLine />
      </LegalDocument>
    </>
  );
}
