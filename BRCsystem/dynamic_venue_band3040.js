// dynamic_venue_band3040.js — 会場別 30〜40%帯 過大評価バイアスの動的補正モジュール
//
// 【背景】
//   prob_scenario_engine.py の _VENUE_BAND3040_COEF は 2026-06-25 の
//   1回限りのスクショ診断（会場ごと数件〜十数件）で固定した係数テーブル。
//   1週間後の実績（2026-07-02診断）と比較すると、徳山・三国など複数会場で
//   過大評価⇔過小評価の「方向」自体が反転しており、固定係数はもはや実態と
//   合っていない。会場別の30-40%帯サンプルは元々不安定（小サンプル）なので、
//   固定値で凍結するのではなく dynamic_inn2place.js と同じ「サンプル数に
//   応じて重みを連動させる自己学習」方式に置き換える。
//
// 【対象が異なる点に注意】
//   Python版は艇別勝率 bt["prob"]（コース別1着率）を補正しているが、
//   会場別の過大評価を実測しているcalibration.jsの診断パネル
//   （🔍 30〜40%帯 過大評価 内訳調査）は computeScenCombosWithEV の
//   hitProbEst（シナリオ買い目全体の的中確率推定）を集計対象にしている。
//   対象がズレたままでは学習データと補正対象が矛盾するため、
//   本モジュールは hitProbEst に対して補正をかける（＝Python版とは別レイヤー。
//   Python側の静的テーブルと併用しても構わないが、将来的には本モジュールの
//   学習結果を元に Python側テーブルも定期更新する運用に寄せるのが望ましい）。
//
// 【二重補正対策】
//   computeScenCombosWithEV.js は既に calibrateProb()（全会場共通の
//   区分線形補正）を hitProbEst に適用済み。本モジュールはその「後」に
//   会場ごとの残差だけを追加補正する。基準値は固定0.35ではなく、
//   その時点の「全会場平均の実績的中率」を使うことで、calibrateProb側の
//   全体補正と二重に効いて過補正するのを防ぐ（＝会場間の相対的なズレだけを補正）。
//
// 【設計方針（dynamic_inn2place.js を踏襲）】
//   動的係数 = 会場実績率 / 全会場平均実績率
//   ウェイト  = サンプル数に応じて 0 → MAX_W_DYNAMIC へ線形増加
//   ブレンド  = 動的係数 × wDynamic + 1.0(無補正) × (1 - wDynamic)
//   MIN_SAMPLES 未満の会場は補正なし（1.0）のまま
//   係数は [COEF_MIN, COEF_MAX] にクリップして極端な補正を防止
//
// 【使い方（既存コードへの変更は最小限）】
//   ① このファイルを computeScenCombosWithEV.js より後に読み込む
//      （collectResultsForDateScen の二重ラップ順を保証するため）
//   ② top_stats.js の _renderHistory30 冒頭、_applyDynamicInn2Place の
//      近くに1行追加するだけ:
//
//        if (typeof _applyDynamicInn2Place === 'function') _applyDynamicInn2Place(allResultsScenAll);
//        if (typeof _updateVenueBand3040Coefs === 'function') _updateVenueBand3040Coefs(allResultsScenAll); // ← これを追加
//
//   これだけで、以後 collectResultsForDateScen が返す hitProbEst / ev が
//   会場別補正込みの値になり、EV1.1フィルタ等の買い目選定にも反映される。
//
// 【安全策】
//   - 全体サンプル不足（<MIN_TOTAL_SAMPLES_HARD件）の日は学習をスキップ
//   - 会場ごとにサンプル不足（<MIN_SAMPLES件）ならその会場は補正なしのまま
//   - 崩壊値（NaN・0以下等）は反映せず、既存の学習結果を維持
//   - 学習には補正適用前の値のみを使用（自己崩壊ループ対策）
//   - localStorage に永続化 → リロードしても即座に前回の学習結果を反映
//   - _resetVenueBand3040() でいつでも手動リセット可能
// ─────────────────────────────────────────────────────────────────────

