/*
 * THE TEST THAT WOULD HAVE CAUGHT IT — and that now guards the fix.
 *
 * This app shipped with a YouTube <iframe> as its centrepiece and an `<a target="_blank">` beside it.
 * Both were dead on arrival, and neither failure was visible anywhere except in a real browser
 * pointed at the real appliance:
 *
 *   - Every app is served with a fixed Content-Security-Policy. It declared no `frame-src` and no
 *     `media-src`, so both fell through to `default-src 'self'`: the third-party iframe was refused
 *     and so was any remote <audio>/<video>. Fixed in the host (me#2372) — the policy now names the
 *     video origins, so the player is back and this file checks the page only frames what the policy
 *     actually permits, rather than banning frames and thereby testing the old bug.
 *   - `target="_blank"` does nothing in the Me desktop app, where a renderer has to leave through the
 *     preload bridge. A link that silently does nothing looks identical to a link nobody clicked.
 *
 * The policy lives on the HTTP RESPONSE, which is why this file exists at all. The offline harness
 * the other realms use — the page's own bytes against a stub origin — has no CSP and passes happily
 * on an app that cannot work. Keep both: offline for interactions, this for existence.
 *
 * It needs the appliance up and the realm installed. Skipped, loudly, when it is not — a smoke test
 * that silently passes because nothing was running is worse than no smoke test.
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.IMPROMPTU_BASE || "http://localhost:11043";
const TOKEN = process.env.IMPROMPTU_TOKEN || "";
const APP = `${BASE}/apps/impromptu/impromptu.html`;

test.describe("the served app", () => {
  test.skip(!TOKEN, "IMPROMPTU_TOKEN is not set — cannot reach the appliance, so nothing is proven.");

  test("loads from the appliance with no CSP violation and no console error", async ({ browser }) => {
    const ctx = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
    const page = await ctx.newPage();

    const violations = [];
    const errors = [];
    /*
     * securitypolicyviolation fires in the page, so it is captured by a listener installed before any
     * script runs. This is the event that the iframe would have tripped.
     */
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI });
      });
    });
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    const res = await page.goto(APP, { waitUntil: "domcontentloaded" });
    expect(res, "no response from the appliance").toBeTruthy();
    expect(res.status(), `GET ${APP}`).toBe(200);

    /* The CSP must actually be the one this app was written against; if it loosens, this is where to know. */
    const csp = res.headers()["content-security-policy"] || "";
    expect(csp, "the app CSP is missing entirely").toContain("default-src 'self'");

    await page.waitForTimeout(1500);
    violations.push(...(await page.evaluate(() => window.__cspViolations || [])));

    expect(violations, `CSP blocked something: ${JSON.stringify(violations)}`).toEqual([]);
    /*
     * Gateway calls will fail in this context (the runtime needs a session, not a bearer token) and
     * the page is written to SHOW that rather than throw, so a failed fetch is expected and a thrown
     * error is not. Anything that reaches the console as an error is a defect in the page.
     */
    const real = errors.filter((e) => !/Failed to load resource|net::ERR|401|403/i.test(e));
    expect(real, `console errors: ${real.join(" | ")}`).toEqual([]);

    await ctx.close();
  });

  test("any frame it does embed is one the CSP actually permits", async ({ browser }) => {
    const ctx = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
    const page = await ctx.newPage();
    const res = await page.goto(APP, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    /*
     * This used to assert the page embedded NOTHING, because the app CSP declared no `frame-src` and
     * a YouTube iframe was refused outright. The policy now names the video origins (me#2372), so the
     * player is legitimate and banning it would be testing the old bug. What must still hold is that
     * the page never reaches for an origin the policy does not list — which is the real guard, and
     * the one the CSP-violation test above enforces from the other direction.
     */
    const allowed = (res.headers()["content-security-policy"] || "")
      .split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-src")) || "";
    expect(allowed, "the app CSP no longer declares frame-src").not.toBe("");

    const framed = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe,embed,object"))
        .map((n) => n.getAttribute("src") || "")
        .filter(Boolean));
    for (const src of framed) {
      const origin = new URL(src, location.href).origin;
      expect(allowed, `framed ${origin}, which frame-src does not permit`).toContain(origin);
    }
  });

  test("an external link is INTERCEPTED, not left to target=_blank", async ({ browser }) => {
    const ctx = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
    const page = await ctx.newPage();
    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    /* The chain and the delegated listener must both exist, or nothing external opens anywhere. */
    expect(
      await page.evaluate(() => document.documentElement.getAttribute("data-external-links")),
      "no delegated external-link handler is installed",
    ).toBe("intercepted");

    /*
     * BEHAVIOURAL, not structural. The old bug was a link that looked right and did nothing, so this
     * clicks a real external anchor with `window.me.openExternal` stubbed — the desktop app's bridge —
     * and asserts the click reached it and did NOT navigate this page away. Asserting on markup would
     * have passed for the broken version too.
     */
    await page.evaluate(() => {
      window.__opened = [];
      window.me = { openExternal: (u) => window.__opened.push(u) };
    });
    const before = page.url();
    const anchor = page.locator('a[href^="https://imslp.org"]').first();
    await expect(anchor, "the footer credit link is missing — pick another external anchor").toHaveCount(1);
    await anchor.click();
    await page.waitForTimeout(400);

    expect(await page.evaluate(() => window.__opened), "the click never reached openExternal").toEqual([
      "https://imslp.org/",
    ]);
    expect(page.url(), "clicking an external link navigated the app away from itself").toBe(before);
  });
});
