// off: the sites switched off with This site, by host name.
const defaults = { mode: "auto", palette: "dark", off: [] };
const settings = { ...defaults };
const night = matchMedia("(prefers-color-scheme: dark)");
const controls = document.querySelector("#controls");
const paletteRow = document.querySelector("#palette-row");
const siteRow = document.querySelector("#site-row");
const siteName = document.querySelector("#site-name");
const themeNote = document.querySelector("#theme-note");
const radios = document.querySelectorAll("input[type=radio]");
const caption = document.querySelector("#caption");
const status = document.querySelector("#status");
const names = { warm: "Warm paper", dark: "Dark e-ink" };
let loaded = false;
// What the page in this tab says about its site: undefined while asking, null when it can't answer.
let page;

const offList = () => Array.isArray(settings.off) ? settings.off : [];

function render() {
  const siteOff = Boolean(page?.site) && offList().includes(page.site);
  const active = (settings.mode === "on" || (settings.mode === "auto" && night.matches)) && !siteOff;
  controls.disabled = !loaded;
  paletteRow.disabled = settings.mode === "off";
  siteRow.disabled = !page?.site;
  for (const radio of radios) {
    radio.checked = radio.name === "site" ? Boolean(page?.site) && radio.value === (siteOff ? "off" : "on") : settings[radio.name] === radio.value;
  }
  document.documentElement.dataset.palette = settings.palette;
  document.documentElement.toggleAttribute("data-off", !active);
  const when = settings.mode === "auto" ? (night.matches ? "Night (Auto)" : "Day (Auto)") : settings.mode === "on" ? "On" : "Off";
  caption.textContent = `Now: ${when} · ${active ? names[settings.palette] : siteOff ? "This site as usual" : "Sites as usual"}`;
  siteName.textContent = page === undefined ? "" : page === null ? "Chrome doesn't let extensions change this page, or it needs a reload."
    : page.site || "This page has no site name to switch.";
  themeNote.hidden = !page?.siteDark || siteOff;
}

// What sync storage holds, as far as the popup knows: a failed save goes back to it. Saves run one
// at a time, in order, so an older choice can't land after a newer one.
const stored = {};
let saving = Promise.resolve();
function save(key, value) {
  settings[key] = value;
  render();
  return saving = saving.then(() => chrome.storage.sync.set({ [key]: value })).then(() => {
    stored[key] = value;
    status.textContent = "";
  }, () => {
    // A newer choice of the same setting is on screen: its own save decides.
    if (settings[key] !== value) return;
    settings[key] = stored[key];
    render();
    status.textContent = "Could not save the setting.";
  });
}

chrome.storage.sync.get(Object.keys(defaults)).then(values => {
  for (const key in defaults) if (values[key] !== undefined) settings[key] = values[key];
  Object.assign(stored, settings);
  loaded = true;
  render();
}, () => {
  status.textContent = "Could not load the settings.";
});
// The page in this tab answers for its site. Chrome's own pages, the Web Store and tabs opened
// before E-ink was loaded don't answer.
chrome.tabs.query({ active: true, currentWindow: true })
  .then(([tab]) => chrome.tabs.sendMessage(tab.id, "eink-ping", { frameId: 0 }))
  .then(answer => { page = answer ?? null; render(); }, () => { page = null; render(); });

render();
// Native radios give each row arrow-key selection and clickable labels.
controls.addEventListener("change", ({ target: { name, value } }) => {
  if (name !== "site") return save(name, value);
  const others = offList().filter(host => host !== page.site);
  return save("off", value === "off" ? [...others, page.site] : others);
});
night.addEventListener("change", render);
