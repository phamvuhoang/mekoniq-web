// Transport for the static demo — no server. Same API as the Node-RED WebSocket transport.
// One tab (elected with Web Locks) runs the real orchestrator + simulator from lib/; every page
// of this browser (tabs and iframes) talks to it over BroadcastChannel. State lives in localStorage,
// so closing the engine tab hands over to another tab without losing missions.
// ponytail: browsers throttle timers in background tabs, so robots slow down if the engine tab is
// hidden for long; the real deployment runs the engine on Node-RED, not in a page.
const Transport = (() => {
  const KEY = 'mekoniq.demo.v1';
  const ch = new BroadcastChannel('mekoniq-demo');
  const me = Math.random().toString(36).slice(2);
  let onData = () => {}, onStatus = () => {}, input = null;

  // Loads a CommonJS file from lib/ (shared verbatim with Node-RED).
  async function load(url) {
    const module = { exports: {} };
    new Function('module', 'exports', await (await fetch(url)).text())(module, module.exports);
    return module.exports;
  }

  async function lead() {
    const [O, S, site] = await Promise.all([load('lib/orchestrator.js'), load('lib/simulator.js'), fetch('site.json').then(r => r.json())]);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    const st = (saved && saved.st) || O.init(site, Date.now());
    const sim = (saved && saved.sim) || S.init(site);
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ st, sim })); } catch (e) {} };

    const deliver = ui => {
      for (const u of ui) {
        if (!u.session || u.session === me) onData(u.payload);
        ch.postMessage({ payload: u.payload, to: u.session });
      }
    };
    const run = inp => {
      const r = O.handle(st, site, inp, Date.now());
      deliver(r.ui);
      for (const cmd of r.cmds) for (const e of S.handle(sim, site, cmd, Date.now())) run({ source: 'adapter', data: e });
    };
    input = (text, session) => {
      let data;
      try { data = JSON.parse(text); } catch (e) { return; }
      run({ source: 'ui', data, session });
    };
    setInterval(() => { for (const e of S.handle(sim, site, { cmd: 'tick' }, Date.now())) run({ source: 'adapter', data: e }); }, 500);
    setInterval(save, 2000);
    addEventListener('pagehide', save);
    ch.postMessage({ ready: true });
    onStatus(true);
  }

  ch.onmessage = e => {
    const m = e.data;
    if (m.cmd !== undefined) { if (input) input(m.cmd, m.from); }
    else if (m.ping) { if (input) ch.postMessage({ ready: true }); }
    else if (m.ready) { if (!input) onStatus(true); }
    else if (m.payload && (!m.to || m.to === me)) onData(m.payload);
  };

  return {
    connect(data, status) {
      onData = data; onStatus = status;
      const start = () => lead().then(() => new Promise(() => {}));   // hold the lock while this page lives
      if (navigator.locks) navigator.locks.request('mekoniq-demo-engine', start);
      else start();   // no Web Locks (very old browser): every page runs its own engine
      ch.postMessage({ ping: true });
    },
    send(text) {
      if (input) input(text, me);
      else ch.postMessage({ cmd: text, from: me });
    }
  };
})();
