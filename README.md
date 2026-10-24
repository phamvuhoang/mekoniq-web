# MEKONIQ Serve — web

Static site, no build step. Deploys to Vercel as-is.

- `index.html` — landing page (MEKONIQ Serve concept, from the 2026 company blueprint)
- `demo/` — interactive demo: same UI + orchestrator as the Node-RED version, running in the browser
  (`demo/transport.js` replaces the WebSocket; tabs/iframes of one browser sync via BroadcastChannel)

## Update the demo
Source of truth is `../trial`. After changing UI or logic there:

    cd ../trial && npm run web     # copies data/public, data/lib, data/site.json -> web/demo

`demo/transport.js`, `demo/index.html`, `demo/showcase.html` are web-only and are not overwritten.

## Run locally
    python3 -m http.server 4173    # http://localhost:4173 (Web Locks need localhost or https)

## Deploy
    npm i -g vercel
    vercel          # preview
    vercel --prod   # production
