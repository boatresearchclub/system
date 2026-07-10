// ══════════════════════════════════════════════════════════════════
// フェーズ2: data/*.json を fetch して埋め込み変数にマージするローダー
//
// 設計方針:
//   - 埋め込み変数（RESULT_DATA / ALL_DATA_HISTORY）はそのまま残す
//     → 埋め込み済みデータが既あれば即座に表示できる
//   - fetch完了後に変数へマージ → 過去日数が増えても HTML は軽量
//   - fetch失敗しても埋め込みデータで動作継続（フォールバック保証）
//   - IS_SERVER 環境では fetch を行わない（ローカルサーバーのAPIを使うため）
// ══════════════════════════════════════════════════════════════════

// フェーズ2: data/ ディレクトリのベースURL（index.htmlと同階層）
const DATA_BASE_URL = (function() {
  const base = location.href.replace(/\/[^\/]*$/, '');
  return base + '/data';
})();

// フェーズ2ローダー: data/index.json を先にfetchして存在する日付だけ並列fetch
async function fetchAndMergeJsonData() {
  // ── fetchヘルパー: 失敗しても null を返す ──
  // noCache=true のときのみ no-store（index.json用）、
  // それ以外はブラウザキャッシュを活用して高速化（変更なければ304で即返る）
  async function safeFetch(url, noCache) {
    try {
      const res = await fetch(url, { cache: noCache ? 'no-cache' : 'default' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // ① data/index.json を先にfetchして存在する日付リストを取得
  // index.json だけ毎回確認（no-store）、各データJSONはキャッシュ活用
  const idx = await safeFetch(`${DATA_BASE_URL}/index.json`, true);
  if (!idx) {
    // index.json がなければ何もしない（フェーズ1未完了 or 初回push前）
    return;
  }

  const resultDates  = idx.result_dates  || [];   // ["20260512", "20260511", ...]
  const historyDates = idx.history_dates || [];

  // ── today_YYYYMMDD.json を fetch して ALL_DATA にセット ──
  // idx.today_date: "20260611" 形式（auto_push.py の write_data_index が出力）
  const todayNd = idx.today_date;
  if (todayNd) {
    const todayData = await safeFetch(`${DATA_BASE_URL}/today_${todayNd}.json`, true);
    if (todayData) {
      // data.js ビルド時点で埋め込まれた古い venue（今日 today_*.json に
      // 存在しないもの＝前日以前の開催場）を ALL_DATA から削除する。
      // これをやらないと GitHub Pages 等で data.js のビルドが古い場合に
      // 「本日の開催場」へ前日の会場が混入し続けるバグになる。
      for (const venue of Object.keys(ALL_DATA)) {
        if (!Object.prototype.hasOwnProperty.call(todayData, venue)) {
          delete ALL_DATA[venue];
        }
      }
      for (const [venue, vdata] of Object.entries(todayData)) {
        ALL_DATA[venue] = vdata;
      }
    }
  }

  // ② RESULT_DATA: index.json に記録された日付だけfetch（404が出ない）
  const resultFetches = resultDates.map(nd =>
    safeFetch(`${DATA_BASE_URL}/result_${nd}.json`).then(data => {
      if (!data) return;
      for (const [key, val] of Object.entries(data)) {
        // key = "{slug}_{rno}" または "{slug} {rno}"（実データはスペース区切り）
        // → RESULT_DATA キー = "{slug}_{YYYYMMDD}_{rno}"
        const m = key.match(/^(.+)[ _](\d+)$/);
        const fullKey = m ? `${m[1]}_${nd}_${m[2]}` : `${key}_${nd}`;
        if (!RESULT_DATA[fullKey]) RESULT_DATA[fullKey] = val;
      }
    })
  );

  // ③ ALL_DATA_HISTORY: index.json に記録された日付だけfetch
  const historyFetches = historyDates.map(nd => {
    const dash = `${nd.slice(0,4)}-${nd.slice(4,6)}-${nd.slice(6,8)}`;
    return safeFetch(`${DATA_BASE_URL}/history_${nd}.json`).then(data => {
      if (!data) return;
      if (!ALL_DATA_HISTORY[dash]) {
        ALL_DATA_HISTORY[dash] = data;
      } else {
        // 会場単位で補完（埋め込みが空の会場のみ）
        for (const [venue, vdata] of Object.entries(data)) {
          if (!ALL_DATA_HISTORY[dash][venue]) {
            ALL_DATA_HISTORY[dash][venue] = vdata;
          }
        }
      }
    });
  });

  // ④ master_ext.json（MASTER_EXT が null の場合のみ上書き）
  const masterFetch = safeFetch(`${DATA_BASE_URL}/master_ext.json`).then(data => {
    if (data && !MASTER_EXT) MASTER_EXT = data;
  });

  // ⑤ player_id_map.json（登番→選手名 のマップ）
  // → 出走表で「選手名→登番」を逆引きできるように PLAYER_ID_MAP に格納する。
  // 同名の選手が複数いる場合は最初に見つかった登番を優先する（上書きしない）。
  const playerIdMapFetch = safeFetch(`${DATA_BASE_URL}/player_id_map.json`).then(data => {
    if (!data) return;
    for (const [toban, name] of Object.entries(data)) {
      if (!Object.prototype.hasOwnProperty.call(PLAYER_ID_MAP, name)) {
        PLAYER_ID_MAP[name] = toban;
      }
    }
  });

  // 全fetch並列実行（失敗しても続行）
  await Promise.allSettled([...resultFetches, ...historyFetches, masterFetch, playerIdMapFetch]);
}


// IS_SERVER: localhost以外（Netlify/GitHub Pages）では動的APIは使えないため
// ホスト名でランタイム判定する（auto_pushによるハードコード true を廃止）
const IS_SERVER = (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
// APIサーバー疎通フラグ（初回チェック後に確定）
let _serverAvailable = IS_SERVER;
const PLAYER_ID_MAP = {};

// ============================================================
// アプリロジック グローバル変数
// ============================================================
let DATA = null;
let selectedRace = 0;
let currentVenue = '';

const _tenjiCache = {};
let _tenjiCacheReady = false;
let _renderBuyRetry = false; // ★追加: renderBuyのリトライ制御

// ══════════════════════════════════════════════════════════════════
// レンダーキャッシュ（改善①）
// renderBuy / renderDetail の計算結果HTMLをメモ化する。
// キー: "{venue}_{date}_{rno}" — データ更新時に invalidateRenderCache() で一括破棄。
// _RENDER_CACHE_VER: 表示ロジック変更時にインクリメントしてキャッシュを強制無効化。
// ══════════════════════════════════════════════════════════════════
const _RENDER_CACHE_VER = 3; // ★バージョンアップ（MASTER_EXT待機対応）
const _renderCache = {};

/**
 * レンダーキャッシュを全破棄する。
 * refreshTenjiData / refreshOddsData 完了後に呼ぶこと。
 */
function invalidateRenderCache() {
  const keys = Object.keys(_renderCache);
  keys.forEach(k => delete _renderCache[k]);
  if (keys.length > 0) {
  }
}

/**
 * キャッシュキーを生成する共通ヘルパー。
 * venue / DATA.date / rno が揃っている前提で呼ぶこと。
 */
function _renderCacheKey(rno) {
  const slug = (typeof VENUE_SLUG_MAP !== 'undefined' && VENUE_SLUG_MAP[currentVenue])
    ? VENUE_SLUG_MAP[currentVenue] : currentVenue;
  return `${slug}_${DATA?.date ?? ''}_${rno}`;
}

// ── シナリオ買い目キャッシュ（メモリ + localStorage 二層構造）──
// 保存: buildScenarioBuyPanel が allCombos 確定時にメモリと localStorage 両方に書く。
// 読出: computeScenCombos がメモリ → localStorage → 再計算 の順に参照する。
// これによりリロード・翌日集計でも画面表示と集計の買い目が完全に一致する。
//
// localStorage キー形式: "scen_c_{venue}_{date}_{rno}"
//   例: "scen_c_津_2026-05-20_6"
// localStorage 値: カンマ区切りのcombo文字列
//   例: "2-1-3,2-3-1,2-5-1"
// 容量目安: 最大18点×7文字×288レース/日 ≒ 37KB/日 → 30日分で約1MB（上限5MB以内）
// 古いエントリ: 起動時に30日以上前のキーを自動削除する。
const _scenComboCache = {};
const _SCEN_CACHE_LS_PREFIX = 'scen_c_';
const _SCEN_CACHE_EXPIRE_DAYS = 30;

// localStorage からメモリキャッシュに復元 & 古いエントリを削除する初期化関数
function _initScenComboCache() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - _SCEN_CACHE_EXPIRE_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const toDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const lsKey = localStorage.key(i);
      if (!lsKey || !lsKey.startsWith(_SCEN_CACHE_LS_PREFIX)) continue;
      // キー形式: "scen_c_{venue}_{YYYY-MM-DD}_{rno}"
      // 日付部分を正規表現で抽出
      const m = lsKey.match(/(\d{4}-\d{2}-\d{2})/);
      if (m && m[1] < cutoffStr) {
        toDelete.push(lsKey);
        continue;
      }
      // メモリキャッシュに復元
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        // lsKey: "scen_c_{venue}_{date}_{rno}" → memKey: "{venue}_{date}_{rno}"
        const memKey = lsKey.slice(_SCEN_CACHE_LS_PREFIX.length);
        _scenComboCache[memKey] = raw.split(',');
      }
    }
    toDelete.forEach(k => localStorage.removeItem(k));
  } catch(_e) { /* プライベートブラウズ等でlocalStorage使用不可の場合は無視 */ }
}

// localStorage にシナリオ買い目を保存するヘルパー
// ── [修正] venue は VENUE_SLUG_MAP でslug変換してからキーに使う ──
// computeScenCombosWithEV のキャッシュ参照も同一のslug変換を行うため、
// キーを統一しないとキャッシュが永遠に命中しない問題を修正。
function _saveScenComboToLS(venue, date, rno, combos) {
  try {
    if (!venue || !date || rno == null || !combos || combos.length === 0) return;
    const slug   = (typeof VENUE_SLUG_MAP !== 'undefined' && VENUE_SLUG_MAP[venue])
                   ? VENUE_SLUG_MAP[venue] : venue;
    const memKey = `${slug}_${date}_${rno}`;
    const lsKey  = `${_SCEN_CACHE_LS_PREFIX}${memKey}`;
    _scenComboCache[memKey] = combos.slice();
    localStorage.setItem(lsKey, combos.join(','));
  } catch(_e) { /* localStorage 書き込み失敗は無視 */ }
}

function _ensureTenjiCache() {
  if (_tenjiCacheReady) return;
  for(const [key, val] of Object.entries(TENJI_DATA)){
    const normalized = key.replace(/_(\d{4})(\d{2})(\d{2})_/, '_$1-$2-$3_');
    _tenjiCache[normalized] = val;
  }
  _tenjiCacheReady = true;
}

function tenjiKey(venue, date, race){
  // _ensureTenjiCache が YYYYMMDD → YYYY-MM-DD に変換するのに合わせる
  const d = String(date).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  return `${venue}_${d}_${race}`;
}