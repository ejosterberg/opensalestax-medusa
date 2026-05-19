// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later
//
// Medusa admin route — "OpenSalesTax" sidebar entry that exposes the
// Test Connection button.
//
// Path:    /app/opensalestax  (auto-mounted by Medusa admin SDK from
//          the directory name `src/admin/routes/opensalestax/`).
// Backed by: POST /admin/opensalestax/test-connection (see ../../api/...)
//
// Why a dedicated route rather than a widget injected into an existing
// page? Medusa v2's tax-provider plugins don't surface a settings page
// in core admin yet, so there's no obvious injection zone for the
// button. A standalone route is discoverable in the sidebar and works
// on every Medusa admin install without core changes.

import { defineRouteConfig } from '@medusajs/admin-sdk';
import { useState } from 'react';

interface TestEnvelope {
  ok: boolean;
  message?: string;
  error?: string;
}

const OpenSalesTaxPage = () => {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestEnvelope | null>(null);

  const runTest = async () => {
    setBusy(true);
    setResult(null);
    try {
      const resp = await fetch('/admin/opensalestax/test-connection', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const data = (await resp.json()) as TestEnvelope;
      setResult(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResult({ ok: false, error: `Request failed: ${message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '720px' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.5rem' }}>
        OpenSalesTax
      </h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        Probe the configured engine&rsquo;s <code>/v1/health</code> endpoint
        and confirm Medusa can reach it. Catches typo&rsquo;d engine URLs
        before they bite at checkout.
      </p>

      <p>
        <button
          type="button"
          onClick={runTest}
          disabled={busy}
          style={{
            background: '#2271b1',
            color: 'white',
            border: 0,
            padding: '0.6em 1.4em',
            borderRadius: '3px',
            cursor: busy ? 'wait' : 'pointer',
            fontSize: '1em',
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? 'Testing…' : 'Test connection'}
        </button>
        {result !== null && (
          <span
            style={{
              marginLeft: '1em',
              fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
              color: result.ok ? 'green' : '#d63638',
            }}
          >
            {result.ok ? `✓ ${result.message ?? 'OK'}` : `✗ ${result.error ?? 'Unknown error'}`}
          </span>
        )}
      </p>

      <div
        style={{
          marginTop: '2em',
          padding: '0.8em 1em',
          background: '#fff8e5',
          borderLeft: '4px solid #ffb900',
          borderRadius: '2px',
          fontSize: '0.9em',
          color: '#555',
        }}
      >
        Engine URL is configured via the <code>OPENSALESTAX_URL</code>{' '}
        environment variable. After changing the value, restart the Medusa
        server before re-testing.
      </div>
    </div>
  );
};

export const config = defineRouteConfig({
  label: 'OpenSalesTax',
});

export default OpenSalesTaxPage;
