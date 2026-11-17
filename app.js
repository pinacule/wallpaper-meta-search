// Wallpaper Meta-Search — one query, several wallpaper sources, no server.
// Direct: Danbooru (sends CORS *). Via the proxy chain (proxy-client.js):
// Wallhaven, Safebooru, and the HTML-scraping adapters in adapters-extra.js.
// Gelbooru is inline when a free account's API key + user ID are set in
// Settings — its API returns 401 for anonymous requests (verified
// 2026-11-15), so without a key the adapter throws before fetching and
// the status pill says "needs API key" instead of showing 0.
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
//   Danbooru (cdn.donmai.us): a 3220x5400 card failed in-grid on a slow
//     VPN link while the proxied sources rendered fine (field report
//     2026-11-16) — the proxy's server-side fetch with streaming is the
//     healthier path for this CDN, and the local proxy already allows
//     the host (proxy/server.mjs) as does the Worker (worker/worker.js).
//     The proxy is only used when it is up; when it is down (or no
//     Worker is set) proxiedImageUrl returns the direct URL, so a
//     missing proxy can never break Danbooru — it just loads direct.
// The proxy is the local one when it is up (localhost pages only), else the
// user's Cloudflare Worker when one is set and answering (workerUp —
// probed at startup like the local proxy). With neither configured the
// images load direct, as before.
// NOTE: a proxy does NOT change the egress IP, so it can't dodge an
// IP-based block (e.g. a CDN 403ing a datacenter/VPN IP).
const IMAGE_PROXY_HOSTS = new Set(["static.zerochan.net", "s3.zerochan.net", "wallpapercave.com", "cdn.donmai.us"]);
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
  // A search owns the status row now: drop Trending's own reserve (see
  // loadTrending) so the two classes never stack.
  statusBox().classList.remove("status-reserved-trending");
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
// (Wallhaven and Gelbooru are inline now, so they are NOT here — see
// SOURCES. The scrapers in adapters-extra.js drop their own sites from
// this list when they register.)
const SITE_LINKS = [
  ["WallpaperAccess", (q) => `https://wallpaperaccess.com/search?q=${encodeURIComponent(q)}`],
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
    // Round 13: the default is now All (0), not 100. A stored "100" is
    // almost always the old default, not an explicit choice — 100 was the
    // only default the app ever had — so migrate it once, so returning
    // users get the new default too (changing the HTML default alone
    // does nothing for anyone with a stored value). The flag stops it
    // re-applying, so anyone who really wants 100 re-picks it once and
    // it sticks. The migrated value is written back immediately: without
    // that, a user who never touches Settings would fall back to the
    // stored "100" on the next load.
    let limVal = ["50", "100", "150", "200", "0"].includes(lim) ? lim : "0";
    if (localStorage.getItem("wms.limitMigrated13") !== "1" && limVal === "100") {
      limVal = "0";
      localStorage.setItem("wms.limit", "0");
    }
    localStorage.setItem("wms.limitMigrated13", "1");
    limEl.value = limVal;
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
  const gbKeyEl = staticEl("gb-key");
  if (gbKeyEl) gbKeyEl.value = localStorage.getItem("wms.gbKey") || "";
  const gbUserEl = staticEl("gb-user");
  if (gbUserEl) gbUserEl.value = localStorage.getItem("wms.gbUserId") || "";
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
  const gbKeyEl = staticEl("gb-key");
  if (gbKeyEl) localStorage.setItem("wms.gbKey", gbKeyEl.value.trim());
  const gbUserEl = staticEl("gb-user");
  if (gbUserEl) localStorage.setItem("wms.gbUserId", gbUserEl.value.trim());
}

