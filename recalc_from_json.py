"""
recalc_from_json.py — 既存の data/*.json を、元CSVを介さずに直接再計算する

【recalc_prob.py --auto との違い】
  recalc_prob.py --auto は csv_output/ 内の元CSVを再パースして
  JSONを丸ごと作り直す方式のため、元CSVが既に無い日付は
  「CSV なし（元CSVが見つからないため再計算不可）」で無言スキップされる。

  本スクリプトは、JSON内に既に埋め込まれている boats 配列
  （boat / name / grade / win_rate / local_rate 等）を直接
  calc_prob_from_master() に渡して prob 等を再計算するため、
  元CSVが残っていなくても直せる。ただし tenji（展示）関連の
  再注入は行わない（_inject_tenji_scores は元のtenji_dataファイルが
  別途必要なため、本スクリプトの対象外。基準1着率＝prob/base_rate/
  score/dq/_logic_version のみを直す）。

【使い方】
  python recalc_from_json.py data/today_20260810.json
  python recalc_from_json.py data/today_20260810.json --venue 唐津 --race 6   # 特定レースのみ
  python recalc_from_json.py data/today_20260810.json --dry-run              # 書き込まず差分表示のみ

【注意】
  - auto_push.py が同時に動いている場合は停止してから実行すること
    （recalc_prob.py と同じ理由。書き込み中に上書きされる競合を避けるため）
  - 元ファイルは .bak として退避してから上書きする
  - GitHub Pages に反映するには別途 git push が必要
"""

import json
import sys
import shutil
import argparse
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPTS_DIR))

from prob_scenario_engine import calc_prob_from_master, MASTER, LOGIC_VERSION  # noqa: E402


def log(msg):
    print(f"[recalc_from_json] {msg}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="既存JSONのboats配列を直接再計算する（元CSV不要）")
    parser.add_argument("json_path", help="対象JSON（data/today_*.json または data/history_*.json）")
    parser.add_argument("--venue", default=None, help="この会場のみ再計算（省略時は全会場）")
    parser.add_argument("--race", type=int, default=None, help="このレース番号のみ再計算（--venue必須）")
    parser.add_argument("--dry-run", action="store_true", help="書き込まずに差分表示のみ")
    args = parser.parse_args()

    if args.race is not None and args.venue is None:
        log("ERROR: --race を使う場合は --venue も指定してください")
        sys.exit(1)

    path = Path(args.json_path)
    if not path.exists():
        log(f"ERROR: ファイルが見つかりません: {path}")
        sys.exit(1)

    if not MASTER:
        log("ERROR: MASTER（master_data.json）が空です。prob_scenario_engine.load_master() が")
        log("       正しく本番の master_data.json を読み込めているか確認してください。")
        sys.exit(1)

    log(f"現在のLOGIC_VERSION = {LOGIC_VERSION}")
    log(f"対象ファイル = {path}")

    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    changed = 0
    checked = 0

    for venue, vdata in data.items():
        if args.venue and venue != args.venue:
            continue
        races = vdata.get("races", {})
        is_joshi = bool(vdata.get("is_joshi"))
        grade = vdata.get("grade", "一般")
        for rno_str, rd in races.items():
            if args.race is not None and str(args.race) != str(rno_str):
                continue
            boats = rd.get("boats")
            if not boats:
                continue
            checked += 1

            before = {b["boat"]: b.get("prob") for b in boats}
            rno = int(rno_str) if str(rno_str).isdigit() else 0

            new_boats = calc_prob_from_master(
                boats, venue=venue, race_no=rno, is_joshi=is_joshi, grade=grade
            )
            rd["boats"] = new_boats

            diffs = []
            for b in new_boats:
                old_p = before.get(b["boat"])
                new_p = b.get("prob")
                if old_p is None or abs((new_p or 0) - old_p) > 0.001:
                    diffs.append(f"{b['boat']}号艇{b['name']}: {old_p} → {new_p}")
            if diffs:
                changed += 1
                log(f"  {venue} R{rno_str}:")
                for d in diffs:
                    log(f"    {d}")

    log("─" * 50)
    log(f"チェック: {checked}レース / 変化あり: {changed}レース")

    if args.dry_run:
        log("(dry-run: 書き込みなし)")
        return

    if changed == 0 and checked == 0:
        log("対象レースが見つかりませんでした（--venue / --race の指定を確認してください）")
        return

    shutil.copy2(path, path.with_suffix(".json.bak"))
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    log(f"書き込み完了: {path}（元ファイルは {path.with_suffix('.json.bak').name} に退避済み）")
    log("※ GitHub Pages に反映するには git push が必要です")


if __name__ == "__main__":
    main()
