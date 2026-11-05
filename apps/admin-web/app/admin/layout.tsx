'use client';

import { RequireAuth } from '@eticketsgo/web-kit';
import { AdminShell } from '@/components/admin-shell';
import { MfaGate } from '@/components/mfa-gate';
import { PageAccessGate } from '@/components/page-access-gate';
import { StepUpProvider } from '@/components/step-up';

/*
  The menu itself lives in `lib/admin-nav.ts`, grouped by the job an operator is doing, and the
  frame in `components/admin-shell.tsx`. The guard is unchanged: the admin console is for the
  ADMIN and SUPER_ADMIN roles, and each page and API route keeps its own capability check.
  `PageAccessGate` shows "You do not have access to this page" in place of a page whose menu
  link this operator could not see (`lib/page-access.ts`), instead of a refused request.
*/
/*
  The frame is RequireAuth's (`frame`), not a child of it: it is drawn round the wait while the
  operator's session is confirmed and stays the same element when the page replaces the
  spinner, so a refresh shows the console from the first paint and nothing in it is remounted.
  The frame asks the API for nothing of its own.
*/
const adminFrame = (content: React.ReactNode) => <AdminShell>{content}</AdminShell>;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth roles={['ADMIN', 'SUPER_ADMIN']} frame={adminFrame}>
      <MfaGate>
        <StepUpProvider>
          <PageAccessGate>{children}</PageAccessGate>
        </StepUpProvider>
      </MfaGate>
    </RequireAuth>
  );
}
