"""
prob_scenario_engine.py  —  確率計算・展開補正エンジン
========================================================
auto_push.py から計算ロジックを分離したモジュール。
GitHub連携・ファイル監視には一切関与しない。

【提供する機能】
  - マスタ読み込み・ホットリロード（load_master / apply_kimari_tuning / rebuild_master）
  - 基準確率計算（calc_prob_from_master）
  - 展示スコア計算（_calc_tenji_scores_for_race / _inject_tenji_scores）
  - 展開スコア計算（_calc_tenkai_scores）
  - ST補正・調子補正（st_rank_to_correction / form_correction）

【auto_push.py 側の変更方法】
  from prob_scenario_engine import (
      load_master, apply_kimari_tuning, rebuild_master,
      calc_prob_from_master, _inject_tenji_scores,
      normalize_name, resolve_player_name,
      MASTER,   # ← 参照のみ。更新は rebuild_master() 経由で行う
  )
"""

import json
import math
import subprocess
import sys
from pathlib import Path
from datetime import datetime

# ── パス定義（auto_push.py と同じ規則）──────────────────────────────
SCRIPTS_DIR      = Path(__file__).parent
DATA_COLLECT_DIR = Path(r"C:\Users\user\Desktop\データ収集\scripts")

# ── ロジックバージョン ────────────────────────────────────────────
# calc_prob_from_master() の計算ロジックを変更するたびに、この値も
# 必ず更新すること（日付更新でOK）。recalc_prob.py --auto は、
# 各JSONに埋め込まれた _logic_version とこの値を比較し、
# 古い（または未設定=旧ロジック）ファイルだけを自動検出して再計算する。
LOGIC_VERSION = "2026-08-10-index-aligned"

# ══════════════════════════════════════════════════════════════════
# [2026-08-10] INDEX（index.html の runPredict()）ロジックへの一本化
# ══════════════════════════════════════════════════════════════════
# 唐津6R(2026-08-10)でINDEXとZIPの1着率予想が食い違った件を受け、
# ZIPの基準1着率計算をINDEXの経験ベイズ縮小推定＋Isotonic較正に
# 完全一本化する（ユーザー判断: 完全一致優先、st_corr/form_corr/
# オッズ合成/venue_band3040バイアス等のZIP独自補正は撤去）。
#
# 【重要な制約 - 要確認】
#   INDEXは以下の3つの独自データテーブルを使っているが、今回渡された
#   MASTER（master_ext.json由来のスキーマ）にはこれらの直接の等価物が
#   見当たらなかった。そのため次の代替マッピングで実装している:
#
#   1. globalAll = DATA.categories[grade].course_excl[c]
#      （「グレード別・全国」のコース別勝率。SG/G1/G2/G3/一般/女子で別集計）
#      → MASTERに全国グレード別集計テーブルが見当たらないため、
#        venue_stats[venue].course_rates[c]（会場のコース別実測、
#        全グレード込み）で代用している。本番のmaster_data.jsonに
#        全国グレード別テーブルが別途あるなら、そちらに差し替えるべき。
#
#   2. venueCourseAgg = VENUE_COURSE_NATIONAL[venue][c] = {n, win, top3}
#      （会場×コースの「全選手合算」実測値。個人非依存）
#      → 同上のvenue_stats[venue].course_rates[c]で代用（rateのみでnが
#        無いため、このレベルのshrinkは省略し実測値をそのまま
#        venueCourseBaseWinとして使っている）。
#
#   3. VENUE_WOMEN_COURSE（女子戦専用の会場×コース集計）
#      → 同様の理由でMASTERに見当たらないため、女子戦でも上記(1)(2)と
#        同じ venue_stats[venue].course_rates[c] にフォールバックしている。
#
#   個人×コース成績（cm = course_master[name][c]）と
#   当地成績（vc = venue_course_master[name][venue][c]）は
#   MASTERに実データがあるため、INDEXのK_LANE/K_VENUEによる
#   shrinkはそのまま忠実に再現できている。
#
#   → 本番のmaster_data.jsonに(1)(2)の全国集計テーブルが実在するなら、
#      _venue_course_base_win() 内のTODOを実データに差し替えて
#      完全再現に近づけること。
USE_INDEX_ALIGNED_LOGIC = True  # False にすると旧ZIPロジック(st_corr/form_corr/オッズ合成/band補正)に戻る

K_LANE       = 20   # 個人×コース成績を「会場考慮ベース」へ縮小する重み（INDEXと同じ）
K_VENUE      = 15   # 当地成績を本人通算成績へ縮小する重み（INDEXと同じ）
K_VENUE_BASE = 300  # 会場×コース実測を全国グレード平均へ縮小する重み（INDEXと同じ定数。上記TODO(1)が本番データで埋まったら有効化）

# INDEX (index.html) の CALIB_WIN_CURVE をそのまま移植。
# Isotonic回帰による較正曲線（0〜100%を1%刻みでサンプリング、85%でキャップ）。
CALIB_WIN_CURVE = [0.0,1.5,2.5,3.7,4.1,5.4,5.6,7.1,8.1,9.4,9.5,10.9,12.0,12.1,13.0,14.8,15.3,16.6,17.3,18.4,19.7,19.7,19.9,24.5,24.5,26.1,28.0,28.0,29.4,30.5,30.5,30.5,31.3,31.3,31.3,35.1,35.1,35.1,35.5,35.5,38.0,40.6,40.6,44.6,44.6,44.6,44.9,47.8,50.1,50.6,51.2,53.9,54.1,56.1,56.2,56.4,56.4,56.5,57.0,58.7,59.6,61.7,62.5,62.5,62.5,63.8,63.8,67.5,68.3,68.3,69.1,70.1,71.4,71.4,71.4,74.7,74.7,74.7,77.1,77.1,81.4,81.4,81.4,81.4,81.8,81.8,81.8,81.8,81.8,85.0,85.0,85.0,85.0,85.0,85.0,85.0,85.0,85.0,85.0,85.0,85.0]


def shrink(n, rate, prior_rate, k):
    """INDEX(index.html)のshrink()と同一の経験ベイズ縮小推定。"""
    n = n or 0
    rate = rate or 0.0
    return (n * rate + k * (prior_rate or 0.0)) / (n + k)


def apply_win_calibration(pct):
    """INDEXのapplyCalibration()と同一（0〜100スケールのpctを受け取る）。"""
    p = max(0.0, min(100.0, pct))
    i0 = int(math.floor(p))
    i1 = min(100, i0 + 1)
    frac = p - i0
    return CALIB_WIN_CURVE[i0] + (CALIB_WIN_CURVE[i1] - CALIB_WIN_CURVE[i0]) * frac

MASTER_JSON        = DATA_COLLECT_DIR / "master_data.json"
KIMARI_TUNING_JSON = DATA_COLLECT_DIR / "kimari_tuning.json"
TENJI_DIR          = DATA_COLLECT_DIR / "tenji_data"
XLSX_PATH          = DATA_COLLECT_DIR.parent / "ボートリサーチ_マスタ.xlsx"
BUILD_MASTER_PY    = SCRIPTS_DIR / "build_master_json.py"

# 会場名 → fetch_tenji.py のURLスラッグ（auto_push.py と同一マップ）
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


# ══════════════════════════════════════════════════════════════════
# ログ（auto_push.py の log() に依存しない独立実装）
# ══════════════════════════════════════════════════════════════════
def _log(msg: str) -> None:
    print(f"[prob_engine] {msg}", flush=True)


# ══════════════════════════════════════════════════════════════════
# マスタ読み込み・ホットリロード
# ══════════════════════════════════════════════════════════════════

V2_PATTERN_TABLE_JSON = DATA_COLLECT_DIR / "v2_pattern_table.json"


def load_master() -> dict:
    if MASTER_JSON.exists():
        with open(MASTER_JSON, encoding="utf-8") as f:
            master = json.load(f)
    else:
        master = {}

    # [2026-06-29 追加] pipeline_prototype.py が生成した v2パターンテーブルをロード
    # master_data.json とは別ファイルで管理し、pipeline再実行時のみ上書きされる。
    if V2_PATTERN_TABLE_JSON.exists():
        try:
            with open(V2_PATTERN_TABLE_JSON, encoding="utf-8") as f:
                master["v2_pattern_table"] = json.load(f)
            _log(f"✓ v2_pattern_table.json ロード: {len(master['v2_pattern_table'])}パターン")
        except Exception as e:
            _log(f"⚠ v2_pattern_table.json 読み込みエラー: {e} → スキップ")

    return master



