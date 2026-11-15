// ProxyClient — fetch JSON through a chain of CORS proxies, reporting which one worked.
//
// Why this exists: Wallhaven, Safebooru and AlphaCoders send NO CORS headers,
// so a web page cannot call their APIs directly. The only reliable paths are
// a proxy you run yourself (local Node proxy, or your own Cloudflare Worker).
// Public proxies are tried last and are flaky by nature — every one of them
// was tested live on 2026-11-15 and most were already down or rate-limited:
//
//   VERIFIED WORKING 2026-11-15
//     local proxy (proxy/server.mjs, port 8787) — Wallhaven JSON, CORS * header
//     corsfix (proxy.corsfix.com)                — Wallhaven JSON (needs an Origin
//                                                  header, which browsers send)
//   ALIVE BUT FAILING for Wallhaven on 2026-11-15
//     allorigins /raw and /get                   — 520 / 502 for wallhaven.cc
//     cors.lol (api.cors.lol)                    — 429 rate-limited
//   DEAD / KEY-ONLY (not in the chain)
//     codetabs (timeout), corsproxy.io (API key), isomorphic-git (403),
//     cors.eu.org (Cloudflare block)
//
// Chain order (first success wins):
//   1. local proxy — only when the page itself is served over http (localhost),
//      because an https page (GitHub Pages) cannot fetch http://localhost (mixed content).
//   2. the user's own Cloudflare Worker URL from Settings (if set).
//   3. a custom proxy URL from Settings (if set).
//   4. public fallbacks: corsfix, allorigins /raw, allorigins /get, cors.lol.
//
// Usage from app.js:
//   const { data, via } = await ProxyClient.fetchJson(apiUrl);
//   // via is e.g. "local proxy", "worker", "corsfix" — show it in the status line.
//   const up = await ProxyClient.probeLocalProxy(); // true if :8787 answers
"use strict";

const ProxyClient = (() => {
  const LOCAL_PROXY = "http://localhost:8787/?url=";

  // { name, build(url) } — build turns a target API URL into a proxied URL.
  const PUBLIC_PROXIES = [
    { name: "corsfix", build: (u) => `https://proxy.corsfix.com/?${u}` },
    { name: "allorigins", build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: "allorigins (json)", build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, unwrap: true },
    { name: "cors.lol", build: (u) => `https://api.cors.lol/?url=${encodeURIComponent(u)}` },
  ];

  const isBrowser = typeof window !== "undefined" && typeof window.location !== "undefined";
  const pageIsHttp = !isBrowser || window.location.protocol === "http:";

  function fetchWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  async function tryCandidate(candidate, targetUrl, timeoutMs) {
    const res = await fetchWithTimeout(candidate.build(targetUrl), timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json();
    if (candidate.unwrap) {
      // allorigins /get wraps the body: { contents: "<json string>", ... }
      if (typeof data.contents === "string") data = JSON.parse(data.contents);
      else throw new Error("unexpected allorigins response");
    }
    return data;
  }

  // settings: { customProxy?: string, workerUrl?: string }
  function buildChain(settings) {
    const chain = [];
    if (pageIsHttp) chain.push({ name: "local proxy", build: (u) => LOCAL_PROXY + encodeURIComponent(u) });
    if (settings.workerUrl) {
      const base = settings.workerUrl.replace(/\?$/, "").replace(/\/$/, "");
      chain.push({ name: "worker", build: (u) => `${base}/?url=${encodeURIComponent(u)}` });
    }
    if (settings.customProxy) {
      const p = settings.customProxy;
      chain.push({ name: "custom proxy", build: (u) => p + encodeURIComponent(u) });
    }
    chain.push(...PUBLIC_PROXIES);
    return chain;
  }

  async function fetchJson(targetUrl, settings = {}, timeoutMs = 8000) {
    const chain = buildChain(settings);
    const failures = [];
    for (const candidate of chain) {
      try {
        const data = await tryCandidate(candidate, targetUrl, timeoutMs);
        return { data, via: candidate.name };
      } catch (err) {
        failures.push(`${candidate.name}: ${err.message}`);
      }
    }
    throw new Error(`all proxies exhausted — ${failures.join(" | ")}`);
  }

  // Quick check whether the local proxy is running (any HTTP response counts —
  // it answers 400 with usage text when no ?url= is given).
  async function probeLocalProxy(timeoutMs = 2500) {
    try {
      await fetchWithTimeout("http://localhost:8787/", timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  // Same chain, but returns the raw text (for the HTML-scraping adapters).
  async function fetchText(targetUrl, settings = {}, timeoutMs = 8000) {
    const chain = buildChain(settings);
    const failures = [];
    for (const candidate of chain) {
      try {
        const res = await fetchWithTimeout(candidate.build(targetUrl), timeoutMs);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let text = await res.text();
        if (candidate.unwrap) {
          const data = JSON.parse(text);
          if (typeof data.contents === "string") text = data.contents;
          else throw new Error("unexpected allorigins response");
        }
        return { text, via: candidate.name };
      } catch (err) {
        failures.push(`${candidate.name}: ${err.message}`);
      }
    }
    throw new Error(`all proxies exhausted — ${failures.join(" | ")}`);
  }

  return { fetchJson, fetchText, probeLocalProxy, buildChain, LOCAL_PROXY };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ProxyClient;
