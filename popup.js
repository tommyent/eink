const defaults = { enabled: true, day: "warm", night: "dark" };
const settings = { ...defaults };
const night = matchMedia("(prefers-color-scheme: dark)");
const master = document.querySelector("#enabled");
const times = document.querySelector("#times");
const radios = document.querySelectorAll("input[type=radio]");
const caption = document.querySelector("#caption");
const status = document.querySelector("#status");
const names = { warm: "Warm paper", dark: "Dark e-ink", off: "Off, Gmail as usual" };
let loaded = false;

function render() {
  const now = night.matches ? "night" : "day";
  const palette = settings.enabled ? settings[now] : "off";
  master.setAttribute("aria-checked", String(settings.enabled));
  master.disabled = !loaded;
  times.disabled = !loaded || !settings.enabled;
  for (const radio of radios) radio.checked = settings[radio.name] === radio.value;
  document.querySelector("#now-day").hidden = now !== "day";
  document.querySelector("#now-night").hidden = now !== "night";
  // The panel wears the palette Gmail has now; when that is off it follows the Mac.
  document.documentElement.dataset.palette = palette === "off" ? (night.matches ? "dark" : "warm") : palette;
  document.documentElement.toggleAttribute("data-off", palette === "off");
  caption.textContent = settings.enabled ? `Now: ${now === "day" ? "Day" : "Night"} · ${names[palette]}` : "E-ink is off";
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
  settings.enabled = settings.enabled !== false;
  loaded = true;
  render();
}, () => {
  status.textContent = "Could not load the settings.";
});

render();
// A <button> already toggles on click, Space and Enter, and its <label for> forwards clicks;
// native radios give each row arrow-key selection and clickable labels.
master.addEventListener("click", () => save("enabled", !settings.enabled));
times.addEventListener("change", event => save(event.target.name, event.target.value));
night.addEventListener("change", render);
