// place23_prob_calibration.js — 2着・3着「確率値」キャリブレーション（完全外付け）
//
// 【解決する問題】
//   calibration.js の calcPlace2Calibration / calcPlace3Calibration は
//   「予測順位（1位/2位/3位）が当たったか」だけを集計しており、
//   画面（renderer.js buildScenarioSection）に表示される具体的な確率値
//   （例:「2着 38%」）そのものが実態と合っているかは検証していない。
//
//   本モジュールは computeScenCombosWithEV.js が計算している
//   weighted2nd / weighted3rd（= 画面表示と同一の加重確率）の中から
//   「予測1位の確率値」を取り出し、1着キャリブレーション（calibration.js
//   calcCalibration）と同じ手法でビン分け→実績比較を行う。
//
// 【設計方針・旧版からの変更点】
//   旧版: collectResultsForDateScen をラップして pred2ndTopProb を付与しようとしていた。
//   問題: _renderCalibrationPanel が発火する時点では allResultsScenAll は
//         「すでに計算済みの配列」であり、ラッパーは今後の呼び出しにしか効かない。
//         → 初回表示では pred2ndTopProb が常に空のまま（0件）になっていた。
//
//   新版（タスク①対応）:
//   ① collectResultsForDateScen のラップは完全廃止。
//   ② _renderCalibrationPanel のフック内で、渡された allResultsScenAll を
//      その場で走査（バックフィル）し、pred2ndTopProb が未設定なレコードに対して
//      computeScenCombosWithEV を呼び出して確率値を直接付与する。
//   ③ 付与は「インプレース書き込み」なので、calibration.js 側のオブジェクト
//      参照がそのまま有効になり、表示済みパネルへの反映も即時。
//
// 【前提条件】
//   - computeScenCombosWithEV.js が先に読み込まれていること
//   - getDataForDate / window._setDataForCalc / window._restoreDataForCalc
//     （top_stats.js / renderer.js に定義）が使用可能であること
//   - calibration.js より後に読み込み、_renderCalibrationPanel が定義済みであること
//     （ポーリングで待機するため、厳密な順序保証は不要）
//
// ─────────────────────────────────────────────────────────────────────