// Content mode: "safe" (default), "mixed" (safe + suggestive) or "nsfw"
// (explicit only). What each source does in NSFW mode is in the README's
// purity table — Danbooru works anonymously, Wallhaven needs an API key,
// Gelbooru needs an API key + user ID, Safebooru has nothing, the
// scraped sites have no filter at all.
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
// to the default (All, 0) rather than hiding everything or nothing.
let limitElCache = null;
function resultLimit() {
  // Static control, cached like the others (see resultsBox) — the value is
  // still read fresh on every call.
  if (!limitElCache) limitElCache = $("#limit");
  const el = limitElCache;
  const v = el ? el.value : "";
  if (!v || v === "0") return 0;
  const n = parseInt(v, 10);
  return [50, 100, 150, 200].includes(n) ? n : 0;
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

// Reduce an aspect ratio to lowest terms for the badge: a card whose pixel
// size is unknown but whose ratio IS known (Wallpapers.com listing thumbs —
// the thumbnail preserves the full image's aspect ratio) shows "16:9"
// instead of "size unknown". The ratio is real; the pixels genuinely are
// unknown, so the badge shows a ratio (with a colon), never a pixel size
// (with a ×) that would pretend to know them. The loaded thumb's own
// natural size is NOT used here: that is the 900w thumbnail's pixels, not
// the full image's, and which variant loaded (900w high vs 300w thumb)
// would change the number for the same wallpaper.
function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1;
}
function ratioLabel(w, h) {
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

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
// Round 10: the booru initial fetch can page past pid 1 when the target
// isn't met — the min-res filter can hide most of two pages, and stopping
// at pid 1 then leaves the source short for no reason other than an
// arbitrary page count. Pids 0+1 fetch concurrently; the extra-pid loop
// is sequential (one pid at a time, so a query that meets its target from
// pid 0+1 pays nothing extra) and bounded by this cap (pids 0-4, i.e. up
// to 3 extra sequential fetches).
const BOORU_DAPI_MAX_PID = 4;

// Fetched-but-unprocessed booru page (round 10 optimizer): Safebooru and
// Gelbooru fetch pids 0+1 concurrently; when pid 0 alone meets the target,
// pid 1's data used to be discarded and the first load-more click re-fetched
// the same page — one wasted request per search per source in the common
// no-min-res case. One entry per source, keyed by the fetch fingerprint
// (tags incl. purity + min-res), so load more serves it from memory.
// Cleared at the start of each initial fetch, so a stale page from an
// earlier search can never be served; consumed (deleted) on use.
const booruPageStash = new Map(); // source -> { fp, pid, data, via }
function booruStashFp(tags, m) {
  return `${tags}|${m ? `${m.w}x${m.h}` : "any"}`;
}

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


// Tags are display + click-to-search data, never ranking data: cap them
// so a 40-tag Danbooru post doesn't bloat the result object, the card
// HTML, or a Favorites snapshot. Non-strings and blanks are dropped.
const MAX_TAGS = 12;
function capTags(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    if (typeof t !== "string") continue;
    const s = t.trim();
    if (s) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
// Gelbooru credentials from Settings (both are required — the dapi 401s
// without either). Read fresh on every call so a pasted key takes effect
// immediately, like workerUrlSetting().
function gelbooruCreds() {
  const keyEl = staticEl("gb-key");
  const userEl = staticEl("gb-user");
  return {
    key: keyEl ? keyEl.value.trim() : "",
    userId: userEl ? userEl.value.trim() : "",
  };
}

// --- Source adapters. Each returns [{ thumb, full, alts, page, width, height, source, date, score }].
// `alts` is the ordered list of alternate URLs for the same image to try if
// `full` fails to load (smaller versions from the same source — see the
// image loader in app.js: loadFullImage/probeUrl). `date` is an ISO string where the API provides one (Danbooru
// and Wallhaven via `created_at`, Gelbooru via `created_at`), null otherwise. `score` is the source's
// popularity signal where one exists (Danbooru `score`, Wallhaven
// `favorites`, Gelbooru `score`), null otherwise — Safebooru's dapi `score` is null ~88% of
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
    // Skipped for load more too: the count is a whole-database figure,
    // unchanged by fetching another page — the initial value stands.
    if (m && !trending && !opts.more) {
      hiddenPromise = (async () => {
        const [{ data: all }, { data: pass }] = await Promise.all([
          fetchJson(`https://danbooru.donmai.us/counts/posts.json?tags=${encodeURIComponent(baseTags)}`, false),
          fetchJson(`https://danbooru.donmai.us/counts/posts.json?tags=${encodeURIComponent(searchTags)}`, false),
        ]);
        return Math.max(0, (all.counts?.posts ?? 0) - (pass.counts?.posts ?? 0));
      })().catch(() => 0);
    }

    // Load more (round 8): opts.more fetches exactly one further page,
    // starting at opts.startPage — the cursor the initial fetch returned
    // (see nextCursor below). A more-batch takes the whole page (up to
    // 200 posts), not the 100 target: the page is the natural batch, and
    // the render cap (not the fetch) decides what shows.
    const startPage = opts.startPage || 1;
    const pageCount = opts.maxPages || BOORU_MAX_PAGES;
    const target = opts.more ? BOORU_PAGE_SIZE : BOORU_TARGET;
    const out = [];
    let via = "";
    let fetchedUpTo = startPage - 1; // last page actually fetched
    let lastPageShort = false; // the last page came back short/empty: no more pages
    for (let page = startPage; page < startPage + pageCount && out.length < target; page++) {
      const { data, via: v } = await fetchJson(
        `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(fetchTags)}&limit=${BOORU_PAGE_SIZE}&page=${page}`, false);
      via = v;
      fetchedUpTo = page;
      if (!Array.isArray(data) || data.length === 0) { lastPageShort = true; break; }
      for (const p of data) {
        const full = pickBooruFile(p.file_url, p.large_file_url);
        if (!full) continue;
        // Huge originals (multi-MB / very wide — a 98 MB file turned up in
        // the top 200 for "catgirl") stall past the 15 s probe timeout or
        // get cut off on slow links, and the card fails even though the
        // ~850px sample would load in a second. Show the sample in the
        // grid instead (displayFull); the Full image link still opens the
        // original. The sample is also the first probe candidate, with the
        // original as a fallback (see the card template). The 5 MB line is
        // the probe budget expressed as a size: a 5 MB file needs ~2.7 Mbps
        // sustained for the full 15 s, so anything above it times out on a
        // slow or VPN link (field report 2026-11-16: a 3220x5400 card
        // failed in-grid while its sample would have loaded in ~1 s). The
        // old 15 MB line only caught the worst cases. The sample is ~850px
        // on the long side — visually identical in a ~300px card — and the
        // preload meter charges the sample's cost, not the original's.
        const huge = (typeof p.file_size === "number" && p.file_size > 5 * 1024 * 1024)
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
          // The API returns every tag (`tag_string`, space-separated) —
          // stored, capped, so the card can show them and a click can
          // search them (see the card template).
          tags: capTags(typeof p.tag_string === "string" ? p.tag_string.split(" ") : []),
        });
        if (out.length >= target) break;
      }
      if (data.length < BOORU_PAGE_SIZE) { lastPageShort = true; break; } // last page
      if (out.length < target) await sleep(BOORU_PAGE_DELAY_MS);
    }
    out.hidden = hiddenPromise ? await hiddenPromise : 0;
    out.hiddenScope = "db"; // exact count across the whole database
    out.via = via;
    // Load-more cursor: the next page not yet fetched, or null when the
    // last page was short (Danbooru has no more pages for this query).
    out.nextCursor = lastPageShort ? null : fetchedUpTo + 1;
    out.exhausted = lastPageShort;
    return out;
  },

  async safebooru(q, opts = {}) {
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
          // Safebooru returns tags as a space-separated string.
          tags: capTags(typeof p.tags === "string" ? p.tags.split(" ") : []),
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
    // Load more (round 8): one pid per click, starting at the cursor the
    // initial fetch returned. A failed pid throws — loadMore catches it
    // and leaves the cursor alone, so the next click retries the same pid.
    if (opts.more) {
      const pid = opts.startPid;
      // Stashed pid 1 (see below): the initial fetch already downloaded
      // this page — serve it from memory instead of fetching it twice.
      // A fingerprint mismatch (query/purity/min-res changed since the
      // search) falls through to a fresh fetch, as before.
      const stashed = booruPageStash.get("safebooru");
      let data, v;
      if (stashed && stashed.pid === pid && stashed.fp === booruStashFp(tags, m)) {
        booruPageStash.delete("safebooru");
        ({ data, via: v } = stashed);
      } else {
        ({ data, via: v } = await fetchPage(pid));
      }
      via = v;
      const full = processPage(data);
      out.hidden = hidden;
      out.hiddenScope = "checked"; // only among the pages actually fetched
      out.examined = examined;
      out.via = via;
      out.nextCursor = full ? pid + 1 : null;
      out.exhausted = !full;
      return out;
    }
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
    // target or is the last page (< 200 items), page 1 was fetched anyway;
    // when the target is met it is stashed for load more (see below)
    // instead of being ignored.
    // A new initial fetch invalidates any stashed page from an earlier
    // search (a rejected pid 1 must not leave an old page behind).
    booruPageStash.delete("safebooru");
    const [p0, p1] = await Promise.allSettled([fetchPage(0), fetchPage(1)]);
    if (p0.status === "rejected") throw p0.reason;
    via = p0.value.via;
    const full0 = processPage(p0.value.data);
    let pid1Processed = false, full1 = false;
    if (full0 && out.length < BOORU_TARGET && p1.status === "fulfilled") {
      via = p1.value.via;
      full1 = processPage(p1.value.data);
      pid1Processed = true;
    }
    // Pid 1 fetched but not needed (pid 0 met the target): stash it for
    // the first load-more click instead of discarding it — the cursor
    // below already points at pid 1, so load more serves this page from
    // memory. A short pid 0 means there is no pid 1 at all (nothing to
    // stash, and the cursor is null anyway).
    if (!pid1Processed && p1.status === "fulfilled" && full0 && out.length >= BOORU_TARGET) {
      booruPageStash.set("safebooru", { fp: booruStashFp(tags, m), pid: 1, data: p1.value.data, via: p1.value.via });
    }
    // Round 10: keep paging while the target isn't met and pages keep
    // coming back full. Pids 0+1 fetch concurrently; the extra pids are
    // fetched sequentially, one at a time, so a query that meets its
    // target from pid 0+1 pays nothing extra, and the BOORU_DAPI_MAX_PID
    // cap bounds the worst case. A failed extra pid just leaves the
    // earlier results standing (the cursor points at it, so load more
    // retries it); a pid 1 that was rejected in the concurrent pair is
    // retried fresh here instead of being skipped.
    let nextPid = pid1Processed ? 2 : 1;
    let lastFull = pid1Processed ? full1 : full0;
    while (out.length < BOORU_TARGET && lastFull && nextPid <= BOORU_DAPI_MAX_PID) {
      try {
        const { data, via: v } = await fetchPage(nextPid);
        via = v;
        lastFull = processPage(data);
        nextPid++;
      } catch {
        break;
      }
    }
    out.hidden = hidden;
    out.hiddenScope = "checked"; // only among the pages actually fetched
    out.examined = examined;
    out.via = via;
    // Load-more cursor: the next pid not yet PROCESSED, or null when the
    // last processed page was short (no more pages). Pid 1 was fetched
    // alongside pid 0 but is only processed when pid 0 alone doesn't meet
    // the target — when it wasn't processed it sits in booruPageStash, so
    // the first load-more click serves it from memory instead of
    // re-fetching it. A short pid 0 means there is no pid 1 at all.
    out.nextCursor = lastFull ? nextPid : null;
    out.exhausted = out.nextCursor === null;
    return out;
  },

  async gelbooru(q, opts = {}) {
    // Same dapi shape as Safebooru (same Gelbooru-software API), with two
    // differences: the dapi 401s without an account's api_key + user_id,
    // and Gelbooru is not safe-only — purity is applied with the same
    // rating: metatags as Danbooru. No key (or no user ID) means no fetch
    // at all: throw before any request so shortReason's /api key/i rule
    // turns it into a "needs API key" pill (same pattern as Wallhaven
    // NSFW), instead of a 401 or a misleading "0 found".
    // The API docs could not be verified live from this VM (gelbooru.com
    // is blocked here), so the params/fields follow the documented dapi
    // as recorded in the audit (api_key + user_id, same post fields as
    // Safebooru) — live verification needs a real key in Settings.
    const { key, userId } = gelbooruCreds();
    if (!key || !userId) throw new Error("needs a Gelbooru API key — paste one in Settings");
    const p = purity();
    const tags = formatQueryFor("gelbooru", q)
      + (p === "safe" ? " rating:safe" : p === "mixed" ? " rating:safe,questionable" : " rating:explicit");
    const m = minRes();
    const out = [];
    let examined = 0;
    let hidden = 0;
    let via = "";
    // Same concurrent pages 0+1 as Safebooru (see the comment there):
    // page 0 still throws if it fails, a failed page 1 just leaves the
    // page-0 results standing.
    const fetchPage = (pid) => fetchJson(
      `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&limit=${BOORU_PAGE_SIZE}&pid=${pid}&tags=${encodeURIComponent(tags)}&api_key=${encodeURIComponent(key)}&user_id=${encodeURIComponent(userId)}`, true);
    const processPage = (data) => {
      if (!Array.isArray(data) || data.length === 0) return false;
      for (const post of data) {
        examined++; // count posts actually looked at, not pages fetched
        const full = pickBooruFile(post.file_url, post.sample_url);
        if (!full) continue;
        // Same huge-file rule as Danbooru/Safebooru (Gelbooru reports no
        // file_size, so width is the only signal — its sample is the
        // ~850px version).
        const displayFull = post.width > 6000 && post.sample_url && post.sample_url !== full
          ? post.sample_url : null;
        const item = {
          thumb: post.preview_url,
          full,
          displayFull,
          // Same image, smaller: the ~850px sample, then the preview.
          alts: [post.sample_url, post.preview_url].filter((u) => u && u !== full),
          page: `https://gelbooru.com/index.php?page=post&s=view&id=${post.id}`,
          width: post.width, height: post.height, source: "Gelbooru",
          // Gelbooru's dapi returns created_at ("YYYY-MM-DD HH:MM:SS",
          // parsed by Date.parse for Newest sort) — unlike Safebooru,
          // which returns none.
          date: post.created_at || null,
          // Gelbooru's `score` is a real integer (upvotes minus
          // downvotes), so it ranks in Best mode — unlike Safebooru's,
          // which is null ~88% of the time. A 0 or negative score still
          // sorts in the unscored tail (bestRank only ranks score > 0).
          // Live distribution unverified (no key to test with) — if it
          // turns out to be mostly 0, this degrades to the tail, harmless.
          score: typeof post.score === "number" ? post.score : null,
          // Gelbooru returns tags as a space-separated string, like Safebooru.
          tags: capTags(typeof post.tags === "string" ? post.tags.split(" ") : []),
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
    // Load more (round 8): one pid per click, starting at the cursor the
    // initial fetch returned. A failed pid throws — loadMore catches it
    // and leaves the cursor alone, so the next click retries the same pid.
    if (opts.more) {
      const pid = opts.startPid;
      // Stashed pid 1 (see below): the initial fetch already downloaded
      // this page — serve it from memory instead of fetching it twice.
      // A fingerprint mismatch (query/purity/min-res changed since the
      // search) falls through to a fresh fetch, as before.
      const stashed = booruPageStash.get("gelbooru");
      let data, v;
      if (stashed && stashed.pid === pid && stashed.fp === booruStashFp(tags, m)) {
        booruPageStash.delete("gelbooru");
        ({ data, via: v } = stashed);
      } else {
        ({ data, via: v } = await fetchPage(pid));
      }
      via = v;
      const full = processPage(data);
      out.hidden = hidden;
      out.hiddenScope = "checked"; // only among the pages actually fetched
      out.examined = examined;
      out.via = via;
      out.nextCursor = full ? pid + 1 : null;
      out.exhausted = !full;
      return out;
    }
    // A new initial fetch invalidates any stashed page from an earlier
    // search (a rejected pid 1 must not leave an old page behind).
    booruPageStash.delete("gelbooru");
    const [p0, p1] = await Promise.allSettled([fetchPage(0), fetchPage(1)]);
    if (p0.status === "rejected") throw p0.reason;
    via = p0.value.via;
    const full0 = processPage(p0.value.data);
    let pid1Processed = false, full1 = false;
    if (full0 && out.length < BOORU_TARGET && p1.status === "fulfilled") {
      via = p1.value.via;
      full1 = processPage(p1.value.data);
      pid1Processed = true;
    }
    // Pid 1 fetched but not needed (pid 0 met the target): stash it for
    // the first load-more click, same as Safebooru.
    if (!pid1Processed && p1.status === "fulfilled" && full0 && out.length >= BOORU_TARGET) {
      booruPageStash.set("gelbooru", { fp: booruStashFp(tags, m), pid: 1, data: p1.value.data, via: p1.value.via });
    }
    // Round 10: keep paging while the target isn't met and pages keep
    // coming back full. Pids 0+1 fetch concurrently; the extra pids are
    // fetched sequentially, one at a time, so a query that meets its
    // target from pid 0+1 pays nothing extra, and the BOORU_DAPI_MAX_PID
    // cap bounds the worst case. A failed extra pid just leaves the
    // earlier results standing (the cursor points at it, so load more
    // retries it); a pid 1 that was rejected in the concurrent pair is
    // retried fresh here instead of being skipped.
    let nextPid = pid1Processed ? 2 : 1;
    let lastFull = pid1Processed ? full1 : full0;
    while (out.length < BOORU_TARGET && lastFull && nextPid <= BOORU_DAPI_MAX_PID) {
      try {
        const { data, via: v } = await fetchPage(nextPid);
        via = v;
        lastFull = processPage(data);
        nextPid++;
      } catch {
        break;
      }
    }
    out.hidden = hidden;
    out.hiddenScope = "checked"; // only among the pages actually fetched
    out.examined = examined;
    out.via = via;
    // Load-more cursor: the next pid not yet PROCESSED, or null when the
    // last processed page was short (no more pages) — same pattern as
    // Safebooru, including the booruPageStash for an unprocessed pid 1.
    out.nextCursor = lastFull ? nextPid : null;
    out.exhausted = out.nextCursor === null;
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
    const toItem = (w) => {
      const width = parseInt(w.resolution.split("x")[0], 10);
      const height = parseInt(w.resolution.split("x")[1], 10);
      // Huge originals (multi-MB / very wide) stall past the 15 s probe
      // timeout — same rule as Danbooru (file_size > 15 MB or width >
      // 6000). Wallhaven's API offers no mid-size sample: its thumbs are
      // all tiny (verified live 2026-11-16 against the real API — a
      // 7680x4320 file and a 1920x1080 one alike: large is 432px on the
      // long side, original 300px, small a 300x200 crop), so the only
      // honest sample is thumbs.large, which is already the card thumb.
      // Show the thumb instead of the original (displayFull); the Full
      // image link still opens the original, and the original stays the
      // first fallback candidate, so a blocked thumb still tries it
      // before the card fails. The upgrade then early-returns "cached"
      // (src already equals the display URL), so no probe slot is burned
      // and the preload meter charges the sample estimate, not the
      // original's file_size (see preloadCost).
      const huge = (typeof w.file_size === "number" && w.file_size > 15 * 1024 * 1024)
        || width > 6000;
      const displayFull = huge && w.thumbs && w.thumbs.large && w.thumbs.large !== w.path
        ? w.thumbs.large : null;
      return {
        thumb: w.thumbs.large,
        full: w.path,
        displayFull,
        alts: [w.thumbs.large].filter((u) => u && u !== w.path),
        page: w.url,
        width,
        height,
        source: "Wallhaven",
        date: w.created_at || null,
        // `favorites` (users who saved it) over `views` (passive traffic):
        // favorites is an active endorsement, and Wallhaven itself offers
        // sorting=favorites. "code geass" sample (2026-11-15, relevance
        // page): favorites median 12, max 44; views median 5,286.
        score: w.favorites,
        fileSize: typeof w.file_size === "number" ? w.file_size : null,
        // Wallhaven returns tags as objects ({name, ...}) — take the name,
        // capped like the boorus.
        tags: capTags(Array.isArray(w.tags) ? w.tags.map((t) => (typeof t === "string" ? t : (t && t.name))) : []),
      };
    };
    const fetchPage = (page) => fetchJson(
      `https://wallhaven.cc/api/v1/search?${wallhavenParams(q, { page, trending: opts.trending })}`, true);
    // Load more (round 8): one page per click, starting at the cursor the
    // initial fetch returned. A short page (< 24 items) is the last page.
    if (opts.more) {
      const page = opts.startPage;
      const { data, via } = await fetchPage(page);
      const out = (data.data || []).map(toItem);
      const full = data.data && data.data.length >= 24;
      out.nextCursor = full ? page + 1 : null;
      out.exhausted = !full;
      out.via = via;
      return out;
    }
    // Exact min-res hidden count, same pattern as Danbooru's counts calls:
    // Wallhaven's meta.total counts the results matching the query AS GIVEN
    // (verified live 2026-11-16: "landscape" total 50,889 without atleast,
    // 42,383 with atleast=1920x1080 — the difference, 8,506, is exactly
    // what the filter hid). So one extra request with the same params
    // minus `atleast` gives the before-filter total; hidden is the
    // difference. NOTE: total minus returned would NOT be the hidden
    // count — that is the results sitting on unfetched pages (42,383 − 48).
    // Skipped for trending (same rationale as Danbooru) and when no min-res
    // filter is set. A failed counts fetch just means no count (0), never
    // a failed source. The counts request runs concurrently with the page
    // fetches, so it adds no latency.
    const m = minRes();
    let hiddenPromise = null;
    if (m && !opts.trending) {
      const noAtleast = wallhavenParams(q, { page: 1, trending: opts.trending });
      noAtleast.delete("atleast");
      hiddenPromise = fetchJson(`https://wallhaven.cc/api/v1/search?${noAtleast}`, true)
        .then(({ data }) => (typeof data.meta?.total === "number" ? data.meta.total : null))
        .catch(() => null);
    }
    // Trending fetches 2 pages (AW5, round 10 debugger): the slice agent
    // raised the shared path to 4 pages for search, but Trending has no
    // load more and its render cap is the Show limit (default 100) — the
    // 3rd/4th pages' items sit unreachable in the pool behind the cap, so
    // they cost 2 requests and buy nothing. Search keeps all 4 (96).
    const pageCount = opts.trending ? 2 : WALLHAVEN_PAGES;
    const settled = await Promise.allSettled(
      Array.from({ length: pageCount }, (_, i) => fetchPage(i + 1)));
    if (settled[0].status === "rejected") throw settled[0].reason;
    const out = [];
    const { data, via: v1 } = settled[0].value;
    let via = v1;
    let nextCursor = null; // the next page not yet PROCESSED, or null when done
    // Round 10: up to pageCount pages, processed in order. Stop at
    // the first failed page (the cursor points at it, so load more retries
    // it), the first short page (no more pages), or when the target is
    // met. A page that succeeds is used even if a later one fails.
    for (let i = 0; i < pageCount; i++) {
      const page = i + 1;
      const s = settled[i];
      if (s.status === "rejected") { nextCursor = page; break; }
      const { data: pd, via: pv } = s.value;
      via = pv;
      const items = pd.data || [];
      out.push(...items.map(toItem));
      if (items.length < 24) { nextCursor = null; break; } // short page: last
      if (out.length >= WALLHAVEN_TARGET) { nextCursor = page + 1; break; }
      nextCursor = page + 1;
    }
    const totalWith = typeof data.meta?.total === "number" ? data.meta.total : null;
    const totalWithout = hiddenPromise ? await hiddenPromise : null;
    if (totalWith !== null && totalWithout !== null) {
      out.hidden = Math.max(0, totalWithout - totalWith);
      out.hiddenScope = "db"; // exact count across the whole database
    } else {
      out.hidden = 0;
      out.hiddenScope = "db";
    }
    // Load-more cursor: the next page not yet PROCESSED (see the loop
    // above — a failed page is retried, a short page ends the source,
    // a met target leaves the next page for the first load-more click).
    out.nextCursor = nextCursor;
    out.exhausted = out.nextCursor === null;
    out.via = via;
    return out;
  },

  // NOTE: no AlphaCoders adapter here — its documented API is dead (nginx 404
  // on every variant, verified 2026-11-15). The HTML-scraping replacement
  // lives in adapters-extra.js and registers itself into SOURCES.
};

// Load more (round 8): each paginated source exposes a `more` entry that
// fetches ONE further page from the cursor its initial fetch returned (see
// nextCursor on the returned arrays). The cursor is opaque to the caller
// — a page/pid number for the API sources, a page URL for the scrapers
// (see adapters-extra.js). A source without `more` — WallpaperCave, whose
// category page holds 50 with no pagination link — contributes nothing
// more; loadMore treats a missing `more` as exhausted.
SOURCES.danbooru.more = (q, cursor) => SOURCES.danbooru(q, { startPage: cursor, maxPages: 1, more: true });
SOURCES.safebooru.more = (q, cursor) => SOURCES.safebooru(q, { startPid: cursor, more: true });
SOURCES.gelbooru.more = (q, cursor) => SOURCES.gelbooru(q, { startPid: cursor, more: true });
SOURCES.wallhaven.more = (q, cursor) => SOURCES.wallhaven(q, { startPage: cursor, more: true });

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

// Wallhaven pagination: 24 results per page, up to WALLHAVEN_PAGES pages
// (target 96 — raised from 2 pages / 48 in round 10: Wallhaven was the
// source the user singled out, 48 from 2 pages while the API has thousands
// more, and the API is fast, so 4 concurrent page fetches cost one round
// trip). Enough for the ratio/min-res filters to have something to work
// with, without turning one search into a crawl.
const WALLHAVEN_TARGET = 96;
const WALLHAVEN_PAGES = 4;

// --- Sorting ---
// The last fetched result set is kept in memory so changing the sort order
// re-renders instantly without re-searching.
let lastResults = [];
let lastReports = [];
let lastQuery = "";
// --- Load more (round 8) ---
// The last search's per-source pagination state, kept alongside
// lastResults/lastReports so a sort/ratio change re-renders without
// re-searching AND without losing the cursors:
//   lastCursors[name]  — the opaque next-page cursor the source's initial
//                        fetch returned (page/pid number, or a page URL);
//                        absent = exhausted (no more pages) or unsupported
//                        (WallpaperCave — no pagination at all).
//   lastSourceState[name] — cumulative per-source totals for the status
//                        pills ({ passing, hidden, via, empty }), so a
//                        load-more batch can rebuild its source's pill
//                        from the new totals instead of the first batch's.
//   extraLimit         — extra render capacity from Load more clicks, this
//                        search (see the Show-limit note in renderResults).
//   moreLoading        — a load-more fetch is in flight (button disabled,
//                        double-clicks swallowed).
// A new search resets all of it (see search()); switching to
// Favorites/Trending leaves it alone, so coming back to the search view
// keeps both the results and the cursors.
const LOAD_MORE_STEP = 100; // extra cards shown per Load more click
let lastCursors = {};
let lastSourceState = {};
let extraLimit = 0;
let moreLoading = false;
let searchLoading = false; // a search fetch is in flight (loadMore must not run then)
let lastVisibleCount = 0; // cards on screen after the last render
let lastLimitHidden = 0; // fetched-but-unrendered cards after the last render
let loadMoreBtnCache = null;
function loadMoreBtn() {
  if (!loadMoreBtnCache) loadMoreBtnCache = $("#load-more");
  return loadMoreBtnCache;
}
// The top load-more button (round 10) mirrors the bottom one exactly —
// same hidden/disabled/text — so "load more at the top" is the same
// action. Its row is reserved (see style.css), so showing it never moves
// the grid.
let loadMoreTopBtnCache = null;
let loadMoreTopRowCache = null;
function loadMoreTopBtn() {
  if (!loadMoreTopBtnCache) loadMoreTopBtnCache = $("#load-more-top");
  return loadMoreTopBtnCache;
}
function loadMoreTopRow() {
  if (!loadMoreTopRowCache) loadMoreTopRowCache = $("#load-more-top-row");
  return loadMoreTopRowCache;
}
// Button state, derived from the current view + cursors + render:
// hidden unless a search rendered cards; disabled while a load is in
// flight, or when nothing is left to show (every source exhausted AND
// the fetched pool fully shown). Called from renderResults (after the
// visible/limit counts are known) and from search()/loadTrending() when
// they show skeletons (hide until the new results render).
function updateLoadMoreButton() {
  const btn = loadMoreBtn();
  if (!btn) return;
  const topBtn = loadMoreTopBtn();
  const topRow = loadMoreTopRow();
  // A search fetch is in flight: the grid shows skeletons, not cards.
  // search() hides the button directly, but a load-more click racing the
  // new search can resolve after the search started — its dropped-load
  // path would otherwise unhide the button over the skeletons (stale
  // lastReports counts). Hide until the new search renders.
  if (searchLoading) { btn.hidden = true; if (topRow) topRow.hidden = true; return; }
  const show = !favsView && !trendingView && lastReports.length > 0 && lastVisibleCount > 0;
  btn.hidden = !show;
  if (topRow) topRow.hidden = !show;
  if (!show) return;
  const hasMorePages = Object.keys(lastCursors).some((n) => typeof SOURCES[n]?.more === "function");
  const hasHidden = lastLimitHidden > 0;
  if (moreLoading) {
    btn.disabled = true;
    btn.textContent = "Loading…";
  } else if (!hasMorePages && !hasHidden) {
    btn.disabled = true;
    btn.textContent = "No more results";
  } else {
    btn.disabled = false;
    btn.textContent = "Load more";
  }
  if (topBtn) { topBtn.disabled = btn.disabled; topBtn.textContent = btn.textContent; }
}

// One Load more click: fetch the next page from every source that still
// has one, in parallel, and raise the search view's render cap by
// LOAD_MORE_STEP so the new items actually show. The Show limit is a
// rendering cap (see renderResults), so growing it is what "show more"
// means — the fetch supplies the extra items, and the cap bump reveals
// them together with any pool items the limit was already hiding. Every
// click fetches (when a source has a next page), even while the pool
// still holds unrendered cards: the initial search already fetches ~5x
// what it shows, and a click that only re-revealed old cards would look
// like the feature does nothing. A failed source contributes nothing
// this round and keeps its cursor, so the next click retries it — the
// same partial-results rule as search(). Never re-runs the search, never
// touches the preload counters or the Favorites view, and never resets
// the sort.
async function loadMore() {
  // No-op guards: not in the search view, nothing ever searched, a search
  // fetch is in flight (its cursors were just reset — a load now would
  // re-render the old results and kill the new search via the viewSeq
  // guard), or a load already in flight (the button disables itself, but
  // a keyboard or programmatic double-click must not double-fetch).
  if (moreLoading || searchLoading || favsView || trendingView || !lastReports.length) return;
  const names = Object.keys(lastCursors).filter((n) => typeof SOURCES[n]?.more === "function");
  // Nothing left to fetch AND nothing left to reveal: the button should
  // already be disabled — bail out rather than bumping the cap for nothing.
  if (!names.length && lastLimitHidden <= 0) return;
  moreLoading = true;
  updateLoadMoreButton();
  const seq = ++viewSeq; // a new search during the fetch cancels this load
  const q = lastQuery;
  const batches = await Promise.all(names.map(async (name) => {
    try {
      const items = await SOURCES[name].more(q, lastCursors[name]);
      const m = minRes();
      const passing = items.filter((r) => passesMinRes(r, m));
      return { name, items, passing, ok: true };
    } catch (err) {
      return { name, err, ok: false };
    }
  }));
  moreLoading = false;
  // A newer search started while this load was in flight: drop the result
  // (its cursors belong to the old session — search() reset them).
  if (seq !== viewSeq) { updateLoadMoreButton(); return; }
  // Dedupe set for the merge below (built once, shared by all batches).
  const seenFull = new Set(lastResults.map((r) => r.full));
  let addedFresh = false; // a new batch landed: the preload budget restarts for it (AW1)
  for (const b of batches) {
    if (!b.ok) continue; // failed source: pill and cursor stand, retry next click
    // Dedupe the batch against the fetched set (same by-full rule as
    // renderResults): a source re-serving a post from an earlier page
    // (page boundaries shift as new posts arrive) must not count twice
    // in the pill or the pool.
    const fresh = b.passing.filter((r) => !seenFull.has(r.full));
    if (fresh.length) addedFresh = true;
    for (const r of fresh) seenFull.add(r.full);
    lastResults.push(...fresh);
    // Advance the cursor (a null nextCursor means exhausted — drop the entry).
    if (b.items.nextCursor != null) lastCursors[b.name] = b.items.nextCursor;
    else delete lastCursors[b.name];
    // Rebuild this source's pill from the cumulative totals: the hidden
    // count adds across batches (Safebooru counts among fetched pages;
    // Danbooru's batch hidden is 0, so its exact DB count stands), and
    // the via is the latest batch's.
    const st = lastSourceState[b.name] || { passing: 0, hidden: 0, via: "", empty: false };
    st.passing += fresh.length;
    st.hidden += b.items.hidden || 0;
    st.via = b.items.via || st.via;
    st.empty = false;
    lastSourceState[b.name] = st;
    const idx = lastReports.findIndex((r) => r[0] === b.name);
    if (idx >= 0) {
      lastReports[idx] = sourceReport(b.name, { hidden: st.hidden, hiddenScope: st.hiddenScope, via: st.via, empty: st.empty }, { length: st.passing });
    }
  }
  // A new batch landed: its preload budget starts here (AW1). Without
  // this, a Paused pump (target already spent) would never resume on the
  // new cards — they would sit hidden under the default loaded-only
  // filter, and the observer can't fire on display:none cards, so Load
  // more would appear to do nothing. The session counters are untouched
  // (AN5); only the batch base moves, and only when the batch actually
  // added cards — an all-dupe/failed click leaves the budget alone.
  if (addedFresh) resetPreloadBatch();
  // Only raise the render cap when a cap is actually in force (round 13).
  // At All (limit 0) the cap never constrains anything — effLimit ignores
  // extraLimit there — so an unconditional bump is dead state that LEAKS:
  // two Load more clicks at All leave extraLimit at 200, and switching
  // the select to "100 wallpapers" afterwards shows 300 cards under a
  // "100" label with no pill (the debugger's BH1). The fetch above is
  // Load more's real job at All; the bump is only for revealing pool
  // items a cap was hiding.
  if (resultLimit() > 0) extraLimit += LOAD_MORE_STEP;
  renderResults(lastResults, lastReports, lastQuery);
  updateLoadMoreButton();
}

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
// its heart and Retry still working (the Source page / Full image links
// live in the viewer since round 15).
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
  // A failed card is never "loaded" (round 10): drop it from the loaded
  // record and strip the class, so the loaded-only grid never shows a
  // placeholder and the filter counts stay honest. The state is set
  // BEFORE markCardFailed: that call refreshes the counts cache, and the
  // cache must see this card as settled ("failed"), not still loading —
  // otherwise the meter would stay on "Preloading…" after the last card
  // fails (round 11).
  img.dataset.state = "failed";
  markCardFailed(img);
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
    ph.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l4.5-4.5 3.5 3.5 3-3L20 19"/><line x1="4" y1="4" x2="20" y2="20"/></svg><span>Image couldn't load</span><span class="img-fail-reason">${escapeHtml(failReasonText(reason))}</span>`;
  }
  const card = img._card || img.closest(".card");
  const retry = img._retryBtn || (card && card.querySelector('[data-action="retry-img"]'));
  if (retry) img._retryBtn = retry;
  if (retry && !img.dataset.thumbOnly) retry.style.display = "";
}

