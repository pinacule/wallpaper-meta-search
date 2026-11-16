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
| Wallpapers.com | HTML search page via proxy chain, inline | Works — up to 80 items per search (badge shows the listing ratio, e.g. 16:9) |
| WallpaperCave | HTML search page via proxy chain, inline | Works via local proxy (up to 50 items); via public proxies it flips between working and failing in bursts — see below |
| Zerochan | HTML search page via proxy chain, inline | Works via local proxy (up to 80 items); via public proxies Zerochan's bot-block ("Crawlers are not permitted") 503s corsfix in bursts — see below |
| Gelbooru | API via proxy chain, inline | Works with a free account API key + user ID (Settings); without one the pill says "needs API key" |
| WallpaperAccess | Link only | Cloudflare 403s every fetch, direct and via proxy |
| Google Images | Link only | No free search API |

## Why some sources need a proxy

A web page can only fetch from a site that explicitly allows it (CORS).
Danbooru allows it; the rest don't, so those requests go through a proxy
chain, in order:

1. **Local proxy** (`proxy/server.mjs`, port 8787) — only when the page is
   served over http (localhost). Started automatically by `start.sh` /
   `start.bat`. This is the reliable path: every source works through it,
   including Zerochan and WallpaperCave — and the card IMAGES from those
   two go through it too when it's up (every other source's images load
   direct — see "Results"). If it's not running, a
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
  the filter hides matches, the status line says how many — but only
  Danbooru and Safebooru report a count (Danbooru's is exact for the whole
  database; Safebooru's counts only the pages actually fetched). Wallhaven
  and the scraped sites drop below-filter matches silently, with no count —
  and the pill never says which kind a count is: both read the same
  ("N below WxH — lower the filter to see them").
- **Show** — how many wallpapers load per search: **50**, **100** (default),
  **150**, **200**, or **All**. The limit applies after merging, sorting and
  the other filters, so it counts the wallpapers that would actually show —
  fewer cards means fewer thumbnails and fewer full-res probes. When it hides
  results the status line says how many ("N more — raise the limit to see
  them"). Favorites always show all saved items, whatever the limit says.
  The choice is remembered in the browser (localStorage `wms.limit`). The
  per-source fetch caps (Danbooru and Safebooru 100, Wallhaven 48,
  Wallpapers.com, AlphaCoders and Zerochan 80, WallpaperCave 50) are
  unchanged — the limit caps what is rendered, not what is fetched.
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
    | Safebooru | Safe-only site — returns nothing in NSFW mode (all 100 "code geass" posts rated `general`); the pill says "0 found · safe-only site" |
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
loads thumbnail-first. (Wallpapers.com cards are the exception: they keep
their 900w thumbnail, since their multi-MB full files are never probed
in-card.) The small thumbnail (tens of KB) appears in under a
second, and the full-resolution image is swapped in only when the card
nears the viewport, so a search never has ~200 multi-MB files in flight at
once. The box height is fixed from the known dimensions — or from the
listing's aspect ratio when the pixels are unknown — on the card itself,
and the image fills it with `object-fit: contain` — so nothing ever jumps
while images arrive, and a failed image becomes a same-size "couldn't load"
placeholder (its Source page / Full image links still work) instead of
disappearing or collapsing. The box is never corrected after render: a
size-unknown card keeps its 4:3 box and the image letterboxes inside it,
whatever the loaded image's natural size. What does change is the badge —
when the full image loads, its real dimensions replace "size unknown"
(except on Wallpapers.com cards, which are thumb-only and never load the
full in-card, so their badge stays "size unknown").
If a full image stalls (see below), it times out after 15 s and falls
through the alternates. Clicking an image opens the full image in a new
tab — the image itself is the link, and that never changes. The Source /
Full image / ♡ buttons live in a row overlaid at the bottom of the image
and only appear while you hover (or tab through) a card, so the grid stays
clean; on touch devices, which have no hover, the row is always visible.
— so on a wide monitor the masonry just adds more ~300px columns instead
of leaving empty margins.

Zerochan, WallpaperCave, and Danbooru images go through a proxy when one
is configured — the local proxy when it is running, else your Cloudflare
Worker when one is set and answering. Every other source's images load
direct, so a search never queues ~200 images behind the proxy's
6-connection limit (changed 2026-11-15: the proxy used to carry every
image). The proxy sends no Referer and a plain UA, which dodges
Referer-based hotlink blocks. Verified 2026-11-15: Zerochan full images
that stalled mid-download direct came through the proxy in ~2.4 s, and
WallpaperCave images that failed in bursts direct (32/100 cards on the
hosted site) come through it instead. Danbooru joined the proxy list in
v5.14 (its 3220×5400 card failed in-grid direct on a slow/VPN path while
the full image opened fine on click). The direct URL stays as a fallback
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
50 GB clamps to 50. While preloading runs, a progress line above the
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
unknown. A successful upgrade is charged once, at the displayed image's
cost — the ~850px sample for huge files, the full file otherwise — even
if a smaller alternate is what actually loaded; failed or stalled
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

Under the tab, a row of **popular-search chips** (landscape, catgirl,
cyberpunk 2077, anime, minimal, dark aesthetic, nature, space, city
night, mountains, neon, abstract) runs that term as a normal search:
back to the Search tab, the term in the box, submitted. The first visit
to Trending fetches live; going back later re-renders from memory, and
the ↻ Refresh button forces a fresh load.

## Changes in v5.16 (round 12 — the meter/filter divergence, 2026-11-16)

- **The meter now always agrees with the filter row**: the v5.15
  browser test caught the meter stuck on "Ready · 34 wallpapers"
  while the filter row said Loaded (56), and falling 97 → 68 → 34
  across Load more clicks while the filter climbed to 174. Root cause:
  the meter's text was only repainted on pump iterations and phase
  changes — once the pump stopped (drained or paused) the observer
  kept loading cards and the meter froze at the pump's last paint.
  `refreshPreloadPhase` now repaints the meter on every card state
  change (a text write, not a DOM walk — the counts are already
  computed by the caller). Reproduced in the harness first (meter 2
  vs filter 3, fixed to 3 = 3). The Load more fall was the same bug,
  not lost state — the growing render preserves loaded cards and the
  full rebuild restores them via `loadedPages`.
- **"Ready" now names the failures**: the same test caught "Ready"
  with 44/100 cards permanently failed and the meter never mentioning
  it. It now reads "Ready · 56 wallpapers · 50 MB / 1.0 GB · 44
  failed" when failures exist; a clean set keeps the plain "Ready"
  text. `loadedCardCounts` gained a `failed` field (settled-failed:
  state "failed", "Preview only" full-failed, or no img); at Ready,
  pending == failed, so the meter's failed count always agrees with
  the filter row's Not ready count. Paused shows no failed count
  (the budget is the point there). Packing verified: the longest
  Ready-with-failures text still fits the 2-line phone rung.
- **Stale filter labels zeroed**: during a new search's busy phase
  the filter row's DOM labels kept the previous search's counts (the
  row is visually hidden by the reserve rule, but the labels were
  stale). `updateLoadedFilterButtons` now zeroes the three labels
  whenever the row hides, and they come back true when it unhides.
- **Debugger pass (no bugs found, 9 seam guards)**: verified the
  meter/Ready seam — the repainted meter always shows the right
  failed count (none while loading or paused, matching Not ready at
  Ready, because pending = failed + loading always); repaint cost
  measured (21 changed text writes over a 20-card pump run, ~1/card;
  fill ~3/card; all O(1) writes, no loop, no layout reads); the
  `failed` definition's edge cases (thumbOnly thumb error → failed,
  thumb still loading → loading and blocks Ready, Retry un-fails, a
  card failing after promotion is impossible without a Retry or a new
  render first); label zeroing on every hide path (new-search busy,
  empty states, Favorites/Trending switches); the AW1 per-batch
  budget untouched (Load more after Paused still works).
- **Optimizer pass (nothing left to take, 5 guards)**: the
  unconditional repaint costs ~0.010ms/call (61–63 calls over a
  20-card pump run, 0.63ms total), 0 queries while pumping, zero
  layout reads anywhere in app.js; the `failed` counter rides the
  same single `loadedCardCounts` walk (1 querySelectorAll per call,
  no second pass); round-2 claims re-verified (parallel pages
  151–152ms, growing 25.8ms vs rebuild 54.6ms, Gelbooru no-key = 0
  fetches). Not taken: the counts walk itself (~0.05ms/call in a real
  browser — a running counter risks wrong user-visible counts) and
  the pump's redundant meter calls (~0.01ms each).
- QA harness 537 checks (509 + 4 meter repaint + 10 Ready with
  failures + 9 debugger + 5 optimizer), optimizer all green.

## Changes in v5.15 (round 11 — the two browser findings, 2026-11-16 — pushed as 099d0a60)

- **The first-search shift is fixed**: the v5.14 browser test showed the
  grid still jumping ~+29px on the FIRST search after page load (0px on
  repeats), and the bug hunt found it was two bugs, not one. (1) The
  filter row (Loaded / Not ready / All) had no reserve at all — the
  round-10 reasoning ("it appears on search render, never
  asynchronously") is true for repeat searches but false for the first
  one, when the grid is already showing skeletons and the row appears
  under it, pushing the grid down by its full height (~47px). It now
  has the same hidden-but-reserved slot as the meter and the top
  load-more row: natural height, gated on grid cards/skeletons, never
  in Favorites or Trending, none over an empty state. (2) The meter
  reserve OVER-reserved by exactly 12px — the round-9
  `min-height: calc(1.32rem + 12px)` double-counted the margins
  (min-height is a CONTENT height; the 12px margins sit outside it),
  so the hidden slot was 45px against a 33px shown meter and the grid
  jumped UP 12px when the meter appeared, partly masking the filter
  row's drop. The min-heights are now bare 1.32rem / 2.64rem. Net
  first-search shift after both fixes: 0px, by measurement.
- **"Ready" now means what it says**: the v5.14 browser test caught
  the meter reading "Ready · 50 wallpapers" at 50/100 loaded, with
  the Loaded count still climbing after — "Ready" meant the preload
  pump's queue drained, not that everything was loaded. It now means
  NO card in the current set is still loading (loaded + settled-failed
  == total); while the observer is still upgrading cards, the meter
  honestly stays on "Preloading…". Failed and "Preview only" cards
  are settled, not loading, so they never block Ready, and Paused
  promotes to Ready if the observer finishes everything while the
  pump is paused. The meter's count is now the GRID's loaded count
  and bytes (pump + observer, no per-batch reset), so it agrees
  exactly with the filter row's Loaded count instead of contradicting
  it. The phase definitions are documented at the `preloadPhase`
  declaration in app.js.
- **Debugger pass (2 fixes, both stale-counts bugs at the seam)**:
  (1) during a new search's busy phase the meter and the filter row
  showed the OLD grid's numbers over the skeletons ("Preloading… 1
  wallpaper · 512 MB", "Loaded (1)" for cards that were gone) — the
  search reset re-cached the old counts and nothing refreshed them
  after the skeletons replaced the cards; the counts are now
  refreshed the moment the skeletons land. (2) A re-render that
  drops loaded cards (sort/ratio change) left the pump painting the
  pre-render count, so the meter stuck on the dropped cards' numbers
  while the filter row showed the true ones — the counts are now
  refreshed at the top of `restartPreload`, before the pump runs.
  Verified clean with the debugger's own measurements: the shift
  agent's meter arithmetic (33.12px / 54.24px, hidden == shown on
  both rungs), the meter texts against the reserve at 412px and
  481–640px, every cache path, every phase transition, and the
  per-batch budget (Load more after Paused still works).
- **Optimizer pass (1 taken)**: the Ready agent's `_img` cache only
  covered `buildCard` — every new search takes the full-rebuild path,
  which never set it, so each counts walk paid one querySelector per
  card (400 calls over a 20-card pump run, measured in the QA shim).
  The full rebuild now sets `cards[i]._img`, and the drop loop reads
  it first. The harness fix that came with it: test-opt's `parseCard`
  was setting `_img` for free on every parsed card, so the "0 queries
  while pumping" check passed vacuously — it no longer does, and the
  check is now a real guard (400 queries on unfixed code, 0 on
  fixed). Verified clean with numbers: parallel pages still ~152ms,
  growing render still beats rebuild (12.3ms vs 39.1ms), Gelbooru
  no-key = 0 fetches, and the live-search summary shows Wallhaven at
  96 items (the round-10 slice change working).
- QA harness 509 checks (481 + 8 first-search shift + 10 Ready state
  + 5 debugger + 5 optimizer), optimizer all green.

## Changes in v5.14 (round 10 — the four issues, 2026-11-16 — pushed as 8e5cba95)

- **Danbooru cards no longer fail outright**: a card whose preview is
  showing but whose full-size upgrade times out now keeps the preview
  and gets a small "Preview only" badge instead of the whole-card
  "Image couldn't load" placeholder — the full image is still one click
  away. Danbooru images (cdn.donmai.us) are now proxy-routed when a
  proxy is up, with the direct URL as fallback, and the "huge file"
  line dropped from 15 MB to 5 MB, so big files show their ~850px
  sample in the grid instead of stalling. The fail reason no longer
  clips at narrow card sizes. No retry on timeout and no longer timeout
  — a retry would hold a probe slot and a browser connection for
  another 15 s; the sample line and the proxy route are the fix for
  slow huge files. The proxy route is unproven live (Danbooru 403s
  from this VM).
- **A fairer slice from every source**: the per-source page caps were
  the real limiter. Wallhaven now fetches 4 pages (up to 96, was 2
  pages / 48), Safebooru and Gelbooru keep paging until their 100
  target is met, Zerochan pulls tag pages 2–4, AlphaCoders pages 1–4.
  The "cyberpunk" pool goes from ~364 to ~451 at the cost of ~6 more
  requests, with no real slowdown (the pages run in parallel).
  Danbooru stays at 100 — already the biggest slice — and
  WallpaperCave's 8 is real (the matched categories only hold 8).
  Best's round-robin already guarantees a fair visible set; the fix
  extends how long small sources stay in the mix on load more.
- **"Also search on" cleaned up**: Wallhaven was listed there even
  though it is a full inline source — it is removed, so the row is
  only WallpaperAccess + Google Images. The audit found two stale
  README rows too (Gelbooru still "Link only", Wallpapers.com still
  "no resolution shown") and fixed them. Everything else checked was
  clean.
- **The preload workflow the user asked for**: the meter is now
  persistent — it stays visible whenever a target is set, showing
  Preloading… / Paused / Ready plus the wallpaper count and MB/GB,
  with a spinner while active. When a target is set, the grid shows
  only fully loaded wallpapers ("none nonloaded"); a Loaded / Not
  ready / All row sits under the meter — the Loaded button is the
  instant view of the loaded set, Not ready is one click away, All is
  the escape hatch. Sort and filter controls work on the loaded set.
  Load more got a twin at the top of the results, doing the same as
  the bottom one, and preloading continues on the new batch after
  Load more. "Ready" means the queue drained for the current set;
  "Paused" means the budget is spent with unloaded cards remaining.
  One honest caveat: the spinner adds ~22px of meter width, which at
  phone width could tip the meter text to a third line in the worst
  case — the phone rung reserves two.
- **Debugger pass (5 fixes)**: the big one was Load more doing nothing
  after Paused — the pump compared the *session* total against the
  target, so the new batch's cards stayed hidden under the loaded-only
  filter and the observer can't fire on hidden cards; the target is now
  a per-batch budget that resets when a fresh batch lands. Also: the
  meter reserve under-reserved at 481–640px (the Paused text is 14
  chars longer than the loading text, so the meter grew a line the
  moment the target was reached — the two-line rung now runs to
  640px); the filter row showed stale counts over empty states (it now
  hides when there are no cards); the top load-more reserve was dead
  space in Trending (excluded there); Trending fetched 4 Wallhaven
  pages for a view with no load more (2 pages there, 4 in search).
- **Optimizer pass (2 taken)**: Safebooru/Gelbooru re-fetched their
  pid-1 page on the first load more (it was discarded when pid 0 met
  the target) — it is now stashed and served from memory. The
  growing-path render stages cards in a DocumentFragment and inserts
  once (364 live insertions → 1). Verified clean with numbers:
  parallel pages still ~150ms, growing render still beats rebuild,
  Gelbooru no-key = 0 fetches, the meter costs 0 document queries
  during a pump.
- QA harness 481 checks (419 + 5 link cleanup + 12 Danbooru +
  10 source slice + 19 preload workflow + 11 debugger + 5 optimizer),
  optimizer all green.

## Changes in v5.13 (round 9 — the pill shift, 2026-11-16 — pushed as cd31dc1c)

- **The pill shift is fixed, for real this time**: the v5.12 browser test
  showed the grid still jumping +27/+10/+52px, and the round-9 bug hunt
  found three separate causes. (1) The meter's reserved slot was ~17px
  short on the FIRST search only — its text span is empty until
  preloading starts, so the hidden slot was 16px against a 33px visible
  meter; the reserve now pins the full one-line height. (2) The status
  reserve was 2 rows, but 8 sources' settled pills take 3 rows at
  desktop once public-proxy via labels appear — the base rung is now 3
  rows, at the price of ~37px dead space under the busy pill when the
  settled pills only take 2. (3) The first search sat ~75px higher than
  later ones because the proxy banner started hidden and popped in up to
  2.5s after load — it is now visible by default and only hides when a
  proxy or Worker is confirmed. Trending gets its own phone-only reserve
  (2 rows at 412px, where its pills wrap against a 1-row busy pill).
  The debugger re-measured the phone rung for 8 sources (10 → 11
  lines). Honest limits, in the comments: the via-label case at 1280px
  still needs 4 rows, and no fixed reserve is exact across queries.
- The load-more tail shift is not a bug: a page-2 item sorting near the
  tail and moving the last few cards is the growing-set path working as
  designed (existing nodes move, never rebuild). A ~10px residual in one
  browser measurement has no code mechanism behind it and is most
  likely measurement noise.
- QA harness 419 checks (403 + 12 pill shift + 4 debugger), optimizer
  harness all green, nothing left to take — the reserve path is 3
  classList ops per search and there is no forced layout anywhere in
  the app.

## Changes in v5.12 (round 8 — sources, tags, load more, 2026-11-16 — pushed as 251aa0db)

- **The +33px busy→settled jump is fixed**: it was the preload-meter
  slot, not the status pills. The round-6 meter reservation was gated on
  `main:has(#results .card)` — during the busy phase `#results` holds
  skeletons, not cards, so the slot was absent (0px) until the first
  cards rendered, and the grid dropped exactly the meter's height the
  frame results arrived (v5.11 browser test: busy y=760, settled y=793).
  The gate now lists skeletons too, so the slot is reserved continuously
  from busy through settled. A phone rung reserves the wrapped (two-line)
  meter height at ≤480px, where the shown meter breaks to two lines.
- **Gelbooru is an 8th inline source** (was link-only): same dapi shape
  as Safebooru, with a free account's `api_key` + `user_id` (Settings
  fields next to the Wallhaven key). Without a key it throws before any
  fetch, so the pill says "needs API key" instead of a 401 or a
  misleading "0 found". Purity uses Danbooru-style `rating:` metatags.
  Max fetch per search is now 638 items (was 538). Live use needs a free
  Gelbooru account — no key exists yet, so the adapter is verified by
  code + harness only.
