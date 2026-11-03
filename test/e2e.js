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
  // default profile because Playwright's own contexts are off the record. Headless Chrome still
  // plays sound through the Mac's speakers, so mute it.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "eink-"));
  const proc = spawn(chrome, ["--headless", "--mute-audio", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
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
  // The rendered colour at one point of a page, from a real screenshot.
  async function pixel(page, x, y) {
    const png = (await page.screenshot()).toString("base64");
    return decoder.evaluate(async ({ src, x, y }) => {
      const img = new Image(); img.src = "data:image/png;base64," + src; await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height), ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
    }, { src: png, x, y });
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
  await captionIs("Now: Day (Auto) · Sites as usual");
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
  await captionIs("Now: Off · Sites as usual");
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

  // Every other site: its light design first, then the same filters as Gmail. Still Auto and Dark,
  // with the Mac in dark mode.
  const svg = fill => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="${fill}"/></svg>`;
  // The photo is a black-to-white ramp with a #f0c040 band across the middle.
  const photo = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/>`
    + `<stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="300" height="200" fill="url(#g)"/><rect y="80" width="300" height="40" fill="#f0c040"/></svg>`;
  const images = { "/light.svg": svg("#ffffff"), "/dark.svg": svg("#000000"), "/photo.svg": photo };
  const pages = ["/force.html", "/saved-dark.html", "/plain.html", "/fullscreen.html", "/oklch.html", "/theme.html", "/auto-theme.html", "/github-theme.html"];
  await context.route("https://sites.test/**", route => {
    const { pathname } = new URL(route.request().url());
    if (images[pathname]) return route.fulfill({ contentType: "image/svg+xml", body: images[pathname] });
    if (pages.includes(pathname)) return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, pathname), "utf8") });
    return route.fulfill({ status: 404, body: "" });
  });
  // Another origin, with no CORS headers, so the page can't read this stylesheet's rules.
  // The extension's own fetch of auto-theme.css is slow, as when its worker wakes from sleep.
  await context.route("https://cdn.test/**", async route => {
    const file = new URL(route.request().url()).pathname === "/auto-theme.css" ? "auto-theme.css" : "force-x.css";
    if (file === "auto-theme.css" && route.request().serviceWorker()) await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ contentType: "text/css", body: fs.readFileSync(path.join(__dirname, file), "utf8") });
  });
  const lightRegistered = () => popup.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).find(script => script.id === "light") ?? null);
  // Waits until light.js's registration passes check. Polled from here, because waitForFunction
  // takes the Promise an async function returns as truthy and doesn't wait at all.
  const registration = async (check, what) => {
    for (let i = 0; i < 50; i++) {
      if (check(await lightRegistered())) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`light.js is never registered ${what}: ${JSON.stringify(await lightRegistered())}`);
  };
  // Chrome can leave out an empty excludeMatches.
  const everywhere = light => light && !light.excludeMatches?.length;
  await registration(light => light, "at all");
  const site = await context.newPage();
  await site.setViewportSize({ width: 1280, height: 800 });
  await site.emulateMedia({ colorScheme: "dark" });
  const siteFilter = () => site.evaluate(() => getComputedStyle(document.documentElement).filter);
  const siteEink = value => site.waitForFunction(v => document.documentElement.getAttribute("data-eink") === v, value);
  const siteDarkIs = value => site.waitForFunction(v => document.documentElement.hasAttribute("data-site-dark") === v, value, { timeout: 5000 });

  // Six ways a site picks dark mode all give way to its light design, while Auto still sees the Mac's dark mode.
  await site.goto("https://sites.test/force.html");
  await siteEink("dark");
  const boxes = ["media", "xorigin", "jsclass", "lightdark", "cssinjs"];
  await site.waitForFunction(ids => ids.every(id => getComputedStyle(document.getElementById(id)).backgroundColor === "rgb(255, 255, 255)"),
    boxes, { timeout: 5000 }).catch(() => {});
  assert.deepEqual(await site.evaluate(ids => ({
    pageSeesDark: matchMedia("(prefers-color-scheme: dark)").matches,
    body: getComputedStyle(document.body).backgroundColor,
    boxes: Object.fromEntries(ids.map(id => [id, getComputedStyle(document.getElementById(id)).backgroundColor])),
    picture: document.getElementById("pic").currentSrc.split("/").pop()
  }), boxes), { pageSeesDark: false, body: "rgb(255, 255, 255)", boxes: Object.fromEntries(boxes.map(id => [id, "rgb(255, 255, 255)"])), picture: "light.svg" });
  assert.equal(await siteFilter(), "invert(0.85) grayscale(1)", "the same Dark filter as Gmail");
  await site.screenshot({ path: path.join(shots, "sites-force-dark.png") });

  // This site: off and on again from the popup, live; light.js leaves a site that is off alone.
  await aim("sites.test");
  await popup.waitForSelector("#site-row:not([disabled])");
  assert.equal(await popup.textContent("#site-name"), "sites.test");
  assert.equal(await selected("site"), "on");
  await popup.locator("body").screenshot({ path: path.join(shots, "popup-site-on.png") });
  await choose("site", "off");
  await site.waitForFunction(() => !document.documentElement.hasAttribute("data-eink"));
  assert.equal(await siteFilter(), "none");
  await captionIs("Now: Night (Auto) · This site as usual");
  await registration(light => light?.excludeMatches?.includes("*://sites.test/*"), "without sites.test");
  await popup.locator("body").screenshot({ path: path.join(shots, "popup-site-off.png") });
  await choose("site", "on");
  await siteEink("dark");
  assert.deepEqual(await popup.evaluate(async () => (await chrome.storage.sync.get("off")).off), []);
  await registration(everywhere, "everywhere again");

  // Hosts with unusual match patterns are switched off too: an IPv6 address, which
  // location.hostname gives in brackets, and a name with an underscore.
  const odd = ["[::1]", "my_host.example"];
  await context.route(url => odd.includes(url.hostname), route => route.fulfill({ contentType: "text/html", body: "<p>An odd host.</p>" }));
  await popup.evaluate(off => chrome.storage.sync.set({ off }), odd);
  await registration(light => light?.excludeMatches?.length === 2, `without ${odd.join(" and ")}`);
  for (const host of odd) {
    await site.goto(`http://${host}/`);
    // light.js rewrites the page's own colour-scheme queries wherever it runs.
    assert.equal(await site.evaluate(() => matchMedia("(prefers-color-scheme: dark)").media), "(prefers-color-scheme: dark)", `light.js stays off ${host}`);
  }
  await popup.evaluate(() => chrome.storage.sync.set({ off: [] }));
  await registration(everywhere, "everywhere again");

  // A page extensions can't change: the row is disabled, with the reason.
  const blocked = await context.newPage();
  await blocked.goto("chrome://version");
  await aim("blocked");
  await popup.waitForFunction(() => document.querySelector("#site-name").textContent.startsWith("Chrome doesn't"));
  assert.equal(await popup.isDisabled("input[name=site][value=off]"), true);
  await popup.locator("body").screenshot({ path: path.join(shots, "popup-blocked.png") });
  await blocked.close();

  // A dark theme the site keeps for itself: the dark-site check takes over, as for Gmail's own.
  await site.goto("https://sites.test/saved-dark.html");
  await site.waitForFunction(() => document.documentElement.hasAttribute("data-site-dark"));
  assert.equal(await siteFilter(), "grayscale(1)");
  await site.screenshot({ path: path.join(shots, "sites-saved-dark.png") });

  // Colours Chrome computes as oklch() and oklab(): a near-white page is light, a near-black one dark.
  for (const dark of [false, true]) {
    await site.goto(`https://sites.test/oklch.html${dark ? "?dark" : ""}`);
    await siteEink("dark");
    await site.waitForFunction(dark => document.documentElement.hasAttribute("data-site-dark") === dark, dark, { timeout: 5000 }).catch(() => {});
    assert.equal(await site.evaluate(() => document.documentElement.hasAttribute("data-site-dark")), dark,
      `the ${dark ? "near-black" : "near-white"} OKLCH page ${dark ? "isn't" : "is"} read as dark`);
  }

  // An explicit account theme must render like the same site's light design under either palette.
  const accountColours = {};
  for (const look of ["dark", "warm"]) {
    await choose("palette", look);
    accountColours[look] = {};
    for (const theme of ["dark", "light"]) {
      await site.goto(`https://sites.test/github-theme.html${theme === "light" ? "?light" : ""}`);
      await siteEink(look);
      await site.waitForFunction(() => performance.now() > 3500);
      accountColours[look][theme] = [await pixel(site, 640, 700), await pixel(site, 50, 50)];
      console.log(`account ${theme} under ${look}: page/text ${accountColours[look][theme].map(hex).join(" / ")}`);
    }
  }
  for (const look of ["dark", "warm"]) assert.deepEqual(accountColours[look].dark, accountColours[look].light,
    `explicit dark account theme matches the light design under ${look}`);
  await aim("sites.test");
  for (const look of ["dark", "warm"]) {
    await choose("palette", look);
    await site.goto("https://sites.test/github-theme.html");
    await siteEink(look);
    await siteDarkIs(false);
    const modeIs = mode => site.waitForFunction(value => document.documentElement.dataset.colorMode === value, mode);
    await modeIs("light");
    await site.evaluate(() => document.body.replaceWith(document.body.cloneNode(true)));
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual([await pixel(site, 640, 700), await pixel(site, 50, 50)], accountColours[look].light,
      `Turbo body swap keeps the ${look} palette`);
    for (const control of ["site", "mode"]) {
      await choose(control, "off");
      await modeIs("dark");
      await site.waitForFunction(() => !document.documentElement.hasAttribute("data-eink"));
      assert.deepEqual(await pixel(site, 640, 700), [13, 17, 23], `${control} off restores the account theme`);
      await choose(control, "on");
      await modeIs("light");
      await siteDarkIs(false);
      assert.deepEqual(await pixel(site, 640, 700), accountColours[look].light[0]);
    }
    // A site that insists on its theme wins; no observer loop keeps rewriting it.
    await site.evaluate(() => { document.documentElement.dataset.colorMode = "dark"; });
    await siteDarkIs(true);
    await site.waitForFunction(() => performance.now() > 3500);
    assert.equal(await site.evaluate(() => new Promise(resolve => {
      let changes = 0;
      const observer = new MutationObserver(records => { changes += records.length; });
      observer.observe(document.documentElement, { attributes: true });
      setTimeout(() => { observer.disconnect(); resolve(changes); }, 1200);
    })), 0, "the site and E-ink do not fight over the theme");
    await choose("mode", "off");
    await modeIs("dark");
    await choose("mode", "auto");
    await modeIs("light");
    await site.emulateMedia({ colorScheme: "light" });
    await modeIs("dark");
    await site.emulateMedia({ colorScheme: "dark" });
    await modeIs("light");
    // The same contract on <body>, including a replacement carrying the site's dark choice.
    await site.evaluate(() => {
      document.documentElement.removeAttribute("data-color-mode");
      document.documentElement.removeAttribute("data-light-theme");
      document.body.dataset.colorMode = "dark";
      document.body.dataset.lightTheme = "light";
    });
    await site.waitForFunction(() => document.body.dataset.colorMode === "light");
    await site.evaluate(() => {
      const next = document.body.cloneNode(true);
      next.dataset.colorMode = "dark";
      document.body.replaceWith(next);
    });
    await site.waitForFunction(() => document.body.dataset.colorMode === "light");
    await choose("site", "off");
    await site.waitForFunction(() => document.body.dataset.colorMode === "dark");
    await choose("site", "on");
    await site.waitForFunction(() => document.body.dataset.colorMode === "light");
  }
  await choose("palette", "dark");

  // Themes switched with data attributes, on <html> (Bootstrap's data-bs-theme) and on <body>
  // (GitHub's data-color-mode), also on a <body> swapped in without a reload, as Turbo does.
  await site.goto("https://sites.test/theme.html");
  await siteEink("dark");
  await siteDarkIs(false);
  // Past the planned check 2.5 s after load, so only each change itself can set off a check.
  await site.waitForFunction(() => performance.now() > 3500);
  await site.evaluate(() => { document.documentElement.dataset.bsTheme = "dark"; });
  await siteDarkIs(true);
  await site.evaluate(() => { delete document.documentElement.dataset.bsTheme; });
  await siteDarkIs(false);
  await site.evaluate(() => document.body.replaceWith(Object.assign(document.createElement("body"), { innerHTML: "<p>The next page.</p>" })));
  // Let the check that the swap itself sets off go by first.
  await new Promise(resolve => setTimeout(resolve, 1000));
  await site.evaluate(() => { document.body.dataset.colorMode = "dark"; });
  await siteDarkIs(true);

  // A page built like Brave Search in its Auto theme (test/auto-theme.html): its dark theme comes from
  // a stylesheet on another origin, so it is dark anyway until light.js's copy lands. As it lands the
  // page turns light, and E-ink must invert it in that same frame, not leave it white under the
  // dark-anyway filter until a later check.
  await site.goto("https://sites.test/auto-theme.html");
  await siteEink("dark");
  await siteDarkIs(true);
  assert.deepEqual(await site.evaluate(() => new Promise(resolve => new MutationObserver((records, observer) => {
    if (!document.querySelector("link + style")) return;
    observer.disconnect();
    resolve({ pageLight: getComputedStyle(document.body).backgroundColor === "rgb(250, 250, 250)", siteDark: document.documentElement.hasAttribute("data-site-dark") });
  }).observe(document.head, { childList: true }))), { pageLight: true, siteDark: false }, "the page is inverted as the copy lands");

  // A page with no background of its own is dark gray under Dark, not white.
  await site.goto("https://sites.test/plain.html");
  await siteEink("dark");
  const canvas = await pixel(site, 640, 700);
  assert.ok(Math.max(...canvas) < 60, `the plain page below its text is ${hex(canvas)}, not dark gray`);
  await site.screenshot({ path: path.join(shots, "sites-plain-dark.png") });

  // Fullscreen content is drawn outside the page filter. Every way a page goes fullscreen must still
  // be black and white, gray under Dark and warm gray under Warm, on a light page and on one that is
  // dark anyway, and a fullscreen player must keep the tones the same photo has in the page. In
  // colour the photo's band is yellow, and as a negative blue. Afterwards the page looks as before.
  await context.route("https://player.test/**", route => new URL(route.request().url()).pathname === "/photo.svg"
    ? route.fulfill({ contentType: "image/svg+xml", body: images["/photo.svg"] })
    : route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, "embed.html"), "utf8") }));
  // Rendered colours at several points of one screenshot of the site page.
  async function levels(points) {
    const png = (await site.screenshot()).toString("base64");
    return decoder.evaluate(async ({ src, points }) => {
      const img = new Image(); img.src = "data:image/png;base64," + src; await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height), ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return points.map(([x, y]) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)]);
    }, { src: png, points });
  }
  const ramp = [0.05, 0.25, 0.5, 0.75, 0.95];
  const pageFilters = { dark: "invert(0.85) grayscale(1)", warm: "grayscale(1) brightness(0.85) sepia(0.45) brightness(0.97)",
    "dark on a dark page": "grayscale(1)", "warm on a dark page": "invert(1) brightness(1.12) grayscale(1) brightness(0.85) sepia(0.45) brightness(0.97)" };
  const blackAndWhite = (look, [r, g, b]) => look === "dark"
    ? Math.max(r, g, b) - Math.min(r, g, b) <= 6 && r > 130
    : r >= g - 3 && g >= b - 3 && r - b <= 50 && r > 120;
  // [the page's fullscreen element, screenshot name, description, how to enter]
  const ways = [
    ["stage", "player", "a player element", () => site.click("#go-stage")],
    ["clip", "video", "the video itself", () => site.click("#go-clip")],
    ["embed", "frame", "an embedded player's frame, made fullscreen by the page", () => site.click("#go-embed")],
    ["wrap", "player-with-frame", "a player element with a frame in it", () => site.click("#go-wrap")],
    ["embed", "embed-own-player", "an embedded player making its own player fullscreen", () => site.frameLocator("#embed").locator("#inner").click()],
    ["root", "whole-page", "the whole page (as YouTube does it), where the page filter stays", () => site.click("#go-root")]
  ];
  for (const darkPage of [false, true]) for (const look of ["dark", "warm"]) {
    const where = look + (darkPage ? " on a dark page" : "");
    await choose("palette", look);
    await site.goto(`https://sites.test/fullscreen.html${darkPage ? "?dark" : ""}`);
    await siteEink(look);
    await site.waitForFunction(dark => document.documentElement.hasAttribute("data-site-dark") === dark, darkPage);
    const page = await pixel(site, 1270, 790);
    // Points along the ramp, above the band, in the page's photo.
    const box = await site.locator("#stage img").boundingBox();
    const inPage = await levels(ramp.map(f => [box.x + f * box.width, box.y + 0.25 * box.height]));
    for (const [id, shot, name, enter] of ways) {
      await enter();
      await site.waitForFunction(id => id === "root" ? document.fullscreenElement === document.documentElement : document.fullscreenElement?.id === id, id);
      await new Promise(resolve => setTimeout(resolve, 300));
      // The fullscreen content fills the screen; with the whole page fullscreen, look at its photo where it is.
      const seen = await pixel(site, ...(id === "root" ? [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)] : [640, 400]));
      if (id === "root") assert.equal(await siteFilter(), pageFilters[where]);
      assert.ok(blackAndWhite(look, seen), `${name} in fullscreen under ${where} is ${hex(seen)}, not black and white`);
      if (id === "stage") {
        // The player shows the photo with object-fit: cover, across the full width and cropped top and bottom.
        const scale = Math.max(1280 / 300, 800 / 200), top = (800 - 200 * scale) / 2;
        const full = await levels(ramp.map(f => [f * 1280, top + 0.25 * 200 * scale]));
        const gap = Math.max(...inPage.flatMap((colour, i) => colour.map((v, k) => Math.abs(v - full[i][k]))));
        assert.ok(gap <= 6, `fullscreen under ${where} is ${gap} levels off the page's tones: ${full.map(hex)} against ${inPage.map(hex)}`);
      }
      await site.screenshot({ path: path.join(shots, `fullscreen-${shot}-${look}${darkPage ? "-dark-page" : ""}.png`) });
      await site.evaluate(() => document.exitFullscreen());
      await site.waitForFunction(() => !document.fullscreenElement);
      // Let Chrome finish leaving fullscreen: a request made straight away was sometimes never answered.
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(await pixel(site, 1270, 790), page, `the page under ${where} looks as before after fullscreen`);
    // Photos flip back wherever the page is inverted: Dark on a light page, Warm on a dark one.
    assert.equal(await site.evaluate(() => getComputedStyle(document.querySelector("#stage img")).filter), (look === "dark") !== darkPage ? "invert(1)" : "none");
  }

  // A page built like X (test/social.html): photos drawn as CSS backgrounds, a photo viewer opened
  // in-page over a black backdrop, and a saved dark theme switched on late. The page must be checked
  // again as it changes, and every photo must be a gray photo wherever the page is inverted, never a negative.
  await context.route("https://social.test/**", route => new URL(route.request().url()).pathname === "/photo.svg"
    ? route.fulfill({ contentType: "image/svg+xml", body: images["/photo.svg"] })
    : route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(__dirname, "social.html"), "utf8") }));
  const centre = async selector => {
    const box = await site.locator(selector).boundingBox();
    return pixel(site, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  };
  const photoIs = async (look, selector, what) => {
    const seen = await centre(selector);
    assert.ok(blackAndWhite(look, seen), `${what} under ${look} is ${hex(seen)}, not a ${look === "dark" ? "gray" : "warm gray"} photo`);
  };
  await choose("palette", "dark");
  await site.goto("https://social.test/");
  await siteEink("dark");
  await siteDarkIs(false);
  // The card's frame flips its photo back exactly while the page around it is inverted, following
  // its own page through every change below.
  const card = await (await site.waitForSelector("#card")).contentFrame();
  await card.waitForLoadState();
  const cardFlipsIs = value => card.waitForFunction(v => document.documentElement.hasAttribute("data-eink-frame") === v, value, { timeout: 5000 });
  await cardFlipsIs(true);
  await photoIs("dark", "#card", "a photo in a frame");
  await photoIs("dark", "#post-photo", "a photo drawn as a background");
  await photoIs("dark", "#banner", "a banner drawn as a background");
  await photoIs("dark", "#avatar", "a photo inside that banner");
  assert.equal(await site.evaluate(() => getComputedStyle(document.querySelector("#avatar")).filter), "none", "the photo inside the banner isn't flipped twice");
  await site.screenshot({ path: path.join(shots, "social-feed-dark.png") });
  // The photo made fullscreen: the fullscreen rules still decide, not the flip for inline backgrounds.
  await site.click("#full");
  await site.waitForFunction(() => document.fullscreenElement?.id === "post-photo");
  await new Promise(resolve => setTimeout(resolve, 300));
  const fullscreenPhoto = await pixel(site, 640, 400);
  assert.ok(blackAndWhite("dark", fullscreenPhoto), `the fullscreen background photo is ${hex(fullscreenPhoto)}, not a gray photo`);
  await site.screenshot({ path: path.join(shots, "social-fullscreen-dark.png") });
  await site.evaluate(() => document.exitFullscreen());
  await site.waitForFunction(() => !document.fullscreenElement);
  await new Promise(resolve => setTimeout(resolve, 500));
  await choose("palette", "warm");
  await siteEink("warm");
  await photoIs("warm", "#post-photo", "a photo drawn as a background");
  await cardFlipsIs(false);
  await photoIs("warm", "#card", "a photo in a frame");
  await site.screenshot({ path: path.join(shots, "social-feed-warm.png") });
  // The viewer: a route change without a reload, over a black backdrop, so the page is dark anyway now.
  await site.click("#open");
  await siteDarkIs(true);
  await cardFlipsIs(true);
  await photoIs("warm", "#viewer-photo", "the viewer's photo");
  await site.screenshot({ path: path.join(shots, "social-viewer-warm.png") });
  await choose("palette", "dark");
  await siteEink("dark");
  await cardFlipsIs(false);
  await photoIs("dark", "#viewer-photo", "the viewer's photo");
  await site.screenshot({ path: path.join(shots, "social-viewer-dark.png") });
  // Back to the feed, and checked again.
  await site.click("#close");
  await siteDarkIs(false);
  await cardFlipsIs(true);
  await photoIs("dark", "#post-photo", "a photo drawn as a background");
  // The account's dark theme, switched on late on <body>.
  await site.click("#theme");
  await siteDarkIs(true);
  await cardFlipsIs(false);
  await photoIs("dark", "#post-photo", "a photo on the dark theme");
  await photoIs("dark", "#card", "a photo in a frame on the dark theme");
  await site.screenshot({ path: path.join(shots, "social-late-theme-dark.png") });
  // If the page strips our attribute, it comes back; left alone, nothing keeps rewriting <html>
  // (after the one planned check 2.5 s after load, which reads the page without our attribute).
  await site.evaluate(() => document.documentElement.removeAttribute("data-eink"));
  await siteEink("dark");
  await site.waitForFunction(() => performance.now() > 3500);
  assert.equal(await site.evaluate(() => new Promise(resolve => {
    let changes = 0;
    const watch = new MutationObserver(records => { changes += records.length; });
    watch.observe(document.documentElement, { attributes: true });
    setTimeout(() => { watch.disconnect(); resolve(changes); }, 2000);
  })), 0, "nothing rewrites <html> while the page is idle");
  assert.ok(await lightRegistered(), "light.js stays registered in Auto");

  await browser.close();
  proc.kill();
  console.log(`ok: screenshots in ${shots}`);
})().catch(error => { console.error(error); process.exit(1); });
