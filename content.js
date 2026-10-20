// eink.css is always injected but only applies while <html data-eink> is set.
function apply(enabled) {
  document.documentElement.toggleAttribute("data-eink", enabled !== false);
}

chrome.storage.sync.get("enabled").then(({ enabled }) => apply(enabled), () => apply(true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.enabled) apply(changes.enabled.newValue);
});
