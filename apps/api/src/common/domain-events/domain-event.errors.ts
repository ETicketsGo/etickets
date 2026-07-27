/**
 * Typed errors for the domain event layer (ADR-038). These are infrastructure errors
 * (not HTTP AppExceptions): validation/subscription errors surface to the producer,
 * while handler/publication failures are captured by the dispatcher and logged +
 * counted rather than thrown, so a post-commit publish never rolls a commit back.
 */
export abstract class DomainEventError extends Error {
  abstract readonly code: string;
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The event envelope is missing/!malformed required fields. Thrown by publish(). */
export class InvalidDomainEventError extends DomainEventError {
  readonly code = 'DOMAIN_EVENT_INVALID';
}

/** A handler declared supported versions and the event's version is not among them. */
export class UnsupportedEventVersionError extends DomainEventError {
  readonly code = 'DOMAIN_EVENT_UNSUPPORTED_VERSION';
}

/** The same handler identity subscribed to the same event type twice. */
export class DuplicateSubscriptionError extends DomainEventError {
  readonly code = 'DOMAIN_EVENT_DUPLICATE_SUBSCRIPTION';
}

/** A handler threw (or timed out). Captured per-handler; never aborts other handlers. */
export class DomainEventHandlerError extends DomainEventError {
  readonly code = 'DOMAIN_EVENT_HANDLER_FAILED';
  constructor(
    message: string,
    readonly handlerName: string,
    readonly eventId: string,
  ) {
    super(message, { handlerName, eventId });
  }
}

/** The bus itself failed to dispatch (not an individual handler fault). */
export class DomainEventPublicationError extends DomainEventError {
  readonly code = 'DOMAIN_EVENT_PUBLICATION_FAILED';
}

/** After-commit dispatch of transaction-collected events failed. */
export class TransactionDispatchError extends DomainEventError {
  readonly code = 'DOMAIN_EVENT_TRANSACTION_DISPATCH_FAILED';
}
