function arekClass(v){ return v < 45 ? 'arek-lo' : v < 65 ? 'arek-md' : 'arek-hi'; }
function arekLabel(v){ return v < 45 ? '安定' : v < 65 ? '中荒れ' : '大荒れ'; }

// 結果comboを正規化（区切り文字を統一）して比較用キーを作る
// ※ AI予想タブ・オッズタブなど複数の描画関数から共通利用するためトップレベルに配置
function normalizeCombo(s){ return (s||'').replace(/[－−\-]/g,'-'); }

// 艇番文字列（例: "1−2−3"）を color-circle バッジ列に変換
// ※ AI予想タブ・オッズタブなど複数の描画関数から共通利用するためトップレベルに配置
function comboToBadges(combo){
  return (combo || '').split(/([－−\-])/).map(part => {
    if (/^[－−\-]$/.test(part)) {
      return `<span style="color:var(--text3);font-size:13px;margin:0 1px;font-weight:400">−</span>`;
    }
    const n = part.trim();
    if (/^[1-6]$/.test(n)) {
      return `<span class="boat-circle b${n}" style="width:22px;height:22px;font-size:11px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${n}</span>`;
    }
    return part;
  }).join('');
}

// ── 期待値（EV）計算・フィルタリング共通ユーティリティ ──────────────
// AI予想タブ（attachEV）・EVフィルタータブ（buildEvFilterPanel）など、
// 「買い目 × オッズ」を扱う複数の描画関数から共通利用するためトップレベルに配置。
//
// 買い目オブジェクトのキー名は生成元によって異なる：
//   - renderer.js 内部生成（buy3list/buy2list 等）: { c: "1-2-3", prob: 0.255 }（確率は比率0-1）
//   - analyzer.js 由来の生データ                  : { pattern: "1-2-3", final_prob: 25.5 }（確率は%表記）
// options でキー名・確率表記(%/比率)を吸収できる汎用設計にしている。
// ※ 既存の attachEV / filterByEV はこのユーティリティに処理を委譲する形にリファクタ済み。

/**
 * 単一の買い目オブジェクトに odds（オッズ）と _ev（期待値）を付与した新しいオブジェクトを返す。
 * ピュア関数（引数のオブジェクトは変更せず、新規オブジェクトを返す）。
 * オッズが見つからない・不正な場合は _odds / _ev が null になるだけで、除外はしない
 * （除外まで行いたい場合は filterCombosByExpectedValue を使用する）。
 *
 * @param {Object} combo
 * @param {Object<string, number>} oddsData - 直前オッズ { パターン文字列: オッズ }
 * @param {Object} [options]
 * @param {string}   [options.patternKey='c']         買い目文字列のキー名
 * @param {string}   [options.probKey='prob']         確率のキー名
 * @param {boolean}  [options.probIsPercentage=false] 確率がパーセント表記(0-100)か比率(0-1)か
 * @param {function} [options.normalizeCombo]         オッズ参照前にパターン文字列を正規化する関数
 * @returns {Object} 元のcomboに _odds / _ev を加えた新しいオブジェクト
 */
function attachComboEV(combo, oddsData, options = {}) {
  const {
    patternKey = 'c',
    probKey = 'prob',
    probIsPercentage = false,
    normalizeCombo: normalizeFn = normalizeCombo,
  } = options;

  if (!combo || typeof combo !== 'object') {
    return { ...combo, _odds: null, _ev: null };
  }

  const patternRaw = combo[patternKey];
  const probRaw     = combo[probKey];

  const key  = typeof patternRaw === 'string' ? normalizeFn(patternRaw) : null;
  const odds = (key != null && oddsData && typeof oddsData === 'object') ? (oddsData[key] ?? null) : null;

  const validProb = typeof probRaw === 'number' && !Number.isNaN(probRaw);
  const validOdds = typeof odds === 'number' && !Number.isNaN(odds) && odds > 0;

  const probRatio = validProb ? (probIsPercentage ? probRaw / 100 : probRaw) : null;
  const ev = (validProb && validOdds) ? probRatio * odds : null;

  return {
    ...combo,
    _odds: validOdds ? odds : null,
    _ev:   ev != null ? Number(ev.toFixed(4)) : null,
  };
}

/**
 * 買い目配列にオッズ・期待値を付与するだけの関数（フィルタリングは行わない）。
 * 的中重視／回収重視モードのように EV 未達でも買い目自体は表示したい場合に使用する。
 * ピュア関数（combos 配列・各要素は変更しない）。
 */
function attachEVToCombos(combos, oddsData, options = {}) {
  if (!Array.isArray(combos)) return [];
  return combos.map(c => attachComboEV(c, oddsData, options));
}

/**
 * 買い目配列を期待値（EV）でフィルタリングするピュア関数。
 *
 *   期待値(EV) = 的中確率（比率） × オッズ
 *
 * オッズ未取得（特払い・欠場・データ欠損など）の買い目は、安全のため必ず除外する。
 * 既存データ・処理を破壊しない（combos・oddsData はコピーして使うのみで書き換えない）。
 *
 * @param {Array<Object>} combos              - 買い目配列
 * @param {Object<string, number>} oddsData   - 直前オッズ { パターン文字列: オッズ }
 * @param {number} [threshold=1.10]           - 採用する期待値の下限（この値以上を採用）
 * @param {Object} [options]                  - attachComboEV と同じオプション
 *   @param {string}   [options.patternKey='c']
 *   @param {string}   [options.probKey='prob']
 *   @param {boolean}  [options.probIsPercentage=false]
 *   @param {function} [options.normalizeCombo]
 * @returns {Array<Object>} EV >= threshold の買い目配列（_odds, _ev 付与済み、EV降順ソート）
 * @throws {TypeError} combos/oddsData/threshold の型が不正な場合
 */
function filterCombosByExpectedValue(combos, oddsData, threshold = 1.10, options = {}) {
  if (!Array.isArray(combos)) {
    throw new TypeError('filterCombosByExpectedValue: combos は配列である必要があります。');
  }
  if (typeof oddsData !== 'object' || oddsData === null) {
    throw new TypeError('filterCombosByExpectedValue: oddsData はオブジェクトである必要があります。');
  }
  if (typeof threshold !== 'number' || Number.isNaN(threshold)) {
    throw new TypeError('filterCombosByExpectedValue: threshold は数値である必要があります。');
  }

  return attachEVToCombos(combos, oddsData, options)
    .filter(c => c._ev != null && c._ev >= threshold)
    .sort((a, b) => b._ev - a._ev);
}

function weightDots(w, max=3){
  let s='';
  for(let i=0;i<max;i++) s+=`<span class="wdot${i<w?'':' empty'}"></span>`;
  return `<div class="buy-weight">${s}</div>`;
}
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
const _commentCache = {};
(function(){
  if (typeof COMMENT_DATA === 'undefined') return;
  for(const [key, val] of Object.entries(COMMENT_DATA)){
    const normalized = key.replace(/_(\d{4})(\d{2})(\d{2})_/, '_$1-$2-$3_');
    _commentCache[normalized] = val;
  }
})();
function commentKey(venue, date, race){ return `${venue}_${date}_${race}`; }

const COMMENT_KEYWORDS_GOOD = ['調子いい','足がいい','足は良','仕上がって','自信','乗れてる','感触いい','良さそう','行ける','自信あり'];
const COMMENT_KEYWORDS_BAD  = ['エンジンに力','力がない','届かない','失敗','苦しい','厳しい','遅い','差ない','出し切れ','整備'];

function highlightComment(text){
  if(!text) return '<span class="comment-empty">コメントなし</span>';
  let t = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  COMMENT_KEYWORDS_GOOD.forEach(kw=>{ t = t.replaceAll(kw, `<span class="comment-keyword good">${kw}</span>`); });
  COMMENT_KEYWORDS_BAD.forEach(kw=>{  t = t.replaceAll(kw, `<span class="comment-keyword bad">${kw}</span>`); });
  return t;
}

// ── モーター情報セクション（コメントタブ用）──
//
// データソース優先順位:
//   1. _tenjiCache[key][frameNo].motor_rate2 / motor_no / prev_user  ← 展示取得済み
//   2. boats[].motor2 / motor_no / prev_user                         ← CSV埋め込み値
//
// M2率順位は当該レースの6艇間で算出（同率は同順位）。
//
function buildMotorInfoSection(rno, boats){
  _ensureTenjiCache();
  const slug2  = VENUE_SLUG_MAP[DATA.venue] || DATA.venue;
  const key2   = tenjiKey(slug2, DATA.date, rno);
  const cached2 = _tenjiCache[key2];

  // 各艇のモーター情報をマージ（展示キャッシュ優先、なければboatsのフィールドを使用）
  const motorRows = boats.map(bt => {
    const td = cached2 ? cached2[String(bt.boat)] : null;
    return {
      boat:       bt.boat,
      name:       bt.name,
      motor_no:   td?.__motor_no   ?? td?.motor_no   ?? bt.motor_no   ?? null,
      motor2:     (td?.__motor_rate2 != null) ? td.__motor_rate2
                  : (td?.motor_rate2 != null) ? td.motor_rate2
                  : (bt.motor2 != null)       ? bt.motor2
                  : null,
      motor_rank: td?.__motor_rank ?? td?.motor_rank ?? bt.motor_rank ?? null,
      prev_user:  td?.__prev_user  ?? td?.prev_user  ?? bt.prev_user  ?? null,
    };
  });

  // M2率順位:
  //   サイト取得値(motor_rank)があればそちらをそのまま使用。
  //   なければ当該レースの6艇のM2率で降順ランクを計算（同率同順位）。
  const hasSiteRank = motorRows.some(r => r.motor_rank != null);
  const rankMap = {};
  if(hasSiteRank){
    motorRows.forEach(r => { rankMap[r.boat] = r.motor_rank; });
  } else {
    const sorted2 = [...motorRows]
      .filter(r => r.motor2 != null)
      .sort((a, b) => b.motor2 - a.motor2);
    sorted2.forEach((r, i) => {
      rankMap[r.boat] = (i > 0 && r.motor2 === sorted2[i-1].motor2)
        ? rankMap[sorted2[i-1].boat]
        : i + 1;
    });
  }

  const hasAny = motorRows.some(r => r.motor2 != null || r.motor_no != null || r.prev_user != null);
  if(!hasAny) return '';

  // 順位バッジ色（1位→金, 2位→銀, 3位→銅）
  function rankBadge(rank){
    if(rank == null) return '<span style="color:var(--text3);font-size:11px">—</span>';
    const colors = {1:'#e6a800',2:'#7a8a99',3:'#a0672a'};
    const c = colors[rank] || 'var(--text3)';
    return `<span style="font-size:11px;font-weight:700;color:${c}">${rank}位</span>`;
  }

  function m2Color(v){
    if(v == null) return 'var(--text3)';
    return v >= 40 ? 'var(--green)' : v >= 25 ? 'var(--orange)' : 'var(--red)';
  }

  const rows = motorRows.map(r => {
    const rank   = rankMap[r.boat] ?? null;
    const m2disp = r.motor2 != null
      ? `<span style="font-family:var(--mono);font-weight:700;color:${m2Color(r.motor2)}">${r.motor2.toFixed(1)}%</span>`
      : '<span style="color:var(--text3)">—</span>';
    const monoDisp = r.motor_no != null
      ? `<span style="font-size:10px;color:var(--text3);font-family:var(--mono)">#${r.motor_no}</span>`
      : '';
    const prevDisp = r.prev_user
      ? `<span style="font-size:11px;color:var(--text2)">${r.prev_user}</span>`
      : `<span style="font-size:11px;color:var(--text3)">—</span>`;

    return `<div style="display:grid;grid-template-columns:28px 1fr 52px 36px 1fr;gap:4px 8px;align-items:center;padding:0.4rem 1rem;border-bottom:1px solid var(--border)">
      <span class="boat-circle b${r.boat}" style="width:22px;height:22px;font-size:11px;line-height:22px;display:inline-flex;align-items:center;justify-content:center">${r.boat}</span>
      <div style="min-width:0">
        <div style="font-size:12px;font-weight:600;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.name}</div>
        ${monoDisp ? `<div style="margin-top:1px">${monoDisp}</div>` : ''}
      </div>
      <div style="text-align:center">${m2disp}</div>
      <div style="text-align:center">${rankBadge(rank)}</div>
      <div>${prevDisp}</div>
    </div>`;
  }).join('');

  return `<div style="border-bottom:1px solid var(--border)">
    <div style="display:grid;grid-template-columns:28px 1fr 52px 36px 1fr;gap:4px 8px;align-items:center;padding:0.35rem 1rem;background:var(--bg3);border-bottom:1px solid var(--border)">
      <span></span>
      <span style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--text3)">🔧 モーター</span>
      <span style="font-size:10px;color:var(--text3);text-align:center">M2率</span>
      <span style="font-size:10px;color:var(--text3);text-align:center">順位</span>
      <span style="font-size:10px;color:var(--text3)">前節使用者</span>
    </div>
    ${rows}
  </div>`;
}

function buildCommentSection(rno, boats){
  _ensureTenjiCache();
  const slug = VENUE_SLUG_MAP[DATA.venue] || DATA.venue;
  const key  = `${slug}_${DATA.date}_${rno}`;

  // COMMENT_DATAに実データがあればそちらを使用
  const cached = _commentCache[key];
  if(cached){
    const rows = boats.map(bt => {
      const entry = cached[bt.boat] || cached[String(bt.boat)] || {};
      return `<div class="comment-row">
        <span class="boat-circle b${bt.boat}" style="width:22px;height:22px;font-size:11px;line-height:22px;display:inline-flex;align-items:center;justify-content:center">${bt.boat}</span>
        <span class="comment-name">${bt.name}</span>
        <span class="comment-text">${highlightComment(entry.comment||'')}</span>
      </div>`;
    }).join('');
    const fetched = cached['__fetched_at'] || '';
    return `<div class="comment-section">
      <div class="comment-title">選手コメント <span class="comment-badge">取得済み${fetched?' '+fetched:''}</span></div>
      ${rows}
    </div>`;
  }

  // データなし → コメントなし表示
  const rows = boats.map(bt => `
    <div class="comment-row">
      <span class="boat-circle b${bt.boat}" style="width:22px;height:22px;font-size:11px;line-height:22px;display:inline-flex;align-items:center;justify-content:center">${bt.boat}</span>
      <span class="comment-name">${bt.name}</span>
      <span class="comment-empty">コメントなし</span>
    </div>`).join('');
  return `<div class="comment-section">
    <div class="comment-title">選手コメント <span class="comment-badge waiting">未取得</span></div>
    ${rows}
  </div>`;
}

// ── F回数取得（列表示用）──
// FLYING_DATA[会場][レースno文字列] = [{waku, name, flying, f_total}, ...]
function getFTotal(boatNo, rno){
  if(!DATA || !currentVenue) return 0;
  const raceMap = (FLYING_DATA[currentVenue] || {})[String(rno)] || [];
  const rec = raceMap.find(r => String(r.waku) === String(boatNo));
  return rec ? (rec.f_total || 1) : 0;
}

// ── 決まり手テーブル（選手情報タブ用）──
//
// 表示仕様:
//   コース1号艇: 逃げ（kimari） + 差され／捲られ／捲り差され（被kimari）
//   コース2〜6 : 逃げ（2コースのみ）＋ 差し／まくり／まくり差し（kimari）
//
// カラー:
//   高率（≥40%) → var(--green) / 中率（≥15%） → var(--orange) / 低率 → (standard)
//   まくり差し（被）のカラムは「まくり差し」
//
function buildKimariTable(boats){
  if(!MASTER_EXT?.course_master) return '';

  // データがひとつでも存在するか確認
  const hasAny = boats.some(bt => {
    const cm = getCourseMaster(bt.name, String(bt.boat));
    return cm?.kimari || cm?.['被kimari'];
  });
  if(!hasAny) return '';

  // パーセント表示ヘルパー（小数 → %文字列）
  function pct(v){ return v != null ? Math.round(v * 100) + '%' : '—'; }

  // カラー計算（高 / 中 / 低）
  function kimariColor(v){
    if(v == null) return 'var(--text3)';
    if(v >= 0.40) return 'var(--green)';
    if(v >= 0.15) return 'var(--orange)';
    return 'var(--text)';
  }

  // 被kimariカラー（差される側なので高いほど危険→赤系）
  function hiColor(v){
    if(v == null) return 'var(--text3)';
    if(v >= 0.25) return 'var(--red, #e53935)';
    if(v >= 0.10) return 'var(--orange)';
    return 'var(--text)';
  }

  // ── グリッドレイアウト定数 ──
  // 枠26px | 選手名(flex-grow) | 逃げ44px | 差し44px | まくり44px | まくり差44px
  const GRID = '26px 1fr 44px 44px 44px 44px';

  // ヘッダーラベル（「まくり差し」→「まくり差」で1文字削減して収まりを改善）
  const headerCols = ['', '選手', '逃げ', '差し', 'まくり', 'まくり差'];
  const headerHtml = headerCols.map((h, i) => {
    const align = i >= 2 ? 'center' : (i === 1 ? 'left' : 'center');
    return `<span style="font-size:10px;font-weight:700;color:var(--text3);text-align:${align};white-space:nowrap;letter-spacing:-.02em;">${h}</span>`;
  }).join('');

  // 値セルHTML生成ヘルパー
  // color は文字列（CSSカラー）を直接受け取る
  function valCell(v, color){
    const fw = v != null && v >= 0.15 ? '700' : '400';
    return `<span style="font-size:11px;font-family:var(--mono);font-weight:${fw};color:${color};text-align:center;">${pct(v)}</span>`;
  }

  // ── データ行 ──
  const rowsHtml = boats.map(bt => {
    const c  = String(bt.boat);
    const cm = getCourseMaster(bt.name, c);
    const k  = cm?.kimari      || {};
    const hk = cm?.['被kimari'] || {};

    const isBoat1 = bt.boat === 1;

    // 逃げ: 1号艇のみ（kimari['逃げ']）
    const nigeVal = isBoat1 ? (k['逃げ'] ?? null) : null;

    // 差し列: 1号艇→被差され率、2〜6→差し率
    const sashiVal  = isBoat1 ? (hk['差され']  ?? null) : (k['差し']  ?? null);

    // まくり列: 1号艇→被捲られ率、2〜6→まくり率
    const makuriVal = isBoat1 ? (hk['捲られ']  ?? null) : (k['まくり'] ?? null);

    // まくり差し列: 1号艇→被捲り差され率、2号艇→null、3〜6→まくり差し率
    const mkSashiVal = isBoat1
      ? (hk['捲り差され'] ?? null)
      : (bt.boat === 2 ? null : (k['まくり差し'] ?? null));

    // 色を事前に文字列として解決しておく
    const nigeColor    = kimariColor(nigeVal);
    const sashiColor   = isBoat1 ? hiColor(sashiVal)   : kimariColor(sashiVal);
    const makuriColor  = isBoat1 ? hiColor(makuriVal)  : kimariColor(makuriVal);
    const mkSashiColor = isBoat1 ? hiColor(mkSashiVal) : kimariColor(mkSashiVal);

    const rowBg = isBoat1 ? 'background:rgba(255,102,0,0.04);' : '';

    return `<div style="display:grid;grid-template-columns:${GRID};gap:0 6px;align-items:center;padding:5px 10px;border-top:1px solid var(--border);${rowBg}">
      <span class="boat-circle b${bt.boat}" style="width:22px;height:22px;font-size:11px;display:inline-flex;align-items:center;justify-content:center;">${bt.boat}</span>
      <span style="font-size:11px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;">${bt.name}</span>
      ${valCell(nigeVal,    nigeColor)}
      ${valCell(sashiVal,   sashiColor)}
      ${valCell(makuriVal,  makuriColor)}
      ${valCell(mkSashiVal, mkSashiColor)}
    </div>`;
  }).join('');

  return `
    <div style="border-bottom:1px solid var(--border);">
      <div style="padding:3px 10px 0;display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
        <span style="font-size:10px;font-weight:700;color:var(--text3);letter-spacing:.04em;">🏁 決まり手（過去1年）</span>
        <span style="font-size:9px;color:var(--text3);">枠番コース実績</span>
        <span style="margin-left:auto;font-size:9px;color:var(--text3);">①の差し〜まくり差欄は被決まり手</span>
      </div>
      <div style="display:grid;grid-template-columns:${GRID};gap:0 6px;align-items:center;padding:5px 10px 4px;background:var(--bg3);border-bottom:1px solid var(--border);border-top:1px solid var(--border);margin-top:3px;">
        ${headerHtml}
      </div>
      <div style="padding:0 0 2px;">
        ${rowsHtml}
      </div>
    </div>
  `;
}

// ── renderDetail ──
function renderDetail(rno){
  const rd = DATA.races[String(rno)];
  if(!rd) return;

  // ── キャッシュヒット確認（改善①）──
  if (DATA && currentVenue) {
    const _ck = _renderCacheKey(rno);
    const _cached = _renderCache[_ck];
    if (_cached && _cached.detail) {
      document.getElementById('inline-detail').innerHTML = _cached.detail;
      updatePersistentBanners(rno);
      return;
    }
  }
  const boats = [...rd.boats].sort((a,b)=>a.boat-b.boat);
  const tenjiHtml = buildTenjiSection(rno, boats);


  // グリッド列: 枠26px 選手名80px(7文字対応・折り返し防止) 登番24px 級26px F列18px 基準1着率42px 3連対率44px ST順40px
  // [選手名折り返し対応] 7文字まで1行に収まるよう選手名列を拡張し、他列を詰めて吸収
  const colStyle = 'grid-template-columns: 26px 80px 24px 26px 18px 42px 44px 40px; column-gap:3px';
  const headFont = 'font-size:10px;white-space:nowrap;letter-spacing:0';

  // バナーをタブ外の常時表示エリアに更新
  updatePersistentBanners(rno);

  const html = `
    <div class="detail-panel">
      <div class="bt-head-simple" style="${colStyle}">
        <span style="${headFont}">枠</span><span style="text-align:center;${headFont}">選手名</span><span style="text-align:center;${headFont}">登番</span><span style="${headFont}">級</span><span style="text-align:center;${headFont}">F</span><span style="text-align:center;${headFont}">1着率</span><span style="text-align:center;${headFont}">3連対率</span><span style="text-align:center;${headFont}">平均ST順</span>
      </div>
      ${boats.map((bt,i)=>{
        const fTotal = getFTotal(bt.boat, rno);
        const fCell = fTotal > 0
          ? `<span style="color:#e60012;font-weight:700;font-size:13px;display:block;text-align:center">${fTotal}</span>`
          : `<span style="color:var(--text3);font-size:11px;display:block;text-align:center">—</span>`;
        const course = String(bt.boat);
        const stRank = getCourseMaster(bt.name, course)?.st_rank;
        const stCell = stRank != null
          ? `<span style="display:block;text-align:center;font-size:12px">${stRank.toFixed(1)}</span>`
          : `<span style="color:var(--text3);font-size:11px;display:block;text-align:center">—</span>`;
        const ap3 = MASTER_EXT?.player_index?.[bt.name]?.annual_place3;
        const place3Cell = ap3 != null
          ? `<span style="display:block;text-align:center;font-size:12px;color:var(--text)">${(ap3*100).toFixed(1)}%</span>`
          : `<span style="color:var(--text3);font-size:11px;display:block;text-align:center">—</span>`;
        // 登番（PLAYER_ID_MAP: 選手名→登番 の逆引き / player_id_map.json から構築）
        const toban = (typeof PLAYER_ID_MAP !== 'undefined' && PLAYER_ID_MAP[bt.name]) || '';
        const tobanCell = toban
          ? `<span style="display:block;text-align:center;font-size:9px;color:var(--text3)">${toban}</span>`
          : `<span style="color:var(--text3);font-size:9px;display:block;text-align:center">—</span>`;
        return `
        <div class="bt-row${i===0?' top1':''}" style="${colStyle}">
          <span class="boat-circle b${bt.boat}" style="justify-self:center;width:22px;height:22px;font-size:11px;line-height:22px;display:inline-flex;align-items:center;justify-content:center">${bt.boat}</span>
          <div style="text-align:center;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${bt.name}</div>
          <div>${tobanCell}</div>
          <div style="text-align:center" class="bt-grade">${bt.grade ?? '-'}</div>
          <div>${fCell}</div>
          <div style="display:flex;flex-direction:column;align-items:center;gap:1px">
            <span>${(()=>{ const wr = getCourseMaster(bt.name, String(bt.boat))?.win_rate; return wr != null ? (wr*100).toFixed(1)+'%' : '<span style="color:var(--text3);font-size:11px">—</span>'; })()}</span>
          </div>
          <div>${place3Cell}</div>
          <div>${stCell}</div>
        </div>`;
      }).join('')}
      ${tenjiHtml}
    </div>
  `;
  // ── 展開シミュボタンをパネル下部に追加 ──
  const simBtnHtml = `<button
    onclick="openSimModal(${rno})"
    style="display:block;width:100%;padding:11px 16px;
      background:rgba(0,102,255,0.06);border:none;
      border-top:1px solid var(--border);
      color:var(--accent2);font-size:13px;font-weight:700;
      cursor:pointer;letter-spacing:0.05em;transition:background 0.15s;"
    onmouseover="this.style.background='rgba(0,102,255,0.12)'"
    onmouseout="this.style.background='rgba(0,102,255,0.06)'"
  >⚡ 展開シミュ</button>`;
  document.getElementById('inline-detail').innerHTML = html + simBtnHtml;

  // ── キャッシュ保存（改善①）──
  if (DATA && currentVenue) {
    const _ck = _renderCacheKey(rno);
    if (!_renderCache[_ck]) _renderCache[_ck] = {};
    _renderCache[_ck].detail = html + simBtnHtml;
  }
}

