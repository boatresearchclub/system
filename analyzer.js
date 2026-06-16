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

// ── 会場名→スラッグ 共通マップ（全関数から参照）──
const VENUE_SLUG_MAP = {
  "桐生":"kiryu","戸田":"toda","江戸川":"edogawa","平和島":"heiwajima",
  "多摩川":"tamagawa","浜名湖":"hamanako","蒲郡":"gamagori","常滑":"tokoname",
  "津":"tsu","三国":"mikuni","びわこ":"biwako","住之江":"suminoe",
  "尼崎":"amagasaki","鳴門":"naruto","丸亀":"marugame","児島":"kojima",
  "宮島":"miyajima","徳山":"tokuyama","下関":"shimonoseki","若松":"wakamatsu",
  "芦屋":"ashiya","福岡":"fukuoka","唐津":"karatsu","大村":"omura"
};

function buildWeatherBar(rno){
  _ensureTenjiCache();
  const slug   = VENUE_SLUG_MAP[DATA.venue] || DATA.venue;
  const key    = tenjiKey(slug, DATA.date, rno);
  const cached = _tenjiCache[key];

  // ── 会場別スタートライン方向（ボートの進行方位角 °）──────────
  // 追い風 = 風がボートを後ろから押す（風向とボート進行が逆方向）
  // 風向き数値: 1=北(0°), 2=北北東(22.5°)... 時計回り16方位
  // 会場別スタートライン方向（ボートの進行方位角°）
  // ソース: 公式サイト実データの追い風/向かい風分析（2014-2022）から逆算
  // 追い風方向の逆がボート進行方向 = SL_DIR
  const SL_DIR = {
    "kiryu":       180,  // 桐生    南  （追い風=北）
    "toda":        135,  // 戸田    南東 （追い風=北西）
    "edogawa":      45,  // 江戸川  北東 （追い風=南西）
    "heiwajima":     0,  // 平和島  北  （追い風=南）
    "tamagawa":    270,  // 多摩川  西  （追い風=東）※変更なし
    "hamanako":      0,  // 浜名湖  北  （追い風=南）
    "gamagori":    225,  // 蒲郡    南西 （追い風=北東）
    "tokoname":    315,  // 常滑    北西 （追い風=南東）※変更なし
    "tsu":         315,  // 津      北西 （追い風=南東）
    "mikuni":      180,  // 三国    南  （追い風=北）
    "biwako":      180,  // びわこ  南  （追い風=北）
    "suminoe":     180,  // 住之江  南  （追い風=北）
    "amagasaki":   225,  // 尼崎    南西 （追い風=北東）
    "naruto":      135,  // 鳴門    南東 （追い風=北西）
    "marugame":      0,  // 丸亀    北  （追い風=南）
    "kojima":      180,  // 児島    南  （追い風=北）
    "miyajima":    225,  // 宮島    南西 （追い風=北東）
    "tokuyama":    315,  // 徳山    北西 （追い風=南東）
    "shimonoseki": 270,  // 下関    西  （追い風=東）※変更なし
    "wakamatsu":   180,  // 若松    南  （追い風=北）※変更なし
    "ashiya":      180,  // 芦屋    南  （若松隣接・地形推定）
    "fukuoka":     225,  // 福岡    南西 （博多湾・地形推定）
    "karatsu":     180,  // 唐津    南  （追い風=北、年間追い風多し）
    "omura":       270,  // 大村    西  （大村湾・地形推定）※変更なし
  };
  function windNumToDeg(n){ return ((n - 1) * 22.5) % 360; }
  function getWindType(windNum, slDeg){
    if(windNum == null || slDeg == null) return null;
    const windDeg = windNumToDeg(windNum);
    let diff = Math.abs(windDeg - slDeg) % 360;
    if(diff > 180) diff = 360 - diff;
    // diff≈0° → 風向=ボート進行方向 → 向かい風
    // diff≈180° → 風向=ボート逆方向 → 追い風
    if(diff <= 30)  return 'head';    // ±30°以内 = 向かい風
    if(diff >= 150) return 'tail';    // ±30°以内(逆) = 追い風
    // 横風: 符号付き差分で右/左を判定
    // signed 0〜180° → 風がボートの右側から来る（右横風）
    // signed 180〜360° → 風がボートの左側から来る（左横風）
    const signed = (windDeg - slDeg + 360) % 360;
    return signed < 180 ? 'cross_right' : 'cross_left';
  }
  const WIND_LABEL = { tail:'追い風', head:'向かい風', cross_right:'右横風', cross_left:'左横風' };
  // 矢印はスタートライン(右)に向かうボートを基準にした画面座標
  // ボート進行=→, 追い風=後ろから→, 向かい風=正面から←, 右横風=下から↑, 左横風=上から↓
  const WIND_ARROW = { tail:'→', head:'←', cross_right:'↑', cross_left:'↓' };

  // データ未取得 → 過去日なら「記録なし」、当日なら「取得待ち」
  if(!cached){
    const today = new Date().toISOString().slice(0,10);
    const isPastDay = DATA.date && DATA.date < today;
    const msg = isPastDay ? '記録なし' : '取得待ち';
    return `<div class="weather-bar"><span class="weather-bar-title">水面気象情報</span><div class="weather-bar-body"><span class="tenji-waiting" style="margin:0;padding:0;display:inline;font-size:11px">${msg}</span></div></div>`;
  }

  const w = {
    weather:       cached.__weather,
    weather_degree:cached.__weather_degree,
    water_degree:  cached.__water_degree,
    wind_speed:    cached.__wind_speed,
    wind_dir_num:  cached.__wind_direction,
    wind_dir_text: cached.__wind_direction_text,
    wave_height:   cached.__wave_height,
  };

  // キャッシュはあるが気象フィールドがすべて null
  if(Object.values(w).every(v => v == null)){
    return `<div class="weather-bar"><span class="weather-bar-title">水面気象情報</span><div class="weather-bar-body"><span class="tenji-waiting" style="margin:0;padding:0;display:inline;font-size:11px">取得待ち</span></div></div>`;
  }

  // 追い風/向かい風バッジ
  const windType  = getWindType(w.wind_dir_num, SL_DIR[slug] ?? null);
  const windBadge = windType
    ? `<span class="wind-badge ${windType}">${WIND_ARROW[windType]} ${WIND_LABEL[windType]}</span>`
    : '';

  const weatherIcon = {'晴':'☀️','曇':'☁️','雨':'🌧️','雪':'❄️'};
  const icon = weatherIcon[w.weather] || '🌤️';
  const row1 = [
    w.weather        != null ? `<div class="weather-item"><span class="wi-label">天候</span><span class="wi-val">${icon} ${w.weather}</span></div>` : '',
    w.weather_degree != null ? `<div class="weather-item"><span class="wi-label">気温</span><span class="wi-val">${w.weather_degree}℃</span></div>` : '',
    w.water_degree   != null ? `<div class="weather-item"><span class="wi-label">水温</span><span class="wi-val">${w.water_degree}℃</span></div>` : '',
  ].filter(Boolean).join('');
  const row2 = [
    w.wind_speed  != null ? `<div class="weather-item"><span class="wi-label">風速</span><span class="wi-val">${w.wind_speed}m/s${w.wind_dir_text ? ' ' + w.wind_dir_text : ''}${windBadge}</span></div>` : '',
    w.wave_height != null ? `<div class="weather-item"><span class="wi-label">波高</span><span class="wi-val">${w.wave_height}cm</span></div>` : '',
  ].filter(Boolean).join('');
  const weatherRows = [
    row1 ? `<div style="display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap">${row1}</div>` : '',
    row2 ? `<div style="display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap">${row2}</div>` : ''
  ].filter(Boolean).join('');
  return `<div class="weather-bar"><span class="weather-bar-title">水面気象情報</span><div class="weather-bar-body" style="flex-direction:column;gap:4px;align-items:center">${weatherRows}</div></div>`;
}

