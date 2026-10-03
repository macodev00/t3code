#!/usr/bin/env node
// Generic T3 Code UI capture: pairs (or reuses a session), runs a scene, saves PNGs + a WebM recording.
// Usage: node capture.mjs --url <start-url> --out <dir> --scene <scenes/x.mjs> [--pair <pairing-url>] [--state session.json]
//        [--width 1440 --height 900 --scale 1]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const out = path.resolve(args.out); fs.mkdirSync(out, { recursive: true });
const statePath = path.resolve(args.state ?? path.join(out, "..", "session-state.json"));
const width = Number(args.width ?? 1440), height = Number(args.height ?? 900), scale = Number(args.scale ?? 1);
const scene = await import(pathToFileURL(path.resolve(args.scene)).href);

// System Chrome if present, else Playwright's own Chromium (`npx playwright-core install chromium`).
const executablePath = process.env.CHROME || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
if (args.pair) { // one-time pairing: exchanges the token for a session cookie, saved to statePath
  const c = await browser.newContext(); const p = await c.newPage();
  await p.goto(args.pair); await p.waitForURL((u) => !u.pathname.startsWith("/pair"), { timeout: 120000 });
  await p.waitForTimeout(3000); await c.storageState({ path: statePath }); await c.close();
}
const ctx = await browser.newContext({
  viewport: { width, height }, deviceScaleFactor: scale,
  storageState: fs.existsSync(statePath) ? statePath : undefined,
  recordVideo: { dir: out, size: { width, height } },
  colorScheme: args.theme ?? "light",
});
if (scene.initLocalStorage) await ctx.addInitScript((kv) => { if (!sessionStorage.getItem("__cap_init")) { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); sessionStorage.setItem("__cap_init", "1"); } }, scene.initLocalStorage);
// Headless recordings show no cursor: draw a short-lived ring wherever a click lands.
await ctx.addInitScript(() => addEventListener("pointerdown", (e) => {
  const d = document.createElement("div");
  d.style.cssText = `position:fixed;left:${e.clientX - 14}px;top:${e.clientY - 14}px;width:28px;height:28px;border:3px solid #ef4444;border-radius:50%;pointer-events:none;z-index:2147483647;transition:opacity .6s,transform .6s`;
  document.documentElement.appendChild(d);
  requestAnimationFrame(() => { d.style.transform = "scale(1.6)"; d.style.opacity = "0"; });
  setTimeout(() => d.remove(), 900);
}, true));
const page = await ctx.newPage();
const log = []; page.on("console", (m) => m.type() === "error" && log.push(m.text().split("\n")[0].slice(0, 300))); page.on("pageerror", (e) => log.push("pageerror: " + e.message.slice(0, 300)));
const t0 = Date.now(); let startAt = 0; const markStart = () => { startAt = (Date.now() - t0) / 1000; };
let n = 0; const shot = async (name, opts = {}) => { const f = path.join(out, `${String(++n).padStart(2, "0")}-${name}.png`); await page.screenshot({ path: f, ...opts }); console.log("SHOT", f); return f; };
try {
  await page.goto(args.url);
  await scene.run({ page, shot, markStart, args });
} finally {
  const video = page.video(); await ctx.close(); await browser.close();
  if (video) { const v = await video.path(); const dest = path.join(out, "recording.webm"); fs.renameSync(v, dest); console.log("VIDEO", dest); }
  fs.writeFileSync(path.join(out, "trim-start.txt"), String(Math.max(0, startAt - 0.5)) + "\n");
  fs.writeFileSync(path.join(out, "console-errors.txt"), log.join("\n") + "\n");
}
