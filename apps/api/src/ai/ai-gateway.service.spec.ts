import { AiGateway } from './ai-gateway.service';
import { PromptRegistry } from './prompts/prompt-registry';
import { AiUnavailableError, type AiProvider } from './provider/ai-provider';

function makeAi(enabled: boolean, provider = enabled ? 'openai' : 'disabled') {
  return { isEnabled: () => enabled, provider, timeoutMs: 5000, maxRetries: 1, costPer1kMinor: 0 };
}

function makeGateway(enabled: boolean, provider: AiProvider) {
  const usage = { record: jest.fn().mockResolvedValue(undefined) };
  const gateway = new AiGateway(
    makeAi(enabled) as never,
    usage as never,
    new PromptRegistry(),
    provider,
  );
  return { gateway, usage };
}

const okProvider: AiProvider = {
  name: 'openai',
  complete: async () => ({ text: 'rephrased', tokensIn: 10, tokensOut: 5 }),
};
const failProvider: AiProvider = {
  name: 'openai',
  complete: async () => {
    throw new AiUnavailableError('boom');
  },
};

describe('AiGateway (WS10 safety)', () => {
  it('falls back and records "disabled" when AI is off (default posture)', async () => {
    const { gateway, usage } = makeGateway(
      false,
      new (class implements AiProvider {
        name = 'disabled';
        async complete(): Promise<never> {
          throw new AiUnavailableError();
        }
      })(),
    );
    const res = await gateway.run({ feature: 'test', promptKey: 'event.summary', input: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.fallback).toBe(true);
    expect(usage.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'disabled' }));
  });

  it('redacts PII before the provider sees the input', async () => {
    let seen = '';
    const spy: AiProvider = {
      name: 'openai',
      complete: async (req) => {
        seen = req.input;
        return { text: 'ok', tokensIn: 1, tokensOut: 1 };
      },
    };
    const { gateway } = makeGateway(true, spy);
    await gateway.run({ feature: 'test', promptKey: 'event.summary', input: 'mail me at a@b.com' });
    expect(seen).toContain('[EMAIL]');
    expect(seen).not.toContain('a@b.com');
  });

  it('returns the provider text and records success when enabled', async () => {
    const { gateway, usage } = makeGateway(true, okProvider);
    const res = await gateway.run({ feature: 'test', promptKey: 'event.summary', input: 'facts' });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('rephrased');
    expect(usage.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('never throws into the caller — provider failure yields a fallback', async () => {
    const { gateway } = makeGateway(true, failProvider);
    const res = await gateway.run({ feature: 'test', promptKey: 'event.summary', input: 'x' });
    expect(res.ok).toBe(false);
    expect(res.fallback).toBe(true);
  });
});