(function () {

  // ── ① バックフィル関数：allResultsScenAll 配列をその場で補完 ──
  //
  // 引数で受け取った results[] の各レコードに pred2ndTopProb / pred3rdTopProb が
  // 未設定であれば、computeScenCombosWithEV を呼び出して直接書き込む。
  //
  // 設計上の注意:
  //   - computeScenCombosWithEV はキャッシュヒット時も weighted2nd/3rd を計算済み
  //     （computeScenCombosWithEV.js の [修正] 箇所で対応済み）
  //   - _setDataForCalc / _restoreDataForCalc は computeScenCombosWithEV 内で
  //     呼ばれるため、ここで明示的に呼ぶ必要はない
  //   - エラーが起きた1件はスキップして次へ（安全側フォールバック）
  //   - 既に pred2ndTopProb が付いているレコードは再計算しない（冪等）
  //
  function _backfillProbFields(results) {
    if (!Array.isArray(results) || results.length === 0) return;
    if (typeof window.computeScenCombosWithEV !== 'function') {
      console.warn('[place23_prob_calibration] computeScenCombosWithEV が未定義のためバックフィルをスキップ');
      return;
    }
    if (typeof getDataForDate !== 'function') {
      console.warn('[place23_prob_calibration] getDataForDate が未定義のためバックフィルをスキップ');
      return;
    }

    let filled = 0, skipped = 0, errors = 0;

    results.forEach(r => {
      // 既に付与済みのレコードはスキップ（冪等性保証）
      if (r.pred2ndTopProb != null && r.pred3rdTopProb != null) {
        skipped++;
        return;
      }

      try {
        const dataForDate = getDataForDate(r.date);
        if (!dataForDate) return;
        const vdata = dataForDate[r.venue];
        if (!vdata) return;

        const res = window.computeScenCombosWithEV(r.venue, vdata, r.rno);
        if (!res) return;

        // ── 2着 予測1位の確率値（= 画面の「2着 XX%」と同じ数値）──
        // ranked2ndList は加重確率降順の艇番配列
        // weighted2nd は { 艇番: 加重確率 } のマップ
        if (res.ranked2ndList && res.ranked2ndList.length > 0 && res.weighted2nd) {
          const topBoat2 = res.ranked2ndList[0];
          r.pred2ndTopBoat = topBoat2;
          r.pred2ndTopProb = res.weighted2nd[topBoat2] ?? null;
          // 実際にその艇が2着になったか
          r.pred2ndTopHit  = (r.actual2nd != null && topBoat2 === r.actual2nd);
        }

        // ── 3着 予測1位の確率値 ──
        if (res.ranked3rdList && res.ranked3rdList.length > 0 && res.weighted3rd) {
          const topBoat3 = res.ranked3rdList[0];
          r.pred3rdTopBoat = topBoat3;
          r.pred3rdTopProb = res.weighted3rd[topBoat3] ?? null;
          r.pred3rdTopHit  = (r.actual3rd != null && topBoat3 === r.actual3rd);
        }

        // ── ranked2ndList / ranked3rdList もバックフィル（順位検証用）──
        // collectResultsForDateScen 側の pred2ndRank は「頻度ベース」のままだが、
        // 加重確率ベースの順位も参照できるように保持しておく
        if (!r._weighted2ndList && res.ranked2ndList) {
          r._weighted2ndList = res.ranked2ndList;
          r._weighted3rdList = res.ranked3rdList;
        }

        filled++;
      } catch (_e) {
        errors++;
        // 1レースのエラーは無視して次へ
      }
    });

    if (filled > 0 || errors > 0) {
      console.log(`[place23_prob_calibration] バックフィル完了: 付与=${filled}件, スキップ=${skipped}件, エラー=${errors}件`);
    }
  }


  // ── ② ビン分け集計（calibration.js calcCalibration と同一手法）──
  const BINS = [
    { label: '0–10%',  min: 0.00, max: 0.10 },
    { label: '10–20%', min: 0.10, max: 0.20 },
    { label: '20–30%', min: 0.20, max: 0.30 },
    { label: '30–40%', min: 0.30, max: 0.40 },
    { label: '40–60%', min: 0.40, max: 0.60 },
    { label: '60%+',   min: 0.60, max: 1.01 },
  ];

  function _calcProbCalibration(results, probKey, hitKey) {
    const valid = (results || []).filter(r => r[probKey] != null);
    return BINS.map(bin => {
      const inBin  = valid.filter(r => r[probKey] >= bin.min && r[probKey] < bin.max);
      const total  = inBin.length;
      const hits   = inBin.filter(r => r[hitKey]).length;
      const actual = total > 0 ? hits / total : null;
      const estAvg = total > 0 ? inBin.reduce((s, r) => s + r[probKey], 0) / total : null;
      return { label: bin.label, total, hits, actual, estAvg };
    });
  }

  function _calcError(binStats) {
    const valid = binStats.filter(b => b.total > 0 && b.actual != null && b.estAvg != null);
    if (valid.length === 0) return null;
    const totalN = valid.reduce((s, b) => s + b.total, 0);
    const wErr   = valid.reduce((s, b) => s + Math.abs(b.estAvg - b.actual) * b.total, 0);
    return wErr / totalN;
  }


  // ── ③ HTML生成（calibration.js と同系統の見た目）──
  function _buildHTML(bins2, err2, n2, bins3, err3, n3) {
    function rows(bins) {
      return bins.map(b => {
        if (b.total === 0) {
          return `<tr>
            <td style="padding:3px 6px;font-size:10px;color:var(--text3)">${b.label}</td>
            <td colspan="4" style="padding:3px 6px;font-size:10px;color:var(--text3);text-align:center">データなし</td>
          </tr>`;
        }
        const diff    = (b.actual - b.estAvg);
        const diffPct = (diff * 100).toFixed(0);
        const color   = Math.abs(diff) <= 0.07
          ? 'var(--green)'
          : (Math.abs(diff) <= 0.15 ? 'var(--orange)' : 'var(--red,#e05)');
        const lowN = b.total < 10 ? ' *' : '';
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:3px 6px;font-size:10px;color:var(--text3);white-space:nowrap">${b.label}</td>
          <td style="padding:3px 6px;text-align:right;font-size:11px">${(b.estAvg*100).toFixed(0)}%</td>
          <td style="padding:3px 6px;text-align:right;font-size:11px;font-weight:700">${(b.actual*100).toFixed(0)}%${lowN}</td>
          <td style="padding:3px 6px;text-align:right;font-size:11px;font-weight:700;color:${color}">${diff>=0?'+':''}${diffPct}%</td>
          <td style="padding:3px 6px;text-align:right;font-size:9px;color:var(--text3)">n=${b.total}</td>
        </tr>`;
      }).join('');
    }

    function errLabel(err) {
      if (err == null) return '—';
      const color   = err <= 0.07 ? 'var(--green)' : (err <= 0.15 ? 'var(--orange)' : 'var(--red,#e05)');
      const verdict = err <= 0.07 ? '良好' : (err <= 0.15 ? '要観察' : '要改善');
      return `<span style="color:${color};font-weight:700">${(err*100).toFixed(1)}% 誤差・${verdict}</span>`;
    }

    const headerRow = `
      <thead><tr>
        <th style="padding:3px 6px;font-size:9px;color:var(--text3);text-align:left">推定帯</th>
        <th style="padding:3px 6px;font-size:9px;color:var(--text3);text-align:right">推定平均</th>
        <th style="padding:3px 6px;font-size:9px;color:var(--text3);text-align:right">実績</th>
        <th style="padding:3px 6px;font-size:9px;color:var(--text3);text-align:right">差</th>
        <th style="padding:3px 6px;font-size:9px;color:var(--text3);text-align:right">件数</th>
      </tr></thead>`;

    return `
      <div style="background:var(--bg3);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)">
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-align:center;margin-bottom:2px">
          🎯 2着・3着 確率値キャリブレーション
        </div>
        <div style="font-size:10px;color:var(--text3);text-align:center;margin-bottom:6px">
          画面表示の「予測1位の%」そのものが実態と一致しているか
        </div>

        <div style="font-size:10px;font-weight:700;color:var(--text3);margin:6px 0 2px">
          2着（${n2}件）&nbsp; 加重平均誤差: ${errLabel(err2)}
        </div>
        <table style="width:100%;border-collapse:collapse">
          ${headerRow}
          <tbody>${rows(bins2)}</tbody>
        </table>

        <div style="font-size:10px;font-weight:700;color:var(--text3);margin:10px 0 2px">
          3着（${n3}件）&nbsp; 加重平均誤差: ${errLabel(err3)}
        </div>
        <table style="width:100%;border-collapse:collapse">
          ${headerRow}
          <tbody>${rows(bins3)}</tbody>
        </table>

        <div style="font-size:9px;color:var(--text3);margin-top:6px">
          推定平均=その帯に入ったレースの「画面表示%」の平均　
          実績=その帯で実際に予測1位艇が来た割合　* n&lt;10は参考値
        </div>
      </div>`;
  }


  // ── ④ 公開関数（外部から直接呼び出し可能）──
  //
  // 使い方:
  //   window._renderPlace23ProbCalibrationPanel(allResultsScenAll);
  //
  // allResultsScenAll: collectResultsForDateScen を30日分まとめた配列。
  // この関数内でバックフィルを実行するため、呼び出し元での前処理は不要。
  window._renderPlace23ProbCalibrationPanel = function (allResultsScenAll) {
    try {
      // ── admin-mode ガード ──
      // calibration.js の _renderCalibrationPanel と同じ権限チェックをここでも行う。
      // このパネルは管理者専用のため、admin-mode でない場合は既存パネルを
      // 削除して終了する（無料/有料ユーザーには一切表示しない）。
      if (!document.body.classList.contains('admin-mode')) {
        const existing = document.getElementById('place23-prob-calibration-panel');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        return;
      }

      const all = allResultsScenAll || [];
      if (all.length === 0) {
        console.warn('[place23_prob_calibration] allResultsScenAll が空のためスキップ');
        return;
      }

      // ── バックフィル（核心部分）──
      // allResultsScenAll の各レコードに pred2ndTopProb / pred3rdTopProb を直接付与。
      // 既に付与済みのレコードはスキップ（冪等）。
      _backfillProbFields(all);

      // ── 集計 ──
      const bins2 = _calcProbCalibration(all, 'pred2ndTopProb', 'pred2ndTopHit');
      const bins3 = _calcProbCalibration(all, 'pred3rdTopProb', 'pred3rdTopHit');
      const err2  = _calcError(bins2);
      const err3  = _calcError(bins3);
      const n2    = all.filter(r => r.pred2ndTopProb != null).length;
      const n3    = all.filter(r => r.pred3rdTopProb != null).length;

      // ── DOM 挿入・更新 ──
      let container = document.getElementById('place23-prob-calibration-panel');
      if (!container) {
        container = document.createElement('div');
        container.id = 'place23-prob-calibration-panel';
        container.style.marginBottom = '0.6rem';
        // top-ai-calibration-panel（hitProbEst キャリブレーション）の直後に挿入
        const ref = document.getElementById('top-ai-calibration-panel');
        if (ref && ref.parentNode) {
          ref.parentNode.insertBefore(container, ref.nextSibling);
        } else {
          // フォールバック: body末尾に追加
          document.body.appendChild(container);
        }
      }

      container.innerHTML = `<div class="ai-stats-card">${_buildHTML(bins2, err2, n2, bins3, err3, n3)}</div>`;

    } catch (e) {
      console.warn('[place23_prob_calibration] _renderPlace23ProbCalibrationPanel エラー:', e);
    }
  };


  // ── ⑤ 自動フック ──
  //
  // window._renderCalibrationPanel（calibration.js で定義）をラップし、
  // その呼び出しに相乗りして自動発火させる。
  //
  // 旧版との違い:
  //   旧: ラップ内で collectResultsForDateScen の再ラップを試みていた
  //       → フック前に生成済みの配列には効果なし
  //   新: 引数として渡された allResultsScenAll をその場でバックフィルする
  //       → allResultsScenAll の内容を直接書き換えるため、既存オブジェクトへ即時反映
  //
  function _hookAutoRender() {
    if (typeof window._renderCalibrationPanel !== 'function') return false;
    if (window._renderCalibrationPanel._place23Hooked) return true; // 二重フック防止

    const _origRender = window._renderCalibrationPanel;

    window._renderCalibrationPanel = function (allResultsScenAll) {
      // まず元の _renderCalibrationPanel を実行（hitProbEst キャリブレーションパネルを描画）
      const ret = _origRender.apply(this, arguments);

      // その後、同じ allResultsScenAll に対してバックフィル＋パネル描画を実行
      try {
        window._renderPlace23ProbCalibrationPanel(allResultsScenAll);
      } catch (e) {
        console.warn('[place23_prob_calibration] auto-render エラー:', e);
      }

      return ret;
    };

    window._renderCalibrationPanel._place23Hooked = true;
    console.log('[place23_prob_calibration] 自動フック完了（バックフィル方式）');
    return true;
  }

  // _renderCalibrationPanel がまだ定義されていない場合はポーリングして待機（最大10秒）
  (function _waitAndHook() {
    if (_hookAutoRender()) return;
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (_hookAutoRender() || tries >= 100) clearInterval(iv);
    }, 100);
  })();

})();

// ══════════════════════════════════════════════════════════════════
// 【使い方まとめ】
//
// index.html に <script> タグを1行追加するだけ:
//   <script src="place23_prob_calibration.js"></script>
//
// 読み込み順（必須）:
//   1. top_stats.js          ← collectResultsForDateScen / getDataForDate の元定義
//   2. computeScenCombosWithEV.js ← weighted2nd/3rd の計算元
//   3. calibration.js        ← _renderCalibrationPanel の定義元
//   4. place23_prob_calibration.js ← このファイル（フック後に自動発火）
//
// 【バックフィルの動作】
//   _renderCalibrationPanel が呼ばれると自動フックが発火し、
//   引数の allResultsScenAll[] を走査してバックフィルを実行する。
//
//   バックフィル対象レコード: pred2ndTopProb が null のもの
//   スキップ条件: pred2ndTopProb が既に設定済み（冪等性）
//
//   computeScenCombosWithEV の戻り値:
//     ranked2ndList[0] → 2着予測1位の艇番
//     weighted2nd[ranked2ndList[0]] → その艇の加重確率（= 画面表示と同一の値）
//
// 【デバッグ】
//   コンソールで手動実行も可能:
//     window._renderPlace23ProbCalibrationPanel(allResultsScenAll);
//
// ══════════════════════════════════════════════════════════════════
