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

/**
 * The page is exactly one viewport tall, and its columns scroll inside it.
 *
 * It used to overflow by a CONSTANT 296px at every viewport size — the signature of a layout bug
 * rather than too much content. `aside.guide` was `height: 100vh` while `main` sat below a header
 * and a tab strip, so the page was always a viewport plus those two however little was on it: on
 * first paint, before anybody had asked for anything, the footer and the bottom of the guide — the
 * Ask button among them — hung off the bottom.
 *
 * Asserted at several viewports because a single height can pass by luck, and the constant offset
 * is what makes this a bug rather than a long page.
 */
test.describe("the page fits its viewport", () => {
  test.skip(!TOKEN, "IMPROMPTU_TOKEN is not set — cannot reach the appliance, so nothing is proven.");

  for (const vp of [{ width: 1400, height: 900 }, { width: 1280, height: 760 }, { width: 1600, height: 1000 }]) {
    test(`no page scroll at ${vp.width}x${vp.height}`, async ({ browser }) => {
      const ctx = await browser.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
        viewport: vp,
      });
      const page = await ctx.newPage();
      await page.goto(APP, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);

      const m = await page.evaluate(() => {
        const badge = document.getElementById("embabel-badge").getBoundingClientRect();
        const ask = document.getElementById("guideGo").getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollHeight - window.innerHeight,
          askAboveBadge: ask.bottom <= badge.top,
          barHidden: document.getElementById("npBar").offsetHeight === 0,
        };
      });

      expect(m.overflow, "the page scrolls on first paint, with nothing loaded").toBeLessThanOrEqual(0);
      /* The badge is fixed to the window, so a column that fills the viewport can hide the one
         control in it somebody has to reach. */
      expect(m.askAboveBadge, "the Ask button is underneath the Embabel badge").toBe(true);
      /* `hidden` loses to any class that sets `display`, which is how an empty now-playing bar
         stayed on screen after being marked hidden. */
      expect(m.barHidden, "the now-playing bar is showing with nothing playing").toBe(true);

      await ctx.close();
    });
  }

  test("a full list scrolls the column, never the page", async ({ browser }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
      viewport: { width: 1400, height: 900 },
    });
    const page = await ctx.newPage();
    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await page.locator('nav.tabs button[data-panel="browse"]').click();
    await page.locator("#eraGo").click();
    await page.waitForTimeout(9000);

    const m = await page.evaluate(() => {
      const stage = document.querySelector(".stage");
      return {
        overflow: document.documentElement.scrollHeight - window.innerHeight,
        stageScrolls: stage.scrollHeight > stage.clientHeight,
      };
    });
    expect(m.stageScrolls, "the composer list did not load, so this proves nothing").toBe(true);
    expect(m.overflow, "a long list grew the page instead of scrolling its column").toBeLessThanOrEqual(0);
    await ctx.close();
  });
});

/**
 * Finding a recording has to be VISIBLE, and has to stop saying it is still looking.
 *
 * Both halves shipped broken, and both were silent. The success path set `w.url`, played the work
 * and returned, never touching the button it had relabelled — so a card whose recording was already
 * playing sat there reading "Looking…" forever. And it scrolled with `window.scrollTo({top: 0})`,
 * which does nothing at a desktop width: `.stage` is the scroller, not the document. The player is
 * at the top of that column, so somebody who had scrolled down through the works got the recording
 * they asked for, out of sight, above them, while the button said the search was still running.
 * Pressing a button and seeing nothing change is indistinguishable from pressing a dead button.
 *
 * The Brave search is stubbed by replacing `window.gateway.brave.webSearch` after load — the app
 * captured that object once, so it sees the replacement — which keeps the test off the live search
 * quota while the rest of the path stays real.
 */
