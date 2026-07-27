# -*- coding: utf-8 -*-
"""
prob_calibration.py — 基準1着率(bt["prob"])の事後キャリブレーション
============================================================================
【背景】
  prob_scenario_engine.py の calc_prob_from_master() が出力する bt["prob"] は、
  実測データでの検証の結果、1号艇について系統的に過大評価（-0.10〜-0.17）、
  2〜6号艇について軽度の過小評価（+0.02〜+0.03）となっていることが分かった。

  既存の COURSE1_CALIB_POINTS（computeScenCombosWithEV.js）は「逃げ率」専用の
  補正であり、bt["prob"] 自体を補正する仕組みはこれまで存在しなかった。
  本モジュールはそのギャップを埋める。

【検証方法】
  2025-07-26〜2026-05-31 のhistory_*.json（bt["prob"]）と実際の1着艇情報を
  日付で時系列分割（学習: 〜2026-02-26 / 検証: 2026-02-27〜） し、
  検証期間には一切学習させず、コース別 isotonic regression（単調回帰）を
  学習期間データのみで作成 → 検証期間に適用して改善を確認した。
    Brier Score: 0.0903 → 0.0876（-3.0%、検証専用データ）
    LogLoss   : 0.2975 → 0.2866（-3.7%、検証専用データ）
  本番用テーブル（prob_calibration_tables.json）は全期間データで再学習済み。

【使い方】
  prob_scenario_engine.py の calc_prob_from_master() 末尾、
      for i, bt in enumerate(boats):
          bt["prob"] = round(scores[i] / total, 4)
          ...
  の直後（_apply_venue_band3040_bias の前）に一行追加する:

      from prob_calibration import calibrate_probs
      boats = calibrate_probs(boats)

  これだけで bt["prob"] がコース別補正＋レース内再正規化された値に置き換わる。
  bt["prob_raw"] に補正前の値を退避するので、既存のbase_rate/base_scoreとの
  比較や、補正のオン/オフ切り替えデバッグにも使える。

【運用】
  データが増えたら data/calibrate.py と同じ枠組みで定期的に再学習し、
  prob_calibration_tables.json を差し替えることを推奨する（3〜6ヶ月おき目安）。
  再学習時は必ず学習期間と検証期間を日付で分離し、検証専用データでの
  Brier/LogLoss改善を確認してから本番反映すること（過学習防止）。
"""

import json
from pathlib import Path

_TABLE_PATH = Path(__file__).parent / "prob_calibration_tables.json"
_tables = None


def _load_tables():
    global _tables
    if _tables is None:
        with open(_TABLE_PATH, encoding="utf-8") as f:
            _tables = json.load(f)
    return _tables


def _interp(points, p):
    """区分線形補間。points は [[x0,y0],[x1,y1],...] で x昇順・0〜1をカバーする前提。"""
    if p <= points[0][0]:
        return points[0][1]
    if p >= points[-1][0]:
        return points[-1][1]
    for i in range(1, len(points)):
        x0, y0 = points[i - 1]
        x1, y1 = points[i]
        if p <= x1:
            if x1 == x0:
                return y1
            t = (p - x0) / (x1 - x0)
            return y0 + t * (y1 - y0)
    return points[-1][1]


def calibrate_probs(boats: list) -> list:
    """
    boats: calc_prob_from_master() が prob/base_rate/dq 等を付与した後のリスト。
    各艇の bt["prob"] をコース別キャリブレーション曲線で補正し、
    レース内で再正規化（合計1）してから返す。

    副作用: bt["prob_raw"] に補正前の値を保存する。
    """
    tables = _load_tables()
    course1_pts = tables["PROB_CALIB_COURSE1_POINTS"]
    other_pts = tables["PROB_CALIB_COURSE_OTHER_POINTS"]

    calibrated = []
    for bt in boats:
        raw_p = bt.get("prob")
        if raw_p is None:
            calibrated.append(None)
            continue
        bt["prob_raw"] = raw_p
        course = str(int(bt.get("boat", 0)))
        if course == "1":
            cp = _interp(course1_pts, raw_p)
        else:
            pts = other_pts.get(course, other_pts.get("2"))
            cp = _interp(pts, raw_p)
        calibrated.append(max(cp, 0.0001))

    total = sum(c for c in calibrated if c is not None) or 1.0
    for bt, cp in zip(boats, calibrated):
        if cp is None:
            continue
        bt["prob"] = round(cp / total, 4)

    return boats
