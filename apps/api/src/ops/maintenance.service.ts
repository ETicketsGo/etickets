import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { opsKeyPrefix } from '../common/redis-namespace';

export interface MaintenanceState {
  enabled: boolean;
  message?: string;
}

/**
 * Redis-backed maintenance flag (no migration). Stored as JSON at a single key.
 *
 * The guard path ({@link isActive}) is cached in-memory for a few seconds and
 * FAILS OPEN: any Redis error returns the last known value or, if none, a
 * disabled state — so an unreachable Redis can NEVER start blocking traffic.
 * Default (key unset) is `{ enabled: false }`, i.e. behaves exactly as today.
 */
@Injectable()
export class MaintenanceService {
  /**
   * Env-scoped key (P6.2). The flag used to live at a single global `etg:maintenance`, so any
   * two environments pointed at one Redis shared it — QA switching maintenance on would have
   * taken production offline. Namespacing it per APP_ENV makes that impossible.
   */
  private readonly key: string;
  /** Guard cache lifetime — bounds Redis reads to ~1 per window per instance. */
  private readonly cacheTtlMs = 3000;
  private cache: { value: MaintenanceState; expiresAt: number } | null = null;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.key = `${opsKeyPrefix(config.get<string>('APP_ENV'))}:maintenance`;
  }

  /** Fresh read of the persisted flag (admin GET path). May throw if Redis is down. */
  async getState(): Promise<MaintenanceState> {
    const raw = await this.redis.client.get(this.key);
    return MaintenanceService.parse(raw);
  }

  /** Persist the flag (admin POST path) and prime the in-memory cache. */
  async setState(input: MaintenanceState): Promise<MaintenanceState> {
    const value = MaintenanceService.normalize(input);
    await this.redis.client.set(this.key, JSON.stringify(value));
    this.cache = { value, expiresAt: Date.now() + this.cacheTtlMs };
    return value;
  }

  /**
   * Guard path: cached + fail-open. NEVER throws. On any Redis error it returns
   * the last known value, or a disabled state if nothing is cached yet — so
   * traffic is never blocked because Redis is unreachable.
   */
  async isActive(): Promise<MaintenanceState> {
    const now = Date.now();
    if (this.cache && now < this.cache.expiresAt) return this.cache.value;
    try {
      const value = await this.getState();
      this.cache = { value, expiresAt: now + this.cacheTtlMs };
      return value;
    } catch {
      // Fail open: prefer the last known good value; otherwise treat as disabled.
      return this.cache?.value ?? { enabled: false };
    }
  }

  private static normalize(input: MaintenanceState): MaintenanceState {
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    return message
      ? { enabled: Boolean(input.enabled), message }
      : { enabled: Boolean(input.enabled) };
  }

  private static parse(raw: string | null): MaintenanceState {
    if (!raw) return { enabled: false };
    try {
      const parsed = JSON.parse(raw) as Partial<MaintenanceState>;
      return MaintenanceService.normalize({
        enabled: Boolean(parsed.enabled),
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
      });
    } catch {
      return { enabled: false };
    }
  }
}