def apply_kimari_tuning(master: dict) -> dict:
    """
    kimari_tuning.json が存在すれば tune_kimari.py が算出した
    補正済み venue_kimari を master に上書きして返す。
    ファイルがなければ master をそのまま返す（無害）。
    """
    if not KIMARI_TUNING_JSON.exists():
        return master
    try:
        with open(KIMARI_TUNING_JSON, encoding="utf-8") as f:
            tuning = json.load(f)
        tuned_kimari = tuning.get("venue_kimari", {})
        if not tuned_kimari:
            return master
        master = dict(master)
        original = master.get("venue_kimari", {})
        merged   = {**original, **tuned_kimari}
        master["venue_kimari"] = merged
        built_at = tuning.get("built_at", "不明")
        _log(f"✓ kimari_tuning.json 適用: {len(tuned_kimari)}会場 (生成日時: {built_at})")
    except Exception as e:
        _log(f"⚠ kimari_tuning.json 読み込みエラー: {e} → 生の値を使用")
    return master


# モジュール読み込み時に1度だけロード
MASTER: dict = apply_kimari_tuning(load_master())


def rebuild_master() -> bool:
    """
    ボートリサーチ_マスタ.xlsx から master_data.json を再ビルドし
    グローバルの MASTER をホットリロードする。
    auto_push.py のメインループから Excelマスタ変更検知時に呼ぶ。
    """
    global MASTER
    if not XLSX_PATH.exists():
        _log(f"⚠ {XLSX_PATH.name} が見つかりません → マスタ再ビルドスキップ")
        return False
    if not BUILD_MASTER_PY.exists():
        _log(f"⚠ {BUILD_MASTER_PY.name} が見つかりません → マスタ再ビルドスキップ")
        return False

    _log("Excelマスタ更新検知 → master_data.json を再ビルド中...")
    result = subprocess.run(
        [sys.executable, str(BUILD_MASTER_PY), str(XLSX_PATH), str(MASTER_JSON)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        _log(f"✕ 再ビルド失敗: {result.stderr.strip()}")
        return False

    MASTER = apply_kimari_tuning(load_master())
    _log(f"✓ マスタ再ビルド完了 / 選手数: {len(MASTER.get('course_master', {}))}")
    return True


# ══════════════════════════════════════════════════════════════════
# 名前正規化・選手名解決
# ══════════════════════════════════════════════════════════════════

def normalize_name(name: str) -> str:
    return str(name).replace("\u3000", "").replace(" ", "").strip()


def resolve_player_name(raw_name: str, reg_no) -> tuple[str, str]:
    id_map  = MASTER.get("player_id_map", {})
    reg_str = str(reg_no).strip() if reg_no else ""
    if reg_str and reg_str in id_map:
        return id_map[reg_str], "id"
    normalized = normalize_name(raw_name)
    for official in MASTER.get("course_master", {}):
        if official.startswith(normalized):
            return official, "prefix"
    return normalize_name(raw_name), "unresolved"


# ══════════════════════════════════════════════════════════════════
# ST補正・調子補正
# ══════════════════════════════════════════════════════════════════

def st_rank_to_correction(st_rank, course: str = "1") -> float:
    """
    コース別ST順位 → 補正係数。
    [修正 2026-07-05] 全コース共通の基準値(3.0固定)・感度係数(0.048固定)を、
    master_data.json の meta.parameters.st_avg_by_course /
    st_sensitivity_by_course（コース別の実測値）に差し替え。
    旧実装は「選手個人のst_rankは見ているが、比較対象の基準値・感度が
    全コース一律」だったため、1コースはST差の影響が強く・6コースは
    弱いという実態を無視して補正がねじれていた。
    例: 1コースは基準3.14・感度0.15、6コースは基準4.04・感度0.03。
    """
    if st_rank is None:
        return 1.0
    params      = MASTER.get("meta", {}).get("parameters", {})
    baseline    = params.get("st_avg_by_course", {}).get(course, 3.0)
    sensitivity = params.get("st_sensitivity_by_course", {}).get(course, 0.048)
    raw = 1.0 + (baseline - st_rank) * sensitivity
    return max(0.82, min(1.12, raw))


def form_correction(player_idx: dict | None, overall_win) -> float:
    """
    選手の調子補正係数を返す。
    FLY明け補正（最優先）→ bayesian_win ベース4段階評価。
    """
    if not player_idx:
        return 1.0
    # ① FLY明け補正
    fly_days       = player_idx.get("fly_days")
    fly_after_runs = player_idx.get("fly_after_runs") or 0
    if fly_days is not None and fly_after_runs < 10:
        return 0.85
    # ② bayesian_win
    bayesian = player_idx.get("bayesian_win")
    base     = overall_win or player_idx.get("overall_win")
    if bayesian is None or not base or base <= 0:
        return 1.0
    ratio = bayesian / base
    # [2026-06-25] 過大評価抑制: base_rate×st_corr×form_corrの乗算増幅を緩和
    # 上限を1.08→1.05、1.04→1.02に絞る。下側は据え置き（抑制方向は安全）
    if   ratio >= 1.20: return 1.05   # 旧1.08 → 絞り込み
    elif ratio >= 1.08: return 1.02   # 旧1.04 → 絞り込み
    elif ratio <= 0.80: return 0.92
    elif ratio <= 0.92: return 0.96
    else:               return 1.00


# ══════════════════════════════════════════════════════════════════
# 会場別 被kimari補正強度
# ⚠️ SYNC REQUIRED: sample.js の VENUE_HI_KIMARI_STRENGTH と同一に保つこと
# ══════════════════════════════════════════════════════════════════

_VENUE_HI_KIMARI_STRENGTH = {
    "大村": 1.5, "常滑": 1.5, "丸亀": 1.5, "尼崎": 1.5,
    "住之江": 1.5, "桐生": 1.5, "下関": 1.5,
    "戸田": 2.5, "三国": 2.5, "平和島": 2.5, "浜名湖": 2.5, "蒲郡": 2.5,
    "江戸川": 2.0,
    "_default": 2.0,
}


def _get_hi_kimari_strength(venue: str) -> float:
    return _VENUE_HI_KIMARI_STRENGTH.get(venue, _VENUE_HI_KIMARI_STRENGTH["_default"])


# ══════════════════════════════════════════════════════════════════
# 展示スコア計算
# ⚠️ SYNC REQUIRED: sample.js の VENUE_TENJI_CONFIG と同一に保つこと
# ══════════════════════════════════════════════════════════════════

_VENUE_TENJI_CONFIG = {
    "江戸川": {
        "available": {"lap1": False,   "mawari": False, "chokusen": False, "tenji": True},
        "weight":    {"lap1": 0.0,     "mawari": 0.0,   "chokusen": 0.0,   "tenji": 1.0},
    },
    "桐生": {
        "available": {"lap1": "half",  "mawari": True,  "chokusen": True,  "tenji": True},
        "weight":    {"lap1": 2.25,    "mawari": 0.0,   "chokusen": 1.0,   "tenji": 2.0},
    },
    "尼崎": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": False,  "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
    "住之江": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": False,  "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
    "徳山": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": False,  "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
    "蒲郡": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 0.0,   "chokusen": 1.0,   "tenji": 2.0},
    },
    "戸田": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 0.0,   "chokusen": 1.0,   "tenji": 2.0},
    },
    "三国": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 0.0,   "chokusen": 1.0,   "tenji": 2.0},
    },
    "平和島": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 0.0,   "chokusen": 1.0,   "tenji": 2.0},
    },
    "浜名湖": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 0.0,   "chokusen": 1.0,   "tenji": 2.0},
    },
    "宮島": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
    "下関": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
    "若松": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
    "大村": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
    "常滑": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
    "丸亀": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
    "_default": {
        "available": {"lap1": True,    "mawari": True,  "chokusen": True,   "tenji": True},
        "weight":    {"lap1": 4.5,     "mawari": 1.0,   "chokusen": 0.0,   "tenji": 2.0},
    },
}

_TENJI_FIELDS = ["lap1", "mawari", "chokusen", "tenji"]


