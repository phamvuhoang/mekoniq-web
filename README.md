# MEKONIQ Serve — web

Static site, no build step. Deploys to Vercel as-is.

Four static pages sharing `site.css` (tokens copied from `demo/brand.css`, fonts from `demo/fonts/`, no JS framework):

- `index.html` — Home: hero, how it works, the robot screen, fallbacks + safety, pilot KPIs (keeps meta/OG)
- `serve.html` — Serve S1: features and the three apps (station, robot, table QR)
- `demo.html` — entry to the interactive demo (`demo/`, robot R1, kitchen station, showcase)
- `contact.html` — pilot form; builds a draft to copy, sends nothing to a server
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
