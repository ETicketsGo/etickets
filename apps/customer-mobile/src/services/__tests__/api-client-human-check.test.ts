import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { apiClient } from '../api-client';

/**
 * The API client answers a human-check challenge once, with Play's proof, and then leaves
 * the outcome to the server. Axios runs for real; only the network (the adapter) and Play
 * (playIntegrityHeaders) are stand-ins.
 */
jest.mock('../env', () => ({ env: { apiUrl: 'https://api.test/api' } }));
jest.mock('../secure-store', () => ({
  tokenStore: { get: async () => null, set: async () => undefined, clear: async () => undefined },
}));
const mockHeaders = jest.fn();
jest.mock('../human-check', () => ({
  ...jest.requireActual('../human-check'),
  playIntegrityHeaders: (...args: unknown[]) => mockHeaders(...args),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));
jest.mock('expo-crypto', () => ({}));

const challenge = (status: number, code: string) => ({
  status,
  data: {
    code,
    message: 'Please confirm you are a person, then try again.',
    details: { action: 'otp', siteKey: null, playIntegrity: { cloudProjectNumber: '1234567' } },
  },
});

/** Answers each request in turn and records the headers it was sent with. */
function network(answers: { status: number; data: unknown }[]) {
  const sent: Record<string, unknown>[] = [];
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    sent.push({ ...config.headers.toJSON() });
    const next = answers.shift() ?? { status: 500, data: {} };
    const response = { ...next, statusText: '', headers: {}, config };
    if (next.status >= 400) {
      throw new AxiosError('refused', String(next.status), config, null, response);
    }
    return response;
  };
  apiClient.defaults.adapter = adapter;
  return sent;
}

beforeEach(() => mockHeaders.mockReset());

it('retries a 428 once with the Play headers, and the server lets it through', async () => {
  mockHeaders.mockResolvedValue({ 'x-play-integrity-token': 'tok', 'x-play-integrity-nonce': 'n' });
  const sent = network([
    challenge(428, 'HUMAN_CHECK_REQUIRED'),
    { status: 200, data: { sent: true } },
  ]);
  const res = await apiClient.post('/auth/phone/request-code', { phone: '+919876543210' });
  expect(res.data).toEqual({ sent: true });
  expect(mockHeaders).toHaveBeenCalledWith({ action: 'otp', cloudProjectNumber: '1234567' });
  expect(sent).toHaveLength(2);
  expect(sent[0]['x-play-integrity-token']).toBeUndefined();
  expect(sent[1]['x-play-integrity-token']).toBe('tok');
});

it('a second refusal is final: no loop, the server answer stands', async () => {
  mockHeaders.mockResolvedValue({ 'x-play-integrity-token': 'tok', 'x-play-integrity-nonce': 'n' });
  const sent = network([
    challenge(428, 'HUMAN_CHECK_REQUIRED'),
    challenge(403, 'HUMAN_CHECK_FAILED'),
    { status: 200, data: {} },
  ]);
  await expect(apiClient.post('/auth/phone/request-code', {})).rejects.toMatchObject({
    response: { status: 403 },
  });
  expect(sent).toHaveLength(2);
  expect(mockHeaders).toHaveBeenCalledTimes(1);
});

it('without an answer from Play, the original 428 is returned and nothing is resent', async () => {
  mockHeaders.mockResolvedValue(null);
  const sent = network([challenge(428, 'HUMAN_CHECK_REQUIRED')]);
  await expect(apiClient.post('/auth/login', {})).rejects.toMatchObject({
    response: { status: 428 },
  });
  expect(sent).toHaveLength(1);
});

it('a plain 403 (not a human check) is never retried', async () => {
  const sent = network([{ status: 403, data: { code: 'FORBIDDEN', message: 'No.' } }]);
  await expect(apiClient.post('/bookings', {})).rejects.toMatchObject({
    response: { status: 403 },
  });
  expect(mockHeaders).not.toHaveBeenCalled();
  expect(sent).toHaveLength(1);
});
