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
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth roles={['ADMIN', 'SUPER_ADMIN']}>
      <MfaGate>
        <StepUpProvider>
          <AdminShell>
            <PageAccessGate>{children}</PageAccessGate>
          </AdminShell>
        </StepUpProvider>
      </MfaGate>
    </RequireAuth>
  );
}
