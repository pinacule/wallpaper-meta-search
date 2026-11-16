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

// Image hosts that genuinely need a proxy instead of a direct load.
// Everything else loads direct — spreading requests over the real CDN hosts
// (six connections each) instead of funnelling every image through
// localhost:8787, where the browser's six-connection cap made a couple of
// slow files starve every thumbnail behind them (black cards with only alt
// text, 2026-11-15). The proxy sends no Referer, so it also sidesteps
// Referer-based hotlink blocks for these hosts.
//   Zerochan: its full images were observed stalling mid-download direct
//     (HTTP 200, then nothing) while the proxy delivered them reliably.
//   WallpaperCave: on the hosted site 32/100 cards failed with "blocked or
//     missing" while the same URLs loaded fine directly — WallpaperCave
//     throttles the burst of direct image requests from one browser. The
//     proxy fetches server-side (one egress, no burst), and the direct URL
//     stays as a fallback candidate (see renderResults).
// The proxy is the local one when it is up (localhost pages only), else the
// user's Cloudflare Worker when one is set and answering (workerUp —
// probed at startup like the local proxy). With neither configured the
// images load direct, as before.
// NOTE: a proxy does NOT change the egress IP, so it can't dodge an
// IP-based block (e.g. a CDN 403ing a datacenter/VPN IP).
const IMAGE_PROXY_HOSTS = new Set(["static.zerochan.net", "s3.zerochan.net", "wallpapercave.com"]);
let workerUp = false; // the configured Worker answered its health probe
let workerUrlElCache = null;
// The results/status boxes never leave the page, but renderResults,
// discardRenderedCards and restartPreload re-queried #results 3x per render
// (plus #status once) — 4 document queries per render for static elements.
// Cached lazily, same pattern as preloadElCache/workerUrlElCache above;
// the innerHTML/content is still written fresh every time.
let resultsElCache = null;
let statusElCache = null;
function resultsBox() { if (!resultsElCache) resultsElCache = $("#results"); return resultsElCache; }
function statusBox() { if (!statusElCache) statusElCache = $("#status"); return statusElCache; }
// Reserve the status row's height for the pills that are about to arrive
// (see .status-reserved in style.css): a search starts with one short
// busy pill and ends with one pill per source plus total/ratio/limit
// pills, and without the reserve the row grows from one line to two (or
// more) as results render — the whole grid jumps down ~48px in the same
// frame the cards appear (v5.7 browser test). The reserve only switches
// on for 6+ sources: with fewer, the final pills fit one row at desktop
// widths, so there is nothing to reserve and no dead space to pay for.
// The height itself is viewport-dependent (media queries in style.css),
// so this only toggles the class — and because it is set in the same
// synchronous block as the busy pill, the row is already at its final
// height before the first source reports in.
function setStatusReserve(sourceCount) {
  statusBox().classList.toggle("status-reserved", sourceCount >= 6);
}
// Every other static control, looked up once per page lifetime instead of
// once per call: loadSettings, saveSettings and the view functions used to
// re-query the same elements on every search (~14 document queries per
// search — saveSettings alone did 8). The readers above keep their own
// caches; this one table covers the call sites they don't. The elements
// never leave the page, so a cached reference can't go stale — and a
// lookup that returns null is NOT stored (the `if (!…)` re-queries next
// time), so a missing element behaves exactly as before.
const staticEls = {};
function staticEl(id) {
  if (!staticEls[id]) staticEls[id] = $("#" + id);
  return staticEls[id];
}
function workerUrlSetting() {
  // Cached element, fresh value — mirrors preloadTarget(): the input's
  // value is read on every call so a pasted URL takes effect immediately,
  // without a DOM query per image.
  if (!workerUrlElCache) workerUrlElCache = $("#worker-url");
  return workerUrlElCache ? workerUrlElCache.value.trim() : "";
}
// Health probe for the Worker's image path: any HTTP response counts (the
// worker answers 400 with usage text when no ?url= is given — same rule as
// probeLocalProxy). No AbortController here: the QA harness has none, so
// the timeout is a race instead (the losing fetch's rejection is swallowed
// so it never surfaces as unhandled).
async function probeWorker(timeoutMs = 2500) {
  const u = workerUrlSetting();
  if (!u) return false;
  const p = fetch(u);
  p.catch(() => {});
  try {
    await Promise.race([p, sleep(timeoutMs).then(() => { throw new Error("worker probe timeout"); })]);
    return true;
  } catch {
    return false;
  }
}
function proxiedImageUrl(u) {
  if (!u) return u;
  // Host check without `new URL()`: this runs 3x per card (thumb, full,
  // each alt). Splitting on "/" is slightly faster than URL parsing
  // (measured in node: ~0.9µs vs ~1.0µs a call — the win is small, but
  // the split is also simpler here). Splitting on "/" gives the host at index 2
  // for absolute URLs; anything else (relative or malformed) has no host
  // there and loads direct, as before. Lowercased so an uppercase host
  // still matches, like URL.hostname would.
  const host = u.split("/")[2];
  if (!host || !IMAGE_PROXY_HOSTS.has(host.toLowerCase())) return u;
  if (localProxyUp && pageIsHttp) return "http://localhost:8787/?url=" + encodeURIComponent(u);
  const wu = workerUrlSetting();
  if (workerUp && wu) return `${wu.replace(/\?$/, "").replace(/\/$/, "")}/?url=${encodeURIComponent(u)}`;
  return u;
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

let proxyElCache = null;
function proxySettings() {
  // #proxy cached like the other static controls (see resultsBox above);
  // the Worker URL comes from workerUrlSetting(), which already caches
  // its element — same values as before, read fresh on every call.
  if (!proxyElCache) proxyElCache = $("#proxy");
  return {
    customProxy: proxyElCache.value.trim(),
    workerUrl: workerUrlSetting(),
  };
}
function loadSettings() {
  staticEl("proxy").value = localStorage.getItem("wms.proxy") || "";
  staticEl("worker-url").value = localStorage.getItem("wms.workerUrl") || "";
  // Purity: "safe" (default), "mixed" or "nsfw". Migrate the old #sfw
  // checkbox setting if it exists: wms.sfw=false meant "not safe-only" ->
  // mixed.
  let p = localStorage.getItem("wms.purity");
  if (!p) {
    const legacySfw = localStorage.getItem("wms.sfw");
    p = legacySfw === "false" ? "mixed" : "safe";
  }
  staticEl("purity").value = ["safe", "mixed", "nsfw"].includes(p) ? p : "safe";
  const dr = localStorage.getItem("wms.deviceRatio");
  staticEl("device-ratio").value = ["all", "pc", "ultrawide", "phone"].includes(dr) ? dr : "all";
  // Sort was the one view control that didn't survive a reload (limit,
  // ratio, purity and preload all persist) — restore it the same way.
  const sortEl = staticEl("sort");
  if (sortEl) {
    const sv = localStorage.getItem("wms.sort");
    sortEl.value = ["best", "largest", "newest", "source"].includes(sv) ? sv : "best";
  }
  const limEl = staticEl("limit");
  if (limEl) {
    const lim = localStorage.getItem("wms.limit");
    limEl.value = ["50", "100", "150", "200", "0"].includes(lim) ? lim : "100";
  }
  const preloadEl = staticEl("data-preload");
  if (preloadEl) {
    // Stored format is bytes (v5.3); the input shows GB. Anything
    // unparseable falls back to the 1 GB default, as before.
    const raw = localStorage.getItem("wms.preload");
    const pv = raw === null ? NaN : Number(raw);
    preloadEl.value = (Number.isFinite(pv) && pv >= 0)
      ? preloadBytesToGb(Math.min(pv, PRELOAD_MAX_GB * GB))
      : preloadBytesToGb(PRELOAD_DEFAULT);
    updatePreloadPresets();
  }
  updatePreloadMeter();
  const whKeyEl = staticEl("wh-key");
  if (whKeyEl) whKeyEl.value = localStorage.getItem("wms.whKey") || "";
  setWallColor(wallColor());
  updateProxyStatus();
}
function saveSettings() {
  localStorage.setItem("wms.proxy", staticEl("proxy").value.trim());
  localStorage.setItem("wms.workerUrl", staticEl("worker-url").value.trim());
  localStorage.setItem("wms.purity", staticEl("purity").value);
  localStorage.setItem("wms.deviceRatio", staticEl("device-ratio").value);
  const sortEl = staticEl("sort");
  if (sortEl) localStorage.setItem("wms.sort", sortEl.value);
  const limEl = staticEl("limit");
  if (limEl) localStorage.setItem("wms.limit", limEl.value);
  const preloadEl = staticEl("data-preload");
  // The input holds GB; storage keeps the v5.3 byte format.
  if (preloadEl) localStorage.setItem("wms.preload", String(preloadTarget()));
  const whKeyEl = staticEl("wh-key");
  if (whKeyEl) localStorage.setItem("wms.whKey", whKeyEl.value.trim());
}

// Content mode: "safe" (default), "mixed" (safe + suggestive) or "nsfw"
// (explicit only). What each source does in NSFW mode is in the README's
// purity table — Danbooru works anonymously, Wallhaven needs an API key,
// Safebooru has nothing, the scraped sites have no filter at all.
let purityElCache = null;
function purity() {
  // Static control, cached like the others (see resultsBox) — the value is
  // still read fresh on every call.
  if (!purityElCache) purityElCache = $("#purity");
  const v = purityElCache.value;
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
  const [up, wUp] = await Promise.all([ProxyClient.probeLocalProxy(), probeWorker()]);
  localProxyUp = up;
  workerUp = wUp;
  const hosted = window.location.protocol === "https:";
  if (el) {
    el.textContent = up
      ? "Local proxy detected — port 8787."
      : workerUp
        ? "Cloudflare Worker detected."
        : "No local proxy — run start.sh or start.bat to start one.";
  }
  if (banner) {
    // The banner warns that proxied sources are unreliable without a
    // proxy — a healthy Worker IS a proxy, so it hides the banner too
    // (it used to stay up telling the user to set up the Worker they had
    // already set up).
    banner.hidden = up || workerUp;
    if (!up && !workerUp && bannerText) {
      // Plain wording: name what breaks and the exact fix. The banner is
      // sticky (see style.css) so it can't scroll away unnoticed.
      bannerText.innerHTML = hosted
        ? "<strong>Local proxy is OFF — the hosted version can't reach one.</strong> Set up the Cloudflare Worker (see <code>worker/README.md</code>) and paste its URL in Settings, or run the app locally with <code>./start.sh</code>. Zerochan fails and images may not load — public proxies are unreliable."
        : "<strong>Local proxy is OFF.</strong> Run <code>./start.sh</code> (Linux/Mac) or <code>start.bat</code> (Windows) from the project folder, then reload. Zerochan fails and images may not load — public proxies are unreliable.";
    }
  }
}

let minResElCache = null;
function minRes() {
  // Static control, cached like the others (see resultsBox) — the value is
  // still read fresh on every call.
  if (!minResElCache) minResElCache = $("#min-res");
  const v = minResElCache.value;
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
let limitElCache = null;
function resultLimit() {
  // Static control, cached like the others (see resultsBox) — the value is
  // still read fresh on every call.
  if (!limitElCache) limitElCache = $("#limit");
  const el = limitElCache;
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
let deviceRatioElCache = null;
function deviceRatio() {
  // Static control, cached like the others (see resultsBox) — the value is
  // still read fresh on every call.
  if (!deviceRatioElCache) deviceRatioElCache = $("#device-ratio");
  const v = deviceRatioElCache.value;
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
// (v5.4: 200/post pages, 2 pages, target 100 passing — a strict filter
// like 3440x1440+ needs the depth; the old 40-target stopped after one
// page even when the user asked for All results.)
const BOORU_TARGET = 100;
const BOORU_MAX_PAGES = 2;
const BOORU_PAGE_SIZE = 200;
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
  async danbooru(q, opts = {}) {
    // Trending (opts.trending): Danbooru's own popularity ranking for
    // today — order:rank is the site's "most popular" sort, and date:
    // pins it to the current day (UTC, which is what Danbooru uses).
    // Verified live 2026-11-15: order:rank + date: + rating:safe returns
    // 200. The rating metatag still applies (see below), and the
    // width:/height: server-side filter still applies — trending is not
    // an excuse to show phone art on a PC filter.
    const trending = !!opts.trending;
    const tags = trending
      ? `order:rank date:${new Date().toISOString().slice(0, 10)}`
      : formatQueryFor("danbooru", q);
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
    // Best mode wants the highest-scored posts, not the newest: ask the
    // server for order:score so the fetched pages ARE the top of the
    // ranking instead of the newest 200 (whose scores the sort then has to
    // rescue). Other modes keep the default newest-first order — Newest
    // sort needs it, and Largest/Source don't care about score. A
    // user-typed order: metatag wins over the automatic one.
    const fetchTags = (sortMode() === "best" && !searchTags.includes("order:"))
      ? searchTags + " order:score" : searchTags;

    // Best-effort exact count of posts hidden by the filter, from Danbooru's
    // counts endpoint (total matching posts minus total passing posts).
    // If it fails, results still work — the count just isn't shown.
    let hiddenPromise = null;
    // Skipped for trending: counts of an order:rank query answer a
    // question nobody asked (and would cost two extra requests per load).
    if (m && !trending) {
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
        `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(fetchTags)}&limit=${BOORU_PAGE_SIZE}&page=${page}`, false);
      via = v;
      if (!Array.isArray(data) || data.length === 0) break;
      for (const p of data) {
        const full = pickBooruFile(p.file_url, p.large_file_url);
        if (!full) continue;
        // Huge originals (multi-MB / very wide — a 98 MB file turned up in
        // the top 200 for "catgirl") stall past the 15 s probe timeout or
        // get cut off on slow links, and the card fails even though the
        // ~850px sample would load in a second. Show the sample in the
        // grid instead (displayFull); the Full image link still opens the
        // original. The sample is also the first probe candidate, with the
        // original as a fallback (see the card template).
        const huge = (typeof p.file_size === "number" && p.file_size > 15 * 1024 * 1024)
          || p.image_width > 6000;
        const displayFull = huge && p.large_file_url && p.large_file_url !== full
          ? p.large_file_url : null;
        out.push({
          thumb: p.preview_file_url || p.large_file_url || full,
          full,
          displayFull,
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
    // Pages 0+1 fetch concurrently (same pattern as Wallhaven above and
    // AlphaCoders in adapters-extra.js): page 1 is needed whenever page 0
    // yields fewer than 100 passing posts — the min-resolution filter runs
    // client-side here, so a page of small posts can pass almost nothing —
    // and sequential fetching paid a 250 ms delay plus a second round-trip
    // per search (measured in node with stubbed 150 ms pages: ~555 ms ->
    // ~151 ms). allSettled: page 0 still throws if it fails, a failed page
    // 1 just leaves the page-0 results standing — that differs from the
    // old sequential code, where a page-1 failure errored the whole
    // source; partial results are the better outcome there, and the
    // success path is identical (same items, same order, same counts, same
    // `via` — the last page actually used). When page 0 already meets the
    // target or is the last page (< 200 items), page 1 was fetched anyway
    // and is ignored.
    const fetchPage = (pid) => fetchJson(
      `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=${BOORU_PAGE_SIZE}&pid=${pid}&tags=${encodeURIComponent(tags)}`, true);
    const [p0, p1] = await Promise.allSettled([fetchPage(0), fetchPage(1)]);
    if (p0.status === "rejected") throw p0.reason;
    // Processes one page's posts into out, counting examined/hidden exactly
    // as the old loop did; returns whether the page was full (i.e. not the
    // last page — a short page means there is no next page to use).
    const processPage = (data) => {
      if (!Array.isArray(data) || data.length === 0) return false;
      for (const p of data) {
        examined++; // count posts actually looked at, not pages fetched
        const full = pickBooruFile(p.file_url, p.sample_url);
        if (!full) continue;
        // Same huge-file rule as Danbooru (Safebooru reports no file_size,
        // so width is the only signal — its sample is the ~850px version).
        const displayFull = p.width > 6000 && p.sample_url && p.sample_url !== full
          ? p.sample_url : null;
        const item = {
          thumb: p.preview_url,
          full,
          displayFull,
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
      return data.length >= BOORU_PAGE_SIZE;
    };
    via = p0.value.via;
    const full0 = processPage(p0.value.data);
    if (full0 && out.length < BOORU_TARGET && p1.status === "fulfilled") {
      via = p1.value.via;
      processPage(p1.value.data);
    }
    out.hidden = hidden;
    out.hiddenScope = "checked"; // only among the pages actually fetched
    out.examined = examined;
    out.via = via;
    return out;
  },

  async wallhaven(q, opts = {}) {
    // One page is 24 results — with a ratio filter on, a page of mixed
    // results can filter down to almost nothing client-side (the user's
    // "catgirl" ultrawide search: 24 fetched, 0 ultrawide on page 1), so
    // paginate until the target is met, and let the API pre-filter by
    // ratio (see wallhavenParams) so every fetched page is usable.
    // Pages 1+2 fetch concurrently (same pattern as AlphaCoders in
    // adapters-extra.js): page 2 is needed whenever page 1 is full (24
    // per page, target 48), so sequential fetching paid a 250 ms delay
    // plus a whole second round-trip per search (measured in node with
    // stubbed 150 ms pages: ~554 ms -> ~151 ms). allSettled: page 1 still
    // throws if it fails (page 2's result is then ignored — one wasted
    // fetch in that failure case). A failed page 2 just leaves the page-1
    // results standing — that differs from the old sequential code, where
    // a page-2 failure errored the whole source; partial results are the
    // better outcome there, and the success path is identical (same items,
    // same order, same `via` — the last page actually used). When page 1
    // is the last page (< 24 items), page 2 was fetched anyway and its
    // results are ignored — one wasted fetch in that case too.
    const toItem = (w) => ({
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
    });
    const [p1, p2] = await Promise.allSettled([
      fetchJson(`https://wallhaven.cc/api/v1/search?${wallhavenParams(q, { page: 1, trending: opts.trending })}`, true),
      fetchJson(`https://wallhaven.cc/api/v1/search?${wallhavenParams(q, { page: 2, trending: opts.trending })}`, true),
    ]);
    if (p1.status === "rejected") throw p1.reason;
    const out = [];
    const { data, via: v1 } = p1.value;
    let via = v1;
    out.push(...(data.data || []).map(toItem));
    if (data.data && data.data.length >= 24 && out.length < WALLHAVEN_TARGET && p2.status === "fulfilled") {
      const { data: data2, via: v2 } = p2.value;
      out.push(...(data2.data || []).map(toItem));
      via = v2;
    }
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
// opts.trending: the daily toplist instead of a query search —
// sorting=toplist, topRange=1d, and NO q parameter (Wallhaven's API takes
// q as optional; sending an empty one is harmless but pointless).
// opts.page: which results page (search pagination, v5.4).
function wallhavenParams(q, opts = {}) {
  // Accept a bare page number too (wallhavenParams('cat', 2)) — the
  // search tests call it that way; the app always passes an opts object.
  if (typeof opts === "number") opts = { page: opts };
  const p = purity();
  const params = new URLSearchParams({
    categories: "111", order: "desc", page: String(opts.page || 1),
    sorting: opts.trending ? "toplist" : "relevance",
    // Safe: sfw only (100). Mixed: sfw + sketchy (110) — works without an
    // API key, verified live 2026-11-15. NSFW: 001 — the API returns 0
    // results for anonymous requests (verified live 2026-11-15: total 0
    // for "code geass", "anime" and even an empty query; the docs say
    // "NSFW wallpapers are blocked to guests"), so a key is required.
    // The key is only sent when set in Settings; without one the adapter
    // throws and the status pill explains why instead of showing 0.
    purity: p === "safe" ? "100" : p === "mixed" ? "110" : "001",
  });
  if (opts.trending) params.set("topRange", "1d");
  else params.set("q", formatQueryFor("wallhaven", q));
  const wc = wallColor();
  if (wc) params.set("colors", wc);
  if (p === "nsfw") {
    const keyEl = staticEl("wh-key");
    const key = keyEl ? keyEl.value.trim() : "";
    if (!key) throw new Error("needs a Wallhaven API key for NSFW — paste one in Settings");
    params.set("apikey", key);
  }
  const m = minRes();
  if (m) params.set("atleast", `${m.w}x${m.h}`);
  // Ratio filter on the server, not just the client: without it a page of
  // mixed results can filter down to zero ultrawide/phone cards (verified
  // live 2026-11-15: "catgirl" safe, atleast 3440x1440, page 1 of 24 had
  // 0 ultrawide; with ratios=21x9 the API returned 2/2 ultrawide, and
  // ratios=21x9,32x9 covers 3440x1440 and 5120x1440 alike). "PC landscape"
  // is left to the client-side filter — it would need nearly every
  // landscape bucket listed, and landscape is the majority anyway.
  // NOT sent for trending: toplist+ratios returns 0 (verified live
  // 2026-11-15 — toplist+atleast alone returns 40), so trending relies on
  // the client-side ratio filter for that part.
  if (!opts.trending) {
    const ratio = deviceRatio();
    if (ratio === "ultrawide") params.set("ratios", "21x9,32x9");
    else if (ratio === "phone") params.set("ratios", "9x16,10x16,9x18");
  }
  return params;
}

// Wallhaven pagination: 24 results per page, two pages max (48) — enough
// for the ratio/min-res filters to have something to work with, without
// turning one search into a crawl.
const WALLHAVEN_TARGET = 48;

// --- Sorting ---
// The last fetched result set is kept in memory so changing the sort order
// re-renders instantly without re-searching.
let lastResults = [];
let lastReports = [];
let lastQuery = "";
// Generation counter for async loads: search() and loadTrending() capture
// it at start and only render if it still matches when their fetches
// finish. Without this, a slow first search finishing after a second one
// (or a trending load finishing after a search) overwrote the current view
// with stale results for the wrong query — the query box said "second"
// while the grid showed the first search's cards.
let viewSeq = 0;

let sortElCache = null;
function sortMode() {
  // Static control, cached like the others (see resultsBox) — the value is
  // still read fresh on every call.
  if (!sortElCache) sortElCache = $("#sort");
  const el = sortElCache;
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
  // The log value is computed ONCE per scored item and kept in a Map: the
  // old version computed Math.log10(1 + score) twice per item (once for
  // the per-source max, once for the rank) — a log10 costs ~250 ns while a
  // Map set+get costs ~54 ns, so storing it wins (measured in node, 400
  // scored items: 0.26 ms -> 0.18 ms per call). The ranks are identical —
  // the same log value divided by the same max.
  const logByItem = new Map();
  const maxBySource = new Map();
  for (const r of list) {
    if (typeof r.score === "number" && r.score > 0) {
      const v = Math.log10(1 + r.score);
      logByItem.set(r, v);
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
    const v = logByItem.get(r);
    if (v !== undefined) {
      const max = maxBySource.get(r.source);
      if (max) rank = v / max;
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
    // Epoch ms computed ONCE per item, not per comparison: Date.parse inside
    // the comparator ran ~7,000 times for a 400-item sort (same class of
    // waste the v5.3 optimizer removed from Best's rank — measured in node:
    // 0.82 ms -> 0.40 ms per 400-item sort).
    const msByItem = new Map(list.map((r) => [r, dateMs(r)]));
    return [...list].sort((a, b) => {
      const da = msByItem.get(a), db = msByItem.get(b);
      if (Number.isNaN(da) && Number.isNaN(db)) return 0;
      if (Number.isNaN(da)) return 1;
      if (Number.isNaN(db)) return -1;
      return db - da;
    });
  }
  // "largest" — the original behaviour: pixel area, largest first.
  // Area precomputed once per item (same fix as "newest" dates): the
  // comparator used to multiply width x height on every comparison.
  // Plain width*height (no ||0) so size-unknown items keep their NaN
  // area and sort exactly as before (measured in node: 0.168 -> 0.126 ms
  // per 400-item sort).
  const areaByItem = new Map(list.map((r) => [r, r.width * r.height]));
  return [...list].sort((a, b) => areaByItem.get(b) - areaByItem.get(a));
}

function renderSiteLinks(q) {
  staticEl("site-buttons").innerHTML = SITE_LINKS.map(([name, fn]) =>
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
// <img> swaps to it — the anchor's aspect-ratio never changes (see
// imgLoaded), so the card never changes height and the masonry never
// rebalances around it.
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
// later <img> swap reuses it). Calls done(true) on load, done(false, reason)
// on error OR on timeout (a stalled download counts as failed) — reason is
// "timeout" when the 15 s budget ran out, "error" when the load failed fast
// (blocked, 404, network); the card's placeholder shows it, so a giant
// file that stalls reads differently from a host that blocks this browser.
// One retry after retryDelayMs — but only for a quick error, not for a timeout: a
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
    done(false, timedOut ? "timeout" : "error");
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
// working; the user can still open the source page. `reason` ("timeout" /
// "error", from the probe — see probeUrl) is shown under the message so a
// stalled giant file reads differently from a blocked host, and the Retry
// button in the card's link row is unhidden (thumb-only cards have nothing
// to retry — their thumbnail IS the image — so theirs stays hidden).
function failReasonText(reason) {
  return reason === "timeout"
    ? "Timed out after 15 s"
    : "Blocked or missing";
}
function markImageFailed(img, reason) {
  img.dataset.state = "failed";
  img.dataset.failReason = reason || "error";
  img.style.visibility = "hidden";
  // Remember the alt for a later retry: blanking it keeps a failed <img>
  // from rendering its alt text over the badges, but a card that recovers
  // via Retry should get its description back (see restoreImgAlt in
  // loadFullImage). Only the first failure saves it — a second failure
  // must not overwrite the saved text with "".
  if (img._prevAlt === undefined) img._prevAlt = img.getAttribute("alt") || "";
  img.alt = ""; // a failed <img> would otherwise render its alt text over the badges
  // Anchor/card were cached at render time (see renderResults) — a failure
  // then needs no DOM walk, same pattern as imgLoaded. The placeholder and
  // retry button are cached lazily on the img: the placeholder is created
  // once per card and never moves, and the retry button is found once and
  // reused if the card fails again after a Retry. Fallbacks keep direct
  // calls (harness, or an img built outside renderResults) working.
  const anchor = img._anchor || img.closest("a.thumb");
  if (anchor) {
    let ph = img._placeholder || anchor.querySelector(".img-placeholder");
    if (!ph) {
      ph = document.createElement("div");
      ph.className = "img-placeholder";
      ph.setAttribute("aria-hidden", "true");
      anchor.appendChild(ph);
      img._placeholder = ph;
    }
    // (Re)build the content: a retry that fails again must show the new
    // reason, not the stale one from the first failure.
    ph.hidden = false;
    ph.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l4.5-4.5 3.5 3.5 3-3L20 19"/><line x1="4" y1="4" x2="20" y2="20"/></svg><span>Image couldn't load</span><span class="img-fail-reason">${escapeHtml(failReasonText(reason))}</span>`;
  }
  const card = img._card || img.closest(".card");
  const retry = img._retryBtn || (card && card.querySelector('[data-action="retry-img"]'));
  if (retry) img._retryBtn = retry;
  if (retry && !img.dataset.thumbOnly) retry.style.display = "";
}

// A card image finished loading, so the browser knows its true size.
// That size is used only for the badge: when the image showing is the
// FULL one, its pixels ARE the real dimensions, so the badge stops
// saying "size unknown". The box itself never changes here (see below) —
// the loaded ratio is never applied to the anchor. Idempotent — fires
// again on every src swap (thumb -> full), and the badge check makes the
// dimension fill-in a one-time thing. Items with parsed dimensions are
// unaffected (their ratio already matches; the badge is already set).
function imgLoaded(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return;
  // The image arrived: stop the loading pulse on the anchor (see
  // .card .thumb in style.css) — before it loads, the box is a pulsing
  // dark panel instead of a flat black void, so a slow thumb reads as
  // "loading" rather than "broken". The class is added on the FIRST load
  // (thumb) and never removed; a later src swap (thumb -> full) keeps
  // it. (A card that fails outright never gets it — the failure
  // placeholder covers the anchor, pulse and all.)
  const anchor = img._anchor || img.closest("a.thumb");
  if (anchor) anchor.classList.add("img-loaded");
  // The box NEVER changes here: the anchor keeps the aspect-ratio it was
  // rendered with, even when the loaded image's natural size differs from
  // the reserve (a size-unknown card keeps its 4:3 box; a listing-ratio
  // card keeps the listing ratio). The old code "corrected" the box to the
  // loaded size — and in the CSS multi-column masonry every height change
  // rebalances the columns, so cards resized AND reshuffled as images
  // loaded (the v5.6 browser test: a 355x511 placeholder box for a square
  // image rendering ~355x355, and the top-row order changing on scroll).
  // The reserve is exact for every source that publishes real dimensions
  // (API dims, schema.org, WallpaperCave's width/height, Wallpapers.com's
  // proportional listing thumbs, Zerochan's title resolution), so freezing
  // it costs nothing there; for the truly-unknown the image letterboxes
  // inside the 4:3 box with object-fit: contain — stable, and the badge
  // below still fills in the real size once the full image loads.
  // The card/badge were cached at render time (see renderResults): a load
  // then needs no DOM walk. The fallbacks keep direct calls (harness, or
  // an img built outside renderResults) working.
  const card = img._card || img.closest(".card");
  const badge = img._badge || (card && card.querySelector(".badge-res"));
  if (badge && badge.textContent === "size unknown"
      && img.getAttribute("src") === img.dataset.full) {
    badge.textContent = `${w}×${h}`;
  }
}

// Full URLs whose probe already succeeded (in this page lifetime). A
// re-render rebuilds every card, so without this every sort/ratio change
// would re-probe ~200 multi-MB images. The img's own onerror is the
// backstop if a cached verdict goes stale (see imgThumbError).
// Capped: a long session with many searches would otherwise grow this Set
// without bound (~200 entries per search). Past the cap the OLDEST verdict
// is evicted (Sets keep insertion order) and re-probed once if needed —
// one probe beats unbounded memory.
const PROBED_URLS_CAP = 2000;
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
// upgrade is charged once, at the displayed image's cost (the ~850px sample
// for huge files — see preloadCost — the full file otherwise), even if a
// smaller alternate is what actually loaded; failed or timed-out probes
// charge nothing (their partial bytes are uncounted).
// The meter therefore reads "≈" throughout. Counting via the local proxy
// was considered and rejected: only Zerochan images go through it now, so
// it would see a small fraction of the bytes, and the browser's Resource
// Timing sizes are zeroed for cross-origin images without
// Timing-Allow-Origin, which these CDNs don't send.
const GB = 1073741824;
const PRELOAD_MAX_GB = 50; // clamp for a typed amount — 50 GB of eager
// preloads is already far past useful, and it bounds a typo like 500
const PRELOAD_DEFAULT = 1073741824; // 1 GB (bytes — the stored format)
// Typed GB -> bytes: empty / 0 / negative / non-numeric = Off (0); above
// the max clamps to it.
function preloadGbToBytes(gb) {
  if (!Number.isFinite(gb) || gb <= 0) return 0;
  return Math.round(Math.min(gb, PRELOAD_MAX_GB) * GB);
}
// Stored bytes -> the GB string the input shows: up to 3 decimals,
// trailing zeros trimmed, so 536870912 shows as "0.5" and 1073741824 as "1".
function preloadBytesToGb(bytes) {
  return String(Math.round((bytes / GB) * 1000) / 1000);
}
let preloadSpent = 0; // bytes charged to eager preloads, this view (see below)
let preloadCount = 0; // wallpapers eagerly preloaded, this view (see below)
// Preload progress is PER VIEW, not per page: the meter counts one view's
// preloads, and switching views must not reset it (the v5.6 browser test:
// the meter restarted at 0 after a Favorites/Trending round trip —
// loadTrending zeroed both counters on every fresh load, so the search
// session's progress was destroyed). Each view's {spent, count} is saved
// when leaving it and restored on return (see syncPreloadView, called
// from the view setters). A NEW search is still a new session: search()
// zeroes the search view's counters AND its stored entry, so stale
// progress can never resurrect after a later round trip. Favorites never
// preloads (the pump stops there), so its entry stays {0, 0}.
const preloadStateByView = new Map(); // view key -> { spent, count }
let preloadViewKey = "search"; // the view the counters currently belong to
// Save the outgoing view's counters and restore the incoming view's.
// Called from setFavsView/setTrendingView AFTER the flag flips, so the
// current key is the new view and preloadViewKey is still the old one.
// The double-setter call pattern (renderFavsView calls setFavsView(true)
// then setTrendingView(false)) is safe: the second call is a no-op
// because the key already matches.
function syncPreloadView() {
  const key = favsView ? "favs" : trendingView ? "trending" : "search";
  if (key === preloadViewKey) return;
  preloadStateByView.set(preloadViewKey, { spent: preloadSpent, count: preloadCount });
  const s = preloadStateByView.get(key);
  preloadSpent = s ? s.spent : 0;
  preloadCount = s ? s.count : 0;
  preloadViewKey = key;
}
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
// element is retried instead of cached as null); the input's VALUE is
// still read fresh every time, so changing it — or setting it directly,
// as the harness does — always takes effect.
let preloadElCache = null;
let preloadMeterElCache = null;
let preloadMeterTextCache = null;
let preloadMeterFillCache = null;
function preloadTarget() {
  if (!preloadElCache) preloadElCache = $("#data-preload");
  const gb = preloadElCache ? Number(preloadElCache.value) : NaN;
  return preloadGbToBytes(gb);
}

// The preset chips under the input: the pressed one matches the input's
// current amount. Compared numerically (the input is free text, so "1.0"
// and "1" are the same amount, and a clamped "60" matches no chip).
function updatePreloadPresets() {
  const gb = preloadTarget() / GB;
  $$(".preload-preset").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.gb) === gb);
  });
}

function preloadCost(r) {
  // Huge originals display their ~850px sample, not the original — charge
  // the sample's estimated cost, not the original's file_size (a 98 MB
  // original with a ~150 KB sample used to eat the whole 1 GB target after
  // ~10 cards). The sample keeps the original's aspect ratio with its long
  // side at ~850 px; same 0.5 bytes/px estimate as below.
  if (r.displayFull) {
    const w = r.width || 0, h = r.height || 0;
    if (w > 0 && h > 0) {
      const s = 850 / Math.max(w, h);
      return Math.round(w * s * h * s * 0.5);
    }
  }
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
  // The meter is a live progress line only: it shows while a search is
  // preloading toward a target the user set, and is hidden otherwise —
  // Off, target reached, queue drained, Favorites view. (It used to
  // persist a "Preloaded ≈ X" summary after the fact; that text is gone —
  // the line exists to show loading in progress, not history.)
  const show = preloadRunning && target > 0;
  el.hidden = !show;
  if (!show) return;
  if (!preloadMeterTextCache) preloadMeterTextCache = el.querySelector(".preload-meter-text");
  if (!preloadMeterFillCache) preloadMeterFillCache = el.querySelector(".preload-meter-fill");
  const text = preloadMeterTextCache || el;
  text.textContent = `Preloading… ${preloadCount} wallpaper${preloadCount === 1 ? "" : "s"} · ${fmtBytes(preloadSpent)} / ${fmtBytes(target)}`;
  if (preloadMeterFillCache) {
    preloadMeterFillCache.style.width = `${Math.min(100, (preloadSpent / target) * 100).toFixed(1)}%`;
  }
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
      preloadCount++;
      updatePreloadMeter();
    }
    queueMicrotask(pumpPreload);
  });
}

function restartPreload(imgs) {
  // The full rebuild already collected the grid's imgs (see renderResults);
  // passing them in skips a second querySelectorAll over the whole grid.
  // Other callers (the sort-only fast path) pass nothing and query as before.
  // The #results lookup itself is deferred to that fallback branch, so the
  // common (imgs passed) path needs no DOM query at all.
  const box = imgs ? null : resultsBox();
  preloadQueue = imgs || (box ? [...box.querySelectorAll(".card img")] : []);
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
  // Already showing the intended display image (WallpaperCave: the thumb
  // IS the full image): nothing to upgrade. The _thumbErrored flag matters
  // — after a thumb error the src still equals the display URL, but the
  // image never arrived, so it must probe (the direct fallback candidate)
  // instead of declaring itself done. Without the flag, Retry on a
  // single-candidate card was a no-op that instantly reported success.
  if (!img._thumbErrored && img.getAttribute("src") === candidates[0]) {
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
    restoreImgAlt(img);
    img.dataset.state = "full";
    done("cached");
    return;
  }
  let i = 0;
  let dead = false;
  let cancelProbe = null;
  let lastFailReason = "error"; // what the last probe reported (see probeUrl)
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
    if (i >= candidates.length) { markImageFailed(img, lastFailReason); done("failed"); return; }
    const url = candidates[i++];
    cancelProbe = probeUrl(url, (ok, reason) => {
      cancelProbe = null;
      // The card is gone — normally _cancelUpgrade already fired done()
      // (dead), but if the img was detached some other way the pump's
      // onDone must still fire exactly once or the pump stalls forever.
      if (dead || !img.isConnected) { done("failed"); return; }
      if (ok) {
        // Cap the cache (see above): evict the oldest verdict when full.
        if (probedFullUrls.size >= PROBED_URLS_CAP) probedFullUrls.delete(probedFullUrls.values().next().value);
        probedFullUrls.add(url);
        img.src = url;
        img.style.visibility = "";
        restoreImgAlt(img);
        img.dataset.state = "full";
        done("downloaded");
      } else {
        lastFailReason = reason || "error";
        tryNext();
      }
    });
  };
  tryNext();
}

// Restore the alt text markImageFailed blanked, once a retried card
// recovers. Sets both the property and the attribute: real browsers
// reflect one into the other, the test shim does not.
function restoreImgAlt(img) {
  if (img._prevAlt === undefined) return;
  img.setAttribute("alt", img._prevAlt);
  img.alt = img._prevAlt;
  img._prevAlt = undefined;
}

// The thumbnail itself failed (its host blocks this browser, or it 404s).
// Hide the broken icon immediately (the anchor keeps the reserved box)
// and start the upgrade — the full-size URL may load even when the thumb
// host doesn't. If an upgrade is already running, the probe resolves it.
function imgThumbError(img) {
  if (img.dataset.state === "failed") return;
  // Remember the failure for loadFullImage's early return: the src still
  // equals the display URL, but the image never arrived — without this
  // flag the card would declare itself done instead of probing. It must
  // be set for EVERY branch below, not just the probe path at the end:
  // the single-candidate and already-full branches also return via
  // markImageFailed, and a Retry on those cards otherwise early-returns
  // "cached" while the img is still hidden (blank card — no placeholder,
  // no retry button). (Not cleared on Retry: a retry must probe, not
  // early-return.)
  img._thumbErrored = true;
  // Thumb-only card (Wallpapers.com): there is no cheap fallback to try, so
  // a failed thumbnail is already a total failure.
  if (img.dataset.thumbOnly) { markImageFailed(img, "error"); return; }
  // The visible image IS the full-res one (its probe already succeeded, or
  // the thumb is the full image — WallpaperCave) and it just errored:
  // there is nothing left to try. Show the placeholder instead of leaving
  // a hidden card with no explanation.
  if (img.dataset.state === "full") { markImageFailed(img, "error"); return; }
  // Single candidate and the thumb already IS it (WallpaperCave, no alts):
  // the upgrade would be a no-op, so a thumb error here is already a total
  // failure — don't hide the img and wait on a probe that returns instantly.
  const thumbAlts = (img.dataset.alts || "").split("|").filter(Boolean);
  if (img.getAttribute("src") === img.dataset.full && thumbAlts.length === 0) {
    markImageFailed(img, "error");
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
    displayFull: r.displayFull || null,
    // Wallpapers.com items have no pixel dims, only a listing aspect ratio
    // — without these, a favorite re-rendered at the 4:3 fallback and was
    // hidden by every specific ratio filter even though the item is landscape.
    ratioW: r.ratioW || 0,
    ratioH: r.ratioH || 0,
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
  const btn = staticEl("favs-toggle");
  if (!btn) return;
  btn.textContent = `★ Favorites (${favorites.length})`;
  btn.classList.toggle("active", favsView);
  btn.setAttribute("aria-pressed", favsView ? "true" : "false");
}

function setFavsView(on) {
  favsView = on;
  updateFavsToggle();
  // Entering Favorites: its status is one or two pills, so a reserve left
  // over from a many-source search would be dead space here. Leaving
  // Favorites needs no reserve either — the back path re-renders the
  // previous view's final pills directly, with no busy phase.
  if (on) setStatusReserve(0);
  syncPreloadView();
}

function renderFavsView() {
  setFavsView(true);
  setTrendingView(false);
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
let lastRenderTrendingView = false;

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
  const box = resultsBox();
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

  statusBox().innerHTML = reports.map(([name, payload, ok]) => {
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

  const box = resultsBox();
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
        <p>Tap the ♡ on any wallpaper to save it here.</p>
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
        <p><strong>${uniq.length}</strong> matching wallpaper${uniq.length === 1 ? "" : "s"} in other ratios.</p>
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
        <p><strong>${hiddenTotal.toLocaleString()}</strong> matching post${hiddenTotal === 1 ? "" : "s"} below that size.</p>
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
          <li>Try one or two words</li>
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
  // It also covers a SHRINKING visible set (ratio tightened, limit
  // lowered): the cards that stay are reused in place and the rest are
  // dropped, so a ratio toggle no longer rebuilds ~100 cards, re-parses
  // their HTML and re-observes their images (measured in node, 100 -> 50
  // ratio change: 15.5 ms median full rebuild -> 9.5 ms; a real browser
  // saves the innerHTML parse, new DOM nodes and image re-handling on
  // top). A growing set still rebuilds (new cards needed), as does any
  // proxy/view change.
  // Dropped cards get the same treatment as a full rebuild (see
  // discardRenderedCards): their in-flight upgrades are cancelled and
  // they leave the observer, so no probe keeps downloading for a card
  // that is no longer shown.
  const visiblePages = new Set(visible.map((r) => r.page));
  if (cardByPage.size >= visible.length
      && localProxyUp === lastRenderProxyUp && favsView === lastRenderFavsView
      && trendingView === lastRenderTrendingView
      && visible.every((r) => { const el = cardByPage.get(r.page); return el && el.isConnected; })) {
    for (const [page, el] of cardByPage) {
      if (visiblePages.has(page)) continue;
      const img = el.querySelector("img");
      if (img && typeof img._cancelUpgrade === "function") img._cancelUpgrade();
      if (imageObserver && img) imageObserver.unobserve(img);
      el.remove();
    }
    cardByPage = new Map(visible.map((r) => [r.page, cardByPage.get(r.page)]));
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
    // The ratio is FROZEN at render: imgLoaded never rewrites it (see
    // there). A loaded image only fills in the badge's real dimensions.
    // Freezing is what keeps the masonry still — in CSS multi-column
    // layout any height change rebalances the columns and reshuffles the
    // visual order, so a "correction" on load moved cards and changed
    // their order as the user scrolled.
    // referrerpolicy=no-referrer avoids Referer-based hotlink blocks.
    // Image URLs go through the local proxy when it is up (see
    // proxiedImageUrl) — verified 2026-11-15 to un-stall Zerochan images.
    const ratio = (r.width && r.height)
      ? `aspect-ratio:${r.width} / ${r.height}`
      : (r.ratioW && r.ratioH)
        ? `aspect-ratio:${r.ratioW} / ${r.ratioH}`
        : `aspect-ratio:4 / 3`;
    const thumbSrc = proxiedImageUrl(r.thumb);
    // The full image the card LINKS to is always the original (the anchor
    // href and the "Full image" link below). What the card DISPLAYS can be
    // smaller: for huge originals the adapter sets displayFull to the
    // ~850px sample, which loads in a second where a 17–98 MB original
    // stalls past the probe timeout (see the Danbooru adapter). The
    // original stays the first fallback candidate, so a blocked sample
    // still tries it before the card fails.
    const displayFull = r.displayFull || r.full;
    const fullUrl = proxiedImageUrl(r.full);
    // displayFull is usually r.full itself — reuse fullUrl instead of
    // re-running the proxy check on the same string (one fewer
    // proxiedImageUrl call per card; identical output, same string).
    const displayUrl = displayFull === r.full ? fullUrl : proxiedImageUrl(displayFull);
    // What an upgrade of this card costs the preload meter (see preloadCost).
    const cost = preloadCost(r);
    const alts = [
      ...(displayFull !== r.full ? [r.full] : []),
      ...(r.alts || []).filter((u) => u && u !== r.full && u !== displayFull),
    ].map(proxiedImageUrl);
    // If the full image is proxy-routed (Zerochan, WallpaperCave), keep
    // the direct URL as a final fallback candidate: a proxy that fails
    // for this one image must not brick a card the direct fetch could
    // still serve. The proxied URL is tried first, so a healthy proxy is
    // never bypassed — and with no proxy configured the direct URL is
    // already the primary, so nothing is appended. (fullUrl IS
    // proxiedImageUrl(r.full), computed above — no second call per card.)
    if (fullUrl !== r.full && !alts.includes(r.full)) alts.push(r.full);
    // Favorite state read once per card, from the per-render Set above.
    const fav = favPages.has(r.page);
    return `
    <article class="card">
      <a class="thumb" href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener" style="${ratio}"><img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${escapeHtml(thumbSrc)}" data-full="${escapeHtml(displayUrl)}" data-alts="${escapeHtml(alts.join("|"))}"${r.thumbOnly ? ' data-thumb-only="1"' : ""} data-cost="${cost}" data-state="thumb" onload="imgLoaded(this)" onerror="imgThumbError(this)" alt="${r.source} wallpaper ${res}">
        <span class="badge badge-res">${res}</span>
        <span class="badge badge-src">${r.source}</span>
      </a>
      <div class="meta">
        <div class="links">
          <a href="${escapeHtml(r.page)}" target="_blank" rel="noopener">Source page ↗</a>
          <a class="full-link" href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener">Full image ↗</a>
          <button type="button" class="img-retry" data-action="retry-img" style="display:none">Retry</button>
          <button type="button" class="fav-btn${fav ? " fav-on" : ""}" data-action="toggle-fav" data-page="${escapeHtml(r.page)}" aria-pressed="${fav ? "true" : "false"}" aria-label="Save to favorites" title="Save to favorites">${fav ? "♥" : "♡"}</button>
        </div>
      </div>
    </article>`;
  }).join("");
  // Start full-res upgrades for cards near the viewport (the observer
  // fires for the rest as the user scrolls). Without IntersectionObserver,
  // load everything immediately.
  const observer = getImageObserver();
  const imgs = box.querySelectorAll(".card img");
  imgs.forEach((img) => {
    if (observer) observer.observe(img);
    else loadFullImage(img);
  });
  // Remember the rendered cards (in visible order) for the sort-only fast
  // path above — and the proxy state / view they were rendered under. The
  // cards come from the imgs just observed (one <img> per card, in document
  // order) instead of a second querySelectorAll over the whole grid. The img
  // is a direct child of its anchor, which is a direct child of the card
  // (see the template) — two property reads instead of a closest() walk per
  // img, same nodes; the fallback keeps harness-built imgs working.
  const cards = [...imgs].map((img) => (img.parentElement && img.parentElement.parentElement) || img.closest(".card"));
  // Cache the nodes imgLoaded needs per image (anchor, card, badge) so a
  // load doesn't walk the DOM three times per image — ~300 traversals
  // saved per 100-card render across the thumb + full loads (measured in
  // node: 7.23 -> 2.99 ms per 100 loads). The lookups are O(1), not walks:
  // the img is a direct child of its anchor, and the res badge is its
  // next element sibling (see the card template) — so attaching the refs
  // costs no traversal either. The fallbacks keep any img built outside
  // renderResults (harness, template drift) working: a missing badge
  // just stays null and imgLoaded falls back to a query at load time.
  // The card itself is free (the closest() above already found it).
  imgs.forEach((img, i) => {
    img._anchor = img.parentElement || img.parent || img.closest("a.thumb");
    img._card = cards[i];
    const sib = img.nextElementSibling;
    img._badge = (sib && typeof sib.className === "string" && sib.className.includes("badge-res")) ? sib : null;
  });
  cardByPage = new Map(visible.map((r, i) => [r.page, cards[i]]));
  lastRenderProxyUp = localProxyUp;
  lastRenderFavsView = favsView;
  lastRenderTrendingView = trendingView;
  restartPreload(imgs);
}

async function search(ev) {
  ev.preventDefault();
  saveSettings();
  const q = staticEl("query").value.trim();
  if (!q) return;
  // Generation guard against overlapping loads (see viewSeq above).
  const seq = ++viewSeq;
  // A new search shows search results, not the Favorites or Trending view.
  setFavsView(false);
  setTrendingView(false);
  // New search session: the preload meter starts over (bytes already
  // downloaded stay downloaded — the meter counts this search's preloads).
  // Zero the counters AND the stored search entry, or a later round trip
  // would resurrect the old numbers (see syncPreloadView).
  preloadSpent = 0;
  preloadCount = 0;
  preloadStateByView.set(preloadViewKey, { spent: 0, count: 0 });
  updatePreloadMeter();
  renderSiteLinks(q);

  const chosen = $$(".source:checked").map((c) => c.value);
  // Reserve the status row for the pills this search will produce (see
  // setStatusReserve): without it the row grows a line when results
  // render and the grid jumps down.
  setStatusReserve(chosen.length);
  statusBox().innerHTML = `<span class="status-pill pill-busy"><span class="spinner"></span>Searching ${chosen.length} source${chosen.length === 1 ? "" : "s"}…</span>`;
  // The skeletons replace the cards — discard their in-flight upgrades
  // first (see discardRenderedCards), or an orphaned probe stalls the
  // preload pump and keeps downloading for a card that is already gone.
  discardRenderedCards();
  resultsBox().innerHTML = Array.from({ length: 8 }, () =>
    `<div class="skeleton" aria-hidden="true"><div class="skeleton-thumb"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`).join("");
  // The skeletons replace the cards — drop the sort-only cache (its entries
  // are detached; the isConnected check in renderResults would reject them,
  // but there is no reason to keep holding them).
  cardByPage = new Map();

  const reports = [];
  const all = [];
  if (!chosen.length) {
    // All sources unchecked: say so in the pill instead of showing an
    // empty status line above a bare "No wallpapers found".
    reports.push(["Search", "no sources selected — enable at least one in Sources", true, 0]);
  }
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
      reports.push(sourceReport(name, items, passing));
    } catch (err) {
      reports.push([name, err, false, 0]);
    }
  }));
  // Keep the fetched set so a sort change can re-render without re-searching.
  // Assigned only when this load is still the newest: a stale load's data
  // must not replace the current search's — otherwise a sort change after
  // an overlapping search would flip the grid back to the old query.
  if (seq === viewSeq) {
    lastResults = all;
    lastReports = reports;
    lastQuery = q;
  }
  // Only the newest load renders — and only into the search view. A slow
  // load finishing after a newer search, a trending load, or a switch to
  // Favorites must not overwrite the current view with the wrong query's
  // results.
  if (seq !== viewSeq || trendingView || favsView) return;
  renderResults(all, reports, q);
}

$("#search-form").addEventListener("submit", search);
$("#proxy").addEventListener("change", saveSettings);
$("#worker-url").addEventListener("change", () => { saveSettings(); refreshProxyAndRerender(); });
$("#purity").addEventListener("change", saveSettings);
$("#wh-key").addEventListener("change", saveSettings);
$("#sort").addEventListener("change", () => {
  saveSettings();
  if (favsView) renderFavsView();
  else if (trendingView) renderTrendingView();
  else if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
});
$("#device-ratio").addEventListener("change", () => {
  saveSettings();
  if (favsView) renderFavsView();
  else if (trendingView) renderTrendingView();
  else if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
});
const limitEl = $("#limit");
if (limitEl) limitEl.addEventListener("change", () => {
  saveSettings();
  if (favsView) renderFavsView();
  else if (trendingView) renderTrendingView();
  else if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
});
const preloadEl = $("#data-preload");
if (preloadEl) {
  // "input" so the meter and the pump follow while typing (a half-typed
  // "2." still parses as 2 GB; clearing the field means Off until a new
  // number lands); "change" covers Enter/blur the same way.
  const onPreloadInput = () => {
    saveSettings();
    updatePreloadPresets();
    updatePreloadMeter();
    pumpPreload(); // raising the target resumes a stopped chain; lowering
    // it stops the pump at its next check (already-spent bytes stay spent)
  };
  preloadEl.addEventListener("input", onPreloadInput);
  preloadEl.addEventListener("change", onPreloadInput);
}
// Preset chips fill the input (and persist + resume the pump, like typing).
$$(".preload-preset").forEach((b) => b.addEventListener("click", () => {
  const el = staticEl("data-preload");
  if (!el) return;
  el.value = b.dataset.gb || "0";
  saveSettings();
  updatePreloadPresets();
  updatePreloadMeter();
  pumpPreload();
}));
// Color swatches: persist the choice (and the pressed state) immediately;
// it applies to Wallhaven on the next search, like the Content select.
// No auto re-search — same as changing purity.
$$(".swatch").forEach((b) => b.addEventListener("click", () => setWallColor(b.dataset.color || "")));
// Favorites toggle: show only saved favorites (in the current sort order),
// or go back to where the toggle came from — the Trending view if that's
// where the user was, otherwise the last search results (or the idle state
// if none yet).
const favsToggleBtn = $("#favs-toggle");
if (favsToggleBtn) favsToggleBtn.addEventListener("click", () => {
  if (favsView) {
    setFavsView(false);
    if (viewBeforeFavs === "trending" && lastTrendingReports.length) renderTrendingView();
    else {
      // Back to Search: mark its tab current again — renderResults below
      // doesn't touch the tabs, and setTrendingView(false) must run AFTER
      // setFavsView(false) or the guard leaves no tab active (see below).
      setTrendingView(false);
      if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
      else { discardRenderedCards(); resultsBox().innerHTML = idleResultsHtml; }
    }
  } else {
    viewBeforeFavs = trendingView ? "trending" : "search";
    renderFavsView();
  }
});

// Tabs: Search shows the last search (or the idle state); Trending loads
// what's popular now (from memory on repeat visits, fresh on ↻).
const tabSearchBtn = $("#tab-search");
if (tabSearchBtn) tabSearchBtn.addEventListener("click", () => {
  // Favs first, THEN the tab: setTrendingView(false) while favsView is
  // still on leaves the Search tab inactive (the guard in setTrendingView
  // correctly refuses to mark it current while Favorites is showing).
  setFavsView(false);
  setTrendingView(false);
  if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
  else { discardRenderedCards(); resultsBox().innerHTML = idleResultsHtml; }
});
const tabTrendingBtn = $("#tab-trending");
if (tabTrendingBtn) tabTrendingBtn.addEventListener("click", () => loadTrending(false));
const trendingRefreshBtn = $("#trending-refresh");
if (trendingRefreshBtn) trendingRefreshBtn.addEventListener("click", () => loadTrending(true));
// Popular-search chips: run that term as a normal search — back to the
// Search tab, the term in the box, submitted.
$$(".trend-chip").forEach((b) => b.addEventListener("click", () => {
  const q = b.dataset.query || "";
  if (!q) return;
  setTrendingView(false);
  setFavsView(false);
  staticEl("query").value = q;
  $("#search-form").requestSubmit();
}));
// Re-probe both proxies and re-render the current view if either just came
// up: image URLs are proxy-routed at render time, so a proxy that appears
// after the render (local proxy started, Worker URL pasted) only takes
// effect for images after a re-render. Shared by the banner's recheck
// button and the Worker URL field's change handler. Previously-verified
// full images swap in immediately (see probedFullUrls), so this is cheap.
// Stays in the Favorites view if that's where the user is.
async function refreshProxyAndRerender() {
  const wasUp = localProxyUp, wasWorkerUp = workerUp;
  await updateProxyStatus();
  const cameUp = (!wasUp && localProxyUp) || (!wasWorkerUp && workerUp);
  if (!cameUp) return;
  if (favsView) renderFavsView();
  else if (trendingView && lastTrendingReports.length) renderTrendingView();
  else if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
}
const recheckBtn = $("#proxy-recheck");
if (recheckBtn) recheckBtn.addEventListener("click", refreshProxyAndRerender);

// One status-pill line per source, shared by search() and loadTrending():
// same wording, same hidden-count note, same purity suffixes — a trending
// pill must read exactly like a search pill for the same source.
// `via` comes from the items themselves (per-call), never a shared global
// — parallel fetches used to overwrite each other's label. When the local
// proxy is down, a public-proxy via is labelled as such ("via corsfix —
// public proxy") so it doesn't read like the healthy local-proxy path.
function sourceReport(name, items, passing) {
  const via = items.via || "";
  const PUBLIC_VIAS = ["corsfix", "allorigins", "allorigins (json)", "cors.lol"];
  const viaLabel = via
    ? ` (via ${via}${!localProxyUp && PUBLIC_VIAS.includes(via) ? " — public proxy" : ""})`
    : "";
  let msg;
  if (items.empty && passing.length === 0) {
    // The site answered with a genuine empty page (Wallpapers.com for
    // "catgirl" — verified live: HTTP 200, empty grid). That is not a
    // failure, so it gets a green "0 found" pill saying so, not the
    // red "no results parsed" one. A real fetch/parse failure still
    // throws in the adapter and lands in the red pill below.
    // No purity/hidden suffixes here — they would only muddy the point.
    msg = `0 found${viaLabel}`;
  } else {
    msg = `${passing.length} found${viaLabel}`;
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
      else if (name === "safebooru") msg += " · safe-only site";
      else msg += " · no purity filter";
    }
  }
  const hidden = items.hidden || 0;
  const m = minRes();
  if (hidden > 0 && m) {
    msg += ` · ${hidden.toLocaleString()} below ${m.w}×${m.h} — lower the filter to see them`;
  }
  return [name, msg, true, hidden];
}

// --- Trending ---
// The Trending tab shows what's popular right now, no query needed:
// Wallhaven's daily toplist (sorting=toplist, topRange=1d) and Danbooru's
// most popular posts today (order:rank + today's date). Only those two:
// Safebooru has no popularity endpoint, and AlphaCoders' top page is four
// featured items with no dimensions — not a real feed (checked live
// 2026-11-15). The scraped sites have no trending listing either.
// The same filters as search apply — Content mode and the server-side
// min-resolution filter are inside the adapters (purity(), minRes(),
// wallhavenParams), the device/ratio filter and the result limit run in
// renderResults(), and the source checkboxes are respected (an unchecked
// Wallhaven/Danbooru is skipped). Favorites work on trending cards exactly
// like search cards (same renderResults + renderedByPage).
// Like search, the last fetched set is kept in memory so sort/ratio
// changes re-render without re-fetching; the ↻ button forces a fresh load.
const TRENDING_SOURCES = ["wallhaven", "danbooru"];
let trendingView = false;
let trendingLoading = false;
let lastTrendingResults = [];
let lastTrendingReports = [];
// Which view the Favorites toggle came from ("search" or "trending"), so
// toggling back restores it instead of always landing on the last search.
let viewBeforeFavs = "search";

function setTrendingView(on) {
  trendingView = on;
  const s = staticEl("tab-search"), t = staticEl("tab-trending");
  // Favorites is a third view with no tab of its own: renderFavsView calls
  // setTrendingView(false) while favsView is on, and the Search tab must
  // not claim to be current then (its visual state is neutralised in CSS;
  // see main:has(#favs-toggle.active)).
  const searchCurrent = !on && !favsView;
  if (s) { s.classList.toggle("active", searchCurrent); s.setAttribute("aria-selected", searchCurrent ? "true" : "false"); }
  if (t) { t.classList.toggle("active", on); t.setAttribute("aria-selected", on ? "true" : "false"); }
  const panel = staticEl("trending-panel");
  if (panel) panel.hidden = !on;
  // Entering Trending: at most two sources, so its pills fit one row —
  // clear any reserve left by a many-source search (renderTrendingView
  // re-renders final pills directly, with no busy phase, so nothing here
  // needs reserving; loadTrending re-sets it right after, to off as well
  // since its chosen list is capped at the two trending sources).
  if (on) setStatusReserve(0);
  syncPreloadView();
}

function renderTrendingView() {
  setTrendingView(true);
  setFavsView(false);
  renderResults(lastTrendingResults, lastTrendingReports, "Trending");
}

async function loadTrending(force) {
  setTrendingView(true);
  setFavsView(false);
  // Already loaded and not forced: re-render from memory, no re-fetch
  // (same as switching back to a previous search).
  if (!force && lastTrendingReports.length) { renderTrendingView(); return; }
  if (trendingLoading) return;
  trendingLoading = true;
  const seq = ++viewSeq; // generation guard, see search()
  // No meter reset here: switching views must not restart the meter (the
  // v5.6 browser test — a fresh Trending load used to zero both counters,
  // destroying the search session's progress). The trending view gets its
  // own counters, saved and restored by syncPreloadView: a first visit
  // starts at 0, a return visit resumes where it left off, and the search
  // session's progress survives the round trip.
  updatePreloadMeter();

  const chosen = $$(".source:checked").map((c) => c.value).filter((n) => TRENDING_SOURCES.includes(n));
  setStatusReserve(chosen.length);
  statusBox().innerHTML = `<span class="status-pill pill-busy"><span class="spinner"></span>Loading what's trending…</span>`;
  // The skeletons replace the cards — discard their in-flight upgrades
  // first (see discardRenderedCards), or an orphaned probe stalls the
  // preload pump and keeps downloading for a card that is already gone.
  discardRenderedCards();
  resultsBox().innerHTML = Array.from({ length: 8 }, () =>
    `<div class="skeleton" aria-hidden="true"><div class="skeleton-thumb"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`).join("");
  cardByPage = new Map();

  const reports = [];
  const all = [];
  if (!chosen.length) {
    reports.push(["Trending", "no trending sources selected — enable Wallhaven or Danbooru in Sources", true, 0]);
  } else {
    await Promise.all(chosen.map(async (name) => {
      try {
        const items = await SOURCES[name](null, { trending: true });
        // minRes read once per source, not once per item (same as search()).
        const m = minRes();
        const passing = items.filter((r) => passesMinRes(r, m));
        all.push(...passing);
        reports.push(sourceReport(name, items, passing));
      } catch (err) {
        reports.push([name, err, false, 0]);
      }
    }));
  }
  // Keep the fetched set for back-navigation — but only when this load is
  // still the newest (see search(): a stale load must not replace the
  // current view's data).
  if (seq === viewSeq) {
    lastTrendingResults = all;
    lastTrendingReports = reports;
  }
  // Reset before the early return below: a stale load must not leave the
  // flag stuck, or every later refresh click would be swallowed.
  trendingLoading = false;
  // Only the newest load renders, and only while the Trending view is
  // still showing (same race as search() above).
  if (seq !== viewSeq || !trendingView || favsView) return;
  renderResults(all, reports, "Trending");
}

// Heart buttons (delegated) + retry buttons + empty-state actions: drop
// the device/ratio filter and re-render from memory, or drop the
// min-resolution filter and search again.
resultsBox().addEventListener("click", (ev) => {
  const retryBtn = ev.target.closest('[data-action="retry-img"]');
  if (retryBtn) {
    // Retry a failed card from scratch: hide the placeholder, clear the
    // upgrade state, and probe the candidates again (the sample first for
    // huge files, then the original — see loadFullImage). The img stays
    // hidden until a probe succeeds, which unhides it; a second failure
    // re-marks it with the new reason. Thumb-only cards never show this
    // button (there is nothing to retry — see markImageFailed).
    const card = retryBtn.closest(".card");
    const img = card && card.querySelector("img");
    if (!img) return;
    // The placeholder was cached on the img when the failure was marked
    // (see markImageFailed); the anchor lookup is the fallback for an img
    // built outside renderResults.
    const ph = img._placeholder || (img._anchor || img.closest("a.thumb"))?.querySelector(".img-placeholder");
    if (ph) ph.hidden = true;
    img.dataset.upgradeStarted = "";
    img.dataset.state = "thumb";
    img.dataset.failReason = "";
    retryBtn.style.display = "none";
    loadFullImage(img);
    return;
  }
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
    staticEl("device-ratio").value = "all";
    saveSettings();
    if (favsView) renderFavsView();
    else if (trendingView) renderTrendingView();
    else renderResults(lastResults, lastReports, lastQuery);
    return;
  }
  if (!ev.target.closest('[data-action="clear-res"]')) return;
  staticEl("min-res").value = "0";
  // In the Trending view there is no search to re-run — reload trending
  // with the loosened filter instead.
  if (trendingView) loadTrending(true);
  else $("#search-form").requestSubmit();
});
loadSettings();
const idleResultsHtml = resultsBox().innerHTML;
updateFavsToggle();