// A full-res upgrade failed, but the thumbnail is displaying — the card is
// NOT broken, it just never got its full image. Keep the thumbnail visible
// (a failed upgrade must never hide a working image) and say so honestly:
// a small "Preview only" badge on the card (with the reason in its title)
// and the Retry button in the action row, so the user can try the full
// again. The state stays "thumb", so a later Retry (or a re-render) can
// upgrade it; the preload pump still hears "failed", so the card is not
// counted as preloaded.
function markFullFailed(img, reason) {
  img.dataset.state = "thumb";
  img.dataset.failReason = reason || "error";
  img.style.visibility = ""; // never hide a displaying thumbnail
  const card = img._card || img.closest(".card");
  if (card) card.classList.add("full-failed");
  const anchor = img._anchor || img.closest("a.thumb");
  if (anchor) {
    let b = img._fullFailedBadge || anchor.querySelector(".badge-full-failed");
    if (!b) {
      b = document.createElement("span");
      b.className = "badge badge-full-failed";
      anchor.appendChild(b);
      img._fullFailedBadge = b;
    }
    b.hidden = false;
    b.textContent = "Preview only";
    b.title = `Full image failed: ${failReasonText(reason)} — showing preview. Retry to try again.`;
  }
  const retry = img._retryBtn || (card && card.querySelector('[data-action="retry-img"]'));
  if (retry) img._retryBtn = retry;
  if (retry && !img.dataset.thumbOnly) retry.style.display = "";
  // A "Preview only" card stops loading (it is settled, like a failure),
  // so the counts and the phase reconcile — mirroring markCardLoaded /
  // markCardFailed. Without this, the meter would stay on "Preloading…"
  // when the observer, not the pump, settles the last card as Preview
  // only: nothing else re-evaluates the phase in that path.
  const counts = updateLoadedFilterButtons();
  refreshPreloadPhase(counts);
}

