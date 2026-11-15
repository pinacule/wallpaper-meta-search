# Wallpaper Meta-Search

One search box, every wallpaper source. Type a query and get inline results
from seven sites in one grid, plus one-click links to the rest. No server, no
account, no tracking — it's a static site.

## Live demo

Enable GitHub Pages on this repo (Settings → Pages → Deploy from branch,
`main`, `/ (root)`) and it runs at
`https://<your-username>.github.io/wallpaper-meta-search/`.

Or run it locally — the reliable way, since the local proxy makes every
source work:

```sh
./start.sh    # Linux / macOS — starts the proxy and the app, opens your browser
start.bat     # Windows — same thing, double-click it
```

Then open `http://localhost:8090/`. Or just open `index.html` in a browser
(Danbooru works; the proxied sources need the proxy running).

## What it searches

| Source | How | Status (verified live 2026-11-15) |
|---|---|---|
| Danbooru | Direct API, inline | Works with no setup — Danbooru sends `Access-Control-Allow-Origin: *` |
| Wallhaven | API via proxy chain, inline | Works — best source; see "Why some sources need a proxy" |
| Safebooru | API via proxy chain, inline | Works |
| AlphaCoders | HTML search page via proxy chain, inline | Works, no API key — the documented API (`api2.0/get.php`) is dead (nginx 404 on every variant) |
| Wallpapers.com | HTML search page via proxy chain, inline | Works — 40 items per search (no resolution shown) |
| WallpaperCave | HTML search page via proxy chain, inline | Works — 40 items, real resolutions |
| Zerochan | HTML search page via proxy chain, inline | Works — 38 items, real resolutions (goes through the proxy to dodge its browser check) |
| WallpaperAccess | Link only | Cloudflare 403s every fetch, direct and via proxy |
| Gelbooru | Link only | Its API returns 401 anonymously — needs an account API key |
| Google Images | Link only | No free search API |

## Why some sources need a proxy

A web page can only fetch from a site that explicitly allows it (CORS).
Danbooru allows it; the rest don't, so those requests go through a proxy
chain, in order:

1. **Local proxy** (`proxy/server.mjs`, port 8787) — only when the page is
   served over http (localhost). Started automatically by `start.sh` /
   `start.bat`. This is the reliable path.
2. **Your own Cloudflare Worker** (`worker/`) — paste its URL in Settings.
   Free tier is 100k requests/day; see `worker/README.md` for the three
   deploy paths (one-click button, dashboard paste, `wrangler deploy`).
   This is the reliable path when using GitHub Pages, where the local proxy
   can't be reached (an https page can't fetch `http://localhost`).
3. **A custom proxy URL** from Settings, if you enter one.
4. **Public fallbacks** (corsfix, allorigins, cors.lol) — tried last. Tested
   2026-11-15: most were down, rate-limited, or failing for these hosts, so
   don't rely on them. The status line under each search tells you which
   path actually worked, e.g. `wallhaven: 24 found (via local proxy)`.

## Filters

- **Min. resolution** — 1920×1080+, 2560×1440+, 3440×1440+ (ultrawide).
  Danbooru filters server-side; Safebooru paginates until it has enough.
  Sites that don't show a resolution are never hidden by the filter. When
  the filter hides matches, the status line says how many (Danbooru's count
  is exact for the whole database; Safebooru's is "of N checked").
- **Safe / SFW only** — Wallhaven `purity=100`, Danbooru `rating:safe`.
- **Booru queries** — comma separates tags: `code geass, lelouch`.

## Bugs fixed in this version

- Danbooru returned **0 results at default settings**: tags were joined with
  `+`, and `encodeURIComponent` turned it into `%2B`, so Danbooru read the
  whole thing as one nonexistent tag. Tags are now space-joined.
- Min. resolution **"Any" returned 0 for every source**: the `"0"` option
  value parsed to `{w: 0, h: undefined}` and `height >= undefined` is always
  false. Fixed.
- The old code fetched only the 40 newest booru posts and filtered locally —
  the newest posts are mostly portrait phone art, so the filter could wipe
  the result. Boorus now paginate (up to 4×100) until 40 passing results.
- No fetch timeout: a hung proxy hung the UI on "Searching…" forever. The
  proxy chain now times out each attempt after 8 s.

## Project layout

- `index.html` / `style.css` — the page
- `app.js` — search logic, Danbooru/Safebooru/Wallhaven adapters, rendering
- `adapters-extra.js` — HTML-scraping adapters (Wallpapers.com,
  WallpaperCave, AlphaCoders, Zerochan); loads after `app.js` and
  self-registers
- `proxy-client.js` — the proxy fallback chain
- `proxy/server.mjs` — optional local CORS proxy (Node 18+, no deps)
- `worker/` — optional Cloudflare Worker proxy + deploy README
- `wrangler.toml`, `start.sh`, `start.bat` — Worker config and one-click start

## Adding a source

If a site has a JSON API, add an adapter to `SOURCES` in `app.js` returning
`[{ thumb, full, page, width, height, source }]`. If it has no API, add a
scraper to `adapters-extra.js` the same way (use `ProxyClient.fetchText`),
or add it to `SITE_LINKS` for link-only.
