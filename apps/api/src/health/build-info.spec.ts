import { buildInfo } from './health.controller';

describe('buildInfo (which build is answering)', () => {
  it('an image built once in CI reports its own commit, even where Railway sets one too', () => {
    expect(
      buildInfo({ GIT_SHA: 'aaa111', BUILD_VERSION: 'v1.2.3', RAILWAY_GIT_COMMIT_SHA: 'bbb222' }),
    ).toMatchObject({ sha: 'aaa111', version: 'v1.2.3', source: 'image' });
  });

  it('a Railway source build (empty build args) reports the Railway commit', () => {
    expect(buildInfo({ GIT_SHA: '', RAILWAY_GIT_COMMIT_SHA: 'bbb222' })).toMatchObject({
      sha: 'bbb222',
      source: 'railway',
    });
  });

  it('a local run reports nothing rather than inventing a commit', () => {
    expect(buildInfo({})).toEqual({ sha: null, version: null, builtAt: null, source: null });
  });
});
