'use client';

import { AppShell, RequireAuth } from '@eticketsgo/web-kit';
import { brandDisplay } from '@eticketsgo/web-kit/fonts/brand-display';
import { ColorSchemeSwitch } from '@/components/color-scheme-switch';
import { MfaGate } from '@/components/mfa-gate';
import { StepUpProvider } from '@/components/step-up';
import { proposalNavItems } from '@/lib/proposal-nav';

const NAV = proposalNavItems();

/*
  PROPOSAL - do not merge (docs/design/ADMIN-PROPOSAL.md).

  The admin console drawn in the approved "desk" system: the shared shell with
  `appearance="desk"`, the regrouped menu, and pages built from `brand-*` tokens only. It sits
  beside `/admin`, not over it, so the live console is untouched and the two can be compared
  side by side on the same data. The guards are the live console's: the same roles, the same
  MFA gate, and each API route keeps its own capability check.

  The display face is attached here rather than on <html>, so nothing outside the prototype
  changes; DESIGN-SYSTEM.md section 11 puts it on <html> when admin adopts the system.
*/
export default function ProposalLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth roles={['ADMIN', 'SUPER_ADMIN']}>
      <MfaGate>
        <StepUpProvider>
          <div className={brandDisplay.variable}>
            <AppShell
              brand="Admin"
              nav={NAV}
              navLabel="Admin"
              drawerLabel="Admin menu"
              appearance="desk"
              headerAccessory={<ColorSchemeSwitch className="hidden sm:flex" />}
              drawerAccessory={
                <div className="flex items-center justify-between gap-3 border-b border-brand-line px-4 py-3 sm:hidden">
                  <span className="text-brand-ui text-brand-ink-2">Appearance</span>
                  <ColorSchemeSwitch />
                </div>
              }
            >
              <div className="mx-auto w-full max-w-brand-console space-y-8 font-brand-text">
                {children}
              </div>
            </AppShell>
          </div>
        </StepUpProvider>
      </MfaGate>
    </RequireAuth>
  );
}
