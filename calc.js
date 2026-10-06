/* =========================================================
 * サワラ焼肉CUP — 集計ロジック（純粋関数）
 * 集計値は保存しない。毎回 CatchLog と Trip から計算する。
 * ブラウザ: window.Calc / Node: module.exports
 * ========================================================= */
(function (root) {
  'use strict';

  /** 小数誤差を丸める（0.1+0.2 対策） */
  function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }

  /** "HH:MM" または "HH:MM:SS" → 分 */
  function toMinutes(t) {
    if (!t || typeof t !== 'string') return null;
    var m = t.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  /**
   * 実釣時間（時間）。終了 < 開始 の場合は日付またぎ（夜便）として +24h。
   * 開始=終了 や不正値は 0。
   */
  function tripHours(start, end) {
    var s = toMinutes(start), e = toMinutes(end);
    if (s === null || e === null) return 0;
    var d = e - s;
    if (d < 0) d += 1440;
    return d / 60;
  }

  /** 削除済みを除いた有効な釣果 */
  function activeCatches(catches) {
    return (catches || []).filter(function (c) { return !c.deleted_at; });
  }

  /** SCORE = 総ポイント ÷ 人時 × 1000（人時0なら0：0除算防止） */
  function scoreOf(points, personHours) {
    if (!(personHours > 0)) return 0;
    return points / personHours * 1000;
  }

  /** 大会日×船×便 の集計 */
  function aggregateTrip(trip, catches) {
    var list = activeCatches(catches).filter(function (c) { return c.trip_id === trip.id; });
    var points = r2(list.reduce(function (a, c) { return a + (Number(c.points) || 0); }, 0));
    var people = Math.max(0, Number(trip.people) || 0);
    var hours = tripHours(trip.start_time, trip.end_time);
    var personHours = people * hours;
    return {
      trip: trip,
      count: list.length,
      points: points,
      people: people,
      hours: hours,
      personHours: personHours,
      // = 総ポイント ÷ 参加人数 ÷ 実釣時間 × 1000
      score: (people > 0 && hours > 0) ? points / people / hours * 1000 : 0
    };
  }

  /**
   * 複数便の合算（大会日×船、または全日程×船）
   * 各便のSCOREを足すのではなく、総ポイント ÷ 総人時 × 1000
   */
  function aggregateGroup(trips, catches) {
    var rows = (trips || []).map(function (t) { return aggregateTrip(t, catches); });
    var count = 0, points = 0, people = 0, hours = 0, personHours = 0;
    rows.forEach(function (r) {
      count += r.count; points += r.points; people += r.people;
      hours += r.hours; personHours += r.personHours;
    });
    points = r2(points);
    return {
      tripRows: rows,
      tripCount: rows.length,
      count: count,
      points: points,
      people: people,          // 延べ人数
      hours: hours,            // 実釣時間の合計
      personHours: personHours,
      score: scoreOf(points, personHours)
    };
  }

  /** サイズ区分ごとの本数 */
  function sizeBreakdown(trips, catches, categories) {
    var ids = {};
    (trips || []).forEach(function (t) { ids[t.id] = true; });
    var out = {};
    (categories || []).forEach(function (c) { out[c.label] = 0; });
    activeCatches(catches).forEach(function (c) {
      if (!ids[c.trip_id]) return;
      out[c.size_category] = (out[c.size_category] || 0) + 1;
    });
    return out;
  }

  /**
   * 船ごとのランキング
   * rows: [{boat, agg}] → 順位・メダル・DRAW判定を付けて返す
   * 便が1つもない船は順位対象外（rank=null）
   */
  function rankBoats(rows) {
    var EPS = 1e-6;
    var ranked = rows.filter(function (r) { return r.agg.tripCount > 0; })
      .sort(function (a, b) { return b.agg.score - a.agg.score; });
    var prev = null, prevRank = 0;
    ranked.forEach(function (r, i) {
      if (prev !== null && Math.abs(prev - r.agg.score) < EPS) {
        r.rank = prevRank;
      } else {
        r.rank = i + 1; prevRank = r.rank;
      }
      prev = r.agg.score;
    });
    ranked.forEach(function (r) {
      r.tied = ranked.filter(function (x) { return x.rank === r.rank; }).length > 1;
    });
    var unranked = rows.filter(function (r) { return r.agg.tripCount === 0; });
    unranked.forEach(function (r) { r.rank = null; r.tied = false; });

    var leaders = ranked.filter(function (r) { return r.rank === 1; });
    var anyScore = ranked.some(function (r) { return r.agg.score > 0; });
    var status;
    if (ranked.length === 0 || !anyScore) status = 'none';
    else if (leaders.length > 1) status = 'draw';
    else status = 'winner';

    return {
      rows: ranked.concat(unranked),
      leaders: leaders,
      status: status   // 'none' | 'draw' | 'winner'
    };
  }

  function medal(rank, tied) {
    if (rank == null) return '—';
    if (rank === 1 && tied) return '🤝';
    return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank + '位';
  }

  function fmtPoints(p) { return (Math.round((Number(p) || 0) * 10) / 10).toFixed(1); }
  function fmtScore(s) {
    if (!(s > 0)) return '0';
    var v = Math.round(s * 10) / 10;
    return (v % 1 === 0) ? String(v) : v.toFixed(1);
  }
  function fmtHours(h) {
    if (!(h > 0)) return '0h';
    var mins = Math.round(h * 60);
    var hh = Math.floor(mins / 60), mm = mins % 60;
    return mm ? hh + 'h' + String(mm).padStart(2, '0') : hh + 'h';
  }

  var Calc = {
    r2: r2, toMinutes: toMinutes, tripHours: tripHours, scoreOf: scoreOf,
    aggregateTrip: aggregateTrip, aggregateGroup: aggregateGroup,
    sizeBreakdown: sizeBreakdown, rankBoats: rankBoats, medal: medal,
    fmtPoints: fmtPoints, fmtScore: fmtScore, fmtHours: fmtHours,
    activeCatches: activeCatches
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(typeof window !== 'undefined' ? window : this);