(function () {

  // ── パラメータ ──
  const MIN_SAMPLES            = 20;   // 会場ごとの最低サンプル数（未満は補正なし）
  const MAX_W_DYNAMIC          = 0.60; // 動的値の最大ウェイト
  const SATURATE_AT            = 100;  // このサンプル数でウェイトが MAX_W_DYNAMIC に到達
  const COEF_MIN                = 0.60;
  const COEF_MAX                = 1.40;
  const BAND_MIN                = 0.30; // 対象帯（hitProbEst）
  const BAND_MAX                = 0.40;
  const MIN_TOTAL_SAMPLES_HARD  = 100;  // 全会場合計がこれ未満の日は学習自体をスキップ
  const LS_KEY                  = 'scen_calib_venue_band3040_v1';

  let _venueCoef = {}; // { venue: coef(number) } ランタイム参照用
  let _venueMeta = {}; // { venue: {coef,total,hits,actual,globalRate,updatedAt} } localStorage永続化・デバッグ表示用

  window._venueBand3040Meta = _venueMeta; // コンソールから中身を確認できるように公開

  // ── localStorage から復元（前回学習結果を即時反映）──
  function _loadFromLS() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      Object.entries(parsed).forEach(([venue, entry]) => {
        const c = entry?.coef;
        if (typeof c === 'number' && !isNaN(c) && c >= COEF_MIN && c <= COEF_MAX) {
          _venueCoef[venue] = c;
          _venueMeta[venue] = entry;
        }
      });
    } catch (_e) { /* プライベートブラウズ等でlocalStorage使用不可の場合は無視 */ }
  }
  _loadFromLS();

  function _saveToLS() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(_venueMeta)); } catch (_e) { /* 保存失敗は無視 */ }
  }

  // ── 公開: 会場別補正係数の取得（未学習・サンプル不足の会場は1.0=補正なし）──
  window.getVenueBand3040Coef = function (venue) {
    return _venueCoef[venue] ?? 1.0;
  };

  // ── 内部: hitProbEstが対象帯(0.30〜0.40)の場合のみ会場係数を適用 ──
  function _applyCoefToHitProbEst(hitProbEst, venue) {
    if (hitProbEst == null || hitProbEst < BAND_MIN || hitProbEst >= BAND_MAX) return hitProbEst;
    const coef = window.getVenueBand3040Coef(venue);
    if (Math.abs(coef - 1.0) < 0.001) return hitProbEst;
    return Math.max(0, Math.min(1, hitProbEst * coef));
  }
  window._applyVenueBand3040ToHitProbEst = _applyCoefToHitProbEst; // 他モジュール/デバッグ用に公開

  // ── 公開: allResultsScenAll から会場別係数を再学習する ──
  // _renderHistory30 の冒頭で毎回呼ぶ想定（dynamic_inn2place.js と同じ呼び出しパターン）。
  window._updateVenueBand3040Coefs = function (allResultsScenAll) {
    try {
      const list = allResultsScenAll || [];

      // ── 学習には「本モジュールの補正が効く前」の値を使う（自己崩壊ループ対策）──
      // _preVenueBand3040HitProbEst は下部の collectResultsForDateScen パッチが
      // 補正適用前に保存するフィールド。まだパッチが効いていない初回等は
      // hitProbEst（= calibrateProb適用後・本モジュール未適用の生値）で代替する。
      const band = list.filter(r => {
        const p = r._preVenueBand3040HitProbEst ?? r.hitProbEst;
        return p != null && p >= BAND_MIN && p < BAND_MAX && r.venue;
      });

      const totalAll = band.length;
      if (totalAll < MIN_TOTAL_SAMPLES_HARD) {
        return; // 全体サンプル不足のため今回は学習を見送り、既存の係数を維持
      }

      // ── 基準値: 全会場平均の実績的中率 ──
      const globalHits = band.filter(r => r.isHit).length;
      const globalRate = globalHits / totalAll;
      if (!(globalRate > 0) || isNaN(globalRate)) return; // 崩壊値ガード

      // ── 会場別集計 ──
      const venueMap = {};
      band.forEach(r => {
        const v = r.venue;
        if (!venueMap[v]) venueMap[v] = { total: 0, hits: 0 };
        venueMap[v].total++;
        if (r.isHit) venueMap[v].hits++;
      });

      const now = new Date().toISOString();

      Object.entries(venueMap).forEach(([venue, s]) => {
        if (s.total < MIN_SAMPLES) return; // サンプル不足会場はスキップ（既存値を維持）

        const actualRate = s.hits / s.total;
        if (isNaN(actualRate)) return;

        // サンプル数に応じて0〜MAX_W_DYNAMICへ線形増加するウェイト
        const wDynamic = Math.min(MAX_W_DYNAMIC, (s.total / SATURATE_AT) * MAX_W_DYNAMIC);

        // 会場実績 / 全会場平均 = 相対バイアス係数（動的値）
        const rawCoef = actualRate / globalRate;
        // 1.0（無補正）とブレンド → クリップ
        const blended = rawCoef * wDynamic + 1.0 * (1 - wDynamic);
        const coef    = Math.max(COEF_MIN, Math.min(COEF_MAX, blended));
        if (isNaN(coef)) return; // 崩壊値ガード

        _venueCoef[venue] = coef;
        _venueMeta[venue] = {
          coef, total: s.total, hits: s.hits,
          actual: actualRate, globalRate, updatedAt: now,
        };
      });

      _saveToLS();
    } catch (e) {
      console.warn('[dynamic_venue_band3040] 更新エラー:', e);
    }
  };

  // ── collectResultsForDateScen への二重パッチ ──
  // computeScenCombosWithEV.js の §4パッチ（pred2ndRank/hitProbEst上書き）が
  // 既に1回ラップしているため、本モジュールは別フラグ(_band3040Patched)で
  // さらに1段ラップする（二重ラップガードは互いに独立）。
  function _applyBand3040Patch() {
    if (typeof collectResultsForDateScen !== 'function') return;
    if (collectResultsForDateScen._band3040Patched) return;

    const _orig = collectResultsForDateScen;
    window.collectResultsForDateScen = function (dateStr, includeAll) {
      const results = _orig.call(this, dateStr, includeAll);
      if (!Array.isArray(results)) return results;

      results.forEach(r => {
        if (r.hitProbEst == null || !r.venue) return;

        // 学習用に「本モジュールの補正前」の値を保存。
        // §4パッチの _rawHitProbEst（calibrateProb適用前）とは別物で、
        // こちらは calibrateProb 適用後・本モジュール適用前の値。
        r._preVenueBand3040HitProbEst = r.hitProbEst;

        const corrected = _applyCoefToHitProbEst(r.hitProbEst, r.venue);
        if (corrected !== r.hitProbEst) {
          r.hitProbEst = corrected;
          r.hitRate    = corrected; // hitRate は hitProbEst の別名（top_stats.js 慣例）
          if (r.synth != null) r.ev = r.synth * corrected; // EVフィルタにも反映
        }
      });

      return results;
    };
    window.collectResultsForDateScen._band3040Patched = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _applyBand3040Patch);
  } else {
    _applyBand3040Patch();
  }
  // computeScenCombosWithEV.js 側の§4パッチも DOMContentLoaded 時に適用されるため、
  // 読み込み順が前後した場合の保険として次のタスクでもう一度試行する。
  setTimeout(_applyBand3040Patch, 0);

  // ── デバッグ用: 現在の学習状況をコンソール表示 ──
  window._debugVenueBand3040 = function () {
    const rows = Object.entries(_venueMeta)
      .map(([venue, m]) => ({
        venue,
        件数: m.total,
        実績: (m.actual * 100).toFixed(1) + '%',
        全会場平均: (m.globalRate * 100).toFixed(1) + '%',
        係数: m.coef.toFixed(3),
        更新日時: m.updatedAt,
      }))
      .sort((a, b) => a.係数 - b.係数);
    console.table(rows);
    return rows;
  };

  // ── デバッグ用リセット ──
  window._resetVenueBand3040 = function () {
    _venueCoef = {};
    _venueMeta = {};
    try { localStorage.removeItem(LS_KEY); } catch (_e) {}
    console.log('[dynamic_venue_band3040] 補正をリセットしました（次回 _updateVenueBand3040Coefs 呼び出しで再学習されます）');
  };

})();
