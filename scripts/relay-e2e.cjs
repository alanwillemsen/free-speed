// Two-browser end-to-end test of the coach <-> rower link over the relay.
//
// Needs the dev server running (npm run dev — it spawns the local relay on
// 8787) and two headless Chromes with separate profiles (separate localStorage
// → distinct stable peer ids):
//
//   google-chrome --headless=new --remote-debugging-port=9333 --no-sandbox \
//     --ignore-certificate-errors --user-data-dir=/tmp/chrome-rower about:blank &
//   google-chrome --headless=new --remote-debugging-port=9334 --no-sandbox \
//     --ignore-certificate-errors --user-data-dir=/tmp/chrome-coach about:blank &
//   node scripts/relay-e2e.cjs
//
// Note: via the Vite proxy + wrangler dev, a page-initiated WebSocket close can
// take ~10 s to complete (Chrome's closing-handshake timeout), so the
// "coach socket loss" step reads slower here than against the real relay.
const { createRequire } = require('module');
const req = createRequire('/home/notwork/git/free-speed/package.json');
const WebSocket = req('ws');
const APP = process.env.APP_URL || 'https://localhost:5173/'; // e.g. a `vite preview` of a relay-enabled build
const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:8787'; // presence checks; point at the deployed relay to test production
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = undefined; }
    if (v) { console.log(`  ok   ${label} (${Date.now() - t0} ms)`); return v; }
    if (Date.now() - t0 > ms) { console.log(`  TIMEOUT ${label} after ${ms} ms`); failures++; return null; }
    await sleep(250);
  }
}
async function presence(id) { return (await fetch(`${RELAY}/room/${id}/presence`)).json(); }

const INSTRUMENT = `(() => {
  window.__rx = []; window.__sockets = [];
  const OrigWS = window.WebSocket;
  const d = Object.getOwnPropertyDescriptor(OrigWS.prototype, 'onmessage');
  Object.defineProperty(OrigWS.prototype, 'onmessage', { configurable: true,
    get() { return d.get.call(this); },
    set(fn) { d.set.call(this, (ev) => { try { const f = JSON.parse(ev.data); window.__rx.push({ t: Date.now(), k: f.type || ('_' + f._relay), online: f.online }); } catch {} return fn && fn.call(this, ev); }); } });
  const Wrapped = function (url, protocols) { const s = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols); if (String(url).includes('/room/')) window.__sockets.push(s); return s; };
  Wrapped.prototype = OrigWS.prototype; Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Wrapped;
  window.confirm = () => true;
  try { delete DeviceMotionEvent.requestPermission; delete DeviceOrientationEvent.requestPermission; } catch {}
  let wid = 0; const watchers = new Map();
  navigator.geolocation.watchPosition = (ok) => { const id = ++wid; let i = 0; const t = setInterval(() => { i++; ok({ coords: { latitude: 43.3690 + i * 0.00003, longitude: -80.3215 + i * 0.00002, accuracy: 5, speed: 4.2, heading: 20, altitude: null, altitudeAccuracy: null }, timestamp: Date.now() }); }, 1000); watchers.set(id, t); return id; };
  navigator.geolocation.clearWatch = (id) => clearInterval(watchers.get(id));
  navigator.geolocation.getCurrentPosition = (ok) => ok({ coords: { latitude: 43.3690, longitude: -80.3215, accuracy: 5, speed: 0, heading: null, altitude: null }, timestamp: Date.now() });
  window.__row = (ms) => { const start = performance.now(); const period = 60000 / 27; const iv = setInterval(() => { const el = performance.now() - start; if (el > ms) { clearInterval(iv); return; } const phase = (el % period) / period; const drive = phase < 0.35 ? Math.sin(phase / 0.35 * Math.PI) : 0; const ax = 3 * drive - 0.66;
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: ax, y: 0, z: 0 }, accelerationIncludingGravity: { x: ax, y: 0, z: 9.81 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16.67 }));
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 0, gamma: 0, absolute: false })); }, 1000 / 60); return 'rowing'; };
})();`;