// The upgrade chain in loadFullImage exhausted: decide between the two
// failure modes. If the thumbnail is actually displaying (loaded, decoded,
// never errored), keep it — see markFullFailed. Otherwise there is no
// image to keep, and the whole card fails as before (see markImageFailed).
// The thumbnail check is `complete && naturalWidth > 0` (a loaded image)
// plus `!_thumbErrored` (the authoritative flag — imgThumbError sets it
// when the thumb itself errors, and a failed thumb has naturalWidth 0
// anyway). A thumb that is still loading when the chain exhausts is NOT
// kept: the chain's last candidate IS the thumb URL, so its probe failing
// is strong evidence the thumb won't arrive either.
function markUpgradeFailed(img, reason) {
  if (!img._thumbErrored && img.complete && img.naturalWidth > 0) {
    markFullFailed(img, reason);
  } else {
    markImageFailed(img, reason);
  }
}

// A card image finished loading, so the browser knows its true size.
// That size is used only for the badge: when the image showing is the
// FULL one, its pixels ARE the real dimensions, so the badge stops
// saying "size unknown" — or showing the listing ratio — and shows them.
// The box itself never changes here (see below) — the loaded ratio is
// never applied to the anchor. Idempotent — fires again on every src swap
// (thumb -> full), and the badge check makes the dimension fill-in a
// one-time thing: a badge already showing real pixels ("1920×1080") is
// left alone. Items with parsed dimensions are unaffected (their ratio
// already matches; the badge is already set).
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
  // Fill the badge only while it does NOT already show real pixels: a
  // "size unknown" badge, or a ratio badge ("16:9") on a card whose full
  // image just loaded, both upgrade to the real "W×H". A thumbOnly card
  // never reaches here with src === data-full (its full is never loaded
  // in-grid), so a Wallpapers.com ratio badge stays the ratio forever —
  // the honest end state, since the full's real pixels are never measured.
  if (badge && !/^\d+×\d+$/.test(badge.textContent)
      && img.getAttribute("src") === img.dataset.full) {
    badge.textContent = `${w}×${h}`;
  }
  // thumbOnly card (Wallpapers.com): the thumbnail IS the final image, so
  // its arrival (this load) is what makes the card "loaded" (round 10).
  // A normal card's thumb load is not its final image — only the full
  // upgrade counts, and loadFullImage records that.
  if (img.dataset.thumbOnly && img.dataset.state === "thumb") markCardLoaded(img);
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

// Pages whose full image is loaded (round 10): the data-side record of
// "this card is ready", keyed by source page URL (the same key the
// favorites use). The card's .is-loaded class is the DOM mirror — the
// CSS grid filter hides cards without it. Populated when an img reaches
// its final image (loadFullImage success, or a thumbOnly thumb arriving
// via imgLoaded) and cleared on a failed card and on a new search. The
// full rebuild restores .is-loaded from this Set, so a rebuilt card
// doesn't flash as unloaded while the observer re-verifies it (the
// cached probe verdict would restore it a moment later anyway).
// Capped like probedFullUrls: a long session would otherwise grow it
// without bound. Evicting the oldest only loses the rebuild shortcut;
// the card's own class (on the live node) is untouched.
const loadedPages = new Set();
function markCardLoaded(img) {
  // The page key lives on the img (see cardHtml) so a rebuilt card can
  // be matched without a DOM walk; fall back to the card's fav button.
  const page = (img.dataset && img.dataset.page)
    || (img._card && img._card.querySelector('[data-action="toggle-fav"]')?.dataset?.page)
    || null;
  if (page) {
    if (loadedPages.size >= PROBED_URLS_CAP) loadedPages.delete(loadedPages.values().next().value);
    loadedPages.add(page);
  }
  const card = img._card || img.closest(".card");
  if (card) card.classList.add("is-loaded");
  const counts = updateLoadedFilterButtons();
  refreshPreloadPhase(counts);
}
function markCardFailed(img) {
  const page = (img.dataset && img.dataset.page)
    || (img._card && img._card.querySelector('[data-action="toggle-fav"]')?.dataset?.page)
    || null;
  if (page) loadedPages.delete(page);
  const card = img._card || img.closest(".card");
  if (card) card.classList.remove("is-loaded");
  const counts = updateLoadedFilterButtons();
  refreshPreloadPhase(counts);
}

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
// Batch base (round 10 debugger, AW1): the session counters above are
// cumulative, but the target is a PER-BATCH budget — each Load more click
// starts a new batch with a fresh budget, or the pump could never resume
// after Paused (spent already >= target) and the new batch's cards would
// sit hidden under the default loaded-only filter forever: the pump won't
// touch them, and the observer can't fire on display:none cards. The base
// is the counters' value when the current batch started; the pump's stop
// check reads the batch-relative numbers (spent - base). (The meter used
// to read them too, but since round 11 it shows the grid's loaded state
// instead — see updatePreloadMeter — so the two visible counts agree.)
// Reset by resetPreloadBatch() when a new batch lands (loadMore, a fresh
// Trending load) and by search()'s reset. Saved per view with the counters
// (see preloadStateByView) so a round trip doesn't resurrect a stale base.
let preloadBaseSpent = 0;
let preloadBaseCount = 0;
// A new batch landed (load more, fresh Trending load): the current batch's
// budget starts here. The session counters are NOT touched (AN5) — only
// the base moves, so the meter's batch numbers restart at 0 / target while
// the session totals keep accumulating underneath.
function resetPreloadBatch() {
  preloadBaseSpent = preloadSpent;
  preloadBaseCount = preloadCount;
}
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
const preloadStateByView = new Map(); // view key -> { spent, count, baseSpent, baseCount }
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
  preloadStateByView.set(preloadViewKey, { spent: preloadSpent, count: preloadCount, baseSpent: preloadBaseSpent, baseCount: preloadBaseCount });
  const s = preloadStateByView.get(key);
  preloadSpent = s ? s.spent : 0;
  preloadCount = s ? s.count : 0;
  preloadBaseSpent = s ? (s.baseSpent || 0) : 0;
  preloadBaseCount = s ? (s.baseCount || 0) : 0;
  preloadViewKey = key;
  // The phase belongs to the view too (round 10): entering Favorites
  // idles it (the pump never runs there — the meter hides), and entering
  // Search/Trending restarts it as "loading" when a target is set (the
  // pump corrects it to ready/paused on the new view's first render).
  // Without this the meter shows the previous view's state until the
  // next render — and, for an empty Favorites view, forever, since the
  // empty branch returns before restartPreload.
  preloadPhase = key === "favs" ? "idle" : (preloadTarget() > 0 ? "loading" : "idle");
  updatePreloadMeter();
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

