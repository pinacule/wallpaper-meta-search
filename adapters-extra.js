// adapters-extra.js — HTML-scraping adapters for wallpaper sites with no working
// open API. Loads AFTER app.js and self-registers into the global SOURCES object
// (overwriting the dead AlphaCoders API adapter) and removes the newly inline
// sites from the global SITE_LINKS array. Script order in index.html matters:
//   <script src="app.js"></script>
//   <script src="adapters-extra.js"></script>
//
// How they work: each adapter fetches the site's own public search page through
// the app's proxy chain (ProxyClient.fetchText, same chain as the API sources
// — local proxy first, then the user's Worker, then public fallbacks) — one
// request per search (WallpaperCave: search page + up to 3 matching
// categories, fetched concurrently; the local-proxy fast path is a single
// request), the same as opening the page in a browser. No credentials, no
// scraping of login-walled pages, no bulk crawling. See README for per-site status.
//
// Verified live 2026-11-15 (see README "Source status"). AlphaCoders' documented
// API (wall.alphacoders.com/api2.0/get.php) returns nginx 404 on every variant
// tested, so AlphaCoders is scraped from its HTML search page instead — no API
// key needed any more.
"use strict";

// Returns { text, via } — `via` names the proxy that served the page
// (see app.js: it is per-call, never a shared global, so parallel source
// fetches can't overwrite each other's label).
async function fetchHtml(url) {
  const { text, via } = await ProxyClient.fetchText(url, proxySettings());
  if (text.length < 500) throw new Error(`empty response from ${new URL(url).hostname}`);
  return { text, via };
}

// Root-relative hrefs ("/wallpapers/x.html") are every call site's input
// — all scraped hrefs start with a slash. Plain concatenation gives exactly
// what new URL(rel, base) returns for those, without the parser (~0.30 ms
// per search saved across ~240 calls, measured in node). Anything else
// (absolute URL, or a rel with characters the parser would percent-encode
// — non-ASCII, braces, backtick, pipe, caret, backslash, space, angle
// brackets, quotes) falls back to URL parsing, so behaviour is identical.
const absUrl = (base, rel) =>
  (rel.startsWith("/") && /^[\x21-\x7E]+$/.test(rel) && !/[<>"`{}|^\\]/.test(rel) ? base + rel : new URL(rel, base).href);
const cap80 = (arr) => arr.slice(0, 80);

// Min-res hidden count for the scrapers (same pattern as Safebooru in
// app.js): count the fetched items with known dimensions that the filter
// hides. Items with unknown dimensions (0x0 — Wallpapers.com always,
// AlphaCoders/Zerochan when the listing omits them) pass the filter and
// are never counted. Scope is "checked" — only among the pages actually
// fetched, so the true total may be larger (the pill shows "N+").
function markHidden(items) {
  const m = minRes();
  items.hidden = m ? items.filter((r) => !passesMinRes(r, m)).length : 0;
  items.hiddenScope = "checked";
  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (seen.has(it.page)) return false;
    seen.add(it.page);
    return true;
  });
}

// Round-robin interleave of several item lists: first item of each list,
// then second, and so on — so no single list fills a cap on its own.
// (Same reason the app's Best sort interleaves by source.)
function interleave(lists) {
  const out = [];
  let more = true;
  for (let i = 0; more; i++) {
    more = false;
    for (const list of lists) {
      if (i < list.length) { out.push(list[i]); more = true; }
    }
  }
  return out;
}

// WallpaperCave fetches at most this many matching categories per search:
// each category page holds up to 50 items, so 3 give up to 150 candidates
// — 3x the 50-item cap — while the fetches run concurrently, so the
// wall-clock cost is ~one slow public-proxy round-trip, not one per
// category. Beyond the first 3 matches the search page's relevance
// ordering falls off and the extra categories are increasingly off-topic.
const WALLPAPERCAVE_MAX_CATEGORIES = 3;

