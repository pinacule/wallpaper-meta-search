// Optional local CORS proxy for Wallpaper Meta-Search.
// Usage: node server.mjs   (Node 18+; no dependencies)
// Then set the app's CORS proxy to: http://localhost:8787/?url=
// It only fetches the wallpaper APIs and public search pages the app uses
// (see ALLOWED) and adds CORS headers.
// Do NOT expose this to the internet — it is an open proxy by design.
import http from "node:http";

const PORT = 8787;
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
  try {
    const upstream = await fetch(target, { headers: { "User-Agent": "wallpaper-meta-search/0.1" } });
    res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("Content-Type") || "application/json" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Upstream fetch failed: ${err.message}\n`);
  }
});

server.listen(PORT, () => console.log(`Wallpaper Meta-Search proxy on http://localhost:${PORT}/`));
