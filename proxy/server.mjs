// Optional local CORS proxy for Wallpaper Meta-Search.
// Usage: node server.mjs   (Node 18+; no dependencies)
// Then set the app's CORS proxy to: http://localhost:8787/?url=
// It only fetches the wallpaper APIs and public search pages the app uses
// (see ALLOWED) and adds CORS headers.
// Do NOT expose this to the internet — it is an open proxy by design.
import http from "node:http";
import { Readable } from "node:stream";

const PORT = 8787;
// A stalled upstream (Zerochan and Wallpapers.com both do this) must not tie
// up a proxy connection forever. The browser-side probe gives up at 15 s;
// this bounds the proxy at 20 s and a closed browser request aborts the
// upstream download immediately (see res.on("close") below).
const UPSTREAM_TIMEOUT_MS = 20000;
const ALLOWED = [
  /^https:\/\/wallhaven\.cc\/api\//,
  /^https:\/\/safebooru\.org\/index\.php\?page=dapi/,
  /^https:\/\/wall\.alphacoders\.com\/api2\.0\//,
  /^https:\/\/wallpapers\.com\//,
  /^https:\/\/wallpapercave\.com\//,
  /^https:\/\/wall\.alphacoders\.com\/search\.php/,
  /^https:\/\/alphacoders\.com\//,
  /^https:\/\/wallpaperaccess\.com\//,
  /^https:\/\/www\.zerochan\.net\//,
  // Image CDNs the card <img>s load from (thumb-first + upgrade path).
  // Same hosts the adapters already return URLs for — routing images
  // through here dodges Referer-based hotlink blocks the same way the
  // search fetches dodge them. NOTE: this does NOT change the egress IP,
  // so it can't dodge an IP-based block (e.g. Zerochan 503ing a
  // datacenter IP); the browser-side fallback chain still applies.
  /^https:\/\/w\.wallhaven\.cc\//,
  /^https:\/\/th\.wallhaven\.cc\//,
  /^https:\/\/safebooru\.org\//,
  /^https:\/\/images\d*\.alphacoders\.com\//,
  /^https:\/\/static\.zerochan\.net\//,
  /^https:\/\/s3\.zerochan\.net\//,
  /^https:\/\/cdn\.donmai\.us\//,
];

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const target = new URL(req.url, "http://localhost").searchParams.get("url");
  if (!target || !ALLOWED.some((re) => re.test(target))) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Usage: /?url=<allowed api/search url>\n");
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  // The browser aborts probes it no longer needs (15 s timeout, re-render,
  // closed tab). Abort the upstream fetch then too, instead of downloading a
  // multi-MB file for an image that will never be shown.
  res.on("close", () => {
    clearTimeout(timeout);
    controller.abort();
  });
  try {
    const upstream = await fetch(target, { signal: controller.signal, headers: { "User-Agent": "wallpaper-meta-search/0.1" } });
    // Forward the caching headers (and length/type) so the browser can
    // cache proxied images properly — without them every re-render
    // re-downloaded every thumb through the proxy. Only these are
    // forwarded; nothing else from upstream (no set-cookie, etc.).
    const headers = {};
    for (const name of ["content-type", "content-length", "cache-control", "last-modified", "etag", "expires", "accept-ranges"]) {
      const v = upstream.headers.get(name);
      if (v !== null) headers[name] = v;
    }
    res.writeHead(upstream.status, headers);
    // Stream the body instead of buffering it: a 26 MB AlphaCoders PNG
    // used to sit entirely in proxy memory before the first byte reached
    // the browser (and the 15 s probe timeout ticked the whole time).
    // Streaming also means time-to-first-byte is the upstream's, not the
    // full download's. A mid-stream upstream failure destroys the
    // response — the browser-side fallback chain treats it as a failed
    // image, same as the old 502 did.
    if (upstream.body) {
      Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
    } else {
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Upstream fetch failed: ${err.message}\n`);
  }
});

server.listen(PORT, () => console.log(`Wallpaper Meta-Search proxy on http://localhost:${PORT}/`));
