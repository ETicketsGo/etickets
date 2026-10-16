import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  FEATURE_DEFAULTS,
  MARKETS,
  isFeatureEnabled,
  parseMarketProviderMap,
  routeNotificationProvider,
  type FeatureFlag,
} from '@eticketsgo/shared-types';
import { Public } from '../common/decorators';
import { messageContentLoggable } from '../notifications/channels/transports/content-logging';

/**
 * The countries whose mobile numbers can be sent a sign-in code from THIS deployment.
 *
 * ── WHY `phoneSignIn` WAS NOT ENOUGH ───────────────────────────────────────────────
 * `phoneSignIn` only says text messages have not been declared off. On an environment whose
 * SMS provider is still `log`, or whose routing table has no provider for India, it stayed
 * true, so the storefront offered a Mobile form to everybody and the request-code call then
 * failed with 503 SMS_UNAVAILABLE - after the person had typed their number. Seen on QA for
 * every Indian number. The page cannot avoid that dead end unless it knows in advance.
 *
 * ── WHY IT IS WORKED OUT FROM THE SAME RULES THE SEND USES ─────────────────────────
 * The route comes from `routeNotificationProvider` with the same table the SMS channel reads,
 * and a `log` route counts only where `messageContentLoggable` says the console IS the
 * delivery (LOCAL/DEV) - the exact test `PhoneOtpService.requestCode` fails closed on. So this
 * list cannot claim a country the send would refuse for that reason.
 *
 * It is a hint, not a gate: a configured provider can still fail at send time (missing keys, a
 * carrier refusal), and the storefront keeps handling that answer too. It names countries
 * only - never which provider, never a credential.
 */
export function smsReachableCountries(config: Pick<ConfigService, 'get'>): string[] {
  if (config.get<string>('SMS_ENABLED') === 'false') return [];
  const marketProviders = parseMarketProviderMap(config.get<string>('SMS_PROVIDER_BY_MARKET'));
  const defaultProvider = config.get<string>('SMS_PROVIDER') ?? 'log';
  const consoleIsDelivery = messageContentLoggable(config);
  return MARKETS.filter((market) => {
    /*
      Routed by a NUMBER in that country, not by the country, because that is how a sign-in
      code is routed: the OTP message carries no country, only the destination. The two differ
      for +1, which is shared by the United States and Canada - a table naming only US cannot
      tell a +1 number's market, refuses it as ambiguous, and so must not be reported as able
      to text the United States.
    */
    const route = routeNotificationProvider({
      marketProviders,
      defaultProvider,
      destination: `+${market.callingCode}9000000000`,
    });
    if (!route.ok) return false;
    return route.provider !== 'log' || consoleIsDelivery;
  }).map((market) => market.code);
}

@ApiTags('public')
@Controller('capabilities')
export class CapabilitiesController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Resolved feature flags (capabilities) for the platform.' })
  get(): Record<string, boolean | string[]> {
    const flags = Object.keys(FEATURE_DEFAULTS) as FeatureFlag[];
    return {
      ...Object.fromEntries(flags.map((flag) => [flag, isFeatureEnabled(flag)])),
      // Read-only: false when SMS is declared off, so the storefront hides phone sign-in.
      phoneSignIn: this.config.get<string>('SMS_ENABLED') !== 'false',
      // Which numbers a code can actually reach - see `smsReachableCountries`.
      phoneSignInCountries: smsReachableCountries(this.config),
    };
  }
}
