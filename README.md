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
| WallpaperCave | HTML search page via proxy chain, inline | Works via local proxy (40 items); via public proxies it flips between working and failing in bursts — see below |
| Zerochan | HTML search page via proxy chain, inline | Works via local proxy (38 items); via public proxies Zerochan's bot-block ("Crawlers are not permitted") 503s corsfix in bursts — see below |
| WallpaperAccess | Link only | Cloudflare 403s every fetch, direct and via proxy |
| Gelbooru | Link only | Its API returns 401 anonymously — needs an account API key |
| Google Images | Link only | No free search API |

## Why some sources need a proxy

A web page can only fetch from a site that explicitly allows it (CORS).
Danbooru allows it; the rest don't, so those requests go through a proxy
chain, in order:

1. **Local proxy** (`proxy/server.mjs`, port 8787) — only when the page is
   served over http (localhost). Started automatically by `start.sh` /
   `start.bat`. This is the reliable path: every source works through it,
   including Zerochan and WallpaperCave. If it's not running, an amber
   banner under the search box says so — start the proxy and reload.
2. **Your own Cloudflare Worker** (`worker/`) — paste its URL in Settings.
   Free tier is 100k requests/day; see `worker/README.md` for the three
   deploy paths (one-click button, dashboard paste, `wrangler deploy`).
   This is the reliable path when using GitHub Pages, where the local proxy
   can't be reached (an https page can't fetch `http://localhost`).
3. **A custom proxy URL** from Settings, if you enter one.
4. **Public fallbacks** (corsfix, allorigins, cors.lol) — tried last. The
   status line under each search tells you which path actually worked,
   e.g. `wallhaven: 24 found (via local proxy)`.

### Public-proxy reliability (tested 2026-11-15, evening)

The public proxies are flaky *per host*, and they flip between working and
failing over minutes — a source that failed one minute can work the next:

- **corsfix** — reliable for Wallhaven, Safebooru, Wallpapers.com and
  AlphaCoders (5/5 rounds). But it 503s WallpaperCave's pages and Zerochan
  in bursts: Zerochan's 503 is its own bot-block ("Crawlers are not
  permitted") aimed at corsfix's datacenter IP; WallpaperCave's is a plain
  503 with an empty body. The chain retries each proxy once (1.5 s later),
  which often lands on a good burst.
- **allorigins** — slow (7–20 s per request) and mostly 502/522 for these
  hosts. It does serve WallpaperCave *category* pages (200 in ~7 s), so
  the WallpaperCave adapter falls back to guessing the category URL
  (`/<query-slug>-wallpapers`) when the search page can't be fetched.
  HTML fetches allow 20 s for this reason; JSON fetches stay at 8 s.
- **cors.lol** — 429 rate-limited on every host right now; kept last in the
  chain in case it recovers.
- **Zerochan via public proxies is currently not reliably possible** — every
  public proxy gets its bot-block in bursts. Use the local proxy or the
  Worker for Zerochan (the Worker is untested against the block — its
  Cloudflare egress IPs may be blocked too).

Why a failed source shows "proxy unreachable" instead of the real error:
when a public proxy returns an error status, the browser only reports it as
"Failed to fetch" if that error response lacks CORS headers (allorigins'
error pages do). The chain error then contains "Failed to fetch" and the UI
shortens it to "proxy unreachable". Hover the red pill for the full
per-proxy errors.

## Filters

