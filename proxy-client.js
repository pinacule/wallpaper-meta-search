// ProxyClient — fetch JSON through a chain of CORS proxies, reporting which one worked.
//
// Why this exists: Wallhaven, Safebooru and AlphaCoders send NO CORS headers,
// so a web page cannot call their APIs directly. The only reliable paths are
// a proxy you run yourself (local Node proxy, or your own Cloudflare Worker).
// Public proxies are tried last and are flaky by nature — every one of them
// was tested live on 2026-11-15 and most were already down or rate-limited:
//
//   VERIFIED WORKING 2026-11-15 (evening retest, 5/5 rounds via curl + app code)
//     local proxy (proxy/server.mjs, port 8787) — every source, incl. Zerochan
//     corsfix (proxy.corsfix.com)                — Wallhaven, Safebooru,
//                                                  Wallpapers.com, AlphaCoders
//   FLAKY / BURSTY via corsfix (flips between 200 and 503 over minutes)
//     wallpapercave — category page 503s in bursts (0 bytes, 5/5 one round,
//       then 40 results the next); search page 503s too
//     zerochan — 503 "Crawlers are not permitted" (Zerochan's own bot-block
//       against corsfix's datacenter IP), 5/5 one round, then 38 results
//   ALIVE BUT SLOW / FAILING for these hosts on 2026-11-15
//     allorigins /raw and /get                   — 502/522, and 7-20s to fail;
//                                                  BUT it serves WallpaperCave
//                                                  category pages (200, 7.1s),
//                                                  which the slug fallback uses
//     cors.lol (api.cors.lol)                    — 429 rate-limited on everything
//   DEAD / KEY-ONLY (not in the chain)
//     codetabs (timeout), corsproxy.io (API key), isomorphic-git (403),
//     cors.eu.org (Cloudflare block)
//
// Why a failed source shows "proxy unreachable" instead of "HTTP 503": when
// a public proxy returns an error status, the browser only reports it as
// "Failed to fetch" if that error response lacks CORS headers (allorigins'
// Cloudflare error pages do). The chain error then contains "Failed to fetch"
// and the UI shortens it to "proxy unreachable". The real per-proxy errors
// are in the full message (hover the pill).
//
// Retries: each candidate is tried twice (1 retry after 1.5s) on network
// errors, timeouts, HTTP 5xx and 429 — the public proxies flip between
// working and 503 in bursts, so a second attempt often lands on a good one.
// 4xx (except 429) is final. The local proxy is never retried: a refused
// connection means it simply isn't running, and retrying would only add delay.
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

  const RETRY_DELAY_MS = 1500;

  // settings: { customProxy?: string, workerUrl?: string }
  function buildChain(settings) {
    const chain = [];
    // noRetry: a refused connection means the proxy isn't running at all —
    // retrying it would only add delay to every proxied source.
    if (pageIsHttp) chain.push({ name: "local proxy", noRetry: true, build: (u) => LOCAL_PROXY + encodeURIComponent(u) });
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

  // 4xx (except 429) means the request itself is wrong — retrying is pointless.
  // Everything else (network error, timeout, 5xx, 429) may clear on a retry.
  function isRetryable(err) {
    const m = String((err && err.message) || err || "");
    return !(/HTTP 4\d\d/.test(m) && !/HTTP 429/.test(m));
  }

  // Walk the chain; each candidate gets one retry on a retryable failure.
  // parse(res, candidate) turns the response into the result (JSON or text).
  async function fetchViaChain(chain, targetUrl, timeoutMs, parse) {
    const failures = [];
    for (const candidate of chain) {
      let lastErr = null;
      const attempts = candidate.noRetry ? 1 : 2;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const res = await fetchWithTimeout(candidate.build(targetUrl), timeoutMs);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const result = await parse(res, candidate);
          return { result, via: candidate.name };
        } catch (err) {
          lastErr = err;
          if (attempt + 1 < attempts && isRetryable(err)) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            continue;
          }
          break;
        }
      }
      failures.push(`${candidate.name}: ${lastErr.message}`);
    }
    throw new Error(`all proxies exhausted — ${failures.join(" | ")}`);
  }

  async function fetchJson(targetUrl, settings = {}, timeoutMs = 8000) {
    const { result: data, via } = await fetchViaChain(buildChain(settings), targetUrl, timeoutMs,
      async (res, candidate) => {
        let data = await res.json();
        if (candidate.unwrap) {
          // allorigins /get wraps the body: { contents: "<json string>", ... }
          if (typeof data.contents === "string") data = JSON.parse(data.contents);
          else throw new Error("unexpected allorigins response");
        }
        return data;
      });
    return { data, via };
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
  // 20s timeout: scraped pages are ~400KB and the slow fallbacks (allorigins)
  // need 7s+ even to serve a page that works.
  async function fetchText(targetUrl, settings = {}, timeoutMs = 20000) {
    const { result: text, via } = await fetchViaChain(buildChain(settings), targetUrl, timeoutMs,
      async (res, candidate) => {
        let text = await res.text();
        if (candidate.unwrap) {
          const data = JSON.parse(text);
          if (typeof data.contents === "string") text = data.contents;
          else throw new Error("unexpected allorigins response");
        }
        return text;
      });
    return { text, via };
  }

  return { fetchJson, fetchText, probeLocalProxy, buildChain, LOCAL_PROXY };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ProxyClient;
