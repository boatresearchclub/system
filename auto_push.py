"""
auto_push.py  —  CSV・展示情報JSON・index.html を GitHub に自動push
====================================================================
【監視対象】
  csv_output/*.csv     → pushしてスマホで番組表を表示
  tenji_data/*.json    → pushしてスマホで展示情報を表示
  index.html           → 常に含める

【使い方】
  python auto_push.py

【初回セットアップ済み前提】
  git init / git remote add origin ... / git push -u origin master
"""

import subprocess, time, json, glob, os, re, sys, queue
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from datetime import datetime
import pandas as pd

# ── Windows CP932 対策: stdout/stderr を UTF-8 に強制 ──────────────
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = open(sys.stdout.fileno(), mode="w", encoding="utf-8", buffering=1)
if sys.stderr.encoding and sys.stderr.encoding.lower() not in ("utf-8", "utf8"):
    sys.stderr = open(sys.stderr.fileno(), mode="w", encoding="utf-8", buffering=1)

# ── 買い目点数最適化ロジック ──────────────────────────────
try:
    from betting_optimizer import classify_race as _classify_race
    _OPTIMIZER_AVAILABLE = True
except ImportError:
    _OPTIMIZER_AVAILABLE = False
    print("[警告] betting_optimizer.py が見つかりません。推奨点数は全レース10点になります。")

SCRIPTS_DIR = Path(__file__).parent
# ── データ収集フォルダ（auto_push.py とは別の場所） ──────────────
DATA_COLLECT_DIR = Path(r"C:\Users\user\Desktop\データ収集\scripts")
# fetch_odds.py を import できるように sys.path に追加
if str(DATA_COLLECT_DIR) not in sys.path:
    sys.path.insert(0, str(DATA_COLLECT_DIR))
TENJI_DIR   = DATA_COLLECT_DIR / "data"
COMMENT_DIR = DATA_COLLECT_DIR / "data"
RESULT_DIR  = DATA_COLLECT_DIR / "data"
ODDS_DIR    = DATA_COLLECT_DIR / "data"
DATA_DIR    = SCRIPTS_DIR / "data"       # GitHubにpushする書き出し先（BRCsystem/data）

# オッズ取得間隔（秒）
ODDS_FETCH_INTERVAL = 300   # 5分ごと

CSV_DIR           = DATA_COLLECT_DIR / "csv_output"
RESULTS_CSV_DIR    = DATA_COLLECT_DIR.parent / "data_csv"  # ← scriptsを挟まない実際の格納先に修正
INDEX_HTML        = SCRIPTS_DIR / "index.html"
CSS_FILE          = SCRIPTS_DIR / "sample.css"
JS_FILE           = SCRIPTS_DIR / "sample.js"
JS_FILE_OBF       = SCRIPTS_DIR / "sample_obf.js"
PARAMS_JS         = SCRIPTS_DIR / "params.js"
PARAMS_JS_OBF     = SCRIPTS_DIR / "params_obf.js"
CSV_EXPORT_JS     = SCRIPTS_DIR / "csv_export.js"
CSV_EXPORT_JS_OBF = SCRIPTS_DIR / "csv_export_obf.js"
SIM_JS            = SCRIPTS_DIR / "sim.js"
SIM_JS_OBF        = SCRIPTS_DIR / "sim_obf.js"
BACKTEST_JS       = SCRIPTS_DIR / "backtest.js"
BACKTEST_JS_OBF   = SCRIPTS_DIR / "backtest_obf.js"
TOP_STATS_JS      = SCRIPTS_DIR / "top_stats.js"
TOP_STATS_JS_OBF  = SCRIPTS_DIR / "top_stats_obf.js"
TOP_PAGE_JS       = SCRIPTS_DIR / "top_page.js"
TOP_PAGE_JS_OBF   = SCRIPTS_DIR / "top_page_obf.js"
CALIBRATION_JS        = SCRIPTS_DIR / "calibration.js"
CALIBRATION_JS_OBF    = SCRIPTS_DIR / "calibration_obf.js"
COMPUTE_SCEN_JS       = SCRIPTS_DIR / "computeScenCombosWithEV.js"
COMPUTE_SCEN_JS_OBF   = SCRIPTS_DIR / "computeScenCombosWithEV_obf.js"
DYNAMIC_INN2PLACE_JS  = SCRIPTS_DIR / "dynamic_inn2place.js"
DYNAMIC_INN2PLACE_JS_OBF = SCRIPTS_DIR / "dynamic_inn2place_obf.js"
DATA_JS           = SCRIPTS_DIR / "data.js"
PLAYER_ID_MAP     = DATA_COLLECT_DIR / "player_id_map.json"
TENJIHOSEIPLUS_TEMPLATE = SCRIPTS_DIR / "boatrace_analyzer.html"
TENJIHOSEIPLUS_HTML     = SCRIPTS_DIR / "tenjihoseiplus.html"

try:
    from tenjihoseiplus import maybe_update_tenjihoseiplus
except ImportError:
    maybe_update_tenjihoseiplus = None
    print("[WARN] tenjihoseiplus.py が見つかりません → tenjihoseiplus.html 更新はスキップされます")
VIEWER_HTML           = SCRIPTS_DIR / "展開別残存ビューア.html"
FETCH_TENJI_PY        = SCRIPTS_DIR / "fetch_tenji.py"
FETCH_RESULT_PY       = DATA_COLLECT_DIR / "fetch_result.py"
FETCH_RACE_INDEX_PY   = DATA_COLLECT_DIR / "fetch_race_index.py"
FETCH_ODDS_PY         = DATA_COLLECT_DIR / "fetch_odds.py"
RACE_INDEX_JSON       = DATA_COLLECT_DIR / "race_index.json"

def get_race_index_path(date_str=None):
    if date_str:
        hd = date_str.replace("-", "")
    else:
        hd = datetime.now().strftime("%Y%m%d")
    p = DATA_COLLECT_DIR / f"race_index_{hd}.json"
    if p.exists():
        return p
    return RACE_INDEX_JSON

CHECK_INTERVAL    = 2   # 秒
HISTORY_DAYS      = 1
RESULT_DAYS       = 1
HISTORY_KEEP_DAYS = 30  # history_*.json を保持する最大日数（バックテスト用）
RESULT_KEEP_DAYS  = 30  # result_*.json を保持する最大日数

VENUE_SLUG = {
    "桐生":   "kiryu",    "戸田":   "toda",     "江戸川": "edogawa",
    "平和島": "heiwajima","多摩川": "tamagawa", "浜名湖": "hamanako",
    "蒲郡":   "gamagori", "常滑":   "tokoname", "津":     "tsu",
    "三国":   "mikuni",   "びわこ": "biwako",   "住之江": "suminoe",
    "尼崎":   "amagasaki","鳴門":   "naruto",   "丸亀":   "marugame",
    "児島":   "kojima",   "宮島":   "miyajima", "徳山":   "tokuyama",
    "下関":   "shimonoseki","若松":  "wakamatsu","芦屋":   "ashiya",
    "福岡":   "fukuoka",  "唐津":   "karatsu",  "大村":   "omura",
}

# ── 確率計算エンジン（prob_scenario_engine.py に分離） ────────────
from prob_scenario_engine import (
    MASTER,
    rebuild_master,
    load_master,
    apply_kimari_tuning,
    normalize_name,
    resolve_player_name,
    calc_prob_from_master,
    _inject_tenji_scores,
)
try:
    from prob_scenario_engine import _check_tenji_config_sync
except ImportError:
    def _check_tenji_config_sync():
        """prob_scenario_engine に未実装の場合はスキップ"""
        pass
try:
    from prob_scenario_engine import XLSX_PATH
except ImportError:
    XLSX_PATH = Path(r"C:\Users\user\Desktop\データ収集\ボートリサーチ_マスタ.xlsx")
try:
    from prob_scenario_engine import MASTER_JSON
except ImportError:
    MASTER_JSON = Path(r"C:\Users\user\Desktop\データ収集\scripts\master_data.json")

def parse_csv(filepath):
    try:
        try:
            df = pd.read_csv(filepath, encoding="utf-8")
        except UnicodeDecodeError:
            df = pd.read_csv(filepath, encoding="shift_jis")
    except Exception:
        return None
    if "会場" not in df.columns or "レース" not in df.columns:
        return None
    df = df.fillna("")
    venue = str(df.iloc[0]["会場"]).strip()
    date  = str(df.iloc[0].get("日付", "")).strip().replace("/", "-")
    venue_stats = MASTER.get("venue_stats", {}).get(venue, {})
    races = {}
    for _, row in df.iterrows():
        rno = int(row["レース"]) if str(row["レース"]).isdigit() else 0
        if rno == 0:
            continue
        if rno not in races:
            races[rno] = {
                "arek": venue_stats.get("arek_by_race", {}).get(rno,
                        venue_stats.get("arek_score", 54.7)),
                "time": str(row.get("締切時刻", "")),
                "boats": []
            }
        raw_name = str(row.get("選手名", "")).strip()
        reg_no   = str(row.get("登番", "")).strip()
        if raw_name:
            raw_name = re.sub(r'\d+$', '', raw_name).strip()
        if raw_name:
            name, name_dq = resolve_player_name(raw_name, reg_no)
        else:
            name, name_dq = f"艇{row.get('艇番', '?')}", "unresolved"
        # モーター番号
        # fetch_tenji.py が保存する列名は "motor_no"
        # 旧列名（モーター番号 / モーターNo / M番号）にもフォールバック
        motor_no_raw = row.get("motor_no",
                       row.get("モーター番号",
                       row.get("モーターNo",
                       row.get("M番号", None))))
        try:
            motor_no = int(float(motor_no_raw)) if motor_no_raw not in (None, "", "nan") else None
        except (ValueError, TypeError):
            motor_no = None

        # モーター2連対率
        # fetch_tenji.py が保存する列名は "motor_rate2"
        # 旧列名（M2率）にもフォールバック
        motor_rate2_raw = row.get("motor_rate2", row.get("M2率", None))
        try:
            motor_rate2 = float(motor_rate2_raw) if motor_rate2_raw not in (None, "", "nan") else 0.0
        except (ValueError, TypeError):
            motor_rate2 = 0.0

        # モーター3連対率
        motor_rate3_raw = row.get("motor_rate3", row.get("M3率", None))
        try:
            motor_rate3 = float(motor_rate3_raw) if motor_rate3_raw not in (None, "", "nan") else 0.0
        except (ValueError, TypeError):
            motor_rate3 = 0.0

        # モーター順位
        motor_rank_raw = row.get("motor_rank", None)
        try:
            motor_rank = int(float(motor_rank_raw)) if motor_rank_raw not in (None, "", "nan") else None
        except (ValueError, TypeError):
            motor_rank = None

        # 前節使用者
        # fetch_tenji.py が保存する列名は "prev_user"
        # 旧列名（前節使用者 / 前節使用）にもフォールバック
        prev_user_raw = row.get("prev_user",
                        row.get("前節使用者",
                        row.get("前節使用", None)))
        prev_user = str(prev_user_raw).strip() if prev_user_raw not in (None, "", "nan") else None

        races[rno]["boats"].append({
            "boat":       int(row.get("艇番", 0)),
            "reg_no":     reg_no,
            "name":       name,
            "name_dq":    name_dq,
            "grade":      str(row.get("級別", "B1")),
            "win_rate":   float(row.get("全国勝率", 0) or 0),
            "local_rate": float(row.get("当地勝率", 0) or 0),
            "motor2":     motor_rate2,    # ← motor_rate2 列から取得
            "motor_rate2": motor_rate2,   # ← sample.html の両方の参照に対応
            "motor_rate3": motor_rate3,
            "boat2":      float(row.get("B2率", 0) or 0),
            "results":    str(row.get("今節成績", "")),
            "hayami":     float(row.get("早見", 0) or 0) or None,
            "motor_no":   motor_no,
            "motor_rank": motor_rank,
            "prev_user":  prev_user,
            "score":      0,
            "dq":         "fallback",
            "prob":       1/6,
        })
    # ── 女子戦フラグ・グレードを race_index_{YYYYMMDD}.json から取得 ──
    is_joshi = False
    race_grade = "一般"   # "SG" / "G1" / "G2" / "G3" / "一般"
    try:
        _ri_path = get_race_index_path(date)
        if _ri_path.exists():
            with open(_ri_path, encoding="utf-8") as _f:
                _ri = json.load(_f)
            _vi = _ri.get("venues", {}).get(venue, {})
            _period = _vi.get("period", "")
            _period_match = False
            if _period and date:
                try:
                    from datetime import datetime as _dt
                    _year = _dt.now().year
                    _parts = _period.replace(" ", "").split("-")
                    if len(_parts) == 2:
                        _start = _dt.strptime(f"{_year}/{_parts[0]}", "%Y/%m/%d").date()
                        _end   = _dt.strptime(f"{_year}/{_parts[1]}", "%Y/%m/%d").date()
                        _csv_d = _dt.strptime(date, "%Y-%m-%d").date()
                        _period_match = _start <= _csv_d <= _end
                except Exception:
                    pass
            if _period_match:
                is_joshi   = bool(_vi.get("is_joshi", False))
                race_grade = str(_vi.get("grade", "一般"))
    except Exception:
        pass

    for rno, rd in races.items():
        rd["boats"] = calc_prob_from_master(rd["boats"], venue, race_no=rno,
                                            is_joshi=is_joshi, grade=race_grade)
        rd["boats"].sort(key=lambda b: -b["prob"])

    # ── 買い目点数最適化パターンを各レースに付与（v2対応）──────
    # 【変更点】
    #   ① boat1_tenkai / pred1_tenkai は分類判定用の raw値（cap しない）
    #   ② tenji係数（boat1_tenji / pred1_tenji）を新たに渡す → 補正専用・上限1.0キャップ
    #   ③ are_index（あれ指数）を渡す → まくりアラートフラグに使用
    #   ④ pat.flags からフラグ群を rd["opt_flags"] に格納（UI表示・将来拡張用）
    #   ⑤ [2026-05-17] buy_mode別にclassify_raceを2回呼び出し → opt_points_hit/rec に格納
    #      HIT: あれ>=55のSS他艇を不買い（的中率向上）
    #      REC: あれフィルターなし（高配当狙い維持）
    if _OPTIMIZER_AVAILABLE:
        for rno, rd in races.items():
            boats_sorted = rd["boats"]  # prob降順済み
            pred_rank1   = boats_sorted[0] if boats_sorted else None
            boat1_data   = next((b for b in boats_sorted if b["boat"] == 1), None)

            if pred_rank1 and boat1_data:
                # ── base係数 = prob（正規化済み基準確率）─────────────────
                pred1_base = pred_rank1.get("prob", 0.0)
                boat1_base = boat1_data.get("prob", 0.0)

                # ── tenkai係数（raw値）= 分類判定専用。cap しない ────────
                # tenkai_score が付与されていればそれ、なければ prob で代替
                pred1_tenkai = pred_rank1.get("tenkai_score", pred_rank1.get("prob", 0.0))
                boat1_tenkai = boat1_data.get("tenkai_score", boat1_data.get("prob", 0.0))

                # ── tenji係数 = 展示係数。補正専用（内部で上限1.0キャップ）
                # [2026-05-17 修正] tenji_score_coef（平均=1.0基準の係数）を使用する。
                # 旧: tenji_score（全艇合計=1.0の正規化値）を渡していた → 常に1.0フォールバック
                # 新: _inject_tenji_scores() が付与した tenji_score_coef（0.5〜2.0）を渡す
                #     tenji_score_coef がなければ 1.0（中立・展示データなし扱い）
                pred1_tenji = pred_rank1.get("tenji_score_coef") or 1.0
                boat1_tenji = boat1_data.get("tenji_score_coef") or 1.0

                # ── あれ指数（レース単位）= まくりアラートフラグ用 ────────
                are_index = float(rd.get("arek", 50.0))

                # [2026-05-17] HIT/REC 両モードで分類（buy_mode別に挙動が異なる）
                common_args = dict(
                    venue           = venue,
                    pred_rank1_boat = int(pred_rank1["boat"]),
                    boat1_base      = boat1_base,
                    boat1_tenkai    = boat1_tenkai,
                    pred1_base      = pred1_base,
                    pred1_tenkai    = pred1_tenkai,
                    boat1_tenji     = boat1_tenji,
                    pred1_tenji     = pred1_tenji,
                    are_index       = are_index,
                )
                pat_hit = _classify_race(**common_args, buy_mode="hit")
                pat_rec = _classify_race(**common_args, buy_mode="rec")

                # パターン名・フラグはHITを基準（両モードで同一のはずだが念のため）
                pat = pat_hit if pat_hit is not None else pat_rec

                # pat が None = 除外会場
                if pat is None:
                    rd["opt_pattern"]         = "除外会場"
                    rd["opt_points"]          = 0
                    rd["opt_points_hit"]      = 0
                    rd["opt_points_rec"]      = 0
                    rd["opt_pass_reason_hit"] = ""
                    rd["opt_pass_reason_rec"] = ""
                    rd["opt_flags"]           = {}
                else:
                    rd["opt_pattern"]         = pat.name
                    rd["opt_points"]          = pat.points           # 後方互換（HIT値）
                    rd["opt_points_hit"]      = pat_hit.points if pat_hit else 0
                    rd["opt_points_rec"]      = pat_rec.points if pat_rec else 0
                    rd["opt_pass_reason_hit"] = pat_hit.pass_reason if pat_hit else ""
                    rd["opt_pass_reason_rec"] = pat_rec.pass_reason if pat_rec else ""
                    # ── フラグ群を dict で格納（UI・将来拡張用）──────────
                    rd["opt_flags"] = {
                        "makuri_alert":   pat.flags.makuri_alert,    # まくり/まくり差しアラート
                        "sashi_alert":    pat.flags.sashi_alert,     # 差し/抜きアラート
                        "low_dividend":   pat.flags.low_dividend,    # 低配当罠フィルター
                        "sweet_spot":     pat.flags.sweet_spot,      # スイートスポット
                        "high_pop_zone":  pat.flags.high_pop_zone,   # 高人気圧縮ゾーン
                        "kimari_predict": pat.flags.kimari_predict,  # 将来: 決まり手予測
                    }
            else:
                rd["opt_pattern"]         = "中立1号艇"
                rd["opt_points"]          = 10
                rd["opt_points_hit"]      = 10
                rd["opt_points_rec"]      = 10
                rd["opt_pass_reason_hit"] = ""
                rd["opt_pass_reason_rec"] = ""
                rd["opt_flags"]           = {}
    else:
        for rno, rd in races.items():
            rd["opt_pattern"]         = "（未設定）"
            rd["opt_points"]          = 10
            rd["opt_pass_reason_hit"] = ""
            rd["opt_pass_reason_rec"] = ""
            rd["opt_flags"]           = {}

    # ── race_index_{YYYYMMDD}.json から開催情報を取得（period照合で正確に判定）──
    race_info = {}
    try:
        _ri_path2 = get_race_index_path(date)
        if _ri_path2.exists():
            with open(_ri_path2, encoding="utf-8") as _f:
                _ri = json.load(_f)
            _vi = _ri.get("venues", {}).get(venue, {})
            if _vi:
                _period = _vi.get("period", "")
                _period_match = False
                if _period and date:
                    try:
                        from datetime import datetime as _dt2
                        _year = _dt2.now().year
                        _parts = _period.replace(" ", "").split("-")
                        if len(_parts) == 2:
                            _start = _dt2.strptime(f"{_year}/{_parts[0]}", "%Y/%m/%d").date()
                            _end   = _dt2.strptime(f"{_year}/{_parts[1]}", "%Y/%m/%d").date()
                            _csv_d = _dt2.strptime(date, "%Y-%m-%d").date()
                            _period_match = _start <= _csv_d <= _end
                    except Exception:
                        pass
                if _period_match:
                    race_info = {
                        "grade":    _vi.get("grade", ""),
                        "is_joshi": bool(_vi.get("is_joshi", False)),
                        "title":    _vi.get("title", ""),
                        "period":   _period,
                        "day":      _vi.get("day", ""),
                    }
    except Exception:
        pass

    # ── [2026-05-17 追加] 展示スコアを boats に付与 ──────────────────────
    # tenji_data/*.json を読み込み、各艇に tenji_score / tenji_score_coef を付与。
    # classify_race() に渡る boat1_tenji / pred1_tenji が正しく機能するようになる。
    # 展示JSONが存在しないレースはスキップ（副作用なし）。
    _inject_tenji_scores(races, venue, date)

    return {
        "venue":     venue,
        "date":      date,
        "race_info": race_info,
        "inn_data": {
            "inn_rate":    venue_stats.get("inn_rate", 0.5),
            "arek_score":  venue_stats.get("arek_score", 50),
            "course_rates": [0] + [
                venue_stats.get("course_rates", {}).get(str(c), 0)
                for c in range(1, 7)
            ],
            "inn_2place": venue_stats.get("inn_2place", {}),
        },
        "races": {str(k): v for k, v in sorted(races.items())},
    }

