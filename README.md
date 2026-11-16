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
   including Zerochan and WallpaperCave — and since v5 the card IMAGES go
   through it too when it's up (see "Results"). If it's not running, a
   sticky amber banner pinned to the top of the page says so, in plain
   words — start the proxy and reload.
2. **Your own Cloudflare Worker** (`worker/`) — paste its URL in Settings.
   Free tier is 100k requests/day; see `worker/README.md` for the three
   deploy paths (one-click button, dashboard paste, `wrangler deploy`).
   This is the reliable path when using GitHub Pages, where the local proxy
   can't be reached (an https page can't fetch `http://localhost`).
3. **A custom proxy URL** from Settings, if you enter one.
4. **Public fallbacks** (corsfix, allorigins, cors.lol) — tried last. The
   status line under each search tells you which path actually worked,
   e.g. `wallhaven: 24 found (via local proxy)`. When the local proxy is
   down, a public-proxy result is labelled as such — `(via corsfix —
   public proxy)` — and a proxied source that fails says `proxy off —
   run ./start.sh` instead of a bare HTTP status.

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
- **Show** — how many wallpapers load per search: **50**, **100** (default),
  **150**, **200**, or **All**. The limit applies after merging, sorting and
  the other filters, so it counts the wallpapers that would actually show —
  fewer cards means fewer thumbnails and fewer full-res probes. When it hides
  results the status line says how many ("N more — raise the limit to see
  them"). Favorites always show all saved items, whatever the limit says.
  The choice is remembered in the browser (localStorage `wms.limit`). The
  per-source fetch caps (40 per source) are unchanged — the limit caps what
  is rendered, not what is fetched.
- **Device / ratio** — All ratios (default), **PC — landscape**, **PC —
  ultrawide 21:9**, or **Phone — portrait**. Classified from each item's own
  width/height: landscape is width > height, ultrawide is width/height ≥
  2.0 (21:9 ≈ 2.33 and wider — so a 3440×1440 search on a 3440×1440 screen
  finds its own kind), portrait is height > width. Square images (width =
  height) are neither, so they show only under All ratios. Items with no
  size at all can't be classified, so a specific ratio hides them — the
  status line says how many ("N hidden by ratio filter"), and if the filter
  hides everything the empty state offers "Show all ratios". Like the sort
  order, it re-renders the already-fetched results instantly — no re-search
  — and composes with the min-resolution filter and the sort. The choice is
  remembered in the browser (localStorage `wms.deviceRatio`).
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
- **Color** — a row of swatches (Red, Orange, Yellow, Green, Teal, Blue,
  Purple, Pink, Brown, Black, White) plus **Any color** (default). Only
  Wallhaven supports it: the chosen swatch is sent as Wallhaven's `colors`
  hex parameter (the swatch values are Wallhaven's own indexed palette), and
  the Wallhaven status pill notes the color (e.g. "· color #cc0000").
  Danbooru and Safebooru take tags only, and the scraped listings carry no
  color data, so every other source ignores the choice and returns its
  normal results — the picker says so ("Color filters Wallhaven only").
  The choice is remembered in the browser (localStorage `wms.color`) and
  applies on the next search, like the Content mode. No client-side pixel
  analysis, no guessing a color from tags.
- **Booru queries** — the query is auto-formatted per source. Boorus
  (Danbooru, Safebooru) are tag search: plain words join into one tag with
  underscores (`code geass` → `code_geass`), comma-separated groups become
  separate tags, and explicit booru syntax is left alone (`-excluded` tags,
  `~` OR groups, `*` wildcards, metatags like `rating:explicit` and
  `order:score`, tokens that already contain `_`). Every other source takes
  the plain text unchanged.

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
  a score of 0) used to sort after all scored items — so the top of a
  search was only Danbooru + Wallhaven and the best unscored results sat
  buried at the bottom. Best now interleaves the sources round-robin: the
  best item of every source first, then the second-best of every source,
  and so on, with each source's internal order still best-first. Source
  order within each round is first-appearance order in the best-sorted
  list, so the highest-ranked source leads each round.
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
(no 16:9 cropping) and is shown at full resolution in the end — but it
loads thumbnail-first. The small thumbnail (tens of KB) appears in under a
second, and the full-resolution image is swapped in only when the card
nears the viewport, so a search never has ~200 multi-MB files in flight at
once. The box height is fixed from the known dimensions — or from the
listing's aspect ratio when the pixels are unknown — on the card itself,
and the image fills it with `object-fit: contain` — so nothing ever jumps
while images arrive, and a failed image becomes a same-size "couldn't load"
placeholder (its Source page / Full image links still work) instead of
disappearing or collapsing. The one exception: an item whose listing stated
neither dimensions nor ratio gets its box corrected once, from the loaded
image's own size — and when the full image loads, its real dimensions
replace the "size unknown" badge.
If a full image stalls (see below), it times out after 15 s and falls
through the alternates. Clicking an image opens the full image in a new
tab — the image itself is the link, and that never changes. The Source /
Full image / ♡ buttons live in a row overlaid at the bottom of the image
and only appear while you hover (or tab through) a card, so the grid stays
clean; on touch devices, which have no hover, the row is always visible.
— so on a wide monitor the masonry just adds more ~300px columns instead
of leaving empty margins.

Zerochan and WallpaperCave images go through a proxy when one is
configured — the local proxy when it is running, else your Cloudflare
Worker when one is set and answering. Every other source's images load
direct, so a search never queues ~200 images behind the proxy's
6-connection limit (changed 2026-11-15: the proxy used to carry every
image). The proxy sends no Referer and a plain UA, which dodges
Referer-based hotlink blocks. Verified 2026-11-15: Zerochan full images
that stalled mid-download direct came through the proxy in ~2.4 s, and
WallpaperCave images that failed in bursts direct (32/100 cards on the
hosted site) come through it instead. The direct URL stays as a fallback
candidate, so a proxy failure for one image doesn't brick its card. The
proxy does NOT change the egress IP, so it can't dodge an IP-based block.
With no proxy configured, Zerochan full images stall direct again (the
thumbnail still shows).

## Preload

The **Preload** field in the toolbar (a number input in GB, default
**1 GB**, remembered in the browser) says how much full-image data to
fetch up front while you wait after a search: once results render, the
app eagerly upgrades full-res images in display order until that much has
loaded. Type any amount — 0.5, 2.5, 12 — or tap a preset chip (Off / 0.5 /
1 / 2 / 5 GB); empty, 0 or a negative number means Off, and anything over
50 GB clamps to 50. While preloading runs, a progress line under the
status pills shows "Preloading… N wallpapers · X / Y GB" with a thin
bar; it only appears while a search is preloading toward a set target,
and hides when preload is Off or the target is reached. This is a preload
amount, not a cap — when the target is reached eager preloading stops,
but scrolling still upgrades cards on demand as usual, so nothing is ever
blocked by the number. Off is the old lazy-only behaviour. The count
resets on every new search; raising the target mid-search resumes
preloading with the next queued card.

How the bytes are counted — honestly approximate, so the meter always
reads "≈": Danbooru and Wallhaven report an exact `file_size` per item
(verified live 2026-11-15); Safebooru and all scraped sites don't, so
those are estimated at 0.5 bytes per pixel from the known dimensions
(observed range across real files: ~0.1 for a flat Danbooru jpg to ~1.4
for a big AlphaCoders PNG), or a flat 5 MB when even the dimensions are
unknown. A successful upgrade is charged once, at the full file's cost,
even if a smaller alternate is what actually loaded; failed or stalled
probes charge nothing (their partial bytes are uncounted). Preloading
runs one probe at a time so two of the three probe slots stay free for
scrolling, skips thumb-only (Wallpapers.com) cards, and does not run in
the Favorites view — a handful of deliberate picks, which the observer
upgrades on demand anyway.

## Favorites

Every card has a ♡ button in its link row (hover the card to reveal it). Click it to save that wallpaper
— the heart fills (♥) and the item is stored in this browser's
localStorage under `wms.favs` (thumb, full image, source page, size,
source, date and score — enough to re-render the card without
re-searching). Click again to remove it.

The **★ Favorites (N)** button in the toolbar shows only your saved
favorites, in the current sort order (Best / Largest / Newest / Source
order all work on favorites too). Click it again — or run a new search —
to go back to normal results. Favorites survive reloads and new searches,
and a wallpaper that shows up again in a later search still shows its
filled heart. Everything is local-only: no account, no server, no export.

## Trending

The **Trending** tab (next to Search, above the results) shows what's
popular right now, with no query to type:

- **Wallhaven's daily toplist** — `sorting=toplist`, `topRange=1d`
  (verified live 2026-11-15: 24 results through the local proxy).
- **Danbooru's most popular posts today** — `order:rank` plus today's
  date (verified live 2026-11-15 via curl; the VM's IP is intermittently
  Cloudflare-blocked by Danbooru, so a run can also come back HTTP 403 —
  the pill says so honestly and the Wallhaven results still show).

Only those two: Safebooru has no popularity endpoint, and AlphaCoders'
top page is four featured items with no dimensions — not a real feed
(checked live 2026-11-15). The same filters as search apply: Content
mode and the server-side min-resolution filter are inside the adapters,
the device/ratio filter and the result limit run on the grid, the
Wallhaven color swatch applies, and the source checkboxes are respected
(uncheck Wallhaven or Danbooru and it's skipped). Favorites work on
trending cards exactly like search cards, and switching back to the
Favorites view remembers whether you came from Trending or Search.

Under the tab, a row of **popular-search chips** (code geass, catgirl,
cyberpunk 2077, anime, minimal, dark aesthetic, nature, space, city
night, mountains, neon, abstract) runs that term as a normal search:
back to the Search tab, the term in the box, submitted. The first visit
to Trending fetches live; going back later re-renders from memory, and
the ↻ Refresh button forces a fresh load.

## Changes in v5.6 (round 2 — Wallhaven-inspired redesign, 2026-11-16 — unreleased)

- **Redesigned in Wallhaven's language**: warm charcoal background
  (`#1c1c1c`) instead of blue-black, a single restrained gold accent
  replacing indigo, denser layout (tighter gaps and paddings, 15px body
  type), 4px corners, flat option rows separated by hairlines instead of
  a big settings panel, underline tabs, and a plain lowercase wordmark
  (the icon tile is gone). No gradients anywhere — the skeleton shimmer
  is a flat opacity pulse. All functionality and behavior unchanged.
- **Debug fixes from the redesign**: the preload meter no longer
  scrolls the page sideways on phones (it wraps); the card action row
  compacts below 900px so "Full image" stops wrapping unevenly; the
  Trending heading's text basis shrank so the Refresh button stays on
  its line. Ten new contrast checks cover the real states (pills,
  badges, banner, gold button text).
- **Second debug pass**: Retry on a thumb-failed card actually probes
  again (it was a no-op that left a blank card when the thumb already
  was the full image, or when there was no proxy to fall back to);
  leaving Favorites for Search marks the Search tab current again; the
  filled heart clears WCAG AA even over a bright image; the Black color
  swatch is actually visible now; the URL fast path falls back to the
  parser for any character it would percent-encode.
- **Faster**: Wallhaven and Safebooru fetch both pages in parallel
  (~550 ms → ~150 ms each in tests); static control lookups are cached
  (79 → 12 document queries per search); image URLs are computed once
  per card and reused; "Best" ranking computes each log once; failed
  images reuse the render-time cached refs. If a second page fails, the
  source now returns the first page's results instead of failing the
  whole source (same pattern as AlphaCoders since v5.5).
- QA harness 223 checks, optimizer all green.

## Changes in v5.5 (round 1 of the production-readiness loop, 2026-11-16 — pushed as 4d897408)

- **Overlapping loads no longer clobber each other**: a slow search
  finishing after a newer one (or a trending load after a search) used to
  overwrite the current view with the wrong query's results. Loads now
  carry a generation number and only the newest one renders, into the view
  it belongs to; stale loads still keep their data for back-navigation.
- **WallpaperCave images go through the proxy** (local proxy, else the
  Worker when set and answering) with the direct URL as a fallback — the
  hosted site's 32/100 burst failures were WallpaperCave throttling direct
  requests. The Worker now allows Zerochan's image hosts too, and its
  health is probed at startup; a healthy Worker also hides the proxy-off
  banner (it used to stay up after the Worker was set up). On the hosted
  site with no proxy configured, images still load direct and can still be
  throttled — Retry covers those, and the Worker deploy is the real fix.
- **Favorites keep the listing aspect ratio** (Wallpapers.com items
  re-rendered at 4:3 and vanished under ratio filters).
- **Preload meter charges huge files at the sample's cost**, not the
  original's (a 98 MB original with a ~150 KB sample used to eat the whole
  1 GB target after ~10 cards).
- **Sort order is remembered** across reloads, like every other control.
- Card link/image URLs are HTML-escaped; a search with no sources
  selected says so in the status pill. Retry on a single-candidate card
  actually probes now (it used to report success instantly on a broken
  card).
- **Phones**: the grid is one full-width column below 600px — the
  Source / Full image / heart row was wider than the two-column cards, so
  the heart button was clipped on every card. Small grey text is brighter
  (--faint now passes WCAG AA), the Search tab no longer claims to be
  current while viewing Favorites (look and aria-selected), the Trending
  refresh button aligns with its heading, and dead CSS is gone.
- **Faster**: AlphaCoders fetches both pages in parallel (about 2×
  locally, up to ~20 s saved on slow public proxies); tightening the ratio
  filter or lowering the limit reuses the cards that stay instead of
  rebuilding the grid; image loads skip their DOM walks; "Largest" sort
  precomputes areas. All behavior-identical, measured in node.
- QA harness 174 checks, optimizer all green.

## Changes in v5.4 (2026-11-15)

- **Preload is a typed amount now**: a GB number input with preset chips
  (Off / 0.5 / 1 / 2 / 5), clamps at 50 GB; the meter is a live progress
  line ("Preloading… N wallpapers · X / Y GB" + bar) that only shows while
  a search is preloading toward a set target.
- **Trending tab**: Wallhaven's daily toplist + Danbooru's most popular
  posts today, same filters as search, plus 12 popular-search chips.
- **More results**: Danbooru fetches up to 100 passing posts (was 40, 200
  per page, 2 pages), Wallhaven 48 across 2 pages, scrapers paginate to a
  second page (Wallpapers.com `?p=2` on the listing slug, AlphaCoders
  quickload endpoint, Zerochan tag page). The sites' own options are used
  where they exist: Danbooru `order:score` in Best mode, Wallhaven
  `ratios=` for the ratio filter. One verified exception: Wallhaven's
  toplist + `ratios=` returns 0, so Trending keeps ratio filtering local.
- **Error fixes**: a genuine empty page (Wallpapers.com "catgirl") is a
  green "0 found" pill, not red; failed cards show the reason (timeout vs
  blocked/missing) and a Retry button; huge originals display their ~850px
  sample in the grid while the Full image link stays on the original.
- **UI**: flatter and quieter — decorative gradients removed, sharper type
  hierarchy, calmer cards, 8px radii throughout.
- Debug pass: a card that recovers via Retry gets its alt text back
  (it was blanked on failure and never restored). Optimizer pass: Newest
  sort precomputes dates (~2× faster), `absUrl` fast path for
  root-relative hrefs, one grid traversal per render, verified-URL cache
  capped at 2000 entries. QA harness 137 checks, optimizer all green.

## Changes since v5.2 (merged from the local agent's work, 2026-11-15)

- Images are proxied **only for Zerochan hosts** (`static.zerochan.net`,
  `s3.zerochan.net`); every other source loads direct. This removes the
  localhost 6-connection bottleneck that queued a whole search behind the
  proxy.
- At most **3 full-res probes run at once**. A probe that stalls for the
  full 15 s is **not retried** — only quick errors get one retry.
- **Wallpapers.com cards are thumb-only**: their multi-MB full files are
  never probed in-card (the card keeps the thumbnail; the "Full image"
  button still works). Consequence: a Wallpapers.com badge can no longer
  fill in from a full load — it stays "size unknown" until the full image
  is opened directly.
- The local proxy gives up on an upstream fetch after **20 s** and aborts
  the upstream download when the browser request closes.

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
- Black cards persisted (v5): Wallpapers.com and Danbooru cards still
  showed black in the user's browser even though the URLs curl as HTTP
  200. Diagnosis (live, 2026-11-15): the URLs are fine, the DOWNLOADS are
  the problem — a search pulls ~150–250 MB (a single Safebooru file is
  14 MB, an AlphaCoders PNG 26 MB), and Zerochan full images STALL
  mid-download (HTTP 200, then nothing — a 30 s curl timeout hit with
  12 MB already received). A stalled `<img>` never fires `onerror`, so no
  fallback chain ever ran. Fixes: thumbnail-first loading (small thumb
  shows immediately, full-res swaps in on approach via IntersectionObserver,
  so ~200 huge files are never all in flight); a 15 s timeout per image
  attempt (a stall counts as failed), one delayed retry, then the
  alternates; the box height now comes from the card's own aspect-ratio
  (not the `<img>`), so nothing jumps when images arrive; a card whose
  images all fail becomes a same-size placeholder instead of being
  removed (removal was itself a jump). Images are also routed through the
  local proxy when it is up (allowlist extended to the image CDNs:
  `w./th.wallhaven.cc`, `safebooru.org`, `images*.alphacoders.com`,
  `static/s3.zerochan.net`, `cdn.donmai.us`) — Zerochan images that stall
  direct load through it in ~2.4 s. Unverified from this VM: Danbooru's
  CDN (`cdn.donmai.us`) 403s this VM's IP, so Danbooru images couldn't be
  tested here at all — the proxy route is the best shot, but if the user's
  VPN IP is also blocked there, those cards will show the placeholder.
- Badge overlap (v5): on narrow cards the "size unknown" and source
  badges could collide — and a failed image rendered its long alt text
  over them. Badges are now capped at just under half the card width with
  ellipsis truncation, and a failed image hides its alt text behind the
  placeholder.
- Proxy errors were too easy to miss (v5): the user ran a whole session
  with the proxy off without noticing the banner (it sat under the hero
  and scrolled away). The banner is now sticky at the top of the page with
  plain wording ("Local proxy is OFF. Run ./start.sh … then reload …
  Right now Zerochan fails and images may not load"), a failing proxied
  source's pill says "proxy off — run ./start.sh" (technical detail stays
  in the tooltip), and public-proxy results are labelled "(via corsfix —
  public proxy)".
