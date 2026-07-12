
// ── 買い目確率フィルター閾値 ──
// [削除] 確率フィルターは廃止。オッズ次第で低確率でも買い目に残す。
// let BUY_PROB_THRESHOLD = 2.0;

// ── 的中重視: 1着軸を1艇固定にするための乖離率閾値 ──
// final_prob 1位と2位の差がこの値（%）以上のとき、1位艇を1艇固定軸として組み立てる。
// 下回る場合は僅差2頭軸（isDualAxis）として2軸展開する。
// 根拠: 全国平均1コース確率≒50%, 2コース≒15% → 典型的な「明確な軸」レースで差は15%前後。
//       10%では拮抗レースでも固定軸になりすぎ回収悪化、15%では条件過剰で殆ど非該当。
//       12% = 1位の確率が2位の約1.25倍以上を「明確な1艇軸」と定義する仮置き値。
//       バックテスト後に調整すること（推奨範囲: 8〜15%）。
let DIVERGENCE_THRESHOLD_HIT = 12.0; // 単位: % ← スライダーUIから変更可

// ── 会場名→スラッグ 共通マップ（全関数から参照）──
const VENUE_SLUG_MAP = {
  "桐生":"kiryu","戸田":"toda","江戸川":"edogawa","平和島":"heiwajima",
  "多摩川":"tamagawa","浜名湖":"hamanako","蒲郡":"gamagori","常滑":"tokoname",
  "津":"tsu","三国":"mikuni","びわこ":"biwako","住之江":"suminoe",
  "尼崎":"amagasaki","鳴門":"naruto","丸亀":"marugame","児島":"kojima",
  "宮島":"miyajima","徳山":"tokuyama","下関":"shimonoseki","若松":"wakamatsu",
  "芦屋":"ashiya","福岡":"fukuoka","唐津":"karatsu","大村":"omura"
};

// ── 会場別展示情報タイム計測制約 ＋ 重みテーブル ──
//
// 重み設計方針:
//   lap1  = 4.5（固定）: 1周タイム → 総合的なモーター力
//   tenji = 4.5（固定）: 展示タイム → スリット後の直線加速力
//   回り足 or 直線 = 1.0（どちらか一方のみ使用、もう一方は0）:
//     差し強会場  → mawari=1.0, chokusen=0  （ターン巧さが差し展開に直結）
//     まくり強会場 → mawari=0,  chokusen=1.0 （立ち上がり加速がまくり展開に直結）
//   合計 = 10.0 → 再正規化後: lap1≒0.45, tenji≒0.45, mawari or chokusen≒0.10
//
// available: 計測が存在するか（falseはデータ自体がない）
//   lap1:"half" → 桐生は半周計測のため重みを半減して扱う
//
const VENUE_TENJI_CONFIG = {

  // ── 計測制約あり（tenji のみ）──
  "江戸川": {
    available: { lap1:false,  mawari:false, chokusen:false, tenji:true },
    weight:    { lap1:0,      mawari:0,     chokusen:0,     tenji:1.0  },
  },

  // ── lap1が半周計測（桐生）→ まくり強なので直線を採用、lap1重みを半減 ──
  "桐生": {
    available: { lap1:"half", mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:2.25,   mawari:0,     chokusen:1.0,   tenji:2.0  },
  },

  // ── mawari のみ計測あり（直線なし会場）→ 差し寄りのため回り足採用 ──
  "尼崎": {
    available: { lap1:true,   mawari:true,  chokusen:false, tenji:true },
    weight:    { lap1:4.5,    mawari:1.0,   chokusen:0,     tenji:2.0  },
  },
  "住之江": {
    available: { lap1:true,   mawari:true,  chokusen:false, tenji:true },
    weight:    { lap1:4.5,    mawari:1.0,   chokusen:0,     tenji:2.0  },
  },
  "徳山": {
    available: { lap1:true,   mawari:true,  chokusen:false, tenji:true },
    weight:    { lap1:4.5,    mawari:1.0,   chokusen:0,     tenji:2.0  },
  },

  // ── 蒲郡: 実測テーブル方式（1周+直線+展示、回り足は使わない）──
  "蒲郡": {
    available: { lap1:true,   mawari:false, chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:0,     chokusen:1.0,   tenji:2.0  },
  },
  "戸田": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:0,     chokusen:1.0,   tenji:2.0  },
  },
  "三国": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:0,     chokusen:1.0,   tenji:2.0  },
  },
  "平和島": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:0,     chokusen:1.0,   tenji:2.0  },
  },
  "浜名湖": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:0,     chokusen:1.0,   tenji:2.0  },
  },

  // ── 差し強会場 → 回り足を採用 ──
  "宮島": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:1.0,   chokusen:0,     tenji:2.0  },
  },
  "下関": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:1.0,   chokusen:0,     tenji:2.0  },
  },
  "若松": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:1.0,   chokusen:0,     tenji:2.0  },
  },

  // ── 逃げ強会場（差しもそこそこ）→ 回り足を採用 ──
  "大村": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:1.0,   chokusen:0,     tenji:2.0  },
  },
  // ── 常滑: 実測テーブル方式（1周+展示のみ、回り足・直線は使わない）──
  "常滑": {
    available: { lap1:true,   mawari:false, chokusen:false, tenji:true },
    weight:    { lap1:4.5,    mawari:0,     chokusen:0,     tenji:2.0  },
  },
  "丸亀": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:1.0,   chokusen:0,     tenji:2.0  },
  },

  // ── デフォルト（多摩川・津・びわこ・鳴門・児島・芦屋・福岡・唐津）→ 回り足を採用 ──
  // [2026-05-13 修正] tenji重みを 4.5→2.0 に削減
  // 旧: lap1=45% tenji=45% → 展示タイムが周回タイムと同等の影響力（過剰）
  // 新: lap1=56% tenji=25% → 展示タイムを補助的な判断材料に位置付け
  "_default": {
    available: { lap1:true,   mawari:true,  chokusen:true,  tenji:true },
    weight:    { lap1:4.5,    mawari:1.0,   chokusen:0,     tenji:2.0  },
  },
};

