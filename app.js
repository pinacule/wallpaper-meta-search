// Wallpaper Meta-Search — one query, several wallpaper sources, no server.
// Direct: Danbooru (sends CORS *). Via the proxy chain (proxy-client.js):
// Wallhaven, Safebooru, and the HTML-scraping adapters in adapters-extra.js.
// Gelbooru is link-only: its API returns 401 for anonymous requests
// (verified 2026-11-15 — the site is up, the dapi needs an account key).
// WallpaperAccess is link-only: Cloudflare 403s every fetch (verified 2026-11-15).
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// Whether the local proxy was up at the last probe (set by
// updateProxyStatus). Used for image URLs (route through it when up) and
// for honest failure pills (when down, a proxied source failing is most
// likely the missing proxy — see shortReason). Initial value false: the
// probe resolves in milliseconds on localhost, so by the time a search
// finishes it reflects reality.
let localProxyUp = false;
const pageIsHttp = typeof window !== "undefined" && window.location.protocol === "http:";

// Image hosts that genuinely need the local proxy. Everything else loads
// direct — spreading requests over the real CDN hosts (six connections
// each) instead of funnelling every image through localhost:8787, where the
// browser's six-connection cap made a couple of slow files starve every
// thumbnail behind them (black cards with only alt text, 2026-11-15).
// Zerochan stays proxied: its full images were observed stalling
// mid-download direct (HTTP 200, then nothing) while the proxy delivered
// them reliably. The proxy sends no Referer, so it also sidesteps
// Referer-based hotlink blocks for those two hosts.
// NOTE: the proxy does NOT change the egress IP, so it can't dodge an
// IP-based block (e.g. a CDN 403ing a datacenter/VPN IP).
const IMAGE_PROXY_HOSTS = new Set(["static.zerochan.net", "s3.zerochan.net"]);
function proxiedImageUrl(u) {
  if (!localProxyUp || !pageIsHttp || !u) return u;
  // Host check without `new URL()`: this runs 3x per card (thumb, full,
  // each alt), and URL parsing costs ~8µs a call — ~4ms per 159-card
  // render with the proxy up. Splitting on "/" gives the host at index 2
  // for absolute URLs; anything else (relative or malformed) has no host
  // there and loads direct, as before. Lowercased so an uppercase host
  // still matches, like URL.hostname would.
  const host = u.split("/")[2];
  if (!host || !IMAGE_PROXY_HOSTS.has(host.toLowerCase())) return u;
  return "http://localhost:8787/?url=" + encodeURIComponent(u);
}

// NOTE: there is deliberately NO shared "last proxy" global. An earlier
// version kept one (`lastVia`) and the parallel source fetches overwrote it,
// so the status pill could name the wrong proxy (e.g. "danbooru … via
// corsfix" for a source that never touches a proxy). Each fetch returns its
// own `via`, adapters attach it to their result array, and search() reads it
// from there.

