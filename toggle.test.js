const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const settled = () => new Promise(resolve => setImmediate(resolve));
const palettes = ["warm", "dark", "off"];

function storage({ stored = {}, loadFails = false, saveFails = false } = {}) {
  const listeners = [], writes = [];
  return { listeners, writes, sync: {
    get: async () => { if (loadFails) throw new Error("Load failed"); return stored; },
    set: async value => { if (saveFails) throw new Error("Quota exceeded"); writes.push({ ...value }); }
  }, onChanged: { addListener(listener) { listeners.push(listener); } } };
}

// Fake prefers-color-scheme: dark query whose change listeners fire on setNight().
function appearance(nightNow) {
  const listeners = [];
  const query = { matches: nightNow, addEventListener(name, listener) { listeners.push(listener); } };
  return { matchMedia: () => query, setNight(value) { query.matches = value; listeners.forEach(listener => listener()); } };
}

function content({ night = false, ...options } = {}) {
  const attributes = {};
  const chromeStorage = storage(options), mac = appearance(night);
  vm.runInNewContext(fs.readFileSync(`${__dirname}/content.js`, "utf8"), {
    matchMedia: mac.matchMedia,
    document: { documentElement: {
      setAttribute(name, value) { attributes[name] = value; }, removeAttribute(name) { delete attributes[name]; }
    } },
    chrome: { storage: chromeStorage }
  });
  return { palette: () => attributes["data-eink"] ?? "off", setNight: mac.setNight,
    change: (changes, area = "sync") => chromeStorage.listeners.forEach(listener => listener(changes, area)) };
}

function popup({ night = false, ...options } = {}) {
  const element = extra => ({ disabled: true, hidden: false, textContent: "", attributes: {}, handlers: {}, ...extra,
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, handler) { this.handlers[name] = handler; } });
  const ids = Object.fromEntries(["#enabled", "#times", "#caption", "#status", "#now-day", "#now-night"].map(id => [id, element()]));
  const radios = ["day", "night"].flatMap(name => palettes.map(value => element({ name, value, checked: false })));
  const root = { dataset: {}, off: false, toggleAttribute(name, on) { this.off = on; } };
  const chromeStorage = storage(options), mac = appearance(night);
  vm.runInNewContext(fs.readFileSync(`${__dirname}/popup.js`, "utf8"), {
    matchMedia: mac.matchMedia,
    document: { querySelector: selector => ids[selector], querySelectorAll: () => radios, documentElement: root },
    chrome: { storage: chromeStorage }
  });
  return { ids, root, writes: chromeStorage.writes, setNight: mac.setNight,
    selected: name => radios.find(radio => radio.name === name && radio.checked)?.value,
    choose: (name, value) => ids["#times"].handlers.change({ target: { name, value } }),
    clickMaster: () => ids["#enabled"].handlers.click() };
}

test("content script picks the right palette for every combination", async () => {
  for (const enabled of [true, false]) for (const day of palettes) for (const night of palettes) for (const isNight of [false, true]) {
    const s = content({ night: isNight, stored: { enabled, day, night } }); await settled();
    const expected = enabled ? (isNight ? night : day) : "off";
    assert.equal(s.palette(), expected, JSON.stringify({ enabled, day, night, isNight }));
  }
});

test("content script defaults to warm by day and dark by night, and survives load failures", async () => {
  const day = content(); await settled(); assert.equal(day.palette(), "warm");
  const night = content({ night: true }); await settled(); assert.equal(night.palette(), "dark");
  const broken = content({ loadFails: true }); await settled(); assert.equal(broken.palette(), "warm");
  const bogus = content({ stored: { day: "neon" } }); await settled(); assert.equal(bogus.palette(), "off");
});

test("content script follows the Mac's appearance live", async () => {
  const s = content({ stored: { day: "off", night: "warm" } }); await settled();
  assert.equal(s.palette(), "off");
  s.setNight(true); assert.equal(s.palette(), "warm");
  s.setNight(false); assert.equal(s.palette(), "off");
});

test("content script applies sync changes live and ignores other changes", async () => {
  const s = content(); await settled();
  s.change({ day: { oldValue: "warm", newValue: "dark" } }); assert.equal(s.palette(), "dark");
  s.change({ enabled: { newValue: false } }); assert.equal(s.palette(), "off");
  s.change({ enabled: { newValue: true } }, "local"); assert.equal(s.palette(), "off");
  s.change({ other: { newValue: 1 } }); assert.equal(s.palette(), "off");
  s.change({ enabled: { newValue: true } }); assert.equal(s.palette(), "dark");
  s.change({ day: { oldValue: "dark" } }); assert.equal(s.palette(), "warm", "a removed key falls back to its default");
});

test("popup shows the saved state, marks now, and themes itself", async () => {
  const s = popup({ night: true, stored: { night: "warm" } });
  assert.equal(s.ids["#enabled"].disabled, true); assert.equal(s.ids["#times"].disabled, true);
  await settled();
  assert.equal(s.ids["#enabled"].attributes["aria-checked"], "true");
  assert.equal(s.ids["#times"].disabled, false);
  assert.equal(s.selected("day"), "warm"); assert.equal(s.selected("night"), "warm");
  assert.equal(s.ids["#now-night"].hidden, false); assert.equal(s.ids["#now-day"].hidden, true);
  assert.equal(s.root.dataset.palette, "warm"); assert.equal(s.ids["#caption"].textContent, "Now: Night · Warm paper");
  s.setNight(false);
  assert.equal(s.ids["#now-day"].hidden, false); assert.equal(s.ids["#caption"].textContent, "Now: Day · Warm paper");
});

test("popup saves each choice and the master switch", async () => {
  const s = popup(); await settled();
  await s.choose("day", "off");
  assert.equal(s.selected("day"), "off"); assert.equal(s.root.off, true); assert.equal(s.root.dataset.palette, "warm");
  assert.match(s.ids["#caption"].textContent, /Day · Off/);
  await s.choose("night", "warm");
  await s.clickMaster();
  assert.equal(s.ids["#enabled"].attributes["aria-checked"], "false"); assert.equal(s.ids["#times"].disabled, true);
  assert.equal(s.ids["#caption"].textContent, "E-ink is off");
  assert.deepEqual(s.writes, [{ day: "off" }, { night: "warm" }, { enabled: false }]);
});

test("popup keeps Day and Night disabled while E-ink is saved off", async () => {
  const s = popup({ stored: { enabled: false } }); await settled();
  assert.equal(s.ids["#enabled"].disabled, false); assert.equal(s.ids["#times"].disabled, true);
});

test("popup reverts the choice and says so when saving fails", async () => {
  const s = popup({ saveFails: true }); await settled();
  await s.choose("day", "dark");
  assert.equal(s.selected("day"), "warm");
  assert.match(s.ids["#status"].textContent, /Could not save/);
});

test("popup stays disabled when the settings cannot be loaded", async () => {
  const s = popup({ loadFails: true }); await settled();
  assert.equal(s.ids["#enabled"].disabled, true); assert.equal(s.ids["#times"].disabled, true);
  assert.match(s.ids["#status"].textContent, /Could not load/);
});
