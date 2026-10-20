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

// backgrounds: colours from the element under the page centre up to <html>.
function content({ night = false, backgrounds = ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"], ...options } = {}) {
  const attributes = {}, events = {};
  const chromeStorage = storage(options), mac = appearance(night);
  const chain = backgrounds.reduceRight((parentElement, backgroundColor) => ({ backgroundColor, parentElement }), null);
  vm.runInNewContext(fs.readFileSync(`${__dirname}/content.js`, "utf8"), {
    matchMedia: mac.matchMedia, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: el => ({ backgroundColor: el.backgroundColor }),
    addEventListener(name, handler) { events[name] = handler; },
    setTimeout() {},
    document: { hidden: false, elementFromPoint: () => chain, addEventListener(name, handler) { events[name] = handler; },
      documentElement: {
        setAttribute(name, value) { attributes[name] = value; }, removeAttribute(name) { delete attributes[name]; },
        toggleAttribute(name, on) { if (on) attributes[name] = ""; else delete attributes[name]; }
      } },
    chrome: { storage: chromeStorage }
  });
  return { palette: () => attributes["data-eink"] ?? "off", gmailDark: () => "data-gmail-dark" in attributes,
    localWrites: chromeStorage.localWrites, setNight: mac.setNight, load: () => events.load(),
    change: (changes, area = "sync") => chromeStorage.listeners.forEach(listener => listener(changes, area)) };
}

function popup({ night = false, ...options } = {}) {
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
    chrome: { storage: chromeStorage }
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

test("content script detects Gmail's own dark theme and reports it", async () => {
  const light = content(); light.load();
  assert.equal(light.gmailDark(), false); assert.deepEqual(light.localWrites, [{ gmailDark: false }]);
  const dark = content({ backgrounds: ["rgba(0, 0, 0, 0)", "rgba(255, 255, 255, 0.1)", "rgb(31, 31, 31)", "rgb(255, 255, 255)"] }); dark.load();
  assert.equal(dark.gmailDark(), true); assert.deepEqual(dark.localWrites, [{ gmailDark: true }]);
  const unknown = content({ backgrounds: ["rgba(0, 0, 0, 0)"] }); unknown.load();
  assert.equal(unknown.gmailDark(), false); assert.deepEqual(unknown.localWrites, []);
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

test("popup shows a note when Gmail's own dark theme was detected", async () => {
  const s = popup({ local: { gmailDark: true } }); await settled();
  assert.equal(s.ids["#theme-note"].hidden, false);
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
