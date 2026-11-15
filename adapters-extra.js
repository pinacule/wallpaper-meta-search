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
// request per search (WallpaperCave: two, search page + first matching
// category), the same as opening the page in a browser. No credentials, no
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
// (absolute URL, or a rel with characters the parser would percent-encode)
// falls back to URL parsing, so behaviour is identical.
const absUrl = (base, rel) =>
  (rel.startsWith("/") && !/[\s<>"]/.test(rel) ? base + rel : new URL(rel, base).href);
const cap80 = (arr) => arr.slice(0, 80);

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (seen.has(it.page)) return false;
    seen.add(it.page);
    return true;
  });
}

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

const EXTRA_SOURCES = {
  // wallpapers.com — /search/<query> 301-redirects to a /<slug> listing page
  // (fetch follows it). Each result: <a href="/wallpapers/<slug>.html"> with a
  // thumbnail at /images/thumbnail/<slug>.jpg; the full image is the same slug
  // under /images/hd/ (verified: both return HTTP 200). The listing does NOT
  // publish the full resolution anywhere — but each result's <img> carries
  // width/height of the thumbnail, which preserves the full image's aspect
  // ratio, so the card's box is right from the start (ratioW/ratioH, not
  // width/height — the badge honestly stays "size unknown" until the full
  // image loads and reports its real pixels, see imgLoaded in app.js).
  // The listing also offers a 900w /images/high/ variant: that is the thumb
  // now, instead of the 300w thumbnail — visibly crisper in the grid.
  async wallpapersdotcom(q) {
    q = formatQueryFor("wallpapersdotcom", q);
    const { text: html, via } = await fetchHtml(`https://wallpapers.com/search/${encodeURIComponent(q)}`);
    const out = parseWallpapersCom(html);
    // Second page: the listing paginates on its own slug URL (?p=2, e.g.
    // /code-geass?p=2 — verified live: the paginator links there, while
    // ?p=2 on /search itself is ignored and returns page 1 again). The
    // page-1 HTML carries the link, so follow it when present; a failed
    // page-2 fetch just leaves the page-1 results standing.
    if (out.length) {
      const pg2 = /href="(\/[^"?]+\?p=2)"/.exec(html);
      if (pg2) {
        try {
          const { text: html2 } = await fetchHtml(absUrl("https://wallpapers.com", pg2[1]));
          out.push(...parseWallpapersCom(html2));
        } catch { /* page 2 is a bonus */ }
      }
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
        items.via = via;
        return items;
      }
      throw new Error("no results parsed from Wallpapers.com");
    }
    items.via = via;
    return items;
  },

  // WallpaperCave — /search?q= is a category hub, not wallpapers. The adapter
  // opens the first category whose slug contains a word from the query
  // (e.g. /code-geass-wallpapers), then parses its items: each has
  // <a href="/w/<id>" class="wpinkw"><img src="/wp/<id>.jpg"
  // width="<w>" height="<h>" — the img IS the full image, with real resolution.
  // Fallback: corsfix 503s the search page in bursts, and allorigins 522s it
  // — but allorigins DOES serve category pages (200, ~7s, verified 2026-11-15).
  // So if the search page can't be fetched (or lists no category), guess the
  // category URL directly from the query: /<query-slug>-wallpapers. If the
  // guess 404s, the adapter fails honestly like before.
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
          if (items.length) { items.via = "local proxy"; return items; }
        }
        // Not ok, or no items: fall through to the search page below.
      } catch {
        // Local proxy fetch failed — fall through to the search page.
      }
    }
    let cat = null;
    try {
      const { text: searchHtml } = await fetchHtml(`https://wallpapercave.com/search?q=${encodeURIComponent(q)}`);
      const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const cats = [...searchHtml.matchAll(/<a[^>]+href="(\/[a-z0-9-]+-wallpapers)"/g)]
        .map((m) => m[1]);
      cat = cats.find((c) => words.some((w) => c.includes(w))) || cats[0] || null;
    } catch (e) {
      cat = null; // search page unreachable — fall through to the slug guess
    }
    if (!cat) {
      if (!slug) throw new Error("no matching category on WallpaperCave search page");
      cat = `/${slug}-wallpapers`;
    }
    const { text: html, via } = await fetchHtml(absUrl("https://wallpapercave.com", cat));
    const items = parseWallpaperCaveCategory(html);
    if (!items.length) throw new Error("no results parsed from WallpaperCave category page");
    items.via = via;
    return items;
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
  async alphacoders(q) {
    q = formatQueryFor("alphacoders", q);
    const { text: html, via } = await fetchHtml(`https://wall.alphacoders.com/search.php?search=${encodeURIComponent(q)}`);
    // Second page: the search page infinite-scrolls via
    // alphacoders.com/search/view?q=<q>&page=2&quickload=1 (verified live
    // 2026-11-15: returns new items in the same markup; the plain
    // search.php?page=2 returns page 1 again). A failed page-2 fetch just
    // leaves the page-1 results standing.
    const pages = [html];
    try {
      const { text: html2 } = await fetchHtml(`https://alphacoders.com/search/view?q=${encodeURIComponent(q)}&page=2&quickload=1`);
      pages.push(html2);
    } catch { /* page 2 is a bonus */ }
    const dims = new Map(); // id -> { w, h, fmt }
    for (const pageHtml of pages) {
      for (const dm of pageHtml.matchAll(/big\.php\?i=(\d+)"[\s\S]{0,900}?<meta itemprop="width" content="(\d+)">\s*<meta itemprop="height" content="(\d+)">(?:\s*<meta itemprop="fileFormat" content="(\w+)">)?/g)) {
        dims.set(dm[1], { w: +dm[2], h: +dm[3], fmt: (dm[4] || "jpg").toLowerCase() });
      }
    }
    const perId = new Map(); // id -> [thumb urls]
    for (const pageHtml of pages) {
      for (const m of pageHtml.matchAll(/https:\/\/images\d*\.alphacoders\.com\/\d+\/thumb-(?:350|440|1920)-(\d+)\.(jpg|png|webp)/g)) {
        const arr = perId.get(m[1]) || [];
        arr.push(m[0]);
        perId.set(m[1], arr);
      }
    }
    const ids = [...new Set(pages.flatMap((pageHtml) => [...pageHtml.matchAll(/big\.php\?i=(\d+)/g)].map((m) => m[1])))];
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
    if (!out.length) throw new Error("no results parsed from AlphaCoders");
    out.via = via;
    return out;
  },

  // Zerochan — search page lists <li data-id="<id>"> items with a lazy thumb
  // (data-src https://s3.zerochan.net/240/...avif), a full-image download link
  // (https://static.zerochan.net/<tags>.full.<id>.<ext>) and the resolution in
  // the thumb's title attribute ("2716×1920 ..."). Note: Zerochan serves a
  // "Checking browser..." challenge to some direct requests; going through
  // the proxy returns the real page (verified 2026-11-15).
  async zerochan(q) {
    q = formatQueryFor("zerochan", q);
    const { text: html, via } = await fetchHtml(`https://www.zerochan.net/search?q=${encodeURIComponent(q)}`);
    const out = [];
    parseZerochanPage(html, out);
    // Second page: search redirects to a tag page (the canonical link,
    // e.g. /Nekomimi), and ?p=2 works THERE — ?p=2 on /search itself is
    // ignored and returns page 1 again (verified live 2026-11-15:
    // /Nekomimi?p=2 returned 48 new ids, 0 overlap). A failed page-2
    // fetch just leaves the page-1 results standing.
    const canon = /<link rel="canonical" href="(https:\/\/www\.zerochan\.net\/[^"]+)"/.exec(html);
    if (canon && !/\/search/.test(canon[1])) {
      try {
        const sep = canon[1].includes("?") ? "&" : "?";
        const { text: html2 } = await fetchHtml(`${canon[1]}${sep}p=2`);
        parseZerochanPage(html2, out);
      } catch { /* page 2 is a bonus */ }
    }
    const items = dedupe(out);
    if (!items.length) throw new Error("no results parsed from Zerochan (it may be showing its browser check)");
    const capped = cap80(items);
    capped.via = via;
    return capped;
  },
};

// Self-wire into app.js: register the adapters (overwriting the dead
// AlphaCoders API adapter) and drop the now-inline sites from the link-only list.
Object.assign(SOURCES, EXTRA_SOURCES);
for (const name of ["Wallpapers.com", "WallpaperCave", "AlphaCoders", "Zerochan"]) {
  const i = SITE_LINKS.findIndex(([n]) => n === name);
  if (i >= 0) SITE_LINKS.splice(i, 1);
}