// ── 会場別 hiKimariStrength テーブル ──────────────────────────────────
//
// 1コース選手の被kimari率がvKimariを動的補正する際の強度係数。
// 値が大きいほど個人の被kimari率が展開確率に強く反映される。
//
// 設計基準:
//   逃げ強会場（大村・常滑・丸亀・尼崎・住之江）
//     → 1.5: イン有利な水面特性で1号艇が崩れにくい。外コース補正を抑える。
//   荒れ強会場（戸田・三国・平和島・浜名湖・蒲郡）
//     → 2.5: 外コースが決まりやすく、被kimari個人差が展開に直結しやすい。
//   特殊水面（江戸川）
//     → 2.0: 潮流・水路の特異性が強く個人被kimari率の汎化精度が低いため中程度に抑制。
//   デフォルト（上記以外: 多摩川・津・びわこ・鳴門・児島・芦屋・福岡・唐津など）
//     → 2.0: 現行より若干抑制し過補正リスクを低減。
//
// ⚠️ SYNC REQUIRED: prob_scenario_engine.py の _VENUE_HI_KIMARI_STRENGTH と値を必ず一致させること
// 変更時は両ファイルを同時に更新する
const VENUE_HI_KIMARI_STRENGTH = {
  // 逃げ強会場 → 弱め
  "大村":    1.5,
  "常滑":    1.5,
  "丸亀":    1.5,
  "尼崎":    1.5,
  "住之江":  1.5,
  "桐生":    1.5,
  "下関":    1.5,
  // 荒れ強会場 → 強め
  "戸田":    2.5,
  "三国":    2.5,
  "平和島":  2.5,
  "浜名湖":  2.5,
  "蒲郡":    2.5,
  // 特殊水面 → 中程度
  "江戸川":  2.0,
  // デフォルト (未登録会場はここを使用)
  "_default": 2.0,
};

// 会場名から hiKimariStrength を取得するヘルパー
function getHiKimariStrength(venue){
  return VENUE_HI_KIMARI_STRENGTH[venue] ?? VENUE_HI_KIMARI_STRENGTH["_default"];
}

// 会場設定から最終重みを返す（arek動的調整なし・会場固定重みのみ）
function resolveWeights(venue, arek){
  const cfg = VENUE_TENJI_CONFIG[venue] || VENUE_TENJI_CONFIG["_default"];
  const base = { ...cfg.weight };

  // 計測がない項目をゼロにして再正規化
  const FIELDS = ["lap1", "mawari", "chokusen", "tenji"];
  FIELDS.forEach(f => { if(!cfg.available[f]) base[f] = 0; });
  const total = FIELDS.reduce((s, f) => s + base[f], 0) || 1;
  FIELDS.forEach(f => { base[f] = base[f] / total; });
  return base;
}

// ── 住之江 展示補正テーブル（1周+回り足+展示 合算diff → 各着補正率） ──
// diff = 6艇平均合算 - 各艇合算（速い艇→プラス、遅い艇→マイナス）
// 小数第3位は四捨五入して第2位で判定
const SUMINOE_TENJI_TABLE = {
  1: [
    { lo: null,  hi: -0.40, p1: -24, p2:  4, p3: -5, p3r: -25 },
    { lo: -0.40, hi: -0.20, p1: -20, p2:  0, p3:  1, p3r: -19 },
    { lo: -0.19, hi:  0.00, p1: -12, p2:  4, p3:  1, p3r:  -7 },
    { lo:  0.01, hi:  0.19, p1: -10, p2:  4, p3:  1, p3r:  -5 },
    { lo:  0.20, hi:  0.39, p1:  -4, p2:  1, p3:  0, p3r:  -3 },
    { lo:  0.40, hi:  0.59, p1:   2, p2:  0, p3:  0, p3r:   2 },
    { lo:  0.60, hi:  0.79, p1:   6, p2: -3, p3:  1, p3r:   5 },
    { lo:  0.80, hi: null,  p1:  10, p2: -2, p3: -2, p3r:   6 },
  ],
  2: [
    { lo: null,  hi: -0.40, p1:  -1, p2: -9, p3: -3, p3r: -14 },
    { lo: -0.39, hi: -0.20, p1:  -6, p2: -2, p3:  5, p3r:  -3 },
    { lo: -0.19, hi:  0.00, p1:  -2, p2: -2, p3: -1, p3r:  -5 },
    { lo:  0.01, hi:  0.19, p1:  -4, p2:  0, p3:  1, p3r:  -3 },
    { lo:  0.20, hi:  0.39, p1:   1, p2:  0, p3:  1, p3r:   3 },
    { lo:  0.40, hi:  0.59, p1:   6, p2:  4, p3: -1, p3r:   9 },
    { lo:  0.60, hi:  0.79, p1:  10, p2:  5, p3: -3, p3r:  12 },
    { lo:  0.80, hi: null,  p1:   8, p2: 11, p3:  1, p3r:  20 },
  ],
  3: [
    { lo: null,  hi: -0.80, p1:  -8, p2: -2, p3: -4, p3r: -14 },
    { lo: -0.80, hi: -0.60, p1:  -1, p2: -9, p3: -9, p3r: -19 },
    { lo: -0.59, hi: -0.40, p1:  -2, p2: -3, p3:  0, p3r:  -5 },
    { lo: -0.39, hi: -0.20, p1:  -3, p2: -1, p3: -1, p3r:  -4 },
    { lo: -0.19, hi:  0.00, p1:  -2, p2:  1, p3: -1, p3r:  -2 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:  0, p3:  3, p3r:   3 },
    { lo:  0.20, hi:  0.39, p1:   5, p2:  0, p3:  4, p3r:   9 },
    { lo:  0.40, hi:  0.59, p1:   3, p2:  6, p3: -1, p3r:   9 },
    { lo:  0.60, hi:  0.80, p1:  13, p2:  6, p3: -4, p3r:  15 },
    { lo:  0.80, hi: null,  p1:   7, p2: 14, p3:  1, p3r:  22 },
  ],
  4: [
    { lo: null,  hi: -0.80, p1:  -6, p2: -7, p3: -7, p3r: -20 },
    { lo: -0.80, hi: -0.60, p1:  -4, p2: -8, p3:  3, p3r:  -9 },
    { lo: -0.59, hi: -0.40, p1:  -2, p2: -3, p3: -3, p3r:  -9 },
    { lo: -0.39, hi: -0.20, p1:  -1, p2: -3, p3:  0, p3r:  -4 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2:  1, p3:  0, p3r:   0 },
    { lo:  0.01, hi:  0.19, p1:   1, p2:  3, p3:  2, p3r:   5 },
    { lo:  0.20, hi:  0.39, p1:   4, p2:  5, p3:  1, p3r:  10 },
    { lo:  0.40, hi:  0.59, p1:   6, p2:  8, p3:  1, p3r:  15 },
    { lo:  0.60, hi:  0.80, p1:   6, p2:  8, p3:  3, p3r:  18 },
    { lo:  0.80, hi: null,  p1:   5, p2:  0, p3: 13, p3r:  18 },
  ],
  5: [
    { lo: null,  hi: -0.80, p1:  -1, p2: -2, p3: -9, p3r: -12 },
    { lo: -0.80, hi: -0.60, p1:  -3, p2: -1, p3: -3, p3r:  -7 },
    { lo: -0.59, hi: -0.40, p1:  -2, p2: -2, p3:  0, p3r:  -4 },
    { lo: -0.39, hi: -0.20, p1:   1, p2:  0, p3: -2, p3r:  -1 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2: -1, p3: -1, p3r:  -3 },
    { lo:  0.01, hi:  0.19, p1:   1, p2:  2, p3:  1, p3r:   4 },
    { lo:  0.20, hi:  0.39, p1:   1, p2:  0, p3: 10, p3r:  11 },
    { lo:  0.40, hi:  0.59, p1:   3, p2:  4, p3:  5, p3r:  11 },
    { lo:  0.60, hi:  0.80, p1:   9, p2:  5, p3:  1, p3r:  15 },
    { lo:  0.80, hi: null,  p1:  13, p2: 10, p3:  3, p3r:  26 },
  ],
  6: [
    { lo: null,  hi: -0.80, p1:  -1, p2: -3, p3: -7, p3r: -11 },
    { lo: -0.80, hi: -0.60, p1:  -1, p2:  1, p3: -2, p3r:  -3 },
    { lo: -0.59, hi: -0.40, p1:   0, p2: -2, p3:  0, p3r:  -1 },
    { lo: -0.39, hi: -0.20, p1:   0, p2: -1, p3: -1, p3r:  -3 },
    { lo: -0.19, hi:  0.00, p1:   0, p2:  1, p3: -2, p3r:  -1 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:  1, p3:  4, p3r:   5 },
    { lo:  0.20, hi:  0.39, p1:   0, p2:  0, p3:  3, p3r:   3 },
    { lo:  0.40, hi:  0.60, p1:   0, p2:  1, p3:  8, p3r:  10 },
    { lo:  0.60, hi:  0.80, p1:   0, p2: 14, p3:  6, p3r:  20 },
    { lo:  0.80, hi: null,  p1:  11, p2:  0, p3:  0, p3r:  25 },
  ],
};

