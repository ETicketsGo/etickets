import { classifySyncFailure } from './sync-failure.classifier';
import {
  ProviderMappingAmbiguousError,
  ProviderPayloadInvalidError,
  ProviderSyncOrderingConflictError,
  ProviderSyncRetryableFailureError,
  ProviderWebhookSignatureInvalidError,
  ProviderEventUnsupportedVersionError,
} from './sync.errors';

describe('classifySyncFailure', () => {
  it('security rejections are terminal (REJECTED, not retried)', () => {
    const v = classifySyncFailure(new ProviderWebhookSignatureInvalidError());
    expect(v).toMatchObject({
      class: 'SECURITY_REJECTION',
      retryable: false,
      terminalStatus: 'REJECTED',
    });
  });
  it('schema/permanent failures are terminal (PERMANENT_FAILURE)', () => {
    expect(classifySyncFailure(new ProviderPayloadInvalidError())).toMatchObject({
      retryable: false,
      terminalStatus: 'PERMANENT_FAILURE',
    });
  });
  it('mapping ambiguity + unsupported version + ordering conflict go to MANUAL_REVIEW', () => {
    expect(classifySyncFailure(new ProviderMappingAmbiguousError()).terminalStatus).toBe(
      'MANUAL_REVIEW',
    );
    expect(classifySyncFailure(new ProviderEventUnsupportedVersionError()).terminalStatus).toBe(
      'MANUAL_REVIEW',
    );
    expect(classifySyncFailure(new ProviderSyncOrderingConflictError()).terminalStatus).toBe(
      'MANUAL_REVIEW',
    );
  });
  it('provider retryable failures retry', () => {
    expect(classifySyncFailure(new ProviderSyncRetryableFailureError())).toMatchObject({
      retryable: true,
      terminalStatus: 'RETRYABLE_FAILURE',
    });
  });
  it('unknown errors are treated as retryable infrastructure faults', () => {
    expect(classifySyncFailure(new Error('boom'))).toMatchObject({
      class: 'RETRYABLE_INFRASTRUCTURE',
      retryable: true,
    });
  });
});