function updatePreloadMeter(counts) {
  if (!preloadMeterElCache) preloadMeterElCache = $("#preload-meter");
  const el = preloadMeterElCache;
  if (!el) return;
  const target = preloadTarget();
  // The meter is persistent once a target is set (round 10): it used to
  // show only while the pump was running and hide the moment the target
  // was reached or the queue drained — which is why the user said the
  // loading pill "is not there". Now it stays visible with its state
  // (Preloading… / Paused / Ready) until the target is cleared or the
  // view leaves Search/Trending. The reserve (round 6/8/9) keeps the grid
  // from jumping when it appears — the slot is already reserved whenever
  // the grid has cards. It never shows in Favorites: the pump doesn't
  // run there, and the phase goes stale on the view switch (nothing calls
  // the pump when entering Favorites), so the view gate — not the phase —
  // hides it. Trending keeps it (the pump runs there by design).
  const show = target > 0 && preloadPhase !== "idle" && !favsView;
  el.hidden = !show;
  el.classList.toggle("is-loading", show && preloadPhase === "loading");
  if (!show) return;
  if (!preloadMeterTextCache) preloadMeterTextCache = el.querySelector(".preload-meter-text");
  if (!preloadMeterFillCache) preloadMeterFillCache = el.querySelector(".preload-meter-fill");
  const text = preloadMeterTextCache || el;
  // The meter's numbers are the GRID's loaded state (round 11): the
  // loaded count and the summed cost of the loaded cards — the same
  // numbers the filter row shows, so the two never contradict. They used
  // to be the pump's per-batch numbers (preloadCount/preloadSpent minus
  // the batch base), which reset on Load more and excluded observer
  // upgrades — so the meter said "Ready · 50 wallpapers" while the filter
  // row said "Loaded (69)" (the v5.14 browser test). The pump's own
  // budget accounting is untouched: its stop check still reads the
  // batch-relative counters (AW1); only what the meter DISPLAYS changed.
  // `counts` is the already-computed loadedCardCounts() when the caller
  // has it (refreshPreloadPhase does); otherwise read the cache, which
  // updateLoadedFilterButtons refreshes on every card state change — a
  // fresh walk here would run on every pump iteration (O(n²)) and trip
  // the optimizer's "0 document queries while pumping" check. Only the
  // very first call (no cache yet) walks the DOM, once.
  const c = counts || cachedLoadedCounts || (cachedLoadedCounts = loadedCardCounts());
  const n = c.loaded;
  const spent = c.loadedBytes;
  const plural = n === 1 ? "" : "s";
  if (preloadPhase === "paused") {
    text.textContent = `Paused — target reached · ${n} wallpaper${plural} · ${fmtBytes(spent)} / ${fmtBytes(target)}`;
  } else if (preloadPhase === "ready") {
    // "Ready" with failures says so (round 12): the v5.15 browser test
    // caught "Ready · 34 wallpapers" while 44/100 cards had permanently
    // failed — failed cards are settled, not loading, so the set IS done
    // and the phase is honestly "ready", but the meter never mentioned
    // them. The failed count is appended only when > 0; a clean set
    // keeps the plain text. "Preview only" cards count as failed here
    // (they never got their full image) — the same number the filter row
    // shows as Not ready once loading reaches 0. Paused shows no failed
    // count (the budget is the point there, and failures while paused
    // are still "not ready" in the filter row); the loading text doesn't
    // either (the set isn't done yet).
    const failed = c.failed || 0;
    text.textContent = failed > 0
      ? `Ready · ${n} wallpaper${plural} · ${fmtBytes(spent)} / ${fmtBytes(target)} · ${failed} failed`
      : `Ready · ${n} wallpaper${plural} · ${fmtBytes(spent)} / ${fmtBytes(target)}`;
  } else {
    text.textContent = `Preloading… ${n} wallpaper${plural} · ${fmtBytes(spent)} / ${fmtBytes(target)}`;
  }
  if (preloadMeterFillCache) {
    preloadMeterFillCache.style.width = `${Math.min(100, (spent / target) * 100).toFixed(1)}%`;
  }
}

// Reconcile the preload phase with the grid's actual loading state
// (round 11). The pump's "queue drained" is NOT "ready" — the observer
// may still be upgrading cards that scrolled into view, so the meter
// used to say "Ready" while the Loaded count was still climbing (the
// v5.14 browser test: "Ready · 50 wallpapers" at 50/100 loaded, Loaded
// still climbing to 69). The phase is honest only when it agrees with
// the grid: "ready" means no card in the current set is still loading
// (loaded + settled-failed == total); while any card is still loading
// the phase stays "loading". Called from the pump's stop paths and on
// every card load/fail (via markCardLoaded/markCardFailed), so a late
// observer upgrade can promote the phase, and a Retry (a card going
// pending again) demotes it. `counts` is the already-computed
// loadedCardCounts() when the caller has it; otherwise it is computed
// here. Never called for Favorites or an idle phase (the guards below) —
// and never from updateLoadedFilterButtons itself: the search reset calls
// that while the OLD grid is still in the DOM, and promoting to "ready"
// off the old grid's counts would be wrong (the new search just started).
function refreshPreloadPhase(counts) {
  if (favsView || preloadPhase === "idle" || preloadTarget() <= 0) return;
  // As in updatePreloadMeter: read the cache (refreshed on every card
  // state change) rather than re-walking the DOM — this runs on the
  // pump's drain and on every card load/fail.
  const c = counts || cachedLoadedCounts || (cachedLoadedCounts = loadedCardCounts());
  if (c.total === 0) return;
  if (c.loading === 0) {
    // Nothing still loading: the set is done. Promote from "loading" (the
    // pump drained but the observer was still working) or from "paused"
    // (the budget was spent but the observer finished everything anyway —
    // "Paused — target reached" would be wrong when nothing is left).
    if (preloadPhase === "loading" || preloadPhase === "paused") {
      preloadPhase = "ready";
    }
  } else if (preloadPhase === "ready") {
    // A card went pending again (a Retry, or a new render) — the meter
    // must not claim Ready while anything is still loading.
    preloadPhase = "loading";
  }
  // Repaint on EVERY card state change (round 12), not only on a phase
  // change: the observer can load cards while the pump is stopped
  // (drained or paused), and the meter's number would otherwise freeze
  // at the pump's last paint while the filter row keeps climbing — the
  // v5.15 browser test saw the meter stuck on "Ready · 34 wallpapers"
  // against a filter row of Loaded (56), and falling 97 → 68 → 34 across
  // Load more clicks while the filter climbed to 174. The counts are
  // already computed by the caller, so this is a text write, not a DOM
  // walk, and the optimizer's "0 queries while pumping" check is
  // untouched. (The pump's own updatePreloadMeter calls are now
  // redundant for the count, but harmless — they also refresh the fill.)
  updatePreloadMeter(c);
}

// Preload phase (round 10; redefined round 11): what the meter claims
// about the current set. Set by pumpPreload's stop paths and by
// refreshPreloadPhase (which reconciles it with the grid — see above);
// read by updatePreloadMeter. The phases, in the user's words ("when it
// is ready it shows me all the wallpaper, none nonloaded"):
// - "idle" = no target (or Favorites) — meter hidden.
// - "loading" = something in the current set is still loading (the pump
//   is running, or the observer is still upgrading cards). The meter
//   shows "Preloading…" with the loaded count / bytes so far.
// - "paused" = the pump stopped because the next item doesn't fit the
//   remaining per-batch budget (budget spent, unloaded cards remain —
//   raise the target or load more to resume). The observer may still be
//   loading cards; if it finishes them all, the phase promotes to
//   "ready" (nothing left to load).
// - "ready" = NO card in the current set is still loading (every card is
//   loaded, or settled as failed / "Preview only" — a Retry is manual,
//   not loading). This is the user's "it is ready" state: the loaded-only
//   grid shows everything that will ever load. "Ready" is a property of
//   the CURRENT SET only: loading more pages re-arms it (the new batch
//   loads, then the phase settles again). The meter still says "Ready"
//   when cards failed — failed is settled, so the set IS done — but it
//   says how many (round 12): "Ready · 56 wallpapers · 50 MB / 1.0 GB
//   · 44 failed", so it never claims everything loaded when nearly half
//   the set failed. A clean set (0 failed) keeps the plain "Ready" text.
// The pump's "queue drained" alone is NOT "ready" — the observer may
// still be upgrading cards that scrolled into view. refreshPreloadPhase
// (called from the pump's stop paths and on every card load/fail) is what
// promotes "loading"/"paused" to "ready", and demotes "ready" back to
// "loading" if a card goes pending again (a Retry, or a new render).
let preloadPhase = "idle";

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
  if (!target || favsView) { preloadRunning = false; preloadPhase = "idle"; updatePreloadMeter(); return; }
  let img = null;
  while (preloadIndex < preloadQueue.length) {
    img = preloadQueue[preloadIndex];
    if (!img.isConnected || img.dataset.upgradeStarted) { preloadIndex++; continue; }
    break;
  }
  // Queue drained: everything in the current set was attempted by the
  // pump — but that alone is NOT "ready" (round 11): the observer may
  // still be upgrading cards that scrolled into view, so the meter used
  // to say "Ready" while the Loaded count was still climbing. Reconcile
  // with the grid instead: refreshPreloadPhase promotes to "ready" only
  // when no card is still loading, and leaves the phase "loading" while
  // the observer finishes. (The phase stays a property of the current
  // set: a later render rebuilds the queue and pumpPreload re-arms it.)
  if (!img || preloadIndex >= preloadQueue.length) { preloadRunning = false; refreshPreloadPhase(); updatePreloadMeter(); return; }
  const cost = Number(img.dataset.cost) || 0;
  // Doesn't fit the remaining target: stop here WITHOUT consuming the
  // item, so raising the target later resumes with it. The meter settles
  // on "Paused — target reached" (round 10) instead of hiding. The check
  // is batch-relative (AW1): the target is a per-batch budget, so a spent
  // session total must not block a fresh batch — resetPreloadBatch() moves
  // the base when a new batch lands (loadMore, fresh Trending load).
  if ((preloadSpent - preloadBaseSpent) + cost > target) { preloadRunning = false; preloadPhase = "paused"; updatePreloadMeter(); return; }
  preloadIndex++;
  preloadRunning = true;
  preloadPhase = "loading";
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
  // Refresh the counts before the pump runs (round 11 debugger, BA3):
  // the cache still holds the PRE-render grid's counts — a sort/ratio
  // change can drop loaded cards — and the pump's first
  // updatePreloadMeter below would paint those stale numbers while the
  // filter row (refreshed by applyGridFilter right after this) shows the
  // true ones. With the pump paused or drained, nothing repaints the
  // meter after that, so the stale count would stick. One walk per
  // render, not per pump iteration, so the optimizer's "0 queries while
  // pumping" check is untouched.
  updateLoadedFilterButtons();
  const box = imgs ? null : resultsBox();
  preloadQueue = imgs || (box ? [...box.querySelectorAll(".card img")] : []);
  preloadIndex = 0;
  updatePreloadMeter();
  pumpPreload();
}