def _resolve_tenji_weights(venue: str) -> dict:
    """sample.js resolveWeights() の完全移植。"""
    cfg   = _VENUE_TENJI_CONFIG.get(venue, _VENUE_TENJI_CONFIG["_default"])
    base  = dict(cfg["weight"])
    avail = cfg["available"]
    for f in _TENJI_FIELDS:
        if avail.get(f) is False:
            base[f] = 0.0
    total = sum(base.values()) or 1.0
    return {f: base[f] / total for f in _TENJI_FIELDS}


def _time_to_coef(h: float) -> float:
    """sample.js timeToCoef() の完全移植。"""
    if h >= 60: return 1.15
    if h >= 55: return 1.08
    if h >= 45: return 1.00
    if h >= 40: return 0.93
    return 0.85


def _field_coefs(boats: list, tenji_by_frame: dict, field: str) -> list | None:
    """sample.js fieldCoefs() の完全移植。"""
    vals       = [tenji_by_frame.get(b["boat"], {}).get(field) for b in boats]
    valid_vals = [v for v in vals if v is not None]
    if not valid_vals:
        return None
    fill_avg = sum(valid_vals) / len(valid_vals)
    filled   = [v if v is not None else fill_avg for v in vals]
    avg      = sum(filled) / len(filled)
    variance = sum((v - avg) ** 2 for v in filled) / len(filled)
    std      = variance ** 0.5
    if std == 0:
        return [1.0] * len(filled)
    return [_time_to_coef(50 + ((avg - v) / std) * 10) for v in filled]


def _calc_tenji_scores_for_race(boats: list, tenji_by_frame: dict, venue: str) -> None:
    """
    各 boat dict に tenji_score・tenji_score_coef を付与する（インプレース）。
    展示データがない場合は何もしない。
    """
    w = _resolve_tenji_weights(venue)
    coefs_map = {}
    for f in _TENJI_FIELDS:
        if w[f] <= 0:
            continue
        c = _field_coefs(boats, tenji_by_frame, f)
        if c is not None:
            coefs_map[f] = c

    if not coefs_map:
        return

    composite = []
    for i in range(len(boats)):
        score, w_total = 0.0, 0.0
        for f in _TENJI_FIELDS:
            if f not in coefs_map:
                continue
            score   += w[f] * coefs_map[f][i]
            w_total += w[f]
        composite.append(score / w_total if w_total > 0 else 1.0)

    coef_total = sum(composite) or 1.0
    coef_avg   = coef_total / len(boats)

    for i, bt in enumerate(boats):
        bt["tenji_score"] = round(composite[i] / coef_total, 6)
        bt["tenji_score_coef"] = round(
            min(2.0, max(0.5, composite[i] / coef_avg)) if coef_avg > 0 else 1.0, 4
        )


def _inject_tenji_scores(races: dict, venue: str, date_str: str) -> None:
    """
    tenji_data/*.json を読み込み各レースの boats に tenji_score を付与する。
    parse_csv() の return 直前から呼ぶ。
    """
    slug    = VENUE_SLUG.get(venue, venue)
    date_nd = date_str.replace("-", "")
    loaded  = 0

    for rno, rd in races.items():
        fpath = TENJI_DIR / f"tenji_{slug}_{date_nd}_R{rno}.json"
        if not fpath.exists():
            continue
        try:
            with open(fpath, encoding="utf-8") as f:
                rows = json.load(f)
        except Exception:
            continue
        tenji_by_frame = {r["frame"]: r for r in rows}
        _calc_tenji_scores_for_race(rd["boats"], tenji_by_frame, venue)
        loaded += 1

    if loaded:
        _log(f"✓ 展示スコア付与: {venue} {date_str}  {loaded}R分")


# ══════════════════════════════════════════════════════════════════
# 展開スコア計算（sample.js calcTenkaiProbs の Python移植）
# ══════════════════════════════════════════════════════════════════

