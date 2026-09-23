/* Playwright's test fixture `use` callback is not a React hook. */
/* eslint react-hooks/rules-of-hooks: off */
import { expect, test as base } from "@playwright/test";

type BrowserDiagnostics = {
  pageErrors: string[];
  consoleErrors: string[];
  serverErrors: string[];
};

export const test = base.extend<{ diagnostics: BrowserDiagnostics }>({
  diagnostics: async ({ page }, use) => {
    const diagnostics: BrowserDiagnostics = {
      pageErrors: [],
      consoleErrors: [],
      serverErrors: [],
    };

    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 500 && new URL(response.url()).origin === "http://127.0.0.1:3000") {
        diagnostics.serverErrors.push(`${response.status()} ${response.url()}`);
      }
    });

    await use(diagnostics);

    expect(diagnostics.pageErrors, "browser uncaught errors").toEqual([]);
    expect(diagnostics.consoleErrors, "browser console errors").toEqual([]);
    expect(diagnostics.serverErrors, "application 5xx responses").toEqual([]);
  },
});

export { expect };
