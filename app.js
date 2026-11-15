// Wallpaper Meta-Search — one query, several wallpaper sources, no server.
// Direct: Danbooru (sends CORS *). Via the proxy chain (proxy-client.js):
// Wallhaven, Safebooru, and the HTML-scraping adapters in adapters-extra.js.
// Gelbooru is link-only: its API returns 401 for anonymous requests
// (verified 2026-11-15 — the site is up, the dapi needs an account key).
// WallpaperAccess is link-only: Cloudflare 403s every fetch (verified 2026-11-15).
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// NOTE: there is deliberately NO shared "last proxy" global. An earlier
// version kept one (`lastVia`) and the parallel source fetches overwrote it,
// so the status pill could name the wrong proxy (e.g. "danbooru … via
// corsfix" for a source that never touches a proxy). Each fetch returns its
// own `via`, adapters attach it to their result array, and search() reads it
// from there.

// Sites without inline results: open their own search in a new tab.
const SITE_LINKS = [
  ["WallpaperAccess", (q) => `https://wallpaperaccess.com/search?q=${encodeURIComponent(q)}`],
  ["Gelbooru", (q) => `https://gelbooru.com/index.php?page=post&s=list&tags=${encodeURIComponent(q.replace(/\s+/g, "_"))}`],
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
  const whKeyEl = $("#wh-key");
  if (whKeyEl) whKeyEl.value = localStorage.getItem("wms.whKey") || "";
  updateProxyStatus();
}
function saveSettings() {
  localStorage.setItem("wms.proxy", $("#proxy").value.trim());
  localStorage.setItem("wms.workerUrl", $("#worker-url").value.trim());
  localStorage.setItem("wms.purity", $("#purity").value);
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
  const hosted = window.location.protocol === "https:";
  if (el) {
    el.textContent = up
      ? "Local proxy detected on port 8787 — Wallhaven and the other proxied sources will go through it."
      : "Local proxy not running — sources will try your Worker, then public proxies. Run start.sh (Linux/Mac) or start.bat (Windows) to start it.";
  }
  if (banner) {
    banner.hidden = up;
    if (!up && bannerText) {
      bannerText.innerHTML = hosted
        ? "<strong>No local proxy here — and the hosted version can't reach one.</strong> Set up the Cloudflare Worker (see <code>worker/README.md</code>) and paste its URL in Settings, or run the app locally with <code>./start.sh</code> — otherwise Wallhaven, Safebooru, Zerochan and the other proxied sources fall back to public proxies, which fail often."
        : "<strong>Local proxy not running.</strong> Wallhaven, Safebooru, Zerochan and the other proxied sources fall back to public proxies, which fail often — some sources may come back empty. Run <code>./start.sh</code> (Linux/Mac) or <code>start.bat</code> (Windows) from the project folder, then reload this page.";
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
function passesMinRes(r) {
  const m = minRes();
  // Unknown sizes (0x0 — some scraped sites don't show resolution) pass
  // through instead of being hidden by a filter that can't judge them.
  return !m || !r.width || !r.height || (r.width >= m.w && r.height >= m.h);
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
const BOORU_TARGET = 40;
const BOORU_MAX_PAGES = 4;
const BOORU_PAGE_SIZE = 100;
const BOORU_PAGE_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// "Code Geass" -> "code_geass"; "Code Geass, Lelouch" -> "code_geass lelouch"
// (comma separates tags, whitespace inside a tag becomes underscores).
// Tags are joined with SPACES, not "+", because encodeURIComponent turns "+"
// into "%2B" and Danbooru then treats the whole thing as one literal tag
// (that was the "Danbooru: 0 found" bug at default settings).
function booruTags(q) {
  return q.split(",").map((part) =>
    part.trim().toLowerCase().split(/\s+/).filter(Boolean).join("_")
  ).filter(Boolean).join(" ");
}

// Prefer the original file for `full` (a wallpaper app wants full res, not
// the ~850px sample). Fall back to the sample for videos/archives.
function pickBooruFile(fileUrl, sampleUrl) {
  if (fileUrl && !/\.(mp4|webm|zip)$/i.test(fileUrl)) return fileUrl;
  return sampleUrl || fileUrl || null;
}

// --- Source adapters. Each returns [{ thumb, full, page, width, height, source, date }].
// `date` is an ISO string where the API provides one (Danbooru and Wallhaven
// via `created_at`), null otherwise. The result array also carries `.via`
// (which proxy served it, "" for direct) and, for the boorus, `.hidden` —
// see the note at the top about why `via` is per-call, never a global. ---
const SOURCES = {
  async danbooru(q) {
    const tags = booruTags(q);
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
          page: `https://danbooru.donmai.us/posts/${p.id}`,
          width: p.image_width, height: p.image_height, source: "Danbooru",
          date: p.created_at || null,
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
    const tags = booruTags(q);
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
          page: `https://safebooru.org/index.php?page=post&s=view&id=${p.id}`,
          width: p.width, height: p.height, source: "Safebooru",
          // Safebooru's dapi returns no created_at (it has `change`, a
          // last-modified epoch — deliberately not used as a date).
          date: p.created_at || null,
        };
        if (passesMinRes(item)) {
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
    const p = purity();
    const params = new URLSearchParams({
      q, categories: "111", sorting: "relevance", order: "desc", page: "1",
      // Safe: sfw only (100). Mixed: sfw + sketchy (110) — works without an
      // API key, verified live 2026-11-15. NSFW: 001 — the API returns 0
      // results for anonymous requests (verified live 2026-11-15: total 0
      // for "code geass", "anime" and even an empty query; the docs say
      // "NSFW wallpapers are blocked to guests"), so a key is required.
      // The key is only sent when set in Settings; without one the adapter
      // throws and the status pill explains why instead of showing 0.
      purity: p === "safe" ? "100" : p === "mixed" ? "110" : "001",
    });
    if (p === "nsfw") {
      const keyEl = $("#wh-key");
      const key = keyEl ? keyEl.value.trim() : "";
      if (!key) throw new Error("needs a Wallhaven API key for NSFW — paste one in Settings (free, from your Wallhaven account)");
      params.set("apikey", key);
    }
    const m = minRes();
    if (m) params.set("atleast", `${m.w}x${m.h}`);
    const { data, via } = await fetchJson(`https://wallhaven.cc/api/v1/search?${params}`, true);
    const out = (data.data || []).map((w) => ({
      thumb: w.thumbs.large,
      full: w.path,
      page: w.url,
      width: parseInt(w.resolution.split("x")[0], 10),
      height: parseInt(w.resolution.split("x")[1], 10),
      source: "Wallhaven",
      date: w.created_at || null,
    }));
    out.via = via;
    return out;
  },

  // NOTE: no AlphaCoders adapter here — its documented API is dead (nginx 404
  // on every variant, verified 2026-11-15). The HTML-scraping replacement
  // lives in adapters-extra.js and registers itself into SOURCES.
};

// --- Sorting ---
// The last fetched result set is kept in memory so changing the sort order
// re-renders instantly without re-searching.
let lastResults = [];
let lastReports = [];
let lastQuery = "";

function sortMode() {
  return ($("#sort") && $("#sort").value) || "largest";
}

// Epoch ms for an item's date, or NaN when the source gives no date
// (scraped sources have none — see adapters-extra.js).
function dateMs(r) {
  return r.date ? Date.parse(r.date) : NaN;
}

function sortResults(list) {
  const mode = sortMode();
  if (mode === "source") return list; // arrival order, as the sources returned them
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Short, scannable reason for a failed source (full message goes in the pill's title).
// Order matters: an HTTP status is the most informative bit — check it before
// the generic "proxy unreachable" mapping, or a 503 challenge page, a 429 and
// a dead local proxy all display identically.
function shortReason(err) {
  const m = String((err && err.message) || err || "");
  if (/api key/i.test(m)) return "needs API key";
  const http = m.match(/HTTP (\d+)/);
  if (http) return `HTTP ${http[1]}`;
  if (/NetworkError|Failed to fetch|Load failed/i.test(m)) return "proxy unreachable";
  return m.length > 48 ? m.slice(0, 48) + "…" : m;
}

function renderResults(results, reports, q) {
  const seen = new Set();
  const uniq = results.filter((r) => {
    if (seen.has(r.full)) return false;
    seen.add(r.full);
    return true;
  });
  const sorted = sortResults(uniq);

  const hiddenTotal = reports.reduce((sum, r) => sum + (r[3] || 0), 0);

  $("#status").innerHTML = reports.map(([name, payload, ok]) => {
    if (ok) {
      return `<span class="status-pill pill-ok"><span class="pill-dot"></span><strong>${name}</strong>&nbsp;${escapeHtml(payload)}</span>`;
    }
    const full = String((payload && payload.message) || payload || "");
    return `<span class="status-pill pill-fail" title="${escapeHtml(full)}"><span class="pill-dot"></span><strong>${name}</strong>&nbsp;${shortReason(payload)}</span>`;
  }).join("") + (uniq.length
    ? `<span class="status-pill pill-total"><strong>${uniq.length} result${uniq.length === 1 ? "" : "s"}</strong></span>`
    : "");

  const box = $("#results");
  if (!uniq.length) {
    if (hiddenTotal > 0 && minRes()) {
      const m = minRes();
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
  box.innerHTML = sorted.map((r) => {
    const res = (r.width && r.height) ? `${r.width}×${r.height}` : "size unknown";
    // Full-resolution image as the displayed <img> (no small thumb, no crop).
    // aspect-ratio reserves the box from the known dimensions so lazy-loaded
    // images don't shift the collage as they arrive; unknown sizes (0x0)
    // get no ratio and size themselves naturally once loaded.
    const ratio = (r.width && r.height) ? ` style="aspect-ratio:${r.width} / ${r.height}"` : "";
    return `
    <article class="card">
      <a class="thumb" href="${r.full}" target="_blank" rel="noopener"><img loading="lazy" decoding="async" src="${r.full}" data-thumb="${escapeHtml(r.thumb)}"${ratio} alt="${r.source} wallpaper ${res}">
        <span class="badge badge-res">${res}</span>
        <span class="badge badge-src">${r.source}</span>
      </a>
      <div class="meta">
        <div class="links">
          <a href="${r.page}" target="_blank" rel="noopener">Source page ↗</a>
          <a href="${r.full}" target="_blank" rel="noopener">Full image ↗</a>
        </div>
      </div>
    </article>`;
  }).join("");
  // If a full image fails to load (hotlink protection, dead file), fall back
  // to the smaller thumb instead of leaving a broken card.
  box.querySelectorAll(".card img").forEach((img) => {
    img.addEventListener("error", () => {
      const thumb = img.dataset.thumb;
      if (thumb && !img.dataset.fallbackDone) {
        img.dataset.fallbackDone = "1";
        img.src = thumb;
      }
    });
  });
}

async function search(ev) {
  ev.preventDefault();
  saveSettings();
  const q = $("#query").value.trim();
  if (!q) return;
  renderSiteLinks(q);

  const chosen = $$(".source:checked").map((c) => c.value);
  $("#status").innerHTML = `<span class="status-pill pill-busy"><span class="spinner"></span>Searching ${chosen.length} source${chosen.length === 1 ? "" : "s"}…</span>`;
  $("#results").innerHTML = Array.from({ length: 8 }, () =>
    `<div class="skeleton" aria-hidden="true"><div class="skeleton-thumb"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`).join("");

  const reports = [];
  const all = [];
  await Promise.all(chosen.map(async (name) => {
    try {
      const items = await SOURCES[name](q);
      const passing = items.filter(passesMinRes);
      all.push(...passing);
      // Adapters report how many matches the min-resolution filter hid, so
      // the UI never silently shows 0 when matches exist below the filter.
      // `via` comes from the items themselves (per-call), never a shared
      // global — parallel fetches used to overwrite each other's label.
      const via = items.via || "";
      let msg = `${passing.length} found${via ? ` (via ${via})` : ""}`;
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
      const m = minRes();
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
  if (lastReports.length) renderResults(lastResults, lastReports, lastQuery);
});
// Banner action: re-probe the local proxy (e.g. after starting start.sh)
// and hide the banner if it's up now.
const recheckBtn = $("#proxy-recheck");
if (recheckBtn) recheckBtn.addEventListener("click", updateProxyStatus);
// Empty-state action: drop the min-resolution filter and search again.
$("#results").addEventListener("click", (ev) => {
  if (!ev.target.closest('[data-action="clear-res"]')) return;
  $("#min-res").value = "0";
  $("#search-form").requestSubmit();
});
loadSettings();