def _calc_tenkai_scores(boats: list, venue: str) -> list:
    """
    各 boat dict に tenkai_score を付与して返す。
    MASTER の venue_kimari・course_master を参照する。
    """
    venue_kimari_all = MASTER.get("venue_kimari", {})
    course_master    = MASTER.get("course_master", {})

    if not venue_kimari_all:
        for bt in boats:
            bt["tenkai_score"] = bt["prob"]
        return boats

    vKimari = venue_kimari_all.get(venue)
    if not vKimari:
        for bt in boats:
            bt["tenkai_score"] = bt["prob"]
        return boats

    KIMARI_HARD_EXCLUDE = {
        "逃げ":       {"2","3","4","5","6"},
        "差し":       {"1"},
        "まくり":     {"1"},
        "まくり差し": {"1","2"},
        "抜き":       set(),
    }
    KIMARI_SOFT_THRESHOLD = {
        "まくり": {"2": 0.05},
        "抜き":   {"1": 0.03},
    }
    RELATIVE_MIN           = 0.3
    RELATIVE_MAX           = 3.0
    PERSONAL_BLEND_STRENGTH = 0.7

    def get_personal_kimari(name, course_str, kimari_type):
        return (course_master.get(name, {})
                             .get(course_str, {})
                             .get("kimari", {})
                             .get(kimari_type, 0))

    def get_personal_hi_kimari(name, hi_type):
        return (course_master.get(name, {})
                             .get("1", {})
                             .get("被kimari", {})
                             .get(hi_type))

    def is_valid_first(bt, kimari):
        wc  = str(int(bt["boat"]))
        exc = KIMARI_HARD_EXCLUDE.get(kimari)
        if exc is None:
            return False
        if wc in exc:
            return False
        soft = KIMARI_SOFT_THRESHOLD.get(kimari, {})
        if wc in soft:
            return get_personal_kimari(bt["name"], wc, kimari) >= soft[wc]
        return True

    def calc_relative_coef(winner, kimari, boat1):
        if boat1 is None:
            return 1.0
        wc = str(int(winner["boat"]))
        if kimari == "逃げ":
            nige = get_personal_kimari(winner["name"], "1", "逃げ")
            return nige if nige > 0 else 1.0
        if kimari == "差し":
            attack = get_personal_kimari(winner["name"], wc, "差し")
            def_r  = get_personal_hi_kimari(boat1["name"], "差され")
            return (attack * def_r) if def_r is not None else (attack or 1.0)
        if kimari == "まくり":
            attack = get_personal_kimari(winner["name"], wc, "まくり")
            def_r  = get_personal_hi_kimari(boat1["name"], "捲られ")
            return (attack * def_r) if def_r is not None else (attack or 1.0)
        if kimari == "まくり差し":
            attack = get_personal_kimari(winner["name"], wc, "まくり差し")
            def1   = get_personal_hi_kimari(boat1["name"], "捲り差され")
            boat2  = next((b for b in boats if int(b["boat"]) == 2), None)
            def2   = get_personal_hi_kimari(boat2["name"], "捲り差され") if boat2 else None
            if def1 is not None and def2 is not None:
                combined_def = (def1 * def2) ** 0.5
                return attack * combined_def if attack else combined_def
            elif def1 is not None:
                return (attack * def1) if def1 is not None else (attack or 1.0)
            else:
                return attack or 1.0
        return 1.0

    boat1 = next((b for b in boats if int(b["boat"]) == 1), None)

    # 被kimari率で adjustedVKimari を動的補正
    hi_strength     = _get_hi_kimari_strength(venue)
    adjustedVKimari = dict(vKimari)

    if boat1:
        name1      = boat1["name"]
        hi_kimari  = (course_master.get(name1, {}).get("1", {}).get("被kimari"))
        boat1_runs = (course_master.get(name1, {}).get("1", {}).get("runs", 0) or 0)
        if hi_kimari and boat1_runs >= 30:
            hi_trust        = min(boat1_runs / 100, 1.0)
            sasare_rate     = hi_kimari.get("差され")
            makurare_rate   = hi_kimari.get("捲られ")
            makurisasare_r  = hi_kimari.get("捲り差され")
            if sasare_rate is not None:
                adjustedVKimari["差し"] = (
                    vKimari.get("差し", 0) * (1 + hi_trust * sasare_rate * hi_strength))
            if makurare_rate is not None:
                adjustedVKimari["まくり"] = (
                    vKimari.get("まくり", 0) * (1 + hi_trust * makurare_rate * hi_strength))
            if makurisasare_r is not None:
                adjustedVKimari["まくり差し"] = (
                    vKimari.get("まくり差し", 0) * (1 + hi_trust * makurisasare_r * hi_strength))
            total_hi  = ((sasare_rate or 0) + (makurare_rate or 0) + (makurisasare_r or 0))
            nige_rate = get_personal_kimari(name1, "1", "逃げ")
            if nige_rate > 0:
                nige_boost = nige_rate / max(nige_rate + total_hi, 0.01)
                adjustedVKimari["逃げ"] = (
                    vKimari.get("逃げ", 0) * (0.5 + 0.5 * nige_boost * 2))
            adj_total = sum(adjustedVKimari.values())
            if adj_total > 0:
                adjustedVKimari = {k: v / adj_total for k, v in adjustedVKimari.items()}

    kimari_types = [k for k, v in adjustedVKimari.items()
                    if v > 0 and k in KIMARI_HARD_EXCLUDE]

    def blend_personal_kimari(bt, base_vkimari):
        name   = bt["name"]
        course = str(int(bt["boat"]))
        cm     = course_master.get(name, {}).get(course, {})
        if not cm:
            return base_vkimari
        runs = cm.get("runs", 0) or 0
        if runs < 30:
            return base_vkimari
        trust           = min(runs / 100, 1.0) * PERSONAL_BLEND_STRENGTH
        personal_kimari = cm.get("kimari", {})
        BLEND_TARGETS   = ["差し", "まくり", "まくり差し", "抜き"]
        personal_total  = sum(personal_kimari.get(k, 0) for k in BLEND_TARGETS)
        if personal_total <= 0:
            return base_vkimari
        blend_base_sum = sum(base_vkimari.get(k, 0) for k in BLEND_TARGETS)
        blended = dict(base_vkimari)
        for k in BLEND_TARGETS:
            if k not in blended:
                continue
            personal_rate = (personal_kimari.get(k, 0) / personal_total) * blend_base_sum
            blended[k] = base_vkimari[k] * (1 - trust) + personal_rate * trust
        orig_total  = sum(base_vkimari.values())
        blend_total = sum(blended.values())
        if blend_total > 0:
            blended = {k: v / blend_total * orig_total for k, v in blended.items()}
        return blended

    boat_vkimari    = {bt["boat"]: blend_personal_kimari(bt, adjustedVKimari) for bt in boats}
    kimari_coef_sum = {bt["boat"]: 0.0 for bt in boats}

    for kimari in kimari_types:
        rel_coefs   = {}
        valid_boats = [b for b in boats if is_valid_first(b, kimari)]
        if not valid_boats:
            continue
        for bt in boats:
            if not is_valid_first(bt, kimari):
                rel_coefs[bt["boat"]] = 0.0
                continue
            raw_coef    = calc_relative_coef(bt, kimari, boat1)
            kimari_runs = (course_master.get(bt["name"], {})
                                        .get(str(int(bt["boat"])), {})
                                        .get("runs", 0) or 0)
            personal_trust         = min(kimari_runs / 100, 1.0)
            rel_coefs[bt["boat"]]  = raw_coef * personal_trust + 1.0 * (1 - personal_trust)

        avg_coef = sum(rel_coefs[b["boat"]] for b in valid_boats) / len(valid_boats)
        if avg_coef <= 0:
            continue

        for bt in boats:
            if is_valid_first(bt, kimari):
                kimari_prob = boat_vkimari[bt["boat"]].get(kimari, 0)
                if kimari_prob <= 0:
                    continue
                norm_coef = min(RELATIVE_MAX, max(RELATIVE_MIN,
                                rel_coefs[bt["boat"]] / avg_coef))
                kimari_coef_sum[bt["boat"]] += kimari_prob * norm_coef
            else:
                kimari_prob = adjustedVKimari.get(kimari, 0)
                kimari_coef_sum[bt["boat"]] += kimari_prob * RELATIVE_MIN

    raw_scores = {bt["boat"]: bt["prob"] * (kimari_coef_sum[bt["boat"]] or RELATIVE_MIN)
                  for bt in boats}

    # ══════════════════════════════════════════════════════════════════
    # [2026-06-29 追加] 連動ペア（まくり→まくり差し）ボーナス
    #
    # pipeline_prototype.py の実績分析結果:
    #   連動先(まくり差し型)が3着以内に来た割合: 86.3%（ランダム60%比 +26%pt）
    # → まくり型艇が存在するレースでまくり差し型艇に確率ボーナスを付与する。
    #
    # ボーナス強度 CHAIN_BONUS:
    #   3着以内 +26%pt のシグナルを1着率に換算するため保守的に 0.08 に設定。
    #   (86.3%−60%) ÷ 3着枠数 ≒ 8.7% → 0.08 にクリップ。
    # ゼロサム保証:
    #   ボーナス付与後に全艇を再正規化するため合計は常に変わらない。
    # ══════════════════════════════════════════════════════════════════
    CHAIN_BONUS = 0.08  # まくり差し連動艇への1着率ボーナス（0.05〜0.12 が実用範囲）

    # まくり実績がある艇（攻め型 = まくり率>0）を検出
    has_makuri_boats = [
        bt for bt in boats
        if bt["boat"] != 1
        and course_master.get(bt["name"], {}).get(str(bt["boat"]), {}).get("kimari", {}).get("まくり", 0) > 0
    ]
    # まくり差し実績がある艇（連動先候補）を検出
    has_makurisashi_boats = [
        bt for bt in boats
        if bt["boat"] != 1
        and course_master.get(bt["name"], {}).get(str(bt["boat"]), {}).get("kimari", {}).get("まくり差し", 0) > 0
    ]

    if has_makuri_boats and has_makurisashi_boats:
        # 連動するペアが存在するレース → まくり差し型艇のスコアにボーナスを乗算
        for bt in has_makurisashi_boats:
            # まくり差し個人実績を信頼度スケールに変換（30走以上で有効）
            ms_runs = course_master.get(bt["name"], {}).get(str(bt["boat"]), {}).get("runs", 0) or 0
            ms_rate = course_master.get(bt["name"], {}).get(str(bt["boat"]), {}).get("kimari", {}).get("まくり差し", 0)
            if ms_runs < 10 or ms_rate <= 0:
                continue  # データ不足はスキップ
            trust = min(ms_runs / 80, 1.0)  # 80走で最大信頼
            effective_bonus = 1.0 + CHAIN_BONUS * trust * min(ms_rate * 3, 1.0)
            raw_scores[bt["boat"]] = raw_scores[bt["boat"]] * effective_bonus

    # ══════════════════════════════════════════════════════════════════
    # [2026-06-29 追加] v2パターンテーブル ルックアップ補正
    #
    # pipeline_prototype.py が生成した out/v2_pattern_table.json を
    # MASTER に格納した場合に、1号艇タイプ × 筆頭威力艇 × 連動有無に応じて
    # 1号艇・筆頭威力艇の raw_scores を実績1着率に寄せるブレンドを行う。
    #
    # ブレンド強度 V2_BLEND:
    #   reliable=True（n≧500）なら 0.35（実績35%混ぜ込み）
    #   reliable=False（n<500）  なら 0.15（保守的）
    # テーブルなし/パターン未一致の場合は何もしない（既存ロジックのまま）。
    # ══════════════════════════════════════════════════════════════════
    v2_table = MASTER.get("v2_pattern_table")
    if v2_table and boat1:
        # 1号艇ラベルを特定
        snap1 = {"n": course_master.get(boat1["name"], {}).get("1", {}).get("runs", 0),
                 "rates": None}
        runs1 = course_master.get(boat1["name"], {}).get("1", {}).get("runs", 0) or 0
        if runs1 >= 8:
            kimari1 = course_master.get(boat1["name"], {}).get("1", {}).get("kimari", {})
            total1  = sum(kimari1.values()) or 1
            nige_r  = kimari1.get("逃げ", 0) / total1 if total1 > 0 else 0
            if nige_r >= 0.5:
                b1_label = "粘り型"
            else:
                beta_map  = {"差し": "差され型", "まくり": "まくられ型",
                             "まくり差し": "まくり差され型", "抜き": "抜かれ型"}
                top_k = max(beta_map.keys(), key=lambda k: kimari1.get(k, 0))
                b1_label = beta_map.get(top_k, "その他")

            # 筆頭威力艇（1号艇以外で「決まり手威力」が最も高い艇）
            # [2026-07-02 修正] boosts が定義されないまま参照されており
            # NameError で calc_prob_from_master が必ず落ちるバグを修正。
            # kimari_coef_sum（決まり手種別ごとの威力を合算したスコア、
            # 基礎prob非依存）を「威力」の定義として採用。
            # ※ 本来の設計意図が別変数だった可能性はあるため、
            #    v2_pattern_table によるブレンド結果が想定と違う場合は
            #    ここの定義を見直してください。
            boosts = {b: v for b, v in kimari_coef_sum.items() if b != 1}
            if boosts:
                top_direct = max(boosts, key=boosts.get)
                td_bt      = next((b for b in boats if b["boat"] == top_direct), None)
                if td_bt:
                    td_course  = str(top_direct)
                    td_kimari_map = course_master.get(td_bt["name"], {}).get(td_course, {}).get("kimari", {})
                    td_top_k   = max(["差し", "まくり", "まくり差し"],
                                     key=lambda k: td_kimari_map.get(k, 0))
                    chain_flag = "連動有" if (has_makuri_boats and has_makurisashi_boats) else "連動無"
                    pk = f"1号[{b1_label}] | 筆頭[{top_direct}号:{td_top_k}] | {chain_flag}"

                    entry = v2_table.get(pk)
                    if entry:
                        is_reliable = entry.get("reliable", False)
                        V2_BLEND = 0.35 if is_reliable else 0.15

                        # [修正 2026-07-05] サンプル数不足(n<500)のパターンで
                        # ブレンドした場合、該当レース全艇に「予測不適正」警告
                        # フラグを付与する。has_insufficientによるTrueは上書き
                        # しない（Trueへの追加のみ・Falseへの後戻りはしない）。
                        if not is_reliable:
                            for wbt in boats:
                                wbt["prob_warning"] = True
                                wbt.setdefault("prob_warning_reason", [])
                                if "low_sample_pattern" not in wbt["prob_warning_reason"]:
                                    wbt["prob_warning_reason"].append("low_sample_pattern")

                        # 1号艇: 実績boat1_rateに向けてブレンド
                        target1   = entry["boat1_rate"]
                        cur_total = sum(raw_scores.values()) or 1.0
                        cur1_share = raw_scores.get(1, 0) / cur_total
                        blended1   = cur1_share * (1 - V2_BLEND) + target1 * V2_BLEND
                        raw_scores[1] = blended1  # 再正規化前なのでscaleは後で揃う

                        # 筆頭威力艇: 実績force1_rateに向けてブレンド
                        target_f1   = entry["force1_rate"]
                        cur_f1_share = raw_scores.get(top_direct, 0) / cur_total
                        blended_f1  = cur_f1_share * (1 - V2_BLEND) + target_f1 * V2_BLEND
                        raw_scores[top_direct] = blended_f1

    total_ts   = sum(raw_scores.values()) or 1.0
    for bt in boats:
        bt["tenkai_score"] = round(raw_scores[bt["boat"]] / total_ts, 6)
    return boats


