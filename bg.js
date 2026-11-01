// Keeps light.js registered while e-ink can be on, fetches the cross-origin stylesheets it can't
// read, and passes each top page's dark-site answer to its frames.
const LIGHT = "light";
const MAX_CSS = 2_000_000;

// In the page's own world at document_start, in every frame, except on sites switched off.
// Pages already open keep what they loaded with until they reload.
async function registerLight() {
  const { mode = "auto", off = [] } = await chrome.storage.sync.get(["mode", "off"]);
  await chrome.scripting.unregisterContentScripts({ ids: [LIGHT] }).catch(() => {});
  if (mode !== "on" && mode !== "auto") return;
  // A host that can't make a valid match pattern would fail the whole registration. Host names may
  // hold underscores, and location.hostname gives an IPv6 address in brackets, as patterns take it.
  const hosts = Array.isArray(off) ? off.filter(host => typeof host === "string" && /^([a-z0-9_.-]+|\[[0-9a-f:.]+\])$/i.test(host)) : [];
  await chrome.scripting.registerContentScripts([{ id: LIGHT, matches: ["<all_urls>"], excludeMatches: hosts.map(host => `*://${host}/*`),
    js: ["light.js"], css: ["light.css"], runAt: "document_start", allFrames: true, matchOriginAsFallback: true, world: "MAIN" }]);
}
// One registration at a time, in order, so quick changes can't race each other.
let queue = Promise.resolve();
const sync = () => (queue = queue.then(registerLight).catch(error => console.error("E-ink could not register light.js", error)));
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.storage.onChanged.addListener((changes, area) => { if (area === "sync" && ("mode" in changes || "off" in changes)) sync(); });

// Hosts on this computer or its network: loopback, private, shared (CGNAT, as Tailscale uses) and
// link-local addresses, and local names. A public name that points at one can't be told apart here.
const LOCAL = /^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[(::1?\]|::ffff:|f[cd]|fe[89ab]))|^[^.[]+$|\.(localhost|local|internal|lan|home\.arpa)$/i;
const isLocal = url => { try { return LOCAL.test(new URL(url).hostname); } catch { return false; } };

// Trust boundary: the page chooses the URL (content.js checks it is a stylesheet the page links
// to and can't read). Fetch it without cookies, a referrer or redirects, and from this computer or
// its network only for a page there itself; accept only CSS up to 2 MB, and hand back only CSS
// that has dark-mode rules to rewrite, so a page can't read other data through the extension.
async function fetchCSS(url, page) {
  if (!/^https?:\/\//i.test(url) || (isLocal(url) && !isLocal(page))) return "";
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
  if (!response.ok || !/^text\/css\s*(;|$)/i.test(response.headers.get("content-type") ?? "")
    || Number(response.headers.get("content-length")) > MAX_CSS) return "";
  // Without a Content-Length, stop reading past the cap: leaving the loop cancels the download.
  const decoder = new TextDecoder();
  let text = "", size = 0;
  for await (const chunk of response.body) {
    if ((size += chunk.length) > MAX_CSS) return "";
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return /prefers-color-scheme/i.test(text) ? text : "";
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab) return;
  // Frames follow the top page of their own tab: a frame asks it as it starts, and only the top
  // page tells all its tab's frames when its answer changes.
  if (message === "eink-top") {
    chrome.tabs.sendMessage(sender.tab.id, "eink-ping", { frameId: 0 }).then(answer => reply(answer?.siteDark), () => reply());
    return true;
  }
  if (typeof message?.siteDark === "boolean" && sender.frameId === 0) {
    chrome.tabs.sendMessage(sender.tab.id, { siteDark: message.siteDark }).catch(() => {});
    return;
  }
  if (typeof message?.fetchCSS !== "string") return;
  fetchCSS(message.fetchCSS, sender.url).then(reply, () => reply(""));
  return true;
});
