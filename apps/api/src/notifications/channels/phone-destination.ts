import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RenderedNotification } from './notification-channel.interface';
import { payloadPhone } from './transports/recipient.util';

const logger = new Logger('Notification');

/**
 * Where an SMS or WhatsApp message is going, resolved from the recipient's own account.
 *
 * ── WHY THE ACCOUNT WINS OVER THE PAYLOAD ──────────────────────────────────────────
 * A payload is assembled by whichever service is sending — sixteen of them, some of which
 * copy fields out of request bodies. If a payload could name the destination, then anything
 * that can influence a payload could redirect somebody else's booking confirmation, ticket
 * QR or refund notice to a number of its choosing, and the resulting `Notification` row
 * would look completely ordinary. So when there is an account, the account's number is used
 * and the payload's is ignored — and ignored loudly, because a caller trying to override it
 * is either a bug or something worse.
 *
 * ── WHY A PAYLOAD NUMBER IS STILL ACCEPTED WITHOUT AN ACCOUNT ──────────────────────
 * Sign-in codes. A code goes to a number that may not belong to any account yet — that is
 * the entire point of it — so there is nothing to look up, and PhoneOtpService passes the
 * number directly. That path has no `userId`, which is exactly the condition below.
 *
 * ── WHY UNVERIFIED NUMBERS ARE STILL USED ──────────────────────────────────────────
 * `phoneVerifiedAt` records whether somebody proved they hold the number, which gates
 * SIGNING IN as them. It does not gate being written to: a person who typed their number
 * into their profile and never completed a verification still wants their ticket. Requiring
 * verification here would silently drop messages for every account created by email.
 */
export async function resolvePhoneDestination(
  msg: RenderedNotification,
  prisma?: PrismaService,
): Promise<RenderedNotification> {
  const supplied = payloadPhone(msg);

  if (!msg.userId) {
    // No account to be authoritative about — the OTP path, and guests.
    return supplied ? { ...msg, destination: supplied } : msg;
  }

  if (!prisma) return supplied ? { ...msg, destination: supplied } : msg;

  const user = await prisma.user
    .findUnique({ where: { id: msg.userId }, select: { phone: true } })
    .catch(() => null);

  if (!user?.phone) {
    /*
      The account exists and has no number. The payload is NOT used as a fallback here: an
      account whose owner never gave us a phone number is precisely the case where a
      payload-supplied one would be somebody else's.
    */
    return msg;
  }

  if (supplied && supplied !== user.phone) {
    logger.warn(
      `[${msg.channel}:${msg.type}] payload phone ignored; using the recipient's own number`,
    );
  }
  return { ...msg, destination: user.phone };
}
