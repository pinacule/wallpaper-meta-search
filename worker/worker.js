// Cloudflare Worker: CORS proxy for Wallpaper Meta-Search.
// Free tier: 100,000 requests/day — far more than wallpaper searching needs.
//
// It forwards ?url= to one of the wallpaper APIs and adds CORS headers, so the
// app can call Wallhaven / Safebooru / AlphaCoders directly from the browser
// without a public proxy. Nothing else is forwarded: any other host gets a 400.
//
// Deploy it (see worker/README.md), then paste the *.workers.dev URL into the
// app's Settings under "Your Cloudflare Worker URL".
const ALLOWED = [
  /^https:\/\/wallhaven\.cc\/api\//,
  /^https:\/\/safebooru\.org\/index\.php\?page=dapi/,
  /^https:\/\/wall\.alphacoders\.com\/api2\.0\//,
  // HTML search pages used by the scraping adapters (adapters-extra.js):
  /^https:\/\/wallpapers\.com\//,
  /^https:\/\/wallpapercave\.com\//,
  /^https:\/\/wall\.alphacoders\.com\/search\.php/,
  /^https:\/\/alphacoders\.com\//,
  /^https:\/\/www\.zerochan\.net\//,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const target = new URL(request.url).searchParams.get("url");
    if (!target || !ALLOWED.some((re) => re.test(target))) {
      return new Response("Usage: /?url=<wallhaven|safebooru|alphacoders api url, or a wallpaper search page>\n", {
        status: 400,
        headers: CORS,
      });
    }
    try {
      const upstream = await fetch(target, {
        headers: { "User-Agent": "wallpaper-meta-search/0.1" },
      });
      const headers = new Headers(upstream.headers);
      for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err.message}\n`, {
        status: 502,
        headers: CORS,
      });
    }
  },
};
