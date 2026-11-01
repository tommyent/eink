# E-ink

Chrome Manifest V3 extension that gives every site an e-ink look: grayscale, no accent colours, low glare. It started as Gmail E-ink, and every site now looks the way Gmail did with it. Two palettes:

- **Warm** paper page (about `#f3e5cc`) with dark-gray text.
- **Dark** gray page (about `#262626`, not black) with soft light-gray text. Photos and avatars are inverted back so they look normal, slightly dimmed.

A site that has its own dark mode is shown in its light design first, and the palette then applies to that, so dark-mode sites look the same as the rest.

The toolbar popup has three controls:

- **E-ink**: On (always), Off (never) or Auto (only while the Mac is in dark mode, sites as usual by day). Default Auto.
- **Palette**: Warm or Dark, used whenever e-ink is active. Default Dark.
- **This site**: On or Off for the site in the current tab, shown by its host name (for example `github.com`). Default On.

A "Now:" line shows what applies at the moment, for example "Now: Night (Auto) · Dark e-ink", or "Now: Night (Auto) · This site as usual" on a site switched off. Pages switch live when a setting changes and, in Auto, when macOS changes appearance (for example at sunset with Auto appearance), with no reload. Settings, including the sites switched off, are saved in Chrome sync storage.

The source directory is the unpacked extension. No dependencies or build step are required.

## Install and update

1. Open `chrome://extensions` and turn on Developer mode.
2. Click Load unpacked and choose this folder.
3. Reload open tabs: a page that was open before the extension loaded doesn't have it until it reloads.

E-ink needs access to every site. Chrome's details page for it reads "Allow this extension to read and change all your data on websites you visit", with the choices On click, On specific sites and On all sites; the last is what E-ink expects, and the other two limit it to the sites you allow. A Web Store install would show the warning "Read and change all your data on all websites".

Updating from Gmail E-ink in the same folder: press Reload on the extension at `chrome://extensions`. In a headless Chrome 156 test with Developer mode on, the reload kept the extension on, with its settings and the new site access, without asking. Chrome's documentation says an update that adds a permission is disabled until the user accepts it; that is the case for Web Store updates, and if Chrome ever shows E-ink as off after a reload, turn it back on there. Keep Developer mode on: with it off, the same test showed Chrome turning the reloaded extension off ("Turn on developer mode to use this extension"). Loading a copy from another folder makes a separate extension with its own settings, so switch the other copy off to avoid two filters on one page.

After changing any file, press Reload on this extension at `chrome://extensions`, then reload open tabs. Chrome keeps running the old content script and CSS in a tab until that tab reloads, while the popup always loads its files fresh, so a new popup can end up writing settings that an old content script never reads.

## How it works

`eink.css` puts one CSS `filter` on the top page's `<html>` element: `grayscale` plus a little `sepia` and `brightness` for Warm, or `invert(0.85) grayscale(1)` for Dark. It changes no site's colours one by one, so it doesn't depend on any site's class names, and grayscale keeps each site's own light/dark contrast: bold unread rows, selected rows, focus rings and links stay distinct. `content.js` runs on every page and frame, reads the settings, checks `matchMedia("(prefers-color-scheme: dark)")` for Auto, and sets `data-eink="warm"` or `"dark"` on the top page's `<html>` (or removes it). The CSS applies only while that attribute is there.

