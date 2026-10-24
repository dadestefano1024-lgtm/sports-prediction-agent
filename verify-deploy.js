'use strict';
/**
 * Confirm the push actually reached the live service, by looking for the new
 * code rather than for a 200.
 *
 * A deploy that is still building serves the OLD build happily, so "the site
 * responds" proves nothing -- the same trap as judging a service worker by a
 * page load. Three markers, client and server:
 *   - index.html carries the new badge and per-game picker classes
 *   - the old flat-list class is GONE (so it is not a half-deploy)
 *   - POST /api/pool/nfl returns tierCount, and a spread carries travelProb
 */
const https = require('https');
const HOST = 'sports-prediction-agent.onrender.com';

const get = (path) => new Promise((res, rej) => {
  https.get({ host: HOST, path, headers: { Accept: '*/*' } }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; });
    r.on('end', () => res({ status: r.statusCode, body: b }));
  }).on('error', rej).setTimeout(60000, function () { this.destroy(new Error('timeout')); });
});
const post = (path, payload) => new Promise((res, rej) => {
  const data = JSON.stringify(payload);
  const r = https.request({ host: HOST, path, method: 'POST', headers: {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
    Accept: 'application/json' } }, (s) => {
    let b = ''; s.on('data', (c) => { b += c; });
    s.on('end', () => { try { res({ status: s.statusCode, body: JSON.parse(b) }); }
                        catch (e) { res({ status: s.statusCode, body: b.slice(0, 200) }); } });
  });
  r.on('error', rej); r.setTimeout(180000, () => r.destroy(new Error('timeout')));
  r.write(data); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const deadline = Date.now() + 8 * 60 * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    let page;
    try { page = await get('/'); } catch (e) { page = { status: 'ERR ' + e.message, body: '' }; }
    const hasEdge = /edge-badge/.test(page.body);
    const hasPicker = /gp-b|gamePickerInner/.test(page.body);
    const oldGone = !/\.pl-opt\s*\{|toggleCardPick/.test(page.body);
    console.log(`[${attempt}] / ${page.status}  edge-badge=${hasEdge}  picker=${hasPicker}  old-list-gone=${oldGone}`);

    if (hasEdge && hasPicker && oldGone) {
      console.log('\nclient is live. checking the server...');
      const r = await post('/api/pool/nfl', { week: 7, count: 6 });
      const d = r.body || {};
      const tc = d.tierCount;
      const sp = (d.ranked || []).find((c) => c.market === 'spread' && c.travelProb);
      console.log('  POST /api/pool/nfl  ' + r.status);
      console.log('  tierCount: ' + (tc ? JSON.stringify(tc) : 'MISSING'));
      console.log('  a spread with travelProb: ' + (sp
        ? sp.pick + '  tier=' + sp.poolTier + '  p=' + (sp.travelProb.p * 100).toFixed(1) +
          '%  move=' + sp.movePts + '  absorbed=' + sp.absorbed
        : 'MISSING'));
      const opt = (d.options || []).find((o) => o.poolTier);
      console.log('  options carry a tier: ' + (opt ? 'yes (' + opt.pick + ' = ' + opt.poolTier + ')' : 'MISSING'));
      console.log('  card headline: 1 week in ' + ((d.card && d.card.oneIn) || '?'));
      console.log('\n  the six as served:');
      for (const [i, b] of (d.best || []).entries()) {
        console.log('    ' + (i + 1) + '. ' + String(b.pick).padEnd(24) +
          (b.poolTier || 'none').padEnd(6) +
          (b.travelProb ? (b.travelProb.p * 100).toFixed(1) + '%' : '  --  '));
      }
      const ok = tc && sp && opt;
      console.log('\n' + (ok ? 'DEPLOYED and serving the new fields.'
                             : 'client deployed but the SERVER fields are missing -- check Render logs.'));
      process.exit(ok ? 0 : 1);
    }
    await wait(20000);
  }
  console.log('\nstill not live after 8 minutes -- check the Render dashboard for a failed build.');
  process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