test.describe("finding a recording", () => {
  test.skip(!TOKEN, "IMPROMPTU_TOKEN is not set — cannot reach the appliance, so nothing is proven.");

  test("reveals the player and stops saying 'Looking…'", async ({ browser }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
      viewport: { width: 1280, height: 760 },
    });
    const page = await ctx.newPage();
    await page.goto(APP, { waitUntil: "domcontentloaded" });

    /* The catalogue path: facts, one call, no model — so this is fast and the same every run. */
    await page.locator('nav.tabs button[data-panel="browse"]').click();
    await page.locator("#eraGo").click();
    await page.waitForSelector("#eraOut .card", { timeout: 30000 });
    await page.locator("#eraOut .card").first().click();
    await page.waitForSelector("#composerOut .card", { timeout: 30000 });

    await page.evaluate(() => {
      window.gateway.brave.webSearch = () =>
        Promise.resolve({
          web: { results: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "A Performance, 2019" }] },
        });
    });

    const find = page.locator('button:has-text("Find a recording")').first();
    await expect(find, "no work offered a recording search, so this proves nothing").toHaveCount(1);

    /* Scroll the COLUMN to the bottom first: that is the state the bug needed, and the state a
       reader is actually in when they reach a work far down the list. */
    const before = await page.evaluate(() => {
      const stage = document.querySelector(".stage");
      stage.scrollTop = stage.scrollHeight;
      return { top: stage.scrollTop, player: document.querySelector(".nowplaying").getBoundingClientRect().top };
    });
    expect(before.player, "the player was already in view, so revealing it proves nothing").toBeLessThan(0);

    await find.scrollIntoViewIfNeeded();
    await find.click();
    await page.waitForTimeout(2500);

    const after = await page.evaluate(() => {
      const np = document.querySelector(".nowplaying").getBoundingClientRect();
      return {
        inView: np.bottom > 0 && np.top < window.innerHeight,
        playing: !!document.querySelector("#frame iframe"),
        looking: Array.from(document.querySelectorAll("button")).some((b) => b.textContent.includes("Looking")),
        listen: Array.from(document.querySelectorAll("button")).some((b) => b.textContent.trim() === "Listen"),
      };
    });

    expect(after.playing, "the recording was found but never reached the player").toBe(true);
    expect(after.inView, "the player stayed out of view, so the result looked like nothing happened").toBe(true);
    expect(after.looking, "a button still claims to be searching after the search finished").toBe(false);
    expect(after.listen, "the card did not become one you can listen to").toBe(true);
    await ctx.close();
  });
});

/**
 * The masthead asset is not cropped at the wordmark.
 *
 * `piano_wide_2.jpg` ships with its final U four pixels from the right edge, and this app framed it
 * with a border-radius — drawing a hard line at exactly that point, so the whole graphic read as
 * chopped off. The canvas is now extended with its own texture and the edges are masked out, the
 * way the old app's header did it with `padding: 0 80px` and a gradient.
 *
 * Measured in PIXELS of the served image rather than in CSS, because the failure is a property of
 * the asset: anybody re-exporting it can take the clear ground away again, and a CSS assertion
 * would not notice.
 */
test.describe("the masthead", () => {
  test.skip(!TOKEN, "IMPROMPTU_TOKEN is not set — cannot reach the appliance, so nothing is proven.");

  test("leaves clear ground after the wordmark, and no hard frame", async ({ browser }) => {
    const ctx = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
    const page = await ctx.newPage();
    await page.goto(APP, { waitUntil: "networkidle" });

    const m = await page.evaluate(() => {
      const img = document.querySelector("h1 img");
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const brightest = (x) => {
        let m = 0;
        for (let y = 0; y < c.height; y++) {
          const i = (y * c.width + x) * 4;
          m = Math.max(m, (d[i] + d[i + 1] + d[i + 2]) / 3);
        }
        return m;
      };
      let gap = -1;
      for (let x = c.width - 1; x >= 0; x--) if (brightest(x) > 110) { gap = c.width - 1 - x; break; }
      const cs = getComputedStyle(img);
      return { gap, width: c.width, radius: cs.borderTopRightRadius, mask: cs.maskImage || cs.webkitMaskImage || "none" };
    });

    expect(m.width, "the logo did not decode, so nothing below is measured").toBeGreaterThan(0);
    expect(m.gap, `only ${m.gap}px of clear ground right of the wordmark — it reads as cropped`).toBeGreaterThanOrEqual(60);
    expect(m.radius, "a rounded frame draws a hard edge across the artwork").toBe("0px");
    expect(m.mask, "the asset's edge is not faded, so it ends in a visible rectangle").toContain("gradient");
    await ctx.close();
  });
});
