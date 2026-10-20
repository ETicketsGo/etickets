import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AwsSecretsManagerSecretManager } from '../../../secrets/cloud/aws-secrets-manager.secret-manager';
import { NotificationsModule } from '../../notifications.module';
import { EMAIL_TRANSPORT, selectEmailTransport } from './email.transport';

/**
 * R4: two AWS keys, each reaching only its own service.
 *
 *   - SES_AWS_ACCESS_KEY_ID / SES_AWS_SECRET_ACCESS_KEY: read by the SES client only.
 *   - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY: read by the AWS default credential chain, which
 *     is what the payment secret store signs with. Its behaviour must not change at all.
 *
 * And one transport for every sender: the API (support form, ops alerts) and the worker (every
 * customer notification) both get EMAIL_TRANSPORT from NotificationsModule, so both sign with
 * the dedicated key without any service-specific code.
 */
describe('SES credential isolation', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('builds the payment secret store from the default chain, with no key of its own', async () => {
    // The SES key names are present and must change nothing for the secret store.
    process.env.SES_AWS_ACCESS_KEY_ID = 'AKIASESONLYEXAMPLE';
    process.env.SES_AWS_SECRET_ACCESS_KEY = 'ses-only-secret';
    const constructed: unknown[] = [];
    class FakeClient {
      constructor(args: unknown) {
        constructed.push(args);
      }
      async send() {
        return { SecretString: 'value' };
      }
    }
    class Probe extends AwsSecretsManagerSecretManager {
      protected override async loadModule<T>(): Promise<T | null> {
        return { SecretsManagerClient: FakeClient, GetSecretValueCommand: class {} } as T;
      }
    }
    await new Probe('ap-south-1', 1000).healthCheck();
    // Region only: credentials come from the chain (AWS_ACCESS_KEY_ID), exactly as before.
    expect(constructed).toEqual([{ region: 'ap-south-1' }]);
  });

  it('means no AWS SDK reads the SES key names by itself', () => {
    // The default chain reads AWS_ACCESS_KEY_ID; a name it reads would leak the SES key into
    // the secret store. Pinned so a rename to an SDK-read name is caught here.
    for (const name of ['SES_AWS_ACCESS_KEY_ID', 'SES_AWS_SECRET_ACCESS_KEY']) {
      expect(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']).not.toContain(
        name,
      );
    }
  });

  it('binds EMAIL_TRANSPORT once, from selectEmailTransport, and exports it to the API', () => {
    const providers = Reflect.getMetadata('providers', NotificationsModule) as unknown[];
    const bindings = providers.filter(
      (p): p is { provide: symbol; useFactory: unknown } =>
        typeof p === 'object' &&
        p !== null &&
        (p as { provide?: unknown }).provide === EMAIL_TRANSPORT,
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0].useFactory).toBe(selectEmailTransport);
    expect(Reflect.getMetadata('exports', NotificationsModule)).toContain(EMAIL_TRANSPORT);
  });

  it('runs the worker on the API application module, so it gets the same transport', () => {
    const main = readFileSync(join(__dirname, '../../../../../worker/src/main.ts'), 'utf8');
    expect(main).toMatch(/from '@eticketsgo\/api'/);
    expect(main).toMatch(/createApplicationContext\(AppModule/);
  });

  it('constructs an SES client in exactly one place', () => {
    // A second SESv2Client anywhere would be a sender that skips the dedicated key.
    const root = join(__dirname, '../../../../../..');
    const hits = execFileSync(
      'git',
      [
        'grep',
        '-l',
        '-E',
        'new SESv2Client|new SESClient',
        '--',
        'apps',
        'packages',
        ':!*.spec.ts',
      ],
      { cwd: root, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .map((f) => f.split(String.fromCharCode(92)).join('/'));
    expect(hits).toEqual(['apps/api/src/notifications/channels/transports/email.transport.ts']);
  });
});
