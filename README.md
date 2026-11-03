# deck-remote

A phone remote control for **Google Slides or PDF decks open in Chrome**.

**Docs, live demo and connect helper:** https://diegoforni.github.io/deck-remote/

The tool runs on the computer that shows the deck. It drives the Chrome tab
over the DevTools protocol and serves a mobile web app on your Wi‑Fi (QR code
in the terminal). The phone gives you:

- **Next / Back buttons** that control the actual Chrome tab (real key events,
  so presenter view, transitions and embedded video all behave normally).
- **A talk timer** that starts on your *first press of Next* and keeps
  counting (with a reset button). It survives page reloads on the phone.
- **1–7 words describing the current slide**, and **1 word describing the
  next slide** — generated automatically by OCR from the largest text on each
  slide, so you always know what's coming without looking at the big screen.
- **Live sync**: the deck is polled continuously (perceptual screenshot
  hashing + the PDF viewer's `#page=` URL), so if you advance from the laptop
  keyboard or a USB clicker, the phone follows instantly.

```
Computer (deck in Chrome)          Phone (same Wi‑Fi)
┌───────────────────────┐          ┌──────────────────┐
│ Chrome ← keys (CDP)   │◀── WS ──▶│ Next / Back      │
│ screenshots + OCR     │          │ timer, keywords  │
└───────────────────────┘          └──────────────────┘
```

## Requirements

- macOS or Linux on the presenting computer (the installer needs internet once)
- Chrome or Chromium (installed by you; the tool finds it, or `--chrome-path`)
- A phone on the same network (Wi‑Fi / hotspot)

## Install (one line)

After copying/scp'ing this folder to the presenting machine:

```bash
bash install.sh
```

That's it — it installs Node.js LTS via nvm if missing (no sudo), (re)installs
dependencies cleanly (safe even if you scp'd `node_modules` from another
OS/arch — native modules are platform-specific), verifies everything loads,
and pre-caches the OCR language model so the first real run works offline.
Re-running it is always safe.

To copy the project over (no `node_modules` needed, they're reinstalled):

```bash
scp -r deck-remote/ diegoforni@desktop:            # or scp the tarball below
```

## Quick start

```bash
./deck-remote --url ~/talks/my-deck.pdf           # PDF: a path opens it automatically
./deck-remote --url docs.google.com              # or pick a tab by URL substring
```

Then:

1. The tool opens its own Chromium window (a dedicated profile under
   `~/deck-remote-chrome-profile`). Open your deck **in that window**:
   - **Google Slides**: sign into Google once in that window, open your deck,
     and press `Ctrl+F5` (⌘F5 on Mac) to enter presentation mode.
   - **PDF**: just open the file (`file://…` or a download works).
2. In the terminal, scan the printed **QR code** with your phone.
3. deck-remote does **one automatic pass** through the deck (it flips through
   every slide, screenshots and OCRs them, then returns to slide 1). Keep the
   deck in presentation mode and don't touch the mouse during this pass.
4. Present. Put Chrome in fullscreen (`F11`) for a clean look. The phone's
   timer starts the first time you press **Next**.

### Attaching to your existing Chrome instead

If you want to control a tab in your normal Chrome window (keeping your
logins), quit Chrome completely and relaunch it with a debug port:

```bash
google-chrome --remote-debugging-port=9222          # Linux
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222   # macOS
```

Notes:

- Chrome 136+ **blocks** the debug port on the *default* profile. Either use
  `--user-data-dir=$HOME/chrome-debug-profile` (sign in once there), or use
  the tool's own window as described above.
- If the debug port is already open, deck-remote attaches and never launches
  its own window. Use `--list-tabs` to see what it can see, and `--url
  <substring>` to pick a tab non-interactively.

## How slide descriptions are made

During the setup pass every slide is screenshotted and OCR'd. Words whose
rendered height is markedly larger than the page median are treated as the
slide title; the first 7 title words describe the current slide, and the first
non-stopword is the 1‑word hint for the next slide. If OCR finds no text
(image-only slide), the phone just shows the slide number. OCR runs in the
background, prioritising the slide currently on screen, so you can start
presenting before every description is ready.

## Options

```
--url <url|path|substring>  A local file path (pdf/html) or absolute URL is opened
                            automatically; otherwise a substring matched against
                            open tab URLs (e.g. docs.google.com)
--port <n>            HTTP/WS port for the phone UI (default 8675)
--debug-port <n>      Chrome DevTools port (default 9222)
--pin <code>          Require a PIN before a phone can connect (recommended on shared Wi‑Fi)
--chrome-path <path>  Chrome/Chromium binary to launch (default: auto-detect, incl. macOS paths)
--user-data-dir <dir> Profile dir for the launched Chrome (default ~/deck-remote-chrome-profile)
--list-tabs           Print open tabs and exit
```

## Troubleshooting

- **“Multiple tabs open”** — pass `--url docs.google.com` (or part of the
  deck's URL/file name).
- **Keywords are empty for a while** — OCR is still running; slide 1 is always
  processed first.
- **Descriptions look wrong** — OCR reads the biggest text; heavily graphical
  slides or unusual fonts degrade quality. The slide number always shows.
- **Phone can't connect** — both devices must be on the same network; some
  corporate Wi‑Fi isolates clients (use a phone hotspot instead). On Linux,
  open the port: `sudo ufw allow 8675/tcp`.
- **Google Slides in edit mode** — put the deck in presentation mode first
  (`Ctrl+F5`), then restart deck-remote; the tool warns about this itself.
- **Two identical slides in a row** — screenshot tracking can't tell them
  apart; the count/next-hint may be off by one until you move again.
- **Deck changed** — restart deck-remote to re-index.

## Security

The remote is unauthenticated on your LAN by default. On shared/venue Wi‑Fi
run it with `--pin 1234`. Anyone with the URL (and pin) can control the deck —
that is the point, but choose your network accordingly.

## Website

The [GitHub Pages site](https://diegoforni.github.io/deck-remote/) hosts the
docs, an interactive demo of the phone UI, and a **connect helper**: type your
computer's `ip:port` (handy on Tailscale/ZeroTier networks) and get a tappable
link + QR for the remote. The remote itself is always served by your computer
— browsers block `ws://` WebSockets from HTTPS pages, so a web-hosted page
can't (and shouldn't) talk to your LAN server.

## Testing

```bash
npm test    # end-to-end: local HTML deck (Google-Slides-equivalent pipeline)
```
The e2e test drives a real (headless) Chromium: indexes a 6‑slide deck, OCRs
keywords, presses next/back, verifies the timer, and checks that navigation
done directly in the tab (laptop keyboard) syncs to the phone client. The PDF
section is skipped automatically on builds whose headless mode lacks the PDF
viewer — PDF mode relies on Chrome's desktop PDF viewer (`#page=` navigation)
and was designed/tested against desktop Chrome.

## Limitations

- One deck at a time; the deck must respond to ←/→ (Google Slides present
  mode, the Chrome PDF viewer and common HTML decks do).
- Fragments in Google Slides decks are indexed as separate steps (each
  fragment gets its own description), which usually is what you want.
- Animated overlays that appear on mouse movement may briefly confuse slide
  detection; the phone self-corrects on the next poll (~1 s).