function buildCourseOrderBanner(rno, boats){
  // _tenjiCache から course/is_normal_course を読んで「進入変更」バナーを生成
  _ensureTenjiCache();
  const slug2  = VENUE_SLUG_MAP[DATA.venue] || DATA.venue;
  const key2   = tenjiKey(slug2, DATA.date, rno);
  const cached2 = _tenjiCache[key2];
  if(!cached2) return '';  // 展示未取得 → バナーなし

  const cf2 = bn => cached2[String(bn)] ?? cached2[bn];

  // course が null の艇が1つでもあればコースデータなし → バナーなし
  const entries = boats.map(b => {
    const d = cf2(b.boat);
    const course = d?.course ?? null;
    // is_normal_course が明示されていればそちらを優先、
    // なければ「展示コース ≠ 枠番」で進入変更を判定
    const is_normal = d?.is_normal_course != null
      ? d.is_normal_course
      : (course != null ? course === b.boat : null);
    return { frame: b.boat, name: b.name, course, is_normal };
  });
  if(entries.some(e => e.course == null)) return '';

  const allNormal = entries.every(e => e.is_normal !== false);
  if(allNormal) return '';  // 全艇枠なり → バナー不要

  // コース順でソート（1コース→2→…）
  const sorted = [...entries].sort((a,b) => a.course - b.course);

  // ボートサークル
  const circle = (n) =>
    `<span class="boat-circle b${n}" style="width:20px;height:20px;font-size:10px;line-height:20px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${n}</span>`;

  // コース順に全艇の枠番サークルを並べる
  const orderHtml = sorted.map((e, i) =>
    `${i > 0 ? '<span class="cb-sep">›</span>' : ''}${circle(e.frame)}`
  ).join('');

  return `<div class="course-order-banner">
    <span class="cb-icon">⚠</span>
    <span class="cb-text">進入変更</span>
    <span class="cb-order">${orderHtml}</span>
  </div>`;
}