- **Tags**: Danbooru, Safebooru, Wallhaven and Gelbooru items now carry
  their tags (capped at 12 stored, 6 chips shown + a muted "+N").
  Chips sit in the meta overlay under the links row — hover-reveal on
  desktop, always visible on touch — and clicking one searches for that
  tag. Scrapers carry no tags. Every chip is escaped; a tag is untrusted
  API text, never markup.
- **Wallhaven huge files get a sample**: Wallhaven's API offers no
  mid-size sample — its thumbs are fixed sizes regardless of the
  original (verified live: `large` is 432px on the long side even for a
  7680×4320 file). For huge files `displayFull` is now `thumbs.large`,
  the thumb itself, so the grid never stalls past the 15 s probe on a
  multi-MB original; the Full image link still opens the original, and
  the original stays the first fallback candidate.
- **WallpaperCave searches up to 3 categories** (was 1): the top 3
  categories matching any query word are fetched concurrently and
  interleaved, so one full category can't fill the 50-item cap alone.
  0–1 matches keep the old single-category path exactly.
- **Wallpapers.com badge shows the ratio**: the listing thumb's
  dimensions are the full image's real ratio, so the badge now shows the
  GCD-reduced ratio ("16:9", "300:169") instead of "size unknown"
  forever. A ratio badge still upgrades to real pixels if a full ever
  loads.
