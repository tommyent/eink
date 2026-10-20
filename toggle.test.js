const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const settled = () => new Promise(resolve => setImmediate(resolve));

function storage({ stored = {}, loadFails = false, saveFails = false } = {}) {
  const listeners = [], writes = [];
  return { listeners, writes, sync: {
    get: async () => { if (loadFails) throw new Error("Load failed"); return stored; },
    set: async value => { if (saveFails) throw new Error("Quota exceeded"); writes.push({ ...value }); }
  }, onChanged: { addListener(listener) { listeners.push(listener); } } };
}

function content(options) {
  const attributes = new Set();
  const chromeStorage = storage(options);
  vm.runInNewContext(fs.readFileSync(`${__dirname}/content.js`, "utf8"), {
    document: { documentElement: { toggleAttribute(name, on) { on ? attributes.add(name) : attributes.delete(name); } } },
    chrome: { storage: chromeStorage }
  });
  return { on: () => attributes.has("data-eink"),
    change: (changes, area = "sync") => chromeStorage.listeners.forEach(listener => listener(changes, area)) };
}

function popup(options) {
  const ids = Object.fromEntries(["#enabled", "#status"].map(id => [id, { checked: false, disabled: true, textContent: "", handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; } }]));
  const chromeStorage = storage(options);
  vm.runInNewContext(fs.readFileSync(`${__dirname}/popup.js`, "utf8"), {
    document: { querySelector: selector => ids[selector] }, chrome: { storage: chromeStorage }
  });
  return { toggle: ids["#enabled"], status: ids["#status"], writes: chromeStorage.writes };
}

test("content script turns the look on by default and follows the saved setting", async () => {
  const fresh = content(); await settled(); assert.equal(fresh.on(), true);
  const off = content({ stored: { enabled: false } }); await settled(); assert.equal(off.on(), false);
  const broken = content({ loadFails: true }); await settled(); assert.equal(broken.on(), true);
});

test("content script applies sync changes live and ignores other changes", async () => {
  const s = content(); await settled();
  s.change({ enabled: { newValue: false } }); assert.equal(s.on(), false);
  s.change({ enabled: { newValue: true } }, "local"); assert.equal(s.on(), false);
  s.change({ other: { newValue: 1 } }); assert.equal(s.on(), false);
  s.change({ enabled: { newValue: true } }); assert.equal(s.on(), true);
});

test("popup shows the saved state and saves changes", async () => {
  const s = popup({ stored: { enabled: false } });
  assert.equal(s.toggle.disabled, true);
  await settled();
  assert.equal(s.toggle.disabled, false); assert.equal(s.toggle.checked, false);
  s.toggle.checked = true; await s.toggle.handlers.change();
  assert.deepEqual(s.writes, [{ enabled: true }]);
});

test("popup reverts the checkbox and says so when saving fails", async () => {
  const s = popup({ saveFails: true }); await settled();
  assert.equal(s.toggle.checked, true);
  s.toggle.checked = false; await s.toggle.handlers.change();
  assert.equal(s.toggle.checked, true);
  assert.match(s.status.textContent, /Could not save/);
});

test("popup stays disabled when the setting cannot be loaded", async () => {
  const s = popup({ loadFails: true }); await settled();
  assert.equal(s.toggle.disabled, true);
  assert.match(s.status.textContent, /Could not load/);
});
