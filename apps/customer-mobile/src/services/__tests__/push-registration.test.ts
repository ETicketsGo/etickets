import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  askForPushAfterBooking,
  forgetPushDevice,
  syncPushRegistration,
} from '../push-registration';

const mockEnv = { pushEnabled: false };
// A getter: the factory runs before mockEnv exists, the tests read it after.
jest.mock('../env', () => ({
  get env() {
    return mockEnv;
  },
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  // jest.mock factories run before imports, so the library mock is required here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
const mockRegister = jest.fn();
const mockDeregister = jest.fn();
const mockAsk = jest.fn();
const mockState = jest.fn();
jest.mock('../notifications', () => ({
  registerDevice: () => mockRegister(),
  deregisterDevice: (id: string) => mockDeregister(id),
  requestNotificationPermission: () => mockAsk(),
  getPermissionState: () => mockState(),
}));

beforeEach(async () => {
  await AsyncStorage.clear();
  mockEnv.pushEnabled = false;
  for (const m of [mockRegister, mockDeregister, mockAsk, mockState]) m.mockReset();
  mockRegister.mockResolvedValue({ id: 'dev_1' });
  mockState.mockResolvedValue('granted');
  mockAsk.mockResolvedValue('granted');
});

describe('push registration', () => {
  it('does nothing at all in a build without a push credential', async () => {
    await syncPushRegistration();
    await askForPushAfterBooking();
    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('registers without a prompt when permission was already granted', async () => {
    mockEnv.pushEnabled = true;
    await syncPushRegistration();
    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('asks only once, after a booking', async () => {
    mockEnv.pushEnabled = true;
    await askForPushAfterBooking();
    await askForPushAfterBooking();
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  it('deregisters the remembered device on sign-out', async () => {
    mockEnv.pushEnabled = true;
    await syncPushRegistration();
    await forgetPushDevice();
    expect(mockDeregister).toHaveBeenCalledWith('dev_1');
  });
});