async function browser(port) {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(500); } }
  if (!browser.cleaned?.[port]) {
    browser.cleaned = { ...(browser.cleaned || {}), [port]: true };
    for (const t of await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) {
      if (t.url.includes('5173')) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
    }
  }
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression, awaitPromise = true) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  return { send, evalJs, close: () => fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`), shot: async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); require('fs').writeFileSync(file, Buffer.from(r.data, 'base64')); } };
}
const rxCount = (b, k) => b.evalJs(`window.__rx.filter(f => f.k === ${JSON.stringify(k)}).length`);

(async () => {
  // ---- rower ----
  const rower = await browser(9333);
  await rower.send('Page.navigate', { url: APP + '#live' });
  await waitFor(() => rower.evalJs(`!!document.querySelector('.live-link, .bigscreen-embedded, .live-recover')`), 20000, 'rower page rendered');
  await rower.evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discard'); if (b) { b.click(); return 'discarded'; } return 'no recovery offer'; })()`).then((r) => console.log('  rower recovery:', r));
  const identity = JSON.parse(await rower.evalJs(`localStorage.getItem('freespeed-identity')`));
  const code = identity.id.replace('freespeed-', '');
  console.log('  rower id', identity.id);
  await waitFor(async () => (await presence(identity.id)).online, 15000, 'relay shows rower online');
  const rowerState = await rower.evalJs(`document.body.innerText.includes('Hold to Stop') ? 'capturing' : (document.querySelector('.live-link')?.innerText || '')`);
  check('rower page in a sane state', /capturing|waiting for a coach|Connected/.test(rowerState), rowerState.slice(0, 80).replace(/\n/g, ' | '));

  // ---- coach joins via the QR/join URL ----
  const coach = await browser(9334);
  await coach.send('Page.navigate', { url: `${APP}#live?join=${code}&as=coach` });
  // Connected shows as the pairing panel's indicator, or — if the rower is already
  // capturing — the coach jumps straight into the watching readout.
  await waitFor(() => coach.evalJs(`!!document.querySelector('.live-link-connected, .bigscreen-embedded')`), 25000, 'coach UI shows connected / watching');
  const coachText = await coach.evalJs(`document.querySelector('.live-link-connected')?.innerText || (document.querySelector('.bigscreen-embedded') ? 'watching readout' : '')`);
  check('coach connected to rower', /Connected to rower|watching readout/i.test(coachText), coachText.replace(/\n/g, ' | '));
  await waitFor(() => coach.evalJs(`window.__rx.some(f => f.k === 'hello')`), 8000, 'coach received rower hello');
  await waitFor(() => rower.evalJs(`window.__rx.some(f => f.k === 'hello')`), 8000, 'rower received coach hello');
  const p1 = await presence(identity.id);
  check('relay: 1 guest in rower room', p1.online && p1.guests === 1, JSON.stringify(p1));
  check('rower exactly 1 open socket (StrictMode left no duplicates)', (await rower.evalJs(`window.__sockets.filter(s => s.readyState === 1).length`)) === 1);
  check('coach exactly 2 open sockets (own room + dial)', (await coach.evalJs(`window.__sockets.filter(s => s.readyState === 1).length`)) === 2);
  await coach.shot('e2e-coach-connected.png');

  // ---- rower captures; coach should stream ----
  let capturing = await rower.evalJs(`document.body.innerText.includes('Hold to Stop')`);
  if (!capturing) {
    await rower.evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => /Start Capture/.test(b.textContent)); if (b) b.click(); return !!b; })()`);
    capturing = await waitFor(() => rower.evalJs(`document.body.innerText.includes('Hold to Stop')`), 8000, 'rower capture started');
  } else console.log('  rower auto-started capture');
  await rower.evalJs(`window.__row(45000)`, false);
  await sleep(12000);
  const batches1 = await rxCount(coach, 'batch');
  check('coach receiving sample batches', batches1 > 50, `${batches1} batches in 12 s`);
  const coachView = await coach.evalJs(`({ watching: !!document.querySelector('.bigscreen-embedded'), spm: document.querySelector('.bigscreen-spm')?.innerText || null, text: document.body.innerText.slice(0, 160) })`);
  console.log('  coach view', JSON.stringify(coachView));
  await coach.shot('e2e-coach-streaming.png');

  // ---- resilience 1: the coach's sockets die (radio drop) ----
  const hellos1 = await rxCount(coach, 'hello');
  await coach.evalJs(`window.__sockets.filter(s => s.readyState === 1).forEach(s => s.close()); 'closed'`);
  await waitFor(async () => (await rxCount(coach, 'hello')) > hellos1, 15000, 'coach re-attached after socket loss (fresh rower hello)');
  const b2 = await rxCount(coach, 'batch'); await sleep(4000); const b3 = await rxCount(coach, 'batch');
  check('stream resumes after coach reconnect', b3 > b2 + 10, `${b3 - b2} batches in 4 s`);
  check('coach back to 2 open sockets', (await coach.evalJs(`window.__sockets.filter(s => s.readyState === 1).length`)) === 2);

  // ---- resilience 2: rower phone reloads mid-session ----
  const hellos2 = await rxCount(coach, 'hello');
  const offl = await coach.evalJs(`window.__rx.filter(f => f.k === '_peer' && f.online === false).length`);
  await rower.send('Page.reload');
  await waitFor(() => coach.evalJs(`window.__rx.filter(f => f.k === '_peer' && f.online === false).length > ${offl}`), 15000, 'coach told rower went offline');
  await waitFor(async () => (await rxCount(coach, 'hello')) > hellos2, 25000, 'coach re-attached after rower reload');
  await waitFor(() => rower.evalJs(`!!document.querySelector('.live-link, .live-recover')`), 15000, 'rower page back');
  await rower.evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discard'); if (b) { b.click(); return 'discarded'; } return 'no recovery offer'; })()`).then((r) => console.log('  rower recovery after reload:', r));
  await waitFor(() => coach.evalJs(`!!document.querySelector('.live-link-connected, .bigscreen-embedded')`), 15000, 'coach UI connected again');

  // ---- coach Disconnect (from the #link setup panel), then reconnect from the roster ----
  await coach.evalJs(`location.hash = '#link'; 'ok'`);
  await waitFor(() => coach.evalJs(`!!document.querySelector('.live-link-disconnect')`), 10000, 'coach link-setup panel shows Disconnect');
  const clickedDisc = await coach.evalJs(`(() => { const b = document.querySelector('.live-link-disconnect'); if (b) { b.click(); return true; } return false; })()`);
  check('coach has a Disconnect button', clickedDisc);
  await waitFor(async () => (await presence(identity.id)).guests === 0, 10000, 'relay: coach left rower room');
  await waitFor(() => coach.evalJs(`!!document.querySelector('.live-roster-row.online button')`), 15000, 'roster shows rower online');
  await coach.shot('e2e-coach-roster.png');
  check('roster Connect clicked', await coach.evalJs(`(() => { const b = document.querySelector('.live-roster-row.online button'); if (b) { b.click(); return true; } return false; })()`));
  await waitFor(() => coach.evalJs(`!!document.querySelector('.live-link-connected')`), 15000, 'coach reconnected from roster');
  const p2 = await presence(identity.id);
  check('relay: 1 guest again', p2.guests === 1, JSON.stringify(p2));

  // ---- same phone, second tab of the app: must not fight over the room ----
  const hellos3 = await rxCount(coach, 'hello');
  const tab2 = await browser(9333);
  await tab2.send('Page.navigate', { url: APP + '#live' });
  await waitFor(() => tab2.evalJs(`window.__sockets.some(s => s.readyState === 1 && s.url.includes('role=host'))`), 15000, 'second rower tab hosts the room');
  await waitFor(async () => (await rxCount(coach, 'hello')) > hellos3, 10000, 'coach got hello from the new tab (still attached)');
  await sleep(4000);
  const tab1Hosts = await rower.evalJs(`window.__sockets.filter(s => s.readyState === 1 && s.url.includes('role=host')).length`);
  check('displaced first tab yields (no host socket)', tab1Hosts === 0, `${tab1Hosts} open host sockets in tab 1`);
  check('coach UI still connected during the handover', await coach.evalJs(`!!document.querySelector('.live-link-connected')`));
  const p3 = await presence(identity.id);
  check('relay: room still has host + 1 guest', p3.online && p3.guests === 1, JSON.stringify(p3));
  await tab2.close();
  await waitFor(() => rower.evalJs(`window.__sockets.filter(s => s.readyState === 1 && s.url.includes('role=host')).length === 1`), 20000, 'first tab re-claims the room once it is free');
  await waitFor(async () => (await rxCount(coach, 'hello')) > hellos3 + 1, 15000, 'coach re-attached to the first tab');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('e2e crashed:', e); process.exit(2); });
