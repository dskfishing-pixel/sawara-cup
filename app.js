/* =========================================================
 * サワラ焼肉CUP — 画面
 * ========================================================= */
(function () {
  'use strict';
  var S = window.Store, C = window.Calc;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var LS_UI = 'scup:ui:v1';

  var ui = Object.assign({
    tab: 'rank',
    date: null,          // 表示中の大会日
    scope: 'day',        // ランキング: day | all
    tripId: null,        // 入力中の便（端末ごとに記憶）
    logBoat: 'all',
    showDeleted: false,
    tideMode: 'auto',    // auto（GPSで最寄り港）| manual（港を手動選択）
    tidePort: null       // 手動選択の港 'pc-hc'
  }, readUI());
  if (ui.tab === 'admin') ui.tab = 'rank';
  ui.selMode = false; ui.sel = {};          // 複数選択は起動時に必ず解除

  function readUI() { try { return JSON.parse(localStorage.getItem(LS_UI)) || {}; } catch (e) { return {}; } }
  function saveUI() { try { localStorage.setItem(LS_UI, JSON.stringify(ui)); } catch (e) {} }

  /* ---------- 小物 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function md(date) { if (!date) return ''; var p = date.split('-'); return (+p[1]) + '/' + (+p[2]); }
  function wd(date) { return '日月火水木金土'[new Date(date + 'T00:00:00').getDay()]; }
  function hm(iso) { var d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function t5(t) { return t ? String(t).slice(0, 5) : ''; }
  function boatName(id) { var b = S.find('boats', id); return b ? b.name : '（削除された船）'; }
  function isAdmin() { return S.role === 'admin'; }
  function cats() { return S.pointsConfig().categories; }
  function ptOf(label) {
    var c = cats().find(function (x) { return x.label === label; });
    return c ? Number(c.points) : 0;
  }
  function pending(id) { return S.outbox.some(function (o) { return o.row && o.row.id === id; }); }
  function vibrate() { try { navigator.vibrate && navigator.vibrate(30); } catch (e) {} }
  function toLocalInput(iso) {
    var d = new Date(iso), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function ensureDate() {
    var days = S.days().map(function (d) { return d.event_date; });
    if (ui.date && days.indexOf(ui.date) >= 0) return;
    var today = S.localDate();
    if (days.indexOf(today) >= 0) ui.date = today;
    else ui.date = days.filter(function (d) { return d >= today; })[0] || days[days.length - 1] || null;
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove(); return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }
  function randCode(prefix, n) {
    var a = 'abcdefghjkmnpqrstuvwxyz23456789', b = new Uint8Array(n), out = '';
    crypto.getRandomValues(b); b.forEach(function (x) { out += a[x % a.length]; });
    return prefix + out;
  }
  function validCode(c) { return /^[A-Za-z0-9_-]{6,40}$/.test(c); }
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent); }
  function inLINE() { return / Line\//i.test(navigator.userAgent); }
  function standalone() { return navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches); }

  /* ---------- トースト ---------- */
  var toastTimer = null;
  function toast(msg, opts) {
    opts = opts || {};
    var el = $('#toast');
    clearTimeout(toastTimer);
    el.className = 'toast ' + (opts.kind || '');
    el.innerHTML = '<span class="msg">' + esc(msg) + '</span>' +
      (opts.actions || []).map(function (a, i) { return '<button type="button" data-i="' + i + '">' + esc(a.label) + '</button>'; }).join('');
    el.hidden = false;
    el.onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var a = opts.actions[+b.dataset.i]; el.hidden = true; a.fn();
    };
    toastTimer = setTimeout(function () { el.hidden = true; }, opts.ms || 2600);
  }

  /* ---------- 確認ダイアログ（iPhoneでも確実に出る自前版） ---------- */
  function ask(msg, okLabel, fn, danger) {
    var w = document.createElement('div');
    w.className = 'dialog-wrap';
    w.innerHTML = '<div class="dialog" role="alertdialog" aria-modal="true"><p>' + esc(msg) + '</p>' +
      '<div class="row"><button class="btn ghost grow" type="button" data-k="no">やめる</button>' +
      '<button class="btn ' + (danger ? 'danger' : 'primary') + ' grow" type="button" data-k="ok">' + esc(okLabel || 'OK') + '</button></div></div>';
    document.body.appendChild(w);
    w.onclick = function (e) {
      var b = e.target.closest('button');
      if (e.target === w || (b && b.dataset.k === 'no')) { w.remove(); return; }
      if (b && b.dataset.k === 'ok') { w.remove(); fn(); }
    };
  }

  /* ---------- ボトムシート ---------- */
  var sheetOpen = false;
  function openSheet(html, bind) {
    var w = $('#sheet');
    w.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + html + '</div>';
    w.hidden = false; sheetOpen = true;
    w.onclick = function (e) { if (e.target === w) closeSheet(); };
    bind && bind(w.firstChild);
  }
  function closeSheet() { var w = $('#sheet'); w.hidden = true; w.innerHTML = ''; sheetOpen = false; render(); }

  /* =========================================================
   * 描画
   * ========================================================= */
  function render() {
    ['#tabbar', '#syncBtn', '#adminBtn'].forEach(function (id) { $(id).hidden = false; });
    ensureDate();
    renderSync();
    renderDatebar();
    document.querySelectorAll('#tabbar button').forEach(function (b) {
      if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    var main = $('#main');
    var html = ({ rank: viewRank, input: viewInput, log: viewLog, trips: viewTrips, sum: viewSum, admin: viewAdmin }[ui.tab] || viewRank)();
    main.innerHTML = installHint() + html;
    if (window.Tide) {                                  // GPSはランキング画面を開いている間だけ
      if (ui.tab === 'rank' && ui.tideMode !== 'manual') Tide.startWatch(); else Tide.stopWatch();
    }
    saveUI();
  }

  function renderSync() {
    var b = $('#syncBtn'), st = S.status, n = S.outbox.length;
    if (S.mode === 'local') { b.className = 'sync'; b.innerHTML = '<span class="dot"></span>この端末に保存'; return; }
    if (!st.online) { b.className = 'sync bad'; b.innerHTML = '<span class="dot"></span>圏外' + (n ? '・未送信' + n : ''); return; }
    if (n) { b.className = 'sync warn'; b.innerHTML = '<span class="dot"></span>送信待ち' + n; return; }
    if (st.realtime !== 'live') { b.className = 'sync warn'; b.innerHTML = '<span class="dot"></span>再接続中'; return; }
    b.className = 'sync'; b.innerHTML = '<span class="dot"></span>リアルタイム';
  }

  function renderDatebar() {
    var bar = $('#datebar');
    // 管理画面と、便を選んだ後の釣果入力では日付バーを隠してボタンを大きく
    if (ui.tab === 'admin' || (ui.tab === 'input' && currentTrip())) { bar.hidden = true; return; }
    bar.hidden = false;
    var days = S.days();
    var html = days.map(function (d) {
      var on = ui.tab === 'rank' && ui.scope === 'all' ? false : d.event_date === ui.date;
      return '<button class="chip" type="button" data-date="' + d.event_date + '" aria-pressed="' + on + '">' +
        md(d.event_date) + '(' + wd(d.event_date) + ')' + (d.title ? ' ' + esc(d.title) : '') + '</button>';
    }).join('');
    if (ui.tab === 'rank' && days.length > 1) {
      html += '<button class="chip" type="button" data-scope="all" aria-pressed="' + (ui.scope === 'all') + '">全日程</button>';
    }
    if (!days.length) html = '<span class="muted small">大会日がありません。⚙︎ 管理から追加してください</span>';
    bar.innerHTML = html;
    var on = bar.querySelector('[aria-pressed="true"]');
    if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  /* ---------- ホーム画面追加の案内 ---------- */
  function installHint() {
    if (ui.tab !== 'rank') return '';
    if (inLINE()) {
      return '<div class="notice" style="margin-bottom:10px">LINEの中で開いています。右下の「…」→「ブラウザで開く」でSafariに切り替えてから、ホーム画面に追加してください。</div>';
    }
    if (S.mode !== 'cloud' || !isIOS() || standalone() || ui.hideA2HS) return '';
    return '<div class="notice row" style="margin-bottom:10px;align-items:flex-start"><span class="grow">📲 次回からアプリとして開けるように：画面下の共有ボタン <b>⬆︎</b> →「ホーム画面に追加」</span>' +
      '<button class="btn sm ghost" type="button" data-action="hide-a2hs" aria-label="閉じる">×</button></div>';
  }

  /* ---------- 🏆 ランキング ---------- */
  function boatRows(trips) {
    return S.boats().map(function (b) {
      return { boat: b, agg: C.aggregateGroup(trips.filter(function (t) { return t.boat_id === b.id; }), S.data.catch_logs) };
    });
  }

  function viewRank() {
    var all = ui.scope === 'all';
    if (!all && !ui.date) return emptyBox('大会日がまだありません。', '⚙︎ 管理を開く', 'go-admin');
    var trips = all ? S.trips() : S.trips(ui.date);
    var rk = C.rankBoats(boatRows(trips));
    var head;
    if (rk.status === 'winner') {
      head = '<div class="verdict"><div class="v-icon">🏆</div><div><div class="v-label">現在の勝者</div><div class="v-name">' +
        esc(rk.leaders[0].boat.name) + '</div></div></div>';
    } else if (rk.status === 'draw') {
      head = '<div class="verdict draw"><div class="v-icon">🤝</div><div><div class="v-label">同点</div><div class="v-name">DRAW</div></div></div>';
    } else {
      head = '<div class="verdict none"><div class="v-icon">🎣</div><div><div class="v-name" style="font-size:20px">まだ釣果がありません</div>' +
        '<div class="small muted">釣れたら 🎣 釣果入力 からワンタップで記録</div></div></div>';
    }
    var duel = rk.rows.length === 2;
    var boards = rk.rows.map(function (r) {
      var a = r.agg, lead = rk.status !== 'none' && r.rank === 1;
      var trs = a.tripRows.map(function (tr) {
        return '<div><span>' + esc(all ? md(tr.trip.event_date) + ' ' : '') + esc(tr.trip.trip) + '</span><span class="num">' +
          tr.count + '本 ' + C.fmtPoints(tr.points) + 'pt <b>' + C.fmtScore(tr.score) + '</b></span></div>';
      }).join('');
      return '<article class="board' + (lead ? ' lead' : '') + '">' +
        '<div class="b-head"><span class="b-medal">' + (rk.status === 'none' || r.rank == null ? '' : C.medal(r.rank, r.tied)) + '</span>' +
        '<span class="b-name">' + esc(r.boat.name) + '</span></div>' +
        (a.tripCount ? (
          '<div class="b-score-label">SCORE</div><div class="b-score" data-len="' + C.fmtScore(a.score).length + '">' + C.fmtScore(a.score) + '</div>' +
          '<div class="b-stats">' +
          stat('本数', a.count) + stat('総ポイント', C.fmtPoints(a.points)) + stat(a.tripCount > 1 ? '延べ人数' : '人数', a.people) +
          stat('実釣時間', C.fmtHours(a.hours)) + stat('人時', C.r2(a.personHours)) + stat('便数', a.tripCount) +
          '</div>' + (a.tripCount > 1 || all ? '<div class="b-trips">' + trs + '</div>' : '')
        ) : '<div class="b-none">' + (all ? '便がありません' : 'この日の便は未設定') + '</div>') +
        '</article>';
    }).join('');
    return head + '<div class="boards' + (duel ? ' duel' : '') + '">' + boards + '</div>' +
      '<p class="formula">SCORE ＝ 総ポイント ÷ 人時（人数×実釣時間）× 1000<br>' +
      (all ? '全日程の合計で計算' : md(ui.date) + ' の全便合計で計算') + '</p>' + tideCard();
  }

  /* ---------- 🌊 潮汐（ランキングの下） ---------- */
  function tideDate() { return (ui.scope === 'all' || !ui.date) ? S.localDate() : ui.date; }
  function upcomingDates() {
    var today = S.localDate(), lim = new Date(Date.now() + 30 * 86400000), limS = lim.getFullYear() + '-' + String(lim.getMonth() + 1).padStart(2, '0') + '-' + String(lim.getDate()).padStart(2, '0');
    var ds = S.days().map(function (d) { return d.event_date; }).filter(function (d) { return d >= today && d <= limS; });
    if (ds.indexOf(today) < 0) ds.unshift(today);
    return ds.sort();
  }

  function tideCard() {
    if (!window.Tide) return '';
    var T = window.Tide;
    T.loadPorts();
    var date = tideDate();
    var head = '<h2 class="sec" style="margin-top:22px">🌊 潮汐（参考値）</h2>';
    if (!T.ports) {
      return head + '<div class="panel small muted">' + (T.portsState === 'error'
        ? '潮汐データを取得できません。電波のある場所で開くと、周辺の港のデータがこの端末に保存されます。'
        : '潮汐データを読み込み中…') + '</div>';
    }
    var port = T.pick(ui.tideMode, ui.tidePort);
    if (!port) return '';
    T.ensure(port, date);
    T.prefetch(upcomingDates());
    var d = T.day(port, date);

    var where;
    if (ui.tideMode === 'manual') where = '手動で選択';
    else if (T.posState === 'ok' && T.pos) where = '📍 現在地から約' + (Math.round(T.distKm(T.pos, port) * 10) / 10) + 'km';
    else if (T.posState === 'waiting') where = '📍 現在地を確認中…';
    else if (T.posState === 'denied') where = '位置情報オフ：基本の港を表示';
    else where = '基本の港';

    var top = '<div class="tide-head"><button class="tide-port" type="button" data-action="tide-pick">' + esc(port.name) + ' <span aria-hidden="true">▾</span></button>' +
      '<span class="tide-where">' + esc(where) + '</span>' +
      (d && d.title ? '<span class="tide-title">' + esc(d.title) + '</span>' : '') + '</div>';

    if (!d) {
      return head + '<div class="panel tide">' + top + '<p class="small muted" style="margin:10px 0 0">' +
        (T.isLoading(port, date) ? md(date) + ' の潮汐を読み込み中…' : md(date) + ' の潮汐はまだこの端末に保存されていません。電波のある場所で開くと自動で保存されます。') + '</p></div>';
    }
    var ev = function (list) {
      return list.length ? list.map(function (e) { return '<span class="num">' + esc(e.time) + '</span> <b class="num">' + e.cm + '</b><small>cm</small>'; }).join('　') : '—';
    };
    return head + '<div class="panel tide">' + top +
      '<div class="small muted" style="margin-top:2px">' + md(date) + '(' + wd(date) + ')' + (d.sunrise ? '　日の出 ' + esc(d.sunrise) + '　日の入 ' + esc(d.sunset) : '') + '</div>' +
      tideSvg(d, date) +
      '<div class="tide-ev"><div><span class="tag hi">満潮</span>' + ev(d.highs) + '</div><div><span class="tag lo">干潮</span>' + ev(d.lows) + '</div></div>' +
      '<p class="tide-note">出典：tide736.net（潮汐調和定数からの推算値）。航海には海上保安庁の潮汐表を使用してください。</p></div>';
  }

  function tideSvg(d, date) {
    var W = 360, H = 150, L = 30, R = 16, Tp = 12, B = 22, pw = W - L - R, ph = H - Tp - B;
    var se = d.series || []; if (se.length < 2) return '';
    var cms = se.map(function (p) { return p[1]; });
    var mn = Math.min.apply(null, cms), mx = Math.max.apply(null, cms);
    var pad = Math.max(10, (mx - mn) * 0.12); mn -= pad; mx += pad;
    var x = function (m) { return L + m / 1440 * pw; }, y = function (cm) { return Tp + (1 - (cm - mn) / (mx - mn)) * ph; };
    var line = se.map(function (p, i) { return (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join(' ');
    var area = line + ' L' + x(se[se.length - 1][0]).toFixed(1) + ' ' + (Tp + ph) + ' L' + x(se[0][0]).toFixed(1) + ' ' + (Tp + ph) + ' Z';
    var out = '<svg class="tide-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="潮位グラフ">';
    // 便の時間帯（実釣時間）を薄く表示
    S.trips(date).forEach(function (t) {
      var s0 = C.toMinutes(t.start_time), e0 = C.toMinutes(t.end_time);
      if (s0 === null || e0 === null) return; if (e0 <= s0) e0 = 1440;
      out += '<rect x="' + x(s0).toFixed(1) + '" y="' + Tp + '" width="' + (x(e0) - x(s0)).toFixed(1) + '" height="' + ph + '" fill="var(--signal)" opacity="0.10"/>';
    });
    // 目盛り
    [0, 6, 12, 18, 24].forEach(function (h) {
      out += '<line x1="' + x(h * 60) + '" y1="' + Tp + '" x2="' + x(h * 60) + '" y2="' + (Tp + ph) + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + x(h * 60) + '" y="' + (H - 6) + '" font-size="10" text-anchor="middle" fill="var(--ink-2)">' + h + '時</text>';
    });
    var step = (mx - mn) > 250 ? 100 : 50;
    for (var v = Math.ceil(mn / step) * step; v <= mx; v += step) {
      out += '<text x="' + (L - 4) + '" y="' + (y(v) + 3) + '" font-size="9" text-anchor="end" fill="var(--ink-2)">' + v + '</text>';
    }
    out += '<path d="' + area + '" fill="var(--steel)" opacity="0.28"/><path d="' + line + '" fill="none" stroke="var(--sea)" stroke-width="2.4" stroke-linejoin="round"/>';
    // 満潮・干潮の点
    (d.highs || []).concat(d.lows || []).forEach(function (e) {
      var m = C.toMinutes(e.time); if (m === null) return;
      out += '<circle cx="' + x(m).toFixed(1) + '" cy="' + y(e.cm).toFixed(1) + '" r="3.4" fill="var(--surface)" stroke="var(--sea)" stroke-width="2"/>';
    });
    // 今の時刻と潮位
    if (date === S.localDate()) {
      var now = new Date(), nm = now.getHours() * 60 + now.getMinutes(), cur = null;
      for (var i = 1; i < se.length; i++) {
        if (se[i][0] >= nm) { var a = se[i - 1], b = se[i]; cur = a[1] + (b[1] - a[1]) * (nm - a[0]) / Math.max(1, b[0] - a[0]); break; }
      }
      out += '<line x1="' + x(nm).toFixed(1) + '" y1="' + Tp + '" x2="' + x(nm).toFixed(1) + '" y2="' + (Tp + ph) + '" stroke="var(--signal)" stroke-width="2"/>';
      if (cur !== null) {
        var lx = Math.min(Math.max(x(nm), L + 26), W - R - 26);
        out += '<circle cx="' + x(nm).toFixed(1) + '" cy="' + y(cur).toFixed(1) + '" r="4.5" fill="var(--signal)"/>' +
          '<rect x="' + (lx - 26) + '" y="0" width="52" height="15" rx="7" fill="var(--signal)"/>' +
          '<text x="' + lx + '" y="11" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">今 ' + Math.round(cur) + 'cm</text>';
      }
    }
    return out + '</svg>';
  }

  function openTidePicker() {
    var T = window.Tide; if (!T || !T.ports) return;
    var list = T.near(T.reference(), 40);
    var html = '<h3>潮汐を表示する港</h3>' +
      '<button class="btn ' + (ui.tideMode !== 'manual' ? 'dark' : 'ghost') + ' block" type="button" data-k="auto">📍 現在地の最寄り港に自動で切り替え</button>' +
      '<p class="small muted">' + (T.pos ? '現在地から近い順' : '基本の港（岩国）から近い順') + '</p>' +
      list.map(function (x) {
        var on = ui.tideMode === 'manual' && ui.tidePort === T.key(x.port);
        return '<button class="logitem" type="button" data-k="' + T.key(x.port) + '"' + (on ? ' style="border-color:var(--sea);box-shadow:0 0 0 2px var(--sea) inset"' : '') + '>' +
          '<span class="l-main"><div class="l-size">' + esc(x.port.name) + '</div></span><span class="small muted">約' + (Math.round(x.km * 10) / 10) + 'km</span></button>';
      }).join('') +
      '<div class="actions"><button class="btn ghost block" type="button" data-k="close">閉じる</button></div>';
    openSheet(html, function (root) {
      root.onclick = function (e) {
        var b = e.target.closest('[data-k]'); if (!b) return;
        var k = b.dataset.k;
        if (k === 'auto') { ui.tideMode = 'auto'; ui.tidePort = null; T.current = null; }
        else if (k !== 'close') { ui.tideMode = 'manual'; ui.tidePort = k; }
        closeSheet();
      };
    });
  }
  function stat(k, v) { return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
  function emptyBox(msg, btn, action, extra) {
    return '<div class="panel empty"><p>' + msg + '</p>' + (btn ? '<button class="btn primary" type="button" data-action="' + action + '"' + (extra || '') + '>' + btn + '</button>' : '') + '</div>';
  }

  /* ---------- 🎣 釣果入力 ---------- */
  function currentTrip() { return ui.tripId ? S.find('trips', ui.tripId) : null; }

  function viewInput() {
    var trip = currentTrip();
    if (!trip) return viewTripPicker();
    var agg = C.aggregateTrip(trip, S.data.catch_logs);
    var list = S.catchesOf(trip.id);
    var counts = {};
    list.forEach(function (c) { counts[c.size_category] = (counts[c.size_category] || 0) + 1; });
    var cs = cats(), n = cs.length;
    var today = S.localDate();
    var warn = trip.event_date !== today
      ? '<div class="notice" style="margin-top:10px">この便は ' + md(trip.event_date) + ' の便です（今日ではありません）</div>' : '';

    var btns = cs.map(function (c, i) {
      var w = n > 1 ? 50 + i * (50 / (n - 1)) : 100, k = counts[c.label] || 0;
      return '<button type="button" class="size-btn' + (i === n - 1 ? ' top' : '') + '" data-action="catch" data-label="' + esc(c.label) + '" style="--w:' + w + '%">' +
        '<span class="fill" aria-hidden="true"></span>' +
        '<span class="s-label">' + esc(c.label) + '</span>' +
        '<span class="s-pt">' + C.fmtPoints(c.points) + '<small>pt</small></span>' +
        '<span class="s-count' + (k ? '' : ' zero') + '" aria-label="' + k + '本">' + k + '</span>' +
        '</button>';
    }).join('');

    var recent = list.slice(0, 5).map(function (c) { return logItem(c); }).join('');
    return '<div class="tripbar"><div class="t-main"><div class="t-boat">' + esc(boatName(trip.boat_id)) + ' ' + esc(trip.trip) + '</div>' +
      '<div class="t-sub">' + md(trip.event_date) + '(' + wd(trip.event_date) + ') ' + t5(trip.start_time) + '–' + t5(trip.end_time) + ' ' + trip.people + '名</div></div>' +
      '<button class="btn sm" type="button" data-action="pick-trip">便を変更</button></div>' +
      warn +
      '<div class="tally"><div><div class="k">本数</div><div class="v">' + agg.count + '</div></div>' +
      '<div><div class="k">総ポイント</div><div class="v">' + C.fmtPoints(agg.points) + '</div></div>' +
      '<div><div class="k">SCORE</div><div class="v">' + C.fmtScore(agg.score) + '</div></div></div>' +
      '<div class="sizes">' + btns + '</div>' +
      '<p class="small muted" style="text-align:center;margin:8px 0 0">サイズを押すと即登録。間違えたら「取消」</p>' +
      (recent ? '<div class="recent"><h2 class="sec">この便の直近</h2>' + recent + '</div>' : '');
  }

  function viewTripPicker() {
    if (!ui.date) return emptyBox('大会日がまだありません。', '⚙︎ 管理を開く', 'go-admin');
    var trips = S.trips(ui.date);
    if (!trips.length) return emptyBox(md(ui.date) + ' の便がまだありません。<br>まず便を作成してください。', '＋ 便を追加', 'new-trip');
    return '<h2 class="sec">入力する便を選択（' + md(ui.date) + '）</h2><div class="trippick">' + trips.map(function (t) {
      var a = C.aggregateTrip(t, S.data.catch_logs);
      return '<button type="button" data-action="use-trip" data-id="' + t.id + '"><div class="tp-boat">' + esc(boatName(t.boat_id)) + ' ' + esc(t.trip) + '</div>' +
        '<div class="tp-sub">' + t5(t.start_time) + '–' + t5(t.end_time) + ' ' + t.people + '名 ' + a.count + '本 ' + C.fmtPoints(a.points) + 'pt</div></button>';
    }).join('') + '</div>';
  }

  var lastTap = 0;
  function registerCatch(label, btn) {
    var now = Date.now();
    if (now - lastTap < 700) return;              // 連打による二重登録防止
    lastTap = now;
    var trip = currentTrip(); if (!trip) return;
    var row = S.upsert('catch_logs', {
      id: S.uuid(),                                // UUID：再送しても同じ1件
      trip_id: trip.id,
      caught_at: new Date().toISOString(),
      event_date: trip.event_date,
      boat_id: trip.boat_id,
      trip: trip.trip,
      size_category: label,
      points: ptOf(label),
      memo: '',
      deleted_at: null
    });
    vibrate();
    var hit = document.querySelector('.size-btn[data-label="' + CSS.escape(label) + '"]');
    if (hit) { hit.classList.remove('hit'); void hit.offsetWidth; hit.classList.add('hit'); }
    toast('✅ ' + label + '  +' + C.fmtPoints(row.points) + 'pt', {
      kind: 'ok', ms: 6000,
      actions: [
        { label: '取消', fn: function () { softDelete(row.id, true); } },
        { label: 'メモ', fn: function () { editCatch(row.id); } }
      ]
    });
  }

  function softDelete(id, quiet) {
    var c = S.find('catch_logs', id); if (!c) return;
    S.upsert('catch_logs', Object.assign({}, c, { deleted_at: new Date().toISOString() }));
    toast(quiet ? '取り消しました' : '削除しました', {
      actions: [{ label: '元に戻す', fn: function () { restore(id); } }], ms: 5000
    });
  }
  function restore(id) {
    var c = S.find('catch_logs', id); if (!c) return;
    S.upsert('catch_logs', Object.assign({}, c, { deleted_at: null }));
    toast('復元しました', { kind: 'ok' });
  }

  /** sel を渡すと選択モード（タップで選択切替）、省略すると通常（タップで編集） */
  function logItem(c, sel) {
    var selecting = typeof sel === 'boolean';
    return '<button type="button" class="logitem' + (c.deleted_at ? ' deleted' : '') + (selecting && sel ? ' picked' : '') + '" data-action="' +
      (selecting ? 'sel-toggle' : 'edit-catch') + '" data-id="' + c.id + '"' + (selecting ? ' aria-pressed="' + sel + '"' : '') + '>' +
      (selecting ? '<span class="chk" aria-hidden="true">' + (sel ? '✓' : '') + '</span>' : '') +
      '<span class="l-time">' + hm(c.caught_at) + '</span>' +
      '<span class="l-main"><div class="l-size">' + esc(c.size_category) + '</div>' +
      '<div class="l-sub">' + esc(boatName(c.boat_id)) + ' ' + esc(c.trip) + (c.memo ? '　📝' + esc(c.memo) : '') +
      (pending(c.id) ? ' <span class="pending-mark">送信待ち</span>' : '') + '</div></span>' +
      '<span class="l-pt">' + C.fmtPoints(c.points) + '</span></button>';
  }

  /* ---------- 📋 CatchLog ---------- */
  function logLists() {
    var tripIds = {};
    S.trips(ui.date).forEach(function (t) { tripIds[t.id] = true; });
    var all = S.data.catch_logs.filter(function (c) {
      return tripIds[c.trip_id] && (ui.logBoat === 'all' || c.boat_id === ui.logBoat);
    }).sort(function (a, b) { return a.caught_at < b.caught_at ? 1 : -1; });
    return { live: all.filter(function (c) { return !c.deleted_at; }), dead: all.filter(function (c) { return c.deleted_at; }) };
  }
  function selectedIds() {
    return Object.keys(ui.sel || {}).filter(function (id) { return ui.sel[id] && S.find('catch_logs', id); });
  }

  function viewLog() {
    if (!ui.date) return emptyBox('大会日がまだありません。', '⚙︎ 管理を開く', 'go-admin');
    var L = logLists(), live = L.live, dead = L.dead, selMode = !!ui.selMode;
    var pts = C.r2(live.reduce(function (s, c) { return s + Number(c.points); }, 0));
    var item = function (c) { return selMode ? logItem(c, !!ui.sel[c.id]) : logItem(c); };

    var chips = '<div class="row" style="flex-wrap:wrap;margin-bottom:10px">' +
      ['all'].concat(S.boats().map(function (b) { return b.id; })).map(function (id) {
        return '<button class="chip" type="button" data-action="log-boat" data-id="' + id + '" aria-pressed="' + (ui.logBoat === id) + '">' +
          (id === 'all' ? '全船' : esc(boatName(id))) + '</button>';
      }).join('') + '</div>';

    var head = selMode
      ? '<div class="row" style="margin:0 0 8px"><span class="grow small"><b>選択モード</b>　タップで選択</span>' +
        '<button class="btn sm" type="button" data-action="sel-all">すべて選択</button>' +
        '<button class="btn sm ghost" type="button" data-action="sel-exit">やめる</button></div>'
      : '<div class="row" style="margin:0 0 8px"><span class="grow small muted">' + md(ui.date) + '　' + live.length + '本　' + C.fmtPoints(pts) + 'pt　タップで編集</span>' +
        ((live.length || dead.length) ? '<button class="btn sm" type="button" data-action="sel-start">選択して削除</button>' : '') + '</div>';

    var body = live.length ? live.map(item).join('') : '<div class="panel empty"><p class="muted">この日の記録はまだありません</p></div>';
    var deleted = dead.length ? '<h2 class="sec"><button class="btn sm ghost" type="button" data-action="toggle-deleted">削除済み ' + dead.length + '件を' + (ui.showDeleted ? '隠す' : '表示') + '</button></h2>' +
      (ui.showDeleted ? dead.map(item).join('') : '') : '';

    var bar = '';
    if (selMode) {
      var ids = selectedIds();
      var nLive = ids.filter(function (id) { return !S.find('catch_logs', id).deleted_at; }).length, nDead = ids.length - nLive;
      bar = '<div class="selspace"></div><div class="selbar"><span class="grow"><b class="num" style="font-size:24px">' + ids.length + '</b> 件選択中</span>' +
        (nLive ? '<button class="btn sm danger" type="button" data-action="sel-delete">削除</button>' : '') +
        (nDead ? '<button class="btn sm" type="button" data-action="sel-restore">復元</button>' : '') +
        (isAdmin() && ids.length ? '<button class="btn sm dark" type="button" data-action="sel-purge">完全削除</button>' : '') +
        (ids.length ? '' : '<span class="small muted">釣果をタップして選択</span>') + '</div>';
    }
    return chips + head + body + deleted + bar;
  }

  function editCatch(id) {
    var c = S.find('catch_logs', id); if (!c) return;
    var sel = { label: c.size_category, points: Number(c.points), tripId: c.trip_id };
    var trips = S.trips();
    function html() {
      return '<h3>釣果の編集</h3>' +
        '<label class="field"><span>サイズ区分</span><div class="seg" id="ec-size">' + cats().map(function (k) {
          return '<button type="button" data-label="' + esc(k.label) + '" aria-pressed="' + (k.label === sel.label) + '">' + esc(k.label) + '</button>';
        }).join('') + '</div></label>' +
        '<label class="field"><span>点数（サイズを選ぶと自動入力）</span><input class="input num" id="ec-pt" type="number" inputmode="decimal" step="0.5" min="0" value="' + sel.points + '"></label>' +
        '<label class="field"><span>日時</span><input class="input" id="ec-time" type="datetime-local" value="' + toLocalInput(c.caught_at) + '"></label>' +
        '<label class="field"><span>便（大会日・船・便）</span><select class="input" id="ec-trip">' + trips.map(function (t) {
          return '<option value="' + t.id + '"' + (t.id === sel.tripId ? ' selected' : '') + '>' + md(t.event_date) + ' ' + esc(boatName(t.boat_id)) + ' ' + esc(t.trip) + '</option>';
        }).join('') + '</select></label>' +
        '<label class="field"><span>メモ</span><textarea class="input" id="ec-memo" placeholder="例：〇〇さん　ジグ40g">' + esc(c.memo || '') + '</textarea></label>' +
        '<div class="actions"><button class="btn primary block" type="button" id="ec-save">保存する</button>' +
        (c.deleted_at
          ? '<button class="btn dark block" type="button" id="ec-restore">復元する</button>' +
            (isAdmin() ? '<button class="btn danger block" type="button" id="ec-purge">完全に削除（元に戻せません）</button>' : '')
          : '<button class="btn danger block" type="button" id="ec-del">この釣果を削除</button>') +
        '<button class="btn ghost block" type="button" id="ec-cancel">閉じる</button></div>';
    }
    openSheet(html(), function (root) {
      root.querySelector('#ec-size').onclick = function (e) {
        var b = e.target.closest('button'); if (!b) return;
        sel.label = b.dataset.label; sel.points = ptOf(sel.label);
        root.querySelectorAll('#ec-size button').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
        root.querySelector('#ec-pt').value = sel.points;
      };
      root.querySelector('#ec-save').onclick = function () {
        var p = parseFloat(root.querySelector('#ec-pt').value);
        if (!(p >= 0)) { toast('点数を正しく入力してください', { kind: 'err' }); return; }
        var tv = root.querySelector('#ec-time').value;
        var t = S.find('trips', root.querySelector('#ec-trip').value);
        S.upsert('catch_logs', Object.assign({}, c, {
          size_category: sel.label, points: p,
          caught_at: (tv && tv !== toLocalInput(c.caught_at)) ? new Date(tv).toISOString() : c.caught_at, // 時刻を変えた時だけ更新
          trip_id: t.id, event_date: t.event_date, boat_id: t.boat_id, trip: t.trip,
          memo: root.querySelector('#ec-memo').value.trim()
        }));
        closeSheet(); toast('保存しました', { kind: 'ok' });
      };
      var d = root.querySelector('#ec-del');
      if (d) d.onclick = function () { closeSheet(); softDelete(c.id); };
      var r = root.querySelector('#ec-restore');
      if (r) r.onclick = function () { closeSheet(); restore(c.id); };
      var pg = root.querySelector('#ec-purge');
      if (pg) pg.onclick = function () {
        ask('この釣果を完全に削除します。元に戻せません。', '完全に削除', function () {
          S.remove('catch_logs', c.id); closeSheet(); toast('完全に削除しました');
        }, true);
      };
      root.querySelector('#ec-cancel').onclick = closeSheet;
    });
  }

  /* ---------- 🚤 便設定 ---------- */
  function viewTrips() {
    if (!ui.date) return emptyBox('大会日がまだありません。', '⚙︎ 管理を開く', 'go-admin');
    var trips = S.trips(ui.date);
    var cards = trips.map(function (t) {
      var a = C.aggregateTrip(t, S.data.catch_logs);
      return '<div class="panel tripcard"><div class="tc-head"><span class="tc-boat">' + esc(boatName(t.boat_id)) + '</span><span class="tc-trip">' + esc(t.trip) + '</span>' +
        (ui.tripId === t.id ? '<span class="pending-mark" style="margin-left:auto">入力中</span>' : '') + '</div>' +
        '<div class="tc-grid">' + stat('人数', t.people + '名') + stat('時間', t5(t.start_time) + '–' + t5(t.end_time)) + stat('実釣', C.fmtHours(a.hours)) +
        stat('本数', a.count) + stat('総pt', C.fmtPoints(a.points)) + stat('SCORE', C.fmtScore(a.score)) + '</div>' +
        '<div class="tc-actions"><button class="btn primary" type="button" data-action="use-trip" data-id="' + t.id + '">🎣 この便で入力</button>' +
        '<button class="btn" type="button" data-action="edit-trip" data-id="' + t.id + '">編集</button></div></div>';
    }).join('');
    return '<h2 class="sec">' + md(ui.date) + '(' + wd(ui.date) + ') の便</h2>' +
      (cards || '<div class="panel empty"><p class="muted">まだ便がありません</p></div>') +
      '<div style="margin-top:12px"><button class="btn dark block" type="button" data-action="new-trip">＋ 便を追加</button></div>';
  }

  function editTrip(id) {
    var t = id ? S.find('trips', id) : null;
    var boats = S.boats();
    var f = t ? { event_date: t.event_date, boat_id: t.boat_id, trip: t.trip, people: t.people, start_time: t5(t.start_time), end_time: t5(t.end_time) }
      : { event_date: ui.date, boat_id: (boats[0] || {}).id, trip: (S.tripNames()[0] || {}).name, people: null, start_time: '05:00', end_time: '09:00' };
    var nCatch = t ? S.data.catch_logs.filter(function (c) { return c.trip_id === t.id; }).length : 0;

    function maxP() { var b = S.find('boats', f.boat_id); return b ? b.max_people : 9; }
    function html() {
      var mp = maxP(), people = '';
      for (var i = 1; i <= mp; i++) people += '<button type="button" data-p="' + i + '" aria-pressed="' + (f.people === i) + '">' + i + '</button>';
      var h = C.tripHours(f.start_time, f.end_time);
      return '<h3>' + (t ? '便の編集' : '便を追加') + '</h3>' +
        '<label class="field"><span>大会日</span><select class="input" id="tr-date">' + S.days().map(function (d) {
          return '<option value="' + d.event_date + '"' + (d.event_date === f.event_date ? ' selected' : '') + '>' + md(d.event_date) + '(' + wd(d.event_date) + ') ' + esc(d.title || '') + '</option>';
        }).join('') + '</select></label>' +
        '<div class="field"><span>船</span><div class="seg" id="tr-boat">' + boats.map(function (b) {
          return '<button type="button" data-id="' + b.id + '" aria-pressed="' + (b.id === f.boat_id) + '">' + esc(b.name) + '</button>';
        }).join('') + '</div></div>' +
        '<div class="field"><span>便</span><div class="seg" id="tr-trip">' + S.tripNames().map(function (n) {
          return '<button type="button" data-name="' + esc(n.name) + '" aria-pressed="' + (n.name === f.trip) + '">' + esc(n.name) + '</button>';
        }).join('') + '</div></div>' +
        '<div class="field"><span>参加人数（最大 ' + mp + '名）</span><div class="seg people" id="tr-people">' + people + '</div></div>' +
        '<div class="row"><label class="field grow"><span>開始</span><input class="input num" id="tr-start" type="time" value="' + f.start_time + '"></label>' +
        '<label class="field grow"><span>終了</span><input class="input num" id="tr-end" type="time" value="' + f.end_time + '"></label></div>' +
        '<p class="small" id="tr-hours" style="margin:-4px 0 0">実釣時間 <b class="num" style="font-size:22px">' + C.fmtHours(h) + '</b>' +
        (f.people ? '　人時 <b class="num" style="font-size:22px">' + C.r2(f.people * h) + '</b>' : '') +
        (C.toMinutes(f.end_time) < C.toMinutes(f.start_time) ? '　<span class="muted">（日付またぎ）</span>' : '') + '</p>' +
        '<div class="actions"><button class="btn primary block" type="button" id="tr-save">' + (t ? '保存する' : '便を作成') + '</button>' +
        (t ? '<button class="btn danger block" type="button" id="tr-del">' +
          (nCatch && isAdmin() ? 'この便と釣果' + nCatch + '件をまとめて削除' : 'この便を削除') + '</button>' : '') +
        '<button class="btn ghost block" type="button" id="tr-cancel">閉じる</button></div>';
    }
    function bind(root) {
      root.querySelector('#tr-date').onchange = function (e) { f.event_date = e.target.value; };
      root.querySelector('#tr-boat').onclick = function (e) {
        var b = e.target.closest('button'); if (!b) return;
        f.boat_id = b.dataset.id; if (f.people > maxP()) f.people = null; rerender(root);
      };
      root.querySelector('#tr-trip').onclick = function (e) {
        var b = e.target.closest('button'); if (!b) return; f.trip = b.dataset.name; rerender(root);
      };
      root.querySelector('#tr-people').onclick = function (e) {
        var b = e.target.closest('button'); if (!b) return; f.people = +b.dataset.p; rerender(root);
      };
      root.querySelector('#tr-start').onchange = function (e) { f.start_time = e.target.value; rerender(root); };
      root.querySelector('#tr-end').onchange = function (e) { f.end_time = e.target.value; rerender(root); };
      root.querySelector('#tr-cancel').onclick = closeSheet;
      root.querySelector('#tr-save').onclick = function () {
        if (!f.event_date) return toast('大会日を選んでください', { kind: 'err' });
        if (!f.boat_id) return toast('船を選んでください', { kind: 'err' });
        if (!f.trip) return toast('便を選んでください', { kind: 'err' });
        if (!f.people) return toast('参加人数を選んでください', { kind: 'err' });
        if (f.people > maxP()) return toast('最大人数を超えています', { kind: 'err' });
        if (!(C.tripHours(f.start_time, f.end_time) > 0)) return toast('開始と終了の時刻を確認してください', { kind: 'err' });
        var dup = S.data.trips.find(function (x) {
          return x.event_date === f.event_date && x.boat_id === f.boat_id && x.trip === f.trip && (!t || x.id !== t.id);
        });
        if (dup) return toast('同じ大会日・船・便が既にあります', { kind: 'err' });
        var saved = S.upsert('trips', Object.assign({}, t || {}, f));
        // 所属する釣果の 大会日・船・便 も揃える（サーバー側でもトリガーで保証）
        if (t) S.data.catch_logs.filter(function (c) { return c.trip_id === t.id && (c.event_date !== f.event_date || c.boat_id !== f.boat_id || c.trip !== f.trip); })
          .forEach(function (c) { S.upsert('catch_logs', Object.assign({}, c, { event_date: f.event_date, boat_id: f.boat_id, trip: f.trip })); });
        if (!t) { ui.tripId = saved.id; ui.date = saved.event_date; ui.tab = 'input'; window.scrollTo(0, 0); }
        closeSheet(); toast(t ? '保存しました（SCOREを再計算）' : '便を作成しました。釣れたらサイズを押すだけ', { kind: 'ok' });
      };
      var d = root.querySelector('#tr-del');
      if (d) d.onclick = function () {
        if (nCatch && !isAdmin()) return toast('釣果が' + nCatch + '件ある便は削除できません。釣果を別の便に移すか、管理者に「まとめて削除」を頼んでください', { kind: 'err', ms: 5000 });
        if (nCatch) {
          return ask('「' + boatName(t.boat_id) + ' ' + t.trip + '」の便と、釣果' + nCatch + '件（削除済みを含む）をすべて完全に削除します。元に戻せません。', 'まとめて削除', function () {
            var list = S.data.catch_logs.filter(function (c) { return c.trip_id === t.id; });
            S.batch(function () {
              list.forEach(function (c) { S.remove('catch_logs', c.id); });   // 先に釣果を消してから
              S.remove('trips', t.id);                                       // 便を消す（送信もこの順番）
            });
            if (ui.tripId === t.id) ui.tripId = null;
            closeSheet(); toast('便と釣果' + list.length + '件を削除しました');
          }, true);
        }
        ask('この便を削除しますか？', '削除する', function () {
          S.remove('trips', t.id); if (ui.tripId === t.id) ui.tripId = null;
          closeSheet(); toast('便を削除しました');
        }, true);
      };
    }
    function rerender(root) { root.innerHTML = '<div class="grab"></div>' + html(); bind(root); }
    if (!S.days().length) return toast('先に ⚙︎ 管理 で大会日を追加してください', { kind: 'err' });
    if (!boats.length) return toast('先に ⚙︎ 管理 で船を追加してください', { kind: 'err' });
    openSheet(html(), bind);
  }

  /* ---------- 📊 集計 ---------- */
  function viewSum() {
    if (!ui.date) return emptyBox('大会日がまだありません。', '⚙︎ 管理を開く', 'go-admin');
    var trips = S.trips(ui.date), cl = S.data.catch_logs;
    var tripRows = trips.map(function (t) {
      var a = C.aggregateTrip(t, cl);
      return '<tr><td class="l"><b>' + esc(boatName(t.boat_id)) + '</b></td><td class="l">' + esc(t.trip) + '</td><td class="n">' + a.people +
        '</td><td class="n">' + C.fmtHours(a.hours) + '</td><td class="n">' + C.r2(a.personHours) + '</td><td class="n">' + a.count +
        '</td><td class="n">' + C.fmtPoints(a.points) + '</td><td class="score">' + C.fmtScore(a.score) + '</td></tr>';
    }).join('');
    var dayRows = boatRows(trips).map(function (r) {
      var a = r.agg;
      return '<tr class="total"><td class="l">' + esc(r.boat.name) + '</td><td class="n">' + a.tripCount + '</td><td class="n">' + a.people + '</td><td class="n">' +
        C.fmtHours(a.hours) + '</td><td class="n">' + C.r2(a.personHours) + '</td><td class="n">' + a.count + '</td><td class="n">' +
        C.fmtPoints(a.points) + '</td><td class="score">' + C.fmtScore(a.score) + '</td></tr>';
    }).join('');
    var cs = cats();
    var sizeRows = S.boats().map(function (b) {
      var bd = C.sizeBreakdown(trips.filter(function (t) { return t.boat_id === b.id; }), cl, cs);
      return '<tr><td class="l"><b>' + esc(b.name) + '</b></td>' + cs.map(function (c) { return '<td class="n">' + (bd[c.label] || 0) + '</td>'; }).join('') + '</tr>';
    }).join('');
    var allRows = boatRows(S.trips()).map(function (r) {
      var a = r.agg;
      return '<tr><td class="l"><b>' + esc(r.boat.name) + '</b></td><td class="n">' + a.tripCount + '</td><td class="n">' + C.r2(a.personHours) +
        '</td><td class="n">' + a.count + '</td><td class="n">' + C.fmtPoints(a.points) + '</td><td class="score">' + C.fmtScore(a.score) + '</td></tr>';
    }).join('');

    return '<h2 class="sec">便別（大会日×船×便）</h2>' +
      (trips.length ? tbl(['船', '便', '人数', '実釣', '人時', '本数', '総pt', 'SCORE'], tripRows) : '<div class="panel muted">この日の便はありません</div>') +
      '<h2 class="sec">日別（大会日×船）＝ 日別総pt ÷ 日別総人時 × 1000</h2>' +
      tbl(['船', '便数', '延べ人数', '実釣計', '人時', '本数', '総pt', 'SCORE'], dayRows) +
      '<h2 class="sec">サイズ別本数（' + md(ui.date) + '）</h2>' +
      tbl(['船'].concat(cs.map(function (c) { return c.label + '<br>' + C.fmtPoints(c.points) + 'pt'; })), sizeRows) +
      '<h2 class="sec">全日程の通算</h2>' +
      tbl(['船', '便数', '人時', '本数', '総pt', 'SCORE'], allRows) +
      '<div class="row" style="margin-top:16px"><button class="btn grow" type="button" data-action="csv-catch">釣果CSV</button>' +
      '<button class="btn grow" type="button" data-action="csv-sum">集計CSV</button></div>';
  }
  function tbl(heads, rows) {
    return '<div class="tablebox scroll-x"><table class="t"><thead><tr>' + heads.map(function (h, i) {
      return '<th' + (i === 0 ? ' class="l"' : '') + '>' + h + '</th>';
    }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* ---------- ⚙︎ 管理 ---------- */
  function viewAdmin() {
    var adm = isAdmin(), dis = adm ? '' : ' disabled';
    var mode = S.mode === 'local'
      ? '<b>デモモード</b>（この端末だけに保存）'
      : '<b>クラウドモード</b>（' + (adm ? '管理者' : '記録係') + '）<br><span class="small muted">最終同期 ' + (S.status.lastSync ? hm(S.status.lastSync) : '—') + '　未送信 ' + S.outbox.length + '件</span>';

    var days = S.days().map(function (d) {
      var n = S.data.trips.filter(function (t) { return t.event_date === d.event_date; }).length;
      return '<div class="adm-row"><span class="grow"><b>' + md(d.event_date) + '(' + wd(d.event_date) + ')</b> ' + esc(d.title || '') +
        ' <span class="small muted">便' + n + '</span></span>' +
        '<button class="btn sm ghost" type="button" data-action="del-day" data-id="' + d.event_date + '"' + dis + '>削除</button></div>';
    }).join('');

    var boats = S.boats(true).map(function (b) {
      return '<div class="adm-row"><input class="input grow" style="min-height:44px" data-action="boat-name" data-id="' + b.id + '" value="' + esc(b.name) + '"' + dis + '>' +
        '<div class="stepper"><button type="button" data-action="boat-max" data-id="' + b.id + '" data-d="-1"' + dis + '>−</button>' +
        '<span class="num">' + b.max_people + '</span><button type="button" data-action="boat-max" data-id="' + b.id + '" data-d="1"' + dis + '>＋</button></div>' +
        '<button class="toggle" type="button" aria-label="表示" data-action="boat-active" data-id="' + b.id + '" aria-pressed="' + (b.active !== false) + '"' + dis + '></button></div>';
    }).join('');

    var tns = S.tripNames().map(function (n) {
      return '<button class="chip" type="button" data-action="del-tripname" data-id="' + n.id + '"' + dis + '>' + esc(n.name) + ' ×</button>';
    }).join(' ');

    var pts = cats().map(function (c, i) {
      return '<div class="pt-row"><label for="pt' + i + '">' + esc(c.label) + '</label><input class="input num" id="pt' + i + '" data-i="' + i + '" type="number" inputmode="decimal" step="0.5" min="0" value="' + c.points + '"' + dis + '></div>';
    }).join('');

    var conn = S.connection() || {};
    var memberCode = conn.memberCode || (S.role === 'member' ? conn.code : '') || '';
    var invite = S.mode === 'cloud' ? '<h2 class="sec">招待リンク（URLだけで参加）</h2><div class="panel">' +
      '<label class="field"><span>記録係用コード（Supabaseに登録したもの）</span><input class="input" id="iv-code" autocomplete="off" autocapitalize="off" value="' + esc(memberCode) + '"></label>' +
      '<div class="row"><button class="btn primary grow" type="button" data-action="invite-line">LINEで送る</button>' +
      '<button class="btn grow" type="button" data-action="invite-copy">リンクをコピー</button></div>' +
      '<p class="small muted" style="margin-bottom:0">受け取った人はリンクをタップするだけで参加できます。リンクを知っている人は誰でも入力できるので、送る相手に注意してください。</p>' +
      (adm ? '<button class="btn sm ghost block" style="margin-top:10px" type="button" data-action="invite-admin">自分の別端末用：管理者リンクをコピー</button>' : '') +
      '</div>' : '';

    return '<h2 class="sec">接続</h2><div class="panel">' + mode +
      (S.mode === 'cloud' ? '<div class="row" style="margin-top:10px"><button class="btn sm grow" type="button" data-action="sync-now">今すぐ同期</button><button class="btn sm ghost grow" type="button" data-action="rejoin">参加コードを入れ直す</button></div>' : '') +
      '<button class="btn sm ghost block" style="margin-top:8px" type="button" data-action="reset-conn">' + (S.mode === 'local' ? 'クラウド（複数端末共有）に切り替える' : '接続設定をやり直す（別の大会に切替）') + '</button>' +
      '</div>' + invite +
      (adm ? '' : '<div class="notice" style="margin-top:10px">船・便名・大会日・ポイントの変更は管理者のみ。管理者コードで参加し直すと編集できます。</div>') +
      '<h2 class="sec">大会日</h2><div class="panel">' + (days || '<p class="muted">まだありません</p>') +
      '<div class="row" style="margin-top:10px"><input class="input grow" id="ad-date" type="date" value="' + S.localDate() + '"' + dis + '>' +
      '<input class="input grow" id="ad-title" placeholder="名称（任意）"' + dis + '></div>' +
      '<button class="btn dark block" style="margin-top:8px" type="button" data-action="add-day"' + dis + '>＋ 大会日を追加</button></div>' +
      '<h2 class="sec">船（名前・最大乗船人数・表示）</h2><div class="panel">' + boats +
      '<div class="row" style="margin-top:10px"><input class="input grow" id="ad-boat" placeholder="新しい船の名前"' + dis + '>' +
      '<button class="btn dark" type="button" data-action="add-boat"' + dis + '>追加</button></div></div>' +
      '<h2 class="sec">便の種類</h2><div class="panel"><div class="row" style="flex-wrap:wrap">' + tns + '</div>' +
      '<div class="row" style="margin-top:10px"><input class="input grow" id="ad-tn" placeholder="例：夕便"' + dis + '>' +
      '<button class="btn dark" type="button" data-action="add-tripname"' + dis + '>追加</button></div></div>' +
      '<h2 class="sec">サイズ別ポイント</h2><div class="panel">' + pts +
      '<button class="btn primary block" style="margin-top:8px" type="button" data-action="save-points"' + dis + '>ポイントを保存</button>' +
      '<p class="small muted">保存後に登録した釣果から新ポイントになります。既存の釣果にも反映するには下のボタン。</p>' +
      '<button class="btn block" type="button" data-action="reapply-points"' + dis + '>既存の全釣果に現在のポイントを再適用</button></div>' +
      '<h2 class="sec">データ</h2><div class="panel"><div class="actions" style="margin-top:0">' +
      '<button class="btn block" type="button" data-action="backup">バックアップ（JSON）を保存</button>' +
      '<button class="btn block" type="button" data-action="csv-catch">釣果CSVを保存</button>' +
      '<label class="btn block" style="display:flex;align-items:center;justify-content:center' + (adm ? '' : ';opacity:.45') + '">バックアップから復元<input type="file" id="ad-restore" accept="application/json,.json" hidden' + dis + '></label>' +
      '<button class="btn block" type="button" data-action="testdata"' + dis + '>テストデータを投入（10/6 DSK号 早朝便）</button>' +
      (S.mode === 'local' ? '<button class="btn danger block" type="button" data-action="reset">この端末のデータを初期化</button>' : '') +
      '</div></div>' +
      '<p class="small muted" style="text-align:center;margin-top:18px"><button class="btn sm ghost" type="button" data-action="back">← 戻る</button></p>';
  }

  /* ---------- 書き出し ---------- */
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function csv(rows) {
    return '\ufeff' + rows.map(function (r) {
      return r.map(function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\r\n');
  }
  function csvCatch() {
    var rows = [['id', 'timestamp', 'event_date', 'boat', 'trip', 'size_category', 'points', 'memo', 'deleted']];
    S.data.catch_logs.slice().sort(function (a, b) { return a.caught_at < b.caught_at ? -1 : 1; }).forEach(function (c) {
      rows.push([c.id, new Date(c.caught_at).toLocaleString('ja-JP'), c.event_date, boatName(c.boat_id), c.trip, c.size_category, c.points, c.memo || '', c.deleted_at ? '削除済' : '']);
    });
    download('catchlog_' + S.localDate() + '.csv', csv(rows), 'text/csv');
  }
  function csvSum() {
    var rows = [['区分', '大会日', '船', '便', '人数', '実釣時間h', '人時', '本数', '総ポイント', 'SCORE']];
    S.days().forEach(function (d) {
      var trips = S.trips(d.event_date);
      trips.forEach(function (t) {
        var a = C.aggregateTrip(t, S.data.catch_logs);
        rows.push(['便別', t.event_date, boatName(t.boat_id), t.trip, a.people, C.r2(a.hours), C.r2(a.personHours), a.count, a.points, C.r2(a.score)]);
      });
      boatRows(trips).forEach(function (r) {
        var a = r.agg; if (!a.tripCount) return;
        rows.push(['日別', d.event_date, r.boat.name, '全便', a.people, C.r2(a.hours), C.r2(a.personHours), a.count, a.points, C.r2(a.score)]);
      });
    });
    download('score_' + S.localDate() + '.csv', csv(rows), 'text/csv');
  }

  /* ---------- テストデータ ---------- */
  function loadTestData() {
    var date = '2026-10-06';
    if (!S.find('event_days', date)) S.upsert('event_days', { event_date: date, title: '' });
    var boat = S.boats(true).find(function (b) { return b.name === 'DSK号'; });
    if (!boat) boat = S.upsert('boats', { name: 'DSK号', max_people: 6, sort: 1, active: true });
    if (!S.tripNames().some(function (n) { return n.name === '早朝便'; })) S.upsert('trip_names', { name: '早朝便', sort: 2 });
    var trip = S.data.trips.find(function (t) { return t.event_date === date && t.boat_id === boat.id && t.trip === '早朝便'; });
    if (!trip) trip = S.upsert('trips', { event_date: date, boat_id: boat.id, trip: '早朝便', people: 5, start_time: '05:00', end_time: '09:00' });
    var seq = ['60cm未満', '80〜89cm', '90〜99cm', '100cm以上', '80〜89cm', '90〜99cm', '80〜89cm', '90〜99cm', '100cm以上'];
    var base = new Date(date + 'T05:20:00');
    seq.forEach(function (label, i) {
      S.upsert('catch_logs', {
        id: S.uuid(), trip_id: trip.id, caught_at: new Date(base.getTime() + i * 22 * 60000).toISOString(),
        event_date: date, boat_id: boat.id, trip: '早朝便', size_category: label, points: ptOf(label), memo: 'テスト', deleted_at: null
      });
    });
    ui.date = date; ui.tripId = trip.id; ui.scope = 'day'; ui.tab = 'sum';
    render();
    toast('テストデータを投入しました（9件）', { kind: 'ok' });
  }

  /* =========================================================
   * 操作
   * ========================================================= */
  function onClick(e) {
    var tabBtn = e.target.closest('#tabbar button');
    if (tabBtn) { ui.tab = tabBtn.dataset.tab; ui.selMode = false; ui.sel = {}; render(); window.scrollTo(0, 0); return; }
    var dateBtn = e.target.closest('#datebar [data-date]');
    if (dateBtn) { ui.date = dateBtn.dataset.date; ui.scope = 'day'; ui.sel = {}; render(); return; }
    if (e.target.closest('#datebar [data-scope]')) { ui.scope = 'all'; render(); return; }

    var b = e.target.closest('[data-action]'); if (!b || b.disabled) return;
    var id = b.dataset.id, a = b.dataset.action;
    switch (a) {
      case 'catch': registerCatch(b.dataset.label, b); break;
      case 'pick-trip': ui.tripId = null; render(); break;
      case 'use-trip': {
        ui.tripId = id; var t = S.find('trips', id); if (t) ui.date = t.event_date;
        ui.tab = 'input'; render(); window.scrollTo(0, 0); break;
      }
      case 'new-trip': editTrip(null); break;
      case 'edit-trip': editTrip(id); break;
      case 'edit-catch': editCatch(id); break;
      case 'log-boat': ui.logBoat = id; ui.sel = {}; render(); break;
      case 'sel-start': ui.selMode = true; ui.sel = {}; render(); break;
      case 'sel-exit': ui.selMode = false; ui.sel = {}; render(); break;
      case 'sel-toggle': ui.sel[id] = !ui.sel[id]; render(); break;
      case 'sel-all': {
        var LL = logLists(), vis = LL.live.concat(ui.showDeleted ? LL.dead : []);
        var allOn = vis.length && vis.every(function (c) { return ui.sel[c.id]; });
        ui.sel = {}; if (!allOn) vis.forEach(function (c) { ui.sel[c.id] = true; });
        render(); break;
      }
      case 'sel-delete': {
        var del = selectedIds().filter(function (x) { return !S.find('catch_logs', x).deleted_at; });
        ask(del.length + '件の釣果を削除します。削除済みとして残るので、あとで復元できます。', '削除する', function () {
          var at = new Date().toISOString();
          S.batch(function () { del.forEach(function (x) { S.upsert('catch_logs', Object.assign({}, S.find('catch_logs', x), { deleted_at: at })); }); });
          ui.selMode = false; ui.sel = {}; render();
          toast(del.length + '件を削除しました', { ms: 6000, actions: [{ label: '元に戻す', fn: function () {
            S.batch(function () { del.forEach(function (x) { var c = S.find('catch_logs', x); if (c) S.upsert('catch_logs', Object.assign({}, c, { deleted_at: null })); }); });
            toast('元に戻しました', { kind: 'ok' });
          } }] });
        }, true);
        break;
      }
      case 'sel-restore': {
        var res = selectedIds().filter(function (x) { return S.find('catch_logs', x).deleted_at; });
        S.batch(function () { res.forEach(function (x) { S.upsert('catch_logs', Object.assign({}, S.find('catch_logs', x), { deleted_at: null })); }); });
        ui.selMode = false; ui.sel = {}; render(); toast(res.length + '件を復元しました', { kind: 'ok' });
        break;
      }
      case 'sel-purge': {
        var pg = selectedIds();
        ask(pg.length + '件の釣果を完全に削除します。元に戻せません。', '完全に削除', function () {
          S.batch(function () { pg.forEach(function (x) { S.remove('catch_logs', x); }); });
          ui.selMode = false; ui.sel = {}; render(); toast(pg.length + '件を完全に削除しました');
        }, true);
        break;
      }
      case 'toggle-deleted': ui.showDeleted = !ui.showDeleted; render(); break;
      case 'go-admin': ui.tab = 'admin'; render(); break;
      case 'back': ui.tab = 'rank'; render(); break;
      case 'csv-catch': csvCatch(); break;
      case 'csv-sum': csvSum(); break;
      case 'backup': download('sawara-cup-backup_' + S.localDate() + '.json', JSON.stringify(S.exportJSON(), null, 1), 'application/json'); break;
      case 'testdata': ask('テストデータ（2026/10/06 DSK号 早朝便・5名・05:00〜09:00・9本）を追加します。', '追加する', loadTestData); break;
      case 'reset':
        ask('この端末のデータをすべて消して初期状態に戻します。先にバックアップを推奨します。', '初期化する', function () { S.resetLocal(); ui.tripId = null; ui.date = null; render(); }, true);
        break;
      case 'hide-a2hs': ui.hideA2HS = true; render(); break;
      case 'tide-pick': openTidePicker(); break;
      case 'invite-copy': case 'invite-line': {
        var code = ($('#iv-code').value || '').trim();
        if (!code) return toast('記録係用コードを入力してください', { kind: 'err' });
        var cn = S.connection(); if (cn) { cn.memberCode = code; S.setConnection(cn); }
        var link = S.makeInvite(code);
        var msg = 'サワラ焼肉CUP のスコア入力アプリです。\nこのリンクをタップするだけで参加できます。\n' + link;
        if (a === 'invite-line') { window.open('https://line.me/R/share?text=' + encodeURIComponent(msg), '_blank'); }
        else copyText(link).then(function (ok) { toast(ok ? '招待リンクをコピーしました' : 'コピーできませんでした', { kind: ok ? 'ok' : 'err' }); });
        break;
      }
      case 'invite-admin': {
        var ac = (S.connection() || {}).code;
        if (!ac) return toast('管理者コードが端末に保存されていません。参加コードを入れ直してください', { kind: 'err' });
        copyText(S.makeInvite(ac)).then(function (ok) { toast(ok ? '管理者リンクをコピーしました（他人に送らないでください）' : 'コピーできませんでした', { kind: ok ? 'ok' : 'err', ms: 4000 }); });
        break;
      }
      case 'reset-conn':
        ask(S.mode === 'local' ? 'クラウド設定画面に移ります。この端末のデモデータはそのまま残ります。' : 'この端末の接続設定を消して、初期設定画面に戻ります。サーバーのデータは消えません。', '進む', function () {
          if (S.mode !== 'local') S.clearConnection(); else localStorage.removeItem('scup:conn:v1');
          location.replace(location.pathname);
        });
        break;
      case 'sync-now': S.flush().then(function () { return S.refresh(); }).then(function () { toast('同期しました', { kind: 'ok' }); }); break;
      case 'rejoin': S.leave().then(function () { showJoin(); }); break;
      case 'add-day': {
        var d = $('#ad-date').value; if (!d) return toast('日付を選んでください', { kind: 'err' });
        if (S.find('event_days', d)) return toast('その大会日は既にあります', { kind: 'err' });
        S.upsert('event_days', { event_date: d, title: $('#ad-title').value.trim() }); ui.date = d;
        toast('大会日を追加しました', { kind: 'ok' }); break;
      }
      case 'del-day': {
        if (S.data.trips.some(function (t) { return t.event_date === id; })) return toast('便がある大会日は削除できません', { kind: 'err' });
        ask(md(id) + ' を削除しますか？', '削除する', function () { S.remove('event_days', id); }, true); break;
      }
      case 'add-boat': {
        var nm = $('#ad-boat').value.trim(); if (!nm) return toast('船の名前を入力してください', { kind: 'err' });
        if (S.data.boats.some(function (x) { return x.name === nm; })) return toast('同じ名前の船があります', { kind: 'err' });
        S.upsert('boats', { name: nm, max_people: 9, sort: S.data.boats.length + 1, active: true }); toast('船を追加しました', { kind: 'ok' }); break;
      }
      case 'boat-max': {
        var bt = S.find('boats', id), v = Math.min(50, Math.max(1, bt.max_people + (+b.dataset.d)));
        S.upsert('boats', Object.assign({}, bt, { max_people: v })); break;
      }
      case 'boat-active': {
        var bb = S.find('boats', id); S.upsert('boats', Object.assign({}, bb, { active: bb.active === false })); break;
      }
      case 'add-tripname': {
        var tn = $('#ad-tn').value.trim(); if (!tn) return;
        if (S.data.trip_names.some(function (x) { return x.name === tn; })) return toast('同じ便名があります', { kind: 'err' });
        S.upsert('trip_names', { name: tn, sort: S.data.trip_names.length + 1 }); break;
      }
      case 'del-tripname': {
        var n = S.find('trip_names', id);
        ask('便の種類「' + n.name + '」を一覧から外しますか？（作成済みの便には影響しません）', '外す', function () { S.remove('trip_names', id); }); break;
      }
      case 'save-points': {
        var cfg = S.pointsConfig(), bad = false;
        document.querySelectorAll('.pt-row input').forEach(function (inp) {
          var v = parseFloat(inp.value); if (!(v >= 0)) bad = true; else cfg.categories[+inp.dataset.i].points = v;
        });
        if (bad) return toast('ポイントは0以上の数字で入力してください', { kind: 'err' });
        S.upsert('settings', { key: 'points', value: cfg }); toast('ポイントを保存しました', { kind: 'ok' }); break;
      }
      case 'reapply-points': {
        var list = S.data.catch_logs.filter(function (c) { return Number(c.points) !== ptOf(c.size_category) && cats().some(function (k) { return k.label === c.size_category; }); });
        if (!list.length) return toast('変更が必要な釣果はありません');
        ask(list.length + '件の釣果の点数を現在の設定に置き換えます。', '置き換える', function () {
          list.forEach(function (c) { S.upsert('catch_logs', Object.assign({}, c, { points: ptOf(c.size_category) })); });
          toast(list.length + '件を再計算しました', { kind: 'ok' });
        }); break;
      }
    }
  }

  function onChange(e) {
    var t = e.target;
    if (t.dataset && t.dataset.action === 'boat-name') {
      var nm = t.value.trim(), bt = S.find('boats', t.dataset.id);
      if (!nm) { t.value = bt.name; return; }
      if (S.data.boats.some(function (x) { return x.name === nm && x.id !== bt.id; })) { toast('同じ名前の船があります', { kind: 'err' }); t.value = bt.name; return; }
      S.upsert('boats', Object.assign({}, bt, { name: nm })); toast('船名を保存しました', { kind: 'ok' });
    }
    if (t.id === 'ad-restore' && t.files && t.files[0]) {
      var r = new FileReader();
      r.onload = function () {
        try {
          var obj = JSON.parse(r.result);
          ask('バックアップを復元します。' + (S.mode === 'local' ? '現在のデータは置き換えられます。' : '同じIDのデータは上書きされます。'), '復元する', function () {
            try { S.importJSON(obj); toast('復元しました', { kind: 'ok' }); } catch (err) { toast('復元に失敗：' + err.message, { kind: 'err' }); }
          });
        } catch (err) { toast('復元に失敗：' + err.message, { kind: 'err' }); }
      };
      r.readAsText(t.files[0]);
    }
  }

  function hideChrome() { ['#tabbar', '#datebar', '#syncBtn', '#adminBtn'].forEach(function (id) { $(id).hidden = true; }); }

  /* ---------- 招待リンクの貼り付け ---------- */
  function invitePanel() {
    return '<div class="panel"><h2 class="sec" style="margin-top:0">招待リンクを受け取った方</h2>' +
      '<p class="small muted" style="margin-top:0">LINEで届いたリンクをタップすれば自動で参加できます。うまくいかない時は、リンクを長押しでコピーしてここに貼り付け。</p>' +
      '<textarea class="input" id="st-inv" placeholder="https://… を貼り付け"></textarea>' +
      '<button class="btn primary block" style="margin-top:8px" type="button" id="st-inv-go">このリンクで参加</button></div>';
  }
  function bindInvitePanel() {
    $('#st-inv-go').onclick = function () {
      var txt = $('#st-inv').value, inv = S.parseInvite(txt);
      if (!inv) return toast('招待リンクの形式ではありません。リンク全体を貼り付けてください', { kind: 'err', ms: 4000 });
      var token = txt.match(/[#&?]i=([A-Za-z0-9_-]+)/)[1];
      history.replaceState(null, '', location.pathname + '#i=' + token);
      location.reload();
    };
  }

  /* ---------- 参加画面（コード入力） ---------- */
  function showJoin(msg) {
    hideChrome();
    $('#main').innerHTML = '<div class="join"><div class="panel"><h1>🐟 参加する</h1>' +
      '<p class="muted small">参加コードを入力してください。この端末は次回から自動で入れます。</p>' +
      (msg ? '<div class="notice" style="margin-bottom:12px">' + esc(msg) + '</div>' : '') +
      '<label class="field"><span>参加コード</span><input class="input" id="jn-code" autocomplete="off" autocapitalize="off"></label>' +
      '<label class="field"><span>名前（任意）</span><input class="input" id="jn-name" placeholder="例：篤希号 船長"></label>' +
      '<button class="btn primary block" type="button" id="jn-go">参加する</button></div>' +
      '<div style="margin-top:10px">' + invitePanel() + '</div>' +
      '<p style="text-align:center"><button class="btn sm ghost" type="button" id="jn-reset">接続設定をやり直す</button></p></div>';
    bindInvitePanel();
    $('#jn-reset').onclick = function () {
      ask('この端末の接続設定を消して、初期設定画面に戻ります。', '戻る', function () { S.clearConnection(); location.replace(location.pathname); });
    };
    $('#jn-go').onclick = function () {
      var code = $('#jn-code').value.trim(); if (!code) return;
      this.disabled = true; this.textContent = '確認中…';
      S.join(code, $('#jn-name').value.trim()).then(function (role) {
        ui.tab = 'rank'; render();
        toast(role === 'admin' ? '管理者として参加しました' : '参加しました', { kind: 'ok' });
      }).catch(function (err) { showJoin(err.message); });
    };
  }

  /* ---------- 初期設定画面（接続先が未設定） ---------- */
  var SQL_TEXT = null;
  var LS_DRAFT = 'scup:setupdraft:v1';
  function showSetup() {
    hideChrome();
    var d; try { d = JSON.parse(localStorage.getItem(LS_DRAFT)) || {}; } catch (e) { d = {}; }
    if (!d.member) d.member = randCode('sawara-', 5);
    if (!d.admin) d.admin = randCode('admin-', 10);
    localStorage.setItem(LS_DRAFT, JSON.stringify(d));
    if (!SQL_TEXT) fetch('schema.sql', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (t) { SQL_TEXT = t; }).catch(function () {});

    $('#main').innerHTML = '<div class="join"><h1 style="font-size:28px;margin:0 0 12px">🐟 はじめに</h1>' +
      invitePanel() +
      '<div class="panel"><h2 class="sec" style="margin-top:0">主催者の初期設定（最初の1回だけ）</h2>' +
      '<p class="small"><b>① 参加コードを決める</b>（自動で作成済み。変更も可）</p>' +
      '<label class="field"><span>記録係用コード（船長に配る）</span><input class="input" id="st-member" autocomplete="off" autocapitalize="off" value="' + esc(d.member) + '"></label>' +
      '<label class="field"><span>管理者用コード（自分だけ）</span><input class="input" id="st-admin" autocomplete="off" autocapitalize="off" value="' + esc(d.admin) + '"></label>' +
      '<p class="small"><b>② データベースを作る</b></p>' +
      '<button class="btn dark block" type="button" id="st-copy">SQLをコピー</button>' +
      '<a class="btn ghost block" style="display:flex;align-items:center;justify-content:center;margin-top:8px;text-decoration:none" href="https://supabase.com/dashboard" target="_blank" rel="noopener">Supabaseを開く</a>' +
      '<p class="small muted">Supabaseの SQL Editor に貼り付けて Run。「Success」と出ればOK。</p>' +
      '<textarea class="input" id="st-sql" readonly hidden style="min-height:140px;font-size:12px"></textarea>' +
      '<p class="small"><b>③ 接続情報を貼り付ける</b></p>' +
      '<label class="field"><span>Project URL</span><input class="input" id="st-url" inputmode="url" autocomplete="off" autocapitalize="off" placeholder="https://xxxx.supabase.co" value="' + esc(d.url || '') + '"></label>' +
      '<label class="field"><span>anon public key</span><textarea class="input" id="st-key" autocomplete="off" autocapitalize="off" placeholder="eyJ…">' + esc(d.key || '') + '</textarea></label>' +
      '<button class="btn primary block" type="button" id="st-go">接続して開始</button></div>' +
      '<div class="panel"><h2 class="sec" style="margin-top:0">まず触ってみる</h2>' +
      '<button class="btn block" type="button" id="st-demo">デモで試す（この端末だけに保存）</button></div></div>';

    bindInvitePanel();
    function saveDraft() {
      d.member = $('#st-member').value.trim(); d.admin = $('#st-admin').value.trim();
      d.url = $('#st-url').value.trim(); d.key = $('#st-key').value.trim();
      localStorage.setItem(LS_DRAFT, JSON.stringify(d));
    }
    ['#st-member', '#st-admin', '#st-url', '#st-key'].forEach(function (id) { $(id).addEventListener('input', saveDraft); });

    $('#st-copy').onclick = function () {
      saveDraft();
      if (!validCode(d.member) || !validCode(d.admin)) return toast('コードは6〜40文字の英数字・ハイフンで入力してください', { kind: 'err', ms: 4000 });
      if (d.member === d.admin) return toast('記録係用と管理者用は別のコードにしてください', { kind: 'err' });
      if (!SQL_TEXT) return toast('SQLを読み込み中です。数秒後にもう一度押してください', { kind: 'err' });
      var sql = SQL_TEXT.replace('__MEMBER_CODE__', d.member).replace('__ADMIN_CODE__', d.admin);
      var ta = $('#st-sql'); ta.value = sql;
      copyText(sql).then(function (ok) {
        if (ok) toast('SQLをコピーしました。Supabaseに貼り付けてください', { kind: 'ok', ms: 4000 });
        else { ta.hidden = false; ta.focus(); ta.select(); toast('自動コピーできません。下の枠を長押し→全選択→コピー', { kind: 'err', ms: 5000 }); }
      });
    };
    $('#st-go').onclick = function () {
      saveDraft();
      if (!/^https:\/\/[^\s]+$/.test(d.url)) return toast('Project URL を https:// から貼り付けてください', { kind: 'err' });
      if (d.key.length < 20) return toast('anon public key を貼り付けてください', { kind: 'err' });
      if (!validCode(d.admin)) return toast('管理者用コードを確認してください', { kind: 'err' });
      S.setConnection({ url: d.url.replace(/\/+$/, ''), key: d.key, code: d.admin, memberCode: d.member });
      location.replace(location.pathname);
    };
    $('#st-demo').onclick = function () { S.setConnection({ mode: 'local' }); location.replace(location.pathname); };
  }

  /* ---------- 起動 ---------- */
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  $('#adminBtn').onclick = function () { ui.tab = ui.tab === 'admin' ? 'rank' : 'admin'; render(); window.scrollTo(0, 0); };
  $('#syncBtn').onclick = function () {
    if (S.mode === 'local') return toast('デモモード：データはこの端末だけに保存されています');
    S.flush().then(function () { return S.refresh(); });
    toast(S.outbox.length ? '未送信 ' + S.outbox.length + '件を送信中…（電波が戻ると自動送信）' : '最新データを取得しました');
  };

  S.onChange(function (kind, payload) {
    if (kind === 'error') { toast(payload, { kind: 'err', ms: 5000 }); return; }
    if (kind === 'status') { renderSync(); return; }
    if (sheetOpen) { renderSync(); return; }     // 編集中のシートは壊さない（閉じた時に再描画）
    if (!$('#adminBtn').hidden) render();
  });

  if (window.Tide) Tide.init(function () {
    if (!sheetOpen && ui.tab === 'rank' && !$('#adminBtn').hidden) render();
  });

  S.init().then(function (st) {
    $('#boot').remove();
    if (st === 'need_setup') showSetup();
    else if (st === 'need_join') showJoin(S.joinError);
    else {
      render();
      if (S.viaInvite && S.mode === 'cloud') toast(S.role === 'admin' ? '管理者として参加しました' : '参加しました。釣れたら 🎣 からサイズを押すだけ', { kind: 'ok', ms: 4000 });
    }
  }).catch(function (err) {
    $('#boot').remove();
    if (S.data.boats.length) { render(); toast(err.message, { kind: 'err', ms: 6000 }); }
    else $('#main').innerHTML = '<div class="panel empty"><p>' + esc(err.message) + '</p><button class="btn primary" onclick="location.reload()">再読み込み</button></div>';
  });

  window.__app = { ui: ui, render: render };
})();
