const defaults = { mode: "auto", palette: "dark" };
const settings = { ...defaults };
const night = matchMedia("(prefers-color-scheme: dark)");
const controls = document.querySelector("#controls");
const paletteRow = document.querySelector("#palette-row");
const radios = document.querySelectorAll("input[type=radio]");
const caption = document.querySelector("#caption");
const status = document.querySelector("#status");
const names = { warm: "Warm paper", dark: "Dark e-ink" };
let loaded = false;

function render() {
  const active = settings.mode === "on" || (settings.mode === "auto" && night.matches);
  controls.disabled = !loaded;
  paletteRow.disabled = settings.mode === "off";
  for (const radio of radios) radio.checked = settings[radio.name] === radio.value;
  document.documentElement.dataset.palette = settings.palette;
  document.documentElement.toggleAttribute("data-off", !active);
  const when = settings.mode === "auto" ? (night.matches ? "Night (Auto)" : "Day (Auto)") : settings.mode === "on" ? "On" : "Off";
  caption.textContent = `Now: ${when} · ${active ? names[settings.palette] : "Gmail as usual"}`;
}

async function save(key, value) {
  const previous = settings[key];
  settings[key] = value;
  render();
  try {
    await chrome.storage.sync.set({ [key]: value });
    status.textContent = "";
  } catch {
    settings[key] = previous;
    render();
    status.textContent = "Could not save the setting.";
  }
}

chrome.storage.sync.get(Object.keys(defaults)).then(values => {
  for (const key in defaults) if (values[key] !== undefined) settings[key] = values[key];
  loaded = true;
  render();
}, () => {
  status.textContent = "Could not load the settings.";
});
// Set by content.js on the last Gmail page it checked.
chrome.storage.local.get("gmailDark").then(({ gmailDark }) => {
  document.querySelector("#theme-note").hidden = !gmailDark;
}, () => {});

render();
// Native radios give each row arrow-key selection and clickable labels.
controls.addEventListener("change", event => save(event.target.name, event.target.value));
night.addEventListener("change", render);