# ── index.html への埋め込み ────────────────────────────
VENUE_LIST = [
    '桐生','戸田','江戸川','平和島','多摩川','浜名湖','蒲郡','常滑',
    '津','三国','びわこ','住之江','尼崎','鳴門','丸亀','児島',
    '宮島','徳山','下関','若松','芦屋','福岡','唐津','大村'
]

def inject_all_data_to_html():
    """当日CSVを全部parseしてindex.htmlのALL_DATAを書き換える"""
    # get_today_csvs() を使うことで深夜帯（0〜3時）も正しく当日CSVを取得できる
    # （today_str() は深夜帯に翌日付を返すため直接使わない）
    all_data = {v: None for v in VENUE_LIST}
    loaded = []

    for csv_path in get_today_csvs():
        data = parse_csv(csv_path)
        if data and data.get("venue") in all_data:
            all_data[data["venue"]] = data
            loaded.append(data["venue"])

    if not loaded:
        log("  ⚠ 当日CSVなし → ALL_DATA埋め込みスキップ")
        return False

    html_text = _data_js_read()

    # ALL_DATA の埋め込みブロックを正規表現で置換
    all_data_json = json.dumps(all_data, ensure_ascii=False, separators=(",", ":"))
    new_block = f"let ALL_DATA = {all_data_json};\n"

    # 既存の let ALL_DATA = {...}; を置換（複数行対応）
    pattern = r'(?:let|const) ALL_DATA = [\s\S]*?;[^\n]*\n'
    if re.search(pattern, html_text):
        html_text = re.sub(pattern, new_block, html_text)
    else:
        log("  ⚠ ALL_DATAの埋め込み位置が見つかりません")
        return False

    # ── タイムスタンプ埋め込み（差分を強制生成） ──────────
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    html_text = re.sub(r'<!-- auto_push_updated:.*?-->', '', html_text)
    html_text = html_text.replace(
        '</head>',
        f'<!-- auto_push_updated:{timestamp} --></head>',
        1
    )

    safe_text = html_text.replace('\x00', '')
    _data_js_write(safe_text)
    # [fix] ALL_DATA更新時に必ずキャッシュバスターを更新する。
    # update_cache_version() は index.html の /* __CACHE_VER__ */ を書き換えるため、
    # ブラウザが data.js を古いキャッシュから読むのを防ぐ。
    update_cache_version()
    log(f"  ✓ ALL_DATA埋め込み完了 ({timestamp}): {', '.join(loaded)}")
    return True


def inject_master_ext_to_html():
    """master_data.json の venue_kimari / tenkai_remaining を index.html に埋め込む"""
    if not MASTER_JSON.exists():
        log("  ⚠ master_data.json が見つかりません → MASTER_EXT埋め込みスキップ")
        return False

    master_ext = {
        "venue_kimari":        MASTER.get("venue_kimari", {}),
        "tenkai_remaining":    MASTER.get("tenkai_remaining", {}),
        "winner_course_order": MASTER.get("winner_course_order", {}),
        "venue_stats":         MASTER.get("venue_stats", {}),
        "course_master":       MASTER.get("course_master", {}),
        "course_master_joshi": MASTER.get("course_master_joshi", {}),  # 女子戦用コースマスタ
        "course_master_g1":    MASTER.get("course_master_g1", {}),     # SG/G1戦用コースマスタ
        "player_index":        MASTER.get("player_index", {}),
    }

    html_text = _data_js_read()
    master_ext_json = json.dumps(master_ext, ensure_ascii=False, separators=(",", ":"))
    new_block = f"let MASTER_EXT = {master_ext_json};\n"

    pattern = r'(?:let|const) MASTER_EXT = [\s\S]*?;[^\n]*\n'
    if re.search(pattern, html_text):
        html_text = re.sub(pattern, new_block, html_text)
        _data_js_write(html_text)
        vk = len(master_ext["venue_kimari"])
        tr = len(master_ext["tenkai_remaining"])
        log(f"  ✓ MASTER_EXT埋め込み完了: venue_kimari={vk}会場 tenkai_remaining={tr}会場")
        return True
    else:
        log("  ⚠ MASTER_EXTの埋め込み位置が見つかりません")
        return False


def inject_tenji_to_html(days_back=HISTORY_DAYS):
    """tenji_data/*.json を読んで index.html の TENJI_DATA を書き換える（過去日分も含む）"""
    from datetime import timedelta
    today = datetime.now().date()
    target_dates = [
        (today - timedelta(days=d)).strftime("%Y%m%d")
        for d in range(0, days_back + 1)
    ]
    tenji_all = {}  # { "venue_date_race": {frame: data, __weather: ..., ...} }

    # モーター情報キーのマッピング（JSONフィールド名 → 埋め込みキー名）
    MOTOR_KEYS = (
        ("motor_no",    "__motor_no"),
        ("motor_rate2", "__motor_rate2"),
        ("motor_rate3", "__motor_rate3"),
        ("motor_rank",  "__motor_rank"),
        ("prev_user",   "__prev_user"),
    )

    # 風情報キーのマッピング（JSONフィールド名 → 埋め込みキー名）
    WIND_KEYS = (
        ("weather",             "__weather"),
        ("weather_degree",      "__weather_degree"),
        ("water_degree",        "__water_degree"),
        ("wind_speed",          "__wind_speed"),
        ("wind_direction",      "__wind_direction"),
        ("wind_direction_text", "__wind_direction_text"),
        ("wave_height",         "__wave_height"),
    )

    # 風情報が欠落しているレースを記録（後でまとめて再取得）
    missing_wind = []  # [(fpath, venue, date_nd, race_int, embed_key), ...]

    for fpath in glob.glob(str(TENJI_DIR / "*.json")):
        fname = Path(fpath).name
        if not any(d in fname for d in target_dates):
            continue
        m = re.match(r"tenji_(.+)_(\d{8})_R?(\d+)\.json", fname)
        if not m:
            continue
        venue, date_nd, race = m.group(1), m.group(2), str(int(m.group(3)))
        embed_key = f"{venue}_{date_nd}_{race}"
        try:
            with open(fpath, encoding="utf-8") as f:
                rows = json.load(f)
            by_frame = {str(r["frame"]): r for r in rows}

            # 風情報を __プレフィックスで付与（rowsの先頭行から取得）
            wind_filled = False
            if rows:
                first = rows[0]
                for wind_key, ek_w in WIND_KEYS:
                    val = first.get(wind_key)
                    if val is not None:
                        by_frame[ek_w] = val
                        wind_filled = True

            # モーター情報を各フレームに付与（motor_no / motor_rate2 / motor_rate3 / prev_user）
            for r in rows:
                frame_key = str(r["frame"])
                if frame_key not in by_frame:
                    continue
                for motor_key, ek_m in MOTOR_KEYS:
                    val = r.get(motor_key)
                    if val is not None:
                        by_frame[frame_key][ek_m] = val

            tenji_all[embed_key] = by_frame

            # 風情報が欠落しているレースを記録（当日分のみ・展示データありの場合のみ）
            # 展示データなし（モーター情報だけのJSON）は再取得しない → 永遠に取れないため
            has_tenji = any(
                rows[i].get("lap1") is not None or rows[i].get("tenji") is not None
                for i in range(len(rows))
            ) if rows else False
            if not wind_filled and has_tenji and date_nd == today.strftime("%Y%m%d"):
                missing_wind.append((fpath, venue, date_nd, int(m.group(3)), embed_key))

        except Exception:
            continue

    # ── 風情報が欠落しているレースをバックグラウンドで再取得 ──────────────────
    # 展示データありのJSONのみ対象。pushはブロックしない。
    if missing_wind:
        log(f"  ⚠ 風情報未取得: {len(missing_wind)}レース（展示あり）→ バックグラウンドで再取得")
        import threading as _threading
        _threading.Thread(
            target=_refetch_wind_and_push,
            args=(missing_wind, tenji_all, WIND_KEYS),
            daemon=True,
        ).start()

    html_text = _data_js_read()
    tenji_json = json.dumps(tenji_all, ensure_ascii=False, separators=(",", ":"))
    new_block = f"let TENJI_DATA = {tenji_json};\n"

    pattern = r'(?:let|const) TENJI_DATA = [\s\S]*?;[^\n]*\n'
    if re.search(pattern, html_text):
        html_text = re.sub(pattern, new_block, html_text)
        _data_js_write(html_text)
        log(f"  ✓ 展示情報埋め込み完了: {len(tenji_all)}レース分")
        return True
    else:
        log("  ⚠ TENJI_DATAの埋め込み位置が見つかりません")
        return False


def _refetch_wind_and_push(missing_wind: list, tenji_all: dict, WIND_KEYS: tuple):
    """バックグラウンドで風情報を再取得し、取得できたらHTMLを更新してpush"""
    _refetch_wind(missing_wind, tenji_all, WIND_KEYS)

    has_wind = any(
        tenji_all.get(embed_key, {}).get("__wind_speed") is not None
        or tenji_all.get(embed_key, {}).get("__weather") is not None
        for _, _, _, _, embed_key in missing_wind
    )
    if not has_wind:
        log("  [BG] 風情報: 全レース取得できず → push スキップ")
        return

    log("  [BG] 風情報取得完了 → TENJI_DATA 再埋め込み＋push")
    html_text = _data_js_read()
    tenji_json = json.dumps(tenji_all, ensure_ascii=False, separators=(",", ":"))
    new_block = f"let TENJI_DATA = {tenji_json};\n"
    pattern = r'(?:let|const) TENJI_DATA = [\s\S]*?;[^\n]*\n'
    if re.search(pattern, html_text):
        html_text = re.sub(pattern, new_block, html_text)
        _data_js_write(html_text)
        git_push([INDEX_HTML])
        log("  [BG] ✓ 風情報 push 完了")
    else:
        log("  [BG] ⚠ TENJI_DATA埋め込み位置が見つかりません")


