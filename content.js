// eink.css is always injected but only applies while <html> carries data-eink="warm|dark" (the top
// page) or data-eink-frame (a frame inside an inverted page).
// off: the sites the popup's This site switch turned off, by host name.
const defaults = { mode: "auto", palette: "dark", off: [] };
const settings = { ...defaults };
const night = matchMedia("(prefers-color-scheme: dark)");
const root = document.documentElement;
// The filter goes on the top page only: it already covers every frame drawn inside it.
const isTop = window === window.top;
const hostOf = origin => { try { return new URL(origin).hostname; } catch { return ""; } };
// A frame belongs to the top page's site, which a cross-origin frame can only learn from ancestorOrigins.
const ancestors = location.ancestorOrigins ?? [];
const site = isTop ? location.hostname : hostOf(ancestors[ancestors.length - 1]);

// Whether the site is dark anyway, remembered per site and appearance so the next visit starts right.
let siteDark = false;
const darkKey = () => `dark:${site}:${night.matches ? "dark" : "light"}`;
const cache = {}, reads = {}, checked = new Set();
const readCache = key => reads[key] ??= chrome.storage.local.get(key).then(values => { cache[key] = values[key]; }, () => {});

function apply(values = {}) {
  for (const key in defaults) if (key in values) settings[key] = values[key] ?? defaults[key];
  // Auto: e-ink only while the Mac is in dark mode; macOS Auto flips that at sunset.
  const off = Array.isArray(settings.off) ? settings.off : [];
  const active = (settings.mode === "on" || (settings.mode === "auto" && night.matches)) && !off.includes(site);
  const palette = settings.palette === "warm" ? "warm" : "dark";
  if (!isTop) {
    // Dark inverts a light page, Warm inverts a dark one.
    root.toggleAttribute("data-eink-frame", active && (palette === "dark") !== siteDark);
    return;
  }
  if (active) root.setAttribute("data-eink", palette);
  else root.removeAttribute("data-eink");
  root.toggleAttribute("data-site-dark", siteDark);
}

// Starts from the remembered answer, unless this page has already checked for itself.
function recall() {
  const key = darkKey();
  readCache(key).then(() => {
    if (key !== darkKey() || checked.has(key) || typeof cache[key] !== "boolean") return;
    siteDark = cache[key];
    apply();
  });
}

// light.js gives most sites their light design; a dark theme saved on the site itself stays dark
// and needs other filters (eink.css). Computed styles ignore our filter.
function pageIsDark() {
  const scheme = document.querySelector('meta[name="color-scheme"]')?.content.trim().toLowerCase();
  if (scheme === "dark" || scheme === "only dark") return true;
  if (root.classList.contains("dark") || document.body?.classList.contains("dark")) return true;
  // Vote on a 4 x 3 grid with the first opaque background behind each point, or Chrome's white
  // canvas if there is none, so one dark player or banner can't decide for the whole page.
  let dark = 0;
  for (let row = 1; row <= 3; row++) for (let col = 1; col <= 4; col++) {
    let lightness = 255;
    for (let el = document.elementFromPoint(innerWidth * col / 5, innerHeight * row / 4); el; el = el.parentElement) {
      const rgba = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (rgba && (rgba[3] ?? 1) > 0.5) { lightness = 0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2]; break; }
    }
    if (lightness < 100) dark++;
  }
  return dark > 6;
}

function detectSiteTheme() {
  // Chrome's PDF viewer is dark around a white page: invert it like any light page.
  if (!isTop || document.contentType === "application/pdf") return;
  // Read the page's own colours: our white canvas and filters all key off data-eink.
  const palette = root.getAttribute("data-eink");
  root.removeAttribute("data-eink");
  const dark = pageIsDark();
  if (palette) root.setAttribute("data-eink", palette);
  const key = darkKey();
  checked.add(key);
  siteDark = dark;
  apply();
  readCache(key).then(() => {
    if (cache[key] === dark) return;
    cache[key] = dark;
    chrome.storage.local.set({ [key]: dark }).catch(() => {});
  });
}

chrome.storage.sync.get(Object.keys(defaults)).then(apply, () => apply());
recall();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") apply(Object.fromEntries(Object.entries(changes).map(([key, { newValue }]) => [key, newValue])));
  // Frames follow the top page's answer, and every tab of a site follows the latest one.
  const key = darkKey();
  if (area === "local" && key in changes && !checked.has(key) && typeof changes[key].newValue === "boolean") {
    cache[key] = siteDark = changes[key].newValue;
    apply();
  }
});
night.addEventListener("change", () => { apply(); recall(); });
// The popup asks the page which site it is and whether it is dark anyway. Chrome's own pages
// don't answer, because extensions can't run there.
if (isTop) chrome.runtime.onMessage.addListener((message, sender, reply) => { if (message === "eink-ping") reply({ site, siteDark }); });
// Pages paint over time; check once the DOM is in, at load, once more after that, and when the tab comes back.
document.addEventListener("DOMContentLoaded", detectSiteTheme);
addEventListener("load", () => { detectSiteTheme(); setTimeout(detectSiteTheme, 2500); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) detectSiteTheme(); });