// ── 展開推定（1着率のみ）── 【刷新版: ゼロサム相対評価モデル】
//
// 【設計思想】
//   6艇を1つのレース空間として扱い、100%のパイを奪い合う相対評価モデル。
//   従来の「掛け算連鎖 → 正規化」を廃止し、以下の手順で算出する:
//
//   1. 各艇の「コース決まり手適性スコア」を個人実績で計算（独立）
//      → 決まり手ごとに「その艇が勝てる確率の重み」を正規化して配分
//   2. 被kimari（1コース崩れやすさ）は scenarioVKimari の事前分布として
//      calcScenarioData 側でのみ使用し、ここでは二重計上しない
//   3. 全艇分の適性スコアを合計→正規化 で tenkai_prob が常にΣ=1.0を保証
//
// MASTER_EXT なし → prob をそのまま tenkai_prob にコピーして返す
// MASTER_EXT あり → ゼロサム相対分配モデルを適用
//
// 恵まれ（転覆等による繰り上がり）は予測不可のため除外。
//
function buildScenarioSection(ranked2, place2Map, rawBoats, tenjiScoreMap, hasTenji){
  const sd = calcScenarioData(ranked2, rawBoats, tenjiScoreMap);
  if(!sd.valid) return '';

  const { scenarioProb, scenarioPlace2, kimariTypes, merged3rdMap } = sd;

  const boatCircle = (n) =>
    `<span class="boat-circle b${n}" style="width:20px;height:20px;font-size:10px;line-height:20px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${n}</span>`;

  // ── 艇ごとに全決まり手の確率を合算し、全艇分を選出 ──
  // 各艇の「代表決まり手」= その艇のscenarioProbが最大のkimari
  // 右端合計 = final_prob と一致する
  // [2026-07-08 修正] 上位3艇のみの表示から全艇表示に変更（.slice(0, 3)を撤廃）
  const top3Scenarios = ranked2
    .filter(winner => {
      const total = kimariTypes.reduce((s, k) => s + (scenarioProb[winner.boat]?.[k] ?? 0), 0);
      return total > 0.001;
    })
    .map(winner => {
      // 代表決まり手: このwinner艇でscenarioProbが最大のkimari
      let bestKimari = kimariTypes[0];
      let bestProb = 0;
      for(const k of kimariTypes){
        const p = scenarioProb[winner.boat]?.[k] ?? 0;
        if(p > bestProb){ bestProb = p; bestKimari = k; }
      }
      return { boat: winner.boat, name: winner.name, final_prob: winner.final_prob, kimari: bestKimari, prob: bestProb };
    });

  if(top3Scenarios.length === 0) return '';

  // ── 艇ごとに全決まり手をscenariosに格納（2着・3着の加重平均に全kimariを使う）──
  // totalProb = final_prob と一致する
  const boatGroups = new Map();
  for(const sc of top3Scenarios){
    // 全kimariをscenariosに追加
    const allScens = kimariTypes
      .map(k => ({ kimari: k, prob: scenarioProb[sc.boat]?.[k] ?? 0, place2List: scenarioPlace2[sc.boat]?.[k] || [] }))
      .filter(x => x.prob > 0.001);
    boatGroups.set(sc.boat, {
      boat: sc.boat,
      name: sc.name,
      bestKimari: sc.kimari,  // 代表決まり手（バッジ表示用）
      scenarios: allScens,
    });
  }

  // グループを合計確率の降順でソート
  const groupList = [...boatGroups.values()]
    .sort((a, b) =>
      b.scenarios.reduce((s, x) => s + x.prob, 0) -
      a.scenarios.reduce((s, x) => s + x.prob, 0)
    );

  // 決まり手→カラー
  const KIMARI_COLOR = {
    '逃げ': 'var(--accent2)', '差し': 'var(--green)',
    'まくり': 'var(--red)', 'まくり差し': 'var(--orange)', '抜き': 'var(--text3)'
  };
  const KIMARI_BG = {
    '逃げ': 'rgba(0,102,255,.1)', '差し': 'rgba(0,184,107,.1)',
    'まくり': 'rgba(255,59,59,.1)', 'まくり差し': 'rgba(255,122,0,.1)', '抜き': 'rgba(108,122,148,.1)'
  };

  const scenarioBlocks = groupList.map((grp) => {
    const totalProb = grp.scenarios.reduce((s, x) => s + x.prob, 0);
    const isMulti = true; // 全kimariを加重平均するため常にtrue

    // ── 2着確率を加重平均で合算 ──
    // 各シナリオの place2List を prob で重み付けして同一艇番ごとに合算し正規化する
    const mergedP2Map = {}; // boat番号 → { boat, name, p2sum }
    for(const scen of grp.scenarios){
      const w = scen.prob / (totalProb || 1); // シナリオ重み（合計1.0）
      for(const item of scen.place2List){
        if(!mergedP2Map[item.boat]){
          mergedP2Map[item.boat] = { boat: item.boat, name: item.name, p2sum: 0 };
        }
        mergedP2Map[item.boat].p2sum += item.p2 * w;
      }
    }
    // p2sum を正規化（合計が1.0になるよう）
    const p2Total = Object.values(mergedP2Map).reduce((s, x) => s + x.p2sum, 0) || 1;
    const mergedPlace2 = Object.values(mergedP2Map)
      .map(x => ({ boat: x.boat, name: x.name, p2: x.p2sum / p2Total }))
      .sort((a, b) => b.p2 - a.p2);

    const top4Place = mergedPlace2.slice(0, 4);

    // 各2着候補の行を生成
    const p2Lines = top4Place.map(item => {
      const third3     = merged3rdMap[grp.boat]?.[item.boat] || [];
      // ── 3着率は merged3rdMap 格納時に正規化済みの normPct を使う ──
      const third3html = third3.map(t3 => {
        return `<span style="display:inline-flex;align-items:center;gap:2px;white-space:nowrap">
          ${boatCircle(t3.boat)}
          <span style="font-size:11px;font-family:var(--mono);color:var(--text)">${t3.normPct ?? 0}%</span>
        </span>`;
      }).join('<span style="color:var(--text3);margin:0 3px;font-size:11px">/</span>');

      return `<div style="padding:4px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          <span style="font-size:11px;color:var(--text3);flex-shrink:0">2着</span>
          ${boatCircle(item.boat)}
          <span style="font-size:11px;font-family:var(--mono);font-weight:600;color:var(--text);min-width:2.8em">${(item.p2*100).toFixed(0)}%</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding-left:4px">
          <span style="font-size:11px;color:var(--text3);flex-shrink:0">└ 3着</span>
          ${third3html}
        </div>
      </div>`;
    }).join('');

    // ── ヘッダー部分: 確率上位2つの決まり手バッジを表示 ──
    const topKimaris = grp.scenarios
      .slice()
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 2);
    const kimariBadges = topKimaris.map(s => {
      const kColor = KIMARI_COLOR[s.kimari] || 'var(--accent2)';
      const kBg    = KIMARI_BG[s.kimari]    || 'rgba(108,122,148,.1)';
      return `<span style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;background:${kBg};color:${kColor};flex-shrink:0">${s.kimari}<span style="font-weight:400;font-size:10px;margin-left:3px">${(s.prob*100).toFixed(1)}%</span></span>`;
    }).join('');

    return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap">
        ${boatCircle(grp.boat)}
        <span style="font-size:13px;font-weight:700;flex-shrink:0">${grp.name}</span>
        ${kimariBadges}
        <span style="font-size:13px;font-family:var(--mono);font-weight:700;color:var(--text);margin-left:auto;flex-shrink:0">${(totalProb*100).toFixed(1)}%</span>
      </div>
      <div style="padding-left:4px">${p2Lines}</div>
    </div>`;
  }).join('');

  const tenjiBadge = hasTenji
    ? `<span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;background:rgba(0,102,255,.12);color:var(--accent2);margin-left:8px;vertical-align:middle">展示情報込み</span>`
    : '';

  // ── 住之江: 軸候補・切り候補バッジ ──
  let suminoePivotBadges = '';
  if (hasTenji && tenjiScoreMap && tenjiScoreMap.__isSuminoe) {
    const pivotBoats = []; // diffプラス大 = 軸候補
    const cutBoats   = []; // diffマイナス大 = 切り候補
    ranked2.forEach(b => {
      const diff = tenjiScoreMap[`__diff_${b.boat}`];
      if (diff == null) return;
      if (diff >= 0.40)  pivotBoats.push({ boat: b.boat, diff });
      if (diff <= -0.40) cutBoats.push({ boat: b.boat, diff });
    });
    pivotBoats.sort((a, b) => b.diff - a.diff);
    cutBoats.sort((a, b) => a.diff - b.diff);

    const boatCircleS = n =>
      `<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:10px;font-weight:700;background:var(--boat${n}-bg,#333);color:var(--boat${n}-fg,#fff)">${n}</span>`;

    if (pivotBoats.length > 0) {
      const circles = pivotBoats.map(x => boatCircleS(x.boat)).join('');
      suminoePivotBadges += `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;padding:2px 8px 2px 6px;border-radius:4px;background:rgba(0,184,107,.13);color:var(--green);">軸${circles}</span>`;
    }
    if (cutBoats.length > 0) {
      const circles = cutBoats.map(x => boatCircleS(x.boat)).join('');
      suminoePivotBadges += `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;padding:2px 8px 2px 6px;border-radius:4px;background:rgba(255,59,59,.10);color:var(--red);margin-left:4px">切${circles}</span>`;
    }
  }

  return `<div style="padding:0.75rem 1.25rem;border-bottom:1px solid var(--border)">
    <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin-bottom:${suminoePivotBadges ? '6px' : '10px'}">展開シナリオ${tenjiBadge}</div>
    ${suminoePivotBadges ? `<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:10px">${suminoePivotBadges}</div>` : ''}
    ${scenarioBlocks}
  </div>`;
}

// ── renderBuy ──
function renderBuy(rno){
  // ★★★ 修正⑤: MASTER_EXT がロードされるまで待機（最大500ms×3回）★★★
  if (!MASTER_EXT || !MASTER_EXT.venue_kimari) {
    if (!_renderBuyRetry) {
      _renderBuyRetry = true;
      console.log('[renderBuy] MASTER_EXT 未ロード → 300ms後に再試行');
      setTimeout(() => {
        _renderBuyRetry = false;
        renderBuy(rno);
      }, 300);
      return;
    }
    // 2回目以降はフォールバックで続行（無限ループ防止）
    console.warn('[renderBuy] MASTER_EXT 未ロードのまま強行（2回目）');
  }

  // ★★★ 修正⑦: データ事前解決（スナップショットを取得）★★★
  const _masterSnapshot = MASTER_EXT ? JSON.parse(JSON.stringify(MASTER_EXT)) : null;
  const _venueKimariSnapshot = _masterSnapshot?.venue_kimari?.[DATA.venue] || null;
  const _innDataSnapshot = DATA.inn_data ? JSON.parse(JSON.stringify(DATA.inn_data)) : null;

  _ensureTenjiCache();
  const rd = DATA.races[String(rno)];
  if(!rd) return;

  // ── キャッシュヒット確認（改善①）──
  if (DATA && currentVenue) {
    const _ck = _renderCacheKey(rno);
    const _cached = _renderCache[_ck];
    if (_cached && _cached.buy && _cached.detail2 && _cached._ver === _RENDER_CACHE_VER) {
      const _buyEl     = document.getElementById('buy-panel');
      const _detail2El = document.getElementById('detail2-panel');
      if (_buyEl)     _buyEl.innerHTML     = _cached.buy;
      if (_detail2El) _detail2El.innerHTML = _cached.detail2;
      const _scenEl = document.getElementById('buy-mode-scen');
      if (_scenEl) _scenEl.style.display = 'block';
      updatePersistentBanners(rno);
      return;
    }
  }

  const arek     = rd.arek ?? 54.7;
  const rawBoats = rd.boats;

  // ── 買い目点数上限（betting_optimizer による推奨点数）──
  // opt_points が埋め込まれていればそれを使用、なければ 10点（デフォルト）
  // ※ 要注意会場（大村・宮島・福岡・丸亀）は最大7点で返ってくるため 0 は存在しない
  // 見送り推奨（pass_reason あり）でも買い目は参考表示するため上限は10点固定
  // 通常パターンは buyMode 別に opt_points_hit/rec を参照
  const _optHit  = rd.opt_points_hit != null ? rd.opt_points_hit : (rd.opt_points != null ? rd.opt_points : 10);
  const _optRec  = rd.opt_points_rec != null ? rd.opt_points_rec : (rd.opt_points != null ? rd.opt_points : 10);
  const _passHit = rd.opt_pass_reason_hit || '';
  const _passRec = rd.opt_pass_reason_rec || '';
  const BUY_MAX_POINTS_HIT = _passHit ? 10 : (_optHit > 0 ? _optHit : 10);
  const BUY_MAX_POINTS_REC = _passRec ? 10 : (_optRec > 0 ? _optRec : 10);
  const BUY_MAX_POINTS = BUY_MAX_POINTS_HIT; // 後方互換（buildBuy3ForMode のクロージャ参照用）

  // ─ STEP1: 1着率計算（venue_kimari × prob × 個人kimari適性）
  // [拡張] スリット隊形・展示タイム・気象補正を加えた拡張版を使用
  // tenjiData は後続 STEP2 で定義されるが、ここでは先に取得して渡す
  const _slug_ext  = VENUE_SLUG_MAP[DATA.venue] || DATA.venue;
  const _tKey_ext  = tenjiKey(_slug_ext, DATA.date, rno);
  const _tData_ext = _tenjiCache[_tKey_ext] || null;

  // ★★★ 修正⑦: 解決済みデータを明示的に渡す ★★★
  const ranked = calcTenkaiProbsExtended(
    rawBoats,
    arek,
    _tData_ext,
    DATA.venue,
    {
      masterExt: _masterSnapshot,
      venueKimari: _venueKimariSnapshot,
      innData: _innDataSnapshot,
    }
  );

  // ─ STEP2: 3スコア独立計算 → 加重合成（base:50% / tenkai:30% / tenji:20%）──
  //
  // 【変更点】
  //   旧: tenkai_prob に展示係数を連鎖乗算 → 二重加点/二重減点が発生していた
  //   新: 基準prob・相対補正スコア・展示スコアをそれぞれ独立計算し加算合成
  //       各スコアは互いを参照しない
  //
  const slug      = VENUE_SLUG_MAP[DATA.venue] || DATA.venue;
  const tKey      = tenjiKey(slug, DATA.date, rno);
  const tenjiData = _tenjiCache[tKey] || null;
  const hasTenji  = !!tenjiData;

  // 展示独立スコアを取得（展示データがある場合のみ）
  let tenjiScoreMap = null;
  if(hasTenji){
    tenjiScoreMap = calcTenjiScore(ranked, tenjiData, DATA.venue, arek);
  }

  // ── STEP2: 指数重み方式で最終確率を計算 ──
  //
  //   final_prob ∝ baseNorm^wBase × tenkaiCoef^wTenkai × tenjiCoef^wTenji
  //
  //   FINAL_PROB_WEIGHTS の各値がべき乗の指数として機能する。
  //   weight=1.0 → 素の乗算と同じ挙動
  //   weight=2.0 → その指標の影響を2倍強く効かせる
  //   weight=0.0 → その指標を完全に無効化（係数が何であっても1.0扱い）
  //
  //   展示データなし時: tenjiCoef=1.0 のため wTenji の値に関わらず影響ゼロ
  //
  const probTotal = ranked.reduce((s, b) => s + b.prob, 0) || 1;
  const useMaster = hasMasterExt() && !!MASTER_EXT.venue_kimari[DATA.venue];

  // arek連動動的重みを取得（荒れ会場ほどwTenkai増・wBase減）
  // [2026-07-12] wSlit はスリット補正撤廃に伴い受け取り・使用を停止（calcDynamicWeights自体は互換のため残置）
  const { wBase, wTenkai, wTenji } = calcDynamicWeights(arek);

  // 各艇の展開係数・展示係数を算出
  const tenkaiOnlyTotal = ranked.reduce((s, x) => s + (x.tenkai_score ?? x.tenkai_prob), 0) || 1;

  // ── 枠番順に並んだrawBoatsから「1つ前コース（枠番-1）の艇」参照マップを生成 ──
  // 例: 4号艇なら3号艇を前コースとして参照
  const boatByNo = {};
  rawBoats.forEach(b => { boatByNo[b.boat] = b; });

  // 展示データ（枠番→テンジタイム）を取得
  const tenjiRawMap = {};  // { [boat番号]: tenji秒数 }
  if(hasTenji && tenjiData){
    const boatKeysTenji = Object.keys(tenjiData).filter(k => /^\d+$/.test(k));
    boatKeysTenji.forEach(k => {
      const entry = tenjiData[k];
      // テンジタイム: entry.tenji（数値）
      if(entry && typeof entry.tenji === 'number'){
        tenjiRawMap[parseInt(k)] = entry.tenji;
      }
    });
  }

  ranked.forEach(b => {
    const baseNorm    = b.prob / probTotal;  // 基準確率（正規化済み）

    // ── 展開補正（差分ベース）──
    // [2026-06-27 修正] 旧実装: tenkaiCoef = tenkaiNorm/baseNorm を[0.3,3.0]にクランプ
    //   → baseNormが極端に大きい艇(例: 1号艇91.8%)はわずかな展開上の不利でも比率が
    //     一気に下振れし、逆にbaseNormが極端に小さい艇(数%の艇)はわずかな展開上の
    //     有利でも比率が爆発し、複数艇が上限3.0に張り付いて「差」が消える、という
    //     基準確率の偏りに応じた感度の暴走が発生していた。
    //     （実例: 1号艇 基準91.8%→展開補正▼0.64、他5艇 基準2%前後→展開補正▲3.00全員一致
    //       → 最終的に1号艇が91.8%→38.4%まで落ちる異常値の原因。
    //       computeScenCombosWithEV.js にあった同種のバグと同一原因。
    //       renderer.js の buildScenarioBuyPanel がこちらの値を実際に画面表示していたため、
    //       computeScenCombosWithEV.js 側だけの修正では画面の数値は変わらなかった）
    //   新実装: tenkaiDiff = tenkaiNorm - baseNorm（展開スコアの絶対的なズレ）を
    //     そのままボーナス量の元にする。比率を経由しないため baseNorm の大小によらず、
    //     展開要因がもたらす補正の絶対量が艇ごとの実際の強弱に比例する。
    let tenkaiDiff = 0.0;
    if(useMaster && baseNorm > 0){
      const tenkaiNorm = (b.tenkai_score ?? b.tenkai_prob) / tenkaiOnlyTotal;
      tenkaiDiff = tenkaiNorm - baseNorm;
    }
    // 旧tenkaiCoef互換値（表示・デバッグ用にのみ保持。ボーナス計算には使わない）
    const tenkaiCoef = baseNorm > 0
      ? Math.min(3.0, Math.max(0.3, (baseNorm + tenkaiDiff) / baseNorm))
      : 1.0;

    // ── 展示補正係数 ──
    let tenjiCoef = 1.0;
    let tenjiRawP1 = null; // [2026-07-13 追加] テーブル参照直後の生の加減値(pt)。クランプなし
    if(tenjiScoreMap){
      tenjiCoef  = tenjiScoreMap[`__coef_${b.boat}`] ?? 1.0;
      tenjiRawP1 = tenjiScoreMap[`__rawP1_${b.boat}`] ?? null;
    }

    const wTenjiCourse = wTenji;

    // 1パス目: 各係数と baseNorm を保存
    b._baseNorm     = baseNorm;
    b._tenkaiCoef   = tenkaiCoef;   // 互換値（表示用のみ）
    b._tenkaiDiff   = tenkaiDiff;   // ボーナス計算で実際に使う値（差分ベース）
    b._tenjiCoef    = tenjiCoef;
    b._tenjiRawP1   = tenjiRawP1;   // テーブル生値（pt）。7会場のみ非null
    b._wTenjiCourse = wTenjiCourse;
    b.display_tenkai = useMaster ? tenkaiCoef : null;
    b.display_tenji  = hasTenji  ? tenjiCoef  : null;
    b.display_slit   = null;
  });

  // ── [2026-07-12 修正] 基準列にキャリブレーションを追加適用 ──
  //
  // 【背景】
  //   従来の display_base = baseNorm + tenkaiDiff は、final_prob が最終的に通す
  //   ①wTenkaiによる展開ボーナスの重み付け ②コース別キャリブレーション
  //   (calibrateCourse1Prob / calibrateOtherCourseProb) を一切通していなかった。
  //   そのため「基準」列と「展開シナリオ」の1着率（= final_prob ベース）が
  //   展示データが来る前の段階でも食い違って見える原因になっていた。
  //
  // 【方針】
  //   基準列は「展示・スリット補正を含まない final_prob」として計算する。
  //   → 展示データが無い間は tenjiBonus=slitBonus=0 のため final_prob と完全一致する。
  //   → 展示データが来た後は、展示・スリットの影響を含まない「その手前の値」として
  //     独立した意味を保ち、展示補正・スリット補正・最終確率の各列と役割が重複しない。
  {
    const TENKAI_DIFF_GAIN = 1.0;
    const baseScores = {};
    ranked.forEach(b => {
      const tenkaiBonus = TENKAI_DIFF_GAIN * b._tenkaiDiff * wTenkai;
      baseScores[b.boat] = Math.max(0.001, b._baseNorm + tenkaiBonus);
    });
    const baseScoreTotal = Object.values(baseScores).reduce((s, v) => s + v, 0) || 1;
    ranked.forEach(b => { b.display_base = baseScores[b.boat] / baseScoreTotal; });

    // final_prob と同一のキャリブレーション関数を、同じ手順で適用する
    try {
      const _boat1b = ranked.find(b => b.boat === 1);
      if (_boat1b && typeof calibrateCourse1Prob === 'function') {
        const _raw1b = _boat1b.display_base;
        const _cal1b = calibrateCourse1Prob(_raw1b, _boat1b.name ?? null);
        if (_cal1b != null && !isNaN(_cal1b) && Math.abs(_cal1b - _raw1b) > 1e-9) {
          const _othersB = ranked.filter(b => b.boat !== 1);
          const _othersBTotal = _othersB.reduce((s, b) => s + b.display_base, 0) || 1;
          const _remainB = Math.max(0, 1 - _cal1b);
          _othersB.forEach(b => { b.display_base = _remainB * (b.display_base / _othersBTotal); });
          _boat1b.display_base = _cal1b;
        }
      }
      if (typeof calibrateOtherCourseProb === 'function') {
        ranked.forEach(b => {
          if (b.boat == null || b.boat === 1 || b.display_base == null) return;
          const _rawOb = b.display_base;
          const _calOb = calibrateOtherCourseProb(_rawOb, b.boat);
          if (_calOb != null && !isNaN(_calOb)) b.display_base = _calOb;
        });
        const _renormB = ranked.reduce((s, b) => s + (b.display_base || 0), 0);
        if (_renormB > 0 && Math.abs(_renormB - 1) > 1e-9) {
          ranked.forEach(b => { b.display_base = b.display_base / _renormB; });
        }
      }
    } catch (_ccb) { /* 補正失敗時は無補正のまま続行（フォールバック） */ }
  }

  // ══════════════════════════════════════════════════════════════════
  // STEP2: 【刷新】6艇一括スリット相対評価 + 加算ボーナス方式で final_prob を確定
  //
  // 【旧実装の問題点2】
  //   展示タイム「回り足 or 直線」を会場特性だけで 1.0 or 0 の二値評価していた
  //   → 実際は気象（追い風/向かい風）や選手差で連続的に変わる指標
  //   → 旧: prevBoat との1対1比較でスリット係数を決定していた
  //
  // 【新設計: 6艇一括相対評価】
  //   1. 6艇の「スリット総合スコア」= 展示タイム × (1 + 気象補正) + ST順 × 換算係数
  //      を全艇一括で計算し、6艇平均からの乖離率をスリット優劣指標とする
  //   2. コース特性（スロー枠=回り足重視、ダッシュ枠=直線重視）と
  //      風向（追い風/向かい風）による連続値補正を集約
  //   3. 乖離率をそのまま加算ボーナスとして final_prob に反映
  //      → クリップ付きで過補正防止（上限±SLIT_REL_CLIP）
  //
  // ══════════════════════════════════════════════════════════════════
  const BONUS_BASE_TENKAI = 0.15;  // [2026-06-27] 旧・比率方式専用の定数。差分方式(TENKAI_DIFF_GAIN)に移行したため現在は未使用（_tenkaiCoef表示用の互換計算にのみ間接的に名残あり）。
  const BONUS_BASE_TENJI  = 0.15;  // 展示補正の加算強度（実測テーブル非対応会場でのみ使用）
  // [2026-07-12 削除] SLIT_BONUS_BASE / SLIT_REL_CLIP はスリット補正撤廃に伴い削除。

  // [2026-07-12 追加] 実測テーブル会場（住之江/常滑/蒲郡/三国）専用: 1着補正クリップ表
  //
  // 【背景】
  //   従来、全会場共通で tenjiBonus = BONUS_BASE_TENJI(0.15) × (coef-1) × wTenji(0.5固定)
  //   という加算方式だったため、住之江等が持つ実測 p1 デルタ（例: 4号艇0.6秒差で+6%等）を
  //   使っていても、最終的な final_prob への影響は最大でも±2%pt程度しか出ず、
  //   「展示補正を入れている意味がない」状態だった。
  //
  //   一方2着・3着補正（TENJI_P2_CLIP_BY_COURSE / CLIP3_BY_COURSE）は実測係数を直接乗算
  //   しており、体感できる強さで機能している。1着だけ蚊帳の外だった。
  //
  // 【方針】
  //   実測テーブルを持つ会場に限り、1着も2着・3着と同じ「係数を直接乗算」方式に変更する。
  //   ただし [2026-05-13] の教訓（wTenji=1.0で1号艇が過剰強化され回収率▼20%）を踏まえ、
  //   1号艇（既に確率が高い艇）のクリップ幅は特に狭くし、過剰強化を構造的に防ぐ。
  //   3〜6号艇は展示の影響が実際に大きいコースのため、2着用クリップに準じた幅を持たせる。
  //
  // ⚠️ この初期値はバックテスト未実施の暫定値。[2026-05-13]と同様の副作用
  //    （鉄板1号艇レースがさらに鉄板化し回収率が下がる）が起きていないか、
  //    導入後は必ず回収率ベースで検証すること。
  const TENJI_P1_CLIP_BY_COURSE = {
    1: [0.94, 1.06],  // 最重要: 1号艇の過剰強化を構造的に防ぐ（2026-05-13教訓）
    2: [0.90, 1.12],
    3: [0.85, 1.20],
    4: [0.80, 1.25],
    5: [0.85, 1.20],
    6: [0.88, 1.15],
  };

  // [2026-07-12 削除] スリット補正（前艇比較のラップタイム評価）は撤廃。
  // 「スリット補正」の表示スロットは、実測テーブル会場（住之江/常滑/蒲郡/三国/鳴門/多摩川/平和島）の
  // タイム由来1着率(p1)加算値を表示する用途に転用する（下のfinal_prob確定ループ内で設定）。

  // 実測テーブル会場（住之江/常滑/蒲郡/三国/鳴門/多摩川/平和島）かどうか
  // （calcTenjiScoreが __isSuminoe を立てる）
  const isMeasuredTenjiVenue = !!(tenjiScoreMap && tenjiScoreMap.__isSuminoe);

  // 2パス目: final_prob を確定
  //   実測テーブル会場: タイム由来1着率(p1)を「直接加算」（コース別クリップで過補正防止）
  //                     [2026-07-12] 乗算方式・スリット補正から変更。表示は「スリット補正」枠を流用。
  //   それ以外:         従来通り加算ボーナス方式（BONUS_BASE_TENJI × wTenji で希釈）。スリット分は撤廃。
  ranked.forEach(b => {
    // [2026-06-27 修正] tenkaiBonus は旧 (tenkaiCoef-1)*BONUS_BASE_TENKAI 方式から
    // 差分(_tenkaiDiff)を直接使う方式に変更。TENKAI_DIFF_GAIN は旧方式との
    // スケール整合用の感応度係数（実測データで再チューニング可能な値として分離）。
    const TENKAI_DIFF_GAIN = 1.0;
    const tenkaiBonus = TENKAI_DIFF_GAIN * b._tenkaiDiff * wTenkai;

    const preScore = Math.max(0.001, b._baseNorm + tenkaiBonus);

    if(isMeasuredTenjiVenue){
      // ── タイム由来1着率(p1)を直接加算（実測根拠あり）──
      const [lo, hi] = TENJI_P1_CLIP_BY_COURSE[b.boat] ?? [0.85, 1.20];
      const rawCoef      = b._tenjiCoef; // クリップ前（テーブル参照時の[0.5,2.0]クランプのみ済み）
      // [2026-07-13 修正] クリップ判定をpt空間で直接行う。
      //   旧実装は係数空間(1+p1/100)でクリップしてから(-1)*100で戻していたため、
      //   浮動小数点の往復誤差でクリップ非発動時でも表示が生値と1桁ズレる不具合があった
      //   （例: rawP1=11.75 → 展示補正=11.7 / スリット補正=11.8 に見えてしまう）。
      //   pt空間で完結させることで、非クリップ時は raw と完全に同じ値になることを保証する。
      const rawPt        = b._tenjiRawP1 ?? ((rawCoef - 1.0) * 100);
      const loPt         = (lo - 1.0) * 100;
      const hiPt         = (hi - 1.0) * 100;
      const clippedPt    = Math.min(hiPt, Math.max(loPt, rawPt)); // コース別クリップ適用後（pt）
      const tenjiAddend  = clippedPt / 100; // 加算するデルタ（確率空間）
      b._multi_score = Math.max(0.001, preScore + tenjiAddend);
      // 「スリット補正」表示スロットを、コース別クリップでどれだけ削られたかの診断表示に転用
      // （展示補正の（）が既にclippedCoef由来の実効値を出しているため、ここは重複させず
      //   「クリップされていなければ本来いくつだったか」という別情報のみ持たせる）
      b.display_slit = 1.0 + tenjiAddend; // 既存互換用に保持（内部利用のみ）
      const clipTrimPt = rawPt - clippedPt; // 正=クリップで下振れ抑制／負=クリップで下限持ち上げ
      b.display_tenji_clip_pt   = clipTrimPt;
      b.display_tenji_raw_coef  = rawCoef;
      // [2026-07-13] テーブル参照直後の生の加減値(pt)。[0.5,2.0]クランプすら通っていない真の実測値。
      b.display_tenji_table_pt  = rawPt;
      // 展示補正セルに（）併記する実際の1着率加減値（renorm前のpt換算・目安値）
      b.display_tenji_addend_pt = clippedPt;
    } else {
      // ── 従来の加算ボーナス方式（実測根拠なし会場）──
      const tenjiBonus = BONUS_BASE_TENJI * (b._tenjiCoef - 1.0) * b._wTenjiCourse;
      b._multi_score = Math.max(0.001, preScore + tenjiBonus);
      // 実測データがない会場は「スリット補正」表示なし（根拠のない値を出さない）
      b.display_slit = null;
      b.display_tenji_clip_pt = null;
      b.display_tenji_table_pt = null;
      // 非実測会場も同じ考え方でpt換算した加減値（目安値）を併記
      b.display_tenji_addend_pt = tenjiBonus * 100;
    }
  });

  // 正規化して final_prob を確定
  const multiTotal = ranked.reduce((s, b) => s + b._multi_score, 0) || 1;
  ranked.forEach(b => {
    b.final_prob = b._multi_score / multiTotal;
    b.tenkai_prob_base  = b.tenkai_prob;
    b.tenji_score_indep = tenjiScoreMap ? (tenjiScoreMap[b.boat] ?? null) : null;
  });

  // ── [2026-07-04 追加／同日 二重適用修正] コース別キャリブレーション補正 ──
  // computeScenCombosWithEV.js の calibrateCourse1Prob / calibrateOtherCourseProb
  // （calibration.js ①③パネルの実測データで自己学習）を、この画面表示用の
  // final_prob に適用する。
  //
  // 【重要】analyzer.js の calcTenkaiProbsExtended（Stage1）側にも同じ関数の
  //   呼び出しが以前あったが、tenkaiDiff = tenkaiNorm - baseNorm の計算で
  //   baseNorm（較正前の生prob）との差分を取る際に較正分がそのまま
  //   tenkaiBonus として再度乗ってしまい、事実上の二重補正になっていたため
  //   2026-07-04付けで削除した（analyzer.js 側のコメント参照）。
  //   較正の適用は、全ボーナス合成・正規化が終わった後のこの箇所のみで行う。
  //
  // 【注意】ここで使う補正テーブルは computeScenCombosWithEV.js 内の
  //   calcTenkaiProbs（展示データなしの簡易版）の実測誤差から学習したもので、
  //   ここで使っている calcTenkaiProbsExtended（展示・気象・スリット込み）とは
  //   厳密には別モデル。系統的な過大評価の傾向は共通するはずだが完全一致は
  //   保証されないため、あくまで暫定的な代用補正である。
  //   本来は本画面の final_prob 専用の実績照合パネルを別途用意し、
  //   専用のキャリブレーションテーブルで学習させるのが望ましい。
  try {
    const _boat1r = ranked.find(b => b.boat === 1);
    if (_boat1r && typeof calibrateCourse1Prob === 'function') {
      const _raw1r = _boat1r.final_prob;
      // [2026-07-04] 旧Stage1側で渡していた個人名（個人逃げ率ブレンド用）を
      // こちらに引き継ぐ。calibrateCourse1Prob 側が第2引数未対応でも無害。
      const _cal1r = calibrateCourse1Prob(_raw1r, _boat1r.name ?? null);
      if (_cal1r != null && !isNaN(_cal1r) && Math.abs(_cal1r - _raw1r) > 1e-9) {
        const _othersR = ranked.filter(b => b.boat !== 1);
        const _othersRTotal = _othersR.reduce((s, b) => s + b.final_prob, 0) || 1;
        const _remainR = Math.max(0, 1 - _cal1r);
        _othersR.forEach(b => { b.final_prob = _remainR * (b.final_prob / _othersRTotal); });
        _boat1r.final_prob = _cal1r;
      }
    }
    if (typeof calibrateOtherCourseProb === 'function') {
      ranked.forEach(b => {
        if (b.boat == null || b.boat === 1 || b.final_prob == null) return;
        const _rawOr = b.final_prob;
        const _calOr = calibrateOtherCourseProb(_rawOr, b.boat);
        if (_calOr != null && !isNaN(_calOr)) b.final_prob = _calOr;
      });
      const _renormR = ranked.reduce((s, b) => s + (b.final_prob || 0), 0);
      if (_renormR > 0 && Math.abs(_renormR - 1) > 1e-9) {
        ranked.forEach(b => { b.final_prob = b.final_prob / _renormR; });
      }
    }
  } catch (_ccr) { /* 補正失敗時は無補正のまま続行（フォールバック） */ }

  ranked.sort((a, b) => b.final_prob - a.final_prob);

  // ─ STEP3: 2着率計算（inn_2place ベース）
  const place2Map = calcPlace2Probs(rawBoats, ranked);
  // place2Map を各ボートに付与して2着ランクを作成
  const ranked2 = [...ranked].map(b=>({...b, place2_prob: place2Map[b.boat]||0}));

  const [A, B, C, D] = ranked;
  const mode    = tenkaiLabel(arek);
  const modeDesc = arek < 40
    ? `インの${A.name}（${A.boat}号）が主導権。逃げ・先マイが濃厚。`
    : arek > 60
      ? `${A.name}（${A.boat}号）軸だが、まくり・差しが入りやすい展開。`
      : `${A.name}（${A.boat}号）中心だが${B.name}（${B.boat}号）との競り合いも。`;

  const probDiff   = A.final_prob - B.final_prob;
  // 乖離率（%）: DIVERGENCE_THRESHOLD_HIT と同一単位で比較する
  // 旧: probDiff <= 0.05（固定5%）→ 新: DIVERGENCE_THRESHOLD_HIT（デフォルト12%）未満を僅差とみなす
  const probDiffPct = probDiff * 100;
  const isDualAxis  = probDiffPct < DIVERGENCE_THRESHOLD_HIT;

  // ─ STEP4 & STEP5: 展開シナリオベースの買い目生成
  //
  // 【1着軸の決定】
  //   1号艇 final_prob が会場平均（inn_data.course_rates[1]）を下回る場合、
  //   1号艇を除いた中でシナリオ確率合計が最大の艇を本命軸とする。
  //   それ以外は final_prob 1位（= A）を本命軸とする。
  //
  // 【2着候補の選定】
  //   各シナリオの place2List から確率を累積し、合計50%以上になるまで採用。
  //   逃げシナリオ(1号艇逃げ)では inn_2place の会場平均を上回る艇を優先。
  //
  // 【3着の選定】
  //   全艇のうち final_prob 最下位の艇を除外した残りを流す。
  //
  // 【MASTERなし時】place2_prob ベースの旧ロジックにフォールバック。

  const innData_buy  = DATA.inn_data || {};
  const cRates_buy   = innData_buy.course_rates || [];
  const inn2Place_buy = (() => {
    const v = innData_buy.inn_2place;
    if(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) return v;
    return MASTER_EXT?.venue_stats?.[DATA.venue]?.inn_2place || {};
  })();

  // 会場平均1コース1着率
  const venueAvgCourse1 = cRates_buy[1] ?? null;

  // 1号艇が会場平均を下回るか
  const boat1 = ranked2.find(b => b.boat === 1);
  const boat1BelowAvg = (venueAvgCourse1 !== null && boat1)
    ? boat1.final_prob < venueAvgCourse1
    : false;

  // ── 3着: rate3 最下位1艇を除外して残り全流し ──
  //
  // pick3rd(winnerBoat, kimari, secondBoat) で呼び出す。
  // シナリオの rate3（個人補正ブレンド済み）が最も低い艇を1艇除外し、
  // 残り全艇を3着候補として返す。
  // rate3 データが全くない場合は final_prob 最下位を除外してフォールバック。
  //
  const tenkaiRem_buy = (() => {
    // [2026-06-01 修正] venue はこのスコープで未定義 → DATA.venue を使用
    const _venueForRB = DATA?.venue ?? currentVenue ?? null;
    const vLocal = MASTER_EXT?.venue_stats?.[_venueForRB]?.tenkai_remaining;
    if(vLocal && typeof vLocal === 'object' && Object.keys(vLocal).length > 0) return vLocal;
    return MASTER_EXT?.tenkai_remaining || null;
  })();

  // winner_course_order（個人実績）: renderBuy スコープで参照できるよう定義
  const winnerCO_buy = MASTER_EXT?.winner_course_order || {};

  // calcScenarioData を先読み（軸決定より前に呼ぶため）
  // tenjiScoreMap を渡して 2着確率に展示係数を反映させる（問題3対応）
  const sd = calcScenarioData(ranked2, rawBoats, tenjiScoreMap);

  // ── 軸信頼度判定（if(sd.valid)の外で定義しないと参照エラーになる）──
  const venueAvg1_buy = cRates_buy[1] ?? 0.45;
  const top1FinalProb = ranked2[0]?.final_prob ?? 0;

  // ── 【改修】的中重視モード: 1着固定軸の採用条件 ──
  // 仕様（変更）:
  //   ① final_prob 1位と2位の乖離率 ≥ DIVERGENCE_THRESHOLD_HIT（デフォルト12%）
  //   ② その1位艇の最終確率順位が1位（= 実質同義だが明示）
  // → 乖離が十分に大きい場合のみ1位艇を1艇固定軸とする。
  //    乖離が閾値未満（isDualAxis=true）の場合は2頭軸展開に自動移行。
  // ※ 旧条件「1号艇が場平均以上 AND top2以内」は廃止。
  //    1号艇かどうかは axisReliable の判定に含めない（rec側で制御）。
  const boat1ForAxis   = ranked2.find(b => b.boat === 1);
  const boat1FinalProb = boat1ForAxis?.final_prob ?? 0;
  const boat1RankAmongFinal = [...ranked2]
    .sort((a, b) => (b.final_prob ?? 0) - (a.final_prob ?? 0))
    .findIndex(b => b.boat === 1);
  // axisReliable: 乖離率が閾値以上（= isDualAxis が偽）のとき真
  const axisReliable = !isDualAxis; // isDualAxis=true（僅差）のとき false になる
  // 後方互換: boat1AboveAvg は rec 側の判定で引き続き使用
  const boat1AboveAvg = boat1FinalProb >= venueAvg1_buy;

  // ── 【改修】3着候補絞り込み関数（画面表示と同一データベース）──
  //
  // 旧: tenkaiRem_buy の rate3 を使用 → 画面の3着表示と乖離が発生
  // 新: 画面の展開シナリオ表示と同じ scenarioPlace2[winnerBoat][kimari] の p2 を使用
  //     （1着→2着→3着の流れで、2着候補リストから2着指定艇を除いた残りを
  //       p2 降順で累積まで採用する）
  //
  // buyMode: 'hit'（的中重視）または 'rec'（回収重視）
  //
  // 【2026-05-16 改修】モード別に3着累積目標を分離
  //   hit: 0.80 → 3着ヒモを広げて的中率向上（0.85はMAX10点上限と衝突し2軸目が押し出された）
  //   rec: 0.70 → 従来通り（配当重視のため絞りを維持）
  const PICK3_PROB_TARGET_HIT = 0.80; // 的中重視: 3着累積確率目標 80%
  const PICK3_PROB_TARGET_REC = 0.70; // 回収重視: 3着累積確率目標 70%（従来通り）

  function pick3rd(winnerBoat, kimari, secondBoat, buyMode){
    const pick3Target = (buyMode === 'hit') ? PICK3_PROB_TARGET_HIT : PICK3_PROB_TARGET_REC;

    if(!sd.valid) {
      // MASTERなしフォールバック: final_prob 降順でモード別累積%
      const allBoats = ranked2.map(b => b.boat).filter(b => b !== winnerBoat && b !== secondBoat);
      if(allBoats.length <= 2) return allBoats;
      const sorted = [...allBoats].sort((a, b) => {
        const fa = ranked2.find(r => r.boat === a)?.final_prob ?? 0;
        const fb = ranked2.find(r => r.boat === b)?.final_prob ?? 0;
        return fb - fa;
      });
      const totalFP = sorted.reduce((s, b) => s + (ranked2.find(r => r.boat === b)?.final_prob ?? 0), 0) || 1;
      const picked = []; let cum = 0;
      for(const b of sorted){
        picked.push(b);
        cum += (ranked2.find(r => r.boat === b)?.final_prob ?? 0) / totalFP;
        if(cum >= pick3Target) break;
      }
      return picked;
    }

    // ── merged3rdMap（calc3rdScores）ベースで3着候補を選出 ──
    // rate3（tenkai_remaining 展開別3着率）× 展示係数 × avg_rank補正 の合成スコアで選ぶ。
    // p2 ベースだと「2着本命を除いた残り全員」がほぼ均等になり識別力ゼロになる問題を解消。
    const thirdCandidates = (sd.merged3rdMap?.[winnerBoat]?.[secondBoat] || [])
      .filter(x => x.boat !== winnerBoat && x.boat !== secondBoat);

    if(thirdCandidates.length > 0){
      const scoreTotal = thirdCandidates.reduce((s, x) => s + x.score, 0) || 1;
      const picked = []; let cum = 0;
      for(const t3 of thirdCandidates){ // calc3rdScores で score 降順ソート済み
        picked.push(t3.boat);
        cum += t3.score / scoreTotal;
        if(cum >= pick3Target) break;
      }
      if(picked.length > 0) return picked;
    }

    // フォールバック: merged3rdMap が空の場合のみ p2 ベースを使用
    const place2List = sd.scenarioPlace2[winnerBoat]?.[kimari] || [];
    const candidates = place2List.filter(x => x.boat !== winnerBoat && x.boat !== secondBoat);

    if(candidates.length === 0) return [];
    if(candidates.length <= 2) return candidates.map(x => x.boat);

    const totalP2 = candidates.reduce((s, x) => s + x.p2, 0) || 1;
    const picked = []; let cum = 0;
    for(const item of candidates){
      picked.push(item.boat);
      cum += item.p2 / totalP2;
      if(cum >= pick3Target) break;
    }
    return picked;
  }

  // ── モード別買い目生成関数 ──
  // buyMode: 'hit' | 'rec'
  // 1着軸選定ロジックもモードで変える:
  //   hit: final_prob 1位固定（ブレ排除）
  //   rec: top3Scen の1〜2位も候補（穴も許容）
  function buildBuy3ForMode(buyMode, maxPts){
    const b3    = [];
    const b3seen = new Set();
    const b2    = [];
    const b2seen = new Set();
    const MAX_PTS = (maxPts != null) ? maxPts : BUY_MAX_POINTS; // 10点上限

    function tryAdd3m(first, second, third, label, lc, prob, sg){
      const key = `${first}-${second}-${third}`;
      if(first===second||second===third||first===third) return;
      if(b3seen.has(key)) return;
      if(b3.length >= MAX_PTS) return;
      b3seen.add(key);
      b3.push({c:`${first}−${second}−${third}`, l:label, lc, prob: prob ?? null, scenarioGroup: sg ?? 0});
    }
    function tryAdd2m(first, second, label, lc, prob, sg){
      const key = `${first}-${second}`;
      if(first===second) return;
      if(b2seen.has(key)) return;
      b2seen.add(key);
      b2.push({c:`${first}−${second}`, l:label, lc, prob: prob ?? null, scenarioGroup: sg ?? 0});
    }

    if(sd.valid){
      const { scenarioProb, scenarioPlace2, kimariTypes, merged3rdMap } = sd;
      function kimariToLc(kimari){
        return { '逃げ':'bl-nige', '差し':'bl-sashi', 'まくり':'bl-makuri',
                 'まくり差し':'bl-makusas', '抜き':'bl-nuki' }[kimari] || 'bl-nuki';
      }

      // ── 【改修】2着閾値: hitモード 75% / recモード 70% ──
      // hit: 的中重視のため2着も拡張して取りこぼし削減
      // rec: 配当重視のため従来通り絞りを維持（10点上限圧迫を回避）
      const PICK2_PROB_TARGET_HIT2 = 0.75;
      const PICK2_PROB_TARGET_REC2 = 0.70;

      function pick2nd(winnerBoat, kimari, bMode){
        const pick2Target = (bMode === 'hit') ? PICK2_PROB_TARGET_HIT2 : PICK2_PROB_TARGET_REC2;
        const list = scenarioPlace2[winnerBoat]?.[kimari] || [];
        if(list.length === 0) return [];
        const isNige = (kimari === '逃げ' && winnerBoat === 1);
        let sorted;
        if(isNige && Object.keys(inn2Place_buy).length > 0){
          const avgRate = Object.values(inn2Place_buy).reduce((s,v)=>s+v,0) / Object.keys(inn2Place_buy).length;
          sorted = [...list].sort((a,b) => {
            const aAbove = (inn2Place_buy[String(a.boat)] ?? 0) >= avgRate ? 1 : 0;
            const bAbove = (inn2Place_buy[String(b.boat)] ?? 0) >= avgRate ? 1 : 0;
            if(bAbove !== aAbove) return bAbove - aAbove;
            return b.p2 - a.p2;
          });
        } else {
          sorted = [...list].sort((a,b) => b.p2 - a.p2);
        }
        // 累積 p2 がモード別目標以上になるまで追加
        const picked = [];
        let cum = 0;
        for(const item of sorted){
          if(item.boat === winnerBoat) continue;
          picked.push(item.boat);
          cum += item.p2;
          if(cum >= pick2Target) break;
        }
        return picked;
      }

      const allScenPairs = [];
      for(const winner of ranked2){
        for(const k of kimariTypes){
          const p = scenarioProb[winner.boat]?.[k];
          if(p > 0.001) allScenPairs.push({ boat: winner.boat, name: winner.name, kimari: k, prob: p });
        }
      }
      allScenPairs.sort((a, b) => b.prob - a.prob);
      const seenK = new Set();
      const top3Scen = [];
      for(const pair of allScenPairs){
        if(seenK.has(pair.kimari)) continue;
        seenK.add(pair.kimari);
        top3Scen.push(pair);
        if(top3Scen.length >= 3) break;
      }

      // ── 【改修】1着軸の決定（モード別）──
      //
      // ① 的中重視(hit):
      //   axisReliable（乖離率 ≥ DIVERGENCE_THRESHOLD_HIT）が真:
      //     1位艇を1艇固定軸（全シナリオ展開 + 他艇補完）
      //   axisReliable が偽（isDualAxis=true: 乖離率 < 閾値）:
      //     final_prob 1位艇 + 2位艇の2軸展開（各軸の最有力シナリオ）
      //     ※ 旧: axisReliable 偽のときも1位を強制先頭にしていたが、
      //        isDualAxis 経路で吸収するため廃止。
      //
      // ② 回収重視(rec):
      //   【改修】final_prob 1位が1号艇でないとき → 1・2位艇の両シナリオを展開（穴狙い）
      //   1号艇が1位のとき → top3Scen 順（通常フロー）
      let scenariosToProcess;
      if(buyMode === 'hit'){
        if(axisReliable){
          // ── 乖離率 ≥ 閾値: final_prob 1位艇を1艇固定軸 ──
          const fp1stBoat = ranked2[0]; // final_prob 降順ソート済みの先頭
          const boat1Scens = top3Scen.filter(s => s.boat === fp1stBoat.boat);
          if(boat1Scens.length === 0){
            const fp1stBest = allScenPairs.find(p => p.boat === fp1stBoat.boat);
            scenariosToProcess = fp1stBest ? [fp1stBest, ...top3Scen.filter(s => s.boat !== fp1stBoat.boat)] : top3Scen;
          } else {
            scenariosToProcess = [...boat1Scens, ...top3Scen.filter(s => s.boat !== fp1stBoat.boat)];
          }
        } else {
          // ── 乖離率 < 閾値（isDualAxis）: final_prob 1位 + 2位の2軸展開 ──
          const fp1stBoat = ranked2[0];
          const fp2ndBoat = ranked2[1];
          const dualAxes  = [fp1stBoat?.boat, fp2ndBoat?.boat].filter(Boolean);
          const dualScens = dualAxes.map(ax => allScenPairs.find(p => p.boat === ax)).filter(Boolean);
          const dualRest  = top3Scen.filter(s => !dualAxes.includes(s.boat)).slice(0, 1);
          scenariosToProcess = [...dualScens, ...dualRest];
        }
      } else {
        // ── 回収重視: 1号艇 final_prob が場平均以下のとき穴軸展開 ──
        // 設計方針: 1号艇の最終確率が場平均を下回る = 信頼度低い → 1号艇以外の上位2艇を軸に
        // boat1AboveAvg は上位スコープ（2324行目）で定義済み
        if(!boat1AboveAvg){
          // 1号艇を除いた ranked2 の上位2艇を軸に展開シナリオを組み立てる
          const top2ExBoat1 = ranked2
            .filter(b => b.boat !== 1)
            .slice(0, 2)
            .map(b => b.boat);
          const recScens = allScenPairs
            .filter(p => top2ExBoat1.includes(p.boat))
            .slice(0, 4); // 2艇 × 最大2シナリオ（点数上限は後段で制御）
          scenariosToProcess = recScens.length > 0 ? recScens : top3Scen;
        } else {
          // 1号艇が場平均以上 → 通常フロー（top3Scen 順）
          scenariosToProcess = top3Scen;
        }
      }

      scenariosToProcess.forEach((topScen, scenIdx) => {
        const axisBoat = topScen.boat;
        const kimari   = topScen.kimari;
        const lc       = kimariToLc(kimari);
        const baseLabel = kimari;
        const scenProb  = scenarioProb[axisBoat]?.[kimari] ?? 0;
        const seconds   = pick2nd(axisBoat, kimari, buyMode);

        seconds.forEach(s2 => {
          const place2List = scenarioPlace2[axisBoat]?.[kimari] || [];
          const p2Item     = place2List.find(x => x.boat === s2);
          const p2         = p2Item?.p2 ?? 0;
          const prob2      = scenProb * p2;

          // 展開シナリオ表示と同一の merged3rdMap を直接参照
          const thirdAll   = merged3rdMap[axisBoat]?.[s2] || [];
          const R3_MIN_THRESHOLD = 0.03; // 3着率3%未満の艇は買い目から除外
          const scoreTotal = thirdAll.reduce((s, x) => s + x.score, 0) || 1;
          const thirdList  = [];
          let cumScore = 0;
          const pick3TargetInner = (buyMode === 'hit') ? PICK3_PROB_TARGET_HIT : PICK3_PROB_TARGET_REC;
          for(const x of thirdAll){
            if(x.r3 != null && x.r3 < R3_MIN_THRESHOLD) continue;
            thirdList.push(x);
            cumScore += x.score / scoreTotal;
            if(cumScore >= pick3TargetInner) break;
          }
          thirdList.forEach(t => {
            const prob3 = t.r3 != null ? prob2 * t.r3 : null;
            tryAdd3m(axisBoat, s2, t.boat, baseLabel, lc, prob3, scenIdx);

            // 折り返し
            if(seconds.length === 1){
              const p2RevItem  = (scenarioPlace2[axisBoat]?.[kimari] || []).find(x => x.boat === t.boat);
              const p2Rev      = p2RevItem?.p2 ?? 0;
              const prob2Rev   = scenProb * p2Rev;
              const probRev    = t.r3 != null ? prob2Rev * t.r3 : null;
              tryAdd3m(axisBoat, t.boat, s2, baseLabel+'（折返）', lc, probRev, scenIdx);
            }
          });
          tryAdd2m(axisBoat, s2, baseLabel, lc, prob2, scenIdx);
        });
      });

    } else {
      // MASTERなし: 旧ロジックにフォールバック
      function place2For(axisBoat){
        return ranked2.filter(bt => bt.boat !== axisBoat).sort((x,y) => y.place2_prob - x.place2_prob);
      }
      const p2A  = place2For(A.boat);
      const P2a_ = p2A[0]||B;
      const P2b_ = p2A[1]||C;
      const lbNige = arek < 40 ? '逃げ' : arek > 60 ? 'まくり' : '差し';
      const lcNige = arek < 40 ? 'bl-nige' : arek > 60 ? 'bl-makuri' : 'bl-sashi';
      pick3rd(A.boat, null, P2a_.boat, buyMode).forEach(b=>tryAdd3m(A.boat,P2a_.boat,b,lbNige,lcNige,null,0));
      pick3rd(A.boat, null, P2b_.boat, buyMode).forEach(b=>tryAdd3m(A.boat,P2b_.boat,b,lbNige,lcNige,null,1));
      tryAdd2m(A.boat, P2a_.boat, lbNige, lcNige, null, 0);
      tryAdd2m(A.boat, P2b_.boat, lbNige, lcNige, null, 1);
      if(arek>=45){
        pick3rd(P2a_.boat, null, A.boat, buyMode).forEach(b=>tryAdd3m(P2a_.boat,A.boat,b,'差し','bl-sashi',null,2));
        tryAdd2m(P2a_.boat, A.boat, '差し', 'bl-sashi', null, 2);
      }
    }

    return { b3, b2 };
  }

  // ── 2モードの買い目をそれぞれ生成 ──
  // HIT/REC 別の点数上限で買い目を生成（見送り推奨時は10点で参考表示）
  const { b3: buy3Hit_raw, b2: buy2Hit_raw } = buildBuy3ForMode('hit', BUY_MAX_POINTS_HIT);
  const { b3: buy3Rec_raw, b2: buy2Rec_raw } = buildBuy3ForMode('rec', BUY_MAX_POINTS_REC);

  // 旧コードとの互換性のため buy3 / buy2 は的中重視ベースで定義
  // ※ 合成オッズ判定（buy3Hit_checked）は後段で行うため、ここでは raw を参照
  const buy3 = buy3Hit_raw;
  const buy2 = buy2Hit_raw;


  // ─ STEP6: 確率テーブル生成
  const probRows = ranked2.map((bt,i)=>{
    // 基準列: probを6艇で正規化し、展開補正（tenkaiDiff）を加味した相対確率（合計100%）
    const basePct = (bt.display_base * 100).toFixed(1);

    // 展示補正列: 実際の1着率加減値のみ表示（係数は加減値の単位違いに過ぎず冗長なため廃止）
    //   addendPt = (coef-1.0)*100 [実測会場] / 0.15*wTenji*(coef-1.0)*100 [非実測会場]
    //   → coefは常にaddendPtから機械的に逆算できるため、表示上の情報量はaddendPtと同一。
    //   デバッグ用に元係数は title属性でのみ確認可能にしておく。
    let tenjiCorrCell;
    if(hasTenji && bt.display_tenji != null){
      const coef     = bt.display_tenji;
      const addendPt = bt.display_tenji_addend_pt;
      const dbgTitle = `title="係数(参考): ${coef.toFixed(3)}"`;
      if(addendPt == null || Math.abs(addendPt) < 0.05){
        tenjiCorrCell = `<span ${dbgTitle} style="font-size:10px;color:var(--text3)">±0.0</span>`;
      } else {
        const color = addendPt >= 0 ? 'var(--green)' : 'var(--red)';
        const mark  = addendPt >= 0 ? '▲' : '▼';
        tenjiCorrCell = `<span ${dbgTitle} style="font-size:10px;font-weight:600;color:${color}">${mark}${addendPt >= 0 ? '+' : '−'}${Math.abs(addendPt).toFixed(1)}</span>`;
      }
    } else {
      tenjiCorrCell = `<span style="font-size:10px;color:var(--text3)">—</span>`;
    }

    // スリット補正列: [2026-07-13〜] 実測テーブル会場のみ、テーブル参照直後の
    //   「生の」1着率加減値(pt)を表示（[0.5,2.0]クランプすら通っていない真の実測値）。
    //   展示補正列（コース別クリップ後の実効値）と見比べて、値がズレていればクリップが効いている、
    //   という読み方ができるようにする。
    let slitCorrCell;
    if(hasTenji && bt.display_tenji_table_pt != null){
      const rawPt = bt.display_tenji_table_pt;
      if(Math.abs(rawPt) < 0.05){
        slitCorrCell = `<span style="font-size:10px;color:var(--text3)">±0.0</span>`;
      } else {
        const color = rawPt >= 0 ? 'var(--green)' : 'var(--red)';
        const mark  = rawPt >= 0 ? '▲' : '▼';
        slitCorrCell = `<span style="font-size:10px;font-weight:600;color:${color}">${mark}${rawPt >= 0 ? '+' : '−'}${Math.abs(rawPt).toFixed(1)}</span>`;
      }
    } else {
      slitCorrCell = `<span style="font-size:10px;color:var(--text3)">—</span>`;
    }

    // 最終確率: 3スコアの加重合成結果（合計は常に100%）── 展示情報取得前はハイフン表示
    const finalProb = bt.final_prob ?? bt.tenkai_prob;
    const finalPct  = (finalProb * 100).toFixed(1);
    const finalCell = hasTenji ? `${finalPct}%` : `—`;

    // 場平均（会場コース別1着率）からの加減値を（）で併記（展示情報取得前は非表示）
    const venueAvg    = cRates_buy[bt.boat] ?? null;
    const diffPt      = venueAvg != null ? (finalProb - venueAvg) * 100 : null;
    const diffCell    = !hasTenji
      ? ``
      : diffPt == null
        ? `<span style="font-size:10px;color:var(--text3)">（—）</span>`
        : Math.abs(diffPt) < 0.05
          ? `<span style="font-size:10px;color:var(--text3)">（±0.0）</span>`
          : `<span style="font-size:10px;font-weight:600;color:${diffPt >= 0 ? 'var(--green)' : 'var(--red)'}">（${diffPt >= 0 ? '+' : '−'}${Math.abs(diffPt).toFixed(1)}）</span>`;

    // 期待値セル
    const evCell = `<span class="ev-cell" data-boat="${bt.boat}" data-fp="${finalProb.toFixed(4)}" style="font-size:11px;color:var(--text3)">—</span>`;

    // ── 3連対率セル（管理者限定）──
    // 基準値: 出走表と同じ MASTER_EXT.player_index[name].annual_place3（年間3連対率）
    // 実測テーブル会場（住之江/常滑/蒲郡/三国）のみ、当日展示に基づく3連対率デルタ(__p3r_)を加算表示。
    // それ以外の会場は実測デルタを持たないため基準値のみ表示（根拠のない加算はしない）。
    let place3rCell;
    {
      const base3r = MASTER_EXT?.player_index?.[bt.name]?.annual_place3; // 0〜1 の割合、なければ null
      if(base3r == null){
        place3rCell = `<span style="font-size:10px;color:var(--text3)">—</span>`;
      } else if(isMeasuredTenjiVenue && hasTenji && tenjiScoreMap){
        const deltaPt = tenjiScoreMap[`__p3r_${bt.boat}`] ?? 0; // %pt単位（例: +6 → +6%pt）
        const adjusted = Math.max(0, Math.min(1, base3r + deltaPt / 100));
        const deltaStr = Math.abs(deltaPt) < 0.5
          ? ''
          : `<span style="font-size:9px;color:${deltaPt >= 0 ? 'var(--green)' : 'var(--red)'}">（${deltaPt >= 0 ? '+' : '−'}${Math.abs(deltaPt).toFixed(1)}）</span>`;
        place3rCell = `<span style="font-family:var(--mono)">${(adjusted * 100).toFixed(1)}%</span>${deltaStr}`;
      } else {
        place3rCell = `<span style="font-family:var(--mono)">${(base3r * 100).toFixed(1)}%</span>`;
      }
    }

    return `<tr>
      <td style="text-align:center;padding:4px 3px"><span class="boat-circle b${bt.boat}" style="width:22px;height:22px;font-size:11px;line-height:22px;display:inline-flex;align-items:center;justify-content:center">${bt.boat}</span></td>
      <td class="col-name" style="padding:4px 4px;font-size:0.82rem;text-align:center">${bt.name}</td>
      <td style="padding:4px 4px;text-align:center;font-family:var(--mono);font-size:0.82rem;color:var(--text3)">${basePct}%</td>
      <td class="admin-only" style="padding:4px 3px;text-align:center;font-size:0.82rem">${tenjiCorrCell}</td>
      <td class="admin-only" style="padding:4px 3px;text-align:center;font-size:0.82rem">${slitCorrCell}</td>
      <td style="padding:4px 4px;text-align:center;font-family:var(--mono);font-size:0.82rem;font-weight:700;color:var(--accent2)">${finalCell}${diffCell}</td>
      <td class="admin-only" style="padding:4px 4px;text-align:center;font-size:0.82rem">${place3rCell}</td>
    </tr>`;
  }).join('');

  const dualNote = isDualAxis
    ? `<span style="color:var(--orange);font-size:11px;font-weight:700">⚡ 僅差2頭軸（${A.boat}号・${B.boat}号 差${probDiffPct.toFixed(1)}% / 閾値${DIVERGENCE_THRESHOLD_HIT}%）</span>`
    : '';

  // ── 会場平均率テーブル ──
  // コース1着率: inn_data.course_rates（会場平均）
  // 1－◯ 2着率: inn_data.inn_2place → なければ MASTER_EXT.venue_stats[venue].inn_2place にフォールバック
  const innData   = DATA.inn_data || {};
  const cRates    = innData.course_rates || [];

  // inn_2place: inn_data に直接入っていれば使用、なければ venue_stats から取得
  const inn2Place = (() => {
    const fromInnData = innData.inn_2place;
    if(fromInnData && typeof fromInnData === 'object' && !Array.isArray(fromInnData) && Object.keys(fromInnData).length > 0)
      return fromInnData;
    return MASTER_EXT?.venue_stats?.[DATA.venue]?.inn_2place || {};
  })();

  // コース番号ラベル（進入コース）
  const courseLabels = ['1','2','3','4','5','6'];

  // 各コースのセル
  const courseRateCells = courseLabels.map(c => {
    const ci   = parseInt(c);
    const rate = cRates[ci];
    const pct  = rate != null ? (rate * 100).toFixed(1) + '%' : '—';
    // 1コースは強調
    const style = ci === 1
      ? 'font-weight:700;color:var(--text)'
      : 'color:var(--text)';
    return `<td style="text-align:center;padding:4px 6px;font-size:12px;font-family:var(--mono);${style}">${pct}</td>`;
  }).join('');

  // イン逃げ時2着率のセル（オブジェクト形式から取得）
  const inn2Cells = courseLabels.map(c => {
    const ci   = parseInt(c);
    if(ci === 1){
      return `<td style="text-align:center;padding:4px 6px;font-size:11px;color:var(--text3)">—</td>`;
    }
    const rate = inn2Place[c] ?? null;
    const pct  = rate != null ? (rate * 100).toFixed(1) + '%' : 'データなし';
    const style = rate == null
      ? 'color:var(--text3);font-size:11px'
      : 'color:var(--text)';
    return `<td style="text-align:center;padding:4px 6px;font-size:12px;font-family:var(--mono);${style}">${pct}</td>`;
  }).join('');

  const venueStatsTable = `
    <div style="padding:0.6rem 1.25rem;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--text3);margin-bottom:6px;text-transform:uppercase">
        ${DATA.venue} — 会場平均
      </div>
      <div class="prob-table-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead>
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:2px 6px;font-size:10px;color:var(--text3);min-width:7em"></td>
            ${courseLabels.map(c=>`<th style="text-align:center;padding:2px 6px;font-size:10px;color:var(--text3);font-weight:500">
              <span class="boat-circle b${c}" style="width:18px;height:18px;font-size:10px;display:inline-flex;align-items:center;justify-content:center">${c}</span>
            </th>`).join('')}
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:4px 6px;font-size:10px;color:var(--text3);white-space:nowrap">コース1着率</td>
            ${courseRateCells}
          </tr>
          <tr>
            <td style="padding:4px 6px;font-size:10px;color:var(--text3);white-space:nowrap">1－◯ 2着率</td>
            ${inn2Cells}
          </tr>
        </tbody>
      </table>
      </div>
    </div>`;

  // ── 展開分析タブ: 会場平均・着順確率・展開シナリオ ──
  document.getElementById('buy-panel').innerHTML = `
    ${venueStatsTable}
    <div style="padding:0.75rem 1.25rem 0.5rem;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text3)">独自補正 最終確率</div>
      </div>
      <div class="prob-table-wrap">
      <table class="prob-table" style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="font-size:10px;color:var(--text3);font-weight:500;padding:3px 4px;text-align:center">枠</th>
          <th style="font-size:10px;color:var(--text3);font-weight:500;padding:3px 4px;text-align:center">選手名</th>
          <th style="font-size:10px;color:var(--text3);font-weight:500;padding:3px 6px;text-align:center" title="6艇のprobに展開補正を加味して正規化し、コース別キャリブレーションまで適用した1着率（展示・スリット補正は含まない／合計100%）">基準</th>
          <th class="admin-only" style="font-size:10px;color:var(--text3);font-weight:500;padding:3px 4px;text-align:center" title="展示タイムの係数（1.0基準: ▲=有利 ▼=不利）。（）内は実際に1着率へ加算される値のpt換算目安（renorm前のため最終確率列の差分とは一致しない参考値）">展示補正</th>
          <th class="admin-only" style="font-size:10px;color:var(--text3);font-weight:500;padding:3px 4px;text-align:center" title="[2026-07-13〜] 実測テーブル会場（住之江/常滑/蒲郡/三国/鳴門/多摩川/平和島）のみ表示。テーブル参照直後の生の1着率加減値(pt)（クランプなし）。展示補正列（コース別クリップ後）と数値が異なる艇はクリップが効いている。それ以外の会場は—">スリット補正</th>
          <th style="font-size:10px;color:var(--text3);font-weight:500;padding:3px 6px;text-align:center" title="基準・展開・展示を均等（1:1:1）で合成・正規化した最終1着率（合計は常に100%）">最終確率</th>
          <th class="admin-only" style="font-size:10px;color:var(--text3);font-weight:500;padding:3px 6px;text-align:center" title="出走表の3連対率（年間）に、実測テーブル会場（住之江/常滑/蒲郡/三国）のみ展示補正（3連対率デルタ）を加えた値。それ以外の会場は基準値のみ表示">3連対率</th>
        </tr></thead>
        <tbody>${probRows}</tbody>
      </table>
      </div>
    </div>
    ${buildScenarioSection(ranked2, place2Map, rawBoats, tenjiScoreMap, hasTenji)}
  `;

  // ── AI予想タブ: 買い目のみ ──
  // 結果データとの的中チェック
  const rKey      = resultKey(slug, DATA.date, rno);
  const resultRd  = RESULT_DATA[rKey];
  const hasResult = !!(resultRd && resultRd.sanrentan && resultRd.sanrentan.length > 0);

  // 結果comboを正規化（区切り文字を統一）して比較用セットを作成
  // normalizeCombo / comboToBadges はファイル先頭でトップレベル定義済み（オッズタブ等と共通利用）
  // sanrentan[0] が確定着順（1着-2着-3着）。全件Setにすると払戻データの他組み合わせと誤マッチする
  const resultSan3  = hasResult && resultRd.sanrentan[0] ? new Set([normalizeCombo(resultRd.sanrentan[0].combo)]) : null;
  // nirentan は sanrentan と独立してチェック（sanrentan がなくても 2連単的中を正しく判定する）
  const resultNiren = resultRd?.nirentan?.[0] ? new Set([normalizeCombo(resultRd.nirentan[0].combo)]) : null;

  function hitBadge(){ return `<span class="hit-badge">🎯 的中</span>`; }

  function buy3Row(r){
    const nc = normalizeCombo(r.c);
    const isHit = resultSan3 && resultSan3.has(nc);
    const probCell = r.prob != null
      ? `<span style="font-size:10px;font-family:var(--mono);color:var(--text3);margin-left:auto;flex-shrink:0">${(r.prob*100).toFixed(1)}%</span>`
      : '';
    return `<div class="buy-row${isHit?' hit':''}">
      <span class="buy-label ${r.lc}">${r.l}</span>
      <span class="buy-combo" style="display:inline-flex;align-items:center;gap:0;letter-spacing:0">${comboToBadges(r.c)}</span>
      ${probCell}
      ${isHit?hitBadge():''}
    </div>`;
  }

  function buy2Row(r){
    const nc = normalizeCombo(r.c);
    const isHit = resultNiren && resultNiren.has(nc);
    const probCell = r.prob != null
      ? `<span style="font-size:10px;font-family:var(--mono);color:var(--text3);margin-left:auto;flex-shrink:0">${(r.prob*100).toFixed(1)}%</span>`
      : '';
    return `<div class="buy-row${isHit?' hit':''}">
      <span class="buy-label ${r.lc}">${r.l}</span>
      <span class="buy-combo" style="display:inline-flex;align-items:center;gap:0;letter-spacing:0">${comboToBadges(r.c)}</span>
      ${probCell}
      ${isHit?hitBadge():''}
    </div>`;
  }

  // ── 買い目を艇番の若い順でソート ──
  buy3.sort((a, b) => {
    const [a1,a2,a3] = a.c.split(/\D+/).map(Number);
    const [b1,b2,b3] = b.c.split(/\D+/).map(Number);
    if(a1 !== b1) return a1 - b1;
    if(a2 !== b2) return a2 - b2;
    return a3 - b3;
  });
  buy2.sort((a, b) => {
    const [a1,a2] = a.c.split(/\D+/).map(Number);
    const [b1,b2] = b.c.split(/\D+/).map(Number);
    if(a1 !== b1) return a1 - b1;
    return a2 - b2;
  });

  // ── シナリオグループ別に買い目をグループ化して表示 ──
  function buildGroupedBuyRows(buyList, resultSet, isTriple) {
  const oddsType = isTriple ? "3t" : "2t";
  // 現在レースのオッズを取得
  const _oddsDate = viewDate || (DATA?.date) || todayDate;
  const raceOdds = ODDS_DATA?.[_oddsDate]?.[DATA?.venue]?.[String(rno)]?.[oddsType] || {};

  let html = '';
  buyList.forEach((r, idx) => {
    const nc    = normalizeCombo(r.c);
    const isHit = resultSet && resultSet.has(nc);

    // AI予想確率
    const probPct = r.prob != null ? (r.prob * 100).toFixed(2) + '%' : '—';

    // ── オッズ取得 ──
    // normalizeCombo で "1-2-3" 形式になっているのでそのまま参照
    const oddsVal = raceOdds[nc] ?? null;
    const oddsStr = oddsVal != null ? oddsVal.toFixed(1) : '—';
    const oddsColor = oddsVal == null ? 'var(--text3)' : 'var(--text)';

    // ── 期待値計算 (AI確率 × オッズ) ──
    let evHtml = '';
    if (r.prob != null && oddsVal != null) {
      const ev = r.prob * oddsVal;
      // EV ≥ 1.0: 緑（プラス期待値） / 0.7〜1.0: オレンジ / < 0.7: 赤
      const evColor = ev >= 1.0
        ? 'var(--green)'
        : ev >= 0.7 ? 'var(--orange)' : 'var(--red)';
      const evWeight = ev >= 1.0 ? '700' : '500';
      evHtml = `<span style="font-size:10px;font-family:var(--mono);font-weight:${evWeight};color:${evColor};flex-shrink:0;min-width:4em;text-align:right">EV${ev.toFixed(2)}</span>`;
    } else if (r.prob != null) {
      // オッズ未取得時はプレースホルダー
      evHtml = `<span style="font-size:10px;color:var(--text3);flex-shrink:0;min-width:4em;text-align:right">EV—</span>`;
    }

    // 順位ラベル
    const rankColor = idx === 0 ? 'var(--gold)' : idx === 1 ? '#aaa' : 'var(--text3)';
    const rankNum   = `<span style="font-size:9px;color:${rankColor};font-weight:700;min-width:14px;flex-shrink:0">${idx+1}</span>`;

    html += `<div class="buy-row${isHit?' hit':''}" style="padding:6px 0">
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:nowrap">
        ${rankNum}
        <span class="buy-combo" style="display:inline-flex;align-items:center;gap:0;letter-spacing:0;flex:1;min-width:0">${comboToBadges(r.c)}</span>
        <span style="font-size:10px;font-family:var(--mono);color:var(--text3);flex-shrink:0;min-width:3.5em;text-align:right">${probPct}</span>
        <span style="font-size:12px;font-family:var(--mono);font-weight:600;color:${oddsColor};flex-shrink:0;min-width:3.8em;text-align:right">${oddsStr}倍</span>
        ${evHtml}
        ${isHit ? hitBadge() : ''}
      </div>
    </div>`;
  });
  return html;
  } // buildGroupedBuyRows 終了

  // ── AI予想タブ: 的中重視 / 回収重視 の2モード生成 ──

  // オッズ取得
  const _oddsDateEv = viewDate || (DATA?.date) || todayDate;
  const raceOdds3tEv = ODDS_DATA?.[_oddsDateEv]?.[DATA?.venue]?.[String(rno)]?.['3t'] || {};
  const _raceOdds2tRaw = ODDS_DATA?.[_oddsDateEv]?.[DATA?.venue]?.[String(rno)]?.['2t'] || {};
  // ODDS_DATAに '2t' がない場合は RESULT_DATA.nirentan の払戻オッズをフォールバックとして使用
  const raceOdds2tEv = (Object.keys(_raceOdds2tRaw).length > 0)
    ? _raceOdds2tRaw
    : (() => {
        const fb = {};
        (resultRd?.nirentan || []).forEach(r => {
          if (r.combo != null && r.odds != null) fb[normalizeCombo(r.combo)] = r.odds;
        });
        return fb;
      })();

  // ── 合成オッズ計算ヘルパー ──
  function calcSynthOdds(list, oddsMap){
    let denom = 0, cnt = 0;
    list.forEach(r => {
      const ov = oddsMap[normalizeCombo(r.c)] ?? null;
      if(ov != null && ov > 0){ denom += 1/ov; cnt++; }
    });
    if(cnt === 0 || denom === 0) return null;
    return 1 / denom;
  }
  function synthOddsHtml(list, oddsMap){
    const so = calcSynthOdds(list, oddsMap);
    if(so == null) return '';
    const soColor = so >= 3.0 ? 'var(--green)' : so >= 1.5 ? 'var(--text2)' : 'var(--red)';
    return `<span style="margin-left:auto;font-size:11px;font-family:var(--mono);font-weight:700;color:${soColor}">合成${so.toFixed(2)}倍</span>`;
  }

  // ── 合成オッズ判定関数 ──
  // 生成した買い目セットの合成オッズを計算し、目標未達なら空配列（見送り）を返す。
  // 買い目の中身は一切削らない。確率順に生成した買い目をそのまま判定する。
  // targetSynth: 目標合成オッズ（hit=2.0, rec=4.0）
  // maxPts: 点数上限
  function checkSynthOdds(list, oddsMap, targetSynth, maxPts){
    const candidates = list.slice(0, maxPts);
    const so = calcSynthOdds(candidates, oddsMap);
    // オッズが1点も取得できていない場合は見送り（参加しない）
    if(so == null){
      console.warn('[checkSynthOdds] オッズ未取得のため見送り', { targetSynth, candidates: candidates.map(r=>r.c) });
      return [];
    }
    // 合成オッズ未達 → 空配列（見送り扱い）
    if(so < targetSynth){
      console.log('[checkSynthOdds] 合成オッズ未達', { so: so.toFixed(2), targetSynth });
      return [];
    }
    return candidates;
  }

  // ── 各買い目にオッズを付与するヘルパー（EV表示用に残す）──
  // [修正] EV計算ロジックは共通ユーティリティ attachEVToCombos に委譲（EVフィルタータブと同一ロジックを共有）。
  // 的中重視／回収重視モードは EV未達でも買い目自体を表示したいため、ここではフィルタリングは行わない。
  function attachEV(list, oddsMap){
    return attachEVToCombos(list, oddsMap, {
      patternKey: 'c', probKey: 'prob', probIsPercentage: false, normalizeCombo,
    });
  }

  // ── 【改修】的中重視モード ──
  // 生成済み buy3Hit_raw を最大10点、合成2.0倍以上にトリム
  // 合成オッズ未達の場合は空配列（見送り）
  const HIT_MAX_PTS     = 10;
  const HIT_SYNTH_MIN   = 2.0;
  const buy3Hit_checked  = checkSynthOdds(buy3Hit_raw, raceOdds3tEv, HIT_SYNTH_MIN, HIT_MAX_PTS);
  // 合成オッズ未達フラグ
  const hitUnderSynth    = buy3Hit_checked.length === 0;
  // 表示用: 未達でも参考として raw を表示するが、EV付与は checked ベース
  // ※ 集計（collectResultsForDate）は computeBuy3 内部で同じ閾値チェック済みなので二重カウントなし
  const buy3Hit          = attachEV(buy3Hit_checked.length > 0 ? buy3Hit_checked : buy3Hit_raw.slice(0, HIT_MAX_PTS), raceOdds3tEv);
  const buy2Hit          = attachEV(buy2Hit_raw.slice(0, 8), raceOdds2tEv);

  // ── 【改修】回収重視モード ──
  // 生成済み buy3Rec_raw を最大10点、合成4.0倍以上にトリム
  // 合成オッズ未達の場合は空配列（見送り）
  const REC_MAX_PTS     = 10;
  // rec合成オッズ基準: 4.0倍固定
  const REC_SYNTH_MIN   = 4.0;
  const buy3Rec_checked  = checkSynthOdds(buy3Rec_raw, raceOdds3tEv, REC_SYNTH_MIN, REC_MAX_PTS);
  const recUnderSynth    = buy3Rec_checked.length === 0;
  const buy3Rec          = attachEV(buy3Rec_checked.length > 0 ? buy3Rec_checked : buy3Rec_raw.slice(0, REC_MAX_PTS), raceOdds3tEv);
  const buy2Rec          = attachEV(buy2Rec_raw.slice(0, 8), raceOdds2tEv);

  // ── パターンバッジ・見送り推奨 ──
  const optPattern    = rd.opt_pattern || null;
  const optPoints     = rd.opt_points  != null ? rd.opt_points : 10;
  // 見送り推奨理由（モード別）
  const passReasonHit = rd.opt_pass_reason_hit || '';
  const passReasonRec = rd.opt_pass_reason_rec || '';
  const patternColors = {
    '高配当1号艇': '#0066ff', '高配当他艇': '#00b86b',
    '中立1号艇':   '#6c7a94', '中立他艇':   '#6c7a94',
    '低配当1号艇': '#ff7a00', '要注意会場': '#ff7a00',
  };
  const patColor   = optPattern ? (patternColors[optPattern] || '#6c7a94') : '#6c7a94';
  const isCaution  = optPattern === '要注意会場';
  const patLabel   = isCaution ? '⚠ ' + optPattern : optPattern;
  const patBadge   = optPattern
    ? `<span style="display:inline-flex;align-items:center;gap:4px;margin-left:6px;">
        <span style="background:${patColor};color:#fff;font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;letter-spacing:.02em;">${patLabel}</span>
        <span style="color:var(--text3);font-size:10px;">推奨${optPoints}点</span>
       </span>`
    : '';

  // ── buildGroupedBuyRows: EVを付与済みリストにも対応 ──
  function buildBuyRows(buyList, resultSet, isTriple){
    const oddsMap = isTriple ? raceOdds3tEv : raceOdds2tEv;
    let html = '';
    buyList.forEach((r, idx) => {
      const nc    = normalizeCombo(r.c);
      const isHit = resultSet && resultSet.has(nc);
      const probPct = r.prob != null ? (r.prob * 100).toFixed(2) + '%' : '—';
      const oddsVal = r._odds ?? (oddsMap[nc] ?? null);
      const oddsStr = oddsVal != null ? oddsVal.toFixed(1) : '—';
      const oddsColor = oddsVal == null ? 'var(--text3)' : 'var(--text)';
      const ev  = r._ev ?? null;
      let evHtml = '';
      if(ev != null){
        const evColor  = ev >= 1.0 ? 'var(--green)' : ev >= 0.7 ? 'var(--orange)' : 'var(--red)';
        const evWeight = ev >= 1.0 ? '700' : '500';
        evHtml = `<span style="font-size:10px;font-family:var(--mono);font-weight:${evWeight};color:${evColor};flex-shrink:0;min-width:4em;text-align:right">EV${ev.toFixed(2)}</span>`;
      } else if(r.prob != null){
        evHtml = `<span style="font-size:10px;color:var(--text3);flex-shrink:0;min-width:4em;text-align:right">EV—</span>`;
      }
      const rankColor = idx === 0 ? 'var(--gold)' : idx === 1 ? '#aaa' : 'var(--text3)';
      const rankNum   = `<span style="font-size:9px;color:${rankColor};font-weight:700;min-width:14px;flex-shrink:0">${idx+1}</span>`;
      html += `<div class="buy-row${isHit?' hit':''}" style="padding:6px 0">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:nowrap">
          ${rankNum}
          <span class="buy-combo" style="display:inline-flex;align-items:center;gap:0;letter-spacing:0;flex:1;min-width:0">${comboToBadges(r.c)}</span>
          <span style="font-size:10px;font-family:var(--mono);color:var(--text3);flex-shrink:0;min-width:3.5em;text-align:right">${probPct}</span>
          <span style="font-size:12px;font-family:var(--mono);font-weight:600;color:${oddsColor};flex-shrink:0;min-width:3.8em;text-align:right">${oddsStr}倍</span>
          ${evHtml}
          ${isHit ? hitBadge() : ''}
        </div>
      </div>`;
    });
    return html || '<div style="padding:8px;color:var(--text3);font-size:12px">買い目なし</div>';
  }

  // ── 各モードのHTML生成 ──
  // underSynth=true のとき: 買い目はそのまま表示し、合成オッズ未達の注意書きを添える
  // passReason が空でないとき: 見送り推奨バナーをタブ直下・buy-grid上に表示
  function buildModePanel(buy3list, buy2list, modeId, underSynth, synthMin, passReason){
    // 見送り・合成オッズ未達に関係なく、買い目が結果と一致すれば的中バッジを常に表示する
    const b3html = buildBuyRows(buy3list, resultSan3, true);
    const b2html = buildBuyRows(buy2list, resultNiren, false);
    const so3    = synthOddsHtml(buy3list, raceOdds3tEv);
    const _soVal = calcSynthOdds(buy3list, raceOdds3tEv);
    const _soStr = _soVal != null ? _soVal.toFixed(2) + '倍' : '取得中';
    const synthWarning = underSynth
      ? `<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:4px;
                     background:rgba(255,180,0,0.10);border:1px solid rgba(255,180,0,0.35);
                     border-radius:6px;font-size:11px;color:var(--orange)">
           <span style="font-size:14px;flex-shrink:0">⚠️</span>
           <span>合成オッズ <strong>${_soStr}</strong>（基準${synthMin}倍未満）。参考買い目として表示していますが、購入は自己判断でお願いします。</span>
         </div>`
      : '';
    // ── 見送り推奨バナー（➊高人気圧縮 ➋中人気ロス ➌limited会場 ➍SS他艇高あれ指数）──
    const passWarning = passReason
      ? `<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;margin:4px 0 6px;
                     background:rgba(220,53,69,0.08);border:1px solid rgba(220,53,69,0.30);
                     border-radius:6px;font-size:11px;color:#c0392b">
           <span style="font-size:15px;flex-shrink:0;line-height:1.4">🚫</span>
           <div style="line-height:1.6">
             <div style="font-weight:700;margin-bottom:2px">見送り推奨</div>
             <div style="color:var(--text2)">${passReason}</div>
           </div>
         </div>`
      : '';
    // 管理者のみ表示するパネル本体（display:none はswitchBuyModeで制御、admin-onlyクラスは付けない）
    const adminContent = `
      <div id="${modeId}" style="display:none">
        ${passWarning}
        <div class="buy-grid">
          <div class="buy-card">
            <div class="buy-card-title" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
              <span>3連単</span>
              <span style="font-weight:400;color:var(--text3);font-size:10px;">${buy3list.length}点</span>
              ${patBadge}
              ${so3}
            </div>
            ${synthWarning}
            ${b3html}
          </div>
          <div class="buy-card">
            <div class="buy-card-title">2連単 <span style="font-weight:400;color:var(--text3);font-size:10px;margin-left:6px">${buy2list.length}点</span></div>
            ${b2html}
          </div>
        </div>
      </div>`;
    return adminContent;
  }

  const hitPanelHtml = buildModePanel(buy3Hit, buy2Hit, 'buy-mode-hit', hitUnderSynth, HIT_SYNTH_MIN, passReasonHit);
  const recPanelHtml = buildModePanel(buy3Rec, buy2Rec, 'buy-mode-rec', recUnderSynth, REC_SYNTH_MIN, passReasonRec);

  // ── シナリオ買いパネル生成 ──
  const scenPanelHtml = buildScenarioBuyPanel(ranked2, sd, resultSan3, raceOdds3tEv, comboToBadges, normalizeCombo, rno);

  // ── イン鉄板パネル生成 ──
  const inTepPanelHtml = buildInTepBuyPanel(ranked2, sd, resultSan3, raceOdds3tEv, comboToBadges, normalizeCombo);

  // ── イン否定パネル生成 ──
  const inNegPanelHtml = buildInNegBuyPanel(ranked2, sd, resultSan3, raceOdds3tEv, comboToBadges, normalizeCombo);

  // イン鉄板条件（タブの強調表示判定）
  const _boat1ForIT = ranked2.find(b => b.boat === 1);
  const _isInTepCond = _boat1ForIT && (_boat1ForIT.final_prob ?? 0) >= 0.75;

  // イン否定条件（タブの強調表示判定）【改修: σ基準ユーティリティを使用】
  const { condMet: _isInNegCond, usingStd: _inNegUsingStd } = _calcInNegCond(ranked2);

  // ── タブUI ──
  const modeTabs = `
    <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:0;background:var(--bg2);">
      <button id="buy-tab-scen" onclick="switchBuyMode('scen')"
        style="flex:1;padding:8px 2px 6px;font-size:11px;font-weight:700;border:none;background:none;cursor:pointer;
               border-bottom:2px solid var(--accent);color:var(--accent);font-family:'Noto Sans JP',sans-serif;
               display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.2;">
        <span>🎲 シナリオ</span>
        <span style="font-size:9px;font-weight:400;color:var(--text3);">18点固定</span>
      </button>
      <button id="buy-tab-intep" onclick="switchBuyMode('intep')"
        style="flex:1;padding:8px 2px 6px;font-size:11px;font-weight:500;border:none;background:none;cursor:pointer;
               border-bottom:2px solid transparent;color:${_isInTepCond?'#4da8ff':'var(--text3)'};font-family:'Noto Sans JP',sans-serif;
               display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.2;">
        <span>🔒 イン鉄板</span>
        <span style="font-size:9px;font-weight:400;color:var(--text3);">${_isInTepCond?'条件成立':'75%未満'}</span>
      </button>
      <button id="buy-tab-inneg" onclick="switchBuyMode('inneg')"
        style="flex:1;padding:8px 2px 6px;font-size:11px;font-weight:500;border:none;background:none;cursor:pointer;
               border-bottom:2px solid transparent;color:${_isInNegCond?'var(--orange)':'var(--text3)'};font-family:'Noto Sans JP',sans-serif;
               display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.2;">
        <span>⚡ イン否定</span>
        <span style="font-size:9px;font-weight:400;color:var(--text3);">${_isInNegCond?'条件成立':(_inNegUsingStd?`場平均-${IN_NEG_N_SIGMA}σ未満`:'場平均-10%未満')}</span>
      </button>
      <button id="buy-tab-hit" onclick="switchBuyMode('hit')"
        style="flex:1;padding:8px 2px 6px;font-size:11px;font-weight:500;border:none;background:none;cursor:pointer;
               border-bottom:2px solid transparent;color:var(--text3);font-family:'Noto Sans JP',sans-serif;
               display:none;flex-direction:column;align-items:center;gap:2px;line-height:1.2;">
        <span>🎯 的中重視</span>
        <span style="font-size:9px;font-weight:400;color:var(--text3);">合成2.0x以上</span>
      </button>
      <button id="buy-tab-hit-lock"
        style="flex:1;padding:8px 2px 6px;font-size:11px;font-weight:500;border:none;background:none;cursor:default;
               border-bottom:2px solid transparent;color:var(--text3);font-family:'Noto Sans JP',sans-serif;
               display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.2;opacity:0.5">
        <span>🔒 的中重視</span>
        <span style="font-size:9px;font-weight:400;color:var(--text3);">管理者限定</span>
      </button>
      <button id="buy-tab-rec" onclick="switchBuyMode('rec')"
        style="flex:1;padding:8px 2px 6px;font-size:11px;font-weight:500;border:none;background:none;cursor:pointer;
               border-bottom:2px solid transparent;color:var(--text3);font-family:'Noto Sans JP',sans-serif;
               display:none;flex-direction:column;align-items:center;gap:2px;line-height:1.2;">
        <span>💰 回収重視</span>
        <span style="font-size:9px;font-weight:400;color:var(--text3);">合成4.0x以上</span>
      </button>
      <button id="buy-tab-rec-lock"
        style="flex:1;padding:8px 2px 6px;font-size:11px;font-weight:500;border:none;background:none;cursor:default;
               border-bottom:2px solid transparent;color:var(--text3);font-family:'Noto Sans JP',sans-serif;
               display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.2;opacity:0.5">
        <span>🔒 回収重視</span>
        <span style="font-size:9px;font-weight:400;color:var(--text3);">管理者限定</span>
      </button>
      <button id="buy-tab-ev" onclick="switchBuyMode('ev')"
        style="flex:1;padding:8px 2px 6px;font-size:11px;font-weight:500;border:none;background:none;cursor:pointer;
               border-bottom:2px solid transparent;color:var(--green);font-family:'Noto Sans JP',sans-serif;
               display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.2;">
        <span>✨ EV買い</span>
        <span style="font-size:9px;font-weight:400;color:var(--text3);">EV1.15以上</span>
      </button>
    </div>`;

  // ── innerHTML 書き込み（scen/intep/inneg を先頭、hit/rec は最後） ──
  // hit/rec パネルは display:none で生成されるが、CSS .admin-only の display:revert に
  // 干渉しないよう admin-only クラスは付けず、JS のみで表示制御する。
  const evFilterPanelHtml = buildEvFilterPanel(
    buy3Hit_raw, buy2Hit_raw, resultSan3, resultNiren,
    raceOdds3tEv, raceOdds2tEv, comboToBadges, normalizeCombo
  );

  document.getElementById('detail2-panel').innerHTML =
    modeTabs + scenPanelHtml + inTepPanelHtml + inNegPanelHtml + hitPanelHtml + recPanelHtml + evFilterPanelHtml;

  // ── 初期表示: シナリオタブをアクティブに ──
  // switchBuyMode を使うと admin チェックが走るため直接操作する
  const _isAdmin = document.body.classList.contains('admin-mode');
  const _allPanelIds = ['buy-mode-scen','buy-mode-intep','buy-mode-inneg','buy-mode-hit','buy-mode-rec'];
  _allPanelIds.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = 'none';
  });
  const _scenPanel = document.getElementById('buy-mode-scen');
  if(_scenPanel) _scenPanel.style.display = 'block';

  // ── 管理者/非管理者でロックタブ・ロックパネルを切り替え ──
  // 的中重視・回収重視タブ: 管理者→本物ボタン表示, 非管理者→ロックボタン表示
  ['hit','rec'].forEach(m => {
    const realTab = document.getElementById('buy-tab-' + m);
    const lockTab = document.getElementById('buy-tab-' + m + '-lock');
    if(realTab) realTab.style.display = _isAdmin ? 'flex' : 'none';
    if(lockTab) lockTab.style.display = _isAdmin ? 'none' : 'flex';
  });
  // ロックパネル（買い目非表示の鍵アイコン）
  ['buy-mode-hit', 'buy-mode-rec'].forEach(mid => {
    const lockEl = document.getElementById('user-lock-' + mid);
    if(lockEl) lockEl.style.display = _isAdmin ? 'none' : 'block';
  });

  // ── キャッシュ保存（改善①）──
  if (DATA && currentVenue) {
    const _ck = _renderCacheKey(rno);
    if (!_renderCache[_ck]) _renderCache[_ck] = {};
    const _buyEl     = document.getElementById('buy-panel');
    const _detail2El = document.getElementById('detail2-panel');
    _renderCache[_ck].buy     = _buyEl     ? _buyEl.innerHTML     : '';
    _renderCache[_ck].detail2 = _detail2El ? _detail2El.innerHTML : '';
    _renderCache[_ck]._ver    = _RENDER_CACHE_VER;
  }

  // バナーをタブ外の常時表示エリアに更新
  updatePersistentBanners(rno);

} // renderBuy 終了

// ── 買い目モード切り替え ──
// ── EVフィルタータブ: AI確率×オッズ が EV1.1以上の買い目のみ表示 ──
function buildEvFilterPanel(buy3list, buy2list, resultSan3, resultNiren,
                             raceOdds3tEv, raceOdds2tEv, comboToBadges, normalizeCombo,
                             evThreshold) {
  // [修正] TOPページの renderScenEVSection と基準を統一し、デフォルトを1.15に変更。
  // config.js側の EV_FILTER_THRESHOLD があればそちらを優先採用。
  const EV_THRESHOLD = evThreshold ?? (typeof EV_FILTER_THRESHOLD !== 'undefined' ? EV_FILTER_THRESHOLD : 1.15);

  // [修正] EV計算・フィルタリングは共通ピュア関数 filterCombosByExpectedValue に委譲。
  // オッズ欠損（特払い・欠場・データ欠損）の買い目は関数側で安全に除外される。
  function filterByEV(list, oddsMap) {
    return filterCombosByExpectedValue(list, oddsMap, EV_THRESHOLD, {
      patternKey: 'c', probKey: 'prob', probIsPercentage: false, normalizeCombo,
    });
  }

  const ev3list = filterByEV(buy3list, raceOdds3tEv);
  const ev2list = filterByEV(buy2list, raceOdds2tEv);

  // ★超妙味株（EV1.5以上）の判定閾値。TOPページの renderScenEVSection と統一。
  const EV_SUPER_THRESHOLD = 1.5;

  function buildEvRows(list, resultSet) {
    if (list.length === 0) {
      return `<div style="padding:16px 8px;color:var(--red);font-size:12px;text-align:center;font-weight:700;line-height:1.6">
        【ケン（見送り推奨）】<br>期待値${EV_THRESHOLD.toFixed(2)}以上の買い目がありません
      </div>`;
    }
    let html = '';
    list.forEach((r, idx) => {
      const nc      = normalizeCombo(r.c);
      const isHit   = resultSet && resultSet.has(nc);
      const probPct = r.prob != null ? (r.prob * 100).toFixed(2) + '%' : '—';
      const oddsStr = r._odds != null ? r._odds.toFixed(1) : '—';
      const ev      = r._ev;
      const isSuper = ev >= EV_SUPER_THRESHOLD;
      const evColor = isSuper ? '#00c853' : 'var(--green)';
      const evHtml  = `<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:${evColor};flex-shrink:0;min-width:4em;text-align:right">EV${ev.toFixed(2)}</span>`;
      const superBadge = isSuper
        ? '<span style="font-size:9px;font-weight:800;color:#00c853;background:#00c85320;border:1px solid #00c853;border-radius:3px;padding:1px 4px;flex-shrink:0">★超妙味株</span>'
        : '';
      const rankColor = idx === 0 ? 'var(--gold)' : idx === 1 ? '#aaa' : 'var(--text3)';
      html += `<div class="buy-row${isHit ? ' hit' : ''}${isSuper ? ' buy-row--super' : ''}"
        style="padding:6px 0${isSuper ? ';border-left:3px solid #00c853;background:rgba(0,200,83,0.06)' : ''}">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:nowrap">
          <span style="font-size:9px;color:${rankColor};font-weight:700;min-width:14px;flex-shrink:0">${idx+1}</span>
          <span class="buy-combo" style="display:inline-flex;align-items:center;gap:0;letter-spacing:0;flex:1;min-width:0">${comboToBadges(r.c)}</span>
          ${superBadge}
          <span style="font-size:10px;font-family:var(--mono);color:var(--text3);flex-shrink:0;min-width:3.5em;text-align:right">${probPct}</span>
          <span style="font-size:12px;font-family:var(--mono);font-weight:600;color:var(--text);flex-shrink:0;min-width:3.8em;text-align:right">${oddsStr}倍</span>
          ${evHtml}
          ${isHit ? '<span style="font-size:10px;background:var(--green);color:#fff;padding:1px 5px;border-radius:3px;font-weight:700">HIT</span>' : ''}
        </div>
      </div>`;
    });
    return html;
  }

  function calcSynth(list) {
    let denom = 0, cnt = 0;
    list.forEach(r => { if (r._odds != null && r._odds > 0) { denom += 1 / r._odds; cnt++; } });
    return (cnt > 0 && denom > 0) ? 1 / denom : null;
  }
  const so3val = calcSynth(ev3list);
  const so3str = so3val != null
    ? `<span style="margin-left:auto;font-size:11px;font-family:var(--mono);font-weight:700;color:${so3val >= 3.0 ? 'var(--green)' : so3val >= 1.5 ? 'var(--text2)' : 'var(--red)'}">合成${so3val.toFixed(2)}倍</span>`
    : '';

  return `<div id="buy-mode-ev" style="display:none">
    <div style="padding:6px 8px 4px;font-size:10px;color:var(--text3);line-height:1.5;background:rgba(0,200,83,0.06);border-bottom:1px solid var(--border)">
      ✨ AI確率 × オッズ が <strong style="color:var(--green)">EV${EV_THRESHOLD.toFixed(2)}以上</strong> の買い目のみ（EV降順・EV1.5以上は★超妙味株）
    </div>
    <div class="buy-grid">
      <div class="buy-card">
        <div class="buy-card-title" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
          <span>3連単</span>
          <span style="font-weight:400;color:var(--text3);font-size:10px">${ev3list.length}点</span>
          ${so3str}
        </div>
        ${buildEvRows(ev3list, resultSan3)}
      </div>
      <div class="buy-card">
        <div class="buy-card-title">2連単 <span style="font-weight:400;color:var(--text3);font-size:10px;margin-left:6px">${ev2list.length}点</span></div>
        ${buildEvRows(ev2list, resultNiren)}
      </div>
    </div>
  </div>`;
}

