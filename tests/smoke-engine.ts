// SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later

/**
 * One-off smoke test against the live OpenSalesTax engine on Eric's lab.
 * Not part of the unit suite â€” run manually:
 *   npx ts-node tests/smoke-engine.ts
 *
 * Purpose: verify the HTTP client's fetch path actually round-trips against
 * a real engine. If this passes, the unit-test stubs are well-shaped and
 * the plugin is ready for Medusa-side integration testing.
 */

import { OpenSalesTaxProvider } from '../src/providers/opensalestax/service';
import type { ItemTaxCalculationLine, TaxCalculationContext } from '@medusajs/framework/types';

const provider = new OpenSalesTaxProvider(
  { logger: console as unknown as any },
  { apiBaseUrl: process.env.OPENSALESTAX_URL ?? 'http://10.32.161.126:8080' },
);

const itemLines: ItemTaxCalculationLine[] = [
  {
    line_item: {
      id: 'li_smoke_1',
      product_id: 'p_smoke',
      quantity: 1,
      unit_price: 100,
      currency_code: 'usd',
    } as unknown as ItemTaxCalculationLine['line_item'],
    rates: [],
  },
];

const context: TaxCalculationContext = {
  address: {
    country_code: 'US',
    province_code: 'mn',
    postal_code: '55401',
    city: 'Minneapolis',
  },
};

(async () => {
  console.log('[smoke] calling engine for $100 / general / ZIP 55401...');
  const result = await provider.getTaxLines(itemLines, [], context);
  if (result.length === 0) {
    console.error('[smoke] FAIL: empty result. Engine unreachable, or all lines filtered.');
    process.exit(1);
  }
  console.log(`[smoke] PASS: ${result.length} tax lines returned`);
  let total = 0;
  for (const line of result) {
    console.log(
      '  - ' +
        ('line_item_id' in line ? line.line_item_id : line.shipping_line_id) +
        '  ' +
        line.name +
        '  ' +
        line.rate +
        '%',
    );
    total += line.rate;
  }
  console.log(`[smoke] sum of rates: ${total.toFixed(3)}% (expect ~9.025% for ZIP 55401)`);
})().catch((err) => {
  console.error('[smoke] threw:', err);
  process.exit(1);
});
