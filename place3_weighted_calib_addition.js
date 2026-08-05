// ─────────────────────────────────────────────────────────────────────────
// [2026-08-05 追加] computeScenCombosWithEV.js が実際に画面へ返している
// weighted3rd（1着上位2艇=top1/top2をfinal_prob比でブレンドした3着確率）
// の較正テーブル。
//
// place3_calib_addition.js の PLACE3_CALIB_POINTS は「全1着候補で周辺化した
// フルの3着確率」を較正したものだったが、実際に画面表示・買い目選定に
// 使われているのは top1/top2 軸のみに絞った近似値(weighted3rd)であるため、
// こちらを別途較正した。算出方法は computeScenCombosWithEV.js 内の
// _34b303 / _439583（軸ごとのweighted計算）と、それをfinal_prob比で
// ブレンドする本体ロジックをNode.js上で再現し、実データ
// (81日・10,052レース)で検証した。
//
// 【妥当性チェック】
//   同じ手法でweighted2ndを再現し、既存のPLACE2_CALIB_POINTS（実績較正済み）
//   と同方向・同程度のズレが出ることを確認した上で、weighted3rd側を構築。
//
// 【train/test 7:3検証結果（較正前→較正後 Brier Score、test側）】
//   1号艇: 0.08147 → 0.07840   4号艇: 0.15443 → 0.15334
//   2号艇: 0.15858 → 0.15383   5号艇: 0.14544 → 0.14471
//   3号艇: 0.16496 → 0.16168   6号艇: 0.13494 → 0.13388
//   全艇番で改善（過学習ではない）。
// ─────────────────────────────────────────────────────────────────────────
const PLACE3_WEIGHTED_CALIB_POINTS = {
  1: [[0.000, 0.000], [0.004, 0.051], [0.010, 0.073], [0.018, 0.081], [0.029, 0.087], [0.044, 0.103], [0.088, 0.136], [1.000, 0.136]],
  2: [[0.000, 0.000], [0.062, 0.167], [0.098, 0.179], [0.122, 0.200], [0.143, 0.191], [0.166, 0.195], [0.212, 0.220], [1.000, 0.220]],
  3: [[0.000, 0.000], [0.078, 0.165], [0.116, 0.180], [0.141, 0.183], [0.163, 0.200], [0.188, 0.222], [0.235, 0.227], [1.000, 0.227]],
  4: [[0.000, 0.000], [0.086, 0.139], [0.130, 0.177], [0.159, 0.183], [0.183, 0.182], [0.211, 0.213], [0.265, 0.247], [1.000, 0.247]],
  5: [[0.000, 0.000], [0.079, 0.127], [0.122, 0.149], [0.149, 0.160], [0.171, 0.168], [0.199, 0.208], [0.252, 0.244], [1.000, 0.244]],
  6: [[0.000, 0.000], [0.026, 0.058], [0.076, 0.112], [0.114, 0.148], [0.144, 0.179], [0.181, 0.208], [0.241, 0.236], [1.000, 0.236]],
};
window.PLACE3_WEIGHTED_CALIB_POINTS = PLACE3_WEIGHTED_CALIB_POINTS;

/**
 * computeScenCombosWithEV() が返す weighted3rd の生の値を実測ベースで補正する。
 * 呼び出し側で6艇分まとめて適用後、合計が1になるよう再正規化すること。
 * @param {number} rawProb  補正前の weighted3rd 値 (0〜1)
 * @param {number} boat     枠番（1〜6）
 * @returns {number}        補正後の値（0〜1、要再正規化）
 */
window.calibratePlace3WeightedProb = function (rawProb, boat) {
  if (rawProb == null || isNaN(rawProb)) return rawProb;
  const pts = PLACE3_WEIGHTED_CALIB_POINTS[boat];
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

// ── computeScenCombosWithEV() 呼び出し側での適用例 ──
//
// const res = computeScenCombosWithEV(venue, vdata, rno);
// if (res.weighted3rd && typeof calibratePlace3WeightedProb === 'function') {
//   const calibrated = {};
//   Object.entries(res.weighted3rd).forEach(([boatStr, raw]) => {
//     calibrated[boatStr] = calibratePlace3WeightedProb(raw, Number(boatStr));
//   });
//   const total = Object.values(calibrated).reduce((s, v) => s + (v || 0), 0) || 1;
//   Object.keys(calibrated).forEach(b => { calibrated[b] = calibrated[b] / total; });
//   res.weighted3rd = calibrated;
// }