function switchBuyMode(mode){
  // ── 管理者限定モード（hit / rec）: 非管理者はアクセス不可 ──
  const _adminOnlyModes = ['hit', 'rec'];
  if(_adminOnlyModes.includes(mode) && !document.body.classList.contains('admin-mode')){
    return; // 非管理者は何もしない
  }

  const hitPanel    = document.getElementById('buy-mode-hit');
  const recPanel    = document.getElementById('buy-mode-rec');
  const scenPanel   = document.getElementById('buy-mode-scen');
  const inTepPanel  = document.getElementById('buy-mode-intep');
  const inNegPanel  = document.getElementById('buy-mode-inneg');
  const evPanel     = document.getElementById('buy-mode-ev');
  const hitTab      = document.getElementById('buy-tab-hit');
  const recTab      = document.getElementById('buy-tab-rec');
  const scenTab     = document.getElementById('buy-tab-scen');
  const inTepTab    = document.getElementById('buy-tab-intep');
  const inNegTab    = document.getElementById('buy-tab-inneg');
  const evTab       = document.getElementById('buy-tab-ev');
  // ロックパネル（非管理者向けロック表示）
  const hitLockPanel = document.getElementById('user-lock-buy-mode-hit');
  const recLockPanel = document.getElementById('user-lock-buy-mode-rec');

  if(!hitPanel || !recPanel) return;

  // 全パネルを非表示・ロック表示も閉じる・タブをリセット
  [hitPanel, recPanel, scenPanel, inTepPanel, inNegPanel, evPanel, hitLockPanel, recLockPanel]
    .filter(Boolean).forEach(p => { p.style.display = 'none'; });
  [hitTab, recTab, scenTab, inTepTab, inNegTab, evTab].filter(Boolean).forEach(t => {
    t.style.borderBottomColor = 'transparent';
    t.style.color             = 'var(--text3)';
    t.style.fontWeight        = '500';
  });

  // 選択モードだけアクティブ化
  const activePanel = document.getElementById('buy-mode-' + mode);
  const activeTab   = document.getElementById('buy-tab-' + mode);
  if(activePanel) activePanel.style.display = 'block';
  if(activeTab){
    activeTab.style.borderBottomColor = 'var(--accent)';
    activeTab.style.color             = 'var(--accent)';
    activeTab.style.fontWeight        = '700';
  }
}