// Parse one Wallpapers.com listing page into items (shared by page 1 and
// the ?p=2 follow-up — see wallpapersdotcom below).
function parseWallpapersCom(html) {
  const out = [];
  const re = /<a[^>]+href="(\/wallpapers\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 80) {
    const inner = /(?:data-src|src)="(https:\/\/wallpapers\.com\/images\/thumbnail\/[^"]+)"/.exec(m[2]);
    if (!inner) continue;
    const thumb300 = inner[1];
    const high = /https:\/\/wallpapers\.com\/images\/high\/[^" ]+\.jpg/.exec(m[2]);
    const thumb = high ? high[0] : thumb300;
    const dims = /width="(\d+)"\s*height="(\d+)"/.exec(m[2]);
    out.push({
      thumb,
      full: thumb300.replace("/images/thumbnail/", "/images/hd/"),
      // Fallback: the thumbnail itself, if the /images/hd/ file won't load.
      alts: [thumb],
      // The /images/hd/ files are multi-MB and their CDN stalls past the
      // probe timeout on some connections; a card only needs the 900 px
      // thumbnail (the full file is still one click away). See thumbOnly in
      // app.js loadFullImage.
      thumbOnly: true,
      page: absUrl("https://wallpapers.com", m[1]),
      width: 0, height: 0,
      ratioW: dims ? parseInt(dims[1], 10) : 0,
      ratioH: dims ? parseInt(dims[2], 10) : 0,
      source: "Wallpapers.com",
      date: null, // search pages show no date — dateless in Newest sort
      score: null, // no popularity number on the page — unscored in Best sort
    });
  }
  return out;
}

// Parse a WallpaperCave category page into up to 50 items (deduped) —
// the page holds 50, and there is no pagination link to follow.
function parseWallpaperCaveCategory(html) {
  const out = [];
  const re = /<a href="(\/w\/[^"]+)" class="wpinkw">[\s\S]*?<img src="(\/wp\/[^"]+)" width="(\d+)" height="(\d+)"/g;
  let m;
  while ((m = re.exec(html)) && out.length < 50) {
    out.push({
      thumb: absUrl("https://wallpapercave.com", m[2]),
      full: absUrl("https://wallpapercave.com", m[2]),
      // No alternate: the grid image IS the full image, so there is
      // nothing else to fall back to — a failed card is removed instead.
      alts: [],
      page: absUrl("https://wallpapercave.com", m[1]),
      width: parseInt(m[3], 10), height: parseInt(m[4], 10),
      source: "WallpaperCave",
      date: null, // category pages show no date — dateless in Newest sort
      score: null, // no popularity number on the page — unscored in Best sort
    });
  }
  return dedupe(out).slice(0, 50);
}

// Parse one Zerochan search/tag page into `out` (shared by page 1 and
// the tag page's ?p=2 — see zerochan below).
function parseZerochanPage(html, out) {
  const liRe = /<li[^>]+data-id="(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) && out.length < 80) {
    const id = m[1];
    const block = m[2];
    const thumb = /(?:data-src|src)="(https:\/\/s3\.zerochan\.net\/240\/[^"]+)"/.exec(block);
    const full = /href="(https:\/\/static\.zerochan\.net\/[^"]+\.full\.\d+\.\w+)"/.exec(block);
    if (!thumb || !full) continue;
    const res = /title="(\d+)&#10005;(\d+)/.exec(block);
    out.push({
      thumb: thumb[1],
      full: full[1],
      // Fallback: the 240px thumb from s3 — a different host than the
      // full image, so a block on one doesn't necessarily kill the other.
      alts: [thumb[1]],
      page: `https://www.zerochan.net/${id}`,
      width: res ? parseInt(res[1], 10) : 0,
      height: res ? parseInt(res[2], 10) : 0,
      source: "Zerochan",
      date: null, // search pages show no date — dateless in Newest sort
      score: null, // no popularity number on the page — unscored in Best sort
    });
  }
  return out;
}

