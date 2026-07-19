// dynamic_inn2place.js — 動的 inn_2place 補正モジュール【全艇対応版】
//
// 【設計方針】
//   既存コード（sample.js / top_stats.js）への変更は最小限。
//   _renderHistory30 の冒頭に1行追加するだけで動作する。
//
//     _applyDynamicInn2Place(allResultsScenAll); // ← これだけ追加
//
// 【何をするか】
//   過去30日の collectResultsForDateScen 結果（allResultsScenAll）から
//   会場別・winner艇別（1〜6号艇それぞれが1着だった場合）の
//   2着枠番出現率を実績集計し、
//   MASTER_EXT.venue_stats[venue].place2_dist[winnerBoat] を動的更新する。
//
//   [2026-06-24 修正] 旧版は「1号艇1着」のケースのみを対象にしていたが、
//   画像3のキャリブレーション結果（2〜6コース勝利時も2着的中率が
//   同程度に低い: 24〜36%）から、全winner艇で同様の補正が必要と判明。
//   そのため inn_2place（1号艇専用・後方互換用に維持）に加えて
//   venue_stats[venue].place2_dist = { '1': {...}, '2': {...}, ... }
//   という winner艇別の構造を新設する。
//
//   優先順位（既存コードの参照順と同一）:
//     ① DATA.inn_data.inn_2place  ← 当日レース表示時に使用（触らない、1号艇限定の旧仕様）
//     ② MASTER_EXT.venue_stats[venue].inn_2place ← 1号艇分・後方互換のため維持
//     ③ MASTER_EXT.venue_stats[venue].place2_dist[winnerBoat] ← 新設・全艇分
//
//   ①②は従来コードからの参照を壊さないために維持。
//   ③は calcScenarioData 等の呼び出し元が対応すれば全艇に展開できる
//   （place2_dist の利用箇所は呼び出し側の追加対応が別途必要）。
//
// 【ブレンド式】
//   動的値 = 実績値(直近30日) × W_DYNAMIC + 静的マスタ × (1 - W_DYNAMIC)
//   W_DYNAMIC: サンプル数に応じて 0〜MAX_W_DYNAMIC に線形増加
//   MIN_SAMPLES: これ未満の(会場×winner艇)組は補正しない（静的マスタのまま）
//
// 【安全策】
//   - MASTER_EXT が null / venue_stats がない場合は何もしない
//   - サンプル不足（< MIN_SAMPLES）の(会場×winner艇)組はスキップ
//   - 元の静的マスタを _inn2PlaceOriginal / _place2DistOriginal にバックアップ
//     → リロードで復元、_resetDynamicInn2Place() で手動リセットも可能
//   - 本モジュールは「表示・買い目生成」には影響しない
//     （当日レースは DATA.inn_data.inn_2place が優先されるため）
// ─────────────────────────────────────────────────────────────────────

