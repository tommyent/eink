const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const settled = () => new Promise(resolve => setImmediate(resolve));

function storage({ stored = {}, loadFails = false, saveFails = false, local = {} } = {}) {
  const listeners = [], writes = [], localWrites = [];
  return { listeners, writes, localWrites, sync: {
    get: async () => { if (loadFails) throw new Error("Load failed"); return stored; },
    set: async value => { if (saveFails) throw new Error("Quota exceeded"); writes.push({ ...value }); }
  }, local: {
    get: async () => local, set: async value => { localWrites.push({ ...value }); }
  }, onChanged: { addListener(listener) { listeners.push(listener); } } };
}

// Fake prefers-color-scheme: dark query whose change listeners fire on setNight().
function appearance(nightNow) {
  const listeners = [];
  const query = { matches: nightNow, addEventListener(name, listener) { listeners.push(listener); } };
  return { matchMedia: () => query, setNight(value) { query.matches = value; listeners.forEach(listener => listener()); } };
}

const chain = colours => colours.reduceRight((parentElement, backgroundColor) => ({ backgroundColor, parentElement }), null);
const lightPage = ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"];

// backgrounds: colours from the element under every sampled point up to <html>; pageAt(x, y) for
// a page that differs by place. frame: run as a frame inside a page of https://example.com.
// scheme: the page's <meta name="color-scheme">; classes: on <body>.
function content({ night = false, backgrounds = lightPage, pageAt, frame = false, contentType = "text/html", scheme,
  classes = [], ...options } = {}) {
  const attributes = {}, events = {}, messages = [], filteredReads = [];
  const chromeStorage = storage(options), mac = appearance(night);
  const sandbox = {
    matchMedia: mac.matchMedia, innerWidth: 1000, innerHeight: 800, URL,
    getComputedStyle: el => { filteredReads.push("data-eink" in attributes); return { backgroundColor: el.backgroundColor }; },
    addEventListener(name, handler) { events[name] = handler; },
    setTimeout() {},
    location: frame ? { hostname: "widget.example", ancestorOrigins: ["https://example.com"] } : { hostname: "example.com", ancestorOrigins: [] },
    document: { hidden: false, contentType, addEventListener(name, handler) { events[name] = handler; },
      elementFromPoint: (x, y) => pageAt ? pageAt(x, y) : chain(backgrounds),
      querySelector: selector => selector.startsWith("meta") && scheme ? { content: scheme } : null,
      body: { classList: { contains: name => classes.includes(name) } },
      documentElement: {
        classList: { contains: () => false }, getAttribute: name => attributes[name] ?? null,
        setAttribute(name, value) { attributes[name] = value; }, removeAttribute(name) { delete attributes[name]; },
        toggleAttribute(name, on) { if (on) attributes[name] = ""; else delete attributes[name]; }
      } },
    chrome: { storage: chromeStorage, runtime: { onMessage: { addListener(listener) { messages.push(listener); } } } }
  };
  sandbox.window = sandbox;
  sandbox.window.top = frame ? {} : sandbox;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/content.js`, "utf8"), sandbox);
  return { palette: () => attributes["data-eink"] ?? "off", siteDark: () => "data-site-dark" in attributes,
    flipsBack: () => "data-eink-frame" in attributes, filteredReads, answers: messages.length,
    ping: () => new Promise(resolve => messages[0]("eink-ping", {}, resolve)),
    localWrites: chromeStorage.localWrites, setNight: mac.setNight, ready: () => events.DOMContentLoaded(), load: () => events.load(),
    change: (changes, area = "sync") => chromeStorage.listeners.forEach(listener => listener(changes, area)) };
}

// page: what the page in the active tab answers, or nothing where E-ink can't run.
function popup({ night = false, page, ...options } = {}) {
  const element = extra => ({ disabled: true, hidden: true, textContent: "", handlers: {}, ...extra,
    addEventListener(name, handler) { this.handlers[name] = handler; } });
  const ids = Object.fromEntries(["#controls", "#palette-row", "#caption", "#status", "#theme-note"].map(id => [id, element()]));
  const radios = [["mode", "on"], ["mode", "off"], ["mode", "auto"], ["palette", "warm"], ["palette", "dark"]]
    .map(([name, value]) => element({ name, value, checked: false }));
  const root = { dataset: {}, off: false, toggleAttribute(name, on) { this.off = on; } };
  const chromeStorage = storage(options), mac = appearance(night);
  vm.runInNewContext(fs.readFileSync(`${__dirname}/popup.js`, "utf8"), {
    matchMedia: mac.matchMedia,
    document: { querySelector: selector => ids[selector], querySelectorAll: () => radios, documentElement: root },
    chrome: { storage: chromeStorage, tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async (tabId, message, options) => {
        assert.equal(JSON.stringify([tabId, message, options]), JSON.stringify([7, "eink-ping", { frameId: 0 }]));
        if (!page) throw new Error("Could not establish connection. Receiving end does not exist.");
        return page;
      } } }
  });
  return { ids, root, writes: chromeStorage.writes, setNight: mac.setNight,
    caption: () => ids["#caption"].textContent,
    selected: name => radios.find(radio => radio.name === name && radio.checked)?.value,
    choose: (name, value) => ids["#controls"].handlers.change({ target: { name, value } }) };
}

test("content script picks the right palette for every combination", async () => {
  for (const mode of ["on", "off", "auto"]) for (const palette of ["warm", "dark"]) for (const night of [false, true]) {
    const s = content({ night, stored: { mode, palette } }); await settled();
    const expected = mode === "on" || (mode === "auto" && night) ? palette : "off";
    assert.equal(s.palette(), expected, JSON.stringify({ mode, palette, night }));
  }
});

test("content script defaults to Auto with Dark, and survives bad or missing settings", async () => {
  const day = content(); await settled(); assert.equal(day.palette(), "off");
  const night = content({ night: true }); await settled(); assert.equal(night.palette(), "dark");
  const broken = content({ night: true, loadFails: true }); await settled(); assert.equal(broken.palette(), "dark");
  const bogus = content({ stored: { mode: "on", palette: "neon" } }); await settled(); assert.equal(bogus.palette(), "dark");
  // Settings from the earlier Day/Night version are ignored rather than half-applied.
  const old = content({ night: true, stored: { enabled: true, day: "off", night: "warm" } }); await settled();
  assert.equal(old.palette(), "dark");
});

test("content script follows the Mac's appearance live in Auto", async () => {
  const s = content({ stored: { palette: "warm" } }); await settled();
  assert.equal(s.palette(), "off");
  s.setNight(true); assert.equal(s.palette(), "warm");
  s.setNight(false); assert.equal(s.palette(), "off");
});

test("content script applies sync changes live and ignores other changes", async () => {
  const s = content(); await settled();
  s.change({ mode: { oldValue: "auto", newValue: "on" } }); assert.equal(s.palette(), "dark");
  s.change({ palette: { newValue: "warm" } }); assert.equal(s.palette(), "warm");
  s.change({ mode: { newValue: "off" } }, "local"); assert.equal(s.palette(), "warm");
  s.change({ other: { newValue: 1 } }); assert.equal(s.palette(), "warm");
  s.change({ mode: { newValue: "off" } }); assert.equal(s.palette(), "off");
  s.change({ mode: { oldValue: "off" } }); assert.equal(s.palette(), "off", "a removed key falls back to Auto, which is off by day");
});

test("the dark-site check votes on a grid, so one dark element can't decide", async () => {
  // A light page with a black video player across the middle of the screen.
  const player = content({ pageAt: (x, y) => chain(y === 400 && x >= 400 && x <= 600 ? ["rgb(0, 0, 0)"] : lightPage) });
  player.ready(); assert.equal(player.siteDark(), false);
  const dark = content({ backgrounds: ["rgba(0, 0, 0, 0)", "rgba(255, 255, 255, 0.1)", "rgb(31, 31, 31)", "rgb(255, 255, 255)"] });
  dark.ready(); assert.equal(dark.siteDark(), true);
  const canvas = content({ backgrounds: ["rgba(0, 0, 0, 0)"] }); canvas.ready();
  assert.equal(canvas.siteDark(), false, "nothing opaque: Chrome's white canvas shows");
  const meta = content({ scheme: "dark" }); meta.ready(); assert.equal(meta.siteDark(), true);
  const both = content({ scheme: "light dark" }); both.ready(); assert.equal(both.siteDark(), false, "light dark leaves it to the grid");
  const saved = content({ classes: ["dark"] }); saved.ready(); assert.equal(saved.siteDark(), true);
});

test("the dark-site check reads the page without our filter, and skips PDFs", async () => {
  const s = content({ night: true, stored: { mode: "on" } }); await settled();
  assert.equal(s.palette(), "dark");
  s.ready();
  assert.ok(s.filteredReads.length > 0 && s.filteredReads.every(on => !on), "no data-eink while reading colours");
  assert.equal(s.palette(), "dark", "and it's back afterwards");
  const pdf = content({ night: true, contentType: "application/pdf", backgrounds: ["rgb(40, 40, 40)"] }); pdf.load();
  await settled();
  assert.equal(pdf.siteDark(), false); assert.deepEqual(pdf.localWrites, []);
});

test("the answer is remembered per site and appearance, and written only when it changes", async () => {
  const known = content({ night: true, local: { "dark:example.com:dark": true } }); await settled();
  assert.equal(known.siteDark(), true, "a remembered dark site starts dark, before any check");
  known.setNight(false); await settled();
  assert.equal(known.siteDark(), true, "nothing remembered for day: the night answer stays until a check");
  const same = content({ night: true, backgrounds: ["rgb(20, 20, 20)"], local: { "dark:example.com:dark": true } });
  same.ready(); same.load(); await settled();
  assert.deepEqual(same.localWrites, []);
  const fresh = content(); fresh.ready(); fresh.load(); await settled();
  assert.deepEqual(fresh.localWrites, [{ "dark:example.com:light": false }], "one write, not one per check");
  const changed = content({ night: true, local: { "dark:example.com:dark": true } }); await settled();
  changed.ready(); await settled();
  assert.equal(changed.siteDark(), false); assert.deepEqual(changed.localWrites, [{ "dark:example.com:dark": false }]);
});

test("a frame never gets the page filter, and flips photos back only inside an inverted page", async () => {
  const dark = content({ frame: true, night: true }); await settled();
  assert.equal(dark.palette(), "off"); assert.equal(dark.flipsBack(), true);
  dark.change({ palette: { newValue: "warm" } }); assert.equal(dark.flipsBack(), false, "Warm doesn't invert a light page");
  dark.change({ palette: { newValue: "dark" } }); assert.equal(dark.flipsBack(), true);
  dark.setNight(false); assert.equal(dark.flipsBack(), false, "Auto by day: the page isn't filtered");
  // Inside a site that is dark anyway, Dark only drops colour and Warm inverts.
  const inDark = content({ frame: true, night: true, local: { "dark:example.com:dark": true } }); await settled();
  assert.equal(inDark.flipsBack(), false);
  inDark.change({ palette: { newValue: "warm" } }); assert.equal(inDark.flipsBack(), true);
  // The top page's answer reaches its frames live.
  const live = content({ frame: true, night: true }); await settled();
  live.change({ "dark:example.com:dark": { newValue: true } }, "local"); assert.equal(live.flipsBack(), false);
  const own = content({ frame: true, night: true, backgrounds: ["rgb(31, 31, 31)"] }); own.ready(); own.load(); await settled();
  assert.deepEqual(own.localWrites, [], "only the top page checks the site's theme");
  assert.equal(own.answers, 0, "and only the top page answers the popup");
});

test("the page tells the popup its site and whether it is dark anyway", async () => {
  const s = content({ backgrounds: ["rgb(20, 20, 20)"] }); s.ready();
  assert.deepEqual({ ...await s.ping() }, { site: "example.com", siteDark: true });
});

test("popup shows the defaults and the state right now", async () => {
  const s = popup();
  assert.equal(s.ids["#controls"].disabled, true);
  await settled();
  assert.equal(s.ids["#controls"].disabled, false);
  assert.equal(s.selected("mode"), "auto"); assert.equal(s.selected("palette"), "dark");
  assert.equal(s.caption(), "Now: Day (Auto) · Gmail as usual"); assert.equal(s.root.off, true);
  s.setNight(true);
  assert.equal(s.caption(), "Now: Night (Auto) · Dark e-ink"); assert.equal(s.root.off, false);
  assert.equal(s.ids["#theme-note"].hidden, true);
});

test("popup saves each choice and dims the palette while off", async () => {
  const s = popup(); await settled();
  await s.choose("mode", "on");
  assert.equal(s.caption(), "Now: On · Dark e-ink");
  await s.choose("palette", "warm");
  assert.equal(s.root.dataset.palette, "warm"); assert.equal(s.caption(), "Now: On · Warm paper");
  await s.choose("mode", "off");
  assert.equal(s.ids["#palette-row"].disabled, true); assert.equal(s.caption(), "Now: Off · Gmail as usual");
  assert.deepEqual(s.writes, [{ mode: "on" }, { palette: "warm" }, { mode: "off" }]);
});

test("popup shows a note when this site's own dark theme was detected", async () => {
  const dark = popup({ page: { site: "example.com", siteDark: true } }); await settled();
  assert.equal(dark.ids["#theme-note"].hidden, false);
  const light = popup({ page: { site: "example.com", siteDark: false } }); await settled();
  assert.equal(light.ids["#theme-note"].hidden, true);
  const blocked = popup(); await settled();
  assert.equal(blocked.ids["#theme-note"].hidden, true);
});

test("popup reverts the choice and says so when saving fails", async () => {
  const s = popup({ saveFails: true }); await settled();
  await s.choose("palette", "warm");
  assert.equal(s.selected("palette"), "dark");
  assert.match(s.ids["#status"].textContent, /Could not save/);
});

test("popup stays disabled when the settings cannot be loaded", async () => {
  const s = popup({ loadFails: true }); await settled();
  assert.equal(s.ids["#controls"].disabled, true);
  assert.match(s.ids["#status"].textContent, /Could not load/);
});
