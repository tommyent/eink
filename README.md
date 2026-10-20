# Gmail E-ink

Chrome Manifest V3 extension that gives Gmail (`https://mail.google.com/*`) an e-ink look: grayscale, no accent colours, low glare. The palette follows the Mac's appearance through `prefers-color-scheme`:

- **Warm e-ink** (light mode): warm paper page (about `#f3e5cc`) with dark-gray text.
- **Dark e-ink** (dark mode): dark-gray page (about `#262626`, not black) with soft light-gray text. Photos and avatars are inverted back so they look normal, slightly dimmed.

The palette switches live when macOS changes appearance (for example at sunset with Auto), with no reload. The toolbar popup has one on/off toggle, saved in Chrome sync storage and applied live to open Gmail tabs. Off leaves Gmail exactly as it is without the extension.

The source directory is the unpacked extension. No dependencies or build step are required.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click Load unpacked and choose this folder.
3. Open or switch to a Gmail tab. Use the toolbar button to turn the look on or off.

## How it works

`eink.css` puts one CSS `filter` on the `<html>` element: `grayscale` plus a little `sepia` and `brightness` for warm paper, or `invert(0.85) grayscale(1)` for dark. It changes no Gmail colours one by one, so it doesn't depend on Gmail's obfuscated class names, and grayscale keeps Gmail's own light/dark contrast: unread bold rows, selected rows, focus rings, links and compose stay distinct. `content.js` sets `data-eink` on `<html>` when the toggle is on; the CSS applies only while that attribute is there.

## Fragile parts

- It assumes Gmail's default light theme. With Gmail's own dark theme or a dark background theme turned on, the dark palette inverts it to light. Use Gmail's default theme with this extension.
- In the dark palette, `img`, `video`, `picture` and `canvas` are inverted back to show photos. Gmail draws many icons as sprites on a transparent `img` whose `src` contains `cleardot`; the `img:not([src*="cleardot"])` rule keeps those inverted with the page. If Gmail changes that sprite pattern, some icons may show dark on dark. Icons drawn as inline SVG or CSS backgrounds are unaffected.
- Images set as CSS backgrounds (rare in Gmail, common in some email bodies) stay inverted in the dark palette.
- A full-page filter costs some GPU work on every repaint (inferred, not measured on real Gmail).

## Checks

```sh
node --test toggle.test.js
npm i --no-save playwright-core && node test/e2e.js
```

`toggle.test.js` checks the content script and popup with simulated Chrome APIs. `test/e2e.js` starts headless Google Chrome, loads this folder through the DevTools `Extensions.loadUnpacked` command (branded Chrome ignores `--load-extension`), serves `test/fixture.html` (a Gmail-like inbox, open message and compose window) at a `mail.google.com` URL, and:

- switches `prefers-color-scheme` on the open page and screenshots both palettes to `test/screenshots/`;
- samples rendered colours of Gmail's text, link and row colours and checks WCAG AA (4.5:1) for each pair, and that no accent colour is left;
- turns the toggle off in the popup and checks the Gmail tab returns to normal live and after reload.

The fixture approximates Gmail's colours and markup; it does not establish compatibility with live Gmail.