// [修正 2026-07-05] 実測テーブル共通: 階段状binを線形補間してなめらかにする。
// 旧実装は if/else の範囲判定でbinの境界(0.01秒差)を跨ぐと
// p1/p2/p3が不連続にジャンプしていた（オーバーフィッティング要因）。
// 各binの中央値を代表点として線形補間し、実測データの値自体は保持したまま
// 連続的な変化にする（住之江・常滑・蒲郡いずれも実測データのため、
// 値を捨てて他会場と同じ合成感度式に統一するのではなく、補間のみ行う）。
function _interpolateTenjiTable(rows, diff) {
  const points = rows.map((r, i) => {
    let lo = r.lo, hi = r.hi;
    // 両端(null)は隣接binの幅を流用して代表点を推定
    if (lo === null) lo = hi - (rows[i + 1] ? (rows[i + 1].hi - rows[i + 1].lo || 0.2) : 0.2);
    if (hi === null) hi = lo + (rows[i - 1] ? (rows[i - 1].hi - rows[i - 1].lo || 0.2) : 0.2);
    return { x: (lo + hi) / 2, p1: r.p1, p2: r.p2, p3: r.p3, p3r: r.p3r };
  });

  if (diff <= points[0].x) return points[0];
  if (diff >= points[points.length - 1].x) return points[points.length - 1];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (diff >= a.x && diff <= b.x) {
      const t = (diff - a.x) / (b.x - a.x);
      return {
        p1:  a.p1  + (b.p1  - a.p1)  * t,
        p2:  a.p2  + (b.p2  - a.p2)  * t,
        p3:  a.p3  + (b.p3  - a.p3)  * t,
        p3r: a.p3r + (b.p3r - a.p3r) * t,
      };
    }
  }
  return points[points.length - 1];
}

// 住之江補正テーブルを引いて行を返す（線形補間版）
function _suminoeTableLookup(boat, diff) {
  const rows = SUMINOE_TENJI_TABLE[boat];
  if (!rows) return null;
  const d = Math.round(diff * 100) / 100; // 小数第3位四捨五入
  return _interpolateTenjiTable(rows, d);
}

