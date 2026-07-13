function isGradeMode() {
  if (!currentVenue) return false;
  const grade = (
    typeof RACE_INDEX_DATA !== 'undefined' &&
    RACE_INDEX_DATA &&
    RACE_INDEX_DATA.venues
  ) ? (RACE_INDEX_DATA.venues[currentVenue]?.grade ?? '一般') : '一般';
  return grade === 'SG' || grade === 'G1';
}

/**
 * コース別マスタエントリを返す共通ヘルパー。
 *
 * 優先順位（引継ぎポイント最重要事項）:
 *   グレードモード(SG/G1):
 *     1. MASTER_EXT.course_master_g1[name][course]  reliable=true
 *     2. MASTER_EXT.course_master[name][course]       ← reliable=false のフォールバック
 *     ※ SGでも出場経験が少なくて reliable=false の選手は必ず存在する。
 *        フォールバックがないとデータなし選手が全員同一確率になって計算が破綻する。
 *   女子戦(DATA.is_joshi):
 *     1. MASTER_EXT.course_master_joshi[name][course] reliable=true
 *     2. MASTER_EXT.course_master[name][course]
 *   その他:
 *     MASTER_EXT.course_master[name][course]
 *
 * @param {string} name   - 選手名
 * @param {string} course - コース番号文字列 ("1"〜"6")
 * @returns {object|undefined} コース別マスタエントリ
 */
function getCourseMaster(name, course) {
  if (!MASTER_EXT) return undefined;

  const cmBase  = MASTER_EXT.course_master;
  const cmG1    = MASTER_EXT.course_master_g1;
  const cmJoshi = MASTER_EXT.course_master_joshi;

  if (isGradeMode() && cmG1) {
    const entryG1 = cmG1[name]?.[course];
    if (entryG1 && entryG1.reliable) return entryG1;
    // reliable=false → 一般戦マスタに静かにフォールバック
    return cmBase?.[name]?.[course];
  }

  if (DATA?.is_joshi && cmJoshi) {
    const entryJ = cmJoshi[name]?.[course];
    if (entryJ && entryJ.reliable) return entryJ;
    return cmBase?.[name]?.[course];
  }

  return cmBase?.[name]?.[course];
}

// [追加 2026-07-05] 3着予測の最終フォールバック用・コース別固定統計値。
// 会場別データ・全国平均データの両方が欠損している場合にのみ使用する。
// final_prob（1着確率）への引きずられを防ぐための絶対的な最終防波堤。
const FIXED_3RD_RATE_BY_COURSE = { 1: 0.14, 2: 0.17, 3: 0.18, 4: 0.19, 5: 0.17, 6: 0.15 };
const FIXED_3RD_RATE_DEFAULT   = 0.16;

// buildWeatherBar / buildCourseOrderBanner / buildTenjiSection は renderer.js で定義済み

// VENUE_TENJI_CONFIG / SUMINOE_TENJI_TABLE / VENUE_SLUG_MAP は config.js で定義済み

function fieldRawVals(boats, tenjiData, field){
  const vals = boats.map(b => tenjiData[b.boat]?.[field] ?? null);
  const validVals = vals.filter(v => v !== null);
  if(validVals.length === 0) return null;
  const fillAvg = validVals.reduce((a, v) => a + v, 0) / validVals.length;
  return vals.map(v => v !== null ? v : fillAvg);
}

// ── [2026-05-18 修正] calcTenjiScore → 合成スコア平均乖離 × コース別感度方式 ──
//
// 【設計】
//   ① 展示スコア = lap1×w + (mawari or chokusen)×w + tenji×w （生タイム加重合算）
//      → 小さいほど速い（タイム値の合計）
//   ② 6艇の平均スコアを基準に乖離率を算出
//      deviation = (avg - 艇スコア) / avg  → 速い艇はプラス
//   ③ 乖離率 × TENJI_SENSITIVITY_BY_COURSE[枠番] で rawCoef を生成
//      → 同じ乖離率でも枠番によって係数の伸びが変わる
//      → 1号艇と6号艇が同タイムなら6号艇（sensitivity大）を高評価
//
// 返り値: { [boat番号]: 正規化スコア, __coef_N: 平均1.0基準の係数 } または null
//

