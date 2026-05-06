# OpenSalesTax for Medusa

> Replace TaxJar / Avalara with self-hosted [OpenSalesTax](https://github.com/ejosterberg/open-sales-tax). Free, open-source, US sales-tax calculation for Medusa v2.

[![npm](https://img.shields.io/npm/v/@ejosterberg/medusa-plugin-opensalestax.svg)](https://www.npmjs.com/package/@ejosterberg/medusa-plugin-opensalestax) [![npm downloads](https://img.shields.io/npm/dm/@ejosterberg/medusa-plugin-opensalestax.svg)](https://www.npmjs.com/package/@ejosterberg/medusa-plugin-opensalestax) [![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE) [![Medusa](https://img.shields.io/badge/medusa-v2.13%2B-purple)](package.json) [![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](package.json)

**Status:** v0.1.0. Tested against Medusa v2.14.2 + OpenSalesTax engine v0.54. 17 unit tests + a live-engine smoke test + a live-Medusa integration test (provider registers in the Tax Module, gets bound to a US tax region, and returns 6 jurisdictions summing to 9.025% for a ZIP 55401 / $100 cart).

## What this saves you

Most Medusa tax integrations point at paid services:

| Service | Pricing |
|---|---:|
| **Avalara AvaTax** | enterprise pricing |
| **TaxJar** | from $19/mo + transaction fees |
| **Stripe Tax** | 0.5% per transaction |
| **OpenSalesTax + this plugin** | $0 software cost, self-hosted |

You run a small server for the OpenSalesTax engine; this plugin calls into it from Medusa's tax-provider machinery. Tax math runs locally on infrastructure you own.

## Install

```bash
yarn add @ejosterberg/medusa-plugin-opensalestax
# or
npm install @ejosterberg/medusa-plugin-opensalestax
```

The plugin needs the OpenSalesTax engine running somewhere reachable from your Medusa server. The engine is a Docker container; see [the engine's quickstart](https://github.com/ejosterberg/open-sales-tax) for the 5-minute setup.

## Configure

Add the provider under the Tax Module's `providers` array in `medusa-config.ts`:

```ts
import { defineConfig } from "@medusajs/framework/utils"

module.exports = defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/tax",
      options: {
        providers: [
          {
            resolve: "@ejosterberg/medusa-plugin-opensalestax/providers/opensalestax",
            id: "opensalestax",
            options: {
              apiBaseUrl: process.env.OPENSALESTAX_URL!,
              apiKey:     process.env.OPENSALESTAX_API_KEY, // optional

              // Optional: map Medusa product_type_id → OST engine category.
              // OST categories: "general" | "clothing" | "groceries" |
              //                 "prescription_drugs" | "prepared_food" |
              //                 "digital_goods"
              // Empty string = "skip this line — non-taxable"
              defaultCategory: "general",
              categoryByProductTypeId: {
                "ptyp_clothing":   "clothing",
                "ptyp_groceries":  "groceries",
                "ptyp_giftcards":  "",
              },

              timeoutMs: 5000, // optional, default 5000
            },
          },
        ],
      },
    },
  ],
})
```

Then in the Medusa Admin, assign the provider (`tp_opensalestax_opensalestax`) to a Tax Region (e.g., your "United States" region).

## Verifying it works

Drop a $100 product into a cart with a Minneapolis MN shipping address (ZIP 55401). The order summary should show six tax lines summing to $9.03:

| Type     | Jurisdiction                              | Rate    | Tax     |
|----------|-------------------------------------------|---------|---------|
| state    | Minnesota                                 | 6.875%  | $6.88   |
| county   | Hennepin County                           | 0.150%  | $0.15   |
| city     | Minneapolis                               | 0.500%  | $0.50   |
| district | Hennepin County Transit Sales Tax         | 0.500%  | $0.50   |
| district | Metro Area Transportation Sales Tax       | 0.750%  | $0.75   |
| district | Metro Area Sales and Use Tax for Housing  | 0.250%  | $0.25   |
|          |                                           | **9.025%** | **$9.03** |

Each jurisdiction shows up as its own line in the order — useful for audit reconciliation. TaxJar / Avalara show one rolled-up number; OpenSalesTax shows you exactly where every penny went.

## How it works

1. Customer adds a US-shipping address to their cart.
2. Medusa's Tax Module calls `OpenSalesTaxProvider.getTaxLines(items, shipping, context)`.
3. The provider builds a payload of taxable line items with their pre-tax amounts and OST categories.
4. Provider calls `POST /v1/calculate` on your engine.
5. Engine returns per-jurisdiction tax breakdown (state, county, city, special districts).
6. Provider returns one `ItemTaxLineDTO` per `(line_item × jurisdiction)` to Medusa.
7. Medusa sums them and renders them in the cart, checkout, and order summary.

### Country / currency gating

- **Non-US destinations** (anything except `country_code === "US"`) → returns `[]` (no tax line). Engine is US-only.
- **Non-USD line items** (`currency_code !== "usd"`) → that line is skipped. The engine does not handle non-USD amounts.
- **Unparseable ZIP codes** → returns `[]`.

These are silent, fail-soft skips — no exceptions thrown, no checkout interruption.

### Engine errors

If the engine is unreachable, returns 5xx, or times out, the provider logs the error and returns `[]`. **Returning empty means "no tax line"** — don't throw, since Medusa surfaces exceptions to the customer mid-checkout.

You should monitor your engine's uptime independently. The companion engine project ships with a `/v1/health` endpoint and a Docker healthcheck.

## What's NOT in v0.1.0

- **Caching.** Medusa calls `getTaxLines` on every cart-totals recompute. For high-traffic stores, wrap the provider in Medusa's `ICacheService` (60s TTL is reasonable). Planned for v0.2.
- **Shipping tax.** Some US states tax shipping at the destination's general rate; others don't. The current provider returns `[]` for shipping lines. Planned for v0.2 once the engine surfaces a shipping-specific category.
- **Refund handling.** WC connector has refund proration; the Medusa equivalent isn't implemented yet because Medusa's return/refund flow has its own tax handling. Planned for v0.2.
- **Automated CI integration test using `@medusajs/test-utils`'s `moduleIntegrationTestRunner`.** The plugin's verified end-to-end against a real Medusa instance manually; turning that into a CI-runnable Jest suite is planned for v0.2.

## Compatibility

- **Medusa** v2.13+ (peerDependency range; tested against v2.14.2)
- **Node** 20+ (uses built-in `fetch`)
- **OpenSalesTax engine** v0.36+ (recommended)

## Disclaimer

> Tax calculations are provided as-is for convenience. The merchant is solely responsible for tax-collection accuracy and remittance to the appropriate jurisdictions. Verify against your state Department of Revenue before remitting.

## Quality bar

- **17 unit tests** covering construction, ZIP extraction, unit-amount computation, jurisdiction-to-tax-line mapping, the happy path, country/currency/ZIP gates, fail-soft on engine errors, and category mapping
- **Live-engine smoke test** confirms 6 jurisdictions returned for ZIP 55401 / $100 with sum-of-rates = 9.025%
- **TypeScript strict mode** + `noUnusedLocals` + `noUnusedParameters`
- **Apache 2.0 license**

## License

[Apache 2.0](LICENSE).
