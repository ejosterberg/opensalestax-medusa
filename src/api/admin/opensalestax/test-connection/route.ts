// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later
//
// Admin API endpoint backing the "Test Connection" widget.
//
// Path:    POST /admin/opensalestax/test-connection
// Auth:    Medusa admin session (mounted under /admin/*).
// Reads:   OPENSALESTAX_URL + OPENSALESTAX_API_KEY env vars (same source
//          the tax provider reads at runtime, so a green check guarantees
//          the same config the calculate path will use).
// Returns: { ok: true,  message: '...' }  on success
//          { ok: false, error: '...' }    on failure
//
// Equivalent of the admin "Test Connection" button shipped in WooCom v0.5
// / Vendure v1.3 / Saleor v1.0. Catches typo'd engine URLs at config time
// rather than at first checkout.

import { OpenSalesTaxClient } from '@ejosterberg/opensalestax';

import { testConnection } from './tester';

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework';

/**
 * Build the client from process env. Returns null if the engine URL is unset
 * so the handler can report a clean config error instead of constructing
 * an invalid client.
 */
function buildClientFromEnv(): OpenSalesTaxClient | null {
  const baseUrl = process.env.OPENSALESTAX_URL;
  if (!baseUrl || baseUrl.trim() === '') {
    return null;
  }
  return new OpenSalesTaxClient({
    baseUrl: baseUrl.trim(),
    apiKey: process.env.OPENSALESTAX_API_KEY ?? null,
    timeoutMs: Number(process.env.OPENSALESTAX_TIMEOUT_MS ?? 5000),
    allowPrivate: process.env.OPENSALESTAX_ALLOW_PRIVATE === 'true',
  });
}

export const POST = async (
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> => {
  const client = buildClientFromEnv();
  const envelope = await testConnection(client);
  // Always 200 — the envelope's `ok` flag tells the widget what to render.
  res.status(200).json(envelope);
};
