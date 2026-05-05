# Changelog

All notable changes documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org).

## [Unreleased]

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