# ══════════════════════════════════════════════════════════════════
# 会場別 30〜40%帯 過大評価バイアス補正
#
# スクリーンショット診断（2026-06-25）より:
#   推定30〜40%帯 → 実績的中率45.0%（目標35%）= 過大評価が系統的に存在
#   会場別内訳: 尼崎0%, 徳山0% など特に過大評価が著しい会場がある一方、
#              三国60%, 宮島55% などは目標値を超えた過小評価状態
#
# 設計:
#   各会場の実績中率 / 目標値(35%) を補正係数として使用する区分線形補間。
#   データ件数が少ない（<5件）会場は全国デフォルト（1.0）にフォールバック。
#   prob 帯が 0.30〜0.40 の艇に限定して乗算後、全艇を再正規化するため
#   合計は常に 1.0 に保たれる（ゼロサム保証）。
#
# 補正係数 = 実績率 / 目標率(0.35)
#   1.0未満 → 過大評価の会場（確率を引き下げ）
#   1.0超過 → 過小評価の会場（確率を引き上げ）
#   クリップ: [0.60, 1.40] で極端な値を防ぐ
# ══════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════
# [2026-07-02] 無効化（dynamic_venue_band3040.js へ移管）
#
#   このテーブルは2026-06-25の1回限りのスクショ（会場ごと数件〜十数件）を
#   固定値化したもの。1週間後（2026-07-02）の実績と比較すると徳山・三国など
#   複数会場で過大評価⇔過小評価の方向自体が反転しており、固定係数がむしろ
#   逆効果になっているケースを確認した。
#
#   補正の役割はフロントエンドの dynamic_venue_band3040.js に移管した。
#   そちらは会場×hitProbEstの実績をローリング集計し、サンプル数に応じて
#   ウェイトを連動させながら自己学習するため、この静的テーブルより追従性が
#   高い。二重補正を避けるため、ここでは無効化する（_apply_venue_band3040_bias
#   は早期returnでno-opになる）。
#
#   再有効化する場合は _VENUE_BAND3040_ENABLED を True に戻すこと。
#   ただしテーブルの値自体は2026-06-25時点のまま更新していないため、
#   再有効化前に最新データで係数を洗い直すこと。
# ══════════════════════════════════════════════════════════════════
_VENUE_BAND3040_ENABLED = False

# スクリーンショットの実績値から算出（件数5件未満は None → スキップ）
# 実績値 / 0.35（目標値）= 補正係数の根拠
# [2026-07-02] 無効化中（_VENUE_BAND3040_ENABLED = False）。参考値として残置。
_VENUE_BAND3040_COEF: dict[str, float | None] = {
    "尼崎":   0.00 / 0.35,   # 2件   → 小サンプル（要注意: 将来的にはサンプル増で更新）
    "徳山":   0.00 / 0.35,   # 3件   → 小サンプル
    "大村":   0.22 / 0.35,   # 9件
    "芦屋":   0.25 / 0.35,   # 4件   → 小サンプル
    "鳴門":   0.29 / 0.35,   # 7件
    "住之江": 0.30 / 0.35,   # 10件
    "平和島": 0.33 / 0.35,   # 3件   → 小サンプル
    "多摩川": 0.38 / 0.35,   # 8件
    "福岡":   0.38 / 0.35,   # 8件
    "浜名湖": 0.43 / 0.35,   # 7件
    "児島":   0.45 / 0.35,   # 11件
    "常滑":   0.46 / 0.35,   # 13件
    "廐津":   0.50 / 0.35,   # 2件   → 小サンプル
    "津":     0.50 / 0.35,   # 2件   → 小サンプル
    "桐生":   0.50 / 0.35,   # 4件   → 小サンプル
    "びわこ": 0.53 / 0.35,   # 15件
    "宮島":   0.55 / 0.35,   # 11件
    "下関":   0.56 / 0.35,   # 9件
    "三国":   0.60 / 0.35,   # 10件
    "戸田":   0.60 / 0.35,   # 5件
    "蒲郡":   0.63 / 0.35,   # 8件
    "丸亀":   0.67 / 0.35,   # 6件
    "若松":   0.67 / 0.35,   # 3件   → 小サンプル
    "_default": 1.0,
}
# 件数が少ない会場（スクショで<5件）の係数を緩和してデフォルトにブレンド
_VENUE_BAND3040_LOW_SAMPLE: set[str] = {"尼崎", "芦屋", "平和島", "廐津", "津", "桐生", "若松", "徳山"}
_VENUE_BAND3040_BLEND_RATIO = 0.40  # 低サンプル会場は実績40%+デフォルト60%