// ── イン鉄板買い目パネル生成 ──
// 条件: 1号艇の final_prob >= 0.75
// 買い目: シナリオの2着率上位2艇 A・B を軸に
//   1-A-[B,C], 1-[B,C]-A  （Cは2着率3位）
//   1-B-[A,C], 1-[A,C]-B
//   被り目は除外
function buildInTepBuyPanel(ranked2, sd, resultSan3, raceOdds3tEv, comboToBadges, normalizeCombo){
  const boat1 = ranked2.find(b => b.boat === 1);
  const fp1   = boat1?.final_prob ?? 0;

  // イン鉄板条件チェック
  if(!boat1 || fp1 < 0.75){
    return `<div id="buy-mode-intep" style="display:none">
      <div style="padding:16px 12px;color:var(--text3);font-size:12px;line-height:1.7">
        <div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:6px">🔒 イン鉄板</div>
        <div>1号艇の最終確率が <strong>75%以上</strong> のとき表示されます。</div>
        <div style="margin-top:4px;color:var(--text3);font-size:11px">現在: ${boat1 ? (fp1*100).toFixed(1)+'%' : 'データなし'}</div>
      </div>
    </div>`;
  }

  const { scenarioProb, scenarioPlace2, merged3rdMap } = sd || {};

  // ── シナリオ加重2着確率を算出（winner=1号艇） ──
  function getPlace2Ranking2(winnerBoat){
    // sd が無効（MASTER_EXT未ロード等）または scenarioPlace2 が存在しない場合は
    // final_prob 降順でフォールバック（モバイル等でfetchが間に合わない場合も正常表示）
    if(!sd?.valid || !scenarioPlace2?.[winnerBoat]){
      return ranked2.filter(r => r.boat !== winnerBoat)
        .sort((a, b) => (b.final_prob ?? 0) - (a.final_prob ?? 0))
        .map(r => r.boat);
    }
    const totals = {};
    let weightSum = 0;
    for(const [kimari, list] of Object.entries(scenarioPlace2[winnerBoat])){
      const scenProb = scenarioProb?.[winnerBoat]?.[kimari] ?? 0;
      weightSum += scenProb;
      (list || []).forEach(x => {
        totals[x.boat] = (totals[x.boat] ?? 0) + x.p2 * scenProb;
      });
    }
    if(weightSum <= 0){
      return ranked2.filter(r => r.boat !== winnerBoat)
        .sort((a, b) => (b.final_prob ?? 0) - (a.final_prob ?? 0))
        .map(r => r.boat);
    }
    return Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([boat]) => parseInt(boat));
  }

  // ── 3着候補リスト（merged3rdMapから） ──
  function getPlace3List(winnerBoat, secondBoat){
    const thirdAll = merged3rdMap?.[winnerBoat]?.[secondBoat] || [];
    if(thirdAll.length > 0){
      return thirdAll
        .filter(x => x.boat !== winnerBoat && x.boat !== secondBoat)
        .map(x => x.boat);
    }
    return ranked2
      .filter(r => r.boat !== winnerBoat && r.boat !== secondBoat)
      .sort((a, b) => (b.final_prob ?? 0) - (a.final_prob ?? 0))
      .map(r => r.boat);
  }

  // 2着率上位3艇（1号艇除く）
  const p2rank = getPlace2Ranking2(1).filter(b => b !== 1);
  const p2A = p2rank[0]; // 2着率1位
  const p2B = p2rank[1]; // 2着率2位
  const p2C = p2rank[2]; // 2着率3位

  // p2A/p2B が null の場合（MASTER_EXT 未ロード時など）は ranked2 から直接補完
  if(p2A == null || p2B == null){
    const _fb = ranked2
      .filter(r => r.boat !== 1)
      .sort((a, b) => (b.final_prob ?? 0) - (a.final_prob ?? 0))
      .map(r => r.boat);
    if(_fb.length < 2){
      return `<div id="buy-mode-intep" style="display:none">
        <div style="padding:16px;color:var(--text3);font-size:12px">データ不足のためイン鉄板買い目を生成できません</div>
      </div>`;
    }
    p2rank[0] = _fb[0]; p2rank[1] = _fb[1]; p2rank[2] = _fb[2] ?? null;
  }
  // p2A/p2B/p2C をフォールバック後の値で再バインド
  const [p2A_f, p2B_f, p2C_f] = [p2rank[0], p2rank[1], p2rank[2] ?? null];

  // ── 買い目生成ロジック ──
  // 1-A-(B or C 3着位2位3位) と その折り返し
  // 1-B-(A or C 3着位2位3位) と その折り返し
  // ただし被り目（2着=3着など）は除外

  function makeInTepBlock(winner, second, thirds){
    const combos = [];
    const used = new Set();
    thirds.forEach(t => {
      if(t !== winner && t !== second){
        const fwd = `${winner}-${second}-${t}`;
        const bwd = `${winner}-${t}-${second}`;
        if(!used.has(fwd)){ used.add(fwd); combos.push(fwd); }
        if(!used.has(bwd)){ used.add(bwd); combos.push(bwd); }
      }
    });
    return combos;
  }

  // グループ1: 1-A-{B,C} と 1-{B,C}-A
  const thirdsA = [p2B_f, p2C_f].filter(b => b != null && b !== 1 && b !== p2A_f);
  const blockA = makeInTepBlock(1, p2A_f, thirdsA);

  // グループ2: 1-B-{A,C} と 1-{A,C}-B
  const thirdsB = [p2A_f, p2C_f].filter(b => b != null && b !== 1 && b !== p2B_f);
  const blockB = makeInTepBlock(1, p2B_f, thirdsB);

  // 全体で重複除去
  const allSet = new Set();
  const allCombos = [];
  [...blockA, ...blockB].forEach(c => {
    if(!allSet.has(c)){ allSet.add(c); allCombos.push(c); }
  });

  // ── HTML生成 ──
  const boatBadge = n => `<span class="boat-circle b${n}" style="width:22px;height:22px;font-size:12px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;vertical-align:middle">${n}</span>`;

  function comboToHtml(combo){
    const sep = '<span style="color:var(--text3);margin:0 1px;font-size:11px">-</span>';
    return combo.split('-').map(n => boatBadge(parseInt(n))).join(sep);
  }

  function buyRowIT(c){
    const nc = normalizeCombo(c);
    const isHit = resultSan3 && resultSan3.has(nc);
    const oddsVal = raceOdds3tEv?.[nc] ?? null;
    const oddsStr = oddsVal != null ? oddsVal.toFixed(1) : '—';
    return `<div class="buy-row${isHit?' hit':''}" style="padding:5px 0">
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:nowrap">
        <span class="buy-combo" style="display:inline-flex;align-items:center;gap:0;letter-spacing:0;flex:1;min-width:0">${comboToHtml(c)}</span>
        <span style="font-size:12px;font-family:var(--mono);font-weight:600;color:${oddsVal!=null?'var(--text)':'var(--text3)'};flex-shrink:0;min-width:3.8em;text-align:right">${oddsStr}倍</span>
        ${isHit?`<span style="font-size:10px;font-weight:700;color:var(--green);flex-shrink:0;border:1.5px solid var(--green);border-radius:3px;padding:1px 5px;line-height:1.3">的中</span>`:''}
      </div>
    </div>`;
  }

  // 合成オッズ
  const _synthDenom2 = allCombos.reduce((d, c) => {
    const ov = raceOdds3tEv?.[normalizeCombo(c)] ?? null;
    return (ov != null && ov > 0) ? d + 1/ov : d;
  }, 0);
  const _synthCnt2 = allCombos.filter(c => (raceOdds3tEv?.[normalizeCombo(c)] ?? null) != null).length;
  const itSynth = (_synthCnt2 > 0 && _synthDenom2 > 0) ? 1 / _synthDenom2 : null;

  // 想定的中率
  let _itHitSum = 0, _itHitKnown = 0;
  allCombos.forEach(c => {
    const winner = parseInt(c.split('-')[0]);
    const p = calcScenarioComboProb(c, winner, sd);
    if(p != null){ _itHitSum += p; _itHitKnown++; }
  });
  const itHitRate = _itHitKnown > 0 ? _itHitSum : null;

  // 期待値
  const itEV = (itSynth != null && itHitRate != null) ? itSynth * itHitRate : null;

  // 統計バッジHTML
  const _itSynthColor = itSynth == null ? 'var(--text3)' : itSynth >= 3.0 ? 'var(--green)' : itSynth >= 1.5 ? 'var(--text2)' : 'var(--red)';
  const _itHitColor   = itHitRate == null ? 'var(--text3)' : itHitRate >= 0.30 ? 'var(--green)' : itHitRate >= 0.20 ? 'var(--orange)' : 'var(--red)';
  const _itEVColor    = itEV == null ? 'var(--text3)' : itEV >= 1.3 ? 'var(--green)' : itEV >= 1.1 ? 'var(--orange)' : 'var(--text3)';
  const itStatsHtml = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;padding:6px 0 4px">
      ${itHitRate != null ? `<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:${_itHitColor}">的中率${(itHitRate*100).toFixed(1)}%</span>` : ''}
      ${itSynth   != null ? `<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:${_itSynthColor}">合成${itSynth.toFixed(2)}倍</span>` : ''}
      ${itEV      != null ? `<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:${_itEVColor}">EV${itEV.toFixed(2)}</span>` : ''}
    </div>`;

  let rowsHtml = allCombos.map(c => buyRowIT(c)).join('');

  return `
    <div id="buy-mode-intep" style="display:none">
      <div class="buy-grid">
        <div class="buy-card">
          <div class="buy-card-title" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span>🔒 イン鉄板（3連単）</span>
            <span style="font-weight:400;color:var(--text3);font-size:10px;">${allCombos.length}点</span>
          </div>
          ${itStatsHtml}
          ${rowsHtml || '<div style="padding:8px;color:var(--text3);font-size:12px">買い目を生成できませんでした</div>'}
        </div>
      </div>
    </div>`;
}

// ── イン否定: σ基準の閾値ユーティリティ ──────────────────────────────────
//
// 【改修】固定10%pt → 会場別σ(標準偏差)基準に変更
//
// 判定ロジック:
//   ① MASTER_EXT.venue_stats[venue].course1_std が存在する場合
//      → 閾値 = μ(venue_avg1) - N_SIGMA × σ  (N_SIGMA = 1.0)
//   ② σデータなし（旧JSON互換フォールバック）
//      → 閾値 = μ - FALLBACK_PT (固定 10%pt) ← 以前の挙動を維持
//
// Python側でσを追加するまでは②で動作し、追加後は即①に切り替わる。
//
// 戻り値:
//   { condMet, venueAvg1, fp1, sigma, threshold, usingStd, condDesc }
// ─────────────────────────────────────────────────────────────────────────
const IN_NEG_N_SIGMA    = 1.0;   // σの倍率（1.0σ ≈ 会場ごとの「1標準偏差下」）
const IN_NEG_FALLBACK_PT = 0.10; // σデータがないときの固定マージン（10%pt）

function _calcInNegCond(ranked2, venueOverride) {
  const _venue    = venueOverride ?? DATA.venue ?? null;
  const innData   = DATA.inn_data || {};
  const cRates    = innData.course_rates || [];
  const venueAvg1 = cRates[1] ?? null;
  const boat1     = ranked2.find(b => b.boat === 1);
  const fp1       = boat1?.final_prob ?? null;

  // σ取得: MASTER_EXT.venue_stats[venue].course1_std（小数表現, 例: 0.08）
  const sigma_raw  = MASTER_EXT?.venue_stats?.[_venue]?.course1_std ?? null;
  const sigma      = (sigma_raw !== null && isFinite(sigma_raw) && sigma_raw > 0) ? sigma_raw : null;
  const usingStd   = sigma !== null;
  const margin     = usingStd ? (IN_NEG_N_SIGMA * sigma) : IN_NEG_FALLBACK_PT;
  const threshold  = (venueAvg1 !== null) ? venueAvg1 - margin : null;

  const condMet = (threshold !== null && fp1 !== null)
    ? fp1 <= threshold
    : false;

  // 表示用説明文
  let condDesc;
  if (venueAvg1 === null) {
    condDesc = '場平均データなし';
  } else if (usingStd) {
    condDesc = `1号艇 ${fp1 != null ? (fp1*100).toFixed(1)+'%' : '?'} ／ 場平均 ${(venueAvg1*100).toFixed(1)}%`
      + ` σ=${(sigma*100).toFixed(1)}%pt`
      + `（閾値: 場平均-${IN_NEG_N_SIGMA}σ = ${(threshold*100).toFixed(1)}%）`;
  } else {
    condDesc = `1号艇 ${fp1 != null ? (fp1*100).toFixed(1)+'%' : '?'} ／ 場平均 ${(venueAvg1*100).toFixed(1)}%`
      + `（差: ${fp1 != null ? ((fp1 - venueAvg1)*100).toFixed(1) : '?'}%pt`
      + ` ／ σデータなし・固定${(IN_NEG_FALLBACK_PT*100).toFixed(0)}%pt閾値）`;
  }

  return { condMet, venueAvg1, fp1, sigma, threshold, usingStd, condDesc };
}

// ── イン否定買い目パネル生成 ──
// 【改修】条件: 1号艇 final_prob が 場平均 - N×σ 以下（σあり）
//         または 場平均 - 10%pt 以下（σなし・フォールバック）
// 買い目:
//   軸A・軸B = 1号艇以外の final_prob 上位2艇
//   各軸に対して:
//     ◯-2着上位2艇-3着上位3艇（折り返し含む）各6点 × 2軸 = 計24点 → 被り目除去
function buildInNegBuyPanel(ranked2, sd, resultSan3, raceOdds3tEv, comboToBadges, normalizeCombo){

  // ── 条件チェック（σ基準ユーティリティを使用）──
  const {
    condMet, venueAvg1, fp1: fp1_neg, sigma, threshold, usingStd, condDesc
  } = _calcInNegCond(ranked2);

  if(!condMet){
    return `<div id="buy-mode-inneg" style="display:none">
      <div style="padding:16px 12px;color:var(--text3);font-size:12px;line-height:1.8">
        <div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:6px">⚡ イン否定</div>
        <div>1号艇の最終確率が <strong>${usingStd ? `場平均-${IN_NEG_N_SIGMA}σ以下` : `場平均より${(IN_NEG_FALLBACK_PT*100).toFixed(0)}%pt以上低い`}</strong> とき表示されます。</div>
        <div style="margin-top:6px;font-size:11px;color:var(--text3)">${condDesc}</div>
      </div>
    </div>`;
  }

  const { scenarioProb, scenarioPlace2, merged3rdMap } = sd || {};

  // ── シナリオ加重2着確率ランキング（winnerBoat基準）──
  function getP2Rank(winnerBoat){
    if(!scenarioPlace2?.[winnerBoat]) {
      return ranked2.filter(r => r.boat !== winnerBoat)
        .sort((a,b) => (b.final_prob??0)-(a.final_prob??0))
        .map(r => r.boat);
    }
    const totals = {};
    let weightSum = 0;
    for(const [kimari, list] of Object.entries(scenarioPlace2[winnerBoat])){
      const sp = scenarioProb?.[winnerBoat]?.[kimari] ?? 0;
      weightSum += sp;
      (list||[]).forEach(x => { totals[x.boat] = (totals[x.boat]??0) + x.p2*sp; });
    }
    if(weightSum <= 0){
      return ranked2.filter(r => r.boat !== winnerBoat)
        .sort((a,b) => (b.final_prob??0)-(a.final_prob??0))
        .map(r => r.boat);
    }
    return Object.entries(totals)
      .sort((a,b) => b[1]-a[1])
      .map(([b]) => parseInt(b));
  }

  // ── 3着ランキング（merged3rdMap基準） ──
  function getP3Rank(winnerBoat, secondBoat){
    const thirdAll = merged3rdMap?.[winnerBoat]?.[secondBoat] || [];
    if(thirdAll.length > 0){
      return thirdAll
        .filter(x => x.boat !== winnerBoat && x.boat !== secondBoat)
        .map(x => x.boat);
    }
    return ranked2
      .filter(r => r.boat !== winnerBoat && r.boat !== secondBoat)
      .sort((a,b) => (b.final_prob??0)-(a.final_prob??0))
      .map(r => r.boat);
  }

  // ── 1着軸: 1号艇以外の final_prob 上位2艇 ──
  const outerRanked = ranked2.filter(b => b.boat !== 1)
    .sort((a,b) => (b.final_prob??0)-(a.final_prob??0));
  const axisA = outerRanked[0]?.boat;
  const axisB = outerRanked[1]?.boat;

  if(axisA == null){
    return `<div id="buy-mode-inneg" style="display:none">
      <div style="padding:16px;color:var(--text3);font-size:12px">データ不足のためイン否定買い目を生成できません</div>
    </div>`;
  }

  // ── 折り返し込みブロック生成 ──
  // ◯-2着上位2-3着上位3（折り返し）
  //   正: winner-second-third（2着2艇×3着3艇 = 6点）
  //   折: winner-third-second（3着3艇×2着2艇 = 6点）
  // → 合計12点/軸
  function makeNegBlock(winner){
    const p2rank = getP2Rank(winner).filter(b => b !== winner);
    const sec1   = p2rank[0];
    const sec2   = p2rank[1];
    if(sec1 == null) return { combos: [], sec1: null, sec2: null };

    const combos = [];
    const used   = new Set();

    function add(c){
      if(!used.has(c)){
        const parts = c.split('-').map(Number);
        // 被り目チェック（同じ艇が2着・3着に重複しないか）
        if(new Set(parts).size === parts.length){ used.add(c); combos.push(c); }
      }
    }

    // 2着候補リスト（上位2艇）
    const secs = [sec1, sec2].filter(s => s != null);

    secs.forEach(sec => {
      const p3rank = getP3Rank(winner, sec).filter(b => b !== winner && b !== sec);
      const thirds = p3rank.slice(0, 3);
      thirds.forEach(t => {
        add(`${winner}-${sec}-${t}`);   // 正方向
        add(`${winner}-${t}-${sec}`);   // 折り返し
      });
    });

    return { combos, sec1, sec2 };
  }

  const blockA = makeNegBlock(axisA);
  const blockB = axisB != null ? makeNegBlock(axisB) : { combos: [], sec1: null, sec2: null };

  // 全体重複除去
  const allSet  = new Set();
  const allCombos = [];
  [...blockA.combos, ...blockB.combos].forEach(c => {
    if(!allSet.has(c)){ allSet.add(c); allCombos.push(c); }
  });

  // ── HTML部品 ──
  const boatBadge = n =>
    `<span class="boat-circle b${n}" style="width:22px;height:22px;font-size:12px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;vertical-align:middle">${n}</span>`;

  function comboToHtml(combo){
    const sep = '<span style="color:var(--text3);margin:0 1px;font-size:11px">-</span>';
    return combo.split('-').map(n => boatBadge(parseInt(n))).join(sep);
  }

  function buyRowIN(c){
    const nc      = normalizeCombo(c);
    const isHit   = resultSan3 && resultSan3.has(nc);
    const oddsVal = raceOdds3tEv?.[nc] ?? null;
    const oddsStr = oddsVal != null ? oddsVal.toFixed(1) : '—';
    return `<div class="buy-row${isHit?' hit':''}" style="padding:5px 0">
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:nowrap">
        <span class="buy-combo" style="display:inline-flex;align-items:center;gap:0;letter-spacing:0;flex:1;min-width:0">${comboToHtml(c)}</span>
        <span style="font-size:12px;font-family:var(--mono);font-weight:600;color:${oddsVal!=null?'var(--text)':'var(--text3)'};flex-shrink:0;min-width:3.8em;text-align:right">${oddsStr}倍</span>
        ${isHit?`<span style="font-size:10px;font-weight:700;color:var(--green);flex-shrink:0;border:1.5px solid var(--green);border-radius:3px;padding:1px 5px;line-height:1.3">的中</span>`:''}
      </div>
    </div>`;
  }

  // 合成オッズ
  const _sd = allCombos.reduce((d, c) => {
    const ov = raceOdds3tEv?.[normalizeCombo(c)] ?? null;
    return (ov != null && ov > 0) ? d + 1/ov : d;
  }, 0);
  const _sc = allCombos.filter(c => (raceOdds3tEv?.[normalizeCombo(c)] ?? null) != null).length;
  const inNegSynth      = (_sc > 0 && _sd > 0) ? 1/_sd : null;
  const inNegSynthColor = inNegSynth == null ? 'var(--text3)' : inNegSynth >= 3.0 ? 'var(--green)' : inNegSynth >= 1.5 ? 'var(--text2)' : 'var(--red)';
  const inNegSynthHtml  = inNegSynth != null
    ? `<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:${inNegSynthColor}">合成${inNegSynth.toFixed(2)}倍</span>`
    : '';

  // 軸バッジ
  const axisBadges = [axisA, axisB].filter(Boolean).map(b => boatBadge(b)).join(' ');

  // セクション分け表示（軸A / 軸B）
  let rowsHtml = '';
  if(blockA.combos.length > 0){
    rowsHtml += `<div style="font-size:10px;color:var(--orange);font-weight:700;margin:6px 0 2px;display:flex;align-items:center;gap:4px">
      <span>軸</span>${boatBadge(axisA)}<span>グループ</span>
    </div>`;
    blockA.combos.forEach(c => { rowsHtml += buyRowIN(c); });
  }
  if(blockB.combos.length > 0){
    rowsHtml += `<div style="font-size:10px;color:var(--orange);font-weight:700;margin:10px 0 2px;display:flex;align-items:center;gap:4px">
      <span>軸</span>${boatBadge(axisB)}<span>グループ</span>
    </div>`;
    blockB.combos.forEach(c => { rowsHtml += buyRowIN(c); });
  }

  return `
    <div id="buy-mode-inneg" style="display:none">
      <div class="buy-grid">
        <div class="buy-card">
          <div class="buy-card-title" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span>⚡ イン否定（3連単）</span>
            <span style="font-weight:400;color:var(--text3);font-size:10px;">${allCombos.length}点</span>
            ${inNegSynthHtml}
          </div>
          <div style="background:rgba(255,140,0,0.08);border:1px solid rgba(255,140,0,0.28);border-radius:6px;padding:7px 10px;margin-bottom:8px;font-size:11px;line-height:1.8">
            <div style="font-weight:700;color:var(--orange);margin-bottom:2px">⚡ イン否定モード</div>
            <div style="color:var(--text2);font-size:10px">${condDesc}</div>
            <div style="color:var(--text2);margin-top:3px">1着軸: ${axisBadges}</div>
          </div>
          ${rowsHtml || '<div style="padding:8px;color:var(--text3);font-size:12px">買い目を生成できませんでした</div>'}
        </div>
      </div>
    </div>`;
}

