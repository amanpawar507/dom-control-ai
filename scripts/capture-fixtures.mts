import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { redactText } from "../src/policy/redact.js";

const BASE = "http://localhost:8081/parabank";
const OUT = "tests/fixtures/parabank";

const USER = process.env["PARABANK_USER"] ?? "john";
const PASS = process.env["PARABANK_PASS"] ?? "demo";

const PAGES: Array<{ name: string; path: string; auth: boolean }> = [
  { name: "login", path: "/index.htm", auth: false },
  { name: "findtrans", path: "/findtrans.htm", auth: true },
  { name: "transfer", path: "/transfer.htm", auth: true },
];

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

mkdirSync(OUT, { recursive: true });

// Capture the unauthenticated login page BEFORE signing in. index.htm renders
// the login form only while logged out; once a session exists, the same URL
// serves the post-login account menu instead, so this must happen first.
for (const p of PAGES.filter((x) => !x.auth)) {
  await page.goto(`${BASE}${p.path}`);
  await page.waitForLoadState("domcontentloaded");
  const html = redactText(await page.content());
  writeFileSync(`${OUT}/${p.name}.html`, html, "utf8");
  console.log(`captured ${p.name}.html`);
}

// Fixture account ships inside the container image. Never a real credential.
await page.goto(`${BASE}/index.htm`);
await page.locator('input[name="username"]').fill(USER);
await page.locator('input[name="password"]').fill(PASS);
await page.locator('input[value="Log In"]').click();
await page.waitForURL(/overview\.htm/, { timeout: 15_000 });

for (const p of PAGES.filter((x) => x.auth)) {
  await page.goto(`${BASE}${p.path}`);
  await page.waitForLoadState("domcontentloaded");
  const html = redactText(await page.content());
  writeFileSync(`${OUT}/${p.name}.html`, html, "utf8");
  console.log(`captured ${p.name}.html`);
}

await browser.close();
