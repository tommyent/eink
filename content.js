// eink.css is always injected but only applies while <html> carries data-eink="warm|dark" (the top
// page) or data-eink-frame (a frame inside an inverted page).
const defaults = { mode: "auto", palette: "dark" };
const settings = { ...defaults };
const night = matchMedia("(prefers-color-scheme: dark)");
const root = document.documentElement;
// The filter goes on the top page only: it already covers every frame drawn inside it.
const isTop = window === window.top;

function apply(values = {}) {
  for (const key in defaults) if (key in values) settings[key] = values[key] ?? defaults[key];
  // Auto: e-ink only while the Mac is in dark mode; macOS Auto flips that at sunset.
  const active = settings.mode === "on" || (settings.mode === "auto" && night.matches);
  const palette = settings.palette === "warm" ? "warm" : "dark";
  if (!isTop) root.toggleAttribute("data-eink-frame", active && palette === "dark");
  else if (active) root.setAttribute("data-eink", palette);
  else root.removeAttribute("data-eink");
}

// A site that is dark anyway needs other filters (eink.css). Read the first opaque background
// behind the middle of the page; computed styles ignore our own filter.
function detectSiteTheme() {
  if (!isTop) return;
  let rgba;
  for (let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); el; el = el.parentElement) {
    rgba = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number);
    if (rgba && (rgba[3] ?? 1) > 0.5) break;
    rgba = null;
  }
  if (!rgba) return;
  const dark = 0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2] < 100;
  root.toggleAttribute("data-site-dark", dark);
  chrome.storage.local.set({ gmailDark: dark }).catch(() => {});
}

chrome.storage.sync.get(Object.keys(defaults)).then(apply, () => apply());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") apply(Object.fromEntries(Object.entries(changes).map(([key, { newValue }]) => [key, newValue])));
});
night.addEventListener("change", () => apply());
// Pages paint well after load; check again once they have, and when the tab comes back.
addEventListener("load", () => { detectSiteTheme(); setTimeout(detectSiteTheme, 2500); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) detectSiteTheme(); });
