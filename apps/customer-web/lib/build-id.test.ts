import { describe, expect, it } from 'vitest';
import { buildIdFrom } from './build-id';

describe('buildIdFrom', () => {
  it('shortens the platform commit to seven characters', () => {
    expect(
      buildIdFrom({ RAILWAY_GIT_COMMIT_SHA: '4F30B8B3C0FFEE1234567890ABCDEF1234567890' }),
    ).toBe('4f30b8b');
  });

  it('prefers an explicit BUILD_SHA over the platform one', () => {
    expect(buildIdFrom({ BUILD_SHA: 'aaaaaaa1', RAILWAY_GIT_COMMIT_SHA: 'bbbbbbb2' })).toBe(
      'aaaaaaa',
    );
  });

  it('is null in development, where no platform sets a commit', () => {
    expect(buildIdFrom({})).toBeNull();
  });

  it('never shows something that is not a commit', () => {
    expect(buildIdFrom({ RAILWAY_GIT_COMMIT_SHA: 'main' })).toBeNull();
    expect(buildIdFrom({ RAILWAY_GIT_COMMIT_SHA: '  ' })).toBeNull();
    expect(buildIdFrom({ RAILWAY_GIT_COMMIT_SHA: 'my-secret-token-value' })).toBeNull();
  });
});
