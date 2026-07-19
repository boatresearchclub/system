"""
recalc_prob.py — 過去JSONの prob を修正済み calc_prob_from_master で一括再計算する

【仕組み】
  auto_push.py の parse_csv() → write_history_json() / write_today_json() と
  まったく同じロジックで CSV を再パースし、data/*.json を上書きする。
  修正済みの prob_scenario_engine.py が import されるので、
  band3040_bias スキップ・combined キャップ緩和が反映される。

【使い方】
  # このスクリプトを auto_push.py と同じフォルダに置く
  python recalc_prob.py              # data/ 配下の全 history_/today_ JSON を再生成
  python recalc_prob.py --days 7    # 直近7日分のみ
  python recalc_prob.py --dry-run   # 書き込まずに差分だけ表示

【注意】
  - 元ファイルは .bak として退避してから上書きする
  - GitHub Pages に反映するには別途 git push が必要
  - auto_push.py が同時に動いている場合は停止してから実行すること
"""

import json
import sys
import re
import glob
import shutil
import argparse
from pathlib import Path
from datetime import datetime, timedelta

# ── パス定義（auto_push.py と同じ）─────────────────────────────────
SCRIPTS_DIR      = Path(__file__).parent
DATA_COLLECT_DIR = Path(r"C:\Users\user\Desktop\データ収集\scripts")
CSV_DIR          = DATA_COLLECT_DIR / "csv_output"
DATA_DIR    = SCRIPTS_DIR / "data"       # auto_push.py と同じ: BRCsystem/data
HISTORY_KEEP_DAYS = 30

# ── prob_scenario_engine を import（修正済みファイルが同フォルダにある前提）
sys.path.insert(0, str(SCRIPTS_DIR))
from prob_scenario_engine import (
    calc_prob_from_master, normalize_name, resolve_player_name, MASTER
)

# ────────────────────────────────────────────────────────────────────
def log(msg):
    print(f"[recalc] {msg}", flush=True)


def get_race_index_path(date_str=None):
    """auto_push.py の get_race_index_path と同じロジック"""
    if date_str:
        hd = date_str.replace("-", "")
        p = DATA_COLLECT_DIR / f"race_index_{hd}.json"
        if p.exists():
            return p
    return DATA_COLLECT_DIR / "race_index.json"


def parse_csv(filepath):
    """
    auto_push.py の parse_csv() をそのまま移植。
    修正済み calc_prob_from_master が呼ばれるため、prob が正しく再計算される。
    """
    try:
        import pandas as pd
        try:
            df = pd.read_csv(filepath, encoding="utf-8")
        except UnicodeDecodeError:
            df = pd.read_csv(filepath, encoding="shift_jis")
    except Exception as e:
        log(f"  CSV読み込みエラー: {filepath} ({e})")
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

        motor_no_raw = row.get("motor_no", row.get("モーター番号",
                       row.get("モーターNo", row.get("M番号", None))))
        try:
            motor_no = int(float(motor_no_raw)) if motor_no_raw not in (None, "", "nan") else None
        except (ValueError, TypeError):
            motor_no = None

        motor_rate2_raw = row.get("motor_rate2", row.get("M2率", None))
        try:
            motor_rate2 = float(motor_rate2_raw) if motor_rate2_raw not in (None, "", "nan") else 0.0
        except (ValueError, TypeError):
            motor_rate2 = 0.0

        motor_rate3_raw = row.get("motor_rate3", row.get("M3率", None))
        try:
            motor_rate3 = float(motor_rate3_raw) if motor_rate3_raw not in (None, "", "nan") else 0.0
        except (ValueError, TypeError):
            motor_rate3 = 0.0

        motor_rank_raw = row.get("motor_rank", None)
        try:
            motor_rank = int(float(motor_rank_raw)) if motor_rank_raw not in (None, "", "nan") else None
        except (ValueError, TypeError):
            motor_rank = None

        prev_user_raw = row.get("prev_user", row.get("前節使用者", row.get("前節使用", None)))
        prev_user = str(prev_user_raw).strip() if prev_user_raw not in (None, "", "nan") else None

        races[rno]["boats"].append({
            "boat":        int(row.get("艇番", 0)),
            "reg_no":      reg_no,
            "name":        name,
            "name_dq":     name_dq,
            "grade":       str(row.get("級別", "B1")),
            "win_rate":    float(row.get("全国勝率", 0) or 0),
            "local_rate":  float(row.get("当地勝率", 0) or 0),
            "motor2":      motor_rate2,
            "motor_rate2": motor_rate2,
            "motor_rate3": motor_rate3,
            "boat2":       float(row.get("B2率", 0) or 0),
            "results":     str(row.get("今節成績", "")),
            "hayami":      float(row.get("早見", 0) or 0) or None,
            "motor_no":    motor_no,
            "motor_rank":  motor_rank,
            "prev_user":   prev_user,
            "score":       0,
            "dq":          "fallback",
            "prob":        1/6,
        })

    # 女子戦・グレード判定（auto_push.py と同じ）
    is_joshi   = False
    race_grade = "一般"
    try:
        _ri_path = get_race_index_path(date)
        if _ri_path.exists():
            with open(_ri_path, encoding="utf-8") as _f:
                _ri = json.load(_f)
            _vi = _ri.get("venues", {}).get(venue, {})
            _period = _vi.get("period", "")
            if _period and date:
                _year  = datetime.now().year
                _parts = _period.replace(" ", "").split("-")
                if len(_parts) == 2:
                    _start = datetime.strptime(f"{_year}/{_parts[0]}", "%Y/%m/%d").date()
                    _end   = datetime.strptime(f"{_year}/{_parts[1]}", "%Y/%m/%d").date()
                    _csv_d = datetime.strptime(date, "%Y-%m-%d").date()
                    if _start <= _csv_d <= _end:
                        is_joshi   = bool(_vi.get("is_joshi", False))
                        race_grade = str(_vi.get("grade", "一般"))
    except Exception:
        pass

    # ── ここで修正済み calc_prob_from_master が呼ばれる ──
    for rno, rd in races.items():
        rd["boats"] = calc_prob_from_master(
            rd["boats"], venue, race_no=rno,
            is_joshi=is_joshi, grade=race_grade
        )
        rd["boats"].sort(key=lambda b: -b["prob"])

    return {
        "venue":    venue,
        "date":     date,
        "is_joshi": is_joshi,
        "grade":    race_grade,
        "races":    {str(k): v for k, v in sorted(races.items())},
    }


