'use client';

import { useParams } from 'next/navigation';
import { InviteAcceptance } from '@/components/invite-acceptance';

/**
 * Where an invited team member joins.
 *
 * It sits OUTSIDE `/organizer` deliberately: everything under that path requires a session and
 * an organizer seat, and the invitee has neither yet. The page itself is public; accepting is
 * not - it needs the invited account's own session with its email confirmed (see
 * `InviteAcceptance` and the API's `acceptInvitation`).
 */
export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  return <InviteAcceptance token={token} />;
}
