import { ConfigService } from '@nestjs/config';
import {
  deriveEnvVarName,
  deriveKeyVaultName,
  isValidReference,
  maskSecret,
  redactSecrets,
} from './secret-reference';
import { SecretCache } from './secret-cache';
import { EnvironmentSecretManager } from './environment-secret-manager';
import { selectSecretManager } from './secret-manager.factory';
import { SecretResolutionError } from './secret-manager.interface';

describe('secret-reference helpers', () => {
  it('validates well-formed references and rejects bad ones', () => {
    expect(isValidReference('payments/stripe/live/secret-key')).toBe(true);
    expect(isValidReference('payments/stripe')).toBe(true);
    expect(isValidReference('payments')).toBe(false); // needs >= 2 segments
    expect(isValidReference('Payments/Stripe')).toBe(false); // uppercase
    expect(isValidReference('payments//stripe')).toBe(false); // empty segment
    expect(isValidReference('payments/stripe key')).toBe(false); // space
    expect(isValidReference('')).toBe(false);
  });

  it('derives backend keys deterministically', () => {
    expect(deriveEnvVarName('payments/stripe/live/secret-key')).toBe(
      'PAYMENTS_STRIPE_LIVE_SECRET_KEY',
    );
    expect(deriveKeyVaultName('payments/stripe/live/secret-key')).toBe(
      'payments-stripe-live-secret-key',
    );
  });

  it('masks secrets without revealing them', () => {
    expect(maskSecret('sk_live_abcdef123456')).toBe('••••3456');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret(undefined)).toBe('••••');
    expect(maskSecret('sk_live_abcdef123456')).not.toContain('abcdef');
  });

  it('redacts known secret values and long tokens from messages', () => {
    const secret = 'sk_live_supersecretvalue';
    const msg = `boom while using ${secret} at endpoint`;
    const out = redactSecrets(msg, [secret]);
    expect(out).not.toContain('supersecret');
    expect(out).toContain('«redacted»');
  });
});

