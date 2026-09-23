---
agent: playwright-test-generator
description: Generate test plan
---

Generate the requested test scenario from the current Valurise plan. Reuse `tests/e2e/fixtures.ts`, use accessible role/label locators, and mock any API that could write data or contact an external service. Do not embed real names, financial data, identifiers, API keys, or passwords. Never run an authenticated flow unless a dedicated non-production E2E account is configured; keep artifacts disabled for that flow.

Test plan: `specs/coverage.plan.md`