// Sites without inline results: open their own search in a new tab.
const SITE_LINKS = [
  ["WallpaperAccess", (q) => `https://wallpaperaccess.com/search?q=${encodeURIComponent(q)}`],
  ["Gelbooru", (q) => `https://gelbooru.com/index.php?page=post&s=list&tags=${encodeURIComponent(formatQueryFor("gelbooru", q))}`],
  ["Wallhaven", (q) => `https://wallhaven.cc/search?q=${encodeURIComponent(q)}`],
  ["Google Images", (q) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q + " wallpaper")}`],
];

function proxySettings() {
  return {
    customProxy: $("#proxy").value.trim(),
    workerUrl: $("#worker-url").value.trim(),
  };
}
function loadSettings() {
  $("#proxy").value = localStorage.getItem("wms.proxy") || "";
  $("#worker-url").value = localStorage.getItem("wms.workerUrl") || "";
  // Purity: "safe" (default), "mixed" or "nsfw". Migrate the old #sfw
  // checkbox setting if it exists: wms.sfw=false meant "not safe-only" ->
  // mixed.
  let p = localStorage.getItem("wms.purity");
  if (!p) {
    const legacySfw = localStorage.getItem("wms.sfw");
    p = legacySfw === "false" ? "mixed" : "safe";
  }
  $("#purity").value = ["safe", "mixed", "nsfw"].includes(p) ? p : "safe";
  const dr = localStorage.getItem("wms.deviceRatio");
  $("#device-ratio").value = ["all", "pc", "ultrawide", "phone"].includes(dr) ? dr : "all";
  const limEl = $("#limit");
  if (limEl) {
    const lim = localStorage.getItem("wms.limit");
    limEl.value = ["50", "100", "150", "200", "0"].includes(lim) ? lim : "100";
  }
  const preloadEl = $("#data-preload");
  if (preloadEl) {
    const pv = localStorage.getItem("wms.preload");
    preloadEl.value = PRELOAD_VALUES.includes(pv) ? pv : String(PRELOAD_DEFAULT);
  }
  updatePreloadMeter();
  const whKeyEl = $("#wh-key");
  if (whKeyEl) whKeyEl.value = localStorage.getItem("wms.whKey") || "";
  setWallColor(wallColor());
  updateProxyStatus();
}
function saveSettings() {
  localStorage.setItem("wms.proxy", $("#proxy").value.trim());
  localStorage.setItem("wms.workerUrl", $("#worker-url").value.trim());
  localStorage.setItem("wms.purity", $("#purity").value);
  localStorage.setItem("wms.deviceRatio", $("#device-ratio").value);
  const limEl = $("#limit");
  if (limEl) localStorage.setItem("wms.limit", limEl.value);
  const preloadEl = $("#data-preload");
  if (preloadEl) localStorage.setItem("wms.preload", preloadEl.value);
  const whKeyEl = $("#wh-key");
  if (whKeyEl) localStorage.setItem("wms.whKey", whKeyEl.value.trim());
}

// Content mode: "safe" (default), "mixed" (safe + suggestive) or "nsfw"
// (explicit only). What each source does in NSFW mode is in the README's
// purity table — Danbooru works anonymously, Wallhaven needs an API key,
// Safebooru has nothing, the scraped sites have no filter at all.
function purity() {
  const v = $("#purity").value;
  return ["safe", "mixed", "nsfw"].includes(v) ? v : "safe";
}
// Wallpaper color — Wallhaven ONLY. Wallhaven's API takes a `colors` hex
// (no "#", e.g. cc0000); the values below are Wallhaven's own indexed
// palette, so every swatch is a color the API actually matches on. No other
// source has a color parameter — Danbooru/Safebooru take tags only, and the
// scraped listings (AlphaCoders, Wallpapers.com, WallpaperCave, Zerochan)
// carry no color data — so a color choice filters Wallhaven and leaves
// every other source untouched. The UI says so next to the picker. There is
// no client-side pixel analysis and no guessing a color from tags.
// Persisted in localStorage as `wms.color` ("" = any color).
const WALL_COLORS = ["cc0000", "cc6633", "ffff00", "77cc33", "66cccc", "0066cc", "663399", "ea4c88", "660000", "000000", "ffffff"];
function wallColor() {
  const c = localStorage.getItem("wms.color") || "";
  return WALL_COLORS.includes(c) ? c : "";
}
function setWallColor(hex) {
  const next = WALL_COLORS.includes(hex) ? hex : "";
  localStorage.setItem("wms.color", next);
  $$(".swatch").forEach((b) => {
    b.setAttribute("aria-pressed", (b.dataset.color || "") === next ? "true" : "false");
  });
}

// Shows whether the local proxy (start.sh / start.bat) is running — in the
// Settings line AND in the banner under the hero, so a missing proxy can't
// be missed. On the hosted (https) version the local proxy can never work
// (an https page can't fetch http://localhost), so the banner points at the
// Cloudflare Worker instead.
async function updateProxyStatus() {
  const el = $("#proxy-status");
  const banner = $("#proxy-banner");
  const bannerText = $("#proxy-banner-text");
  const up = await ProxyClient.probeLocalProxy();
  localProxyUp = up;
  const hosted = window.location.protocol === "https:";
  if (el) {
    el.textContent = up
      ? "Local proxy detected on port 8787 — Wallhaven and the other proxied sources will go through it."
      : "Local proxy not running — sources will try your Worker, then public proxies. Run start.sh (Linux/Mac) or start.bat (Windows) to start it.";
  }
  if (banner) {
    banner.hidden = up;
    if (!up && bannerText) {
      // Plain wording: name what breaks and the exact fix. The banner is
      // sticky (see style.css) so it can't scroll away unnoticed.
      bannerText.innerHTML = hosted
        ? "<strong>Local proxy is OFF — and the hosted version can't reach one.</strong> Set up the Cloudflare Worker (see <code>worker/README.md</code>) and paste its URL in Settings, or run the app locally with <code>./start.sh</code> and reload — right now Zerochan fails and images may not load; the public proxies are unreliable."
        : "<strong>Local proxy is OFF.</strong> Run <code>./start.sh</code> (Linux/Mac) or <code>start.bat</code> (Windows) from the project folder, then reload this page. Right now Zerochan fails and images may not load — the public proxies are unreliable.";
    }
  }
}

function minRes() {
  const v = $("#min-res").value;
  // The "Any" option has value "0", which is a truthy string — without this
  // check it parses to { w: 0, h: undefined } and the height comparison
  // (>= undefined) is always false, filtering out every result.
  if (!v || v === "0") return null;
  const [w, h] = v.split("x").map(Number);
  return { w, h };
}
// How many search results to render: 50 / 100 / 150 / 200, or 0 = All.
// "0" follows the min-res "0" = Any pattern (a truthy string — never
// compare it numerically without this check). An unknown value falls back
// to the default 100 rather than hiding everything or nothing.
function resultLimit() {
  const el = $("#limit");
  const v = el ? el.value : "";
  if (!v || v === "0") return 0;
  const n = parseInt(v, 10);
  return [50, 100, 150, 200].includes(n) ? n : 100;
}
function passesMinRes(r, m = minRes()) {
  // Unknown sizes (0x0 — some scraped sites don't show resolution) pass
  // through instead of being hidden by a filter that can't judge them.
  return !m || !r.width || !r.height || (r.width >= m.w && r.height >= m.h);
}
// Device / ratio filter ("all", "pc", "ultrawide" or "phone").
// Bands, from the item's own width/height:
//   pc        — landscape: width > height (any landscape, incl. 16:9, 21:9)
//   ultrawide — width / height >= 2.0 (21:9 ≈ 2.33 and wider)
//   phone     — portrait: height > width (9:16, 9:20, …)
// Square (width === height) is neither landscape nor portrait, so it shows
// only under "All ratios" — it is hidden by every specific ratio filter.
// Items with no pixel dimensions but a known aspect ratio (Wallpapers.com:
// ratioW/ratioH from the listing thumbnail) CAN be classified — the ratio
// is all the filter needs. Truly unknown items (no dims, no ratio) still
// hide under a specific ratio (unlike min-res, which lets them through —
// a ratio filter that kept unknowns would show PC results full of phone art).
function deviceRatio() {
  const v = $("#device-ratio").value;
  return ["all", "pc", "ultrawide", "phone"].includes(v) ? v : "all";
}
function passesDeviceRatio(r, mode = deviceRatio()) {
  if (mode === "all") return true;
  const w = r.width || r.ratioW || 0, h = r.height || r.ratioH || 0;
  if (!w || !h) return false;
  if (mode === "phone") return h > w;
  if (mode === "ultrawide") return w / h >= 2.0;
  return w > h; // pc
}
// Short label for the ratio empty state ("No PC landscape wallpapers…").
const RATIO_LABELS = { pc: "PC landscape", ultrawide: "ultrawide 21:9", phone: "phone portrait" };

// Returns { data, via } — `via` names the proxy that served a proxied
// request ("" for direct fetches). Callers keep the via with their own
// result; see the note above about why it is never a shared global.
async function fetchJson(url, viaProxy) {
  if (!viaProxy) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: await res.json(), via: "" };
  }
  // Proxied sources go through the fallback chain (local proxy -> Worker ->
  // custom proxy -> public proxies). See proxy-client.js.
  return ProxyClient.fetchJson(url, proxySettings());
}

// --- Booru helpers ---
// How many passing results to collect per booru before stopping, and how
// far to paginate. Boorus return newest-first, and the newest posts are
// mostly vertical phone art, so a single small page can be wiped out by
// the min-resolution filter — fetch big pages until we have enough.
const BOORU_TARGET = 40;
const BOORU_MAX_PAGES = 4;
const BOORU_PAGE_SIZE = 100;
const BOORU_PAGE_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Format a user's free-text query into valid booru tags (Danbooru,
// Safebooru, Gelbooru). Plain words join into one tag with underscores
// ("code geass" -> "code_geass"); comma-separated groups become separate
// tags; anything that already looks like booru syntax stands alone
// untouched: metatags ("rating:explicit", "order:score", "width:>=1920"),
// "-excluded" tags, "~" OR-group tags, "*" wildcards, and tokens that
// already contain "_" ("code_geass"). A lone "-" or "~" attaches to the
// next token ("- nude" -> "-nude"). Hyphens inside plain words become
// underscores ("code-geass" -> "code_geass") because booru tag names don't
// contain hyphens. The old version blindly joined every whitespace token
// in a comma group with "_", which glued exclusions and metatags into the
// phrase ("code geass -nude" became the single nonexistent tag
// "code_geass_-nude", and the exclusion was silently lost).
function formatBooruTags(q) {
  const out = [];
  let phrase = [];
  let pendingPrefix = "";
  const flush = () => { if (phrase.length) { out.push(phrase.join("_")); phrase = []; } };
  const isSpecial = (t) => t.startsWith("-") || t.startsWith("~") || t.includes(":") || t.includes("*") || t.includes("_");
  for (const part of String(q).split(",")) {
    for (let raw of part.trim().toLowerCase().split(/\s+/)) {
      if (!raw) continue;
      if (raw === "-" || raw === "~") { pendingPrefix = raw; continue; }
      if (pendingPrefix) {
        if (isSpecial(raw)) pendingPrefix = ""; // can't combine; drop it
        else { raw = pendingPrefix + raw; pendingPrefix = ""; }
      }
      if (isSpecial(raw)) { flush(); out.push(raw); }
      else phrase.push(raw.replace(/-/g, "_"));
    }
    flush();
    pendingPrefix = ""; // a dangling prefix doesn't cross a comma group
  }
  flush();
  return out.join(" ");
}

// Per-source query formatting. Boorus are tag search: the same words need
// underscores ("code geass" -> "code_geass") or they mean something else
// entirely. Every other source takes plain free text, so the query passes
// through unchanged. All adapters (and the Gelbooru link-out) go through
// here — no ad-hoc query rewriting anywhere else.
const BOORU_SOURCES = new Set(["danbooru", "safebooru", "gelbooru"]);
function formatQueryFor(source, q) {
  if (BOORU_SOURCES.has(String(source).toLowerCase())) return formatBooruTags(q);
  return q;
}

// Prefer the original file for `full` (a wallpaper app wants full res, not
// the ~850px sample). Fall back to the sample for videos/archives.
function pickBooruFile(fileUrl, sampleUrl) {
  if (fileUrl && !/\.(mp4|webm|zip)$/i.test(fileUrl)) return fileUrl;
  return sampleUrl || fileUrl || null;
}

// --- Source adapters. Each returns [{ thumb, full, alts, page, width, height, source, date, score }].
// `alts` is the ordered list of alternate URLs for the same image to try if
// `full` fails to load (smaller versions from the same source — see the
// image loader in app.js: loadFullImage/probeUrl). `date` is an ISO string where the API provides one (Danbooru
// and Wallhaven via `created_at`), null otherwise. `score` is the source's
// popularity signal where one exists (Danbooru `score`, Wallhaven
// `favorites`), null otherwise — Safebooru's dapi `score` is null ~88% of
// the time and the scraped sites show no popularity number at all. The result
// array also carries `.via` (which proxy served it, "" for direct) and, for
// the boorus, `.hidden` — see the note at the top about why `via` is
// per-call, never a global. ---
const SOURCES = {
  async danbooru(q) {
    const tags = formatQueryFor("danbooru", q);
    const m = minRes();
    const p = purity();
    // Safe: rating:safe only. Mixed: safe OR questionable (comma = OR inside
    // the rating metatag, verified live 2026-11-15 — anonymous, no login).
    // NSFW: rating:explicit only — also works anonymously, verified live
    // 2026-11-15 ("code geass rating:explicit": 1,788 posts, 209 at
    // 1920x1080+; the posts call returns 100/100 rating "e").
    // Space-joined like every other tag: never "+"-joined, or
    // encodeURIComponent turns it into "%2B" and Danbooru reads it as one
    // nonexistent literal tag (the v1 "0 found" bug).
    const baseTags = tags + (p === "safe" ? " rating:safe" : p === "mixed" ? " rating:safe,questionable" : " rating:explicit");
    // Filter on the server, not the client: Danbooru supports width:/height:
    // metatags, so the API only returns posts that already pass the
    // min-resolution filter. The old code fetched the 40 newest posts and
    // filtered locally — the newest posts are mostly portrait phone art, so
    // the filter could (and did) empty the whole result.
    const searchTags = baseTags + (m ? ` width:>=${m.w} height:>=${m.h}` : "");

    // Best-effort exact count of posts hidden by the filter, from Danbooru's
    // counts endpoint (total matching posts minus total passing posts).
    // If it fails, results still work — the count just isn't shown.
    let hiddenPromise = null;
    if (m) {
      hiddenPromise = (async () => {
        const [{ data: all }, { data: pass }] = await Promise.all([
          fetchJson(`https://danbooru.donmai.us/counts/posts.json?tags=${encodeURIComponent(baseTags)}`, false),
          fetchJson(`https://danbooru.donmai.us/counts/posts.json?tags=${encodeURIComponent(searchTags)}`, false),
        ]);
        return Math.max(0, (all.counts?.posts ?? 0) - (pass.counts?.posts ?? 0));
      })().catch(() => 0);
    }

    const out = [];
    let via = "";
    for (let page = 1; page <= BOORU_MAX_PAGES && out.length < BOORU_TARGET; page++) {
      const { data, via: v } = await fetchJson(
        `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(searchTags)}&limit=${BOORU_PAGE_SIZE}&page=${page}`, false);
      via = v;
      if (!Array.isArray(data) || data.length === 0) break;
      for (const p of data) {
        const full = pickBooruFile(p.file_url, p.large_file_url);
        if (!full) continue;
        out.push({
          thumb: p.preview_file_url || p.large_file_url || full,
          full,
          // If the original won't load (CDN block, rate-limit), fall back
          // through the smaller versions of the same post.
          alts: [p.large_file_url, p.preview_file_url].filter((u) => u && u !== full),
          page: `https://danbooru.donmai.us/posts/${p.id}`,
          width: p.image_width, height: p.image_height, source: "Danbooru",
          date: p.created_at || null,
          // `score` is upvotes minus downvotes — Danbooru's own ranking
          // signal (order:score uses it). Chosen over fav_count because it
          // also counts downvotes, so a controversial post ranks lower.
          // "code geass" sample (2026-11-15, 100 newest safe posts):
          // median 17, p90 53, max 207.
          score: p.score,
          fileSize: typeof p.file_size === "number" ? p.file_size : null,
        });
        if (out.length >= BOORU_TARGET) break;
      }
      if (data.length < BOORU_PAGE_SIZE) break; // last page
      if (out.length < BOORU_TARGET) await sleep(BOORU_PAGE_DELAY_MS);
    }
    out.hidden = hiddenPromise ? await hiddenPromise : 0;
    out.hiddenScope = "db"; // exact count across the whole database
    out.via = via;
    return out;
  },

  async safebooru(q) {
    // Safebooru hosts safe content only (verified live 2026-11-15: all 100
    // "code geass" posts on the first page rated "general"). In NSFW mode
    // there is nothing to fetch — return empty so the status pill can say
    // so instead of showing safe results under an NSFW-only filter.
    if (purity() === "nsfw") return [];
    // Safebooru's API has no server-side dimension filter, so filter locally
    // — but paginate through big pages until we have enough passing results
    // instead of giving up after the first 40 newest posts.
    // (minRes is read once here, not per item — the select can't usefully
    // change mid-fetch, and search() re-filters with the current value.)
    const tags = formatQueryFor("safebooru", q);
    const m = minRes();
    const out = [];
    let examined = 0;
    let hidden = 0;
    let via = "";
    for (let pid = 0; pid < BOORU_MAX_PAGES && out.length < BOORU_TARGET; pid++) {
      const { data, via: v } = await fetchJson(
        `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=${BOORU_PAGE_SIZE}&pid=${pid}&tags=${encodeURIComponent(tags)}`, true);
      via = v;
      if (!Array.isArray(data) || data.length === 0) break;
      for (const p of data) {
        examined++; // count posts actually looked at, not pages fetched
        const full = pickBooruFile(p.file_url, p.sample_url);
        if (!full) continue;
        const item = {
          thumb: p.preview_url,
          full,
          // Same image, smaller: the ~850px sample, then the preview.
          alts: [p.sample_url, p.preview_url].filter((u) => u && u !== full),
          page: `https://safebooru.org/index.php?page=post&s=view&id=${p.id}`,
          width: p.width, height: p.height, source: "Safebooru",
          // Safebooru's dapi returns no created_at (it has `change`, a
          // last-modified epoch — deliberately not used as a date).
          date: p.created_at || null,
          // Safebooru's `score` field is NOT a usable signal: in a 100-post
          // "code geass" sample (2026-11-15) it was null for 88 posts and 1
          // for the other 12, so it carries no ranking information. Set to
          // null — Safebooru items sort in the unscored tail in Best mode.
          score: null,
        };
        if (passesMinRes(item, m)) {
          out.push(item);
          if (out.length >= BOORU_TARGET) break;
        } else {
          hidden++;
        }
      }
      if (data.length < BOORU_PAGE_SIZE) break; // last page
      if (out.length < BOORU_TARGET) await sleep(BOORU_PAGE_DELAY_MS);
    }
    out.hidden = hidden;
    out.hiddenScope = "checked"; // only among the pages actually fetched
    out.examined = examined;
    out.via = via;
    return out;
  },

  async wallhaven(q) {
    const params = wallhavenParams(q);
    const { data, via } = await fetchJson(`https://wallhaven.cc/api/v1/search?${params}`, true);
    const out = (data.data || []).map((w) => ({
      thumb: w.thumbs.large,
      full: w.path,
      alts: [w.thumbs.large].filter((u) => u && u !== w.path),
      page: w.url,
      width: parseInt(w.resolution.split("x")[0], 10),
      height: parseInt(w.resolution.split("x")[1], 10),
      source: "Wallhaven",
      date: w.created_at || null,
      // `favorites` (users who saved it) over `views` (passive traffic):
      // favorites is an active endorsement, and Wallhaven itself offers
      // sorting=favorites. "code geass" sample (2026-11-15, relevance
      // page): favorites median 12, max 44; views median 5,286.
      score: w.favorites,
      fileSize: typeof w.file_size === "number" ? w.file_size : null,
    }));
    out.via = via;
    return out;
  },

  // NOTE: no AlphaCoders adapter here — its documented API is dead (nginx 404
  // on every variant, verified 2026-11-15). The HTML-scraping replacement
  // lives in adapters-extra.js and registers itself into SOURCES.
};