def _apply_venue_band3040_bias(boats: list, venue: str) -> list:
    """
    prob が 0.30〜0.40 の帯に属する艇に会場別バイアス係数を乗算し、
    全艇を再正規化して返す（インプレース更新）。

    [2026-06-26] スキップ条件:
      1号艇 prob が全体2位との差 >= 0.15（= 突出メンバー）の場合は補正をかけない。
      band3040_bias は「平均的な1号艇が過大評価されていた」実績から導出した係数であり、
      峰竜太クラスの支配的な1号艇に無差別適用すると逆バイアスになる。

    [2026-07-02] _VENUE_BAND3040_ENABLED = False のため無効化中。
      補正はフロントエンドの dynamic_venue_band3040.js（hitProbEstベース・
      自己学習）に移管済み。詳細はテーブル直前のコメント参照。
    """
    if not _VENUE_BAND3040_ENABLED:
        return boats  # 無効化中: 常にno-op（フロント側 dynamic_venue_band3040.js が補正を担当）

    # ── 突出1号艇スキップ判定 ──
    sorted_probs = sorted([bt.get("prob", 0) for bt in boats], reverse=True)
    boat1_prob   = next((bt.get("prob", 0) for bt in boats if int(bt.get("boat", 0)) == 1), None)
    if (boat1_prob is not None
            and len(sorted_probs) >= 2
            and boat1_prob == sorted_probs[0]           # 1号艇がトップ
            and boat1_prob - sorted_probs[1] >= 0.15):  # 2位と15%以上の差
        return boats  # 突出メンバーは補正スキップ

    raw_coef = _VENUE_BAND3040_COEF.get(venue, _VENUE_BAND3040_COEF["_default"])

    # 低サンプル会場はデフォルト(1.0)とブレンドして係数を緩和
    if venue in _VENUE_BAND3040_LOW_SAMPLE:
        raw_coef = raw_coef * _VENUE_BAND3040_BLEND_RATIO + 1.0 * (1 - _VENUE_BAND3040_BLEND_RATIO)

    # クリップ: 極端な補正を防ぐ
    coef = max(0.60, min(1.40, raw_coef))

    if abs(coef - 1.0) < 0.001:
        return boats  # 補正不要

    for bt in boats:
        prob = bt.get("prob", 0)
        if 0.30 <= prob <= 0.40:
            bt["prob"] = prob * coef

    # 全体再正規化（ゼロサム保証）
    total = sum(bt.get("prob", 0) for bt in boats) or 1.0
    for bt in boats:
        bt["prob"] = round(bt["prob"] / total, 4)

    return boats


# ══════════════════════════════════════════════════════════════════
# 基準確率計算（コース別1着率 → prob）
# ══════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════
# [2026-07-20 追加] 実績の薄い選手を会場平均へ滑らかに縮小するヘルパー
#
# 【背景】従来は course_master / venue_course_master の reliable フラグ
#   （20走が基準。グレードメイン1走・女子8走）で「使う/使わない」の
#   二択になっており、reliable=False の場合は個人データを完全に無視して
#   会場のそのコース平均（race_course_rates / venue_course_rates）を
#   そのまま base_rate に採用していた。
#
#   これは「実績のない選手」を暗黙に「平均的な実力の選手」として扱う
#   ことになり、st_corr / form_corr も個人データが無ければ 1.0（中立）
#   になるため、補正の全段階で下振れさせる仕組みがどこにも無かった。
#   少ないサンプルの勝率は分散が大きく、平均へ縮小（シュリンケージ）
#   するのが統計的に妥当（build_master_json.py の bayesian_win_rate と
#   同じ発想）だが、その縮小が「個人データの量」に応じて連続的に
#   効くようにはなっていなかった。
#
# 【方針】build_master_json.py の calc_wco_trust と同じ対数補間方式で、
#   出走数(runs)に応じて0〜1の信頼度(trust)を算出し、
#   個人勝率と会場平均を trust で連続的にブレンドする。
#   runs=0（本当にデータが無い）場合のみ、従来通り会場平均のみを使う。
# ══════════════════════════════════════════════════════════════════
_SHRINK_MIN_RUNS = 3   # これ未満は trust=0.0（会場平均のみ）
_SHRINK_AT_MIN_TRUST = 0.0

# [2026-07-21] 【非推奨】以下の _smooth_personal_trust / _shrink_to_pop は
# calc_prob_from_master() が固定比率ブレンド(全国50/会場30/直近10走20)に
# 変更されたことに伴い、現在は呼び出されていない（デッドコード）。
# 「個人データあり」判定の _SHRINK_MIN_RUNS 定数のみ引き続き使用中。
# 将来動的trustブレンドに戻す可能性を考慮し、関数自体は残置する。


def _smooth_personal_trust(runs, min_runs: int = _SHRINK_MIN_RUNS, full_runs: int = 20) -> float:
    """出走数(runs) → 信頼度(0.0〜1.0) を対数補間で算出する。

    runs < min_runs         → 0.0（個人データは使わず会場平均のみ）
    runs >= full_runs        → 1.0（個人データを全面採用）
    min_runs 〜 full_runs    → 対数補間で滑らかに増加
    """
    if not runs or runs <= 0:
        return 0.0
    if runs < min_runs:
        return 0.0
    full_runs = max(full_runs, min_runs + 1)  # ゼロ割防止
    if runs >= full_runs:
        return 1.0
    t = math.log(runs / min_runs) / math.log(full_runs / min_runs)
    return round(max(0.0, min(1.0, t)), 4)


def _shrink_to_pop(raw_rate, runs, pop_avg, full_runs: int = 20):
    """個人勝率(raw_rate)を出走数(runs)に応じた信頼度で会場平均(pop_avg)へ
    縮小ブレンドする。raw_rate や runs が無ければ None を返す
    （呼び出し側で従来通りの空欄扱いにするため）。
    """
    if raw_rate is None or not runs or runs <= 0:
        return None
    trust = _smooth_personal_trust(runs, full_runs=full_runs)
    if pop_avg is None:
        return raw_rate  # 会場平均が取れない場合は個人値をそのまま使う（従来通り）
    return raw_rate * trust + pop_avg * (1.0 - trust)


