import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

/*
 * Browser smoke test: boots the real server on a throwaway data folder, drives the built client
 * in Chrome at a phone width (home, room, queue drag, menu, sheets, admin) and saves screenshots.
 *   npm run build && npm run smoke
 * Needs: puppeteer-core (dev dependency) and Chrome. Set CHROME_PATH if Chrome is not in the default place.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(repo + "/server/package.json");
const { io } = require("socket.io-client");
const shots = path.join(tmpdir(), "karaoke-smoke-shots");
const CHROME = process.env.CHROME_PATH ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
mkdirSync(shots, { recursive: true });
const PORT = Number(process.env.SMOKE_PORT ?? 3999), BASE = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "karaoke-smoke-"));
const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: path.join(repo, "server"), env: { ...process.env, PORT: String(PORT), KARAOKE_DATA_DIR: dataDir, KARAOKE_FAKE_YOUTUBE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 100 && !log.includes("listening"); i++) await new Promise((r) => setTimeout(r, 200));
const results = [];
const check = (name, ok, extra = "") => { results.push([ok, name, extra]); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };
const errors = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function clickText(page, sel, text) {
  const ok = await page.evaluate((sel, text) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text)); if (el) { el.click(); return true; } return false; }, sel, text);
  return ok;
}
const shot = (page, n) => page.screenshot({ path: `${shots}/${n}.png` });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await shot(page, "01-home");
  check("home renders", !!(await page.$("h1")) && (await page.$eval("h1", (e) => e.textContent)).includes("Karaoke"));
  await clickText(page, "button", "Start a party");
  await page.waitForSelector("input[placeholder='Your name']", { timeout: 8000 });
  await page.type("input[placeholder='Your name']", "Alice");
  await clickText(page, "button", "Join the party");
  await page.waitForSelector(".app", { timeout: 8000 });
  const code = page.url().match(/\/r\/(\w{4})/)[1];
  check("joined room as host", await page.evaluate(() => document.body.textContent.includes("Host")), code);
  await shot(page, "02-room");

  // a second singer adds songs over the socket
  const bot = io(BASE, { transports: ["websocket"] });
  await new Promise((r) => bot.on("connect", r));
  const join = await new Promise((r) => bot.emit("room:join", { code, singerId: "bot-1", name: "Bot" }, r));
  check("bot joined", join.ok);
  for (const n of ["aaaaaaaaa01", "aaaaaaaaa02", "aaaaaaaaa03", "aaaaaaaaa04"]) await new Promise((r) => bot.emit("queue:add", { video: { videoId: n, title: "Test song " + n.slice(-2), channel: "Ch", duration: "3:00", thumb: "" } }, r));
  await sleep(500);
  // search paging, against the server's made-up YouTube (no network)
  await (await page.$("input[type=search]")).type("abba");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".song", { timeout: 8000 });
  const label = () => page.$eval(".pager span", (e) => e.textContent ?? "");
  const waitLabel = (start) => page.waitForFunction((s) => document.querySelector(".pager span")?.textContent?.startsWith(s), { timeout: 8000 }, start);
  const titles = () => page.$$eval(".song .song-title", (l) => l.map((e) => e.textContent));
  const page1 = await titles();
  check("search shows the first page", page1.length === 25 && (await label()).startsWith("1–25"), await label());
  await clickText(page, ".pager button", "Next");
  await waitLabel("26");
  const page2 = await titles();
  check("Next shows the second page", page2.length === 25 && !page2.some((x) => page1.includes(x)), await label());
  await clickText(page, ".pager button", "Prev");
  await waitLabel("1–25");
  check("Prev goes back to the first page", JSON.stringify(await titles()) === JSON.stringify(page1));
  await clickText(page, ".pager button", "Next");
  await waitLabel("26");
  await page.select(".page-size select", "10");
  await waitLabel("21");
  check("a new page size keeps the first song on screen", (await titles()).includes(page2[0]), await label());
  await page.select(".page-size select", "25");
  await waitLabel("1–25");
  await shot(page, "03a-search");
  // page jumping: « and » move 3 pages, and » stops at the end
  const press = (symbol) => page.evaluate((s) => [...document.querySelectorAll(".pager button")].find((b) => b.textContent.trim() === s)?.click(), symbol);
  await press("»");
  await waitLabel("76");
  check("» jumps three pages ahead", (await label()).startsWith("76–100"), await label());
  await shot(page, "03b-jumped");
  check("no horizontal overflow (search pager)", (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  await press("«");
  await waitLabel("1–25");
  check("« jumps back to the start", (await titles()).join() === page1.join());
  let jumps = 0;
  while (jumps < 12 && !(await page.$eval(".pager button[aria-label^=Forward]", (b) => b.disabled))) {
    const before = await label();
    await press("»");
    await page.waitForFunction((b) => document.querySelector(".pager span")?.textContent !== b && !document.querySelector(".pager span")?.textContent.startsWith("Loading"), { timeout: 8000 }, before);
    jumps++;
  }
  const endLabel = await label();
  check("» stops at the end of the results", await page.$eval(".pager button[aria-label^=Forward]", (b) => b.disabled), `${jumps} jumps, ${endLabel}`);
  check("the last page has no plus", !endLabel.endsWith("+"), endLabel);
  await press("«");
  await page.waitForFunction(() => !document.querySelector(".pager span")?.textContent.startsWith("Loading"), { timeout: 8000 });
  check("« goes back three pages from the end", parseInt(await label()) === parseInt(endLabel) - 3 * 25, `${await label()} (the end was ${endLabel})`);
  check("a complete list has no plus even when pages follow", !(await label()).endsWith("+"), await label());

  await clickText(page, ".tabs button", "Queue");
  await sleep(300);
  await shot(page, "03-queue");
  const rows = await page.$$eval(".queue li, ol li, ul.queue li", (l) => l.length);
  check("queue shows songs", rows >= 3, `rows=${rows}`);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no horizontal overflow (room, 420px)", (await overflow()) <= 0, `${await overflow()}px wider than the screen`);

  // drag reorder: grab the last grip, move it to the top
  const grips = await page.$$(".grip");
  if (grips.length >= 2) {
    const titles = async () => page.$$eval(".grip", (g) => g.map((x) => x.getAttribute("aria-label")));
    const before = await titles();
    const last = await grips[grips.length - 1].boundingBox(), first = await grips[0].boundingBox();
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + 5, (last.y + first.y) / 2, { steps: 8 });
    await page.mouse.move(first.x + 5, first.y - 4, { steps: 8 });
    await page.mouse.up();
    await sleep(700);
    const after = await titles();
    check("drag reorders queue", JSON.stringify(before) !== JSON.stringify(after), `${before.length} rows`);
    await shot(page, "04-after-drag");
  } else check("drag reorders queue", false, "no grips");

  // menu + toggles
  await page.click("button[aria-label='Menu']");
  await sleep(300);
  await shot(page, "05-menu");
  const fair = await page.$("button[role=menuitemcheckbox]:nth-of-type(2)");
  const state = () => page.$$eval("button[role=menuitemcheckbox]", (b) => b.map((x) => x.getAttribute("aria-checked")));
  const s0 = await state();
  await clickText(page, "button[role=menuitemcheckbox]", "Fair queue");
  await sleep(500);
  const s1 = await state();
  check("fair queue toggle flips", s0.join() !== s1.join(), `${s0} -> ${s1}`);
  await clickText(page, "button[role=menuitemcheckbox]", "Everyone can control");
  await sleep(400);
  check("everyone-can-control toggle flips", (await state()).join() !== s1.join());
  // theme swatch
  await page.$$eval(".swatches button", (b) => b[1]?.click());
  await sleep(400);
  check("room colour changes", (await page.evaluate(() => document.documentElement.dataset.theme)) !== "orange", await page.evaluate(() => document.documentElement.dataset.theme));
  // sheets
  for (const [label, probe] of [["Room history", "Room history"], ["Invite", "Invite singers"], ["Change your name", "Change your name"], ["Make someone else host", "Make someone else host"]]) {
    const opened = await clickText(page, "button.menu-item", label);
    await sleep(300);
    const seen = await page.evaluate((p) => document.body.textContent.includes(p), probe);
    check(`menu → ${label}`, opened && seen);
    check(`no horizontal overflow (${label})`, (await overflow()) <= 0, `${await overflow()}px`);
    await shot(page, "06-" + label.replace(/\W+/g, "-"));
    await page.keyboard.press("Escape");
    // close whatever is open: click backdrop, else reopen menu path
    await page.evaluate(() => (document.querySelector(".dialog-backdrop, .sheet-backdrop"))?.click());
    await sleep(250);
    if (!(await page.$("button.menu-item"))) { await page.click("button[aria-label='Menu']"); await sleep(250); }
  }
  // host dialog confirm path
  await clickText(page, "button.menu-item", "Make someone else host");
  await sleep(300);
  const pick = await page.evaluate(() => { const b = [...document.querySelectorAll(".sheet button")].find((x) => x.textContent.includes("Bot")); b?.click(); return !!b; });
  await sleep(300);
  check("host picker lists Bot and opens confirm dialog", pick && !!(await page.$(".dialog")));
  await shot(page, "07-host-confirm");
  await page.evaluate(() => document.querySelector(".dialog-backdrop")?.click());
  await sleep(200);
  await page.evaluate(() => document.querySelector(".sheet-backdrop")?.click());

  // lazy player chunk loads when this device plays the videos
  const chunks = [];
  page.on("response", (r) => r.url().includes("/assets/ScreenPlayer-") && chunks.push(r.status()));
  await page.click("button[aria-label='Menu']"); await sleep(250);
  await clickText(page, "button.menu-item", "Play on this device");
  await sleep(1500);
  check("ScreenPlayer chunk loads on demand", chunks.includes(200), JSON.stringify(chunks));
  await shot(page, "07b-play-here");

  // screen page
  const sp = await browser.newPage();
  await sp.setViewport({ width: 1280, height: 720 });
  sp.on("pageerror", (e) => errors.push("screen pageerror: " + e.message));
  await sp.goto(`${BASE}/screen`, { waitUntil: "networkidle0" });
  await shot(sp, "08-screen-landing");
  check("screen landing renders", (await sp.evaluate(() => document.body.textContent)).length > 20);
  await sp.close();

  // screen code: the host reads it in the menu, a second device has to type it to become the screen
  await page.click("button[aria-label='Menu']");
  await page.waitForFunction(() => /Screen code:\s*[A-Z2-9]{6}/.test(document.body.textContent), { timeout: 5000 }).catch(() => {}); // loaded from the server when the menu opens
  const menuCode = await page.evaluate(() => /Screen code:\s*([A-Z2-9]{6})/.exec(document.body.textContent)?.[1] ?? null);
  check("host menu shows the screen code", !!menuCode, menuCode ?? "");
  await page.keyboard.press("Escape");
  const other = await browser.createBrowserContext(); // its own storage: a different device
  const tv = await other.newPage();
  await tv.setViewport({ width: 1280, height: 720 });
  tv.on("pageerror", (e) => errors.push("tv pageerror: " + e.message));
  await tv.goto(`${BASE}/r/${code}/screen`, { waitUntil: "networkidle0" });
  const needs = await tv.waitForSelector("input[aria-label='Screen code']", { timeout: 8000 }).then(() => true, () => false);
  await shot(tv, "08b-screen-code-prompt");
  check("a second screen is asked for the code", needs);
  if (needs && menuCode) {
    await tv.type("input[aria-label='Screen code']", "AAAAAA");
    await clickText(tv, "button", "Use this screen");
    await tv.waitForFunction(() => document.body.textContent.includes("isn't right"), { timeout: 8000 }).catch(() => {});
    check("a wrong code is refused", await tv.evaluate(() => document.body.textContent.includes("isn't right")));
    await tv.$eval("input[aria-label='Screen code']", (el) => (el.value = ""));
    await tv.type("input[aria-label='Screen code']", menuCode);
    await clickText(tv, "button", "Use this screen");
    await tv.waitForFunction(() => !document.querySelector("input[aria-label='Screen code']"), { timeout: 8000 }).catch(() => {});
    check("the right code makes it the screen", !(await tv.$("input[aria-label='Screen code']")));
  }
  await other.close();
  await page.bringToFront();

  // admin
  const ap = await browser.newPage();
  await ap.setViewport({ width: 1100, height: 800 });
  ap.on("pageerror", (e) => errors.push("admin pageerror: " + e.message));
  ap.on("console", (m) => m.type() === "error" && errors.push("admin console: " + m.text()));
  await ap.goto(`${BASE}/admin`, { waitUntil: "networkidle0" });
  await shot(ap, "09-admin-signin");
  const inputs = await ap.$$("input");
  await inputs[1].type("password");
  await ap.keyboard.press("Enter");
  await ap.waitForSelector("input[type=password]", { timeout: 5000 }).catch(() => {});
  await sleep(500);
  const pw = await ap.$$("input[type=password]");
  check("admin forces password change", pw.length === 3, `fields=${pw.length}`);
  await pw[0].type("password"); await pw[1].type("smoketest123"); await pw[2].type("smoketest123");
  await ap.keyboard.press("Enter");
  await ap.waitForSelector("[role=tab]", { timeout: 20000 }); // password hashing can be slow on a cold server
  for (const tab of ["Rooms", "Appearance", "Debug", "Account"]) {
    await clickText(ap, "[role=tab]", tab);
    await sleep(tab === "Debug" ? 1500 : 600);
    await shot(ap, "10-admin-" + tab);
    check(`admin tab ${tab}`, await ap.evaluate((t) => document.querySelector("[role=tab][aria-selected=true]")?.textContent.includes(t), tab));
  }
  await clickText(ap, "[role=tab]", "Rooms");
  await sleep(3500);
  const roomRow = await ap.evaluate((c) => document.body.textContent.includes(c), code);
  check("admin Rooms lists the room", roomRow);
  // appearance preset change
  await clickText(ap, "[role=tab]", "Appearance");
  await sleep(400);
  const cards = await ap.$$eval("[data-theme] button, button[data-theme]", (b) => b.length);
  check("appearance has preset cards", cards > 0, `cards=${cards}`);
  bot.close();
} catch (e) {
  check("script ran to the end", false, String(e).slice(0, 300));
}
await browser.close();
server.kill();
const bad = errors.filter((e) => !/favicon|net::ERR|Failed to load resource/.test(e));
console.log("\nBROWSER ERRORS:", bad.length ? "\n" + [...new Set(bad)].join("\n") : "none");
console.log("SERVER ERROR LINES:", log.split("\n").filter((l) => /error|exception|unhandled/i.test(l) && !/youtubei|nip\.io|sslip/i.test(l)).slice(0, 8).join("\n") || "none");
// The server logs one line per distinct Content-Security-Policy violation the browser reports.
const cspLines = log.split("\n").filter((l) => l.includes("CSP would block") || l.includes("CSP blocked"));
console.log("CSP VIOLATIONS:", cspLines.length ? "\n" + cspLines.join("\n") : "none");
console.log(`\n${results.filter((r) => r[0]).length}/${results.length} checks passed; screenshots in ${shots}`);
process.exit(results.every((r) => r[0]) && bad.length === 0 && cspLines.length === 0 ? 0 : 1);
