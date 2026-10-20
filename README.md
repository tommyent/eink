# Gmail E-ink

Chrome Manifest V3 extension that gives Gmail (`https://mail.google.com/*`) an e-ink look: grayscale, no accent colours, low glare. Two palettes:

- **Warm** paper page (about `#f3e5cc`) with dark-gray text.
- **Dark** gray page (about `#262626`, not black) with soft light-gray text. Photos and avatars are inverted back so they look normal, slightly dimmed.

The toolbar popup has two controls:

- **E-ink**: On (always), Off (never) or Auto (only while the Mac is in dark mode, plain Gmail by day). Default Auto.
- **Palette**: Warm or Dark, used whenever e-ink is active. Default Dark.

A "Now:" line shows what applies at the moment, for example "Now: Night (Auto) · Dark e-ink". Gmail switches live when a setting changes and, in Auto, when macOS changes appearance (for example at sunset with Auto appearance), with no reload. Settings are saved in Chrome sync storage. Off leaves Gmail exactly as it is without the extension.

The source directory is the unpacked extension. No dependencies or build step are required.

## Install and update

1. Open `chrome://extensions` and turn on Developer mode.
2. Click Load unpacked and choose this folder.
3. Open or reload a Gmail tab. Use the toolbar button to choose the mode and palette.

After changing any file, press Reload on this extension at `chrome://extensions`, then reload open Gmail tabs. Chrome keeps running the old content script and CSS in a tab until that tab reloads, while the popup always loads its files fresh, so a new popup can end up writing settings that an old content script never reads.

## How it works

`eink.css` puts one CSS `filter` on the `<html>` element: `grayscale` plus a little `sepia` and `brightness` for Warm, or `invert(0.85) grayscale(1)` for Dark. It changes no Gmail colours one by one, so it doesn't depend on Gmail's obfuscated class names, and grayscale keeps Gmail's own light/dark contrast: unread bold rows, selected rows, focus rings, links and compose stay distinct. `content.js` reads the settings, checks `matchMedia("(prefers-color-scheme: dark)")` for Auto, and sets `data-eink="warm"` or `"dark"` on `<html>` (or removes it). The CSS applies only while that attribute is there.

Gmail's own dark theme (Settings > Themes) is already dark, so the plain filters would turn it light. `content.js` reads the first opaque background behind the middle of the page after load, and if it is dark it sets `data-gmail-dark`: Dark then only removes colour, and Warm inverts the page to paper first. The popup then says that Gmail's dark theme is on.

The popup is a small e-ink panel in the chosen palette. Each control is a `radiogroup` of native radio buttons styled as segments, so arrow keys move the choice, labels are clickable, and the focused segment shows a ring. Palette is disabled and dimmed while E-ink is Off.

## Fragile parts

- Gmail dark-theme detection samples a background colour. It was tested on a recoloured fixture and checked to report the light theme on real Gmail; it has not been tried with Gmail's real dark theme or photo themes, so the colours there are inferred. A theme with a photo background may be detected either way. The detected theme is shared through `chrome.storage.local`, so with two Gmail accounts on different themes the popup note reflects the last tab checked.
- When the page is inverted, `img`, `video`, `picture` and `canvas` are inverted back to show photos. Gmail's own UI images stay inverted with the page: sprites on `cleardot.gif` and images under `/icons/mail/` (the wordmark). If Gmail moves those, some icons may show dark on dark. Icons drawn as inline SVG or CSS backgrounds are unaffected.
- Images set as CSS backgrounds (rare in Gmail, common in some email bodies) stay inverted.
- A full-page filter costs some GPU work on every repaint (inferred, not measured).

## Checks

```sh
node --test toggle.test.js
npm i --no-save playwright-core && node test/e2e.js
```

`toggle.test.js` checks the content script and popup with simulated Chrome APIs, appearance and page: every combination of mode, palette and appearance, live appearance and setting changes, defaults, invalid or old-format settings, Gmail dark-theme detection, and save/load failures.

`test/e2e.js` starts headless Google Chrome, loads this folder through the DevTools `Extensions.loadUnpacked` command (branded Chrome ignores `--load-extension`), and serves `test/fixture.html` (a Gmail-like inbox, open message and compose window) at a `mail.google.com` URL, plus a copy recoloured like Gmail's dark theme. It:

- switches `prefers-color-scheme` on the open page and checks Auto follows it live; screenshots each state and the popup to `test/screenshots/`;
- samples rendered colours of Gmail's text, link and row colours and checks WCAG AA (4.5:1) for each pair and that no accent colour is left; checks the popup's text (4.5:1) and segment outlines and focus ring (3:1) in both palettes;
- drives the popup with arrow keys and label clicks, checks each change reaches Gmail live, that settings persist across reloads, that UI images stay inverted while photos flip back, and the dark-theme filters and popup note.

The fixture approximates Gmail's colours and markup. The 2026-10-20 check on real Gmail (light theme) is described in the commit history, not repeated by these tests.
