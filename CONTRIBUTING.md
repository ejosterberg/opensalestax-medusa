# Contributing to OpenSalesTax for Medusa

Apache 2.0 licensed. DCO sign-off (`git commit -s`) required on every commit; CI enforces. No AI co-author trailers.

## Local dev

```bash
git clone https://github.com/ejosterberg/opensalestax-medusa
cd opensalestax-medusa
npm install
```

## Quality gate

Run before submitting any PR:

```bash
npx tsc --noEmit                # strict-mode type check
npx jest                        # unit tests
npx ts-node tests/smoke-engine.ts  # OPTIONAL — needs an OpenSalesTax engine reachable
```

`OPENSALESTAX_URL` env var overrides the default `http://10.32.161.126:8080` in the smoke test.

## Coding conventions

- TypeScript strict mode; `noUnusedLocals` and `noUnusedParameters` are enabled.
- No top-level `await`. The plugin's published bundle is CJS via `medusa plugin:build`.
- No new runtime dependencies without a strong reason. Built-in `fetch` (Node 20+) replaces axios / node-fetch.
- Defaults to no comments. Add one only when the WHY is non-obvious.
- Dual-licensed Apache-2.0 OR GPL-2.0-or-later + SPDX header on every source file:
  ```ts
  // SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later
  ```

## Reporting

Security issues: email **ejosterberg@gmail.com** directly. Don't open public GitHub issues for vulnerabilities.

## Roadmap (v0.2)

- Wrap `getTaxLines` with Medusa's `ICacheService` (short TTL).
- Shipping-line tax handling.
- Live integration test using `@medusajs/test-utils`'s `moduleIntegrationTestRunner`.
- Refund/return tax integration.
