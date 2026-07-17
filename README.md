# LuxSync v3

A premium, dependency-free photo gallery that turns any public Google Drive folder into a
scrollable, previewable, downloadable client gallery. Pure static HTML/CSS/JS — no backend,
no build step.

## How it works

Client pastes a Drive folder link + a Drive API key into the setup screen. The page calls the
Drive API v3 `files.list` endpoint directly from the browser, renders a masonry contact-sheet
grid, and opens a full lightbox on click with keyboard/swipe navigation and download.

## Requirements

- The Drive folder must be shared as **Anyone with the link — Viewer**.
- A **Google Drive API key** (Drive API v3 enabled). This is entered per session in the browser
  and is never written to disk, cookies, or localStorage — it lives only in page memory and is
  gone on refresh.

### Getting an API key
1. [console.cloud.google.com](https://console.cloud.google.com/) → create/select a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → Credentials → Create Credentials → API key**.
4. (Recommended) Restrict the key to the Drive API and to your Zeabur domain under
   **API restrictions** / **Application restrictions → HTTP referrers**.

## Local dev

No build tooling required — it's one HTML file.

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

### Skip re-pasting your API key locally

The app has no backend and no build step, so there's no real environment-variable
mechanism — but you can get the same effect with a gitignored local config file:

```bash
cp config.example.js config.js
```

Edit `config.js` and set `window.LUXSYNC_API_KEY` to your key. `index.html` (and
`luxsync-v3.html`) load this file automatically and pre-fill the setup form's API
key field with it, so you don't have to find and paste the key every time during
local dev. `config.js` is in `.gitignore` and is never committed or deployed — it's
purely a local convenience. Clients using the deployed gallery still paste their
own key into the form as before (see "Known limitations" below).

## Deploy — GitHub → Zeabur

1. This repo is already on GitHub at
   [TheBooleanJulian/luxsync-v3](https://github.com/TheBooleanJulian/luxsync-v3). Push changes
   with:
   ```bash
   git add .
   git commit -m "..."
   git push origin main
   ```
2. In [Zeabur](https://zeabur.com): **New Project → Deploy from GitHub** → select this repo.
3. Zeabur auto-detects it as a static site (root `index.html`). In the service's
   **Variables** tab, add an environment variable named `LUXSYNC_API_KEY` set to your Drive
   API key.
   [zbpack.json](zbpack.json) at the repo root runs a build step that writes that value into
   `config.js` before the site is served, which pre-fills the setup form's API key field —
   the same mechanism used for [local dev](#skip-re-pasting-your-api-key-locally). Anyone
   else deploying their own copy of this repo sets their own `LUXSYNC_API_KEY` in their own
   Zeabur project; nothing about the key is shared between deployments.
4. Add a custom domain under the service's **Domains** tab if you want a branded link
   (e.g. `gallery.luxsync.app`) to hand to clients.

### Branch strategy (optional, matches the usual fleet pattern)

```
feature/* → dev → main
```
Point Zeabur's production service at `main`; spin up a second Zeabur service tracking `dev`
for a staging preview if you want to test layout changes before clients see them.

## Known limitations (v1)

- **API key is client-visible.** Fine for handing a link to a specific client; restrict the key
  by HTTP referrer so it only works from your deployed domain. Not meant to be a fully public
  self-serve product without a backend proxy.
- **"Download All" is sequential, not zipped.** Google's direct-download URLs don't return CORS
  headers, so an in-browser zip (fetch + JSZip) isn't reliable. Each photo downloads individually
  with a short delay between them instead.
- **No caching.** Every visit re-queries the Drive API live. Fine for typical gallery sizes;
  for very large folders (1000+ files) initial load will take a few seconds longer.

## Roadmap

A FastAPI backend (matching your usual stack):
- Keep the Drive API key server-side instead of in the browser.
- Serve a real zipped download by streaming image bytes through your own server.
- Give each client a slug/subdomain with cached thumbnails and custom branding.
- Add basic auth or an access-code gate per gallery.
