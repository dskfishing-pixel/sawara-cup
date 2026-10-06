/* =========================================================
 * サワラ焼肉CUP — 潮汐（最寄り港の自動選択・端末内保存）
 * データは /api/tide（tide736.net の中継）から取得し、端末に保存する。
 * 圏外でも、保存済みの日・港なら表示できる。
 * ========================================================= */
(function () {
  'use strict';
  var LS_PORTS = 'scup:tideports:v1';
  var LS_DATA = 'scup:tide:v1';
  var PREFS = '34,35,38';                                // 広島・山口・愛媛
  var DEFAULT = { name: '岩国', lat: 34.172, lon: 132.236 }; // GPSが使えない時の基本の港
  var SWITCH_MARGIN_KM = 1.0;                            // これ以上近い港が出たら切り替え
  var EVAL_INTERVAL_MS = 120000;                         // 位置の再評価は最短2分おき
  var PREFETCH_RADIUS_KM = 25;

  function readLS(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function key(p) { return p.pc + '-' + p.hc; }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  function distKm(a, b) {
    var R = 6371, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  var Tide = {
    ports: null,
    data: readLS(LS_DATA, {}),
    pos: null,              // {lat, lon, acc, at}
    posState: 'off',        // off | waiting | ok | denied | unavailable
    current: null,          // 表示中の港
    portsState: 'idle',     // idle | loading | ok | error
    inflight: {},
    failedAt: {},
    watchId: null,
    lastEval: null,
    prefetched: false,
    onUpdate: function () {},
    distKm: distKm,
    DEFAULT: DEFAULT,

    init: function (onUpdate) {
      this.onUpdate = onUpdate || this.onUpdate;
      var cached = readLS(LS_PORTS, null);
      if (cached && cached.ports && cached.ports.length && Date.now() - cached.at < 30 * 86400000) {
        this.ports = cached.ports; this.portsState = 'ok';
      }
      this.pruneOld();
    },

    loadPorts: function () {
      var self = this;
      if (this.portsState === 'loading' || (this.portsState === 'ok' && this.ports)) return;
      if (this.failedAt.ports && Date.now() - this.failedAt.ports < 60000) return;
      if (!navigator.onLine && !this.ports) { this.portsState = 'error'; return; }
      this.portsState = 'loading';
      fetch('/api/tide?ports=' + PREFS).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok || !j.ports || !j.ports.length) throw new Error(j.error || 'no ports');
        self.ports = j.ports; self.portsState = 'ok';
        writeLS(LS_PORTS, { at: Date.now(), ports: j.ports });
        self.onUpdate();
      }).catch(function () {
        self.failedAt.ports = Date.now();
        self.portsState = self.ports ? 'ok' : 'error';
        self.onUpdate();
      });
    },

    /** 基準点に近い順の港一覧 */
    near: function (ref, n) {
      if (!this.ports) return [];
      return this.ports.map(function (p) { return { port: p, km: distKm(ref, p) }; })
        .sort(function (a, b) { return a.km - b.km; }).slice(0, n || 999);
    },

    defaultPort: function () {
      if (!this.ports) return null;
      var byName = this.ports.filter(function (p) { return p.name === DEFAULT.name || p.name === DEFAULT.name + '港'; });
      if (byName.length) return byName[0];
      var n = this.near(DEFAULT, 1)[0];
      return n ? n.port : null;
    },

    /** 表示する港を決める（手動 → GPS自動 → 基本の港） */
    pick: function (mode, manualKey) {
      if (!this.ports) return null;
      var self = this, p = null;
      if (mode === 'manual' && manualKey) {
        p = this.ports.filter(function (x) { return key(x) === manualKey; })[0] || null;
      }
      if (!p && mode !== 'manual' && this.pos) {
        var best = this.near(this.pos, 1)[0];
        var cur = this.current && this.ports.filter(function (x) { return key(x) === key(self.current); })[0];
        if (best && cur && key(cur) !== key(best.port) && distKm(this.pos, cur) - best.km < SWITCH_MARGIN_KM) p = cur; // 境目で行ったり来たりしない
        else if (best) p = best.port;
      }
      if (!p) p = this.defaultPort();
      this.current = p;
      return p;
    },

    reference: function () { return this.pos || DEFAULT; },

    day: function (port, date) {
      var d = port && this.data[key(port)];
      return (d && d[date]) || null;
    },

    /** その日の潮汐が無ければ取得（30日分まとめて保存） */
    ensure: function (port, date) {
      if (!port || !date || this.day(port, date)) return;
      this.fetchRange(port, date);
    },

    fetchRange: function (port, date) {
      var self = this, k = key(port) + '@' + date;
      if (this.inflight[k] || !navigator.onLine) return Promise.resolve(false);
      if (this.failedAt[k] && Date.now() - this.failedAt[k] < 60000) return Promise.resolve(false);
      this.inflight[k] = true;
      return fetch('/api/tide?pc=' + port.pc + '&hc=' + port.hc + '&date=' + date + '&rg=month')
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok || !j.days) throw new Error(j.error || 'no data');
          var bucket = self.data[key(port)] || (self.data[key(port)] = {});
          Object.keys(j.days).forEach(function (d) { bucket[d] = j.days[d]; });
          writeLS(LS_DATA, self.data);
          delete self.inflight[k];
          self.onUpdate();
          return true;
        })
        .catch(function () { delete self.inflight[k]; self.failedAt[k] = Date.now(); self.onUpdate(); return false; });
    },

    isLoading: function (port, date) { return !!this.inflight[key(port) + '@' + date]; },

    /** 陸にいるうちに、大会日の周辺の港をまとめて保存しておく（圏外対策） */
    prefetch: function (dates) {
      if (this.prefetched || !this.ports || !navigator.onLine || !dates.length) return;
      this.prefetched = true;
      var self = this;
      var ports = this.near(this.reference(), 12).filter(function (x) { return x.km <= PREFETCH_RADIUS_KM; }).map(function (x) { return x.port; });
      var cur = this.current; if (cur && ports.indexOf(cur) < 0) ports.unshift(cur);
      var jobs = [];
      ports.forEach(function (p) {
        var missing = dates.filter(function (d) { return !self.day(p, d); });
        if (missing.length) jobs.push([p, missing[0]]);
      });
      (function next() {                       // 1件ずつ（相手のサーバーに負担をかけない）
        var j = jobs.shift(); if (!j) return;
        self.fetchRange(j[0], j[1]).then(function () { setTimeout(next, 400); });
      })();
    },

    startWatch: function () {
      var self = this;
      if (this.watchId !== null || !('geolocation' in navigator)) { if (!('geolocation' in navigator)) this.posState = 'unavailable'; return; }
      if (this.posState === 'denied') return;
      this.posState = this.pos ? 'ok' : 'waiting';
      this.watchId = navigator.geolocation.watchPosition(function (g) {
        var p = { lat: g.coords.latitude, lon: g.coords.longitude, acc: g.coords.accuracy, at: Date.now() };
        var moved = !self.lastEval || distKm(self.lastEval, p) > 0.3;
        var stale = !self.lastEval || Date.now() - self.lastEval.at > EVAL_INTERVAL_MS;
        self.pos = p; self.posState = 'ok';
        if (moved || stale || !self.lastEval) { self.lastEval = p; self.onUpdate(); }
      }, function (err) {
        self.posState = err.code === 1 ? 'denied' : 'unavailable';
        if (err.code === 1) self.stopWatch();
        self.onUpdate();
      }, { enableHighAccuracy: false, maximumAge: 120000, timeout: 30000 });
    },

    stopWatch: function () {
      if (this.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    },

    pruneOld: function () {
      var cut = ymd(new Date(Date.now() - 7 * 86400000)), changed = false, self = this;
      Object.keys(this.data).forEach(function (k) {
        Object.keys(self.data[k]).forEach(function (d) { if (d < cut) { delete self.data[k][d]; changed = true; } });
        if (!Object.keys(self.data[k]).length) { delete self.data[k]; changed = true; }
      });
      if (changed) writeLS(LS_DATA, this.data);
    },

    key: key
  };

  window.Tide = Tide;
})();
