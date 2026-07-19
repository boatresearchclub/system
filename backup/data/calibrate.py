#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
calibrate.py — 循環なしキャリブレーション検証ツール
============================================================
history_YYYYMMDD.json（レース前の予測 prob）と
result_YYYYMMDD.json（実際の着順）を日付で突き合わせ、
「推定確率 vs 実績的中率」を確率帯別・枠番別に集計する。

【重要な設計方針】
  - calibration.js のような「学習と採点を同じデータでやる」循環を避けるため、
    ここでは一切の補正テーブル学習（updateCalibPoints等）を行わない。
    history_*.json の prob（course_master由来の生の予測値）と、
    実際に何号艇が1着だったかだけを突き合わせる、単純な集計のみ。
  - 複数日分をまとめて集計することも、学習期間／評価期間で日付を分けて
    比較することもできる（--split-date オプション）。

【使い方】
  # ディレクトリ内の history_*.json / result_*.json を自動で日付ペアリングして集計
  python calibrate.py --dir /path/to/jsons

  # 個別ファイルを指定
  python calibrate.py --pairs history_20260717.json:result_20260717.json ...

  # 学習期間と評価期間を日付で分けて比較（リークがないか確認する用途）
  python calibrate.py --dir /path/to/jsons --split-date 2026-07-01

  # CSVで保存
  python calibrate.py --dir /path/to/jsons --csv-out calib_report.csv

【ファイル名の想定】
  history_YYYYMMDD.json / result_YYYYMMDD.json
  （venue_slug は VENUE_SLUG マップで日本語会場名と対応付ける。
   未知の会場が出てきたら警告を出してスキップする）