// ── 常滑 展示補正テーブル（1周+展示 合算diff → 各着補正率） ──
// diff = 6艇平均合算 - 各艇合算（速い艇→プラス、遅い艇→マイナス）
// ※ 回り足は含まない（住之江と異なる点）
// 小数第3位は四捨五入して第2位で判定
const TOKONAME_TENJI_TABLE = {
  1: [
    { lo: null,  hi: -0.20, p1: -11, p2:  5, p3:  3, p3r:  -3 },
    { lo: -0.19, hi:  0.00, p1: -12, p2:  3, p3:  3, p3r:  -5 },
    { lo:  0.01, hi:  0.19, p1:  -9, p2:  4, p3:  1, p3r:  -1 },
    { lo:  0.20, hi:  0.39, p1:  -1, p2:  0, p3:  1, p3r:  -1 },
    { lo:  0.40, hi:  0.59, p1:   2, p2: -2, p3:  0, p3r:   0 },
    { lo:  0.60, hi:  0.79, p1:   6, p2: -2, p3: -1, p3r:   3 },
    { lo:  0.80, hi:  0.99, p1:   8, p2: -1, p3: -3, p3r:   4 },
    { lo:  1.00, hi: null,  p1:  11, p2: -2, p3: -2, p3r:   7 },
  ],
  2: [
    { lo: null,  hi: -0.60, p1:  -8, p2: -10, p3: -8, p3r: -26 },
    { lo: -0.59, hi: -0.40, p1:  -6, p2:  -5, p3: -4, p3r: -14 },
    { lo: -0.39, hi: -0.20, p1:   0, p2:  -4, p3: -1, p3r:  -6 },
    { lo: -0.19, hi:  0.00, p1:  -2, p2:  -1, p3:  0, p3r:  -4 },
    { lo:  0.01, hi:  0.19, p1:  -1, p2:   0, p3:  0, p3r:  -1 },
    { lo:  0.20, hi:  0.39, p1:   1, p2:   2, p3:  3, p3r:   5 },
    { lo:  0.40, hi:  0.59, p1:   6, p2:   6, p3:  0, p3r:  12 },
    { lo:  0.60, hi: null,  p1:   8, p2:   8, p3:  4, p3r:  20 },
  ],
  3: [
    { lo: null,  hi: -0.60, p1:  -5, p2:  -8, p3:  0, p3r: -12 },
    { lo: -0.59, hi: -0.40, p1:  -4, p2:  -5, p3: -2, p3r: -11 },
    { lo: -0.39, hi: -0.20, p1:  -4, p2:  -3, p3: -2, p3r:  -9 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2:   0, p3:  1, p3r:   0 },
    { lo:  0.01, hi:  0.19, p1:   2, p2:   0, p3:  3, p3r:   5 },
    { lo:  0.20, hi:  0.39, p1:   5, p2:   6, p3: -1, p3r:   9 },
    { lo:  0.40, hi:  0.59, p1:   7, p2:   9, p3:  0, p3r:  15 },
    { lo:  0.60, hi: null,  p1:   6, p2:   8, p3: -4, p3r:  10 },
  ],
  4: [
    { lo: null,  hi: -0.60, p1:  -2, p2:  -6, p3: -5, p3r: -13 },
    { lo: -0.59, hi: -0.40, p1:  -4, p2:  -2, p3: -6, p3r: -12 },
    { lo: -0.39, hi: -0.20, p1:  -3, p2:  -1, p3:  0, p3r:  -4 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2:   1, p3:  2, p3r:   3 },
    { lo:  0.01, hi:  0.19, p1:  -2, p2:   1, p3:  0, p3r:  -2 },
    { lo:  0.20, hi:  0.39, p1:   5, p2:   4, p3:  4, p3r:  13 },
    { lo:  0.40, hi:  0.59, p1:  16, p2:  -1, p3:  4, p3r:  19 },
    { lo:  0.60, hi: null,  p1:  19, p2:  11, p3: -4, p3r:  25 },
  ],
  5: [
    { lo: null,  hi: -0.60, p1:  -2, p2:  -4, p3: -6, p3r: -11 },
    { lo: -0.59, hi: -0.40, p1:  -2, p2:  -4, p3: -3, p3r:  -8 },
    { lo: -0.39, hi: -0.20, p1:  -1, p2:   0, p3:  0, p3r:  -1 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2:   0, p3: -1, p3r:  -2 },
    { lo:  0.01, hi:  0.19, p1:   1, p2:  -1, p3:  3, p3r:   3 },
    { lo:  0.20, hi:  0.39, p1:   1, p2:   5, p3:  4, p3r:  10 },
    { lo:  0.40, hi:  0.59, p1:   4, p2:   8, p3:  4, p3r:  14 },
    { lo:  0.60, hi: null,  p1:  16, p2:   8, p3:  6, p3r:  30 },
  ],
  6: [
    { lo: null,  hi: -0.60, p1:  -1, p2:  -3, p3: -5, p3r:  -9 },
    { lo: -0.59, hi: -0.40, p1:   0, p2:  -1, p3: -5, p3r:  -6 },
    { lo: -0.39, hi: -0.20, p1:  -1, p2:  -2, p3: -1, p3r:  -4 },
    { lo: -0.19, hi:  0.00, p1:   0, p2:   0, p3:  2, p3r:   2 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:   0, p3:  4, p3r:   4 },
    { lo:  0.20, hi:  0.39, p1:   1, p2:   5, p3:  3, p3r:   9 },
    { lo:  0.40, hi:  0.59, p1:   3, p2:   5, p3:  1, p3r:   9 },
    { lo:  0.60, hi: null,  p1:   7, p2:  18, p3:  7, p3r:  31 },
  ],
};

// 常滑補正テーブルを引いて行を返す（線形補間版）
function _tokonameTableLookup(boat, diff) {
  const rows = TOKONAME_TENJI_TABLE[boat];
  if (!rows) return null;
  const d = Math.round(diff * 100) / 100;
  return _interpolateTenjiTable(rows, d);
}

