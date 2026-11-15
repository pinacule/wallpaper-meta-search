#!/bin/sh
# Wallpaper Meta-Search — one double-click start (Linux / macOS).
# Starts the local CORS proxy (port 8787) and serves the app on port 8090.
# The app auto-detects the local proxy when served from localhost, so
# Wallhaven works with no Settings changes. Ctrl+C stops anything started
# here. If a proxy or the app is already running on those ports, it is
# reused instead of starting a second copy.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (https://nodejs.org). It is not installed or not on PATH."
  exit 1
fi

PROXY_PID=""
SERVER_PID=""

# The local proxy answers 400 with usage text when no ?url= is given —
# any HTTP answer means something is already listening on :8787.
if curl -s -m 2 -o /dev/null "http://localhost:8787/"; then
  echo "Proxy already running on :8787 — reusing it."
else
  node proxy/server.mjs &
  PROXY_PID=$!
fi

# Reuse :8090 only if it is already serving this app.
if curl -s -m 2 "http://localhost:8090/index.html" | grep -q "Wallpaper Meta-Search"; then
  echo "App already running on :8090 — reusing it."
elif command -v python3 >/dev/null 2>&1; then
  python3 -m http.server 8090 >/dev/null 2>&1 &
  SERVER_PID=$!
else
  node --input-type=module -e "
    import http from 'node:http';
    import { readFile } from 'node:fs/promises';
    import { extname, join } from 'node:path';
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/plain' };
    http.createServer(async (req, res) => {
      try {
        const file = join(process.cwd(), req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
        res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
        res.end(await readFile(file));
      } catch { res.writeHead(404); res.end('not found'); }
    }).listen(8090, () => console.log('App on http://localhost:8090/'));
  " &
  SERVER_PID=$!
fi

cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

sleep 1
echo ""
echo "  Wallpaper Meta-Search is running:"
echo "    App:   http://localhost:8090/"
echo "    Proxy: http://localhost:8787/ (Wallhaven goes through this)"
if [ -z "$PROXY_PID" ] && [ -z "$SERVER_PID" ]; then
  echo "  (Both were already running, so nothing new was started.)"
else
  echo "  Press Ctrl+C to stop."
fi
echo ""

if command -v xdg-open >/dev/null 2>&1; then
  (sleep 1; xdg-open http://localhost:8090/ >/dev/null 2>&1 &) || true
elif command -v open >/dev/null 2>&1; then
  (sleep 1; open http://localhost:8090/ >/dev/null 2>&1 &) || true
fi

if [ -n "$PROXY_PID" ] || [ -n "$SERVER_PID" ]; then
  wait
fi
