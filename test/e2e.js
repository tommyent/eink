// Loads the unpacked extension in headless Chrome, serves fixture.html at a
// mail.google.com URL, drives the popup switches and checks screenshots,
// contrast, live apply and persistence. Run: npm i --no-save playwright-core && node test/e2e.js
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
  const palette = value => gmail.waitForFunction(v => document.documentElement.getAttribute("data-eink") === v, value);
  const unstyled = async () => {
    await gmail.waitForFunction(() => !document.documentElement.hasAttribute("data-eink"));
    assert.equal(await filter(), "none");
  };
  // The Mac's appearance, as seen by both the Gmail tab and the popup.
  const mac = async scheme => { await gmail.emulateMedia({ colorScheme: scheme }); await popup.emulateMedia({ colorScheme: scheme }); };
  const selected = name => popup.$eval(`input[name=${name}]:checked`, input => input.value);

  // Gmail's text, link and row colours as rendered under the filter, checked for WCAG AA.
  const pairs = [["text", "page"], ["secondary", "page"], ["link", "page"], ["text", "read"], ["secondary", "read"], ["text", "selected"]];
  async function checkGmail(name) {
    await gmail.screenshot({ path: path.join(shots, `${name}.png`) });
    const colours = {};
    for (const key of ["page", "text", "secondary", "link", "read", "selected"]) colours[key] = await sample(`#sw-${key}`);
    console.log(`${name}: page ${hex(colours.page)}, text ${hex(colours.text)}, photo centre ${hex(await sample(".photo"))}`);
    for (const [fg, bg] of pairs) {
      const ratio = contrast(colours[fg], colours[bg]);
      console.log(`  ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
      assert.ok(ratio >= 4.5, `${name} ${fg} on ${bg} fails WCAG AA`);
    }
    // No accent colour: dark is neutral gray, warm only has the paper's own hue (r >= g >= b; Gmail blue had b > r).
    for (const [r, g, b] of Object.values(colours)) assert.ok(name === "dark" ? Math.max(r, g, b) - Math.min(r, g, b) <= 6 : r >= g - 3 && g >= b - 3, `${name} swatch ${hex([r, g, b])} keeps colour`);
    return colours;
  }

  // Popup text and control outlines against its screen colour (AA 4.5 for text, 3 for controls and focus ring).
  async function checkPopup(name) {
    await popup.locator("body").screenshot({ path: path.join(shots, `popup-${name}.png`) });
    const css = await popup.evaluate(() => {
      const style = (selector, prop) => getComputedStyle(document.querySelector(selector))[prop];
      const screen = style("main", "backgroundColor");
      return [
        ["title", style("h1", "color"), screen, 4.5], ["caption", style("#caption", "color"), screen, 4.5],
        ["hint", style(".hint", "color"), screen, 4.5], ["label", style("#enabled-label", "color"), screen, 4.5],
        ["segment", style(".segments input:not(:checked) + span", "color"), screen, 4.5],
        ["chosen segment", style(".segments input:checked + span", "color"), style(".segments input:checked + span", "backgroundColor"), 4.5],
        ["segment outline", style(".segments", "borderTopColor"), screen, 3], ["switch", style("#enabled", "borderTopColor"), screen, 3],
        // The ring sits on the switch, or on the segment span of a focused radio (drawn inside the span).
        ["focus ring", ...(() => {
          const active = document.activeElement, ring = active.matches("input") ? active.nextElementSibling : active;
          const ringStyle = getComputedStyle(ring);
          return [ringStyle.outlineStyle === "none" ? "rgb(0, 0, 0, 0)" : ringStyle.outlineColor, active.matches("input:checked") ? ringStyle.backgroundColor : screen];
        })(), 3]
      ];
    });
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    for (const [key, fg, bg, limit] of css) {
      const ratio = contrast(rgb(fg), rgb(bg));
      console.log(`  popup ${name} ${key}: ${ratio.toFixed(2)}:1`);
      assert.ok(ratio >= limit, `popup ${name} ${key} below ${limit}:1`);
    }
  }

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 296, height: 400 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForSelector("#enabled:not([disabled])");
  assert.equal(await popup.getAttribute("#enabled", "aria-checked"), "true", "E-ink defaults on");
  assert.equal(await selected("day"), "warm", "Day defaults to Warm");
  assert.equal(await selected("night"), "dark", "Night defaults to Dark");

  // Defaults, switching live with the Mac's appearance and no reload.
  await mac("light");
  await gmail.goto(inbox);
  await palette("warm");
  await gmail.focus("#subject");
  const warm = await checkGmail("warm");
  assert.ok(warm.page[0] > warm.page[2] + 15, "warm page is warm paper");
  assert.equal(await popup.isVisible("#now-day"), true, "now marks Day");
  await popup.keyboard.press("Tab");
  assert.equal(await popup.evaluate(() => document.activeElement.id), "enabled");
  await checkPopup("day-warm");
  await mac("dark");
  await palette("dark");
  const dark = await checkGmail("dark");
  assert.ok(luminance(dark.page) < 0.05 && luminance(dark.page) > 0, "dark page is dark gray, not black");
  assert.equal(await popup.isVisible("#now-night"), true, "now marks Night");
  assert.equal(await popup.isVisible("#now-day"), false);
  await popup.focus("input[name=night]:checked");
  await checkPopup("night-dark");

  // Arrow keys move through a row: Night Dark -> Warm reaches Gmail live.
  await popup.keyboard.press("ArrowLeft");
  assert.equal(await selected("night"), "warm");
  await palette("warm");
  await popup.keyboard.press("ArrowRight");
  await palette("dark");
  await popup.keyboard.press("ArrowLeft");
  await palette("warm");
  // A label click: Day Off means e-ink only at night.
  await popup.click("input[name=day][value=off] + span");
  assert.equal(await selected("day"), "off");
  await mac("light");
  await unstyled();
  await mac("dark");
  await palette("warm");

  // Master off: Gmail back to normal in both appearances, rows disabled.
  await popup.click("label[for=enabled]");
  await unstyled();
  await mac("light");
  await unstyled();
  assert.equal(await popup.isDisabled("input[name=day][value=warm]"), true, "rows disabled while off");
  await gmail.screenshot({ path: path.join(shots, "off.png") });
  await popup.locator("body").screenshot({ path: path.join(shots, "popup-off.png") });

  // All three settings persist across reloads.
  await gmail.reload();
  await gmail.waitForLoadState();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await filter(), "none", "off survives reload");
  await popup.reload();
  await popup.waitForSelector("#enabled:not([disabled])");
  assert.equal(await popup.getAttribute("#enabled", "aria-checked"), "false");
  assert.equal(await selected("day"), "off");
  assert.equal(await selected("night"), "warm");
  assert.equal(await popup.isDisabled("input[name=night][value=dark]"), true);
  await popup.focus("#enabled");
  await popup.keyboard.press("Space");
  await mac("dark");
  await palette("warm");
  await gmail.reload();
  await palette("warm");
  await mac("light");
  await unstyled();

  await browser.close();
  proc.kill();
  console.log(`ok: screenshots in ${shots}`);
})().catch(error => { console.error(error); process.exit(1); });
