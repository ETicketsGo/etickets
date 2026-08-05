import type { z } from 'zod';
import { apiClient } from './api-client';

/**
 * `apiClient` with the response parsed by a Zod schema.
 *
 * Every read goes through here so a malformed or drifted response fails at the network
 * boundary, where there is one place to handle it, rather than three components deep
 * where it reads as a rendering bug. See features/discovery/schema.ts for why an
 * always-current client cannot be assumed.
 */
export async function getParsed<T extends z.ZodTypeAny>(
  url: string,
  schema: T,
  params?: Record<string, unknown>,
): Promise<z.infer<T>> {
  const { data } = await apiClient.get(url, { params });
  const result = schema.safeParse(data);
  if (!result.success) {
    // The message names the endpoint and the offending paths, and deliberately does NOT
    // include the payload — responses carry names, emails and booking references, and
    // this string reaches Sentry.
    const paths = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.code}`)
      .join('; ');
    throw new ApiContractError(url, paths);
  }
  return result.data;
}

export async function postParsed<T extends z.ZodTypeAny>(
  url: string,
  body: unknown,
  schema: T,
): Promise<z.infer<T>> {
  const { data } = await apiClient.post(url, body);
  const result = schema.safeParse(data);
  if (!result.success) {
    const paths = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.code}`)
      .join('; ');
    throw new ApiContractError(url, paths);
  }
  return result.data;
}

/**
 * A response that did not match what this build expects. Distinct from a network or
 * server error because the remedy is different — retrying will not help, and the user
 * should be told to update the app rather than to check their connection.
 */
export class ApiContractError extends Error {
  constructor(
    readonly endpoint: string,
    readonly issues: string,
  ) {
    super(`Unexpected response from ${endpoint} (${issues})`);
    this.name = 'ApiContractError';
  }
}