function buildTenjiSection(rno, boats){
  _ensureTenjiCache();
  const slug   = VENUE_SLUG_MAP[DATA.venue] || DATA.venue;
  const key    = tenjiKey(slug, DATA.date, rno);
  const cached = _tenjiCache[key];

  // 未取得の場合
  if(cached === undefined || cached === null){
    const rd = DATA.races[String(rno)];
    const timeStr = rd && rd.time;
    // 過去日かどうか判定（DATA.date が今日より前）
    const today = new Date().toISOString().slice(0,10);
    const isPastDay = DATA.date && DATA.date < today;
    let pastDeadline = isPastDay; // 過去日は無条件で「記録なし」
    if(!isPastDay && timeStr && /^\d{1,2}:\d{2}$/.test(timeStr.trim())){
      const now = new Date();
      const [h, m] = timeStr.trim().split(':').map(Number);
      const deadlineMin = h * 60 + m - 5;  // 締め切り5分前
      const nowMin = now.getHours() * 60 + now.getMinutes();
      pastDeadline = nowMin >= deadlineMin;
    }
    // 過去日または締め切り後は「展示情報がありません」
    const msg = pastDeadline ? '展示情報がありません' : '取得待ち';
    return `${buildWeatherBar(rno)}<div class="tenji-section">
      <div class="tenji-title">展示情報</div>
      <div style="background:var(--bg2)"><div class="tenji-waiting">${msg}</div></div>
    </div>`;
  }

  // 枠番キーは文字列で統一（Python側JSON → 文字列キー、数値/文字列どちらでも取得できるよう正規化）
  const cf = bn => cached[String(bn)] ?? cached[bn];
  const lap1vals   = boats.map(b=>cf(b.boat)?.lap1).filter(v=>v!=null);
  const mawarivals = boats.map(b=>cf(b.boat)?.mawari).filter(v=>v!=null);
  const chokuvals  = boats.map(b=>cf(b.boat)?.chokusen).filter(v=>v!=null);
  const tenjivals  = boats.map(b=>cf(b.boat)?.tenji).filter(v=>v!=null);
  const bestLap1   = lap1vals.length   ? Math.min(...lap1vals)   : null;
  const bestMawari = mawarivals.length ? Math.min(...mawarivals) : null;
  const bestChoku  = chokuvals.length  ? Math.min(...chokuvals)  : null;
  const bestTenji  = tenjivals.length  ? Math.min(...tenjivals)  : null;
  const rows = boats.map(bt => {
    const bn = bt.boat;
    const t  = cf(bn);
    if(!t) return `<tr><td>${bn}</td><td>${bt.name}</td><td colspan="5">—</td></tr>`;
    const f = (v, best) => v==null ? '—' : `<span class="${v===best?'tenji-best':''}">${v.toFixed(2)}</span>`;
    const rankCls = t.tenji_rank===1 ? 'tenji-rank1' : '';
    const tilt = t.tilt != null ? `<span class="tenji-tilt">${t.tilt>0?'+':''}${t.tilt}</span>` : '';
    return `<tr>
      <td><span class="boat-circle b${bn}" style="width:22px;height:22px;font-size:11px;line-height:22px;display:inline-flex;align-items:center;justify-content:center">${bn}</span></td>
      <td>${bt.name}</td>
      <td>${f(t.lap1, bestLap1)}</td>
      <td>${f(t.mawari, bestMawari)}</td>
      <td>${f(t.chokusen, bestChoku)}</td>
      <td><span class="${rankCls}">${f(t.tenji, bestTenji)}</span></td>
      <td>${tilt}</td>
    </tr>`;
  }).join('');
  return `${buildWeatherBar(rno)}<div class="tenji-section">
    <div class="tenji-title">展示情報</div>
    <div style="background:var(--bg2)">
      <table class="tenji-table">
        <thead><tr>
          <th>枠</th><th style="text-align:center">選手名</th>
          <th>1周</th><th>回り足</th><th>直線</th><th>展示</th><th>チルト</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

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
      const row  = _suminoeTableLookup(b.boat, diff) ?? { p1: 0, p2: 0, p3: 0 };
      // %pt → 係数（例: +13%pt → 1.13）
      map[`__coef_${b.boat}`]  = Math.min(2.0, Math.max(0.5, 1 + row.p1 / 100));
      map[`__coef2_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p2 / 100));
      map[`__coef3_${b.boat}`] = Math.min(2.0, Math.max(0.5, 1 + row.p3 / 100));
      map[`__diff_${b.boat}`]  = diff;  // バッジ表示用
      map[b.boat] = 1 / boats.length;   // 正規化スコア（均等）
    });
    map.__isSuminoe = true;  // buildScenarioSectionのバッジ判定用
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
//  【ゼロサム保証の数理設計】
//
//  ① vKimari パイの再配分（スリット補正A・気象補正B-2）
//     adjustedVKimari[k] *= slitMul[k] * windBoost[k]
//     → 乗算後に Σ で再正規化 → 合計が常に 1.0 に保たれる
//
//  ② personalAdaptation への展示乖離加算（展示補正B-1）
//     personalAdaptation[b] += tenjiDev[b]
//     adaptTotal も同時に増減するため、
//     adaptShare = personalAdaptation[b] / adaptTotal は正規化されたまま
//
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
  const outside = boats.filter(b => b.boat === 3 || b.boat === 4);

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
  const TENJI_DEV_CLIP   = 0.05;  // ±5% クリップ
  const TENJI_DEV_WEIGHT = 0.60;  // 加算強度

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
 * 展開確率・基準1着率 拡張版（スリット隊形・展示タイム・気象補正）
 *
 * 既存 calcTenkaiProbs のゼロサム相対評価モデルを継承し、
 * 3つの動的補正を追加する。tenjiData / venue を省略した場合は
 * 既存 calcTenkaiProbs と同等の動作になる。
 *
 * @param {object[]}    boats      レース艇データ（boat, name, prob 必須）
 * @param {number}      arek       荒れ指数
 * @param {object|null} tenjiData  展示キャッシュ（省略可）
 * @param {string}      venue      会場名（省略可）
 * @returns {object[]}  tenkai_prob / tenkai_score / final_prob 付き配列
 */
