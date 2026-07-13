// ══════════════════════════════════════════════════════════════════════════════
// computeScenCombosWithEV.js  — シナリオ買い目 + EV + 2着/3着予測（完全実装版）
//
// 【解決する問題】
//
//   問題① pred2ndRank / pred3rdRank が「頻度ベース」で誤判定
//          → scenarioPlace2 の p2 × シナリオ重み の加重確率ベースに変更
//
//   問題② computeScenCombosWithEV が未実装
//          → calcScenarioData / calcScenarioComboProb を内部で呼び出し正式実装
//
//   問題③ hitProbEst が系統的に過小評価（実測で +10〜17% のズレ）
//          → Platt Scaling 的なビン補間キャリブレーションで補正
//
//   問題④ 買い目点数が buildScenarioBuyPanel と食い違う（常に2軸18点で固定）
//          → _confRank（HIGH/MID/LOW）と _allow2ndAxis（fp差ゲート）を追加し
//            buildScenarioBuyPanel 通常モードと完全一致させた
//            HIGH(HHI≥0.55 かつ fp≥0.50): 1軸最大12点
//            MID/LOW かつ fp差>15%pt     : 1軸最大12点
//            MID/LOW かつ fp差≤15%pt     : 2軸最大18点（重複除去後16〜18点）
//
// 【使い方】
//   このファイルを sample.js / top_stats.js より後に <script> で読み込むだけ。
//   既存コードの変更は一切不要。
//
//   top_stats.js の collectResultsForDateScen から呼ばれる:
//     computeScenCombosWithEV(venue, vdata, rno)
//   戻り値:
//     {
//       combos      : string[],          // 買い目文字列（例: "1-2-3"）
//       hitProbEst  : number|null,       // キャリブレーション補正済み的中確率
//       synthOdds   : number|null,       // 合成オッズ（参考）
//       ev          : number|null,       // 期待値 = synthOdds × hitProbEst
//       pred2ndRank : number|null,       // 実際の2着枠番が「加重確率」で何位だったか
//       pred3rdRank : number|null,       // 実際の3着枠番が「加重確率」で何位だったか
//       weighted2nd : object,            // { boat: 加重確率合計 } デバッグ用
//       weighted3rd : object,            // { boat: 加重確率合計 } デバッグ用
//     }
//
// ══════════════════════════════════════════════════════════════════════════════

