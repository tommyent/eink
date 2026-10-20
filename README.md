# Gmail E-ink

Chrome Manifest V3 extension that gives Gmail (`https://mail.google.com/*`) an e-ink look: grayscale, no accent colours, low glare. Two palettes:

- **Warm** paper page (about `#f3e5cc`) with dark-gray text.
- **Dark** gray page (about `#262626`, not black) with soft light-gray text. Photos and avatars are inverted back so they look normal, slightly dimmed.

The toolbar popup has an **E-ink** master switch and two rows, **Day** (Mac in light mode) and **Night** (Mac in dark mode), each set to Warm, Dark or Off. Defaults: on, Day = Warm, Night = Dark. Night = Warm or Day = Off (e-ink only at night) also work. A "now" marker shows which row applies at the moment. Gmail switches live when macOS changes appearance (for example at sunset with Auto), and when a setting changes, with no reload. Settings are saved in Chrome sync storage. Off leaves Gmail exactly as it is without the extension.

The source directory is the unpacked extension. No dependencies or build step are required.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click Load unpacked and choose this folder.
3. Open or switch to a Gmail tab. Use the toolbar button to choose the palettes.

## How it works

`eink.css` puts one CSS `filter` on the `<html>` element: `grayscale` plus a little `sepia` and `brightness` for warm paper, or `invert(0.85) grayscale(1)` for dark. It changes no Gmail colours one by one, so it doesn't depend on Gmail's obfuscated class names, and grayscale keeps Gmail's own light/dark contrast: unread bold rows, selected rows, focus rings, links and compose stay distinct. `content.js` reads the settings, checks `matchMedia("(prefers-color-scheme: dark)")` to pick the Day or Night choice, and sets `data-eink="warm"` or `"dark"` on `<html>` (or removes it for Off). The CSS applies only while that attribute is there.

The popup is a small e-ink panel in the palette Gmail has now (or the Mac's appearance when that is Off). The master switch is a `<button role="switch">` with `aria-checked`, so Space, Enter and its label all toggle it. Each Day/Night row is a `radiogroup` of native radio buttons styled as segments: arrow keys move the choice, labels are clickable, and both kinds of control show a focus ring. The rows are disabled and dimmed while E-ink is off.

## Fragile parts

- It assumes Gmail's default light theme. With Gmail's own dark theme or a dark background theme turned on, the Dark palette inverts it to light. Use Gmail's default theme with this extension.
- In the Dark palette, `img`, `video`, `picture` and `canvas` are inverted back to show photos. Gmail draws many icons as sprites on a transparent `img` whose `src` contains `cleardot`; the `img:not([src*="cleardot"])` rule keeps those inverted with the page. If Gmail changes that sprite pattern, some icons may show dark on dark. Icons drawn as inline SVG or CSS backgrounds are unaffected.
- Images set as CSS backgrounds (rare in Gmail, common in some email bodies) stay inverted in the Dark palette.
- A full-page filter costs some GPU work on every repaint (inferred, not measured on real Gmail).

## Checks

```sh
node --test toggle.test.js
npm i --no-save playwright-core && node test/e2e.js
```

`toggle.test.js` checks the content script and popup with simulated Chrome APIs and a simulated appearance: every combination of master switch, Day, Night and appearance (36 cases), live appearance changes, live setting changes, defaults, and save/load failures. `test/e2e.js` starts headless Google Chrome, loads this folder through the DevTools `Extensions.loadUnpacked` command (branded Chrome ignores `--load-extension`), serves `test/fixture.html` (a Gmail-like inbox, open message and compose window) at a `mail.google.com` URL, and:

- switches `prefers-color-scheme` on the open page and checks the defaults follow it live; screenshots both palettes and the popup in day, night and off states to `test/screenshots/`;
- samples rendered colours of Gmail's text, link and row colours and checks WCAG AA (4.5:1) for each pair and that no accent colour is left; checks the popup's text (4.5:1) and switch, segment outline and focus ring (3:1) in both palettes;
- drives the popup with arrow keys, label clicks and the master switch, checking each reaches the Gmail tab live, Day = Off with Night = Warm, and that all settings persist across reloads of Gmail and the popup.

The fixture approximates Gmail's colours and markup; it does not establish compatibility with live Gmail. Dimmed disabled rows in the off state are not contrast-checked (WCAG exempts inactive controls).