function calcTenkaiProbsExtended(boats, arek, tenjiData = null, venue = null) {
  const resolvedVenue = venue ?? DATA?.venue ?? '';

  // ── MASTER_EXT なし / 会場データなし → フォールバック ──
  if (!MASTER_EXT || !MASTER_EXT.venue_kimari) {
    return [...boats].map(b => ({
      ...b,
      tenkai_prob:  b.prob,
      tenkai_score: b.prob,
      final_prob:   b.prob,
    })).sort((a, b) => b.tenkai_prob - a.tenkai_prob);
  }
  const vKimariRaw = MASTER_EXT.venue_kimari[resolvedVenue];
  if (!vKimariRaw) {
    return [...boats].map(b => ({
      ...b,
      tenkai_prob:  b.prob,
      tenkai_score: b.prob,
      final_prob:   b.prob,
    })).sort((a, b) => b.tenkai_prob - a.tenkai_prob);
  }

  // ── [A] スリット隊形補正係数 ──
  const { makuriBoost, nigeDiscount } = calcSlitFormationBoost(boats);

  // ── [B-2] 気象補正係数 ──
  const weatherCtx = buildWeatherContext(tenjiData, resolvedVenue);
  const windBoost  = calcWindKimariBoost(weatherCtx);

  // ── [B-1] 展示タイム乖離マップ ──
  const tenjiDevMap = calcTenjiDeviation(boats, tenjiData);

  // ── vKimari にスリット・気象補正を乗算 → 再正規化（ゼロサム保証①） ──
  const slitMul = {
    '逃げ':       nigeDiscount,
    '差し':       1.0,
    'まくり':     makuriBoost,
    'まくり差し': makuriBoost * 0.7 + 0.3,  // まくり差しは半分の感度
    '抜き':       1.0,
  };

  const adjustedVKimari = {};
  for (const [k, v] of Object.entries(vKimariRaw)) {
    const slit = slitMul[k]   ?? 1.0;
    const wind = windBoost[k] ?? 1.0;
    adjustedVKimari[k] = Math.max(0, v * slit * wind);
  }
  // 再正規化 → Σ = 1.0 を保証
  const vKimariTotal = Object.values(adjustedVKimari).reduce((s, v) => s + v, 0);
  if (vKimariTotal > 0) {
    for (const k of Object.keys(adjustedVKimari)) {
      adjustedVKimari[k] = adjustedVKimari[k] / vKimariTotal;
    }
  }

  // ════════ 以下は既存 calcTenkaiProbs のロジックをそのまま継承 ════════

  const KIMARI_HARD_EXCLUDE = {
    '逃げ':       new Set(['2','3','4','5','6']),
    '差し':       new Set(['1']),
    'まくり':     new Set(['1']),
    'まくり差し': new Set(['1','2','3']),
    '抜き':       new Set(),
  };
  const KIMARI_SOFT_THRESHOLD = {
    'まくり':     { '2': 0.05 },
    'まくり差し': { '5': 0.05, '6': 0.08 },
    '抜き':       { '1': 0.03 },
  };
  const PERSONAL_BLEND_STRENGTH = 0.7;

  function getPersonalKimari(boatName, courseStr, kimariType) {
    return getCourseMaster(boatName, courseStr)?.kimari?.[kimariType] ?? 0;
  }
  function isValidFirst(boat, kimari) {
    const wc  = String(boat.boat);
    const exc = KIMARI_HARD_EXCLUDE[kimari];
    if (!exc) return false;
    if (exc.has(wc)) return false;
    const soft = KIMARI_SOFT_THRESHOLD[kimari];
    if (soft && wc in soft) {
      return getPersonalKimari(boat.name, wc, kimari) >= soft[wc];
    }
    return true;
  }

  const boat1 = boats.find(b => b.boat === 1) || null;

  function blendPersonalKimari(boatObj, baseVKimari) {
    const name   = boatObj.name;
    const course = String(boatObj.boat);
    const cm     = getCourseMaster(name, course);
    if (!cm) return baseVKimari;
    const runs = cm.runs ?? 0;
    if (runs < 20) return baseVKimari;
    const trust = Math.min(runs / 100, 1.0) * PERSONAL_BLEND_STRENGTH;
    const personalKimari = cm.kimari ?? {};
    const BLEND_TARGETS  = ['差し', 'まくり', 'まくり差し', '抜き'];
    const personalTotal  = BLEND_TARGETS.reduce((s, k) => s + (personalKimari[k] ?? 0), 0);
    if (personalTotal <= 0) return baseVKimari;
    const blended       = { ...baseVKimari };
    const venueBlendSum = BLEND_TARGETS.reduce((s, kk) => s + (baseVKimari[kk] ?? 0), 0);
    for (const k of BLEND_TARGETS) {
      if (!(k in blended)) continue;
      const personalRate = (personalKimari[k] ?? 0) / personalTotal * venueBlendSum;
      blended[k] = baseVKimari[k] * (1 - trust) + personalRate * trust;
    }
    const origTotal  = Object.values(baseVKimari).reduce((s, v) => s + v, 0);
    const blendTotal = Object.values(blended).reduce((s, v) => s + v, 0);
    if (blendTotal > 0) {
      for (const k of Object.keys(blended)) blended[k] = blended[k] / blendTotal * origTotal;
    }
    return blended;
  }

  const kimariTypes = Object.keys(adjustedVKimari).filter(
    k => adjustedVKimari[k] > 0 && k in KIMARI_HARD_EXCLUDE
  );
  const boatVKimari = {};
  boats.forEach(b => { boatVKimari[b.boat] = blendPersonalKimari(b, adjustedVKimari); });

  const kimariCoefSum = {};
  boats.forEach(b => { kimariCoefSum[b.boat] = 0; });

  const nigePersonalRate = (() => {
    if (!boat1) return null;
    const nigeRate = getPersonalKimari(boat1.name, '1', '逃げ');
    const nigeRuns = getCourseMaster(boat1.name, '1')?.runs ?? 0;
    if (nigeRuns < 20 || nigeRate <= 0) return null;
    const trust     = Math.min(nigeRuns / 100, 1.0) * PERSONAL_BLEND_STRENGTH;
    const venueNige = adjustedVKimari['逃げ'] || 0;
    return venueNige * (1 - trust) + nigeRate * trust;
  })();

  for (const kimari of kimariTypes) {
    const personalAdaptation = {};

    for (const b of boats) {
      if (!isValidFirst(b, kimari)) {
        personalAdaptation[b.boat] = 0;
        continue;
      }
      const wc  = String(b.boat);
      const cm  = getCourseMaster(b.name, wc);
      const runs = cm?.runs ?? 0;

      let kimariRate;
      if (kimari === '逃げ') {
        kimariRate = (b.boat === 1 && nigePersonalRate != null)
          ? nigePersonalRate
          : (adjustedVKimari['逃げ'] || 0);
      } else {
        kimariRate = getPersonalKimari(b.name, wc, kimari);
        if (runs < 20 || kimariRate <= 0) {
          kimariRate = boatVKimari[b.boat][kimari] || adjustedVKimari[kimari] || 0;
        } else {
          const trust     = Math.min(runs / 100, 1.0);
          const venueRate = boatVKimari[b.boat][kimari] || adjustedVKimari[kimari] || 0;
          kimariRate = kimariRate * trust + venueRate * (1 - trust);
        }
      }

      // ── [B-1] 展示タイム乖離補正（ゼロサム保証②） ──
      //   加算後 adaptTotal も増減するため、比率は正規化されたまま。
      const tenjiAdj = tenjiDevMap[b.boat] ?? 0;
      personalAdaptation[b.boat] = Math.max(0, kimariRate + tenjiAdj);
    }

    const validBoats = boats.filter(b => isValidFirst(b, kimari));
    if (validBoats.length === 0) continue;
    const adaptTotal = validBoats.reduce((s, b) => s + personalAdaptation[b.boat], 0);
    if (adaptTotal <= 0) continue;

    const kimariBaseProb = adjustedVKimari[kimari] || 0;
    if (kimariBaseProb <= 0) continue;

    for (const b of validBoats) {
      const adaptShare = personalAdaptation[b.boat] / adaptTotal;  // Σ=1.0
      kimariCoefSum[b.boat] += kimariBaseProb * adaptShare;
    }
  }

  const FLOOR_PROB = 0.0001;
  const scores = {};
  boats.forEach(b => {
    const adaptScore = kimariCoefSum[b.boat] > 0 ? kimariCoefSum[b.boat] : FLOOR_PROB;
    scores[b.boat] = Math.max(FLOOR_PROB, b.prob * adaptScore);
  });

  const total = Object.values(scores).reduce((a, v) => a + v, 0) || 1;
  return [...boats]
    .map(b => ({
      ...b,
      tenkai_prob:         scores[b.boat] / total,
      tenkai_score:        scores[b.boat] / total,
      kimari_coef:         kimariCoefSum[b.boat],
      final_prob:          scores[b.boat] / total,
      // デバッグ用メタ（UIへの表示用）
      _slit_makuri_boost:  makuriBoost,
      _slit_nige_discount: nigeDiscount,
      _wind_type:          weatherCtx.windType,
      _tenji_dev:          tenjiDevMap[b.boat] ?? 0,
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
              place2Score[self.boat] += winnerProb * (tpMap[self.boat] / othersTotal);
            }
          }
        }
      }
      if(!usedRemaining){
        for(const self of ranked){
          if(self.boat === winner.boat) continue;
          place2Score[self.boat] += winnerProb * (tpMap[self.boat] / othersTotal);
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
// 買い目生成・HTML表示の両方から参照する共通計算。
// 戻り値:
//   {
//     scenarioProb  : {boat: {kimari: 発生確率}},
//     scenarioPlace2: {boat: {kimari: [{boat, p2}]}},  // 正規化済み2着リスト（展示係数補正済み）
//     kimariTypes   : string[],
//     inn2Place     : object,
//     top3          : ranked2の上位3艇,
//     valid         : boolean  // MASTERなし等で計算不可の場合 false
//   }
//
// tenjiScoreMap: calcTenjiScore の戻り値（展示データなし時は null）
//   __coef_N（平均=1.0基準）を 2着確率の補正に使用。
//   null の場合は補正なし（係数=1.0 として扱う）。
//   補正強度は TENJI_P2_COEF_CLIP でクリップ（過補正防止）。
//
function calcScenarioData(ranked2, rawBoats, tenjiScoreMap, venueOverride, vdataOverride){
  if(!MASTER_EXT || !MASTER_EXT.venue_kimari){
    return { valid: false };
  }
  // venueOverride / vdataOverride が渡された場合はそちらを優先（過去日集計など DATA が当日以外のケース）
  const venue   = venueOverride || DATA?.venue;
  const vKimari = MASTER_EXT.venue_kimari[venue];
  if(!vKimari) return { valid: false };

  // inn_2place: inn_data に直接入っていれば使用、なければ venue_stats から取得
  const _vdata = vdataOverride || DATA;
  const inn2Place = (() => {
    const v = (_vdata?.inn_data || {}).inn_2place;
    if(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) return v;
    return MASTER_EXT?.venue_stats?.[venue]?.inn_2place || {};
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
    const vLocal = MASTER_EXT?.venue_stats?.[venue]?.tenkai_remaining;
    if(vLocal && typeof vLocal === 'object' && Object.keys(vLocal).length > 0) return vLocal;
    return MASTER_EXT?.tenkai_remaining || {};
  })();
  const winnerCO = MASTER_EXT?.winner_course_order || {};

  const scenarioPlace2 = {};
  for(const winner of ranked2){
    scenarioPlace2[winner.boat] = {};
    const wc = String(winner.boat);
    // final_prob（展示加味済み最終確率）ベースで他艇の合計を算出
    const othersTotal = ranked2
      .filter(r => r.boat !== winner.boat)
      .reduce((s, r) => s + (r.final_prob ?? r.tenkai_prob), 0) || 1;

    for(const kimari of kimariTypes){
      if(!(scenarioProb[winner.boat]?.[kimari] > 0)) continue;

      const useInn2 = (kimari === '逃げ' && winner.boat === 1 && Object.keys(inn2Place).length > 0);
      const remForThis = tenkaiRem[kimari]?.[wc] || null;

      const place2List = rawBoats
        .filter(b => b.boat !== winner.boat)
        .map(b => {
          const sc = String(b.boat);
          let p2;
          if(useInn2){
            const baseP2 = inn2Place[sc] ?? null;
            const personEntry2 = winnerCO[b.name]?.[sc]?.['1'];
            const personRate2  = personEntry2?.rate2 ?? null;
            const personTrust2 = personEntry2?.trust ?? 0;
            console.log(`[p2debug] ${b.name} ${sc}枠 baseP2:${baseP2?.toFixed(3)} personRate2:${personRate2} trust:${personTrust2} cond:${baseP2 != null && personRate2 != null && personTrust2 > 0.3}`);
            if(baseP2 != null && personRate2 != null && personTrust2 > 0.3){ // 他箇所と統一(count>=10相当)
              p2 = personRate2 * personTrust2 + baseP2 * (1 - personTrust2);
              console.log(`[p2debug] → 個人補正適用 p2:${p2.toFixed(3)}`);
            } else {
              p2 = baseP2;
              console.log(`[p2debug] → baseのみ p2:${p2?.toFixed(3)}`);
            }
            if(p2 == null){
              const bt = ranked2.find(r => r.boat === b.boat);
              p2 = bt ? (bt.final_prob ?? bt.tenkai_prob) / othersTotal : 0;
            }
          } else if(remForThis){
            const remEntry  = remForThis[sc];
            const baseTR    = remEntry?.rate2 ?? null;
            const trTrust   = remEntry?.trust ?? 0;
            const personEntry = winnerCO[b.name]?.[sc]?.[wc];
            const personRate2 = personEntry?.rate2 ?? null;
            const personTrust = personEntry?.trust ?? 0;
            if(baseTR != null && personRate2 != null && personTrust > 0.3){
              const wPerson = personTrust;
              const wNat    = (1 - personTrust);  // ② 修正: trTrust二重適用を排除
              const wTot    = wPerson + wNat;      // 常に1.0
              p2 = (personRate2 * wPerson + baseTR * wNat) / wTot;
            } else if(baseTR != null){
              p2 = baseTR;
            } else {
              const bt = ranked2.find(r => r.boat === b.boat);
              p2 = bt ? (bt.final_prob ?? bt.tenkai_prob) / othersTotal : 0;
            }
          } else {
            const bt = ranked2.find(r => r.boat === b.boat);
            p2 = bt ? (bt.final_prob ?? bt.tenkai_prob) / othersTotal : 0;
          }
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
      const TENJI_P2_CLIP_BY_COURSE = {
        1: [0.85, 1.20],  // イン有利、展示で大きく変動しない
        2: [0.80, 1.25],
        3: [0.70, 1.40],  // 差し・まくり差し主体、展示が効く
        4: [0.65, 1.45],  // まくり最多、展示差が2着にも直結
        5: [0.70, 1.40],
        6: [0.75, 1.35],
      };
      if(tenjiScoreMap){
        place2List.forEach(x => {
          const [lo, hi] = TENJI_P2_CLIP_BY_COURSE[x.boat] ?? [0.75, 1.35];
          const rawCoef = tenjiScoreMap[`__coef2_${x.boat}`] ?? tenjiScoreMap[`__coef_${x.boat}`] ?? 1.0;
          const coef    = Math.min(hi, Math.max(lo, rawCoef));
          x.p2 *= coef;
        });
      }

      const p2Sum = place2List.reduce((s, x) => s + x.p2, 0) || 1;
      place2List.forEach(x => { x.p2 = x.p2 / p2Sum; });
      place2List.sort((a, b) => b.p2 - a.p2);
      console.log(`[p2debug] 正規化後(winner:${winner.boat} ${kimari}):`, place2List.map(x => `${x.boat}枠:${(x.p2*100).toFixed(0)}%`));
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
      let r3;
      if(baseR3 != null && personR3 != null && personTrust > 0.3){
        // ①ベース＋個人両方あり
        // ② wNat修正: baseは常にフルウェイト、個人が上乗せ（trTrust二重適用を排除）
        const wPerson = personTrust;
        const wNat    = (1 - personTrust);   // 修正: trTrust * (1-personTrust) → (1-personTrust)
        const wTot    = wPerson + wNat;       // 常に1.0
        r3 = (personR3 * wPerson + baseR3 * wNat) / wTot;
      } else if(baseR3 != null){
        // ②ベースのみ
        r3 = baseR3;
      } else if(personR3 != null && personTrust > 0.3){
        // ③個人のみ（ベースなし）
        r3 = personR3;
      } else {
        // ④フォールバック: final_prob 相対比
        r3 = null;
      }

      const baseScore = r3 ?? ((b.final_prob ?? b.tenkai_prob ?? 0) / candidateTotal);

      const CLIP3_BY_COURSE = {
        1: [0.85, 1.20],
        2: [0.80, 1.25],
        3: [0.70, 1.40],
        4: [0.65, 1.45],
        5: [0.70, 1.40],
      };
      const tenjiCoef = tenjiScoreMap ? (tenjiScoreMap[`__coef3_${b.boat}`] ?? tenjiScoreMap[`__coef_${b.boat}`] ?? 1.0) : 1.0;
      const [c3lo, c3hi] = CLIP3_BY_COURSE[b.boat] ?? [0.75, 1.35];
      const clipped = Math.min(c3hi, Math.max(c3lo, tenjiCoef));
      // ① avgRank補正を最終スコアに乗算
      const score = baseScore * clipped * rankCoef;

      return { boat: b.boat, name: b.name, r3, score };
    });

  const scoreSum = result.reduce((s, x) => s + x.score, 0) || 1;
  result.forEach(x => { x.score = x.score / scoreSum; });
  result.sort((a, b) => b.score - a.score);
  return result;
}

//