(function () {

  // ─────────────────────────────────────────────────────────────────────────
  // § 1  キャリブレーション補正テーブル
  //       実測データ（3096件）から構築した推定→実績のマッピング
  //       Platt Scaling / Isotonic Regression に相当する区分線形補間
  //
  //  【統計的根拠】
  //   モデルが確率を過小評価している原因:
  //     1. calcScenarioComboProb は kimari × p2 × r3 の三重積
  //        → 各確率が独立でないのに掛け合わせると系統的に低くなる
  //     2. scenarioProb の正規化前残差が圧縮されている
  //   補正により「実態に即した的中確率」を返すことで EV 計算の精度が上がる。
  //
  //  ビン定義: [推定平均, 実績率] の対応点（線形補間用）
  //  ※ 実測値に合わせて更新すること（calibration.js のパネルを参照）
  // ─────────────────────────────────────────────────────────────────────────
  // ── サニティチェック用パラメータ ──
  // [2026-06-20 追加] 自己崩壊ループ対策。
  // 「高確率ビンの実績が極端に低い」点はデータ不足/一時的偏りによる
  // 崩壊値とみなし、補正テーブルへの反映・復元から除外する。
  const HIGH_PROB_BIN_MIN          = 0.40; // これ以上の推定値を「高確率帯」とみなす
  const EXTREME_LOW_ACTUAL_THRESH  = 0.05; // 高確率帯でこれ以下の実績率は異常とみなす

  /**
   * CALIB_POINTS（またはロード直後の生データ）が「正常」かどうかを判定する。
   * 異常と判定された場合は使用せず、デフォルトテーブルにフォールバックする。
   */
  function _isSaneCalibPoints(points) {
    if (!Array.isArray(points) || points.length < 3) return false;
    for (const pt of points) {
      if (!Array.isArray(pt) || pt.length < 2) return false;
      const [x, y] = pt;
      if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) return false;
      if (x < 0 || x > 1 || y < 0 || y > 1) return false;
      // 高確率帯で実績が崩壊している点が含まれていたらテーブル全体を不採用にする
      if (x >= HIGH_PROB_BIN_MIN && y <= EXTREME_LOW_ACTUAL_THRESH) return false;
    }
    return true;
  }

  // localStorage キー
  // [2026-06-20 修正] 二重補正バグにより v1 キーには「自分自身の出力を学習し続けた」
  // 崩壊済みテーブルが保存されている可能性が高いため、キーをバージョンアップして
  // クリーンな状態から再構築する（v1 の汚染データはこのファイルの読み込み時に破棄する）。
  const _CALIB_LS_KEY_LEGACY = 'scen_calib_points_v1';
  const _CALIB_LS_KEY        = 'scen_calib_points_v4';

  // ── 汚染データの強制クレンジング（使い捨てリセット）──
  // 旧バージョンのキーが残っていた場合は問答無用で削除する。
  // 新バージョン側のキーであっても、内容が異常（崩壊）と判定された場合は削除する。
  (function _cleanupCorruptedCalibData() {
    try {
      if (localStorage.getItem(_CALIB_LS_KEY_LEGACY) != null) {
        localStorage.removeItem(_CALIB_LS_KEY_LEGACY);
        console.warn(`[computeScenCombosWithEV] 旧キー(${_CALIB_LS_KEY_LEGACY})の汚染済み補正テーブルを破棄しました。`);
      }
      // [2026-06-25] v2キーも旧キー扱いで破棄（60日データで再学習させるため）
      if (localStorage.getItem('scen_calib_points_v2') != null) {
        localStorage.removeItem('scen_calib_points_v2');
        console.warn('[computeScenCombosWithEV] 旧キー(scen_calib_points_v2)を破棄しました（60日再学習のため）。');
      }
      // [2026-06-25] v3キーも旧キー扱いで破棄
      // （analyzer.jsのcalcTenkaiProbs刷新後も旧ロジック時代の補正テーブルが
      //   そのまま新ロジックの生値を上書きしてしまっていたため、v4へ移行し
      //   デフォルトを補正なし(y=x)にリセットして再学習させる）
      if (localStorage.getItem('scen_calib_points_v3') != null) {
        localStorage.removeItem('scen_calib_points_v3');
        console.warn('[computeScenCombosWithEV] 旧キー(scen_calib_points_v3)を破棄しました（新ロジック移行に伴う再学習のため）。');
      }
      const rawV2 = localStorage.getItem(_CALIB_LS_KEY);
      if (rawV2) {
        const parsedV2 = JSON.parse(rawV2);
        if (!_isSaneCalibPoints(parsedV2)) {
          localStorage.removeItem(_CALIB_LS_KEY);
          console.warn(`[computeScenCombosWithEV] ${_CALIB_LS_KEY} の内容が異常（崩壊値）と判定されたため破棄しました。`, parsedV2);
        }
      }
    } catch (_e) {}
  })();

  // localStorage から復元を試みる（起動時に前回の実測値を即時反映）
  function _loadCalibFromLS() {
    try {
      const raw = localStorage.getItem(_CALIB_LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (_isSaneCalibPoints(parsed)) {
        return parsed;
      }
      console.warn('[computeScenCombosWithEV] localStorage の補正テーブルが異常なため復元をスキップし、デフォルトを使用します。');
    } catch (_e) {}
    return null;
  }

  const CALIB_POINTS = _loadCalibFromLS() || [
    // [2026-06-25] 新ロジック(calcTenkaiProbs刷新)への移行に伴い、
    // 旧ロジック時代の実測値(推定35%→実績18%等)で生値を潰していた問題を解消するため、
    // デフォルトを「補正なし(y=x)」にリセット。
    // calibration.js パネルに新ロジックの実測値が十分蓄積された時点で、
    // localStorage(v4)側に学習結果が自動的に保存され、以後はそちらが使われる。
    [0.00, 0.00],
    [1.00, 1.00],
  ];
  window.CALIB_POINTS = CALIB_POINTS; // calibration.js のJSON書き出しボタンから参照するため公開

  /**
   * 区分線形補間でキャリブレーション補正を適用する。
   *
   * @param {number} rawProb  モデルの生確率 (0〜1)
   * @returns {number}        補正後の確率 (0〜1)
   *
   * 【設計方針】
   *   CALIB_POINTS は calibration.js パネルの実測値を手動転記する。
   *   将来的には localStorage に保存した binStats JSON から自動更新可能。
   *   補正は「一方向のみ上昇」ではなく双方向に対応（万一逆転が起きた場合も安全）。
   */
  window.calibrateProb = calibrateProb;
  function calibrateProb(rawProb) {
    if (rawProb == null || isNaN(rawProb)) return rawProb;
    const p = Math.max(0, Math.min(1, rawProb));

    // 左端・右端の外挿クランプ
    if (p <= CALIB_POINTS[0][0]) return CALIB_POINTS[0][1];
    if (p >= CALIB_POINTS[CALIB_POINTS.length - 1][0]) {
      return CALIB_POINTS[CALIB_POINTS.length - 1][1];
    }

    // 区間を探して線形補間
    for (let i = 1; i < CALIB_POINTS.length; i++) {
      const [x0, y0] = CALIB_POINTS[i - 1];
      const [x1, y1] = CALIB_POINTS[i];
      if (p <= x1) {
        const t = (p - x0) / (x1 - x0);
        return y0 + t * (y1 - y0);
      }
    }
    return p; // fallback（到達しないはず）
  }

  // ─────────────────────────────────────────────────────────────────────────
  // § 1.5  コース別（艇単位）キャリブレーション補正テーブル
  //
  //   【背景】2026-06-20 コース別勝率キャリブレーションパネルにより、
  //   1号艇の最終確率（nigeProb）が系統的に過大評価（平均74.7%→実績60.8%）
  //   されていることが判明。一方2〜6号艇は確率の合計が1.0になる制約のため
  //   その分が一律に過小評価されていた。
  //
  //   【方針】hitProbEst と同じ区分線形補間方式で、1号艇の nigeProb のみを
  //   直接補正する。2〜6号艇は「1号艇が下がった分」を従来の conditionalShare
  //   比率のまま再配分する（analyzer.js 側）ことで、6艇間の相対評価（誰が
  //   強いか）は変えず、確率の絶対水準だけを実績に合わせて引き締める。
  //
  //   現状は calibration.js のコース別パネルが艇単位の平均値しか出さない
  //   （ビン分割していない）ため、暫定的に [0,0]→[実測平均]→[1,実測平均]
  //   の3点テーブルとする。将来 calcCalibrationByCourse 側がビン別集計に
  //   対応したら、ここも hitProbEst 同様の多点補間に拡張できる。
  // ─────────────────────────────────────────────────────────────────────────
  const _COURSE1_CALIB_LS_KEY = 'scen_calib_course1_v2'; // [2026-06-25] v1→v2: 60日データで再学習

  // [2026-06-25] course1 v1旧キーを破棄（60日再学習のため）
  try {
    if (localStorage.getItem('scen_calib_course1_v1') != null) {
      localStorage.removeItem('scen_calib_course1_v1');
      console.warn('[computeScenCombosWithEV] 旧キー(scen_calib_course1_v1)を破棄しました。');
    }
  } catch (_e) {}
  function _loadCourse1CalibFromLS() {
    try {
      const raw = localStorage.getItem(_COURSE1_CALIB_LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (_isSaneCalibPoints(parsed)) return parsed;
    } catch (_e) {}
    return null;
  }

  // デフォルト: 2026-06-20 実測（694件）推定74.7%→実績60.8%を反映
  const COURSE1_CALIB_POINTS = _loadCourse1CalibFromLS() || [
    [0.00, 0.00],
    [0.747, 0.608],
    [1.00, 0.608], // 右端は最後の実測水準でフラット外挿（100%への収束は仮定しない）
  ];
  window.COURSE1_CALIB_POINTS = COURSE1_CALIB_POINTS; // calibration.js のJSON書き出しボタンから参照するため公開

  // ─────────────────────────────────────────────────────────────────────────
  // [2026-07-13 追加] 会場別 1コース補正テーブル
  //
  //   【背景】津・平和島・多摩川・鳴門（潮汐/風でイン残りにくい）と
  //   大村・常滑・宮島（イン粘り強）で1コース実績が推定59〜63%付近に
  //   対して実績44%〜73%まで約30ポイント開いている。全会場共通の
  //   COURSE1_CALIB_POINTS 1本ではこの会場差を拾えないため、
  //   会場別テーブル（VENUE_COURSE1_CALIB_POINTS）を追加する。
  //
  //   サンプル不足の会場は自身のテーブルを持たせず、
  //   calibrateCourse1Prob 側で全国平均（COURSE1_CALIB_POINTS）に
  //   フォールバックする。
  // ─────────────────────────────────────────────────────────────────────────
  const _VENUE_COURSE1_CALIB_LS_KEY = 'scen_calib_venue_course1_v1';

  function _loadVenueCourse1CalibFromLS() {
    try {
      const raw = localStorage.getItem(_VENUE_COURSE1_CALIB_LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const cleaned = {};
      Object.entries(parsed).forEach(([v, pts]) => {
        if (_isSaneCalibPoints(pts)) cleaned[v] = pts;
      });
      return Object.keys(cleaned).length > 0 ? cleaned : null;
    } catch (_e) { return null; }
  }

  // デフォルト: 空（会場別テーブル未学習の会場は calibrateCourse1Prob 内で
  // 全国平均 COURSE1_CALIB_POINTS に自動フォールバックする）
  const VENUE_COURSE1_CALIB_POINTS = _loadVenueCourse1CalibFromLS() || {};
  window.VENUE_COURSE1_CALIB_POINTS = VENUE_COURSE1_CALIB_POINTS; // calibration.js のJSON書き出しボタンから参照するため公開

  /**
   * 1号艇の nigeProb を実測ベースで補正する。
   * @param {number} rawNigeProb  analyzer.js の Stage1 クリップ後の値
   * @param {string} [boat1Name]  1号艇の選手名（個人逃げ率ブレンド用）
   * @param {string} [venue]      会場名（会場別補正テーブル参照用）
   * @returns {number}            補正後の値（0〜1）
   */
  window.calibrateCourse1Prob = function (rawNigeProb, boat1Name, venue) {
    // ── [2026-06-29 修正] 個人逃げ率ブレンド方式 ──────────────────────
    //
    // 【旧実装の問題】
    //   全会場一律の区分線形補間（推定74.7%→実績60.8%）を適用していたため、
    //   逃げ82%の鉄板選手も逃げ40%の弱い選手も同じ引き下げを受けていた。
    //   個人能力を計算している意味がなかった。
    //
    // 【新実装の設計思想】
    //   1. まず全会場平均テーブルで「市場ベースの期待値」を計算（従来通り）
    //   2. 個人の実績逃げ率が取得できる場合、その値を「個人実績」として
    //      PERSONAL_BLEND（40%）でブレンドする
    //   3. 個人実績が信頼できる（runs≧20）場合のみブレンドを適用
    //      データ不足の場合は従来の全体補正のみ（フォールバック）
    //
    // PERSONAL_BLEND: 個人逃げ率の混ぜ込み強度
    //   0.0 = 完全に全体補正のみ（旧実装と同じ）
    //   1.0 = 完全に個人実績のみ
    //   0.4 = 個人40% + 全体60%（実績と市場の折衷）
    //
    // 例: 新田泰章（逃げ82%、runs=68）
    //   全体補正: 69.6% → 約60%
    //   個人逃げ率: 82%
    //   ブレンド: 60% × 0.6 + 82% × 0.4 = 68.8% ← 個人実力が反映される
    //
    // 例: データ不足選手（runs=5）
    //   全体補正: 60%（フォールバック）← 個人実績を信頼しない
    // ─────────────────────────────────────────────────────────────────────
    const PERSONAL_BLEND = 0.4;  // 個人逃げ率の混ぜ込み強度（0〜1）
    const PERSONAL_MIN_RUNS = 20; // 個人実績を信頼する最低出走数

    if (rawNigeProb == null || isNaN(rawNigeProb)) return rawNigeProb;
    const p = Math.max(0, Math.min(1, rawNigeProb));

    // ── Step1: 補正テーブルで市場ベースの期待値を計算 ──
    // [2026-07-13 追加] venue が渡され、かつ当該会場のサンプルが十分で
    // 自前のテーブルが学習済みの場合はそちらを優先する。
    // 会場別テーブルが無い（サンプル不足でupdateVenueCourse1CalibPointsが
    // まだ書き込んでいない）場合は、従来通り全国平均テーブルにフォールバックする。
    const pts = (venue && VENUE_COURSE1_CALIB_POINTS[venue]) || COURSE1_CALIB_POINTS;
    let globalCalib = p;
    if (p <= pts[0][0]) {
      globalCalib = pts[0][1];
    } else if (p >= pts[pts.length - 1][0]) {
      globalCalib = pts[pts.length - 1][1];
    } else {
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        if (p <= x1) {
          const t = (p - x0) / (x1 - x0);
          globalCalib = y0 + t * (y1 - y0);
          break;
        }
      }
    }

    // ── Step2: 個人逃げ率ブレンド ──
    // boat1Name が渡されていて MASTER_EXT が利用可能な場合のみ適用
    if (boat1Name && typeof MASTER_EXT !== 'undefined' && MASTER_EXT?.course_master) {
      const cm1   = MASTER_EXT.course_master[boat1Name]?.['1'];
      const runs  = cm1?.runs ?? 0;
      const nigeR = cm1?.kimari?.['逃げ'] ?? null;

      if (nigeR != null && runs >= PERSONAL_MIN_RUNS) {
        // 信頼度: 20走で最小（PERSONAL_BLEND×0.5）、100走で最大（PERSONAL_BLEND）
        const trust  = Math.min(runs / 100, 1.0);
        const blend  = PERSONAL_BLEND * (0.5 + 0.5 * trust); // 0.5×blend〜1.0×blend
        const result = globalCalib * (1 - blend) + nigeR * blend;
        return Math.max(0, Math.min(1, result));
      }
    }

    // フォールバック: 個人データなし → 全体補正のみ
    return globalCalib;
  };

  /**
   * calibration.js の calcCalibrationByCourse() 結果（course=1の要素）で
   * COURSE1_CALIB_POINTS を更新する。hitProbEst の updateCalibPoints と同じ
   * 自己崩壊ループ対策（最低サンプル数・異常値ガード）を踏襲する。
   *
   * @param {Array} courseStats  calcCalibrationByCourse() の戻り値（6要素）
   */
  window.updateCourse1CalibPoints = function (courseStats) {
    if (!Array.isArray(courseStats)) return;
    const c1 = courseStats.find(s => s.course === 1);
    if (!c1 || c1.estAvg == null || c1.actual == null) return;

    const MIN_SAMPLES_HARD = 50; // コース別は艇単位×レースなので最低50件
    if (c1.count < MIN_SAMPLES_HARD) {
      console.warn(`[updateCourse1CalibPoints] サンプル不足 (${c1.count}件 < ${MIN_SAMPLES_HARD}件) のため更新をスキップしました。`);
      return;
    }
    // 高確率帯で実績が極端に低い崩壊値は反映しない（hitProbEst と同じガード）
    if (c1.estAvg >= HIGH_PROB_BIN_MIN && c1.actual <= EXTREME_LOW_ACTUAL_THRESH) {
      console.warn('[updateCourse1CalibPoints] 異常値（崩壊値）のため更新をスキップしました。', c1);
      return;
    }

    const newPoints = [[0.00, 0.00], [c1.estAvg, c1.actual], [1.00, c1.actual]];
    if (!_isSaneCalibPoints(newPoints)) {
      console.warn('[updateCourse1CalibPoints] 更新後テーブルが異常と判定されたため、適用を中止しました。', newPoints);
      return;
    }
    COURSE1_CALIB_POINTS.length = 0;
    newPoints.forEach(pt => COURSE1_CALIB_POINTS.push(pt));
    try { localStorage.setItem(_COURSE1_CALIB_LS_KEY, JSON.stringify(COURSE1_CALIB_POINTS)); } catch (_e) {}
  };

  /**
   * calibration.js の calcCalibrationByVenueCourse() 結果
   * （{ 会場名: [ {course, count, estAvg, actual, diff}, ... course1〜6 ], ... }）
   * の course===1 要素を使って VENUE_COURSE1_CALIB_POINTS を会場ごとに更新する。
   * updateCourse1CalibPoints と同じ自己崩壊ループ対策（最低サンプル数・
   * 異常値ガード）を会場単位で踏襲する。
   *
   * サンプル不足の会場（MIN_SAMPLES_HARD_VENUE 未満）は、その会場の
   * 既存テーブルを一切変更しない（＝未学習ならフォールバックのまま、
   * 既学習でも直近が不足なら前回値を維持し暴れさせない）。
   *
   * @param {Object} venueCourseStats  calcCalibrationByVenueCourse() の戻り値
   */
  window.updateVenueCourse1CalibPoints = function (venueCourseStats) {
    if (!venueCourseStats || typeof venueCourseStats !== 'object') return;

    // 会場別は1会場あたりのレース数が全国平均より少なくなるため、
    // 全国版（50件）よりやや緩めるが、崩壊値を拾わない最低限は確保する。
    const MIN_SAMPLES_HARD_VENUE = 30;

    Object.entries(venueCourseStats).forEach(([venue, courseStats]) => {
      if (!Array.isArray(courseStats)) return;
      const c1 = courseStats.find(s => s.course === 1);
      if (!c1 || c1.estAvg == null || c1.actual == null) return;

      if (c1.count < MIN_SAMPLES_HARD_VENUE) {
        // サンプル不足の会場は更新しない（全国平均フォールバックのまま、
        // または既存の会場別テーブルを維持）
        return;
      }
      // 高確率帯で実績が極端に低い崩壊値は反映しない（全国版と同じガード）
      if (c1.estAvg >= HIGH_PROB_BIN_MIN && c1.actual <= EXTREME_LOW_ACTUAL_THRESH) {
        console.warn(`[updateVenueCourse1CalibPoints] ${venue}: 異常値（崩壊値）のため更新をスキップしました。`, c1);
        return;
      }

      const newPoints = [[0.00, 0.00], [c1.estAvg, c1.actual], [1.00, c1.actual]];
      if (!_isSaneCalibPoints(newPoints)) {
        console.warn(`[updateVenueCourse1CalibPoints] ${venue}: 更新後テーブルが異常と判定されたため、適用を中止しました。`, newPoints);
        return;
      }
      VENUE_COURSE1_CALIB_POINTS[venue] = newPoints;
    });

    try {
      localStorage.setItem(_VENUE_COURSE1_CALIB_LS_KEY, JSON.stringify(VENUE_COURSE1_CALIB_POINTS));
    } catch (_e) { /* 保存失敗は無視 */ }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // § 1.6  2〜6号艇 コース別（確率帯別）キャリブレーション補正テーブル
  //
  //   【背景】2026-07-03 診断（calibration.js ①③パネル）により、
  //   1号艇のみ calibrateCourse1Prob で補正され、2〜6号艇の final_prob は
  //   無補正のまま出力されていたことが判明。特に20〜40%帯（主に2〜4コース艇）
  //   で実績が推定を大きく下回る過大評価が残存していた
  //   （20-30%帯: 推定24.2%→実績16.3%、30-40%帯: 推定33.9%→実績16.7%）。
  //
  //   【方針】COURSE1_CALIB_POINTS と同じ区分線形補間方式を2〜6号艇にも適用する。
  //   ただしコース1は1点（市場平均のnigeProb）に対して実績が概ね線形に効くのに対し、
  //   2〜6号艇は確率帯によって誤差の大きさが大きく異なる（0-10%帯は過小評価、
  //   20-40%帯は過大評価）ため、コースごとに複数点（BINS単位）の区分線形テーブルを
  //   持たせる。1点しか実績が無いコース・帯は [0,0]→[実測点]→[1,実測点] にフォールバック。
  //
  //   【二重補正・自己崩壊ループ対策】
  //   コース1と同じく、学習には「本モジュールの補正が適用される前」の生値を使う。
  //   2〜6号艇はこれまで補正が存在しなかったため、boatProbs = 生値だったが、
  //   本モジュール導入後は boatProbsRaw[course] に生値を保存するので、
  //   calibration.js 側はそちらを優先して学習に使うこと（updateCourseOtherCalibPoints
  //   の呼び出し元で対応）。
  // ─────────────────────────────────────────────────────────────────────────
  const _COURSE_OTHER_CALIB_LS_KEY = 'scen_calib_course_other_v1';
  const OTHER_COURSES = [2, 3, 4, 5, 6];

  function _loadCourseOtherCalibFromLS() {
    try {
      const raw = localStorage.getItem(_COURSE_OTHER_CALIB_LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      // 各コースのテーブルが妥当かチェックし、不正なコースは除外
      const cleaned = {};
      OTHER_COURSES.forEach(c => {
        if (_isSaneCalibPoints(parsed[c])) cleaned[c] = parsed[c];
      });
      return Object.keys(cleaned).length > 0 ? cleaned : null;
    } catch (_e) { return null; }
  }

  // デフォルト: 補正なし（y=x）。calibration.js パネルに実測が蓄積され次第、
  // updateCourseOtherCalibPoints が localStorage に学習結果を保存し、以後はそちらを使う。
  const COURSE_OTHER_CALIB_POINTS = _loadCourseOtherCalibFromLS() || {
    2: [[0.00, 0.00], [1.00, 1.00]],
    3: [[0.00, 0.00], [1.00, 1.00]],
    4: [[0.00, 0.00], [1.00, 1.00]],
    5: [[0.00, 0.00], [1.00, 1.00]],
    6: [[0.00, 0.00], [1.00, 1.00]],
  };
  window.COURSE_OTHER_CALIB_POINTS = COURSE_OTHER_CALIB_POINTS; // calibration.js のJSON書き出しボタンから参照するため公開

  /**
   * 2〜6号艇の final_prob を実測ベースで補正する（区分線形補間）。
   * @param {number} rawProb  補正前の final_prob (0〜1)
   * @param {number} course   枠番（2〜6）
   * @returns {number}        補正後の値（0〜1）
   */
  window.calibrateOtherCourseProb = function (rawProb, course) {
    if (rawProb == null || isNaN(rawProb)) return rawProb;
    const pts = COURSE_OTHER_CALIB_POINTS[course];
    if (!pts || pts.length < 2) return rawProb;
    const p = Math.max(0, Math.min(1, rawProb));

    if (p <= pts[0][0]) return pts[0][1];
    if (p >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];

    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      if (p <= x1) {
        const t = (x1 - x0) > 1e-9 ? (p - x0) / (x1 - x0) : 0;
        return y0 + t * (y1 - y0);
      }
    }
    return p; // fallback（到達しないはず）
  };

  /**
   * calibration.js の calcWinProbCalibrationByCourse() 結果
   * （{ course(2-6): [ {estAvg, actual, count}, ... ] }）で
   * COURSE_OTHER_CALIB_POINTS を更新する。
   * updateCourse1CalibPoints / updateCalibPoints と同じ
   * 自己崩壊ループ対策（最低サンプル数・異常値ガード・単調性チェック）を踏襲する。
   *
   * @param {Object} courseBinStats  { 2: [...], 3: [...], ..., 6: [...] }
   */
  window.updateCourseOtherCalibPoints = function (courseBinStats) {
    if (!courseBinStats || typeof courseBinStats !== 'object') return;

    const MIN_SAMPLES_HARD_BIN = 50; // 帯ごとの最低サンプル数（艇単位×レースなので比較的多め）

    OTHER_COURSES.forEach(course => {
      const bins = courseBinStats[course];
      if (!Array.isArray(bins) || bins.length === 0) return;

      // サンプル十分な帯だけを採用し、estAvg昇順に並べる
      const usable = bins
        .filter(b => b && b.estAvg != null && b.actual != null && b.count >= MIN_SAMPLES_HARD_BIN)
        .sort((a, b) => a.estAvg - b.estAvg);

      if (usable.length === 0) return; // このコースは全帯サンプル不足→既存テーブル維持

      // 崩壊値ガード: 高確率帯で実績が極端に低い場合は更新しない
      const collapsed = usable.some(b => b.estAvg >= HIGH_PROB_BIN_MIN && b.actual <= EXTREME_LOW_ACTUAL_THRESH);
      if (collapsed) {
        console.warn(`[updateCourseOtherCalibPoints] course${course}: 異常値（崩壊値）のため更新をスキップしました。`, usable);
        return;
      }

      // 両端を [0,0] / [1, 最終帯の実績] で挟む
      const lastActual = usable[usable.length - 1].actual;
      const newPoints = [[0.00, 0.00], ...usable.map(b => [b.estAvg, b.actual]), [1.00, lastActual]];

      // x が単調増加になるよう重複・逆転を除去（同一estAvgが並んだ場合は後者を優先）
      const dedup = [];
      newPoints.forEach(pt => {
        if (dedup.length > 0 && pt[0] <= dedup[dedup.length - 1][0]) {
          dedup[dedup.length - 1] = pt;
        } else {
          dedup.push(pt);
        }
      });

      if (!_isSaneCalibPoints(dedup)) {
        console.warn(`[updateCourseOtherCalibPoints] course${course}: 更新後テーブルが異常と判定されたため、適用を中止しました。`, dedup);
        return;
      }

      COURSE_OTHER_CALIB_POINTS[course] = dedup;
    });

    try {
      localStorage.setItem(_COURSE_OTHER_CALIB_LS_KEY, JSON.stringify(COURSE_OTHER_CALIB_POINTS));
    } catch (_e) { /* 保存失敗は無視 */ }
  };

  /**
   * キャリブレーション補正テーブルを外部から更新する。
   * calibration.js の binStats を渡すと自動更新できる。
   *
   * 呼び出し例（calibration.js の _renderCalibrationPanel 末尾に追加）:
   *   if (typeof updateCalibPoints === 'function') updateCalibPoints(binStats);
   *
   * @param {Array} binStats  calcCalibration() の戻り値
   */
  window.updateCalibPoints = function (binStats) {
    if (!Array.isArray(binStats)) return;

    // ── ① 全体の最低サンプル数チェック ──
    // [2026-06-20 追加] 自己崩壊ループ対策。
    // バックテスト全体の有効データ件数が少ない状態で更新すると、
    // 偏ったビンの値がそのままテーブルに刻まれて次回以降の補正を歪める。
    const MIN_TOTAL_SAMPLES_HARD  = 100; // これ未満は問答無用でスキップ
    const MIN_TOTAL_SAMPLES_RECOMMENDED = 200; // 推奨下限（警告のみ、更新は許可）
    const totalValidForUpdate = binStats.reduce((s, b) => s + (b.total || 0), 0);

    if (totalValidForUpdate < MIN_TOTAL_SAMPLES_HARD) {
      console.warn(
        `[updateCalibPoints] 全体有効件数不足 (${totalValidForUpdate}件 < ${MIN_TOTAL_SAMPLES_HARD}件) のため` +
        `補正テーブルの更新をスキップしました（既存テーブルを維持）。`
      );
      return;
    }
    if (totalValidForUpdate < MIN_TOTAL_SAMPLES_RECOMMENDED) {
      console.warn(
        `[updateCalibPoints] 全体有効件数が推奨値未満 (${totalValidForUpdate}件 < ${MIN_TOTAL_SAMPLES_RECOMMENDED}件) です。` +
        `更新は実行しますが、サンプルが増えるまで結果の信頼性に注意してください。`
      );
    }

    const newPoints = [[0.00, 0.00]]; // 左端固定

    // [2026-07-13 追加] 小標本崩壊値ガード
    //   既存の②ガードは「高確率帯（40%+）で実績が5%以下」しか捕捉できず、
    //   30〜40%帯のような中間帯でサンプルが少ない（N=13等）場合に
    //   偶然実績0%になったビンがそのまま補正テーブルに刻まれてしまう
    //   （実例: 推定34.3%・実績0.0%・N=13 が CALIB_POINTS を歪める）。
    //   母数が少ない（<30件）ビンは、推定と実績の乖離が大きい（20pt以上）場合、
    //   確率帯を問わず「まだ信頼できない」として補正テーブルへの反映をスキップする。
    const SMALL_SAMPLE_THRESH        = 30;   // これ未満は「小標本」とみなす
    const SMALL_SAMPLE_MAX_DEVIATION = 0.20; // 小標本で許容する最大乖離（20pt）

    binStats.forEach(b => {
      if (b.total >= 10 && b.estAvg != null && b.actual != null) {
        // ── ② 極端な値（崩壊）の破棄（高確率帯・実績激低）──
        // 高確率ビン（40%以上）で実績が極端に低い（5%以下など）場合は、
        // データ不足または一時的な偏りによる崩壊値とみなし、
        // この点は補正テーブルに反映しない（既存の対応点をそのまま維持する）。
        if (b.estAvg >= HIGH_PROB_BIN_MIN && b.actual <= EXTREME_LOW_ACTUAL_THRESH) {
          console.warn(
            `[updateCalibPoints] 異常値スキップ: ビン[${b.label}] estAvg=${b.estAvg.toFixed(2)} ` +
            `actual=${(b.actual*100).toFixed(1)}% (N=${b.total}) → このビンは補正テーブルに反映しません。`
          );
          return;
        }
        // ── ②' 小標本崩壊値の破棄（確率帯を問わない）──
        const deviation = Math.abs(b.actual - b.estAvg);
        if (b.total < SMALL_SAMPLE_THRESH && deviation >= SMALL_SAMPLE_MAX_DEVIATION) {
          console.warn(
            `[updateCalibPoints] 小標本異常値スキップ: ビン[${b.label}] estAvg=${b.estAvg.toFixed(2)} ` +
            `actual=${(b.actual*100).toFixed(1)}% (N=${b.total} < ${SMALL_SAMPLE_THRESH}, 乖離${(deviation*100).toFixed(1)}pt) ` +
            `→ サンプル不足のため補正テーブルに反映しません。`
          );
          return;
        }
        newPoints.push([b.estAvg, b.actual]);
      }
    });
    // [2026-06-20 修正] 旧実装は無条件で [1.00, 1.00] を末尾に追加していたため、
    // 実測データのない高確率帯（N<10で上のループからスキップされたビン）でも
    // 「推定100%→実績100%」へ強制的に収束させてしまい、過大評価の温床になっていた。
    // 実測のある最後の点と同じ y 値でフラット延長する（=データがない領域は
    // 「分からないので保守的に」を採用し、100%への収束を仮定しない）。
    const lastRealY = newPoints.length > 1 ? newPoints[newPoints.length - 1][1] : 0.5;
    newPoints.push([1.00, lastRealY]); // 右端: フラット外挿（旧: 固定 [1.00, 1.00]）
    if (newPoints.length >= 3) {
      // x 昇順ソート（安全策）
      newPoints.sort((a, b) => a[0] - b[0]);

      // ── 最終サニティチェック ──
      // 個別ビンの異常値は上で除外済みだが、念のため完成したテーブル全体も検査する。
      if (!_isSaneCalibPoints(newPoints)) {
        console.warn('[updateCalibPoints] 更新後テーブルが異常と判定されたため、適用を中止しました（既存テーブルを維持）。', newPoints);
        return;
      }

      CALIB_POINTS.length = 0;
      newPoints.forEach(pt => CALIB_POINTS.push(pt));
      // localStorage に永続化（リロード後も即時反映）
      try { localStorage.setItem(_CALIB_LS_KEY, JSON.stringify(CALIB_POINTS)); } catch (_e) {}
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // § 1.7  サーバー配布キャリブレーションJSONの適用（端末間の不一致解消）
  //
  //   【背景】CALIB_POINTS / COURSE1_CALIB_POINTS / COURSE_OTHER_CALIB_POINTS は
  //   これまで各端末の localStorage で独立に学習されており、
  //     ・admin の複数端末間で学習履歴が異なる
  //     ・premiumユーザーの端末では admin-mode 限定の学習処理が一度も走らず、
  //       ソースコード埋め込みのデフォルト値（無補正 y=x 等）のまま固定される
  //   という理由で「独自補正 最終確率」列が端末ごとに食い違う原因になっていた。
  //
  //   【方針】calibration.js（admin専用パネル）で学習・確定した値を
  //   data/calib_points.json として auto_push.py 経由で配布し、
  //   全端末がページ読み込み時にこれをfetchして「権威あるテーブル」として
  //   上書き適用する。fetch失敗時は従来通り localStorage → デフォルトに
  //   フォールバックする（可用性を落とさない）。
  //
  //   admin端末での学習（updateCalibPoints等）は従来通り localStorage にも
  //   書き込まれ、その場ではすぐ反映されるが、他端末・次回リロードでの
  //   「正」は data/calib_points.json 側になる。
  // ─────────────────────────────────────────────────────────────────────────
  (function _applyServerCalibPoints() {
    try {
      if (typeof fetch !== 'function') return;
      const base = (typeof DATA_BASE_URL !== 'undefined')
        ? DATA_BASE_URL
        : location.href.replace(/\/[^\/]*$/, '') + '/data';

      // [2026-07-11] index.json と同様、常に最新を確認する（no-cache）。
      // 'default' のままだと、push直後もブラウザキャッシュにより古い
      // calib_points.json を掴み続ける端末が発生しうる（①と同種の問題）。
      fetch(`${base}/calib_points.json`, { cache: 'no-cache' })
        .then(res => (res && res.ok) ? res.json() : null)
        .then(json => {
          if (!json || typeof json !== 'object') return;
          let applied = false;

          if (_isSaneCalibPoints(json.CALIB_POINTS)) {
            CALIB_POINTS.length = 0;
            json.CALIB_POINTS.forEach(pt => CALIB_POINTS.push(pt));
            try { localStorage.setItem(_CALIB_LS_KEY, JSON.stringify(CALIB_POINTS)); } catch (_e) {}
            applied = true;
          }
          if (_isSaneCalibPoints(json.COURSE1_CALIB_POINTS)) {
            COURSE1_CALIB_POINTS.length = 0;
            json.COURSE1_CALIB_POINTS.forEach(pt => COURSE1_CALIB_POINTS.push(pt));
            try { localStorage.setItem(_COURSE1_CALIB_LS_KEY, JSON.stringify(COURSE1_CALIB_POINTS)); } catch (_e) {}
            applied = true;
          }
          if (json.COURSE_OTHER_CALIB_POINTS && typeof json.COURSE_OTHER_CALIB_POINTS === 'object') {
            OTHER_COURSES.forEach(c => {
              if (_isSaneCalibPoints(json.COURSE_OTHER_CALIB_POINTS[c])) {
                COURSE_OTHER_CALIB_POINTS[c] = json.COURSE_OTHER_CALIB_POINTS[c];
                applied = true;
              }
            });
            if (applied) {
              try { localStorage.setItem(_COURSE_OTHER_CALIB_LS_KEY, JSON.stringify(COURSE_OTHER_CALIB_POINTS)); } catch (_e) {}
            }
          }
          if (json.VENUE_COURSE1_CALIB_POINTS && typeof json.VENUE_COURSE1_CALIB_POINTS === 'object') {
            let venueApplied = false;
            Object.entries(json.VENUE_COURSE1_CALIB_POINTS).forEach(([v, pts]) => {
              if (_isSaneCalibPoints(pts)) {
                VENUE_COURSE1_CALIB_POINTS[v] = pts;
                venueApplied = true;
              }
            });
            if (venueApplied) {
              applied = true;
              try { localStorage.setItem(_VENUE_COURSE1_CALIB_LS_KEY, JSON.stringify(VENUE_COURSE1_CALIB_POINTS)); } catch (_e) {}
            }
          }

          // 既にキャッシュ済みの表示・事前計算結果を破棄し、新しいテーブルで
          // 再計算させる（fetch完了が遅れて先に古い値で描画されていた場合の保険）。
          if (applied) {
            try { if (typeof invalidateRenderCache === 'function') invalidateRenderCache(); } catch (_e) {}
            try {
              if (typeof _scenEVCache === 'object' && _scenEVCache) {
                Object.keys(_scenEVCache).forEach(k => delete _scenEVCache[k]);
              }
            } catch (_e) {}
            try { if (typeof _triggerPrefill === 'function') _triggerPrefill(); } catch (_e) {}
            console.info('[computeScenCombosWithEV] data/calib_points.json を適用しました（全端末共通の補正テーブル）。');
          }
        })
        .catch(() => { /* fetch失敗時は従来のlocalStorage/デフォルトのまま動作継続 */ });
    } catch (_e) { /* 何らかの理由で失敗しても致命的にしない */ }
  })();


  // ─────────────────────────────────────────────────────────────────────────
  // § 2  加重確率ベースの 2着 / 3着 順位算出
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * scenarioPlace2 と scenarioProb を使い、各艇の「加重2着確率」を計算する。
   *
   * 【旧実装との違い】
   *   旧: combo文字列の2着ポジションに現れた頻度をカウント
   *       → 買い目構成の都合で2号艇が多く含まれると誤って「2着最有力」になる
   *
   *   新: scenarioPlace2[winner][kimari][].p2 × scenarioProb[winner][kimari]
   *       で加重合計 → 真の2着確率に基づく順位付け
   *
   * @param {object} sd  calcScenarioData() の戻り値
   * @param {number} winnerBoat  軸（1着）艇番
   * @returns {{ weighted: {[boat]: number}, ranked: number[] }}
   *   weighted: 各艇の加重2着確率合計（正規化なし。比較用）
   *   ranked  : 加重確率降順の艇番配列
   */
  function calcWeighted2nd(sd, winnerBoat) {
    const { scenarioProb, scenarioPlace2, kimariTypes } = sd;
    if (!scenarioProb?.[winnerBoat] || !kimariTypes?.length) {
      return { weighted: {}, ranked: [] };
    }

    const weighted = {};
    let totalScenWeight = 0;

    for (const kimari of kimariTypes) {
      const scenW = scenarioProb[winnerBoat]?.[kimari] ?? 0;
      if (scenW <= 0) continue;
      totalScenWeight += scenW;

      const p2List = scenarioPlace2?.[winnerBoat]?.[kimari] || [];
      p2List.forEach(({ boat, p2 }) => {
        if (boat == null || isNaN(p2)) return;
        weighted[boat] = (weighted[boat] ?? 0) + scenW * p2;
      });
    }

    // totalScenWeight で割ることで「シナリオ確率の合計が1でない場合」も安全に正規化
    if (totalScenWeight > 0) {
      Object.keys(weighted).forEach(k => { weighted[k] /= totalScenWeight; });
    }

    // [修正] 2着確率の系統的過大評価を補正（実測: 推定47%→実績30%, 推定65%→実績42%）
    // 区分線形補間で推定値を実績ベースにスケールダウンする。
    // 補正テーブルは calibration.js スクショ4の実測値から導出。
    const P2_CALIB = [
      [0.00, 0.00], [0.20, 0.18], [0.30, 0.24],
      [0.40, 0.30], [0.50, 0.33], [0.65, 0.40], [1.00, 0.60],
    ];
    Object.keys(weighted).forEach(k => {
      const raw = weighted[k];
      const idx = P2_CALIB.findIndex(pt => raw <= pt[0]);
      if (idx <= 0) return; // 0以下 or テーブル外はそのまま
      const [x0, y0] = P2_CALIB[idx - 1];
      const [x1, y1] = P2_CALIB[idx];
      weighted[k] = y0 + (raw - x0) / (x1 - x0) * (y1 - y0);
    });

    const ranked = Object.entries(weighted)
      .sort((a, b) => b[1] - a[1])
      .map(([boat]) => parseInt(boat));

    return { weighted, ranked };
  }

  /**
   * merged3rdMap と scenarioProb を使い、各艇の「加重3着確率」を計算する。
   *
   * 【なぜ merged3rdMap を使うか】
   *   calc3rdScores は winner × kimari × second の三重ループで r3 を算出しており、
   *   すでに calcScenarioData 内で scenarioProb × p2 で加重平均済み。
   *   ここでは winner × second の全ペアに対して scenarioProb[winner][kimari] × p2
   *   で再度重み付けすることで、真の3着確率を推定する。
   *
   * @param {object} sd
   * @param {number} winnerBoat
   * @returns {{ weighted: {[boat]: number}, ranked: number[] }}
   */
  function calcWeighted3rd(sd, winnerBoat) {
    const { scenarioProb, scenarioPlace2, merged3rdMap, kimariTypes } = sd;
    if (!scenarioProb?.[winnerBoat] || !kimariTypes?.length) {
      return { weighted: {}, ranked: [] };
    }

    const weighted = {};
    let totalWeight = 0;

    for (const kimari of kimariTypes) {
      const scenW = scenarioProb[winnerBoat]?.[kimari] ?? 0;
      if (scenW <= 0) continue;

      const p2List = scenarioPlace2?.[winnerBoat]?.[kimari] || [];
      p2List.forEach(({ boat: secondBoat, p2 }) => {
        if (secondBoat == null || isNaN(p2) || p2 <= 0) return;
        const w2 = scenW * p2; // このシナリオ×2着艇の複合重み
        totalWeight += w2;

        const thirdList = merged3rdMap?.[winnerBoat]?.[secondBoat] || [];
        thirdList.forEach(({ boat: thirdBoat, r3 }) => {
          if (thirdBoat == null || r3 == null || isNaN(r3)) return;
          weighted[thirdBoat] = (weighted[thirdBoat] ?? 0) + w2 * r3;
        });
      });
    }

    if (totalWeight > 0) {
      Object.keys(weighted).forEach(k => { weighted[k] /= totalWeight; });
    }

    const ranked = Object.entries(weighted)
      .sort((a, b) => b[1] - a[1])
      .map(([boat]) => parseInt(boat));

    return { weighted, ranked };
  }


  // ─────────────────────────────────────────────────────────────────────────
  // § 3  computeScenCombosWithEV  本体
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * シナリオ買い目・的中確率・期待値・2着/3着予測を一括返却する。
   *
   * 【設計方針】
   *   buildScenarioBuyPanel と同一のロジックで買い目を生成しつつ、
   *   calcScenarioComboProb で各買い目の真の的中確率を合算して hitProbEst を算出。
   *   さらに calibrateProb でキャリブレーション補正を適用する。
   *
   * @param {string} venue     会場名
   * @param {object} vdata     その会場・日付のデータオブジェクト（races含む）
   * @param {number} rno       レース番号（整数）
   * @returns {{
   *   combos      : string[],
   *   hitProbEst  : number|null,
   *   synthOdds   : number|null,
   *   ev          : number|null,
   *   pred2ndRank : number|null,
   *   pred3rdRank : number|null,
   *   weighted2nd : object,
   *   weighted3rd : object,
   * }}
   */
  // 実装本体を別名でも保持（強制上書き用）
  function _computeScenCombosWithEV_impl(venue, vdata, rno) {

    const _empty = {
      combos: [], hitProbEst: null, synthOdds: null, ev: null,
      pred2ndRank: null, pred3rdRank: null,
      weighted2nd: {}, weighted3rd: {},
    };

    // ══════════════════════════════════════════════════════════════════════
    // § CACHE-FIRST: buildScenarioBuyPanel が書いたキャッシュを最優先で返す
    //
    // 【設計方針】
    //   買い目のズレを根絶するための唯一確実な手段は
    //   「画面表示と集計が同一のデータを参照する」こと。
    //
    //   buildScenarioBuyPanel は allCombos 確定時に
    //     _saveScenComboToLS(venue, date, rno, allCombos)
    //   を呼び出し、_scenComboCache[memKey] と localStorage 両方に書く。
    //
    //   このキャッシュが存在する場合、ここで再計算は一切行わず
    //   キャッシュの combos をそのまま返す。
    //   hitProbEst など EV 系の値は後段で引き続き計算する。
    //
    //   キャッシュが空の場合（過去日・未表示レース等）は
    //   従来の再計算ロジックにフォールスルーする。
    // ══════════════════════════════════════════════════════════════════════
    try {
      if (venue && vdata?.date && rno != null &&
          typeof _scenComboCache !== 'undefined' &&
          typeof VENUE_SLUG_MAP   !== 'undefined') {
        const _slug    = VENUE_SLUG_MAP[venue] || venue;
        const _memKey  = `${_slug}_${vdata.date}_${rno}`;
        const _cached  = _scenComboCache[_memKey];

        // ══════════════════════════════════════════════════════════
        // [2026-07-11 修正] 結果未確定レースへのキャッシュ誤適用を防止
        //
        // 背景: このキャッシュは venue/date/rno のみをキーにしており、
        //   ロジック版・データ更新時刻を含まない。そのため結果が未確定
        //   （＝オッズ・展示情報が更新され続けている当日レース）でも
        //   無条件に適用され、「そのユーザーが最初にそのレースを開いた
        //   時点」の古い計算結果が端末ごとに固定化され、ユーザー間で
        //   数値が食い違う原因になっていた。
        //
        // 対策: RESULT_DATA に確定結果（三連単配当）が存在するレース、
        //   つまりもう値が変わり得ない過去レースに限りキャッシュを
        //   信頼する。結果未確定のレースは毎回最新データで再計算し、
        //   全ユーザーが常に同じ値を見るようにする。
        //   判定に失敗した場合は安全側（再計算）に倒す。
        // ══════════════════════════════════════════════════════════
        let _isFinalized = false;
        try {
          if (typeof RESULT_DATA !== 'undefined' && typeof resultKey === 'function') {
            const _rKey = resultKey(_slug, vdata.date, rno);
            const _rd0  = RESULT_DATA[_rKey];
            _isFinalized = !!(_rd0 && _rd0.sanrentan && _rd0.sanrentan.length > 0);
          }
        } catch(_eFin) { _isFinalized = false; }

        if (_isFinalized && Array.isArray(_cached) && _cached.length > 0) {
          // キャッシュ命中 → combos は確定値として使い、hitProbEst だけ計算して返す
          // [2026-06-03 修正] 旧実装は hitProbEst=null で早期 return していたため
          //   キャッシュあり（直近数日の表示済みレース）の ev がすべて null になり
          //   EV1.1 フィルタで全件除外されるバグがあった。
          const _combos = _cached.slice();
          let _hitProbEst = null;
          // [修正] キャッシュヒット時の weighted2nd/3rd 受け皿（下のtry内で設定）
          let _cacheWeighted2nd   = {};
          let _cacheRanked2ndList = [];
          let _cacheWeighted3rd   = {};
          let _cacheRanked3rdList = [];
          try {
            const _rd = vdata?.races?.[String(rno)];
            if (_rd?.boats && typeof window._setDataForCalc === 'function'
                && typeof calcTenkaiProbs === 'function'
                && typeof calcScenarioData === 'function'
                && typeof calcScenarioComboProb === 'function') {
              const _savedC = window._setDataForCalc(vdata, venue);
              try {
                const _arek = (_rd.arek > 0) ? _rd.arek : 54.7;
                const _ranked = calcTenkaiProbs(_rd.boats, _arek);
                if (_ranked && _ranked.length >= 2) {
                  const _probTotal = _ranked.reduce((s,b) => s + b.prob, 0) || 1;
                  _ranked.forEach(b => { b.final_prob = b.prob / _probTotal; });
                  const _p2map = calcPlace2Probs(_rd.boats, _ranked);
                  const _ranked2w = _ranked.map(b => ({...b, place2_prob: _p2map[b.boat] || 0}));
                  let _tSM = {};
                  try {
                    if (typeof _ensureTenjiCache === 'function') _ensureTenjiCache();
                    const _sl = (typeof SLUG_MAP !== 'undefined' && SLUG_MAP[venue]) || venue;
                    const _tk = (typeof tenjiKey === 'function') ? tenjiKey(_sl, vdata.date, rno) : null;
                    if (_tk && typeof _tenjiCache !== 'undefined') _tSM = _tenjiCache[_tk] || {};
                  } catch(_te) {}
                  const _sd = calcScenarioData(_ranked2w, _rd.boats, _tSM, venue, vdata);
                  if (_sd) {
                    let _raw = 0, _cnt = 0;
                    _combos.forEach(c => {
                      const _w = parseInt(c.split('-')[0]);
                      const _p = calcScenarioComboProb(c, _w, _sd);
                      if (_p != null && !isNaN(_p)) { _raw += _p; _cnt++; }
                    });
                    if (_cnt > 0 && typeof calibrateProb === 'function') {
                      _hitProbEst = calibrateProb(_raw);
                    }

                    // ── [修正] キャッシュヒット時も weighted2nd/3rd を計算する ──
                    // 旧実装は _sd を hitProbEst 計算にのみ使い捨てており、
                    // weighted2nd/weighted3rd/ranked2ndList/ranked3rdList が
                    // 常に空のまま返っていた。表示済み（=キャッシュあり）レースが
                    // 大半を占めるため、これにより pred2ndRank / 確率値キャリブレーション
                    // が実質機能していなかった。fp1st（予測1着艇）を再現し、
                    // 非キャッシュ経路と同一の calcWeighted2nd/3rd を適用する。
                    try {
                      // fp1st / fp2nd を final_prob 順で特定
                      const _cSorted = [..._ranked].filter(b => b.boat != null && b.final_prob != null)
                        .sort((a, b) => b.final_prob - a.final_prob);
                      const _cFp1st = _cSorted[0]?.boat ?? null;
                      const _cFp2nd = _cSorted[1]?.boat ?? null;
                      if (_cFp1st != null) {
                        const _w2 = calcWeighted2nd(_sd, _cFp1st);
                        _cacheWeighted2nd   = _w2.weighted;
                        _cacheRanked2ndList = _w2.ranked;

                        // [修正] キャッシュ経路も fp1st+fp2nd 加重平均（非キャッシュ経路と統一）
                        const _cw3fp1 = calcWeighted3rd(_sd, _cFp1st);
                        const _cw3fp2 = _cFp2nd != null ? calcWeighted3rd(_sd, _cFp2nd) : { weighted: {}, ranked: [] };
                        const _cp1w = _cSorted[0]?.final_prob ?? 0.7;
                        const _cp2w = _cFp2nd != null ? (_cSorted[1]?.final_prob ?? 0.3) : 0;
                        const _cpwTotal = _cp1w + _cp2w || 1;
                        const _cW3 = {};
                        new Set([...Object.keys(_cw3fp1.weighted), ...Object.keys(_cw3fp2.weighted)]).forEach(k => {
                          _cW3[k] = (((_cw3fp1.weighted[k] ?? 0) * _cp1w) + ((_cw3fp2.weighted[k] ?? 0) * _cp2w)) / _cpwTotal;
                        });
                        _cacheWeighted3rd   = _cW3;
                        _cacheRanked3rdList = Object.entries(_cW3).sort((a, b) => b[1] - a[1]).map(([k]) => parseInt(k));
                      }
                    } catch (_we) { /* 計算失敗時は空のまま（後段でフォールバック） */ }
                  }
                }
              } finally {
                window._restoreDataForCalc(_savedC);
              }
            }
          } catch (_ce) { /* hitProbEst 計算失敗時は null のまま返す */ }

          // キャッシュヒット時も boatProbs を構築する
          // _ranked が取れていれば final_prob を使い、なければ空オブジェクト
          const _boatProbs = {};
          const _boatProbsRaw = {};
          try {
            const _rd2 = vdata?.races?.[String(rno)];
            if (_rd2?.boats && typeof calcTenkaiProbs === 'function'
                && typeof window._setDataForCalc === 'function') {
              const _sv2 = window._setDataForCalc(vdata, venue);
              try {
                const _arek2   = (_rd2.arek > 0) ? _rd2.arek : 54.7;
                const _ranked2 = calcTenkaiProbs(_rd2.boats, _arek2);
                if (_ranked2 && _ranked2.length > 0) {
                  const _pt = _ranked2.reduce((s, b) => s + b.prob, 0) || 1;
                  _ranked2.forEach(b => { b.final_prob = b.prob / _pt; });

                  // ── [2026-06-20 追加] コース別キャリブレーション補正 ──
                  // 本線（非キャッシュ経路）と同じロジック。1号艇のみ補正し、
                  // 差分を他5艇へ現在の比率のまま再配分する。
                  try {
                    const _c1boat = _ranked2.find(b => b.boat === 1);
                    if (_c1boat && typeof calibrateCourse1Prob === 'function') {
                      const _rawC1b = _c1boat.final_prob;
                      _boatProbsRaw[1] = _rawC1b;
                      const _calC1b = calibrateCourse1Prob(_rawC1b, undefined, venue);
                      if (_calC1b != null && !isNaN(_calC1b) && Math.abs(_calC1b - _rawC1b) > 1e-9) {
                        const _others5b = _ranked2.filter(b => b.boat !== 1);
                        const _others5bTotal = _others5b.reduce((s, b) => s + b.final_prob, 0) || 1;
                        const _remainingB = Math.max(0, 1 - _calC1b);
                        _others5b.forEach(b => { b.final_prob = _remainingB * (b.final_prob / _others5bTotal); });
                        _c1boat.final_prob = _calC1b;
                      }
                    }
                  } catch (_cc1b) { /* 補正失敗時は無補正のまま続行 */ }

                  // ── [2026-07-03 追加] 2〜6号艇のコース別キャリブレーション補正 ──
                  // 非キャッシュ経路と同一ロジック（§1.6 calibrateOtherCourseProb）。
                  try {
                    if (typeof calibrateOtherCourseProb === 'function') {
                      _ranked2.forEach(b => {
                        if (b.boat == null || b.boat === 1 || b.final_prob == null) return;
                        const _rawOtherB = b.final_prob;
                        _boatProbsRaw[b.boat] = _rawOtherB; // 再学習用（補正前の生値）
                        const _calOtherB = calibrateOtherCourseProb(_rawOtherB, b.boat);
                        if (_calOtherB != null && !isNaN(_calOtherB)) {
                          b.final_prob = _calOtherB;
                        }
                      });
                      const _renormTotalB = _ranked2.reduce((s, b) => s + (b.final_prob || 0), 0);
                      if (_renormTotalB > 0 && Math.abs(_renormTotalB - 1) > 1e-9) {
                        _ranked2.forEach(b => { b.final_prob = b.final_prob / _renormTotalB; });
                      }
                    }
                  } catch (_ccob) { /* 補正失敗時は無補正のまま続行 */ }

                  _ranked2.forEach(b => { if (b.boat != null) _boatProbs[b.boat] = b.final_prob; });
                }
              } finally {
                window._restoreDataForCalc(_sv2);
              }
            }
          } catch (_be) { /* boatProbs 取得失敗は無視 */ }

          return {
            combos      : _combos,
            hitProbEst  : _hitProbEst,
            synthOdds   : null,
            ev          : null,
            boatProbs   : _boatProbs,
            boatProbsRaw: _boatProbsRaw,
            // [修正] 旧実装は常に null/{} だった。計算できていれば反映する。
            pred2ndRank : null,
            pred3rdRank : null,
            ranked2ndList: _cacheRanked2ndList,
            ranked3rdList: _cacheRanked3rdList,
            weighted2nd : _cacheWeighted2nd,
            weighted3rd : _cacheWeighted3rd,
            _fromCache  : true,
          };
        }
      }
    } catch (_cacheErr) {
      // キャッシュ参照エラーは無視して再計算にフォールスルー
    }
    // ── キャッシュなし → 従来の再計算ロジック ──

    try {
      // ── 引数バリデーション ──
      if (!venue || typeof venue !== 'string') return _empty;
      if (!vdata || typeof vdata !== 'object') return _empty;
      if (rno == null) return _empty;

      // ── 必要な関数の存在確認 ──
      if (typeof calcScenarioData         !== 'function') return _empty;
      if (typeof calcScenarioComboProb    !== 'function') return _empty;
      if (typeof calcTenkaiProbs          !== 'function') return _empty;

      // ── レースデータ取得 ──
      const rd = vdata?.races?.[String(rno)];
      if (!rd || !rd.boats || rd.boats.length < 2) return _empty;

      // ── 展示・最終確率の算出（sample.js の標準フロー再現）──
      const rawBoats = rd.boats;

      // tenjiScoreMap が必要。_ensureTenjiCache / tenjiKey は sample.js グローバル
      let tenjiScoreMap = {};
      try {
        if (typeof _ensureTenjiCache === 'function') _ensureTenjiCache();
        if (typeof tenjiKey === 'function' && typeof _tenjiCache !== 'undefined') {
          const slug = (typeof SLUG_MAP !== 'undefined' && SLUG_MAP[venue]) ? SLUG_MAP[venue] : venue;
          const tk = tenjiKey(slug, vdata.date, rno);
          tenjiScoreMap = _tenjiCache[tk] || {};
        }
      } catch (_e) { /* tenjiCache が利用不可でも続行 */ }

      // ── DATA / currentVenue を一時差し替え ──
      // sample_obf.js 内の DATA はローカルスコープのため window.DATA では届かない。
      // top_stats_obf.js と同スコープの _setDataForCalc / _restoreDataForCalc を経由する。
      if (!venue) return _empty;

      let ranked2, sd;
      let _saved = null;
      try {
        if (typeof window._setDataForCalc === 'function') {
          _saved = window._setDataForCalc(vdata, venue);
        }

        // calcTenkaiProbs で ranked2 を構築
        const _arek = (typeof rd.arek === 'number' && rd.arek > 0) ? rd.arek : 54.7;
        ranked2 = calcTenkaiProbs(rawBoats, _arek);
        if (!ranked2 || ranked2.length < 2) return _empty;

        // ── final_prob を計算（renderBuy と同一ロジック）──
        // calcTenkaiProbs は prob 順だが、renderBuy は展示・スリット補正後の
        // final_prob でソートして fp1st を決める。
        // ここで final_prob を計算しないと fp1st がズレて買い目が変わる。
        try {
          const _probTotal = ranked2.reduce((s, b) => s + b.prob, 0) || 1;
          const _useMaster = (typeof hasMasterExt === 'function') && hasMasterExt() &&
                             !!(typeof MASTER_EXT !== 'undefined' && MASTER_EXT?.venue_kimari?.[venue]);
          const _tenkaiOnlyTotal = ranked2.reduce((s, x) => s + (x.tenkai_score ?? x.tenkai_prob), 0) || 1;
          const _boatByNo = {};
          rawBoats.forEach(b => { _boatByNo[b.boat] = b; });
          const _tenjiRawMap = {};
          if (tenjiScoreMap && typeof tenjiScoreMap === 'object') {
            Object.keys(tenjiScoreMap).filter(k => /^\d+$/.test(k)).forEach(k => {
              const entry = tenjiScoreMap[k];
              if (entry && typeof entry.tenji === 'number') _tenjiRawMap[parseInt(k)] = entry.tenji;
            });
          }
          const { wBase: _wBase, wTenkai: _wTenkai, wTenji: _wTenji, wSlit: _wSlit } =
            (typeof calcDynamicWeights === 'function') ? calcDynamicWeights(_arek) : { wBase:1, wTenkai:1, wTenji:1, wSlit:0 };

          const BONUS_BASE_TENKAI = 0.15; // [2026-06-27] 旧・比率方式専用の定数。差分方式(TENKAI_DIFF_GAIN)に移行したため現在は未使用（_tenkaiCoef表示用の互換計算にのみ間接的に名残あり）。削除は影響範囲確認後に行う。
          const BONUS_BASE_TENJI  = 0.15;
          const SLIT_BONUS_BASE   = 0.15;
          const MAKURI_ALERT_BONUS = 0.20;
          const hasTenji_ = Object.keys(_tenjiRawMap).length > 0;

          // [2026-06-27 修正] 展開補正の「比率(÷)→係数」方式を「差分(-)→ボーナス」方式に変更。
          //   旧実装: tenkaiCoef = tenkaiNorm / baseNorm を [0.3, 3.0] にクランプ
          //     → baseNorm が極端に大きい艇(例: 1号艇91.8%)はわずかな展開上の不利でも
          //       比率が一気に下振れし、逆に baseNorm が極端に小さい艇(数%の艇)は
          //       わずかな展開上の有利でも比率が爆発し、5艇全員が上限3.0に張り付いて
          //       「差」が消える、という基準確率の偏りに応じた感度の暴走が発生していた。
          //     （実例: 1号艇 基準91.8%→展開補正▼0.64、他5艇 基準2%前後→展開補正▲3.00全員一致
          //       → 最終的に1号艇が91.8%→38.4%まで落ちる異常値の原因）
          //   新実装: tenkaiDiff = tenkaiNorm - baseNorm（展開スコアの絶対的なズレ）を
          //     そのままボーナス量の元にする。比率を経由しないため、baseNorm の大小に
          //     よらず「展開要因がもたらす補正の絶対量」が艇ごとの実際の強弱に比例する。
          // 1パス目: 係数計算
          ranked2.forEach(b => {
            const baseNorm = b.prob / _probTotal;
            const prevBoat = _boatByNo[b.boat - 1] || null;

            // ── 展開差分（比率ではなく絶対差）──
            let tenkaiDiff = 0.0;
            if (_useMaster && baseNorm > 0) {
              const tenkaiNorm = (b.tenkai_score ?? b.tenkai_prob) / _tenkaiOnlyTotal;
              tenkaiDiff = tenkaiNorm - baseNorm;
            }
            // ST差分（隣艇との相対比較）。旧コードは係数(1.0前後)に直接加算していたが、
            // 差分ベースに統一するため baseNorm スケールに合わせて縮小して加算する。
            if (prevBoat) {
              const myStRank   = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[b.name]?.[String(b.boat)]?.st_rank : null;
              const prevStRank = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[prevBoat.name]?.[String(prevBoat.boat)]?.st_rank : null;
              if (myStRank != null && prevStRank != null) {
                tenkaiDiff += (prevStRank - myStRank) * 0.10 * Math.max(baseNorm, 0.02);
              }
            }
            // 旧 tenkaiCoef 互換値（UI表示・ログ用にのみ保持。スコア計算には使わない）
            const tenkaiCoef = baseNorm > 0
              ? Math.min(3.0, Math.max(0.3, (baseNorm + tenkaiDiff) / baseNorm))
              : 1.0;

            let tenjiCoef = 1.0;
            if (tenjiScoreMap && typeof tenjiScoreMap === 'object') tenjiCoef = tenjiScoreMap[`__coef_${b.boat}`] ?? 1.0;
            if (prevBoat && hasTenji_) {
              const myTenji   = _tenjiRawMap[b.boat]        ?? null;
              const prevTenji = _tenjiRawMap[prevBoat.boat] ?? null;
              if (myTenji != null && prevTenji != null) {
                tenjiCoef = Math.min(2.0, Math.max(0.5, tenjiCoef + (prevTenji - myTenji) * 0.50));
              }
            }

            let slitCoef = 1.0;
            if (prevBoat && hasTenji_ && _wSlit > 0 && typeof SLIT_LAP_THRESHOLDS !== 'undefined') {
              const myTenji    = _tenjiRawMap[b.boat]          ?? null;
              const prevTenji  = _tenjiRawMap[prevBoat.boat]   ?? null;
              const myStRank   = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[b.name]?.[String(b.boat)]?.st_rank         ?? null : null;
              const prevStRank = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[prevBoat.name]?.[String(prevBoat.boat)]?.st_rank ?? null : null;
              let slitDiff = null;
              if (myTenji != null && prevTenji != null && myStRank != null && prevStRank != null) {
                slitDiff = (prevTenji - myTenji) + (prevStRank - myStRank) * 0.02;
              } else if (myTenji != null && prevTenji != null) {
                slitDiff = prevTenji - myTenji;
              } else if (myStRank != null && prevStRank != null) {
                slitDiff = (prevStRank - myStRank) * 0.02;
              }
              if (slitDiff !== null) {
                const found   = SLIT_LAP_THRESHOLDS.find(t => slitDiff >= t.min);
                const rawCoef = found ? found.coef : 1.0;
                slitCoef = 1.0 + (rawCoef - 1.0) * _wSlit;
              }
              const tenjiAlertDiff = (myTenji != null && prevTenji != null) ? Math.round((prevTenji - myTenji) * 100) / 100 : null;
              const tenjiAlertOk = tenjiAlertDiff != null && tenjiAlertDiff >= 0.10;
              const myStA  = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[b.name]?.[String(b.boat)]?.st_rank ?? null : null;
              const preStA = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[prevBoat.name]?.[String(prevBoat.boat)]?.st_rank ?? null : null;
              const stAlertOk = myStA != null && preStA != null && (preStA - myStA >= 0.5);
              if (tenjiAlertOk && stAlertOk) slitCoef += MAKURI_ALERT_BONUS;
              slitCoef = Math.min(2.0, Math.max(0.5, slitCoef));
            }

            b._baseNorm   = baseNorm;
            b._tenkaiCoef = tenkaiCoef;   // 互換値（表示・デバッグ用のみ）
            b._tenkaiDiff = tenkaiDiff;   // ボーナス計算で実際に使う値（差分ベース）
            b._tenjiCoef  = tenjiCoef;
            b._slitCoef   = slitCoef;
            b._wTenjiCourse = _wTenji;
          });

          // 2パス目: 加算ボーナス方式 + 後艇スリットペナルティ
          ranked2.forEach(b => {
            const nextBoat = _boatByNo[b.boat + 1] || null;
            // [2026-06-27 修正] tenkaiBonus は旧 (coef-1)*BONUS_BASE 方式から
            // 差分(_tenkaiDiff)を直接使う方式に変更。
            // TENKAI_DIFF_GAIN は旧方式とのスケール整合用の係数（BONUS_BASE_TENKAIに相当する
            // 感応度として導入。実測データで再チューニング可能な値として分離している）。
            const TENKAI_DIFF_GAIN = 1.0;
            const tenkaiBonus = TENKAI_DIFF_GAIN * b._tenkaiDiff * _wTenkai;
            const tenjiBonus  = BONUS_BASE_TENJI  * (b._tenjiCoef  - 1.0) * b._wTenjiCourse;
            const slitBonus   = SLIT_BONUS_BASE   * (b._slitCoef   - 1.0) * _wSlit;

            let slitPenalty = 0;
            if (nextBoat && hasTenji_ && _wSlit > 0 && typeof SLIT_LAP_THRESHOLDS !== 'undefined') {
              const myTenjiN   = _tenjiRawMap[b.boat]           ?? null;
              const nextTenji  = _tenjiRawMap[nextBoat.boat]    ?? null;
              const myStRankN  = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[b.name]?.[String(b.boat)]?.st_rank              ?? null : null;
              const nextStRank = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[nextBoat.name]?.[String(nextBoat.boat)]?.st_rank ?? null : null;
              let nextDiff = null;
              if (myTenjiN != null && nextTenji != null && myStRankN != null && nextStRank != null) {
                nextDiff = (myTenjiN - nextTenji) + (myStRankN - nextStRank) * 0.02;
              } else if (myTenjiN != null && nextTenji != null) {
                nextDiff = myTenjiN - nextTenji;
              } else if (myStRankN != null && nextStRank != null) {
                nextDiff = (myStRankN - nextStRank) * 0.02;
              }
              if (nextDiff !== null && nextDiff > 0) {
                const found    = SLIT_LAP_THRESHOLDS.find(t => nextDiff >= t.min);
                const nextCoef = found ? found.coef : 1.0;
                slitPenalty = SLIT_BONUS_BASE * (nextCoef - 1.0) * _wSlit;
              }
              const nextTenjiAlertOk = myTenjiN != null && nextTenji != null && (nextTenji - myTenjiN <= -0.10);
              const nxtStA  = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[nextBoat.name]?.[String(nextBoat.boat)]?.st_rank ?? null : null;
              const myStA2  = typeof MASTER_EXT !== 'undefined' ? MASTER_EXT?.course_master?.[b.name]?.[String(b.boat)]?.st_rank ?? null : null;
              const nextStAlertOk = myStA2 != null && nxtStA != null && (nxtStA - myStA2 <= -0.5);
              if (nextTenjiAlertOk && nextStAlertOk) slitPenalty += SLIT_BONUS_BASE * 0.20 * _wSlit;
            }

            b._multi_score = Math.max(0.001, b._baseNorm + tenkaiBonus + tenjiBonus + slitBonus - slitPenalty);
          });

          const _multiTotal = ranked2.reduce((s, b) => s + b._multi_score, 0) || 1;
          ranked2.forEach(b => { b.final_prob = b._multi_score / _multiTotal; });

          // ── [2026-06-20 追加] コース別キャリブレーション補正 ──
          // ここまでの final_prob は実測で「1号艇平均74.7%→実績60.8%」という
          // 系統的過大評価を含む（コース別キャリブレーションパネルで確認済み）。
          // calibrateCourse1Prob（computeScenCombosWithEV.js § 1.5 で定義、
          // 区分線形補間・実測データで自動更新）で1号艇のみ補正し、
          // 下がった分を他5艇へ「現在の相対比率のまま」再配分する。
          // → 6艇間の相対評価（誰が強いか）は変えず、絶対水準だけ実測に合わせる。
          try {
            const _boat1 = ranked2.find(b => b.boat === 1);
            if (_boat1 && typeof calibrateCourse1Prob === 'function') {
              const _rawC1 = _boat1.final_prob;
              _boat1._rawCourseProb = _rawC1; // 再学習用（補正前の生値）
              const _calC1 = calibrateCourse1Prob(_rawC1, _boat1.name, venue);
              if (_calC1 != null && !isNaN(_calC1) && Math.abs(_calC1 - _rawC1) > 1e-9) {
                const _others5 = ranked2.filter(b => b.boat !== 1);
                const _others5Total = _others5.reduce((s, b) => s + b.final_prob, 0) || 1;
                const _remaining = Math.max(0, 1 - _calC1);
                _others5.forEach(b => { b.final_prob = _remaining * (b.final_prob / _others5Total); });
                _boat1.final_prob = _calC1;
              }
            }
          } catch (_cc1) { /* 補正失敗時は無補正のまま続行（フォールバック） */ }

          // ── [2026-07-03 追加] 2〜6号艇のコース別キャリブレーション補正 ──
          // 上のブロックで1号艇の補正差分を「比率のまま」再配分しただけの
          // 2〜6号艇の final_prob（＝生値）に、calibrateOtherCourseProb で
          // コース別・確率帯別の実測補正をかける。最後に6艇合計が1.0になるよう
          // 全体を再正規化する（1号艇補正済みの値も含めて再スケールされるが、
          // 相対順位は変えず絶対水準だけを実測に近づけるという設計思想は維持）。
          try {
            if (typeof calibrateOtherCourseProb === 'function') {
              ranked2.forEach(b => {
                if (b.boat == null || b.boat === 1 || b.final_prob == null) return;
                const _rawOther = b.final_prob;
                b._rawCourseProb = _rawOther; // 再学習用（補正前の生値）
                const _calOther = calibrateOtherCourseProb(_rawOther, b.boat);
                if (_calOther != null && !isNaN(_calOther)) {
                  b.final_prob = _calOther;
                }
              });
              const _renormTotal = ranked2.reduce((s, b) => s + (b.final_prob || 0), 0);
              if (_renormTotal > 0 && Math.abs(_renormTotal - 1) > 1e-9) {
                ranked2.forEach(b => { b.final_prob = b.final_prob / _renormTotal; });
              }
            }
          } catch (_cco) { /* 補正失敗時は無補正のまま続行（フォールバック） */ }

          ranked2.sort((a, b) => b.final_prob - a.final_prob);
        } catch (_efp) {
          // final_prob 計算失敗時は prob 順のまま続行（旧挙動フォールバック）
          ranked2.forEach(b => { if (b.final_prob == null) b.final_prob = b.prob; });
        }

        // シナリオデータ算出
        sd = calcScenarioData(ranked2, rawBoats, tenjiScoreMap, venue, vdata);
      } finally {
        // 必ず元に戻す
        if (_saved !== null && typeof window._restoreDataForCalc === 'function') {
          window._restoreDataForCalc(_saved);
        }
      }
      if (!sd || !sd.valid) return _empty;

      // ── 買い目生成（buildScenarioBuyPanel と同一ロジック）──
      // ※ DATA / _pickupRaceTagType はグローバル依存のため、
      //    prefill / top_stats 経由では通常モード（isInNeg=false, isInTep=false）で動作する

      const fp1st = ranked2[0]?.boat;
      const fp2nd = ranked2[1]?.boat;
      if (fp1st == null) return _empty;

      // ── 2着確率上位リスト取得（getPlace2Ranking の内部ロジックを再現）──
      function getP2Ranking(winnerBoat) {
        if (!sd.scenarioPlace2?.[winnerBoat]) return [];
        const totals = {};
        let weightSum = 0;
        for (const [kimari, list] of Object.entries(sd.scenarioPlace2[winnerBoat])) {
          const scenProb = sd.scenarioProb?.[winnerBoat]?.[kimari] ?? 0;
          weightSum += scenProb;
          (list || []).forEach(x => {
            totals[x.boat] = (totals[x.boat] ?? 0) + x.p2 * scenProb;
          });
        }
        if (weightSum > 0) Object.keys(totals).forEach(k => { totals[k] /= weightSum; });
        return Object.entries(totals)
          .sort((a, b) => b[1] - a[1])
          .map(([boat]) => parseInt(boat));
      }

      // ── inn_2place ベース（イン鉄板時）──
      // 場平均乖離率フィルタ付き: シナリオ加重2着確率 / inn_2place[boat] >= 1.2 の艇を優先。
      // inn_2place 未取得・乖離率フィルタで0艇になった場合は乖離率1位にフォールバック。
      const _IT_P2_DIVERGE_MIN = 1.2; // buildInTepBuyPanel の IT_P2_DIVERGE_MIN と同値
      function getInnTepP2Ranking() {
        // シナリオ加重2着確率マップを算出（getP2Ranking と同一ロジック）
        const wMap = {};
        if (sd.scenarioPlace2?.[1]) {
          let ws = 0;
          for (const [kimari, list] of Object.entries(sd.scenarioPlace2[1])) {
            const sp = sd.scenarioProb?.[1]?.[kimari] ?? 0;
            ws += sp;
            (list || []).forEach(x => {
              wMap[x.boat] = (wMap[x.boat] ?? 0) + x.p2 * sp;
            });
          }
          if (ws > 0) Object.keys(wMap).forEach(k => { wMap[k] /= ws; });
        }

        // inn_2place 取得（vdata 優先 → MASTER_EXT フォールバック）
        const inn2p = (() => {
          const v = (vdata.inn_data || {}).inn_2place;
          if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) return v;
          return (typeof MASTER_EXT !== 'undefined') ? MASTER_EXT?.venue_stats?.[venue]?.inn_2place || null : null;
        })();

        // 加重確率降順リスト（1号艇除く）
        const boats = Object.entries(Object.keys(wMap).length > 0 ? wMap : {})
          .map(([b, w]) => ({ boat: parseInt(b), w }))
          .filter(x => x.boat !== 1 && !isNaN(x.boat))
          .sort((a, b) => b.w - a.w);

        if (boats.length === 0) return getP2Ranking(1).filter(b => b !== 1);

        if (inn2p) {
          // 乖離率フィルタ適用
          const diverged = boats.filter(x => {
            const avg = inn2p[String(x.boat)] ?? inn2p[x.boat] ?? null;
            if (avg == null || avg <= 0) return true; // 場平均データなし → 通過
            return (x.w / avg) >= _IT_P2_DIVERGE_MIN;
          });
          // 0艇になったら乖離率1位（boats[0]）のみ採用
          return (diverged.length > 0 ? diverged : boats.slice(0, 1)).map(x => x.boat);
        }

        // inn_2place なし → 従来の inn2Place ベース or 加重確率順
        const inn2pLegacy = sd.inn2Place || {};
        const legacySorted = Object.entries(inn2pLegacy)
          .map(([k, v]) => ({ boat: parseInt(k), rate: v }))
          .filter(x => !isNaN(x.boat) && x.boat !== 1)
          .sort((a, b) => b.rate - a.rate)
          .map(x => x.boat);
        return legacySorted.length > 0 ? legacySorted : boats.map(x => x.boat);
      }

      // ── 3着確率上位リスト（最下位カット付き）──
      // AND条件: 平均×0.5未満 かつ 絶対値0.10未満 を満たす最下位艇をカット。
      // buildInTepBuyPanel の IT_P3_TAIL_RATIO / IT_P3_ABS_MIN と同値。
      const _IT_P3_TAIL_RATIO = 0.5;
      const _IT_P3_ABS_MIN    = 0.10;
      function getP3Ranking(winnerBoat, secondBoat) {
        let list;
        const thirdAll = sd.merged3rdMap?.[winnerBoat]?.[secondBoat] || [];
        if (thirdAll.length > 0) {
          list = thirdAll
            .filter(x => x.boat !== winnerBoat && x.boat !== secondBoat)
            .map(x => ({ boat: x.boat, r3: x.r3 ?? 0 }));
        } else {
          list = ranked2
            .filter(r => r.boat !== winnerBoat && r.boat !== secondBoat)
            .sort((a, b) => (b.final_prob ?? 0) - (a.final_prob ?? 0))
            .map(r => ({ boat: r.boat, r3: r.final_prob ?? 0 }));
        }

        // 最下位カット（2艇以上のときのみ）
        if (list.length >= 2) {
          const avg = list.reduce((s, x) => s + x.r3, 0) / list.length;
          const tail = list[list.length - 1];
          if (tail.r3 < avg * _IT_P3_TAIL_RATIO && tail.r3 < _IT_P3_ABS_MIN) {
            list = list.slice(0, -1);
          }
        }

        return list.map(x => x.boat).slice(0, 3);
      }

      // ── makeBlock（forward + backward）──
      function makeBlock(winner, second, thirdCandidates) {
        const thirds = thirdCandidates.filter(t => t !== winner && t !== second);
        return [
          ...thirds.map(t => `${winner}-${second}-${t}`),
          ...thirds.map(t => `${winner}-${t}-${second}`),
        ];
      }

      // ── buildScenarioBuyPanel と同一の確信度ランク判定 ──
      // [2026-06-01 同期] sample.js の変更を反映:
      //   ・HIGH確率閾値を艇番で分岐（1号艇75% / 2〜6号艇50%）
      //   ・SCEN_CONF_MID_PROB 廃止 → HIGH未満はすべてMID
      //   ・_allow2ndAxis = fp2ndProb >= 0.20（絶対値ベース）
      //   ・HIGH でも _allow2ndAxis なら2軸許可
      function _calcHHI(winnerBoat) {
        const probs = sd?.kimariTypes?.map(k => sd.scenarioProb?.[winnerBoat]?.[k] ?? 0) ?? [];
        const total = probs.reduce((s, p) => s + p, 0);
        if (total <= 0) return 0;
        return probs.reduce((s, p) => s + (p / total) ** 2, 0);
      }

      const SCEN_CONF_HIGH_HHI      = 0.55;
      // [同期: sample.js] HIGH確率閾値を艇番で分岐
      //   1号艇軸: 75%以上（イン鉄板と同等の根拠が必要）
      //   2〜6号艇軸: 50%以上
      const SCEN_CONF_HIGH_PROB_INN = 0.75;
      const SCEN_CONF_HIGH_PROB_OUT = 0.50;
      const SCEN_CONF_MID_HHI       = 0.35;
      // [同期: sample.js] SCEN_CONF_MID_PROB 廃止 → HIGH未満はすべてMID
      const FP2ND_MIN_FOR_2AXIS     = 0.20; // fp2nd がこれ以上なら2軸許可

      const _fp1stProb = ranked2.find(b => b.boat === fp1st)?.final_prob ?? 0;
      const _fp2ndProb = ranked2.find(b => b.boat === fp2nd)?.final_prob ?? 0;
      const _hhi = _calcHHI(fp1st);

      // 軸艇が1号艇かどうかで HIGH の確率閾値を切り替える（sample.js と完全一致）
      const _highProbThreshold = (fp1st === 1) ? SCEN_CONF_HIGH_PROB_INN : SCEN_CONF_HIGH_PROB_OUT;

      let _confRank;
      if (_hhi >= SCEN_CONF_HIGH_HHI && _fp1stProb >= _highProbThreshold) {
        _confRank = 'HIGH';
      } else if (_hhi >= SCEN_CONF_MID_HHI || _fp1stProb < _highProbThreshold) {
        _confRank = 'MID';
      } else {
        _confRank = 'LOW';
      }
      // HIGH でも fp2nd >= 20% なら2軸許可（buildScenarioBuyPanel と同一）
      const _allow2ndAxis = _fp2ndProb >= FP2ND_MIN_FOR_2AXIS;

      // ── ブロック生成（buildScenarioBuyPanel 通常モードと完全一致）──
      const p2r1 = getP2Ranking(fp1st);
      const second_A = p2r1[0];
      const second_B = p2r1[1];
      const block1 = second_A != null ? makeBlock(fp1st, second_A, getP3Ranking(fp1st, second_A)) : [];
      const block2 = second_B != null ? makeBlock(fp1st, second_B, getP3Ranking(fp1st, second_B)) : [];

      let block3;
      let second_C;
      if (_allow2ndAxis) {
        // fp2nd >= 20%: 2軸展開（HIGH/MID/LOW 問わず）
        // [2026-06-01 同期] buildScenarioBuyPanel の新仕様に合わせ
        // HIGH でも fp2nd が十分あれば2軸許可
        const p2r2 = getP2Ranking(fp2nd);
        second_C = p2r2[0];
        block3 = (fp2nd != null && second_C != null)
          ? makeBlock(fp2nd, second_C, getP3Ranking(fp2nd, second_C))
          : [];
      } else {
        // fp2nd < 20%: 2軸目なし
        second_C = null;
        block3 = [];
      }

      // 重複除去
      const allCombosSet = new Set();
      const allCombos = [];
      [block1, block2, block3].forEach(block => {
        block.forEach(c => {
          if (!allCombosSet.has(c)) { allCombosSet.add(c); allCombos.push(c); }
        });
      });

      if (allCombos.length === 0) return _empty;

      // ── hitProbEst 算出（各買い目の calcScenarioComboProb を合算）──
      let rawHitProb = 0;
      let knownCount = 0;
      allCombos.forEach(c => {
        const winner = parseInt(c.split('-')[0]);
        const p = calcScenarioComboProb(c, winner, sd);
        if (p != null && !isNaN(p)) {
          rawHitProb += p;
          knownCount++;
        }
      });

      // 確率が取れた買い目が1つ以上あれば hitProbEst を確定
      const rawHitProbEst = knownCount > 0 ? rawHitProb : null;

      // ── キャリブレーション補正 ──
      // rawHitProbEst は系統的に過小評価されているため CALIB_POINTS で補正する。
      // 補正後は「実際の的中率に近い確率」を返す。
      const hitProbEst = rawHitProbEst != null ? calibrateProb(rawHitProbEst) : null;

      // ── 加重確率ベースの 2着/3着 順位算出 ──
      //
      // 【改善ポイント】
      //   旧: combo の 2着ポジション出現頻度 → 買い目構成バイアスで誤判定
      //   新: scenarioProb × p2 の加重合計 → 真の2着確率に基づく順位
      //
      // top_stats.js の collectResultsForDateScen が actual2nd / actual3rd を持っている
      // ため、ここでは ranked 配列のみを返す。actual との照合は呼び出し側が行う。

      const { weighted: weighted2nd, ranked: ranked2ndList } = calcWeighted2nd(sd, fp1st);

      // [修正] 3着予測を fp1st 固定から fp1st + fp2nd の加重平均に変更。
      // 旧実装は winnerBoat = fp1st 固定のため、fp2nd が実際に1着になったレースで
      // 3着予測が全く機能せず識別力2%という結果になっていた。
      // fp1st / fp2nd それぞれの final_prob を重みとして加重平均することで
      // 実際の1着分布に近い3着確率を推定する。
      const _w3fp1 = calcWeighted3rd(sd, fp1st);
      const _w3fp2 = fp2nd != null ? calcWeighted3rd(sd, fp2nd) : { weighted: {}, ranked: [] };
      const _p1w = ranked2.find(b => b.boat === fp1st)?.final_prob ?? 0.7;
      const _p2w = fp2nd != null ? (ranked2.find(b => b.boat === fp2nd)?.final_prob ?? 0.3) : 0;
      const _pw_total = _p1w + _p2w || 1;
      const weighted3rd = {};
      new Set([...Object.keys(_w3fp1.weighted), ...Object.keys(_w3fp2.weighted)]).forEach(k => {
        weighted3rd[k] = (((_w3fp1.weighted[k] ?? 0) * _p1w) + ((_w3fp2.weighted[k] ?? 0) * _p2w)) / _pw_total;
      });
      const ranked3rdList = Object.entries(weighted3rd)
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => parseInt(k));

      // ── 各艇の予測勝率マップ（コース別キャリブレーション用）──
      // ranked2 の final_prob を { 枠番: 予測勝率 } 形式で返す。
      // calibration.js が「モデルが各コースに何%の勝率を与えていたか」を
      // 実績と比較するために使用する。
      const boatProbs = {};
      const boatProbsRaw = {};
      ranked2.forEach(b => {
        if (b.boat != null && b.final_prob != null) {
          boatProbs[b.boat] = b.final_prob;
        }
        // [2026-06-20 追加/2026-07-03 拡張] 全艇の補正前の生値も保持。
        // calibration.js がこちらを使って updateCourse1CalibPoints /
        // updateCourseOtherCalibPoints を呼ぶことで、補正済み値を
        // 学習材料にしてしまう自己崩壊ループを防ぐ。
        if (b.boat != null && b._rawCourseProb != null) {
          boatProbsRaw[b.boat] = b._rawCourseProb;
        }
      });

      // [2026-07-13 追加] 予測決まり手（全 winner×kimari の中で最大確率のペア）。
      // calibration.js の決まり手キャリブレーション（predKimari vs actualKimari）用。
      // 既存の買い目生成・EV計算・boatProbs等には一切影響しない（読み取り専用の追加計算）。
      let topKimariBoat = null;
      let topKimariType = null;
      try {
        let _bestP = -1;
        Object.entries(sd.scenarioProb || {}).forEach(([boatStr, kMap]) => {
          Object.entries(kMap || {}).forEach(([kimari, p]) => {
            if (p > _bestP) { _bestP = p; topKimariBoat = parseInt(boatStr, 10); topKimariType = kimari; }
          });
        });
      } catch(_e) { /* 予測決まり手の計算失敗は無視（既存機能に影響なし） */ }

      return {
        combos      : allCombos,
        hitProbEst,             // キャリブレーション補正済み
        _rawHitProbEst: rawHitProbEst, // デバッグ用（補正前）
        synthOdds   : null,     // 呼び出し側（top_stats.js）で ODDS_DATA から計算
        ev          : null,     // 同上（synthOdds が確定してから計算）
        boatProbs,              // { 枠番: final_prob } コース別勝率キャリブレーション用
        boatProbsRaw,           // { 1: 補正前nigeProb } コース別補正の再学習用（デバッグ）
        // 2着/3着順位リスト（top_stats.js で actual2nd/3rd と照合して pred?ndRank を付与）
        ranked2ndList,          // [最有力艇, 2位艇, ...] 加重確率降順
        ranked3rdList,          // 同上（3着）
        // デバッグ用
        weighted2nd,
        weighted3rd,
        // pred?ndRank は呼び出し側で actual2nd/3rd と突き合わせるため
        // ここでは返さない（actual が不明なため）
        pred2ndRank : null,
        pred3rdRank : null,
        // [2026-07-13 追加] 予測決まり手（呼び出し側で actualKimari と突き合わせる）
        topKimariBoat,
        topKimariType,
      };

    } catch (e) {
      // console.warn('[computeScenCombosWithEV] エラー:', e);  // suppressed
      return {
        combos: [], hitProbEst: null, synthOdds: null, ev: null,
        pred2ndRank: null, pred3rdRank: null,
        weighted2nd: {}, weighted3rd: {},
        topKimariBoat: null, topKimariType: null,
      };
    }
  };


  // ─────────────────────────────────────────────────────────────────────────
  // § 4  top_stats.js の collectResultsForDateScen へのパッチ
  //
  //       top_stats.js の pred2ndRank / pred3rdRank 算出箇所（「頻度ベース」）を
  //       加重確率ベースに差し替えるモンキーパッチ。
  //
  //       【設計方針】
  //         top_stats.js を直接編集するのではなく、
  //         computeScenCombosWithEV の戻り値に ranked2ndList / ranked3rdList を
  //         持たせ、top_stats.js 側でそれを使って pred?ndRank を算出させる。
  //
  //         ただし top_stats.js は既存コードのため ranked2ndList を参照していない。
  //         そのため、collectResultsForDateScen をラップして
  //         results[] の各エントリに ranked2ndList を使った pred?ndRank を上書きする。
  //
  //       【適用条件】
  //         - collectResultsForDateScen が定義済みであること
  //         - まだラップされていないこと（二重ラップ防止）
  // ─────────────────────────────────────────────────────────────────────────

  function _applyPred2ndPatch() {
    if (typeof collectResultsForDateScen !== 'function') return;
    if (collectResultsForDateScen._patched) return; // 二重ラップ防止

    const _orig = collectResultsForDateScen;

    window.collectResultsForDateScen = function (dateStr, includeAll) {
      const results = _orig.call(this, dateStr, includeAll);
      if (!Array.isArray(results)) return results;

      // computeScenCombosWithEV の ranked2ndList / ranked3rdList を使って
      // pred2ndRank / pred3rdRank を加重確率ベースに上書き
      results.forEach(r => {
        // [2026-06-20 修正] 旧実装は「2着/3着データが無いレースは丸ごとスキップ」
        // していたため、boatProbs（コース別キャリブレーション用）も
        // 同じ条件で巻き添えになり、全レコードに boatProbs が付与されず
        // コース別キャリブレーション表が常に「—」になっていた。
        // boatProbs は1着結果だけで判定するロジックなので、
        // 2着/3着データの有無に関わらず必ず計算・コピーする。

        try {
          const dataForDate = (typeof getDataForDate === 'function')
            ? getDataForDate(dateStr) : null;
          if (!dataForDate) return;
          const vdata = dataForDate[r.venue];
          if (!vdata) return;

          const res = window.computeScenCombosWithEV(r.venue, vdata, r.rno);
          if (!res) return;

          // ── boatProbs を常にコピー（コース別キャリブレーション用）──
          if (res.boatProbs) {
            r.boatProbs = res.boatProbs;
          }
          if (res.boatProbsRaw) {
            r.boatProbsRaw = res.boatProbsRaw;
          }

          // ── 加重確率ベースで pred2ndRank を上書き ──
          if (r.actual2nd != null && res.ranked2ndList?.length > 0) {
            const idx = res.ranked2ndList.indexOf(r.actual2nd);
            r.pred2ndRank = idx >= 0 ? idx + 1 : null;
          }

          // ── 加重確率ベースで pred3rdRank を上書き ──
          if (r.actual3rd != null && res.ranked3rdList?.length > 0) {
            const idx = res.ranked3rdList.indexOf(r.actual3rd);
            r.pred3rdRank = idx >= 0 ? idx + 1 : null;
          }

          // ── hitProbEst も更新（キャリブレーション補正済みの値で上書き）──
          // [2026-06-01 修正] hitProbEst 上書き後に r.ev も必ず再計算する。
          // 旧: r.ev を再計算せずに放置 → r.ev = null のままキャッシュに保存され
          //     EV1.1フィルタを通過するレースが過去30日分で0件になるバグ。
          // 新: r.synth が取れていれば ev = synth × 補正後 hitProbEst で上書き。
          //
          // [2026-06-20 修正] 二重補正による自己崩壊ループ対策。
          // r.hitProbEst は常に「補正済み」の値になるため、calibration.js が
          // 補正テーブル再学習用の「生の推定値」を区別できるよう、
          // 補正前の値を r._rawHitProbEst として別途保持する。
          if (res.hitProbEst != null) {
            r.hitProbEst     = res.hitProbEst;
            r.hitRate        = res.hitProbEst; // hitRate は hitProbEst の別名
            r._rawHitProbEst = (res._rawHitProbEst != null) ? res._rawHitProbEst : r._rawHitProbEst;
            // ★ ev を synth × 補正済み hitProbEst で再計算
            if (r.synth != null) {
              r.ev = r.synth * res.hitProbEst;
            }
          }

        } catch (_e) { /* エラーは無視して元の値を保持 */ }
      });

      return results;
    };

    window.collectResultsForDateScen._patched = true;
  }

  // DOM 読み込み後に適用（top_stats.js が先に読み込まれている前提）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _applyPred2ndPatch);
  } else {
    // 既に DOMContentLoaded 済み → 遅延実行で top_stats.js の定義を待つ
    setTimeout(_applyPred2ndPatch, 0);
  }

  window.computeScenCombosWithEV = _computeScenCombosWithEV_impl;

  // ── 強制上書き: obf ファイルのラッパーが古い _orig を掴んでいる問題を回避 ──
  // obf ファイルが window.computeScenCombosWithEV をラップして
  // 古い実装を _orig として保持し続けるため、
  // このファイルのロード完了時点で新実装で強制再上書きする。
  // obf ファイルが後からロードされて上書きする可能性があるため
  // setTimeout で遅延実行し、全スクリプト読み込み完了後に強制上書きする
  function _forceOverride() {
    const _src = window.computeScenCombosWithEV
      ? window.computeScenCombosWithEV.toString() : '';
    if (_src.indexOf('_orig') !== -1 || _src.indexOf('_computeScenCombosWithEV_impl') === -1) {
      window.computeScenCombosWithEV = _computeScenCombosWithEV_impl;
    } else {
    }
  }
  // 即時 + 遅延の二段構え
  _forceOverride();
  setTimeout(_forceOverride, 0);
  setTimeout(_forceOverride, 500);


})();


// ══════════════════════════════════════════════════════════════════════════════
// 【使い方まとめ】
//
// 1. このファイルを以下の順序で HTML に読み込む:
//      <script src="sample.js"></script>
//      <script src="top_stats.js"></script>
//      <script src="calibration.js"></script>
//      <script src="dynamic_inn2place.js"></script>
//      <script src="computeScenCombosWithEV.js"></script>  ← 最後に追加
//
// 2. calibration.js の _renderCalibrationPanel 末尾に以下を追加すると
//    キャリブレーション補正テーブルが自動更新される:
//
//      // 補正テーブルを自動更新
//      const _binStats = calcCalibration(results);
//      if (typeof updateCalibPoints === 'function') updateCalibPoints(_binStats);
//
// 3. top_stats.js / sample.js の変更は一切不要。
//
// 【期待される改善効果】
//
//  ■ hitProbEst キャリブレーション
//    加重平均誤差: 10.6% → 目標 5% 以下
//    （実測 binStats を updateCalibPoints に渡し続けることで自動改善）
//
//  ■ 2着1位的中率
//    旧（頻度ベース）: 24% → 改善目標: 40〜45%
//    理由: 買い目構成バイアスを排除し、真の2着確率で順位付けするため
//
//  ■ 3着1位的中率
//    旧（頻度ベース）: 20% → 改善目標: 30〜35%
//    理由: merged3rdMap の r3 × p2 × scenarioProb で真の3着確率を算出するため
//
//  ■ 買い目点数の一致（修正④）
//    旧: 常に2軸18点で固定 → 画面表示（buildScenarioBuyPanel）と食い違うケースあり
//    新: _confRank（HIGH/MID/LOW）と _allow2ndAxis を追加
//        HIGH または fp差>15%pt → 1軸最大12点
//        MID/LOW かつ fp差≤15%pt → 2軸最大18点（重複除去後16〜18点）
//        → top_stats.js の集計点数・期待値が画面表示と完全に一致する
//

//    hitProbEst が実態に近づくことで EV = synthOdds × hitProbEst の精度が向上し、
//    EV フィルタ（例: EV ≥ 1.1）による買い目選別の正確性が上がる。
//    「高EV → 実際に高回収」の相関が強まり、長期的な回収率改善に寄与する。
//
// ══════════════════════════════════════════════════════════════════════════════