// ── シナリオ買い: 1組合せの推定的中確率を計算 ──
// comboStr  : "1-2-3" 形式の3連単組合せ
// winnerBoat: 1着軸艇番（comboStr の先頭と一致）
// sd        : calcScenarioData の戻り値
// 戻り値    : 推定確率（0〜1）or null（確率不明）
function calcScenarioComboProb(comboStr, winnerBoat, sd) {
  const parts = comboStr.split('-').map(Number);
  const [first, second, third] = parts;
  if (first !== winnerBoat) return 0;

  const { scenarioProb, scenarioPlace2, merged3rdMap, kimariTypes } = sd;
  if (!scenarioProb?.[winnerBoat] || !kimariTypes?.length) return null;

  let probSum = 0;
  let hasAnyData = false;

  for (const kimari of kimariTypes) {
    const scenProb = scenarioProb[winnerBoat]?.[kimari] ?? 0;
    if (scenProb <= 0) continue;

    const p2List = scenarioPlace2?.[winnerBoat]?.[kimari] || [];
    const p2Item = p2List.find(x => x.boat === second);
    const p2     = p2Item?.p2 ?? 0;
    if (p2 <= 0) continue;

    const thirdList = merged3rdMap?.[winnerBoat]?.[second] || [];
    const r3Item    = thirdList.find(x => x.boat === third);
    const r3        = r3Item?.r3 ?? null;
    if (r3 == null) continue;

    probSum    += scenProb * p2 * r3;
    hasAnyData  = true;
  }

  return hasAnyData ? probSum : null;
}

// ── シナリオ買いパネル生成 ──
// ranked2      : final_prob 降順ソート済み艇リスト
// sd           : calcScenarioData の戻り値 ({ scenarioPlace2, ... })
// resultSan3   : 3連単結果 Set（的中バッジ用）
// raceOdds3tEv : 3連単オッズ map
// comboToBadges: コンボ文字列 → 艇バッジHTML変換関数（renderBuy スコープから渡す）
// normalizeCombo: コンボ正規化関数
// raceTagType: 'in_neg'（イン逃げ否定）| 'in_tetsup'（イン逃げ鉄板）| null（通常）
// ピックアップカードから jumpToPickup 経由で開いた場合、
// renderBuy 呼び出し元が _pickupRaceTagType に設定してから呼ぶ。
// 未設定（null）なら従来の通常ロジック。
let _pickupRaceTagType = null;