# ────────────────────────────────────────────────────────────────────
# 再計算メイン処理
# ────────────────────────────────────────────────────────────────────

def recalc_day(date_str: str, dry_run: bool) -> dict:
    """
    指定日付のCSVをすべて再パースして history_YYYYMMDD.json / today_YYYYMMDD.json を上書き。
    戻り値: {"date": str, "venues": int, "written": bool}
    """
    date_nd  = date_str.replace("-", "")
    day_data = {}

    for csv_path in glob.glob(str(CSV_DIR / "*.csv")):
        if date_str not in Path(csv_path).name:
            continue
        data = parse_csv(csv_path)
        if data and data.get("venue"):
            day_data[data["venue"]] = data

    if not day_data:
        return {"date": date_str, "venues": 0, "written": False, "reason": "CSV なし"}

    # today_ → history_ の優先順で対象ファイルを決定
    # どちらも存在しない場合は history_ として新規作成する
    written = False
    out_path = None
    for prefix in ("today", "history"):
        p = DATA_DIR / f"{prefix}_{date_nd}.json"
        if p.exists():
            out_path = p
            break
    if out_path is None:
        # 新規作成: 当日分は today_、過去分は history_
        from datetime import date as _date
        today_nd = datetime.now().strftime("%Y%m%d")
        prefix   = "today" if date_nd == today_nd else "history"
        out_path = DATA_DIR / f"{prefix}_{date_nd}.json"

    if dry_run:
        if out_path.exists():
            with open(out_path, encoding="utf-8") as f:
                old_data = json.load(f)
            for venue, vdata in day_data.items():
                old_vdata = old_data.get(venue, {})
                for rno_str, rd in vdata.get("races", {}).items():
                    old_rd = old_vdata.get("races", {}).get(rno_str, {})
                    for bt in rd.get("boats", []):
                        old_bt = next((b for b in old_rd.get("boats", [])
                                       if b.get("boat") == bt.get("boat")), None)
                        old_p = old_bt.get("prob") if old_bt else None
                        new_p = bt.get("prob")
                        if old_p is not None and abs((new_p or 0) - old_p) > 0.001:
                            log(f"  [DRY] {out_path.name} {venue} R{rno_str} "
                                f"艇{bt['boat']}{bt['name']}: {old_p:.3f} → {new_p:.3f}")
        else:
            log(f"  [DRY] {out_path.name} 新規作成予定: {len(day_data)}会場")
    else:
        if out_path.exists():
            shutil.copy2(out_path, out_path.with_suffix(".json.bak"))
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(day_data, ensure_ascii=False, separators=(",", ":")))
        written = True

    return {"date": date_str, "venues": len(day_data), "written": written or dry_run}


def _target_dates(args) -> list[str]:
    today = datetime.now().date()
    days  = args.days if args.days else HISTORY_KEEP_DAYS
    dates = []
    for d in range(0, days + 1):
        dt = today - timedelta(days=d)
        dates.append(dt.strftime("%Y-%m-%d"))
    return dates


def main():
    parser = argparse.ArgumentParser(description="過去JSON prob 一括再計算")
    parser.add_argument("--days",    type=int, default=None,
                        help=f"直近N日分のみ処理（デフォルト: {HISTORY_KEEP_DAYS}日）")
    parser.add_argument("--dry-run", action="store_true",
                        help="書き込まずに差分表示のみ")
    args = parser.parse_args()

    log(f"DATA_DIR = {DATA_DIR}")
    log(f"CSV_DIR  = {CSV_DIR}")
    log(f"dry_run  = {args.dry_run}")

    if not DATA_DIR.exists():
        log(f"ERROR: DATA_DIR が存在しません: {DATA_DIR}")
        sys.exit(1)
    if not CSV_DIR.exists():
        log(f"ERROR: CSV_DIR が存在しません: {CSV_DIR}")
        sys.exit(1)

    dates   = _target_dates(args)
    total_w = 0
    total_s = 0

    for date_str in dates:
        result = recalc_day(date_str, dry_run=args.dry_run)
        if result["venues"] == 0:
            total_s += 1
            continue
        status = "書き込み済み" if result["written"] else f"スキップ({result.get('reason','')})"
        log(f"  {date_str}: {result['venues']}会場 → {status}")
        total_w += 1

    log("─" * 50)
    log(f"完了: {total_w}日分を処理 / {total_s}日分スキップ（CSV なし）")
    if not args.dry_run and total_w > 0:
        log("※ 元ファイルは .bak として保存済み")
        log("※ GitHub Pages に反映するには git push が必要です")


if __name__ == "__main__":
    main()
