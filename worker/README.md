# Cloudflare Worker proxy

Your own CORS proxy for Wallpaper Meta-Search, on Cloudflare's free tier
(100,000 requests/day). Once deployed, Wallhaven works from anywhere —
including the GitHub Pages version of the app — with no public proxy involved.

## Deploy (pick one)

### Option A — one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pinacule/wallpaper-meta-search)

Sign in with (or create) a free Cloudflare account and it deploys the worker
from this repo. Copy the `*.workers.dev` URL it gives you.

### Option B — paste in the dashboard (2 minutes, no tools)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Create Worker.
2. Delete the starter code, paste in the contents of `worker.js` from this folder, Deploy.
3. Copy the `*.workers.dev` URL from the worker's page.

### Option C — command line

```sh
npx wrangler login
npx wrangler deploy   # from the repo root; uses wrangler.toml
```

## Wire it into the app

Open the app → Settings → **Your Cloudflare Worker URL** → paste the URL →
search. The status line under each search will say `via worker` when it's used.

## What it does

Forwards `?url=` to the wallpaper APIs (`wallhaven.cc/api`,
`safebooru.org` dapi, `wall.alphacoders.com/api2.0`), the search pages the
scraping adapters fetch (wallpapers.com, wallpapercave.com,
alphacoders.com, zerochan.net), and the image files the app routes
through a proxy (Zerochan and WallpaperCave) — and adds CORS headers.
Any other host gets a 400, so it can't be abused as a general open proxy.
