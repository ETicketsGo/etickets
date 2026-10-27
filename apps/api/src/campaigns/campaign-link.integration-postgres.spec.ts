import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureCampaignLink } from './campaign-dispatch.service';

/**
 * integration-real-postgres: the first sends of a campaign create its link rows concurrently.
 *
 * The campaign queue runs several recipients at once. Link rows used to be created with
 * `upsert`, which is not atomic: two first sends both tried the insert, one hit the unique key
 * (campaignId, targetUrl), and that recipient was failed for good (QA certification D4).
 * Twenty concurrent calls must all succeed and agree on one row.
 *
 * Skips (never fabricates a pass) without a database.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const p of ['../../../../.env', '../../../../../.env']) {
    try {
      const m = readFileSync(resolve(__dirname, p), 'utf8').match(/^DATABASE_URL=(.*)$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* try next */
    }
  }
  return undefined;
}

describe('integration-real-postgres: campaign link rows under concurrent first sends', () => {
  const url = loadDatabaseUrl();
  let db: any;
  let available = false;
  const campaignId = `it-link-${randomUUID()}`;

  beforeAll(async () => {
    if (!url) return;
    process.env.DATABASE_URL = url;
    const { PrismaClient } = await import('@prisma/client');
    db = new PrismaClient();
    try {
      await db.$queryRaw`SELECT 1 FROM "CampaignLink" LIMIT 1`;
      available = true;
    } catch {
      available = false;
    }
  });

  afterAll(async () => {
    if (db && available) await db.campaignLink.deleteMany({ where: { campaignId } });
    if (db) await db.$disconnect();
  });

  it('concurrent first sends from two separate clients never fail and share one row', async () => {
    if (!available) return;
    const { PrismaClient } = await import('@prisma/client');
    const other = new PrismaClient();
    try {
      // The race window is small; many fresh targets from two connections pools make it real.
      for (let round = 0; round < 30; round += 1) {
        const target = `https://qa.eticketsgo.com/events/it-link-${round}`;
        const ids = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            ensureCampaignLink(i % 2 ? other : db, campaignId, target),
          ),
        );
        expect(new Set(ids).size).toBe(1);
      }
      expect(
        await db.campaignLink.count({
          where: {
            campaignId,
            targetUrl: { startsWith: 'https://qa.eticketsgo.com/events/it-link-' },
          },
        }),
      ).toBe(30);
    } finally {
      await other.$disconnect();
    }
  });

  it('20 concurrent first sends get one shared row and none fails', async () => {
    if (!available) return;
    const target = 'https://qa.eticketsgo.com/events/it-link';
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => ensureCampaignLink(db, campaignId, target)),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await db.campaignLink.count({ where: { campaignId, targetUrl: target } })).toBe(1);
    // And a later call returns the same row.
    expect(await ensureCampaignLink(db, campaignId, target)).toBe(ids[0]);
  });
});
