import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What a deep service may know about the HTTP request it is serving, without being handed it.
 *
 * Exists for the audit trail of platform staff acting on an organization. The tenant check
 * (`OrgAccessService.assertMember`) runs inside services, a long way from the controller, and
 * a refusal recorded there as "somebody was refused something" answers nobody's question. With
 * this the row says which request it was: method, path and the correlation id every other log
 * line about that request carries.
 *
 * Set once per request by `CorrelationIdMiddleware`. Absent in workers, scripts and tests that
 * build a module without the middleware, and every reader treats it as optional: this is
 * context for a record, never an input to a decision.
 */
export interface RequestContext {
  correlationId: string;
  method: string;
  /** Already passed through `safeRequestPath`, so it is safe to write down. */
  path: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequest(): RequestContext | undefined {
  return requestContext.getStore();
}
