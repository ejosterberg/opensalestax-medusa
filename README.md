# OpenSalesTax for Medusa

> Replace TaxJar / Avalara with self-hosted [OpenSalesTax](https://github.com/ejosterberg/open-sales-tax). Free, open-source, US sales-tax calculation for Medusa v2.

[![npm](https://img.shields.io/npm/v/@ejosterberg/medusa-plugin-opensalestax.svg)](https://www.npmjs.com/package/@ejosterberg/medusa-plugin-opensalestax) [![npm downloads](https://img.shields.io/npm/dm/@ejosterberg/medusa-plugin-opensalestax.svg)](https://www.npmjs.com/package/@ejosterberg/medusa-plugin-opensalestax) [![License](https://img.shields.io/badge/license-Apache%202.0%20OR%20GPL%202.0--or--later-blue)](LICENSE) [![Medusa](https://img.shields.io/badge/medusa-v2.13%2B-purple)](package.json) [![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](package.json)

**Status:** v0.2.0. Tested against Medusa v2.14.2 + OpenSalesTax engine v0.54. **30 unit tests** + live smoke test + live Medusa integration test on a Proxmox VM. v0.2 adds **caching** (~1600x faster on repeat calls during checkout) and **shipping-line tax** (default `general` category, configurable, opt-out-able).

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

              // v0.2: shipping-line tax. Defaults to "general"; set to ""
              // to skip shipping tax entirely; or pick another OST category.
              shippingCategory: "general",

              // v0.2: cache TTL in seconds. Default 60. Set to 0 to disable.
              // Cache uses Medusa's ICacheService from the container.
              cacheTtlSeconds: 60,

              // v0.4 (CP-3): per-state nexus filter. When non-empty,
              // the provider short-circuits the engine call for carts
              // shipping to states not in this list (returns [] —
              // Medusa treats as "no tax"). Unset / empty array =
              // engine called for every cart (v0.3 behavior).
              // Accepts an array of 2-letter codes OR a comma-separated
              // string (e.g. "MN,WI,IA") for env-var compatibility.
              nexusStates: ["MN", "WI", "IA"],

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

## What's new in v0.4.0

- ✅ **Per-state nexus filter (CP-3).** New `nexusStates` provider option. Most US merchants only have nexus in a small set of states; without a filter, every cart goes through the engine even when the merchant has no obligation to collect for that destination. Setting `nexusStates: ["MN", "WI", "IA"]` short-circuits the engine for any other destination — no RTT, no spurious tax lines. Filter is opt-in: omit or pass `[]` and behavior is identical to v0.3. Brings Medusa in line with WooCom v0.5, Vendure v1.2, and Odoo v0.3.

## What's new in v0.2.0

- ✅ **Caching wrap.** Engine responses are cached under a content-addressed key with a configurable TTL (default 60s). The realistic checkout pattern — customer types ZIP, Medusa recomputes cart totals 5 times — now produces 1 engine call instead of 5. Verified ~1600x speedup on repeat calls in our live test (1603ms → 0ms). Cache uses Medusa's `ICacheService` if registered; degrades gracefully to no-cache if the host hasn't configured one.
- ✅ **Shipping-line tax.** Provider now sends shipping lines through the engine alongside item lines. Configurable via the `shippingCategory` option: defaults to `"general"`, set to `""` to skip shipping tax entirely, or pick any of the 6 OST categories. Returned as `ShippingTaxLineDTO` so Medusa renders shipping tax distinctly in the order summary.

## What's NOT yet shipping (planned for v0.3+)

- **Refund / return tax integration.** Medusa's return flow has its own tax path; we don't yet capture per-order breakdown for refund proration. (The WooCommerce sibling connector ships this in its v0.3 + v0.4.1.)
- **Automated CI integration test using `moduleIntegrationTestRunner`.** Turning the manual VM-based integration test into a CI-runnable Jest suite requires a Postgres service container in the GitHub Actions matrix. Designed but deferred.
- **Per-order breakdown storage.** Like the WooCommerce connector's per-order audit table; needs research into Medusa's order-meta patterns.

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
- **Dual-licensed Apache 2.0 OR GPL-2.0-or-later**

## License

Dual-licensed under your choice of [Apache-2.0](LICENSE-APACHE.txt) OR [GPL-2.0-or-later](LICENSE-GPL.txt). See [LICENSE](LICENSE).
