// Wallpaper Meta-Search — one query, several wallpaper sources, no server.
// Direct: Danbooru (sends CORS *). Via the proxy chain (proxy-client.js):
// Wallhaven, Safebooru, and the HTML-scraping adapters in adapters-extra.js.
// Gelbooru is link-only: its API returns 401 for anonymous requests
// (verified 2026-11-15 — the site is up, the dapi needs an account key).
// WallpaperAccess is link-only: Cloudflare 403s every fetch (verified 2026-11-15).
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let lastVia = ""; // which proxy served the most recent proxied request (see proxy-client.js)

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
  updateProxyStatus();
}
function saveSettings() {
  localStorage.setItem("wms.proxy", $("#proxy").value.trim());
  localStorage.setItem("wms.workerUrl", $("#worker-url").value.trim());
}

// Shows whether the local proxy (start.sh / start.bat) is running.
async function updateProxyStatus() {
  const el = $("#proxy-status");
  if (!el) return;
  const up = await ProxyClient.probeLocalProxy();
  el.textContent = up
    ? "Local proxy detected on port 8787 — Wallhaven and the other proxied sources will go through it."
    : "Local proxy not running — sources will try your Worker, then public proxies. Run start.sh (Linux/Mac) or start.bat (Windows) to start it.";
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
async function fetchJson(url, viaProxy) {
  if (!viaProxy) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  // Proxied sources go through the fallback chain (local proxy -> Worker ->
  // custom proxy -> public proxies). See proxy-client.js.
  const { data, via } = await ProxyClient.fetchJson(url, proxySettings());
  lastVia = via;
  return data;
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

// --- Source adapters. Each returns [{ thumb, full, page, width, height, source }]. ---
const SOURCES = {
  async danbooru(q) {
    const tags = booruTags(q);
    const sfw = $("#sfw").checked;
    const m = minRes();
    const baseTags = tags + (sfw ? " rating:safe" : "");
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
        const [all, pass] = await Promise.all([
          fetchJson(`https://danbooru.donmai.us/counts/posts.json?tags=${encodeURIComponent(baseTags)}`, false),
          fetchJson(`https://danbooru.donmai.us/counts/posts.json?tags=${encodeURIComponent(searchTags)}`, false),
        ]);
        return Math.max(0, (all.counts?.posts ?? 0) - (pass.counts?.posts ?? 0));
      })().catch(() => 0);
    }

    const out = [];
    for (let page = 1; page <= BOORU_MAX_PAGES && out.length < BOORU_TARGET; page++) {
      const data = await fetchJson(
        `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(searchTags)}&limit=${BOORU_PAGE_SIZE}&page=${page}`, false);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const p of data) {
        const full = pickBooruFile(p.file_url, p.large_file_url);
        if (!full) continue;
        out.push({
          thumb: p.preview_file_url || p.large_file_url || full,
          full,
          page: `https://danbooru.donmai.us/posts/${p.id}`,
          width: p.image_width, height: p.image_height, source: "Danbooru",
        });
        if (out.length >= BOORU_TARGET) break;
      }
      if (data.length < BOORU_PAGE_SIZE) break; // last page
      if (out.length < BOORU_TARGET) await sleep(BOORU_PAGE_DELAY_MS);
    }
    out.hidden = hiddenPromise ? await hiddenPromise : 0;
    out.hiddenScope = "db"; // exact count across the whole database
    return out;
  },

  async safebooru(q) {
    // Safebooru's API has no server-side dimension filter, so filter locally
    // — but paginate through big pages until we have enough passing results
    // instead of giving up after the first 40 newest posts.
    const tags = booruTags(q);
    const out = [];
    let examined = 0;
    let hidden = 0;
    for (let pid = 0; pid < BOORU_MAX_PAGES && out.length < BOORU_TARGET; pid++) {
      const data = await fetchJson(
        `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=${BOORU_PAGE_SIZE}&pid=${pid}&tags=${encodeURIComponent(tags)}`, true);
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
    return out;
  },

  async wallhaven(q) {
    const params = new URLSearchParams({
      q, categories: "111", sorting: "relevance", order: "desc", page: "1",
      purity: $("#sfw").checked ? "100" : "110",
    });
    const m = minRes();
    if (m) params.set("atleast", `${m.w}x${m.h}`);
    const data = await fetchJson(`https://wallhaven.cc/api/v1/search?${params}`, true);
    return (data.data || []).map((w) => ({
      thumb: w.thumbs.large,
      full: w.path,
      page: w.url,
      width: parseInt(w.resolution.split("x")[0], 10),
      height: parseInt(w.resolution.split("x")[1], 10),
      source: "Wallhaven",
    }));
  },

  // NOTE: no AlphaCoders adapter here — its documented API is dead (nginx 404
  // on every variant, verified 2026-11-15). The HTML-scraping replacement
  // lives in adapters-extra.js and registers itself into SOURCES.
};

function renderSiteLinks(q) {
  $("#site-buttons").innerHTML = SITE_LINKS.map(([name, fn]) =>
    `<a href="${fn(q)}" target="_blank" rel="noopener">${name} ↗</a>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Short, scannable reason for a failed source (full message goes in the pill's title).
function shortReason(err) {
  const m = String((err && err.message) || err || "");
  if (/no API key/i.test(m)) return "needs API key";
  if (/NetworkError|Failed to fetch|Load failed/i.test(m)) return "proxy unreachable";
  const http = m.match(/HTTP (\d+)/);
  if (http) return `HTTP ${http[1]}`;
  return m.length > 48 ? m.slice(0, 48) + "…" : m;
}

function renderResults(results, reports, q) {
  const seen = new Set();
  const uniq = results.filter((r) => {
    if (seen.has(r.full)) return false;
    seen.add(r.full);
    return true;
  }).sort((a, b) => (b.width * b.height) - (a.width * a.height));

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
  box.innerHTML = uniq.map((r) => {
    const res = (r.width && r.height) ? `${r.width}×${r.height}` : "size unknown";
    return `
    <article class="card">
      <a class="thumb" href="${r.full}" target="_blank" rel="noopener"><img loading="lazy" src="${r.thumb}" alt="${r.source} wallpaper ${res}">
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
    lastVia = "";
    try {
      const items = await SOURCES[name](q);
      const passing = items.filter(passesMinRes);
      all.push(...passing);
      // Adapters report how many matches the min-resolution filter hid, so
      // the UI never silently shows 0 when matches exist below the filter.
      let msg = `${passing.length} found${lastVia ? ` (via ${lastVia})` : ""}`;
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
  renderResults(all, reports, q);
}

$("#search-form").addEventListener("submit", search);
$("#proxy").addEventListener("change", saveSettings);
$("#worker-url").addEventListener("change", saveSettings);
// Empty-state action: drop the min-resolution filter and search again.
$("#results").addEventListener("click", (ev) => {
  if (!ev.target.closest('[data-action="clear-res"]')) return;
  $("#min-res").value = "0";
  $("#search-form").requestSubmit();
});
loadSettings();
