import { describe, expect, it } from 'vitest';
import { buildAssetLinks, parseAndroidApps } from './android-asset-links';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(
  ':',
);

describe('assetlinks.json', () => {
  it('is absent (404) until configured', () => {
    expect(buildAssetLinks(undefined)).toBeNull();
    expect(buildAssetLinks('')).toBeNull();
  });

  it('ignores malformed entries rather than trusting them', () => {
    expect(parseAndroidApps('com.example.app:not-a-fingerprint,nopackage,:' + FP)).toEqual([]);
  });

  it('builds one statement per package with every fingerprint', () => {
    const body = buildAssetLinks(
      `com.eticketsgo.customer.preview:${FP}, com.eticketsgo.customer.preview:${FP.replace('00', 'FF')}`,
    );
    expect(body).toHaveLength(1);
    expect(body?.[0]).toEqual({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.eticketsgo.customer.preview',
        sha256_cert_fingerprints: [FP, FP.replace('00', 'FF')],
      },
    });
  });

  it('accepts lower-case fingerprints as Android prints them in some tools', () => {
    expect(parseAndroidApps(`com.eticketsgo.customer:${FP.toLowerCase()}`)[0]?.fingerprint).toBe(
      FP,
    );
  });
});
