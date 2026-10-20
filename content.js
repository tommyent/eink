// eink.css is always injected but only applies while <html data-eink="warm|dark"> is set.
const defaults = { enabled: true, day: "warm", night: "dark" };
const settings = { ...defaults };
const night = matchMedia("(prefers-color-scheme: dark)");

function apply(values = {}) {
  for (const key in defaults) if (key in values) settings[key] = values[key] ?? defaults[key];
  const palette = settings.enabled !== false && settings[night.matches ? "night" : "day"];
  const root = document.documentElement;
  if (palette === "warm" || palette === "dark") root.setAttribute("data-eink", palette);
  else root.removeAttribute("data-eink");
}

chrome.storage.sync.get(Object.keys(defaults)).then(apply, () => apply());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") apply(Object.fromEntries(Object.entries(changes).map(([key, { newValue }]) => [key, newValue])));
});
// Mac light mode is day, dark mode is night; macOS Auto flips this at sunset.
night.addEventListener("change", () => apply());
