---
agent: playwright-test-planner
description: Create test plan
---

Create a browser test plan for the Valurise personal-finance application. Focus on critical flows that can run safely against the local app with mocked APIs: sign-in validation, access request/approval waiting state, password recovery feedback, responsive login, and dashboard interactions only when a dedicated test account is explicitly configured. Never use production credentials or alter real financial records. Prefer high-value, deterministic scenarios over broad CRUD coverage.

- Seed file: `tests/e2e/seed.spec.ts`
- Test plan: `specs/coverage.plan.md`
