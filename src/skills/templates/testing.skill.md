---
id: testing
name: Testing Engineering Standards
domain: testing
tags: [vitest, playwright, testing]
applicablePromptTypes: [test, feature, api, agent]
---

UNIT TESTS: Use Vitest. Every utility function, pure function, and agent method has unit tests. Test file colocated: src/lib/utils/format.ts -> src/lib/utils/format.test.ts. Describe blocks named after the function. It blocks named should [behavior] when [condition].

INTEGRATION TESTS: Every API route has integration tests using Vitest + msw for mocking. Test happy path, auth failure, validation failure, and server error cases for every route.

E2E TESTS: Use Playwright. Every critical user flow has an e2e test: signup, login, core feature use, billing. Tests in e2e/ directory. Page object model pattern: each page has a class with locators and action methods.

MOCKING: Use vi.mock() for module mocks. Use msw for HTTP mocks. Never mock the implementation under test. Always restore mocks in afterEach.

COVERAGE: Minimum 80% line coverage on src/lib/. Minimum 60% on src/components/. Zero coverage acceptable on src/app/ (Next.js pages tested via e2e).

ASSERTIONS: Use expect().toMatchInlineSnapshot() for complex objects. Use expect().toHaveBeenCalledWith() not .toHaveBeenCalled() for spy assertions.