// Grid filter (round 10): which cards the search grid shows while a
// preload target is set. "loaded" = only cards whose full image is ready
// — the main grid never shows an unloaded placeholder (the user's "none
// nonloaded"). "pending" = only cards not yet loaded, one click away for
// the stragglers (and their Retry buttons). "all" = everything, the old
// behaviour. The filter is a CSS class on #results (see style.css): cards
// keep their nodes, the pump keeps working on the hidden ones, and a card
// flips visible the moment its .is-loaded class lands, with no re-render.
// It only applies in the search view with a target set; Favorites and
// Trending always show all. The default is "loaded" — a new search resets
// to it (see search()).
let gridFilter = "loaded";
function gridFilterActive() {
  return !favsView && !trendingView && preloadTarget() > 0;
}
// Cached loadedCardCounts() (round 11): the counts are already computed
// on every card state change by updateLoadedFilterButtons, so the meter
// and the phase reconcile read the cache instead of re-walking the DOM —
// the pump calls updatePreloadMeter on every iteration, and a walk per
// iteration is O(n²) and trips the optimizer's "0 document queries while
// pumping" check. The cache is refreshed by updateLoadedFilterButtons
// (card load/fail, Preview only, applyGridFilter) and reset to zero by a
// new search session (see the reset in the search handler).
let cachedLoadedCounts = null;
function loadedCardCounts() {
  const box = resultsBox();
  if (!box) return { total: 0, loaded: 0, pending: 0, loading: 0, loadedBytes: 0, failed: 0 };
  const cards = box.querySelectorAll(".card");
  let loaded = 0, loading = 0, failed = 0, loadedBytes = 0;
  for (const card of cards) {
    // The img is cached on the card at build time (see buildCard) — a
    // querySelector here would be one call per card, per invocation.
    const img = card._img || card.querySelector("img");
    if (card.classList.contains("is-loaded")) {
      loaded++;
      loadedBytes += img ? (Number(img.dataset.cost) || 0) : 0;
      continue;
    }
    // Settled as failed (round 12): the full failed outright (state
    // "failed") or the card kept only its thumbnail ("Preview only",
    // full-failed class) — either way it will never load, so it is not
    // "loading" and it counts as failed for the meter. A card with no
    // img at all can never load either. When loading reaches 0, pending
    // == failed, so the meter's failed count always agrees with the
    // filter row's Not ready count at Ready.
    if (!img || img.dataset.state === "failed" || card.classList.contains("full-failed")) { failed++; continue; }
    loading++;
  }
  return { total: cards.length, loaded, pending: cards.length - loaded, loading, loadedBytes, failed };
}
function updateLoadedFilterButtons() {
  const row = staticEl("loaded-filter");
  if (!row) return null;
  const counts = loadedCardCounts();
  cachedLoadedCounts = counts; // refresh the cache (see above) — the
  // meter and the phase reconcile read this instead of re-walking the DOM
  const { total, loaded, pending } = counts;
  const setBtn = (id, label, on) => {
    const b = staticEl(id);
    if (!b) return;
    b.textContent = label;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.classList.toggle("active", on);
  };
  // The row only exists in the search view with a target set AND with
  // cards to filter (AW3): over an empty state (0 results, idle, ratio
  // hidden) it would show three (0) buttons — and, worse, the empty branch
  // in renderResults returns before applyGridFilter, so without this gate
  // the row keeps the PREVIOUS search's counts above "No wallpapers found".
  row.hidden = !gridFilterActive() || total === 0;
  if (row.hidden) {
    // Zero the labels while hidden (round 12): the row is visually hidden
    // by the reserve rule, but its DOM labels kept the previous search's
    // counts — anything reading the DOM (including the v5.15 browser test)
    // saw stale numbers. The labels are re-set from the true counts the
    // moment the row unhides.
    setBtn("filter-loaded", "✓ Loaded (0)", gridFilter === "loaded");
    setBtn("filter-pending", "Not ready (0)", gridFilter === "pending");
    setBtn("filter-all", "All (0)", gridFilter === "all");
    return counts;
  }
  setBtn("filter-loaded", `✓ Loaded (${loaded})`, gridFilter === "loaded");
  setBtn("filter-pending", `Not ready (${pending})`, gridFilter === "pending");
  setBtn("filter-all", `All (${total})`, gridFilter === "all");
  return counts;
}
function applyGridFilter() {
  const box = resultsBox();
  if (!box) return;
  const on = gridFilterActive();
  box.classList.toggle("show-loaded", on && gridFilter === "loaded");
  box.classList.toggle("show-pending", on && gridFilter === "pending");
  updateLoadedFilterButtons();
}
function setGridFilter(mode) {
  gridFilter = mode;
  applyGridFilter();
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
  // An upgrade starting while the meter claims "Ready" means a card went
  // pending again — only a Retry does that (the pump and the observer
  // never start one when the phase is "ready": there is nothing pending
  // for them). Demote the phase now, so the meter doesn't claim Ready
  // while the retry is in flight; the completion (markCardLoaded /
  // markCardFailed) re-promotes it if nothing is left. Guarded to the
  // "ready" case so the common pump/observer path pays one string
  // comparison, not a DOM walk. The cache is invalidated first: it still
  // holds the pre-retry counts (this card settled), so the reconcile
  // below must walk the DOM once to see the card pending again.
  if (preloadPhase === "ready") { cachedLoadedCounts = null; refreshPreloadPhase(); }
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
    markCardLoaded(img);
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
    markCardLoaded(img);
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
    if (i >= candidates.length) { markUpgradeFailed(img, lastFailReason); done("failed"); return; }
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
        markCardLoaded(img);
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
  // A detached img's in-flight fetch can still error after a rebuild
  // discarded the card: failing it would strip the LIVE card's page from
  // loadedPages (the meter reads DOM classes, so it wouldn't fall — but
  // the next rebuild would lose the restore shortcut and hide a loaded
  // card under the loaded-only filter until the observer re-verifies it).
  // A detached img displays nothing; its errors are stale by definition.
  if (!img.isConnected) return;
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
  // the thumb is the full image — WallpaperCave) and it just errored.
  // The probe already downloaded this URL once, so a single fetch failure
  // of the display <img> is a transient (proxy 429, connection reset),
  // not proof the image is bad — the same one retry the probe itself gets
  // (see probeUrl). Retry the same URL once before failing the card: the
  // src is cleared first so the same URL actually re-fetches (setting src
  // to its current value is a no-op in browsers). Without the retry, a
  // flaky proxy strips probe-verified cards and the meter's MB falls while
  // the loaded count rises (round 14: the v5.16 browser test, 161 MB ->
  // 144 MB across Load more). A second failure is a genuine failure and
  // fails the card as before.
  if (img.dataset.state === "full") {
    if (!img._fullRetried) {
      img._fullRetried = true;
      // Retry the URL that is actually displaying. An alternate-settled
      // card shows its alternate, not data-full — and data-full already
      // failed its probe twice, so retrying it would kill a card whose
      // alternate is fine (the viewer already refuses to re-fetch the
      // full for these cards, see openLightbox). Fall back to data-full
      // only if the img somehow has no src.
      const cur = img.getAttribute("src") || img.dataset.full;
      img.removeAttribute("src");
      img.src = cur;
      return;
    }
    markImageFailed(img, "error");
    return;
  }
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
// alts, page, width, height, source, date, score, tags), so the Favorites view can
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
    // Tags ride along so a favourited card keeps its chips in the
    // Favorites view without re-searching. Old snapshots have no `tags`
    // field — the template treats that as "no tags".
    tags: Array.isArray(r.tags) ? [...r.tags] : [],
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
  applyGridFilter(); // the filter only applies in the search view (round 10)
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

// One card's HTML — a pure function of the item + favorite state, shared
// by the full rebuild and the growth path (see buildCard), so both build
// byte-identical cards. The img's data-* attributes are what
// loadFullImage/probeUrl read; the anchor's inline aspect-ratio is the
// frozen reserve (round 3 + round 7): imgLoaded never rewrites it, a
// loaded image only fills in the badge's real dimensions.
function cardHtml(r, fav) {
  // Pixels known -> "1920×1080". Pixels unknown but ratio known (only
  // Wallpapers.com: ratioW/ratioH from the listing thumb) -> the reduced
  // ratio, e.g. "16:9": the shape IS known, the pixels are not, and a
  // colon can never be mistaken for a pixel size. Neither known -> the
  // honest "size unknown". (imgLoaded may still upgrade a ratio badge to
  // real pixels if the full image ever loads — see there.)
  const res = (r.width && r.height) ? `${r.width}×${r.height}`
    : (r.ratioW && r.ratioH) ? ratioLabel(r.ratioW, r.ratioH)
    : "size unknown";
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
  // Tags, when the source gave any (the API sources — Danbooru,
  // Safebooru, Wallhaven, Gelbooru; scrapers have none): they live in
  // the viewer now (round 15), not on the card — see tagsHtmlFor below.
  // The card keeps only the image, the heart and Retry, so scrolling
  // stays clean; the tags belong to the one wallpaper being viewed.
  return `
    <article class="card">
      <a class="thumb" href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener" style="${ratio}"><img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${escapeHtml(thumbSrc)}" data-full="${escapeHtml(displayUrl)}" data-alts="${escapeHtml(alts.join("|"))}"${r.thumbOnly ? ' data-thumb-only="1"' : ""} data-cost="${cost}" data-page="${escapeHtml(r.page)}" data-state="thumb" onload="imgLoaded(this)" onerror="imgThumbError(this)" alt="${r.source} wallpaper ${res}">
        <span class="badge badge-res">${res}</span>
        <span class="badge badge-src">${r.source}</span>
      </a>
      <button type="button" class="fav-btn${fav ? " fav-on" : ""}" data-action="toggle-fav" data-page="${escapeHtml(r.page)}" aria-pressed="${fav ? "true" : "false"}" aria-label="Save to favorites" title="Save to favorites">${fav ? "♥" : "♡"}</button>
      <button type="button" class="img-retry" data-action="retry-img" style="display:none">Retry</button>
    </article>`;
}

// Tag chips for the viewer (round 15): ALL of them — the viewer is the
// one place tags live now that the card carries none, and the "+N" count
// the card used was a space-saving device with nowhere to expand to
// here (a dead label in the detail view). Tags are already capped at 12
// when stored (capTags), so this is at most 12 chips, and they wrap.
// Every chip is escaped (escapeHtml) — a tag is untrusted API text,
// never markup. Clicking a chip searches that tag (see the viewer click
// handler) — the same path as a Trending chip.
function tagsHtmlFor(r) {
  const tags = r.tags || [];
  return tags.length ? `
        <div class="tags">${tags.map((t) => `<button type="button" class="tag-chip" data-action="search-tag" data-tag="${escapeHtml(t)}" title="Search for ${escapeHtml(t)}">${escapeHtml(t)}</button>`).join("")}</div>` : "";
}

// Build one card node from the shared template: used by the growth path
// for cards the fast path doesn't already have (load more, limit raised,
// ratio loosened). The img's caches (anchor, card, badge) are attached
// here, exactly like the full rebuild does after parsing — imgLoaded and
// markImageFailed rely on them, and the fallbacks keep an img built
// outside renderResults working if the template ever drifts.
function buildCard(r, fav) {
  const holder = document.createElement("div");
  holder.innerHTML = cardHtml(r, fav);
  const card = holder.children[0];
  const img = card.querySelector("img");
  img._anchor = img.parentElement || img.closest("a.thumb");
  img._card = card;
  // Reverse cache (round 11): loadedCardCounts needs each card's img on
  // every card state change, and a per-card querySelector there is O(n)
  // calls per load — O(n²) over a pump run, which trips the optimizer's
  // "0 document queries while pumping" check. The img is cached on the
  // card at build time, like _card/_anchor above; loadedCardCounts falls
  // back to querySelector for a card built outside buildCard.
  card._img = img;
  const sib = img.nextElementSibling;
  img._badge = (sib && typeof sib.className === "string" && sib.className.includes("badge-res")) ? sib : null;
  // A rebuilt card whose full image already loaded (recorded in
  // loadedPages) shows as loaded immediately (round 10) — same as the
  // full rebuild's restoration below. Without this, a card that left the
  // visible set and re-entered via the growing path would hide in the
  // loaded-only view until the observer re-verified it.
  if (loadedPages.has(r.page)) card.classList.add("is-loaded");
  return { card, img };
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
  // Load more (round 8) raises the SEARCH view's cap by LOAD_MORE_STEP
  // per click (extraLimit): the Show limit is a rendering cap, so growing
  // it is what "show more" means — the fetch only supplies the extra
  // items. Favorites always shows all, and Trending never loads more, so
  // neither gets the extra capacity.
  const limit = favsView ? 0 : resultLimit();
  const effLimit = (!favsView && !trendingView && limit > 0) ? limit + extraLimit : limit;
  const limitHidden = effLimit > 0 ? Math.max(0, visible.length - effLimit) : 0;
  if (effLimit > 0) visible = visible.slice(0, effLimit);
  // Remember what this render showed, for the Load more button (see
  // updateLoadMoreButton): whether any cards are on screen, and whether
  // the fetched pool still holds unrendered ones. Set here — before the
  // empty-state returns below — so every render path reports it.
  lastVisibleCount = visible.length;
  lastLimitHidden = limitHidden;
  updateLoadMoreButton();

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
    // Nothing to show — the pump has nothing to do, so the meter goes idle
    // (round 10); without this a target-set search that finds nothing leaves
    // the meter stuck on "Preloading… 0 / Y" (the empty branch returns
    // before restartPreload, so the pump never corrects the phase).
    preloadPhase = "idle";
    updatePreloadMeter();
    // The filter row is refreshed after each empty state below (AW3) —
    // not here: the old cards are still in the DOM until innerHTML is
    // set, so the gate in updateLoadedFilterButtons would still see them.
    if (favsView && !uniq.length) {
      box.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true" style="font-size:64px;line-height:1">♡</div>
        <h2>No favorites yet</h2>
        <p>Tap the ♡ on any wallpaper to save it here.</p>
      </div>`;
      applyGridFilter(); // AW3: no cards — the filter row hides (gate in updateLoadedFilterButtons)
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
      applyGridFilter(); // AW3: no cards — the filter row hides
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
      applyGridFilter(); // AW3: no cards — the filter row hides
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
    applyGridFilter(); // AW3: no cards — the filter row hides
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
  // top).
  // And a GROWING visible set (load more, limit raised, ratio loosened):
  // the cards the set gained are built from the same template (see
  // buildCard) and appended in order, while the existing cards are moved,
  // not rebuilt — their loaded images, probe state and observer
  // registration survive. A growing set used to take the full rebuild
  // below, which re-fetched every thumb and re-probed every full image.
  // Guarded by cardByPage.size > 0: an empty cache means the box holds
  // skeletons or an empty state, not cards, and only a full rebuild can
  // replace those (search()/loadTrending() and the empty branches clear
  // the cache whenever they replace the cards).
  // Dropped cards get the same treatment as a full rebuild (see
  // discardRenderedCards): their in-flight upgrades are cancelled and
  // they leave the observer, so no probe keeps downloading for a card
  // that is no longer shown.
  const visiblePages = new Set(visible.map((r) => r.page));
  if (cardByPage.size > 0
      && localProxyUp === lastRenderProxyUp && favsView === lastRenderFavsView
      && trendingView === lastRenderTrendingView
      && visible.every((r) => { const el = cardByPage.get(r.page); return !el || el.isConnected; })) {
    for (const [page, el] of cardByPage) {
      if (visiblePages.has(page)) continue;
      // The img is cached on the card (round 11, see the full rebuild
      // below) — a querySelector here would be one call per dropped card.
      const img = el._img || el.querySelector("img");
      if (img && typeof img._cancelUpgrade === "function") img._cancelUpgrade();
      if (imageObserver && img) imageObserver.unobserve(img);
      el.remove();
    }
    // Favorite lookup for the cards built below (same per-render Set the
    // full rebuild uses — isFav() was a linear scan, see below).
    const favPages = new Set(favorites.map((f) => f.page));
    const observer = getImageObserver();
    const nextByPage = new Map();
    // Stage the reordered set in a fragment and insert it once (round 10
    // optimizer): appending each card straight into the live box was one
    // insertion per card — up to ~100 per load-more — and every insertion
    // re-evaluates the :has() reserve rules on <main> plus the masonry
    // layout. The fragment keeps the same final order (moves are moves:
    // an existing card is detached from the box into the fragment, then
    // back in place) with a single live insertion. Observing a new card's
    // img while it sits in the fragment is fine — observation follows the
    // node, and the pump/observer run after the insert, below.
    const frag = document.createDocumentFragment();
    for (const r of visible) {
      let el = cardByPage.get(r.page);
      if (!el) {
        // New card: build it from the shared template, observe its image
        // (or load it outright without an observer), and append it in
        // order — exactly like the full rebuild does for every card.
        const built = buildCard(r, favPages.has(r.page));
        el = built.card;
        if (observer) observer.observe(built.img);
        else loadFullImage(built.img);
      }
      frag.appendChild(el);
      nextByPage.set(r.page, el);
    }
    box.appendChild(frag);
    cardByPage = nextByPage;
    restartPreload(); // same cards, new order — preload follows the new order
    applyGridFilter(); // counts refresh after the set grew/shrank (round 10)
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
  box.innerHTML = visible.map((r) => cardHtml(r, favPages.has(r.page))).join("");
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
  // Reverse cache too (round 11 optimizer, BB1): loadedCardCounts needs
  // each card's img on every card state change, and buildCard alone
  // setting card._img left every full-rebuild card without it — the path
  // every new search takes — so each counts walk paid one querySelector
  // per card (400 calls over a 20-card pump run, measured in the QA
  // shim). The img is already in hand here, so this costs nothing.
  imgs.forEach((img, i) => {
    img._anchor = img.parentElement || img.parent || img.closest("a.thumb");
    img._card = cards[i];
    cards[i]._img = img;
    const sib = img.nextElementSibling;
    img._badge = (sib && typeof sib.className === "string" && sib.className.includes("badge-res")) ? sib : null;
  });
  cardByPage = new Map(visible.map((r, i) => [r.page, cards[i]]));
  // Restore the loaded marker on rebuilt cards (round 10): a card whose
  // full image already loaded (recorded in loadedPages) shows as loaded
  // immediately, instead of waiting for the observer to re-verify it via
  // the cached probe verdict.
  visible.forEach((r, i) => { if (loadedPages.has(r.page)) cards[i].classList.add("is-loaded"); });
  lastRenderProxyUp = localProxyUp;
  lastRenderFavsView = favsView;
  lastRenderTrendingView = trendingView;
  restartPreload(imgs);
  applyGridFilter(); // re-assert the grid filter + refresh the counts (round 10)
}

async function search(ev) {
  ev.preventDefault();
  saveSettings();
  const q = staticEl("query").value.trim();
  if (!q) return;
  // Generation guard against overlapping loads (see viewSeq above).
  const seq = ++viewSeq;
  searchLoading = true; // loadMore must not run while this fetch is in flight
  // A new search shows search results, not the Favorites or Trending view.
  setFavsView(false);
  setTrendingView(false);
  // New search session: the preload meter starts over (bytes already
  // downloaded stay downloaded — the meter counts this search's preloads).
  // Zero the counters AND the stored search entry, or a later round trip
  // would resurrect the old numbers (see syncPreloadView).
  preloadSpent = 0;
  preloadCount = 0;
  preloadBaseSpent = 0;
  preloadBaseCount = 0;
  preloadStateByView.set(preloadViewKey, { spent: 0, count: 0, baseSpent: 0, baseCount: 0 });
  // The cached grid counts start over too (round 11): the meter reads
  // the cache, and the old grid's loaded cards must not carry into the
  // new session's "Preloading… 0 / Y". (The updateLoadedFilterButtons
  // call below re-caches the old grid's counts — the old cards are still
  // in the DOM — but the refresh after the skeletons below zeroes the
  // cache again before anything reads it in the busy phase.)
  cachedLoadedCounts = { total: 0, loaded: 0, pending: 0, loading: 0, loadedBytes: 0, failed: 0 };
  // New search session: the loaded record starts over too (round 10) —
  // the new results are different cards, and the grid filter re-applies
  // to them as they load. The phase restarts as "loading" when a target
  // is set, so the meter reads "Preloading… 0 / Y" through the busy
  // phase; the grid filter resets to "loaded", the workflow's main view.
  loadedPages.clear();
  preloadPhase = preloadTarget() > 0 ? "loading" : "idle";
  gridFilter = "loaded";
  updatePreloadMeter();
  updateLoadedFilterButtons();
  // New search session: the load-more state starts over too — the old
  // cursors belong to the old query, and the render cap goes back to the
  // Show limit. Reset here (not when the fetch finishes) so a load-more
  // click racing the new search can't use stale cursors.
  extraLimit = 0;
  lastCursors = {};
  lastSourceState = {};
  moreLoading = false;
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
  // The skeletons replace the cards — refresh the counts NOW, not at
  // render (round 11 debugger, BA1/BA2): the reset above re-cached the
  // OLD grid's counts (the old cards were still in the DOM), and the
  // busy phase reads both the meter and the filter row off that cache —
  // the pump's drain microtask (from a cancelled in-flight upgrade)
  // calls updatePreloadMeter, and the row sits visible above the
  // skeletons showing "Loaded (N)" for cards that are gone. With the
  // skeletons in the DOM the counts are zero and the row hides, so the
  // busy phase reads "Preloading… 0 / Y" and no stale filter counts.
  updateLoadedFilterButtons();
  // The skeletons replace the cards — drop the sort-only cache (its entries
  // are detached; the isConnected check in renderResults would reject them,
  // but there is no reason to keep holding them).
  cardByPage = new Map();
  // The skeletons replace the cards — hide Load more until the new results
  // render. (updateLoadMoreButton can't do this: it derives from the last
  // render's counts, which are still the previous search's here.)
  const lmBtn = loadMoreBtn();
  if (lmBtn) lmBtn.hidden = true;
  const lmTopRow = loadMoreTopRow();
  if (lmTopRow) lmTopRow.hidden = true;

  const reports = [];
  const all = [];
  const cursors = {}; // per-source next-page cursor for this search
  const sourceState = {}; // per-source cumulative totals for the pills
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
      // Load-more cursor + pill totals for this source: the next page the
      // adapter can fetch (null = exhausted / unsupported), and the
      // cumulative totals the pill is built from (see lastSourceState).
      // Only for successful fetches — a failed source has no cursor and
      // keeps no totals, so loadMore never asks it for more.
      if (items.nextCursor != null) cursors[name] = items.nextCursor;
      sourceState[name] = {
        passing: passing.length,
        hidden: items.hidden || 0,
        // The pill's "+" (checked scope) must survive a load-more rebuild
        // (see loadMore): the scope is a per-source constant, so the
        // initial value stands for every later batch.
        hiddenScope: items.hiddenScope,
        via: items.via || "",
        empty: !!items.empty,
      };
    } catch (err) {
      reports.push([name, err, false, 0]);
    }
  }));
  searchLoading = false; // the fetch is done (render decision below is separate)
  // Keep the fetched set so a sort change can re-render without re-searching.
  // Assigned only when this load is still the newest: a stale load's data
  // must not replace the current search's — otherwise a sort change after
  // an overlapping search would flip the grid back to the old query.
  if (seq === viewSeq) {
    lastResults = all;
    lastReports = reports;
    lastQuery = q;
    lastCursors = cursors;
    lastSourceState = sourceState;
  }
  // Only the newest load renders — and only into the search view. A slow
  // load finishing after a newer search, a trending load, or a switch to
  // Favorites must not overwrite the current view with the wrong query's
  // results.
  if (seq !== viewSeq || trendingView || favsView) return;
  renderResults(all, reports, q);
}

$("#search-form").addEventListener("submit", search);
// Load more button (round 8): below the grid, not inside it. Guarded
// like the other optional controls — the harness DOM has the button
// (see test-shim.mjs), a bare page without it just skips the wiring.
const loadMoreBtnEl = $("#load-more");
if (loadMoreBtnEl) loadMoreBtnEl.addEventListener("click", loadMore);
// Top load-more button (round 10): above the grid, same action as the
// bottom one. Guarded the same way — a bare page without it skips it.
const loadMoreTopBtnEl = $("#load-more-top");
if (loadMoreTopBtnEl) loadMoreTopBtnEl.addEventListener("click", loadMore);
// Loaded filter buttons (round 10): Loaded / Not ready / All — the
// "insta view loaded wallpapers" switch. Each sets the grid filter; the
// button's data-filter attribute is the mode (see setGridFilter).
$$(".filter-btn").forEach((b) => b.addEventListener("click", () => setGridFilter(b.dataset.filter || "all")));
$("#proxy").addEventListener("change", saveSettings);
$("#worker-url").addEventListener("change", () => { saveSettings(); refreshProxyAndRerender(); });
$("#purity").addEventListener("change", saveSettings);
$("#wh-key").addEventListener("change", saveSettings);
$("#gb-key").addEventListener("change", saveSettings);
$("#gb-user").addEventListener("change", saveSettings);
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
    applyGridFilter(); // the target changed — the filter row and the grid
    // follow it (a target set turns the loaded-only view on, Off turns it off)
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
  applyGridFilter(); // see onPreloadInput — the filter follows the target
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
    // In Mixed mode, say what each source actually includes: Danbooru,
    // Gelbooru and Wallhaven filter by rating/purity; Safebooru is a
    // safe-only site; the scraped sites have no purity filter at all. In
    // Safe mode the pills read exactly as before.
    if (purity() === "mixed") {
      if (name === "danbooru" || name === "wallhaven" || name === "gelbooru") msg += " · incl. suggestive";
      else if (name === "safebooru") msg += " · safe-only site";
      else msg += " · no purity filter";
    } else if (purity() === "nsfw") {
      // NSFW mode: Danbooru and Gelbooru return explicit posts; Wallhaven
      // only works with an API key (the adapter throws without one, so
      // reaching here means a key was set); Safebooru returns nothing by
      // design; the scraped sites have no purity filter at all.
      if (name === "danbooru" || name === "gelbooru") msg += " · explicit only";
      else if (name === "wallhaven") msg += " · NSFW (API key set)";
      else if (name === "safebooru") msg += " · safe-only site";
      else msg += " · no purity filter";
    }
  }
  const hidden = items.hidden || 0;
  const m = minRes();
  if (hidden > 0 && m) {
    // Exact counts (Danbooru, Wallhaven) cover the whole database; checked
    // counts (Safebooru, scrapers) cover only the pages actually fetched,
    // so there may be more — the "+" says "at least". One character, the
    // pill stays the same length otherwise.
    const n = items.hiddenScope === "checked"
      ? `${hidden.toLocaleString()}+` : hidden.toLocaleString();
    msg += ` · ${n} below ${m.w}×${m.h} — lower the filter to see them`;
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
  // Entering Trending: at most two sources, so the 6-source reserve
  // never applies — clear any reserve left by a many-source search
  // (renderTrendingView re-renders final pills directly, with no busy
  // phase, so nothing here needs reserving; loadTrending re-sets it
  // right after, to off as well since its chosen list is capped at the
  // two trending sources). At desktop the two Trending pills fit one
  // row; at phone width they take two (see the status-reserved-trending
  // rung), which loadTrending reserves on its fetch path.
  // Leaving Trending clears its own phone reserve too (see loadTrending).
  if (on) setStatusReserve(0);
  else statusBox().classList.remove("status-reserved-trending");
  syncPreloadView();
  applyGridFilter(); // the filter only applies in the search view (round 10)
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
  // Trending's own reserve (round 9): the 6-source threshold never
  // fires for 2 sources, but at phone width the settled pills take 2
  // rows against a 1-row busy pill — reserve them (phone-only rung in
  // style.css, so no dead space at desktop). Set synchronously with
  // the busy pill below, like the search reserve.
  statusBox().classList.add("status-reserved-trending");
  statusBox().innerHTML = `<span class="status-pill pill-busy"><span class="spinner"></span>Loading what's trending…</span>`;
  // The skeletons replace the cards — discard their in-flight upgrades
  // first (see discardRenderedCards), or an orphaned probe stalls the
  // preload pump and keeps downloading for a card that is already gone.
  discardRenderedCards();
  resultsBox().innerHTML = Array.from({ length: 8 }, () =>
    `<div class="skeleton" aria-hidden="true"><div class="skeleton-thumb"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`).join("");
  cardByPage = new Map();
  // Load more belongs to the search view, not Trending — hide it while
  // the trending cards load (renderResults hides it again once they do).
  const lmBtnT = loadMoreBtn();
  if (lmBtnT) lmBtnT.hidden = true;

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
  // A fresh Trending batch landed: its preload budget starts here (AW1,
  // same as loadMore) — without this, a Paused pump would never resume
  // on the refreshed cards.
  resetPreloadBatch();
  renderResults(all, reports, "Trending");
}

// ---------- In-site viewer (round 15) ----------
// Clicking a card's image opens the wallpaper here, as large as the
// viewport allows, instead of a new tab. The tags, Source page and Full
// image links moved here from the card (the grid keeps only the image,
// the heart and Retry). X, Esc and the backdrop all close it; the page
// behind doesn't scroll while it's open. Focus goes to the X on open
// and returns to the card on close.
let lightboxItem = null; // the item currently open (null = closed)
let lightboxCard = null; // the card element it was opened from
let lightboxLastFocus = null; // element to return focus to on close

function lightboxEls() {
  return {
    box: staticEl("lightbox"),
    img: staticEl("lightbox-img"),
    err: staticEl("lightbox-error"),
    caption: staticEl("lightbox-caption"),
    source: staticEl("lightbox-source"),
    full: staticEl("lightbox-full"),
    fav: staticEl("lightbox-fav"),
    tags: staticEl("lightbox-tags"),
    close: staticEl("lightbox-close"),
  };
}

// One place for the heart's visual state, shared by the card button and
// the viewer's button (both must agree — toggling in the viewer syncs
// the card behind it, and vice versa).
function setFavButton(btn, on) {
  if (!btn) return;
  btn.classList.toggle("fav-on", on);
  btn.textContent = on ? "♥" : "♡";
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

function openLightbox(card) {
  const els = lightboxEls();
  if (!els.box || !card) return;
  const img = card._img || card.querySelector("img");
  if (!img) return;
  const item = renderedByPage.get(img.dataset.page);
  if (!item) return;
  const anchor = img._anchor || img.closest("a.thumb");
  // The full URL is the anchor's href — the same URL the "Full image"
  // link uses, never a fallback or an alternate (see B7/AJ4). The viewer
  // shows what the card shows first (thumbnail or sample) and swaps to
  // the full when it arrives; the preload uses the exact full URL, so the
  // browser cache dedupes it with the card's own upgrade (no second
  // download of the same URL).
  const fullUrl = anchor ? anchor.getAttribute("href") : proxiedImageUrl(item.full);
  const currentSrc = img.getAttribute("src") || "";
  const res = card.querySelector(".badge-res")?.textContent || "";
  const srcName = card.querySelector(".badge-src")?.textContent || item.source || "";
  // Capture the return target only on the FIRST open: a re-open while
  // the viewer is already up would re-capture it, and focus was already
  // moved to the X by the first open — so closing would strand focus on
  // the hidden X instead of the card that opened it. (A re-open is a
  // keyboard path: Tab out of the viewer, Enter on another card.)
  if (!lightboxItem) lightboxLastFocus = document.activeElement;
  lightboxItem = item;
  lightboxCard = card;
  els.caption.textContent = [srcName, res].filter(Boolean).join(" · ");
  els.source.setAttribute("href", item.page);
  els.full.setAttribute("href", fullUrl);
  els.fav.setAttribute("data-page", item.page);
  setFavButton(els.fav, favorites.some((f) => f.page === item.page));
  els.tags.innerHTML = tagsHtmlFor(item);
  els.tags.hidden = !(item.tags && item.tags.length);
  els.err.hidden = true;
  els.img.style.display = "";
  if (img.dataset.state === "failed") {
    // Nothing to show: the thumbnail failed too. The links still work.
    els.img.removeAttribute("src");
    els.img.style.display = "none";
    els.err.hidden = false;
  } else {
    els.img.setAttribute("src", currentSrc);
    els.img.setAttribute("alt", img.getAttribute("alt") || "");
    if (currentSrc === fullUrl) {
      // Already showing the full (or the full IS the thumb, e.g.
      // WallpaperCave): nothing to upgrade to.
    } else if (img.dataset.state === "thumb" && !card.classList.contains("full-failed")) {
      // The card is still on its thumbnail/sample and the full hasn't
      // failed yet: kick the card's own upgrade (no-op if already
      // started — see loadFullImage) and preload the full for the
      // viewer. On load, swap the viewer to the full; on error, keep
      // what the card shows (re-read at error time — the card may have
      // settled on an alternate by then). A card that settled on an
      // alternate (state "full", src is the alternate) or on its
      // thumbnail (Preview only) keeps what it shows — the full already
      // failed there, so the viewer doesn't re-fetch it.
      loadFullImage(img);
      const pre = new Image();
      pre.onload = () => {
        if (lightboxItem === item) els.img.setAttribute("src", fullUrl);
      };
      pre.onerror = () => {
        if (lightboxItem !== item) return;
        const nowSrc = img.getAttribute("src") || "";
        if (nowSrc && nowSrc !== els.img.getAttribute("src")) els.img.setAttribute("src", nowSrc);
        if (img.dataset.state === "failed") {
          els.img.style.display = "none";
          els.err.hidden = false;
        }
      };
      pre.src = fullUrl;
    }
  }
  els.box.hidden = false;
  document.body.classList.add("lightbox-open");
  if (els.close && typeof els.close.focus === "function") els.close.focus();
}

function closeLightbox() {
  if (!lightboxItem) return;
  const els = lightboxEls();
  lightboxItem = null;
  lightboxCard = null;
  if (els.box) els.box.hidden = true;
  document.body.classList.remove("lightbox-open");
  const back = lightboxLastFocus;
  lightboxLastFocus = null;
  // The card that opened the viewer may be gone — unfavoriting from the
  // viewer in the Favorites view rebuilds the grid, so the saved anchor
  // is detached, and focusing it would strand focus on a node that
  // isn't in the page. Fall back to the view's toggle there, the search
  // box otherwise. (isConnected is false for a detached node; the
  // !== false form keeps this safe where isConnected is undefined.)
  if (back && typeof back.focus === "function" && back.isConnected !== false) {
    back.focus();
  } else {
    const fb = favsView ? staticEl("favs-toggle") : staticEl("query");
    if (fb && typeof fb.focus === "function") fb.focus();
  }
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
    // A fresh attempt gets its one display-fetch retry again (see the
    // state="full" branch in imgThumbError): without this, a retried card
    // that errors once more would fail immediately instead of retrying.
    img._fullRetried = false;
    retryBtn.style.display = "none";
    // Clear the "Preview only" state too (see markFullFailed): a card
    // whose upgrade failed but whose thumbnail was kept shows the badge
    // and the full-failed class — a retry that succeeds must remove both,
    // and a retry that fails again re-adds them via markUpgradeFailed.
    if (img._fullFailedBadge) img._fullFailedBadge.hidden = true;
    if (card) card.classList.remove("full-failed");
    loadFullImage(img);
    return;
  }
  const tagBtn = ev.target.closest('[data-action="search-tag"]');
  if (tagBtn) {
    // Click a tag to search it — the same path as a Trending chip (see
    // the chip handler): the term goes into the search box and the form
    // is submitted. The normal search formats it per source (booru
    // underscores, Wallhaven plain text), and search() exits the
    // Favorites/Trending view. dataset.tag is the decoded attribute
    // value, so a tag with spaces or quotes survives the round trip.
    const tag = tagBtn.dataset.tag || "";
    if (!tag) return;
    staticEl("query").value = tag;
    $("#search-form").requestSubmit();
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
      setFavButton(favBtn, nowFav);
    }
    return;
  }
  const thumbAnchor = ev.target.closest("a.thumb");
  if (thumbAnchor) {
    // Left-click (or keyboard Enter) on the image opens the viewer in
    // the page instead of a new tab. Middle-click still opens the full
    // image (auxclick, not click), and the anchor's href stays the full
    // URL for right-click / copy-link. The heart, Retry and tag buttons
    // sit outside the anchor and are handled above, so they never land
    // here. The placeholder has pointer-events:none, so a click on a
    // failed card's image area reaches the anchor too — the viewer
    // shows the error note for it.
    ev.preventDefault();
    openLightbox(thumbAnchor.closest(".card"));
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

// Viewer controls (round 15): X / backdrop close, the heart toggles the
// favorite (and syncs the card's heart behind it), a tag chip closes
// the viewer and searches the tag. Esc is a document keydown below —
// it only acts while the viewer is open.
const lightboxEl = staticEl("lightbox");
if (lightboxEl) {
  lightboxEl.addEventListener("click", (ev) => {
    if (ev.target.closest('[data-action="close-lightbox"]')) { closeLightbox(); return; }
    const favBtn = ev.target.closest('[data-action="toggle-fav"]');
    if (favBtn) {
      const item = renderedByPage.get(favBtn.dataset.page);
      if (!item) return;
      const nowFav = toggleFav(item);
      if (favsView) {
        // Unfavoriting inside the Favorites view removes the card from
        // it — the viewer was showing a card that is gone, so close it.
        renderFavsView();
        closeLightbox();
      } else {
        setFavButton(favBtn, nowFav);
        const cardFav = lightboxCard && lightboxCard.querySelector('[data-action="toggle-fav"]');
        setFavButton(cardFav, nowFav);
      }
      return;
    }
    const tagBtn = ev.target.closest('[data-action="search-tag"]');
    if (tagBtn) {
      const tag = tagBtn.dataset.tag || "";
      if (!tag) return;
      closeLightbox();
      staticEl("query").value = tag;
      $("#search-form").requestSubmit();
      return;
    }
  });
}
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && lightboxItem) closeLightbox();
  // Tab must stay inside the viewer while it's open (round 15 debugger):
  // the dialog is modal (aria-modal), but without a trap a keyboard user
  // tabs straight out of it into the page behind — and could then
  // re-open the viewer from a card while it's already open. Wrap Tab at
  // both ends, and pull focus back in if it somehow got outside.
  if (ev.key === "Tab" && lightboxItem) {
    const els = lightboxEls();
    const focusables = [els.source, els.full, els.fav];
    if (!els.tags.hidden) focusables.push(...els.tags.querySelectorAll(".tag-chip"));
    focusables.push(els.close);
    const list = focusables.filter(Boolean);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (!list.includes(active)) { ev.preventDefault(); first.focus(); return; }
    if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  }
});