// Wallhaven search parameters, factored out of the adapter so the color
// wiring is unit-testable (harness Group G). The `colors` param is only set
// when a swatch is chosen — "" means no color filter, exactly like the API
// with the parameter omitted.
function wallhavenParams(q) {
  const p = purity();
  const params = new URLSearchParams({
    q: formatQueryFor("wallhaven", q), categories: "111", sorting: "relevance", order: "desc", page: "1",
    // Safe: sfw only (100). Mixed: sfw + sketchy (110) — works without an
    // API key, verified live 2026-11-15. NSFW: 001 — the API returns 0
    // results for anonymous requests (verified live 2026-11-15: total 0
    // for "code geass", "anime" and even an empty query; the docs say
    // "NSFW wallpapers are blocked to guests"), so a key is required.
    // The key is only sent when set in Settings; without one the adapter
    // throws and the status pill explains why instead of showing 0.
    purity: p === "safe" ? "100" : p === "mixed" ? "110" : "001",
  });
  const wc = wallColor();
  if (wc) params.set("colors", wc);
  if (p === "nsfw") {
    const keyEl = $("#wh-key");
    const key = keyEl ? keyEl.value.trim() : "";
    if (!key) throw new Error("needs a Wallhaven API key for NSFW — paste one in Settings (free, from your Wallhaven account)");
    params.set("apikey", key);
  }
  const m = minRes();
  if (m) params.set("atleast", `${m.w}x${m.h}`);
  return params;
}

// --- Sorting ---
// The last fetched result set is kept in memory so changing the sort order
// re-renders instantly without re-searching.
let lastResults = [];
let lastReports = [];
let lastQuery = "";

function sortMode() {
  const el = $("#sort");
  return (el && el.value) || "best";
}

// Epoch ms for an item's date, or NaN when the source gives no date
// (scraped sources have none — see adapters-extra.js).
function dateMs(r) {
  return r.date ? Date.parse(r.date) : NaN;
}

// --- "Best first" ---
// The scale problem: Danbooru scores and Wallhaven favorites are different
// scales (a Danbooru score of 200 is not the same as 200 Wallhaven
// favorites — for "code geass" the Danbooru max was 207, Wallhaven's 44),
// so raw numbers can't be compared across sources. Instead each scored
// item is ranked by log10(1 + score), normalised by the best log-score
// within its own source's fetched set — so each source's best item reads
// as 1.0 ("best of its source") and the top of the list mixes the best of
// every source instead of burying the smaller-voting community. The log
// scale keeps a single runaway score from dominating.
// A score of null, or <= 0 (nobody voted — no signal), counts as unscored:
// unscored items sort after all scored items, in arrival order (each
// source's own relevance order).
function bestRank(list) {
  const maxBySource = new Map();
  for (const r of list) {
    if (typeof r.score === "number" && r.score > 0) {
      const v = Math.log10(1 + r.score);
      if (!maxBySource.has(r.source) || v > maxBySource.get(r.source)) {
        maxBySource.set(r.source, v);
      }
    }
  }
  // Returns a Map from item -> { rank, area }: the normalised 0..1 rank
  // (or -1 for unscored items) and the pixel area, computed ONCE per item.
  // The old version returned a rank function that recomputed
  // Math.log10(1 + score) on every comparison (~2,000 log10 calls for a
  // 159-item sort) and re-multiplied width x height for every area
  // tiebreak; the comparator below is now pure Map lookups.
  const out = new Map();
  for (const r of list) {
    let rank = -1;
    if (typeof r.score === "number" && r.score > 0) {
      const max = maxBySource.get(r.source);
      if (max) rank = Math.log10(1 + r.score) / max;
    }
    out.set(r, { rank, area: (r.width || 0) * (r.height || 0) });
  }
  return out;
}