// ── 蒲郡 展示補正テーブル（1周+直線+展示 合算diff → 各着補正率） ──
// diff = 6艇平均合算 - 各艇合算（速い艇→プラス、遅い艇→マイナス）
// ※ 回り足は含まない
const GAMAGORI_TENJI_TABLE = {
  1: [
    { lo: null,  hi: -0.40, p1: -19, p2:  3, p3:  6, p3r: -11 },
    { lo: -0.39, hi: -0.20, p1: -13, p2:  8, p3:  6, p3r:   1 },
    { lo: -0.19, hi:  0.00, p1:  -8, p2:  0, p3:  2, p3r:  -5 },
    { lo:  0.01, hi:  0.19, p1:  -5, p2:  1, p3:  2, p3r:  -2 },
    { lo:  0.20, hi:  0.39, p1:   0, p2:  1, p3: -1, p3r:   0 },
    { lo:  0.40, hi:  0.59, p1:   7, p2: -2, p3: -2, p3r:   2 },
    { lo:  0.60, hi:  0.79, p1:   7, p2: -3, p3: -1, p3r:   3 },
    { lo:  0.80, hi: null,  p1:  13, p2: -3, p3: -3, p3r:   7 },
  ],
  2: [
    { lo: null,  hi: -0.60, p1:  -5, p2:  -5, p3: -8, p3r: -18 },
    { lo: -0.59, hi: -0.40, p1:  -3, p2:  -1, p3: -5, p3r:  -9 },
    { lo: -0.39, hi: -0.20, p1:  -5, p2:  -3, p3: -3, p3r: -11 },
    { lo: -0.19, hi:  0.00, p1:  -3, p2:  -1, p3:  1, p3r:  -3 },
    { lo:  0.01, hi:  0.19, p1:  -2, p2:   1, p3:  2, p3r:   0 },
    { lo:  0.20, hi:  0.39, p1:   5, p2:   2, p3:  1, p3r:   8 },
    { lo:  0.40, hi:  0.59, p1:   8, p2:   1, p3:  1, p3r:  10 },
    { lo:  0.60, hi:  0.79, p1:   6, p2:  13, p3:  1, p3r:  20 },
    { lo:  0.80, hi: null,  p1:  24, p2:  -3, p3: -2, p3r:  19 },
  ],
  3: [
    { lo: null,  hi: -0.80, p1:  -3, p2:  -5, p3: -8, p3r: -17 },
    { lo: -0.79, hi: -0.60, p1:  -4, p2:  -7, p3: -9, p3r: -20 },
    { lo: -0.59, hi: -0.40, p1:  -5, p2:  -7, p3: -3, p3r: -15 },
    { lo: -0.39, hi: -0.20, p1:  -4, p2:  -4, p3:  4, p3r:  -5 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2:  -2, p3: -2, p3r:  -5 },
    { lo:  0.01, hi:  0.19, p1:   1, p2:   3, p3:  1, p3r:   4 },
    { lo:  0.20, hi:  0.39, p1:   4, p2:   3, p3:  4, p3r:  10 },
    { lo:  0.40, hi:  0.59, p1:  10, p2:  13, p3: -2, p3r:  20 },
    { lo:  0.60, hi: null,  p1:   8, p2:  10, p3:  2, p3r:  20 },
  ],
  4: [
    { lo: null,  hi: -0.80, p1:  -5, p2:  -6, p3: -11, p3r: -21 },
    { lo: -0.79, hi: -0.60, p1:  -4, p2:  -9, p3:  -3, p3r: -16 },
    { lo: -0.59, hi: -0.40, p1:  -1, p2:  -6, p3:  -2, p3r:  -9 },
    { lo: -0.39, hi: -0.20, p1:  -4, p2:  -3, p3:   2, p3r:  -4 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2:  -1, p3:  -2, p3r:  -3 },
    { lo:  0.01, hi:  0.19, p1:   2, p2:   1, p3:   0, p3r:   3 },
    { lo:  0.20, hi:  0.39, p1:   3, p2:   3, p3:   3, p3r:   9 },
    { lo:  0.40, hi:  0.59, p1:   3, p2:   6, p3:   1, p3r:  10 },
    { lo:  0.60, hi: null,  p1:   7, p2:  13, p3:   2, p3r:  22 },
  ],
  5: [
    { lo: null,  hi: -0.80, p1:  -2, p2:  -1, p3:  -8, p3r: -10 },
    { lo: -0.79, hi: -0.60, p1:  -3, p2:  -6, p3:  -5, p3r: -13 },
    { lo: -0.59, hi: -0.40, p1:  -2, p2:  -4, p3:  -3, p3r: -10 },
    { lo: -0.39, hi: -0.20, p1:  -2, p2:  -1, p3:  -1, p3r:  -4 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2:  -3, p3:   2, p3r:  -2 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:   3, p3:  -1, p3r:   2 },
    { lo:  0.20, hi:  0.39, p1:   1, p2:   2, p3:   4, p3r:   6 },
    { lo:  0.40, hi:  0.59, p1:   8, p2:  12, p3:   2, p3r:  22 },
    { lo:  0.60, hi: null,  p1:  12, p2:   1, p3:  10, p3r:  22 },
  ],
  6: [
    { lo: null,  hi: -1.00, p1:  -1, p2:  -4, p3:  -6, p3r: -11 },
    { lo: -0.99, hi: -0.80, p1:   0, p2:  -2, p3:  -6, p3r:  -9 },
    { lo: -0.79, hi: -0.60, p1:  -1, p2:  -5, p3:  -4, p3r: -10 },
    { lo: -0.59, hi: -0.40, p1:  -1, p2:  -2, p3:  -5, p3r:  -7 },
    { lo: -0.39, hi: -0.20, p1:   0, p2:   1, p3:  -2, p3r:   0 },
    { lo: -0.19, hi:  0.00, p1:   1, p2:   0, p3:   1, p3r:   2 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:  -1, p3:   3, p3r:   2 },
    { lo:  0.20, hi:  0.39, p1:   0, p2:   2, p3:   1, p3r:   3 },
    { lo:  0.40, hi: null,  p1:   0, p2:   5, p3:   6, p3r:  11 },
  ],
};

// 蒲郡補正テーブルを引いて行を返す（線形補間版）
function _gamagoriTableLookup(boat, diff) {
  const rows = GAMAGORI_TENJI_TABLE[boat];
  if (!rows) return null;
  const d = Math.round(diff * 100) / 100;
  return _interpolateTenjiTable(rows, d);
}