- **Hidden counts for every source**: Wallhaven reports an exact count
  (`meta.total` without the min-res filter minus with it — verified live:
  "landscape" 50,889 − 42,383 = 8,506 hidden); the scrapers report a
  checked count among the pages actually fetched, marked with a "+"
  (items with unknown dimensions are never counted, so Wallpapers.com
  is always 0). The pill distinguishes them: exact shows the number,
  checked shows "3+ below 1920×1080".
- **Load more**: a button below the grid fetches the next page from
  every source that has one (Danbooru page, Safebooru pid, Wallhaven
  page, AlphaCoders page, Wallpapers.com paginator link, Zerochan ?p=)
  and raises the render cap by 100 per click. A failed source keeps its
  cursor for retry next click. WallpaperCave has no pagination, so it
  contributes nothing more. Existing cards are moved, never rebuilt, so
  the grid top doesn't move; preload counters are untouched, and a new
  search cancels an in-flight load and resets the cursors.
- README cleanup: 9 contradictions between the README and the code
  fixed (per-source caps, the meter's position, the preload charge, the
  Trending chips list, and more).
- QA harness 403 checks (302 + 8 Cave + 6 Wallpapers.com + 10 tags +
  6 Wallhaven + 6 pill shift + 12 Gelbooru + 13 hidden counts +
  32 load more + 8 debugger), optimizer harness fixed (it had been
  crashing on a stale default directory since v5) and all green, with 6
  new Phase 8 regression guards. The debugger also fixed 6 real bugs:
  Gelbooru load-more fired 3 fetches per click, three scraper load-more
  paths forgot their hidden counts, the pill lost its checked-scope "+"
  on rebuild, and the Load more button could flash over skeletons
  during a new search.

