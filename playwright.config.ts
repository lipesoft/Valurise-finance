import { defineConfig, devices } from "@playwright/test";

const authEnvNames = [
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_PUBLISHABLE_KEY",
  "E2E_SUPABASE_SECRET_KEY",
  "E2E_TEST_IDENTIFIER",
  "E2E_TEST_PASSWORD",
] as const;
const authE2EConfigured = authEnvNames.every((name) => Boolean(process.env[name]));

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

const webServerEnv: Record<string, string> = {
  ...inheritedEnv,
  NEXT_PUBLIC_SUPABASE_URL: authE2EConfigured
    ? process.env.E2E_SUPABASE_URL!
    : "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: authE2EConfigured
    ? process.env.E2E_SUPABASE_PUBLISHABLE_KEY!
    : "e2e-local-only-publishable-key",
  SUPABASE_SECRET_KEY: authE2EConfigured
    ? process.env.E2E_SUPABASE_SECRET_KEY!
    : "e2e-local-only-secret-key",
  VALURISE_MASTER_EMAIL: "e2e-master@valurise.invalid",
  VALURISE_AI_ENCRYPTION_KEY: "e2e-local-only-encryption-key",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    // Do not attach to a developer's server, which may be configured for a live database.
    reuseExistingServer: false,
    timeout: 120_000,
    env: webServerEnv,
  },
});
