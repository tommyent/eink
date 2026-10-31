// Loads the unpacked extension in headless Chrome, serves fixture.html at a
// mail.google.com URL, drives the popup switches and checks screenshots,
// contrast, live apply and persistence. Run: npm i --no-save playwright-core && node test/e2e.js
// EXT=<folder> loads another copy of the extension instead of this one.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.realpathSync(process.env.EXT || path.join(__dirname, ".."));
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
  // /u/1/ serves the fixture recoloured like Gmail's own dark theme (approximate Material 3 dark colours).
  const fixture = fs.readFileSync(path.join(__dirname, "fixture.html"), "utf8");
  const darkTheme = `<style>
    body { background: #111; color: #e3e3e3; } main, [role=dialog] { background: #1f1f1f; }
    [role=row] { background: #1f1f1f; border-color: #333; } [role=row].unread { background: #2d2d2d; }
    [role=row][aria-selected=true] { background: #3c4a5e; } .snippet, .meta, .logo { color: #c4c7c5; } article a { color: #a8c7fa; }
    nav a, article b { color: #e3e3e3 !important; } nav a[aria-current] { background: #3c4a5e; } .compose-btn { background: #3c4a5e; color: #e3e3e3; }
    article { border-color: #111; } [role=dialog] input, [role=dialog] [contenteditable] { background: #1f1f1f; color: #e3e3e3; border-color: #333; }
    .send { background: #a8c7fa; color: #062e6f; } [role=dialog] .title, [role=search] input { background: #2d2d2d; color: #e3e3e3; }
    #sw-page { background: #1f1f1f !important; } #sw-text { background: #e3e3e3 !important; } #sw-secondary { background: #c4c7c5 !important; }
    #sw-link { background: #a8c7fa !important; } #sw-read { background: #1f1f1f !important; } #sw-selected { background: #3c4a5e !important; }
  </style></head>`;
  await context.route("https://mail.google.com/**", route => route.fulfill({ contentType: "text/html",
    body: route.request().url().includes("/u/1/") ? fixture.replace("</head>", darkTheme) : fixture }));
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
  const choose = (name, value) => popup.click(`input[name=${name}][value=${value}] + span`);
  // The popup redraws on its own change events, so give it a moment before comparing.
  const captionIs = async text => {
    await popup.waitForFunction(t => document.querySelector("#caption").textContent === t, text, { timeout: 5000 }).catch(() => {});
    assert.equal(await popup.textContent("#caption"), text);
  };

  // Gmail's text, link and row colours as rendered under the filter, checked for WCAG AA.
  const pairs = [["text", "page"], ["secondary", "page"], ["link", "page"], ["text", "read"], ["secondary", "read"], ["text", "selected"]];
  async function checkGmail(name, look) {
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
    for (const [r, g, b] of Object.values(colours)) assert.ok(look === "dark" ? Math.max(r, g, b) - Math.min(r, g, b) <= 6 : r >= g - 3 && g >= b - 3, `${name} swatch ${hex([r, g, b])} keeps colour`);
    if (look === "dark") assert.ok(luminance(colours.page) < 0.05 && luminance(colours.page) > 0, `${name} page is dark gray, not black`);
    else assert.ok(colours.page[0] > colours.page[2] + 15 && luminance(colours.page) > 0.6, `${name} page is warm paper`);
  }

  // Popup text and control outlines against its screen colour (AA 4.5 for text, 3 for controls and focus ring).
  async function checkPopup(name) {
    await popup.locator("body").screenshot({ path: path.join(shots, `popup-${name}.png`) });
    const css = await popup.evaluate(() => {
      const style = (selector, prop) => getComputedStyle(document.querySelector(selector))[prop];
      const screen = style("main", "backgroundColor");
      const active = document.activeElement, ring = getComputedStyle(active.nextElementSibling);
      return [
        ["title", style("h1", "color"), screen, 4.5], ["caption", style("#caption", "color"), screen, 4.5],
        ["hint", style(".hint", "color"), screen, 4.5], ["legend", style("legend", "color"), screen, 4.5],
        ["segment", style(".segments input:not(:checked) + span", "color"), screen, 4.5],
        ["chosen segment", style(".segments input:checked + span", "color"), style(".segments input:checked + span", "backgroundColor"), 4.5],
        ["segment outline", style(".segments", "borderTopColor"), screen, 3],
        // The focus ring is drawn inside the focused radio's segment.
        ["focus ring", ring.outlineStyle === "none" ? "rgb(0, 0, 0, 0)" : ring.outlineColor, active.checked ? ring.backgroundColor : screen, 3]
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
  // The popup asks the active tab, but here it is a tab itself: point it at the newest tab whose
  // page answers for the site named in the popup URL's hash, or with "blocked", that doesn't answer.
  await popup.addInitScript(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async info => {
      const target = location.hash.slice(1);
      if (!info.active || !target) return query(info);
      const self = await chrome.tabs.getCurrent();
      const tabs = (await query({})).filter(tab => tab.id !== self.id);
      const answers = await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, "eink-ping", { frameId: 0 }).catch(() => null)));
      const index = answers.findLastIndex(answer => target === "blocked" ? !answer : answer?.site === target);
      return index < 0 ? [] : [tabs[index]];
    };
  });
  const aim = async site => { await popup.goto(`chrome-extension://${id}/popup.html#${site}`); await popup.reload(); };
  await popup.goto(`chrome-extension://${id}/popup.html#mail.google.com`);
  await popup.waitForSelector("#controls:not([disabled])");
  assert.equal(await selected("mode"), "auto", "E-ink defaults to Auto");
  assert.equal(await selected("palette"), "dark", "Palette defaults to Dark");

  // Auto: plain Gmail by day, e-ink by night, switching live with no reload.
  await mac("light");
  await gmail.goto(inbox);
  await gmail.focus("#subject");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await filter(), "none", "Auto is plain by day");
  await captionIs("Now: Day (Auto) · Gmail as usual");
  await gmail.screenshot({ path: path.join(shots, "auto-day.png") });
  await mac("dark");
  await palette("dark");
  await captionIs("Now: Night (Auto) · Dark e-ink");
  // Photos flip back; Gmail's UI images (wordmark, sprites) stay inverted with the page.
  assert.deepEqual(await gmail.evaluate(() => ["https://ssl.gstatic.com/ui/v1/icons/mail/rfr/logo_gmail_lockup_default_1x_r7.png",
    "https://mail.google.com/mail/images/cleardot.gif", "https://example.com/photo.jpg"].map(src => {
    const img = document.body.appendChild(Object.assign(document.createElement("img"), { src }));
    const value = getComputedStyle(img).filter; img.remove(); return value;
  })), ["none", "none", "invert(1)"]);
  await checkGmail("auto-night-dark", "dark");
  await popup.focus("input[name=palette]:checked");
  await checkPopup("night-dark");

  // Arrow keys move the palette: Dark -> Warm reaches Gmail live.
  await popup.keyboard.press("ArrowLeft");
  assert.equal(await selected("palette"), "warm");
  await palette("warm");
  await checkGmail("auto-night-warm", "warm");
  await checkPopup("night-warm");
  await popup.keyboard.press("ArrowRight");
  await palette("dark");
  await popup.keyboard.press("ArrowLeft");
  await palette("warm");

  // On: e-ink by day too. Label clicks for every mode.
  await choose("mode", "on");
  await mac("light");
  await palette("warm");
  await captionIs("Now: On · Warm paper");
  await checkGmail("on-warm", "warm");
  await choose("palette", "dark");
  await palette("dark");
  await checkGmail("on-dark", "dark");
  await choose("palette", "warm");
  await palette("warm");

  // Off: Gmail back to normal in both appearances, palette row disabled.
  await choose("mode", "off");
  await unstyled();
  await mac("dark");
  await unstyled();
  assert.equal(await popup.isDisabled("input[name=palette][value=dark]"), true, "palette disabled while off");
  await captionIs("Now: Off · Gmail as usual");
  await gmail.screenshot({ path: path.join(shots, "off.png") });
  await popup.locator("body").screenshot({ path: path.join(shots, "popup-off.png") });

  // Settings persist across reloads.
  await gmail.reload();
  await gmail.waitForLoadState();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await filter(), "none", "off survives reload");
  await popup.reload();
  await popup.waitForSelector("#controls:not([disabled])");
  assert.equal(await selected("mode"), "off");
  assert.equal(await selected("palette"), "warm");
  await popup.focus("input[name=mode]:checked");
  await popup.keyboard.press("ArrowRight");
  assert.equal(await selected("mode"), "auto");
  await palette("warm");
  await gmail.reload();
  await palette("warm");

  // Gmail's own dark theme: detected, Dark only drops colour, Warm still gives paper, popup says so.
  await gmail.goto(inbox.replace("/u/0/", "/u/1/"));
  await gmail.waitForFunction(() => document.documentElement.hasAttribute("data-site-dark"));
  await palette("warm");
  assert.match(await filter(), /^invert\(1\)/);
  await checkGmail("gmail-dark-theme-warm", "warm");
  await choose("palette", "dark");
  await palette("dark");
  assert.equal(await filter(), "grayscale(1)");
  await checkGmail("gmail-dark-theme-dark", "dark");
  await popup.reload();
  await popup.waitForSelector("#theme-note:not([hidden])");
  await popup.locator("body").screenshot({ path: path.join(shots, "popup-gmail-dark-theme.png") });

  await browser.close();
  proc.kill();
  console.log(`ok: screenshots in ${shots}`);
})().catch(error => { console.error(error); process.exit(1); });
