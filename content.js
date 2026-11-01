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

// Whether the site is dark anyway. The answer a top page gets when it loads is remembered per site
// and appearance, so the next visit starts right. Frames follow their own top page live, through
// bg.js, not the remembered answer, which another tab of the site may have written.
let siteDark = false;
const darkKey = () => `dark:${site}:${night.matches ? "dark" : "light"}`;
const cache = {}, reads = {}, checked = new Set();
const readCache = key => reads[key] ??= chrome.storage.local.get(key).then(values => { cache[key] = values[key]; }, () => {});

// The page's own changes to <html> and <body> make us check again (below). Our own writes go
// through here, which drops the records they leave, so they can't set that off.
let observer = null;
const quietly = write => { write(); observer?.takeRecords(); };

function apply(values = {}) {
  for (const key in defaults) if (key in values) settings[key] = values[key] ?? defaults[key];
  // Auto: e-ink only while the Mac is in dark mode; macOS Auto flips that at sunset.
  const off = Array.isArray(settings.off) ? settings.off : [];
  const active = (settings.mode === "on" || (settings.mode === "auto" && night.matches)) && !off.includes(site);
  const palette = settings.palette === "warm" ? "warm" : "dark";
  quietly(() => {
    if (!isTop) {
      // Dark inverts a light page, Warm inverts a dark one.
      root.toggleAttribute("data-eink-frame", active && (palette === "dark") !== siteDark);
      return;
    }
    if (!active) root.removeAttribute("data-eink");
    else if (root.getAttribute("data-eink") !== palette) root.setAttribute("data-eink", palette);
    root.toggleAttribute("data-site-dark", siteDark);
  });
}

// A top page tells its frames whenever its answer changes; bg.js passes it to every frame in the tab.
function decide(dark) {
  const changed = dark !== siteDark;
  siteDark = dark;
  apply();
  if (changed && isTop) chrome.runtime.sendMessage({ siteDark }).catch(() => {});
}

// A top page starts from the remembered answer, unless it has already checked for itself.
function recall() {
  if (!isTop) return;
  const key = darkKey();
  readCache(key).then(() => {
    if (key !== darkKey() || checked.has(key) || typeof cache[key] !== "boolean") return;
    decide(cache[key]);
  });
}

// Computed colours come as rgb(), oklch(), oklab(), color() and more: a 1 x 1 canvas turns any of
// them into sRGB and alpha (0 to 255). One it can't read stays transparent.
let paint;
function rgba(colour) {
  paint ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = "transparent";
  paint.fillStyle = colour;
  paint.fillRect(0, 0, 1, 1);
  return paint.getImageData(0, 0, 1, 1).data;
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
      const [r, g, b, a] = rgba(getComputedStyle(el).backgroundColor);
      if (a > 128) { lightness = 0.2126 * r + 0.7152 * g + 0.0722 * b; break; }
    }
    if (lightness < 100) dark++;
  }
  return dark > 6;
}

// remember: this is how the site looks as a page loads, worth keeping for the next visit. A check
// after an in-page route change or a theme switch only decides the page as it is now: a dark
// photo viewer over a light feed mustn't make the site start dark next time. The check 2.5 s
// after load counts only if the page is still on the address it loaded with.
const loadedAt = location.href;
function detectSiteTheme(remember = true) {
  // Chrome's PDF viewer is dark around a white page: invert it like any light page.
  if (!isTop || document.contentType === "application/pdf") return;
  // Read the page's own colours: our white canvas and filters all key off data-eink.
  const palette = root.getAttribute("data-eink");
  let dark;
  quietly(() => {
    root.removeAttribute("data-eink");
    try { dark = pageIsDark(); } finally { if (palette) root.setAttribute("data-eink", palette); }
  });
  const key = darkKey();
  checked.add(key);
  decide(dark);
  if (!remember || location.href !== loadedAt) return;
  readCache(key).then(() => {
    if (cache[key] === dark) return;
    cache[key] = dark;
    chrome.storage.local.set({ [key]: dark }).catch(() => {});
  });
}

// Single-page apps such as X change routes and switch their own theme without reloading, and may
// rewrite <html>'s attributes: check again shortly after, at most every half second.
let pending = 0;
function recheck() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = 0;
    if (document.readyState !== "loading") detectSiteTheme(false);
    apply();
  }, 500);
}

chrome.storage.sync.get(Object.keys(defaults)).then(apply, () => apply());
recall();
// Another tab's answer never reaches this one: each tab of a site may be on a different view.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") apply(Object.fromEntries(Object.entries(changes).map(([key, { newValue }]) => [key, newValue])));
});
night.addEventListener("change", () => { apply(); recall(); });
// The popup asks the top page which site it is and whether it is dark anyway; so does bg.js for a
// frame. Chrome's own pages don't answer, because extensions can't run there. A frame starts from
// its top page's answer and then follows what the top page tells it; an answer to its question
// that comes after a newer one from the top page is dropped.
let told = false;
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (isTop && message === "eink-ping") reply({ site, siteDark });
  if (!isTop && typeof message?.siteDark === "boolean") { told = true; decide(message.siteDark); }
});
if (!isTop) chrome.runtime.sendMessage("eink-top").then(dark => { if (!told && typeof dark === "boolean") decide(dark); }, () => {});
// Pages paint over time; check once the DOM is in, at load, once more after that, and when the tab comes back.
document.addEventListener("DOMContentLoaded", () => detectSiteTheme());
addEventListener("load", () => { detectSiteTheme(); setTimeout(() => detectSiteTheme(), 2500); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) detectSiteTheme(false); });
// And whenever the page changes itself: in-page navigation (pushState, replaceState, back and
// forward), any attribute on <html> or <body>, where sites switch their theme (class, style,
// data-bs-theme, data-color-mode and others), a new <body> (Turbo swaps one in), and our own
// attributes, if the page strips them.
const watchBody = () => { if (document.body) observer.observe(document.body, { attributes: true }); };
observer = new MutationObserver(() => { watchBody(); recheck(); });
observer.observe(root, { attributes: true, childList: true });
watchBody();
window.navigation?.addEventListener("currententrychange", recheck);
addEventListener("popstate", recheck);

// light.js runs in the page's own world and can't reach the extension, so it asks here for the
// cross-origin stylesheets it can't read. Trust boundary: the page can send this event too, so
// relay only a stylesheet this document links to and can't read, and only a few per page.
let relayed = 0;
const unreadable = sheet => { if (!sheet) return false; try { sheet.cssRules; return false; } catch { return true; } };
document.addEventListener("eink-light-fetch", event => {
  let id, url;
  try { ({ id, url } = JSON.parse(event.detail)); } catch { return; }
  const answer = text => document.dispatchEvent(new CustomEvent("eink-light-css", { detail: JSON.stringify({ id, text }) }));
  const link = [...document.querySelectorAll("link[rel~=stylesheet i]")].find(link => link.href === url);
  if (!link || !unreadable(link.sheet) || relayed++ >= 20) return answer("");
  chrome.runtime.sendMessage({ fetchCSS: url }).then(text => answer(typeof text === "string" ? text : ""), () => answer(""));
});