// [2026-07-12 追加] 三国 展示補正テーブル（1周+回り足+展示 合算diff → 各着補正率）
// diff = 6艇平均合算 - 各艇合算（速い艇→プラス、遅い艇→マイナス）
// 住之江と同じ構成（回り足を含む・直線は含まない）
// 出所: 外部提供データ（住之江/常滑/蒲郡と同一ソース）
const MIKUNI_TENJI_TABLE = {
  1: [
    { lo: null,  hi: -0.40, p1: -18, p2:  5, p3:  2, p3r: -11 },
    { lo: -0.40, hi: -0.20, p1: -18, p2:  5, p3:  0, p3r: -13 },
    { lo: -0.19, hi:  0.00, p1:  -4, p2:  0, p3:  1, p3r:  -4 },
    { lo:  0.01, hi:  0.19, p1:  -2, p2:  0, p3: -1, p3r:  -2 },
    { lo:  0.20, hi:  0.39, p1:   0, p2:  1, p3:  2, p3r:   2 },
    { lo:  0.40, hi:  0.59, p1:   7, p2: -1, p3: -1, p3r:   4 },
    { lo:  0.60, hi:  0.79, p1:  13, p2: -4, p3:  0, p3r:   9 },
    { lo:  0.80, hi: null,  p1:  14, p2: -3, p3: -2, p3r:   9 },
  ],
  2: [
    { lo: null,  hi: -0.60, p1:  -8, p2: -3, p3: -3, p3r: -14 },
    { lo: -0.59, hi: -0.40, p1:  -3, p2: -4, p3: -5, p3r: -12 },
    { lo: -0.39, hi: -0.20, p1:  -5, p2: -1, p3: -1, p3r:  -8 },
    { lo: -0.19, hi:  0.00, p1:  -3, p2: -2, p3:  0, p3r:  -5 },
    { lo:  0.01, hi:  0.19, p1:  -1, p2:  0, p3:  2, p3r:   1 },
    { lo:  0.20, hi:  0.39, p1:   2, p2:  2, p3:  1, p3r:   5 },
    { lo:  0.40, hi:  0.59, p1:   8, p2:  0, p3:  0, p3r:   8 },
    { lo:  0.60, hi:  0.79, p1:   4, p2:  7, p3:  2, p3r:  13 },
    { lo:  0.80, hi: null,  p1:  13, p2:  8, p3: -4, p3r:  17 },
  ],
  3: [
    { lo: null,  hi: -0.80, p1:  -7, p2: -6, p3: -2, p3r: -16 },
    { lo: -0.80, hi: -0.60, p1:  -4, p2:-10, p3: -5, p3r: -19 },
    { lo: -0.59, hi: -0.40, p1:  -7, p2:  0, p3: -6, p3r: -12 },
    { lo: -0.39, hi: -0.20, p1:  -6, p2: -1, p3:  2, p3r:  -5 },
    { lo: -0.19, hi:  0.00, p1:   1, p2: -4, p3:  0, p3r:  -2 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:  1, p3:  1, p3r:   2 },
    { lo:  0.20, hi:  0.39, p1:   4, p2:  5, p3:  1, p3r:  11 },
    { lo:  0.40, hi:  0.59, p1:   6, p2:  5, p3: -1, p3r:  10 },
    { lo:  0.60, hi: null,  p1:  15, p2:  4, p3:  2, p3r:  22 },
  ],
  4: [
    { lo: null,  hi: -0.80, p1:  -2, p2: -7, p3: -8, p3r: -17 },
    { lo: -0.80, hi: -0.60, p1:  -2, p2: -6, p3: -4, p3r: -13 },
    { lo: -0.59, hi: -0.40, p1:  -3, p2:-10, p3: -1, p3r: -14 },
    { lo: -0.39, hi: -0.20, p1:  -1, p2: -1, p3: -1, p3r:  -2 },
    { lo: -0.19, hi:  0.00, p1:   0, p2:  0, p3:  1, p3r:   1 },
    { lo:  0.01, hi:  0.19, p1:   1, p2:  1, p3:  0, p3r:   2 },
    { lo:  0.20, hi:  0.39, p1:   2, p2:  6, p3:  3, p3r:  10 },
    { lo:  0.40, hi:  0.59, p1:   2, p2:  6, p3:  7, p3r:  15 },
    { lo:  0.60, hi: null,  p1:   6, p2: 23, p3: -3, p3r:  26 },
  ],
  5: [
    { lo: null,  hi: -0.80, p1:   0, p2: -6, p3:-10, p3r: -16 },
    { lo: -0.80, hi: -0.60, p1:  -1, p2: -5, p3: -5, p3r: -11 },
    { lo: -0.59, hi: -0.40, p1:  -2, p2: -1, p3:  1, p3r:  -2 },
    { lo: -0.39, hi: -0.20, p1:   0, p2: -1, p3: -2, p3r:  -3 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2: -3, p3:  2, p3r:  -3 },
    { lo:  0.01, hi:  0.19, p1:   2, p2:  2, p3:  1, p3r:   4 },
    { lo:  0.20, hi:  0.39, p1:   1, p2:  3, p3:  2, p3r:   7 },
    { lo:  0.40, hi:  0.60, p1:   1, p2:  7, p3:  2, p3r:  10 },
    { lo:  0.60, hi: null,  p1:   3, p2: 14, p3:  8, p3r:  25 },
  ],
  6: [
    { lo: null,  hi: -0.80, p1:  -1, p2: -3, p3: -5, p3r:  -9 },
    { lo: -0.80, hi: -0.60, p1:  -1, p2: -2, p3: -4, p3r:  -6 },
    { lo: -0.59, hi: -0.40, p1:   0, p2: -1, p3: -4, p3r:  -5 },
    { lo: -0.39, hi: -0.20, p1:   1, p2: -2, p3:  0, p3r:  -1 },
    { lo: -0.19, hi:  0.00, p1:   1, p2:  0, p3: -1, p3r:  -1 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:  2, p3:  3, p3r:   4 },
    { lo:  0.20, hi:  0.39, p1:   0, p2:  0, p3:  3, p3r:   2 },
    { lo:  0.40, hi:  0.60, p1:   0, p2:  6, p3:  9, p3r:  15 },
    { lo:  0.60, hi: null,  p1:   6, p2:  5, p3:  5, p3r:  16 },
  ],
};

// 三国補正テーブルを引いて行を返す（線形補間版）
function _mikuniTableLookup(boat, diff) {
  const rows = MIKUNI_TENJI_TABLE[boat];
  if (!rows) return null;
  const d = Math.round(diff * 100) / 100;
  return _interpolateTenjiTable(rows, d);
}