def _calc_prob_from_master_legacy(
    boats: list,
    venue: str,
    race_no: int = 0,
    is_joshi: bool = False,
    grade: str = "一般",
) -> list:
    """
    [旧ロジック] 選手ごとのコース別1着率 → prob を計算して boats に付与する。
    st_corr/form_corr/オッズ空間合成/venue_band3040バイアス補正を含む
    ZIP独自方式（2026-07-22版）。USE_INDEX_ALIGNED_LOGIC=False で使われる。
    バックテスト比較用に残してある。

    grade 優先順位:
      SG / G1  → course_master_g1（reliable=False は一般マスタにフォールバック）
      女子戦   → course_master_joshi
      その他   → course_master（一般戦）
    """
    course_master_g1    = MASTER.get("course_master_g1", {})
    course_master_joshi = MASTER.get("course_master_joshi", {})
    course_master_base  = MASTER.get("course_master", {})

    IS_GRADE_MODE = grade in ("SG", "G1") and bool(course_master_g1)

    def _get_course_entry(name, c):
        if IS_GRADE_MODE:
            entry_g1 = course_master_g1.get(name, {}).get(c)
            if entry_g1 and entry_g1.get("reliable", False):
                return entry_g1
            return course_master_base.get(name, {}).get(c)
        if is_joshi and course_master_joshi:
            entry_j = course_master_joshi.get(name, {}).get(c)
            if entry_j and entry_j.get("reliable", False):
                return entry_j
            return course_master_base.get(name, {}).get(c)
        return course_master_base.get(name, {}).get(c)

    if IS_GRADE_MODE:
        course_master = course_master_g1
    elif is_joshi and course_master_joshi:
        course_master = course_master_joshi
    else:
        course_master = course_master_base

    venue_course_master = MASTER.get("venue_course_master", {})
    venue_stats         = MASTER.get("venue_stats", {}).get(venue, {})
    player_index        = MASTER.get("player_index", {})
    race_key            = str(race_no) if race_no else None
    race_course_rates   = (
        venue_stats.get("race_course_rates", {}).get(race_key, {})
        if race_key else {}
    )
    venue_course_rates  = venue_stats.get("course_rates", {})
    scores, dq_list, base_rates = [], [], []
    has_insufficient = False

    # [2026-06-26] 1号艇突出判定用に全艇の overall_win を事前収集して付与
    for bt in boats:
        _nm = normalize_name(bt.get("name", ""))
        _pi = player_index.get(_nm)
        bt["_overall_win"] = (_pi.get("overall_win") or 0.0) if _pi else 0.0

    for bt in boats:
        name   = normalize_name(bt.get("name", ""))
        course = int(bt.get("boat", 1))
        c      = str(course)
        base_rate, dq = None, None

        vc = venue_course_master.get(name, {}).get(venue, {}).get(c)
        cm = _get_course_entry(name, c)

        # ── 母集団平均（会場のそのコース平均）を先に確保 ──
        # 個人データが全く無い場合の最終フォールバックに使う。
        pop_avg = race_course_rates.get(c)
        if pop_avg is None:
            pop_avg = venue_course_rates.get(c)

        cm_runs = (cm.get("runs") if cm else None) or 0
        vc_runs = (vc.get("runs") if vc else None) or 0

        # [2026-08-03 変更] 「基準1着率」を加算3元ブレンドから
        #   「コース別勝率 × 当地補正係数」の乗算方式に変更。
        #
        # 【背景】旧方式（全国50%+会場30%+直近10走20%の加算）は、
        #   venue_course_master が実運用マスタに未投入だったため会場成分(vc_raw)
        #   が常にNoneとなり、実質「全国のみ」で動いていた（2026-08-03発覚）。
        #   バックテスト（2026年1月・5〜8月、計9,547レース）で、
        #   「コース別勝率(cm_raw) × 当地補正係数(vc_raw/cm_raw, 0.5〜2.0クリップ)」
        #   の乗算方式を検証したところ、加算方式より一貫して精度が高かった:
        #     Brier Score : 0.1008 → 0.0956（約5%改善）
        #     LogLoss     : 0.3631 → 0.3160（約13%改善）
        #     1着的中率   : 56.83% → 58.03%（+1.2pt）
        #
        # 【設計】
        #   base = cm_raw（全国コース別1着率）。走数不足時は pop_avg にフォールバック。
        #   当地補正係数 = vc_raw(会場×コース別) / cm_raw（全国コース別）を
        #     0.5〜2.0にクリップして乗算。vc_runs不足時は補正なし(1.0)。
        #   加算方式にあった直近10走成分は base_rate 本体には含めない
        #     （バックテストで有意な寄与が確認できていないため）。
        #     dq_recent10 の「データ不足」警告フラグ自体は維持する。
        cm_raw = cm.get("win_rate") if cm else None
        vc_raw = vc.get("win_rate") if vc else None

        # 直近10走（コース別）。base_rate計算には使わないが、
        # UI側「データ不足」バナー用のフラグとして維持。
        r10_raw  = cm.get("recent10_win") if cm else None
        r10_runs = cm.get("recent10_runs") if cm else None
        recent10_insufficient = not (r10_runs is not None and r10_runs >= 10 and r10_raw is not None)
        recent10_rate = 0.0 if recent10_insufficient else r10_raw

        # [2026-08-04 再修正] 実データ確認の結果、venue_course_master の
        # reliable(runs>=20)判定はon/offの二値で、閾値未満の走数情報を
        # 完全に捨ててしまう（reliable比率はわずか2.3%）ことが判明。
        # 小標本でも部分的に情報を活かしつつ過学習を避けるため、
        # 既存の _smooth_personal_trust() による対数補間の連続信頼度加重
        # に置き換える。
        #   trust=0（走数<1、つまりデータ無し）  → 補正なし(local_factor=1.0)
        #   trust=1（走数>=8）                    → フル補正
        #   1〜8走                                → 対数補間で連続的に効かせる
        #
        # min_runs/full_runsは実データ(master_data.json, 2026年1月+5〜8月
        # 計9,592レース)でグリッドサーチして決定。(1,8)〜(1,3)の範囲で
        # 指標がほぼ横ばいのプラトーになっており、(5,20)のような厳しい閾値
        # よりも(1,8)の方が明確に良いことを確認済み:
        #   (5,20): Brier=0.0998 LogLoss=0.3341 的中率=56.70%
        #   (1,8) : Brier=0.0980 LogLoss=0.3285 的中率=57.61%
        #   参考・旧base_rate(会場成分無効時): Brier=0.1008 LogLoss=0.3633 的中率=56.81%
        cm_reliable = bool(cm.get("reliable")) if cm else False
        _LOCAL_FACTOR_CLIP = (0.5, 2.0)
        _LOCAL_FACTOR_MIN_RUNS  = 1
        _LOCAL_FACTOR_FULL_RUNS = 8

        # lane_rate: 個人のコース別勝率。reliable=False(走数不足)なら
        # 会場のそのコース平均(pop_avg)にフォールバックする。
        if cm_raw is not None and cm_reliable:
            lane_rate = cm_raw
        elif pop_avg is not None:
            lane_rate = pop_avg
        else:
            lane_rate = cm_raw  # pop_avgも無ければ個人値をそのまま使う（従来通り）

        if lane_rate is not None:
            local_factor = 1.0
            if vc_raw is not None and cm_raw is not None and cm_raw > 0:
                trust = _smooth_personal_trust(
                    vc_runs,
                    min_runs=_LOCAL_FACTOR_MIN_RUNS,
                    full_runs=_LOCAL_FACTOR_FULL_RUNS,
                )
                if trust > 0:
                    raw_factor = vc_raw / cm_raw
                    # trust=0で1.0（補正なし）、trust=1でフル補正へ連続的に近づける
                    local_factor = 1.0 + (raw_factor - 1.0) * trust
                    local_factor = max(_LOCAL_FACTOR_CLIP[0], min(_LOCAL_FACTOR_CLIP[1], local_factor))
            base_rate = lane_rate * local_factor
            dq = "venue_local" if local_factor != 1.0 else "course_national"
        else:
            base_rate = None

        # 「個人データあり」の基準: 全国/会場いずれかに _SHRINK_MIN_RUNS(3走)以上の
        # 実績があるか。無ければ「実質データなし」として警告対象にする。
        has_personal_data = (cm_runs >= _SHRINK_MIN_RUNS) or (vc_runs >= _SHRINK_MIN_RUNS)

        if base_rate is None:
            rv = pop_avg
            if rv is not None:
                base_rate = rv
                dq = "venue_stat"
        if base_rate is None:
            fallback_rate = vc.get("win_rate") if vc else None
            if fallback_rate is None and cm:
                fallback_rate = cm.get("win_rate")
            base_rate = fallback_rate if fallback_rate is not None else 0.001
            dq = "insufficient"
            has_insufficient = True

        if not has_personal_data:
            has_insufficient = True
            if dq != "insufficient":
                dq = "insufficient"

        base_rate = max(base_rate or 0.001, 0.001)

        st_rank = None
        cm_data = course_master.get(name, {}).get(c)
        if cm_data:
            st_rank = cm_data.get("st_rank")
        if st_rank is None:
            pi      = player_index.get(name, {})
            st_rank = pi.get("st_rank", {}).get(c)

        st_corr   = st_rank_to_correction(st_rank, c)
        pi        = player_index.get(name)
        overall_w = pi.get("overall_win") if pi else None
        form_corr = form_correction(pi, overall_w)
        # [2026-06-25] 合成係数キャップ: st_corr × form_corr の乗算増幅が
        # 30〜40%帯の系統的過大評価（推定36%→実績16%、誤差-20%）の一因。
        # 両者が同時に上振れするケース（好調×好ST）でも最大1.10倍に抑制し
        # base_rate × combined がキャリブレーション実績と整合するようにする。
        # 下限は据え置き（抑制方向は安全）。
        #
        # [2026-06-26] 1号艇かつ実力突出（overall_win が全艇中最高かつ場平均超）の場合は
        # キャップを 1.10 → 1.15 に緩和。
        # 「峰竜太 81.5% vs 他艇 22.5%以下」のような格差メンバーで
        # 1号艇基準確率が場平均を下回るという非直感的な出力を防ぐ。
        _cap = 1.10
        if course == 1 and overall_w is not None:
            other_wins = [
                bt2.get("_overall_win", 0) for bt2 in boats
                if int(bt2.get("boat", 0)) != 1
            ]
            if other_wins and overall_w > max(other_wins) * 1.30:
                _cap = 1.15
        combined  = min(st_corr * form_corr, _cap)

        # [2026-07-18] 根本修正: 勝率(確率)を線形合成するのをやめ、
        # オッズ(p/(1-p))に変換してから合成する（Bradley-Terry型）。
        #
        # 【問題】従来は base_rate（確率そのもの）× combined を6艇分合計して
        #   比率正規化していた。確率は上限1.0で頭打ちになるため、強い艇の
        #   優位性が線形にしか反映されず、本命ほど実際より弱く出る歪みが
        #   構造的に発生していた（calibration実測: 40-60%帯+15.8%,
        #   60%+帯+18.1%の過小評価と一致）。
        # 【対応】base_rateをオッズに変換して合成することで、強い艇ほど
        #   優位性が正しく強調されるようにする。オッズ空間で正規化した後、
        #   6艇合計で割って確率に戻す処理は従来と同じ。
        odds = min(base_rate, 0.999) / (1.0 - min(base_rate, 0.999))
        scores.append(odds * combined)
        dq_list.append(dq)

        # [2026-07-21 追加] 直近10走(コース別)データ不足フラグ。
        # 既存dqとは別枠で持つ（dqの既存分岐ロジックへの影響を避けるため）。
        # renderer.js側の「データ不足」バナーはこのフラグも見て警告表示する。
        bt["dq_recent10"] = "insufficient" if recent10_insufficient else None

        # [2026-08-03 バグ修正] 従来はここで cm.get("win_rate")（全国コース別の
        # 素の値）を再取得して格納しており、実際にスコア計算(odds化)に使った
        # base_rate（当地補正込み）とUI表示値が食い違っていた。
        # 計算に使った値をそのまま格納するよう修正。
        base_rates.append(base_rate)

    total = sum(scores) or 1.0
    for i, bt in enumerate(boats):
        bt["prob"]       = round(scores[i] / total, 4)
        bt["base_score"] = round(scores[i], 4)
        bt["score"]      = round(scores[i], 4)   # 後方互換
        bt["base_rate"]  = round(base_rates[i], 4) if base_rates[i] is not None else None
        bt["dq"]         = dq_list[i]
    if has_insufficient:
        for bt in boats:
            bt["prob_warning"] = True

    # [2026-06-25] 会場別30〜40%帯バイアス補正
    # tenkai_scores付与の前に適用することで展開計算にも補正が伝播する
    boats = _apply_venue_band3040_bias(boats, venue)

    # 展開スコアを付与
    boats = _calc_tenkai_scores(boats, venue)

    # [2026-07-22 追加] recalc_prob.py --auto が「古いロジックで生成された
    # ファイルか」を判定できるよう、各boatにロジックバージョンを埋め込む。
    for bt in boats:
        bt["_logic_version"] = LOGIC_VERSION

    return boats