function buildScenarioBuyPanel(ranked2, sd, resultSan3, raceOdds3tEv, comboToBadges, normalizeCombo, rno){

  // ★★★ sd が undefined または valid=false の場合は再計算 ★★★
  let resolvedSd = sd;
  if (!resolvedSd || !resolvedSd.valid) {
    // ★ 修正⑧: calcScenarioData に masterExt を明示渡し
    const _masterSnapshot = MASTER_EXT ? JSON.parse(JSON.stringify(MASTER_EXT)) : null;
    const _venueKimariSnapshot = _masterSnapshot?.venue_kimari?.[DATA.venue] || null;
    const _innDataSnapshot = DATA.inn_data ? JSON.parse(JSON.stringify(DATA.inn_data)) : null;

    // rawBoats を ranked2 から復元
    const _rawBoats = DATA?.races?.[String(rno)]?.boats || [];
    const _tenjiScoreMap = null; // 必要に応じて calcTenjiScore を呼ぶ
    resolvedSd = calcScenarioData(
      ranked2,
      _rawBoats,
      _tenjiScoreMap,
      DATA.venue,
      DATA,
      {
        masterExt: _masterSnapshot,
        venueKimari: _venueKimariSnapshot,
        innData: _innDataSnapshot,
      }
    );
  }

  // sd が未定義の場合は早期リターン
  if (!resolvedSd || !resolvedSd.valid) {
    return `<div id="buy-mode-scen" style="display:none">
      <div style="padding:16px;color:var(--text3);font-size:12px">展開シナリオデータを生成できませんでした</div>
    </div>`;
  }

  // 以降、resolvedSd を使用
  const { scenarioPlace2, scenarioProb, merged3rdMap, kimariTypes } = resolvedSd;

  if(!ranked2 || ranked2.length < 2){
    return `<div id="buy-mode-scen" style="display:none">
      <div style="padding:16px;color:var(--text3);font-size:12px">データ不足のためシナリオ買いを生成できません</div>
    </div>`;
  }

  // ── タグ種別（ピックアップ連動）──
  const _tagType = _pickupRaceTagType;  // 'in_neg' | 'in_tetsup' | null
  const isInNeg  = _tagType === 'in_neg';
  const isInTep  = _tagType === 'in_tetsup';

  // ══════════════════════════════════════════════════════════════
  // 1着確信度スコア（HHI: ハーフィンダール指数）
  // ──────────────────────────────────────────────────────────────
  // scenarioProb[winner][kimari] の分布がどれだけ1点に集中しているかを測る。
  //
  //   HHI = Σ(各kimariの発生確率)²
  //     → 逃げ100%なら HHI = 1.0（完全確信）
  //     → 5択均等なら HHI = 0.20（全く読めない）
  //
  // ただし競艇は「展開の読めなさ」ではなく「1着艇の特定」が目標なので、
  // 軸候補艇（fp1st）の全シナリオにわたる合計勝率も組み合わせる。
  //
  // 確信度ランク（通常モード・イン鉄板/否定は独自ルールで上書き）:
  //   HIGH  : HHI ≥ 0.55  かつ fp1st合計確率 ≥ 0.50
  //           → 1軸固定・2着A/Bのみ（block3なし）= 最大12点
  //   MID   : HHI ≥ 0.35  または fp1st合計確率 ≥ 0.40
  //           → 現行通り2軸18点
  //   LOW   : それ以外
  //           → 2軸18点 + パネル上部に「読みにくいレース」警告表示
  // ══════════════════════════════════════════════════════════════

  // fp1st を先に仮決めしてHHI計算に使う（イン否定/鉄板は後で上書き）
  const _fp1stTmp = isInNeg
    ? (ranked2.find(b => b.boat !== 1)?.boat ?? ranked2[0]?.boat)
    : ranked2[0]?.boat;

  function calcHHI(winnerBoat) {
    const probs = kimariTypes?.map(k => scenarioProb?.[winnerBoat]?.[k] ?? 0) ?? [];
    const total = probs.reduce((s, p) => s + p, 0);
    if (total <= 0) return 0;
    return probs.reduce((s, p) => s + (p / total) ** 2, 0);
  }

  // 軸艇の全シナリオ合計勝率（ranked2の final_prob ベース）
  const _fp1stProb = ranked2.find(b => b.boat === _fp1stTmp)?.final_prob ?? 0;
  const _fp2ndTmp  = isInNeg
    ? (ranked2.find(b => b.boat !== 1 && b.boat !== _fp1stTmp)?.boat ?? ranked2[1]?.boat)
    : ranked2[1]?.boat;
  const _fp2ndProb = ranked2.find(b => b.boat === _fp2ndTmp)?.final_prob ?? 0;
  const _fpDiffPct = (_fp1stProb - _fp2ndProb) * 100;  // %pt差

  const _hhi = calcHHI(_fp1stTmp);

  // 確信度ランク判定（通常モードのみ適用。鉄板/否定はそれぞれ固定ルール）
  const SCEN_CONF_HIGH_HHI       = 0.55;  // HHI閾値（高確信）
  // [変更] 1着確率閾値を艇番で分岐
  //   1号艇軸: 75%以上（イン鉄板と同等の根拠が必要）
  //   2〜6号艇軸: 50%以上（従来通り）
  const SCEN_CONF_HIGH_PROB_INN  = 0.75;  // 1号艇軸のHIGH閾値
  const SCEN_CONF_HIGH_PROB_OUT  = 0.50;  // 2〜6号艇軸のHIGH閾値
  const SCEN_CONF_MID_HHI        = 0.35;  // HHI閾値（中確信）
  // [変更] MID_PROB廃止 → HIGH未満はすべてMID（2軸展開）
  // 旧: SCEN_CONF_MID_PROB = 0.40
  // 新: HIGHに満たない場合はMIDとして2軸展開
  // [2026-05-31 変更] fp差ゲート廃止 → fp2nd絶対値ベース
  // 旧: SCEN_AXIS2_FP_GAP = 15.0 (%pt差が15以下なら2軸)
  // 新: FP2ND_MIN_FOR_2AXIS = 0.20 (fp2ndが20%以上なら2軸)
  const FP2ND_MIN_FOR_2AXIS = 0.20;

  // 軸艇が1号艇かどうかで HIGH の確率閾値を切り替える
  const _highProbThreshold = (_fp1stTmp === 1) ? SCEN_CONF_HIGH_PROB_INN : SCEN_CONF_HIGH_PROB_OUT;

  let _confRank;  // 'HIGH' | 'MID' | 'LOW'
  if(isInTep || isInNeg){
    // 鉄板・否定は独自ルールで制御するためHHI判定を経由しない
    _confRank = 'MID';
  } else if(_hhi >= SCEN_CONF_HIGH_HHI && _fp1stProb >= _highProbThreshold){
    _confRank = 'HIGH';
  } else if(_hhi >= SCEN_CONF_MID_HHI || _fp1stProb < _highProbThreshold){
    _confRank = 'MID';
  } else {
    _confRank = 'LOW';
  }

  // 2軸目（block3）を出すか: fp2ndが FP2ND_MIN_FOR_2AXIS 以上のときだけ展開
  // HIGH確信時はすでに1軸固定なのでこのフラグは MID/LOW にしか作用しない
  const _allow2ndAxis = _fp2ndProb >= FP2ND_MIN_FOR_2AXIS;

  // ── 軸艇の決定 ──
  // イン逃げ否定: 1号艇を除いた final_prob 最上位を1着軸に
  // イン逃げ鉄板: 1号艇を固定軸に
  // 通常:     final_prob 1位（従来通り）
  let fp1st, fp2nd;
  if(isInNeg){
    const outerTop = ranked2.find(b => b.boat !== 1);
    fp1st = outerTop?.boat ?? ranked2[0]?.boat;
    fp2nd = ranked2.find(b => b.boat !== 1 && b.boat !== fp1st)?.boat ?? ranked2[1]?.boat;
  } else {
    fp1st = ranked2[0]?.boat;  // final_prob 1位
    fp2nd = ranked2[1]?.boat;  // final_prob 2位
  }

  // ── 2着確率上位リストを取得するヘルパー ──
  // scenarioPlace2[winner][kimari] の p2 を kimari ごとに合算して総合2着確率を求める
  function getPlace2Ranking(winnerBoat){
    if(!scenarioPlace2?.[winnerBoat]) return [];
    // kimari をまたいで各艇の p2 を加重平均（シナリオ確率で重みづけ）
    const totals = {};
    let weightSum = 0;
    for(const [kimari, list] of Object.entries(scenarioPlace2[winnerBoat])){
      const scenProb = scenarioProb?.[winnerBoat]?.[kimari] ?? 0;
      weightSum += scenProb;
      (list || []).forEach(x => {
        totals[x.boat] = (totals[x.boat] ?? 0) + x.p2 * scenProb;
      });
    }
    if(weightSum <= 0){
      // フォールバック: kimari なし時は final_prob で代替
      return ranked2
        .filter(r => r.boat !== winnerBoat)
        .sort((a, b) => (b.final_prob ?? 0) - (a.final_prob ?? 0))
        .map(r => r.boat);
    }
    return Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([boat]) => parseInt(boat));
  }

  // イン逃げ鉄板用: inn_2place 降順上位艇リスト
  function getInnTepPlace2Ranking(){
    const inn2p = (() => {
      const v = (DATA.inn_data || {}).inn_2place;
      if(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) return v;
      return MASTER_EXT?.venue_stats?.[DATA.venue]?.inn_2place || {};
    })();
    const sorted = Object.entries(inn2p)
      .map(([k,v]) => ({ boat: parseInt(k), rate: v }))
      .filter(x => !isNaN(x.boat) && x.boat !== 1)
      .sort((a,b) => b.rate - a.rate)
      .map(x => x.boat);
    // inn_2placeが空ならフォールバック
    return sorted.length > 0 ? sorted : getPlace2Ranking(1);
  }

  // ── 3着確率上位リスト（winner・2着を除いた ranked2 の final_prob 順）──
  function getPlace3Ranking(winnerBoat, secondBoat){
    // 展開シナリオタブと同一の merged3rdMap を参照（修正: 旧実装は final_prob 順で
    // 展開タブの3着と食い違いが生じていた。merged3rdMap を使うことで完全一致させる）
    const thirdAll = merged3rdMap?.[winnerBoat]?.[secondBoat] || [];
    if(thirdAll.length > 0){
      return thirdAll
        .filter(x => x.boat !== winnerBoat && x.boat !== secondBoat)
        .slice(0, 3)
        .map(x => x.boat);
    }
    // フォールバック: merged3rdMap がない場合のみ final_prob 順
    return ranked2
      .filter(r => r.boat !== winnerBoat && r.boat !== secondBoat)
      .sort((a, b) => (b.final_prob ?? 0) - (a.final_prob ?? 0))
      .map(r => r.boat)
      .slice(0, 3);
  }

  // ── 3点（折り返し込み6点）生成ヘルパー ──
  // winner-second-third を全候補分 → その後 winner-third-second（折り返し）を全候補分
  function makeBlock(winner, second, thirdCandidates){
    const thirds = thirdCandidates.filter(t => t !== winner && t !== second);
    const forward  = thirds.map(t => `${winner}-${second}-${t}`);
    const backward = thirds.map(t => `${winner}-${t}-${second}`);
    return [...forward, ...backward];
  }

  // ── ブロック生成：タグ種別で分岐 ──
  let block1, block2, block3;
  let second_A, second_B, second_C;
  let _modeLabel = '';  // パネルヘッダー注記用

  if(isInNeg){
    // イン逃げ否定: 外艇2軸（fp1st + fp2nd、どちらも1号艇なし）
    _modeLabel = '⚡ イン逃げ否定モード（外艇軸）';
    const p2r1 = getPlace2Ranking(fp1st);
    second_A = p2r1[0]; second_B = p2r1[1];
    block1 = second_A != null ? makeBlock(fp1st, second_A, getPlace3Ranking(fp1st, second_A)) : [];
    block2 = second_B != null ? makeBlock(fp1st, second_B, getPlace3Ranking(fp1st, second_B)) : [];
    const p2r2 = getPlace2Ranking(fp2nd);
    second_C = p2r2[0];
    block3 = second_C != null ? makeBlock(fp2nd, second_C, getPlace3Ranking(fp2nd, second_C)) : [];
  } else if(isInTep){
    // イン逃げ鉄板: 1号艇固定 + 2着を inn_2place 上位2艇に絞り込み
    _modeLabel = '🔒 イン逃げ鉄板モード（inn_2place 絞り込み）';
    const innRank = getInnTepPlace2Ranking();
    second_A = innRank[0]; second_B = innRank[1];
    second_C = null;
    block1 = second_A != null ? makeBlock(fp1st, second_A, getPlace3Ranking(fp1st, second_A)) : [];
    block2 = second_B != null ? makeBlock(fp1st, second_B, getPlace3Ranking(fp1st, second_B)) : [];
    block3 = [];  // 鉄板時は2グループに絞り EV 向上
  } else {
    // ── 通常モード: 確信度ランクで買い目構成を分岐 ──────────────────
    //
    //  HIGH: 1着がほぼ1艇に絞れている
    //        → fp1st 1軸固定・2着A/Bのみ（block3なし）= 最大12点
    //          水物の2軸目を省いて合成オッズを高める
    //
    //  MID : 1着はある程度絞れているが不確実性もある（現行ロジック）
    //        → fp1st/fp2nd 2軸展開だが fp差 > 15%pt なら1軸に縮退
    //          = 最大18点（fp差大時は最大12点）
    //
    //  LOW : 展開が読みにくい
    //        → MIDと同じ買い目だが警告バナーを表示
    //          「読めないなら買わない」の判断材料として使う
    //
    const p2Ranking1st = getPlace2Ranking(fp1st);
    second_A = p2Ranking1st[0];
    second_B = p2Ranking1st[1];
    block1 = second_A != null ? makeBlock(fp1st, second_A, getPlace3Ranking(fp1st, second_A)) : [];
    block2 = second_B != null ? makeBlock(fp1st, second_B, getPlace3Ranking(fp1st, second_B)) : [];

    // [変更] HIGH でも fp2nd ≥ FP2ND_MIN_FOR_2AXIS(20%) なら2軸許可
    // 旧: HIGH固定で block3なし
    // 新: fp2nd絶対値で判断（例: 52.6% vs 26.8% → 2軸展開）
    if(_allow2ndAxis){
      const p2Ranking2nd = getPlace2Ranking(fp2nd);
      second_C = p2Ranking2nd[0];
      block3 = second_C != null ? makeBlock(fp2nd, second_C, getPlace3Ranking(fp2nd, second_C)) : [];
    } else {
      // fp2nd < 20% → 2軸目は根拠が薄いため追加しない
      second_C = null;
      block3   = [];
    }
  }

  // ── 各ブロック内を 2着→3着 の艇番昇順にソート ──
  // "1着-2着-3着" 形式で split('-') → [1着, 2着, 3着] の数値比較
  function sortBlockAsc(block) {
    return [...block].sort((a, b) => {
      const [, a2, a3] = a.split('-').map(Number);
      const [, b2, b3] = b.split('-').map(Number);
      if (a2 !== b2) return a2 - b2;
      return a3 - b3;
    });
  }
  block1 = sortBlockAsc(block1);
  block2 = sortBlockAsc(block2);
  block3 = sortBlockAsc(block3);

  // 重複除去 → 全体を 1着固定・2着昇順・3着昇順でソート
  const allCombosSet = new Set();
  const allCombosRaw = [];
  [block1, block2, block3].forEach(block => {
    block.forEach(c => {
      if(!allCombosSet.has(c)){ allCombosSet.add(c); allCombosRaw.push(c); }
    });
  });
  const allCombos = allCombosRaw.slice().sort((a, b) => {
    const [a1, a2, a3] = a.split('-').map(Number);
    const [b1, b2, b3] = b.split('-').map(Number);
    if (a1 !== b1) return a1 - b1;
    if (a2 !== b2) return a2 - b2;
    return a3 - b3;
  });

  // ── キャッシュ保存（メモリ + localStorage）──
  // _saveScenComboToLS がメモリと localStorage 両方に書く。
  // リロード後も _initScenComboCache() で復元されるため
  // 過去日・翌日集計でも画面表示と集計の買い目が完全に一致する。
  _saveScenComboToLS(
    DATA && DATA.venue ? DATA.venue : '',
    DATA && DATA.date  ? DATA.date  : '',
    rno,
    allCombos
  );

  // ── HTML生成 ──
  const boatBadge = n => `<span class="boat-circle b${n}" style="width:22px;height:22px;font-size:12px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;vertical-align:middle">${n}</span>`;
  function comboToHtml(combo){
    const sep = '<span style="color:var(--text3);margin:0 1px;font-size:11px">-</span>';
    return combo.split('-').map(n => boatBadge(parseInt(n))).join(sep);
  }


  function blockHeader(label, winner, second){
    // グループ見出しは非表示（要件: ①②③ヘッダー削除）
    return '';
  }

  function buyRow(c){
    const nc = normalizeCombo(c);
    const isHit = resultSan3 && resultSan3.has(nc);
    const oddsVal = raceOdds3tEv?.[nc] ?? null;
    const oddsStr = oddsVal != null ? oddsVal.toFixed(1) : '—';
    return `<div class="buy-row${isHit?' hit':''}" style="padding:5px 0">
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:nowrap">
        <span class="buy-combo" style="display:inline-flex;align-items:center;gap:0;letter-spacing:0;flex:1;min-width:0">${comboToHtml(c)}</span>
        <span style="font-size:12px;font-family:var(--mono);font-weight:600;color:${oddsVal!=null?'var(--text)':'var(--text3)'};flex-shrink:0;min-width:3.8em;text-align:right">${oddsStr}倍</span>
        ${isHit?`<span style="font-size:10px;font-weight:700;color:var(--green);flex-shrink:0;border:1.5px solid var(--green);border-radius:3px;padding:1px 5px;line-height:1.3">的中</span>`:''}
      </div>
    </div>`;
  }

  // ── 重複除去済み allCombos から一括生成（被り目を表示しない）──
  let rowsHtml = allCombos.map(c => buyRow(c)).join('');

  const totalPts = allCombos.length;

  // ── 合算的中率の計算 ──
  let _hitRateSum   = 0;
  let _hitRateKnown = 0;
  allCombos.forEach(c => {
    const winner = parseInt(c.split('-')[0]);
    const p = calcScenarioComboProb(c, winner, resolvedSd);
    if (p != null) { _hitRateSum += p; _hitRateKnown++; }
  });
  const _hitRatePct   = _hitRateSum * 100;
  const _hitRateStr   = _hitRatePct.toFixed(1) + '%';
  const _hitRateColor = _hitRatePct >= 30 ? 'var(--green)'
                      : _hitRatePct >= 20 ? 'var(--orange)'
                      : 'var(--red)';
  const hitRateHtml = _hitRateKnown > 0
    ? `<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:${_hitRateColor}">的中率${_hitRateStr}</span>`
    : '';

  // 合成オッズ計算
  const _synthDenom = allCombos.reduce((d, c) => {
    const ov = raceOdds3tEv?.[normalizeCombo(c)] ?? null;
    return (ov != null && ov > 0) ? d + 1/ov : d;
  }, 0);
  const _synthCnt = allCombos.filter(c => (raceOdds3tEv?.[normalizeCombo(c)] ?? null) != null).length;
  const scenSynth = (_synthCnt > 0 && _synthDenom > 0) ? 1 / _synthDenom : null;
  const scenSynthColor = scenSynth == null ? 'var(--text3)' : scenSynth >= 3.0 ? 'var(--green)' : scenSynth >= 1.5 ? 'var(--text2)' : 'var(--red)';
  const scenSynthHtml = scenSynth != null
    ? `<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:${scenSynthColor}">合成${scenSynth.toFixed(2)}倍</span>`
    : '';

  // ── 期待値計算 & バッジ ──
  const _ev = (scenSynth != null && _hitRateSum > 0) ? scenSynth * _hitRateSum : null;
  const evBadgeHtml = (() => {
    if (_ev == null) return '';
    const color = _ev >= 1.3 ? 'var(--green)' : _ev >= 1.1 ? 'var(--orange)' : 'var(--text3)';
    const star  = _ev >= 1.1 ? ' ⭐' : '';
    return `<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:${color}">EV${_ev.toFixed(2)}${star}</span>`;
  })();

  // ── 期待値キャッシュ保存 ──
  // 期待値 = 合成オッズ × 想定的中率（小数）
  // TOP ページの「期待値1.1」セクションから参照する
  if(DATA && DATA.venue && DATA.date && rno != null){
    const _evKey = `${DATA.venue}_${DATA.date}_${rno}`;
    // バナー用追加フィールド
    const _b1scen       = ranked2.find(b => b.boat === 1);
    const _fp1scen      = _b1scen?.final_prob ?? null;
    const _vAvg1scen    = (DATA.inn_data||{}).course_rates?.[1] ?? null;
    const _prev         = _scenEVCache[_evKey] || {};
    _scenEVCache[_evKey] = {
      venue    : DATA.venue,
      date     : DATA.date,
      rno      : rno,
      ev       : _ev,          // 期待値（null = 計算不可）
      synth    : scenSynth,    // 合成オッズ
      hitRate  : _hitRateSum,  // 想定的中率（0〜1）
      pts      : totalPts,
      // バナー用: prefill で計算済みの hit/rec/tep/neg フィールドは引き継ぐ
      flagHit  : _prev.flagHit  ?? null,
      synthHit : _prev.synthHit ?? null,
      flagRec  : _prev.flagRec  ?? null,
      synthRec : _prev.synthRec ?? null,
      flagInTep: _prev.flagInTep ?? null,
      tepSynth : _prev.tepSynth ?? null,
      flagInNeg: _prev.flagInNeg ?? null,
      negSynth : _prev.negSynth ?? null,
      fp1      : _fp1scen,
      venueAvg1: _vAvg1scen,
    };
    // TOPページが表示中であれば期待値セクションを即時更新
    const topPage = document.getElementById('top-page');
    if(topPage && topPage.style.display !== 'none'){
      renderScenEVSection();
    }
  }

  // ── 確信度バナー（通常モードのみ表示）──────────────────────────────────
  // HHI と fp1st確率をもとに「このレースの1着がどれだけ読めているか」を表示する。
  // イン鉄板・イン否定は独自ロジックで決まるためバナーを出さない。
  const _confBannerHtml = (()=>{
    if(isInNeg || isInTep) return '';
    const hhiPct = Math.round(_hhi * 100);
    const fp1Pct = Math.round(_fp1stProb * 100);
    if(_confRank === 'HIGH'){
      return `<div style="font-size:10px;color:var(--green);margin-bottom:4px;padding:4px 8px;background:rgba(29,158,117,0.10);border-radius:4px;line-height:1.7">
        🎯 高確信（1軸） — HHI ${hhiPct}% / 1着確率 ${fp1Pct}%｜2軸目を省いて合成オッズ優先
      </div>`;
    } else if(_confRank === 'LOW'){
      return `<div style="font-size:10px;color:var(--orange);margin-bottom:4px;padding:4px 8px;background:rgba(239,159,39,0.10);border-radius:4px;line-height:1.7">
        ⚠ 読みにくいレース — HHI ${hhiPct}% / 1着確率 ${fp1Pct}%｜展開が分散しています。見送りも検討を
      </div>`;
    }
    // MID はバナーなし（静かに2軸展開）
    return '';
  })();

  // モード別説明文
  const modeDescHtml = isInNeg
    ? `<div style="font-size:10px;color:var(--orange);margin-bottom:4px;font-weight:700">⚡ イン逃げ否定モード — 外艇を軸に組み立てます</div>`
    : isInTep
    ? `<div style="font-size:10px;color:var(--accent2);margin-bottom:4px;font-weight:700">🔒 イン逃げ鉄板モード — 1号艇固定・inn_2place 上位2着に絞り込み</div>`
    : _confBannerHtml;

  // 確信度ランクをタイトルに添える（通常モードのみ）
  const _confLabel = (!isInNeg && !isInTep)
    ? { HIGH: ' 🎯高確信', MID: '', LOW: ' ⚠要注意' }[_confRank]
    : '';

  const axisDesc = isInTep
    ? `軸: ${boatBadge(fp1st)}（固定）`
    : isInNeg
    ? `外軸: ${boatBadge(fp1st)} / ${fp2nd!=null?boatBadge(fp2nd):''}`
    : `最終確率1位: ${boatBadge(fp1st)} 　2位: ${boatBadge(fp2nd!=null?fp2nd:'')}`;

  // 管理者のみ表示する説明バナー
  const _isAdminScen = document.body.classList.contains('admin-mode');
  const _modeDescAdminHtml = modeDescHtml && _isAdminScen ? modeDescHtml : '';

  return `
    <div id="buy-mode-scen" style="display:none">
      <div class="buy-grid">
        <div class="buy-card">
          <div class="buy-card-title" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span>🎲 シナリオ買い（3連単）${_confLabel}</span>
            <span style="font-weight:400;color:var(--text3);font-size:10px;">${totalPts}点</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;font-size:11px">
            ${hitRateHtml}
            ${scenSynthHtml}
            ${evBadgeHtml}
          </div>
          ${_modeDescAdminHtml}
          ${rowsHtml || '<div style="padding:8px;color:var(--text3);font-size:12px">買い目を生成できませんでした</div>'}
        </div>
      </div>
    </div>`;

}                  //

// ── renderComment ──
function renderComment(rno){
  const rd = DATA.races[String(rno)];
  if(!rd){ console.warn('[renderComment] no race data for rno=', rno); return; }
  const boats = [...rd.boats].sort((a,b)=>a.boat-b.boat);
  const kimariHtml  = buildKimariTable(boats);
  const motorHtml   = buildMotorInfoSection(rno, boats);
  const commentHtml = buildCommentSection(rno, boats);
  const html = `<div class="detail-panel">${kimariHtml}${motorHtml}${commentHtml}</div>`;
  document.getElementById('comment-panel').innerHTML = html;
}

// ── タブ切り替え ──
// ── 結果タブ描画 ──────────────────────────────────────────────────────────
function resultKey(venueSlug, date, rno){
  // RESULT_DATA のキー形式: "{slug}_{YYYYMMDD}_{rno}"
  const dateNd = (date || '').replace(/-/g, '');
  return `${venueSlug}_${dateNd}_${rno}`;
}

function renderResult(rno){
  const panel = document.getElementById('result-panel');
  if(!panel) return;
  if(!DATA || !rno){
    panel.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text3)">レースを選択してください</div>';
    return;
  }

  const slug    = VENUE_SLUG_MAP[DATA.venue] || DATA.venue;
  const key     = resultKey(slug, DATA.date, rno);
  const rd      = RESULT_DATA[key];

  if(!rd || !rd.sanrentan || rd.sanrentan.length === 0){
    panel.innerHTML = `
      <div style="padding:2rem;text-align:center;color:var(--text3)">
        <div style="font-size:24px;margin-bottom:8px">⏳</div>
        <div style="font-size:13px">${rno}R の結果はまだありません</div>
        <div style="font-size:11px;margin-top:6px;color:var(--text3)">レース確定後に自動取得されます</div>
      </div>`;
    return;
  }

  // 枠番カラー丸バッジ（boat-circle スタイル流用）
  const boatBadge = n => `<span class="boat-circle b${n}" style="width:22px;height:22px;font-size:12px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;vertical-align:middle">${n}</span>`;

  // comboを枠番バッジの並びに変換（例: "3-1-5" → ➌➊➎バッジ列）
  function formatCombo(combo){
    return (combo||'').replace(/(\d)/g, m => boatBadge(parseInt(m)));
  }

  // 数字単体を枠番バッジに（返還用）
  const circledNum = n => boatBadge(n);

  // 3連単トップ3
  const san = rd.sanrentan.slice(0, 3);

  const sanHtml = san.map((r, i) => {
    const isHigh = r.odds >= 10000;
    const oddsClass = isHigh ? ' high' : '';
    const ninki = r.ninki ? `<span class="result-ninki">${r.ninki}番人気</span>` : '';
    return `
    <div class="result-row">
      <span class="result-combo">${formatCombo(r.combo)}</span>
      <span class="result-odds${oddsClass}">￥${r.odds.toLocaleString()}</span>
      ${ninki}
    </div>`;
  }).join('');

  // 決まり手（JSONキー: kimari）
  const kimariHtml = rd.kimari
    ? `<div class="result-meta-row"><span class="result-meta-label">決まり手</span><span>${rd.kimari}</span></div>`
    : '';

  // 返還（あれば表示、空配列・nullなら非表示）
  const henkanList = Array.isArray(rd.henkan) ? rd.henkan : (rd.henkan ? [rd.henkan] : []);
  const henkanHtml = henkanList.length > 0
    ? `<div class="result-henkan-row"><span class="result-meta-label">返還</span><span>${henkanList.map(n => circledNum(n)).join('　')}</span></div>`
    : '';

  panel.innerHTML = `
    <div class="result-panel-inner">
      <div class="result-section-title">3連単 払戻</div>
      ${sanHtml}
      ${kimariHtml}
      ${henkanHtml}
    </div>
  `;
}

// ── オッズタップ選択（色反転・永続化）──
// タップした買い目に .odds-picked クラスを付け外しする。
// 選択状態は _oddsPickSet に「日付__会場__レース__券種__組番」のキーで保存するため、
// レース切替・タブ切替でHTMLが作り直されても renderOdds 側でクラスを復元できる。
// _oddsPickOdds には同じキーに対応するオッズ数値を保持し、合成オッズの計算に使う。
// スタイルシート側の !important ルールはインラインstyle(非!important)より優先されるため、
// 各セル/行に既に付いているインラインの色指定があっても選択時は上書きできる。
const _oddsPickSet  = new Set();
const _oddsPickOdds = new Map(); // key -> odds(number)

function _oddsPickKey(date, venue, rno, type, combo){
  return `${date}__${venue}__${rno}__${type}__${combo}`;
}

function toggleOddsPick(el, key, odds){
  if (!el) return;
  if (_oddsPickSet.has(key)) {
    _oddsPickSet.delete(key);
    _oddsPickOdds.delete(key);
    el.classList.remove('odds-picked');
  } else {
    _oddsPickSet.add(key);
    if (odds != null && !isNaN(odds)) _oddsPickOdds.set(key, odds);
    el.classList.add('odds-picked');
  }
  _updateOddsPickSummary();
}

// 現在表示中レースの選択のみクリア（他レースの選択は残す）
function clearOddsPicksForRace(date, venue, rno){
  const prefix = `${date}__${venue}__${rno}__`;
  [..._oddsPickSet].forEach(k => {
    if (k.startsWith(prefix)) { _oddsPickSet.delete(k); _oddsPickOdds.delete(k); }
  });
  document.querySelectorAll('#odds-panel .odds-picked').forEach(el => el.classList.remove('odds-picked'));
  _updateOddsPickSummary();
}

// 合成オッズ = 1 / Σ(1/各オッズ)（選択した買い目に均等に賭けた場合、
// どれか一つが的中すれば戻ってくる倍率）
function _compositeOdds(keys){
  let invSum = 0;
  let valid  = 0;
  keys.forEach(k => {
    const o = _oddsPickOdds.get(k);
    if (o != null && o > 0) { invSum += 1 / o; valid++; }
  });
  if (valid === 0 || invSum <= 0) return null;
  return 1 / invSum;
}

// 選択中の点数・合成オッズを summary バーに反映する
function _updateOddsPickSummary(){
  const bar = document.getElementById('odds-pick-summary');
  if (!bar) return;
  const prefix = bar.dataset.prefix || '';
  const keys   = [..._oddsPickSet].filter(k => k.startsWith(prefix));
  const count  = keys.length;

  const countEl = bar.querySelector('[data-role="odds-pick-count"]');
  if (countEl) countEl.textContent = count;

  const composite = _compositeOdds(keys);
  const compEl = bar.querySelector('[data-role="odds-pick-composite"]');
  if (compEl) compEl.textContent = composite != null ? `${composite.toFixed(2)}倍` : '—';

  bar.style.display = count > 0 ? '' : 'none';
}

function _ensureOddsPickStyle(){
  if (document.getElementById('odds-pick-style')) return;
  const st = document.createElement('style');
  st.id = 'odds-pick-style';
  st.textContent = `
    .odds-picked{ background:var(--accent2) !important; }
    .odds-picked *{ color:#fff !important; }
  `;
  document.head.appendChild(st);
}

function renderOdds(rno) {
  const panel = document.getElementById('odds-panel');
  if (!panel) return;
  _ensureOddsPickStyle();
  if (!DATA || !rno) {
    panel.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text3)">レースを選択してください</div>';
    return;
  }

  const _oddsDateR = viewDate || (DATA?.date) || todayDate;
  const raceOdds = ODDS_DATA?.[_oddsDateR]?.[DATA.venue]?.[String(rno)];
  // このレースの選択キーの接頭辞（summaryバーの集計・クリア用）
  const _oddsPickPrefix = `${_oddsDateR}__${DATA.venue}__${rno}__`;

  if (!raceOdds) {
    panel.innerHTML = `
      <div style="padding:2rem;text-align:center;color:var(--text3)">
        <div style="font-size:1.5rem;margin-bottom:8px">—</div>
        <div style="font-size:13px">オッズ未取得</div>
        <div style="font-size:11px;margin-top:6px;color:var(--text3)">次回 auto_push 時に反映されます</div>
      </div>`;
    return;
  }

  // 艇番 → 選手名 のマップ（マトリクス表のヘッダーに使用）
  const _rd_odds   = DATA.races?.[String(rno)];
  const _nameByBoat = {};
  (_rd_odds?.boats || []).forEach(b => { _nameByBoat[b.boat] = b.name; });

  // 艇番カラー（CSSの .b1〜.b6 と同じ配色をインラインで再現）
  const BOAT_BG = { 1:'#ffffff', 2:'#000000', 3:'#e60012', 4:'#0066cc', 5:'#ffcc00', 6:'#00a651' };
  const BOAT_FG = { 1:'#111111', 2:'#ffffff', 3:'#ffffff', 4:'#ffffff', 5:'#111111', 6:'#ffffff' };
  const BOAT_BORDER = n => n === 1 ? 'border:1px solid rgba(0,0,0,0.35);' : '';

  // ── 3連単マトリクス表を生成（テーブル構造）──
  // 列=1着艇(1-6) → 各列内で2着艇(残り5艇)ごとに行グループ化（艇番カラーの縦帯） → 各グループ内の行=3着艇(残り4艇)
  function build3tMatrixHtml(dict) {
    if (!dict || Object.keys(dict).length === 0) return '';

    const oddsByCombo = {};
    Object.entries(dict).forEach(([combo, odds]) => {
      oddsByCombo[normalizeCombo(combo)] = odds;
    });

    const boatNums = [1, 2, 3, 4, 5, 6];
    const COL_W = 118; // 各1着列の幅(px): 「艇番バッジ＋オッズ」セル分

    // 正方形角丸の艇番バッジ（画像のデザイン: 丸ではなく角丸スクエア）
    const boatBadge = (n, size, fontSize) =>
      `<span style="width:${size}px;height:${size}px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:${fontSize}px;font-weight:700;flex-shrink:0;background:${BOAT_BG[n]};color:${BOAT_FG[n]};${BOAT_BORDER(n)}">${n}</span>`;

    // ── ヘッダー行: 艇番カラー背景＋艇番バッジ＋選手名 ──
    // tbody側は各1着列につき「2着バッジ用td + 3着セル用td」の2セル構成のため、
    // theadのthもcolspan="2"にして列数を一致させる（不一致だとレイアウトが右にずれる）。
    // 艇番バッジの背景は「背景色に対して視認性が保たれる半透明」を艇番ごとに調整
    // （1号艇=白背景には黒系半透明、それ以外の濃色背景には白系半透明）
    const headBadgeBg = n => n === 1 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.30)';
    const headHtml = boatNums.map(first => {
      const nm = _nameByBoat[first] || '';
      return `<th colspan="2" style="min-width:${COL_W}px;padding:0;border:1px solid var(--border);background:${BOAT_BG[first]}">
        <div style="display:flex;align-items:center;gap:6px;padding:6px 8px;white-space:nowrap;overflow:hidden">
          <span style="width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;background:${headBadgeBg(first)};color:${BOAT_FG[first]};${BOAT_BORDER(first)}">${first}</span>
          <span style="font-size:13px;font-weight:700;color:${BOAT_FG[first]};overflow:hidden;text-overflow:ellipsis">${nm}</span>
        </div>
      </th>`;
    }).join('');



    // 各列に対して [{second, cells:[{third,odds}, x4]}, x5] を作る
    const perColumnGroups = boatNums.map(first => {
      const seconds = boatNums.filter(n => n !== first);
      return seconds.map(second => {
        const thirds = boatNums.filter(n => n !== first && n !== second);
        return {
          second,
          cells: thirds.map(third => ({
            third,
            odds: oddsByCombo[`${first}-${second}-${third}`] ?? null,
          })),
        };
      });
    });

    // 20行分（5グループ×4行）を構築。各セルは「2着バッジ(rowspan=4・艇番カラー縦帯) + 3着バッジ + オッズ」
    const TOTAL_ROWS = 5 * 4;
    const bodyRows = [];
    for (let r = 0; r < TOTAL_ROWS; r++) {
      const groupIdx     = Math.floor(r / 4);
      const rowInGroup    = r % 4;
      const isGroupStart  = rowInGroup === 0;
      const stripeBg       = groupIdx % 2 === 1 ? 'background:var(--bg3);' : '';

      const tds = boatNums.map((first, colIdx) => {
        const group = perColumnGroups[colIdx][groupIdx];
        const cell  = group.cells[rowInGroup];
        const odds  = cell.odds;
        const oddsLabel = odds != null ? odds.toFixed(1) : '—';
        const oddsColor = odds == null ? 'var(--text3)' : 'var(--text)';

        const cellCombo = `${first}-${group.second}-${cell.third}`;
        const cellKey   = _oddsPickKey(_oddsDateR, DATA.venue, rno, '3t', cellCombo);
        const cellPicked = _oddsPickSet.has(cellKey) ? ' odds-picked' : '';
        if (odds != null && cellPicked) _oddsPickOdds.set(cellKey, odds); // 復元時にオッズ値も補完
        const cellClickable = odds != null;
        const cellOnclick   = cellClickable ? ` onclick="toggleOddsPick(this, '${cellKey}', ${odds})"` : '';
        const cellCursor    = cellClickable ? 'cursor:pointer;' : '';

        const secondBadgeTd = isGroupStart
          ? `<td rowspan="4" style="width:34px;height:144px;padding:0;border:1px solid var(--border);vertical-align:middle;background:${BOAT_BG[group.second]}">
              <div style="display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:${BOAT_FG[group.second]}">${group.second}</div>
            </td>`
          : '';

        return `${secondBadgeTd}<td class="${cellPicked.trim()}" style="height:36px;padding:4px 8px;border:1px solid var(--border);white-space:nowrap;${cellCursor}${stripeBg}"${cellOnclick}>
          <div style="display:flex;align-items:center;gap:6px">
            ${boatBadge(cell.third, 18, 11)}
            <span style="font-family:var(--mono);font-size:13px;font-weight:500;color:${oddsColor};margin-left:auto">${oddsLabel}</span>
          </div>
        </td>`;
      }).join('');

      bodyRows.push(`<tr>${tds}</tr>`);
    }

    return `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--accent2);border-radius:6px">
      <table style="border-collapse:collapse;table-layout:auto;width:100%;box-sizing:border-box">
        <thead><tr>${headHtml}</tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table>
    </div>`;
  }

  const matrix3tHtml = build3tMatrixHtml(raceOdds['3t']);
  const matrix3tSection = matrix3tHtml
    ? `<div class="buy-card" style="overflow:visible">
        <div class="buy-card-title">3連単</div>
        ${matrix3tHtml}
      </div>`
    : '';

  // ── 各種別のテーブルを生成 ──
  // 3連単（3t）のみ「1着列×2着グループ×3着行」のマトリクス表で表示する。
  // 他の券種（3連複・2連単・2連複・単勝）は人気順の縦リストのまま。
  const TYPES = [
    { key: "3f",  label: "3連複", cols: 3 },
    { key: "2t",  label: "2連単", cols: 2 },
    { key: "2f",  label: "2連複", cols: 2 },
    { key: "tan", label: "単勝",  cols: 1 },
  ];

  // 人気順（オッズ昇順）でソート
  function sortedEntries(dict) {
    if (!dict) return [];
    return Object.entries(dict)
      .map(([combo, odds]) => ({ combo, odds }))
      .sort((a, b) => a.odds - b.odds);
  }

  // 各種別のHTMLを生成（リスト形式の券種のみ。3連単マトリクスは別途全幅で配置）
  const sectionsHtml = TYPES.map(({ key, label }) => {
    const entries = sortedEntries(raceOdds[key]);
    if (entries.length === 0) return '';

    const rows = entries.map((e, idx) => {
      const ninki   = idx + 1;
      const ninkiColor = ninki <= 3 ? 'var(--accent2)' : 'var(--text3)';
      const oddsHigh   = e.odds >= 100;
      const oddsColor  = oddsHigh ? 'var(--red)' : 'var(--text)';

      // comboToBadges は "-" 区切りで動くので combo を正規化
      const badgesHtml = comboToBadges(e.combo.replace(/-/g, '−'));

      const rowKey    = _oddsPickKey(_oddsDateR, DATA.venue, rno, key, e.combo);
      const rowPicked = _oddsPickSet.has(rowKey) ? ' odds-picked' : '';
      if (rowPicked) _oddsPickOdds.set(rowKey, e.odds); // 復元時にオッズ値も補完

      return `<div class="${rowPicked.trim()}" style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="toggleOddsPick(this, '${rowKey}', ${e.odds})">
        <span style="font-size:10px;color:${ninkiColor};font-weight:700;min-width:18px;text-align:right;flex-shrink:0">${ninki}</span>
        <span style="display:inline-flex;align-items:center;gap:0;flex:1">${badgesHtml}</span>
        <span style="font-family:var(--mono);font-size:14px;font-weight:600;color:${oddsColor};min-width:5em;text-align:right;flex-shrink:0">${e.odds.toFixed(1)}</span>
      </div>`;
    }).join('');

    return `<div class="buy-card">
      <div class="buy-card-title">${label}
        <span style="font-weight:400;color:var(--text3);font-size:10px;margin-left:6px">${entries.length}通り</span>
      </div>
      ${rows}
    </div>`;
  }).join('');

  // fetched_at / final フラグの表示
  // inject_odds_to_html() は fetched_at を除外して埋め込むため、
  // __fetched_at ではなく fetched_at キーは存在しない。
  // final フラグ（確定オッズ）があれば確定済みバッジを表示する。
  const isFinal    = raceOdds['final'] === true;
  const finalBadge = isFinal
    ? `<span style="display:inline-block;background:var(--accent2);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:6px">確定</span>`
    : '';

  const updatedHtml = isFinal
    ? `<div style="padding:0.5rem 1.25rem;font-size:11px;color:var(--accent2);border-bottom:1px solid var(--border);font-weight:700">🏁 確定オッズ${finalBadge}</div>`
    : '';

  // このレースで現在選択中の点数・合成オッズ
  const _pickKeysNow = [..._oddsPickSet].filter(k => k.startsWith(_oddsPickPrefix));
  const _pickCount     = _pickKeysNow.length;
  const _pickComposite = _compositeOdds(_pickKeysNow);
  const summaryBarHtml = `
    <div id="odds-pick-summary" data-prefix="${_oddsPickPrefix}" style="display:${_pickCount > 0 ? '' : 'none'};align-items:center;justify-content:space-between;gap:8px;padding:0.5rem 1.25rem;font-size:12px;color:var(--text);border-bottom:1px solid var(--border);background:var(--bg3)">
      <span>選択中: <strong data-role="odds-pick-count">${_pickCount}</strong>点　合成: <strong data-role="odds-pick-composite">${_pickComposite != null ? _pickComposite.toFixed(2) + '倍' : '—'}</strong></span>
      <span style="cursor:pointer;color:var(--accent2);font-weight:600" onclick="clearOddsPicksForRace('${_oddsDateR}', '${DATA.venue}', ${rno})">クリア</span>
    </div>`;

  panel.innerHTML = `
    <div class="detail-panel">
      ${updatedHtml}
      ${summaryBarHtml}
      ${matrix3tSection ? `<div style="padding:0.875rem 1rem 0">${matrix3tSection}</div>` : ''}
      <div class="buy-grid" style="border-top:none">
        ${sectionsHtml}
      </div>
    </div>`;
}