// [2026-07-12 追加] 鳴門 展示補正テーブル（1周+直線+展示 合算diff → 各着補正率）
// diff = 6艇平均合算 - 各艇合算（速い艇→プラス、遅い艇→マイナス）
// 蒲郡と同じ構成（直線を含む・回り足は含まない）
// 出所: 外部提供データ（住之江/常滑/蒲郡/三国と同一ソース）
// [補正] 6号艇の7行目は元データで「0.2〜0.39」と直上行と範囲重複していたため、
// 数値の連続性（1着率2%→5%等の単調増加パターン）から「0.4〜0.59」の誤記と判断し補正済み。
const NARUTO_TENJI_TABLE = {
  1: [
    { lo: null,  hi: -0.20, p1: -16, p2:  0, p3:  1, p3r: -15 },
    { lo: -0.19, hi:  0.00, p1:  -9, p2:  1, p3:  2, p3r:  -6 },
    { lo:  0.01, hi:  0.19, p1:  -7, p2:  1, p3:  3, p3r:  -3 },
    { lo:  0.20, hi:  0.39, p1:  -1, p2:  0, p3:  0, p3r:  -1 },
    { lo:  0.40, hi:  0.59, p1:   4, p2:  0, p3: -1, p3r:   3 },
    { lo:  0.60, hi:  0.79, p1:  12, p2: -3, p3: -3, p3r:   6 },
    { lo:  0.80, hi: null,  p1:  15, p2: -1, p3: -4, p3r:  10 },
  ],
  2: [
    { lo: null,  hi: -0.60, p1:  -5, p2:-10, p3: -3, p3r: -18 },
    { lo: -0.59, hi: -0.40, p1:  -7, p2: -7, p3: -1, p3r: -15 },
    { lo: -0.39, hi: -0.20, p1:  -5, p2: -3, p3:  0, p3r:  -8 },
    { lo: -0.19, hi:  0.00, p1:  -2, p2: -1, p3:  1, p3r:  -2 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:  1, p3: -1, p3r:   0 },
    { lo:  0.20, hi:  0.39, p1:   3, p2:  3, p3:  1, p3r:   7 },
    { lo:  0.40, hi:  0.59, p1:   7, p2:  3, p3:  0, p3r:  10 },
    { lo:  0.60, hi: null,  p1:  10, p2:  5, p3:  1, p3r:  15 },
  ],
  3: [
    { lo: null,  hi: -0.60, p1:  -9, p2: -3, p3:  0, p3r: -11 },
    { lo: -0.59, hi: -0.40, p1:  -3, p2: -3, p3: -3, p3r: -10 },
    { lo: -0.39, hi: -0.20, p1:  -3, p2: -1, p3: -1, p3r:  -6 },
    { lo: -0.19, hi:  0.00, p1:  -2, p2: -1, p3:  0, p3r:  -2 },
    { lo:  0.01, hi:  0.19, p1:   2, p2:  1, p3:  1, p3r:   5 },
    { lo:  0.20, hi:  0.39, p1:   4, p2:  2, p3:  1, p3r:   7 },
    { lo:  0.40, hi:  0.59, p1:   5, p2:  6, p3:  1, p3r:  11 },
    { lo:  0.60, hi: null,  p1:  14, p2:  2, p3: -1, p3r:  15 },
  ],
  4: [
    { lo: null,  hi: -0.60, p1:  -4, p2: -5, p3: -7, p3r: -15 },
    { lo: -0.59, hi: -0.40, p1:  -5, p2: -4, p3: -1, p3r: -10 },
    { lo: -0.39, hi: -0.20, p1:  -2, p2: -2, p3: -1, p3r:  -5 },
    { lo: -0.19, hi:  0.00, p1:   0, p2:  0, p3:  0, p3r:  -1 },
    { lo:  0.01, hi:  0.19, p1:   1, p2:  1, p3:  1, p3r:   4 },
    { lo:  0.20, hi:  0.39, p1:   3, p2:  3, p3:  2, p3r:   8 },
    { lo:  0.40, hi:  0.59, p1:   6, p2:  6, p3:  4, p3r:  16 },
    { lo:  0.60, hi: null,  p1:  14, p2:  9, p3:  0, p3r:  22 },
  ],
  5: [
    { lo: null,  hi: -0.60, p1:  -2, p2: -4, p3: -6, p3r: -12 },
    { lo: -0.59, hi: -0.40, p1:  -2, p2: -3, p3: -1, p3r:  -6 },
    { lo: -0.39, hi: -0.20, p1:  -1, p2: -1, p3:  0, p3r:  -3 },
    { lo: -0.19, hi:  0.00, p1:   0, p2:  0, p3:  1, p3r:   0 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:  0, p3:  1, p3r:   1 },
    { lo:  0.20, hi:  0.39, p1:   2, p2:  5, p3:  1, p3r:   8 },
    { lo:  0.40, hi:  0.59, p1:   5, p2:  6, p3:  3, p3r:  14 },
    { lo:  0.60, hi: null,  p1:   8, p2:  5, p3:  1, p3r:  12 },
  ],
  6: [
    { lo: null,  hi: -0.60, p1:  -1, p2: -4, p3: -6, p3r: -10 },
    { lo: -0.59, hi: -0.40, p1:  -1, p2: -1, p3: -4, p3r:  -7 },
    { lo: -0.39, hi: -0.20, p1:   0, p2: -1, p3: -2, p3r:  -3 },
    { lo: -0.19, hi:  0.00, p1:   0, p2: -1, p3: -1, p3r:  -1 },
    { lo:  0.01, hi:  0.19, p1:   0, p2:  1, p3:  4, p3r:   4 },
    { lo:  0.20, hi:  0.39, p1:   1, p2:  4, p3:  2, p3r:   7 },
    { lo:  0.40, hi:  0.59, p1:   2, p2:  5, p3:  7, p3r:  14 },  // [補正] 元データ「0.2〜0.39」を誤記と判断し訂正
    { lo:  0.60, hi: null,  p1:   3, p2:  5, p3: 12, p3r:  20 },
  ],
};

// 鳴門補正テーブルを引いて行を返す（線形補間版）
function _narutoTableLookup(boat, diff) {
  const rows = NARUTO_TENJI_TABLE[boat];
  if (!rows) return null;
  const d = Math.round(diff * 100) / 100;
  return _interpolateTenjiTable(rows, d);
}