function sortResults(list) {
  const mode = sortMode();
  if (mode === "source") return list; // arrival order, as the sources returned them
  if (mode === "best") {
    const rankByItem = bestRank(list);
    const sorted = [...list].sort((a, b) => {
      const A = rankByItem.get(a), B = rankByItem.get(b);
      if (A.rank !== B.rank) return B.rank - A.rank; // unscored (-1) sorts last
      if (A.rank < 0) return 0; // both unscored: keep arrival order
      // Both scored with the same normalised rank: raw score first, then
      // size — both are deterministic tiebreaks, and bigger is better
      // for a wallpaper.
      if (b.score !== a.score) return b.score - a.score;
      return B.area - A.area;
    });
    // Interleave the sources round-robin: the best item of every source
    // first, then the second-best of every source, and so on. Without this
    // the sort above puts every scored item (Danbooru + Wallhaven) before
    // every unscored one (Safebooru + all scrapers), so the top ~64 were
    // two sources and the best results from the other sources sat buried
    // at the bottom. Source order within each round is first-appearance
    // order in the best-sorted list, so the highest-ranked source leads
    // each round. Within a source the order above is kept.
    const groups = new Map(); // source -> { items, next }, in first-appearance order
    for (const r of sorted) {
      let g = groups.get(r.source);
      if (!g) { g = { items: [], next: 0 }; groups.set(r.source, g); }
      g.items.push(r);
    }
    const out = [];
    let more = true;
    while (more) {
      more = false;
      for (const g of groups.values()) {
        // Index cursor, not shift(): shift() memmoves the rest of the
        // array on every item (O(n) per card dealt).
        if (g.next < g.items.length) { out.push(g.items[g.next++]); more = true; }
      }
    }
    return out;
  }
  if (mode === "newest") {
    // Dated items first, newest first; dateless items after them, in arrival order.
    return [...list].sort((a, b) => {
      const da = dateMs(a), db = dateMs(b);
      if (Number.isNaN(da) && Number.isNaN(db)) return 0;
      if (Number.isNaN(da)) return 1;
      if (Number.isNaN(db)) return -1;
      return db - da;
    });
  }
  // "largest" — the original behaviour: pixel area, largest first.
  return [...list].sort((a, b) => (b.width * b.height) - (a.width * a.height));
}

