// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

import {
  testConnection,
  type HealthClient,
} from '../../src/api/admin/opensalestax/test-connection/tester';

const okClient = (
  payload: {
    version?: string;
    databaseConnected?: boolean;
    rttMs?: number;
  } = {},
): HealthClient => ({
  healthCheck: jest.fn().mockResolvedValue({
    ok: true,
    version: payload.version ?? '0.59.0',
    databaseConnected: payload.databaseConnected ?? true,
    rttMs: payload.rttMs ?? 42,
  }),
});

const failingClient = (error: string, rttMs = 100): HealthClient => ({
  healthCheck: jest.fn().mockResolvedValue({
    ok: false,
    rttMs,
    error,
  }),
});

const throwingClient = (err: unknown): HealthClient => ({
  healthCheck: jest.fn().mockRejectedValue(err),
});

describe('testConnection', () => {
  it('reports config error when client is null', async () => {
    const env = await testConnection(null);
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/OPENSALESTAX_URL/);
  });

  it('shapes a success message with version + db state + RTT', async () => {
    const env = await testConnection(okClient());
    expect(env.ok).toBe(true);
    expect(env.message).toContain('0.59.0');
    expect(env.message).toContain('connected');
    expect(env.message).toContain('42 ms');
  });

  it('reports db disconnected distinctly while still ok=true', async () => {
    // Engine reachable + responding, but DB down — still surface state to the operator.
    const env = await testConnection(okClient({ databaseConnected: false }));
    expect(env.ok).toBe(true);
    expect(env.message).toContain('disconnected');
  });

  it('bubbles HealthCheckFailure as an error envelope', async () => {
    const env = await testConnection(failingClient('HTTP 500'));
    expect(env.ok).toBe(false);
    expect(env.error).toContain('HTTP 500');
    expect(env.error).toContain('unreachable');
  });

  it('catches unexpected throws defensively', async () => {
    // SDK's healthCheck() is never-throws, but defend the widget anyway.
    const env = await testConnection(throwingClient(new Error('boom')));
    expect(env.ok).toBe(false);
    expect(env.error).toContain('Unexpected error');
    expect(env.error).toContain('boom');
  });
});
