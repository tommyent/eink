// Keeps light.js registered while e-ink can be on, and fetches the cross-origin stylesheets it can't read.
const LIGHT = "light";
const MAX_CSS = 2_000_000;

// In the page's own world at document_start, in every frame, except on sites switched off.
// Pages already open keep what they loaded with until they reload.
async function registerLight() {
  const { mode = "auto", off = [] } = await chrome.storage.sync.get(["mode", "off"]);
  await chrome.scripting.unregisterContentScripts({ ids: [LIGHT] }).catch(() => {});
  if (mode !== "on" && mode !== "auto") return;
  // A host that can't make a valid match pattern would fail the whole registration.
  const hosts = Array.isArray(off) ? off.filter(host => typeof host === "string" && /^[a-z0-9.-]+$/i.test(host)) : [];
  await chrome.scripting.registerContentScripts([{ id: LIGHT, matches: ["<all_urls>"], excludeMatches: hosts.map(host => `*://${host}/*`),
    js: ["light.js"], css: ["light.css"], runAt: "document_start", allFrames: true, matchOriginAsFallback: true, world: "MAIN" }]);
}
// One registration at a time, in order, so quick changes can't race each other.
let queue = Promise.resolve();
const sync = () => (queue = queue.then(registerLight).catch(error => console.error("E-ink could not register light.js", error)));
chrome.runtime.onInstalled.addListener(() => {
  sync();
  // Written by the Gmail-only version; the dark-site answer is now kept per site.
  chrome.storage.local.remove("gmailDark").catch(() => {});
});
chrome.runtime.onStartup.addListener(sync);
chrome.storage.onChanged.addListener((changes, area) => { if (area === "sync" && ("mode" in changes || "off" in changes)) sync(); });

// Trust boundary: the page chooses the URL (content.js checks it is a stylesheet the page links
// to and can't read). Fetch it without cookies or a referrer, accept only CSS, and hand back only
// CSS that has dark-mode rules to rewrite, so a page can't read other data through the extension.
async function fetchCSS(url) {
  if (!/^https?:\/\//i.test(url)) return "";
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok || !/^text\/css\s*(;|$)/i.test(response.headers.get("content-type") ?? "")
    || Number(response.headers.get("content-length")) > MAX_CSS) return "";
  const text = await response.text();
  return text.length <= MAX_CSS && /prefers-color-scheme/i.test(text) ? text : "";
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (typeof message?.fetchCSS !== "string" || !sender.tab) return;
  fetchCSS(message.fetchCSS).then(reply, () => reply(""));
  return true;
});