function switchTab(name){
  ['detail','detail2','buy','comment','result','odds'].forEach(t=>{
    const el = document.getElementById('tab-' + t);
    if(el) el.style.display = t===name?'':'none';
  });
  document.querySelectorAll('.tab-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.tab===name);
  });
  if(name==='detail'){
    renderDetail(selectedRace);
  } else if(name==='buy'){
    renderBuy(selectedRace);
  } else if(name==='detail2'){
    renderBuy(selectedRace); // AI予想タブ（buy-panel+detail2-panelに同時出力）
  } else if(name==='comment'){
    if(IS_SERVER && DATA && DATA.date){
      fetchTenjiAll(currentVenue, DATA.date)
        .then(() => renderComment(selectedRace))
        .catch(e => console.warn('[switchTab] fetchTenjiAll error:', e));
    } else {
      renderComment(selectedRace);
    }
  } else if(name==='result'){
    renderResult(selectedRace);
  } else if(name==='odds'){
    renderOdds(selectedRace);
  }
}

function currentTabName(){
  const b = document.querySelector('.tab-btn.active');
  return b ? (b.dataset.tab||'detail') : 'detail';
}

// ── 日付ナビゲーター ──
// viewDate: 現在表示中の日付文字列 "YYYY-MM-DD"（null = 当日 ALL_DATA）
let viewDate = null;

// getAvailableDates のキャッシュ（1秒間有効）
// buildVenueTabs/updateAlertStrip等から頻繁に呼ばれるため
// Object.keys()等の再計算を抑制する
let _availableDatesCache = null;
let _availableDatesCacheTime = 0;
function getAvailableDates(){
  const now = Date.now();
  if (_availableDatesCache && now - _availableDatesCacheTime < 1000) {
    return _availableDatesCache;
  }
  // ALL_DATA_HISTORY のキー（過去日）+ 当日（ALL_DATAから推定）
  const histDates = Object.keys(ALL_DATA_HISTORY).sort();
  // 当日の日付を ALL_DATA から取得
  const todayDate = (function(){
    for(const v of Object.values(ALL_DATA)){
      if(v && v.date) return v.date;
    }
    return null;
  })();
  const all = [...histDates];
  if(todayDate && !all.includes(todayDate)) all.push(todayDate);
  _availableDatesCache = all.sort();
  _availableDatesCacheTime = now;
  return _availableDatesCache;
}

function getDataForDate(dateStr){
  // dateStr が null or 当日 → ALL_DATA、それ以外 → ALL_DATA_HISTORY[dateStr]
  const dates = getAvailableDates();
  const todayDate = dates[dates.length - 1];
  if(!dateStr || dateStr === todayDate) return ALL_DATA;
  return ALL_DATA_HISTORY[dateStr] || {};
}

function updateDateNav(){
  const nav = document.getElementById('date-nav');
  const dates = getAvailableDates();

  // 出走表表示中 = top-page が 'none'（hideTopPage済み）
  // .container.style.display は初期値も '' なので判定に使えない
  const topPageEl = document.getElementById('top-page');
  const isRaceView = topPageEl && topPageEl.style.display === 'none';

  if(dates.length <= 1){ nav.style.display = 'none'; return; }

  // 出走表表示中のみ日付ナビを出す（TOPページ時は top-date-nav が担当）
  nav.style.display = isRaceView ? 'flex' : 'none';

  const todayDate = dates[dates.length - 1];
  const current = viewDate || todayDate;
  const idx = dates.indexOf(current);

  document.getElementById('date-nav-label').textContent = current;
  document.getElementById('date-prev').disabled = idx <= 0;
  document.getElementById('date-next').disabled = idx >= dates.length - 1;
}

function shiftDate(delta){
  const dates = getAvailableDates();
  const todayDate = dates[dates.length - 1];
  const current = viewDate || todayDate;
  const idx = dates.indexOf(current);
  const newIdx = idx + delta;
  if(newIdx < 0 || newIdx >= dates.length) return;
  viewDate = dates[newIdx];

  const dataForDate = getDataForDate(viewDate);

  // 出走表表示中 = top-page が 'none'（hideTopPage済み）
  const topPageEl2 = document.getElementById('top-page');
  const isRaceView = topPageEl2 && topPageEl2.style.display === 'none';

  if(isRaceView && currentVenue){
    // ── 出走表表示中: 現在の会場を維持して日付だけ切り替える ──
    const venueData = dataForDate[currentVenue];
    if(venueData){
      DATA = venueData;
      selectedRace = findCurrentRace(DATA.races);
      buildVenueTabs();
      updateDateNav();
      buildRaceBar();
      // 現在のタブを維持して再描画
      const tab = currentTabName();
      if(tab === 'detail')       renderDetail(selectedRace);
      else if(tab === 'detail2') renderBuy(selectedRace);
      else if(tab === 'buy')     renderBuy(selectedRace);
      else if(tab === 'comment') renderComment(selectedRace);
      else if(tab === 'result')  renderResult(selectedRace);
      else if(tab === 'odds')    renderOdds(selectedRace);
      else                       renderDetail(selectedRace);
      updateHeaderMeta(currentVenue, selectedRace);
      showToast(`${currentVenue} ${viewDate === todayDate ? '本日' : viewDate} のデータを表示`);
    } else {
      // この日は選択中の会場のデータがない → 案内メッセージ
      buildVenueTabs();
      updateDateNav();
      document.getElementById('race-bar').innerHTML = '';
      document.getElementById('inline-detail').innerHTML =
        `<div style="padding:2rem;text-align:center;color:var(--text3)">${currentVenue} の ${viewDate} のデータはありません</div>`;
      showToast(`${currentVenue} の ${viewDate} のデータはありません`);
    }
    return;
  }

  // ── TOPページ表示中: 従来通り会場タブを再構築 ──
  const hasCurrentVenue = currentVenue && dataForDate[currentVenue];
  if(hasCurrentVenue){
    DATA = dataForDate[currentVenue];
    selectedRace = findCurrentRace(DATA.races);
  } else {
    const firstVenue = VENUE_LIST.find(v => dataForDate[v]);
    if(firstVenue){
      currentVenue = firstVenue;
      DATA = dataForDate[firstVenue];
      selectedRace = findCurrentRace(DATA.races);
    } else {
      currentVenue = ''; DATA = null; selectedRace = 0;
    }
  }

  buildVenueTabs();
  updateDateNav();

  if(currentVenue && DATA){
    buildRaceBar();
    selectRace(selectedRace || findCurrentRace(DATA.races));
  } else {
    document.getElementById('race-bar').innerHTML = '';
    document.getElementById('inline-detail').innerHTML =
      '<div style="padding:2rem;text-align:center;color:var(--text3)">会場を選択してください</div>';
  }
}

// ── 締め切りアラートバナー ──
function updateAlertStrip(){
  const strip   = document.getElementById('alert-strip');
  const cardsEl = document.getElementById('alert-cards');
  if(!strip || !cardsEl) return;

  const now    = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const LIMIT  = 15;

  const hits = [];
  const dataForDate = getDataForDate(viewDate);

  // 当日かどうかを判定
  const _alertDates   = getAvailableDates();
  const _alertToday   = _alertDates[_alertDates.length - 1];
  const _alertIsToday = (viewDate || _alertToday) === _alertToday;

  VENUE_LIST.forEach(venue => {
    const vdata = dataForDate[venue];
    if(!vdata || !vdata.races) return;
    // 中止・取消・中止順延の会場はアラート対象外
    const _alertInfo = _alertIsToday
      ? ((RACE_INDEX_DATA && RACE_INDEX_DATA.venues && RACE_INDEX_DATA.venues[venue])
          ? RACE_INDEX_DATA.venues[venue]
          : (vdata.race_info || null))
      : (vdata.race_info || null);
    if (_alertInfo && _alertInfo.cancel_status) return;
    Object.entries(vdata.races).forEach(([rno, rd]) => {
      if(!rd || !rd.time) return;
      const t = String(rd.time).trim();
      const match = t.match(/^(\d{1,2}):(\d{2})$/);
      if(!match) return;
      const raceMin = parseInt(match[1]) * 60 + parseInt(match[2]);
      const diff = raceMin - nowMin;
      if(diff >= 0 && diff <= LIMIT){
        hits.push({ venue, rno: parseInt(rno), time: t, diff });
      }
    });
  });

  hits.sort((a, b) => a.diff - b.diff);

  if(hits.length === 0){
    strip.style.display = 'none';
    return;
  }

  strip.style.display = 'block';
  cardsEl.innerHTML = hits.map(h => {
    const urgent = h.diff <= 5;
    const dotCls = urgent ? 'alert-dot urgent' : 'alert-dot';
    const label  = h.diff <= 0 ? '発走直前' : `残り ${h.diff}分`;
    return `<div class="alert-card${urgent?' urgent':''}" onclick="jumpToAlert('${h.venue}',${h.rno})">
      <div class="alert-card-badge"><span class="${dotCls}"></span>${label}</div>
      <div class="alert-card-venue">${h.venue}</div>
      <div class="alert-card-race">${h.rno}R</div>
      <div class="alert-card-time">${h.time} 発走</div>
    </div>`;
  }).join('');
}

function jumpToAlert(venue, rno){
  const dataForDate = getDataForDate(viewDate);
  if(!dataForDate[venue]) return;
  hideTopPage();
  currentVenue = venue;
  DATA = dataForDate[venue];
  selectedRace = rno;
  document.querySelectorAll('.vtab').forEach(b =>
    b.classList.toggle('active', b.dataset.venue === venue));
  buildRaceBar();
  selectRace(rno);
}

// ── 会場タブ構築 ──
const VENUE_LIST = [
  '桐生','戸田','江戸川','平和島','多摩川','浜名湖','蒲郡','常滑',
  '津','三国','びわこ','住之江','尼崎','鳴門','丸亀','児島',
  '宮島','徳山','下関','若松','芦屋','福岡','唐津','大村'
];

// ── サーバーモード: tenji_all API → _tenjiCache に格納 ──
// SLUG_MAP は後方互換のため VENUE_SLUG_MAP への参照として残す
const SLUG_MAP = VENUE_SLUG_MAP;
async function fetchTenjiAll(venue, date){
  const slug = SLUG_MAP[venue] || venue;

  // ① 埋め込みキャッシュ（inject_tenji_to_html済み）があれば APIコール不要
  const cachedKeys = Object.keys(_tenjiCache).filter(k => k.startsWith(`${slug}_${date}_`));
  if(cachedKeys.length > 0){
    return;
  }

  // ② API が使えない環境（Netlify / GitHub Pages）はスキップ
  if(!_serverAvailable){
    return;
  }

  // ③ ローカルサーバーから取得
  try {
    const res = await fetch(`/api/tenji_all?venue=${slug}&date=${date}`);
    if(!res.ok){
      // 404等 → 以降のAPIコールも抑制
      _serverAvailable = false;
      console.warn('[fetchTenjiAll] API returned', res.status, '→ server unavailable');
      return;
    }
    const json = await res.json();
    if(!json.ok || !json.races) return;
    for(const [rno, frameMap] of Object.entries(json.races)){
      _tenjiCache[`${slug}_${date}_${rno}`] = frameMap;
    }
  } catch(e) {
    _serverAvailable = false;
    console.warn('[fetchTenjiAll] error (server unavailable):', e);
  }
}

function buildVenueTabs(){
  const tabs = document.getElementById('venue-tabs');
  const dataForDate = getDataForDate(viewDate);
  // ループ外で1回だけ計算（以前はループ24回×毎回 getAvailableDates() を呼んでいた）
  const _datesVt   = getAvailableDates();
  const _todayVt   = _datesVt[_datesVt.length - 1];
  const _isTodayVt = (viewDate || _todayVt) === _todayVt;
  const raceIndexVenues = (RACE_INDEX_DATA && RACE_INDEX_DATA.venues) ? RACE_INDEX_DATA.venues : null;

  // DocumentFragment に一括追加 → DOM へは1回だけ反映（リフロー最小化）
  const frag = document.createDocumentFragment();
  VENUE_LIST.forEach(v => {
    const btn = document.createElement('button');
    btn.className = 'vtab';
    const infoVt = _isTodayVt
      ? (raceIndexVenues ? (raceIndexVenues[v] || null) : null)
      : (dataForDate[v] ? (dataForDate[v].race_info || null) : null);
    const day = infoVt ? (infoVt.day || '') : '';
    btn.innerHTML = day ? `${v}<span class="vtab-day">${day}</span>` : v;
    btn.dataset.venue = v;
    const isLoaded = !!dataForDate[v];
    if(isLoaded) btn.classList.add('loaded');
    else { btn.style.opacity = '0.35'; btn.style.cursor = 'default'; }
    if(v === currentVenue) btn.classList.add('active');
    btn.onclick = () => {
      if(!dataForDate[v]) return;
      hideTopPage();
      currentVenue = v;
      DATA = dataForDate[v];
      selectedRace = findCurrentRace(DATA.races);
      document.querySelectorAll('.vtab').forEach(b => b.classList.toggle('active', b.dataset.venue===v));
      buildRaceBar();
      selectRace(selectedRace);
    };
    frag.appendChild(btn);
  });
  tabs.innerHTML = '';
  tabs.appendChild(frag);
}

// ── レース選択バー ──

// 現在時刻に最も近い「これから／直近」のレースを返す
function findCurrentRace(races){
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const entries = Object.entries(races).sort((a,b)=>+a[0]-+b[0]);

  // 未来のレースがあれば最初のものを返す
  for(const [rno, rd] of entries){
    if(!rd.time || !/^\d{1,2}:\d{2}$/.test(rd.time.trim())) continue;
    const [h, m] = rd.time.trim().split(':').map(Number);
    if(h * 60 + m >= nowMin) return parseInt(rno);
  }
  // 全部過去なら最後のレースを返す
  return parseInt(entries[entries.length - 1][0]) || 1;
}
function isRacePast(timeStr){
  if(!timeStr || !/^\d{1,2}:\d{2}$/.test(timeStr.trim())) return false;
  const now = new Date();
  const [h, m] = timeStr.trim().split(':').map(Number);
  const raceMin = h * 60 + m;
  const nowMin  = now.getHours() * 60 + now.getMinutes();
  return nowMin > raceMin;
}

// ── レース種別ラベル取得 ──
// RACE_INDEX_DATA.venues[venue].race_kinds から直接引く。
// race_kinds は fetch_race_index.py が raceindex ページから取得した
// {レース番号: "優勝戦" | "準優勝戦" | ...} の辞書。
function getRaceKindLabel(rno, rd){
  // rd に直接 race_kind が入っている場合は最優先
  if(rd && rd.race_kind) return rd.race_kind;

  const info = (RACE_INDEX_DATA && RACE_INDEX_DATA.venues)
    ? (RACE_INDEX_DATA.venues[currentVenue] || null)
    : null;
  if(!info || !info.race_kinds) return '';

  // race_kinds のキーは数値または文字列どちらの場合もあるため両方試す
  return info.race_kinds[parseInt(rno)] || info.race_kinds[String(rno)] || '';
}

function buildRaceBar(){
  const bar = document.getElementById('race-bar');
  if(!bar) return;
  if(!DATA || !DATA.races){ bar.innerHTML = ''; return; }
  // DocumentFragment に一括追加 → DOM へは1回だけ反映（リフロー最小化）
  const frag = document.createDocumentFragment();
  Object.entries(DATA.races).sort((a,b)=>+a[0]-+b[0]).forEach(([rno,rd])=>{
    const btn = document.createElement('button');
    const past = isRacePast(rd.time);
    const hasInsuf = rd.boats && rd.boats.some(b=>b.dq==='insufficient');
    const kindLabel = getRaceKindLabel(rno, rd);
    btn.className = 'race-btn' + (parseInt(rno)===selectedRace?' active':'') + (past?' past':'');
    btn.id = `rc-${rno}`;
    btn.innerHTML = `<span class="race-btn-no">${rno}R</span><span class="race-btn-time">${rd.time||''}</span>${kindLabel?`<span style="display:block;font-size:8px;line-height:1.2;color:var(--accent,#00aaff);letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${kindLabel}</span>`:''}${hasInsuf?'<span style="font-size:9px;color:var(--orange)">⚠</span>':''}`;
    btn.onclick = ()=>{ selectRace(parseInt(rno)); };
    frag.appendChild(btn);
  });
  bar.innerHTML = '';
  bar.appendChild(frag);
}

function doRefresh(){
  const btn = document.getElementById('refresh-btn');
  if(btn) btn.classList.add('spinning');

  // 現在の状態を保存してリロード後に復元
  sessionStorage.setItem('refresh_venue',   currentVenue || 'NONE');
  sessionStorage.setItem('refresh_race',    String(selectedRace || '0'));
  sessionStorage.setItem('refresh_tab',     currentTabName() || 'detail');
  sessionStorage.setItem('refresh_scrollY', String(window.scrollY || 0));
  sessionStorage.setItem('refresh_flag',    '1');

  // location.reload() でリロード（sessionStorage は同一オリジンで保持される）
  setTimeout(()=>{ location.reload(true); }, 150);
}

function updatePersistentBanners(rno){
  if(!DATA) return;
  _ensureTenjiCache();
  const rd = DATA.races[String(rno)];
  const container = document.getElementById('persistent-banners');
  if(!container) return;
  if(!rd){ container.innerHTML = ''; return; }
  const boats = [...rd.boats].sort((a,b)=>a.boat-b.boat);
  let html = '';

  // ── チルト・スリットAL 用の共通変数を先に用意 ──
  const slugBan    = VENUE_SLUG_MAP[DATA.venue] || DATA.venue;
  const tenjiBanKey = tenjiKey(slugBan, DATA.date, rno);
  const tenjiBanData = _tenjiCache[tenjiBanKey];

  // ── 周回短縮バナー: 全艇の lap1 が null の場合 ──
  if (tenjiBanData) {
    const allNoLap = boats.every(bt => {
      const d = tenjiBanData[String(bt.boat)] ?? tenjiBanData[bt.boat];
      return !d || d.lap1 == null;
    });
    if (allNoLap) {
      html += `<div class="insufficient-banner" style="background:rgba(255,59,59,0.07);border-color:rgba(255,59,59,0.22);color:#000">
        <span style="font-size:13px;flex-shrink:0">🔄</span>
        <span style="font-weight:700;flex-shrink:0">周回短縮</span>
        <span style="font-size:11px;color:var(--text3)">このレースは周回短縮です</span>
      </div>`;
    }
  }

  // ── データ不足バナー ──
  const insuffBoats = boats.filter(bt => bt.dq === 'insufficient');
  if(insuffBoats.length > 0){
    const circles = insuffBoats.map(bt =>
      `<span class="boat-circle b${bt.boat}" style="width:20px;height:20px;font-size:10px;line-height:20px;display:inline-flex;align-items:center;justify-content:center">${bt.boat}</span>`
    ).join('');
    html += `<div class="insufficient-banner" style="background:rgba(255,59,59,0.07);border-color:rgba(255,59,59,0.22);color:#000">
        <span style="font-size:13px;flex-shrink:0">📉</span>
        <span style="font-weight:700;flex-shrink:0">データ不足</span>
        <span style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap">${circles}</span>
        <span style="font-size:10px;color:var(--text3);flex-shrink:0">展開分析精度低下</span>
      </div>`;
  }

  // ── 進入変更バナー ──
  html += buildCourseOrderBanner(rno, boats);

  // ── チルトバナー: tilt ≥ 1.5 の艇が1艇でもあれば表示 ──
  if(tenjiBanData){
    const circle = n =>
      `<span class="boat-circle b${n}" style="width:20px;height:20px;font-size:10px;line-height:20px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${n}</span>`;
    const tiltBoats = boats
      .map(bt => {
        const d = tenjiBanData[String(bt.boat)] ?? tenjiBanData[bt.boat];
        const tilt = d?.tilt ?? null;
        return { boat: bt.boat, tilt };
      })
      .filter(x => x.tilt != null && x.tilt >= 1.5);
    if(tiltBoats.length > 0){
      const tiltItems = tiltBoats.map(x =>
        `${circle(x.boat)}<span style="font-size:11px;font-weight:600">${x.tilt > 0 ? '+' : ''}${x.tilt}度</span>`
      ).join('<span style="margin:0 4px;color:var(--text3)">／</span>');
      html += `<div class="insufficient-banner" style="background:rgba(255,59,59,0.07);border-color:rgba(255,59,59,0.22);color:#000">
        <span style="font-size:13px;flex-shrink:0">🔧</span>
        <span style="font-weight:700;flex-shrink:0">チルト</span>
        <span style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap">${tiltItems}</span>
        <span style="font-size:10px;color:var(--text3);flex-shrink:0">伸び注意</span>
      </div>`;
    }

    // ── まくりアラートバナー: buildTopPickupRaces と同一ロジック ──
    // 条件: 前艇比 ST順0.5以上早い かつ 展示タイム0.1秒以上速い
    const makuriBoatsBan = [];
    for(let bn = 2; bn <= 6; bn++){
      const thisB = boats.find(b => b.boat === bn);
      const prevB = boats.find(b => b.boat === bn - 1);
      if(!thisB || !prevB) continue;
      const myStR  = MASTER_EXT?.course_master?.[thisB.name]?.[String(bn)]?.st_rank ?? null;
      const prStR  = MASTER_EXT?.course_master?.[prevB.name]?.[String(bn-1)]?.st_rank ?? null;
      const stOk   = (myStR != null && prStR != null) ? (prStR - myStR >= 0.5) : false;
      const myT    = tenjiBanData[String(bn)]?.tenji ?? null;
      const prT    = tenjiBanData[String(bn-1)]?.tenji ?? null;
      // 浮動小数点誤差対策: 小数第2位で丸めてから比較（例: 6.92-6.82=0.0999...問題を回避）
      const tenjiDiff = (myT != null && prT != null) ? Math.round((prT - myT) * 100) / 100 : null;
      const tenjiOk = tenjiDiff != null ? (tenjiDiff >= 0.1) : false;
      if(stOk && tenjiOk) makuriBoatsBan.push(bn);
    }
    if(makuriBoatsBan.length > 0){
      const makuriCircles = makuriBoatsBan.map(bn =>
        `<span class="boat-circle b${bn}" style="width:20px;height:20px;font-size:10px;line-height:20px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${bn}</span>`
      ).join('');
      html += `<div class="insufficient-banner" style="background:rgba(255,59,59,0.07);border-color:rgba(255,59,59,0.22);color:#000">
        <span style="font-size:13px;flex-shrink:0">⚡</span>
        <span style="font-weight:700;flex-shrink:0">スリットAL</span>
        ${makuriCircles}
        <span style="font-size:10px;color:var(--text3);flex-shrink:0">一撃警戒</span>
      </div>`;
    }
  }

  // ── AI予想条件バナー（_scenEVCache から参照）──
  // prefillScenEVCache または AI予想タブ開封後に書き込まれるキャッシュを参照。
  // オッズ更新のたびに prefillScenEVCache が再実行 → updatePersistentBanners も呼ばれるため
  // 合成オッズは常に最新値が表示される。
  if(DATA && DATA.venue && DATA.date) {
    const _aiKey   = `${DATA.venue}_${DATA.date}_${rno}`;
    const _aiCache = _scenEVCache[_aiKey];
    if (_aiCache) {
      const _so = v => v != null ? v.toFixed(1) + '倍' : null;
      const _pct= v => v != null ? (v*100).toFixed(1) + '%' : null;

      // ── 期待値1.1（シナリオ買い EV） ──
      if (_aiCache.ev != null && _aiCache.ev >= 1.1) {
        const evColor  = _aiCache.ev >= 1.3 ? '#1db954' : '#e67e00';
        const soStr    = _aiCache.synth != null ? `合成${_so(_aiCache.synth)}` : '';
        html += `<div class="insufficient-banner" style="background:rgba(29,185,84,0.07);border-color:rgba(29,185,84,0.30)">
          <span style="font-size:13px;flex-shrink:0">📈</span>
          <span style="font-weight:700;flex-shrink:0;color:${evColor}">期待値1.1</span>
          <span style="font-size:12px;font-weight:700;font-family:var(--mono);color:${evColor};flex-shrink:0">EV${_aiCache.ev.toFixed(2)}</span>
          ${soStr ? `<span style="font-size:11px;color:var(--text3);flex-shrink:0">${soStr}</span>` : ''}
        </div>`;
      }

      // ── シナリオ買い（EV条件未満でも合成2.0倍以上なら表示）──
      if (_aiCache.synth != null && _aiCache.synth >= 2.0 && !(_aiCache.ev != null && _aiCache.ev >= 1.1)) {
        const soColor = _aiCache.synth >= 3.0 ? '#1db954' : _aiCache.synth >= 2.0 ? '#e67e00' : 'var(--text2)';
        html += `<div class="insufficient-banner" style="background:rgba(100,100,255,0.07);border-color:rgba(100,100,255,0.25)">
          <span style="font-size:13px;flex-shrink:0">🎲</span>
          <span style="font-weight:700;flex-shrink:0">シナリオ買い</span>
          <span style="font-size:12px;font-weight:700;font-family:var(--mono);color:${soColor};flex-shrink:0">合成${_so(_aiCache.synth)}</span>
        </div>`;
      }

      // ── イン鉄板 ──
      if (_aiCache.flagInTep) {
        const fp1Str    = _pct(_aiCache.fp1);
        const tepSoStr  = _aiCache.tepSynth != null ? `合成${_so(_aiCache.tepSynth)}` : null;
        html += `<div class="insufficient-banner" style="background:rgba(0,120,255,0.07);border-color:rgba(0,120,255,0.25)">
          <span style="font-size:13px;flex-shrink:0">🔒</span>
          <span style="font-weight:700;flex-shrink:0;color:#4da8ff">イン鉄板</span>
          ${fp1Str ? `<span style="font-size:12px;font-weight:700;font-family:var(--mono);color:#4da8ff;flex-shrink:0;display:inline-flex;align-items:center;gap:3px"><span class="boat-circle b1" style="width:16px;height:16px;font-size:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">1</span>${fp1Str}</span>` : ''}
          ${tepSoStr ? `<span style="font-size:11px;color:var(--text3);flex-shrink:0">${tepSoStr}</span>` : ''}
        </div>`;
      }

      // ── イン否定 ──
      if (_aiCache.flagInNeg) {
        const fp1Str  = _pct(_aiCache.fp1);
        const avgStr  = _pct(_aiCache.venueAvg1);
        const diffStr = (_aiCache.fp1 != null && _aiCache.venueAvg1 != null)
          ? (((_aiCache.fp1 - _aiCache.venueAvg1)*100).toFixed(1) + '%pt')
          : null;
        const negSoStr = _aiCache.negSynth != null ? `合成${_so(_aiCache.negSynth)}` : null;
        html += `<div class="insufficient-banner" style="background:rgba(230,126,0,0.07);border-color:rgba(230,126,0,0.28)">
          <span style="font-size:13px;flex-shrink:0">⚡</span>
          <span style="font-weight:700;flex-shrink:0;color:var(--orange)">イン否定</span>
          ${fp1Str ? `<span style="font-size:12px;font-weight:700;font-family:var(--mono);color:var(--orange);flex-shrink:0;display:inline-flex;align-items:center;gap:3px"><span class="boat-circle b1" style="width:16px;height:16px;font-size:9px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">1</span>${fp1Str}</span>` : ''}
          ${avgStr && diffStr ? `<span style="font-size:11px;color:var(--text3);flex-shrink:0">場平均${avgStr}（${diffStr}）</span>` : ''}
          ${negSoStr ? `<span style="font-size:11px;color:var(--text3);flex-shrink:0">${negSoStr}</span>` : ''}
        </div>`;
      }

      // ── 的中重視バナー（一時非表示 / 復活時はコメントを外す） ──
      // if (_aiCache.flagHit && _aiCache.synthHit != null) {
      //   const soColor = _aiCache.synthHit >= 3.0 ? '#1db954' : _aiCache.synthHit >= 2.0 ? 'var(--text2)' : 'var(--text3)';
      //   html += `<div class="insufficient-banner" style="background:rgba(0,180,100,0.06);border-color:rgba(0,180,100,0.22)">
      //     <span style="font-size:13px;flex-shrink:0">🎯</span>
      //     <span style="font-weight:700;flex-shrink:0">的中重視</span>
      //     <span style="font-size:12px;font-weight:700;font-family:var(--mono);color:${soColor};flex-shrink:0">合成${_so(_aiCache.synthHit)}</span>
      //   </div>`;
      // }

      // ── 回収重視バナー（一時非表示 / 復活時はコメントを外す） ──
      // if (_aiCache.flagRec && _aiCache.synthRec != null) {
      //   const soColor = _aiCache.synthRec >= 5.0 ? '#1db954' : _aiCache.synthRec >= 4.0 ? 'var(--orange)' : 'var(--text3)';
      //   html += `<div class="insufficient-banner" style="background:rgba(255,215,0,0.06);border-color:rgba(255,215,0,0.25)">
      //     <span style="font-size:13px;flex-shrink:0">💰</span>
      //     <span style="font-weight:700;flex-shrink:0">回収重視</span>
      //     <span style="font-size:12px;font-weight:700;font-family:var(--mono);color:${soColor};flex-shrink:0">合成${_so(_aiCache.synthRec)}</span>
      //   </div>`;
      // }
    }
  }

  container.innerHTML = html;
}

// ── レースメタバー更新ヘルパー ──
// 進入変更バナーの上（#race-meta-bar）に「会場 レース番号 [種別バッジ] 開催日程」を表示する。
// 例: 唐津 2R [一般] 初日/5日間開催
// ※ info.day はデータ側で「初日」「2日目」等の文字列が入っているためそのまま使う
// ※ バッジは TOPページと同じ chip-grade / cg-* クラスを流用する
function updateRaceMetaBar(venue, rno) {
  const el = document.getElementById('race-meta-bar');
  if (!el) return;

  if (!venue || !rno) { el.style.display = 'none'; return; }

  // race_info を取得（今日 → RACE_INDEX_DATA.venues、過去日 → DATA.race_info）
  let info = null;
  try {
    if (RACE_INDEX_DATA && RACE_INDEX_DATA.venues && RACE_INDEX_DATA.venues[venue]) {
      info = RACE_INDEX_DATA.venues[venue];
    } else if (DATA && DATA.race_info) {
      info = DATA.race_info;
    }
  } catch(e) { info = null; }

  // グレード・種別バッジ（TOPページと同じ chip-grade クラスを使用）
  const gradeMap = { SG: 'cg-sg', G1: 'cg-g1', G2: 'cg-g2', G3: 'cg-g3' };
  const grade    = info ? (info.grade || '') : '';
  const isJoshi  = !!(info && info.is_joshi);
  const gcls     = gradeMap[grade] || '';
  const badgeHtml = gcls
    ? `<span class="chip-grade ${gcls}">${grade}</span>`
    : isJoshi
      ? `<span class="chip-grade cg-joshi">女子</span>`
      : `<span class="chip-grade cg-ippan">一般</span>`;

  // 開催日程（info.day は「初日」「2日目」等の文字列がそのまま入っている）
  const day       = info ? (info.day        || '') : '';
  const totalDays = info ? (info.total_days ?? null) : null;
  const dayParts  = [];
  if (day)       dayParts.push(day);
  if (totalDays) dayParts.push(`${totalDays}日間開催`);
  const dayHtml = dayParts.length
    ? `<span class="rmb-day">${dayParts.join('/')}</span>`
    : '';

  el.innerHTML   = `<span class="rmb-venue">${venue}</span><span class="rmb-rno">${rno}R</span>${badgeHtml}${dayHtml}`;
  el.style.display = 'flex';
}

// ── header-meta をシンプルに会場名のみ更新するヘルパー ──
function updateHeaderMeta(venue, rno) {
  const el = document.getElementById('header-meta');
  if (!el) return;
  el.innerHTML = venue ? `<strong>${venue}</strong>` : '';
  // race-meta-bar も同時更新
  updateRaceMetaBar(venue, rno);
}

function selectRace(rno){
  if(!DATA) return;
  selectedRace = rno;
  updateRaceMetaBar(currentVenue, rno);
  updatePersistentBanners(rno);
  document.querySelectorAll('.race-btn').forEach(c=>c.classList.remove('active'));
  const btn = document.getElementById(`rc-${rno}`);
  if(btn){ btn.classList.add('active'); btn.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'}); }
  const tabName = currentTabName();
  if(tabName==='detail')        renderDetail(rno);
  else if(tabName==='detail2')  renderBuy(rno);
  else if(tabName==='buy')      renderBuy(rno);
  else if(tabName==='comment')  renderComment(rno);
  else if(tabName==='result')   renderResult(rno);
  else if(tabName==='odds')     renderOdds(rno);
  else renderDetail(rno);
}

// ── TOAST ──
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2800);
}

