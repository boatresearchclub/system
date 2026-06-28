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
import subprocess
import sys
from pathlib import Path
from datetime import datetime

# ── パス定義（auto_push.py と同じ規則）──────────────────────────────
SCRIPTS_DIR      = Path(__file__).parent
DATA_COLLECT_DIR = Path(r"C:\Users\user\Desktop\データ収集\scripts")

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

def st_rank_to_correction(st_rank) -> float:
    """
    コース別ST順位 → 補正係数（rank=1→1.2 / rank=3.0→1.0 / rank=6→0.7）
    """
    if st_rank is None:
        return 1.0
    raw = 1.0 + (3.0 - st_rank) * (0.12 / 2.5)
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

            # 筆頭威力艇（boostsが既に計算済み）
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
                        V2_BLEND = 0.35 if entry.get("reliable") else 0.15
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

# スクリーンショットの実績値から算出（件数5件未満は None → スキップ）
# 実績値 / 0.35（目標値）= 補正係数の根拠
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
    """
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

def calc_prob_from_master(
    boats: list,
    venue: str,
    race_no: int = 0,
    is_joshi: bool = False,
    grade: str = "一般",
) -> list:
    """
    選手ごとのコース別1着率 → prob を計算して boats に付与する。

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

        venue_rate    = (vc.get("ts_win_rate") or vc.get("win_rate")) if vc and vc.get("reliable") else None
        national_rate = (cm.get("ts_win_rate") or cm.get("win_rate")) if cm and cm.get("reliable") else None
        venue_trust   = vc.get("trust", 0.0) if vc else 0.0

        if venue_rate is not None and national_rate is not None:
            base_rate = venue_rate * venue_trust + national_rate * (1.0 - venue_trust)
            dq = "venue_local"
        elif venue_rate is not None:
            base_rate = venue_rate
            dq = "venue_local"
        elif national_rate is not None:
            base_rate = national_rate
            dq = "course_national"

        has_personal_data = (
            (cm is not None and cm.get("reliable", False))
            or (vc is not None and vc.get("reliable", False))
        )

        if base_rate is None:
            rv = race_course_rates.get(c) or venue_course_rates.get(c)
            if rv is not None:
                base_rate = rv
                dq = "venue_stat"
        if base_rate is None:
            fallback_rate = None
            if vc:
                fallback_rate = vc.get("ts_win_rate") or vc.get("win_rate")
            if fallback_rate is None and cm:
                fallback_rate = cm.get("ts_win_rate") or cm.get("win_rate")
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

        st_corr   = st_rank_to_correction(st_rank)
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
        scores.append(base_rate * combined)
        dq_list.append(dq)

        raw_win_rate = (cm.get("ts_win_rate") or cm.get("win_rate")) if cm else None
        base_rates.append(raw_win_rate)

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
    return boats


def _check_tenji_config_sync():
    """
    Python/JS 間の展示設定整合チェック。
    [2026-05-20 追加] auto_push.py 起動時に呼ばれる。
    設定不整合があれば警告ログを出力する。
    本関数が prob_scenario_engine.py に存在しない古いバージョンでは
    ImportError になるため、スタブとして定義しておく。
    """
    pass
