/* =========================================================
 * サワラ焼肉CUP — データストア
 *  - local モード : この端末の localStorage に保存（デモ・単独利用）
 *  - cloud モード : Supabase（複数端末・リアルタイム・オフライン送信待ち）
 * どちらも同じAPI。画面側は Store.data を読み、変更は upsert/remove で行う。
 * ========================================================= */
(function () {
  'use strict';

  var TABLES = {
    settings:   { pk: 'key' },
    boats:      { pk: 'id' },
    trip_names: { pk: 'id' },
    event_days: { pk: 'event_date' },
    trips:      { pk: 'id' },
    catch_logs: { pk: 'id' }
  };
  var NAMES = Object.keys(TABLES);
  var LS_DATA = 'scup:data:v1';      // local モードの本体データ
  var LS_CACHE = 'scup:cache:v1';    // cloud モードの最終取得キャッシュ（オフライン表示用）
  var LS_OUTBOX = 'scup:outbox:v1';  // cloud モードの未送信操作
  var LS_CONN = 'scup:conn:v1';      // 接続先 {mode:'local'} | {url,key,code,memberCode}
  var SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

  var DEFAULT_POINTS = {
    categories: [
      { key: 'lt60',  label: '60cm未満',  points: 0.5 },
      { key: '60_79', label: '60〜79cm',  points: 1 },
      { key: '80_89', label: '80〜89cm',  points: 1.5 },
      { key: '90_99', label: '90〜99cm',  points: 2 },
      { key: '100up', label: '100cm以上', points: 3 }
    ]
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function nowISO() { return new Date().toISOString(); }
  function localDate(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function readLS(k, fallback) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function writeLS(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }
  /* ---------- 招待リンク ---------- */
  function b64urlEncode(str) {
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return decodeURIComponent(escape(atob(str)));
  }
  /** URL（#i=…）または貼り付けられた文字列から招待情報を取り出す */
  function parseInvite(text) {
    var m = String(text || '').match(/[#&?]i=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
      var j = JSON.parse(b64urlDecode(m[1]));
      if (j && j.u && j.k && j.c) return { url: j.u, key: j.k, code: j.c };
    } catch (e) {}
    return null;
  }

  function emptyData() { var d = {}; NAMES.forEach(function (n) { d[n] = []; }); return d; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function applyOp(data, op) {
    var pk = TABLES[op.table].pk, list = data[op.table];
    if (op.kind === 'upsert') {
      var i = list.findIndex(function (r) { return r[pk] === op.row[pk]; });
      if (i >= 0) list[i] = Object.assign({}, list[i], op.row); else list.push(clone(op.row));
    } else if (op.kind === 'delete') {
      data[op.table] = list.filter(function (r) { return r[pk] !== op.pk; });
    }
  }

  function seedLocal() {
    var d = emptyData(), t = nowISO();
    d.settings.push({ key: 'points', value: clone(DEFAULT_POINTS), updated_at: t });
    d.boats.push({ id: uuid(), name: 'DSK号', max_people: 6, sort: 1, active: true, created_at: t });
    d.boats.push({ id: uuid(), name: '篤希号', max_people: 9, sort: 2, active: true, created_at: t });
    ['通常', '早朝便', '昼便', 'AM便'].forEach(function (n, i) {
      d.trip_names.push({ id: uuid(), name: n, sort: i + 1, created_at: t });
    });
    d.event_days.push({ event_date: localDate(), title: '', created_at: t });
    return d;
  }

  function errMessage(err) {
    if (!err) return '不明なエラー';
    var c = err.code || '';
    if (c === '23505') return '同じ内容が既に登録されています（大会日・船・便の組み合わせが重複）';
    if (c === '23503') return '関連データがあるため実行できません（例：釣果がある便は削除不可）';
    if (c === '42501' || /row-level security/i.test(err.message || '')) return 'この操作の権限がありません（管理者のみ）';
    if (c === '23514') return '入力値が範囲外です';
    return err.message || String(err);
  }
  function isNetworkError(err) {
    if (!err) return false;
    if (!navigator.onLine) return true;
    if (err.code) return false;
    return /fetch|network|load failed|timeout|abort/i.test(err.message || String(err));
  }

  var listeners = [];
  var Store = {
    mode: 'local',
    role: null,
    data: emptyData(),
    outbox: [],
    status: { online: navigator.onLine, realtime: 'off', lastSync: null, syncing: false },
    client: null,

    uuid: uuid, localDate: localDate, DEFAULT_POINTS: DEFAULT_POINTS,

    onChange: function (fn) { listeners.push(fn); },
    /** まとめて変更：途中の再描画を止め、最後に1回だけ画面を更新 */
    batch: function (fn) {
      this._mute = (this._mute || 0) + 1;
      try { fn(); } finally { this._mute--; }
      if (!this._mute) this.emit('data');
    },
    emit: function (kind, payload) {
      if (this._mute && (kind || 'data') === 'data') return;
      listeners.forEach(function (fn) { try { fn(kind || 'data', payload); } catch (e) { console.error(e); } });
    },

    /** 起動。戻り値 'ready' | 'need_join' */
    /** 接続先を決める：招待リンク ＞ config.js ＞ 端末に保存した設定 */
    resolveConnection: function () {
      var inv = parseInvite(location.hash);
      var saved = readLS(LS_CONN, null);
      if (inv) {
        // 新しい招待リンクで開いた：接続先を上書き。別の大会に切り替わる場合はキャッシュを捨てる
        if (!saved || saved.url !== inv.url) { localStorage.removeItem(LS_CACHE); localStorage.removeItem(LS_OUTBOX); }
        var conn = Object.assign({}, saved && saved.url === inv.url ? saved : {}, inv);
        writeLS(LS_CONN, conn);
        this.viaInvite = true;
        return conn;
      }
      var cfg = window.CUP_CONFIG || {};
      if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
        return Object.assign({}, saved || {}, { url: cfg.SUPABASE_URL, key: cfg.SUPABASE_ANON_KEY });
      }
      return saved;
    },
    connection: function () { return this.conn || null; },
    setConnection: function (conn) { writeLS(LS_CONN, conn); this.conn = conn; },
    clearConnection: function () {
      [LS_CONN, LS_CACHE, LS_OUTBOX].forEach(function (k) { localStorage.removeItem(k); });
      try { Object.keys(localStorage).forEach(function (k) { if (/^scup:auth/.test(k)) localStorage.removeItem(k); }); } catch (e) {}
    },
    parseInvite: parseInvite,
    /** 招待リンクを作る（LINEで開いた時に外部ブラウザ=Safariで開くよう指定） */
    makeInvite: function (code) {
      var c = this.conn;
      if (!c || !c.url) return '';
      var base = location.origin + location.pathname;
      return base + '?openExternalBrowser=1#i=' + b64urlEncode(JSON.stringify({ u: c.url, k: c.key, c: code }));
    },

    /** 起動。戻り値 'ready' | 'need_join' | 'need_setup' */
    init: async function () {
      var conn = this.conn = this.resolveConnection();
      if (!conn) return 'need_setup';
      var cfg = { SUPABASE_URL: conn.url, SUPABASE_ANON_KEY: conn.key };
      if (conn.mode === 'local' || !conn.url) {
        this.mode = 'local'; this.role = 'admin';
        this.data = readLS(LS_DATA, null) || seedLocal();
        NAMES.forEach(function (n) { if (!this.data[n]) this.data[n] = []; }, this);
        if (!this.data.settings.some(function (s) { return s.key === 'points'; })) {
          this.data.settings.push({ key: 'points', value: clone(DEFAULT_POINTS) });
        }
        this._saveLocal();
        this.status.realtime = 'local';
        return 'ready';
      }

      this.mode = 'cloud';
      var cache = readLS(LS_CACHE, null);
      if (cache && cache.data) { this.data = cache.data; this.role = cache.role || null; this.status.lastSync = cache.at; }
      this.outbox = readLS(LS_OUTBOX, []);
      this._replayOutbox();
      this.emit('data');

      await loadScript(SUPABASE_JS);
      this.client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'scup:auth' }
      });

      var sess = (await this.client.auth.getSession()).data.session;
      var role = sess ? await this._fetchRole(sess.user.id) : null;
      if (role === 'offline') {           // 圏外起動：キャッシュで動かす
        if (this.role) { this._startSync(); return 'ready'; }
        throw new Error('電波の届く場所で一度開いてください（初回の参加には通信が必要です）');
      }
      // 参加済み。ただし招待リンクで開いた記録係は、管理者リンクだった場合に昇格できるよう再参加を試す
      if (role && !(this.viaInvite && role === 'member')) {
        this.role = role; this._startSync(); return 'ready';
      }
      // 未参加：招待リンク（または保存済み）のコードで自動参加
      if (conn.code) {
        try { await this.join(conn.code, ''); return 'ready'; }
        catch (e) {
          if (role) { this.role = role; this._startSync(); return 'ready'; }
          this.joinError = e.message; return 'need_join';
        }
      }
      return 'need_join';
    },

    _fetchRole: async function (uid) {
      try {
        var res = await this.client.from('members').select('role').eq('uid', uid).maybeSingle();
        if (res.error) return isNetworkError(res.error) ? 'offline' : null;
        return res.data ? res.data.role : null;
      } catch (e) { return 'offline'; }
    },

    /** 参加コードで参加（cloud モード） */
    join: async function (code, name) {
      var c = this.client;
      var sess = (await c.auth.getSession()).data.session;
      if (!sess) {
        var si = await c.auth.signInAnonymously();
        if (si.error) {
          if (isNetworkError(si.error)) throw new Error('接続できません。電波を確認するか、Project URL が正しいか確認してください');
          throw new Error('Supabaseで「Anonymous sign-ins（匿名ログイン）」をONにしてください（' + si.error.message + '）');
        }
      }
      var r = await c.rpc('join_cup', { p_code: code, p_name: name || null });
      if (r.error) {
        var m = r.error.message || '';
        if (/invalid code/.test(m)) throw new Error(this.viaInvite ? '招待リンクのコードが一致しません。主催者に新しいリンクをもらってください' : '参加コードが違います');
        if (r.error.code === 'PGRST202' || /join_cup|schema cache/.test(m)) throw new Error('データベースの準備（SQL）がまだのようです。初期設定②のSQLを Supabase で実行してください');
        throw new Error(errMessage(r.error));
      }
      this.role = r.data;
      if (this.conn) { this.conn.code = code; writeLS(LS_CONN, this.conn); }
      this._startSync();
      return r.data;
    },

    leave: async function () {
      if (this.client) { try { await this.client.auth.signOut(); } catch (e) {} }
      localStorage.removeItem(LS_CACHE);
      if (this.conn) { delete this.conn.code; writeLS(LS_CONN, this.conn); }
      this.role = null;
    },

    _startSync: function () {
      var self = this;
      if (this._syncStarted) return;
      this._syncStarted = true;
      this.refresh().then(function () { self.flush(); });

      var t = null;
      this.client.channel('cup-all')
        .on('postgres_changes', { event: '*', schema: 'public' }, function () {
          clearTimeout(t); t = setTimeout(function () { self.refresh(); }, 250);
        })
        .subscribe(function (st) { self.status.realtime = st === 'SUBSCRIBED' ? 'live' : 'reconnecting'; self.emit('status'); });

      window.addEventListener('online', function () { self.status.online = true; self.flush().then(function () { self.refresh(); }); });
      window.addEventListener('offline', function () { self.status.online = false; self.emit('status'); });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') self.flush().then(function () { self.refresh(); });
      });
      setInterval(function () {
        self.flush();
        if (self.status.realtime !== 'live') self.refresh();
      }, 15000);
      setInterval(function () { self.refresh(); }, 60000);
    },

    _fetchAll: async function (table) {
      var all = [], from = 0, size = 1000;
      for (;;) {
        var res = await this.client.from(table).select('*').range(from, from + size - 1);
        if (res.error) throw res.error;
        all = all.concat(res.data || []);
        if (!res.data || res.data.length < size) break;
        from += size;
      }
      return all;
    },

    /** サーバーから全件取り直し（集計は常にこの生データから行う） */
    refresh: async function () {
      if (this.mode !== 'cloud' || !this.client || this._refreshing) return;
      this._refreshing = true;
      this.status.syncing = true; this.emit('status');
      try {
        var self = this, d = emptyData();
        var results = await Promise.all(NAMES.map(function (n) { return self._fetchAll(n); }));
        NAMES.forEach(function (n, i) { d[n] = results[i]; });
        this.data = d;
        this._replayOutbox();
        this.status.lastSync = nowISO(); this.status.online = true;
        writeLS(LS_CACHE, { data: this.data, role: this.role, at: this.status.lastSync });
        this.emit('data');
      } catch (e) {
        if (isNetworkError(e)) this.status.online = false;
        else this.emit('error', errMessage(e));
      } finally {
        this._refreshing = false; this.status.syncing = false; this.emit('status');
      }
    },

    _replayOutbox: function () {
      var d = this.data;
      this.outbox.forEach(function (op) { applyOp(d, op); });
    },

    /** 未送信の操作を順番にサーバーへ送る */
    flush: async function () {
      if (this.mode !== 'cloud' || !this.client || this._flushing || !this.outbox.length) return;
      this._flushing = true;
      var hadPermanentError = false;
      try {
        while (this.outbox.length) {
          var op = this.outbox[0], res;
          try {
            if (op.kind === 'upsert') res = await this.client.from(op.table).upsert(op.row);
            else res = await this.client.from(op.table).delete().eq(TABLES[op.table].pk, op.pk);
          } catch (e) { res = { error: e }; }
          if (res.error) {
            if (isNetworkError(res.error)) { this.status.online = false; break; }
            this.emit('error', errMessage(res.error));
            hadPermanentError = true;
          } else {
            this.status.online = true;
          }
          this.outbox.shift();
          writeLS(LS_OUTBOX, this.outbox);
        }
      } finally {
        this._flushing = false; this.emit('status');
      }
      if (hadPermanentError) await this.refresh();
    },

    _saveLocal: function () {
      if (!writeLS(LS_DATA, this.data)) this.emit('error', '端末の保存容量が不足しています。バックアップを書き出してください。');
    },

    _commit: function (op) {
      applyOp(this.data, op);
      if (this.mode === 'local') {
        this._saveLocal();
      } else {
        this.outbox.push(op);
        writeLS(LS_OUTBOX, this.outbox);
        writeLS(LS_CACHE, { data: this.data, role: this.role, at: this.status.lastSync });
        this.flush();
      }
      this.emit('data');
    },

    upsert: function (table, row) {
      if (!TABLES[table]) throw new Error('unknown table ' + table);
      var r = clone(row);
      if (TABLES[table].pk === 'id' && !r.id) r.id = uuid();
      if (!r.created_at) {
        var existing = this.find(table, r[TABLES[table].pk]);
        if (!existing) r.created_at = nowISO();
      }
      r.updated_at = nowISO();
      this._commit({ opId: uuid(), table: table, kind: 'upsert', row: r });
      return r;
    },

    remove: function (table, pk) {
      this._commit({ opId: uuid(), table: table, kind: 'delete', pk: pk });
    },

    find: function (table, pk) {
      var key = TABLES[table].pk;
      return this.data[table].find(function (r) { return r[key] === pk; }) || null;
    },

    /* ---------- 便利関数 ---------- */
    pointsConfig: function () {
      var s = this.data.settings.find(function (x) { return x.key === 'points'; });
      var v = s && s.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
      return (v && v.categories && v.categories.length) ? v : clone(DEFAULT_POINTS);
    },
    boats: function (includeInactive) {
      return this.data.boats.filter(function (b) { return includeInactive || b.active !== false; })
        .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name); });
    },
    tripNames: function () {
      return this.data.trip_names.slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    },
    days: function () {
      return this.data.event_days.slice().sort(function (a, b) { return a.event_date < b.event_date ? -1 : 1; });
    },
    trips: function (date) {
      var order = {};
      this.tripNames().forEach(function (t, i) { order[t.name] = i; });
      return this.data.trips.filter(function (t) { return !date || t.event_date === date; })
        .sort(function (a, b) {
          return a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 :
            String(a.start_time).localeCompare(String(b.start_time)) || (order[a.trip] || 0) - (order[b.trip] || 0);
        });
    },
    catchesOf: function (tripId, includeDeleted) {
      return this.data.catch_logs.filter(function (c) {
        return c.trip_id === tripId && (includeDeleted || !c.deleted_at);
      }).sort(function (a, b) { return a.caught_at < b.caught_at ? 1 : -1; });
    },

    /** 全データのJSON（バックアップ用） */
    exportJSON: function () {
      return { app: 'sawara-cup', version: 1, exported_at: nowISO(), data: clone(this.data) };
    },
    /** JSON復元（local: 置換 / cloud: upsert） */
    importJSON: function (obj) {
      if (!obj || !obj.data) throw new Error('バックアップファイルの形式が違います');
      if (this.mode === 'local') {
        var d = emptyData();
        NAMES.forEach(function (n) { d[n] = obj.data[n] || []; });
        this.data = d; this._saveLocal(); this.emit('data');
      } else {
        var self = this;
        ['settings', 'boats', 'trip_names', 'event_days', 'trips', 'catch_logs'].forEach(function (n) {
          (obj.data[n] || []).forEach(function (row) { self.upsert(n, row); });
        });
      }
    },
    resetLocal: function () {
      if (this.mode !== 'local') return;
      this.data = seedLocal(); this._saveLocal(); this.emit('data');
    }
  };

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) return resolve();
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('通信ライブラリを読み込めませんでした。電波の良い場所で再度開いてください。')); };
      document.head.appendChild(s);
    });
  }

  window.Store = Store;
})();