(function () {

  // ── パラメータ ──
  const MIN_SAMPLES    = 20;   // (会場×winner艇)組ごとの最低サンプル数
  const MAX_W_DYNAMIC  = 0.60; // 動的値の最大ウェイト（サンプル数が十分な場合）
  const SATURATE_AT    = 100;  // このサンプル数でウェイトが MAX_W_DYNAMIC に達する
  const ALL_BOATS      = ['1', '2', '3', '4', '5', '6'];

  // 静的マスタのバックアップ（初回呼び出し時に保存）
  let _inn2PlaceOriginal  = null; // 後方互換: venue_stats[venue].inn_2place（1号艇専用）
  let _place2DistOriginal = null; // 新設: venue_stats[venue].place2_dist[winnerBoat]
  let _applied = false;

  // ── 公開関数 ──
  window._applyDynamicInn2Place = function (allResultsScenAll) {
    try {
      if (!MASTER_EXT || !MASTER_EXT.venue_stats) return;

      // 初回のみ静的マスタをディープコピーしてバックアップ
      if (!_inn2PlaceOriginal) {
        _inn2PlaceOriginal = {};
        Object.keys(MASTER_EXT.venue_stats).forEach(venue => {
          const orig = MASTER_EXT.venue_stats[venue]?.inn_2place;
          if (orig && typeof orig === 'object') {
            _inn2PlaceOriginal[venue] = { ...orig };
          }
        });
      }
      if (!_place2DistOriginal) {
        _place2DistOriginal = {};
        Object.keys(MASTER_EXT.venue_stats).forEach(venue => {
          const orig = MASTER_EXT.venue_stats[venue]?.place2_dist;
          if (orig && typeof orig === 'object') {
            _place2DistOriginal[venue] = {};
            Object.keys(orig).forEach(wb => {
              _place2DistOriginal[venue][wb] = { ...orig[wb] };
            });
          }
        });
      }

      // ── 実績集計（winner艇別）──
      // actualResult = "1-2-3" 形式
      // venueWinnerStats[venue][winnerBoat] = { _total, '2': count, ... }
      const venueWinnerStats = {};

      (allResultsScenAll || []).forEach(r => {
        if (!r.actualResult || !r.venue) return;
        const parts = r.actualResult.split('-');
        if (parts.length < 2) return;
        const winner = parts[0]; // 1着枠番（'1'〜'6'）
        const second = parts[1]; // 2着枠番
        if (!ALL_BOATS.includes(winner)) return;

        if (!venueWinnerStats[r.venue]) venueWinnerStats[r.venue] = {};
        if (!venueWinnerStats[r.venue][winner]) venueWinnerStats[r.venue][winner] = { _total: 0 };
        venueWinnerStats[r.venue][winner]._total++;
        venueWinnerStats[r.venue][winner][second] = (venueWinnerStats[r.venue][winner][second] || 0) + 1;
      });

      // ── ブレンド計算の共通ヘルパー ──
      // staticBase: { '2': rate, '3': rate, ... }（合計1.0前提、欠損可）
      // stat: { _total, '2': count, ... }（実績カウント）
      function _blendOne(stat, staticBase) {
        const total = stat._total;
        const wDynamic = Math.min(MAX_W_DYNAMIC, (total / SATURATE_AT) * MAX_W_DYNAMIC);
        const wStatic  = 1 - wDynamic;

        const dynamicRates = {};
        ALL_BOATS.forEach(boat => { dynamicRates[boat] = (stat[boat] || 0) / total; });

        const blended = {};
        ALL_BOATS.forEach(boat => {
          const dyn = dynamicRates[boat];
          const stat_val = staticBase[boat] ?? null;
          blended[boat] = (stat_val != null)
            ? dyn * wDynamic + stat_val * wStatic
            : dyn * wDynamic; // 静的マスタにない枠番は動的値のみ
        });

        const blendedTotal = Object.values(blended).reduce((s, v) => s + v, 0) || 1;
        Object.keys(blended).forEach(k => { blended[k] = blended[k] / blendedTotal; });
        return blended;
      }

      // ── ① 後方互換: venue_stats[venue].inn_2place（1号艇のみ）を従来通り更新 ──
      Object.keys(venueWinnerStats).forEach(venue => {
        const stat1 = venueWinnerStats[venue]['1'];
        if (!stat1 || stat1._total < MIN_SAMPLES) return;
        const staticBase = _inn2PlaceOriginal[venue] || {};
        const blended = _blendOne(stat1, staticBase);
        if (!MASTER_EXT.venue_stats[venue]) MASTER_EXT.venue_stats[venue] = {};
        MASTER_EXT.venue_stats[venue].inn_2place = blended;
      });

      // ── ② 新設: venue_stats[venue].place2_dist[winnerBoat] を全艇分更新 ──
      Object.keys(venueWinnerStats).forEach(venue => {
        ALL_BOATS.forEach(winner => {
          const stat = venueWinnerStats[venue][winner];
          if (!stat || stat._total < MIN_SAMPLES) return; // サンプル不足はスキップ

          // 静的マスタ: 1号艇は inn_2place を流用、他艇は既存 place2_dist があれば使う
          const staticBase = (winner === '1')
            ? (_inn2PlaceOriginal[venue] || {})
            : (_place2DistOriginal[venue]?.[winner] || {});

          const blended = _blendOne(stat, staticBase);

          if (!MASTER_EXT.venue_stats[venue]) MASTER_EXT.venue_stats[venue] = {};
          if (!MASTER_EXT.venue_stats[venue].place2_dist) MASTER_EXT.venue_stats[venue].place2_dist = {};
          MASTER_EXT.venue_stats[venue].place2_dist[winner] = blended;
        });
      });

      _applied = true;

    } catch (e) {
      console.warn('[dynamic_inn2place] エラー:', e);
    }
  };

  // ── 当日レース用ブレンド関数 ──
  // selectRace() の冒頭に以下を1行追加するだけで動作する:
  //   if (typeof _blendInnDataInn2Place === 'function') _blendInnDataInn2Place();
  //
  // DATA.inn_data.inn_2place（当日個別データ・1号艇専用の旧仕様）と
  // MASTER_EXT.venue_stats[venue].inn_2place（動的補正済み会場値）を
  // W_LIVE_BLEND の比率でブレンドして DATA.inn_data.inn_2place を上書きする。
  //
  // [注] DATA.inn_data.inn_2place は1号艇1着専用の当日データのため、
  //      ここでは①②の後方互換構造のみを使う（③ place2_dist は対象外）。
  //
  // W_LIVE_BLEND: 動的補正値のウェイト（0=当日データのみ、1=動的補正のみ）
  // 当日データの信頼性が高いため控えめな値を推奨。

  const W_LIVE_BLEND = 0.25; // 動的補正値のウェイト（25%）

  window._blendInnDataInn2Place = function () {
    try {
      if (!DATA || !DATA.inn_data) return;
      if (!MASTER_EXT?.venue_stats?.[DATA.venue]?.inn_2place) return;

      const liveVal = DATA.inn_data.inn_2place;
      if (!liveVal || typeof liveVal !== 'object' || Array.isArray(liveVal)) return;
      if (Object.keys(liveVal).length === 0) return;

      const dynamicVal = MASTER_EXT.venue_stats[DATA.venue].inn_2place;

      const blended = {};
      ['2', '3', '4', '5', '6'].forEach(boat => {
        const live = liveVal[boat] ?? null;
        const dyn  = dynamicVal[boat] ?? null;
        if (live != null && dyn != null) {
          blended[boat] = live * (1 - W_LIVE_BLEND) + dyn * W_LIVE_BLEND;
        } else if (live != null) {
          blended[boat] = live;
        } else if (dyn != null) {
          blended[boat] = dyn * W_LIVE_BLEND;
        }
      });

      // 正規化
      const total = Object.values(blended).reduce((s, v) => s + v, 0) || 1;
      Object.keys(blended).forEach(k => { blended[k] = blended[k] / total; });

      DATA.inn_data.inn_2place = blended;

    } catch (e) {
      console.warn('[dynamic_inn2place] _blendInnDataInn2Place エラー:', e);
    }
  };

  // ── リセット関数（デバッグ用）──
  // 静的マスタに戻したいときは _resetDynamicInn2Place() をコンソールで実行
  window._resetDynamicInn2Place = function () {
    if (!MASTER_EXT?.venue_stats) return;
    if (_inn2PlaceOriginal) {
      Object.keys(_inn2PlaceOriginal).forEach(venue => {
        if (MASTER_EXT.venue_stats[venue]) {
          MASTER_EXT.venue_stats[venue].inn_2place = { ..._inn2PlaceOriginal[venue] };
        }
      });
    }
    if (_place2DistOriginal) {
      Object.keys(_place2DistOriginal).forEach(venue => {
        if (MASTER_EXT.venue_stats[venue]) {
          MASTER_EXT.venue_stats[venue].place2_dist = {};
          Object.keys(_place2DistOriginal[venue]).forEach(wb => {
            MASTER_EXT.venue_stats[venue].place2_dist[wb] = { ..._place2DistOriginal[venue][wb] };
          });
        }
      });
    }
    _applied = false;
    console.log('[dynamic_inn2place] 静的マスタにリセットしました');
  };

})();