def _refetch_wind(missing_wind: list, tenji_all: dict, WIND_KEYS: tuple):
    """
    风情報が欠落しているレースを Playwright で再取得し、
    tenji_all と JSONファイルを上書きする。

    missing_wind: [(fpath, venue, date_nd, race_int, embed_key), ...]
    """
    try:
        from fetch_tenji import build_wind_url, fetch_html, parse_wind
    except ImportError:
        log("  ⚠ fetch_tenji.py が見つかりません → 風情報再取得スキップ")
        return

    for fpath, venue, date_nd, race_int, embed_key in missing_wind:
        # YYYYMMDD → YYYY-MM-DD
        date_str = f"{date_nd[:4]}-{date_nd[4:6]}-{date_nd[6:]}"
        wind_url = build_wind_url(venue, date_str, race_int)
        log(f"    再取得: {venue} {race_int}R  {wind_url}")

        wind = {}
        # 1回目: 10秒待機、2回目: 5秒だけ確認して諦める
        _poll = 10
        for attempt in range(1, 3):
            try:
                wind_html = fetch_html(
                    wind_url,
                    wait_for="CrawledRaceBeforeInfo",
                    poll_count=_poll,
                )
                wind = parse_wind(wind_html)
                if wind:
                    break
            except Exception as e:
                log(f"    [WARN] 再取得エラー ({attempt}回目): {e}")
            _poll = 5
            if attempt < 2:
                time.sleep(3)

        if not wind:
            log(f"    ✗ {venue} {race_int}R: 風情報取得できず（サイト未掲載の可能性）")
            continue

        # tenji_all の __プレフィックスキーを更新
        by_frame = tenji_all.get(embed_key, {})
        for wind_key, ek_w in WIND_KEYS:
            val = wind.get(wind_key)
            if val is not None:
                by_frame[ek_w] = val
        tenji_all[embed_key] = by_frame

        # JSONファイルも上書き（次回起動時に再取得不要にする）
        try:
            with open(fpath, encoding="utf-8") as f:
                rows = json.load(f)
            for r in rows:
                for wind_key, _ in WIND_KEYS:
                    val = wind.get(wind_key)
                    if val is not None:
                        r[wind_key] = val
            with open(fpath, "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, indent=2)
            log(f"    ✓ {venue} {race_int}R: 風情報取得・JSON更新完了 "
                f"({wind.get('weather','?')} {wind.get('wind_speed','?')}m/s"
                f" {wind.get('wind_direction_text','?')})")
        except Exception as e:
            log(f"    [WARN] JSON更新失敗: {e}")



def inject_comment_to_html(days_back=HISTORY_DAYS):
    """comment_data/*.json を読んで index.html の COMMENT_DATA を書き換える（過去日分も含む）"""
    from datetime import timedelta
    today = datetime.now().date()
    target_dates = [
        (today - timedelta(days=d)).strftime("%Y%m%d")
        for d in range(0, days_back + 1)
    ]
    comment_all = {}  # { "venue_date_race": {frame: data} }

    for fpath in glob.glob(str(COMMENT_DIR / "*.json")):
        fname = Path(fpath).name
        if not any(d in fname for d in target_dates):
            continue
        fname = Path(fpath).name
        # ファイル名: comment_{venue}_{date}_{race}.json or comment_{venue}_{date}_R{race}.json
        m = re.match(r"comment_(.+)_(\d{8})_R?(\d+)\.json", fname)
        if not m:
            continue
        venue, date_nd, race = m.group(1), m.group(2), str(int(m.group(3)))
        embed_key = f"{venue}_{date_nd}_{race}"
        try:
            with open(fpath, encoding="utf-8") as f:
                rows = json.load(f)
            # rows: list of {frame, comment, ...} or dict
            if isinstance(rows, list):
                by_frame = {str(r.get("frame", r.get("boat", ""))): r for r in rows}
            else:
                by_frame = rows
            comment_all[embed_key] = by_frame
        except Exception:
            continue

    html_text = _data_js_read()
    comment_json = json.dumps(comment_all, ensure_ascii=False, separators=(",", ":"))
    new_block = f"let COMMENT_DATA = {comment_json};\n"

    pattern = r'(?:let|const) COMMENT_DATA = [\s\S]*?;[^\n]*\n'
    if re.search(pattern, html_text):
        html_text = re.sub(pattern, new_block, html_text)
        _data_js_write(html_text)
        log(f"  ✓ COMMENT_DATA埋め込み完了: {len(comment_all)}レース分")
        return True
    else:
        # プレースホルダーが存在しない場合: ALL_DATA 宣言の直前に挿入する
        insert_pattern = r'(?=(?:let|const) ALL_DATA\s*=)'
        if re.search(insert_pattern, html_text):
            html_text = re.sub(insert_pattern, new_block, html_text, count=1)
            _data_js_write(html_text)
            log(f"  ✓ COMMENT_DATA埋め込み完了（ALL_DATA直前に挿入）: {len(comment_all)}レース分")
            return True
        else:
            log("  ⚠ COMMENT_DATAの埋め込み位置が見つかりません（ALL_DATAも見つからず）")
            return False


def _flying_path_today() -> Path:
    """本日分の flying_YYYYMMDD.xlsx のパスを返す。
    フライングデータは他のデータ（tenji/comment/result等）と同じく、
    auto_push.py 自身のフォルダ（SCRIPTS_DIR）ではなく、
    データ収集フォルダ（DATA_COLLECT_DIR）に届く。
    """
    # フライングデータは手動管理ファイルのため、today_str()（深夜補正あり）ではなく
    # 実際の今日の日付を使う
    today = datetime.now().strftime("%Y%m%d")
    return DATA_COLLECT_DIR / f"flying_{today}.xlsx"


def inject_flying_to_html():
    """flying_YYYYMMDD.xlsx を読んで index.html の FLYING_DATA を書き換える"""
    flying_path = _flying_path_today()
    if not flying_path.exists():
        log(f"  ⚠ {flying_path.name} が見つかりません → FLYING_DATA埋め込みスキップ")
        return False

    try:
        df = pd.read_excel(str(flying_path), sheet_name="フライング一覧")
    except Exception as e:
        log(f"  ⚠ フライングExcel読込エラー: {e}")
        return False

    df.columns = [str(c).strip() for c in df.columns]
    required = {"会場", "レース", "枠", "選手名", "フライング", "合計F数"}
    if not required.issubset(set(df.columns)):
        log("  ⚠ フライングExcelの列が不足しています")
        return False

    # {会場: {レースno文字列: [{waku, name, flying, f_total}]}} に変換
    flying_all = {}
    for _, row in df.iterrows():
        venue  = str(row["会場"]).strip()
        race   = str(int(row["レース"])) if pd.notna(row["レース"]) else "0"
        waku   = str(row["枠"]).strip() if pd.notna(row["枠"]) else ""
        name   = str(row["選手名"]).strip() if pd.notna(row["選手名"]) else ""
        flying = str(row["フライング"]).strip() if pd.notna(row["フライング"]) else ""
        f_total = int(row["合計F数"]) if pd.notna(row["合計F数"]) else 1
        flying_all.setdefault(venue, {}).setdefault(race, []).append({
            "waku": waku, "name": name, "flying": flying, "f_total": f_total
        })

    html_text = _data_js_read()
    flying_json = json.dumps(flying_all, ensure_ascii=False, separators=(",", ":"))
    new_block = f"let FLYING_DATA = {flying_json};\n"

    pattern = r'(?:let|const) FLYING_DATA = [\s\S]*?;[^\n]*\n'
    if re.search(pattern, html_text):
        html_text = re.sub(pattern, new_block, html_text)
        _data_js_write(html_text)
        total = sum(len(v) for v in flying_all.values())
        log(f"  ✓ FLYING_DATA埋め込み完了: {len(flying_all)}会場 {total}レース分")
        return True
    else:
        log("  ⚠ FLYING_DATAの埋め込み位置が見つかりません")
        return False


def inject_result_to_html(days_back=RESULT_DAYS):
    """
    result_data/*.json を読んで index.html の RESULT_DATA を書き換える。
    RESULT_DATA = {
        "{venue}_{YYYYMMDD}_{rno}": {
            "sanrentan": [{"combo":"1-2-3","odds":4500}, ...],
            "nirentan":  [...],
            "tansho":    [...],
            "fukusho":   [...],
            "fetched_at": "..."
        }
    }
    """
    from datetime import timedelta
    today = datetime.now().date()
    target_dates = [
        (today - timedelta(days=d)).strftime("%Y%m%d")
        for d in range(0, days_back + 1)
    ]

    RESULT_DIR.mkdir(exist_ok=True)
    result_all = {}

    for fpath in glob.glob(str(RESULT_DIR / "*.json")):
        fname = Path(fpath).name
        if not any(d in fname for d in target_dates):
            continue
        m = re.match(r"result_(.+)_(\d{8})_R(\d+)\.json", fname)
        if not m:
            continue
        venue_slug, date_nd, race_str = m.group(1), m.group(2), str(int(m.group(3)))
        embed_key = f"{venue_slug}_{date_nd}_{race_str}"
        try:
            with open(fpath, encoding="utf-8") as f:
                data = json.load(f)
            result_all[embed_key] = {
                "sanrentan":  data.get("sanrentan", []),
                "nirentan":   data.get("nirentan", []),
                "tansho":     data.get("tansho", []),
                "fukusho":    data.get("fukusho", []),
                "kimari":     data.get("kimari", ""),
                "henkan":     data.get("henkan", []),
                "fetched_at": data.get("fetched_at", ""),
            }
        except Exception:
            continue

    html_text = _data_js_read()
    result_json = json.dumps(result_all, ensure_ascii=False, separators=(",", ":"))
    new_block = f"let RESULT_DATA = {result_json};\n"

    pattern = r'(?:let|const) RESULT_DATA = [\s\S]*?;[^\n]*\n'
    if re.search(pattern, html_text):
        html_text = re.sub(pattern, new_block, html_text)
        _data_js_write(html_text)
        log(f"  ✓ RESULT_DATA埋め込み完了: {len(result_all)}レース分")
        return True
    else:
        log("  ⚠ RESULT_DATAの埋め込み位置が見つかりません")
        return False


# ══════════════════════════════════════════════════════════════════
# フェーズ1: data/ ディレクトリへのJSON書き出し
#   - HTMLは一切変更しない（既存の埋め込みはそのまま継続）
#   - data/*.json を追加で書き出すだけ → 安全に並行稼働可能
#   - フェーズ2以降でHTMLのfetchローダーが参照し始める
# ══════════════════════════════════════════════════════════════════

def write_result_json(days_back=None):
    """
    fetch_result.py が RESULT_DIR に書き込んだ統合済み result_{YYYYMMDD}.json を
    そのまま DATA_DIR へ転送（read→write）する。
    _write_and_push_odds_json() と同じ構造。

    出力フォーマット:
        data/result_20260511.json = {
            "{slug}_{rno}": {
                "sanrentan": [...], "nirentan": [...],
                "tansho": [...], "fukusho": [...],
                "kimari": "逃げ", "henkan": [], "fetched_at": "..."
            }, ...
        }
    """
    if days_back is None:
        days_back = RESULT_DAYS
    from datetime import timedelta
    today = datetime.now().date()

    DATA_DIR.mkdir(exist_ok=True)
    written = 0

    target_dates = [
        (today - timedelta(days=d)).strftime("%Y%m%d")
        for d in range(0, days_back + 1)
    ]
    for date_nd in target_dates:
        src_path = RESULT_DIR / f"result_{date_nd}.json"
        if not src_path.exists() or src_path.stat().st_size == 0:
            continue
        try:
            with open(src_path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        if not isinstance(data, dict) or not data:
            continue
        out_path = DATA_DIR / f"result_{date_nd}.json"
        with open(out_path, 'w', encoding='utf-8') as wf:
            wf.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
        written += 1

    log(f"  [JSON] result_YYYYMMDD.json 書き出し完了: {written}日分")
    return written > 0


def write_history_json(days_back=None):
    """
    過去 days_back 日分のCSVを data/history_YYYYMMDD.json として書き出す。
    フェーズ1: inject_history_to_html() と並行稼働。干渉なし。

    出力フォーマット:
        data/history_20260510.json = {"鳴門": {...vdata...}, "桐生": {...}, ...}
    """
    if days_back is None:
        days_back = HISTORY_DAYS
    from datetime import timedelta
    today = datetime.now().date()

    DATA_DIR.mkdir(exist_ok=True)
    written = 0

    for d in range(1, days_back + 1):
        target = today - timedelta(days=d)
        target_str = target.strftime("%Y-%m-%d")
        date_nd    = target.strftime("%Y%m%d")

        # 既に出力済みのファイルはスキップ（起動時の重複パースを防ぐ）
        out_path = DATA_DIR / f"history_{date_nd}.json"
        if out_path.exists():
            continue

        day_data = {}

        for csv_path in glob.glob(str(CSV_DIR / "*.csv")):
            if target_str not in Path(csv_path).name:
                continue
            data = _cached_parse_csv(csv_path)
            if data and data.get("venue"):
                day_data[data["venue"]] = data

        if day_data:
            out_path = DATA_DIR / f"history_{date_nd}.json"
            with open(out_path, 'w', encoding='utf-8') as _wf:
                _wf.write(json.dumps(day_data, ensure_ascii=False, separators=(",", ":")))
            written += 1
            log(f"  [JSON] history_{date_nd}.json: {', '.join(day_data.keys())}")

    # HISTORY_KEEP_DAYS より古いファイルのみ削除（書き出し対象の days_back とは独立）
    # HISTORY_DAYS=1 でも過去30日分は保持してバックテスト用データを守る
    cutoff = today - timedelta(days=HISTORY_KEEP_DAYS)
    for fpath in glob.glob(str(DATA_DIR / "history_*.json")):
        fname = Path(fpath).name
        m = re.match(r"history_(\d{8})\.json", fname)
        if m:
            try:
                fdate = datetime.strptime(m.group(1), "%Y%m%d").date()
                if fdate < cutoff:
                    Path(fpath).unlink()
                    log(f"  [JSON] 古い history_{m.group(1)}.json を削除")
            except ValueError:
                pass

    log(f"  [JSON] history_YYYYMMDD.json 書き出し完了: {written}日分")
    return written > 0


def write_master_ext_json():
    """
    master_data.json の内容を data/master_ext.json として書き出す。
    フェーズ1: inject_master_ext_to_html() と並行稼働。干渉なし。
    """
    if not MASTER_JSON.exists():
        log("  [JSON] master_data.json なし → master_ext.json スキップ")
        return False

    DATA_DIR.mkdir(exist_ok=True)
    master_ext = {
        "venue_kimari":        MASTER.get("venue_kimari", {}),
        "tenkai_remaining":    MASTER.get("tenkai_remaining", {}),
        "winner_course_order": MASTER.get("winner_course_order", {}),
        "venue_stats":         MASTER.get("venue_stats", {}),
        "course_master":       MASTER.get("course_master", {}),
        "course_master_joshi": MASTER.get("course_master_joshi", {}),  # 女子戦用コースマスタ
        "player_index":        MASTER.get("player_index", {}),
    }
    out_path = DATA_DIR / "master_ext.json"
    with open(out_path, 'w', encoding='utf-8') as _wf:
        _wf.write(json.dumps(master_ext, ensure_ascii=False, separators=(",", ":")))
    log("  [JSON] master_ext.json 書き出し完了")
    return True


def write_player_id_map_json():
    """
    scripts/player_id_map.json（登番→選手名マップ）を data/player_id_map.json にコピーする。
    出走表の「登番」列表示用（loader.js の fetchAndMergeJsonData が data/player_id_map.json を
    fetchして PLAYER_ID_MAP に逆引き格納する）。
    内容はそのままコピーするだけ（読み込み→書き出しでJSON妥当性だけ確認）。
    """
    if not PLAYER_ID_MAP.exists():
        log("  [JSON] player_id_map.json なし → data/player_id_map.json スキップ")
        return False

    DATA_DIR.mkdir(exist_ok=True)
    try:
        with open(PLAYER_ID_MAP, 'r', encoding='utf-8') as _rf:
            id_map = json.load(_rf)
    except Exception as _e:
        log(f"  ⚠ player_id_map.json 読み込み失敗 → スキップ: {_e}")
        return False

    out_path = DATA_DIR / "player_id_map.json"
    with open(out_path, 'w', encoding='utf-8') as _wf:
        _wf.write(json.dumps(id_map, ensure_ascii=False, separators=(",", ":")))
    log("  [JSON] data/player_id_map.json 書き出し完了")
    return True


# ── CSVパースキャッシュ ─────────────────────────────────────────────────────
# write_all_json_files() の呼び出し内で同じCSVを複数回 parse_csv() するのを防ぐ。
# write_all_json_files() の先頭でクリアされる。
_csv_parse_cache: dict = {}

def _cached_parse_csv(filepath: str):
    """parse_csv() の結果をセッション内でキャッシュして返す"""
    if filepath not in _csv_parse_cache:
        _csv_parse_cache[filepath] = parse_csv(filepath)
    return _csv_parse_cache[filepath]


def write_today_json():
    """
    当日CSVを data/today_YYYYMMDD.json として書き出す。
    フェーズ1: inject_all_data_to_html() と並行稼働。干渉なし。

    出力フォーマット:
        data/today_20260512.json = {"鳴門": {...vdata...}, "桐生": {...}, ...}
    """
    today_data = {}
    actual_date_nd = None  # CSVファイル名から取得した実際の日付（YYYYMMDD）
    date_candidates = _race_date_candidates()

    for csv_path in glob.glob(str(CSV_DIR / "*.csv")):
        matched_date = next((d for d in date_candidates if d in Path(csv_path).name), None)
        if not matched_date:
            continue
        data = _cached_parse_csv(csv_path)
        if data and data.get("venue"):
            today_data[data["venue"]] = data
            # CSVファイル名に含まれる日付をそのまま使う（例: 2026-06-13 → 20260613）
            if actual_date_nd is None:
                actual_date_nd = matched_date.replace("-", "")

    if not today_data or actual_date_nd is None:
        log("  [JSON] 当日CSV なし → today_YYYYMMDD.json スキップ")
        return False

    DATA_DIR.mkdir(exist_ok=True)
    out_path = DATA_DIR / f"today_{actual_date_nd}.json"
    with open(out_path, 'w', encoding='utf-8') as _wf:
        _wf.write(json.dumps(today_data, ensure_ascii=False, separators=(",", ":")))
    log(f"  [JSON] today_{actual_date_nd}.json 書き出し完了: {', '.join(today_data.keys())}")
    return True


def write_tenji_json_file(days_back=HISTORY_DAYS):
    """
    データ収集側の tenji_YYYYMMDD.json（既に集約済みフォーマット）を読み込み、
    そのまま BRCsystem/data/tenji_YYYYMMDD.json に書き出す。

    【背景】
    以前は TENJI_DIR 配下に「会場_日付_R番号」ごとの個別ファイル
    （tenji_kiryu_20260617_R01.json）が出力され、それを本関数が集約していた。
    現在はデータ収集側のスクリプトが日付単位で既に集約済みの
    tenji_YYYYMMDD.json を直接出力するようになったため、
    個別ファイルを集約するロジックは不要。読み込んでそのまま書き出すだけでよい。

    【入力フォーマット（= 出力フォーマットと同一）】
        TENJI_DIR/tenji_20260616.json = {
            "ashiya_20260616_1": { "1": {...}, "__weather": ..., ... },
            "ashiya_20260616_2": { ... },
            ...
        }
    """
    from datetime import timedelta
    today = datetime.now().date()
    target_dates = [
        (today - timedelta(days=d)).strftime("%Y%m%d")
        for d in range(0, days_back + 1)
    ]

    DATA_DIR.mkdir(exist_ok=True)
    written = []

    for date_nd in target_dates:
        src_path = TENJI_DIR / f"tenji_{date_nd}.json"
        if not src_path.exists():
            continue
        try:
            with open(src_path, encoding="utf-8") as f:
                tenji_all = json.load(f)
        except Exception as e:
            log(f"  [JSON] {src_path.name} 読み込み失敗: {e}")
            continue

        if not isinstance(tenji_all, dict) or not tenji_all:
            continue

        out_path = DATA_DIR / f"tenji_{date_nd}.json"
        with open(out_path, 'w', encoding='utf-8') as _wf:
            _wf.write(json.dumps(tenji_all, ensure_ascii=False, separators=(",", ":")))
        written.append(f"tenji_{date_nd}.json({len(tenji_all)}R)")

    if not written:
        log("  [JSON] data/ に対象の tenji_YYYYMMDD.json なし → スキップ")
        return False

    log(f"  [JSON] {', '.join(written)} 書き出し完了")
    return True


def write_data_index():
    """
    data/index.json を書き出す。
    存在する result_*.json / history_*.json の日付リストを記録し、
    ブラウザ側が「存在しない日付」に無駄なfetchをしないようにする。

    出力フォーマット:
        {
          "result_dates":  ["20260512", "20260511", ...],  // 新しい順
          "history_dates": ["20260511", "20260510", ...],  // 新しい順
          "updated": "2026-05-12 09:30:00"
        }
    """
    DATA_DIR.mkdir(exist_ok=True)

    result_dates = sorted(
        [re.sub(r"result_(\d{8})\.json", r"\1", Path(p).name)
         for p in glob.glob(str(DATA_DIR / "result_*.json"))
         if re.match(r"result_\d{8}\.json", Path(p).name)],
        reverse=True
    )
    history_dates = sorted(
        [re.sub(r"history_(\d{8})\.json", r"\1", Path(p).name)
         for p in glob.glob(str(DATA_DIR / "history_*.json"))
         if re.match(r"history_\d{8}\.json", Path(p).name)],
        reverse=True
    )

    # today_date: today_YYYYMMDD.json の日付（当日分が存在する場合のみ）
    # today_str() は深夜0〜3時に翌日付を返すため、実際のファイルと日付がズレる場合がある。
    # glob で実在するファイルから日付を取得することでズレを防ぐ。
    today_files = sorted(glob.glob(str(DATA_DIR / "today_*.json")), reverse=True)
    today_date_val = None
    for _tf in today_files:
        _m = re.match(r"today_(\d{8})\.json", Path(_tf).name)
        if _m:
            today_date_val = _m.group(1)
            break

    index = {
        "result_dates":  result_dates,
        "history_dates": history_dates,
        "today_date":    today_date_val,
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    out_path = DATA_DIR / "index.json"
    with open(out_path, 'w', encoding='utf-8') as _wf:
        _wf.write(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    log(f"  [JSON] data/index.json 更新: result={len(result_dates)}日 history={len(history_dates)}日")
    return True


def write_all_json_files():
    """
    フェーズ1: data/*.json を一括書き出しするエントリポイント。
    inject_*_to_html() の各呼び出しの直後に追加するだけで動作する。
    HTMLへの影響はゼロ。

    [最適化] 当日CSVのパース結果を _csv_parse_cache に保存し、
    write_today_json / write_history_json 間で重複 parse_csv() を避ける。
    """
    _csv_parse_cache.clear()  # 古いキャッシュをリセット
    write_today_json()
    write_history_json()
    write_result_json()
    try:
        write_master_ext_json()
    except Exception as _e:
        log(f"  ⚠ write_master_ext_json 失敗（スキップして続行）: {_e}")
    try:
        write_player_id_map_json()
    except Exception as _e:
        log(f"  ⚠ write_player_id_map_json 失敗（スキップして続行）: {_e}")
    write_tenji_json_file()  # data/tenji_YYYYMMDD.json を出力（sample.js の fetch 対象）
    write_data_index()       # 最後にインデックスを更新


def get_data_dir_files():
    """git add 用に data/ 内の全JSONを返す"""
    if not DATA_DIR.exists():
        return []
    return list(DATA_DIR.glob("*.json"))


def fetch_result_for_venues(venues_in_csv: dict[str, str]) -> bool:
    """
    CSV到着済み会場の結果をバックグラウンドで随時取得する。
    メインループとは完全に独立したスレッドで動作するため、
    展示情報・コメントのpushを遅延させない。
    レース確定後でないと払戻が出ないため、既取得レースはスキップ。
    venues_in_csv: {会場名: "YYYY-MM-DD"} の辞書

    Returns
    -------
    True  : 全レースが確定済み（以降の呼び出し不要）
    False : 未確定レースが残っている（引き続き5分ごとに呼ぶ）
    """
    if not FETCH_RESULT_PY.exists():
        log(f"  ⚠ {FETCH_RESULT_PY.name} が見つかりません → 結果取得スキップ")
        return False

    RESULT_DIR.mkdir(exist_ok=True)

    def fetch_one(args):
        slug, date_nd, race = args
        # 取得済みはスキップ（統合済みファイル内のrace_keyで判定）
        merged_path = RESULT_DIR / f"result_{date_nd}.json"
        if merged_path.exists():
            try:
                with open(merged_path, encoding="utf-8") as f:
                    merged = json.load(f)
                race_key = f"{slug}_{int(race)}"
                entry = merged.get(race_key, {})
                if entry.get("sanrentan") or entry.get("cancelled"):
                    return slug, race, "skip"
            except Exception:
                pass
        result = subprocess.run(
            [sys.executable, str(FETCH_RESULT_PY),
             "--venue", slug, "--date", date_nd, "--race", str(race),
             "--out", str(RESULT_DIR)],
            capture_output=True, timeout=60
        )
        return slug, race, "ok" if result.returncode == 0 else "fail"

    tasks = []
    for venue_name, date_raw in venues_in_csv.items():
        slug = VENUE_SLUG.get(venue_name)
        if not slug:
            continue
        date_nd = date_raw.replace("-", "")
        for race in range(1, 13):
            tasks.append((slug, date_nd, race))

    if not tasks:
        return True

    log(f"  結果取得開始: {list(venues_in_csv.keys())} ({len(tasks)}R)")
    fetched = 0
    skipped = 0
    # max_workers=2 に抑えてサーバー負荷・タイムアウトを軽減
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(fetch_one, t): t for t in tasks}
        for f in as_completed(futures):
            try:
                slug, race, status = f.result()
                if status == "ok":
                    fetched += 1
                    log(f"    {slug} {race}R 結果取得✓")
                elif status == "skip":
                    skipped += 1
            except Exception as e:
                log(f"    結果取得エラー: {e}")

    if fetched > 0:
        # フェーズ3: HTMLへの埋め込みを停止 → data/*.json + fetchに完全移行
        # inject_result_to_html()
        write_result_json()    # data/result_YYYYMMDD.json を更新
        write_data_index()     # インデックスも更新
        # commit+pushはキューに委譲（他系統のpushと重ならないように）
        with _git_lock:
            run(["git", "add", str(INDEX_HTML)])
            code, out = _run_nolock(["git", "status", "--porcelain"])
            tracked = [l for l in out.strip().splitlines() if not l.startswith("??")]
            if tracked:
                msg = f"result update {datetime.now().strftime('%Y-%m-%d %H:%M')}"
                _push_queue.put((PUSH_URGENT, next(_push_seq), "raw", None, msg))
                log(f"  結果取得完了: {fetched}レース → pushキューに追加")
            else:
                log(f"  結果取得完了: {fetched}レース → 変更なし（スキップ）")

    # 全タスクがスキップ（=全レース確定済み）なら True を返して以降の呼び出しを止める
    all_done = (skipped == len(tasks))
    if all_done:
        log("  ✅ 全レース結果確定済み → 結果取得ループ終了")
    return all_done


def inject_history_to_html(days_back=HISTORY_DAYS):
    """
    過去 days_back 日分のCSVを読んで index.html の ALL_DATA_HISTORY を書き換える。
    ALL_DATA_HISTORY = {"2026-05-04": {"鳴門": {...}, ...}, "2026-05-03": {...}}
    """
    from datetime import timedelta
    today = datetime.now().date()
    history = {}

    for d in range(1, days_back + 1):
        target = today - timedelta(days=d)
        target_str = target.strftime("%Y-%m-%d")  # YYYY-MM-DD
        all_data_day = {v: None for v in VENUE_LIST}
        loaded = []

        for csv_path in glob.glob(str(CSV_DIR / "*.csv")):
            fname = Path(csv_path).name
            if target_str not in fname:
                continue
            data = parse_csv(csv_path)
            if data and data.get("venue") in all_data_day:
                all_data_day[data["venue"]] = data
                loaded.append(data["venue"])

        if loaded:
            history[target_str] = all_data_day
            log(f"  history {target_str}: {', '.join(loaded)}")

    html_text = _data_js_read()
    history_json = json.dumps(history, ensure_ascii=False, separators=(",", ":"))
    new_block = f"let ALL_DATA_HISTORY = {history_json};\n"

    pattern = r'(?:let|const) ALL_DATA_HISTORY = [\s\S]*?;[^\n]*\n'
    if re.search(pattern, html_text):
        html_text = re.sub(pattern, new_block, html_text)
        _data_js_write(html_text)
        # [fix] data.js 書き換え後は index.html の v= も必ず更新する。
        # しないとブラウザが古い data.js をキャッシュし続け日付が切り替わらない。
        update_cache_version()
        log(f"  ✓ ALL_DATA_HISTORY埋め込み完了: {len(history)}日分")
        return True
    else:
        log("  ⚠ ALL_DATA_HISTORYの埋め込み位置が見つかりません")
        return False


def fetch_and_inject_race_index():
    """
    公式サイトから本日の開催グレード・タイトル情報を取得し、
    index.html の RACE_INDEX_DATA を書き換える。
    fetch_race_index.py を別プロセスで実行して race_index.json を生成し、
    その内容を HTML に埋め込む。
    """
    # fetch_race_index.py で race_index.json を生成
    if FETCH_RACE_INDEX_PY.exists():
        log("  公式サイトから開催グレード情報を取得中...")
        try:
            result = subprocess.run(
                [sys.executable, str(FETCH_RACE_INDEX_PY)],
                capture_output=True, timeout=120
                # text/encoding を指定しない → bytes で受け取りデコードエラーを回避
            )
            if result.returncode != 0:
                err = (result.stderr or b"").decode("utf-8", errors="replace")[:200]
                log(f"  ⚠ race_index 取得失敗: {err}")
            else:
                log("  ✓ race_index.json 生成完了")
        except Exception as e:
            log(f"  ⚠ race_index 取得中に例外: {e}")
    else:
        log(f"  ⚠ {FETCH_RACE_INDEX_PY.name} が見つかりません → スキップ")

    # race_index_{YYYYMMDD}.json を読んで HTML に埋め込む
    race_index_path = get_race_index_path()  # 当日分
    if not race_index_path.exists():
        log("  ⚠ race_index.json が見つかりません → RACE_INDEX_DATA埋め込みスキップ")
        return False

    try:
        with open(race_index_path, encoding="utf-8") as f:
            race_index = json.load(f)
    except Exception as e:
        log(f"  ⚠ race_index.json 読込エラー: {e}")
        return False

    html_text = _data_js_read()
    race_index_json = json.dumps(race_index, ensure_ascii=False, separators=(",", ":"))
    new_block = f"let RACE_INDEX_DATA = {race_index_json};\n"

    pattern = r'(?:let|const) RACE_INDEX_DATA = [^\n]*\n'
    if re.search(pattern, html_text):
        html_text = re.sub(pattern, new_block, html_text)
        _data_js_write(html_text)
        log(f"  ✓ RACE_INDEX_DATA埋め込み完了: {len(race_index.get('venues', {}))}会場")
        return True
    else:
        log("  ⚠ RACE_INDEX_DATAの埋め込み位置が見つかりません")
        return False


def inject_odds_to_html() -> bool:
    """
    odds_data/*.json を読み込んで index.html の ODDS_DATA を書き換える。

    index.html 内に以下のプレースホルダーが必要（RESULT_DATA の直前推奨）:
        /* __ODDS_DATA__ */
        const ODDS_DATA = {};

    埋め込み後の形式:
        const ODDS_DATA = {
          "常滑": {
            "6": {
              "3t":  {"1-2-3": 12.5, ...},
              "3f":  {...},
              "2t":  {...},
              "2f":  {...},
              "tan": {...}
            }
          }
        };
    """
    ODDS_DIR.mkdir(exist_ok=True)

    # odds_data/ から全JSONを読み込んで { 会場名: { レースno: {種別: {combo: odds} } } } に集約
    all_odds: dict = {}
    slug_venue = {v: k for k, v in VENUE_SLUG.items()}  # スラッグ→会場名の逆引き

    for fpath in sorted(ODDS_DIR.glob("odds_*.json")):
        # ファイル名: odds_{slug}_{YYYYMMDD}_R{XX}.json
        m = re.match(r"odds_([a-z]+)_(\d{8})_R(\d{2})\.json$", fpath.name)
        if not m:
            continue
        slug, _date_nd, rno_str = m.group(1), m.group(2), str(int(m.group(3)))
        venue = slug_venue.get(slug, slug)
        # 日付キー: YYYYMMDD → YYYY-MM-DD
        date_key = f"{_date_nd[:4]}-{_date_nd[4:6]}-{_date_nd[6:]}"

        try:
            # 空ファイル（書き込み途中で落ちた残骸）はスキップして削除
            if fpath.stat().st_size == 0:
                log(f"  ⚠ 空ファイルを削除: {fpath.name}")
                fpath.unlink(missing_ok=True)
                continue
            with open(fpath, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            log(f"  ⚠ オッズJSON読み込み失敗 {fpath.name}: {e}")
            continue

        # fetched_at はHTMLサイズ削減のため除外。final フラグはそのまま残す
        race_data = {k: v for k, v in data.items() if k != "fetched_at"}
        # 構造: {日付: {会場: {レースno: {...}}}} で過去日も正しく参照できるようにする
        all_odds.setdefault(date_key, {}).setdefault(venue, {})[rno_str] = race_data

    html_text = _data_js_read()
    odds_json  = json.dumps(all_odds, ensure_ascii=False, separators=(",", ":"))
    new_block  = f"const ODDS_DATA = {odds_json};"

    if "const ODDS_DATA" in html_text:
        # 既存の宣言をまるごと置換（ネストしたJSONに対応するため括弧の深さで終端を検出）
        start = html_text.index("const ODDS_DATA")
        brace_start = html_text.index("{", start)
        depth = 0
        i = brace_start
        while i < len(html_text):
            if html_text[i] == "{":
                depth += 1
            elif html_text[i] == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1  # "}" の次
                    if html_text[end:end+1] == ";":
                        end += 1  # ";" も含める
                    break
            i += 1
        html_text = html_text[:start] + new_block + html_text[end:]
    elif "/* __ODDS_DATA__ */" in html_text:
        html_text = html_text.replace(
            "/* __ODDS_DATA__ */",
            f"/* __ODDS_DATA__ */\n{new_block}",
        )
    else:
        log("  ⚠ ODDS_DATA のプレースホルダーが index.html に見つかりません")
        log("    index.html に以下を追加してください（RESULT_DATA の直前推奨）:")
        log("      /* __ODDS_DATA__ */")
        log("      const ODDS_DATA = {};")
        return False

    _data_js_write(html_text)
    total_races = sum(len(races) for venues in all_odds.values() for races in venues.values())
    log(f"  ✓ ODDS_DATA埋め込み完了: {len(all_odds)}日分 / {total_races}レース分")
    return True



def _build_deadline_map(venues_in_csv: dict) -> dict:
    """
    締め切り時刻マップ {venue名: {rno: "HH:MM"}} を構築して返す。

    取得優先順:
      1. 当日CSV の「締切時刻」列（最速・オフライン）
      2. boatrace.jp 公式サイト（CSVに列がない・空の場合のフォールバック）

    fetch_all_races() が期待する形式:
      {"常滑": {1: "10:00", 2: "10:30", ...}, "びわこ": {...}, ...}
    """
    deadline_map: dict = {}

    # ── Step1: CSVから読み込み ───────────────────────────────────────────────
    for csv_path in get_today_csvs():
        try:
            try:
                df = pd.read_csv(csv_path, encoding="utf-8")
            except UnicodeDecodeError:
                df = pd.read_csv(csv_path, encoding="shift_jis")

            if "会場" not in df.columns or "締切時刻" not in df.columns:
                continue

            venue = str(df.iloc[0]["会場"]).strip()
            if venue not in venues_in_csv:
                continue

            venue_map: dict = {}
            for _, row in df.iterrows():
                rno_raw = row.get("レース", "")
                dl_raw  = str(row.get("締切時刻", "")).strip()
                if not str(rno_raw).isdigit() or not dl_raw or dl_raw in ("nan", ""):
                    continue
                rno = int(rno_raw)
                if rno not in venue_map:
                    # "HH:MM" 形式に正規化（"15:20:00" → "15:20" なども対応）
                    venue_map[rno] = dl_raw[:5] if len(dl_raw) >= 5 else dl_raw

            if venue_map:
                deadline_map[venue] = venue_map

        except Exception:
            continue

    # CSVで全会場取得できていれば終了
    csv_venues = set(deadline_map.keys())
    missing_venues = [v for v in venues_in_csv if v not in csv_venues]
    if not missing_venues:
        log(f"  締め切り時刻マップ(CSV): {sum(len(v) for v in deadline_map.values())}レース分")
        return deadline_map

    # ── Step2: 公式サイトからフォールバック取得 ──────────────────────────────
    log(f"  CSVに締切時刻なし: {missing_venues} → boatrace.jp から取得中...")
    try:
        from fetch_deadlines import fetch_deadlines_official, VENUE_JCD as DL_VENUE_JCD
    except ImportError:
        log("  ⚠ fetch_deadlines.py が見つかりません → 締切時刻なしで続行")
        return deadline_map

    date_str = list(venues_in_csv.values())[0] if venues_in_csv else None

    for venue in missing_venues:
        if not date_str:
            continue
        # fetch_deadlines_officialはslugを受け取る
        slug = VENUE_SLUG.get(venue)
        if not slug:
            continue
        try:
            dl = fetch_deadlines_official(slug, date_str)
            if dl:
                deadline_map[venue] = dl   # {rno(int): "HH:MM"}
                log(f"  ✓ {venue}: {len(dl)}R分の締切時刻を公式から取得")
            else:
                log(f"  ⚠ {venue}: 公式サイトからも締切時刻取得失敗")
        except Exception as e:
            log(f"  ⚠ {venue}: 公式取得エラー: {e}")

    total = sum(len(v) for v in deadline_map.values())
    log(f"  締め切り時刻マップ確定: {len(deadline_map)}会場 / {total}レース分")
    return deadline_map


def fetch_odds_for_venues(venues_in_csv: dict) -> bool:
    """
    当日CSVに存在する会場のオッズを「1巡」取得して odds_data/ に保存する。

    fetch_odds.py の fetch_all_races() を呼び出す薄いラッパー。
    ループ制御は呼び出し元（_odds_loop_worker）が行う。
    失敗しても例外を外に投げず False を返す（メインループを止めない）。

    Returns
    -------
    True: 取得成功（アクティブレースの有無に関わらず）
    False: インポートエラー or 例外
    """
    try:
        from fetch_odds import fetch_all_races
    except ImportError:
        log("  ⚠ fetch_odds.py が見つかりません → オッズ取得スキップ")
        return False

    # CSVと公式サイトから締め切り時刻マップを構築
    deadline_map = _build_deadline_map(venues_in_csv)
    if not deadline_map:
        log("  ⚠ 締め切り時刻マップ取得不可 → レース番号順で取得")

    try:
        log(f"  オッズ取得開始（締め切り近い順）: {list(venues_in_csv.keys())}")
        saved, _wait, _has_active = fetch_all_races(
            venues_in_csv, verbose=True, deadline_map=deadline_map
        )
        log(f"  ✓ オッズ1巡完了: {len(saved)}ファイル保存")
        return True
    except Exception as e:
        log(f"  ✕ オッズ取得エラー: {e}")
        return False


# ── オッズ永続ループワーカー ───────────────────────────────────────────────────
# このスレッドが fetch_all_races() を繰り返し呼び出す。
# スレッドが例外で死んでもメインループが検知して再起動する。
import threading as _threading

# data.js への書き込みを排他制御するロック
# 複数スレッドが同時に write_text() を呼ぶと Windows で OSError(22) が発生するため
_data_js_lock = _threading.Lock()

# ── git操作を排他制御するロック ───────────────────────────────────────────────
# 複数スレッド（メインループ・バックグラウンド買い目計算・オッズループ・結果取得）が
# 同時に git add/commit/push を実行すると index.lock の競合 (WinError 32) が発生する。
# すべての git 操作をこのロックで直列化して競合を防ぐ。
_git_lock = _threading.Lock()

# ── pushキュー: 全系統のpushをここに集約して直列処理 ──────────────────────────
# GitHub Pagesは短時間に複数pushが来ると前のデプロイをCancelledにする。
# 全pushをこのキューに入れ、専用ワーカーが順番に処理することで
# Cancelledを防ぐ。
#
# 【優先度付きキュー】
#   priority=0 (PUSH_URGENT): 展示・結果など即時性重視 → デプロイ待ちをスキップ
#   priority=1 (PUSH_NORMAL): CSV・起動時など通常push → 従来通り130秒待機
#
# キューのアイテム形式（タプル）:
#   (priority, seq, kind, files, commit_msg)
#     priority : 0=緊急 / 1=通常
#     seq      : 同優先度内のFIFO順序を保証するための連番
#     kind     : "files"（addしてからcommit+push）/ "raw"（add済み・commit+pushのみ）
#     files    : [Path, ...] or None
#     commit_msg: str
#
import itertools as _itertools
PUSH_URGENT = 0   # 展示・結果: デプロイ待ちスキップ
PUSH_NORMAL = 1   # CSV・起動時など: 従来通り130秒待機
_push_queue: queue.PriorityQueue = queue.PriorityQueue()
_push_seq = _itertools.count()   # 同優先度内のFIFO順を保証するタイブレーカー
_DEPLOY_WAIT_SEC = 130  # GitHub Pagesデプロイ完了までの待機秒数（約2分）

def _push_queue_worker():
    """
    pushキューを優先度順に処理する専用スレッド。

    priority=0（緊急）: デプロイ待ちをスキップして即座にpushする。
      → 展示・結果など数秒単位の即時性が必要なデータに使用。
      → GitHub Pages Cancelledのリスクはあるが、情報鮮度を優先する。

    priority=1（通常）: 前のpushから _DEPLOY_WAIT_SEC 秒待ってから実行する。
      → CSV・起動時pushなどデプロイ安定性を優先するデータに使用。
    """
    last_push_time = 0.0
    while True:
        try:
            item = _push_queue.get(timeout=5)
        except queue.Empty:
            continue

        if item is None:  # 終了シグナル
            break

        priority, _seq, kind, files, msg = item

        # 通常push(priority=1)のみデプロイ待ちを適用。緊急push(priority=0)はスキップ。
        if priority >= PUSH_NORMAL:
            elapsed = time.time() - last_push_time
            if elapsed < _DEPLOY_WAIT_SEC and last_push_time > 0:
                wait = _DEPLOY_WAIT_SEC - elapsed
                log(f"  [PushQueue] ⏳ デプロイ完了待ち {wait:.0f}秒...")
                time.sleep(wait)
        else:
            log(f"  [PushQueue] ⚡ 緊急push → デプロイ待ちスキップ ({msg})")

        try:
            # ── Step A: add & commit（_git_lock 内で短時間で完了）──────────
            with _git_lock:
                if kind == "files" and files:
                    for f in files:
                        _run_nolock(["git", "add", str(f)])

                code, out = _run_nolock(["git", "status", "--porcelain"])
                tracked = [l for l in out.strip().splitlines() if not l.startswith("??")]
                if not tracked:
                    log(f"  [PushQueue] 差分なし → スキップ ({msg})")
                    _push_queue.task_done()
                    continue

                _run_nolock(["git", "commit", "-m", msg])

                # ブランチを確定（main → master フォールバック）
                branch = "main"
                code, push_out = _run_nolock(["git", "push", "origin", branch])
                if code != 0:
                    code2, _ = _run_nolock(["git", "push", "origin", "master"])
                    if code2 == 0:
                        branch = "master"
                        code = 0

            # ── Step B: push失敗時のリトライ（_git_lock の外で実行）────────
            # _git_lock を保持したままsleepすると他スレッドが全停止するため外に出す。
            # このリポジトリは基本このスクリプト（＋手動pushスクリプト）のみが push する
            # 一人運用のため、pull/rebaseは行わず fetch + force-with-lease で確実に追従させる。
            # （pull --rebaseは他スレッドの同時ファイル書き込みでunstaged changes/コンフリクトを
            #   起こしやすく、エラーが連鎖していた）
            MAX_RETRY = 3
            for attempt in range(1, MAX_RETRY + 1):
                if code == 0:
                    break
                log(f"  [PushQueue] ⚠ push失敗（{attempt}回目）→ fetch して force-with-lease で再push...")
                time.sleep(3)

                with _git_lock:
                    # 残存rebaseがあれば中断・削除（過去のpull --rebase運用の残骸対策）
                    rebase_merge_dir = Path(SCRIPTS_DIR) / ".git" / "rebase-merge"
                    rebase_apply_dir = Path(SCRIPTS_DIR) / ".git" / "rebase-apply"
                    if rebase_merge_dir.exists() or rebase_apply_dir.exists():
                        log(f"  [PushQueue] 残存rebaseを検出 → abort...")
                        _run_nolock(["git", "rebase", "--abort"])
                        import shutil as _shutil2
                        if rebase_merge_dir.exists():
                            _shutil2.rmtree(str(rebase_merge_dir), ignore_errors=True)
                        if rebase_apply_dir.exists():
                            _shutil2.rmtree(str(rebase_apply_dir), ignore_errors=True)

                    # リモートの最新を取得（作業ツリーには触れない）
                    _run_nolock(["git", "fetch", "origin", branch])

                    # force-with-lease: 自分がfetchした時点のorigin/branchから動いていなければ上書きpush。
                    # 万一その間に別経路(手動pushスクリプト等)が割り込んでいた場合は失敗するので
                    # その時はリトライで再fetchしてやり直す（安全）。
                    code, push_out = _run_nolock(
                        ["git", "push", "--force-with-lease", "origin", branch]
                    )
                    if code != 0:
                        log(f"  [PushQueue] ✕ force-with-lease push失敗（{attempt}回目）: {push_out.strip()[:200]}")

            if code == 0:
                last_push_time = time.time()
                log(f"  [PushQueue] ✓ push完了: {msg}")
            else:
                log(f"  [PushQueue] ✕✕✕ push失敗（リトライ上限到達）: {msg}")
                log(f"  [PushQueue] ⚠️ 認証切れ・SSH疎通不可等の可能性 → 手元PCでの確認が必要です")

        except Exception as e:
            log(f"  [PushQueue] ✕ 例外: {e}")

        _push_queue.task_done()
# ワーカースレッドを起動
_push_queue_thread = _threading.Thread(target=_push_queue_worker, daemon=True)
_push_queue_thread.start()


# ── 展示情報 専用pushキュー ──────────────────────────────────────────
# ★ [2026-07-10 追加] 展示情報は「締切直前でも確実にリアルタイム反映したい」
#   最優先データだが、従来は結果・オッズ・フライング等と同じ _push_queue を
#   共有していたため、他系統のpush（特にpush失敗時のfetch+force-with-lease
#   リトライ：sleep(3)＋git通信を最大3回）が詰まると、その後ろに並んだ展示
#   pushまで巻き添えで数十秒〜数分待たされることがあった。
#   → 展示情報だけ別キュー・別スレッドに分離し、他系統のpush処理状況に
#     一切左右されずに即push・即リトライできるようにする。
#   → git自体はリポジトリが1つなので index.lock 競合を避けるため、
#     add/commit/pushの実行自体は引き続き共通の _git_lock で直列化するが、
#     「順番待ち」は展示専用キュー内の展示pushどうしだけになる。
#   → デプロイ待ち（_DEPLOY_WAIT_SEC）は元々展示pushには適用していなかった
#     ため、この専用キューでも常にスキップ（待機なし）で処理する。
_tenji_push_queue: queue.Queue = queue.Queue()

def _enqueue_tenji_push(msg: str) -> None:
    """展示情報の変更を専用pushキューに追加する（他系統pushと競合しない）。"""
    _tenji_push_queue.put((next(_push_seq), "raw", None, msg))


def _tenji_push_queue_worker():
    """
    展示情報専用のpushキューを処理する専用スレッド。
    デプロイ待ちは行わず、常に即push（_push_queue_worker の priority=0 相当）。
    """
    while True:
        try:
            item = _tenji_push_queue.get(timeout=5)
        except queue.Empty:
            continue

        if item is None:  # 終了シグナル
            break

        _seq, kind, files, msg = item
        log(f"  [TenjiPushQueue] ⚡ 展示情報push開始 ({msg})")

        try:
            with _git_lock:
                if kind == "files" and files:
                    for f in files:
                        _run_nolock(["git", "add", str(f)])

                code, out = _run_nolock(["git", "status", "--porcelain"])
                tracked = [l for l in out.strip().splitlines() if not l.startswith("??")]
                if not tracked:
                    log(f"  [TenjiPushQueue] 差分なし → スキップ ({msg})")
                    _tenji_push_queue.task_done()
                    continue

                _run_nolock(["git", "commit", "-m", msg])

                branch = "main"
                code, push_out = _run_nolock(["git", "push", "origin", branch])
                if code != 0:
                    code2, _ = _run_nolock(["git", "push", "origin", "master"])
                    if code2 == 0:
                        branch = "master"
                        code = 0

            MAX_RETRY = 3
            for attempt in range(1, MAX_RETRY + 1):
                if code == 0:
                    break
                log(f"  [TenjiPushQueue] ⚠ push失敗（{attempt}回目）→ fetch して force-with-lease で再push...")
                time.sleep(3)

                with _git_lock:
                    rebase_merge_dir = Path(SCRIPTS_DIR) / ".git" / "rebase-merge"
                    rebase_apply_dir = Path(SCRIPTS_DIR) / ".git" / "rebase-apply"
                    if rebase_merge_dir.exists() or rebase_apply_dir.exists():
                        log(f"  [TenjiPushQueue] 残存rebaseを検出 → abort...")
                        _run_nolock(["git", "rebase", "--abort"])
                        import shutil as _shutil3
                        if rebase_merge_dir.exists():
                            _shutil3.rmtree(str(rebase_merge_dir), ignore_errors=True)
                        if rebase_apply_dir.exists():
                            _shutil3.rmtree(str(rebase_apply_dir), ignore_errors=True)

                    _run_nolock(["git", "fetch", "origin", branch])
                    code, push_out = _run_nolock(
                        ["git", "push", "--force-with-lease", "origin", branch]
                    )
                    if code != 0:
                        log(f"  [TenjiPushQueue] ✕ force-with-lease push失敗（{attempt}回目）: {push_out.strip()[:200]}")

            if code == 0:
                log(f"  [TenjiPushQueue] ✓ push完了: {msg}")
            else:
                log(f"  [TenjiPushQueue] ✕✕✕ push失敗（リトライ上限到達）: {msg}")
                log(f"  [TenjiPushQueue] ⚠️ 認証切れ・SSH疎通不可等の可能性 → 手元PCでの確認が必要です")

        except Exception as e:
            log(f"  [TenjiPushQueue] ✕ 例外: {e}")

        _tenji_push_queue.task_done()

# 展示専用ワーカースレッドを起動
_tenji_push_queue_thread = _threading.Thread(target=_tenji_push_queue_worker, daemon=True)
_tenji_push_queue_thread.start()



# data.js に必要なプレースホルダー宣言一覧
_DATA_JS_REQUIRED_VARS = [
    ("let",   "ALL_DATA",         "{}"),
    ("let",   "ALL_DATA_HISTORY", "{}"),
    ("let",   "TENJI_DATA",       "{}"),
    ("let",   "COMMENT_DATA",     "{}"),
    ("let",   "FLYING_DATA",      "{}"),
    ("let",   "MASTER_EXT",       "null"),
    ("let",   "RESULT_DATA",      "{}"),
    ("let",   "RACE_INDEX_DATA",  "{}"),
    ("const", "ODDS_DATA",        "{}"),
]

def _data_js_ensure_placeholders() -> None:
    """
    data.js を読み込み、必要な変数宣言が欠けていれば補完して書き直す。
    強制終了・初期化後に宣言が消えた場合の自動修復。
    data.js が存在しない場合は空の状態から新規作成する。
    """
    if not DATA_JS.exists():
        # 新規作成: 全プレースホルダーを書き出す
        init_text = ""
        for kw, varname, default in _DATA_JS_REQUIRED_VARS:
            init_text += f"{kw} {varname} = {default};\n"
        try:
            with open(DATA_JS, 'w', encoding='utf-8') as _wf:
                _wf.write(init_text)
            log(f"  [data.js] 新規作成: {DATA_JS.name}")
        except Exception as e:
            log(f"  [data.js] 新規作成失敗: {e}")
        return
    try:
        text = DATA_JS.read_text(encoding="utf-8")
    except Exception:
        return
    added = []
    for kw, varname, default in _DATA_JS_REQUIRED_VARS:
        if re.search(r'(?:let|const)\s+' + re.escape(varname) + r'\s*=', text):
            continue
        text = f"{kw} {varname} = {default};\n" + text
        added.append(varname)
    if added:
        try:
            with open(DATA_JS, 'w', encoding='utf-8') as _wf:
                _wf.write(text)
            log(f"  [data.js] 欠損宣言を補完: {', '.join(added)}")
        except Exception as e:
            log(f"  [data.js] 補完書き込み失敗: {e}")

def _data_js_read() -> str:
    """ロックを取得してから data.js を読み込む"""
    with _data_js_lock:
        # DATA_JS が存在すればそちらを、なければ INDEX_HTML にフォールバック
        target = DATA_JS if DATA_JS.exists() else INDEX_HTML
        return target.read_text(encoding="utf-8")


def _data_js_write(text: str) -> None:
    """ロックを取得してから data.js に書き込む（アトミック書き込みで中途半端な状態を防ぐ）"""
    with _data_js_lock:
        target = DATA_JS if DATA_JS.exists() else INDEX_HTML
        # Windows の OSError: [Errno 22] 対策:
        # NUL文字(\x00)および他のWindows不正制御文字を除去する
        # （改行\x0a・タブ\x09・CR\x0dは正常なので残す）
        cleaned = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
        # アトミック書き込み: 一時ファイルに書いてから os.replace で一瞬で置き換える
        # → 書き込み中にブラウザがアクセスしても中途半端なファイルを読まれない
        import tempfile
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile('w', encoding='utf-8', delete=False,
                                            dir=str(target.parent), suffix='.tmp') as tf:
                tf.write(cleaned)
                tmp_path = tf.name
            os.replace(tmp_path, str(target))
        except OSError as e:
            log(f"  [data.js] ✕ 書き込み失敗: {e}")
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass


def _check_missing_tenji_and_odds(venues: dict, deadline_map: dict) -> None:
    """
    全レース終了後に展示情報・オッズが取得できていないレースをチェックしてログ出力し、
    最新データを index.html に埋め込んで最終 git push する。

    venues: {会場名: 日付文字列}
    deadline_map: {会場名: {rno(int or str): "HH:MM"}}
    """
    log("  [終了チェック] 展示情報・オッズ 取得状況を確認中...")
    any_missing = False

    for venue, date_str in venues.items():
        slug    = VENUE_SLUG.get(venue, venue)
        date_nd = date_str.replace("-", "")
        race_nos = sorted(deadline_map.get(venue, {}).keys(), key=lambda x: int(x))

        if not race_nos:
            continue

        missing_tenji = []
        missing_odds  = []

        for rno in race_nos:
            rno_int = int(rno)   # int/str どちらでも対応

            # 展示チェック: tenji_{slug}_{date_nd}_R{N}.json  (ゼロ埋めなし)
            tenji_path = TENJI_DIR / f"tenji_{slug}_{date_nd}_R{rno_int}.json"
            if not tenji_path.exists():
                missing_tenji.append(rno_int)

            # オッズチェック: odds_{slug}_{date_nd}_R{NN}.json (2桁ゼロ埋め)
            odds_path = ODDS_DIR / f"odds_{slug}_{date_nd}_R{rno_int:02d}.json"
            if not odds_path.exists():
                missing_odds.append(rno_int)

        if missing_tenji:
            log(f"  [終了チェック] ⚠ {venue}: 展示情報なし → R{', R'.join(str(r) for r in missing_tenji)}")
            any_missing = True
        if missing_odds:
            log(f"  [終了チェック] ⚠ {venue}: オッズなし    → R{', R'.join(str(r) for r in missing_odds)}")
            any_missing = True

        if not missing_tenji and not missing_odds:
            log(f"  [終了チェック] ✅ {venue}: 展示・オッズ すべて取得済み ({len(race_nos)}R)")

    if not any_missing:
        log("  [終了チェック] ✅ 全会場・全レース 展示情報・オッズ 取得完了")
    else:
        log("  [終了チェック] ⚠ 上記の未取得レースがありました（手動確認推奨）")

    # ── 最終push: data/*.json を書き出してpush ──
    log("  [終了チェック] 最終データ書き出し＋push 開始...")
    try:
        write_all_json_files()
        pushed = git_push([INDEX_HTML], urgent=True)
        if pushed:
            log("  [終了チェック] ✅ 最終push完了 → アプリに反映されました")
        else:
            log("  [終了チェック] 変更なし・pushスキップ（すでに最新）")
    except Exception as e:
        log(f"  [終了チェック] ✕ 最終push失敗: {e}")

    log("  [終了チェック] 完了 → auto_push.py は監視を継続します（Ctrl+C で終了）")

def _write_and_push_odds_json() -> bool:
    """
    オッズ取得直後に呼ぶ軽量push。
    data/odds_YYYYMMDD.json を更新してそのファイルだけgit push する。
    data.js（巨大）は触らないため push が高速に完了する。

    【背景】
    以前は ODDS_DIR 配下に「会場slug_日付_R番号」ごとの個別ファイル
    （odds_kiryu_20260617_R01.json）が出力され、それを本関数が集約していた。
    現在はデータ収集側のスクリプトが日付単位で既に集約済みの
    odds_YYYYMMDD.json を直接出力するようになったため、
    個別ファイルを集約するロジックは不要。読み込んでそのまま書き出すだけでよい。

    【入力フォーマット（= 出力フォーマットと同一）】
        ODDS_DIR/odds_20260616.json = {
            "芦屋": { "8": {"3t": {...}, "2f": {...}, "tan": {...}, "final": true}, "9": {...} },
            "江戸川": { ... },
            ...
        }
    """
    from datetime import timedelta

    DATA_DIR.mkdir(exist_ok=True)

    today = datetime.now().date()
    target_dates = [
        (today - timedelta(days=d)).strftime("%Y%m%d")
        for d in range(0, HISTORY_DAYS + 1)
    ]

    written_paths = []
    total_races = 0
    for date_nd in target_dates:
        src_path = ODDS_DIR / f"odds_{date_nd}.json"
        if not src_path.exists() or src_path.stat().st_size == 0:
            continue
        try:
            with open(src_path, encoding="utf-8") as f:
                venues_data = json.load(f)
        except Exception:
            continue

        if not isinstance(venues_data, dict) or not venues_data:
            continue

        out_path = DATA_DIR / f"odds_{date_nd}.json"
        with open(out_path, 'w', encoding='utf-8') as _wf:
            _wf.write(json.dumps(venues_data, ensure_ascii=False, separators=(",", ":")))
        written_paths.append(out_path)
        total_races += sum(len(races) for races in venues_data.values())

    if not written_paths:
        return False

    with _git_lock:
        for p in written_paths:
            _run_nolock(["git", "add", str(p)])
        code, out = _run_nolock(["git", "status", "--porcelain"])
        tracked = [l for l in out.strip().splitlines() if not l.startswith("??")]
        if not tracked:
            return False
        msg = f"odds json {datetime.now().strftime('%Y-%m-%d %H:%M')} ({total_races}R)"
        _push_queue.put((PUSH_URGENT, next(_push_seq), "raw", None, msg))
    log(f"  [OddsJSON] ✓ 軽量pushキューに追加: {[p.name for p in written_paths]}")
    return True

def inject_race_entry_to_viewer(csv_paths: list) -> bool:
    """
    出走表CSV到着時に「展開別残存ビューア.html」の会場名・選手名を書き換える。

    HTMLに以下のマーカーが埋め込まれていること:
      let raceVenue = venues[0]; // [AUTO_VENUE]
      // [AUTO_PLAYERS_START]
      const PLAYER_NAMES = {...};
      // [AUTO_PLAYERS_END]

    Returns: 書き換えが発生した場合 True
    """
    if not VIEWER_HTML.exists():
        log(f"  [viewer] {VIEWER_HTML.name} が見つかりません → スキップ")
        return False

    # 対象CSVから会場名・選手名を抽出
    venue = None
    players: dict[int, str] = {}

    for csv_path in csv_paths:
        try:
            try:
                df = pd.read_csv(csv_path, encoding="utf-8")
            except UnicodeDecodeError:
                df = pd.read_csv(csv_path, encoding="shift_jis")
        except Exception:
            continue

        if "会場" not in df.columns:
            continue

        _venue = str(df.iloc[0]["会場"]).strip()

        # 選手名列を検出（「選手名」列が必須）
        if "選手名" not in df.columns or "艇番" not in df.columns:
            log(f"  [viewer] {Path(csv_path).name}: 選手名/艇番列なし → スキップ")
            continue

        _players: dict[int, str] = {}
        for _, row in df.iterrows():
            try:
                waku = int(row["艇番"])
                raw  = str(row["選手名"]).strip()
                # 末尾の登録番号（数字）を除去して名前だけ残す
                name = re.sub(r'\d+$', '', raw).strip()
                if 1 <= waku <= 6 and name and name != "nan":
                    _players[waku] = name
            except (ValueError, TypeError):
                continue

        if _venue and _players:
            venue   = _venue
            players = _players
            break  # 最初の有効CSVで確定

    if not venue or not players:
        log("  [viewer] 有効な会場・選手情報が取得できませんでした → スキップ")
        return False

    html = VIEWER_HTML.read_text(encoding="utf-8")
    original = html

    # ── 1. 会場名を書き換え ──────────────────────────────────────────
    venue_js = venue.replace("'", "\\'")
    html = re.sub(
        r"let raceVenue = .*?; // \[AUTO_VENUE\]",
        f"let raceVenue = '{venue_js}'; // [AUTO_VENUE]",
        html,
    )

    # ── 2. 選手名マップを書き換え ─────────────────────────────────────
    names_entries = ", ".join(
        f"{waku}:'{players.get(waku, '')}'" for waku in range(1, 7)
    )
    new_block = (
        "// [AUTO_PLAYERS_START]\n"
        f"const PLAYER_NAMES = {{{names_entries}}};\n"
        "// [AUTO_PLAYERS_END]"
    )
    html = re.sub(
        r"// \[AUTO_PLAYERS_START\].*?// \[AUTO_PLAYERS_END\]",
        new_block,
        html,
        flags=re.DOTALL,
    )

    if html == original:
        log("  [viewer] HTML に変更なし → 書き込みスキップ")
        return False

    VIEWER_HTML.write_text(html, encoding="utf-8")
    log(f"  [viewer] ✓ {VIEWER_HTML.name} 更新: 会場={venue}, 選手={players}")
    return True


def fetch_motor_for_csv(csv_paths: list):
    """
    出走表CSV到着時にモーター情報だけを取得する。
    backfill_motor()の後継。起動時バックフィルは行わない。

    csv_paths: 変更を検知した当日CSVのPathリスト
    """
    if not FETCH_TENJI_PY.exists():
        log(f"  ⚠ {FETCH_TENJI_PY.name} が見つかりません → モーター取得スキップ")
        return

    # today_str() は深夜0〜3時に翌日付を返すが、CSVファイル名は実際の日付で
    # 保存されている場合があるため、_race_date_candidates() で複数候補を許容する。
    date_candidates = _race_date_candidates()
    TENJI_DIR.mkdir(exist_ok=True)

    # 対象CSVから会場・日付を収集
    venues_in_csv: dict[str, str] = {}
    for csv_path in csv_paths:
        if not any(d in Path(csv_path).name for d in date_candidates):
            continue
        try:
            try:
                df = pd.read_csv(csv_path, encoding="utf-8")
            except UnicodeDecodeError:
                df = pd.read_csv(csv_path, encoding="shift_jis")
            if "会場" in df.columns:
                venue_name = str(df.iloc[0]["会場"]).strip()
                date_raw   = str(df.iloc[0].get("日付", date_candidates[0])).strip().replace("/", "-")
                if venue_name and venue_name in VENUE_SLUG:
                    venues_in_csv[venue_name] = date_raw
        except Exception:
            continue

    if not venues_in_csv:
        log("  モーター取得: 対象会場なし → スキップ")
        return

    log(f"  モーター取得開始: {list(venues_in_csv.keys())}")

    def fetch_one_motor(args):
        slug, date, race = args
        result = subprocess.run(
            [sys.executable, str(FETCH_TENJI_PY),
             "--venue", slug,
             "--date",  date,
             "--race",  str(race),
             "--out",   str(TENJI_DIR),
             "--motor-only"],
            capture_output=True, timeout=120
        )
        return slug, race, result.returncode

    tasks = []
    for venue_name, date in venues_in_csv.items():
        slug = VENUE_SLUG[venue_name]
        date_nodash = date.replace("-", "")
        # 既取得レースはスキップ（モーター情報が既にあるもの）
        existing_races = set()
        for f in TENJI_DIR.glob(f"tenji_{slug}_{date_nodash}_R*.json"):
            m = re.search(r"_R(\d{2})\.json$", f.name)
            if m:
                import json as _json
                try:
                    with open(f, encoding="utf-8") as fp:
                        rows = _json.load(fp)
                    if rows and rows[0].get("motor_no") is not None:
                        existing_races.add(int(m.group(1)))
                except Exception:
                    pass
        missing = [r for r in range(1, 13) if r not in existing_races]
        if not missing:
            log(f"  {venue_name}: モーター情報取得済み → スキップ")
            continue
        log(f"  {venue_name}（{slug}）: {len(missing)}R分取得予定 {missing}")
        for race in missing:
            tasks.append((slug, date, race))

    if not tasks:
        log("  モーター取得: 全会場取得済み → スキップ")
        return

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(fetch_one_motor, t): t for t in tasks}
        for f in as_completed(futures):
            try:
                slug, race, code = f.result()
                log(f"    {slug} {race}R {'✓' if code == 0 else '✕'}")
            except Exception as e:
                log(f"    エラー: {e}")

    log("  モーター取得完了")


def fetch_tenji_for_csv(csv_paths: list):
    """
    出走表CSV到着時に展示情報（テンジ）をバックグラウンドで取得する。
    fetch_motor_for_csv と同構造だが --motor-only フラグを使わない。

    csv_paths: 変更を検知した当日CSVのPathリスト
    """
    if not FETCH_TENJI_PY.exists():
        log(f"  ⚠ {FETCH_TENJI_PY.name} が見つかりません → 展示取得スキップ")
        return

    # today_str() は深夜0〜3時に翌日付を返すが、CSVファイル名は実際の日付で
    # 保存されている場合があるため、_race_date_candidates() で複数候補を許容する。
    date_candidates = _race_date_candidates()
    TENJI_DIR.mkdir(exist_ok=True)

    # 対象CSVから会場・日付を収集
    venues_in_csv: dict[str, str] = {}
    for csv_path in csv_paths:
        if not any(d in Path(csv_path).name for d in date_candidates):
            continue
        try:
            try:
                df = pd.read_csv(csv_path, encoding="utf-8")
            except UnicodeDecodeError:
                df = pd.read_csv(csv_path, encoding="shift_jis")
            if "会場" in df.columns:
                venue_name = str(df.iloc[0]["会場"]).strip()
                date_raw   = str(df.iloc[0].get("日付", date_candidates[0])).strip().replace("/", "-")
                if venue_name and venue_name in VENUE_SLUG:
                    venues_in_csv[venue_name] = date_raw
        except Exception:
            continue

    if not venues_in_csv:
        log("  展示取得: 対象会場なし → スキップ")
        return

    log(f"  展示取得開始（バックグラウンド）: {list(venues_in_csv.keys())}")

    def fetch_one_tenji(args):
        slug, date, race = args
        result = subprocess.run(
            [sys.executable, str(FETCH_TENJI_PY),
             "--venue", slug,
             "--date",  date,
             "--race",  str(race),
             "--out",   str(TENJI_DIR)],
            capture_output=True, timeout=120
        )
        return slug, race, result.returncode

    def _bg_fetch():
        tasks = []
        for venue_name, date in venues_in_csv.items():
            slug = VENUE_SLUG[venue_name]
            date_nodash = date.replace("-", "")
            # 既取得レースはスキップ
            existing_races = set()
            for f in TENJI_DIR.glob(f"tenji_{slug}_{date_nodash}_R*.json"):
                m = re.search(r"_R(\d{2})\.json$", f.name)
                if m:
                    existing_races.add(int(m.group(1)))
            missing = [r for r in range(1, 13) if r not in existing_races]
            if not missing:
                log(f"  {venue_name}: 展示情報取得済み → スキップ")
                continue
            log(f"  {venue_name}（{slug}）: 展示 {len(missing)}R分取得予定 {missing}")
            for race in missing:
                tasks.append((slug, date, race))

        if not tasks:
            log("  展示取得: 全会場取得済み → スキップ")
            return

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {executor.submit(fetch_one_tenji, t): t for t in tasks}
            for f in as_completed(futures):
                try:
                    slug, race, code = f.result()
                    log(f"    [展示] {slug} {race}R {'✓' if code == 0 else '✕'}")
                except Exception as e:
                    log(f"    [展示] エラー: {e}")

        log("  展示取得完了")

        # ★ 修正: バックグラウンド取得完了後に tenji_YYYYMMDD.json を書き出してpush。
        # メインループの変更検知（prev_tenji との比較）は CSV変更時に先行更新されるため、
        # 展示JSONが書かれてもループ側では「差分なし」と判定されpushが漏れることがある。
        # ここで明示的に書き出し＆pushすることで確実にGitHubへ反映する。
        try:
            write_tenji_json_file()
            with _git_lock:
                for _tj in DATA_DIR.glob("tenji_*.json"):
                    _run_nolock(["git", "add", str(_tj)])
                _code_t, _out_t = _run_nolock(["git", "status", "--porcelain"])
                _tracked_t = [_l for _l in _out_t.strip().splitlines() if not _l.startswith("??")]
                if _tracked_t:
                    _msg_t = f"tenji update {datetime.now().strftime('%Y-%m-%d %H:%M')} [bg fetch完了]"
                    _enqueue_tenji_push(_msg_t)
                    log("  [BG展示] tenji_YYYYMMDD.json 展示専用pushキューに追加")
                else:
                    log("  [BG展示] 差分なし → pushスキップ")
        except Exception as _e:
            log(f"  [BG展示] push失敗（スキップ）: {_e}")

    import threading as _threading
    _threading.Thread(target=_bg_fetch, daemon=True).start()


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def _wait_for_index_lock(timeout: int = 10) -> bool:
    """
    .git/index.lock が別プロセスに掴まれている間は最大 timeout 秒待機する。
    Windowsでは削除できないので「なくなるまで待つ」戦略を採用。
    timeout 秒経過しても消えなければ False を返す（強制削除は行わない）。
    """
    lock_file = SCRIPTS_DIR / ".git" / "index.lock"
    waited = 0
    while lock_file.exists() and waited < timeout:
        time.sleep(0.5)
        waited += 0.5
    return not lock_file.exists()

def _clear_git_lock():
    """強制終了後に残る .git/index.lock を自動削除する"""
    lock_file = SCRIPTS_DIR / ".git" / "index.lock"
    if not lock_file.exists():
        return
    # まず別プロセスが手放すのを最大5秒待つ（WinError 32 回避）
    if _wait_for_index_lock(timeout=5):
        return  # 自然に消えた
    # それでも残っていれば削除を試みる（本当の残骸の場合）
    try:
        lock_file.unlink()
        log("  [git] index.lock を削除しました（異常終了の残骸）")
    except Exception as e:
        log(f"  [git] index.lock 削除失敗（別プロセス使用中）: {e}")

def run(cmd):
    # git操作は _git_lock で直列化し、index.lock 競合 (WinError 32) を防ぐ
    if cmd[0] == "git":
        with _git_lock:
            if cmd[1] in ("commit", "add"):
                _clear_git_lock()
            r = subprocess.run(cmd, cwd=str(SCRIPTS_DIR),
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            return r.returncode, (r.stdout + r.stderr).strip()
    r = subprocess.run(cmd, cwd=str(SCRIPTS_DIR),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout + r.stderr).strip()

def get_mtimes(pattern):
    return {p: Path(p).stat().st_mtime for p in glob.glob(pattern)}

def today_str():
    """
    競艇営業日ベースの「今日」を返す。
    午前0時〜3時59分は「翌日（レース日）」の出走表がすでに到着している
    ため、その日付を返す。午前4時以降は通常の当日日付。
    例: 01:30 → 翌日付 / 09:00 → 当日付
    """
    now = datetime.now()
    if now.hour < 4:
        from datetime import timedelta
        return (now + timedelta(days=1)).strftime("%Y-%m-%d")
    return now.strftime("%Y-%m-%d")

def _race_date_candidates() -> list:
    """
    CSVを検索する日付候補リストを返す（最大2日分）。
    深夜帯（0〜3時）は「翌日付」＋「当日付」の両方を返すことで
    日付切り替わり直後に古いCSVを誤って除外しないようにする。
    通常時は当日付のみ。
    """
    now = datetime.now()
    from datetime import timedelta
    if now.hour < 4:
        next_day = (now + timedelta(days=1)).strftime("%Y-%m-%d")
        today    = now.strftime("%Y-%m-%d")
        return [next_day, today]   # 翌日付を優先
    return [now.strftime("%Y-%m-%d")]

def get_today_csvs():
    """
    競艇日付ベースで「今日のCSV」を返す。
    深夜1時に翌日付CSVが到着しても正しく検知できる。
    """
    candidates = _race_date_candidates()
    all_csvs = glob.glob(str(CSV_DIR / "*.csv"))
    result = []
    for date in candidates:
        matched = [p for p in all_csvs if date in Path(p).name]
        if matched:
            return matched   # 最初にマッチした日付のCSVを使用
    return result


def get_venues_in_today_csvs() -> dict:
    """
    当日CSVから {会場名: 日付} を抽出して返す
    例: {"常滑":"2026-05-09", "津":"2026-05-09"}
    """
    venues_in_csv = {}

    for csv_path in get_today_csvs():
        try:
            try:
                df = pd.read_csv(csv_path, encoding="utf-8")
            except UnicodeDecodeError:
                df = pd.read_csv(csv_path, encoding="shift_jis")

            if "会場" in df.columns:
                vname = str(df.iloc[0]["会場"]).strip()
                date_raw = str(df.iloc[0].get("日付", today_str())).strip().replace("/", "-")

                if vname in VENUE_SLUG:
                    venues_in_csv[vname] = date_raw

        except Exception:
            continue

    return venues_in_csv


def make_csv_index():
    """csv_output/index.json を生成（当日CSVのみ）"""
    files = sorted([Path(p).name for p in get_today_csvs()])
    idx_path = CSV_DIR / "index.json"
    with open(idx_path, 'w', encoding='utf-8') as _wf:
        _wf.write(json.dumps({"files": files, "updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")},
                   ensure_ascii=False))
    log(f"  index.json: {len(files)}件（当日分のみ）")
    return idx_path

def update_cache_version():
    """
    index.html のキャッシュバスター文字列を現在時刻で更新する。

    index.html 内の全 .js?v=XXXXXXXXXXXXXX (14桁) を新しいタイムスタンプに置換する。
    これにより data.js / sample_obf.js 等すべてのスクリプトがブラウザに再取得される。

    [fix] 旧実装の問題:
      - /* __CACHE_VER__ */ プレースホルダーは初回置換後に消えるため2回目以降は何もしない
      - 結果、再起動のたびにキャッシュが更新されずブラウザが古い data.js を使い続けていた

    [fix] 新実装:
      - index.html 内の全 .js?v=14桁 を置換（繰り返し確実に動作する）
      - /* __CACHE_VER__ */ プレースホルダーも初回互換で残す
    """
    import re as _re
    ver = datetime.now().strftime("%Y%m%d%H%M%S")
    try:
        text = INDEX_HTML.read_text(encoding="utf-8")
        # パターン1: 2回目以降 .js?v=XXXXXXXXXXXXXX (14桁) → 全スクリプト対象
        text2 = _re.sub(r"([.]js[?]v=)\d{14}", lambda m: m.group(1) + ver, text)
        # パターン2: 初回 /* __CACHE_VER__ */ プレースホルダー（後方互換）
        text2 = _re.sub(r"/[*] __CACHE_VER__ [*]/", ver, text2)
        if text2 != text:
            with open(INDEX_HTML, "w", encoding="utf-8") as _wf:
                _wf.write(text2)
            log(f"  ✓ キャッシュバスター更新: v={ver}")
        else:
            log(f"  [WARN] キャッシュバスター: index.html に置換対象なし (v={ver})")
    except Exception as e:
        log(f"  [WARN] cache version update failed: {e}")

def obfuscate_js(src_path, out_path):
    """
    sample.js をコメント除去 → obfuscate して out_path に書き出す。
    失敗時はオリジナルをそのまま使う（動作を絶対に止めない）。
    前提: npm install -g javascript-obfuscator
    """
    import shutil as _shutil, tempfile as _tempfile
    from pathlib import Path as _Path

    obf_cmd = _shutil.which("javascript-obfuscator")
    if not obf_cmd:
        log("[obfuscate] javascript-obfuscator が見つかりません → オリジナルを使用")
        _shutil.copy2(src_path, out_path)
        return out_path

    stripped_path = SCRIPTS_DIR / "_sample_stripped_tmp.js"

    strip_script = r"""
const src = require('fs').readFileSync(process.argv[2], 'utf8');
let result = '', i = 0, inStr = false, strChar = '', inTemplate = 0;
while (i < src.length) {
    const c = src[i];
    if (!inStr && c === '`') { inTemplate += (inTemplate > 0 ? -1 : 1); result += c; i++; continue; }
    if (inTemplate > 0) { result += c; i++; continue; }
    if (!inStr && (c === '"' || c === "'")) { inStr = true; strChar = c; result += c; i++; continue; }
    if (inStr && c === strChar && src[i - 1] !== '\\') { inStr = false; result += c; i++; continue; }
    if (inStr) { result += c; i++; continue; }
    if (c === '/' && src[i + 1] === '*') { while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    result += c; i++;
}
require('fs').writeFileSync(process.argv[3], result);
"""
    with _tempfile.NamedTemporaryFile(suffix=".js", delete=False, mode="w", encoding="utf-8") as tf:
        strip_script_path = tf.name
        tf.write(strip_script)

    try:
        r = subprocess.run(
            ["node", strip_script_path, str(src_path), str(stripped_path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30
        )
        if r.returncode != 0:
            raise RuntimeError(f"strip failed: {r.stderr}")
        log("[obfuscate] コメント除去完了")
    except Exception as e:
        log(f"[obfuscate] コメント除去失敗: {e} → オリジナルを使用")
        _shutil.copy2(src_path, out_path)
        return out_path
    finally:
        try:
            import os as _os; _os.unlink(strip_script_path)
        except Exception:
            pass

    try:
        r = subprocess.run(
            [
                obf_cmd, str(stripped_path),
                "--output", str(out_path),
                "--compact", "true",
                "--string-array", "true",
                "--string-array-encoding", "rc4",
                "--string-array-threshold", "1.0",
                "--dead-code-injection", "false",
                "--self-defending", "false",
            ],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120
        )
        if r.returncode != 0 or not _Path(out_path).exists():
            raise RuntimeError(f"obfuscate failed: {r.stderr}")
        log(f"[obfuscate] 難読化完了: {_Path(out_path).stat().st_size // 1024} KB")
    except Exception as e:
        log(f"[obfuscate] 難読化失敗: {e} → オリジナルを使用")
        _shutil.copy2(src_path, out_path)
    finally:
        try:
            stripped_path.unlink()
        except Exception:
            pass

    return out_path


def _summarize_push_targets(changed_files):
    """
    changed_files のファイル名から会場・レース番号を抽出して人間が読みやすい文字列を返す。

    ファイル名の想定パターン:
      tenji_data/tenji_{venue}_{YYYYMMDD}_R{rno}.json  → 会場+レース番号
      csv_output/{venue}_{YYYYMMDD}.csv                → 会場のみ
      data/index.json, data.js, index.html など        → その他

    戻り値例:
      "びわこR3, 丸亀R5, 唐津R7"
      "唐津 (CSV), index.html, data.js"
    """
    import re as _re
    venue_races = {}   # venue → set of race_no strings
    other_labels = []

    for f in changed_files:
        name = Path(str(f)).name
        # tenji_{venue}_{YYYYMMDD}_R{rno}.json
        m = _re.search(r"tenji_(.+?)_\d{8}_R(\d+)\.json$", name)
        if m:
            venue_races.setdefault(m.group(1), set()).add(m.group(2))
            continue
        # {venue}_{YYYYMMDD}.csv  (csv_output)
        m = _re.search(r"^(.+?)_\d{8}\.csv$", name)
        if m:
            venue_races.setdefault(m.group(1), set())   # レース番号なし
            continue
        # 結果: result_{venue}_{YYYYMMDD}_R{rno}.json
        m = _re.search(r"result_(.+?)_\d{8}_R(\d+)\.json$", name)
        if m:
            venue_races.setdefault(m.group(1), set()).add(m.group(2))
            continue
        # その他（index.html, data.js など）
        other_labels.append(name)

    parts = []
    for venue, races in sorted(venue_races.items()):
        if races:
            sorted_races = sorted(races, key=lambda x: int(x))
            parts.append(f"{venue} R{','.join(sorted_races)}")
        else:
            parts.append(f"{venue} (CSV)")
    parts.extend(other_labels)
    return ", ".join(parts) if parts else "（不明）"


def git_push(changed_files, urgent=False):
    # git add（難読化含む）はここで実施し、commit+push はキューに委譲する。
    # → 複数系統のpushが短時間に重なってGitHub PagesがCancelledになるのを防ぐ。
    # urgent=True: priority=0（緊急）でキューに積む。
    #   → tenji/odds/result の緊急pushが途切れず供給される状況でも、
    #     PUSH_NORMAL のまま後回しにされ続ける「飢餓」を防ぐために使う。
    #     （例: RACE_INDEX_DATA を埋め込んだ data.js の push）
    #   同じpriority内はFIFO（_push_seq）で順序が保たれるため、
    #   先行する緊急push（tenji/odds/result）を追い越すことはない。
    with _git_lock:
        _git_add_locked(changed_files)
        push_summary = _summarize_push_targets(changed_files)
        msg = f"update {datetime.now().strftime('%Y-%m-%d %H:%M')} [{push_summary}]"
        code, out = _run_nolock(["git", "status", "--porcelain"])
        tracked = [l for l in out.strip().splitlines() if not l.startswith("??")]
        if not tracked:
            return False
        priority = PUSH_URGENT if urgent else PUSH_NORMAL
        _push_queue.put((priority, next(_push_seq), "raw", None, msg))
        log(f"  pushキューに追加 [{push_summary}]" + ("（緊急）" if urgent else ""))
        return True

def _run_nolock(cmd, timeout=60):
    """_git_lock 取得済みの内部から呼ぶ git サブコマンド実行（ロックなし版）

    GIT_TERMINAL_PROMPT=0 でGitの対話プロンプト（Credential Manager の
    ブラウザ認証待ちを含む）を即座に失敗させ、さらに timeout でも二重に
    ハングを防ぐ。認証エラー時は無人稼働のまま止まり続けず、失敗として
    ログ・リトライ・通知の既存フローに乗せる。
    """
    if cmd[0] == "git" and cmd[1] in ("commit", "add"):
        _clear_git_lock()
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "never"
    try:
        r = subprocess.run(cmd, cwd=str(SCRIPTS_DIR),
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env=env, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return 1, f"[TIMEOUT] '{' '.join(cmd)}' が{timeout}秒でタイムアウト（認証待ち等でハングした可能性）"

def _git_add_locked(changed_files):
    """_git_lock 保持中に呼ばれる。git add（難読化含む）だけ実施。commit/pushはしない。"""
    # 変更ファイルをadd
    for f in changed_files:
        _run_nolock(["git", "add", str(f)])

    # 常に含めるファイル（index.html / sample.css / data.js / player_id_map.json）
    _run_nolock(["git", "add", str(INDEX_HTML)])
    if CSS_FILE.exists():
        _run_nolock(["git", "add", str(CSS_FILE)])

    # params.js の難読化: params.js 自体が変更された時だけ実行
    if PARAMS_JS.exists():
        params_changed = any(Path(str(f)).resolve() == PARAMS_JS.resolve() for f in changed_files)
        if params_changed or not PARAMS_JS_OBF.exists():
            obf_path_params = obfuscate_js(PARAMS_JS, PARAMS_JS_OBF)
            update_cache_version()
            _run_nolock(["git", "add", str(obf_path_params)])
        else:
            _run_nolock(["git", "add", str(PARAMS_JS_OBF)])

    # csv_export.js の難読化
    if CSV_EXPORT_JS.exists():
        csv_changed = any(Path(str(f)).resolve() == CSV_EXPORT_JS.resolve() for f in changed_files)
        if csv_changed or not CSV_EXPORT_JS_OBF.exists():
            obf_csv = obfuscate_js(CSV_EXPORT_JS, CSV_EXPORT_JS_OBF)
            update_cache_version()
            _run_nolock(["git", "add", str(obf_csv)])
        else:
            _run_nolock(["git", "add", str(CSV_EXPORT_JS_OBF)])

    # sim.js の難読化
    if SIM_JS.exists():
        sim_changed = any(Path(str(f)).resolve() == SIM_JS.resolve() for f in changed_files)
        if sim_changed or not SIM_JS_OBF.exists():
            obf_sim = obfuscate_js(SIM_JS, SIM_JS_OBF)
            update_cache_version()
            _run_nolock(["git", "add", str(obf_sim)])
        else:
            _run_nolock(["git", "add", str(SIM_JS_OBF)])

    # backtest.js の難読化
    if BACKTEST_JS.exists():
        bt_changed = any(Path(str(f)).resolve() == BACKTEST_JS.resolve() for f in changed_files)
        if bt_changed or not BACKTEST_JS_OBF.exists():
            obf_bt = obfuscate_js(BACKTEST_JS, BACKTEST_JS_OBF)
            update_cache_version()
            _run_nolock(["git", "add", str(obf_bt)])
        else:
            _run_nolock(["git", "add", str(BACKTEST_JS_OBF)])

    # top_stats.js の難読化
    if TOP_STATS_JS.exists():
        ts_changed = any(Path(str(f)).resolve() == TOP_STATS_JS.resolve() for f in changed_files)
        if ts_changed or not TOP_STATS_JS_OBF.exists():
            obf_ts = obfuscate_js(TOP_STATS_JS, TOP_STATS_JS_OBF)
            update_cache_version()
            _run_nolock(["git", "add", str(obf_ts)])
        else:
            _run_nolock(["git", "add", str(TOP_STATS_JS_OBF)])

    # top_page.js の難読化
    if TOP_PAGE_JS.exists():
        tp_changed = any(Path(str(f)).resolve() == TOP_PAGE_JS.resolve() for f in changed_files)
        if tp_changed or not TOP_PAGE_JS_OBF.exists():
            obf_tp = obfuscate_js(TOP_PAGE_JS, TOP_PAGE_JS_OBF)
            update_cache_version()
            _run_nolock(["git", "add", str(obf_tp)])
        else:
            _run_nolock(["git", "add", str(TOP_PAGE_JS_OBF)])

    # calibration.js / dynamic_inn2place.js / computeScenCombosWithEV.js（難読化済みをpush）
    if CALIBRATION_JS_OBF.exists():
        _run_nolock(["git", "add", str(CALIBRATION_JS_OBF)])
    if DYNAMIC_INN2PLACE_JS_OBF.exists():
        _run_nolock(["git", "add", str(DYNAMIC_INN2PLACE_JS_OBF)])
    if COMPUTE_SCEN_JS_OBF.exists():
        _run_nolock(["git", "add", str(COMPUTE_SCEN_JS_OBF)])

    # sample.js の難読化: sample.js 自体が変更された時だけ実行（毎回は重すぎる）
    if JS_FILE.exists():
        js_changed = any(Path(str(f)).resolve() == JS_FILE.resolve() for f in changed_files)
        if js_changed or not JS_FILE_OBF.exists():
            obf_path = obfuscate_js(JS_FILE, JS_FILE_OBF)
            update_cache_version()
            _run_nolock(["git", "add", str(obf_path)])
        else:
            _run_nolock(["git", "add", str(JS_FILE_OBF)])

    # data.js: フェーズ2導入前は「スケルトンのみ・push不要」だったが、
    # 現在は fetch_and_inject_race_index() / inject_odds_to_html() 等が
    # RACE_INDEX_DATA 等の実データを data.js に書き込んでいるため、
    # ここで明示的に git add しないとステージングされず、
    # git commit（-aなし）に一切含まれないまま永遠に未pushとなる。
    # ── これが「RACE_INDEX_DATAが更新されない」不具合の根本原因 ──
    if DATA_JS.exists():
        _run_nolock(["git", "add", str(DATA_JS)])
    if PLAYER_ID_MAP.exists():
        _run_nolock(["git", "add", str(PLAYER_ID_MAP)])

    # フェーズ1: data/*.json を追加（存在すれば）
    if DATA_DIR.exists():
        for jf in DATA_DIR.glob("*.json"):
            _run_nolock(["git", "add", str(jf)])

    # addのみ。commit/pushは呼び出し元がキュー経由で実施する。

def get_past_venues_from_csvs(days_back: int = HISTORY_DAYS) -> dict:
    """
    csv_output/ 内の過去 days_back 日分のCSVを走査し、
    {会場名: 日付YYYY-MM-DD} の辞書を返す（当日は除く）。
    バックテスト用結果取得の入力として使う。
    """
    from datetime import timedelta
    today = datetime.now().date()
    target_dates = set(
        (today - timedelta(days=d)).strftime("%Y-%m-%d")
        for d in range(1, days_back + 1)
    )
    venues: dict = {}
    for csv_path in glob.glob(str(CSV_DIR / "*.csv")):
        fname = Path(csv_path).name
        # ファイル名に含まれる日付を検出
        matched_date = next((d for d in target_dates if d in fname), None)
        if not matched_date:
            continue
        try:
            try:
                df = pd.read_csv(csv_path, encoding="utf-8")
            except UnicodeDecodeError:
                df = pd.read_csv(csv_path, encoding="shift_jis")
            if "会場" in df.columns:
                vname = str(df.iloc[0]["会場"]).strip()
                if vname in VENUE_SLUG:
                    venues[vname] = matched_date
        except Exception:
            continue
    return venues


def backfill_past_results():
    """
    起動時に過去 HISTORY_DAYS 日分の result_data/*.json が揃っているか確認し、
    欠けているレースをバックグラウンドで取得する。
    fetch_result_for_venues() を日付単位で繰り返し呼ぶだけ。
    取得完了後にまとめて inject_result_to_html() → push する。
    """
    if not FETCH_RESULT_PY.exists():
        log(f"  ⚠ {FETCH_RESULT_PY.name} が見つかりません → バックフィルスキップ")
        return

    from datetime import timedelta
    today = datetime.now().date()

    # 日付ごとに会場リストを作成
    date_venues: dict[str, dict] = {}  # {"YYYY-MM-DD": {"会場名": "YYYY-MM-DD"}}
    for csv_path in glob.glob(str(CSV_DIR / "*.csv")):
        fname = Path(csv_path).name
        for d in range(1, HISTORY_DAYS + 1):
            target = (today - timedelta(days=d)).strftime("%Y-%m-%d")
            if target not in fname:
                continue
            try:
                try:
                    df = pd.read_csv(csv_path, encoding="utf-8")
                except UnicodeDecodeError:
                    df = pd.read_csv(csv_path, encoding="shift_jis")
                if "会場" in df.columns:
                    vname = str(df.iloc[0]["会場"]).strip()
                    if vname in VENUE_SLUG:
                        date_venues.setdefault(target, {})[vname] = target
            except Exception:
                continue

    if not date_venues:
        log("  バックフィル: 過去CSVなし → スキップ")
        return

    total_missing = 0
    tasks = []
    for date_str, venues in sorted(date_venues.items(), reverse=True):
        date_nd = date_str.replace("-", "")
        for venue_name, _ in venues.items():
            slug = VENUE_SLUG.get(venue_name)
            if not slug:
                continue
            merged_path = RESULT_DIR / f"result_{date_nd}.json"
            merged_cache: dict = {}
            if merged_path.exists():
                try:
                    with open(merged_path, encoding="utf-8") as f:
                        merged_cache = json.load(f)
                except Exception:
                    merged_cache = {}
            for race in range(1, 13):
                # 取得済みはスキップ（統合済みファイル内のrace_keyで判定）
                race_key = f"{slug}_{int(race)}"
                entry = merged_cache.get(race_key, {})
                if entry.get("sanrentan") or entry.get("cancelled"):
                    continue  # 取得済み or 中止登録済み
                tasks.append((slug, date_nd, race))
                total_missing += 1

    if not tasks:
        log("  バックフィル: 全レース取得済み → スキップ")
        return

    log(f"  バックフィル開始: 過去{HISTORY_DAYS}日分 / 未取得 {total_missing}レース")

    def _do_backfill():
        fetched = 0
        # バッチサイズ制限: 起動時に一度に大量プロセスを生成しない
        # 1日あたり最大12レース×複数会場 → max_workers=2 で順次処理
        BACKFILL_BATCH = 48  # 1回のバックフィルで処理する最大レース数
        batch = tasks[:BACKFILL_BATCH]
        if len(tasks) > BACKFILL_BATCH:
            log(f"  バックフィル: 今回は {BACKFILL_BATCH}レースのみ処理（残り{len(tasks)-BACKFILL_BATCH}レースは次回起動時）")

        def fetch_one(args):
            slug, date_nd, race = args
            result = subprocess.run(
                [sys.executable, str(FETCH_RESULT_PY),
                 "--venue", slug, "--date", date_nd, "--race", str(race),
                 "--out", str(RESULT_DIR)],
                capture_output=True, timeout=60
            )
            return slug, date_nd, race, result.returncode

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {executor.submit(fetch_one, t): t for t in batch}
            for fut in as_completed(futures):
                try:
                    slug, date_nd, race, code = fut.result()
                    if code == 0:
                        fetched += 1
                        log(f"    [BF] {slug} {date_nd} {race}R ✓")
                    else:
                        log(f"    [BF] {slug} {date_nd} {race}R ✕（未確定または非公開）")
                except Exception as e:
                    log(f"    [BF] エラー: {e}")

        if fetched > 0:
            log(f"  バックフィル完了: {fetched}レース取得 → inject＋push")
            # フェーズ3: HTMLへの埋め込みを停止
            # inject_result_to_html()
            write_result_json()    # data/result_YYYYMMDD.json を更新
            write_data_index()     # インデックスも更新
            with _git_lock:
                _run_nolock(["git", "add", str(INDEX_HTML)])
                code, out = _run_nolock(["git", "status", "--porcelain"])
                tracked = [l for l in out.strip().splitlines() if not l.startswith("??")]
                if tracked:
                    msg = f"backfill result {datetime.now().strftime('%Y-%m-%d %H:%M')}"
                    _push_queue.put((PUSH_NORMAL, next(_push_seq), "raw", None, msg))
                    log("  ✓ バックフィル pushキューに追加")
                else:
                    log("  バックフィル: 変更なし（既に最新）")
        else:
            log("  バックフィル: 新規取得なし（全レース未確定または非公開）")

    import threading as _threading
    _threading.Thread(target=_do_backfill, daemon=True).start()


def _git_heal_on_startup():
    """
    起動時にgitリポジトリの状態を自動修復する。

    【対処する問題】
    1. 残存rebase（前回の異常終了で .git/rebase-merge/ 等が残っている）
    2. untracked files がリモートと衝突する状態
       （GitHub上で直接ファイルをアップロードした場合などに発生）

    【方針】
    - リモート(origin/main or origin/master)を fetch して最新を確認
    - ローカルがリモートより遅れている場合は reset --hard で強制追従
    - 残存rebaseがあれば abort してクリア
    """
    with _git_lock:
        # 残存rebaseをクリア
        rebase_merge_dir = Path(SCRIPTS_DIR) / ".git" / "rebase-merge"
        rebase_apply_dir = Path(SCRIPTS_DIR) / ".git" / "rebase-apply"
        if rebase_merge_dir.exists() or rebase_apply_dir.exists():
            log("  [git修復] 残存rebaseを検出 → abort してクリア")
            _run_nolock(["git", "rebase", "--abort"])
            import shutil as _shutil3
            for d in [rebase_merge_dir, rebase_apply_dir]:
                if d.exists():
                    _shutil3.rmtree(str(d), ignore_errors=True)

        # unmerged files をクリア
        _, status_out = _run_nolock(["git", "status", "--porcelain"])
        has_unmerged = any(
            l[:2] in ("UU", "AA", "DD", "AU", "UA", "DU", "UD")
            for l in status_out.strip().splitlines()
        )
        if has_unmerged:
            log("  [git修復] unmerged files を検出 → checkout -- . で解消")
            _run_nolock(["git", "checkout", "--", "."])

        # リモートの最新を fetch
        branch = "main"
        rc, _ = _run_nolock(["git", "fetch", "origin", branch])
        if rc != 0:
            rc, _ = _run_nolock(["git", "fetch", "origin", "master"])
            if rc == 0:
                branch = "master"
            else:
                log("  [git修復] fetch失敗（ネットワーク不可？）→ スキップ")
                return

        # ローカルがリモートより遅れているコミット数を確認
        _, rev_out = _run_nolock(["git", "rev-list", "--count", f"HEAD..origin/{branch}"])
        behind = int(rev_out.strip()) if rev_out.strip().isdigit() else 0

        if behind > 0:
            log(f"  [git修復] リモートが{behind}コミット先行 → reset --hard で追従")
            _run_nolock(["git", "reset", "--hard", f"origin/{branch}"])
            log(f"  [git修復] ✓ origin/{branch} に同期完了")
        else:
            log(f"  [git修復] ✓ gitリポジトリ正常（リモートと同期済み）")


def main():
    log("=" * 50)
    log("  自動push監視 起動")
    log(f"  CSV監視  : {CSV_DIR}")
    log(f"  展示情報監視: {TENJI_DIR}")
    log(f"  間隔     : {CHECK_INTERVAL}秒")
    log("=" * 50)

    # 起動時にgitリポジトリの状態を自動修復（残存rebase・リモート遅れ・競合解消）
    _git_heal_on_startup()

    # 起動時に data.js の宣言欠損を自動補完（強制終了後の復旧）
    _data_js_ensure_placeholders()

    # [2026-05-20 追加] 起動時に Python/JS 間の設定整合をチェック
    _check_tenji_config_sync()

    TENJI_DIR.mkdir(exist_ok=True)
    CSV_DIR.mkdir(exist_ok=True)
    COMMENT_DIR.mkdir(exist_ok=True)
    RESULT_DIR.mkdir(exist_ok=True)

    # 深夜帯は翌日付CSVも監視（_race_date_candidates()に従う）
    prev_csv = {}
    for _pat in [str(CSV_DIR / f"*{d}*.csv") for d in _race_date_candidates()]:
        prev_csv.update(get_mtimes(_pat))
    prev_tenji = get_mtimes(str(TENJI_DIR / "*.json"))
    prev_comment = get_mtimes(str(COMMENT_DIR / "*.json")) if COMMENT_DIR.exists() else {}
    prev_result  = get_mtimes(str(RESULT_DIR / "*.json")) if RESULT_DIR.exists() else {}
    prev_odds    = get_mtimes(str(ODDS_DIR / "*.json")) if ODDS_DIR.exists() else {}
    prev_xlsx_mtime = XLSX_PATH.stat().st_mtime if XLSX_PATH.exists() else None
    _flying_path_init = _flying_path_today()
    prev_flying_mtime = None  # 起動時は必ず一度読み込ませるため未設定のままにする

    # 起動時: flyingファイルがあれば無条件で一度読み込んで反映する
    # （起動時点のmtimeを基準にしてしまうと、その後ファイルが更新されない限り
    #   ループ内の変更検知が一切発火せず FLYING_DATA が永久に空になるため）
    if _flying_path_init.exists():
        if inject_flying_to_html():
            prev_flying_mtime = _flying_path_init.stat().st_mtime
            log("  ✓ 起動時 FLYING_DATA 反映完了")
            _flying_startup_target = DATA_JS if DATA_JS.exists() else INDEX_HTML
            git_push([_flying_startup_target], urgent=True)
        else:
            log("  ⚠ 起動時 FLYING_DATA 反映失敗（詳細は直前のログ参照）")
    else:
        log(f"  起動時: {_flying_path_init.name} が見つからないため FLYING_DATA 反映スキップ")

    # 起動時: 当日CSVがあればindex.jsonを生成してpush
    today_csvs = get_today_csvs()
    if today_csvs:
        idx = make_csv_index()
        log(f"  起動時push: {len(today_csvs)}件（当日分）+ index.json")

        # 起動時は data/*.json を書き出してpush（inject→data.js埋め込みは廃止）
        # [fix] 起動前に取得済みのresult JSONを確実にBRCsystem/dataに反映する
        write_result_json()
        write_all_json_files()
        git_push([Path(p) for p in today_csvs] + [idx])
        log("  ✓ 起動時push完了（公式情報取得はバックグラウンドで実行中）")

        # 重い処理（公式レースインデックス取得）はバックグラウンドで実行
        import threading as _threading
        def _reprocess_bg():
            log("  [BG] 公式情報・JSONファイル更新 開始...")
            fetch_and_inject_race_index()
            write_all_json_files()
            # race_index_*.json 等 data/ 配下の新規ファイルも確実に add
            # ── _git_lock を取らずに直接 subprocess で git add すると、
            #    同時刻に走る result/odds の緊急push（_git_lock保持中）と
            #    .git/index.lock を奪い合って "File exists" で失敗するため、
            #    git_push() の _git_add_locked（_git_lock保護下）にまとめて渡す ──
            extra_files = list(DATA_DIR.glob("*.json")) if DATA_DIR.exists() else []
            pushed = git_push([INDEX_HTML] + extra_files, urgent=True)
            if pushed:
                log("  [BG] 公式情報・JSONファイル更新 完了 → push済み")
            else:
                log("  [BG] 公式情報・JSONファイル更新 完了（変更なし・pushスキップ）")
        _threading.Thread(target=_reprocess_bg, daemon=True).start()

    else:
        log("  当日CSVなし → 深夜帯CSV到着監視モードで待機")
        import threading as _threading
        def _await_midnight_csv():
            log("  [深夜監視] 翌日付CSV到着を待機中（30秒ごとチェック）...")
            while True:
                time.sleep(30)
                arrived = get_today_csvs()
                if arrived:
                    log(f"  [深夜監視] 翌日付CSV {len(arrived)}件 到着 → 起動処理を実行")
                    idx = make_csv_index()
                    write_all_json_files()
                    git_push([Path(p) for p in arrived] + [idx])
                    log("  [深夜監視] ✓ 翌日付CSV push完了（公式情報取得はバックグラウンドで実行）")
                    def _bg():
                        fetch_and_inject_race_index()
                        write_all_json_files()
                        pushed = git_push([INDEX_HTML], urgent=True)
                        log("  [深夜監視][BG] 公式情報・JSONファイル更新 完了" + (" → push済み" if pushed else "（変更なし）"))
                    _threading.Thread(target=_bg, daemon=True).start()
                    break
        _threading.Thread(target=_await_midnight_csv, daemon=True).start()

    # 過去HISTORY_DAYS日分の結果をバックグラウンドで補完（バックテスト用）
    backfill_past_results()

    try:
        while True:
          try:
              time.sleep(CHECK_INTERVAL)
              # 深夜帯は翌日付CSVも監視（_race_date_candidates()に従う）
              curr_csv = {}
              for _pat in [str(CSV_DIR / f"*{d}*.csv") for d in _race_date_candidates()]:
                  curr_csv.update(get_mtimes(_pat))
              curr_tenji = get_mtimes(str(TENJI_DIR / "*.json"))
              curr_comment = get_mtimes(str(COMMENT_DIR / "*.json")) if COMMENT_DIR.exists() else {}
              curr_result  = get_mtimes(str(RESULT_DIR / "*.json")) if RESULT_DIR.exists() else {}
              curr_odds    = get_mtimes(str(ODDS_DIR / "*.json")) if ODDS_DIR.exists() else {}

              changed = []

              # Excelマスタ変更チェック → 再ビルド＋MASTER ホットリロード
              curr_xlsx_mtime = XLSX_PATH.stat().st_mtime if XLSX_PATH.exists() else None
              if curr_xlsx_mtime and curr_xlsx_mtime != prev_xlsx_mtime:
                  if rebuild_master():
                      prev_xlsx_mtime = curr_xlsx_mtime

              # フライングExcel変更チェック → FLYING_DATA再埋め込み＋push
              _flying_path_curr = _flying_path_today()
              curr_flying_mtime = _flying_path_curr.stat().st_mtime if _flying_path_curr.exists() else None
              if curr_flying_mtime and curr_flying_mtime != prev_flying_mtime:
                  log(f"  フライング情報変更: {_flying_path_curr.name}")
                  if inject_flying_to_html():
                      prev_flying_mtime = curr_flying_mtime
                      with _git_lock:
                          _flying_target = DATA_JS if DATA_JS.exists() else INDEX_HTML
                          _run_nolock(["git", "add", str(_flying_target)])
                          _code_fly, _out_fly = _run_nolock(["git", "status", "--porcelain"])
                          _tracked_fly = [l for l in _out_fly.strip().splitlines() if not l.startswith("??")]
                          if _tracked_fly:
                              _msg_fly = f"flying update {datetime.now().strftime('%Y-%m-%d %H:%M')}"
                              _push_queue.put((PUSH_URGENT, next(_push_seq), "raw", None, _msg_fly))
                              log("  ✓ フライング情報 pushキューに追加")
                  else:
                      # 読込失敗時も無限リトライしないよう mtime だけは更新しておく
                      prev_flying_mtime = curr_flying_mtime

              # CSV変更チェック
              csv_changed = False
              for p, mt in curr_csv.items():
                  if p not in prev_csv or prev_csv[p] != mt:
                      changed.append(Path(p))
                      log(f"  CSV変更: {Path(p).name}")
                      csv_changed = True

              # 展示情報JSON変更チェック
              for p, mt in curr_tenji.items():
                  if p not in prev_tenji or prev_tenji[p] != mt:
                      changed.append(Path(p))
                      log(f"  展示情報変更: {Path(p).name}")

              # コメントJSON変更チェック
              for p, mt in curr_comment.items():
                  if p not in prev_comment or prev_comment[p] != mt:
                      changed.append(Path(p))
                      log(f"  コメント変更: {Path(p).name}")

              # 結果JSON変更チェック
              for p, mt in curr_result.items():
                  if p not in prev_result or prev_result[p] != mt:
                      changed.append(Path(p))
                      log(f"  結果変更: {Path(p).name}")

              if changed:
                  # CSVが変わったらindex.jsonも再生成＆ALL_DATA再埋め込み
                  if csv_changed:
                      # 出走表到着 → モーター情報を同期取得 → 展示情報をバックグラウンド取得
                      changed_csv_paths = [p for p in changed if str(p).endswith(".csv")]
                      if changed_csv_paths:
                          log("  出走表更新 → モーター情報取得中...")
                          fetch_motor_for_csv(changed_csv_paths)
                          # 新規JSONが生成されたので prev_tenji を更新
                          prev_tenji = get_mtimes(str(TENJI_DIR / "*.json"))
                          # ★ 展示情報はバックグラウンドで取得
                          # （取得完了後にメインループが tenji_data/*.json の変更を検知して push）
                          # ★ 注意: fetch_tenji_for_csv は非同期のため、ここでは prev_tenji を
                          #    更新しない。スレッド完了後に次の10秒ループで変更を検知する。
                          fetch_tenji_for_csv(changed_csv_paths)
                          # ★ 展開別残存ビューアの会場・選手名を更新
                          if inject_race_entry_to_viewer(changed_csv_paths):
                              changed.append(VIEWER_HTML)
                      idx = make_csv_index()
                      changed.append(idx)
                      # ★ inject_all_data_to_html / inject_master_ext_to_html は廃止
                      # → data.jsへの埋め込みをやめ、data/*.jsonへの書き出しのみ行う

                  # ── fetch系（展示・コメント・結果）の変更を分類 ──
                  tenji_changed = any(
                      "tenji" in str(p) and str(p).endswith(".json")
                      for p in changed
                  )
                  comment_changed = any(
                      "comment" in str(p) and str(p).endswith(".json")
                      for p in changed
                  )
                  result_changed = any(
                      "result" in str(p) and str(p).endswith(".json")
                      for p in changed
                  )

                  # fetch系のみの変更（CSVなし）→ write_all_json_files をスキップして即 push
                  fetch_only = (tenji_changed or comment_changed or result_changed) and not csv_changed

                  tenji_push_done  = False
                  result_push_done = False

                  if tenji_changed or comment_changed:
                      # data/tenji_YYYYMMDD.json だけ書き直して即 push
                      write_tenji_json_file()
                      with _git_lock:
                          for tj in DATA_DIR.glob("tenji_*.json"):
                              _run_nolock(["git", "add", str(tj)])
                          code2, out2 = _run_nolock(["git", "status", "--porcelain"])
                          tracked2 = [l for l in out2.strip().splitlines() if not l.startswith("??")]
                          if tracked2:
                              tenji_summary = _summarize_push_targets(changed)
                              msg2 = f"tenji update {datetime.now().strftime('%Y-%m-%d %H:%M')} [{tenji_summary}]"
                              _enqueue_tenji_push(msg2)
                              log(f"  ✓ 展示情報 展示専用pushキューに追加 [{tenji_summary}]")
                              tenji_push_done = True

                  if result_changed and not csv_changed:
                      # data/result_YYYYMMDD.json だけ書き直して即 push
                      write_result_json()
                      with _git_lock:
                          for rj in DATA_DIR.glob("result_*.json"):
                              _run_nolock(["git", "add", str(rj)])
                          code3, out3 = _run_nolock(["git", "status", "--porcelain"])
                          tracked3 = [l for l in out3.strip().splitlines() if not l.startswith("??")]
                          if tracked3:
                              result_summary = _summarize_push_targets(changed)
                              msg3 = f"result update {datetime.now().strftime('%Y-%m-%d %H:%M')} [{result_summary}]"
                              _push_queue.put((PUSH_URGENT, next(_push_seq), "raw", None, msg3))
                              log(f"  ✓ 結果情報 pushキューに追加 [{result_summary}]")
                              result_push_done = True

                  # ── tenjihoseiplus.html（展示タイム分析ビュー）の再生成・push ──
                  # 展示情報 or 結果情報に変化があったときだけ呼ぶ（内部でも変化なしなら自動スキップする）
                  if maybe_update_tenjihoseiplus is not None and (tenji_changed or result_changed):
                      try:
                          # 締切時刻マップを構築（CSV優先→公式サイトfallback）。
                          # _build_deadline_map() のキーは「会場名（日本語）」だが、
                          # tenjihoseiplus.py 側は tenji JSON の venue（スラッグ、例: "heiwajima"）
                          # で引くため、VENUE_SLUG でキーを変換してから渡す。
                          _th_deadline_map = {}
                          try:
                              _venues_in_csv = get_venues_in_today_csvs()
                              _dl_map_ja = _build_deadline_map(_venues_in_csv)
                              _th_deadline_map = {
                                  VENUE_SLUG.get(v, v): m for v, m in _dl_map_ja.items()
                              }
                          except Exception as e:
                              log(f"  [tenjihoseiplus] ⚠ 締切時刻マップ構築失敗: {e}")

                          th_updated = maybe_update_tenjihoseiplus(
                              results_csv_dir=RESULTS_CSV_DIR,
                              tenji_dir=TENJI_DIR,
                              player_map_path=PLAYER_ID_MAP,
                              template_html=TENJIHOSEIPLUS_TEMPLATE,
                              output_html=TENJIHOSEIPLUS_HTML,
                              deadline_map=_th_deadline_map,
                          )
                      except Exception as e:
                          th_updated = False
                          log(f"  [tenjihoseiplus] ✕ 例外: {e}")
                      if th_updated:
                          with _git_lock:
                              _run_nolock(["git", "add", str(TENJIHOSEIPLUS_HTML)])
                              code4, out4 = _run_nolock(["git", "status", "--porcelain"])
                              tracked4 = [l for l in out4.strip().splitlines() if not l.startswith("??")]
                              if tracked4:
                                  msg4 = f"tenjihoseiplus update {datetime.now().strftime('%Y-%m-%d %H:%M')}"
                                  _push_queue.put((PUSH_URGENT, next(_push_seq), "raw", None, msg4))
                                  log(f"  ✓ tenjihoseiplus.html pushキューに追加")


                  # race_index取得（CSV変更時のみ）
                  # → RACE_INDEX_DATA を埋め込んだ data.js は、tenji/odds/result の
                  #   緊急pushに埋もれて後回しにされ続けないよう、ここで即座に
                  #   urgent push する（CSV本体のpushは従来通り通常優先度のまま）。
                  if csv_changed:
                      if fetch_and_inject_race_index():
                          race_index_pushed = git_push([INDEX_HTML], urgent=True)
                          if race_index_pushed:
                              log("  ✓ RACE_INDEX_DATA(data.js) 緊急pushキューに追加")

                  # CSV変更 or fetch以外の変更がある場合 → 通常の全JSON書き出し＋push
                  # fetch系のみ変更の場合は上で個別push済みのためスキップ
                  if fetch_only:
                      if tenji_push_done or result_push_done:
                          log("  fetch系のみ変更 → 個別push済み・write_all_json_files スキップ")
                      else:
                          log("  fetch系のみ変更だが差分なし → pushスキップ")
                  else:
                      # data/*.json を一括書き出し（data.jsへの埋め込みなし）
                      write_all_json_files()
                      git_push(changed)

                  prev_csv     = curr_csv
                  prev_tenji   = curr_tenji
                  prev_comment = curr_comment
                  prev_result  = curr_result

              # ── オッズJSON変更チェック（if changed: の外で独立検知）──────────────
              # オッズだけが変わってCSV・展示・結果に変化がない場合、
              # if changed: ブロックに入らず push が漏れるのを防ぐ。
              odds_changed = any(
                  p not in prev_odds or prev_odds[p] != curr_odds.get(p)
                  for p in curr_odds
              )
              if odds_changed:
                  _write_and_push_odds_json()
                  log("  オッズ情報 pushキューに追加")
              prev_odds = curr_odds
          except Exception as _loop_e:
            log(f"[ループ異常] {_loop_e} → 継続")

    except KeyboardInterrupt:
        log("\n[終了]")

if __name__ == "__main__":
    main()
