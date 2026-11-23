import { expect } from '@jest/globals';

/**
 * Shared auth-response envelope contract (issue #972).
 *
 * Both entrypoints (`index.ts` → full, `app.ts` → hackathon) mount the same
 * wallet-auth router. These assertions are the single source of truth for the
 * *shape* clients may rely on, so a change to one app cannot silently drift
 * away from the other.
 */

export interface ContractResponse {
  status: number;
  body: any;
}

export type PostJson = (
  path: string,
  body: Record<string, unknown>,
) => Promise<ContractResponse>;

export function expectChallengeEnvelope(res: ContractResponse): void {
  expect(res.status).toBe(200);
  expect(res.body).toEqual(
    expect.objectContaining({
      challenge: expect.any(String),
      domain: expect.any(String),
      homeDomain: expect.any(String),
      expiresAt: expect.any(String),
    }),
  );
  expect(res.body.challenge).toContain('Domain:');
  expect(res.body.challenge).toContain('Home Domain:');
  expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
}

export function expectConnectEnvelope(
  res: ContractResponse,
  walletAddress: string,
): void {
  expect(res.status).toBe(200);
  expect(res.body).toEqual(
    expect.objectContaining({
      token: expect.any(String),
      user: expect.objectContaining({
        id: expect.any(String),
        walletAddress,
        createdAt: expect.any(String),
        lastLoginAt: expect.any(String),
      }),
    }),
  );
  expect(res.body.token.length).toBeGreaterThan(10);
}

/**
 * Standard error envelope shared by both entrypoints. The full app's
 * `errorHandler.middleware` and the hackathon app's `errorHandler` must both
 * emit these fields for auth validation failures.
 */
export function expectAuthErrorEnvelope(res: ContractResponse): void {
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.body).toEqual(
    expect.objectContaining({
      error: expect.any(String),
      message: expect.any(String),
      code: expect.any(String),
      path: expect.any(String),
      requestId: expect.any(String),
      timestamp: expect.any(String),
    }),
  );
  expect(new Date(res.body.timestamp).getTime()).not.toBeNaN();
}

/**
 * Run the full auth envelope contract against one app entrypoint.
 * Both suites call this exact function, which is what guarantees parity.
 */
export async function assertAuthEnvelopeContract(
  post: PostJson,
  walletAddress: string,
): Promise<void> {
  expectChallengeEnvelope(
    await post('/api/auth/challenge', { walletAddress }),
  );
  expectConnectEnvelope(
    await post('/api/auth/connect', {
      walletAddress,
      challenge: 'contract-challenge',
      signature: 'contract-signature',
    }),
    walletAddress,
  );
  expectAuthErrorEnvelope(await post('/api/auth/challenge', {}));
}