## Changes in v5.11 (round 7 — the transient top-row reshuffle, 2026-11-16 — pushed as 08d939fa)

- **The round-3 freeze had a hole**: `aspect-ratio` is a preference, and an
  in-flow `img`'s intrinsic size is the anchor's min-content floor — so a
  loaded image TALLER than its reserve forced the anchor taller (a
  Wallpapers.com card whose listing ratio doesn't match the real file, or
  any 4:3-fallback portrait — the certain trigger: 600x1067 at 300px wide
  is 533px against a 225px reserve). Each such growth rebalanced the CSS
  multi-column masonry, so the visual order changed while the DOM order
  did not — the v5.8/v5.10 late reshuffles, where the top row changed once
  between settle and +60s and then came back as the height vector
  completed. The fix is two declarations: the card `img` is now
  `position: absolute; inset: 0`, so the anchor has no in-flow children
  at all and its height is purely the aspect-ratio in every state
  (unloaded, thumb, full, failed). The visual result is identical — the
  img already filled the anchor exactly. Round 5's ruling (no data
  re-sort, no re-render) still holds; the growth was layout responding to
  intrinsic dimensions, not a style write. The debugger verified the
  mechanism (CSS Sizing 4: aspect-ratio yields to the min-content floor)
  and the fix (anchor is the containing block; paint/click order right;
  no in-flow node can enter the anchor), and fixed two comments that
  contradicted the freeze. The mechanism is spec-reasoned and consistent
  with all three sightings, not live-proven (no layout engine on this VM)
  — the next browser run can prove or disprove it directly by comparing
  an anchor's height to its reserve before and after its thumb loads.
