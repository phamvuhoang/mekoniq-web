# MEKONIQ Serve — web

Static site, no build step. Deploys to Vercel as-is.

Four static pages sharing `site.css` (tokens copied from `demo/brand.css`, fonts from `demo/fonts/`, no JS framework):

- `index.html` — Home: hero, how it works, the robot screen, fallbacks + safety, pilot KPIs (keeps meta/OG)
- `serve.html` — Serve S1: features and the three apps (station, robot, table QR)
- `demo.html` — entry to the interactive demo (`demo/`, robot R1, kitchen station, showcase)
- `contact.html` — pilot form; builds a draft to copy, sends nothing to a server
- `demo/` — interactive demo: same UI + orchestrator as the Node-RED version, running in the browser
  (`demo/transport.js` replaces the WebSocket; tabs/iframes of one browser sync via BroadcastChannel)
  `demo/site.json` is a feature policy v2 config with all six features on (`callStaff`, `requestBill`, `guide`, `order`, `pay`,
  `busRobot`), request station `kitchen`, guests reporting a wrong item to staff (`customerCancel: request`) and a 12-item menu;
  the shipped `trial/data/site.json` has every feature off — see `trial/docs/valetudo-setup.md` §2b. In the demo: Cấu hình →
  Hệ thống → Quản lý tính năng → tab Tính năng.
- Demo robots are simulated. "Đi chậm hơn" (guide) exists only on simulated robots, not on Valetudo.
- Billing walkthrough: QR "Yêu cầu tính tiền" → station view "Tính tiền": check the total, "Chuẩn bị phiếu" → robot at the
  table shows the bill QR → guest "Tôi đã chuyển khoản" → staff check the bank app, "Xác nhận đã thu tiền" → "Đóng lượt tính tiền".
  The guest's claim is not a bank confirmation; nothing in the app verifies money.

## Update the demo
Source of truth is `../trial`. After changing UI or logic there:

    cd ../trial && npm run web     # copies data/public, data/lib, data/site.demo.json -> web/demo (as demo/site.json)

`demo/transport.js`, `demo/index.html`, `demo/showcase.html` are web-only and are not overwritten. `transport.js` loads
`lib/` in dependency order (route, feature-policy → site → billing → orchestrator; simulator). Saved demo state carries the
fingerprint of `demo/site.json`: a changed seed resets every visitor's demo data once.

## Run locally
    python3 -m http.server 4173    # http://localhost:4173 (Web Locks need localhost or https)

## Deploy
    npm i -g vercel
    vercel          # preview
    vercel --prod   # production
