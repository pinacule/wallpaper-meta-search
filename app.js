// Wallpaper Meta-Search — one query, several wallpaper sources, no server.
// Direct: Danbooru (sends CORS *). Via proxy: Wallhaven, Safebooru, AlphaCoders.
// Sites with no open API are linked out instead (see SITE_LINKS below).
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const DEFAULT_PROXY = "https://api.allorigins.win/raw?url=";

// Sites without a usable open API: open their own search in a new tab.
const SITE_LINKS = [
  ["Wallpapers.com", (q) => `https://wallpapers.com/search/${encodeURIComponent(q)}`],
  ["WallpaperAccess", (q) => `https://wallpaperaccess.com/search?q=${encodeURIComponent(q)}`],
  ["WallpaperCave", (q) => `https://wallpapercave.com/search/?q=${encodeURIComponent(q)}`],
  ["Zerochan", (q) => `https://www.zerochan.net/search?q=${encodeURIComponent(q)}`],
  ["Gelbooru", (q) => `https://gelbooru.com/index.php?page=post&s=list&tags=${encodeURIComponent(q.replace(/\s+/g, "_"))}`],
  ["AlphaCoders", (q) => `https://wall.alphacoders.com/search.php?search=${encodeURIComponent(q)}`],
  ["Wallhaven", (q) => `https://wallhaven.cc/search?q=${encodeURIComponent(q)}`],
  ["Google Images", (q) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q + " wallpaper")}`],
];

function loadSettings() {
  $("#proxy").value = localStorage.getItem("wms.proxy") || DEFAULT_PROXY;
  $("#alpha-key").value = localStorage.getItem("wms.alphaKey") || "";
}
function saveSettings() {
  localStorage.setItem("wms.proxy", $("#proxy").value.trim() || DEFAULT_PROXY);
  localStorage.setItem("wms.alphaKey", $("#alpha-key").value.trim());
}

function minRes() {
  const v = $("#min-res").value;
  if (!v) return null;
  const [w, h] = v.split("x").map(Number);
  return { w, h };
}
function passesMinRes(r) {
  const m = minRes();
  return !m || (r.width >= m.w && r.height >= m.h);
}
function proxied(url) {
  return ($("#proxy").value.trim() || DEFAULT_PROXY) + encodeURIComponent(url);
}
async function fetchJson(url, viaProxy) {
  const res = await fetch(viaProxy ? proxied(url) : url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- Source adapters. Each returns [{ thumb, full, page, width, height, source }]. ---
const SOURCES = {
  async danbooru(q) {
    const tags = q.trim().split(/\s+/).join("_") + ($("#sfw").checked ? "+rating:safe" : "");
    const data = await fetchJson(
      `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(tags)}&limit=40`, false);
    return data.filter((p) => p.file_url || p.large_file_url).map((p) => ({
      thumb: p.preview_file_url || p.large_file_url || p.file_url,
      full: p.large_file_url || p.file_url,
      page: `https://danbooru.donmai.us/posts/${p.id}`,
      width: p.image_width, height: p.image_height, source: "Danbooru",
    }));
  },

  async safebooru(q) {
    const tags = q.trim().split(/\s+/).join("_");
    const data = await fetchJson(
      `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=40&tags=${encodeURIComponent(tags)}`, true);
    return (Array.isArray(data) ? data : []).map((p) => ({
      thumb: p.preview_url,
      full: p.sample_url || p.file_url,
      page: `https://safebooru.org/index.php?page=post&s=view&id=${p.id}`,
      width: p.width, height: p.height, source: "Safebooru",
    }));
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

  async alphacoders(q) {
    const key = $("#alpha-key").value.trim();
    if (!key) throw new Error("no API key set (see Settings)");
    const params = new URLSearchParams({
      auth: key, method: "search", term: q, info_level: "3",
    });
    const data = await fetchJson(`https://wall.alphacoders.com/api2.0/get.php?${params}`, true);
    if (!data.success) throw new Error(data.error || "AlphaCoders error");
    return (data.wallpapers || []).map((w) => ({
      thumb: w.url_thumb,
      full: w.url_image,
      page: `https://wall.alphacoders.com/big.php?i=${w.id}`,
      width: w.width, height: w.height, source: "AlphaCoders",
    }));
  },
};

function renderSiteLinks(q) {
  $("#site-buttons").innerHTML = SITE_LINKS.map(([name, fn]) =>
    `<a href="${fn(q)}" target="_blank" rel="noopener">${name} ↗</a>`).join("");
}

function renderResults(results, reports) {
  const seen = new Set();
  const uniq = results.filter((r) => {
    if (seen.has(r.full)) return false;
    seen.add(r.full);
    return true;
  }).sort((a, b) => (b.width * b.height) - (a.width * a.height));

  $("#status").innerHTML = reports.map(([name, msg, ok]) =>
    `<span class="${ok ? "" : "fail"}"><strong>${name}:</strong> ${msg}</span>`).join(" &nbsp;•&nbsp; ") +
    (uniq.length ? ` &nbsp;•&nbsp; <strong>${uniq.length} results</strong>` : "");

  const box = $("#results");
  if (!uniq.length) {
    box.innerHTML = `<p class="empty">No results. Try a simpler query (one or two words), another source, or the site links above.</p>`;
    return;
  }
  box.innerHTML = uniq.map((r) => `
    <article class="card">
      <a href="${r.full}" target="_blank" rel="noopener"><img loading="lazy" src="${r.thumb}" alt="${r.source} wallpaper ${r.width}×${r.height}"></a>
      <div class="meta">
        <span class="res">${r.width}×${r.height}</span> · <span class="src">${r.source}</span>
        <div class="links">
          <a href="${r.page}" target="_blank" rel="noopener">Source page ↗</a>
          <a href="${r.full}" target="_blank" rel="noopener">Full image ↗</a>
        </div>
      </div>
    </article>`).join("");
}

async function search(ev) {
  ev.preventDefault();
  saveSettings();
  const q = $("#query").value.trim();
  if (!q) return;
  renderSiteLinks(q);

  const chosen = $$(".source:checked").map((c) => c.value);
  $("#status").textContent = "Searching…";
  $("#results").innerHTML = "";

  const reports = [];
  const all = [];
  await Promise.all(chosen.map(async (name) => {
    try {
      const items = (await SOURCES[name](q)).filter(passesMinRes);
      all.push(...items);
      reports.push([name, `${items.length} found`, true]);
    } catch (err) {
      const viaProxy = name !== "danbooru";
      reports.push([name, viaProxy
        ? `failed — proxy may be down (${err.message}). Try another proxy in Settings, or the site link above.`
        : `failed (${err.message})`, false]);
    }
  }));
  renderResults(all, reports);
}

$("#search-form").addEventListener("submit", search);
$("#proxy").addEventListener("change", saveSettings);
$("#alpha-key").addEventListener("change", saveSettings);
loadSettings();
