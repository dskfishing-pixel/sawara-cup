/* =========================================================
 * サワラ焼肉CUP — 潮汐データ中継（Vercel Serverless Function）
 * データ: tide736.net（日本沿岸736港の潮汐表・参考値）
 *
 *   /api/tide?ports=34,35,38         周辺県の港一覧（名前・緯度経度）
 *   /api/tide?pc=35&hc=12&date=2026-10-10&rg=month   潮汐（最大30日分）
 *
 * ブラウザから直接取得できない場合に備えて、ここで取得・整形し、
 * Vercelのキャッシュに保存して tide736.net へのアクセスを最小限にする。
 * ========================================================= */
'use strict';

const BASES = [
  'https://api.tide736.net/get_tide.php',
  'https://tide736.net/api/get_tide.php'
];

async function callApi(params) {
  const qs = new URLSearchParams(params).toString();
  let lastErr = 'tide736 から取得できませんでした';
  for (const base of BASES) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(base + '?' + qs, { headers: { 'User-Agent': 'sawara-cup/1.0 (tournament app)' }, signal: ctl.signal });
      clearTimeout(timer);
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch (e) { lastErr = 'JSONではない応答'; continue; }
      if (j && Number(j.status) === 1 && j.tide) return j;
      lastErr = (j && j.message) || lastErr;
    } catch (e) { lastErr = e.name === 'AbortError' ? 'タイムアウト' : String(e.message || e); }
  }
  throw new Error(lastErr);
}

/** 緯度経度：数値 / "34.17" / "34°10'30\"" / "34-10-30" のどれでも読む */
function coord(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const m = s.match(/(-?\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)?(?:\D+(\d+(?:\.\d+)?))?/);
  if (!m) return NaN;
  const d = parseFloat(m[1]), mi = parseFloat(m[2] || 0), se = parseFloat(m[3] || 0);
  return (d < 0 ? -1 : 1) * (Math.abs(d) + mi / 60 + se / 3600);
}

function normPort(p) {
  if (!p) return null;
  const o = {
    pc: Number(p.prefecture_code), hc: Number(p.harbor_code),
    name: String(p.harbor_namej || p.harbor_name || '').trim(),
    lat: coord(p.latitude), lon: coord(p.longitude)
  };
  return (o.pc > 0 && o.hc > 0 && isFinite(o.lat) && isFinite(o.lon) && o.name) ? o : null;
}

function asList(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === 'object') {
    // 1件だけのオブジェクト or {key: port} 形式
    if (x.harbor_code != null) return [x];
    return Object.values(x);
  }
  return [];
}

function todayParts() {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // JST
  return { yr: d.getUTCFullYear(), mn: d.getUTCMonth() + 1, dy: d.getUTCDate() };
}

/** 1つの県の港一覧。まず応答の link（近隣港情報）を使い、足りなければ港コードを順に確認 */
async function portsOfPref(pc) {
  const t = todayParts();
  const found = new Map();
  const add = (p) => { const n = normPort(p); if (n && n.pc === pc) found.set(n.hc, n); };
  let first = null;
  for (let hc = 1; hc <= 5 && !first; hc++) {
    try { first = await callApi({ pc, hc, ...t, rg: 'day' }); } catch (e) { /* 次の港コード */ }
  }
  if (!first) throw new Error('県コード ' + pc + ' の港情報が取得できません');
  add(first.tide.port);
  asList(first.tide.link).forEach(add);

  if (found.size < 3) {
    // link に港一覧が無い場合：港コードを 1 から順に確認（6件ずつ並列、連続6件なければ終了）
    let miss = 0;
    for (let start = 1; start <= 80 && miss < 6; start += 6) {
      const batch = [];
      for (let hc = start; hc < start + 6; hc++) {
        batch.push(callApi({ pc, hc, ...t, rg: 'day' }).then(j => { add(j.tide.port); return true; }).catch(() => false));
      }
      const res = await Promise.all(batch);
      res.forEach(ok => { miss = ok ? 0 : miss + 1; });
    }
  }
  return [...found.values()].sort((a, b) => a.hc - b.hc);
}

function hm2min(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
function events(list) {
  return asList(list).map(e => ({ time: String(e.time || '').slice(0, 5), cm: Math.round(Number(e.cm)) }))
    .filter(e => hm2min(e.time) !== null && isFinite(e.cm));
}

/** tide736 の chart を、日ごとの軽いデータに整える（グラフは15分間隔に間引く） */
function normChart(chart) {
  const out = {};
  for (const [date, d] of Object.entries(chart || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !d) continue;
    const series = [];
    let last = -999;
    asList(d.tide).forEach(p => {
      const m = hm2min(p.time), cm = Number(p.cm);
      if (m === null || !isFinite(cm)) return;
      if (m - last >= 15 || m === 1440) { series.push([m, Math.round(cm)]); last = m; }
    });
    out[date] = {
      title: (d.moon && d.moon.title) || '',
      age: d.moon && d.moon.age != null ? Number(d.moon.age) : null,
      sunrise: (d.sun && d.sun.rise) || '',
      sunset: (d.sun && d.sun.set) || '',
      highs: events(d.flood),
      lows: events(d.edd),
      series
    };
  }
  return out;
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (q.ports) {
      const pcs = String(q.ports).split(',').map(Number).filter(n => n >= 1 && n <= 48).slice(0, 6);
      if (!pcs.length) throw new Error('ports の指定が不正です');
      const lists = await Promise.all(pcs.map(pc => portsOfPref(pc).catch(() => [])));
      const ports = lists.flat();
      if (!ports.length) throw new Error('港一覧が取得できませんでした');
      res.setHeader('Cache-Control', 'public, s-maxage=2592000, stale-while-revalidate=2592000');
      res.status(200).send(JSON.stringify({ ok: true, ports }));
      return;
    }
    const pc = Number(q.pc), hc = Number(q.hc);
    const m = String(q.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!(pc > 0 && hc > 0 && m)) throw new Error('pc, hc, date（YYYY-MM-DD）を指定してください');
    const rg = ['day', 'week', 'month'].includes(q.rg) ? q.rg : 'day';
    const j = await callApi({ pc, hc, yr: +m[1], mn: +m[2], dy: +m[3], rg });
    const body = { ok: true, port: normPort(j.tide.port), days: normChart(j.tide.chart), source: 'tide736.net' };
    res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=2592000');
    res.status(200).send(JSON.stringify(body));
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).send(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
};
module.exports._test = { coord, normPort, normChart, asList, portsOfPref, callApi };
