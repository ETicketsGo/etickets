import { Platform } from 'react-native';
import {
  PLAY_INTEGRITY_HEADERS,
  playIntegrityChallenge,
  playIntegrityHeaders,
  setIntegrityModuleForTests,
  type IntegrityModule,
} from '../human-check';

const mockPlatform = { OS: 'android' };
// Only the platform name is replaced; the rest of react-native stays jest-expo's own.
Object.defineProperty(Platform, 'OS', { get: () => mockPlatform.OS, configurable: true });
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { android: { package: 'com.eticketsgo.customer' } } },
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef',
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: async (_alg: string, input: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (
      require('crypto') as {
        createHash: (a: string) => { update: (s: string) => { digest: (e: string) => string } };
      }
    )
      .createHash('sha256')
      .update(input)
      .digest('hex'),
}));

const challengeBody = {
  code: 'HUMAN_CHECK_REQUIRED',
  details: { action: 'otp', siteKey: 'x', playIntegrity: { cloudProjectNumber: '123456789012' } },
};

function fakePlay(token = 'play-token'): IntegrityModule & {
  prepare: jest.Mock;
  request: jest.Mock;
} {
  const prepare = jest.fn(async () => undefined);
  const request = jest.fn(async () => token);
  return {
    prepare,
    request,
    prepareIntegrityTokenProviderAsync: prepare,
    requestIntegrityCheckAsync: request,
  };
}

afterEach(() => {
  setIntegrityModuleForTests(undefined);
  mockPlatform.OS = 'android';
});

describe('reading a challenge', () => {
  it('takes the action and the project number from a 428 or 403 body', () => {
    expect(playIntegrityChallenge(challengeBody)).toEqual({
      action: 'otp',
      cloudProjectNumber: '123456789012',
    });
    expect(playIntegrityChallenge({ ...challengeBody, code: 'HUMAN_CHECK_FAILED' })).not.toBeNull();
  });

  it('is null when the environment has no Play Integrity (the app cannot answer)', () => {
    expect(
      playIntegrityChallenge({ ...challengeBody, details: { action: 'otp', playIntegrity: null } }),
    ).toBeNull();
  });

  it('is null for any other refusal', () => {
    expect(playIntegrityChallenge({ code: 'HUMAN_CHECK_UNAVAILABLE', details: {} })).toBeNull();
    expect(playIntegrityChallenge({ code: 'FORBIDDEN' })).toBeNull();
    expect(playIntegrityChallenge(null)).toBeNull();
    expect(playIntegrityChallenge('<html>')).toBeNull();
  });
});

describe('answering it', () => {
  it('sends the token, the nonce and the package, over the hash the server rebuilds', async () => {
    const play = fakePlay();
    setIntegrityModuleForTests(play);
    const headers = await playIntegrityHeaders({
      action: 'otp',
      cloudProjectNumber: '123456789012',
    });
    const nonce = '0123456789abcdef0123456789abcdef';
    expect(headers).toEqual({
      [PLAY_INTEGRITY_HEADERS.token]: 'play-token',
      [PLAY_INTEGRITY_HEADERS.nonce]: nonce,
      [PLAY_INTEGRITY_HEADERS.packageName]: 'com.eticketsgo.customer',
    });
    expect(play.prepare).toHaveBeenCalledWith('123456789012');
    // The same vector is pinned in apps/api/src/human-check/play-integrity.spec.ts.
    expect(play.request).toHaveBeenCalledWith(
      '2cb5c5569c56c68d64478ddf60738655a13609afd9f4349d768ddcce92611b41',
    );
  });

  it('prepares Play once per project, and again after a failed preparation', async () => {
    const play = fakePlay();
    play.prepare.mockRejectedValueOnce(new Error('Play services too old'));
    setIntegrityModuleForTests(play);
    const c = { action: 'login', cloudProjectNumber: '123456789012' };
    expect(await playIntegrityHeaders(c)).toBeNull();
    expect(await playIntegrityHeaders(c)).not.toBeNull();
    expect(await playIntegrityHeaders(c)).not.toBeNull();
    expect(play.prepare).toHaveBeenCalledTimes(2);
  });

  it('has no answer off Android, without the module, or when Play refuses', async () => {
    const play = fakePlay();
    setIntegrityModuleForTests(play);
    mockPlatform.OS = 'ios';
    const c = { action: 'otp', cloudProjectNumber: '123456789012' };
    expect(await playIntegrityHeaders(c)).toBeNull();
    mockPlatform.OS = 'android';
    setIntegrityModuleForTests(null);
    expect(await playIntegrityHeaders(c)).toBeNull();
    const refusing = fakePlay();
    refusing.request.mockRejectedValue(new Error('PLAY_STORE_NOT_FOUND'));
    setIntegrityModuleForTests(refusing);
    expect(await playIntegrityHeaders(c)).toBeNull();
  });
});
