import { defineConfig } from "@playwright/test";

/*
 * Two kinds of app test, and the realm needs both.
 *
 * `*.spec.mjs` here covers the SERVED app: loaded from the appliance, over HTTP, with the real
 * Content-Security-Policy on the response. That is the only place a blocked iframe or a refused
 * media element shows up, and it is the check this realm shipped without.
 */
export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.mjs",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { viewport: { width: 1280, height: 950 } },
});
