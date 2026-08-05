import { AxiosError, AxiosHeaders } from 'axios';
import { messageForError } from '../errors';
import { ApiContractError } from '../http';

/**
 * Every failure the user can see passes through here, so these tests are really about
 * one thing: never show a customer an axios internal, a bare status code, or a stack.
 */

function httpError(status: number, data?: unknown): AxiosError {
  const err = new AxiosError('Request failed');
  err.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

describe('messageForError', () => {
  it('prefers the API’s own message, which is already written for end users', () => {
    const err = httpError(409, {
      code: 'CONFLICT',
      message: 'Booking cancellation is not available.',
    });

    expect(messageForError(err)).toBe('Booking cancellation is not available.');
  });

  it('distinguishes a timeout from an unreachable server', () => {
    const timeout = new AxiosError('timeout of 20000ms exceeded', 'ECONNABORTED');
    const offline = new AxiosError('Network Error');

    expect(messageForError(timeout)).toMatch(/took too long/i);
    expect(messageForError(offline)).toMatch(/couldn't reach/i);
  });

  it('gives an actionable line for each status the customer can actually hit', () => {
    expect(messageForError(httpError(401))).toMatch(/sign in again/i);
    expect(messageForError(httpError(403))).toMatch(/permission/i);
    expect(messageForError(httpError(404))).toMatch(/couldn't find/i);
    expect(messageForError(httpError(409))).toMatch(/got there first/i);
    expect(messageForError(httpError(429))).toMatch(/wait a moment/i);
    expect(messageForError(httpError(503))).toMatch(/our side/i);
  });

  it('tells the user to update when the response did not match the contract', () => {
    // Retrying cannot fix a schema mismatch, so the message must not suggest it.
    const message = messageForError(
      new ApiContractError('/public/discovery', 'venue: invalid_type'),
    );

    expect(message).toMatch(/update/i);
    expect(message).not.toMatch(/try again/i);
  });

  it('never leaks an endpoint or an internal detail into the contract-error message', () => {
    const message = messageForError(
      new ApiContractError('/bookings/bk_secret_123', 'totalMinor: invalid_type'),
    );

    expect(message).not.toContain('bk_secret_123');
    expect(message).not.toContain('totalMinor');
  });

  it('falls back to something human for a non-Error throw', () => {
    expect(messageForError('kaboom')).toMatch(/something went wrong/i);
    expect(messageForError(undefined)).toMatch(/something went wrong/i);
  });
});