- Re-renders re-probed everything (v5 QA): every sort/ratio change rebuilt
  all cards, so ~200 multi-MB full images were probed again and the
  observer kept the detached nodes forever. Fixes: verified full URLs are
  cached for the page lifetime; sort/ratio changes now just reorder the
  existing cards (same nodes, no thumb re-fetch, no re-probe); in-flight
  probes are cancelled when their card is discarded; the observer is
  disconnected on full rebuilds. Also fixed: a full image erroring after a
  successful probe left a hidden card with no placeholder; the hosted
  (https) version's pills wrongly said "run ./start.sh" (it can never reach
  the local proxy — they now point at the Worker); "Check again" after
  starting the proxy now re-renders the images through it; an empty-query
  submit no longer silently exits the Favorites view.
- Performance (v5): the proxy now streams responses instead of buffering
  them whole (TTFB on a 2.5 MB image 1.32 s → 0.38 s) and forwards cache
  headers so browsers can cache proxied images; WallpaperCave's category
  URL is guessed first (2 fetches → 1); sort changes render in ~1 ms
  instead of ~13 ms in the test harness.
- "Full image" opened a small image (v5.1, field report 2026-11-15): a
  Safebooru card's Full image link opened a 177x250 thumbnail. Cause: when
  the full image stalled and a smaller alternate loaded, the card's links
  were retargeted to whatever had loaded — so the tiny preview became the
  "Full image" target. Fix: the links are never retargeted anymore. The
  fallback chain only changes what is DISPLAYED in the card; Source /
  Full image always point at the full URL (and a direct navigation has no
  15 s probe timeout, so a slow full file still loads in its own tab).
  Regression test B7 in the QA harness covers it.
