# Wallpaper Meta-Search

One search box, every wallpaper source. Type a query and get inline results
from the wallpaper sites that let a browser ask them, plus one-click links to
the ones that don't. No server, no account, no tracking — it's a static site.

## Live demo

Enable GitHub Pages on this repo (Settings → Pages → Deploy from branch,
`main`, `/ (root)`) and it runs at
`https://<your-username>.github.io/wallpaper-meta-search/`.

Or just open `index.html` in a browser — it works from a local file too.

## What it searches

| Source | How | Notes |
|---|---|---|
| Danbooru | Direct API, inline | Works with no setup — Danbooru sends `Access-Control-Allow-Origin: *` |
| Safebooru | Via CORS proxy, inline | No CORS header, so it goes through the proxy |
| Wallhaven | Via CORS proxy, inline | Free API, no key. No CORS header, so it goes through the proxy |
| AlphaCoders | Via CORS proxy, inline | Needs a free API key (your account → API), entered in Settings and stored only in your browser |
| Wallpapers.com, WallpaperAccess, WallpaperCave, Zerochan, Gelbooru, Google Images | Linked out | No usable open API — one click opens that site's own search for the same query |

## Why some sources need a proxy

A web page can only fetch from a site that explicitly allows it (CORS).
Danbooru allows it; Wallhaven, Safebooru and AlphaCoders don't, so those
requests go through a public CORS proxy (default:
`api.allorigins.win`). Public proxies go down or get slow — if a proxied
source comes back empty, try another proxy URL in Settings, or use the site
links. If you'd rather not trust a public proxy at all, run the optional
local one:

```sh
node proxy/server.mjs   # Node 18+, no dependencies
```

then set the proxy in Settings to `http://localhost:8787/?url=`.
The local proxy only forwards requests to the three APIs above — don't
expose it to the internet.

## Filters

- **Min. resolution** — filters results client-side (Wallhaven also filters
  server-side). 3440×1440 is there for ultrawide monitors.
- **Safe / SFW only** — Wallhaven `purity=100`, Danbooru `rating:safe`.

## Project layout

- `index.html` — the page
- `app.js` — search logic and source adapters (add a source here)
- `style.css` — styling
- `proxy/server.mjs` — optional local CORS proxy

## Adding a source

If a site has a JSON API, add an adapter to `SOURCES` in `app.js` returning
`[{ thumb, full, page, width, height, source }]` and a checkbox in
`index.html`. If it has no API, add it to `SITE_LINKS` instead.
