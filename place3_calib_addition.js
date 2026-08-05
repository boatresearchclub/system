// ─────────────────────────────────────────────────────────────────────────
// [2026-08-05 追加] 展開分析タブの3着率モデル（calcScenarioData の
// merged3rdMap から算出したマージナル3着確率）の較正テーブル。
//
// PLACE2_CALIB_POINTS と同じ「低い予測ほど過小評価・高い予測ほど過大評価」
// という歪みが3着率にも存在することが実データ(81日・10,052レース、
// train/test 7:3分割で検証済み)で確認できたため、同じ区分線形補正の
// 仕組みをそのまま適用する。
//
// 【検証結果（test側、較正前→較正後 Brier Score）】
//   1号艇: 0.07955 → 0.07869   4号艇: 0.15439 → 0.15284
//   2号艇: 0.15548 → 0.15402   5号艇: 0.14667 → 0.14491
//   3号艇: 0.16282 → 0.16143   6号艇: 0.13521 → 0.13426
//   全艇番で一貫して改善（過学習ではない）。
//
// 【元データの算出方法】
//   calcTenkaiProbsExtended → calcScenarioData で得られる
//   scenarioProb / scenarioPlace2 / merged3rdMap を、全ての1着軸(ax)・
//   2着候補(second)について確率加重で周辺化（marginalize）し、
//   艇ごとの「3着になる確率」を算出したもの（P(3着=X) の完全な周辺分布）。
//   computeScenCombosWithEV.js の weighted3rd（1着上位2艇のみで近似した値）
//   とは算出範囲が異なる点に注意。weighted3rd を較正したい場合は
//   同じ手法で weighted3rd 側の実績を集計し直す必要がある。
// ─────────────────────────────────────────────────────────────────────────
const PLACE3_CALIB_POINTS = {
  1: [[0.000, 0.000], [0.018, 0.052], [0.035, 0.065], [0.051, 0.072], [0.069, 0.085], [0.091, 0.122], [0.138, 0.136], [1.000, 0.136]],
  2: [[0.000, 0.000], [0.108, 0.157], [0.148, 0.148], [0.174, 0.195], [0.199, 0.189], [0.229, 0.233], [0.286, 0.229], [1.000, 0.229]],
  3: [[0.000, 0.000], [0.118, 0.152], [0.163, 0.165], [0.192, 0.170], [0.220, 0.202], [0.253, 0.230], [0.314, 0.258], [1.000, 0.258]],
  4: [[0.000, 0.000], [0.109, 0.121], [0.159, 0.150], [0.193, 0.181], [0.225, 0.195], [0.262, 0.239], [0.325, 0.257], [1.000, 0.257]],
  5: [[0.000, 0.000], [0.089, 0.115], [0.132, 0.146], [0.163, 0.158], [0.193, 0.192], [0.230, 0.210], [0.294, 0.235], [1.000, 0.235]],
  6: [[0.000, 0.000], [0.031, 0.059], [0.079, 0.106], [0.114, 0.158], [0.147, 0.164], [0.186, 0.209], [0.256, 0.245], [1.000, 0.245]],
};
window.PLACE3_CALIB_POINTS = PLACE3_CALIB_POINTS;

/**
 * 3着マージナル確率の生の値を実測ベースで補正する（区分線形補間）。
 * 呼び出し側で6艇分まとめて呼んだ後、合計が1になるよう再正規化すること。
 * PLACE2_CALIB_POINTS / calibratePlace2Prob と全く同じ使い方。
 * @param {number} rawProb  補正前の3着確率 (0〜1)
 * @param {number} boat     枠番（1〜6）
 * @returns {number}        補正後の値（0〜1、要再正規化）
 */
window.calibratePlace3Prob = function (rawProb, boat) {
  if (rawProb == null || isNaN(rawProb)) return rawProb;
  const pts = PLACE3_CALIB_POINTS[boat];
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
  return p;
};

// ── 使用例（renderer.js の 2着較正適用箇所と同じパターン）──
//
// let place3Map = /* マージナル3着確率を計算する関数の呼び出し */;
// if (typeof calibratePlace3Prob === 'function') {
//   const calibrated = {};
//   Object.keys(place3Map).forEach(boatStr => {
//     calibrated[boatStr] = calibratePlace3Prob(place3Map[boatStr], Number(boatStr));
//   });
//   const total3 = Object.values(calibrated).reduce((s, v) => s + (v || 0), 0) || 1;
//   Object.keys(calibrated).forEach(boatStr => { calibrated[boatStr] = calibrated[boatStr] / total3; });
//   place3Map = calibrated;
// }