function renderSiteLinks(q) {
  $("#site-buttons").innerHTML = SITE_LINKS.map(([name, fn]) =>
    `<a href="${fn(q)}" target="_blank" rel="noopener">${name} ↗</a>`).join("");
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  // The map is hoisted: the old version built a fresh object literal for
  // every matched character (~600 calls per render, several chars each).
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Short, scannable reason for a failed source (full message goes in the pill's title).
// Order matters: an API-key failure is the most specific; then, when the
// local proxy is OFF, a proxied source failing is most likely the missing
// proxy — say so plainly ("proxy off — run ./start.sh") instead of a bare
// HTTP status that hides the fixable cause. Danbooru is direct (no proxy
// involved), so it keeps its technical reason. An HTTP status is still
// checked before the generic "proxy unreachable" mapping, or a 503
// challenge page, a 429 and a dead local proxy all display identically.
function shortReason(err, sourceName) {
  const m = String((err && err.message) || err || "");
  if (/api key/i.test(m)) return "needs API key";
  if (!localProxyUp && sourceName && sourceName !== "danbooru") {
    return pageIsHttp
      ? "proxy off — run ./start.sh"
      : "no proxy — set up the Worker in Settings";
  }
  const http = m.match(/HTTP (\d+)/);
  if (http) return `HTTP ${http[1]}`;
  if (/NetworkError|Failed to fetch|Load failed/i.test(m)) return "proxy unreachable";
  return m.length > 48 ? m.slice(0, 48) + "…" : m;
}

// --- Image loading: thumb first, full-res on approach, never jump ---
// Why this exists (field evidence 2026-11-15): the URLs are fine (curl
// 200s), but the images are not. A search pulls ~150-250 MB of full-res
// files; a single Safebooru file is 14 MB, an AlphaCoders PNG 26 MB, and
// Zerochan full images STALL mid-download (HTTP 200, then nothing — a
// 30 s curl timeout hit with 12 MB already received). A stalled <img>
// never fires onerror, so the v4 fallback chain never ran and the card
// sat black. And when a huge file finally arrived, the box resized and
// the masonry reflowed around it.
//
// So: the card <img> starts on the SMALL thumbnail (tens of KB, loads in
// <1 s) — the box is filled immediately. The full-res image is fetched
// with a probe Image() only when the card nears the viewport
// (IntersectionObserver, 600 px margin), so ~200 multi-MB files are never
// all in flight at once. The probe has a 15 s timeout per attempt (a stall
// counts as a failure), one delayed retry per URL (CDNs 503 in bursts),
// then steps through the alternates. When a candidate loads, the visible
// <img> swaps to it — same aspect ratio, so the card never changes height.
//
// The box height NEVER comes from the image: the aspect-ratio is set on
// the <a class="thumb"> anchor (inline style from the known dimensions,
// 4:3 for size-unknown items) and the img fills it with object-fit:
// contain. A failed card is NEVER removed (removal is itself a jump) —
// it becomes a fixed-height placeholder of the same reserved size, with
// its Source page / Full image links still working.
const imageLoadConfig = { timeoutMs: 15000, retryDelayMs: 1500, maxParallelProbes: 3 };

// Global cap on full-res probes. Each probe can be a multi-MB download, and
// the browser gives one origin only six connections: without this cap a few
// slow or stalled files (Wallpapers.com's CDN, a stalling Zerochan PNG) end
// up holding every connection, and thumbnails queued behind them paint
// black with only their alt text. Thumbs never go through this queue — only
// the full-res upgrade does.
const probeSlots = { active: 0, queue: [] };
function acquireProbeSlot(start) {
  if (probeSlots.active < imageLoadConfig.maxParallelProbes) {
    probeSlots.active++;
    start();
  } else {
    probeSlots.queue.push(start);
  }
}
function releaseProbeSlot() {
  probeSlots.active = Math.max(0, probeSlots.active - 1);
  const next = probeSlots.queue.shift();
  if (next) {
    probeSlots.active++;
    next();
  }
}

// Probe one URL: loads it into the browser cache (no cache-buster, so the
// later <img> swap reuses it). Calls done(true) on load, done(false) on
// error OR on timeout (a stalled download counts as failed). One retry
// after retryDelayMs — but only for a quick error, not for a timeout: a
// file that already stalled for the full budget once would just occupy a
// probe slot (and one of the browser's six connections) for another 15 s.
// Holds one of maxParallelProbes global slots while it runs. Returns a
// cancel function: calling it silently stops the probe (no done() call) —
// used when the card is discarded mid-probe, and it releases the slot.
// NOTE: `finished` is per attempt, not per probe — the retry is a second
// attempt and must be able to finish on its own. (Hoisting it to the probe
// scope once broke the whole fallback chain: the first attempt's finish
// marked the retry dead, so done() never fired and the card sat on its
// thumbnail forever.) `cancelled` is the probe-wide flag instead.
function probeUrl(url, done) {
  let attempts = 0;
  let cancelled = false;
  let timer = null;
  let retryTimer = null;
  let probe = null;
  let hasSlot = false;
  const releaseSlot = () => {
    if (!hasSlot) return;
    hasSlot = false;
    releaseProbeSlot();
  };
  const finish = (ok, timedOut) => {
    if (cancelled) return;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    if (probe) probe.src = ""; // abort a stalled download
    if (ok) { releaseSlot(); done(true); return; }
    if (!timedOut && attempts < 2) {
      retryTimer = setTimeout(attempt, imageLoadConfig.retryDelayMs);
      return;
    }
    releaseSlot();
    done(false);
  };
  const attempt = () => {
    if (cancelled) return;
    attempts++;
    probe = new Image();
    probe.referrerPolicy = "no-referrer";
    let finished = false;
    const finishOnce = (ok, timedOut) => { if (finished) return; finished = true; finish(ok, timedOut); };
    timer = setTimeout(() => finishOnce(false, true), imageLoadConfig.timeoutMs);
    probe.onload = () => finishOnce(true, false);
    probe.onerror = () => finishOnce(false, false);
    probe.src = url;
  };
  acquireProbeSlot(() => {
    if (cancelled) { releaseProbeSlot(); return; }
    hasSlot = true;
    attempt();
  });
  return () => {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    if (probe) probe.src = "";
    releaseSlot();
  };
}

// Total failure: show a fixed-height placeholder of the SAME reserved size
// (the anchor keeps its aspect-ratio, the img stays in the layout box but
// hidden, so nothing moves and nothing disappears). The card's links keep
// working; the user can still open the source page.
function markImageFailed(img) {
  img.dataset.state = "failed";
  img.style.visibility = "hidden";
  img.alt = ""; // a failed <img> would otherwise render its alt text over the badges
  const anchor = img.closest("a.thumb");
  if (anchor && !anchor.querySelector(".img-placeholder")) {
    const ph = document.createElement("div");
    ph.className = "img-placeholder";
    ph.setAttribute("aria-hidden", "true");
    ph.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l4.5-4.5 3.5 3.5 3-3L20 19"/><line x1="4" y1="4" x2="20" y2="20"/></svg><span>Image couldn't load</span>`;
    anchor.appendChild(ph);
  }
}

// A card image finished loading, so the browser knows its true size.
// For items whose listing never stated dimensions, use it: the ratio
// (every thumb here is ratio-preserving) fixes the box at once, and when
// the image showing is the FULL one, its pixels ARE the real dimensions,
// so the badge stops saying "size unknown". Idempotent — fires again on
// every src swap (thumb -> full), and the badge check makes the
// dimension fill-in a one-time thing. Items with parsed dimensions are
// unaffected (their ratio already matches; the badge is already set).
function imgLoaded(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return;
  const anchor = img.closest("a.thumb");
  if (anchor) anchor.style.aspectRatio = `${w} / ${h}`;
  const card = img.closest(".card");
  const badge = card && card.querySelector(".badge-res");
  if (badge && badge.textContent === "size unknown"
      && img.getAttribute("src") === img.dataset.full) {
    badge.textContent = `${w}×${h}`;
  }
}

// Full URLs whose probe already succeeded (in this page lifetime). A
// re-render rebuilds every card, so without this every sort/ratio change
// would re-probe ~200 multi-MB images. The img's own onerror is the
// backstop if a cached verdict goes stale (see imgThumbError).
const probedFullUrls = new Set();

// --- Preload ---
// How much full-image data to fetch up front, in bytes, while the user
// waits after a search — "when you start and wait, you put how many GB
// you wait for, and it continues to load as you go". This is NOT a cap:
// once the target is reached eager preloading stops, but on-demand loading
// (the IntersectionObserver below) keeps working as the user scrolls —
// nothing is ever blocked by the number. Off (0) = no preloading, the
// old lazy behaviour. Default 1 GB: at typical full sizes (0.5–10 MB)
// that is roughly 100–500 wallpapers ready while the user waits, without
// saturating the connection for very long.
//
// Byte counting is honest about being approximate. Danbooru and Wallhaven
// report an exact file_size per item (verified live 2026-11-15); Safebooru
// and all scrapers do not, so those are estimated at 0.5 bytes per pixel
// from the known dimensions (observed range across real files: ~0.1 for a
// flat Danbooru jpg to ~1.4 for a big AlphaCoders PNG; 0.5 is the middle),
// or a flat 5 MB when even the dimensions are unknown. A successful
// upgrade is charged once, at the FULL file's cost, even if a smaller
// alternate is what actually loaded (a conservative ceiling); failed or
// timed-out probes charge nothing (their partial bytes are uncounted).
// The meter therefore reads "≈" throughout. Counting via the local proxy
// was considered and rejected: only Zerochan images go through it now, so
// it would see a small fraction of the bytes, and the browser's Resource
// Timing sizes are zeroed for cross-origin images without
// Timing-Allow-Origin, which these CDNs don't send.
const PRELOAD_DEFAULT = 1073741824; // 1 GB
const PRELOAD_VALUES = ["0", "536870912", "1073741824", "2147483648", "5368709120"];
let preloadSpent = 0; // bytes charged to eager preloads, this search
let preloadQueue = []; // card <img>s in display order, rebuilt per render
let preloadIndex = 0; // next queue entry to consider (only advances past an
// item once its upgrade starts or it is skipped — so an item that doesn't
// fit the remaining target stays queued and is retried if the target grows)
let preloadInFlight = false;
let preloadRunning = false;

// The preload controls never leave the page, but the pump used to
// re-query the DOM for them on every card: updatePreloadMeter() reads
// #preload-meter and preloadTarget() reads #data-preload, and the pump
// calls both ~3x per card — ~5 DOM queries per preloaded card, ~500 for
// a full 100-card preload. Cache the elements once (lazily, so a missing
// element is retried instead of cached as null); the select's VALUE is
// still read fresh every time, so changing it — or setting it directly,
// as the harness does — always takes effect.
let preloadElCache = null;
let preloadMeterElCache = null;
function preloadTarget() {
  if (!preloadElCache) preloadElCache = $("#data-preload");
  const v = preloadElCache ? Number(preloadElCache.value) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function preloadCost(r) {
  if (typeof r.fileSize === "number" && r.fileSize > 0) return Math.round(r.fileSize);
  const w = r.width || 0, h = r.height || 0;
  if (w > 0 && h > 0) return Math.round(w * h * 0.5);
  return 5 * 1024 * 1024;
}

function fmtBytes(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${Math.round(n / 1048576)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function updatePreloadMeter() {
  if (!preloadMeterElCache) preloadMeterElCache = $("#preload-meter");
  const el = preloadMeterElCache;
  if (!el) return;
  const target = preloadTarget();
  if (!target) { el.textContent = "Preload off"; return; }
  if (preloadRunning) { el.textContent = `Preloading ≈ ${fmtBytes(preloadSpent)} / ${fmtBytes(target)}…`; return; }
  if (preloadSpent > 0) { el.textContent = `Preloaded ≈ ${fmtBytes(preloadSpent)}`; return; }
  el.textContent = `Preload ${fmtBytes(target)}`;
}

// One eager upgrade at a time, in display order, until the target is
// reached. Sequential on purpose: it leaves two of the three probe slots
// free, so scrolling never queues behind a preload. Skips cards that are
// detached or already upgrading/upgraded (the observer may have beaten it
// there — those bytes are on-demand, not preload, and aren't counted).
// The chain is self-perpetuating: each completion re-pumps, so a stopped
// chain (target reached, queue drained) restarts on the next render or
// when the user raises the target. Does not run in the Favorites view —
// a handful of deliberate picks, and the observer upgrades those on
// demand anyway.
function pumpPreload() {
  if (preloadInFlight) return;
  const target = preloadTarget();
  if (!target || favsView) { preloadRunning = false; updatePreloadMeter(); return; }
  let img = null;
  while (preloadIndex < preloadQueue.length) {
    img = preloadQueue[preloadIndex];
    if (!img.isConnected || img.dataset.upgradeStarted) { preloadIndex++; continue; }
    break;
  }
  if (!img || preloadIndex >= preloadQueue.length) { preloadRunning = false; updatePreloadMeter(); return; }
  const cost = Number(img.dataset.cost) || 0;
  // Doesn't fit the remaining target: stop here WITHOUT consuming the
  // item, so raising the target later resumes with it.
  if (preloadSpent + cost > target) { preloadRunning = false; updatePreloadMeter(); return; }
  preloadIndex++;
  preloadRunning = true;
  preloadInFlight = true;
  updatePreloadMeter();
  loadFullImage(img, (status) => {
    preloadInFlight = false;
    if (status === "downloaded") {
      preloadSpent += cost;
      updatePreloadMeter();
    }
    queueMicrotask(pumpPreload);
  });
}

function restartPreload() {
  const box = $("#results");
  preloadQueue = box ? [...box.querySelectorAll(".card img")] : [];
  preloadIndex = 0;
  updatePreloadMeter();
  pumpPreload();
}

// Upgrade one card's visible image to full resolution (or the next working
// alternate). Runs once per img; safe to call again (no-op). onDone, when
// given, fires exactly once with what happened: "downloaded" (a probe
// succeeded and bytes were fetched), "cached" (already showing the full
// image, or a previously verified URL swapped in — no new download),
// "skipped" (thumb-only card, or the card is gone / already upgrading),
// "failed" (every candidate failed, or the upgrade was cancelled). The
// preload pump uses it to charge bytes and feed the next card; ordinary
// callers (the observer, imgThumbError) pass nothing and are unaffected.
function loadFullImage(img, onDone) {
  let doneCalled = false;
  const done = (status) => {
    if (doneCalled) return;
    doneCalled = true;
    if (onDone) onDone(status);
  };
  if (!img.isConnected || img.dataset.upgradeStarted) { done("skipped"); return; }
  img.dataset.upgradeStarted = "1";
  // Some sources (Wallpapers.com) serve the card-sized thumbnail fine but
  // their full-size files are multi-MB on a CDN that stalls past the probe
  // timeout here. Keep the thumbnail: probing would only burn a slot, then
  // hide a perfectly good image behind the failure placeholder.
  if (img.dataset.thumbOnly) { img.dataset.state = "thumb"; done("skipped"); return; }
  // Candidates in order: full, then alternates (smaller versions of the
  // same image). Deduped — e.g. WallpaperCave's thumb IS its full image.
  const candidates = [img.dataset.full, ...(img.dataset.alts ? img.dataset.alts.split("|").filter(Boolean) : [])]
    .filter((u, i, a) => u && a.indexOf(u) === i);
  // Already showing the full image (WallpaperCave): nothing to upgrade.
  if (candidates.length === 1 && img.getAttribute("src") === candidates[0]) {
    img.dataset.state = "full";
    done("cached");
    return;
  }
  // This full URL already verified in an earlier render (e.g. a sort
  // change rebuilt the cards): swap it in directly instead of probing
  // again. Only the full URL counts — if an alternate loaded last time,
  // the full is still worth one fresh probe.
  if (probedFullUrls.has(img.dataset.full)) {
    img.src = img.dataset.full;
    img.style.visibility = "";
    img.dataset.state = "full";
    done("cached");
    return;
  }
  let i = 0;
  let dead = false;
  let cancelProbe = null;
  // Abort the in-flight probe (and stop the chain) when the card is
  // discarded — e.g. a new search or a filter change rebuilds the grid.
  // Without this, a stalled probe keeps downloading a multi-MB file for an
  // image that will never be shown (up to the 15 s timeout, twice).
  img._cancelUpgrade = () => {
    dead = true;
    if (cancelProbe) cancelProbe();
    done("failed"); // a discarded mid-probe card must not stall the pump
  };
  const tryNext = () => {
    // The card is gone — normally _cancelUpgrade already fired done()
    // (dead), but if the img was detached some other way the pump's onDone
    // must still fire exactly once or the pump stalls forever.
    if (dead || !img.isConnected) { done("failed"); return; }
    if (i >= candidates.length) { markImageFailed(img); done("failed"); return; }
    const url = candidates[i++];
    cancelProbe = probeUrl(url, (ok) => {
      cancelProbe = null;
      // The card is gone — normally _cancelUpgrade already fired done()
      // (dead), but if the img was detached some other way the pump's
      // onDone must still fire exactly once or the pump stalls forever.
      if (dead || !img.isConnected) { done("failed"); return; }
      if (ok) {
        probedFullUrls.add(url);
        img.src = url;
        img.style.visibility = "";
        img.dataset.state = "full";
        done("downloaded");
      } else {
        tryNext();
      }
    });
  };
  tryNext();
}

// The thumbnail itself failed (its host blocks this browser, or it 404s).
// Hide the broken icon immediately (the anchor keeps the reserved box)
// and start the upgrade — the full-size URL may load even when the thumb
// host doesn't. If an upgrade is already running, the probe resolves it.
function imgThumbError(img) {
  if (img.dataset.state === "failed") return;
  // Thumb-only card (Wallpapers.com): there is no cheap fallback to try, so
  // a failed thumbnail is already a total failure.
  if (img.dataset.thumbOnly) { markImageFailed(img); return; }
  // The visible image IS the full-res one (its probe already succeeded, or
  // the thumb is the full image — WallpaperCave) and it just errored:
  // there is nothing left to try. Show the placeholder instead of leaving
  // a hidden card with no explanation.
  if (img.dataset.state === "full") { markImageFailed(img); return; }
  // Single candidate and the thumb already IS it (WallpaperCave, no alts):
  // the upgrade would be a no-op, so a thumb error here is already a total
  // failure — don't hide the img and wait on a probe that returns instantly.
  const thumbAlts = (img.dataset.alts || "").split("|").filter(Boolean);
  if (img.getAttribute("src") === img.dataset.full && thumbAlts.length === 0) {
    markImageFailed(img);
    return;
  }
  img.style.visibility = "hidden";
  loadFullImage(img);
}

// Upgrade only when a card nears the viewport — never all ~200 at once.
// Falls back to loading everything immediately where IntersectionObserver
// doesn't exist (very old browsers, some test harnesses).
let imageObserver = null;
function getImageObserver() {
  if (imageObserver) return imageObserver;
  if (typeof IntersectionObserver === "undefined") return null;
  imageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        imageObserver.unobserve(e.target);
        loadFullImage(e.target);
      }
    }
  }, { rootMargin: "600px" });
  return imageObserver;
}

// --- Favorites ---
// Saved in localStorage under `wms.favs` (this browser only — no account,
// no server). Each entry is a snapshot of the item as rendered (thumb, full,
// alts, page, width, height, source, date, score), so the Favorites view can
// re-render cards without re-searching. Deduped by source page URL.
const FAVS_KEY = "wms.favs";

function loadFavs() {
  try {
    const raw = localStorage.getItem(FAVS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((f) => f && typeof f.page === "string" && f.page
      && typeof f.thumb === "string" && f.thumb
      && typeof f.full === "string" && f.full);
  } catch {
    return [];
  }
}

let favorites = loadFavs();

function saveFavs() {
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify(favorites));
  } catch {
    // Storage full or blocked: favorites still work for this session.
  }
}

