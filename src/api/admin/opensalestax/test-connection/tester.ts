// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later
//
// Pure test-connection orchestration — split out from route.ts so it's
// unit-testable without the Medusa Express server. Takes an
// `OpenSalesTaxClient`-shape (just needs `healthCheck()`) and shapes the
// inline-message envelope the admin widget renders.

export interface TestConnectionEnvelope {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface HealthClient {
  healthCheck(): Promise<
    | { ok: true; version: string; databaseConnected: boolean; rttMs: number }
    | { ok: false; rttMs: number; error: string }
  >;
}

export async function testConnection(
  client: HealthClient | null,
): Promise<TestConnectionEnvelope> {
  if (client === null) {
    return {
      ok: false,
      error:
        'OPENSALESTAX_URL is not set. Configure the engine URL in your Medusa environment and restart the server.',
    };
  }

  try {
    const result = await client.healthCheck();
    if (result.ok) {
      return {
        ok: true,
        message:
          `Engine v${result.version} reachable — database ` +
          `${result.databaseConnected ? 'connected' : 'disconnected'} ` +
          `(RTT ${result.rttMs} ms)`,
      };
    }
    return { ok: false, error: `Engine unreachable: ${result.error}` };
  } catch (err) {
    // SDK's `healthCheck()` is never-throws, so this branch only fires on
    // truly exotic failures (e.g. injected non-conformant client). Still
    // worth a defensive net so the widget never sees a 500.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Unexpected error: ${message}` };
  }
}
