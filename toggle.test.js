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
// scheme: the page's <meta name="color-scheme">; classes: on <body>. links: the page's stylesheet
// links; fetched: what the extension hands back for a stylesheet light.js can't read.
function content({ night = false, backgrounds = lightPage, pageAt, frame = false, contentType = "text/html", scheme,
  classes = [], links = [], fetched = "", ...options } = {}) {
  const attributes = {}, events = {}, messages = [], filteredReads = [], dispatched = [], sent = [];
  const timers = [], observers = [], navigation = [];
  const chromeStorage = storage(options), mac = appearance(night);
  const sandbox = {
    matchMedia: mac.matchMedia, innerWidth: 1000, innerHeight: 800, URL,
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    MutationObserver: class { constructor(callback) { this.callback = callback; this.dropped = 0; observers.push(this); } observe() {} takeRecords() { this.dropped++; return []; } },
    getComputedStyle: el => { filteredReads.push("data-eink" in attributes); return { backgroundColor: el.backgroundColor }; },
    addEventListener(name, handler) { events[name] = handler; },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    navigation: { addEventListener(name, listener) { if (name === "currententrychange") navigation.push(listener); } },
    location: frame ? { href: "https://widget.example/", hostname: "widget.example", ancestorOrigins: ["https://example.com"] }
      : { href: "https://example.com/", hostname: "example.com", ancestorOrigins: [] },
    document: { hidden: false, readyState: "complete", contentType, addEventListener(name, handler) { events[name] = handler; },
      dispatchEvent(event) { dispatched.push(event); },
      elementFromPoint: (x, y) => pageAt ? pageAt(x, y) : chain(backgrounds),
      querySelector: selector => selector.startsWith("meta") && scheme ? { content: scheme } : null,
      querySelectorAll: () => links,
      body: { classList: { contains: name => classes.includes(name) } },
      documentElement: {
        classList: { contains: () => false }, getAttribute: name => attributes[name] ?? null,
        setAttribute(name, value) { attributes[name] = value; }, removeAttribute(name) { delete attributes[name]; },
        toggleAttribute(name, on) { if (on) attributes[name] = ""; else delete attributes[name]; }
      } },
    chrome: { storage: chromeStorage, runtime: {
      onMessage: { addListener(listener) { messages.push(listener); } },
      sendMessage: async message => { sent.push(message); return fetched; } } }
  };
  sandbox.window = sandbox;
  sandbox.window.top = frame ? {} : sandbox;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/content.js`, "utf8"), sandbox);
  return { palette: () => attributes["data-eink"] ?? "off", siteDark: () => "data-site-dark" in attributes,
    flipsBack: () => "data-eink-frame" in attributes, filteredReads, answers: messages.length, sent,
    ping: () => new Promise(resolve => messages[0]("eink-ping", {}, resolve)),
    // What light.js gets back when it asks for a copy of url.
    relay: async url => { events["eink-light-fetch"]({ detail: JSON.stringify({ id: 1, url }) }); await settled(); return JSON.parse(dispatched.at(-1).detail).text; },
    localWrites: chromeStorage.localWrites, setNight: mac.setNight, ready: () => events.DOMContentLoaded(), load: () => events.load(),
    change: (changes, area = "sync") => chromeStorage.listeners.forEach(listener => listener(changes, area)),
    // The page navigating in place, changing <html> or <body>, or stripping one of our attributes.
    navigate: () => navigation.forEach(listener => listener()), popstate: () => events.popstate(),
    pageChanges: () => observers[0].callback([]), strip: name => { delete attributes[name]; observers[0].callback([]); },
    pendingTimers: () => timers.length, silenced: () => observers[0].dropped, location: sandbox.location,
    tick: () => { const due = timers.splice(0); due.forEach(callback => callback()); } };
}

// Runs light.js against fake page APIs. sheets: document.styleSheets.
function light({ sheets = [] } = {}) {
  const queries = [], events = [], listeners = {}, observers = [], inserted = [];
  class CSSStyleSheet { insertRule(text) { return text; } replace(text) { return text; } replaceSync(text) { return text; } }
  class CSSGroupingRule { insertRule(text) { return text; } }
  class HTMLLinkElement { constructor(href) { this.href = href; this.sheet = { disabled: false }; } after(el) { inserted.push(el); } }
  const sandbox = {
    window: { matchMedia: query => { queries.push(query); return { media: query }; } },
    CSSStyleSheet, CSSGroupingRule, HTMLLinkElement, URL, Element: class { attachShadow() { return {}; } },
    MutationObserver: class { constructor(callback) { this.callback = callback; this.observed = []; observers.push(this); } observe(target) { this.observed.push(target); } },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    document: { styleSheets: sheets, addEventListener(name, listener) { listeners[name] = listener; }, dispatchEvent(event) { events.push(event); },
      createElement: () => ({}) },
    addEventListener(name, listener) { listeners[name] = listener; }
  };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/light.js`, "utf8"), sandbox);
  return { sandbox, queries, events, listeners, inserted, matchMedia: query => sandbox.window.matchMedia(query),
    added: node => observers.find(observer => observer.observed.includes(sandbox.document)).callback([{ type: "childList", addedNodes: [node] }]) };
}

