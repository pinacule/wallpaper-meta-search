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

async function fetchHtml(url) {
  const { text, via } = await ProxyClient.fetchText(url, proxySettings());
  lastVia = via;
  if (text.length < 500) throw new Error(`empty response from ${new URL(url).hostname}`);
  return text;
}

const absUrl = (base, rel) => new URL(rel, base).href;
const cap40 = (arr) => arr.slice(0, 40);

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (seen.has(it.page)) return false;
    seen.add(it.page);
    return true;
  });
}

const EXTRA_SOURCES = {
  // wallpapers.com — /search/<query> 301-redirects to a /<slug> listing page
  // (fetch follows it). Each result: <a href="/wallpapers/<slug>.html"> with a
  // thumbnail at /images/thumbnail/<slug>.jpg; the full image is the same slug
  // under /images/hd/ (verified: both return HTTP 200). No resolution shown.
  async wallpapersdotcom(q) {
    const html = await fetchHtml(`https://wallpapers.com/search/${encodeURIComponent(q)}`);
    const out = [];
    const re = /<a[^>]+href="(\/wallpapers\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && out.length < 40) {
      const inner = /(?:data-src|src)="(https:\/\/wallpapers\.com\/images\/thumbnail\/[^"]+)"/.exec(m[2]);
      if (!inner) continue;
      const thumb = inner[1];
      out.push({
        thumb,
        full: thumb.replace("/images/thumbnail/", "/images/hd/"),
        page: absUrl("https://wallpapers.com", m[1]),
        width: 0, height: 0, source: "Wallpapers.com",
      });
    }
    const items = dedupe(out);
    if (!items.length) throw new Error("no results parsed from Wallpapers.com");
    return cap40(items);
  },

  // WallpaperCave — /search?q= is a category hub, not wallpapers. The adapter
  // opens the first category whose slug contains a word from the query
  // (e.g. /code-geass-wallpapers), then parses its items: each has
  // <a href="/w/<id>" class="wpinkw"><img src="/wp/<id>.jpg"
  // width="<w>" height="<h>" — the img IS the full image, with real resolution.
  async wallpapercave(q) {
    const searchHtml = await fetchHtml(`https://wallpapercave.com/search?q=${encodeURIComponent(q)}`);
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const cats = [...searchHtml.matchAll(/<a[^>]+href="(\/[a-z0-9-]+-wallpapers)"/g)]
      .map((m) => m[1]);
    const cat = cats.find((c) => words.some((w) => c.includes(w))) || cats[0];
    if (!cat) throw new Error("no matching category on WallpaperCave search page");
    const html = await fetchHtml(absUrl("https://wallpapercave.com", cat));
    const out = [];
    const re = /<a href="(\/w\/[^"]+)" class="wpinkw">[\s\S]*?<img src="(\/wp\/[^"]+)" width="(\d+)" height="(\d+)"/g;
    let m;
    while ((m = re.exec(html)) && out.length < 40) {
      out.push({
        thumb: absUrl("https://wallpapercave.com", m[2]),
        full: absUrl("https://wallpapercave.com", m[2]),
        page: absUrl("https://wallpapercave.com", m[1]),
        width: parseInt(m[3], 10), height: parseInt(m[4], 10),
        source: "WallpaperCave",
      });
    }
    const items = dedupe(out);
    if (!items.length) throw new Error("no results parsed from WallpaperCave category page");
    return cap40(items);
  },

  // AlphaCoders — the documented API is dead (see header), so this scrapes the
  // HTML search page instead: wall.alphacoders.com/search.php?search=<q>
  // 302-redirects to alphacoders.com/<slug>. Results link to
  // wall.alphacoders.com/big.php?i=<id> with thumbs at
  // images*.alphacoders.com/<dir>/thumb-350-<id>.* (and thumb-440). The grid
  // does NOT include thumb-1920 links — the full image is the same URL with
  // the "thumb-<size>-" prefix stripped (verified: HTTP 200, e.g. 3.7 MB
  // original for id 775441). No API key needed any more.
  async alphacoders(q) {
    const html = await fetchHtml(`https://wall.alphacoders.com/search.php?search=${encodeURIComponent(q)}`);
    const perId = new Map(); // id -> [thumb urls]
    for (const m of html.matchAll(/https:\/\/images\d*\.alphacoders\.com\/\d+\/thumb-(?:350|440|1920)-(\d+)\.(jpg|png|webp)/g)) {
      const arr = perId.get(m[1]) || [];
      arr.push(m[0]);
      perId.set(m[1], arr);
    }
    const ids = [...new Set([...html.matchAll(/big\.php\?i=(\d+)/g)].map((m) => m[1]))];
    const out = [];
    for (const id of ids) {
      const urls = perId.get(id) || [];
      // Prefer a jpg/png thumb as the base: webp is a derived format and the
      // original file is not stored as .webp (a .webp full URL 404s).
      const base = urls.find((u) => /\.(jpg|png)$/.test(u)) || urls[0];
      if (!base) continue;
      const thumb = urls.find((u) => /thumb-350-/.test(u) && /\.(jpg|png)$/.test(u)) || base;
      out.push({
        thumb,
        full: base.replace(/\/thumb-(?:350|440|1920)-/, "/").replace(/\.webp$/, ".jpg"),
        page: `https://wall.alphacoders.com/big.php?i=${id}`,
        width: 0, height: 0, source: "AlphaCoders",
      });
      if (out.length >= 40) break;
    }
    if (!out.length) throw new Error("no results parsed from AlphaCoders");
    return out;
  },

  // Zerochan — search page lists <li data-id="<id>"> items with a lazy thumb
  // (data-src https://s3.zerochan.net/240/...avif), a full-image download link
  // (https://static.zerochan.net/<tags>.full.<id>.<ext>) and the resolution in
  // the thumb's title attribute ("2716×1920 ..."). Note: Zerochan serves a
  // "Checking browser..." challenge to some direct requests; going through
  // the proxy returns the real page (verified 2026-11-15).
  async zerochan(q) {
    const html = await fetchHtml(`https://www.zerochan.net/search?q=${encodeURIComponent(q)}`);
    const out = [];
    const liRe = /<li[^>]+data-id="(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = liRe.exec(html)) && out.length < 40) {
      const id = m[1];
      const block = m[2];
      const thumb = /(?:data-src|src)="(https:\/\/s3\.zerochan\.net\/240\/[^"]+)"/.exec(block);
      const full = /href="(https:\/\/static\.zerochan\.net\/[^"]+\.full\.\d+\.\w+)"/.exec(block);
      if (!thumb || !full) continue;
      const res = /title="(\d+)&#10005;(\d+)/.exec(block);
      out.push({
        thumb: thumb[1],
        full: full[1],
        page: `https://www.zerochan.net/${id}`,
        width: res ? parseInt(res[1], 10) : 0,
        height: res ? parseInt(res[2], 10) : 0,
        source: "Zerochan",
      });
    }
    const items = dedupe(out);
    if (!items.length) throw new Error("no results parsed from Zerochan (it may be showing its browser check)");
    return cap40(items);
  },
};

// Self-wire into app.js: register the adapters (overwriting the dead
// AlphaCoders API adapter) and drop the now-inline sites from the link-only list.
Object.assign(SOURCES, EXTRA_SOURCES);
for (const name of ["Wallpapers.com", "WallpaperCave", "AlphaCoders", "Zerochan"]) {
  const i = SITE_LINKS.findIndex(([n]) => n === name);
  if (i >= 0) SITE_LINKS.splice(i, 1);
}
