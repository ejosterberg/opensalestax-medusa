# Changelog

All notable changes documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org).

## [Unreleased]

## [0.4.2] — 2026-05-19

### Changed

- **CP-8 Phase 5D: bumped `@ejosterberg/opensalestax` constraint to `^0.2.0`.**
  Picks up the new `capabilities()` / `capabilitiesCached()` helpers for engine
  v0.59.0's `/v1/capabilities` endpoint. No merchant-visible behavior change in
  this release — the helper is available to connector code but not yet wired
  into any feature path. Constraint bump only; Test Connection surface
  enrichment deferred to v-next.

## [0.4.1] — 2026-05-19

### Added

- **Test Connection admin widget (CP-4).** New "OpenSalesTax" sidebar
  entry in Medusa admin (`/app/opensalestax`) with a button that hits
  the configured engine's `/v1/health` endpoint and displays the
  response inline ("✓ Engine v0.59.0 reachable — database connected
  (RTT 42 ms)" on success, "✗ OPENSALESTAX_URL is not set" or "✗ HTTP
  500" on failure). Surfaces typo'd engine URLs + unreachable engines
  at config time rather than at first checkout. Brings this connector
  in line with WooCom v0.5, Vendure v1.3, and Saleor v1.0 which already
  shipped this. Wired via:
  - `src/api/admin/opensalestax/test-connection/route.ts` — Medusa
    admin API route (auth-gated by Medusa's admin session middleware)
    that proxies the request to the OpenSalesTax SDK's `healthCheck()`
    against an engine client built from process env.
  - `src/api/admin/opensalestax/test-connection/tester.ts` — pure
    orchestration split out for unit-testability against a stub client.
  - `src/admin/routes/opensalestax/page.tsx` — Medusa admin route
    component (auto-mounted by the admin SDK from the directory name)
    that renders the button + inline result.
  - 5 unit tests on the tester exercising null-client, happy-path,
    db-disconnected, HealthCheckFailure, and unexpected-throw shapes.
- `@types/react@^18.3` devDep — required for the TSX admin component
  to type-check under the existing `tsc --noEmit` lint script.

### Changed

- `tsconfig.json` — added `"jsx": "react-jsx"` and `"DOM"` to `lib` so
  the lint script can type-check the new admin route. The `medusa
  plugin:build` step that produces the published artifact handled JSX
  fine already; only the standalone lint pipeline needed the bump.

## [0.4.0] — 2026-05-19

### Added

- **Per-state nexus filter (CP-3).** New `nexusStates` provider option
  accepts an array of US 2-letter state codes (e.g. `["MN", "WI", "IA"]`)
  or a comma-separated string. When set and non-empty, the provider
  short-circuits the engine call for any cart whose `address.province_code`
  is not in the list, returning `[]` (Medusa treats this as "no tax
  applies"). Unset / empty preserves v0.3 behavior (engine called for
  every cart). Missing / unresolvable `province_code` with the filter
  active is fail-closed — the safer default for a merchant who explicitly
  opted in. Brings this connector in line with WooCommerce v0.5, Vendure
  v1.2, and Odoo v0.3, which already shipped this filter. Major win for
  merchants with limited nexus footprints — typical merchant only has
  1–3 nexus states and was previously paying engine RTT on every cart.
  Resolves improvement-queue item M-2.

## [0.3.1] — 2026-05-17

### Changed

- **Dual-licensed Apache-2.0 OR GPL-2.0-or-later.** Adds GPL-2.0-or-later as
  an alternative license alongside the existing Apache-2.0 grant, enabling
  downstream redistribution in GPL-only ecosystems (WordPress.org plugin
  directory, OCA AGPL-track repositories) without giving up Apache
  compatibility. License files reorganized: `LICENSE-APACHE.txt` (existing
  Apache text, moved from `LICENSE`), `LICENSE-GPL.txt` (new, GNU GPL v2
  text), `LICENSE` (new dual-declaration). SPDX headers updated across
  source files.

### Added

- **`.github/dependabot.yml`** — weekly checks for npm + GitHub Actions
  dependencies, with grouped dev-dep PRs. Brings this repo in line with
  the rest of the OpenSalesTax connector portfolio's supply-chain hygiene
  standard.

## [0.3.0] — 2026-05-14

Drop the embedded `OpenSalesTaxClient` in favor of the standalone
`@ejosterberg/opensalestax` SDK (v0.1.0+). Constitution §6 /
playbook trigger.

No merchant-facing behavior change for the provider. The HTTP wire
contract with the OpenSalesTax engine is identical; only the
package boundary between the Medusa plugin and the HTTP client
moves.

### Changed
- Depend on `@ejosterberg/opensalestax@^0.1.0` instead of the
  embedded `src/providers/opensalestax/client.ts`.
- Pass `allowPrivate: true` to the SDK client — Medusa
  deployments commonly run the engine on the same private
  network. The SDK's SSRF defense is off by default for this
  deployment shape.
- Property accesses moved to the SDK's camelCase TS surface:
  `jurisdiction.rate_pct` → `jurisdiction.ratePct`.
- Internal `CalculateRequest` / `CalculateResponse` /
  `CalculateLineItem` types replaced by SDK equivalents
  (`Address`, `LineItem`, `CalculationResult`).
- Error class rename: `OpenSalesTaxApiError` (with `.status`) →
  `OpenSalesTaxAPIError` (with `.statusCode`). The provider now
  catches both `OpenSalesTaxAPIError` and `OpenSalesTaxNetworkError`
  for fail-soft behavior.
- `src/providers/opensalestax/index.ts` re-exports the SDK's
  public surface (`OpenSalesTaxClient`, `OpenSalesTaxAPIError`,
  `OpenSalesTaxNetworkError`, `Address`, `LineItem`,
  `CalculationResult`, etc.) so downstream code that imported
  these from the plugin keeps working with one rename.

### Removed
- `src/providers/opensalestax/client.ts` (now lives in
  `@ejosterberg/opensalestax`).

### Migration

For most Medusa stores: nothing to do. The provider's public
interface (`@ejosterberg/medusa-plugin-opensalestax/providers/opensalestax`)
is unchanged.

If your code imported the error class from this plugin:

```diff
-import { OpenSalesTaxApiError } from '@ejosterberg/medusa-plugin-opensalestax';
+import { OpenSalesTaxAPIError } from '@ejosterberg/medusa-plugin-opensalestax';
-} catch (e: OpenSalesTaxApiError) { console.log(e.status); }
+} catch (e: OpenSalesTaxAPIError) { console.log(e.statusCode); }
```

## [0.2.0] — 2026-05-05

### Added

- **Caching wrap.** `OpenSalesTaxProvider` now accepts `cache: ICacheService` from the Medusa Awilix container (registered under `Modules.CACHE = "cache"`) and wraps every engine call in a content-addressed cache. Default TTL: 60 seconds, configurable via the `cacheTtlSeconds` plugin option (set to `0` to disable). Cache key is `opensalestax:v1:{zip5}:{sha1(canonical-payload)}` so any change to ZIP / categories / amounts produces a new key, and the prefix lets us invalidate everything in a future release. **Verified end-to-end on VM 909:** call 1 = 1603ms engine round-trip, call 2 with identical input = 0ms cache hit. ~1600x speedup on repeat calls — exactly the pattern Medusa generates as a customer types their address into checkout.
- **Shipping-line tax.** Provider now sends shipping lines through the engine alongside item lines in the same batched request. New `shippingCategory` plugin option (default `"general"`; set to `""` to opt out of shipping tax entirely; set to any of the 6 valid OST categories to override). Shipping tax lines are returned as `ShippingTaxLineDTO` (carrying `shipping_line_id`) so Medusa renders them as their own line in the order summary, distinct from item tax. **Verified end-to-end on VM 909:** $100 item + $10 shipping in MN → 6 item tax lines + 6 shipping tax lines (12 total).
- 13 new unit tests: shipping tax flow (4), shipping opt-out, invalid shippingCategory fallback, cache hit/miss/key-determinism (4), cacheTtlSeconds=0 disables cache, no-cache-module graceful degradation, cache.get throws, cache.set throws.

### Changed

- `OpenSalesTaxProvider`'s constructor deps now optionally accepts `cache: ICacheService`. The deps shape was `{ logger? }`; it's now `{ logger?, cache? }`. Both are optional — provider degrades gracefully if either is missing (no cache → every call hits engine; no logger → silent operation).
- `getTaxLines()`'s second parameter (`shippingLines`) is now consumed instead of being ignored. Behavior change: stores that previously got `[]` for shipping tax now get correct destination-based shipping tax. If you want the v0.1 behavior, set `shippingCategory: ""` in your provider options.
- The static method `OpenSalesTaxProvider.jurisdictionToTaxLine(j, lineItemId)` signature changed to `jurisdictionToTaxLine(j, entry)` where `entry` is a discriminated union of `{ kind: 'item' | 'shipping', medusaId, category, amountStr }`. This is mostly internal — only callers using this static helper directly need to update. The published `getTaxLines` API is unchanged.

### Verified end-to-end

On Proxmox VM 909 (medusa-test, 10.32.161.168, Medusa v2.14.2 + engine v0.54):

- Plugin v0.2.0 tarball installed via `npm install` cleanly
- Medusa restarts clean; provider still registers as `tp_opensalestax_opensalestax` with `is_enabled: true`
- Cache test: ZIP 55401 / $100 cart, two identical calls — 1603ms then 0ms
- Shipping test: ZIP 55401 / $100 item + $10 shipping → 12 tax lines (6 jurisdictions × 2 line types)
- Opt-out test: same cart with `shippingCategory: ""` → 6 tax lines (item only, shipping correctly suppressed)

### Known limitations / planned for v0.3

- **No automated CI integration test using `moduleIntegrationTestRunner`.** Adding it requires a Postgres service container in the GitHub Actions matrix; designed but deferred to v0.3 to keep this release focused.
- **Per-order breakdown storage / refund proration.** The WooCommerce sibling connector stores per-order jurisdiction breakdowns and prorates them on refunds (its v0.3.0 + v0.4.1 features). The Medusa equivalent requires research into Medusa's order-meta and return-flow patterns; deferred.

## [0.1.0] — 2026-05-05

### Verified
- Live integration test passed against a real Medusa v2.14.2 instance (Proxmox VM 909, `medusa-test`):
  - Plugin tarball installed via `npm install` into the Medusa app's `node_modules`
  - `medusa-config.ts` registered the provider under the Tax Module's `providers` array
  - `systemctl restart medusa` reloaded clean — zero errors in the startup log
  - `GET /admin/tax-providers` (admin-authenticated) lists `tp_opensalestax_opensalestax` with `is_enabled: true`
  - US tax region created via `POST /admin/tax-regions` and bound to the provider successfully
  - Provider's `getTaxLines()` invoked from inside the Medusa app's working directory returned 6 jurisdictions for ZIP 55401 / $100 USD, summing to exactly 9.025% — matches the WooCommerce connector's verified calculation against the same engine
- The `0.1.0-alpha.1` tag was held by exactly this integration test; now released.

### No code changes from 0.1.0-alpha.1
- This is a tag bump only — the `.tgz` published as 0.1.0-alpha.1 is byte-identical to 0.1.0 except for the `version` field. The integration test passed against the alpha tarball; no implementation changes were necessary.

## [0.1.0-alpha.1] — 2026-05-05

### Added
- Initial alpha. First turn-key external-API tax provider for Medusa v2.
- `OpenSalesTaxProvider` implementing `ITaxProvider` from `@medusajs/framework/types`. Targets Medusa v2.14.2; peerDependency range `^2.13.0`.
- HTTP client for the OpenSalesTax engine (`/v1/calculate`, `/v1/health`) using built-in Node 20+ `fetch` — no axios/node-fetch dependency.
- Country gating (US-only), currency gating (USD-only per line item), and ZIP normalization (slices `12345-6789` to `12345`).
- Fail-soft on engine errors: returns `[]` and logs rather than throwing, so an engine outage doesn't block checkout.
- Per-jurisdiction tax lines: one `ItemTaxLineDTO` per `(line_item × jurisdiction)`. Medusa sums them and shows the breakdown in the order summary.
- Configurable category mapping: `categoryByProductTypeId` maps Medusa product types to one of the engine's 6 OST categories (`general`, `clothing`, `groceries`, `prescription_drugs`, `prepared_food`, `digital_goods`) or `""` (skip — non-taxable). Defaults to `general` for unmapped types.
- 17 unit tests via Jest + @swc/jest covering construction, helpers, the happy path, and every gate/fail-soft branch.
- Live-engine smoke test (`tests/smoke-engine.ts`) confirms ZIP 55401 / $100 returns 6 jurisdictions summing to 9.025% against the actual engine.
- Apache 2.0 license + DCO-friendly contributing flow.

### Known limitations / planned
- No caching layer. Medusa calls `getTaxLines` on every cart-totals recompute; high-traffic stores should wrap with `ICacheService`. v0.2.
- No shipping-line tax. Provider returns `[]` for shipping lines. v0.2.
- No refund/return tax handling. Medusa's return flow has its own tax path; integration TBD. v0.2.
- No live Medusa integration test in CI yet — depends on a Medusa starter VM that's being provisioned in parallel. Planned before tagging v0.1.0 stable.
- Multi-currency carts are silently skipped (engine is USD-only). A multi-currency-aware provider that converts via Medusa's currency module is out of scope for v0.x.

### Verified end-to-end
- TypeScript strict-mode compile clean
- 17/17 unit tests pass (`npx jest`)
- Live smoke test against engine v0.39 at `http://10.32.161.126:8080`: ZIP 55401, $100 cart → 6 jurisdictions, sum 9.025%