- QA harness 302 checks (294 + 6 new Group AE + 2 new Group AF),
  optimizer all green.

## Changes in v5.10 (round 6 — search vs Trending + copy cleanup, 2026-11-16 — pushed as bf227fcb)

- **Trending chips are genuinely popular terms now**: "code geass" was the
  only test artifact in the chip list (hardcoded during Code Geass testing)
  — replaced with "landscape"; the other 11 are unchanged generic popular
  topics. The chips also get a visible "Popular searches" label — they only
  had an aria-label before, so nothing on screen said what they are, and
  they read as the user's own recent searches. The search placeholder and
  hint examples lost their Code Geass references too ("cyberpunk 2077",
  "neon").
- **Copy cleanup**: the site's text is cut down across the board — the hero
  sub is gone, the proxy banner and Settings explanations are short, the
  Trending description is one line, the footer and empty state lost their
  duplicated source lists, and failure reasons are terse ("Timed out after
  15 s", "Blocked or missing"). Everything the user needs to act on is kept
  — Worker setup instructions, what a control does, why something failed —
  in fewer words.
- **Skeleton pulse was running but invisible**: the old opacity pulse ran
  over --bg-soft (#262626) on a --panel (#232323) card — a 3-step gap — so
  the composite moved ~1 RGB step, exactly the v5.9 browser test's constant
  RGB 36–38 across 81 samples. The keyframes now animate background-color
  between #171717 and #2c2c2c, the same family as the card pulse. The card
  pulse itself was verified NOT broken — the test measured skeletons, never
  a card anchor (after render the preload pump had already loaded every
  image).
- **Preload meter unreserved**: it sits above #status, outside the round-4
  reserve, so appearing or disappearing moved the grid by its full height
  (~33px at desktop) — the likeliest cause of the v5.9 test's run-2 ~17px
  drop on settle. Its slot is now reserved whenever the grid has cards
  (CSS-only, `:has()`), so showing or hiding it moves nothing. No
  reservation on first load or in Favorites (which never preloads) — no
  dead space there. Trade-off, same as round 4's reserve: after preloading
  ends, the reserved slot is a ~33px dead band until the view changes.
- QA harness 294 checks (268 + 10 new Group AC + 9 new Group AB + 7 new
  Group AD), optimizer: nothing left again (round-2 claims re-verified;
  live search is network-bound, not code-bound).

## Changes in v5.9 (round 5 — bug hunt on the v5.8 browser test, 2026-11-16 — pushed as fc6ec2cc)

- **Late reshuffle — investigated, no app mechanism exists**: the v5.8
  browser test saw the top-row composition change once between a
  "settled" capture (only 5 images decoded) and a minute later, then
  stabilize. Traced from the code: a search renders exactly once
  (all sources awaited, then one `renderResults`), no automatic
  re-render exists after that (the proxy probe never re-renders; the
  pump and observer only swap image sources), and no post-render path
  can change a card's height — the anchor ratio is frozen, everything
  else in the card is absolutely positioned, and the only style writes
  after render are image visibility and the meter fill. So neither a
  remaining height-change path nor late-arriving results can explain
  it; the remaining explanations are a test artifact (scroll position
  at capture time) or a browser-internal balancing quirk, and no
  proportionate fix exists inside the app's architecture — replacing
  CSS multi-column masonry, or holding the first cards until every
  source reports, would both be worse than the one observed, self-
  stabilizing event. No code change for it.
- **Loading cards pulse instead of sitting black**: on the Pages site a
  thumb can take ~10s over a public proxy, and until it lands the card
  is a flat black void that reads as a broken image. The anchor now
  pulses dark grey (`thumb-loading`, background-color only, same 1.3s
  cadence as the skeletons) until the first load lands, when
  `imgLoaded` adds `.img-loaded` and the pulse stops; letterbox bars
  stay flat black after that. Reduced-motion users get the static
  black via the existing global rule.
- QA harness 268 checks (260 + 8 new Group Z), optimizer all green.

## Changes in v5.8 (round 4 — bug hunt on the v5.7 browser test, 2026-11-16 — pushed as 1855dce4)

- **Status-pill shift fixed**: while results loaded, the whole grid
  shifted down ~48px once because the status-pill area grew from one
  row (the busy pill) to two (one pill per source plus totals) as
  results rendered. The row now reserves its final height from the
  busy phase on (`status-reserved`, set for 6+ sources in the same
  block as the busy pill), so it is already two rows tall before the
  first source reports in. The reserve is viewport-aware — about 10
  pill lines on phones (measured at 412px), off entirely above 3000px where the pills fit
  one row — and it never applies to Trending or Favorites, whose
  pills fit one row. With 5 or fewer sources there is no reserve
  either, so there is no dead space to pay for in those views.
- **Preload meter's live invisibility — checked, intended**: on the
  Pages site the meter never appears because public proxies stall and
  the preload queue drains, which hides it by design — it is a live
  progress line only (Off, target reached, queue drained, Favorites
  all hide it), not a status display. The per-view counters from v5.7
  are untouched; the live test simply never produced progress to
  preserve. Its appearance is part of the same frame as the cards
  rendering, so it reads as one content swap, not a jump of stable
  content — reserving a permanent slot for it would leave dead space
  after every preload, which is worse.
- QA harness 257 checks (245 + 12 new Group X), optimizer all green.

## Changes in v5.7 (round 3 — bug hunt on the v5.6 browser test, 2026-11-16 — pushed as 3e68491d)

- **Jumping images fixed**: a card's aspect-ratio box is now frozen at
  its render-time reserve — `imgLoaded` no longer rewrites the box to
  the loaded image's natural size. The reserve is exact for the
  overwhelming majority of cards (real dimensions from Danbooru,
  Wallhaven, Safebooru, AlphaCoders, and Zerochan titles; real
  `<img>` width/height on WallpaperCave pages; proportional listing
  dimensions on Wallpapers.com), and only truly size-unknown items
  keep the 4:3 box, letterboxed. The badge still fills in with the
  true resolution when the full image loads — only the box stays put.
  Because no card changes height on load, the CSS-columns masonry no
  longer rebalances and the grid order stays exactly as rendered; no
  layout change was needed and no code path ever re-sorted on load.
- **Sticky proxy banner is opaque**: its background was 8% amber over
  the page, so grid content scrolling underneath bled through the
  banner text. It is now the exact solid composite of that tint over
  the page background (`#2d261b`). It is the only sticky/fixed element
  on the page, and the other translucent backgrounds are intentional
  in-card overlays, not page chrome.
- **Preload meter survives tab switches**: switching to
  Favorites/Trending used to zero the meter because `loadTrending`
  reset the counters on every fresh load. Preload progress is now kept
  per view (Search, Trending, Favorites) and restored on the way back;
  a new search still zeroes the meter, as before. Accounting rules
  (sample-cost charging etc.) are unchanged.
- **WallpaperCave transient failures (Pages site) — deliberately no
  automatic retry**: the 10/19 first-pass failures all recovered on a
  tab-switch re-render, and a staggered retry would only add a second
  burst to a host that just throttled the first. Recovery stays manual
  (per-card Retry) or via any view switch, which discards and rebuilds
  the cards fresh. (A same-items re-render reuses the card nodes by
  design, so it does not re-attempt a failed thumb.)
- QA harness 243 checks (223 + 20 new Group V), optimizer all green.

## Changes in v5.6 (round 2 — Wallhaven-inspired redesign, 2026-11-16 — pushed as e651e5e8)

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
  fill in from a full load — it stays "size unknown".
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
