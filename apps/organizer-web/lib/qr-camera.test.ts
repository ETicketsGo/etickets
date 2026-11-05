import { describe, expect, it } from 'vitest';
import { cameraErrorMessage } from './qr-camera';

/*
  The door used to say one thing for every camera failure ("Could not access the camera"), and
  "not supported" whenever Chrome lacked BarcodeDetector. Staff need to know which of these it
  is, because each one is fixed somewhere different.
*/
describe('why the camera could not start', () => {
  it('tells a refused permission from a missing camera from a busy one', () => {
    expect(cameraErrorMessage({ name: 'NotAllowedError' })).toMatch(/permission was refused/);
    expect(cameraErrorMessage({ name: 'NotFoundError' })).toMatch(/No camera was found/);
    expect(cameraErrorMessage({ name: 'NotReadableError' })).toMatch(/in use by another app/);
  });

  it('never claims the browser is unsupported for an ordinary failure', () => {
    expect(cameraErrorMessage(new Error('boom'))).toMatch(/could not be started/);
    expect(cameraErrorMessage(null)).not.toMatch(/not supported/);
  });
});
