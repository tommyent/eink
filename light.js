// Gives each site its light design before the e-ink filters apply, so every site looks the way
// Gmail does. bg.js registers it in the page's own world at document_start, so the site's scripts
// see the patched APIs, while content.js in its isolated world still sees the Mac's real appearance.
(() => {
  // Valid, idempotent stand-ins: rewriting them again changes nothing.
  const NEVER = "(width < 0px)", ALWAYS = "(width >= 0px)";
  const scheme = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;
  const mentions = text => typeof text === "string" && /prefers-color-scheme/i.test(text);
  const lighten = text => text.replace(scheme, (_, value) => value.toLowerCase() === "dark" ? NEVER : ALWAYS);

  const matchMedia = window.matchMedia;
  window.matchMedia = function (query) { return matchMedia.call(this, mentions(query) ? lighten(query) : query); };

  // CSS-in-JS and constructed sheets add rules after load: rewrite the text on the way in.
  for (const [proto, name] of [[CSSStyleSheet.prototype, "insertRule"], [CSSGroupingRule.prototype, "insertRule"],
    [CSSStyleSheet.prototype, "replace"], [CSSStyleSheet.prototype, "replaceSync"]]) {
    const original = proto[name];
    proto[name] = function (text, ...rest) { return original.call(this, mentions(text) ? lighten(text) : text, ...rest); };
  }

  const scanned = new WeakSet();
  function walk(rules) {
    for (const rule of rules) {
      if (rule.media && mentions(rule.media.mediaText)) rule.media.mediaText = lighten(rule.media.mediaText);
      if (rule.styleSheet) scan(rule.styleSheet);
      else if (rule.cssRules) walk(rule.cssRules);
    }
  }
  function scan(sheet) {
    if (!sheet || scanned.has(sheet)) return;
    scanned.add(sheet);
    let rules;
    try { rules = sheet.cssRules; } catch { return copy(sheet); }
    walk(rules);
  }

  // A cross-origin sheet without CORS can't be read here: content.js fetches its text through the
  // extension, and a rewritten copy replaces it in place.
  const pending = new Map();
  let ids = 0;
  function copy(sheet) {
    const link = sheet.ownerNode;
    if (!(link instanceof HTMLLinkElement)) return;
    pending.set(++ids, link);
    document.dispatchEvent(new CustomEvent("eink-light-fetch", { detail: JSON.stringify({ id: ids, url: link.href }) }));
  }
  const absolute = (url, base) => { try { return new URL(url, base).href; } catch { return url; } };
  document.addEventListener("eink-light-css", event => {
    let id, text;
    try { ({ id, text } = JSON.parse(event.detail)); } catch { return; }
    const link = pending.get(id);
    pending.delete(id);
    if (!link || !mentions(text)) return;
    // The copy lives in the page, so its relative URLs must stay relative to the original sheet.
    const css = lighten(text)
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, url) => /^(data|blob):|^#/i.test(url) ? match : `url("${absolute(url, link.href)}")`)
      .replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, url) => `@import "${absolute(url, link.href)}"`);
    link.after(Object.assign(document.createElement("style"), { textContent: css }));
    if (link.sheet) link.sheet.disabled = true;
  });

  // New <link>, <style> and <source> elements, changed media attributes, and style text changes.
  const styleObserver = new MutationObserver(records => {
    for (const { target } of records) {
      const style = target.nodeType === 3 ? target.parentNode : target;
      if (style?.localName === "style") scan(style.sheet);
    }
  });
  function visit(node) {
    if (node.nodeType !== 1) return;
    const found = node.matches("link, style, source") ? [node] : [];
    if (node.firstElementChild) found.push(...node.querySelectorAll("link, style, source"));
    for (const el of found) {
      const media = el.getAttribute("media");
      if (mentions(media)) el.setAttribute("media", lighten(media));
      if (el.localName === "style") {
        scan(el.sheet);
        styleObserver.observe(el, { childList: true, characterData: true, subtree: true });
      } else if (el.localName === "link" && /\bstylesheet\b/i.test(el.rel)) {
        scan(el.sheet);
        el.addEventListener("load", () => scan(el.sheet));
      }
    }
  }
  const options = { childList: true, subtree: true, attributes: true, attributeFilter: ["media"] };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") visit(record.target);
      else record.addedNodes.forEach(visit);
    }
  });
  observer.observe(document, options);
  // The observer doesn't see into shadow roots, so watch each one as it is made.
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (...args) {
    const root = attachShadow.apply(this, args);
    observer.observe(root, options);
    return root;
  };
  const rescan = () => { for (const sheet of document.styleSheets) scan(sheet); };
  document.addEventListener("DOMContentLoaded", rescan);
  addEventListener("load", rescan);
})();