- Buttons always visible (v5.1): the Source / Full image / ♡ row under
  every card was visual noise. It is now an overlay at the bottom of the
  image that fades in on hover (or keyboard focus) and is hidden otherwise
  — and hidden means unclickable, so it can never steal the click that
  opens the full image. Touch devices keep the row always visible.
- "Size unknown" on AlphaCoders (v5.2, field report 2026-11-15): the
  listing DID publish the real dimensions all along — each item embeds
  schema.org microdata (<meta itemprop="width" content="1920">, height,
  fileFormat) — the adapter just never read it. It does now: verified
  against a saved live search page, 29/29 items parse with real
  dimensions, and the full URL uses the true file extension (7 of them
  are .png — previously guessed as .jpg with a .png fallback).
- "Size unknown" on Wallpapers.com (v5.2): that listing genuinely
  publishes no full resolution — but each result's <img> carries the
  thumbnail's width/height, which preserves the full image's aspect
  ratio, so the card's box is right from the start (ratio-only, the
  badge honestly stays "size unknown" until the full image loads and
  reports its real pixels — see imgLoaded). The ratio also feeds the
  Device/ratio filter now, so Wallpapers.com portrait art shows under
  "Phone — portrait" instead of being hidden. Thumbs come from the
  900w /images/high/ variant instead of the 300w thumbnail.
- Images looking small although the full is high-res (v5.2): two
  causes. (1) The 4:3 reserve box letterboxed portrait art — a 1080x1920
  image sat in the middle of a wide box with black bars, looking small.
  Fixed by the true ratio above (AlphaCoders dims, Wallpapers.com ratio,
  plus imgLoaded correcting the box from the loaded image as a backstop).
  (2) When the full image stalls, the card falls back to a much smaller
  alternate (e.g. a 177x250 Safebooru preview) — that is the best version
  that actually loaded, not the best that exists; the Full image link
  still opens the real full file. Wallpapers.com thumbs are now 900w
  instead of 300w, so the pre-upgrade image is crisper too.

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
