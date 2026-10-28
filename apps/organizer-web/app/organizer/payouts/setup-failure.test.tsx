import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiRequestError } from '@eticketsgo/web-kit';
import { SetupFailure } from './setup-failure';

describe('SetupFailure', () => {
  it('renders nothing before an attempt fails', () => {
    expect(renderToStaticMarkup(<SetupFailure error={null} />)).toBe('');
  });

  it('shows the mapped sentence as an alert, not the server text', () => {
    const html = renderToStaticMarkup(
      <SetupFailure
        error={
          new ApiRequestError(
            'PAYMENT_PROVIDER_NOT_CONFIGURED',
            'Stripe no longer recommends Accounts v1',
            {},
            'cid-1234-5678',
            503,
          )
        }
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Payout setup is not switched on for this site yet.');
    expect(html).not.toContain('Accounts v1');
  });

  it('tells a manager to ask the owner', () => {
    const html = renderToStaticMarkup(
      <SetupFailure error={new ApiRequestError('TENANT_FORBIDDEN', 'x', {}, undefined, 403)} />,
    );
    expect(html).toContain('Only the owner of this organization can set up payouts.');
  });
});
