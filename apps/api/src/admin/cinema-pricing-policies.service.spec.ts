import {
  CinemaPricingPoliciesService,
  editablePolicyFields,
} from './cinema-pricing-policies.service';

/**
 * A pricing policy changes status only through activate / supersede.
 *
 * The admin PATCH wrote its body to the row as-is, so `{ status: 'ACTIVE' }` activated a policy
 * past every activation check - including the production block on a regulatory order nobody has
 * read. Found in the 2026-10-09 rule-engine review (gap G1).
 */
describe('cinema pricing policy edits', () => {
  const make = (status = 'DRAFT') => {
    const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'p1',
      ...data,
    }));
    const svc = new CinemaPricingPoliciesService(
      {
        cinemaPricingPolicy: {
          findUnique: jest.fn().mockResolvedValue({ id: 'p1', status }),
          update,
          create,
        },
      } as never,
      { record: jest.fn() } as never,
    );
    return { svc, update, create };
  };

  it('refuses a status change through the edit endpoint, and writes nothing', async () => {
    const { svc, update } = make();
    await expect(
      svc.updateDraft('admin', 'p1', { status: 'ACTIVE' } as never),
    ).rejects.toMatchObject({
      response: { details: { reason: 'POLICY_FIELD_NOT_EDITABLE', fields: ['status'] } },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses version and activation stamps too', () => {
    expect(() => editablePolicyFields({ version: 9, activatedAt: new Date(), notes: 'x' })).toThrow(
      /version, activatedAt/,
    );
  });

  it('still edits ordinary fields of a draft', async () => {
    const { svc, update } = make();
    await svc.updateDraft('admin', 'p1', {
      notes: 'Checked against the order',
      ticketPriceMaxMinor: 25000,
    });
    expect(update.mock.calls[0][0].data).toEqual({
      notes: 'Checked against the order',
      ticketPriceMaxMinor: 25000,
    });
  });

  it('creates DRAFT only, and refuses a body that tries to arrive ACTIVE', async () => {
    const { svc, create } = make();
    await expect(
      svc.create('admin', { status: 'ACTIVE', country: 'India' } as never),
    ).rejects.toThrow(/status/);
    expect(create).not.toHaveBeenCalled();
  });
});
