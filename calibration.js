// calibration.js — 確率推定キャリブレーション（完全外付けモジュール）
//
// 【設計方針】
//   既存コード（backtest.js / top_stats.js）への変更はゼロ。
//   collectResultsForDateScen(d, true) が返す results[] を受け取るだけ。
//   必要なフィールド: hitProbEst (number|null), isHit (boolean)
//
// 【使い方】
//   _renderHistory30 の elHistory.innerHTML 代入の直前に1行追加するだけ:
//
//     _renderCalibrationPanel(allResultsScenAll);   // ← これだけ追加
//     elHistory.innerHTML = `...`;                  // 既存行はそのまま
//
//   描画先 DOM は自動生成。id="top-ai-calibration-panel" が存在しない場合は
//   top-ai-stats-history-summary の直後に自動挿入する。
//
// ─────────────────────────────────────────────────────────────────────

(function () {

  // admin 判定は呼び出し時に毎回 classList で確認する（即時評価を廃止）
  // ※ init()（SHA-256認証）が async のため、スクリプト読み込み時点では
  //   admin-mode クラスがまだ付与されていない場合がある。

  // ── CSV保存機能用: 直近の描画に使った results 配列を保持 ──
  // _renderCalibrationPanel が呼ばれるたびに更新される。
  // ボタンの onclick からはこの変数経由でアクセスする（引数を持たせず
  // 常に「今表示中のパネルの元データ」を書き出せるようにするため）。
  let _lastAllResults = [];

  // ── ビン定義 ──
  // hitProbEst の値域 [0, 1] を6段階に分割
  const BINS = [
    { label: '0–10%',  min: 0.00, max: 0.10 },
    { label: '10–20%', min: 0.10, max: 0.20 },
    { label: '20–30%', min: 0.20, max: 0.30 },
    { label: '30–40%', min: 0.30, max: 0.40 },
    { label: '40–60%', min: 0.40, max: 0.60 },
    { label: '60%+',   min: 0.60, max: 1.01 },
  ];

  // ── メイン集計関数 ──
  // results[]: collectResultsForDateScen(d, true) の返り値を30日分結合したもの
  // 戻り値: ビン別統計の配列
  function calcCalibration(results) {
    const valid = results.filter(r => r.hitProbEst != null);

    return BINS.map(bin => {
      const inBin   = valid.filter(r => r.hitProbEst >= bin.min && r.hitProbEst < bin.max);
      const total   = inBin.length;
      const hits    = inBin.filter(r => r.isHit).length;
      const actual  = total > 0 ? hits / total : null;
      const estAvg  = total > 0
        ? inBin.reduce((s, r) => s + r.hitProbEst, 0) / total
        : null;
      return { label: bin.label, total, hits, actual, estAvg };
    });
  }

  // ── キャリブレーション品質スコア ──
  // 各ビンの |推定 − 実績| を加重平均（サンプル数重み）
  // 0に近いほど良い。0.05以下なら優秀、0.10超は要見直し
  function calcCalibrationError(binStats) {
    const valid = binStats.filter(b => b.total > 0 && b.actual != null && b.estAvg != null);
    if (valid.length === 0) return null;
    const totalN  = valid.reduce((s, b) => s + b.total, 0);
    const wErr    = valid.reduce((s, b) => s + Math.abs(b.estAvg - b.actual) * b.total, 0);
    return wErr / totalN;
  }

  // ── 単調性チェック ──
  // 推定値が上がるほど実際の的中率も上がっているか（理想的な予測モデルの条件）
  // 有効ビン間で「逆転」が何回起きているかを返す
  function countMonotonicViolations(binStats) {
    const valid = binStats.filter(b => b.total >= 10 && b.actual != null); // 修正: N<10は参考値のため単調性チェックから除外
    let violations = 0;
    for (let i = 1; i < valid.length; i++) {
      if (valid[i].actual < valid[i - 1].actual - 0.02) violations++;
    }
    return violations;
  }

  // ══════════════════════════════════════════════════════════════════
  // 2着 calibration
  // ──────────────────────────────────────────────────────────────────
  // results[] の各レースで「実際の2着枠番が予測リストの何位だったか」を集計する。
  // pred2ndRank: top_stats.js の collectResultsForDateScen が付与するフィールド。
  //   1 = 買い目中で最多出現の2着枠番と一致（予測1位的中）
  //   2 = 2番目に多い2着枠番と一致
  //   null = 買い目に実際の2着枠番が含まれていない or データなし
  function calcPlace2Calibration(results) {
    const valid = results.filter(r => r.pred2ndRank != null || r.actual2nd != null);
    const total = valid.length;
    if (total === 0) return null;
    const rank1 = valid.filter(r => r.pred2ndRank === 1).length;
    const top2  = valid.filter(r => r.pred2ndRank != null && r.pred2ndRank <= 2).length;
    const top3  = valid.filter(r => r.pred2ndRank != null && r.pred2ndRank <= 3).length;
    const miss  = valid.filter(r => r.pred2ndRank == null).length;
    return { rank1Rate: rank1/total, top2Rate: top2/total, top3Rate: top3/total, missRate: miss/total, total };
  }

  // ══════════════════════════════════════════════════════════════════
  // 3着 calibration
  // ──────────────────────────────────────────────────────────────────
  // pred3rdRank と同様の集計。3着は選択肢が多い（4〜5枠番）ため
  // top3Rate が実用上の下限目標になる。
  function calcPlace3Calibration(results) {
    const valid = results.filter(r => r.pred3rdRank != null || r.actual3rd != null);
    const total = valid.length;
    if (total === 0) return null;
    const rank1 = valid.filter(r => r.pred3rdRank === 1).length;
    const top2  = valid.filter(r => r.pred3rdRank != null && r.pred3rdRank <= 2).length;
    const top3  = valid.filter(r => r.pred3rdRank != null && r.pred3rdRank <= 3).length;
    const miss  = valid.filter(r => r.pred3rdRank == null).length;
    return { rank1Rate: rank1/total, top2Rate: top2/total, top3Rate: top3/total, missRate: miss/total, total };
  }

  // ── 2着・3着 calibration HTML生成 ──
  function buildPlace2CalibHTML(p2, p3) {
    function barRow(label, rate, threshGood, threshWarn, note) {
      if (rate == null) return '';
      const pct   = (rate * 100).toFixed(0) + '%';
      const color = rate >= threshGood ? 'var(--green)'
                  : rate >= threshWarn ? 'var(--orange)'
                  : 'var(--red, #e05)';
      const w     = Math.round(rate * 120);
      return `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:3px 6px;font-size:10px;color:var(--text3);white-space:nowrap">${label}</td>
          <td style="padding:3px 6px;min-width:96px">
            <div style="height:14px;background:var(--bg2);border-radius:2px;overflow:hidden">
              <div style="height:100%;width:${w}px;background:${color};border-radius:2px;opacity:0.85"></div>
            </div>
          </td>
          <td style="padding:3px 6px;text-align:right;font-size:11px;font-weight:700;color:${color}">${pct}</td>
          <td style="padding:3px 6px;font-size:9px;color:var(--text3)">${note}</td>
        </tr>`;
    }
    const p2Section = p2 ? `
      <div style="font-size:10px;font-weight:700;color:var(--text3);margin:6px 0 2px">2着予測精度（${p2.total}件）</div>
      <table style="width:100%;border-collapse:collapse"><tbody>
        ${barRow('1位的中', p2.rank1Rate, 0.50, 0.35, '目標50%+')}
        ${barRow('2位以内', p2.top2Rate,  0.70, 0.55, '目標70%+')}
        ${barRow('3位以内', p2.top3Rate,  0.85, 0.70, '目標85%+')}
        ${barRow('買い目外', p2.missRate, 0,    0.15, '低いほど良')}
      </tbody></table>` : '<div style="font-size:10px;color:var(--text3);padding:4px 0">2着データ不足</div>';
    const p3Section = p3 ? `
      <div style="font-size:10px;font-weight:700;color:var(--text3);margin:8px 0 2px">3着予測精度（${p3.total}件）</div>
      <table style="width:100%;border-collapse:collapse"><tbody>
        ${barRow('1位的中', p3.rank1Rate, 0.40, 0.28, '目標40%+')}
        ${barRow('2位以内', p3.top2Rate,  0.60, 0.45, '目標60%+')}
        ${barRow('3位以内', p3.top3Rate,  0.75, 0.60, '目標75%+')}
        ${barRow('買い目外', p3.missRate, 0,    0.25, '低いほど良')}
      </tbody></table>` : '<div style="font-size:10px;color:var(--text3);padding:4px 0">3着データ不足</div>';
    const p2ok  = p2 && p2.rank1Rate >= 0.50;
    const p3ok  = p3 && p3.top3Rate  >= 0.75;
    const judge = (!p2 && !p3)   ? null
                : (p2ok && p3ok) ? { text: '2着・3着ともに良好',       color: 'var(--green)'      }
                : (!p2ok&&!p3ok) ? { text: '2着・3着とも要改善',       color: 'var(--red, #e05)'  }
                : p2ok           ? { text: '2着良好・3着は要確認',     color: 'var(--orange)'     }
                :                  { text: '2着要改善・3着は許容範囲', color: 'var(--orange)'     };
    return `
      <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)">
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-align:center;margin-bottom:2px">📊 2着・3着 予測精度</div>
        <div style="font-size:10px;color:var(--text3);text-align:center;margin-bottom:6px">買い目内での的中順位分布</div>
        ${judge ? `<div style="font-size:11px;font-weight:700;color:${judge.color};text-align:center;margin-bottom:6px;padding:3px 0;border-bottom:1px solid var(--border)">${judge.text}</div>` : ''}
        <div style="overflow-x:auto">${p2Section}${p3Section}</div>
        <div style="font-size:9px;color:var(--text3);margin-top:5px">
          予測順位=買い目中の枠番出現頻度で判定　買い目外=実際の着順枠が買い目に含まれていなかった割合
        </div>
      </div>`;
  }

  // ── HTML生成 ──
  function buildCalibrationHTML(binStats, calError, violations, totalValid) {
    if (totalValid < 30) {
      return `
        <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)">
          <div style="font-size:10px;font-weight:700;color:var(--text3);text-align:center;margin-bottom:4px">📐 確率キャリブレーション</div>
          <div style="color:var(--text3);font-size:11px;text-align:center;padding:0.3rem 0">
            データ不足（${totalValid}件）<br>30件以上で表示
          </div>
        </div>`;
    }

    // 品質判定
    const errLabel  = calError == null   ? '—'
                    : calError <= 0.05   ? '優秀'
                    : calError <= 0.10   ? '良好'
                    : calError <= 0.15   ? '要注意'
                    : '問題あり';
    const errColor  = calError == null   ? 'var(--text3)'
                    : calError <= 0.05   ? 'var(--green)'
                    : calError <= 0.10   ? 'var(--green)'
                    : calError <= 0.15   ? 'var(--orange)'
                    : 'var(--red, #e05)';
    const errStr    = calError != null ? `${(calError * 100).toFixed(1)}%誤差・${errLabel}` : '—';

    const monLabel  = violations === 0 ? '✓ 単調増加（理想的）'
                    : violations === 1 ? `△ 軽微な逆転あり（${violations}箇所）`
                    : `✗ 逆転${violations}箇所（要確認）`;
    const monColor  = violations === 0 ? 'var(--green)'
                    : violations === 1 ? 'var(--orange)'
                    : 'var(--red, #e05)';

    // バーチャート行
    const maxBar = 120; // px
    const rows = binStats.map(b => {
      if (b.total === 0) {
        return `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:3px 6px;font-size:10px;color:var(--text3);white-space:nowrap">${b.label}</td>
            <td colspan="4" style="padding:3px 6px;font-size:10px;color:var(--text3);text-align:center">—</td>
          </tr>`;
      }
      const estPct    = b.estAvg  != null ? (b.estAvg  * 100).toFixed(0) + '%' : '—';
      const actPct    = b.actual  != null ? (b.actual  * 100).toFixed(0) + '%' : '—';
      const actWidth  = b.actual  != null ? Math.round(b.actual  * maxBar) : 0;
      const estWidth  = b.estAvg  != null ? Math.round(b.estAvg  * maxBar) : 0;
      const diff      = (b.actual != null && b.estAvg != null) ? b.actual - b.estAvg : null;
      const diffStr   = diff != null
        ? (diff >= 0 ? `+${(diff*100).toFixed(0)}` : `${(diff*100).toFixed(0)}`) + '%'
        : '—';
      const diffColor = diff == null       ? 'var(--text3)'
                      : Math.abs(diff) <= 0.05 ? 'var(--green)'
                      : Math.abs(diff) <= 0.10 ? 'var(--orange)'
                      : 'var(--red, #e05)';
      const lowN = b.total < 10;

      return `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:4px 6px;font-size:10px;color:var(--text3);white-space:nowrap">${b.label}</td>
          <td style="padding:4px 6px;min-width:90px">
            <div style="position:relative;height:14px;background:var(--bg2);border-radius:2px;overflow:hidden">
              <div style="position:absolute;left:0;top:0;height:100%;width:${estWidth}px;background:var(--border);border-radius:2px;opacity:0.6"></div>
              <div style="position:absolute;left:0;top:0;height:100%;width:${actWidth}px;background:${actWidth >= estWidth ? 'var(--green)' : 'var(--orange)'};border-radius:2px;opacity:0.85"></div>
            </div>
          </td>
          <td style="padding:4px 6px;text-align:right;font-size:10px;color:var(--text3)">${estPct}</td>
          <td style="padding:4px 6px;text-align:right;font-size:11px;font-weight:700;color:var(--text${lowN ? '3' : ''})">${actPct}${lowN ? '<span style="font-size:9px;color:var(--text3)">*</span>' : ''}</td>
          <td style="padding:4px 6px;text-align:right;font-size:10px;font-weight:700;color:${diffColor}">${diffStr}</td>
        </tr>`;
    }).join('');

    return `
      <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)">
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-align:center;margin-bottom:2px">📐 確率キャリブレーション</div>
        <div style="font-size:10px;color:var(--text3);text-align:center;margin-bottom:8px">推定勝率 vs 実績勝率（全艇×全レース　${totalValid}件）</div>

        <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:3px">
            <span style="font-size:10px;color:var(--text3)">加重平均誤差</span>
            <span style="font-size:11px;font-weight:700;color:${errColor}">${errStr}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:10px;color:var(--text3)">単調性</span>
            <span style="font-size:10px;font-weight:700;color:${monColor}">${monLabel}</span>
          </div>
        </div>

        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid var(--border)">
                <th style="padding:3px 6px;text-align:left;font-size:9px;color:var(--text3);font-weight:500">推定帯</th>
                <th style="padding:3px 6px;text-align:left;font-size:9px;color:var(--text3);font-weight:500">バー</th>
                <th style="padding:3px 6px;text-align:right;font-size:9px;color:var(--text3);font-weight:500">推定</th>
                <th style="padding:3px 6px;text-align:right;font-size:9px;color:var(--text3);font-weight:500">実績</th>
                <th style="padding:3px 6px;text-align:right;font-size:9px;color:var(--text3);font-weight:500">差</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div style="font-size:9px;color:var(--text3);margin-top:4px">
          灰バー=推定、色バー=実績　* N&lt;10の参考値
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // コース別 勝率キャリブレーション（本物版）
  // ──────────────────────────────────────────────────────────────────
  // 各レースの全艇 boatProbs（final_prob）を展開し、
  // 「モデルが各枠番に与えた予測勝率の平均」vs「実際の勝率」を比較する。
  //
  // 集計単位: 艇（boat）× レース
  //   - 推定: boatProbs[boat] = その艇の final_prob（モデル予測勝率）
  //   - 実績: actualResult の1着枠番が boat と一致するか（0 or 1）
  //
  // これにより「1コースをモデルが過小評価しているか」が正確にわかる。
  // ══════════════════════════════════════════════════════════════════
  // ── boatProbs 取得のフォールバック ──
  // 上流オブジェクトのフィールド名・形式がブレているケースに対応する。
  //   名前ブレ:  boatProbs / finalProbs / winProbs / probs / boatProbsRaw
  //   形式ブレ:  { "1": 0.3, ... } / { 1: 0.3, ... } / [b0..b5] (0始まり配列)
  //             / [{boat:1, prob:0.3}, ...] (オブジェクト配列)
  function _getBoatProb(r, course) {
    const candidates = [r.boatProbs, r.finalProbs, r.winProbs, r.probs, r.boatProbsRaw];
    for (const bp of candidates) {
      if (bp == null) continue;
      // オブジェクト配列 [{boat, prob}] 形式
      if (Array.isArray(bp) && bp.length && typeof bp[0] === 'object' && bp[0] !== null) {
        const hit = bp.find(b => Number(b.boat ?? b.course ?? b.frame) === course);
        const v = hit && (hit.prob ?? hit.winProb ?? hit.est);
        if (v != null) return Number(v);
        continue;
      }
      // 数値配列（0始まり or 1始まりの両方を試す）
      if (Array.isArray(bp)) {
        if (bp[course] != null) return Number(bp[course]);       // 1始まり想定
        if (bp[course - 1] != null) return Number(bp[course - 1]); // 0始まり想定
        continue;
      }
      // プレーンオブジェクト（キーが数値/文字列どちらでも bp[course] でヒットする）
      if (bp[course] != null) return Number(bp[course]);
      if (bp[String(course)] != null) return Number(bp[String(course)]);
    }
    return null;
  }

  // ── actualResult から1着枠番を取得するフォールバック ──
  //   名前ブレ:  actualResult（"1-2-3"等の文字列） / actual1st / winnerCourse / result
  //   形式ブレ:  文字列(区切り文字違い) / 配列 [1,2,3] / 数値そのもの
  function _getWinnerCourse(r) {
    const cands = [r.actual1st, r.winnerCourse, r.actualResult, r.result];
    for (const v of cands) {
      if (v == null) continue;
      if (typeof v === 'number') return v;
      if (Array.isArray(v)) return parseInt(v[0], 10);
      const n = parseInt((v + '').trim().split(/[-－−,\s]/)[0], 10);
      if (!Number.isNaN(n)) return n;
    }
    return null;
  }

  function calcCalibrationByCourse(results) {
    const courses = [1, 2, 3, 4, 5, 6];

    // 各コース（枠番）ごとに全レースの boatProbs を展開して集計
    const stats = courses.map(course => {
      let sumEst   = 0;  // 予測勝率の合計
      let sumAct   = 0;  // 実際に勝った回数
      let count    = 0;  // boatProbs にデータがあった艇×レース数

      results.forEach(r => {
        const est = _getBoatProb(r, course);
        if (est == null) return; // このレースにデータなし

        const winner = _getWinnerCourse(r);
        if (winner == null) return;

        sumEst += est;
        sumAct += (winner === course ? 1 : 0);
        count++;
      });

      const estAvg = count > 0 ? sumEst / count : null; // 平均予測勝率
      const actual = count > 0 ? sumAct / count : null; // 実際の勝率

      return { course, count, estAvg, actual };
    });

    // ── 診断ログ：全コースで count === 0 のとき、原因特定のため実データ形状を出力 ──
    if (stats.every(s => s.count === 0) && results.length > 0) {
      const sample = results.find(r => r) || {};
      console.warn(
        '[calibration] コース別キャリブレーション: 全コースで0件。\n' +
        'boatProbs系フィールドまたは勝者情報の取得に失敗しています。サンプルのキー一覧:',
        Object.keys(sample),
        '\nboatProbs候補の値:', {
          boatProbs: sample.boatProbs, finalProbs: sample.finalProbs,
          winProbs: sample.winProbs, probs: sample.probs, boatProbsRaw: sample.boatProbsRaw,
        },
        '\n勝者情報候補の値:', {
          actual1st: sample.actual1st, winnerCourse: sample.winnerCourse,
          actualResult: sample.actualResult, result: sample.result,
        }
      );
    }

    return stats;
  }

  // ══════════════════════════════════════════════════════════════════
  // 確率帯別 勝率キャリブレーション（左パネル「📐 確率キャリブレーション」用）
  // ──────────────────────────────────────────────────────────────────
  // [2026-06-23 修正] 旧実装は results を hitProbEst（レース単位・買い目の
  //   合成的中確率）でビン分けしていた。hitProbEst は1レースにつき1値しか
  //   存在しないため母数は最大 totalAll 件（≒996件）で、特に低確率帯は
  //   サンプルが極端に少なく（N<10常態化）、実用に耐えないグラフになっていた。
  //
  //   「確率キャリブレーション」として本来見たいのは
  //     「モデルが各艇に与えた勝率予測 vs 実際にその艇が勝てたか」
  //   であり、これは calcCalibrationByCourse と同じ集計単位
  //   （艇 × レース）を使えば、最大 totalAll × 6 件まで母数を増やせる。
  //   → boatProbs を全艇展開し、コースで束ねる代わりに確率帯（BINS）で束ね直す。
  //
  // 【重要】この関数の戻り値は表示専用。
  //   updateCalibPoints()（hitProbEst の自己補正テーブル CALIB_POINTS 更新）には
  //   引き続き calcCalibration() の結果（hitProbEst集計）を渡すこと。
  //   CALIB_POINTS は「買い目合成確率(hitProbEst)」を補正するためのテーブルで、
  //   computeScenCombosWithEV.js の ev = synthOdds × calibrateProb(rawHitProbEst)
  //   に直結している。ここで艇単位の勝率集計を混ぜて渡すと、無関係な統計量で
  //   hitProbEst の補正テーブルが歪み、EV計算全体が壊れるため絶対に混在させない。
  function calcWinProbCalibration(results) {
    const courses = [1, 2, 3, 4, 5, 6];
    const binned = BINS.map(bin => ({
      label: bin.label, min: bin.min, max: bin.max,
      total: 0, hits: 0, sumEst: 0,
    }));

    (results || []).forEach(r => {
      const winner = _getWinnerCourse(r);
      if (winner == null) return;
      courses.forEach(course => {
        const est = _getBoatProb(r, course);
        if (est == null) return;
        const bin = binned.find(b => est >= b.min && est < b.max);
        if (!bin) return; // 値域外（負値や1.01以上など想定外データ）は無視
        bin.total++;
        bin.sumEst += est;
        if (winner === course) bin.hits++;
      });
    });

    return binned.map(b => ({
      label  : b.label,
      total  : b.total,
      hits   : b.hits,
      actual : b.total > 0 ? b.hits / b.total : null,
      estAvg : b.total > 0 ? b.sumEst / b.total : null,
    }));
  }

  // ══════════════════════════════════════════════════════════════════
  // [2026-07-03 追加] 2〜6号艇 コース別×確率帯別 勝率キャリブレーション
  // ──────────────────────────────────────────────────────────────────
  // calcCalibrationByCourse はコースごとに単一の平均値しか出さないため、
  // computeScenCombosWithEV.js の updateCourseOtherCalibPoints に渡す
  // 「帯ごとの実測」を作れない。calcWinProbCalibration と同じ BINS を
  // コース別に束ね直し、{ 2: [...], 3: [...], ..., 6: [...] } を返す。
  // コース1は既存の calibrateCourse1Prob/updateCourse1CalibPoints が
  // 単一点方式で担当しているため、ここでは対象外（2〜6号艇のみ）。
  function calcWinProbCalibrationByCourse(results) {
    const courses = [2, 3, 4, 5, 6];
    const out = {};

    courses.forEach(course => {
      const binned = BINS.map(bin => ({
        label: bin.label, min: bin.min, max: bin.max,
        total: 0, hits: 0, sumEst: 0,
      }));

      (results || []).forEach(r => {
        const winner = _getWinnerCourse(r);
        if (winner == null) return;
        const est = _getBoatProb(r, course);
        if (est == null) return;
        const bin = binned.find(b => est >= b.min && est < b.max);
        if (!bin) return;
        bin.total++;
        bin.sumEst += est;
        if (winner === course) bin.hits++;
      });

      out[course] = binned.map(b => ({
        label  : b.label,
        count  : b.total,
        hits   : b.hits,
        actual : b.total > 0 ? b.hits / b.total : null,
        estAvg : b.total > 0 ? b.sumEst / b.total : null,
      }));
    });

    return out;
  }

  // コース別勝率キャリブレーション HTML生成
  function buildCoursCalibHTML(courseStats, totalAll) {
    const maxBar = 100; // px（バーの最大幅px）
    const maxProb = 0.7; // バーのスケール最大値（70%で満幅）
    const courseBg   = ['','#d8d8d8','#333','#e33','#36c','#fa0','#2a9'];
    const courseText = ['','#333','#fff','#fff','#fff','#333','#fff'];

    const rows = courseStats.map(s => {
      if (s.count === 0) {
        return `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:4px 6px;white-space:nowrap">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:${courseBg[s.course]};color:${courseText[s.course]};font-size:10px;font-weight:700">${s.course}</span>
            </td>
            <td colspan="4" style="padding:4px 6px;font-size:10px;color:var(--text3);text-align:center">—</td>
          </tr>`;
      }

      const actPct  = s.actual  != null ? (s.actual  * 100).toFixed(1) + '%' : '—';
      const estPct  = s.estAvg  != null ? (s.estAvg  * 100).toFixed(1) + '%' : '—';
      const actWidth = s.actual  != null ? Math.round(Math.min(s.actual  / maxProb, 1) * maxBar) : 0;
      const estWidth = s.estAvg  != null ? Math.round(Math.min(s.estAvg  / maxProb, 1) * maxBar) : 0;
      const diff    = (s.actual != null && s.estAvg != null) ? s.actual - s.estAvg : null;
      const diffStr = diff != null
        ? (diff >= 0 ? '+' : '') + (diff * 100).toFixed(1) + '%'
        : '—';
      const diffColor = diff == null           ? 'var(--text3)'
                      : Math.abs(diff) <= 0.03  ? 'var(--green)'
                      : Math.abs(diff) <= 0.07  ? 'var(--orange)'
                      : 'var(--red,#e05)';
      const lowN = s.count < 50;
      // 実績 > 推定なら過小評価（緑）、実績 < 推定なら過大評価（橙）
      const barColor = (diff == null || Math.abs(diff) < 0.01) ? 'var(--green)'
                     : diff > 0 ? 'var(--green)' : 'var(--orange)';

      return `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:4px 6px;white-space:nowrap">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:${courseBg[s.course]};color:${courseText[s.course]};font-size:10px;font-weight:700">${s.course}</span>
            <span style="font-size:9px;color:var(--text3);margin-left:2px">${s.count}R</span>
          </td>
          <td style="padding:4px 6px;min-width:${maxBar}px">
            <div style="position:relative;height:14px;background:var(--bg2);border-radius:2px;overflow:hidden">
              <div style="position:absolute;left:0;top:0;height:100%;width:${estWidth}px;background:var(--border);border-radius:2px;opacity:0.7"></div>
              <div style="position:absolute;left:0;top:0;height:100%;width:${actWidth}px;background:${barColor};border-radius:2px;opacity:0.85"></div>
            </div>
          </td>
          <td style="padding:4px 6px;text-align:right;font-size:10px;color:var(--text3)">${estPct}</td>
          <td style="padding:4px 6px;text-align:right;font-size:11px;font-weight:700;color:var(--text)">${actPct}${lowN ? '<span style="font-size:9px;color:var(--text3)">*</span>' : ''}</td>
          <td style="padding:4px 6px;text-align:right;font-size:10px;font-weight:700;color:${diffColor}">${diffStr}</td>
        </tr>`;
    }).join('');

    return `
      <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)">
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-align:center;margin-bottom:2px">🚤 コース別 勝率キャリブレーション</div>
        <div style="font-size:10px;color:var(--text3);text-align:center;margin-bottom:8px">枠番別 予測勝率 vs 実際の勝率（計${totalAll}件）</div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid var(--border)">
                <th style="padding:3px 6px;text-align:left;font-size:9px;color:var(--text3);font-weight:500">枠</th>
                <th style="padding:3px 6px;text-align:left;font-size:9px;color:var(--text3);font-weight:500">バー</th>
                <th style="padding:3px 6px;text-align:right;font-size:9px;color:var(--text3);font-weight:500">推定</th>
                <th style="padding:3px 6px;text-align:right;font-size:9px;color:var(--text3);font-weight:500">実績</th>
                <th style="padding:3px 6px;text-align:right;font-size:9px;color:var(--text3);font-weight:500">差</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div style="font-size:9px;color:var(--text3);margin-top:4px">
          灰バー=推定勝率、色バー=実勝率　緑=過小評価、橙=過大評価　* N&lt;50の参考値
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // 30〜40%帯 過大評価 内訳調査パネル（管理者専用）
  // ──────────────────────────────────────────────────────────────────
  function buildOverestimateAnalysisHTML(results) {
    // 30〜40%帯のレースだけ抽出
    const band = results.filter(r => r.hitProbEst != null && r.hitProbEst >= 0.30 && r.hitProbEst < 0.40);
    if (band.length === 0) return '';

    // ── 会場別集計 ──
    const venueMap = {};
    band.forEach(r => {
      const v = r.venue || '不明';
      if (!venueMap[v]) venueMap[v] = { total: 0, hits: 0 };
      venueMap[v].total++;
      if (r.isHit) venueMap[v].hits++;
    });
    const venueRows = Object.entries(venueMap)
      .map(([v, s]) => ({ venue: v, ...s, actual: s.hits / s.total }))
      .sort((a, b) => a.actual - b.actual); // 的中率低い順

    // ── レース番号別集計 ──
    const rnoMap = {};
    band.forEach(r => {
      const rno = r.rno != null ? `${r.rno}R` : '不明';
      if (!rnoMap[rno]) rnoMap[rno] = { total: 0, hits: 0 };
      rnoMap[rno].total++;
      if (r.isHit) rnoMap[rno].hits++;
    });
    const rnoRows = Object.entries(rnoMap)
      .map(([rno, s]) => ({ rno, ...s, actual: s.hits / s.total }))
      .sort((a, b) => {
        const na = parseInt(a.rno); const nb = parseInt(b.rno);
        return na - nb;
      });

    // ── EV帯別集計（synth × hitProbEst）──
    const evMap = { '〜0.9': { total:0,hits:0 }, '0.9〜1.0': { total:0,hits:0 }, '1.0〜1.1': { total:0,hits:0 }, '1.1〜1.3': { total:0,hits:0 }, '1.3〜': { total:0,hits:0 } };
    band.forEach(r => {
      const ev = r.ev;
      if (ev == null) return;
      const key = ev < 0.9 ? '〜0.9' : ev < 1.0 ? '0.9〜1.0' : ev < 1.1 ? '1.0〜1.1' : ev < 1.3 ? '1.1〜1.3' : '1.3〜';
      evMap[key].total++;
      if (r.isHit) evMap[key].hits++;
    });

    const totalBand = band.length;
    const hitsBand  = band.filter(r => r.isHit).length;
    const actBand   = hitsBand / totalBand;

    // ── 会場テーブル HTML ──
    const vHtml = venueRows.map(s => {
      const pct = (s.actual * 100).toFixed(0) + '%';
      const color = s.actual < 0.25 ? 'var(--red,#e05)' : s.actual < 0.35 ? 'var(--orange)' : 'var(--green)';
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:3px 5px;font-size:10px">${s.venue}</td>
        <td style="padding:3px 5px;font-size:10px;text-align:right;color:var(--text3)">${s.total}件</td>
        <td style="padding:3px 5px;font-size:10px;text-align:right;font-weight:700;color:${color}">${pct}</td>
      </tr>`;
    }).join('');

    // ── レース番号テーブル HTML ──
    const rHtml = rnoRows.map(s => {
      const pct = (s.actual * 100).toFixed(0) + '%';
      const color = s.actual < 0.25 ? 'var(--red,#e05)' : s.actual < 0.35 ? 'var(--orange)' : 'var(--green)';
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:3px 5px;font-size:10px">${s.rno}</td>
        <td style="padding:3px 5px;font-size:10px;text-align:right;color:var(--text3)">${s.total}件</td>
        <td style="padding:3px 5px;font-size:10px;text-align:right;font-weight:700;color:${color}">${pct}</td>
      </tr>`;
    }).join('');

    // ── EV帯テーブル HTML ──
    const eHtml = Object.entries(evMap).map(([key, s]) => {
      if (s.total === 0) return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:3px 5px;font-size:10px">EV${key}</td>
        <td colspan="2" style="padding:3px 5px;font-size:10px;text-align:center;color:var(--text3)">—</td>
      </tr>`;
      const pct = (s.hits / s.total * 100).toFixed(0) + '%';
      const color = (s.hits/s.total) < 0.25 ? 'var(--red,#e05)' : (s.hits/s.total) < 0.35 ? 'var(--orange)' : 'var(--green)';
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:3px 5px;font-size:10px">EV${key}</td>
        <td style="padding:3px 5px;font-size:10px;text-align:right;color:var(--text3)">${s.total}件</td>
        <td style="padding:3px 5px;font-size:10px;text-align:right;font-weight:700;color:${color}">${pct}</td>
      </tr>`;
    }).join('');

    const thStyle = `padding:3px 5px;text-align:left;font-size:9px;color:var(--text3);font-weight:500;border-bottom:1px solid var(--border)`;
    const mkTable = (title, rows) => `
      <div>
        <div style="font-size:10px;font-weight:700;color:var(--text3);margin-bottom:4px">${title}</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="${thStyle}">区分</th>
            <th style="${thStyle};text-align:right">件数</th>
            <th style="${thStyle};text-align:right">実績</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    return `
      <div class="admin-only" style="margin-top:8px">
        <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--orange,#f80)">
          <div style="font-size:10px;font-weight:700;color:var(--orange,#f80);text-align:center;margin-bottom:2px">
            🔍 30〜40%帯 過大評価 内訳調査
          </div>
          <div style="font-size:10px;color:var(--text3);text-align:center;margin-bottom:8px">
            推定30〜40%の${totalBand}件 → 実績的中率 <strong style="color:${actBand < 0.30 ? 'var(--red,#e05)' : 'var(--orange)'}">${(actBand*100).toFixed(1)}%</strong>（目標35%）
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
            ${mkTable('会場別', vHtml)}
            ${mkTable('レース番号別', rHtml)}
            ${mkTable('EV帯別', eHtml)}
          </div>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // 2着・3着 データvs買い目 切り分け診断（管理者専用）
  // ──────────────────────────────────────────────────────────────────
  // 「予測が機能していない」原因を切り分ける：
  //   データが悪い → 1位予測と2位予測の的中率がほぼ同率（識別力なし）
  //   買い目が悪い → 1位予測の的中率が低く、かつ2位以下に偏っている
  // ──────────────────────────────────────────────────────────────────
  function buildDiagnosisHTML(results) {
    const valid2 = results.filter(r => r.actual2nd != null && r.pred2ndRank != null);
    const valid3 = results.filter(r => r.actual3rd != null && r.pred3rdRank != null);
    if (valid2.length === 0 && valid3.length === 0) return '';

    // ── 予測順位分布（2着・3着）──
    function rankDist(arr, rankField) {
      const dist = {};
      arr.forEach(r => {
        const k = r[rankField] <= 4 ? r[rankField] : 5; // 5位以下まとめ
        dist[k] = (dist[k] ?? 0) + 1;
      });
      return dist;
    }
    const dist2 = rankDist(valid2, 'pred2ndRank');
    const dist3 = rankDist(valid3, 'pred3rdRank');
    const total2 = valid2.length;
    const total3 = valid3.length;

    // ── 識別力スコア（1位と2位の差）──
    // 差が大きいほど予測が機能している
    // 差が小さい（≤5%）→ データが悪い可能性大
    const r2_1 = (dist2[1] ?? 0) / total2;
    const r2_2 = (dist2[2] ?? 0) / total2;
    const r3_1 = (dist3[1] ?? 0) / total3;
    const r3_2 = (dist3[2] ?? 0) / total3;
    const disc2 = r2_1 - r2_2; // 識別力（2着）
    const disc3 = r3_1 - r3_2; // 識別力（3着）

    // ── 診断判定 ──
    function diagnose(disc, rank1, name) {
      if (disc >= 0.08) return { verdict: `✅ ${name}予測は機能している`, color: 'var(--green)',   detail: `1位と2位に${(disc*100).toFixed(0)}%差あり` };
      if (disc >= 0.03) return { verdict: `🟡 ${name}予測は弱い識別力`,   color: 'var(--orange)', detail: `1位と2位の差が${(disc*100).toFixed(0)}%のみ` };
      return                   { verdict: `🔴 ${name}予測は機能していない`, color: 'var(--red,#e05)', detail: `1位と2位がほぼ同率 → データ品質を疑う` };
    }
    const diag2 = diagnose(disc2, r2_1, '2着');
    const diag3 = diagnose(disc3, r3_1, '3着');

    // ── 1着コース別の2着1位的中率 ──
    // 逃げ（1着=1枠）とそれ以外で分けて見る
    function courseGroup(r) {
      if (!r.actualResult) return null;
      const first = parseInt((r.actualResult + '').split(/[-－−]/)[0]);
      return first === 1 ? '1コース(逃げ系)' : `${first}コース`;
    }
    const byWinner2 = {};
    valid2.forEach(r => {
      const g = courseGroup(r);
      if (!g) return;
      if (!byWinner2[g]) byWinner2[g] = { total: 0, rank1: 0 };
      byWinner2[g].total++;
      if (r.pred2ndRank === 1) byWinner2[g].rank1++;
    });
    const courseRows2 = Object.entries(byWinner2)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 6)
      .map(([g, s]) => {
        const rate = s.rank1 / s.total;
        const color = rate >= 0.40 ? 'var(--green)' : rate >= 0.28 ? 'var(--orange)' : 'var(--red,#e05)';
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:3px 5px;font-size:10px">${g}</td>
          <td style="padding:3px 5px;font-size:10px;text-align:right;color:var(--text3)">${s.total}件</td>
          <td style="padding:3px 5px;font-size:10px;text-align:right;font-weight:700;color:${color}">${(rate*100).toFixed(0)}%</td>
        </tr>`;
      }).join('');

    // ── レース番号別の2着1位的中率 ──
    const byRno2 = {};
    valid2.forEach(r => {
      const g = r.rno != null ? `${r.rno}R` : null;
      if (!g) return;
      if (!byRno2[g]) byRno2[g] = { total: 0, rank1: 0, rno: r.rno };
      byRno2[g].total++;
      if (r.pred2ndRank === 1) byRno2[g].rank1++;
    });
    const rnoRows2 = Object.entries(byRno2)
      .sort((a, b) => a[1].rno - b[1].rno)
      .map(([g, s]) => {
        const rate = s.rank1 / s.total;
        const color = rate >= 0.40 ? 'var(--green)' : rate >= 0.28 ? 'var(--orange)' : 'var(--red,#e05)';
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:3px 5px;font-size:10px">${g}</td>
          <td style="padding:3px 5px;font-size:10px;text-align:right;color:var(--text3)">${s.total}件</td>
          <td style="padding:3px 5px;font-size:10px;text-align:right;font-weight:700;color:${color}">${(rate*100).toFixed(0)}%</td>
        </tr>`;
      }).join('');

    // ── 予測順位分布バー ──
    function distBars(dist, total, maxRank) {
      return Array.from({ length: maxRank }, (_, i) => i + 1).map(rank => {
        const label = rank === maxRank ? `${rank}位以下` : `${rank}位`;
        const cnt   = dist[rank] ?? 0;
        const rate  = cnt / total;
        const w     = Math.round(rate * 100);
        const color = rank === 1 ? 'var(--green)' : rank === 2 ? 'var(--orange)' : 'var(--text3)';
        return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          <span style="font-size:9px;color:var(--text3);width:36px;flex-shrink:0">${label}</span>
          <div style="flex:1;height:10px;background:var(--bg2);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${w}%;background:${color};opacity:0.8;border-radius:2px"></div>
          </div>
          <span style="font-size:9px;font-weight:700;color:${color};width:28px;text-align:right">${(rate*100).toFixed(0)}%</span>
        </div>`;
      }).join('');
    }

    const thStyle = `padding:3px 5px;text-align:left;font-size:9px;color:var(--text3);font-weight:500;border-bottom:1px solid var(--border)`;

    return `
      <div class="admin-only" style="margin-top:8px">
        <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)">
          <div style="font-size:10px;font-weight:700;color:var(--text3);text-align:center;margin-bottom:8px">
            🔬 2着・3着 データvs買い目 切り分け診断
          </div>

          <!-- 診断サマリー -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
            <div style="background:var(--bg2);border-radius:4px;padding:8px;border-left:3px solid ${diag2.color}">
              <div style="font-size:10px;font-weight:700;color:${diag2.color};margin-bottom:2px">${diag2.verdict}</div>
              <div style="font-size:9px;color:var(--text3)">${diag2.detail}</div>
            </div>
            <div style="background:var(--bg2);border-radius:4px;padding:8px;border-left:3px solid ${diag3.color}">
              <div style="font-size:10px;font-weight:700;color:${diag3.color};margin-bottom:2px">${diag3.verdict}</div>
              <div style="font-size:9px;color:var(--text3)">${diag3.detail}</div>
            </div>
          </div>

          <!-- 予測順位分布 -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
            <div>
              <div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:4px">2着 予測順位分布（${total2}件）</div>
              ${distBars(dist2, total2, 5)}
            </div>
            <div>
              <div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:4px">3着 予測順位分布（${total3}件）</div>
              ${distBars(dist3, total3, 5)}
            </div>
          </div>

          <!-- 1着コース別・レース番号別 -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:4px">1着コース別 2着1位的中率</div>
              <table style="width:100%;border-collapse:collapse">
                <thead><tr>
                  <th style="${thStyle}">1着</th>
                  <th style="${thStyle};text-align:right">件数</th>
                  <th style="${thStyle};text-align:right">的中率</th>
                </tr></thead>
                <tbody>${courseRows2}</tbody>
              </table>
            </div>
            <div>
              <div style="font-size:9px;font-weight:700;color:var(--text3);margin-bottom:4px">レース番号別 2着1位的中率</div>
              <table style="width:100%;border-collapse:collapse">
                <thead><tr>
                  <th style="${thStyle}">R</th>
                  <th style="${thStyle};text-align:right">件数</th>
                  <th style="${thStyle};text-align:right">的中率</th>
                </tr></thead>
                <tbody>${rnoRows2}</tbody>
              </table>
            </div>
          </div>

          <div style="font-size:9px;color:var(--text3);margin-top:6px">
            識別力=1位と2位の的中率の差。差が小さい→データ品質の問題。差が大きく1位が低い→買い目ロジックの問題。
          </div>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // CSV保存機能
  // ──────────────────────────────────────────────────────────────────
  // 5パネル（確率キャリブレーション／2着・3着予測精度／コース別勝率／
  // 30〜40%帯過大評価内訳／2着・3着診断）の集計結果を1本のCSVにまとめて
  // ダウンロードする。既存の calc*() 関数をそのまま再利用し、表示用HTMLとは
  // 独立に「今パネルに表示されている数値」と同じ集計をもう一度計算する。
  // ══════════════════════════════════════════════════════════════════

  function _csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function _csvRow(arr) {
    return arr.map(_csvEscape).join(',');
  }
  function _pctStr(v) {
    return v == null ? '' : (v * 100).toFixed(1) + '%';
  }

  function _buildCalibrationCSV(all) {
    const lines = [];
    const push = (row) => lines.push(_csvRow(row));
    const blank = () => lines.push('');
    const section = (title) => { blank(); push([title]); };

    // ── ① 確率キャリブレーション（艇×レース、winProbBinStats）──
    const winProbBinStats = calcWinProbCalibration(all);
    const calError   = calcCalibrationError(winProbBinStats);
    const violations = countMonotonicViolations(winProbBinStats);
    section('① 確率キャリブレーション（推定勝率 vs 実績勝率・全艇×全レース）');
    push(['加重平均誤差', calError != null ? _pctStr(calError) : '']);
    push(['単調性逆転数', violations]);
    push(['推定帯', '件数', '推定平均', '実績', '差']);
    winProbBinStats.forEach(b => {
      const diff = (b.actual != null && b.estAvg != null) ? b.actual - b.estAvg : null;
      push([b.label, b.total, _pctStr(b.estAvg), _pctStr(b.actual), diff != null ? _pctStr(diff) : '']);
    });

    // ── ② 2着・3着 予測精度 ──
    const p2 = calcPlace2Calibration(all);
    const p3 = calcPlace3Calibration(all);
    section('② 2着・3着 予測精度（買い目内での的中順位分布）');
    push(['区分', '2着', '3着']);
    push(['件数', p2 ? p2.total : '', p3 ? p3.total : '']);
    push(['1位的中', p2 ? _pctStr(p2.rank1Rate) : '', p3 ? _pctStr(p3.rank1Rate) : '']);
    push(['2位以内', p2 ? _pctStr(p2.top2Rate)  : '', p3 ? _pctStr(p3.top2Rate)  : '']);
    push(['3位以内', p2 ? _pctStr(p2.top3Rate)  : '', p3 ? _pctStr(p3.top3Rate)  : '']);
    push(['買い目外', p2 ? _pctStr(p2.missRate) : '', p3 ? _pctStr(p3.missRate) : '']);

    // ── ③ コース別勝率キャリブレーション ──
    const courseStats = calcCalibrationByCourse(all);
    section('③ コース別 勝率キャリブレーション（枠番別 予測勝率 vs 実際の勝率）');
    push(['枠', '件数', '推定', '実績', '差']);
    courseStats.forEach(s => {
      const diff = (s.actual != null && s.estAvg != null) ? s.actual - s.estAvg : null;
      push([s.course, s.count, _pctStr(s.estAvg), _pctStr(s.actual), diff != null ? _pctStr(diff) : '']);
    });

    // ── ④ 30〜40%帯 過大評価 内訳調査 ──
    const band = all.filter(r => r.hitProbEst != null && r.hitProbEst >= 0.30 && r.hitProbEst < 0.40);
    if (band.length > 0) {
      const totalBand = band.length;
      const hitsBand  = band.filter(r => r.isHit).length;

      const venueMap = {};
      band.forEach(r => {
        const v = r.venue || '不明';
        if (!venueMap[v]) venueMap[v] = { total: 0, hits: 0 };
        venueMap[v].total++;
        if (r.isHit) venueMap[v].hits++;
      });
      const rnoMap = {};
      band.forEach(r => {
        const rno = r.rno != null ? `${r.rno}R` : '不明';
        if (!rnoMap[rno]) rnoMap[rno] = { total: 0, hits: 0 };
        rnoMap[rno].total++;
        if (r.isHit) rnoMap[rno].hits++;
      });
      const evMap = { '〜0.9': { total:0,hits:0 }, '0.9〜1.0': { total:0,hits:0 }, '1.0〜1.1': { total:0,hits:0 }, '1.1〜1.3': { total:0,hits:0 }, '1.3〜': { total:0,hits:0 } };
      band.forEach(r => {
        if (r.ev == null) return;
        const key = r.ev < 0.9 ? '〜0.9' : r.ev < 1.0 ? '0.9〜1.0' : r.ev < 1.1 ? '1.0〜1.1' : r.ev < 1.3 ? '1.1〜1.3' : '1.3〜';
        evMap[key].total++;
        if (r.isHit) evMap[key].hits++;
      });

      section('④ 30〜40%帯 過大評価 内訳調査');
      push(['推定30〜40%の件数', totalBand, '実績的中率', _pctStr(hitsBand / totalBand), '目標', '35%']);
      blank();
      push(['会場別', '件数', '実績']);
      Object.entries(venueMap)
        .map(([v, s]) => ({ venue: v, ...s, actual: s.hits / s.total }))
        .sort((a, b) => a.actual - b.actual)
        .forEach(s => push([s.venue, s.total, _pctStr(s.actual)]));
      blank();
      push(['レース番号別', '件数', '実績']);
      Object.entries(rnoMap)
        .map(([rno, s]) => ({ rno, ...s, actual: s.hits / s.total }))
        .sort((a, b) => parseInt(a.rno) - parseInt(b.rno))
        .forEach(s => push([s.rno, s.total, _pctStr(s.actual)]));
      blank();
      push(['EV帯別', '件数', '実績']);
      Object.entries(evMap).forEach(([key, s]) => {
        push([`EV${key}`, s.total, s.total > 0 ? _pctStr(s.hits / s.total) : '—']);
      });
    }

    // ── ⑤ 2着・3着 データvs買い目 切り分け診断 ──
    const valid2 = all.filter(r => r.actual2nd != null && r.pred2ndRank != null);
    const valid3 = all.filter(r => r.actual3rd != null && r.pred3rdRank != null);
    if (valid2.length > 0 || valid3.length > 0) {
      section('⑤ 2着・3着 データvs買い目 切り分け診断');

      function rankDist(arr, rankField) {
        const dist = {};
        arr.forEach(r => {
          const k = r[rankField] <= 4 ? r[rankField] : 5;
          dist[k] = (dist[k] ?? 0) + 1;
        });
        return dist;
      }
      const dist2 = rankDist(valid2, 'pred2ndRank');
      const dist3 = rankDist(valid3, 'pred3rdRank');
      const total2 = valid2.length;
      const total3 = valid3.length;

      push(['予測順位分布', '順位', '2着件数', '2着割合', '3着件数', '3着割合']);
      [1, 2, 3, 4, 5].forEach(rank => {
        const label = rank === 5 ? '5位以下' : `${rank}位`;
        const c2 = dist2[rank] ?? 0;
        const c3 = dist3[rank] ?? 0;
        push(['', label, total2 ? c2 : '', total2 ? _pctStr(c2 / total2) : '',
                          total3 ? c3 : '', total3 ? _pctStr(c3 / total3) : '']);
      });

      // 1着コース別 2着1位的中率
      function courseGroup(r) {
        if (!r.actualResult) return null;
        const first = parseInt((r.actualResult + '').split(/[-－−]/)[0]);
        return first === 1 ? '1コース(逃げ系)' : `${first}コース`;
      }
      const byWinner2 = {};
      valid2.forEach(r => {
        const g = courseGroup(r);
        if (!g) return;
        if (!byWinner2[g]) byWinner2[g] = { total: 0, rank1: 0 };
        byWinner2[g].total++;
        if (r.pred2ndRank === 1) byWinner2[g].rank1++;
      });
      blank();
      push(['1着コース別 2着1位的中率', '件数', '的中率']);
      Object.entries(byWinner2)
        .sort((a, b) => b[1].total - a[1].total)
        .forEach(([g, s]) => push([g, s.total, _pctStr(s.rank1 / s.total)]));

      // レース番号別 2着1位的中率
      const byRno2 = {};
      valid2.forEach(r => {
        const g = r.rno != null ? `${r.rno}R` : null;
        if (!g) return;
        if (!byRno2[g]) byRno2[g] = { total: 0, rank1: 0, rno: r.rno };
        byRno2[g].total++;
        if (r.pred2ndRank === 1) byRno2[g].rank1++;
      });
      blank();
      push(['レース番号別 2着1位的中率', '件数', '的中率']);
      Object.entries(byRno2)
        .sort((a, b) => a[1].rno - b[1].rno)
        .forEach(([g, s]) => push([g, s.total, _pctStr(s.rank1 / s.total)]));
    }

    return '\uFEFF' + lines.join('\r\n'); // BOM付き（Excelで文字化けしないように）
  }

  // ── 公開: CSVダウンロードを実行 ──
  // ボタンから window._downloadCalibrationCSV() として呼ばれる。
  // 引数なし＝常に「直近に描画したパネルのデータ」を書き出す。
  window._downloadCalibrationCSV = function () {
    try {
      if (!_lastAllResults || _lastAllResults.length === 0) {
        alert('CSV化できるデータがありません（パネル未描画、または集計中です）');
        return;
      }
      const csv  = _buildCalibrationCSV(_lastAllResults);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const now  = new Date();
      const pad  = n => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `calibration_${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn('[calibration] CSV出力エラー:', e);
      alert('CSV出力に失敗しました: ' + e.message);
    }
  };

  // ── 公開: 補正テーブルをJSONダウンロード ──
  // ボタンから window._downloadCalibPointsJSON() として呼ばれる。
  // ダウンロードした calib_points.json を scripts/data/ 直下に置くと、
  // auto_push.py が次回push時に data/*.json を自動でgit addするため、
  // 特別な対応なしに配布される（DATA_DIR.glob("*.json") で拾われる）。
  //
  // 【これで解決すること】
  //   CALIB_POINTS 等はこれまで各端末の localStorage で独立に学習され、
  //   admin の複数端末間・premiumユーザー間で「独自補正 最終確率」が
  //   食い違う原因になっていた。この JSON を data/ に配布し、
  //   computeScenCombosWithEV.js 側が起動時に fetch して全端末に同一の
  //   テーブルを適用することで、最終確率が常に同じ値になる。
  window._downloadCalibPointsJSON = function () {
    try {
      const missing = [];
      if (typeof window.CALIB_POINTS === 'undefined') missing.push('CALIB_POINTS');
      if (typeof window.COURSE1_CALIB_POINTS === 'undefined') missing.push('COURSE1_CALIB_POINTS');
      if (typeof window.COURSE_OTHER_CALIB_POINTS === 'undefined') missing.push('COURSE_OTHER_CALIB_POINTS');
      if (missing.length > 0) {
        alert(`補正テーブルが読み込まれていません: ${missing.join(', ')}\ncomputeScenCombosWithEV.js が正しく読み込まれているか確認してください。`);
        return;
      }
      const payload = {
        CALIB_POINTS: window.CALIB_POINTS,
        COURSE1_CALIB_POINTS: window.COURSE1_CALIB_POINTS,
        COURSE_OTHER_CALIB_POINTS: window.COURSE_OTHER_CALIB_POINTS,
        updatedAt: new Date().toISOString(),
      };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'calib_points.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      alert('calib_points.json をダウンロードしました。\nscripts/data/ フォルダに上書き保存すると、次回のpushで全端末に配布されます。');
    } catch (e) {
      console.warn('[calibration] calib_points.json 出力エラー:', e);
      alert('JSON出力に失敗しました: ' + e.message);
    }
  };

  // ── DOM への描画 ──
  function _ensureContainer() {
    let el = document.getElementById('top-ai-calibration-panel');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'top-ai-calibration-panel';
    const ref = document.getElementById('top-ai-stats-history-summary');
    if (ref && ref.parentNode) {
      ref.parentNode.insertBefore(el, ref.nextSibling);
    } else {
      document.body.appendChild(el);
    }
    return el;
  }

  // ── 公開関数（これだけ既存コードから呼ぶ）──
  // 関数は常に定義する。admin でない場合は中でスキップするだけ。
  window._renderCalibrationPanel = function (allResultsScenAll) {
    const _diagAll   = (allResultsScenAll || []).length;
    const _diagValid = (allResultsScenAll || []).filter(r => r.hitProbEst != null).length;

    // ── [修正] admin-mode タイミング問題への対処 ──
    // init()（SHA-256認証）は async のため、defer スクリプト完了後も
    // admin-mode クラスが body に付いていないことがある。
    // → 未付与の場合は最大3秒間ポーリングし、付与され次第データを引き継いで再実行。
    if (!document.body.classList.contains('admin-mode')) {
      let _retryCount = 0;
      const _retryId = setInterval(function () {
        _retryCount++;
        if (document.body.classList.contains('admin-mode')) {
          clearInterval(_retryId);
          window._renderCalibrationPanel(allResultsScenAll);
        } else if (_retryCount >= 30) { // 100ms × 30 = 3秒でタイムアウト
          clearInterval(_retryId);
        }
      }, 100);
      return;
    }
    try {
      const container = _ensureContainer();
      const all       = allResultsScenAll || [];
      const totalAll  = all.length;
      _lastAllResults = all; // CSV保存ボタン用に保持

      // 修正: allResultsScenAll が [] のまま呼ばれたとき（非同期計算完了前）は
      // 「集計中」表示にしてデータ不足と区別する
      if (totalAll === 0) {
        container.innerHTML = `
          <div class="ai-stats-card" style="margin-bottom:0.6rem">
            <div style="display:grid;grid-template-columns:1fr;gap:10px">
              <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)">
                <div style="font-size:10px;font-weight:700;color:var(--text3);text-align:center;margin-bottom:4px">📐 確率キャリブレーション</div>
                <div style="color:var(--text3);font-size:11px;text-align:center;padding:0.3rem 0">集計中...</div>
              </div>
            </div>
          </div>`;
        return;
      }

      // ―― ① 補正テーブル更新には「生の推定値」を使用する ――
      // [2026-06-20 修正] 二重補正による自己崩壊ループ対策。
      //   旧実装は all（= computeScenCombosWithEV 側で既に calibrateProb() 済みの
      //   hitProbEst を持つ配列）を「生データ」のつもりで binStatsRaw に集計し、
      //   それを updateCalibPoints に渡していた。
      //   → 補正テーブルが「自分自身が補正した後の値」を学習材料にしてしまい、
      //     更新を繰り返すほど補正が増幅される自己崩壊ループに陥っていた。
      //   computeScenCombosWithEV.js 側で補正前の値を r._rawHitProbEst に
      //   保持するよう修正したため、ここではそれを使う（無ければ hitProbEst で代替）。
      const allRaw = all.map(r => {
        const raw = (r._rawHitProbEst != null) ? r._rawHitProbEst : r.hitProbEst;
        return (raw === r.hitProbEst) ? r : Object.assign({}, r, { hitProbEst: raw });
      });
      const binStatsRaw = calcCalibration(allRaw);
      if (typeof updateCalibPoints === 'function') updateCalibPoints(binStatsRaw);

      // ―― ② パネル表示用の集計 ――
      // [2026-06-23 修正] 表示には calcWinProbCalibration（艇×レース集計、
      // 母数は最大 totalAll×6）を使う。calcCalibration（hitProbEst集計、
      // 母数は最大 totalAll）は上の binStatsRaw/updateCalibPoints 専用のまま
      // 維持し、表示側のビン分けと混同しない（混ぜると hitProbEst の自己補正
      // テーブル CALIB_POINTS が無関係な統計で歪み、EV計算が壊れるため）。
      const winProbBinStats = calcWinProbCalibration(all);
      const totalValidWin   = winProbBinStats.reduce((s, b) => s + b.total, 0);

      const calError   = calcCalibrationError(winProbBinStats);
      const violations = countMonotonicViolations(winProbBinStats);
      const p2stats    = calcPlace2Calibration(all);
      const p3stats    = calcPlace3Calibration(all);
      // コース別キャリブレーション（パネル表示用：補正済み値）
      const courseStats = calcCalibrationByCourse(all);

      // ―― ③ コース別補正テーブル更新には1号艇の「生の推定値」を使用する ――
      // hitProbEst と同じ自己崩壊ループ対策。r.boatProbsRaw[1] が
      // computeScenCombosWithEV.js 側で保持している補正前の nigeProb。
      // 無ければ（旧データ等）boatProbs[1] のままフォールバックする。
      try {
        const allRawCourse = all.map(r => {
          if (!r.boatProbsRaw || r.boatProbsRaw[1] == null) return r;
          const rawBp = Object.assign({}, r.boatProbs, { 1: r.boatProbsRaw[1] });
          return Object.assign({}, r, { boatProbs: rawBp });
        });
        const courseStatsRaw = calcCalibrationByCourse(allRawCourse);
        if (typeof updateCourse1CalibPoints === 'function') updateCourse1CalibPoints(courseStatsRaw);
      } catch (_ccErr) { /* 補正テーブル更新失敗は無視（既存テーブルを維持） */ }

      // ―― ④ 2〜6号艇の補正テーブル更新には各艇の「生の推定値」を使用する ――
      // [2026-07-03 追加] ①③と同じ自己崩壊ループ対策。
      // boatProbsRaw[course]（computeScenCombosWithEV.js § 1.6 が保持する
      // 補正前の final_prob）があればそちらで boatProbs[course] を上書きしてから
      // 集計する。無ければ（旧データ・導入直後で raw 未保存等）boatProbs の
      // ままフォールバックする（無補正時は raw==補正後なので実害なし）。
      try {
        const allRawOther = all.map(r => {
          if (!r.boatProbsRaw) return r;
          const overrides = {};
          [2, 3, 4, 5, 6].forEach(c => {
            if (r.boatProbsRaw[c] != null) overrides[c] = r.boatProbsRaw[c];
          });
          if (Object.keys(overrides).length === 0) return r;
          return Object.assign({}, r, { boatProbs: Object.assign({}, r.boatProbs, overrides) });
        });
        const courseBinStatsRaw = calcWinProbCalibrationByCourse(allRawOther);
        if (typeof updateCourseOtherCalibPoints === 'function') updateCourseOtherCalibPoints(courseBinStatsRaw);
      } catch (_ccoErr) { /* 補正テーブル更新失敗は無視（既存テーブルを維持） */ }

      container.innerHTML = `
        <div class="ai-stats-card" style="margin-bottom:0.6rem">
          <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
            <button onclick="window._downloadCalibPointsJSON()" style="font-size:10px;font-weight:700;color:var(--text2);background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:4px 10px;cursor:pointer;margin-right:6px">
              🔄 補正テーブルをJSON保存（全端末配布用）
            </button>
            <button onclick="window._downloadCalibrationCSV()" style="font-size:10px;font-weight:700;color:var(--text2);background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:4px 10px;cursor:pointer">
              📥 全パネルをCSV保存
            </button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">
            ${buildCalibrationHTML(winProbBinStats, calError, violations, totalValidWin)}
            ${buildPlace2CalibHTML(p2stats, p3stats)}
            <div class="admin-only">${buildCoursCalibHTML(courseStats, all.length)}</div>
          </div>
          ${buildOverestimateAnalysisHTML(all)}
          ${buildDiagnosisHTML(all)}
        </div>`;
    } catch (e) {
      console.warn('[calibration] render error:', e);
    }
  };

})();