// Runs bg.js with fake Chrome APIs. stored: sync storage; response: what fetch returns.
function background({ stored = {}, response } = {}) {
  const calls = [], listeners = {}, fetches = [];
  const chrome = {
    storage: { sync: { get: async () => stored }, local: { remove: async () => {} }, onChanged: { addListener(listener) { listeners.changed = listener; } } },
    scripting: {
      unregisterContentScripts: async options => { calls.push(["unregister", JSON.parse(JSON.stringify(options))]); },
      registerContentScripts: async scripts => { calls.push(["register", JSON.parse(JSON.stringify(scripts))]); } },
    runtime: { onInstalled: { addListener(listener) { listeners.installed = listener; } }, onStartup: { addListener(listener) { listeners.startup = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } } }
  };
  const fetch = async (url, init) => { fetches.push([url, JSON.parse(JSON.stringify(init))]); return response; };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/bg.js`, "utf8"), { chrome, fetch, console });
  return { calls, listeners, fetches,
    ask: (fetchCSS, sender = { tab: { id: 1 } }) => new Promise(resolve => { if (listeners.message({ fetchCSS }, sender, resolve) !== true) resolve(null); }) };
}
const css = (body, type = "text/css; charset=utf-8", extra = {}) =>
  ({ ok: true, headers: { get: name => ({ "content-type": type, ...extra })[name] ?? null }, text: async () => body });

// page: what the page in the active tab answers, or nothing where E-ink can't run.
function popup({ night = false, page, ...options } = {}) {
  const element = extra => ({ disabled: true, hidden: true, textContent: "", handlers: {}, ...extra,
    addEventListener(name, handler) { this.handlers[name] = handler; } });
  const ids = Object.fromEntries(["#controls", "#palette-row", "#site-row", "#site-name", "#caption", "#status", "#theme-note"]
    .map(id => [id, element()]));
  const radios = [["mode", "on"], ["mode", "off"], ["mode", "auto"], ["palette", "warm"], ["palette", "dark"], ["site", "on"], ["site", "off"]]
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

test("an in-page route change or theme switch makes the page check again, without remembering it", async () => {
  let viewerOpen = false;
  const s = content({ night: true, stored: { mode: "on" }, pageAt: () => chain(viewerOpen ? ["rgba(0, 0, 0, 0.9)"] : lightPage) });
  s.ready(); await settled();
  assert.equal(s.siteDark(), false); assert.deepEqual(s.localWrites, [{ "dark:example.com:dark": false }]);
  // A photo viewer opens over a black backdrop with pushState: checked again half a second later.
  viewerOpen = true;
  s.navigate(); s.navigate();
  assert.equal(s.pendingTimers(), 1, "one check for a burst of changes");
  assert.equal(s.siteDark(), false);
  s.tick(); await settled();
  assert.equal(s.siteDark(), true, "the black viewer is dark anyway");
  assert.equal(s.palette(), "dark");
  // Back to the feed with the browser's back button, then a theme switch on <body>.
  viewerOpen = false;
  s.popstate(); s.tick(); await settled();
  assert.equal(s.siteDark(), false);
  viewerOpen = true;
  s.pageChanges(); s.tick(); await settled();
  assert.equal(s.siteDark(), true);
  assert.deepEqual(s.localWrites, [{ "dark:example.com:dark": false }], "only the answer at load is kept for the next visit");
  // The check 2.5 s after load, made after the route has changed, isn't kept either.
  s.location.href = "https://example.com/status/1/photo/1";
  s.load(); await settled();
  assert.deepEqual(s.localWrites, [{ "dark:example.com:dark": false }]);
});

test("our attributes come back if the page strips them, and our own writes don't set off a check", async () => {
  const s = content({ night: true, stored: { mode: "on" } }); await settled();
  s.ready();
  const silenced = s.silenced();
  assert.ok(silenced > 0, "records from our own writes are dropped");
  s.change({ palette: { newValue: "warm" } });
  assert.ok(s.silenced() > silenced, "a settings change drops its records too");
  assert.equal(s.pendingTimers(), 0);
  s.strip("data-eink"); assert.equal(s.palette(), "off");
  s.tick(); assert.equal(s.palette(), "warm");
});

test("a top page decides for itself, while frames follow their top page", async () => {
  // Still loading, so it hasn't checked yet: another tab's answer must not leak in.
  const top = content({ night: true }); await settled();
  top.change({ "dark:example.com:dark": { newValue: true } }, "local");
  assert.equal(top.siteDark(), false, "another tab of the site on a dark view doesn't make this one dark");
  const frame = content({ frame: true, night: true }); await settled();
  frame.change({ "dark:example.com:dark": { newValue: true } }, "local");
  assert.equal(frame.flipsBack(), false);
});

test("the dark-site check puts our attribute back even if reading the page fails", async () => {
  const s = content({ night: true, stored: { mode: "on" }, pageAt: () => { throw new Error("odd page"); } }); await settled();
  assert.throws(() => s.ready(), /odd page/);
  assert.equal(s.palette(), "dark");
});

test("the page tells the popup its site and whether it is dark anyway", async () => {
  const s = content({ backgrounds: ["rgb(20, 20, 20)"] }); s.ready();
  assert.deepEqual({ ...await s.ping() }, { site: "example.com", siteDark: true });
});

test("a site switched off stays as it is, live, and so do its frames", async () => {
  const off = content({ night: true, stored: { mode: "on", off: ["example.com"] } }); await settled();
  assert.equal(off.palette(), "off");
  const other = content({ night: true, stored: { mode: "on", off: ["other.example"] } }); await settled();
  assert.equal(other.palette(), "dark");
  other.change({ off: { newValue: ["other.example", "example.com"] } }); assert.equal(other.palette(), "off");
  other.change({ off: { newValue: ["other.example"] } }); assert.equal(other.palette(), "dark");
  other.change({ off: { oldValue: ["other.example"] } }); assert.equal(other.palette(), "dark", "a removed list switches nothing off");
  const bad = content({ night: true, stored: { off: "example.com" } }); await settled();
  assert.equal(bad.palette(), "dark", "a list that isn't one is ignored");
  // A frame goes by the page it is in, not by its own address.
  const frame = content({ frame: true, night: true, stored: { off: ["example.com"] } }); await settled();
  assert.equal(frame.flipsBack(), false);
  const ownHost = content({ frame: true, night: true, stored: { off: ["widget.example"] } }); await settled();
  assert.equal(ownHost.flipsBack(), true);
});

test("popup shows the defaults and the state right now", async () => {
  const s = popup();
  assert.equal(s.ids["#controls"].disabled, true);
  await settled();
  assert.equal(s.ids["#controls"].disabled, false);
  assert.equal(s.selected("mode"), "auto"); assert.equal(s.selected("palette"), "dark");
  assert.equal(s.caption(), "Now: Day (Auto) · Sites as usual"); assert.equal(s.root.off, true);
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
  assert.equal(s.ids["#palette-row"].disabled, true); assert.equal(s.caption(), "Now: Off · Sites as usual");
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

test("popup switches this site off and on, keeping the other sites in the list", async () => {
  const s = popup({ night: true, page: { site: "example.com", siteDark: false }, stored: { off: ["a.example"] } }); await settled();
  assert.equal(s.ids["#site-row"].disabled, false); assert.equal(s.ids["#site-name"].textContent, "example.com");
  assert.equal(s.selected("site"), "on");
  await s.choose("site", "off");
  assert.equal(s.selected("site"), "off"); assert.equal(s.caption(), "Now: Night (Auto) · This site as usual"); assert.equal(s.root.off, true);
  await s.choose("site", "on");
  assert.equal(s.selected("site"), "on"); assert.equal(s.caption(), "Now: Night (Auto) · Dark e-ink");
  assert.deepEqual(s.writes.map(write => [...write.off]), [["a.example", "example.com"], ["a.example"]]);
  // Its dark-theme note goes away with it.
  const dark = popup({ page: { site: "example.com", siteDark: true }, stored: { off: ["example.com"] } }); await settled();
  assert.equal(dark.selected("site"), "off"); assert.equal(dark.ids["#theme-note"].hidden, true);
});

test("popup disables This site where the page can't answer", async () => {
  const blocked = popup(); await settled();
  assert.equal(blocked.ids["#site-row"].disabled, true); assert.equal(blocked.selected("site"), undefined);
  assert.match(blocked.ids["#site-name"].textContent, /Chrome doesn't let extensions change this page/);
  const local = popup({ page: { site: "", siteDark: false } }); await settled();
  assert.equal(local.ids["#site-row"].disabled, true); assert.match(local.ids["#site-name"].textContent, /no site name/);
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

test("light.js makes every form of the colour-scheme query read light, and rewriting twice changes nothing", () => {
  const s = light();
  for (const [query, expected] of [
    ["(prefers-color-scheme: dark)", "(width < 0px)"],
    ["(prefers-color-scheme: light)", "(width >= 0px)"],
    ["( Prefers-Color-Scheme :DARK )", "(width < 0px)"],
    ["screen and (prefers-color-scheme: dark)", "screen and (width < 0px)"],
    ["not screen and (prefers-color-scheme: light)", "not screen and (width >= 0px)"],
    ["not (prefers-color-scheme: dark)", "not (width < 0px)"],
    ["(min-width: 600px) or (prefers-color-scheme: dark)", "(min-width: 600px) or (width < 0px)"],
    ["(prefers-color-scheme: dark), print", "(width < 0px), print"],
    ["(min-width: 600px)", "(min-width: 600px)"]
  ]) {
    s.matchMedia(query); assert.equal(s.queries.at(-1), expected, query);
    s.matchMedia(expected); assert.equal(s.queries.at(-1), expected, `${query} again`);
  }
});

test("light.js rewrites the dark-mode rules of readable stylesheets, nested and imported, once", () => {
  const imported = { cssRules: [{ media: { mediaText: "(prefers-color-scheme: dark)" }, cssRules: [] }] };
  const sheet = { cssRules: [
    { media: { mediaText: "(prefers-color-scheme: dark)" }, cssRules: [] },
    { cssRules: [{ media: { mediaText: "print and (prefers-color-scheme: light)" }, cssRules: [] }] },
    { media: { mediaText: "all" }, styleSheet: imported },
    { selectorText: "body" }
  ] };
  const s = light({ sheets: [sheet] });
  s.listeners.DOMContentLoaded();
  assert.equal(sheet.cssRules[0].media.mediaText, "(width < 0px)");
  assert.equal(sheet.cssRules[1].cssRules[0].media.mediaText, "print and (width >= 0px)");
  assert.equal(imported.cssRules[0].media.mediaText, "(width < 0px)");
  sheet.cssRules[0].media.mediaText = "(prefers-color-scheme: dark)";
  s.listeners.load();
  assert.equal(sheet.cssRules[0].media.mediaText, "(prefers-color-scheme: dark)", "a sheet is walked once; later rules come through the hooks");
});

test("light.js rewrites rules that scripts add later, and media attributes as they arrive", () => {
  const s = light();
  const sheet = new s.sandbox.CSSStyleSheet();
  assert.equal(sheet.insertRule("@media (prefers-color-scheme: dark) { a { color: red } }", 0), "@media (width < 0px) { a { color: red } }");
  assert.equal(sheet.replaceSync("@media (prefers-color-scheme: light) { b {} }"), "@media (width >= 0px) { b {} }");
  assert.equal(new s.sandbox.CSSGroupingRule().insertRule("a { color: red }"), "a { color: red }");
  const attributes = { media: "(prefers-color-scheme: dark)" };
  s.added({ nodeType: 1, localName: "source", matches: () => true, getAttribute: name => attributes[name], setAttribute: (name, value) => { attributes[name] = value; } });
  assert.equal(attributes.media, "(width < 0px)");
});

test("light.js replaces a stylesheet it can't read with a rewritten copy, resolving its URLs", () => {
  const s = light();
  const link = new s.sandbox.HTMLLinkElement("https://cdn.example/css/site.css");
  s.sandbox.document.styleSheets.push({ ownerNode: link, get cssRules() { throw new Error("SecurityError"); } });
  s.listeners.DOMContentLoaded();
  const { id, url } = JSON.parse(s.events[0].detail);
  assert.equal(url, "https://cdn.example/css/site.css");
  s.listeners["eink-light-css"]({ detail: JSON.stringify({ id: 99, text: "@media (prefers-color-scheme: dark) {}" }) });
  assert.equal(s.inserted.length, 0, "an answer to nothing it asked is ignored");
  s.listeners["eink-light-css"]({ detail: JSON.stringify({ id, text:
    '@import "base.css"; @media (prefers-color-scheme: dark) { body { background: url(img/bg.png) } i { background: url("data:image/png;base64,AA") } }' }) });
  assert.equal(s.inserted[0].textContent,
    '@import "https://cdn.example/css/base.css"; @media (width < 0px) { body { background: url("https://cdn.example/css/img/bg.png") } i { background: url("data:image/png;base64,AA") } }');
  assert.equal(link.sheet.disabled, true);
});

test("content.js relays only stylesheets the page links to and can't read, and only a few", async () => {
  const blocked = { get cssRules() { throw new Error("SecurityError"); } };
  const s = content({ fetched: "@media (prefers-color-scheme: dark) {}", links: [
    { href: "https://cdn.example/site.css", sheet: blocked }, { href: "https://example.com/own.css", sheet: { cssRules: [] } }] });
  assert.equal(await s.relay("https://cdn.example/site.css"), "@media (prefers-color-scheme: dark) {}");
  assert.equal(await s.relay("https://example.com/own.css"), "", "a sheet the page can read needs no copy");
  assert.equal(await s.relay("http://192.168.1.1/status.css"), "", "a URL the page doesn't link as a stylesheet");
  assert.deepEqual(s.sent.map(message => message.fetchCSS), ["https://cdn.example/site.css"]);
  for (let i = 0; i < 25; i++) await s.relay("https://cdn.example/site.css");
  assert.equal(s.sent.length, 20, "at most 20 a page");
});

test("bg.js registers light.js for every site except those switched off, and not while Off", async () => {
  const s = background({ stored: { mode: "auto", off: ["example.com", "bad host/*", 42] } });
  s.listeners.installed(); await settled();
  assert.deepEqual(s.calls, [["unregister", { ids: ["light"] }], ["register", [{ id: "light", matches: ["<all_urls>"],
    excludeMatches: ["*://example.com/*"], js: ["light.js"], css: ["light.css"], runAt: "document_start", allFrames: true,
    matchOriginAsFallback: true, world: "MAIN" }]]]);
  const off = background({ stored: { mode: "off" } });
  off.listeners.startup(); await settled();
  assert.deepEqual(off.calls, [["unregister", { ids: ["light"] }]]);
  const live = background();
  live.listeners.changed({ palette: { newValue: "warm" } }, "sync"); await settled();
  assert.equal(live.calls.length, 0, "the palette doesn't change what is registered");
  live.listeners.changed({ off: { newValue: [] } }, "sync"); await settled();
  assert.equal(live.calls.at(-1)[0], "register");
});

test("bg.js fetches stylesheets without cookies and hands back only CSS with dark-mode rules", async () => {
  const dark = "@media (prefers-color-scheme: dark) { body { background: #000 } }";
  const ok = background({ response: css(dark) });
  assert.equal(await ok.ask("https://cdn.example/site.css"), dark);
  assert.deepEqual(ok.fetches, [["https://cdn.example/site.css", { credentials: "omit", referrerPolicy: "no-referrer" }]]);
  assert.equal(await background({ response: css(dark, "application/json") }).ask("https://api.example/me"), "");
  assert.equal(await background({ response: css(dark, "text/html") }).ask("https://mail.example/inbox"), "");
  assert.equal(await background({ response: css("body { color: red }") }).ask("https://cdn.example/plain.css"), "", "nothing to rewrite");
  assert.equal(await background({ response: css(dark, "text/css", { "content-length": "9000000" }) }).ask("https://cdn.example/huge.css"), "");
  assert.equal(await background({ response: { ...css(dark), ok: false } }).ask("https://cdn.example/missing.css"), "");
  const local = background({ response: css(dark) });
  assert.equal(await local.ask("file:///Users/someone/notes.css"), "");
  assert.equal(await local.ask("chrome-extension://abc/x.css"), "");
  assert.equal(local.fetches.length, 0);
  assert.equal(await background({ response: css(dark) }).ask("https://cdn.example/site.css", {}), null, "only pages' content scripts may ask");
});