// [2026-07-12 追加] 多摩川 展示補正テーブル（1周+直線+展示 合算diff → 各着補正率）
// diff = 6艇平均合算 - 各艇合算（速い艇→プラス、遅い艇→マイナス）
// 蒲郡・鳴門と同じ構成（直線を含む・回り足は含まない）
// 出所: 外部提供データ（住之江/常滑/蒲郡/三国/鳴門と同一ソース）
const TAMAGAWA_TENJI_TABLE = {
  1: [
    { lo: null,  hi: -0.40, p1: -26, p2:  7, p3: -1, p3r: -21 },
    { lo: -0.40, hi: -0.20, p1: -12, p2: -9, p3:  0, p3r: -21 },
    { lo: -0.19, hi:  0.00, p1: -11, p2:  2, p3:  0, p3r:  -9 },
    { lo:  0.01, hi:  0.19, p1:  -6, p2:  1, p3:  1, p3r:  -4 },
    { lo:  0.20, hi:  0.39, p1:  -2, p2: -1, p3:  1, p3r:  -2 },
    { lo:  0.40, hi:  0.59, p1:   0, p2:  1, p3:  2, p3r:   2 },
    { lo:  0.60, hi:  0.79, p1:   5, p2:  1, p3: -2, p3r:   4 },
    { lo:  0.80, hi:  0.99, p1:   8, p2:  2, p3: -1, p3r:   9 },
    { lo:  1.00, hi: null,  p1:  19, p2: -7, p3: -3, p3r:   9 },
  ],
  2: [
    { lo: null,  hi: -0.60, p1:  -7, p2:-13, p3: -5, p3r: -25 },
    { lo: -0.59, hi: -0.40, p1: -10, p2: -2, p3:  2, p3r: -10 },
    { lo: -0.39, hi: -0.20, p1:  -6, p2: -2, p3:  2, p3r:  -6 },
    { lo: -0.19, hi:  0.00, p1:  -4, p2: -6, p3:  1, p3r:  -8 },
    { lo:  0.01, hi:  0.19, p1:  -1, p2:  2, p3:  0, p3r:   1 },
    { lo:  0.20, hi:  0.39, p1:   4, p2:  4, p3: -3, p3r:   5 },
    { lo:  0.40, hi:  0.59, p1:   5, p2:  5, p3:  1, p3r:  11 },
    { lo:  0.60, hi:  0.79, p1:  12, p2:  5, p3:  2, p3r:  19 },
    { lo:  0.80, hi: null,  p1:  23, p2: -4, p3:  2, p3r:  20 },
  ],
  3: [
    { lo: null,  hi: -0.60, p1:  -5, p2: -6, p3: -7, p3r: -18 },
    { lo: -0.59, hi: -0.40, p1:  -6, p2: -1, p3: -1, p3r:  -8 },
    { lo: -0.39, hi: -0.20, p1:   0, p2: -7, p3:  1, p3r:  -6 },
    { lo: -0.19, hi:  0.00, p1:  -2, p2:  0, p3:  1, p3r:  -1 },
    { lo:  0.01, hi:  0.19, p1:   2, p2:  2, p3: -1, p3r:   3 },
    { lo:  0.20, hi:  0.39, p1:  -1, p2:  5, p3:  5, p3r:   9 },
    { lo:  0.40, hi:  0.59, p1:   9, p2:  8, p3: -3, p3r:  15 },
    { lo:  0.60, hi: null,  p1:  19, p2:  8, p3: -2, p3r:  25 },
  ],
  4: [
    { lo: null,  hi: -0.60, p1:  -8, p2: -6, p3: -4, p3r: -18 },
    { lo: -0.59, hi: -0.40, p1:  -5, p2: -4, p3: -2, p3r: -11 },
    { lo: -0.39, hi: -0.20, p1:  -3, p2:  0, p3:  0, p3r:  -3 },
    { lo: -0.19, hi:  0.00, p1:   1, p2: -1, p3: -1, p3r:  -1 },
    { lo:  0.01, hi:  0.19, p1:   2, p2:  2, p3:  3, p3r:   7 },
    { lo:  0.20, hi:  0.39, p1:   7, p2:  5, p3: -1, p3r:  12 },
    { lo:  0.40, hi:  0.59, p1:   3, p2:  6, p3:  4, p3r:  14 },
    { lo:  0.60, hi: null,  p1:  22, p2:  5, p3:  5, p3r:  33 },
  ],
  5: [
    { lo: null,  hi: -0.80, p1:  -3, p2: -4, p3: -5, p3r: -12 },
    { lo: -0.80, hi: -0.60, p1:  -3, p2: -4, p3: -6, p3r: -14 },
    { lo: -0.59, hi: -0.40, p1:  -4, p2: -3, p3: -7, p3r: -14 },
    { lo: -0.39, hi: -0.20, p1:  -1, p2: -1, p3: -3, p3r:  -5 },
    { lo: -0.19, hi:  0.00, p1:   0, p2:  1, p3:  1, p3r:   1 },
    { lo:  0.01, hi:  0.19, p1:   2, p2:  3, p3:  4, p3r:   9 },
    { lo:  0.20, hi:  0.39, p1:   2, p2:  4, p3:  6, p3r:  12 },
    { lo:  0.40, hi:  0.60, p1:   4, p2:  2, p3:  9, p3r:  14 },
    { lo:  0.60, hi: null,  p1:  16, p2:  3, p3:  4, p3r:  23 },
  ],
  6: [
    { lo: null,  hi: -1.00, p1:  -2, p2: -4, p3:-12, p3r: -18 },
    { lo: -1.00, hi: -0.80, p1:  -1, p2: -3, p3: -7, p3r: -11 },
    { lo: -0.80, hi: -0.60, p1:   0, p2: -4, p3: -5, p3r: -10 },
    { lo: -0.59, hi: -0.40, p1:  -1, p2: -1, p3: -4, p3r:  -7 },
    { lo: -0.39, hi: -0.20, p1:  -1, p2: -1, p3: -2, p3r:  -4 },
    { lo: -0.19, hi:  0.00, p1:  -1, p2:  0, p3:  0, p3r:   0 },
    { lo:  0.01, hi:  0.19, p1:   1, p2:  2, p3:  4, p3r:   7 },
    { lo:  0.20, hi:  0.39, p1:   2, p2:  1, p3:  6, p3r:   9 },
    { lo:  0.40, hi:  0.60, p1:   0, p2:  4, p3: 10, p3r:  14 },
    { lo:  0.60, hi: null,  p1:   7, p2: 13, p3:  5, p3r:  25 },
  ],
};

// 多摩川補正テーブルを引いて行を返す（線形補間版）
function _tamagawaTableLookup(boat, diff) {
  const rows = TAMAGAWA_TENJI_TABLE[boat];
  if (!rows) return null;
  const d = Math.round(diff * 100) / 100;
  return _interpolateTenjiTable(rows, d);
}