def _venue_course_base_win(venue: str, c: str) -> float | None:
    """
    INDEXの venueCourseBaseWin 相当（会場×コースの「全国グレード平均へ
    縮小推定した」ベース値）。

    TODO(要確認): 本来はINDEXと同じ2段構成:
        venueCourseBaseWin = shrink(venueCourseAgg.n, venueCourseAgg.win,
                                     globalAll.win, K_VENUE_BASE)
      だが、MASTERに (a) 会場×コース「全選手合算」実測のn、
      (b) 全国グレード別コース平均 globalAll、のいずれも見当たらないため、
      venue_stats[venue].course_rates[c]（会場のコース別実測、shrink無し）
      をそのまま代用している。
      本番の master_data.json にこれらの全国集計テーブルがあるなら、
      ここを差し替えて K_VENUE_BASE による shrink を有効化すること。
    """
    venue_stats = MASTER.get("venue_stats", {}).get(venue, {})
    return venue_stats.get("course_rates", {}).get(c)


def calc_prob_from_master_index_aligned(
    boats: list,
    venue: str,
    race_no: int = 0,
    is_joshi: bool = False,
    grade: str = "一般",
) -> list:
    """
    [INDEX一本化ロジック / 2026-08-10]
    index.html の runPredict() と同一の経験ベイズ縮小推定(3段)＋
    Isotonic較正曲線で基準1着率(bt["prob"])を計算する。

    INDEXとの対応関係:
      base   = shrink(個人×コース成績, venueCourseBaseWin, K_LANE)
      localFactor = shrink(当地成績, 本人通算成績, K_VENUE) / 本人通算成績  [0.6, 1.6]
      score  = base * localFactor
      → 6艇合計100%正規化 → CALIB_WIN_CURVEで較正 → 再正規化

    st_corr / form_corr / オッズ空間合成 / venue_band3040バイアス補正は
    INDEXに存在しないため、このロジックでは一切使わない
    （USE_INDEX_ALIGNED_LOGIC=Falseで旧ロジックに戻せる）。

    grade='女子' の場合もINDEXと同様に扱うが、女子戦専用の会場×コース
    集計(VENUE_WOMEN_COURSE)がMASTERに無いため _venue_course_base_win()
    は一般戦と同じテーブルにフォールバックする（TODOはそちら参照）。
    """
    course_master_joshi = MASTER.get("course_master_joshi", {})
    course_master_base  = MASTER.get("course_master", {})
    course_master = course_master_joshi if (is_joshi and course_master_joshi) else course_master_base

    venue_course_master = MASTER.get("venue_course_master", {})
    player_index         = MASTER.get("player_index", {})

    scores, dq_list, base_rates = [], [], []
    has_insufficient = False

    for bt in boats:
        name   = normalize_name(bt.get("name", ""))
        course = int(bt.get("boat", 1))
        c      = str(course)

        # ── ステップ1: 個人×コース成績を「会場考慮ベース」へ縮小推定 ──
        cm = course_master.get(name, {}).get(c) or course_master_base.get(name, {}).get(c)
        lane_n   = (cm.get("runs") if cm else None) or 0
        lane_win = (cm.get("win_rate") if cm else None) or 0.0

        venue_course_base_win = _venue_course_base_win(venue, c)
        if venue_course_base_win is None:
            # 会場データが無い場合はINDEXと同じく個人成績をそのまま使う
            base = lane_win if lane_n > 0 else 0.001
        else:
            base = shrink(lane_n, lane_win, venue_course_base_win, K_LANE)

        # ── ステップ2: 当地補正（当地成績を本人通算成績へ縮小推定してから比率化）──
        vc = venue_course_master.get(name, {}).get(venue, {}).get(c)
        venue_n   = (vc.get("runs") if vc else None) or 0
        venue_win = (vc.get("win_rate") if vc else None) or 0.0

        pi = player_index.get(name)
        overall_win = (pi.get("overall_win") if pi else None) or 0.0

        local_factor = 1.0
        if overall_win > 0:
            blended = shrink(venue_n, venue_win, overall_win, K_VENUE)
            local_factor = max(0.6, min(1.6, blended / overall_win))

        base_rate = max(base * local_factor, 0.001)

        has_personal_data = lane_n > 0 or venue_n > 0
        if not has_personal_data:
            has_insufficient = True
            dq = "insufficient"
        else:
            dq = "venue_local" if abs(local_factor - 1.0) > 1e-9 else "course_national"

        scores.append(base_rate)
        dq_list.append(dq)
        base_rates.append(base_rate)

    # ── ステップ3: 6艇合計100%正規化 → Isotonic較正 → 再正規化 ──
    # （INDEXと同じ順序。score/base_rateは％表記ではなく比率のままなので
    #   較正曲線の入出力に合わせて一時的に0-100スケールへ変換する）
    total = sum(scores) or 1.0
    pct_raw = [100.0 * s / total for s in scores]
    pct_cal = [apply_win_calibration(p) for p in pct_raw]
    cal_sum = sum(pct_cal) or 1.0
    final_pct = [100.0 * p / cal_sum for p in pct_cal]

    for i, bt in enumerate(boats):
        bt["prob"]       = round(final_pct[i] / 100.0, 4)
        bt["base_score"] = round(scores[i], 4)
        bt["score"]      = round(scores[i], 4)     # 後方互換
        bt["base_rate"]  = round(base_rates[i], 4)
        bt["dq"]         = dq_list[i]

    if has_insufficient:
        for bt in boats:
            bt["prob_warning"] = True

    # 展開スコアを付与（INDEXの計算範囲外だが、renderer.js等の後段が
    # 引き続き参照するため据え置き）
    boats = _calc_tenkai_scores(boats, venue)

    for bt in boats:
        bt["_logic_version"] = LOGIC_VERSION

    return boats


def calc_prob_from_master(
    boats: list,
    venue: str,
    race_no: int = 0,
    is_joshi: bool = False,
    grade: str = "一般",
) -> list:
    """
    公開エントリポイント。USE_INDEX_ALIGNED_LOGIC で新旧ロジックを切替。
    recalc_from_json.py / auto_push.py はこの関数名をそのまま呼ぶため、
    呼び出し側の変更は不要。
    """
    if USE_INDEX_ALIGNED_LOGIC:
        return calc_prob_from_master_index_aligned(
            boats, venue=venue, race_no=race_no, is_joshi=is_joshi, grade=grade
        )
    return _calc_prob_from_master_legacy(
        boats, venue=venue, race_no=race_no, is_joshi=is_joshi, grade=grade
    )


def _check_tenji_config_sync():
    """
    Python/JS 間の展示設定整合チェック。
    [2026-05-20 追加] auto_push.py 起動時に呼ばれる。
    設定不整合があれば警告ログを出力する。
    本関数が prob_scenario_engine.py に存在しない古いバージョンでは
    ImportError になるため、スタブとして定義しておく。
    """
    pass