describe('SecretCache', () => {
  it('caches within TTL and expires after it', () => {
    let t = 0;
    const cache = new SecretCache(1000, () => t);
    cache.set('a', 'v');
    expect(cache.get('a')).toBe('v');
    t = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('ttl <= 0 disables caching', () => {
    const cache = new SecretCache(0, () => 0);
    cache.set('a', 'v');
    expect(cache.get('a')).toBeUndefined();
  });

  it('invalidate clears one or all', () => {
    const cache = new SecretCache(1000, () => 0);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.invalidate('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    cache.invalidate();
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('EnvironmentSecretManager', () => {
  const env = { PAYMENTS_STRIPE_TEST_SECRET_KEY: 'sk_test_123' } as NodeJS.ProcessEnv;

  it('resolves a reference from the derived env var', async () => {
    const sm = new EnvironmentSecretManager(env, 1000);
    expect(await sm.getSecret('payments/stripe/test/secret-key')).toBe('sk_test_123');
  });

  it('fails closed when the secret is not set (no placeholder fallback)', async () => {
    const sm = new EnvironmentSecretManager({}, 1000);
    await expect(sm.getSecret('payments/stripe/test/secret-key')).rejects.toBeInstanceOf(
      SecretResolutionError,
    );
  });

  it('rejects a malformed reference', async () => {
    const sm = new EnvironmentSecretManager(env, 1000);
    await expect(sm.getSecret('bad ref')).rejects.toBeInstanceOf(SecretResolutionError);
  });

  it('never includes the secret value in the resolution error', async () => {
    const sm = new EnvironmentSecretManager({}, 1000);
    const err = (await sm.getSecret('payments/stripe/test/secret-key').catch((e) => e)) as Error;
    expect(err.message).not.toContain('sk_test');
  });

  it('caches resolved secrets and invalidates on demand', async () => {
    const mutable: NodeJS.ProcessEnv = { PAYMENTS_A_B: 'first' };
    let t = 0;
    const sm = new EnvironmentSecretManager(mutable, 10_000, () => t);
    expect(await sm.getSecret('payments/a-b')).toBe('first');
    mutable.PAYMENTS_A_B = 'second';
    expect(await sm.getSecret('payments/a-b')).toBe('first'); // cached
    sm.invalidateCache('payments/a-b');
    expect(await sm.getSecret('payments/a-b')).toBe('second'); // refreshed
  });

  it('getSecrets resolves multiple', async () => {
    const sm = new EnvironmentSecretManager(
      { PAYMENTS_A: 'x', PAYMENTS_B: 'y' } as NodeJS.ProcessEnv,
      1000,
    );
    expect(await sm.getSecrets(['payments/a', 'payments/b'])).toEqual({
      'payments/a': 'x',
      'payments/b': 'y',
    });
  });
});

describe('cloud secret managers (feature-gated, no SDK / no config)', () => {
  it('Azure healthCheck reports missing vault URL', async () => {
    const { AzureKeyVaultSecretManager } = await import('./cloud/azure-key-vault.secret-manager');
    const sm = new AzureKeyVaultSecretManager(undefined, 1000);
    const health = await sm.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.provider).toBe('azure');
  });

  it('AWS getSecret fails closed with a secret-free error when unconfigured', async () => {
    const { AwsSecretsManagerSecretManager } =
      await import('./cloud/aws-secrets-manager.secret-manager');
    const sm = new AwsSecretsManagerSecretManager(undefined, 1000);
    const err = (await sm.getSecret('payments/stripe/live/secret-key').catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.message).not.toContain('secret-key-value');
  });

  it('GCP healthCheck reports missing project id', async () => {
    const { GcpSecretManager } = await import('./cloud/gcp.secret-manager');
    const health = await new GcpSecretManager(undefined, 1000).healthCheck();
    expect(health.healthy).toBe(false);
  });
});

describe('selectSecretManager', () => {
  const cfg = (values: Record<string, unknown>) =>
    ({ get: (k: string) => values[k] }) as unknown as ConfigService;

  it('defaults to the env backend in LOCAL', () => {
    const sm = selectSecretManager(cfg({ SECRET_MANAGER_PROVIDER: 'env', APP_ENV: 'LOCAL' }));
    expect(sm.provider).toBe('env');
  });

  it('rejects the env backend where LIVE credentials can exist', () => {
    // The environments `isLiveAllowed` permits. This is the control's actual purpose:
    // keep money-moving secrets out of a dashboard variable.
    for (const APP_ENV of ['STAGING', 'PRODUCTION']) {
      expect(() => selectSecretManager(cfg({ SECRET_MANAGER_PROVIDER: 'env', APP_ENV }))).toThrow(
        /not permitted where live credentials can exist/,
      );
    }
  });

  /*
    UAT is allowed the env backend, and that is a deliberate correction rather than a
    relaxation. UAT may NEVER hold a live key — boot rejects `rzp_live_`/`sk_live_` there —
    so requiring a managed vault asked it to guard credentials it cannot have. The two
    controls contradicted each other, and the losing side was an environment that started
    and immediately died with an error naming a variable no template mentioned.
  */
  it('allows the env backend in UAT, which cannot hold a live key', () => {
    expect(
      selectSecretManager(cfg({ SECRET_MANAGER_PROVIDER: 'env', APP_ENV: 'UAT' })).provider,
    ).toBe('env');
  });

  it.each(['LOCAL', 'DEV', 'QA', 'UAT'])(
    '%s refuses the env backend once live keys are deliberately allowed there',
    (APP_ENV) => {
      /*
        The hole the name-based rule left open: with this override on, a live key could be
        loaded into QA or DEV and read straight from an env var, because neither was on the
        forbidden list. Now the rule follows the credential, not the label.
      */
      expect(() =>
        selectSecretManager(
          cfg({
            SECRET_MANAGER_PROVIDER: 'env',
            APP_ENV,
            PAYMENT_ALLOW_LIVE_KEYS_LOWER_ENV: 'true',
          }),
        ),
      ).toThrow(/not permitted where live credentials can exist/);
    },
  );

  it('a managed store is still accepted anywhere', () => {
    // Nothing stops an operator using a vault in UAT if they have one; it is simply no
    // longer the only way to boot.
    expect(
      selectSecretManager(cfg({ SECRET_MANAGER_PROVIDER: 'azure', APP_ENV: 'UAT' })).provider,
    ).toBe('azure');
  });

  it('selects cloud backends by configuration', () => {
    expect(
      selectSecretManager(cfg({ SECRET_MANAGER_PROVIDER: 'azure', APP_ENV: 'PRODUCTION' }))
        .provider,
    ).toBe('azure');
    expect(
      selectSecretManager(cfg({ SECRET_MANAGER_PROVIDER: 'aws', APP_ENV: 'PRODUCTION' })).provider,
    ).toBe('aws');
    expect(
      selectSecretManager(cfg({ SECRET_MANAGER_PROVIDER: 'gcp', APP_ENV: 'PRODUCTION' })).provider,
    ).toBe('gcp');
  });
});