- **Frames** get no filter of their own, because the top page's filter already covers what they draw. A frame inside an inverted page gets `data-eink-frame`, which only flips its photos back. Frames follow the top page's site for This site.
- **Pages with no background of their own** would show Chrome's white canvas, which the root filter doesn't reach, so the page gets a white background while e-ink is on.
- **Fullscreen content** is drawn outside the root filter, so it gets a filter of its own and stays black and white. A fullscreen player or video gets what photos and video look like on that page, so it keeps the same tones: gray under Dark (a little dimmed on a page E-ink inverts, full range on a page that is dark anyway, such as a streaming site's player page) and warm gray under Warm, and nothing inside it flips back. A fullscreen frame gets the page's own filter, because its content still flips its photos back, and a frame inside a fullscreen player gets `invert(1)` while the page is inverted, so it adds up to the same. When the whole page goes fullscreen (as on YouTube), the page filter simply stays. The filters are kept in `--eink-page` and `--eink-photo` on `<html>`.
- **Photos**: when the page is inverted, `img`, `video`, `picture` and `canvas` are inverted back, and so is any element drawn with an inline `background-image` `url()`, which is how X and other React Native for Web sites draw every photo (with an invisible `<img>` over it). Nothing inside an element that is already flipped back flips again. Gmail's own UI images stay inverted with the page: sprites on `cleardot.gif` and images under `/icons/mail/` (the wordmark).

**Light design first.** `light.js` runs in the page's own JavaScript world at `document_start`, in every frame, so the site's scripts see what it changes. It makes the page see light mode: `matchMedia` colour-scheme queries, the `@media` and `@import` rules of every stylesheet the page can read, rules added later through `insertRule`, `replace` and `replaceSync` (CSS-in-JS), and `media` attributes on `<link>`, `<style>` and `<picture>` sources, in new shadow roots too. A dark query becomes `(width < 0px)` and a light one `(width >= 0px)`, valid queries that never and always match. `light.css` sets `color-scheme: light`, which decides `light-dark()` colours and form controls. `content.js` runs in Chrome's isolated world for extensions, so it still sees the Mac's real appearance, and Auto keeps working.

`bg.js`, the service worker, registers `light.js` and `light.css` only while E-ink is On or Auto, leaves out the sites switched off, and registers again whenever either changes. A page already open keeps what it loaded with until it reloads.

A stylesheet from another origin without CORS can't be read by the page. `light.js` then asks `content.js`, which asks `bg.js` to fetch its text, and a rewritten copy replaces it in place. The page can send that request too, so this is a trust boundary: `content.js` passes on only a stylesheet the document links to and can't read, at most 20 per page, and `bg.js` fetches only `http(s)` URLs, without cookies or a referrer, accepts only `text/css` up to 2 MB, and returns only CSS with colour-scheme rules. That is the only network request E-ink makes.

**Sites that stay dark anyway**, such as a dark theme saved on the site itself, would turn light under the plain filters. `content.js` checks the page at DOMContentLoaded, at load and 2.5 s later: a `<meta name="color-scheme">` of `dark`, a `dark` class on `<html>` or `<body>`, or else a vote over twelve points on a grid, each reading the first opaque background behind it (computed styles ignore the filter, and `data-eink` is removed while it reads, so the white canvas doesn't count). If most are dark it sets `data-site-dark`: Dark then only removes colour, and Warm inverts the page to paper first. PDFs are skipped, because Chrome's viewer is dark around a white page. Single-page apps such as X change routes and switch their theme without reloading, so the page is checked again, at most every half second, after in-page navigation (`pushState`, back and forward) and whenever the classes or style on `<html>` or `<body>` change; if the page strips `data-eink`, it is put back. The answer a page gets as it loads is kept in `chrome.storage.local` per site and appearance, written only when it changes, so the next visit starts right; later answers (a dark photo viewer over a light feed, say) decide only the page as it is. Each tab decides for itself, and frames follow their top page.

The popup is a small e-ink panel in the chosen palette. Each control is a `radiogroup` of native radio buttons styled as segments, so arrow keys move the choice, labels are clickable, and the focused segment shows a ring. Palette is disabled and dimmed while E-ink is Off. The popup asks the page in the current tab for its host name and whether its own dark theme is on; a page that doesn't answer is one Chrome keeps extensions off, or one that needs a reload, and This site is disabled there with that reason.

## Pages Chrome blocks

Chrome doesn't let extensions change its own pages (`chrome://` settings, extensions and the new tab page), the Chrome Web Store, `view-source:` pages, top-level `data:` URLs or other extensions' pages, so those keep their own look. The PDF viewer is reached through the page around it. Local `file://` pages need "Allow access to file URLs" on the extension's details page (on by default for an unpacked extension), and Incognito windows need "Allow in Incognito".

## Known limits

- **A dark theme saved on the site itself** (an account setting such as YouTube's or Gmail's own dark theme, or a theme picked on the site and kept in its storage) can't be forced light. The dark-site check then gives Dark as grayscale only (close to the site's own black) and Warm as paper. Setting the site's own appearance to "system" or "device" lets the light design come through.
- **Switching off** (This site, or E-ink Off): the filter goes at once, but a page already open keeps its light design until it reloads, and then shows its own dark mode again.
- **Shadow DOM**: photos inside shadow roots stay inverted, because page CSS doesn't reach into them, and styles in declarative shadow DOM (`<template shadowrootmode>`) aren't rewritten to light.
- **Server-chosen themes**: a site that picks its theme on the server from the `Sec-CH-Prefers-Color-Scheme` request header stays dark and falls back to the dark-site check.
- **Images set as CSS backgrounds from a stylesheet** (not inline on the element), emoji and inline SVG stay inverted with the page under Dark; text inside an element whose inline background image is flipped back shows in that element's own colours; SVG icons in `<img>` are flipped back like photos, so a dark icon can show dark on dark. Canvas-based apps such as online document editors are flipped back too, so their canvas may stay bright (inferred).
- **Frames from another site inside a site switched off** still get the light design, because the switch goes by each frame's own host for `light.js`.
- **Copy-protected video** (Widevine, used by streaming sites): the filters apply to it, in headless Chrome on a Widevine test stream and on screen on Disney+ (reported by the owner).
- **The white background** for pages without one also covers the area below a short page that sets a background only on `<body>`: under Dark that strip is a few levels darker than the rest (`#262626` instead of `#2b2b2b` on the Gmail fixture).
- **The dark-site check** samples colours, so an unusual layout can still be read either way; the answer is remembered per site until a check disagrees.
- **The list of sites switched off** is one sync item, limited by Chrome to 8,192 bytes, roughly 300 host names; past that, the popup says it could not save the setting.
- **Cost**: a full-page filter keeps the GPU busier while scrolling or playing video (in a headless test, Chrome's GPU process used about twice the CPU time, with no dropped frames), and rewriting stylesheets took 3–54 ms of main-thread time per page load in the same test, most on the largest sites.

## Checks

```sh
node --test toggle.test.js
npm i --no-save playwright-core && node test/e2e.js
```

`toggle.test.js` checks the content script, `light.js`, `bg.js` and the popup with simulated Chrome APIs, appearance and page: every combination of mode, palette and appearance, live appearance and setting changes, defaults, invalid or old-format settings, frames, the This site list, the dark-site grid (including a light page with a dark player at the centre), meta and class signals, the PDF skip, the per-site cache, checking again after in-page navigation and page changes (throttled, and not remembered), putting a stripped attribute back, each tab deciding for itself, every form of the colour-scheme query and rewriting it twice, nested and imported rules, late rules and media attributes, the cross-origin copy, the relay's and the fetch's trust-boundary checks, the registration, and save/load failures.

`test/e2e.js` starts headless Google Chrome, loads this folder through the DevTools `Extensions.loadUnpacked` command (branded Chrome ignores `--load-extension`; `EXT=<folder>` loads another copy), and serves `test/fixture.html` (a Gmail-like inbox, open message and compose window) at a `mail.google.com` URL, plus a copy recoloured like Gmail's dark theme. The popup is opened as a tab, so a test-only script points it at the page under test. It:

- switches `prefers-color-scheme` on the open page and checks Auto follows it live; screenshots each state and the popup to `test/screenshots/`;
- samples rendered colours of Gmail's text, link and row colours and checks WCAG AA (4.5:1) for each pair and that no accent colour is left; checks the popup's text (4.5:1) and segment outlines and focus ring (3:1) in both palettes;
- drives the popup with arrow keys and label clicks, checks each change reaches Gmail live, that settings persist across reloads, that UI images stay inverted while photos flip back, and the dark-theme filters and popup note;
- serves small pages at `sites.test` in dark mode and checks that six ways of picking dark mode (`test/force.html`, with a stylesheet from another origin, `test/force-x.css`) all show the light design while Auto still turns on; that This site turns a page off and on live and stops `light.js` there; that `chrome://version` disables This site; that a saved dark theme (`test/saved-dark.html`) falls back to grayscale only; that a page with no background (`test/plain.html`) is dark gray, not white; and that six ways of going fullscreen (`test/fullscreen.html` and the embedded player `test/embed.html`: a player, the video itself, a frame the page makes fullscreen, a player with a frame in it, an embed making its own player fullscreen, and the whole page) are black and white in both palettes, on a light page and on one that is dark anyway, never in colour or a negative; that a fullscreen player keeps the tones its photo has in the page (within 6 levels); and that the page looks as before afterwards; and that a page built like X (`test/social.html`: photos drawn as inline backgrounds, an avatar inside a background banner, a photo viewer opened with `pushState` over a black backdrop, and a dark theme switched on late) shows every photo in gray, never a negative, is checked again on each change, gets `data-eink` back if it strips it, and isn't rewritten while idle.

The fixtures approximate real sites. The 2026-10-20 check on real Gmail (light theme) is described in the commit history; the 2026-10-31 build was compared on GitHub, MDN, Next.js docs, YouTube and BBC in headless Chrome, and none of it is repeated by these tests.
