const toggle = document.querySelector("#enabled");
const status = document.querySelector("#status");

chrome.storage.sync.get("enabled").then(({ enabled }) => {
  toggle.checked = enabled !== false;
  toggle.disabled = false;
}, () => {
  status.textContent = "Could not load the setting.";
});

toggle.addEventListener("change", async () => {
  try {
    await chrome.storage.sync.set({ enabled: toggle.checked });
    status.textContent = "";
  } catch {
    toggle.checked = !toggle.checked;
    status.textContent = "Could not save the setting.";
  }
});