"""

import argparse
import csv
import glob
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# prob_scenario_engine.py と同一のマップ（result_*.json のキーが
# "{venue_slug}_{race_no}" 形式のため、日本語会場名との対応付けに必要）
VENUE_SLUG = {
    "桐生": "kiryu", "戸田": "toda", "江戸川": "edogawa",
    "平和島": "heiwajima", "多摩川": "tamagawa", "浜名湖": "hamanako",
    "蒲郡": "gamagori", "常滑": "tokoname", "津": "tsu",
    "三国": "mikuni", "びわこ": "biwako", "住之江": "suminoe",
    "尼崎": "amagasaki", "鳴門": "naruto", "丸亀": "marugame",
    "児島": "kojima", "宮島": "miyajima", "徳山": "tokuyama",
    "下関": "shimonoseki", "若松": "wakamatsu", "芦屋": "ashiya",
    "福岡": "fukuoka", "唐津": "karatsu", "大村": "omura",
}

BINS = [
    ("0-10%",  0.00, 0.10),
    ("10-20%", 0.10, 0.20),
    ("20-30%", 0.20, 0.30),
    ("30-40%", 0.30, 0.40),
    ("40-60%", 0.40, 0.60),
    ("60%+",   0.60, 1.01),
]


# ══════════════════════════════════════════════════════════════════
# データ読み込み・突き合わせ
# ══════════════════════════════════════════════════════════════════

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def extract_date_suffix(filename: str):
    """history_20260717.json / result_20260717.json から日付部分を取り出す"""
    m = re.search(r"(\d{8})", Path(filename).name)
    return m.group(1) if m else None


def find_pairs_in_dir(directory: str):
    """ディレクトリ内の history_*.json と result_*.json を日付でペアリングする"""
    hist_files = glob.glob(str(Path(directory) / "history_*.json"))
    result_files = glob.glob(str(Path(directory) / "result_*.json"))

    hist_by_date = {extract_date_suffix(p): p for p in hist_files}
    result_by_date = {extract_date_suffix(p): p for p in result_files}

    pairs = []
    dates_only_in_hist = set(hist_by_date) - set(result_by_date)
    dates_only_in_result = set(result_by_date) - set(hist_by_date)
    for date, hpath in sorted(hist_by_date.items()):
        if date in result_by_date:
            pairs.append((date, hpath, result_by_date[date]))

    if dates_only_in_hist:
        print(f"[警告] result側が見つからず除外した日付: {sorted(dates_only_in_hist)}", file=sys.stderr)
    if dates_only_in_result:
        print(f"[警告] history側が見つからず除外した日付: {sorted(dates_only_in_result)}", file=sys.stderr)

    return pairs


def _extract_winner_boat(r: dict):
    """
    result側から「1着艇の艇番」を取得する。
    新形式(order配列: [{boat, rank}, ...])があればそれを最優先で使う。
    旧形式(2026-05頃など。orderキーが無く、tansho(単勝)のcomboだけがある)は
    tanshoの1件目のcomboから1着艇を復元するフォールバックを使う。

    戻り値: (rank_by_boat または None, winner_boat または None, mode)
      mode: "order"    … order配列から着順まで判明（従来通りの精度）
            "tansho"   … 単勝comboから1着艇のみ復元（旧形式フォールバック）
            "none"     … どちらも取得できず
    """
    order = r.get("order")
    if order:
        rank_by_boat = {o["boat"]: str(o.get("rank")) for o in order}
        return rank_by_boat, None, "order"

    tansho = r.get("tansho") or []
    if tansho and tansho[0].get("combo"):
        try:
            winner = int(tansho[0]["combo"])
        except (TypeError, ValueError):
            winner = None
        if winner is not None:
            return None, winner, "tansho"

    return None, None, "none"


def collect_rows(history_path: str, result_path: str, date_label: str):
    """
    1日分の history/result ファイルを突き合わせ、
    (date, venue, race_no, boat_no, prob, is_win) のタプルのリストを返す。

    result側に "order"（着順配列）が無い旧形式のファイルについては、
    "tansho"（単勝）のcomboから1着艇だけを復元するフォールバックを使う。
    このフォールバックは「1着かどうか(is_win)」の判定にのみ使われており、
    2着・3着の情報は無いため、is_winベースの集計（本ツールの全指標）には
    影響なく安全に使える。
    """
    hist = load_json(history_path)
    res = load_json(result_path)

    rows = []
    skipped_no_slug = set()
    skipped_no_result = 0
    skipped_cancelled = 0
    skipped_no_winner_info = 0
    n_order_mode = 0
    n_tansho_fallback = 0

    for venue_ja, vd in hist.items():
        slug = VENUE_SLUG.get(venue_ja)
        if not slug:
            skipped_no_slug.add(venue_ja)
            continue
        for rno, rd in vd.get("races", {}).items():
            key = f"{slug}_{rno}"
            r = res.get(key)
            if not r:
                skipped_no_result += 1
                continue
            if r.get("cancelled"):
                skipped_cancelled += 1
                continue

            rank_by_boat, winner_boat, mode = _extract_winner_boat(r)
            if mode == "none":
                skipped_no_winner_info += 1
                continue
            if mode == "order":
                n_order_mode += 1
            else:
                n_tansho_fallback += 1

            for b in rd.get("boats", []):
                boat_no = b.get("boat")
                prob = b.get("prob")
                if prob is None:
                    continue
                if mode == "order":
                    rank = rank_by_boat.get(boat_no)
                    if rank is None:
                        continue
                    is_win = (rank == "1")
                else:  # mode == "tansho"
                    is_win = (boat_no == winner_boat)
                rows.append((date_label, venue_ja, rno, boat_no, prob, is_win))

    if skipped_no_slug:
        print(f"[{date_label}] 警告: 会場名スラッグ未定義でスキップ: {sorted(skipped_no_slug)}", file=sys.stderr)
    if skipped_no_result or skipped_cancelled:
        print(f"[{date_label}] 結果未取得/中止によりスキップ: {skipped_no_result + skipped_cancelled}レース", file=sys.stderr)
    if skipped_no_winner_info:
        print(f"[{date_label}] 警告: 1着情報が取得できずスキップ: {skipped_no_winner_info}レース", file=sys.stderr)
    if n_tansho_fallback:
        print(f"[{date_label}] 情報: {n_tansho_fallback}レースは旧形式(tanshoから1着のみ復元)で集計。"
              f"orderあり: {n_order_mode}レース", file=sys.stderr)

    return rows


# ══════════════════════════════════════════════════════════════════
# 集計
# ══════════════════════════════════════════════════════════════════

def calc_bin_stats(rows):
    """確率帯別の {label, n, est_avg, actual, diff} を返す"""
    out = []
    for label, lo, hi in BINS:
        inb = [r for r in rows if lo <= r[4] < hi]
        n = len(inb)
        if n == 0:
            out.append({"label": label, "n": 0, "est_avg": None, "actual": None, "diff": None})
            continue
        est = sum(r[4] for r in inb) / n
        act = sum(1 for r in inb if r[5]) / n
        out.append({"label": label, "n": n, "est_avg": est, "actual": act, "diff": act - est})
    return out


def calc_course_stats(rows):
    """枠番別の {course, n, est_avg, actual, diff} を返す"""
    out = []
    for c in range(1, 7):
        inb = [r for r in rows if r[3] == c]
        n = len(inb)
        if n == 0:
            out.append({"course": c, "n": 0, "est_avg": None, "actual": None, "diff": None})
            continue
        est = sum(r[4] for r in inb) / n
        act = sum(1 for r in inb if r[5]) / n
        out.append({"course": c, "n": n, "est_avg": est, "actual": act, "diff": act - est})
    return out


def calc_weighted_error(bin_stats):
    valid = [b for b in bin_stats if b["n"] > 0 and b["diff"] is not None]
    total_n = sum(b["n"] for b in valid)
    if total_n == 0:
        return None
    return sum(abs(b["diff"]) * b["n"] for b in valid) / total_n


def calc_brier_score(rows):
    """Brier score（二値的中の二乗誤差の平均）。0に近いほど良い"""
    if not rows:
        return None
    return sum((r[4] - (1.0 if r[5] else 0.0)) ** 2 for r in rows) / len(rows)


# ══════════════════════════════════════════════════════════════════
# 表示
# ══════════════════════════════════════════════════════════════════

def fmt_pct(x):
    return f"{x*100:.1f}%" if x is not None else "-"


def print_report(title, rows):
    print(f"\n{'='*60}")
    print(f"{title}  (対象艇数: {len(rows)}, レース数: {len(set((r[0], r[1], r[2]) for r in rows))})")
    print(f"{'='*60}")

    bin_stats = calc_bin_stats(rows)
    werr = calc_weighted_error(bin_stats)
    brier = calc_brier_score(rows)
    print(f"\n加重平均誤差: {fmt_pct(werr)}   Brier score: {brier:.4f}" if brier is not None else "\nデータなし")

    print("\n[確率帯別]")
    print(f"{'帯':<10}{'件数':>8}{'推定平均':>10}{'実績':>10}{'差':>10}")
    for b in bin_stats:
        print(f"{b['label']:<10}{b['n']:>8}{fmt_pct(b['est_avg']):>10}{fmt_pct(b['actual']):>10}{fmt_pct(b['diff']):>10}")

    print("\n[枠番別]")
    course_stats = calc_course_stats(rows)
    print(f"{'枠':<6}{'件数':>8}{'推定平均':>10}{'実績':>10}{'差':>10}")
    for c in course_stats:
        label = f"{c['course']}号艇"
        print(f"{label:<6}{c['n']:>8}{fmt_pct(c['est_avg']):>10}{fmt_pct(c['actual']):>10}{fmt_pct(c['diff']):>10}")

    return bin_stats, course_stats, werr, brier


def write_csv(path, all_rows_by_period):
    """複数期間分のbin_stats/course_statsをCSVにまとめて書き出す"""
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        for period_name, rows in all_rows_by_period.items():
            bin_stats = calc_bin_stats(rows)
            course_stats = calc_course_stats(rows)
            werr = calc_weighted_error(bin_stats)
            brier = calc_brier_score(rows)

            w.writerow([f"■ {period_name}"])
            w.writerow(["対象艇数", len(rows)])
            w.writerow(["加重平均誤差", fmt_pct(werr)])
            w.writerow(["Brier score", f"{brier:.4f}" if brier is not None else ""])
            w.writerow([])
            w.writerow(["確率帯", "件数", "推定平均", "実績", "差"])
            for b in bin_stats:
                w.writerow([b["label"], b["n"], fmt_pct(b["est_avg"]), fmt_pct(b["actual"]), fmt_pct(b["diff"])])
            w.writerow([])
            w.writerow(["枠", "件数", "推定平均", "実績", "差"])
            for c in course_stats:
                w.writerow([f"{c['course']}号艇", c["n"], fmt_pct(c["est_avg"]), fmt_pct(c["actual"]), fmt_pct(c["diff"])])
            w.writerow([])
            w.writerow([])
    print(f"\nCSVを書き出しました: {path}")


# ══════════════════════════════════════════════════════════════════
# メイン
# ══════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(description="history_*.json と result_*.json を突き合わせた循環なしキャリブレーション検証")
    ap.add_argument("--dir", help="history_*.json / result_*.json が入っているディレクトリ（日付で自動ペアリング）")
    ap.add_argument("--pairs", nargs="*", default=[], help="個別ファイルペアを 'history.json:result.json' の形式で複数指定")
    ap.add_argument("--split-date", help="YYYY-MM-DD。指定すると、この日付より前/以後で結果を分けて表示する（リークがないか確認する用途）")
    ap.add_argument("--csv-out", help="結果をCSVに書き出すパス")
    args = ap.parse_args()

    pairs = []  # (date_label, history_path, result_path)

    if args.dir:
        for date, hpath, rpath in find_pairs_in_dir(args.dir):
            date_label = f"{date[0:4]}-{date[4:6]}-{date[6:8]}"
            pairs.append((date_label, hpath, rpath))

    for p in args.pairs:
        hpath, rpath = p.split(":")
        date = extract_date_suffix(hpath) or extract_date_suffix(rpath) or "unknown"
        date_label = f"{date[0:4]}-{date[4:6]}-{date[6:8]}" if date != "unknown" else date
        pairs.append((date_label, hpath, rpath))

    if not pairs:
        print("対象ファイルが見つかりませんでした。--dir か --pairs を指定してください。", file=sys.stderr)
        sys.exit(1)

    print(f"対象ファイルペア: {len(pairs)}日分")
    for date_label, hpath, rpath in pairs:
        print(f"  {date_label}: {Path(hpath).name} / {Path(rpath).name}")

    all_rows = []
    for date_label, hpath, rpath in pairs:
        rows = collect_rows(hpath, rpath, date_label)
        all_rows.extend(rows)

    if not all_rows:
        print("突き合わせできたデータがありませんでした。", file=sys.stderr)
        sys.exit(1)

    csv_sections = {}

    # ── 全期間まとめての集計 ──
    _, _, _, _ = print_report(f"全期間合計 ({pairs[0][0]} 〜 {pairs[-1][0]})", all_rows)
    csv_sections["全期間合計"] = all_rows

    # ── split-date が指定されていれば、期間を分けて比較 ──
    if args.split_date:
        before = [r for r in all_rows if r[0] < args.split_date]
        after = [r for r in all_rows if r[0] >= args.split_date]
        if before:
            print_report(f"{args.split_date} より前（学習期間相当）", before)
            csv_sections[f"{args.split_date}より前"] = before
        if after:
            print_report(f"{args.split_date} 以降（評価期間相当）", after)
            csv_sections[f"{args.split_date}以降"] = after
        if not before or not after:
            print("\n[注意] split-date で分けた結果、片方の期間にデータがありません。", file=sys.stderr)

    # ── 日別の内訳も出しておく（傾向がブレているか一目で分かるように）──
    print(f"\n{'='*60}")
    print("日別内訳")
    print(f"{'='*60}")
    print(f"{'日付':<12}{'艇数':>8}{'加重平均誤差':>14}{'Brier':>10}")
    by_date = defaultdict(list)
    for r in all_rows:
        by_date[r[0]].append(r)
    for date_label in sorted(by_date):
        rows = by_date[date_label]
        bin_stats = calc_bin_stats(rows)
        werr = calc_weighted_error(bin_stats)
        brier = calc_brier_score(rows)
        brier_str = f"{brier:.4f}" if brier is not None else "-"
        print(f"{date_label:<12}{len(rows):>8}{fmt_pct(werr):>14}{brier_str:>10}")

    if args.csv_out:
        write_csv(args.csv_out, csv_sections)


if __name__ == "__main__":
    main()
