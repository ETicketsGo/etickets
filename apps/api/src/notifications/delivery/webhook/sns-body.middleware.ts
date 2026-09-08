import {
  Injectable,
  RequestMethod,
  type MiddlewareConsumer,
  type NestMiddleware,
} from '@nestjs/common';
import { text } from 'express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Reading the body Amazon actually sends.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────
 * SNS posts HTTPS notifications with `Content-Type: text/plain; charset=UTF-8`. The body is
 * a JSON document; the media type is not. That is not a quirk of one message — it is how
 * every SNS HTTPS delivery has always been sent, confirmations included.
 *
 * Nest registers `express.json()`, which parses `application/json` and declines everything
 * else. Under Express 5 a declined body is not an empty object, it is `undefined`: the stream
 * is left unread and `@Body()` yields nothing. So the SES endpoint — signature verification,
 * suppression handling, all of it correct — could never see a single real message. The
 * SubscriptionConfirmation would have been refused, the AWS console would have reported a
 * failed subscription, and no delivery event would ever have arrived.
 *
 * ── WHY THIS IS SCOPED TO ONE ROUTE AND NOT ADDED GLOBALLY ─────────────────────────
 * The one-line fix is to teach the global JSON parser to accept `text/plain`. It is also the
 * wrong fix. It would make every endpoint on this API — checkout, refunds, admin — accept a
 * JSON body under a media type that no browser sends for JSON, which is exactly the shape
 * used to slip requests past CSRF protections and content-type allowlists that assume
 * `text/plain` is inert. One provider's non-standard header is not a reason to widen the
 * whole surface.
 *
 * So it is bound to `POST notifications/webhooks/ses/:secret` and nowhere else. Every other
 * route keeps the default parsers untouched.
 *
 * ── WHY IT DOES NOT DECIDE ANYTHING ────────────────────────────────────────────────
 * This middleware only turns bytes into an object. It performs no authentication and relaxes
 * none: the path secret and the SNS signature are checked afterwards, unchanged, and the
 * signature remains authoritative. Anything it cannot parse becomes `{}`, which the verifier
 * refuses as `unknown_type` — the same refusal a forged message gets, and deliberately not a
 * distinct one, since a caller probing this endpoint should not learn where it failed.
 *
 * That last point is why parse failures are not thrown from here. A middleware exception in
 * Express bypasses Nest's exception filters and would answer in a different shape from every
 * other refusal on this endpoint — telling a prober, by the shape of the error alone, that
 * they had reached the parser.
 */

/** The one route this parser is allowed on. Shared so tests bind the identical path. */
export const SNS_WEBHOOK_ROUTE = {
  path: 'notifications/webhooks/ses/:secret',
  method: RequestMethod.POST,
};

/**
 * An SNS envelope is a few hundred bytes; an SES event inside one is a few kilobytes. The cap
 * is generous against that and still bounds what an unauthenticated caller can make this
 * process buffer, since the body must be read in full before the signature can be checked.
 */
const MAX_BODY = '256kb';

/**
 * Both media types are claimed deliberately.
 *
 * `text/plain` is what SNS sends. `application/json` is listed because the global parser has
 * already run by this point: if it handled the request, body-parser's own `_body` marker
 * makes the call below a no-op, and if some future bootstrap change stops it running, this
 * route keeps working rather than failing the way it just did.
 */
const SNS_MEDIA_TYPES = ['text/plain', 'application/json'];

@Injectable()
export class SnsBodyMiddleware implements NestMiddleware {
  private readonly readText = text({
    type: SNS_MEDIA_TYPES,
    limit: MAX_BODY,
    /*
      Keep the exact bytes. Nothing in the SNS scheme needs them — its signature is computed
      over named fields, not over the document — but the Meta handler on this same controller
      does sign raw bytes, and a raw body that is present for one webhook and silently absent
      for another is the kind of asymmetry somebody later builds on by accident.
    */
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  });

  use(req: Request, res: Response, next: NextFunction): void {
    this.readText(req, res, () => {
      /*
        Every failure path lands on the same value. A body too large, a read that broke
        mid-stream, a document that is not JSON, and a document that is valid JSON but not an
        object all produce `{}` — which fails signature verification and is refused with the
        same 401 as a forgery.
      */
      if (typeof req.body === 'string') {
        try {
          req.body = JSON.parse(req.body) as unknown;
        } catch {
          req.body = {};
        }
      }
      if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
        req.body = {};
      }
      next();
    });
  }
}

/**
 * Bind the parser to the SES webhook.
 *
 * A function rather than a line inside the module so the real module and the HTTP test bind
 * through the same code. A test that restated the route string would keep passing after
 * somebody changed the module's copy of it, which is the failure mode this whole file exists
 * to remove.
 */
export function applySnsBodyParser(consumer: MiddlewareConsumer): void {
  consumer.apply(SnsBodyMiddleware).forRoutes(SNS_WEBHOOK_ROUTE);
}
