import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { captureException } from '../observability/sentry';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException, ErrorCodes } from './errors';

jest.mock('../observability/sentry', () => ({ captureException: jest.fn() }));

const captureMock = captureException as jest.Mock;

function makeHost(): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res = { status };
  const req = { method: 'POST', url: '/api/x', originalUrl: '/api/x', correlationId: 'cid-1' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

describe('AllExceptionsFilter — Sentry capture is 5xx-only', () => {
  beforeEach(() => jest.clearAllMocks());

  it('captures unexpected 5xx / non-HttpException errors', () => {
    const { host, status } = makeHost();
    new AllExceptionsFilter().catch(new Error('kaboom'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][1]).toMatchObject({ correlationId: 'cid-1' });
  });

  it('captures an explicit 5xx HttpException', () => {
    const { host } = makeHost();
    new AllExceptionsFilter().catch(
      new HttpException('down', HttpStatus.SERVICE_UNAVAILABLE),
      host,
    );
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT capture expected 4xx AppExceptions', () => {
    const { host, status } = makeHost();
    new AllExceptionsFilter().catch(
      new AppException(ErrorCodes.NOT_FOUND, 'nope', HttpStatus.NOT_FOUND),
      host,
    );
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does NOT capture a 400 validation error', () => {
    const { host } = makeHost();
    new AllExceptionsFilter().catch(new HttpException('bad', HttpStatus.BAD_REQUEST), host);
    expect(captureMock).not.toHaveBeenCalled();
  });
});
