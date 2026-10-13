import { contentLabelFor, contentLabelPolicy, demoFirst } from './content-label';

const qa = { APP_ENV: 'QA', DEMO_ORGANIZATION_IDS: ' org-demo-1 , org-demo-2 ,' };

describe('contentLabelFor', () => {
  it('labels a listed organization DEMO and every other TEST outside production', () => {
    const policy = contentLabelPolicy(qa);
    expect(contentLabelFor('org-demo-1', policy)).toBe('DEMO');
    expect(contentLabelFor('org-demo-2', policy)).toBe('DEMO');
    expect(contentLabelFor('org-fixture', policy)).toBe('TEST');
  });

  it('labels everything TEST when no demo organizations are configured', () => {
    expect(contentLabelFor('org-x', contentLabelPolicy({ APP_ENV: 'UAT' }))).toBe('TEST');
  });

  it('is always null in PRODUCTION, even for a listed organization', () => {
    const policy = contentLabelPolicy({ ...qa, APP_ENV: 'PRODUCTION' });
    expect(contentLabelFor('org-demo-1', policy)).toBeNull();
    expect(contentLabelFor('org-fixture', policy)).toBeNull();
    expect(contentLabelPolicy({ APP_ENV: 'production' }).enabled).toBe(false);
  });

  it('keys on APP_ENV, not NODE_ENV', () => {
    const policy = contentLabelPolicy({ ...qa, NODE_ENV: 'production' });
    expect(contentLabelFor('org-demo-1', policy)).toBe('DEMO');
  });
});

describe('demoFirst', () => {
  it('puts DEMO before TEST, keeps each group in order and drops nothing', () => {
    const items = [
      { id: 'a', contentLabel: 'TEST' as const },
      { id: 'b', contentLabel: 'DEMO' as const },
      { id: 'c', contentLabel: 'TEST' as const },
      { id: 'd', contentLabel: 'DEMO' as const },
    ];
    expect(demoFirst(items).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('leaves unlabelled (production) lists exactly as they were', () => {
    const items = [
      { id: 'a', contentLabel: null },
      { id: 'b', contentLabel: null },
    ];
    expect(demoFirst(items)).toBe(items);
  });
});