function favSnapshot(r) {
  return {
    thumb: r.thumb,
    full: r.full,
    alts: Array.isArray(r.alts) ? [...r.alts] : [],
    page: r.page,
    width: r.width || 0,
    height: r.height || 0,
    source: r.source,
    date: r.date || null,
    score: typeof r.score === "number" ? r.score : null,
    thumbOnly: !!r.thumbOnly,
    fileSize: typeof r.fileSize === "number" ? r.fileSize : null,
  };
}

// Toggles one item's favorite state. Returns true if it is a favorite now.
function toggleFav(item) {
  const i = favorites.findIndex((f) => f.page === item.page);
  const nowFav = i < 0;
  if (nowFav) favorites.push(favSnapshot(item));
  else favorites.splice(i, 1);
  saveFavs();
  updateFavsToggle();
  return nowFav;
}

// Items currently on screen, by source page URL — the heart button's click
// handler looks the item up here (works in search view and in Favorites view).
const renderedByPage = new Map();
let favsView = false;

function updateFavsToggle() {
  const btn = $("#favs-toggle");
  if (!btn) return;
  btn.textContent = `★ Favorites (${favorites.length})`;
  btn.classList.toggle("active", favsView);
  btn.setAttribute("aria-pressed", favsView ? "true" : "false");
}

function setFavsView(on) {
  favsView = on;
  updateFavsToggle();
}

function renderFavsView() {
  setFavsView(true);
  // Favorites render in the current sort order (they carry date/score, so
  // Best/Newest/Largest all compose); unscored ones sort last in Best mode,
  // exactly like search results.
  const reports = favorites.length
    ? [["Favorites", `${favorites.length} saved`, true, 0]]
    : [];
  renderResults(favorites, reports, "Favorites");
}

// Cards currently on screen, by source page URL — the sort-only fast path
// in renderResults reorders these instead of rebuilding them. Also remembers
// the proxy state and view of that render: image URLs are proxy-routed, so
// a proxy state change (or a different view) invalidates the cached nodes.
// Entries are checked with isConnected before use, so a stale entry left
// behind by a skeleton/empty-state render can never resurrect a dead card.
let cardByPage = new Map();
let lastRenderProxyUp = false;
let lastRenderFavsView = false;

// Discard every card currently on screen: abort its in-flight full-res
// upgrade (otherwise the probe downloads to completion for an image that
// will never be shown — and, worse, a preload probe whose card is gone
// never fires its onDone, which stalls the preload pump forever) and drop
// the old images from the observer (detached nodes never intersect, so
// they would never be unobserved). Call before ANY innerHTML replacement
// of #results — the empty-state branch, the full rebuild, search()'s
// skeleton render, and the Favorites toggle's idle restore. The sort-only
// fast path must NOT call this: its cards stay on screen, only reordered.
function discardRenderedCards() {
  const box = $("#results");
  if (!box) return;
  box.querySelectorAll(".card img").forEach((img) => {
    if (typeof img._cancelUpgrade === "function") img._cancelUpgrade();
  });
  if (imageObserver) imageObserver.disconnect();
}

