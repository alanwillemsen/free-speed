// Protocol test for relay/src/index.js against a local `wrangler dev` on 8787.
const { createRequire } = require('module');
const req = createRequire('/home/notwork/git/free-speed/package.json');
const WebSocket = req('ws');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const WS = BASE.replace(/^http/, 'ws');
const room = 'freespeed-test' + Math.floor(Math.random() * 1e6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = '') { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!cond) failures++; }
function open(role, from) {
  const ws = new WebSocket(`${WS}/room/${room}?role=${role}&from=${from}`);
  ws.frames = []; ws.closeInfo = null;
  ws.on('message', (d) => ws.frames.push(JSON.parse(d.toString())));
  ws.on('close', (code, reason) => { ws.closeInfo = { code, reason: reason.toString() }; });
  return new Promise((res, rej) => { ws.once('open', () => res(ws)); ws.once('error', rej); });
}
const last = (ws, pred) => [...ws.frames].reverse().find(pred);
async function presence() { const r = await fetch(`${BASE}/room/${room}/presence`); return r.json(); }
(async () => {
  const health = await (await fetch(BASE + '/')).text();
  check('health', /relay ok/.test(health), health.trim());
  check('presence empty room', (await presence()).online === false);

  const host = await open('host', room);
  await sleep(200);
  check('host hello, no peer', last(host, (f) => f._relay === 'hello')?.peer === null);
  host.send(JSON.stringify({ _relay: 'presence', name: 'Alan', busy: true }));
  await sleep(200);
  const p = await presence();
  check('presence shows host', p.online === true && p.name === 'Alan' && p.busy === true, JSON.stringify(p));

  const guest = await open('guest', 'freespeed-coach1');
  await sleep(200);
  const gh = last(guest, (f) => f._relay === 'hello');
  check('guest hello sees host', gh?.peer?.id === room && gh?.peer?.name === 'Alan', JSON.stringify(gh));
  const hp = last(host, (f) => f._relay === 'peer');
  check('host told guest online', hp?.online === true && hp?.id === 'freespeed-coach1', JSON.stringify(hp));

  // data both ways, verbatim
  host.send(JSON.stringify({ type: 'batch', motion: [{ t: 1, ax: 0.5 }] }));
  guest.send(JSON.stringify({ type: 'hello', name: 'Coach' }));
  await sleep(200);
  check('host->guest data', !!last(guest, (f) => f.type === 'batch' && f.motion?.[0]?.ax === 0.5));
  check('guest->host data', !!last(host, (f) => f.type === 'hello' && f.name === 'Coach'));

  // ping auto-response
  guest.send('{"_relay":"ping"}');
  await sleep(200);
  check('ping -> pong', !!last(guest, (f) => f._relay === 'pong'));
  check('ping not forwarded to host', !host.frames.some((f) => f._relay === 'ping'));

  // newest guest wins; host sees no offline gap
  const hostPeerFramesBefore = host.frames.filter((f) => f._relay === 'peer').length;
  const guest2 = await open('guest', 'freespeed-coach2');
  await sleep(300);
  check('old guest closed 4001', guest.closeInfo?.code === 4001, JSON.stringify(guest.closeInfo));
  const peerFrames = host.frames.filter((f) => f._relay === 'peer').slice(hostPeerFramesBefore);
  check('host saw only online for guest2', peerFrames.length === 1 && peerFrames[0].online === true && peerFrames[0].id === 'freespeed-coach2', JSON.stringify(peerFrames));
  guest2.send(JSON.stringify({ type: 'ping', t: 'x' }));
  await sleep(200);
  check('guest2->host data', !!last(host, (f) => f.type === 'ping' && f.t === 'x'));

  // guest leaves -> host told offline
  guest2.close();
  await sleep(300);
  check('host told guest offline', last(host, (f) => f._relay === 'peer')?.online === false);

  // host kick
  const guest3 = await open('guest', 'freespeed-coach3');
  await sleep(200);
  host.send('{"_relay":"kick"}');
  await sleep(300);
  check('kicked guest told host offline', last(guest3, (f) => f._relay === 'peer' && f.online === false && f.kicked === true), JSON.stringify(guest3.frames));

  // host leaves -> waiting guest told offline, presence false
  const guest4 = await open('guest', 'freespeed-coach4');
  await sleep(200);
  host.close();
  await sleep(300);
  check('guest told host offline', last(guest4, (f) => f._relay === 'peer')?.online === false);
  check('presence offline after host left', (await presence()).online === false);
  // host returns -> waiting guest told online
  const host2 = await open('host', room);
  await sleep(300);
  check('guest told host back online', last(guest4, (f) => f._relay === 'peer')?.online === true);
  check('host2 hello sees waiting guest', last(host2, (f) => f._relay === 'hello')?.peer?.id === 'freespeed-coach4');

  // bad requests
  const bad = await fetch(`${BASE}/room/Not%20Valid!/presence`);
  check('bad room id -> 400', bad.status === 400, String(bad.status));
  const noRole = await new Promise((res) => { const w = new WebSocket(`${WS}/room/${room}`); w.on('error', (e) => res(e.message)); w.on('open', () => res('opened?!')); });
  check('missing role rejected', /400/.test(noRole), noRole);
  const cors = await fetch(`${BASE}/room/${room}/presence`, { method: 'OPTIONS' });
  check('CORS preflight', cors.status === 204 && cors.headers.get('access-control-allow-origin') === '*');
  const pr = await fetch(`${BASE}/relay/room/${room}/presence`);
  check('/relay prefix tolerated', pr.status === 200 && (await pr.json()).online === true);

  host2.close(); guest4.close();
  await sleep(100);
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(2); });
