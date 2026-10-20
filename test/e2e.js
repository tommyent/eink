// Loads the unpacked extension in headless Chrome, serves fixture.html at a
// mail.google.com URL, screenshots both palettes and checks contrast and the
// live toggle. Run: npm i --no-save playwright-core && node test/e2e.js
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.realpathSync(path.join(__dirname, ".."));
const shots = path.join(__dirname, "screenshots");
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const inbox = "https://mail.google.com/mail/u/0/#inbox";

const luminance = rgb => {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const hex = rgb => "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("");

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  // Branded Chrome ignores --load-extension, so load the folder over CDP, and use the
  // default profile because Playwright's own contexts are off the record.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-eink-"));
  const proc = spawn(chrome, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--enable-unsafe-extension-debugging", "--no-first-run", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  process.on("exit", () => proc.kill());
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; !fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n"); i++) {
    if (i > 100) throw new Error("Chrome did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${fs.readFileSync(portFile, "utf8").split("\n")[0]}`);
  const { id } = await (await browser.newBrowserCDPSession()).send("Extensions.loadUnpacked", { path: root });
  const context = browser.contexts()[0];
  await context.route("https://mail.google.com/**", route => route.fulfill({ path: path.join(__dirname, "fixture.html") }));
  const gmail = await context.newPage();
  await gmail.setViewportSize({ width: 1280, height: 800 });
  const decoder = await context.newPage();

  // Reads the rendered colour at the centre of an element from a real screenshot.
  async function sample(selector) {
    const png = (await gmail.locator(selector).screenshot()).toString("base64");
    return decoder.evaluate(async src => {
      const img = new Image(); img.src = "data:image/png;base64," + src; await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height), ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(img.width >> 1, img.height >> 1, 1, 1).data.slice(0, 3)];
    }, png);
  }
  const filter = () => gmail.evaluate(() => getComputedStyle(document.documentElement).filter);

  await gmail.goto(inbox);
  await gmail.waitForFunction(() => document.documentElement.hasAttribute("data-eink"));
  await gmail.focus("#subject");

  const pairs = [["text", "page"], ["secondary", "page"], ["link", "page"], ["text", "read"], ["secondary", "read"], ["text", "selected"]];
  const results = {};
  for (const scheme of ["light", "dark"]) {
    // Switched on the open page, without reload, as when macOS changes appearance.
    await gmail.emulateMedia({ colorScheme: scheme });
    const name = scheme === "light" ? "warm" : "dark";
    assert.match(await filter(), scheme === "light" ? /sepia/ : /invert/, `${name} filter`);
    await gmail.screenshot({ path: path.join(shots, `${name}.png`) });
    const colours = {};
    for (const key of ["page", "text", "secondary", "link", "read", "selected"]) colours[key] = await sample(`#sw-${key}`);
    const photo = await sample(".photo");
    console.log(`${name}: page ${hex(colours.page)}, text ${hex(colours.text)}, photo centre ${hex(photo)}`);
    for (const [fg, bg] of pairs) {
      const ratio = contrast(colours[fg], colours[bg]);
      console.log(`  ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
      assert.ok(ratio >= 4.5, `${name} ${fg} on ${bg} fails WCAG AA`);
    }
    // No accent colour: dark is neutral gray, warm only has the paper's own hue (r >= g >= b; Gmail blue had b > r).
    for (const [r, g, b] of Object.values(colours)) assert.ok(scheme === "dark" ? Math.max(r, g, b) - Math.min(r, g, b) <= 6 : r >= g - 3 && g >= b - 3, `${name} swatch ${hex([r, g, b])} keeps colour`);
    results[name] = colours;
  }
  assert.ok(luminance(results.dark.page) < 0.05 && luminance(results.dark.page) > 0, "dark page is dark gray, not black");
  assert.ok(results.warm.page[0] > results.warm.page[2] + 15, "warm page is warm paper");

  // Popup toggle reaches the open Gmail tab live.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForSelector("#enabled:not([disabled]):checked");
  await popup.click("#enabled");
  await gmail.waitForFunction(() => !document.documentElement.hasAttribute("data-eink"));
  assert.equal(await filter(), "none");
  await gmail.emulateMedia({ colorScheme: "light" });
  await gmail.screenshot({ path: path.join(shots, "off.png") });
  await gmail.reload();
  await gmail.waitForLoadState();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await filter(), "none", "off survives reload");
  await popup.screenshot({ path: path.join(shots, "popup.png") });
  await popup.click("#enabled");
  await gmail.waitForFunction(() => document.documentElement.hasAttribute("data-eink"));

  await browser.close();
  proc.kill();
  console.log(`ok: screenshots in ${shots}`);
})().catch(error => { console.error(error); process.exit(1); });