// ── 住之江 展示補正テーブル ──
// diff = 平均 - 各艇合算（1周+回り足+展示）。速い艇→プラス。小数第2位で四捨五入。
// 補正率(%)はそのまま係数に変換: +13% → 1.13, -7% → 0.93
// 列: lo(下限), hi(上限), p1(1着率%), p2(2着率%), p3(3着率%), p3r(3連対率%)
function calcTenjiScore(boats, tenjiData, venue, arek){
  if(!tenjiData) return null;

  // ── 住之江専用: 実測補正テーブルから __coef を生成 ──
  if(venue === '住之江'){
    const lap1Vals   = fieldRawVals(boats, tenjiData, 'lap1');
    const mawariVals = fieldRawVals(boats, tenjiData, 'mawari');
    const tenjiVals  = fieldRawVals(boats, tenjiData, 'tenji');
    if(!tenjiVals) return null;

    // 合算（使えない項目は0扱い）
    const sums = boats.map((b, i) => {
      let s = tenjiVals[i];
      if(lap1Vals)   s += lap1Vals[i];
      if(mawariVals) s += mawariVals[i];
      return s;
    });
    // 6艇平均（小数第2位で四捨五入）
    const rawAvg = sums.reduce((a, v) => a + v, 0) / sums.length;
    const avg = Math.round(rawAvg * 100) / 100;

    const map = {};
    boats.forEach((b, i) => {
      const diff = Math.round((avg - sums[i]) * 100) / 100; // 速い=プラス
      const row  = _suminoeTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0, p3r: 0 };
      // %pt → 係数（例: +13%pt → 1.13）
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__rawP1_${b.boat}`] = row.p1 ?? 0;  // [2026-07-13 追加] テーブル参照直後の生の1着率加減値(pt)。クランプ一切なし
      map[`__rawBinP1_${b.boat}`] = row.rawP1 ?? 0;  // [2026-07-13 追加] 補間なしの本当の生テーブル値(整数)。表示専用（スリット補正）
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;  // バッジ表示用
      // p3r ±10% 以上で軸/切フラグ
      map[`__pivot_${b.boat}`] = (row.p3r ?? 0) >= 10 ? 'axis' : (row.p3r ?? 0) <= -10 ? 'cut' : null;
      map[`__p3r_${b.boat}`] = row.p3r ?? 0;  // 3連対率補正値（%pt）そのものを保持（表示用）
      map[b.boat] = 1 / boats.length;   // 正規化スコア（均等）
    });
    map.__isSuminoe = true;  // buildScenarioSectionのバッジ判定用
    return map;
  }

  // ── 常滑専用: 実測補正テーブルから __coef を生成 ──
  // diff = 1周 + 展示（回り足は含まない）
  if(venue === '常滑'){
    const lap1Vals  = fieldRawVals(boats, tenjiData, 'lap1');
    const tenjiVals = fieldRawVals(boats, tenjiData, 'tenji');
    if(!tenjiVals) return null;

    const sums = boats.map((b, i) => {
      let s = tenjiVals[i];
      if(lap1Vals) s += lap1Vals[i];
      return s;
    });
    const rawAvg = sums.reduce((a, v) => a + v, 0) / sums.length;
    const avg = Math.round(rawAvg * 100) / 100;

    const map = {};
    boats.forEach((b, i) => {
      const diff = Math.round((avg - sums[i]) * 100) / 100; // 速い=プラス
      const row  = _tokonameTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0, p3r: 0 };
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__rawP1_${b.boat}`] = row.p1 ?? 0;  // [2026-07-13 追加] テーブル参照直後の生の1着率加減値(pt)。クランプ一切なし
      map[`__rawBinP1_${b.boat}`] = row.rawP1 ?? 0;  // [2026-07-13 追加] 補間なしの本当の生テーブル値(整数)。表示専用（スリット補正）
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;
      // p3r ±10% 以上で軸/切フラグ
      map[`__pivot_${b.boat}`] = (row.p3r ?? 0) >= 10 ? 'axis' : (row.p3r ?? 0) <= -10 ? 'cut' : null;
      map[`__p3r_${b.boat}`] = row.p3r ?? 0;  // 3連対率補正値（%pt）そのものを保持（表示用）
      map[b.boat] = 1 / boats.length;
    });
    map.__isSuminoe = true;  // バッジ表示を住之江と共通化
    return map;
  }

  // ── 蒲郡専用: 実測補正テーブルから __coef を生成 ──
  // diff = 1周 + 直線 + 展示（回り足は含まない）
  if(venue === '蒲郡'){
    const lap1Vals    = fieldRawVals(boats, tenjiData, 'lap1');
    const chokusenVals = fieldRawVals(boats, tenjiData, 'chokusen');
    const tenjiVals   = fieldRawVals(boats, tenjiData, 'tenji');
    if(!tenjiVals) return null;

    const sums = boats.map((b, i) => {
      let s = tenjiVals[i];
      if(lap1Vals)     s += lap1Vals[i];
      if(chokusenVals) s += chokusenVals[i];
      return s;
    });
    const rawAvg = sums.reduce((a, v) => a + v, 0) / sums.length;
    const avg = Math.round(rawAvg * 100) / 100;

    const map = {};
    boats.forEach((b, i) => {
      const diff = Math.round((avg - sums[i]) * 100) / 100; // 速い=プラス
      const row  = _gamagoriTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0, p3r: 0 };
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__rawP1_${b.boat}`] = row.p1 ?? 0;  // [2026-07-13 追加] テーブル参照直後の生の1着率加減値(pt)。クランプ一切なし
      map[`__rawBinP1_${b.boat}`] = row.rawP1 ?? 0;  // [2026-07-13 追加] 補間なしの本当の生テーブル値(整数)。表示専用（スリット補正）
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;
      // p3r ±10% 以上で軸/切フラグ
      map[`__pivot_${b.boat}`] = (row.p3r ?? 0) >= 10 ? 'axis' : (row.p3r ?? 0) <= -10 ? 'cut' : null;
      map[`__p3r_${b.boat}`] = row.p3r ?? 0;  // 3連対率補正値（%pt）そのものを保持（表示用）
      map[b.boat] = 1 / boats.length;
    });
    map.__isSuminoe = true;  // バッジ表示を住之江と共通化
    return map;
  }

  // ── [2026-07-12 追加] 三国専用: 実測補正テーブルから __coef を生成 ──
  // diff = 1周 + 回り足 + 展示（直線は含まない）。住之江と同じ構成。
  if(venue === '三国'){
    const lap1Vals   = fieldRawVals(boats, tenjiData, 'lap1');
    const mawariVals = fieldRawVals(boats, tenjiData, 'mawari');
    const tenjiVals  = fieldRawVals(boats, tenjiData, 'tenji');
    if(!tenjiVals) return null;

    const sums = boats.map((b, i) => {
      let s = tenjiVals[i];
      if(lap1Vals)   s += lap1Vals[i];
      if(mawariVals) s += mawariVals[i];
      return s;
    });
    const rawAvg = sums.reduce((a, v) => a + v, 0) / sums.length;
    const avg = Math.round(rawAvg * 100) / 100;

    const map = {};
    boats.forEach((b, i) => {
      const diff = Math.round((avg - sums[i]) * 100) / 100; // 速い=プラス
      const row  = _mikuniTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0, p3r: 0 };
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__rawP1_${b.boat}`] = row.p1 ?? 0;  // [2026-07-13 追加] テーブル参照直後の生の1着率加減値(pt)。クランプ一切なし
      map[`__rawBinP1_${b.boat}`] = row.rawP1 ?? 0;  // [2026-07-13 追加] 補間なしの本当の生テーブル値(整数)。表示専用（スリット補正）
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;
      // p3r ±10% 以上で軸/切フラグ
      map[`__pivot_${b.boat}`] = (row.p3r ?? 0) >= 10 ? 'axis' : (row.p3r ?? 0) <= -10 ? 'cut' : null;
      map[`__p3r_${b.boat}`] = row.p3r ?? 0;  // 3連対率補正値（%pt）そのものを保持（表示用）
      map[b.boat] = 1 / boats.length;
    });
    map.__isSuminoe = true;  // バッジ表示・1着直接乗算判定を住之江と共通化
    return map;
  }

  // ── [2026-07-12 追加] 鳴門専用: 実測補正テーブルから __coef を生成 ──
  // diff = 1周 + 直線 + 展示（回り足は含まない）。蒲郡と同じ構成。
  if(venue === '鳴門'){
    const lap1Vals     = fieldRawVals(boats, tenjiData, 'lap1');
    const chokusenVals = fieldRawVals(boats, tenjiData, 'chokusen');
    const tenjiVals    = fieldRawVals(boats, tenjiData, 'tenji');
    if(!tenjiVals) return null;

    const sums = boats.map((b, i) => {
      let s = tenjiVals[i];
      if(lap1Vals)     s += lap1Vals[i];
      if(chokusenVals) s += chokusenVals[i];
      return s;
    });
    const rawAvg = sums.reduce((a, v) => a + v, 0) / sums.length;
    const avg = Math.round(rawAvg * 100) / 100;

    const map = {};
    boats.forEach((b, i) => {
      const diff = Math.round((avg - sums[i]) * 100) / 100; // 速い=プラス
      const row  = _narutoTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0, p3r: 0 };
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__rawP1_${b.boat}`] = row.p1 ?? 0;  // [2026-07-13 追加] テーブル参照直後の生の1着率加減値(pt)。クランプ一切なし
      map[`__rawBinP1_${b.boat}`] = row.rawP1 ?? 0;  // [2026-07-13 追加] 補間なしの本当の生テーブル値(整数)。表示専用（スリット補正）
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;
      // p3r ±10% 以上で軸/切フラグ
      map[`__pivot_${b.boat}`] = (row.p3r ?? 0) >= 10 ? 'axis' : (row.p3r ?? 0) <= -10 ? 'cut' : null;
      map[`__p3r_${b.boat}`]   = row.p3r ?? 0;  // 3連対率補正値（%pt）そのものを保持（表示用）
      map[b.boat] = 1 / boats.length;
    });
    map.__isSuminoe = true;  // バッジ表示・1着直接乗算判定を住之江と共通化
    return map;
  }

  // ── [2026-07-12 追加] 多摩川専用: 実測補正テーブルから __coef を生成 ──
  // diff = 1周 + 直線 + 展示（回り足は含まない）。蒲郡・鳴門と同じ構成。
  if(venue === '多摩川'){
    const lap1Vals     = fieldRawVals(boats, tenjiData, 'lap1');
    const chokusenVals = fieldRawVals(boats, tenjiData, 'chokusen');
    const tenjiVals    = fieldRawVals(boats, tenjiData, 'tenji');
    if(!tenjiVals) return null;

    const sums = boats.map((b, i) => {
      let s = tenjiVals[i];
      if(lap1Vals)     s += lap1Vals[i];
      if(chokusenVals) s += chokusenVals[i];
      return s;
    });
    const rawAvg = sums.reduce((a, v) => a + v, 0) / sums.length;
    const avg = Math.round(rawAvg * 100) / 100;

    const map = {};
    boats.forEach((b, i) => {
      const diff = Math.round((avg - sums[i]) * 100) / 100; // 速い=プラス
      const row  = _tamagawaTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0, p3r: 0 };
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__rawP1_${b.boat}`] = row.p1 ?? 0;  // [2026-07-13 追加] テーブル参照直後の生の1着率加減値(pt)。クランプ一切なし
      map[`__rawBinP1_${b.boat}`] = row.rawP1 ?? 0;  // [2026-07-13 追加] 補間なしの本当の生テーブル値(整数)。表示専用（スリット補正）
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;
      // p3r ±10% 以上で軸/切フラグ
      map[`__pivot_${b.boat}`] = (row.p3r ?? 0) >= 10 ? 'axis' : (row.p3r ?? 0) <= -10 ? 'cut' : null;
      map[`__p3r_${b.boat}`]   = row.p3r ?? 0;  // 3連対率補正値（%pt）そのものを保持（表示用）
      map[b.boat] = 1 / boats.length;
    });
    map.__isSuminoe = true;  // バッジ表示・1着直接乗算判定を住之江と共通化
    return map;
  }

  // ── [2026-07-12 追加] 平和島専用: 実測補正テーブルから __coef を生成 ──
  // diff = 1周 + 直線 + 展示（回り足は含まない）。蒲郡・鳴門・多摩川と同じ構成。
  if(venue === '平和島'){
    const lap1Vals     = fieldRawVals(boats, tenjiData, 'lap1');
    const chokusenVals = fieldRawVals(boats, tenjiData, 'chokusen');
    const tenjiVals    = fieldRawVals(boats, tenjiData, 'tenji');
    if(!tenjiVals) return null;

    const sums = boats.map((b, i) => {
      let s = tenjiVals[i];
      if(lap1Vals)     s += lap1Vals[i];
      if(chokusenVals) s += chokusenVals[i];
      return s;
    });
    const rawAvg = sums.reduce((a, v) => a + v, 0) / sums.length;
    const avg = Math.round(rawAvg * 100) / 100;

    const map = {};
    boats.forEach((b, i) => {
      const diff = Math.round((avg - sums[i]) * 100) / 100; // 速い=プラス
      const row  = _heiwajimaTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0, p3r: 0 };
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__rawP1_${b.boat}`] = row.p1 ?? 0;  // [2026-07-13 追加] テーブル参照直後の生の1着率加減値(pt)。クランプ一切なし
      map[`__rawBinP1_${b.boat}`] = row.rawP1 ?? 0;  // [2026-07-13 追加] 補間なしの本当の生テーブル値(整数)。表示専用（スリット補正）
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;
      // p3r ±10% 以上で軸/切フラグ
      map[`__pivot_${b.boat}`] = (row.p3r ?? 0) >= 10 ? 'axis' : (row.p3r ?? 0) <= -10 ? 'cut' : null;
      map[`__p3r_${b.boat}`]   = row.p3r ?? 0;  // 3連対率補正値（%pt）そのものを保持（表示用）
      map[b.boat] = 1 / boats.length;
    });
    map.__isSuminoe = true;  // バッジ表示・1着直接乗算判定を住之江と共通化
    return map;
  }

  // ── [2026-07-14 追加] 芦屋専用: 実測補正テーブルから __coef を生成 ──
  // diff = 1周 + 展示（回り足・直線とも含まない）。常滑と同じ構成。
  if(venue === '芦屋'){
    const lap1Vals  = fieldRawVals(boats, tenjiData, 'lap1');
    const tenjiVals = fieldRawVals(boats, tenjiData, 'tenji');
    if(!tenjiVals) return null;

    const sums = boats.map((b, i) => {
      let s = tenjiVals[i];
      if(lap1Vals) s += lap1Vals[i];
      return s;
    });
    const rawAvg = sums.reduce((a, v) => a + v, 0) / sums.length;
    const avg = Math.round(rawAvg * 100) / 100;

    const map = {};
    boats.forEach((b, i) => {
      const diff = Math.round((avg - sums[i]) * 100) / 100; // 速い=プラス
      const row  = _ashiyaTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0, p3r: 0 };
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__rawP1_${b.boat}`] = row.p1 ?? 0;  // テーブル参照直後の生の1着率加減値(pt)。クランプ一切なし
      map[`__rawBinP1_${b.boat}`] = row.rawP1 ?? 0;  // 補間なしの本当の生テーブル値(整数)。表示専用（スリット補正）
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;
      // p3r ±10% 以上で軸/切フラグ
      map[`__pivot_${b.boat}`] = (row.p3r ?? 0) >= 10 ? 'axis' : (row.p3r ?? 0) <= -10 ? 'cut' : null;
      map[`__p3r_${b.boat}`]   = row.p3r ?? 0;  // 3連対率補正値（%pt）そのものを保持（表示用）
      map[b.boat] = 1 / boats.length;
    });
    map.__isSuminoe = true;  // バッジ表示・1着直接乗算判定を住之江と共通化
    return map;
  }


  // diff = 1周 + 直線 + 展示（回り足は含まない）。蒲郡・鳴門・多摩川・平和島と同じ構成。
  if(venue === '戸田'){
    const lap1Vals     = fieldRawVals(boats, tenjiData, 'lap1');
    const chokusenVals = fieldRawVals(boats, tenjiData, 'chokusen');
    const tenjiVals    = fieldRawVals(boats, tenjiData, 'tenji');
    if(!tenjiVals) return null;

    const sums = boats.map((b, i) => {
      let s = tenjiVals[i];
      if(lap1Vals)     s += lap1Vals[i];
      if(chokusenVals) s += chokusenVals[i];
      return s;
    });
    const rawAvg = sums.reduce((a, v) => a + v, 0) / sums.length;
    const avg = Math.round(rawAvg * 100) / 100;

    const map = {};
    boats.forEach((b, i) => {
      const diff = Math.round((avg - sums[i]) * 100) / 100; // 速い=プラス
      const row  = _todaTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0, p3r: 0 };
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__rawP1_${b.boat}`] = row.p1 ?? 0;  // テーブル参照直後の生の1着率加減値(pt)。クランプ一切なし
      map[`__rawBinP1_${b.boat}`] = row.rawP1 ?? 0;  // 補間なしの本当の生テーブル値(整数)。表示専用（スリット補正）
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;
      // p3r ±10% 以上で軸/切フラグ
      map[`__pivot_${b.boat}`] = (row.p3r ?? 0) >= 10 ? 'axis' : (row.p3r ?? 0) <= -10 ? 'cut' : null;
      map[`__p3r_${b.boat}`]   = row.p3r ?? 0;  // 3連対率補正値（%pt）そのものを保持（表示用）
      map[b.boat] = 1 / boats.length;
    });
    map.__isSuminoe = true;  // バッジ表示・1着直接乗算判定を住之江と共通化
    return map;
  }

  const cfg = VENUE_TENJI_CONFIG[venue] || VENUE_TENJI_CONFIG["_default"];

  // ① 項目別の生タイム値を取得
  const lap1Vals     = fieldRawVals(boats, tenjiData, "lap1");
  const mawariVals   = fieldRawVals(boats, tenjiData, "mawari");
  const chokusenVals = fieldRawVals(boats, tenjiData, "chokusen");
  const tenjiVals    = fieldRawVals(boats, tenjiData, "tenji");

  // tenji は必須
  if(!tenjiVals) return null;

  // 会場重みを解決（計測なし項目はゼロ）
  const w = (() => {
    const base = { ...cfg.weight };
    if(!cfg.available.lap1)     base.lap1     = 0;
    if(!cfg.available.mawari)   base.mawari   = 0;
    if(!cfg.available.chokusen) base.chokusen = 0;
    if(!cfg.available.tenji)    base.tenji    = 0;
    return base;
  })();

  const useLap1     = w.lap1     > 0 && lap1Vals     !== null;
  const useMawari   = w.mawari   > 0 && mawariVals   !== null;
  const useChokusen = w.chokusen > 0 && chokusenVals  !== null;

  // lap1・mawari・chokusen のどれも使えなければ null
  if(!useLap1 && !useMawari && !useChokusen) return null;

  // ② 各艇の合成スコアを生成（タイム加重合算 → 小さいほど速い）
  const compositeScores = boats.map((b, i) => {
    let score = tenjiVals[i] * w.tenji;
    if(useLap1)     score += lap1Vals[i]     * w.lap1;
    if(useMawari)   score += mawariVals[i]   * w.mawari;
    if(useChokusen) score += chokusenVals[i] * w.chokusen;
    return score;
  });

  // ③ 6艇平均を基準に乖離率を算出し、コース別感度で係数化
  const avg = compositeScores.reduce((a, v) => a + v, 0) / compositeScores.length;
  if(avg <= 0) return null;

  const rawCoefs = boats.map((b, i) => {
    const deviation   = (avg - compositeScores[i]) / avg;  // 速い艇→プラス
    const sensitivity = TENJI_SENSITIVITY_BY_COURSE[b.boat] ?? 8.0;
    return Math.min(2.0, Math.max(0.5, 1.0 + deviation * sensitivity));
  });

  // ④ 全艇平均を1.0基準に正規化して格納
  const coefAvg   = rawCoefs.reduce((a, v) => a + v, 0) / rawCoefs.length;
  const coefTotal = rawCoefs.reduce((a, v) => a + v, 0) || 1;
  const tenjiScoreMap = {};
  boats.forEach((b, i) => {
    tenjiScoreMap[b.boat] = rawCoefs[i] / coefTotal;
    tenjiScoreMap[`__coef_${b.boat}`] = coefAvg > 0
      ? Math.min(2.0, Math.max(0.5, rawCoefs[i] / coefAvg))
      : 1.0;
  });

  return tenjiScoreMap;
}

// 後方互換ラッパー（updateTenjiDelta等の既存呼び出し箇所向け）
function calcTenjiDelta(boats, tenjiData, venue, arek){
  return calcTenjiScore(boats, tenjiData, venue, arek);
}

function updateTenjiDelta(venue, date, rno){
  if(!DATA||!DATA.races[String(rno)]) return;
  _ensureTenjiCache();
  const slug = VENUE_SLUG_MAP[DATA.venue]||DATA.venue||'';
  const key = tenjiKey(slug, date||DATA.date, rno);
  const tenjiData = _tenjiCache[key];
  if(!tenjiData) return;
  const boats = DATA.races[String(rno)].boats;
  const arekForTenji = (DATA.races[String(rno)]?.arek) ?? 54.7;
  const deltaMap = calcTenjiDelta(boats, tenjiData, DATA.venue, arekForTenji);
  if(!deltaMap) return;
  boats.forEach(b=>{
    b.tenji_delta = deltaMap[b.boat];
    if(b.final_prob == null) b.final_prob = b.tenkai_prob ?? b.prob;
  });
}

function calcTenkaiProbs(boats, arek){
  // ── MASTER_EXT なし ──
  if(!MASTER_EXT || !MASTER_EXT.venue_kimari){
    return [...boats].map(b=>({
      ...b,
      tenkai_prob:  b.prob,
      tenkai_score: b.prob,  // ★ MASTER_EXTなし: probをそのまま独立スコアとして使用
    })).sort((a,b)=>b.tenkai_prob-a.tenkai_prob);
  }

  const venue   = DATA.venue;
  const vKimari = MASTER_EXT.venue_kimari[venue];

  if(!vKimari){
    return [...boats].map(b=>({
      ...b,
      tenkai_prob:  b.prob,
      tenkai_score: b.prob,  // ★ 会場データなし: 同上
    })).sort((a,b)=>b.tenkai_prob-a.tenkai_prob);
  }

  // ── 決まり手ごとのハード除外コース（物理的に絶対ありえない）──
  // 恵まれは除外（転覆等による繰り上がりのため予測不可）
  const KIMARI_HARD_EXCLUDE = {
    '逃げ':       new Set(['2','3','4','5','6']),
    '差し':       new Set(['1']),
    'まくり':     new Set(['1']),
    'まくり差し': new Set(['1','2','3']),  // 3コースも除外（物理的に届きにくい）
    '抜き':       new Set(),
  };

  // ── グレーゾーン：個人kimari%が閾値以上なら有効とみなす ──
  const KIMARI_SOFT_THRESHOLD = {
    'まくり':     {'2': 0.05},             // 2コースのまくりは個人実績5%以上で有効
    'まくり差し': {'5': 0.05, '6': 0.08}, // 5コースは5%以上、6コースは8%以上で有効
    '抜き':       {'1': 0.03},             // 1コースの抜きは個人実績3%以上で有効
  };

  // 選手のコース別kimari%をマスタから取得するヘルパー
  function getPersonalKimari(boatName, courseStr, kimariType){
    return getCourseMaster(boatName, courseStr)?.kimari?.[kimariType] ?? 0;
  }

  // 選手×決まり手の有効判定
  function isValidFirst(boat, kimari){
    const wc  = String(boat.boat);
    const exc = KIMARI_HARD_EXCLUDE[kimari];
    if(!exc) return false;
    if(exc.has(wc)) return false;
    const soft = KIMARI_SOFT_THRESHOLD[kimari];
    if(soft && wc in soft){
      const threshold = soft[wc];
      const personal  = getPersonalKimari(boat.name, wc, kimari);
      return personal >= threshold;
    }
    return true;
  }

  // 1コース艇を特定
  const boat1 = boats.find(b => b.boat === 1) || null;

  // ── 【刷新】会場事前分布 = vKimari をそのまま使用 ──
  // 被kimari補正（旧・修正C）は calcScenarioData 側の scenarioVKimari に集約し、
  // ここでは行わない。これにより「被kimari二重計上（過剰補正）」問題を解消する。
  const adjustedVKimari = { ...vKimari };

  // vKimari の正規化（合計が1.0でない場合の安全策）
  const vKimariTotal = Object.values(adjustedVKimari).reduce((s, v) => s + v, 0);
  if(vKimariTotal > 0 && Math.abs(vKimariTotal - 1.0) > 0.001){
    for(const k of Object.keys(adjustedVKimari)){
      adjustedVKimari[k] = adjustedVKimari[k] / vKimariTotal;
    }
  }

  const kimariTypes = Object.keys(adjustedVKimari).filter(k => adjustedVKimari[k] > 0 && k in KIMARI_HARD_EXCLUDE);

  // ── 【刷新】個人kimari率ブレンド（会場分布との線形補間） ──
  //
  // 各艇の「そのコースでの決まり手使用率」を個人傾向として取り出し、
  // 会場傾向(adjustedVKimari)と trust 比率でブレンドする。
  // 逃げは1コースのみ、その他は各コースの個人実績を使用。
  //
  const PERSONAL_BLEND_STRENGTH = 0.7; // 会場3:個人7 が最大（100走時）

  function blendPersonalKimari(boatObj, baseVKimari){
    const name   = boatObj.name;
    const course = String(boatObj.boat);
    const cm     = getCourseMaster(name, course);
    if(!cm) return baseVKimari;

    const runs = cm.runs ?? 0;
    if(runs < 20) return baseVKimari; // データ不足はスキップ（kimariCoefSumのreliable閾値と統一: 20走）

    // runs数に応じた信頼度（20走→0.14、50走→0.35、100走→0.7）
    const trust = Math.min(runs / 100, 1.0) * PERSONAL_BLEND_STRENGTH;

    const personalKimari = cm.kimari ?? {};
    // 個人kimari率を差し・まくり・まくり差し・抜きのみ対象に正規化
    const BLEND_TARGETS = ['差し', 'まくり', 'まくり差し', '抜き'];
    const personalTotal = BLEND_TARGETS.reduce((s, k) => s + (personalKimari[k] ?? 0), 0);
    if(personalTotal <= 0) return baseVKimari;

    const blended = { ...baseVKimari };
    // 会場合計スケール（差し+まくり+まくり差し+抜き の合計）
    const venueBlendSum = BLEND_TARGETS.reduce((s, kk) => s + (baseVKimari[kk] ?? 0), 0);
    for(const k of BLEND_TARGETS){
      if(!(k in blended)) continue;
      const personalRate = (personalKimari[k] ?? 0) / personalTotal * venueBlendSum;
      blended[k] = baseVKimari[k] * (1 - trust) + personalRate * trust;
    }

    // 再正規化（合計を元の合計に揃える）
    const origTotal  = Object.values(baseVKimari).reduce((s, v) => s + v, 0);
    const blendTotal = Object.values(blended).reduce((s, v) => s + v, 0);
    if(blendTotal > 0){
      for(const k of Object.keys(blended)) blended[k] = blended[k] / blendTotal * origTotal;
    }
    return blended;
  }

  // ── 【刷新】ゼロサム相対評価モデル ──
  //
  // 各決まり手について「この決まり手で1着になる確率のパイ」を
  // 有効艇の個人適性比率で相対分配する（ゼロサム・ゲーム）。
  //
  // 手順:
  //   1. 各艇に個人ブレンドvKimariを算出（会場先験 × 個人実績）
  //   2. 決まり手ごとに有効艇の個人kimari率を抽出し、信頼度で補正
  //   3. 補正後の率を正規化し、会場決まり手確率 × prob で按分
  //   4. 全決まり手の按分スコアを合算 → 正規化 → tenkai_prob
  //
  // ゼロサム保証: 各決まり手スロットの合計は adjustedVKimari[k] × Σprob に等しく、
  //              全スロット合算後の総スコア和は Σprob = 1.0 に収束する。
  //
  // 上下限クリップは廃止。比率の正規化のみで数値が爆発しない。
  //

  // 艇ごとに個人ブレンドvKimariを算出
  const boatVKimari = {};
  boats.forEach(b => { boatVKimari[b.boat] = blendPersonalKimari(b, adjustedVKimari); });

  // 各艇の「ゼロサム適性スコア」累積変数
  const kimariCoefSum = {};
  boats.forEach(b => { kimariCoefSum[b.boat] = 0; });

  // 1コース逃げ率補正: 1コース艇の個人逃げ率を信頼度加重で反映
  const nigePersonalRate = (() => {
    if(!boat1) return null;
    const nigeRate = getPersonalKimari(boat1.name, '1', '逃げ');
    const nigeRuns = getCourseMaster(boat1.name, '1')?.runs ?? 0;
    if(nigeRuns < 20 || nigeRate <= 0) return null;
    const trust = Math.min(nigeRuns / 100, 1.0) * PERSONAL_BLEND_STRENGTH;
    // 逃げ: 個人率と会場率を blend
    const venueNige = adjustedVKimari['逃げ'] || 0;
    return venueNige * (1 - trust) + nigeRate * trust;
  })();

  for(const kimari of kimariTypes){
    // 有効艇の個人kimari適性（信頼度補正済み）を収集
    const personalAdaptation = {};  // boat番号 → 補正済み適性値

    for(const b of boats){
      if(!isValidFirst(b, kimari)){
        personalAdaptation[b.boat] = 0;
        continue;
      }
      const wc  = String(b.boat);
      const cm  = getCourseMaster(b.name, wc);
      const runs = cm?.runs ?? 0;

      let kimariRate;
      if(kimari === '逃げ'){
        // 逃げは1コース専用 → nigePersonalRate を使用
        kimariRate = (b.boat === 1 && nigePersonalRate != null)
          ? nigePersonalRate
          : (adjustedVKimari['逃げ'] || 0);
      } else {
        kimariRate = getPersonalKimari(b.name, wc, kimari);
        if(runs < 20 || kimariRate <= 0){
          // データ不足 → 会場平均にフォールバック
          kimariRate = boatVKimari[b.boat][kimari] || adjustedVKimari[kimari] || 0;
        } else {
          // runs信頼度で会場ブレンド値と線形補間
          const trust = Math.min(runs / 100, 1.0);
          const venueRate = boatVKimari[b.boat][kimari] || adjustedVKimari[kimari] || 0;
          kimariRate = kimariRate * trust + venueRate * (1 - trust);
        }
      }
      personalAdaptation[b.boat] = Math.max(0, kimariRate);
    }

    // 有効艇の適性合計（正規化分母）
    const validBoats = boats.filter(b => isValidFirst(b, kimari));
    if(validBoats.length === 0) continue;
    const adaptTotal = validBoats.reduce((s, b) => s + personalAdaptation[b.boat], 0);
    if(adaptTotal <= 0) continue;

    // この決まり手の「会場事前確率」（= adjustedVKimari[kimari]）を
    // 有効艇の prob × 正規化適性比 でゼロサム分配
    const kimariBaseProb = adjustedVKimari[kimari] || 0;
    if(kimariBaseProb <= 0) continue;

    // 全艇のprob合計（分母、=1.0のはずだが念のため）
    const probTotal = boats.reduce((s, b) => s + b.prob, 0) || 1;

    for(const b of validBoats){
      // ゼロサム按分: kimari確率 × (この艇の prob 比率) × (この艇の適性比率)
      // = kimari確率 × 艇のprob/Σprob × 艇の適性/Σ適性
      // ただし prob と適性を独立に掛けると「prob低い艇」が過剰に抑制されるため
      // 適性比率のみで按分し、最後に prob を乗じて正規化する（ゼロサム保証）
      const adaptShare = personalAdaptation[b.boat] / adaptTotal;  // Σ=1.0
      kimariCoefSum[b.boat] += kimariBaseProb * adaptShare;
    }
    // 有効外艇にも微小スコアを保証（確率0はNaN等のリスク回避）
    for(const b of boats){
      if(isValidFirst(b, kimari)) continue;
      kimariCoefSum[b.boat] += 0;  // 有効外は加算ゼロ（RELATIVE_MIN廃止）
    }
  }

  // ── ゼロサムスコア × prob → 正規化 ──
  //
  // kimariCoefSum はΣ=1.0（全決まり手のvKimari確率の合計 = 1.0）に
  // 近似収束するが、有効外艇でゼロになり得るためprobで補正して下限保証する。
  //
  const FLOOR_PROB = 0.0001;  // 確率の下限（ゼロ除算・NaN防止）
  const scores = {};
  boats.forEach(b => {
    // kimariCoefSum がゼロの艇（有効決まり手が一切ない）は prob をそのまま使用
    const adaptScore = kimariCoefSum[b.boat] > 0 ? kimariCoefSum[b.boat] : FLOOR_PROB;
    // adaptScore（決まり手適性）× prob（基準強さ）の積でゼロサム総合スコアを算出
    scores[b.boat] = Math.max(FLOOR_PROB, b.prob * adaptScore);
  });

  const total = Object.values(scores).reduce((a, v) => a + v, 0) || 1;
  return [...boats]
    .map(b => ({
      ...b,
      tenkai_prob:  scores[b.boat] / total,
      tenkai_score: scores[b.boat] / total,  // ゼロサムモデルでは tenkai_score = tenkai_prob
      kimari_coef:  kimariCoefSum[b.boat],   // 表示用: 生の決まり手適性累積スコア
      // final_prob: renderBuy の加重合成で上書きされる
      final_prob:   scores[b.boat] / total,
    }))
    .sort((a, b) => b.tenkai_prob - a.tenkai_prob);
}

// ══════════════════════════════════════════════════════════════════
//  calcTenkaiProbsExtended — スリット隊形・展示タイム・気象補正 拡張版
//
//  【外部注入対応】options で masterExt / venueKimari / innData を
//  明示的に渡せるように拡張。これにより MASTER_EXT のロードタイミングに
//  依存せず、同じ引数なら常に同じ結果を返す純粋関数として動作する。
// ══════════════════════════════════════════════════════════════════

/**
 * 気象コンテキストを生成するファクトリ関数。
 * renderBuy 等から tenjiData と venue を渡して使う。
 *
 * @param {object|null} tenjiData  展示キャッシュ（_tenjiCache[tKey]）
 * @param {string}      venue      会場名
 * @returns {{ windSpeed: number, windType: string|null }}
 */
function buildWeatherContext(tenjiData, venue) {
  const windSpeed = tenjiData?.__wind_speed ?? 0;
  const windType  = (() => {
    const windNum = tenjiData?.__wind_direction ?? null;
    if (windNum == null || windSpeed < 1) return null;
    const wText = tenjiData?.__wind_direction_text ?? '';
    if (/追い/.test(wText)) return 'tail';
    if (/向かい/.test(wText)) return 'head';
    if (/横/.test(wText)) return 'cross';
    return null;
  })();
  return { windSpeed, windType };
}

/**
 * [提案A] スリット隊形補正
 * 3〜4コース艇が内側（1〜2コース）より平均ST順位で優位なとき、
 * まくり / まくり差し パイを拡大し、逃げパイを縮小する係数を返す。
 *
 * 数理:
 *   stDiff = 内側平均ST順 − 外側平均ST順  (正値 → 外が速い)
 *   ratio  = clamp(stDiff / ST_DIFF_SCALE, 0, 1)
 *   makuriBoost  = 1 + SLIT_MAKURI_MAX * ratio
 *   nigeDiscount = 1 − SLIT_NIGE_DISCOUNT * ratio
 *
 * @param {object[]} boats  レース艇データ
 * @returns {{ makuriBoost: number, nigeDiscount: number }}
 */
function calcSlitFormationBoost(boats) {
  const SLIT_MAKURI_MAX    = 0.40;  // まくりパイ最大+40%
  const SLIT_NIGE_DISCOUNT = 0.30;  // 逃げパイ最大−30%
  const ST_DIFF_SCALE      = 1.5;   // このランク差で最大効果

  const inside  = boats.filter(b => b.boat === 1 || b.boat === 2);
  // [修正] まくりの主体は5・6コース（ダッシュ艇）なので outside を全ダッシュ艇に拡張
  const outside = boats.filter(b => b.boat >= 3);

  function avgStRank(arr) {
    const valid = arr.map(b => {
      const r = getCourseMaster(b.name, String(b.boat))?.st_rank;
      return typeof r === 'number' ? r : null;
    }).filter(v => v !== null);
    if (valid.length === 0) return null;
    return valid.reduce((s, v) => s + v, 0) / valid.length;
  }

  const insideAvg  = avgStRank(inside);
  const outsideAvg = avgStRank(outside);
  if (insideAvg === null || outsideAvg === null) {
    return { makuriBoost: 1.0, nigeDiscount: 1.0 };
  }

  const stDiff = insideAvg - outsideAvg;  // 正値 = アウトが速い
  if (stDiff <= 0) return { makuriBoost: 1.0, nigeDiscount: 1.0 };

  const ratio        = Math.min(stDiff / ST_DIFF_SCALE, 1.0);
  const makuriBoost  = 1.0 + SLIT_MAKURI_MAX    * ratio;
  const nigeDiscount = 1.0 - SLIT_NIGE_DISCOUNT * ratio;
  return { makuriBoost, nigeDiscount };
}

/**
 * [提案B-2] 気象マクロ補正
 * 風速 WIND_THRESHOLD m/s 以上のとき決まり手パイに乗算係数を返す。
 *   向かい風 → まくり・まくり差し UP、逃げ・差し DOWN
 *   追い風   → 逃げ・差し UP、まくり DOWN
 *
 * @param {{ windSpeed: number, windType: string|null }} weatherCtx
 * @returns {object}  決まり手名 → 乗算係数（1.0 = 変更なし）
 */
function calcWindKimariBoost(weatherCtx) {
  const WIND_THRESHOLD = 5;     // m/s 以上で有効
  const WIND_BOOST_MAX = 0.25;  // 最大ブースト幅 ±25%

  const neutral = {
    '逃げ': 1.0, '差し': 1.0, 'まくり': 1.0, 'まくり差し': 1.0, '抜き': 1.0,
  };

  const { windSpeed, windType } = weatherCtx;
  if (windSpeed < WIND_THRESHOLD || windType == null) return neutral;

  // 5m/s → 0%, 10m/s → 100% のリニア
  const ratio = Math.min((windSpeed - WIND_THRESHOLD) / WIND_THRESHOLD, 1.0);
  const boost = WIND_BOOST_MAX * ratio;

  if (windType === 'head') {
    // 向かい風 → インが崩れやすい
    return {
      '逃げ':       1.0 - boost * 0.8,
      '差し':       1.0 - boost * 0.3,
      'まくり':     1.0 + boost,
      'まくり差し': 1.0 + boost * 0.7,
      '抜き':       1.0,
    };
  }
  if (windType === 'tail') {
    // 追い風 → スリット整列しやすく逃げ有利
    return {
      '逃げ':       1.0 + boost * 0.6,
      '差し':       1.0 + boost * 0.4,
      'まくり':     1.0 - boost * 0.5,
      'まくり差し': 1.0 - boost * 0.3,
      '抜き':       1.0,
    };
  }
  // 横風など
  return {
    '逃げ': 1.0 - boost * 0.2, '差し': 1.0,
    'まくり': 1.0 + boost * 0.1, 'まくり差し': 1.0, '抜き': 1.0,
  };
}

/**
 * [提案B-1] 展示タイム6艇平均乖離マップ
 * 乖離率 = (平均 − 自艇秒数) / 平均  (正値 = 自艇が速い)
 * personalAdaptation への加算値として使用する。
 *
 * ゼロサム保証: adaptTotal も同時に増減するため比率は正規化されたまま。
 *
 * @param {object[]}    boats      レース艇データ
 * @param {object|null} tenjiData  展示キャッシュ
 * @returns {object}  { [boat番号]: 乖離補正値（クリップ済み） }
 */
function calcTenjiDeviation(boats, tenjiData) {
  const TENJI_DEV_CLIP   = 0.08;  // ±8% クリップ
  const TENJI_DEV_WEIGHT = 0.90;  // 加算強度

  const devMap = {};
  boats.forEach(b => { devMap[b.boat] = 0; });
  if (!tenjiData) return devMap;

  const tenjiVals = boats.map(b => {
    const td = tenjiData[String(b.boat)] ?? tenjiData[b.boat] ?? null;
    const v  = typeof td?.tenji === 'number' ? td.tenji : null;
    return { boat: b.boat, v };
  });

  const valid = tenjiVals.filter(x => x.v !== null);
  if (valid.length < 2) return devMap;

  const avg = valid.reduce((s, x) => s + x.v, 0) / valid.length;
  if (avg <= 0) return devMap;

  valid.forEach(({ boat, v }) => {
    const rawDev = (avg - v) / avg;  // 正値 = 速い
    devMap[boat] = Math.min(TENJI_DEV_CLIP, Math.max(-TENJI_DEV_CLIP, rawDev)) * TENJI_DEV_WEIGHT;
  });
  return devMap;
}

/**
 * 展開確率・基準1着率 拡張版【三層独立相対評価モデル】
 *
 * ┌─────────────────────────────────────────────────────┐
 * │ 第1層: 選手能力（b.prob）                            │
 * │   純粋な走力能力値のみ。決まり手・STバイアス一切なし │
 * ├─────────────────────────────────────────────────────┤
 * │ 第2層: 展開補正（layer2_modifier）                   │
 * │   会場×個人決まり手適合度 + 1号艇被決まり手 + ST隊形 │
 * ├─────────────────────────────────────────────────────┤
 * │ 第3層: 当日補正（layer3_modifier）                   │
 * │   展示タイム乖離 + 気象（風向・風速）                │
 * └─────────────────────────────────────────────────────┘
 *
 * final_prob = normalize( prob × layer2_modifier × layer3_modifier )
 *
 * チューニングポイント:
 *   L2_CLIP_MIN/MAX    … 第2層の上下限（広げると展開の効きが強くなる）
 *   L3_CLIP_MIN/MAX    … 第3層の上下限（広げると展示・気象の効きが強くなる）
 *   PERSONAL_BLEND_STRENGTH … 個人決まり手実績の会場マスタへの混ぜ込み強度
 *   calcSlitFormationBoost / calcWindKimariBoost / calcTenjiDeviation の
 *   各関数内の定数も独立してチューニング可能
 *
 * @param {object[]}    boats      レース艇データ（boat, name, prob 必須）
 * @param {number}      arek       荒れ指数
 * @param {object|null} tenjiData  展示キャッシュ（省略可）
 * @param {string}      venue      会場名（省略可）
 * @param {object}      options    外部注入オプション
 *   @param {object}   masterExt   マスターデータ（省略時はグローバル）
 *   @param {object}   venueKimari 事前解決済みの会場決まり手分布
 *   @param {object}   innData     事前解決済みの inn_data
 * @returns {object[]}  tenkai_prob / tenkai_score / final_prob / layer2_modifier / layer3_modifier 付き配列
 */
function calcTenkaiProbsExtended(boats, arek, tenjiData = null, venue = null, options = {}) {
  const {
    masterExt = MASTER_EXT,
    venueKimari = null,
    innData = DATA?.inn_data,
    raceIndexData = RACE_INDEX_DATA,
  } = options;

  const resolvedVenue = venue ?? DATA?.venue ?? '';

  // ── MASTER_EXT なし / 会場データなし → フォールバック ──
  if (!masterExt || !masterExt.venue_kimari) {
    return [...boats].map(b => ({
      ...b,
      tenkai_prob:      b.prob,
      tenkai_score:     b.prob,
      final_prob:       b.prob,
      layer2_modifier:  1.0,
      layer3_modifier:  1.0,
    })).sort((a, b) => b.tenkai_prob - a.tenkai_prob);
  }

  // ★ 事前解決済みの venueKimari があればそれを使用
  const vKimariRaw = venueKimari ?? masterExt.venue_kimari[resolvedVenue];
  if (!vKimariRaw) {
    return [...boats].map(b => ({
      ...b,
      tenkai_prob:      b.prob,
      tenkai_score:     b.prob,
      final_prob:       b.prob,
      layer2_modifier:  1.0,
      layer3_modifier:  1.0,
    })).sort((a, b) => b.tenkai_prob - a.tenkai_prob);
  }

  // ★ innData も引数で渡されたものを優先
  const resolvedInnData = innData ?? DATA?.inn_data;

  // ══════════════════════════════════════════════════════
  // 【第2層】展開補正係数の算出
  // ══════════════════════════════════════════════════════

  // ── チューニング定数 ──
  // [2026-06-20] L2_CLIP_MIN/MAX は旧ゼロサムモデル専用だったため未使用化。
  // 現在は Stage1 の NIGE_CLIP_MIN/MAX（下記）と Stage2 の CONDITIONAL_BOOST_SCALE が
  // 同等の役割を担う。完全削除はせず参考値として残置。
  const L2_CLIP_MIN = 0.50;  // (未使用) 第2層の下限（0.5 = 最大50%減）
  // [修正] 荒れ指数(arek)が高いほど外枠の上振れ余地を広げる（荒れレースで外枠過少評価を防ぐ）
  // arek≦54（平均的）→ 1.80、arek≧80（高荒れ）→ 2.20、中間はリニア補間
  const L2_CLIP_MAX = arek >= 80 ? 2.20  // (未使用)
    : arek <= 54 ? 1.80
    : 1.80 + (arek - 54) / (80 - 54) * (2.20 - 1.80);
  const L3_CLIP_MIN = 0.80;  // 第3層の下限
  const L3_CLIP_MAX = 1.20;  // 第3層の上限
  const PERSONAL_BLEND_STRENGTH = 0.7;  // 個人実績の混ぜ込み強度（0〜1）
  const FLOOR_PROB = 0.0001;

  // ── [2-A] スリット隊形補正 → 会場vKimariパイの再配分に使用 ──
  const { makuriBoost, nigeDiscount } = calcSlitFormationBoost(boats);

  // ── 会場vKimariにスリット補正を乗算 → 再正規化（ゼロサムΣ=1保証） ──
  const slitMul = {
    '逃げ':       nigeDiscount,
    '差し':       1.0,
    'まくり':     makuriBoost,
    'まくり差し': makuriBoost * 0.7 + 0.3,
    '抜き':       1.0,
  };
  const adjustedVKimari = {};
  for (const [k, v] of Object.entries(vKimariRaw)) {
    adjustedVKimari[k] = Math.max(0, v * (slitMul[k] ?? 1.0));
  }
  const vKimariTotal = Object.values(adjustedVKimari).reduce((s, v) => s + v, 0);
  if (vKimariTotal > 0) {
    for (const k of Object.keys(adjustedVKimari)) adjustedVKimari[k] /= vKimariTotal;
  }

  // ══════════════════════════════════════════════════════════════════
  // [2026-06-17 刷新] 展開補正 第2層 ── 「1号艇被決まり手 × 他艇攻撃力」モデル
  //
  // 【設計思想】
  //   ① 1号艇の「逃げ率」は b.prob（第1層）に既反映 → 展開補正では完全に無視。
  //   ② 1号艇の「被決まり手（被差し / 被まくり / 被まくり差し）」を弱点データとして使用。
  //      マスタの kimari['差し'] / kimari['まくり'] / kimari['まくり差し'] に格納されている
  //      ※ 1コースの場合、差し〜まくり差し欄は被決まり手として表示される（UI仕様）
  //   ③ 2〜6号艇の「決まり手実績（生の%値）」を攻撃力として使用。
  //      blendPersonalKimari のような「他の決まり手を分母にした再正規化」は一切しない。
  //   ④ ブースト = 1号艇の被決まり手率 × 他艇の決まり手率 の積（噛み合い強度）。
  //   ⑤ 各他艇のブースト合計に比例して、1号艇の展開補正スコアをゼロサムで引き下げる。
  //
  // 【算出フロー】
  //   Step1: 1号艇の被決まり手マップ boat1_vuln を取得（会場傾向とブレンド）
  //   Step2: 2〜6号艇の攻撃力 attack[boat] を生の個人実績で計算（runs不足→会場値）
  //   Step3: boost[boat] = Σ(対象決まり手 k: boat1_vuln[k] * attack_k[boat])
  //   Step4: 1号艇スコア = 基準値(1.0) − ブースト合計（他艇が奪った分）
  //          他艇スコア = 基準値(1.0) + boost[boat] × BOOST_SCALE
  //   Step5: 全艇スコアを平均1.0に正規化 → layer2 係数にクリップ
  // ══════════════════════════════════════════════════════════════════

  // チューニング定数
  // BOOST_SCALE: 噛み合い強度をlayer2係数の変動幅に変換するスケール係数
  // 大きくすると展開補正のメリハリが増す（1.0〜3.0 が実用範囲）
  //
  // 【2026-06-25 変更】0.7 → 0.0
  // 理由: BOOST_SCALE=0.7 のとき totalBoost≈0.20〜0.35 と合わさって
  //   rawNige = prob × (1 - 0.25×0.7) ≈ prob × 0.825 が全レース固定的に発生し、
  //   1号艇 final_prob が最高50%前後に張り付く問題があった。
  //   強いメンバー構成のレース（prob=0.70超）でも確率が潰れており、
  //   キャリブレーション実測（1号艇: 推定55.9%→実績58.9%）とも乖離していた。
  //   0.0にすることで rawNige = prob がそのまま通り、
  //   メンバー構成が強いレースで自然に70〜80%が出るようになる。
  //   Stage2（2〜6号艇）側の展開差別化は CONDITIONAL_BOOST_SCALE で維持する。
  const BOOST_SCALE = 0.0;
  // VULN_TRUST_MAX: 1号艇の被決まり手個人実績を何走で最大信頼とするか
  const VULN_TRUST_MAX = 100;
  // ATTACK_TRUST_MAX: 他艇の攻撃力個人実績を何走で最大信頼とするか
  const ATTACK_TRUST_MAX = 100;
  // 被決まり手・攻撃力のデータ不足時に使用する会場デフォルト値の重み
  const VENUE_FALLBACK_WEIGHT = 0.5;

  // 対象決まり手（1号艇が被り得る決まり手のみ）
  const TARGET_KIMARI = ['差し', 'まくり', 'まくり差し'];

  // 攻撃可能コース定義（各決まり手で仕掛けられるコース）
  const ATTACK_VALID_COURSE = {
    '差し':       new Set(['2', '3', '4', '5', '6']),
    'まくり':     new Set(['2', '3', '4', '5', '6']),
    'まくり差し': new Set(['4', '5', '6']),
  };

  const boat1 = boats.find(b => b.boat === 1) || null;

  // ── Step1: 1号艇の被決まり手マップ（弱点） ──
  // 会場のvKimari分布を下限として、個人実績でブレンド
  const boat1_vuln = {};
  {
    const cm1    = boat1 ? getCourseMaster(boat1.name, '1') : null;
    const runs1  = cm1?.runs ?? 0;
    const trust1 = Math.min(runs1 / VULN_TRUST_MAX, 1.0);
    for (const k of TARGET_KIMARI) {
      const venueRate  = adjustedVKimari[k] ?? 0;
      // 1コース選手のマスタ kimari[k] が被決まり手率（UI仕様と一致）
      const personalRate = (cm1 && runs1 >= 20) ? (cm1.kimari?.[k] ?? venueRate) : venueRate;
      // 個人実績を信頼度でブレンド（データ不足は会場値に寄せる）
      boat1_vuln[k] = personalRate * trust1 + venueRate * (1 - trust1) * VENUE_FALLBACK_WEIGHT;
    }
  }

  // ── Step2: 2〜6号艇の攻撃力（決まり手実績の生パーセンテージ） ──
  // blendPersonalKimari のような「他の決まり手との比率正規化」は行わない。
  // 生のkimari率（全進入に対する実績値）をそのまま使用する。
  const attackPower = {};  // attackPower[boat][kimari] = 攻撃力（0〜1）
  for (const b of boats) {
    if (b.boat === 1) continue;
    const wc        = String(b.boat);
    const cm        = getCourseMaster(b.name, wc);
    const runs      = cm?.runs ?? 0;
    const trust     = Math.min(runs / ATTACK_TRUST_MAX, 1.0);
    attackPower[b.boat] = {};
    for (const k of TARGET_KIMARI) {
      if (!ATTACK_VALID_COURSE[k]?.has(wc)) {
        attackPower[b.boat][k] = 0;
        continue;
      }
      const venueRate    = adjustedVKimari[k] ?? 0;
      // 生の個人実績をそのまま使用（正規化・ブレンドなし）
      const personalRate = (cm && runs >= 20) ? (cm.kimari?.[k] ?? 0) : 0;
      // データ不足の場合は会場値にフォールバック
      attackPower[b.boat][k] = (runs >= 20 && personalRate > 0)
        ? personalRate * trust + venueRate * (1 - trust)
        : venueRate * VENUE_FALLBACK_WEIGHT;
    }
  }

  // ── Step3: 各他艇のブースト量 = 1号艇弱点 × 攻撃力 の噛み合い積 ──
  const boost = {};
  boats.forEach(b => { boost[b.boat] = 0; });
  let totalBoost = 0;
  for (const b of boats) {
    if (b.boat === 1) continue;
    let bsum = 0;
    for (const k of TARGET_KIMARI) {
      bsum += (boat1_vuln[k] ?? 0) * (attackPower[b.boat]?.[k] ?? 0);
    }
    boost[b.boat] = bsum;
    totalBoost += bsum;
  }

  // ── Step4（旧）はここで終了。旧実装は「1号艇 = 1.0 − totalBoost」「他艇 = 1.0 + boost」を
  //    同じ配列内で平均1.0に正規化していたため、1号艇のスコアと他艇のスコアが
  //    ゼロサムで強く連動し、(a) 60%+帯で1号艇が過大評価される、
  //    (b) 攻撃力の強い艇が複数いるレースで1号艇スコアが不自然に振れ単調性が崩れる、
  //    という2つの問題を生んでいた（2026-06-20 キャリブレーション結果より判明）。
  //
  // [2026-06-20 刷新] 二段階モデルへ分離:
  //   Stage1: 1号艇の「逃げ確率」を、他艇と切り離した独立変数として算出・専用クリップ。
  //   Stage2: 「逃げなかった場合」の条件付き勝率を 2〜6号艇間でのみ配分。
  //   Final : final_prob[1] = nige_prob
  //           final_prob[k] = (1 − nige_prob) × conditionalShare[k]  (k=2..6)
  //   こうすることで1号艇の確率と他艇間の配分が数式上も独立になり、
  //   それぞれを別々にキャリブレーションパネルで検証・調整できる。
  // ══════════════════════════════════════════════════════════════════

  // ── 第3層を先に計算（Stage1/2どちらも layer3 を使うため）──
  const tenjiDevMapPre = resolvedVenue === '住之江'
    ? (() => { const m = {}; boats.forEach(b => { m[b.boat] = 0; }); return m; })()
    : calcTenjiDeviation(boats, tenjiData);
  const layer3TenjiPre = {};
  boats.forEach(b => { layer3TenjiPre[b.boat] = 1.0 + (tenjiDevMapPre[b.boat] ?? 0); });
  const weatherCtxPre  = buildWeatherContext(tenjiData, resolvedVenue);
  const windBoostPre   = calcWindKimariBoost(weatherCtxPre);
  const layer3WindPre  = {};
  {
    const vkTotal = Object.values(adjustedVKimari).reduce((s, v) => s + v, 0) || 1;
    let baseWindCoef = 0;
    for (const [k, rate] of Object.entries(adjustedVKimari)) {
      baseWindCoef += (rate / vkTotal) * (windBoostPre[k] ?? 1.0);
    }
    boats.forEach(b => { layer3WindPre[b.boat] = baseWindCoef; });
  }
  const layer3 = {};
  boats.forEach(b => {
    const raw = layer3TenjiPre[b.boat] * layer3WindPre[b.boat];
    layer3[b.boat] = Math.min(L3_CLIP_MAX, Math.max(L3_CLIP_MIN, raw));
  });

  // ══════════════════════════════════════════════════════
  // 【Stage1】1号艇の逃げ確率（nige_prob）── 独立変数
  // ══════════════════════════════════════════════════════
  //
  // チューニングポイント:
  //   NIGE_CLIP_MIN/MAX … 逃げ確率の下限・上限。ここを絞れば
  //   キャリブレーションパネルの「60%+帯」を直接抑え込める。
  //   NIGE_BOOST_SCALE  … 被決まり手プレッシャーの効き具合。
  const NIGE_CLIP_MIN   = 0.25;
  // 【2026-06-25 変更】0.80 → 0.90
  // BOOST_SCALE=0.0 により rawNige = prob がそのまま通るため、
  // 強いメンバー構成（prob=0.80超）のレースで天井に当たらないよう上限を緩和。
  const NIGE_CLIP_MAX   = 0.90;
  const NIGE_BOOST_SCALE = BOOST_SCALE; // 被決まり手プレッシャーの効き（既存値を踏襲）

  const rawNige = (boat1 ? boat1.prob : 0)
    * layer3[1]
    * Math.max(0, 1.0 - totalBoost * NIGE_BOOST_SCALE);
  const nigeProbClipped = Math.min(NIGE_CLIP_MAX, Math.max(NIGE_CLIP_MIN, rawNige));

  // ── [2026-07-04 修正] コース別キャリブレーション補正はここでは適用しない ──
  // [経緯] 2026-06-20にここへ calibrateCourse1Prob を追加していたが、この値
  //   （nigeProb）は下流の tenkai_prob / tenkai_score としてそのまま
  //   renderer.js の STEP2（tenkaiDiff = tenkaiNorm - baseNorm）に渡っていた。
  //   baseNorm は較正前の生 prob のままなので、この diff に「較正で削った分」が
  //   丸ごと再度乗ってしまい、tenkaiBonus 経由で較正が事実上二重に効いていた。
  //   さらに renderer.js 側にも最終 final_prob への直接適用（2026-07-04追加）が
  //   別途あり、実質2〜3重の較正がかかっていたことが実測ログで確認された。
  // [対応] 較正の適用箇所を renderer.js の最終適用（final_prob に対して1回のみ）
  //   に一本化する。ここでは較正前の nigeProbClipped をそのまま使う。
  //   これにより tenkaiDiff は較正の影響を受けず、展開要因（層3の展示・気象・
  //   被決まり手プレッシャー）のみを反映する本来の意味に戻る。
  const nigeProb = nigeProbClipped;

  // ══════════════════════════════════════════════════════
  // 【Stage2】2〜6号艇の条件付き勝率（「1号艇が逃げなかった場合」の配分）
  // ══════════════════════════════════════════════════════
  //
  // CONDITIONAL_BOOST_SCALE: 攻撃力の効き。中間帯（20〜60%）の過小評価是正のため
  // 旧 BOOST_SCALE よりやや強めに設定（次回バックテストで要再検証）。
  const CONDITIONAL_BOOST_SCALE = 1.8;

  const others = boats.filter(b => b.boat !== 1);
  const othersProbTotal = others.reduce((s, b) => s + b.prob, 0) || 1;

  // ══════════════════════════════════════════════════════════════════
  // [2026-06-29 追加] 連動ペア（まくり→まくり差し）ボーナス
  //
  // pipeline_prototype.py 実績:
  //   連動先(まくり差し型)が3着以内に来た割合: 86.3%（ランダム比 +26%pt）
  // → まくり型艇が存在するとき、まくり差し実績を持つ艇に boost を上乗せする。
  //
  // CHAIN_BONUS_JS: 1着率換算ボーナス（Python側と同値）
  // ══════════════════════════════════════════════════════════════════
  const CHAIN_BONUS_JS = 0.08;

  // まくり実績がある艇（非1号艇）
  const hasMakuriBt = others.filter(b => {
    const k = getCourseMaster(b.name, String(b.boat))?.kimari;
    return k && (k['まくり'] ?? 0) > 0;
  });
  // まくり差し実績がある艇（非1号艇）
  const hasMakuriSashiBt = others.filter(b => {
    const k = getCourseMaster(b.name, String(b.boat))?.kimari;
    return k && (k['まくり差し'] ?? 0) > 0;
  });
  const hasChainPair = hasMakuriBt.length > 0 && hasMakuriSashiBt.length > 0;

  // 連動ボーナス係数マップ（デフォルト1.0）
  const chainBoostMap = {};
  others.forEach(b => { chainBoostMap[b.boat] = 1.0; });
  if (hasChainPair) {
    for (const b of hasMakuriSashiBt) {
      const cm  = getCourseMaster(b.name, String(b.boat));
      const runs = cm?.runs ?? 0;
      const msRate = cm?.kimari?.['まくり差し'] ?? 0;
      if (runs < 10 || msRate <= 0) continue;
      const trust = Math.min(runs / 80, 1.0);
      chainBoostMap[b.boat] = 1.0 + CHAIN_BONUS_JS * trust * Math.min(msRate * 3, 1.0);
    }
  }

  const condRaw = {};
  others.forEach(b => {
    const baseShare = b.prob / othersProbTotal; // 1号艇を除いた相対能力
    condRaw[b.boat] = Math.max(0,
      baseShare
      * (1.0 + boost[b.boat] * CONDITIONAL_BOOST_SCALE)
      * layer3[b.boat]
      * chainBoostMap[b.boat]  // ★連動ボーナス
    );
  });
  const condTotal = Object.values(condRaw).reduce((s, v) => s + v, 0) || 1;
  const conditionalShare = {};
  others.forEach(b => { conditionalShare[b.boat] = condRaw[b.boat] / condTotal; });

  // ══════════════════════════════════════════════════════════════════
  // [2026-06-29 追加] v2パターンテーブル ルックアップ補正（JS版）
  //
  // MASTER_EXT.v2_pattern_table が存在する場合に
  // 「1号艇ラベル × 筆頭威力 × 連動有無」でルックアップし、
  // 1号艇の nigeProb と筆頭威力艇の conditionalShare を実績値にブレンドする。
  //
  // ブレンド強度:
  //   reliable=true (n≧500) → 0.35
  //   reliable=false (n<500) → 0.15
  // パターン未一致・テーブルなし → 何もしない（既存ロジックのまま）
  // ══════════════════════════════════════════════════════════════════
  const v2Table = masterExt?.v2_pattern_table;
  let v2NigeOverride       = null;  // null = 補正なし
  let v2ForceBoat          = null;
  let v2ForceShareOverride = null;

  if (v2Table && boat1) {
    // 1号艇ラベルを推定
    const cm1   = getCourseMaster(boat1.name, '1');
    const runs1 = cm1?.runs ?? 0;
    if (runs1 >= 8) {
      const k1      = cm1?.kimari ?? {};
      const tot1    = Object.values(k1).reduce((s, v) => s + v, 0) || 1;
      const nigeR1  = (k1['逃げ'] ?? 0) / tot1;
      let b1Label;
      if (nigeR1 >= 0.5) {
        b1Label = '粘り型';
      } else {
        const betaMap = {'差し': '差され型', 'まくり': 'まくられ型', 'まくり差し': 'まくり差され型', '抜き': '抜かれ型'};
        const topK = ['差し', 'まくり', 'まくり差し', '抜き'].reduce((mx, k) => (k1[k] ?? 0) > (k1[mx] ?? 0) ? k : mx, '差し');
        b1Label = betaMap[topK] ?? 'その他';
      }

      // 筆頭威力艇（boost が最大の艇）
      const boostEntries = Object.entries(boost).filter(([bn]) => Number(bn) !== 1);
      if (boostEntries.length > 0) {
        const [topBoatStr] = boostEntries.reduce((mx, e) => e[1] > mx[1] ? e : mx, boostEntries[0]);
        const topBoat = Number(topBoatStr);
        const tdBt    = boats.find(b => b.boat === topBoat);
        if (tdBt) {
          const tdCm     = getCourseMaster(tdBt.name, topBoatStr);
          const tdK      = tdCm?.kimari ?? {};
          const tdTopK   = ['差し', 'まくり', 'まくり差し'].reduce((mx, k) => (tdK[k] ?? 0) > (tdK[mx] ?? 0) ? k : mx, '差し');
          const chainFlag = hasChainPair ? '連動有' : '連動無';
          const pk = `1号[${b1Label}] | 筆頭[${topBoat}号:${tdTopK}] | ${chainFlag}`;
          const entry = v2Table[pk];
          if (entry) {
            const V2_BLEND = entry.reliable ? 0.35 : 0.15;
            // 1号艇 nigeProb への実績ブレンド
            v2NigeOverride = nigeProb * (1 - V2_BLEND) + entry.boat1_rate * V2_BLEND;
            // 筆頭威力艇 conditionalShare への実績ブレンド
            v2ForceBoat         = topBoat;
            v2ForceShareOverride = conditionalShare[topBoat] * (1 - V2_BLEND) + entry.force1_rate * V2_BLEND;
          }
        }
      }
    }
  }

  // v2補正を適用（補正がある場合のみ）
  const finalNigeProb = v2NigeOverride !== null ? Math.min(NIGE_CLIP_MAX, Math.max(NIGE_CLIP_MIN, v2NigeOverride)) : nigeProb;
  if (v2ForceBoat !== null && v2ForceShareOverride !== null) {
    // conditionalShare を再正規化しながら筆頭威力艇を補正
    const oldShare    = conditionalShare[v2ForceBoat];
    const delta       = v2ForceShareOverride - oldShare;
    const otherBoats  = others.filter(b => b.boat !== v2ForceBoat);
    const otherTotal  = otherBoats.reduce((s, b) => s + conditionalShare[b.boat], 0) || 1;
    // delta 分を他艇から按分で引く（ゼロサム保証）
    otherBoats.forEach(b => {
      conditionalShare[b.boat] = Math.max(0, conditionalShare[b.boat] - delta * (conditionalShare[b.boat] / otherTotal));
    });
    conditionalShare[v2ForceBoat] = v2ForceShareOverride;
    // 合計が1.0になるよう再正規化
    const csTotal = others.reduce((s, b) => s + conditionalShare[b.boat], 0) || 1;
    others.forEach(b => { conditionalShare[b.boat] /= csTotal; });
  }

  // ── 表示・デバッグ用に layer2_modifier 相当値を逆算 ──
  // （UIの「展開補正」列が参照する値。実際の final_prob 計算には使わない＝
  //   下流の二重補正を防ぐため、ここはあくまで「表示用の換算値」）
  const layer2 = {};
  layer2[1] = Math.max(0, 1.0 - totalBoost * NIGE_BOOST_SCALE);
  others.forEach(b => { layer2[b.boat] = 1.0 + boost[b.boat] * CONDITIONAL_BOOST_SCALE; });


  // ══════════════════════════════════════════════════════
  // 【最終合成】二段階モデル: final_prob[1]=finalNigeProb（v2補正後）, final_prob[k]=(1−finalNigeProb)×conditionalShare[k]
  // ══════════════════════════════════════════════════════
  const scores = {};
  scores[1] = Math.max(FLOOR_PROB, finalNigeProb);
  others.forEach(b => {
    scores[b.boat] = Math.max(FLOOR_PROB, (1 - finalNigeProb) * (conditionalShare[b.boat] ?? 0));
  });
  const total = Object.values(scores).reduce((s, v) => s + v, 0) || 1;

  return [...boats]
    .map(b => ({
      ...b,
      tenkai_prob:         scores[b.boat] / total,
      tenkai_score:        scores[b.boat] / total,
      kimari_coef:         b.boat === 1 ? -(totalBoost) : boost[b.boat],  // デバッグ用: ブースト量
      final_prob:          scores[b.boat] / total,
      // [2026-06-20 追加] 1号艇のみ: コース別補正前の値（calibration.js が
      // 自己崩壊ループなしで再学習するための「生データ」）
      _rawCourseProb:      b.boat === 1 ? nigeProbClipped : null,
      // ── レイヤー別係数（デバッグ・チューニング用。表示換算値。final_probの直接の入力ではない）──
      layer2_modifier:     layer2[b.boat],      // 展開適合度（1.0基準）
      layer3_modifier:     layer3[b.boat],      // 当日環境（1.0基準）
      _l3_tenji:           layer3TenjiPre[b.boat], // うち展示タイム成分
      _l3_wind:            layer3WindPre[b.boat],  // うち気象成分
      _slit_makuri_boost:  makuriBoost,
      _slit_nige_discount: nigeDiscount,
      _wind_type:          weatherCtxPre.windType,
      _tenji_dev:          tenjiDevMapPre[b.boat] ?? 0,
      _nige_prob:          b.boat === 1 ? nigeProb : null, // デバッグ用: Stage1の独立逃げ確率
      _v2_nige_override:   b.boat === 1 ? v2NigeOverride : null, // デバッグ用: v2補正後
      _chain_boost:        chainBoostMap[b.boat] ?? null, // デバッグ用: 連動ボーナス係数
    }))
    .sort((a, b) => b.tenkai_prob - a.tenkai_prob);
}

// ── 条件付き2着率推定 ──
//
// 【役割】inn_2place（イン逃げ時の会場別枠別2着率）を使い、
//         各艇の「2着に来る期待スコア」を算出する。
//
// アルゴリズム:
//   1. 1コースが逃げで1着になる確率 = vKimari["逃げ"] × 1コースのtenkai_prob比率
//   2. その場合の各コースの2着率 = inn_2place[コース] + winner_course_order 個人補正
//   3. それ以外の展開（差し・まくり等）は tenkai_remaining（会場別実績、なければ全国実績）+
//      winner_course_order（個人補正）でブレンド。データなし → tenkai_prob 相対値
//
// 返り値: { [boat番号]: place2スコア（正規化済み 0-1） }
//
function calcPlace2Probs(boats, ranked){
  const place2Score = {};
  ranked.forEach(b => { place2Score[b.boat] = 0; });

  const tpMap = {};
  ranked.forEach(b => { tpMap[b.boat] = b.tenkai_prob; });

  // inn_2place: inn_data に直接入っていれば使用、なければ venue_stats から取得
  const inn2Place = (() => {
    const v = (DATA.inn_data || {}).inn_2place;
    if(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) return v;
    return MASTER_EXT?.venue_stats?.[DATA.venue]?.inn_2place || {};
  })();
  const hasInn2 = Object.keys(inn2Place).length > 0;

  // venue_kimari があれば逃げ展開確率を取得
  const vKimari = MASTER_EXT?.venue_kimari?.[DATA.venue] || null;
  const nigeProb = vKimari?.['逃げ'] ?? 0.45;  // なければ0.45をデフォルト

  // winner_course_order: 個人の「勝者コース別・自コース別2着率」
  const winnerCO = MASTER_EXT?.winner_course_order || {};

  // 1コース艇の final_prob 比率（展示補正後の最終確率ベースで按分）
  const boat1 = ranked.find(b => b.boat === 1);
  const fp1   = boat1?.final_prob ?? boat1?.tenkai_prob ?? 0;
  const totalFP = ranked.reduce((s, b) => s + (b.final_prob ?? b.tenkai_prob ?? 0), 0) || 1;
  // 後続処理（非逃げ按分）でも参照するため totalTP は残す
  const tp1   = boat1 ? boat1.tenkai_prob : 0;
  const totalTP = ranked.reduce((s, b) => s + b.tenkai_prob, 0) || 1;

  // 逃げ展開（1コース1着）の確率: final_prob ベースで按分
  const nigeWinProb = nigeProb * (fp1 / totalFP);

  // ── 逃げ展開での2着: inn_2place ベース + winner_course_order 個人補正 ──
  if(hasInn2 && nigeWinProb > 0){
    const othersTP = ranked.filter(r => r.boat !== 1).reduce((s, r) => s + r.tenkai_prob, 0) || 1;
    for(const b of ranked){
      if(b.boat === 1) continue;
      const sc     = String(b.boat);
      const baseP2 = inn2Place[sc] ?? null;

      // winner_course_order: 「1号艇(wc='1')が1着のとき、自艇(sc)が2着に来た率」
      const personEntry = winnerCO[b.name]?.[sc]?.['1'];
      const personRate2 = (personEntry && personEntry.rate2 != null) ? personEntry.rate2 : null;
      const personTrust = (personEntry && personEntry.trust != null) ? personEntry.trust : 0;

      let p2;
      if(baseP2 != null && personRate2 != null && personTrust > 0.3){
        // 個人実績と inn_2place をブレンド（personTrust で重み付け）※閾値: 0.3（count>=10相当）
        p2 = personRate2 * personTrust + baseP2 * (1 - personTrust);
      } else if(baseP2 != null){
        p2 = baseP2;
      } else {
        // inn_2place にもデータなし → tenkai_prob 相対値
        p2 = tpMap[b.boat] / othersTP;
      }
      place2Score[b.boat] += nigeWinProb * p2;
    }
  }

  // ── 非逃げ展開（差し・まくり等）の2着: tenkai_remaining + winner_course_order ──
  const nonNigeProb = 1.0 - nigeWinProb;
  // tenkai_remaining: {決まり手: {1着コース: {進入コース: {rate2, trust}}}}
  // 会場別データ優先、なければ全国実績にフォールバック（calcScenarioData と統一）
  const tenkaiRemaining = (() => {
    // [2026-06-01 修正] venue はグローバル変数ではなく DATA.venue から取得する
    const _venueForP2 = DATA?.venue ?? currentVenue ?? null;
    const vLocal = MASTER_EXT?.venue_stats?.[_venueForP2]?.tenkai_remaining;
    if(vLocal && Object.keys(vLocal).length > 0) return vLocal;
    return MASTER_EXT?.tenkai_remaining || {};
  })();
  if(nonNigeProb > 0){
    for(const winner of ranked){
      const winnerProb = nonNigeProb * (tpMap[winner.boat] / totalTP);
      if(winnerProb <= 0) continue;
      const wc = String(winner.boat);
      const othersTotal = ranked.filter(b => b.boat !== winner.boat)
                                .reduce((s, b) => s + b.tenkai_prob, 0) || 1;

      // vKimari × tenkai_remaining が使える場合は決まり手別に残存率を集計
      let usedRemaining = false;
      if(vKimari && Object.keys(tenkaiRemaining).length > 0){
        const validKimariTot = Object.entries(vKimari)
          .filter(([k]) => k in tenkaiRemaining && tenkaiRemaining[k][wc])
          .reduce((s, [, v]) => s + v, 0);
        if(validKimariTot > 0){
          for(const self of ranked){
            if(self.boat === winner.boat) continue;
            const sc = String(self.boat);
            // ── tenkai_remaining の全国実績を決まり手加重平均で集計 ──
            let p2sum = 0, wsum = 0;
            for(const [kimari, kRate] of Object.entries(vKimari)){
              const entry = tenkaiRemaining[kimari]?.[wc]?.[sc];
              if(entry && entry.rate2 != null){
                const w = kRate * (entry.trust ?? 0.5);
                p2sum += entry.rate2 * w;
                wsum  += w;
              }
            }
            if(wsum > 0){
              const baseTR = p2sum / wsum;
              // ── winner_course_order で個人補正 ──
              // キー: winnerCO[自艇名][自コース(sc)][勝者コース(wc)]
              const personEntry = winnerCO[self.name]?.[sc]?.[wc];
              const personRate2 = (personEntry && personEntry.rate2 != null) ? personEntry.rate2 : null;
              const personTrust = (personEntry && personEntry.trust != null) ? personEntry.trust : 0;
              let p2;
              if(personRate2 != null && personTrust > 0.3){
                // 会場別実績と個人実績をブレンド ※閾値: 0.3（count>=10相当）
                const wNat = (1 - personTrust);
                p2 = (personRate2 * personTrust + baseTR * wNat);
              } else {
                p2 = baseTR;
              }
              place2Score[self.boat] += winnerProb * p2;
              usedRemaining = true;
            } else {
              // [2026-06-25] wsum=0フォールバックを平滑化（25%均等 + 75%tenkai_prob按分）
              const SMOOTH_TR = 0.25;
              const othersCountTR = ranked.filter(b => b.boat !== winner.boat).length || 1;
              const tpShareTR = tpMap[self.boat] / othersTotal;
              const eqShareTR = 1.0 / othersCountTR;
              place2Score[self.boat] += winnerProb * (SMOOTH_TR * eqShareTR + (1 - SMOOTH_TR) * tpShareTR);
            }
          }
        }
      }
      if(!usedRemaining){
        // [2026-06-25] 平滑化: 25%均等 + 75%tenkai_prob按分（過剰集中抑制）
        const SMOOTH_FB = 0.25;
        const othersCountFB = ranked.filter(b => b.boat !== winner.boat).length || 1;
        for(const self of ranked){
          if(self.boat === winner.boat) continue;
          const tpShare = tpMap[self.boat] / othersTotal;
          const eqShare = 1.0 / othersCountFB;
          place2Score[self.boat] += winnerProb * (SMOOTH_FB * eqShare + (1 - SMOOTH_FB) * tpShare);
        }
      }
    }
  }

  // 正規化
  const p2Total = Object.values(place2Score).reduce((a, b) => a + b, 0) || 1;
  const res = {};
  ranked.forEach(b => { res[b.boat] = place2Score[b.boat] / p2Total; });
  return res;
}

// venue_kimari が有効かどうか判定（1着率補正に使う）
function hasMasterExt(){
  return !!(MASTER_EXT &&
    MASTER_EXT.venue_kimari &&
    Object.keys(MASTER_EXT.venue_kimari).length > 0);
}
function tenkaiLabel(arek){
  if(arek < 40) return { label:'逃げ展開', cls:'safe', icon:'🏃' };
  if(arek > 60) return { label:'まくり展開', cls:'warn', icon:'💥' };
  return { label:'混戦展開', cls:'mix', icon:'🔀' };
}
function combo2(a,b){ return `${Math.min(a,b)}＝${Math.max(a,b)}`; }

// ── 展開シナリオ計算（純粋関数）──
//
// 【外部注入対応】options で masterExt / venueKimari / innData を
// 明示的に渡せるように拡張。
//
function calcScenarioData(ranked2, rawBoats, tenjiScoreMap, venueOverride, vdataOverride, options = {}) {
  const {
    masterExt = MASTER_EXT,
    venueKimari = null,
    innData = null,
  } = options;

  const venue = venueOverride || DATA?.venue;

  if (!masterExt || !masterExt.venue_kimari) {
    return { valid: false };
  }

  const vKimari = venueKimari ?? masterExt.venue_kimari[venue];
  if (!vKimari) return { valid: false };

  // inn2Place も引数で渡されたものを優先
  const inn2Place = (() => {
    if (innData?.inn_2place && Object.keys(innData.inn_2place).length > 0) {
      return innData.inn_2place;
    }
    const v = (vdataOverride?.inn_data || DATA?.inn_data || {}).inn_2place;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) return v;
    return masterExt?.venue_stats?.[venue]?.inn_2place || {};
  })();

  const KIMARI_HARD_EXCLUDE = {
    '逃げ':       new Set(['2','3','4','5','6']),
    '差し':       new Set(['1']),
    'まくり':     new Set(['1']),
    'まくり差し': new Set(['1','2','3']),  // 3コースも除外（calcTenkaiProbsと統一）
    '抜き':       new Set(),
  };
  function isValidFirst(boat, kimari){
    const wc = String(boat.boat);
    const exc = KIMARI_HARD_EXCLUDE[kimari];
    if(!exc) return false;
    return !exc.has(wc);
  }

  // ── 【刷新】シナリオ事前分布 scenarioVKimari の構築 ──
  //
  // 旧実装では calcTenkaiProbs と同じ被kimari補正をここでも行っており、
  // 「二重計上（過剰補正）」の原因になっていた。
  //
  // 新設計:
  //   - 被kimari補正はここでは一切行わない
  //   - scenarioVKimari = vKimari（会場事前分布）をそのまま使用
  //   - 1コース艇の個人逃げ率のみ、逃げ展開確率の微調整に使用する
  //     （逃げ率は被kimariと独立した情報であり二重計上にならない）
  //   - 最終1着率（final_prob）は calcTenkaiProbs → renderBuy で正確に計算済みのため、
  //     scenarioProb[winner][kimari] = final_prob × kimariシェア として
  //     自然にその情報を引き継ぐ（二重補正不要）
  //
  const boat1Scenario = rawBoats.find(b => b.boat === 1) || null;
  let scenarioVKimari = { ...vKimari };

  // 逃げ展開確率の微調整: 1コース艇の個人逃げ率（信頼度加重）のみ反映
  if(boat1Scenario){
    const boat1Cm   = getCourseMaster(boat1Scenario.name, '1');
    const nigeRate  = boat1Cm?.kimari?.['逃げ'] ?? null;
    const boat1Runs = boat1Cm?.runs ?? 0;
    if(nigeRate !== null && boat1Runs >= 20){
      const trust = Math.min(boat1Runs / 100, 1.0) * 0.5; // 最大50%ブレンド
      const venueNige = vKimari['逃げ'] || 0;
      scenarioVKimari['逃げ'] = venueNige * (1 - trust) + nigeRate * trust;
      // 再正規化（合計を1.0に揃える）
      const adjTotal = Object.values(scenarioVKimari).reduce((s, v) => s + v, 0);
      if(adjTotal > 0){
        for(const k of Object.keys(scenarioVKimari))
          scenarioVKimari[k] = scenarioVKimari[k] / adjTotal;
      }
    }
  }

  const kimariTypes = Object.keys(scenarioVKimari).filter(k => scenarioVKimari[k] > 0 && k in KIMARI_HARD_EXCLUDE && k !== '抜き');

  // ── winner艇の個人kimari率をscenarioVKimariにブレンド ──
  const SCENARIO_BLEND_STRENGTH = 0.7;
  function blendPersonalKimariScenario(boatObj, baseVKimari){
    const name   = boatObj.name;
    const course = String(boatObj.boat);
    const cm     = getCourseMaster(name, course);
    if(!cm) return baseVKimari;
    const runs = cm.runs ?? 0;
    if(runs < 20) return baseVKimari; // データ不足はスキップ（blendPersonalKimariと閾値統一: 20走）
    const trust = Math.min(runs / 100, 1.0) * SCENARIO_BLEND_STRENGTH;
    const personalKimari = cm.kimari ?? {};
    const BLEND_TARGETS = ['差し', 'まくり', 'まくり差し', '抜き'];
    const personalTotal = BLEND_TARGETS.reduce((s, k) => s + (personalKimari[k] ?? 0), 0);
    if(personalTotal <= 0) return baseVKimari;
    const blended = { ...baseVKimari };
    const venueBlendSum = BLEND_TARGETS.reduce((s, kk) => s + (baseVKimari[kk] ?? 0), 0);
    for(const k of BLEND_TARGETS){
      if(!(k in blended)) continue;
      const personalRate = (personalKimari[k] ?? 0) / personalTotal * venueBlendSum;
      blended[k] = baseVKimari[k] * (1 - trust) + personalRate * trust;
    }
    const origTotal  = Object.values(baseVKimari).reduce((s, v) => s + v, 0);
    const blendTotal = Object.values(blended).reduce((s, v) => s + v, 0);
    if(blendTotal > 0){
      for(const k of Object.keys(blended)) blended[k] = blended[k] / blendTotal * origTotal;
    }
    return blended;
  }

  // 1着率上位3艇（後方互換・表示タイトル用に保持）
  const top3 = ranked2.slice(0, 3);

  // 各1着候補について決まり手別の発生確率を計算（全艇対象）
  const scenarioProb = {};
  for(const winner of ranked2){
    scenarioProb[winner.boat] = {};
    const winnerVKimari = blendPersonalKimariScenario(winner, scenarioVKimari);
    const validKimariTotal = kimariTypes
      .filter(k => isValidFirst(winner, k))
      .reduce((s, k) => s + (winnerVKimari[k] || 0), 0);
    if(validKimariTotal <= 0) continue;
    for(const kimari of kimariTypes){
      if(!isValidFirst(winner, kimari)) continue;
      // final_prob: 基準確率×展開係数×展示係数を正規化した最終1着率（展示加味済み）
      // ここで final_prob を使うことで展示評価がシナリオ発生確率に直接反映される。
      // final_prob が未設定（MASTERなし等）の場合は tenkai_prob にフォールバック。
      const baseWeight = winner.final_prob ?? winner.tenkai_prob;
      scenarioProb[winner.boat][kimari] = baseWeight * (winnerVKimari[kimari] / validKimariTotal);
    }
  }

  // ── 各シナリオの2着リストを計算して scenarioPlace2 に格納 ──
  const tenkaiRem = (() => {
    const vLocal = masterExt?.venue_stats?.[venue]?.tenkai_remaining;
    if(vLocal && typeof vLocal === 'object' && Object.keys(vLocal).length > 0) return vLocal;
    return masterExt?.tenkai_remaining || {};
  })();
  const winnerCO = masterExt?.winner_course_order || {};

  // ══════════════════════════════════════════════════════════════════
  // [2026-06-25 新規追加] kimariタイプ別 2着コース出現バイアステーブル
  //
  // 【設計思想】
  //   tenkai_remaining はあくまで「全体平均」の2着率。
  //   しかし「差し」が決まった場合は1コース1着が多い → 2着に2〜3コースが来やすい、
  //   「まくり」が決まった場合は外コースが攻撃側 → 1コースが残りやすい、など
  //   kimariタイプによって2着コース分布に強い傾向がある。
  //
  //   この補正係数（bias）を p2 に乗算した後、再正規化することで
  //   「kimariが確定した条件のもとでの2着コース確率」に近づける。
  //   合計が1.0になる制約はp2Sum正規化後も満たされるため絶対値は問題なし。
  //
  // 【係数の根拠】競艇一般統計（全国平均）ベースの傾向値
  //   逃げ  : 1コースが1着 → 2〜3コースがそのまま残存しやすい
  //   差し  : 2〜3コースが差して1着 → 1コースが残りやすく、内コース優位
  //   まくり: 4〜6コースが捲って1着 → 1コースの逃げ残り or 隣接コースが2着
  //   まくり差し: 外コース → 1〜2コースが2着に来やすい（内を抜き返せず）
  //   抜き  : 平均的な分布（バイアスなし）
  //
  // 各コース（1〜6）の係数: 1.0が「バイアスなし」、>1.0が「このkimariで出やすい」
  // ══════════════════════════════════════════════════════════════════
  // [2026-07-03 置き換え] KIMARI_PLACE2_BIAS（決まり手キー・全国平均の決め打ち）を廃止。
  //
  // 【廃止理由】
  //   calibration.js の実績データ（allResultsScenAll, actual1st/actual2nd）を使い、
  //   1着コース別の実際の2着分布を集計したところ、'差し'[2コース]=0.0、
  //   'まくり'[4コース]=0.0、'まくり差し'[5コース]=0.0 の3件すべてが誤りと判明した
  //   （実測ではいずれも他コースと遜色ない頻度で2着に来ていた。例: まくり決まり手時の
  //   4コース実測2着率11.8% vs 旧係数0.0）。'決まり手で勝った/差された側は2着に残れない'
  //   という前提が実データと矛盾していたため、0.0によるハード排除は撤廃する。
  //
  //   また『kimari』（実際の決まり手）はそもそも allResultsScenAll に記録されておらず
  //   （top_stats.js の results.push には actualKimari フィールドが無かった）、
  //   検証時は actual1st（実際の1着コース。これは確実に記録されている）を代理指標として
  //   使わざるを得なかった。であれば最初から『1着コース』をキーにしたテーブルに
  //   置き換える方が、集計可能なデータと補正ロジックの対象が一致し整合的である。
  //   ※ top_stats.js 側に actualKimari 記録を追加すれば（本パッチと合わせて反映済み）、
  //     将来的には真の決まり手別データが溜まり次第、このテーブルをさらに精緻化できる。
  //
  // 【値の出典】2026-07-03 実測集計（1着コース別・2着コース分布、単位:件）
  //   1着=1(n=1348): 2:498 3:376 4:251 5:154 6:69
  //   1着=2(n=276) : 1:119 3:55  4:48  5:33  6:21
  //   1着=3(n=271) : 1:109 2:53  4:49  5:37  6:23
  //   1着=4(n=201) : 1:66  2:35  3:31  5:41  6:28
  //   1着=5(n=132) : 1:52  2:30  3:16  4:18  6:16
  //   1着=6(n=47)  : 1:18  2:4   3:8   4:10  5:7   ※サンプルやや少なめ、要継続監視
  //   係数 = 実測2着出現率 ÷ 平均値(1/5=20%)。1.0=平均的、0.0は使用しない。
  const WINNER_COURSE_PLACE2_COEF = {
    // 1着コース: [2着候補コース1, 2, 3, 4, 5, 6]（自コース＝winner自身はnullで未使用）
    1: [null, 1.85, 1.39, 0.93, 0.57, 0.26],
    2: [2.16, null, 1.00, 0.87, 0.60, 0.38],
    3: [2.01, 0.98, null, 0.90, 0.68, 0.42],
    4: [1.64, 0.87, 0.77, null, 1.02, 0.70],
    5: [1.97, 1.14, 0.61, 0.68, null, 0.61],
    6: [1.92, 0.43, 0.85, 1.06, 0.75, null],
  };
  // bias係数の適用強度（0=無効, 1=フル適用）
  // [2026-06-25] 0.4 → 0.55 に引き上げ
  // 理由: キャリブレーション診断で2着予測の1位-2位的中率差が6%のみ（目標10%+）
  //   であり、コース別バイアスが十分に効いていなかった。
  //   0.55 は tenkai_remaining の実データを尊重しつつバイアスを効かせる実用的な中間値。
  //   2着確率の40-60%帯過大評価（+15%）は当日修正済みの展示クリップ引き下げで対応済み
  //   のため、この引き上げは2着識別力改善のみを目的とする。
  const KIMARI_BIAS_STRENGTH = 0.55;

  const scenarioPlace2 = {};
  for(const winner of ranked2){
    scenarioPlace2[winner.boat] = {};
    const wc = String(winner.boat);
    // final_prob（展示加味済み最終確率）ベースで他艇の合計を算出
    const othersTotal = ranked2
      .filter(r => r.boat !== winner.boat)
      .reduce((s, r) => s + (r.final_prob ?? r.tenkai_prob), 0) || 1;

    // [2026-07-03] 1着コース別バイアス配列（実測ベース）。kimariに依存しないため
    // winnerループの外（＝1回だけ）で取得する。
    const biasByWinnerCourse = WINNER_COURSE_PLACE2_COEF[winner.boat] ?? null;

    for(const kimari of kimariTypes){
      if(!(scenarioProb[winner.boat]?.[kimari] > 0)) continue;

      const useInn2 = (kimari === '逃げ' && winner.boat === 1 && Object.keys(inn2Place).length > 0);
      const remForThis = tenkaiRem[kimari]?.[wc] || null;

      const place2List = rawBoats
        .filter(b => b.boat !== winner.boat)
        .map(b => {
          const sc = String(b.boat);
          let p2;
          // avg_rank補正用（calc3rdScoresのrankCoefと同じ指標を2着側にも適用する）
          // [2026-06-20 追加] 旧実装は p2 が rate2/trust ブレンドのみで個人の
          // 「自コース×勝者コースでの平均着順」を一切使っておらず、3着側
          // （calc3rdScores の rankCoef）と非対称だった。
          // キャリブレーション診断で2着予測の1位-2位的中率差が3%しかなく
          // 識別力が弱いと出ていたため、3着と同じ signal を追加して順位の
          // 分離を強める。
          let _avgRank2 = null;
          // [2026-07-02 追加] 実測マスタデータ（tenkai_remaining / inn_2place）の
          // 信頼度。後段のkimari別バイアス補正の強度を動的に決めるために使う。
          // 0 = 実測データなし（全国平均バイアスをフル適用） / 1 = 実測データ十分（バイアス無効化）
          let _dataTrust2 = 0;
          if(useInn2){
            const baseP2 = inn2Place[sc] ?? null;
            const personEntry2 = winnerCO[b.name]?.[sc]?.['1'];
            const personRate2  = personEntry2?.rate2 ?? null;
            const personTrust2 = personEntry2?.trust ?? 0;
            _avgRank2 = personEntry2?.avg_rank ?? null;
            if(baseP2 != null && personRate2 != null && personTrust2 > 0.3){ // 他箇所と統一(count>=10相当)
              p2 = personRate2 * personTrust2 + baseP2 * (1 - personTrust2);
            } else {
              p2 = baseP2;
            }
            // inn_2place は会場の実測イン逃げ時2着率（board全体集計）のため
            // 値が取れていれば信頼度は高いとみなす。
            if(baseP2 != null) _dataTrust2 = 1.0;
            if(p2 == null){
              // [2026-06-25] finalProb按分を平滑化（25%均等 + 75%prob按分）
              const bt = ranked2.find(r => r.boat === b.boat);
              const fpShare = bt ? (bt.final_prob ?? bt.tenkai_prob) / othersTotal : 0;
              const eqShare = 1.0 / (rawBoats.length - 1 || 1);
              p2 = 0.25 * eqShare + 0.75 * fpShare;
            }
          } else if(remForThis){
            const remEntry  = remForThis[sc];
            const baseTR    = remEntry?.rate2 ?? null;
            const trTrust   = remEntry?.trust ?? 0;
            const personEntry = winnerCO[b.name]?.[sc]?.[wc];
            const personRate2 = personEntry?.rate2 ?? null;
            const personTrust = personEntry?.trust ?? 0;
            _avgRank2 = personEntry?.avg_rank ?? null;
            // 実測データの信頼度＝tenkai_remaining側の trust（xlsx「信頼度」列＝レース数由来）。
            // [2026-07-02 追記] 個人実績（winner_course_order）がブレンドされている場合は
            // その信頼度も合成する（どちらか一方が高信頼なら十分に実測寄りとみなす＝確率的OR）。
            // p2自体は既に personRate2 をブレンドしているため、_dataTrust2 側も
            // 同じ情報源の信頼度を反映しないと「個人データは使っているのに
            // バイアス抑制には個人の信頼度が効かない」という不整合になる。
            if(baseTR != null){
              _dataTrust2 = (personRate2 != null)
                ? 1 - (1 - trTrust) * (1 - personTrust)
                : trTrust;
            }
            // [2026-07-13 修正] personTrust > 0.3 のハードカットオフを撤廃。
            // 旧: 信頼度0.3未満の個人データは「全く使わない」の二択だったため、
            //     境界付近（trust=0.29等）の情報がまるごと切り捨てられていた。
            // 新: wPerson=personTrust による連続ブレンドなら、trust→0で自然に
            //     baseTRのみへ収束するため閾値は不要（数式的に安全側）。
            if(baseTR != null && personRate2 != null){
              const wPerson = personTrust;
              const wNat    = (1 - personTrust);  // ② 修正: trTrust二重適用を排除
              const wTot    = wPerson + wNat;      // 常に1.0
              p2 = (personRate2 * wPerson + baseTR * wNat) / wTot;
              try { _CALC2ND_FALLBACK_STATS.total++; _CALC2ND_FALLBACK_STATS.branchTRPerson++; } catch(_e) {}
            } else if(baseTR != null){
              p2 = baseTR;
              try { _CALC2ND_FALLBACK_STATS.total++; _CALC2ND_FALLBACK_STATS.branchTROnly++; } catch(_e) {}
            } else {
              // [2026-07-12 追加] tenkai_remainingのrate2が欠損している場合、
              // place2_dist（dynamic_inn2place.jsが会場×勝ち艇別に実績集計した
              // 決まり手非依存の粗い実測分布）があれば優先的に使う。
              // 決まり手別ではないためtenkai_remainingより精度は劣るが、
              // 実績を一切見ないfinalProb按分よりは改善が期待できる。
              // 安全策: 値が無ければ従来通りfinalProb按分にフォールバック（挙動変化なし）。
              const p2Dynamic = masterExt?.venue_stats?.[venue]?.place2_dist?.[wc]?.[sc] ?? null;
              if(p2Dynamic != null){
                p2 = p2Dynamic;
                try { _CALC2ND_FALLBACK_STATS.total++; _CALC2ND_FALLBACK_STATS.branchDynamic++; } catch(_e) {}
              } else {
                // [2026-06-25] finalProb按分を平滑化
                const bt = ranked2.find(r => r.boat === b.boat);
                const fpShare = bt ? (bt.final_prob ?? bt.tenkai_prob) / othersTotal : 0;
                const eqShare = 1.0 / (rawBoats.length - 1 || 1);
                p2 = 0.25 * eqShare + 0.75 * fpShare;
                try { _CALC2ND_FALLBACK_STATS.total++; _CALC2ND_FALLBACK_STATS.branchPure++; } catch(_e) {}
              }
            }
          } else {
            // [2026-07-12 追加] tenkai_remaining自体が欠損している場合も同様に
            // place2_distを優先フォールバックとして使う。
            const p2Dynamic = masterExt?.venue_stats?.[venue]?.place2_dist?.[wc]?.[sc] ?? null;
            if(p2Dynamic != null){
              p2 = p2Dynamic;
              try { _CALC2ND_FALLBACK_STATS.total++; _CALC2ND_FALLBACK_STATS.branchDynamic++; } catch(_e) {}
            } else {
              // [2026-06-25] finalProb按分を平滑化（tenkai_remainingデータなし）
              const bt = ranked2.find(r => r.boat === b.boat);
              const fpShare = bt ? (bt.final_prob ?? bt.tenkai_prob) / othersTotal : 0;
              const eqShare = 1.0 / (rawBoats.length - 1 || 1);
              p2 = 0.25 * eqShare + 0.75 * fpShare;
              try { _CALC2ND_FALLBACK_STATS.total++; _CALC2ND_FALLBACK_STATS.branchPure++; } catch(_e) {}
            }
          }

          // avg_rank補正を適用（3.5を中央値とし、平均着順が良いほど上方修正）
          // 3着側[0.5,1.5]より分散が大きい指標のため[0.7,1.3]とやや狭いクリップ。
          // [2026-06-25] 上限1.3→1.15, 下限0.7→0.8に抑制（2着確率過大評価対策）
          // [2026-06-25 追記] 識別力向上のため下限を0.8→0.75に緩和。
          //   上限は2着過大評価対策のため1.15で据え置き。
          const rankCoef2 = _avgRank2 != null
            ? Math.max(0.75, Math.min(1.15, (3.5 - _avgRank2) / 1.5 + 0.85))
            : 1.0;
          p2 *= rankCoef2;

          // ── [2026-07-03 改修] 1着コース別 2着コースバイアス補正（実測ベース） ──
          // biasByWinnerCourse[boat-1] が各コースの「この1着コースの時の出やすさ」係数
          // （2026-07-03 実測集計ベース。旧KIMARI_PLACE2_BIASの0.0強制排除は
          //  実測検証で3件とも誤りと判明したため廃止し、ハードゼロは一切使わない）。
          //
          // [2026-07-02] 旧実装は tenkai_remaining（会場別・決まり手別の実測2着率）で
          // ベース値 p2 を算出済みの艇に対しても、KIMARI_BIAS_STRENGTH=0.55 固定で
          // 全国平均バイアスを一律に上乗せしていた。これは実測データを持つケースでも
          // 全国平均の思い込みで歪める二重補正になっていた（マスタ_展開別残存_.xlsx の
          // 会場別・決まり手別・進入コース別 実測rate2/rate3 を軽視する形）。
          //
          // 改修: 実測データの信頼度 _dataTrust2（tenkai_remainingのtrust列＝レース数由来、
          // またはinn_2placeなら1.0）に応じてバイアス強度を動的に絞る。
          //   実測データ十分（trust→1） → 自社実測ベースのバイアスはほぼ効かせない
          //   実測データが薄い/ない（trust→0） → 従来通りKIMARI_BIAS_STRENGTH(0.55)をフル適用
          const rawBias = biasByWinnerCourse?.[b.boat - 1] ?? 1.0;
          const effectiveBiasStrength = KIMARI_BIAS_STRENGTH * (1 - _dataTrust2);
          const blendedBias = 1.0 * (1 - effectiveBiasStrength) + rawBias * effectiveBiasStrength;
          p2 *= blendedBias;

          return { boat: b.boat, name: b.name, p2 };
        });

      // 展示係数補正（問題3対応）
      //
      // 正規化前に各艇の展示係数（平均=1.0基準）を p2 に乗算する。
      // 展示が速い艇は p2 が上昇、遅い艇は p2 が低下。
      // 正規化後も相対順位のみ変わるため、合計は常に 1.0 を維持する。
      //
      // 過補正防止: 係数は枠番別クリップ範囲を適用。
      //   3〜5枠（差し・まくり主体）は展示の影響を強く効かせるため範囲を広げる。
      //   1〜2枠はイン優位が支配的なため狭く抑える。
      //
      // [2026-06-25] 上限値引き下げ（2着確率過大評価対策: 40-60%帯 -17%誤差改善）
      // 旧: 3枠1.40, 4枠1.45 → 展示補正が過剰に2着確率を押し上げていた
      const TENJI_P2_CLIP_BY_COURSE = {
        1: [0.88, 1.15],  // イン有利、展示で大きく変動しない
        2: [0.83, 1.20],
        3: [0.75, 1.28],  // 差し・まくり差し主体（旧1.40→1.28）
        4: [0.70, 1.30],  // まくり最多（旧1.45→1.30）
        5: [0.75, 1.28],  // （旧1.40→1.28）
        6: [0.78, 1.25],  // （旧1.35→1.25）
      };
      // [2026-07-12 修正] 乗算方式→加算方式に変更（final_prob側の1着補正と統一）。
      // クリップ幅(TENJI_P2_CLIP_BY_COURSE)自体は旧・乗算方式で調整された値をそのまま
      // 流用しているため、加算方式での実際の影響度は乗算時と異なる可能性がある。
      // 本番投入前にバックテストで確認すること。
      if(tenjiScoreMap){
        place2List.forEach(x => {
          const [lo, hi] = TENJI_P2_CLIP_BY_COURSE[x.boat] ?? [0.75, 1.35];
          const rawCoef = tenjiScoreMap[`__coef2_${x.boat}`] ?? tenjiScoreMap[`__coef_${x.boat}`] ?? 1.0;
          const coef    = Math.min(hi, Math.max(lo, rawCoef));
          x.p2 = Math.max(0.0001, x.p2 + (coef - 1.0));
        });
      }

      const p2Sum = place2List.reduce((s, x) => s + x.p2, 0) || 1;
      place2List.forEach(x => { x.p2 = x.p2 / p2Sum; });
      place2List.sort((a, b) => b.p2 - a.p2);
      scenarioPlace2[winner.boat][kimari] = place2List;
    }
  }

  // ── 軸艇×2着艇の3着上位リストを事前計算（画面・買い目の共通データ源）──
  // buildScenarioSection / renderBuy の両方がここを参照することでズレをなくす。
  // merged3rdMap[axisBoat][secondBoat] = calc3rdScores の全kimari加重平均結果（score降順）
  const merged3rdMap = {};
  for(const winner of ranked2){
    const ax = winner.boat;
    const axisScens = kimariTypes
      .map(k => ({ kimari: k, prob: scenarioProb[ax]?.[k] ?? 0 }))
      .filter(x => x.prob > 0.001);
    const totalAxProb = axisScens.reduce((s, x) => s + x.prob, 0) || 1;
    merged3rdMap[ax] = {};
    for(const second of ranked2){
      if(second.boat === ax) continue;
      const r3Map = {};
      for(const scen of axisScens){
        const w = scen.prob / totalAxProb;
        const thirds = calc3rdScores(ranked2, tenjiScoreMap, ax, scen.kimari, second.boat);
        for(const t3 of thirds){
          if(!r3Map[t3.boat]) r3Map[t3.boat] = { boat: t3.boat, r3sum: 0, scoreSum: 0, r3Count: 0, scoreCount: 0 };
          if(t3.r3 != null){ r3Map[t3.boat].r3sum += t3.r3 * w; r3Map[t3.boat].r3Count += w; }
          r3Map[t3.boat].scoreSum += t3.score * w; r3Map[t3.boat].scoreCount += w;
        }
      }
      const r3Entries = Object.values(r3Map)
        .map(x => ({ boat: x.boat, r3: x.r3Count > 0 ? x.r3sum / x.r3Count : null, score: x.scoreCount > 0 ? x.scoreSum / x.scoreCount : 0 }))
        .sort((a, b) => b.score - a.score);
      // ── 格納時点で score を正規化して normPct（整数%・合計100）を付加 ──
      const _scoreTotal = r3Entries.reduce((s, x) => s + x.score, 0) || 1;
      const _rawPcts    = r3Entries.map(x => x.score / _scoreTotal * 100);
      const _floors     = _rawPcts.map(p => Math.floor(p));
      const _rem        = 100 - _floors.reduce((s, p) => s + p, 0);
      _rawPcts.map((p, i) => ({ i, frac: p - Math.floor(p) }))
              .sort((a, b) => b.frac - a.frac)
              .slice(0, _rem)
              .forEach(({ i }) => { _floors[i] += 1; });
      r3Entries.forEach((x, i) => { x.normPct = _floors[i]; });
      merged3rdMap[ax][second.boat] = r3Entries;
    }
  }

  return { valid: true, scenarioProb, scenarioPlace2, kimariTypes, inn2Place, top3, scenarioVKimari, isValidFirst, merged3rdMap };
}

// ── 展開シナリオセクション生成（強化版: 2着+3着確率表示・1着率信頼度バー付き）──
//
// 全艇 × 全決まり手の発生確率から上位3シナリオを抽出して表示。
// 「決まり手」を主軸にし、同じ決まり手の重複は最上位1件のみ残す。
// 2着率: 逃げ(1コース1着)→inn_2place, それ以外→tenkai_remaining+winner_course_order
// 3着率: tenkai_remaining.rate3 × winner_course_order.rate3 個人補正ブレンド
// ── トップレベル関数（buildScenarioSection・renderBuy 両方から参照）──
// ── [2026-07-12 計装追加] calc3rdScores フォールバック分岐の内訳計測用カウンタ ──
// 目的: r3 決定ロジックがどの分岐(①base+個人 ②baseのみ ③個人のみ
//       ④a avg_3rd_rate ④b 固定テーブル)にどれだけ落ちているかを可視化する。
// 安全策:
//   - 既存の計算式・戻り値には一切影響しない（読み取り専用の計数のみ）
//   - try/catch で囲み、カウンタ処理自体が失敗しても本体計算は継続する
//   - var 宣言のため analyzer.js が二重読込されても再宣言エラーにならない
if (typeof _CALC3RD_FALLBACK_STATS === 'undefined') {
  var _CALC3RD_FALLBACK_STATS = { total: 0, branch1: 0, branch2: 0, branch3: 0, branch4a: 0, branch4b: 0 };
}
// [2026-07-13 計装追加] 2着計算(scenarioPlace2)の分岐内訳計測用カウンタ
// branchTRPerson: tenkai_remaining+個人ブレンド / branchTROnly: tenkai_remainingのみ
// branchDynamic: place2_distフォールバック使用 / branchPure: finalProb按分のみ(実測データ皆無)
if (typeof _CALC2ND_FALLBACK_STATS === 'undefined') {
  var _CALC2ND_FALLBACK_STATS = { total: 0, branchTRPerson: 0, branchTROnly: 0, branchDynamic: 0, branchPure: 0 };
}
function _resetCalc2ndFallbackStats() {
  _CALC2ND_FALLBACK_STATS = { total: 0, branchTRPerson: 0, branchTROnly: 0, branchDynamic: 0, branchPure: 0 };
}
function _printCalc2ndFallbackStats() {
  const s = _CALC2ND_FALLBACK_STATS;
  if (!s.total) { console.log('[calc2nd計装] データなし'); return s; }
  const pct = n => (n / s.total * 100).toFixed(1) + '%';
  console.log(
    `[calc2nd計装] total=${s.total} ` +
    `TR+個人=${pct(s.branchTRPerson)} TRのみ=${pct(s.branchTROnly)} ` +
    `place2_dist使用=${pct(s.branchDynamic)} finalProb按分のみ=${pct(s.branchPure)}`
  );
  return s;
}
function _resetCalc3rdFallbackStats() {
  _CALC3RD_FALLBACK_STATS = { total: 0, branch1: 0, branch2: 0, branch3: 0, branch4a: 0, branch4b: 0 };
}
function _printCalc3rdFallbackStats() {
  const s = _CALC3RD_FALLBACK_STATS;
  if (!s.total) { console.log('[calc3rd計装] データなし'); return s; }
  const pct = n => (n / s.total * 100).toFixed(1) + '%';
  console.log(
    `[calc3rd計装] total=${s.total} ` +
    `①base+個人=${pct(s.branch1)} ②baseのみ=${pct(s.branch2)} ③個人のみ=${pct(s.branch3)} ` +
    `④a avg_3rd_rate=${pct(s.branch4a)} ④b 固定テーブル=${pct(s.branch4b)}`
  );
  return s;
}

function calc3rdScores(ranked2, tenjiScoreMap, winnerBoat, kimari, secondBoat){
  // [2026-06-01 修正] venue はグローバル変数ではなく DATA.venue から取得する。
  // computeBuy3 / computeRanked2AndSd などから呼ばれる際、DATA = vdata（venue付き）が
  // セットされているため DATA.venue が正しい会場名になる。
  const _venueForCalc3rd = DATA?.venue ?? currentVenue ?? null;
  const tenkaiRem = (() => {
    const vLocal = MASTER_EXT?.venue_stats?.[_venueForCalc3rd]?.tenkai_remaining;
    if(vLocal && typeof vLocal === 'object' && Object.keys(vLocal).length > 0) return vLocal;
    return MASTER_EXT?.tenkai_remaining || null;
  })();
  const winnerCO = MASTER_EXT?.winner_course_order || {};
  const wc = String(winnerBoat);

  // 3着候補艇の final_prob 合計（フォールバック用の按分分母）
  const candidateTotal = ranked2
    .filter(b => b.boat !== winnerBoat && b.boat !== secondBoat)
    .reduce((s, b) => s + (b.final_prob ?? b.tenkai_prob ?? 0), 0) || 1;

  const remForThis = tenkaiRem?.[kimari]?.[wc] || null;

  const result = ranked2
    .filter(b => b.boat !== winnerBoat && b.boat !== secondBoat)
    .map(b => {
      const sc = String(b.boat);
      const remEntry    = remForThis?.[sc];
      // ③ rate3i をベース計算に活用（rate3i×0.6 + rate3×0.4 ブレンドで荒れ耐性UP）
      const rawR3i      = remEntry?.rate3i ?? null;
      const rawR3       = remEntry?.rate3  ?? null;
      const baseR3      = rawR3i != null
        ? rawR3i * 0.6 + (rawR3 ?? rawR3i) * 0.4
        : rawR3;
      const trTrust     = remEntry?.trust  ?? 0;
      const personEntry = winnerCO[b.name]?.[sc]?.[wc];
      const personR3    = personEntry?.rate3  ?? null;
      const personTrust = personEntry?.trust  ?? 0;
      // ① avg_rank 補正係数（着順が良いほどスコアUP: avg_rank=2.0→1.2倍, 3.5→0.7倍）
      const avgRank     = personEntry?.avg_rank ?? null;
      const rankCoef    = avgRank != null
        ? Math.max(0.5, Math.min(1.5, (3.5 - avgRank) / 1.5 + 0.7))
        : 1.0;

      // ── 2着と同じ3パターン優先順位 ──
      // [2026-07-13 修正] personTrust > 0.3 のハードカットオフを撤廃（2着と同じ理由）。
      let r3;
      if(baseR3 != null && personR3 != null){
        // ①ベース＋個人両方あり
        // ② wNat修正: baseは常にフルウェイト、個人が上乗せ（trTrust二重適用を排除）
        const wPerson = personTrust;
        const wNat    = (1 - personTrust);   // 修正: trTrust * (1-personTrust) → (1-personTrust)
        const wTot    = wPerson + wNat;       // 常に1.0
        r3 = (personR3 * wPerson + baseR3 * wNat) / wTot;
        try { _CALC3RD_FALLBACK_STATS.total++; _CALC3RD_FALLBACK_STATS.branch1++; } catch(_e) {}
      } else if(baseR3 != null){
        // ②ベースのみ
        r3 = baseR3;
        try { _CALC3RD_FALLBACK_STATS.total++; _CALC3RD_FALLBACK_STATS.branch2++; } catch(_e) {}
      } else if(personR3 != null){
        // ③個人のみ（ベースなし）
        r3 = personR3;
        try { _CALC3RD_FALLBACK_STATS.total++; _CALC3RD_FALLBACK_STATS.branch3++; } catch(_e) {}
      } else {
        // ④フォールバック: コース別全国平均3着率テーブルを優先使用
        // [修正 2026-07-05] avgR3 も無い場合に final_prob 相対比へ逃げる
        // ルートを完全に切断。1着確率の高い艇を3着にも引き上げてしまい
        // 3着予測が機能しない原因だったバグの再発防止。
        // 会場別・全国平均のどちらも欠損している場合は、コース別の固定
        // 統計値を最終フォールバックとして必ず適用する。
        const avgR3 = MASTER_EXT?.venue_stats?.[_venueForCalc3rd]?.avg_3rd_rate?.[String(b.boat)]
                   ?? MASTER_EXT?.avg_3rd_rate?.[String(b.boat)]
                   ?? null;
        r3 = avgR3 ?? (FIXED_3RD_RATE_BY_COURSE[b.boat] ?? FIXED_3RD_RATE_DEFAULT);
        try {
          _CALC3RD_FALLBACK_STATS.total++;
          if (avgR3 != null) _CALC3RD_FALLBACK_STATS.branch4a++;
          else _CALC3RD_FALLBACK_STATS.branch4b++;
        } catch(_e) {}
      }

      // [修正 2026-07-05] r3 は上記のいずれかの分岐で必ず値が入るため、
      // final_prob / tenkai_prob への引きずられルートはここで完全排除する。
      const baseScore = r3;

      const CLIP3_BY_COURSE = {
        1: [0.85, 1.20],
        2: [0.80, 1.25],
        3: [0.70, 1.42],  // [2026-06-25] 1.40→1.42: 3着識別力向上のため微拡大
        4: [0.65, 1.48],  // [2026-06-25] 1.45→1.48: 同上
        5: [0.70, 1.42],  // [2026-06-25] 1.40→1.42
      };
      const tenjiCoef = tenjiScoreMap ? (tenjiScoreMap[`__coef3_${b.boat}`] ?? tenjiScoreMap[`__coef_${b.boat}`] ?? 1.0) : 1.0;
      const [c3lo, c3hi] = CLIP3_BY_COURSE[b.boat] ?? [0.75, 1.35];
      const clipped = Math.min(c3hi, Math.max(c3lo, tenjiCoef));
      // [2026-07-12 修正] 乗算方式→加算方式に変更（1着・2着補正と統一）。
      // CLIP3_BY_COURSEは旧・乗算方式で調整された値をそのまま流用しているため、
      // 加算方式での実際の影響度は乗算時と異なる可能性がある。バックテスト要確認。
      const score = Math.max(0.0001, baseScore * rankCoef + (clipped - 1.0));

      return { boat: b.boat, name: b.name, r3, score };
    });

  const scoreSum = result.reduce((s, x) => s + x.score, 0) || 1;
  result.forEach(x => { x.score = x.score / scoreSum; });
  result.sort((a, b) => b.score - a.score);
  return result;
}