function renderResults(results, reports, q) {
  const seen = new Set();
  const uniq = results.filter((r) => {
    if (seen.has(r.full)) return false;
    seen.add(r.full);
    return true;
  });
  const sorted = sortResults(uniq);

  // Device/ratio filter, applied after sorting, in memory — no re-search,
  // and it composes with the min-resolution filter (already applied by
  // search()) and with every sort order. Size-unknown items are hidden by
  // a specific ratio (see passesDeviceRatio), and the count is shown in
  // its own pill, following the min-res "hidden by filter" pattern.
  // (The ratio mode is read once here, not once per item.)
  const ratioMode = deviceRatio();
  let visible = sorted.filter((r) => passesDeviceRatio(r, ratioMode));
  const ratioHidden = sorted.length - visible.length;
  // Result limit (search only — favorites always show all): cap the cards
  // actually rendered, so a search never builds ~200 cards, ~200 thumbs
  // and ~200 full-res probes at once. Applied after the ratio filter, so
  // the limit counts what would actually show; the sort-only fast path
  // below keys on visible.length, so a limit change rebuilds (new set)
  // while a sort change with the same limit still reorders in place.
  // The hidden count gets its own pill, like the ratio filter's.
  const limit = favsView ? 0 : resultLimit();
  const limitHidden = limit > 0 ? Math.max(0, visible.length - limit) : 0;
  if (limit > 0) visible = visible.slice(0, limit);

  // Rebuild the on-screen lookup the heart button's click handler uses.
  renderedByPage.clear();
  for (const r of visible) renderedByPage.set(r.page, r);

  const hiddenTotal = reports.reduce((sum, r) => sum + (r[3] || 0), 0);

  $("#status").innerHTML = reports.map(([name, payload, ok]) => {
    if (ok) {
      return `<span class="status-pill pill-ok"><span class="pill-dot"></span><strong>${name}</strong>&nbsp;${escapeHtml(payload)}</span>`;
    }
    const full = String((payload && payload.message) || payload || "");
    return `<span class="status-pill pill-fail" title="${escapeHtml(full)}"><span class="pill-dot"></span><strong>${name}</strong>&nbsp;${shortReason(payload, name)}</span>`;
  }).join("") + (visible.length
    ? `<span class="status-pill pill-total"><strong>${visible.length} result${visible.length === 1 ? "" : "s"}</strong></span>`
    : "") + (ratioHidden > 0
    ? `<span class="status-pill pill-ratio">${ratioHidden} hidden by ratio filter</span>`
    : "") + (limitHidden > 0
    ? `<span class="status-pill pill-limit">${limitHidden} more — raise the limit to see them</span>`
    : "");

  const box = $("#results");
  if (!visible.length) {
    // No cards on screen any more — the sort-only cache is empty too.
    cardByPage = new Map();
    // Discard first: the empty state replaces the cards, and an in-flight
    // upgrade on a discarded card would never report back (see
    // discardRenderedCards) — the preload pump would stall forever.
    discardRenderedCards();
    if (favsView && !uniq.length) {
      box.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true" style="font-size:64px;line-height:1">♡</div>
        <h2>No favorites yet</h2>
        <p>Tap the ♡ on any wallpaper to save it here — favorites are kept in this browser and survive reloads.</p>
      </div>`;
      return;
    }
    // Results exist but the ratio filter hid all of them — say so and
    // offer to show all ratios (client-side, no re-search).
    if (uniq.length > 0) {
      const label = RATIO_LABELS[deviceRatio()] || "this ratio";
      box.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="72" height="72" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="10" width="44" height="34" rx="6"/><circle cx="21" cy="23" r="4.5"/><path d="M10 38l11-11 9 9 7-7 11 11"/><circle cx="48" cy="46" r="9"/><line x1="54.5" y1="52.5" x2="60" y2="58"/></svg>
        </div>
        <h2>No ${label} wallpapers</h2>
        <p>But <strong>${uniq.length}</strong> matching wallpaper${uniq.length === 1 ? "" : "s"} exist${uniq.length === 1 ? "s" : ""} in other ratios.</p>
        <button type="button" class="btn-ghost" data-action="clear-ratio">Show all ratios</button>
      </div>`;
      return;
    }
    const m = minRes(); // read once: the condition below used to call it twice
    if (hiddenTotal > 0 && m) {
      box.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="72" height="72" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="10" width="44" height="34" rx="6"/><circle cx="21" cy="23" r="4.5"/><path d="M10 38l11-11 9 9 7-7 11 11"/><circle cx="48" cy="46" r="9"/><line x1="54.5" y1="52.5" x2="60" y2="58"/></svg>
        </div>
        <h2>No wallpapers at ${m.w}×${m.h} or above</h2>
        <p>But <strong>${hiddenTotal.toLocaleString()}</strong> matching post${hiddenTotal === 1 ? "" : "s"} exist${hiddenTotal === 1 ? "s" : ""} below that size.</p>
        <button type="button" class="btn-ghost" data-action="clear-res">Show all resolutions</button>
      </div>`;
      return;
    }
    box.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="72" height="72" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="10" width="44" height="34" rx="6"/><circle cx="21" cy="23" r="4.5"/><path d="M10 38l11-11 9 9 7-7 11 11"/><circle cx="48" cy="46" r="9"/><line x1="54.5" y1="52.5" x2="60" y2="58"/></svg>
        </div>
        <h2>No wallpapers found</h2>
        <p>Nothing matched <strong>&ldquo;${escapeHtml(q || "")}&rdquo;</strong> at the current filters.</p>
        <ul>
          <li>Try one or two words instead of a long phrase</li>
          <li>Lower the min. resolution filter</li>
          <li>Enable another source, or try the site links above</li>
        </ul>
        <button type="button" class="btn-ghost" data-action="clear-res">Show all resolutions</button>
      </div>`;
    return;
  }
  // Sort-only fast path: same visible set, same proxy state, same view —
  // just reorder the existing cards instead of rebuilding ~160 of them.
  // That keeps every image's probe/placeholder/favorite state: no thumb
  // re-fetch, no full-res re-probe, no masonry reflow of 160 new nodes.
  // (Card HTML is a pure function of the item + favorite state, and the
  // click handler updates favorite buttons in place — so the stored nodes
  // are always current. The isConnected check makes a stale cache entry
  // left behind by a skeleton/empty-state render harmless.)
  if (cardByPage.size === visible.length
      && localProxyUp === lastRenderProxyUp && favsView === lastRenderFavsView
      && visible.every((r) => { const el = cardByPage.get(r.page); return el && el.isConnected; })) {
    for (const r of visible) box.appendChild(cardByPage.get(r.page));
    restartPreload(); // same cards, new order — preload follows the new order
    return;
  }
  // Full rebuild: abort in-flight full-res probes for the cards about to
  // be discarded — their downloads would otherwise run to completion (or
  // the 15 s timeout, twice) for images that will never be shown.
  // (Also drops the old images from the observer — see discardRenderedCards.)
  discardRenderedCards();
  // Favorite lookup for the card template below: isFav() was a linear
  // scan of the favorites list, called once per card — with dozens of
  // favorites that's ~10k string comparisons per render. One Set per
  // render instead; rebuilt here because `favorites` changes between
  // renders (and the fast path above returns before this point).
  const favPages = new Set(favorites.map((f) => f.page));
  box.innerHTML = visible.map((r) => {
    const res = (r.width && r.height) ? `${r.width}×${r.height}` : "size unknown";
    // Thumb first: the small thumbnail loads in <1 s and fills the box
    // immediately; the full-res image is swapped in by loadFullImage when
    // the card nears the viewport (see the loader above). Full quality is
    // still the end state — it just doesn't sit black while a 10-25 MB
    // file downloads or stalls.
    // The aspect-ratio lives on the ANCHOR, not the <img>: the box height
    // is fixed from the known dimensions — or from the listing's aspect
    // ratio when pixels are unknown (ratioW/ratioH) — and only falls back
    // to 4:3 when even the ratio is unknown. Whatever loads then fills the
    // box with object-fit: contain — never cropped, never distorted.
    // A loaded image corrects the box itself (see imgLoaded): the thumb's
    // natural size fixes the ratio at once, and a loaded full image fills
    // in the badge's real dimensions. That one early correction per
    // previously-unknown card is the price of a correct box; known items
    // never move.
    // referrerpolicy=no-referrer avoids Referer-based hotlink blocks.
    // Image URLs go through the local proxy when it is up (see
    // proxiedImageUrl) — verified 2026-11-15 to un-stall Zerochan images.
    const ratio = (r.width && r.height)
      ? `aspect-ratio:${r.width} / ${r.height}`
      : (r.ratioW && r.ratioH)
        ? `aspect-ratio:${r.ratioW} / ${r.ratioH}`
        : `aspect-ratio:4 / 3`;
    const thumbSrc = proxiedImageUrl(r.thumb);
    const fullUrl = proxiedImageUrl(r.full);
    // What an upgrade of this card costs the preload meter (see preloadCost).
    const cost = preloadCost(r);
    const alts = (r.alts || []).filter((u) => u && u !== r.full).map(proxiedImageUrl);
    // Favorite state read once per card, from the per-render Set above.
    const fav = favPages.has(r.page);
    return `
    <article class="card">
      <a class="thumb" href="${fullUrl}" target="_blank" rel="noopener" style="${ratio}"><img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${thumbSrc}" data-full="${escapeHtml(fullUrl)}" data-alts="${escapeHtml(alts.join("|"))}"${r.thumbOnly ? ' data-thumb-only="1"' : ""} data-cost="${cost}" data-state="thumb" onload="imgLoaded(this)" onerror="imgThumbError(this)" alt="${r.source} wallpaper ${res}">
        <span class="badge badge-res">${res}</span>
        <span class="badge badge-src">${r.source}</span>
      </a>
      <div class="meta">
        <div class="links">
          <a href="${r.page}" target="_blank" rel="noopener">Source page ↗</a>
          <a class="full-link" href="${fullUrl}" target="_blank" rel="noopener">Full image ↗</a>
          <button type="button" class="fav-btn${fav ? " fav-on" : ""}" data-action="toggle-fav" data-page="${escapeHtml(r.page)}" aria-pressed="${fav ? "true" : "false"}" aria-label="Save to favorites" title="Save to favorites">${fav ? "♥" : "♡"}</button>
        </div>
      </div>
    </article>`;
  }).join("");
  // Start full-res upgrades for cards near the viewport (the observer
  // fires for the rest as the user scrolls). Without IntersectionObserver,
  // load everything immediately.
  const observer = getImageObserver();
  box.querySelectorAll(".card img").forEach((img) => {
    if (observer) observer.observe(img);
    else loadFullImage(img);
  });
  // Remember the rendered cards (in visible order) for the sort-only fast
  // path above — and the proxy state / view they were rendered under.
  const cards = box.querySelectorAll(".card");
  cardByPage = new Map(visible.map((r, i) => [r.page, cards[i]]));
  lastRenderProxyUp = localProxyUp;
  lastRenderFavsView = favsView;
  restartPreload();
}

async function search(ev) {
  ev.preventDefault();
  saveSettings();
  const q = $("#query").value.trim();
  if (!q) return;
  // A new search shows search results, not the Favorites view.
  setFavsView(false);
  // New search session: the preload meter starts over (bytes already
  // downloaded stay downloaded — the meter counts this search's preloads).
  preloadSpent = 0;
  updatePreloadMeter();
  renderSiteLinks(q);

  const chosen = $$(".source:checked").map((c) => c.value);
  $("#status").innerHTML = `<span class="status-pill pill-busy"><span class="spinner"></span>Searching ${chosen.length} source${chosen.length === 1 ? "" : "s"}…</span>`;
  // The skeletons replace the cards — discard their in-flight upgrades
  // first (see discardRenderedCards), or an orphaned probe stalls the
  // preload pump and keeps downloading for a card that is already gone.
  discardRenderedCards();
  $("#results").innerHTML = Array.from({ length: 8 }, () =>
    `<div class="skeleton" aria-hidden="true"><div class="skeleton-thumb"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`).join("");
  // The skeletons replace the cards — drop the sort-only cache (its entries
  // are detached; the isConnected check in renderResults would reject them,
  // but there is no reason to keep holding them).
  cardByPage = new Map();

  const reports = [];
  const all = [];
  await Promise.all(chosen.map(async (name) => {
    try {
      const items = await SOURCES[name](q);
      // minRes read once per source, not once per item (the filter below
      // runs over up to 100 items per source).
      const m = minRes();
      const passing = items.filter((r) => passesMinRes(r, m));
      all.push(...passing);
      // Adapters report how many matches the min-resolution filter hid, so
      // the UI never silently shows 0 when matches exist below the filter.
      // `via` comes from the items themselves (per-call), never a shared
      // global — parallel fetches used to overwrite each other's label.
      // When the local proxy is down, a public-proxy via is labelled as
      // such ("via corsfix — public proxy") so it doesn't read like the
      // healthy local-proxy path.
      const via = items.via || "";
      const PUBLIC_VIAS = ["corsfix", "allorigins", "allorigins (json)", "cors.lol"];
      const viaLabel = via
        ? ` (via ${via}${!localProxyUp && PUBLIC_VIAS.includes(via) ? " — public proxy" : ""})`
        : "";
      let msg = `${passing.length} found${viaLabel}`;
      if (name === "wallhaven" && wallColor()) msg += ` · color #${wallColor()}`;
      // In Mixed mode, say what each source actually includes: Danbooru and
      // Wallhaven filter by rating/purity; Safebooru is a safe-only site;
      // the scraped sites have no purity filter at all. In Safe mode the
      // pills read exactly as before.
      if (purity() === "mixed") {
        if (name === "danbooru" || name === "wallhaven") msg += " · incl. suggestive";
        else if (name === "safebooru") msg += " · safe-only site";
        else msg += " · no purity filter";
      } else if (purity() === "nsfw") {
        // NSFW mode: Danbooru returns explicit posts; Wallhaven only works
        // with an API key (the adapter throws without one, so reaching here
        // means a key was set); Safebooru returns nothing by design; the
        // scraped sites have no purity filter at all.
        if (name === "danbooru") msg += " · explicit only";
        else if (name === "wallhaven") msg += " · NSFW (API key set)";
        else if (name === "safebooru") msg += " · no NSFW here — safe-only site";
        else msg += " · no purity filter";
      }
      const hidden = items.hidden || 0;
      if (hidden > 0 && m) {
        msg += ` · ${hidden.toLocaleString()} below ${m.w}×${m.h}` +
          (items.hiddenScope === "checked" ? ` (of ${items.examined || 0} checked)` : "") +
          ` — lower the filter to see them`;
      }
      reports.push([name, msg, true, hidden]);
    } catch (err) {
      reports.push([name, err, false, 0]);
    }
  }));
  // Keep the fetched set so a sort change can re-render without re-searching.
  lastResults = all;
  lastReports = reports;
  lastQuery = q;
  renderResults(all, reports, q);
}

$("#search-form").addEventListener("submit", search);
$("#proxy").addEventListener("change", saveSettings);
$("#worker-url").addEventListener("change", saveSettings);
$("#purity").addEventListener("change", saveSettings);
$("#wh-key").addEventListener("change", saveSettings);
$("#sort").addEventListener("change", () => {
  if (favsView) renderFavsView();
  else if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
});
$("#device-ratio").addEventListener("change", () => {
  saveSettings();
  if (favsView) renderFavsView();
  else if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
});
const limitEl = $("#limit");
if (limitEl) limitEl.addEventListener("change", () => {
  saveSettings();
  if (favsView) renderFavsView();
  else if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
});
const preloadEl = $("#data-preload");
if (preloadEl) preloadEl.addEventListener("change", () => {
  saveSettings();
  updatePreloadMeter();
  pumpPreload(); // raising the target resumes a stopped chain; lowering it
  // stops the pump at its next check (already-spent bytes stay spent)
});
// Color swatches: persist the choice (and the pressed state) immediately;
// it applies to Wallhaven on the next search, like the Content select.
// No auto re-search — same as changing purity.
$$(".swatch").forEach((b) => b.addEventListener("click", () => setWallColor(b.dataset.color || "")));
// Favorites toggle: show only saved favorites (in the current sort order),
// or go back to the last search results (or the idle state if none yet).
const favsToggleBtn = $("#favs-toggle");
if (favsToggleBtn) favsToggleBtn.addEventListener("click", () => {
  if (favsView) {
    setFavsView(false);
    if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
    else { discardRenderedCards(); $("#results").innerHTML = idleResultsHtml; }
  } else {
    renderFavsView();
  }
});
// Banner action: re-probe the local proxy (e.g. after starting start.sh)
// and hide the banner if it's up now. If the proxy just came up and cards
// are already on screen, re-render so their image URLs get the proxy route
// (previously-verified full images swap in immediately — see
// probedFullUrls — so this is cheap). Stays in the Favorites view if
// that's where the user is.
const recheckBtn = $("#proxy-recheck");
if (recheckBtn) recheckBtn.addEventListener("click", async () => {
  const wasUp = localProxyUp;
  await updateProxyStatus();
  if (!wasUp && localProxyUp && lastReports.length) {
    if (favsView) renderFavsView();
    else renderResults(lastResults, lastReports, lastQuery);
  }
});
// Heart buttons (delegated) + empty-state actions: drop the device/ratio
// filter and re-render from memory, or drop the min-resolution filter and
// search again.
$("#results").addEventListener("click", (ev) => {
  const favBtn = ev.target.closest('[data-action="toggle-fav"]');
  if (favBtn) {
    const item = renderedByPage.get(favBtn.dataset.page);
    if (!item) return;
    const nowFav = toggleFav(item);
    if (favsView) {
      // Unfavoriting inside the Favorites view removes the card from it.
      renderFavsView();
    } else {
      favBtn.classList.toggle("fav-on", nowFav);
      favBtn.textContent = nowFav ? "♥" : "♡";
      favBtn.setAttribute("aria-pressed", nowFav ? "true" : "false");
    }
    return;
  }
  if (ev.target.closest('[data-action="clear-ratio"]')) {
    $("#device-ratio").value = "all";
    saveSettings();
    if (favsView) renderFavsView();
    else renderResults(lastResults, lastReports, lastQuery);
    return;
  }
  if (!ev.target.closest('[data-action="clear-res"]')) return;
  $("#min-res").value = "0";
  $("#search-form").requestSubmit();
});
loadSettings();
const idleResultsHtml = $("#results").innerHTML;
updateFavsToggle();