- **Min. resolution** — 1920×1080+, 2560×1440+, 3440×1440+ (ultrawide).
  Danbooru filters server-side; Safebooru paginates until it has enough.
  Sites that don't show a resolution are never hidden by the filter. When
  the filter hides matches, the status line says how many (Danbooru's count
  is exact for the whole database; Safebooru's is "of N checked").
- **Content** — three modes, default **Safe only**:
  - *Safe only*: Danbooru `rating:safe`, Wallhaven `purity=100` (sfw).
  - *Mixed (safe + suggestive, no explicit)*: Danbooru
    `rating:safe,questionable`, Wallhaven `purity=110` (sfw + sketchy).
    Safebooru is a safe-only site, so it returns its normal results in both
    modes. Zerochan, AlphaCoders, Wallpapers.com and WallpaperCave have no
    purity filter — in Mixed mode they return whatever their public search
    page shows (verified 2026-11-15: "code geass swimsuit" returned 58
    Zerochan items, "code geass bikini" returned 14 AlphaCoders and 30
    Wallpapers.com items).
  - *NSFW only*: Danbooru `rating:explicit`, Wallhaven `purity=001`.
    Verified counts for "code geass" (2026-11-15):
    | Source | NSFW mode, anonymous | Evidence |
    |---|---|---|
    | Danbooru | ✅ Works, no key — 1,788 explicit posts, 209 at 1920×1080+ | counts endpoint + posts call, all returned posts rated `e` |
    | Wallhaven | ❌ Needs an API key — anonymous `purity=001` returns 0 results for every query (even "anime" and an empty query); the docs say "NSFW wallpapers are blocked to guests". Paste a key in Settings (free, from your Wallhaven account → API, stored only in this browser) and NSFW search works; without one the status pill says "needs API key" instead of showing 0. **The key path is untested** — no key was available when this was built. |
    | Safebooru | Safe-only site — returns nothing in NSFW mode (all 100 "code geass" posts rated `general`); the pill says "no NSFW here" |
    | Zerochan, AlphaCoders, Wallpapers.com, WallpaperCave | No purity filter — NSFW mode changes nothing; they return whatever their public search page shows |
  - Verified counts for "code geass": Danbooru safe 8,176 vs mixed 10,656
    vs explicit 1,788 posts; Wallhaven purity 100: 375 vs 110: 454 results
    (001 anonymous: 0).
- **Booru queries** — comma separates tags: `code geass, lelouch`.

## Sorting

The Order dropdown next to Min. resolution re-sorts the already-fetched
results instantly — no re-search:

- **Best first** (default) — by community popularity. The signal per
  source, verified live 2026-11-15 for "code geass":
  | Source | Signal | Sample |
  |---|---|---|
  | Danbooru | `score` (upvotes − downvotes) | median 17, max 207 over 100 posts |
  | Wallhaven | `favorites` (users who saved it, not passive views) | median 12, max 44 over 24 results |
  | Safebooru | none — its `score` field is null for ~88% of posts and 1 for the rest, so it carries no ranking information |
  | Wallpapers.com, WallpaperCave, AlphaCoders, Zerochan | none — their search pages show no popularity number |
  The scale problem: Danbooru scores and Wallhaven favorites run on
  different scales (207 vs 44 at the top for the same query), so raw
  numbers aren't compared across sources. Instead each item is ranked by
  log10(1 + score), normalised by the best log-score within its own
  source's fetched set — each source's best item reads as 1.0, so the top
  of the list mixes the best of every source instead of burying the
  smaller-voting community. Ties break by raw score, then by size.
  Items with no signal (Safebooru, the scraped sites, and anything with
  a score of 0) sort after all scored items, in arrival order.
- **Largest first** — pixel area, largest first.
- **Newest first** — Danbooru and Wallhaven items carry their upload date;
  newest dated items first, then items with no date (Safebooru's API returns
  no upload date, and the scraped sources — Wallpapers.com, WallpaperCave,
  AlphaCoders, Zerochan — show no date on their search pages, so those
  always land at the end here, in the order they arrived).
- **Source order (most relevant)** — the order the sources returned them,
  i.e. each source's own relevance order, as fetched.

## Results

The grid is a masonry collage: every image keeps its original aspect ratio
(no 16:9 cropping) and is shown at full resolution, lazy-loaded, with the
layout space reserved from its known dimensions so the page doesn't jump as
images arrive. If a full image fails to load (hotlink protection, dead file),
the card falls back to its smaller thumbnail instead of breaking. The page
is fluid full-width — no fixed container — so on a wide monitor the masonry
just adds more ~300px columns instead of leaving empty margins.

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
- Public-proxy failures (v3): the three HTML scrapers only ever worked
  through the local proxy; via public proxies they failed in bursts
  (corsfix 503s WallpaperCave and Zerochan's bot-block; allorigins is slow
  and mostly 502/522). Fixes: each proxy candidate is retried once after
  1.5 s, HTML fetches get a 20 s timeout, the WallpaperCave adapter falls
  back to guessing the category URL directly when the search page can't be
  fetched, and a banner under the search box now says plainly when the
  local proxy isn't running (it used to hide inside collapsed Settings).
- The "(via X)" status label could name the wrong proxy: the last proxy
  used was kept in a shared global while the sources run in parallel, so
  e.g. Danbooru (direct, no proxy) could show "(via corsfix)". Each fetch
  now returns its own `via`, carried with that source's results.
- Failure pills hid the real cause: any "Failed to fetch" was shortened to
  "proxy unreachable", so a 503, a 429 and a dead local proxy all looked
  identical. The pill now shows the HTTP status when the chain knows one.
- Broken images (v4): many cards showed no image at all — just the two
  buttons on a black box. The constructed "full image" URLs were checked
  live and are correct (Wallpapers.com `/images/hd/` and AlphaCoders
  prefix-stripped originals: 40/40 and 29/29 HTTP 200), so the failures
  were load failures, not bad URLs — a search pulls ~150–250 MB of
  full-resolution images at once (one AlphaCoders PNG is 26 MB), and the
  v3 fallback listener attached after `innerHTML` could miss a fast
  failure entirely. Fixes: every item now carries an ordered fallback
  list (`alts` — smaller versions of the same image from the same source,
  e.g. Danbooru large/preview, Safebooru sample/preview, Wallpapers.com
  thumbnail, Zerochan 240 thumb; AlphaCoders also tries the `.png`
  variant when the original was guessed as `.jpg` from a `.webp` thumb);
  the card `<img>` calls `imgFallback(this)` inline via `onerror`, so no
  failure can slip past the listener; the failed URL gets one delayed retry
  (CDNs 503 in bursts under bulk load — two AlphaCoders thumbs 503'd in one
  check and 200'd in the next); a fallback that loads retargets the
  card's "Full image" links to the working URL; when every URL for an
  item fails, the card is removed from the grid (and the result total
  updated) instead of sitting there empty. Items with unknown size
  (Wallpapers.com, AlphaCoders) now reserve a 4:3 box instead of
  collapsing to just buttons, and images send no Referer
  (`referrerpolicy="no-referrer"`) to dodge hotlink blocks.

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