// Fetch one Wallpapers.com listing page and parse it; returns
// { items, nextUrl, via, html } where nextUrl is the paginator link to the
// smallest page after this one, or null when the listing ends here.
// Shared by the initial fetch (page 1 + its ?p=2 follow-up) and load more
// (page 3+). The page number comes from the URL itself (?p=N, default 1).
async function fetchWallpapersComPage(url) {
  const { text: html, via } = await fetchHtml(url);
  const items = parseWallpapersCom(html);
  const cur = /[?&]p=(\d+)/.exec(url);
  const curPage = cur ? parseInt(cur[1], 10) : 1;
  let nextUrl = null, nextPage = Infinity;
  for (const m of html.matchAll(/href="(\/[^"?]+\?p=(\d+))"/g)) {
    const n = parseInt(m[2], 10);
    if (n > curPage && n < nextPage) { nextPage = n; nextUrl = m[1]; }
  }
  return { items, nextUrl, via, html };
}

// Parse ONE AlphaCoders search page (page 1's search.php or a search/view
// page) into items. Shared by the initial fetch (pages 1+2) and load more
// (page 3+). The dims/perId/id maps are per page: an item's microdata and
// thumbs live in the same item block, so a page is self-contained —
// parsing pages separately and concatenating (deduped by page URL) gives
// the same items in the same order as the old cross-page maps.
function parseAlphaCodersPage(pageHtml) {
  const dims = new Map(); // id -> { w, h, fmt }
  for (const dm of pageHtml.matchAll(/big\.php\?i=(\d+)"[\s\S]{0,900}?<meta itemprop="width" content="(\d+)">\s*<meta itemprop="height" content="(\d+)">(?:\s*<meta itemprop="fileFormat" content="(\w+)">)?/g)) {
    dims.set(dm[1], { w: +dm[2], h: +dm[3], fmt: (dm[4] || "jpg").toLowerCase() });
  }
  const perId = new Map(); // id -> [thumb urls]
  for (const m of pageHtml.matchAll(/https:\/\/images\d*\.alphacoders\.com\/\d+\/thumb-(?:350|440|1920)-(\d+)\.(jpg|png|webp)/g)) {
    const arr = perId.get(m[1]) || [];
    arr.push(m[0]);
    perId.set(m[1], arr);
  }
  const ids = [...new Set([...pageHtml.matchAll(/big\.php\?i=(\d+)/g)].map((m) => m[1]))];
  const out = [];
  for (const id of ids) {
    const urls = perId.get(id) || [];
    // Prefer a jpg/png thumb as the base: webp is a derived format and the
    // original file is not stored as .webp (a .webp full URL 404s).
    const base = urls.find((u) => /\.(jpg|png)$/.test(u)) || urls[0];
    if (!base) continue;
    const thumb = urls.find((u) => /thumb-350-/.test(u) && /\.(jpg|png)$/.test(u)) || base;
    const d = dims.get(id);
    let full;
    const alts = [];
    if (d) {
      // True extension known — no guessing, no .png alternate needed.
      full = base.replace(/\/thumb-(?:350|440|1920)-/, "/").replace(/\.\w+$/, `.${d.fmt}`);
    } else {
      full = base.replace(/\/thumb-(?:350|440|1920)-/, "/").replace(/\.webp$/, ".jpg");
      // Fallback for the same image, full-res first: if the thumb was .webp
      // the original was guessed as .jpg, but it may actually be .png — try
      // that before dropping to the small thumb.
      if (/\.webp$/.test(base)) alts.push(full.replace(/\.jpg$/, ".png"));
    }
    if (thumb !== full) alts.push(thumb);
    out.push({
      thumb,
      full,
      alts,
      page: `https://wall.alphacoders.com/big.php?i=${id}`,
      width: d ? d.w : 0, height: d ? d.h : 0, source: "AlphaCoders",
      date: null, // search pages show no date — dateless in Newest sort
      score: null, // no popularity number on the page — unscored in Best sort
    });
    if (out.length >= 80) break;
  }
  return out;
}

const EXTRA_SOURCES = {
  // wallpapers.com — /search/<query> 301-redirects to a /<slug> listing page
  // (fetch follows it). Each result: <a href="/wallpapers/<slug>.html"> with a
  // thumbnail at /images/thumbnail/<slug>.jpg; the full image is the same slug
  // under /images/hd/ (verified: both return HTTP 200). The listing does NOT
  // publish the full resolution anywhere — but each result's <img> carries
  // width/height of the thumbnail, which preserves the full image's aspect
  // ratio, so the card's box is right from the start (ratioW/ratioH, not
  // width/height — the badge shows that ratio ("16:9") instead of a pixel
  // size it doesn't know; see ratioLabel in app.js. The full's real pixels
  // are never loaded in-grid for these thumbOnly cards, so the ratio badge
  // is the honest end state, not a placeholder).
  // The listing also offers a 900w /images/high/ variant: that is the thumb
  // now, instead of the 300w thumbnail — visibly crisper in the grid.
  async wallpapersdotcom(q, opts = {}) {
    q = formatQueryFor("wallpapersdotcom", q);
    // Load more (round 8): opts.cursor is the next listing-page URL
    // (a /<slug>?p=N link from the previous page). One page per click;
    // the paginator link on the fetched page is the next cursor, and a
    // page with no paginator link is the last one. The cursor is the
    // ABSOLUTE url — fetchHtml can't fetch a bare path.
    if (opts.more) {
      const page = await fetchWallpapersComPage(opts.cursor);
      const items = cap80(dedupe(page.items));
      items.nextCursor = page.nextUrl ? absUrl("https://wallpapers.com", page.nextUrl) : null;
      items.exhausted = !page.nextUrl;
      items.via = page.via;
      return items;
    }
    const page1 = await fetchWallpapersComPage(`https://wallpapers.com/search/${encodeURIComponent(q)}`);
    const { html, via } = page1;
    const out = page1.items;
    // Second page: the listing paginates on its own slug URL (?p=2, e.g.
    // /code-geass?p=2 — verified live: the paginator links there, while
    // ?p=2 on /search itself is ignored and returns page 1 again). The
    // page-1 HTML carries the link, so follow it when present; a failed
    // page-2 fetch just leaves the page-1 results standing.
    let nextUrl = null;
    if (out.length && page1.nextUrl) {
      try {
        const page2 = await fetchWallpapersComPage(absUrl("https://wallpapers.com", page1.nextUrl));
        out.push(...page2.items);
        nextUrl = page2.nextUrl;
      } catch { /* page 2 is a bonus */ }
    }
    const items = cap80(dedupe(out));
    if (!items.length) {
      // A genuine search page with an empty grid (verified live 2026-11-15:
      // /search/catgirl returns HTTP 200, title "Search results for
      // 'catgirl'", body class "search-results", zero result anchors) is
      // not a parse failure — return it marked empty so the status pill
      // says "0 found" in green instead of going red. If the page isn't a
      // search-results page at all, the markup probably changed — fail
      // honestly so a real breakage still shows up as an error.
      if (/Search results for|class="[^"]*search-results/.test(html)) {
        items.empty = true;
        items.nextCursor = null;
        items.exhausted = true;
        items.via = via;
        return markHidden(items);
      }
      throw new Error("no results parsed from Wallpapers.com");
    }
    items.nextCursor = nextUrl ? absUrl("https://wallpapers.com", nextUrl) : null;
    items.exhausted = !nextUrl;
    items.via = via;
    return markHidden(items);
  },

  // WallpaperCave — /search?q= is a category hub, not wallpapers. The adapter
  // opens the top matching categories (up to WALLPAPERCAVE_MAX_CATEGORIES)
  // whose slug contains a word from the query (e.g. /code-geass-wallpapers),
  // fetches them concurrently, and merges the items (round-robin interleave,
  // deduped, capped at 50): each has
  // <a href="/w/<id>" class="wpinkw"><img src="/wp/<id>.jpg"
  // width="<w>" height="<h>" — the img IS the full image, with real resolution.
  // One category failing leaves the others standing (the page-2 pattern);
  // all failing fails honestly. Fallback: corsfix 503s the search page in
  // bursts, and allorigins 522s it — but allorigins DOES serve category
  // pages (200, ~7s, verified 2026-11-15). So if the search page can't be
  // fetched (or lists no category), guess the category URL directly from the
  // query: /<query-slug>-wallpapers. If the guess 404s, the adapter fails
  // honestly like before. A search matching no category still opens the
  // first listed category, as before.
  async wallpapercave(q) {
    q = formatQueryFor("wallpapercave", q);
    const slug = q.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    // Fast path: guess the category URL from the query ("/code-geass-wallpapers").
    // Most one-topic queries land here and skip the search-page fetch entirely
    // (one request instead of two — the search page is ~400 KB through the
    // proxy chain). Local proxy ONLY, one direct fetch, no chain walk: a
    // wrong guess 404s in ~0.5 s and falls through to the search page, and
    // when the proxy is down the guess is skipped entirely (a chain walk
    // through the slow public proxies would cost more than the fetch saves).
    // NOTE: an earlier version of this fast path used fetchHtml (full chain)
    // — a wrong guess then walked every public proxy with 20 s timeouts,
    // adding ~90 s before the fallback ran. Never chain-walk a guess.
    if (slug && localProxyUp && pageIsHttp) {
      try {
        const res = await fetch(ProxyClient.LOCAL_PROXY + encodeURIComponent(absUrl("https://wallpapercave.com", `/${slug}-wallpapers`)));
        if (res.ok) {
          const items = parseWallpaperCaveCategory(await res.text());
          if (items.length) { items.nextCursor = null; items.exhausted = true; items.via = "local proxy"; return markHidden(items); }
        }
        // Not ok, or no items: fall through to the search page below.
      } catch {
        // Local proxy fetch failed — fall through to the search page.
      }
    }
    let cats = [];
    try {
      const { text: searchHtml } = await fetchHtml(`https://wallpapercave.com/search?q=${encodeURIComponent(q)}`);
      cats = [...searchHtml.matchAll(/<a[^>]+href="(\/[a-z0-9-]+-wallpapers)"/g)]
        .map((m) => m[1]);
    } catch {
      cats = []; // search page unreachable — fall through to the slug guess
    }
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const matching = cats.filter((c) => words.some((w) => c.includes(w)));
    if (matching.length > 1) {
      // Multi-category: the top matches, fetched concurrently — the
      // wall-clock cost is ~one slow public-proxy round-trip, not one per
      // category. A single category failing leaves the others standing
      // (same tolerance as the page-2 fetches elsewhere); all failing fails
      // honestly with the first error.
      const chosen = matching.slice(0, WALLPAPERCAVE_MAX_CATEGORIES);
      const settled = await Promise.allSettled(
        chosen.map((cat) => fetchHtml(absUrl("https://wallpapercave.com", cat))));
      const lists = [];
      let via = null;
      let firstError = null;
      for (const s of settled) {
        if (s.status === "fulfilled") {
          if (via === null) via = s.value.via;
          lists.push(parseWallpaperCaveCategory(s.value.text));
        } else if (firstError === null) {
          firstError = s.reason;
        }
      }
      // Round-robin interleave, not concatenation: a full first category
      // (50 items) would otherwise fill the cap on its own and the other
      // categories would contribute nothing. Dedupe (the same wallpaper can
      // sit in two categories) and cap at 50, as before.
      const items = dedupe(interleave(lists)).slice(0, 50);
      if (items.length) { items.via = via; return markHidden(items); }
      if (firstError) throw firstError;
      throw new Error("no results parsed from WallpaperCave category page");
    }
    let cat = matching[0] || cats[0] || null;
    if (!cat) {
      if (!slug) throw new Error("no matching category on WallpaperCave search page");
      cat = `/${slug}-wallpapers`;
    }
    const { text: html, via } = await fetchHtml(absUrl("https://wallpapercave.com", cat));
    const items = parseWallpaperCaveCategory(html);
    if (!items.length) throw new Error("no results parsed from WallpaperCave category page");
    // No pagination: the category page holds 50 with no link to follow
    // (see above) — exhausted from the start, no `more` entry.
    items.nextCursor = null;
    items.exhausted = true;
    items.via = via;
    return markHidden(items);
  },

  // AlphaCoders — the documented API is dead (see header), so this scrapes the
  // HTML search page instead: wall.alphacoders.com/search.php?search=<q>
  // 302-redirects to alphacoders.com/<slug>. Results link to
  // wall.alphacoders.com/big.php?i=<id> with thumbs at
  // images*.alphacoders.com/<dir>/thumb-350-<id>.* (and thumb-440). The grid
  // does NOT include thumb-1920 links — the full image is the same URL with
  // the "thumb-<size>-" prefix stripped (verified: HTTP 200, e.g. 3.7 MB
  // original for id 775441). No API key needed any more.
  // The listing DOES carry the real dimensions: each item embeds schema.org
  // microdata (<meta itemprop="width" content="1920">, height, fileFormat)
  // right after its big.php link — so width/height are real here, and the
  // full URL uses the true file extension instead of guessing .jpg/.png.
  async alphacoders(q, opts = {}) {
    q = formatQueryFor("alphacoders", q);
    // Load more (round 8): page 3+ through the same infinite-scroll
    // endpoint as page 2. One page per click; an empty page is the last
    // one (the endpoint has no total count to read).
    if (opts.more) {
      const { text: html, via } = await fetchHtml(
        `https://alphacoders.com/search/view?q=${encodeURIComponent(q)}&page=${opts.startPage}&quickload=1`);
      const items = cap80(dedupe(parseAlphaCodersPage(html)));
      items.nextCursor = items.length ? opts.startPage + 1 : null;
      items.exhausted = !items.length;
      items.via = via;
      return markHidden(items);
    }
    // Pages 2-4: the search page infinite-scrolls via
    // alphacoders.com/search/view?q=<q>&page=N&quickload=1 (verified live
    // 2026-11-15: returns new items in the same markup; the plain
    // search.php?page=2 returns page 1 again). Its URL is built from the
    // query alone — unlike Wallpapers.com / Zerochan, whose page 2 needs a
    // link from page 1 — so all pages fetch concurrently instead of
    // sequentially: one round-trip saved per search (measured in node:
    // ~250 ms at local-proxy speed, up to ~20 s on the slow public
    // proxies). allSettled: page 1 still throws if it fails (the other
    // pages' results are then ignored — wasted fetches in that failure
    // case), and a failed later page still just leaves the earlier
    // results standing. Round 10: pages 3+4 ride along concurrently (the
    // same search/view endpoint load more already uses) — AlphaCoders was
    // a small source in the user's "cyberpunk" search (15 from 2 pages),
    // and more pages are the only way to give it a fair slice. Pages are
    // processed in order and stop at the first failed page (the cursor
    // points at it, so load more retries it); a page that succeeds is
    // used even if a later one fails.
    const [p1, p2, p3, p4] = await Promise.allSettled([
      fetchHtml(`https://wall.alphacoders.com/search.php?search=${encodeURIComponent(q)}`),
      fetchHtml(`https://alphacoders.com/search/view?q=${encodeURIComponent(q)}&page=2&quickload=1`),
      fetchHtml(`https://alphacoders.com/search/view?q=${encodeURIComponent(q)}&page=3&quickload=1`),
      fetchHtml(`https://alphacoders.com/search/view?q=${encodeURIComponent(q)}&page=4&quickload=1`),
    ]);
    if (p1.status === "rejected") throw p1.reason;
    const { text: html, via } = p1.value;
    const pages = [html];
    let nextCursor = 5;
    for (const [page, res] of [[2, p2], [3, p3], [4, p4]]) {
      if (res.status === "rejected") { nextCursor = page; break; }
      pages.push(res.value.text);
      nextCursor = page + 1;
    }
    const out = cap80(dedupe(pages.flatMap((pageHtml) => parseAlphaCodersPage(pageHtml))));
    if (!out.length) throw new Error("no results parsed from AlphaCoders");
    // Load-more cursor: the next page not yet PROCESSED (a failed page is
    // retried on load more instead of being skipped). Whether the last
    // fetched page is the last one can't be told from here — the first
    // load-more fetch that comes back empty marks the source exhausted.
    out.nextCursor = nextCursor;
    out.exhausted = false;
    out.via = via;
    return markHidden(out);
  },

  // Zerochan — search page lists <li data-id="<id>"> items with a lazy thumb
  // (data-src https://s3.zerochan.net/240/...avif), a full-image download link
  // (https://static.zerochan.net/<tags>.full.<id>.<ext>) and the resolution in
  // the thumb's title attribute ("2716×1920 ..."). Note: Zerochan serves a
  // "Checking browser..." challenge to some direct requests; going through
  // the proxy returns the real page (verified 2026-11-15).
  async zerochan(q, opts = {}) {
    q = formatQueryFor("zerochan", q);
    // Load more (round 8): opts.cursor is the next tag-page URL (with
    // ?p=N baked in). One page per click; an empty page is the last one.
    // The next cursor is the same URL with N+1 — the tag page's own
    // pagination, no link to follow.
    if (opts.more) {
      const { text: html2, via: via2 } = await fetchHtml(opts.cursor);
      const batch = [];
      parseZerochanPage(html2, batch);
      const capped = cap80(dedupe(batch));
      const m = /[?&]p=(\d+)/.exec(opts.cursor);
      const page = m ? parseInt(m[1], 10) : 2;
      capped.nextCursor = capped.length
        ? opts.cursor.replace(/([?&]p=)\d+/, `$1${page + 1}`) : null;
      capped.exhausted = !capped.length;
      capped.via = via2;
      return markHidden(capped);
    }
    const { text: html, via } = await fetchHtml(`https://www.zerochan.net/search?q=${encodeURIComponent(q)}`);
    const out = [];
    parseZerochanPage(html, out);
    // Pages 2-4: search redirects to a tag page (the canonical link,
    // e.g. /Nekomimi), and ?p=N works THERE — ?p=2 on /search itself is
    // ignored and returns page 1 again (verified live 2026-11-15:
    // /Nekomimi?p=2 returned 48 new ids, 0 overlap). Round 10: fetch
    // pages 2, 3 and 4 concurrently (their URLs are all derivable from
    // the canonical once page 1 returns it) — Zerochan was the smallest
    // source in the user's "cyberpunk" search (17 from 2 pages at a ~21%
    // min-res pass rate), and more pages are the only way to give it a
    // fair slice. Pages are processed in order and stop at the first
    // failed page (the cursor points at it, so load more retries it); a
    // page that succeeds is used even if a later one fails.
    let nextCursor = null;
    const canon = /<link rel="canonical" href="(https:\/\/www\.zerochan\.net\/[^"]+)"/.exec(html);
    if (canon && !/\/search/.test(canon[1])) {
      const sep = canon[1].includes("?") ? "&" : "?";
      const pageUrl = (n) => `${canon[1]}${sep}p=${n}`;
      const settled = await Promise.allSettled([2, 3, 4].map((n) => fetchHtml(pageUrl(n))));
      for (let i = 0; i < settled.length; i++) {
        const n = i + 2;
        const s = settled[i];
        if (s.status === "rejected") { nextCursor = pageUrl(n); break; }
        parseZerochanPage(s.value.text, out);
        nextCursor = pageUrl(n + 1);
      }
    }
    const items = dedupe(out);
    if (!items.length) throw new Error("no results parsed from Zerochan (it may be showing its browser check)");
    const capped = cap80(items);
    capped.nextCursor = nextCursor;
    capped.exhausted = !nextCursor;
    capped.via = via;
    return markHidden(capped);
  },
};

// Load more (round 8): the scrapers' `more` entries, same shape as the
// API sources' in app.js — one further page from the cursor the initial
// fetch returned. WallpaperCave has none (no pagination). The cursor is
// the next page URL for Wallpapers.com / Zerochan, a page number for
// AlphaCoders.
EXTRA_SOURCES.wallpapersdotcom.more = (q, cursor) => EXTRA_SOURCES.wallpapersdotcom(q, { cursor, more: true });
EXTRA_SOURCES.zerochan.more = (q, cursor) => EXTRA_SOURCES.zerochan(q, { cursor, more: true });
EXTRA_SOURCES.alphacoders.more = (q, cursor) => EXTRA_SOURCES.alphacoders(q, { startPage: cursor, more: true });

// Self-wire into app.js: register the adapters (overwriting the dead
// AlphaCoders API adapter) and drop the now-inline sites from the link-only list.
Object.assign(SOURCES, EXTRA_SOURCES);
for (const name of ["Wallpapers.com", "WallpaperCave", "AlphaCoders", "Zerochan"]) {
  const i = SITE_LINKS.findIndex(([n]) => n === name);
  if (i >= 0) SITE_LINKS.splice(i, 1);
}