// ── 期待値計算（オッズ入力連動）──
//
// 期待値 = final_prob（絶対値確率） × 単勝オッズ
//   > 1.0: 期待値プラス（緑）
//   0.8〜1.0: やや割高（オレンジ）
//   < 0.8: 割高（赤）
//
// 展示データなし → final_prob = tenkai_prob（相対値）で代用
// この場合、合計は1.0になるため厳密な期待値ではなく目安として扱う。
//
function updateEV(){
  document.querySelectorAll('.ev-cell').forEach(cell => {
    const boat = cell.dataset.boat;
    const fp   = parseFloat(cell.dataset.fp);
    const oddsEl = document.getElementById(`odds-${boat}`);
    if(!oddsEl) return;
    const odds = parseFloat(oddsEl.value);
    if(isNaN(odds) || odds <= 0){
      cell.textContent = '—';
      cell.style.color = 'var(--text3)';
      cell.style.fontWeight = '';
      return;
    }
    const ev = fp * odds;
    cell.textContent = ev.toFixed(2);
    if(ev >= 1.0){
      cell.style.color = 'var(--green)';
      cell.style.fontWeight = '700';
    } else if(ev >= 0.8){
      cell.style.color = 'var(--orange)';
      cell.style.fontWeight = '600';
    } else {
      cell.style.color = 'var(--red)';
      cell.style.fontWeight = '';
    }
  });
}

// ── 初期化 ──
(async function(){
  // ── 展示キャッシュ＋シナリオ買い目キャッシュをアイドル時間に一括初期化（改善⑤）──
  // _initScenComboCache は localStorage フルスキャンが重いため requestIdleCallback に移動
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => {
      _ensureTenjiCache();
      _initScenComboCache();
    }, { timeout: 3000 });
  } else {
    setTimeout(() => { _ensureTenjiCache(); }, 200);
    setTimeout(() => { _initScenComboCache(); }, 300);
  }

  try {
  const isRefresh    = sessionStorage.getItem('refresh_flag') === '1';
  const goTopAfterRefresh = sessionStorage.getItem('go_top_after_refresh') === '1';
  const restoreVenue = sessionStorage.getItem('refresh_venue') || '';
  const restoreRace  = parseInt(sessionStorage.getItem('refresh_race') || '0') || 0;
  const restoreTab   = sessionStorage.getItem('refresh_tab') || 'detail';
  const restoreScrollY = parseInt(sessionStorage.getItem('refresh_scrollY') || '0') || 0;

  // ★ デバッグ: 復元前の値をコンソールに出力

  // 復元キーは使い捨て（次回通常起動と区別するため即座にクリア）
  sessionStorage.removeItem('refresh_flag');
  sessionStorage.removeItem('refresh_venue');
  sessionStorage.removeItem('refresh_race');
  sessionStorage.removeItem('refresh_tab');
  sessionStorage.removeItem('refresh_scrollY');
  sessionStorage.removeItem('go_top_after_refresh');

  if(isRefresh && goTopAfterRefresh){
    currentVenue = '';
    DATA         = null;
    buildVenueTabs();
    updateDateNav();
    document.getElementById('race-bar').innerHTML = '';
    document.getElementById('inline-detail').innerHTML =
      '<div style="padding:2rem;text-align:center;color:var(--text3)">会場を選択してください</div>';
    showTopPage();
  } else if(isRefresh){
    // ── 更新ボタン後: 会場・レース・タブを完全復元 ──
    // ALL_DATA[venue] は null（データなし）か object（データあり）かの2択。
    // undefined はキー自体が存在しない（無効な会場名）なので復元不可とする。
    const hasVenue = restoreVenue && restoreVenue !== 'NONE'
                     && Object.prototype.hasOwnProperty.call(ALL_DATA, restoreVenue)
                     && ALL_DATA[restoreVenue] !== null;

    if(hasVenue){
      currentVenue = restoreVenue;
      DATA         = ALL_DATA[restoreVenue];
      selectedRace = restoreRace;
    } else {
      currentVenue = '';
      DATA         = null;
      selectedRace = 0;
    }

    buildVenueTabs();
    buildRaceBar();
    updateDateNav();

    if(hasVenue){
      // updateHeaderMeta は selectRace 内で呼ばれるが、
      // このルートでは selectRace を呼ばない分岐があるため先に呼んでおく
      updateHeaderMeta(restoreVenue, restoreRace || selectedRace);

      // タブUIを先に切り替える
      const TAB_NAMES = ['detail','detail2','buy','comment','result','odds'];
      const safeTab = TAB_NAMES.includes(restoreTab) ? restoreTab : 'detail';
      TAB_NAMES.forEach(t=>{
        document.getElementById(`tab-${t}`).style.display = t === safeTab ? '' : 'none';
      });
      document.querySelectorAll('.tab-btn').forEach(b=>{
        b.classList.toggle('active', b.dataset.tab === safeTab);
      });

      // レースバーを構築してアクティブ表示
      if(restoreRace){
        selectedRace = restoreRace;
        document.querySelectorAll('.race-btn').forEach(c=>c.classList.remove('active'));
        const raceBtn = document.getElementById(`rc-${restoreRace}`);
        if(raceBtn){ raceBtn.classList.add('active'); raceBtn.scrollIntoView({behavior:'auto',block:'nearest',inline:'center'}); }
      }

      // FLYING_DATAはauto_pushで埋め込み済みのためfetch不要
      const doRender = () => {
        if(restoreRace){
          if(safeTab === 'detail')        renderDetail(restoreRace);
          else if(safeTab === 'detail2')  renderBuy(restoreRace);
          else if(safeTab === 'buy')      renderBuy(restoreRace);
          else if(safeTab === 'comment')  renderComment(restoreRace);
          else                            renderDetail(restoreRace);
        }
      };
      if(IS_SERVER && DATA.date){
        fetchTenjiAll(restoreVenue, DATA.date).then(doRender);
      } else {
        doRender();
      }
      // スクロール位置を復元
      if(restoreScrollY > 0){
        requestAnimationFrame(()=>{
          requestAnimationFrame(()=>{ window.scrollTo(0, restoreScrollY); });
        });
      }

    } else {
      document.getElementById('race-bar').innerHTML = '';
      document.getElementById('inline-detail').innerHTML =
        '<div style="padding:2rem;text-align:center;color:var(--text3)">会場を選択してください</div>';
    }

  } else {
    // ── 通常起動: TOPページを表示 ──
    currentVenue = '';
    DATA         = null;
    buildVenueTabs();
    updateDateNav();
    document.getElementById('race-bar').innerHTML = '';
    document.getElementById('inline-detail').innerHTML =
      '<div style="padding:2rem;text-align:center;color:var(--text3)">会場を選択してください</div>';
    showTopPage();
  }

  } catch(e) {
    console.error('[INIT] error:', e);
  } finally {
    // 初期化の成否に関わらずアラートを起動
    updateAlertStrip();

    // ── 30秒ごとに締め切りアラートのみ更新（改善②）──
    // autoRefreshCurrentView は refreshTenjiData / refreshOddsData が
    // データ変化を検知したときだけ呼ぶため、ここでは呼ばない。
    setInterval(function(){
      updateAlertStrip();
    }, 30 * 1000);

    // ── 展示情報を定期fetch（3分ごと）: data/tenji_YYYYMMDD.json ──
    // push直後にページリロードなしで反映させるため
    (function _scheduleRefreshTenji(){
      // 差分検知用ハッシュ（改善②）
      let _lastTenjiHash = '';

      async function refreshTenjiData(){
        if(!DATA || !DATA.date) return;
        const dateNd = DATA.date.replace(/-/g, '');
        const url = `data/tenji_${dateNd}.json`;
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if(!res.ok) return;
          const latest = await res.json();
          // ── 差分チェック（改善②）: 内容が変わっていない場合は再描画しない ──
          const _newHash = JSON.stringify(latest);
          if (_newHash === _lastTenjiHash) {
            console.log('[refreshTenji] 変化なし → スキップ');
            return;
          }
          _lastTenjiHash = _newHash;
          // TENJI_DATA をインプレース更新（既存キーを上書き・追加）
          if(typeof latest === 'object' && latest !== null){
            Object.assign(TENJI_DATA, latest);
            // 展示キャッシュを再構築（_tenjiCacheReadyをリセット）
            _tenjiCacheReady = false;
            _ensureTenjiCache();
            console.log('[refreshTenji] 展示情報更新完了:', Object.keys(latest).length + '件');
            // レンダーキャッシュを破棄してから再描画（改善②）
            invalidateRenderCache();
            autoRefreshCurrentView();
            // 展示更新後にバックグラウンド事前計算を再実行（展示補正が変わるため）
            _triggerPrefill();
          }
        } catch(e){
          // fetchできなくてもサイレントに無視（埋め込みデータで継続）
        }
      }
      // DATA が揃うまで待ってから即取得、以降3分ごと
      function _waitAndRefreshTenji(){
        if(DATA && DATA.date){ refreshTenjiData(); }
        else { setTimeout(_waitAndRefreshTenji, 500); }
      }
      _waitAndRefreshTenji();
      setInterval(refreshTenjiData, 3 * 60 * 1000); // 以降3分ごと
    })();

    // ── オッズを定期fetch（5分ごと）: data/odds_YYYYMMDD.json ──
    // push直後にページリロードなしで反映させるため
    (function _scheduleRefreshOdds(){
      // 差分検知用ハッシュ（改善②）
      let _lastOddsHash = '';

      async function refreshOddsData(){
        if(!DATA || !DATA.date) return;
        const dateNd = DATA.date.replace(/-/g, '');
        const url = `data/odds_${dateNd}.json`;
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if(!res.ok) return;
          const latest = await res.json();
          // ── 差分チェック（改善②）: 内容が変わっていない場合は再描画しない ──
          const _newHash = JSON.stringify(latest);
          if (_newHash === _lastOddsHash) {
            console.log('[refreshOdds] 変化なし → スキップ');
            return;
          }
          _lastOddsHash = _newHash;
          // ODDS_DATA[date_key][venue][rno] 構造にマージ
          if(typeof latest === 'object' && latest !== null){
            const dateKey = DATA.date; // "YYYY-MM-DD"
            if(!ODDS_DATA[dateKey]) ODDS_DATA[dateKey] = {};
            Object.assign(ODDS_DATA[dateKey], latest);
            console.log('[refreshOdds] オッズ更新完了:', Object.keys(latest).length + '会場');
            // レンダーキャッシュを破棄してから再描画（改善②）
            invalidateRenderCache();
            autoRefreshCurrentView();
            // オッズ更新後にバックグラウンド事前計算を再実行（合成オッズ判定が変わるため）
            _triggerPrefill();
          }
        } catch(e){
          // fetchできなくてもサイレントに無視（埋め込みデータで継続）
        }
      }
      // DATA が揃うまで待ってから即取得、以降30秒ごと
      function _waitAndRefreshOdds(){
        if(DATA && DATA.date){ refreshOddsData(); }
        else { setTimeout(_waitAndRefreshOdds, 500); }
      }
      _waitAndRefreshOdds();
      setInterval(refreshOddsData, 30 * 1000);  // 以降30秒ごと
    })();

    // ── 結果を定期fetch（1分ごと）: data/result_YYYYMMDD.json ──
    (function _scheduleRefreshResult(){
      let _lastResultHash = '';
      async function refreshResultData(){
        if(!DATA || !DATA.date) return;
        const dateNd = DATA.date.replace(/-/g, '');
        const url = `data/result_${dateNd}.json`;
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if(!res.ok) return;
          const latest = await res.json();
          const _newHash = JSON.stringify(latest);
          if(_newHash === _lastResultHash) return;
          _lastResultHash = _newHash;
          if(typeof latest === 'object' && latest !== null){
            for(const [key, val] of Object.entries(latest)){
              const m = key.match(/^(.+)[ _](\d+)$/);
              const fullKey = m ? `${m[1]}_${dateNd}_${m[2]}` : `${key}_${dateNd}`;
              RESULT_DATA[fullKey] = val;
            }
            console.log('[refreshResult] 結果更新完了:', Object.keys(latest).length + '件');
            invalidateRenderCache();
            autoRefreshCurrentView();
          }
        } catch(e){}
      }
      function _waitAndRefreshResult(){
        if(DATA && DATA.date){ refreshResultData(); }
        else { setTimeout(_waitAndRefreshResult, 500); }
      }
      _waitAndRefreshResult();
      setInterval(refreshResultData, 60 * 1000);  // 以降1分ごと
    })();
  }

  // ── フェーズ2: バックグラウンドでJSONをfetchしてデータをマージ ──
  // UIの表示を一切ブロックせず、fetch完了後に現在のビューを差分更新する。
  // 失敗しても埋め込みデータで動作継続（フォールバック保証）。
  fetchAndMergeJsonData()
    .then(() => {
      invalidateRenderCache(); // MASTER_EXT ロード後にキャッシュを破棄（スマホ遅延対応）
      buildVenueTabs();        // ALL_DATA がセットされた後に会場タブを再構築
      autoRefreshCurrentView();
      // fetch完了後にトップページ表示中なら再描画する
      if (typeof showTopPage === 'function') showTopPage();
      // 起動時バックグラウンド事前計算（fetchAndMergeJsonData 完了後）
      _triggerPrefill();
    })
    .catch(e => { console.warn('[init] fetchAndMergeJsonData failed:', e); });
})();


// ══════════════════════════════════════════════════════════════════
// シナリオ買い 期待値キャッシュ & TOP ページ表示
//
// ── prefillScenEVCache 呼び出しヘルパー ──
// DATA が null（TOPページ表示中など）でも当日日付を取得して prefill を実行する。
function _triggerPrefill() {
  const dateStr = (DATA && DATA.date)
    ? DATA.date
    : (() => { const d = getAvailableDates(); return d.length ? d[d.length - 1] : null; })();
  if (dateStr) prefillScenEVCache(dateStr);
}

// _scenEVCache: buildScenarioBuyPanel が呼ばれるたびに書き込まれる
//   キー: "{venue}_{date}_{rno}"
//   値  : { venue, date, rno, ev, synth, hitRate, pts }
//
// renderScenEVSection(): TOP ページの #top-scen-ev-section を更新する
//   - ev >= 1.1 のレースのみ表示
//   - 会場ジャンプ機能付き
// ══════════════════════════════════════════════════════════════════
const _scenEVCache = {};

// ══════════════════════════════════════════════════════════════════
// _scenEVCache 事前計算（バックグラウンド）
//
// AI予想タブを開かなくても起動時・オッズ更新・展示更新のタイミングで
// 全レース分のフラグを計算して _scenEVCache に書き込む。
//
// ・既存の computeBuy3 / computeScenCombos / computeInTepCombos /
//   computeInNegCombos をそのまま呼ぶだけ（ロジック変更なし）
// ・1レースずつ setTimeout(0) で分散処理 → UIをブロックしない
// ・AI予想タブを開いたとき buildScenarioBuyPanel が同じキーを上書き
//   するので結果は完全に一致する（競合なし）
// ══════════════════════════════════════════════════════════════════

// 実行中の prefill をキャンセルするためのフラグ
let _prefillGeneration = 0;

// prefillScenEVCache の完了フラグ
// true になった後は _buildHitSokuhoPanel が即時描画できる
let _scenEVCacheReady = false;

function prefillScenEVCache(dateStr) {
  // 新しい世代番号を発行 → 前回実行中の setTimeout チェーンを無効化
  const generation = ++_prefillGeneration;

  const dataForDate = getDataForDate(dateStr);
  if (!dataForDate) return;

  // 処理対象レースをリストアップ（江戸川は計算対象外）
  const tasks = [];
  VENUE_LIST.forEach(venue => {
    if (venue === '江戸川') return;
    const vdata = dataForDate[venue];
    if (!vdata || !vdata.races) return;
    Object.keys(vdata.races).sort((a,b) => +a - +b).forEach(rnoStr => {
      const rno = parseInt(rnoStr);
      const rd  = vdata.races[rnoStr];
      if (!rd || !rd.boats || rd.boats.length < 2) return;
      tasks.push({ venue, vdata, rno, rd });
    });
  });

  if (tasks.length === 0) return;

  let idx = 0;

  function processNext() {
    // 別の prefill が始まっていたら中断
    if (generation !== _prefillGeneration) return;
    if (idx >= tasks.length) {
      // 全レース完了 → 完了フラグを立てる
      _scenEVCacheReady = true;

      // ── TOPページ的中速報セクションを再描画 ──
      // style.display が 'block' / '' (空文字) / undefined のいずれでも
      // 'none' でなければ表示中とみなす。
      // さらに offsetParent で実際に可視かチェック（display:none 祖先を持つ場合を除外）
      const topPage = document.getElementById('top-page');
      const isTopVisible = topPage &&
        topPage.style.display !== 'none' &&
        topPage.offsetParent !== null;

      if (isTopVisible) {
        // _scenEVCache が充填済みのタイミングで _buildHitSokuhoPanel を呼ぶ
        const elScenEV = document.getElementById('top-scen-ev-section');
        if (elScenEV && typeof _buildHitSokuhoPanel === 'function') {
          const _dates = getAvailableDates();
          const _todayDate = _dates[_dates.length - 1];
          if (_todayDate) {
            elScenEV.innerHTML = _buildHitSokuhoPanel(_todayDate);
          }
        }
      }
      // TOPページが非表示の場合: _scenEVCacheReady フラグにより
      // 次回 calcTopAIStats 実行時（showTopPage→calcTopAIStats）に正しく描画される。
      // calcTopAIStats が既に先行実行済みの場合は top_stats.js 側のリトライ機構が対応。

      // persistent-banners も更新（現在表示中のレースがあれば）
      if (DATA && selectedRace) {
        updatePersistentBanners(selectedRace);
      }
      return;
    }

    const { venue, vdata, rno, rd } = tasks[idx++];
    const evKey = `${venue}_${vdata.date}_${rno}`;

    try {
      _ensureTenjiCache();

      // ── オッズ参照（現時点の ODDS_DATA）──
      const raceOdds3t = ODDS_DATA?.[vdata.date]?.[venue]?.[String(rno)]?.['3t'] || {};
      function _normCombo(c){ return (c||'').replace(/[－−\-]/g,'-'); }
      // RESULT_DATA.sanrentan からフォールバック用オッズマップを構築
      // （確定済みレース・ODDS_DATA未取得レースで ev が null になるのを防ぐ）
      const _rSlug   = SLUG_MAP[venue] || venue;
      const _rDateNd = (vdata.date || '').replace(/-/g, '');
      const _rKey    = `${_rSlug}_${_rDateNd}_${rno}`;
      const _resultOdds3t = (() => {
        const map = {};
        (RESULT_DATA?.[_rKey]?.sanrentan || []).forEach(s => {
          if (s?.combo && s?.odds != null && s.odds > 0) {
            map[_normCombo(s.combo)] = s.odds >= 100 ? s.odds / 100 : s.odds;
          }
        });
        return map;
      })();
      const _oddsSource = Object.keys(raceOdds3t).length > 0 ? raceOdds3t : _resultOdds3t;
      function _synthOdds(combos){
        if (!combos || combos.length === 0) return null;
        let denom = 0, cnt = 0;
        combos.forEach(c => {
          const ov = _oddsSource[_normCombo(c)] ?? null;
          if (ov != null && ov > 0) { denom += 1/ov; cnt++; }
        });
        return (cnt > 0 && denom > 0) ? 1/denom : null;
      }

      // ── 的中重視: computeBuy3('hit') → 空なら未達 ──
      const buy3Hit  = computeBuy3(venue, vdata, rno, 'hit');
      const flagHit  = buy3Hit.length > 0;
      const synthHit = flagHit ? _synthOdds(buy3Hit.map(r => r.c)) : null;

      // ── [新規] renderScenEVSection の「買い目別EV」表示用の生データを保持 ──
      // buy3Hit は { c: パターン文字列, prob: 的中確率(比率0-1) } の配列で、
      // 個別買い目ごとの確率を持つ数少ないソースのためこれを採用する
      // （scenCombos は文字列配列のみで個別確率を持たない）。
      // _oddsSource（直前オッズ or 結果オッズのフォールバック）もそのまま
      // スナップショットとして保持し、renderScenEVSection 側で
      // filterCombosByExpectedValue に渡して EV 計算・フィルタ・ソートを行う。
      const buyCombosSnapshot = buy3Hit;
      const oddsMapSnapshot   = _oddsSource;

      // ── 回収重視: computeBuy3('rec') → 空なら未達 ──
      const buy3Rec  = computeBuy3(venue, vdata, rno, 'rec');
      const flagRec  = buy3Rec.length > 0;
      const synthRec = flagRec ? _synthOdds(buy3Rec.map(r => r.c)) : null;

      // ── シナリオ買い + 期待値 ──
      const { combos: scenCombos, hitProbEst } =
        (typeof computeScenCombosWithEV === 'function')
          ? computeScenCombosWithEV(venue, vdata, rno)
          : { combos: computeScenCombos(venue, vdata, rno), hitProbEst: null };
      const scenPts   = scenCombos.length;
      const scenSynth = _synthOdds(scenCombos);
      const scenEV    = (scenSynth != null && hitProbEst != null) ? scenSynth * hitProbEst : null;

      // ── イン鉄板: computeInTepCombos → 空なら条件不成立 ──
      const tepCombos = (typeof computeInTepCombos === 'function')
        ? computeInTepCombos(venue, vdata, rno) : [];
      const flagInTep = tepCombos.length > 0;
      const tepSynth  = flagInTep ? _synthOdds(tepCombos) : null;

      // ── イン否定: computeInNegCombos → 空なら条件不成立 ──
      const negCombos = (typeof computeInNegCombos === 'function')
        ? computeInNegCombos(venue, vdata, rno) : [];
      const flagInNeg = negCombos.length > 0;
      const negSynth  = flagInNeg ? _synthOdds(negCombos) : null;

      // ── バナー用: 1号艇 final_prob & 場平均（イン鉄板/イン否定表示に使用）──
      let fp1Banner = null, venueAvg1Banner = null;
      try {
        const _savedD = DATA, _savedV = currentVenue;
        DATA = vdata; currentVenue = venue;
        const _rd2 = vdata.races[String(rno)];
        if (_rd2 && _rd2.boats) {
          const _arek   = _rd2.arek ?? 54.7;
          // [拡張] _tData を先に取得してから calcTenkaiProbsExtended に渡す
          const _slug   = SLUG_MAP[venue] || venue;
          const _tKey   = tenjiKey(_slug, vdata.date, rno);
          const _tData  = _tenjiCache[_tKey] || null;
          const _ranked = calcTenkaiProbsExtended(_rd2.boats, _arek, _tData, venue);
          let _tsm = null;
          if (_tData) { try { _tsm = calcTenjiScore(_ranked, _tData, venue, _arek); } catch(e2){} }
          const _pTotal = _ranked.reduce((s,b)=>s+b.prob,0)||1;
          const { wBase: _wb, wTenkai: _wt, wTenji: _wj } = calcDynamicWeights(_arek);
          const _ttotal = _ranked.reduce((s,x)=>s+(x.tenkai_score??x.tenkai_prob),0)||1;
          _ranked.forEach(b => {
            const bn = b.prob/_pTotal;
            let tc=1.0; if(_tsm) tc=_tsm[`__coef_${b.boat}`]??1.0;
            b._multi_score = Math.pow(bn,_wb)*Math.pow(tc,_wt)*Math.pow(tc,_wj);
          });
          const _mt = _ranked.reduce((s,b)=>s+b._multi_score,0)||1;
          _ranked.forEach(b=>{ b.final_prob=b._multi_score/_mt; });
          const _b1 = _ranked.find(b=>b.boat===1);
          fp1Banner       = _b1?.final_prob ?? null;
          venueAvg1Banner = (vdata.inn_data||{}).course_rates?.[1] ?? null;
        }
        DATA = _savedD; currentVenue = _savedV;
      } catch(e2) { /* ignore */ }

      // ── キャッシュ書き込み ──
      // AI予想タブを開いた後は buildScenarioBuyPanel が同じキーを上書きする（競合なし）
      if (!_scenEVCache[evKey]) {
        // タブ未開封の場合のみ書き込む（開封済みなら buildScenarioBuyPanel の値を優先）
        _scenEVCache[evKey] = {
          venue, date: vdata.date, rno,
          ev      : scenEV,
          synth   : scenSynth,
          hitRate : hitProbEst,
          pts     : scenPts,
          flagHit,  synthHit,
          flagRec,  synthRec,
          flagInTep, tepSynth,
          flagInNeg, negSynth,
          fp1: fp1Banner,
          venueAvg1: venueAvg1Banner,
          // [新規] renderScenEVSection の買い目別EVフィルタリング用スナップショット
          buyCombos: buyCombosSnapshot,
          oddsMap  : oddsMapSnapshot,
        };
      } else {
        // 既存エントリのフラグだけ更新（ev/synth/hitRate/fp1/venueAvg1 は buildScenarioBuyPanel の精度が高いため保持）
        const existing = _scenEVCache[evKey];
        existing.flagHit   = flagHit;   existing.synthHit   = synthHit;
        existing.flagRec   = flagRec;   existing.synthRec   = synthRec;
        existing.flagInTep = flagInTep; existing.tepSynth   = tepSynth;
        existing.flagInNeg = flagInNeg; existing.negSynth   = negSynth;
        // [新規] オッズは更新頻度が高いため、既存エントリでも毎回最新スナップショットに置き換える
        existing.buyCombos = buyCombosSnapshot;
        existing.oddsMap   = oddsMapSnapshot;
        // ev == null はタブ未開封 → 簡易計算値で補完
        // ev != null は buildScenarioBuyPanel 書き込み済み → fp1/venueAvg1 も正確な値を保持
        if (existing.ev == null) {
          existing.ev        = scenEV;
          existing.synth     = scenSynth;
          existing.hitRate   = hitProbEst;
          existing.pts       = scenPts;
          existing.fp1       = fp1Banner;
          existing.venueAvg1 = venueAvg1Banner;
        }
      }
    } catch(e) {
      // 1レースの計算エラーはサイレントに無視して次へ
    }

    // 次レースをアイドル時間に処理
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(processNext, { timeout: 2000 });
    } else {
      setTimeout(processNext, 0);
    }
  }

  // 最初の1レースをアイドル時間に開始
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(processNext, { timeout: 3000 });
  } else {
    setTimeout(processNext, 0);
  }
}

function renderScenEVSection(){
  const el = document.getElementById('top-scen-ev-section');
  if(!el) return;

  // ── 採用基準 ──────────────────────────────────────────────
  // 期待値(EV) = 的中確率(%) ÷ 100 × 直前オッズ
  // 1.15 未満（ガミる目・投資効率の悪い目）は自動的に除外する。
  const EV_THRESHOLD       = 1.15;
  // EV1.5以上は「★超妙味株」として特に目立たせる
  const EV_SUPER_THRESHOLD = 1.5;

  // ── 全レース分の買い目候補を1本のフラットな配列に集約 ──────
  // _scenEVCache の各レースには prefillScenEVCache で保存した
  //   buyCombos: [{ c: パターン文字列, prob: 的中確率(比率0-1), ... }, ...]
  //   oddsMap  : { パターン文字列: 直前オッズ }（そのレース時点のスナップショット）
  // が入っている。ここで共通ピュア関数 filterCombosByExpectedValue に通し、
  // 「計算 → EV1.15未満を除外 → EV降順ソート」を行う。
  // オッズが欠損している買い目（特払い・欠場・データ未取得等）は
  // filterCombosByExpectedValue 側で安全にスキップされる。
  let allEvCombos = [];
  Object.values(_scenEVCache).forEach(r => {
    if (!Array.isArray(r.buyCombos) || r.buyCombos.length === 0 || !r.oddsMap) return;

    let filtered;
    try {
      filtered = filterCombosByExpectedValue(r.buyCombos, r.oddsMap, EV_THRESHOLD, {
        patternKey: 'c', probKey: 'prob', probIsPercentage: false,
      });
    } catch (e) {
      // 想定外のデータ形式が来てもセクション全体を落とさない
      filtered = [];
    }

    filtered.forEach(c => {
      allEvCombos.push({ ...c, venue: r.venue, rno: r.rno, date: r.date });
    });
  });

  // レースをまたいだランキングとして、全体をEV降順に再ソート
  allEvCombos.sort((a, b) => b._ev - a._ev);

  // ── 買い目が1つも残らない場合は「ケン」推奨を表示して終了 ──────
  if (allEvCombos.length === 0) {
    el.innerHTML = `<div class="scen-ev-empty" style="padding:16px 10px;color:var(--red);font-size:13px;line-height:1.6;text-align:center;font-weight:700;border:1px dashed var(--red);border-radius:8px;background:rgba(255,59,48,0.06)">
      【ケン（見送り推奨）】期待値が基準を超える買い目がありません。
    </div>`;
    return;
  }

  const cards = allEvCombos.map(r => {
    const isSuper  = r._ev >= EV_SUPER_THRESHOLD;
    const evColor  = isSuper ? '#00c853' : (r._ev >= 1.3 ? 'var(--green)' : 'var(--orange)');
    const probStr  = r.prob  != null ? (r.prob * 100).toFixed(1) + '%' : '—';
    const oddsStr  = r._odds != null ? r._odds.toFixed(1) + '倍'       : '—';
    const comboHtml = (typeof comboToBadges === 'function') ? comboToBadges(r.c) : r.c;

    // ★超妙味株（EV1.5以上）は枠線・シャドウで強調するクラス/スタイルを付与
    const cardClass = 'scen-ev-card' + (isSuper ? ' scen-ev-card--super' : '');
    const cardStyle = isSuper
      ? 'cursor:pointer;border:2px solid #00c853;box-shadow:0 0 10px rgba(0,200,83,0.35);'
      : 'cursor:pointer';

    return `<div class="${cardClass}" style="${cardStyle}" onclick="(function(){
      const dataFD = getDataForDate(viewDate);
      if(!dataFD['${r.venue}']) return;
      hideTopPage();
      currentVenue = '${r.venue}';
      DATA = dataFD['${r.venue}'];
      selectedRace = ${r.rno};
      updateHeaderMeta('${r.venue}', ${r.rno});
      document.querySelectorAll('.vtab').forEach(b=>b.classList.toggle('active',b.dataset.venue==='${r.venue}'));
      buildRaceBar();
      const TAB_NAMES=['detail','detail2','buy','comment','result','odds'];
      TAB_NAMES.forEach(t=>{document.getElementById('tab-'+t).style.display=t==='detail2'?'':'none';});
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab==='detail2'));
      selectRace(${r.rno});
    })()">
      <div class="scen-ev-card-header">
        <span class="scen-ev-venue">${r.venue}</span>
        <span class="scen-ev-race">${r.rno}R</span>
        ${isSuper ? `<span class="scen-ev-super-badge" style="font-weight:800;font-size:10px;padding:2px 6px;border-radius:4px;background:#00c85320;border:1px solid #00c853;color:#00c853;margin-left:auto">★超妙味株</span>` : ''}
        <span class="scen-ev-badge" style="background:${evColor}20;border:1px solid ${evColor};color:${evColor}${isSuper ? '' : ';margin-left:auto'}">
          期待値 <strong>${r._ev.toFixed(2)}</strong>
        </span>
      </div>
      <div class="scen-ev-card-body">
        <div class="scen-ev-stat" style="grid-column:1/-1">
          <span class="scen-ev-combo">${comboHtml}</span>
        </div>
        <div class="scen-ev-stat">
          <span class="scen-ev-label">的中確率</span>
          <span class="scen-ev-val" style="font-family:var(--mono)">${probStr}</span>
        </div>
        <div class="scen-ev-stat">
          <span class="scen-ev-label">オッズ</span>
          <span class="scen-ev-val" style="font-family:var(--mono)">${oddsStr}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = cards;
}

// TOP ページが表示されるたびに期待値セクションを描画する
// showTopPage 完了を MutationObserver で検知
(function _initScenEVObserver(){
  if(typeof MutationObserver === 'undefined') return;
  const topPage = document.getElementById('top-page');
  if(!topPage) return;

  let _lastDisplay = '';
  const obs = new MutationObserver(() => {
    const cur = topPage.style.display;
    if(cur !== 'none' && _lastDisplay !== cur){
      // 旧来の期待値セクション更新
      renderScenEVSection();

      // _scenEVCacheReady === true（prefill 完了済み）なら的中速報も即時更新
      // false の場合は calcTopAIStats → リトライ機構が完了後に更新する
      if (_scenEVCacheReady) {
        const _ev = document.getElementById('top-scen-ev-section');
        if (_ev && typeof _buildHitSokuhoPanel === 'function') {
          const _dates = getAvailableDates();
          const _todayDate = _dates[_dates.length - 1];
          if (_todayDate) {
            _ev.innerHTML = _buildHitSokuhoPanel(_todayDate);
          }
        }
      }
    }
    _lastDisplay = cur;
  });
  obs.observe(topPage, { attributes: true, attributeFilter: ['style'] });
})();