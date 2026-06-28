# -*- coding: utf-8 -*-
"""
展開補正パターン化パイプライン プロトタイプ（骨格）

目的:
  「1号艇の被決まり手タイプ × 2-6号艇の攻めタイプ(+連動候補)」という組み合わせを
  「パターン」としてラベル付けし、過去の実レースで実際に何が起きたか(決まり手・着順)を
  集計することで、パラメトリックな式の代わりに『パターン→実績』の経験テーブルを作る。

重要な設計方針:
  - 各レースのタイプ判定には、そのレースの「前日まで」の実績のみを使う(time-pointの厳守)。
    同日内の他レースは使わない(同日内の順序が一意に決まらないため、保守的に1日粒度で区切る)。
  - 1ヶ月分のデータしかないため、月の前半はサンプル不足で「経験不足」になるのは想定どおり。
    これは骨格(パイプラインの配管)を確認するためのプロトタイプであり、数字自体の精度は別問題。
"""

import pandas as pd
import numpy as np
from collections import defaultdict
from pathlib import Path

CSV_PATH = "202605_results.csv"  # 単月だけ試す時用(load_dataで使用)
DATA_DIR = Path(r"C:\Users\user\Desktop\データ収集\data_csv")  # 3年分のCSVが入っているフォルダ。違う場所ならここを書き換える
OUT_DIR = Path("out")
OUT_DIR.mkdir(exist_ok=True)

# ---- 閾値(本番のcourse_master基準20走より緩めた、1ヶ月用の仮閾値) ----
MIN_RUNS_BOAT1 = 8     # 1号艇側(被決まり手)の最低サンプル数
MIN_RUNS_ATTACK = 5    # 2-6号艇側(攻め)の最低サンプル数

ATTACK_KIMARI = ["差し", "まくり", "まくり差し"]
BOAT1_BETA_KIMARI = ["差し", "まくり", "まくり差し", "抜き", "恵まれ"]


def load_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, encoding="utf-8-sig")
    df["日付"] = pd.to_datetime(df["日付"])
    df["race_id"] = (
        df["日付"].dt.strftime("%Y%m%d") + "_" + df["会場名"] + "_" + df["レース番号"].astype(str)
    )
    # 6艇揃っていないレースは除外(出走取消等で分析が崩れるため)
    full = df.groupby("race_id")["艇番"].count()
    valid_ids = full[full == 6].index
    before = df["race_id"].nunique()
    df = df[df["race_id"].isin(valid_ids)].copy()
    after = df["race_id"].nunique()
    print(f"[load] races: {before} -> {after} (6艇揃いのみ採用, {before - after}件除外)")
    return df


def load_data_multi(paths) -> pd.DataFrame:
    """
    複数月分のCSV(202601_results.csv, 202602_results.csv, ...)をまとめて読み込み、
    日付順にソートして1本のDataFrameにする。
    使い方: df = load_data_multi(sorted(Path("data_csv").glob("*_results.csv")))
    """
    frames = []
    for p in paths:
        d = pd.read_csv(p, encoding="utf-8-sig")
        frames.append(d)
    df = pd.concat(frames, ignore_index=True)
    df["日付"] = pd.to_datetime(df["日付"])
    df["race_id"] = (
        df["日付"].dt.strftime("%Y%m%d") + "_" + df["会場名"] + "_" + df["レース番号"].astype(str)
    )
    full = df.groupby("race_id")["艇番"].count()
    valid_ids = full[full == 6].index
    before = df["race_id"].nunique()
    df = df[df["race_id"].isin(valid_ids)].copy()
    after = df["race_id"].nunique()
    print(f"[load_multi] {len(paths)}ファイル / races: {before} -> {after} (6艇揃いのみ採用, {before - after}件除外)")
    return df.sort_values("日付")


class ProfileStore:
    """
    player_id × 進入コース ごとの『これまでの』決まり手実績を保持する。
    boat1側: 全決まり手の出現回数(被決まり手 + 自身の逃げ勝ち)
    attack側: 自身が勝った時の決まり手の出現回数
    """

    def __init__(self):
        # course1: {player_id: {"total": n, "kimari_counts": {決まり手: n}}}
        self.boat1 = defaultdict(lambda: {"total": 0, "kimari_counts": defaultdict(int)})
        # course2-6: {(player_id, course): {"total": n, "win_kimari_counts": {決まり手: n}}}
        self.attack = defaultdict(lambda: {"total": 0, "win_kimari_counts": defaultdict(int)})

    def snapshot_boat1(self, player_id):
        rec = self.boat1.get(player_id)
        if rec is None or rec["total"] < MIN_RUNS_BOAT1:
            n = 0 if rec is None else rec["total"]
            return {"n": n, "rates": None}
        total = rec["total"]
        rates = {k: rec["kimari_counts"].get(k, 0) / total for k in ["逃げ"] + BOAT1_BETA_KIMARI}
        return {"n": total, "rates": rates}

    def snapshot_attack(self, player_id, course):
        rec = self.attack.get((player_id, course))
        if rec is None or rec["total"] < MIN_RUNS_ATTACK:
            n = 0 if rec is None else rec["total"]
            return {"n": n, "rates": None}
        total = rec["total"]
        rates = {k: rec["win_kimari_counts"].get(k, 0) / total for k in ATTACK_KIMARI}
        return {"n": total, "rates": rates}

    def update_with_race(self, race_rows: pd.DataFrame):
        for _, row in race_rows.iterrows():
            pid = row["登録番号"]
            course = int(row["進入コース"])
            kimari = row["決まり手"]
            if course == 1:
                rec = self.boat1[pid]
                rec["total"] += 1
                rec["kimari_counts"][kimari] += 1
            else:
                rec = self.attack[(pid, course)]
                rec["total"] += 1
                if row["着順"] == 1:
                    rec["win_kimari_counts"][kimari] += 1


def classify_boat1(snap):
    if snap["rates"] is None:
        return "経験不足", None
    r = snap["rates"]
    if r["逃げ"] >= 0.5:
        return "粘り型", r
    # 逃げ以外の被決まり手で最大のものを探す
    beta = {k: r[k] for k in BOAT1_BETA_KIMARI}
    top_k = max(beta, key=beta.get)
    label_map = {"差し": "差され型", "まくり": "まくられ型", "まくり差し": "まくり差され型",
                 "抜き": "抜かれ型", "恵まれ": "崩れ型"}
    return label_map.get(top_k, "崩れ型"), r


def classify_attacker(snap):
    if snap["rates"] is None:
        return "経験不足", None
    r = snap["rates"]
    total_win_rate = sum(r.values())
    if total_win_rate < 1e-9:
        return "攻め力なし", r
    top2 = sorted(ATTACK_KIMARI, key=lambda k: r[k], reverse=True)[:2]
    top1_v, top2_v = r[top2[0]], r[top2[1]]
    if top1_v <= 0:
        return "攻め力なし", r
    if top2_v >= top1_v * 0.5 and top2_v > 0:
        return f"複合型({top2[0]}+{top2[1]})", r
    return f"{top2[0]}型", r


def bucket_rate(rate):
    """0.0-1.0の比率を 0-5 / 5-10 / 10-15 / 15+ (%) の4バケットに変換する"""
    if rate is None:
        return "?"
    pct = rate * 100
    if pct < 5:
        return "0-5"
    if pct < 10:
        return "5-10"
    if pct < 15:
        return "10-15"
    return "15+"


def direct_boost(vuln_rates, attack_rates):
    if vuln_rates is None or attack_rates is None:
        return None
    return sum(vuln_rates[k] * attack_rates[k] for k in ATTACK_KIMARI)


def build_pattern_label(boat1_label, attacker_labels, chain_pairs):
    # attacker_labels: list of (course, label) for course2-6
    attack_summary = "/".join(f"{c}号:{lab}" for c, lab in attacker_labels)
    chain_summary = ";".join(f"{a}->{b}" for a, b in chain_pairs) if chain_pairs else "なし"
    return f"1号:{boat1_label} | 攻め[{attack_summary}] | 連動[{chain_summary}]"


def build_pattern_key_v2(boat1_label, top_direct, attacker_info, chain_pairs):
    """
    1着率の予測専用、精度を担保できる範囲まで次元を圧縮した「フロア案」のパターンキー。
    - 1号艇: 既存の質的ラベルをそのまま使う(粘り型/差され型/まくられ型/まくり差され型/抜かれ型/崩れ型 の6種類)
    - 筆頭威力艇: 艇番(2~6) ＋ その艇の主力決まり手(差し/まくり/まくり差し) ＝15通り、バケット化はしない
    - 連動ペアの有無(boolean)
    総数 6×15×2=180パターン。3年分(約17万レース)なら平均944件/パターンで、
    ±3pt程度の精度目標とほぼ一致する設計。
    どれか判定不能(経験不足)な要素があれば None を返す。
    """
    if boat1_label is None or boat1_label == "経験不足" or top_direct is None:
        return None
    top_rates = attacker_info[top_direct]["rates"]
    if top_rates is None:
        return None
    top_kimari = max(ATTACK_KIMARI, key=lambda k: top_rates[k])
    chain_flag = "連動有" if chain_pairs else "連動無"
    return f"1号[{boat1_label}] | 筆頭[{top_direct}号:{top_kimari}] | {chain_flag}"


def process(df: pd.DataFrame, store: "ProfileStore | None" = None):
    if store is None:
        store = ProfileStore()
    records = []
    diag_rows = []

    for date, day_df in df.sort_values("日付").groupby("日付"):
        # この日のレースは「前日までの蓄積」だけを使って判定する
        for race_id, race_rows in day_df.groupby("race_id"):
            boats = {}
            for _, row in race_rows.iterrows():
                boats[int(row["進入コース"])] = {
                    "player_id": row["登録番号"],
                    "name": row["選手名"],
                    "finish": int(row["着順"]),
                }
            if set(boats.keys()) != set(range(1, 7)):
                continue  # 進入コース変更で1-6が揃わない異常ケースはスキップ
            finishes = sorted(b["finish"] for b in boats.values())
            if finishes != [1, 2, 3, 4, 5, 6]:
                # 同着(同一着順)等で1-6が綺麗に揃わないケース。プロフィール更新だけ行いスキップ。
                store.update_with_race(race_rows)
                continue

            decisive_kimari = race_rows["決まり手"].iloc[0]

            # --- 1号艇 ---
            snap1 = store.snapshot_boat1(boats[1]["player_id"])
            boat1_label, vuln_rates = classify_boat1(snap1)

            # --- 2-6号艇 ---
            attacker_info = {}
            for c in range(2, 7):
                snap = store.snapshot_attack(boats[c]["player_id"], c)
                label, rates = classify_attacker(snap)
                attacker_info[c] = {"n": snap["n"], "label": label, "rates": rates}

            # --- 直接威力ランキング ---
            boosts = {}
            for c in range(2, 7):
                b = direct_boost(vuln_rates, attacker_info[c]["rates"])
                if b is not None:
                    boosts[c] = b
            top_direct = max(boosts, key=boosts.get) if boosts else None

            # --- 6艇の相対評価: 威力ランキング(分類できた艇だけを対象に1位~)を作る ---
            ranked = sorted(boosts.items(), key=lambda x: -x[1])
            rank_of = {course: i + 1 for i, (course, _) in enumerate(ranked)}

            # --- 連動候補検出: まくり型/複合型(まくり含む) -> まくり差し型/複合型(まくり差し含む) ---
            chain_pairs = []
            makuri_sources = [c for c, info in attacker_info.items() if "まくり" in info["label"] and "まくり差し" not in info["label"].split("+")[0]]
            # 厳密に「まくり」を持つ艇(単独型 or 複合型の一部)と「まくり差し」を持つ艇を分けて検出
            has_makuri = [c for c, info in attacker_info.items() if info["rates"] and info["rates"].get("まくり", 0) > 0 and info["label"] != "経験不足"]
            has_makurisashi = [c for c, info in attacker_info.items() if info["rates"] and info["rates"].get("まくり差し", 0) > 0 and info["label"] != "経験不足"]
            for a in has_makuri:
                for b_ in has_makurisashi:
                    if a != b_:
                        chain_pairs.append((a, b_))

            attacker_labels = [(c, attacker_info[c]["label"]) for c in range(2, 7)]
            pattern_label = build_pattern_label(boat1_label, attacker_labels, chain_pairs)
            pattern_key_v2 = build_pattern_key_v2(boat1_label, top_direct, attacker_info, chain_pairs)

            top3_boats = {boats[c]["finish"]: c for c in range(1, 7) if boats[c]["finish"] <= 3}
            chain_beneficiary = chain_pairs[0][1] if chain_pairs else None

            actual_1st_course = next(c for c in range(1, 7) if boats[c]["finish"] == 1)
            if actual_1st_course == 1:
                role_of_winner = "1号艇"
            elif actual_1st_course in rank_of:
                role_of_winner = f"威力{rank_of[actual_1st_course]}位"
            else:
                role_of_winner = None  # 勝った艇自身が経験不足で順位付けできない → 集計から除外

            records.append({
                "race_id": race_id,
                "date": date,
                "boat1_label": boat1_label,
                "pattern_label": pattern_label,
                "pattern_key_v2": pattern_key_v2,
                "top_direct_course": top_direct,
                "chain_pairs": ";".join(f"{a}-{b}" for a, b in chain_pairs) if chain_pairs else "",
                "decisive_kimari": decisive_kimari,
                "winner_course": 1 if boats[1]["finish"] == 1 else None,
                "actual_1st_course": actual_1st_course,
                "actual_2nd_course": next(c for c in range(1, 7) if boats[c]["finish"] == 2),
                "actual_3rd_course": next(c for c in range(1, 7) if boats[c]["finish"] == 3),
                "n_classified_boats": sum(1 for c in range(2, 7) if attacker_info[c]["label"] != "経験不足") + (1 if boat1_label != "経験不足" else 0),
                "boat1_is_1st": boats[1]["finish"] == 1,
                "top_direct_is_1st": (top_direct is not None) and (boats[top_direct]["finish"] == 1),
                "chain_beneficiary_course": chain_beneficiary,
                "chain_beneficiary_is_1st": (chain_beneficiary is not None) and (boats[chain_beneficiary]["finish"] == 1),
                "n_ranked_boats": len(rank_of),
                "role_of_winner": role_of_winner,
            })

            # --- このレースの結果を蓄積に反映(次のレース以降のために) ---
            store.update_with_race(race_rows)

        diag_rows.append({"date": date, "n_races_cum": len(records)})

    return pd.DataFrame(records), pd.DataFrame(diag_rows), store


def summarize(records: pd.DataFrame):
    records["fully_classified"] = records["n_classified_boats"] == 6

    print("\n=== データ充足度の推移(全艇判定できたレースの割合) ===")
    records["week"] = records["date"].dt.to_period("W")
    weekly = records.groupby("week")["fully_classified"].mean()
    print(weekly.to_string())

    classified = records[records["fully_classified"]]
    print(f"\n全艇classified済みレース数: {len(classified)} / {len(records)} ({len(classified)/len(records):.1%})")

    print("\n=== 1号艇タイプ別: 実際の決まり手分布(全レース、判定済みのみ) ===")
    boat1_classified = records[records["boat1_label"] != "経験不足"]
    tab = pd.crosstab(boat1_classified["boat1_label"], boat1_classified["decisive_kimari"], normalize="index")
    print(tab.round(3).to_string())
    print("\n(各行のサンプル数)")
    print(boat1_classified["boat1_label"].value_counts().to_string())

    print("\n=== 直接威力トップ艇は実際に上位(3着以内)に来ているか ===")
    has_top = classified[classified["top_direct_course"].notna()].copy()
    has_top["top_in_top3"] = has_top.apply(
        lambda r: r["top_direct_course"] in (r["actual_1st_course"], r["actual_2nd_course"], r["actual_3rd_course"]), axis=1
    )
    print(f"サンプル数: {len(has_top)}")
    print(f"直接威力トップ艇が3着以内に来た割合: {has_top['top_in_top3'].mean():.1%}")
    print("(参考)2-6号艇がランダムに3着以内に入る確率はおよそ60%(5艇中3着分)")

    print("\n=== 連動ペア(まくり→まくり差し)が検出されたレースでの追跡(骨格確認用) ===")
    chain_races = classified[classified["chain_pairs"] != ""]
    print(f"連動ペア検出レース数: {len(chain_races)}")
    if len(chain_races) > 0:
        def beneficiary_in_top3(row):
            pairs = [tuple(map(int, p.split("-"))) for p in row["chain_pairs"].split(";")]
            beneficiaries = {b for _, b in pairs}
            actual_top3 = {row["actual_1st_course"], row["actual_2nd_course"], row["actual_3rd_course"]}
            return len(beneficiaries & actual_top3) > 0
        chain_races = chain_races.copy()
        chain_races["beneficiary_in_top3"] = chain_races.apply(beneficiary_in_top3, axis=1)
        print(f"連動先(まくり差し型)が3着以内に来た割合: {chain_races['beneficiary_in_top3'].mean():.1%}")

    print("\n=== パターン別 集計(サンプル数上位20パターン) ===")
    pattern_counts = records["pattern_label"].value_counts()
    print(pattern_counts.head(20).to_string())

    records.to_csv(OUT_DIR / "pattern_records.csv", index=False, encoding="utf-8-sig")
    pattern_counts.to_csv(OUT_DIR / "pattern_counts.csv", encoding="utf-8-sig")
    print(f"\n詳細レコードを {OUT_DIR / 'pattern_records.csv'} に保存しました。")


def summarize_v2(records: pd.DataFrame):
    print("\n\n========== v2: 1着率専用・次元圧縮パターン ==========")
    v2 = records[records["pattern_key_v2"].notna()].copy()
    print(f"v2パターンが判定できたレース数: {len(v2)} / {len(records)} ({len(v2)/len(records):.1%})")

    if len(v2) == 0:
        print("(判定できたレースが0件のため、これ以上の集計はできません)")
        return

    role_v2 = v2[v2["role_of_winner"].notna()].copy()
    print(f"勝者の役割まで判定できたレース数: {len(role_v2)} / {len(v2)} ({len(role_v2)/max(len(v2),1):.1%})")
    print("(『判定できた』は1号艇+筆頭威力艇+勝者自身が分類済み、という意味。威力2~5位は分類できていなくても集計には影響しない)")

    role_order = ["1号艇", "威力1位", "威力2位", "威力3位", "威力4位", "威力5位"]

    if len(role_v2) > 0:
        n_per_pattern = role_v2.groupby("pattern_key_v2")["race_id"].count()
        cross = pd.crosstab(role_v2["pattern_key_v2"], role_v2["role_of_winner"], normalize="index")
        cross = cross.reindex(columns=role_order, fill_value=0.0)
        cross.insert(0, "n", n_per_pattern)
        cross = cross.sort_values("n", ascending=False)

        print("\n=== パターン別 6艇相対評価(役割ごとの1着率、横の合計=100%、サンプル数上位15) ===")
        print(cross.head(15).round(3).to_string())

        cross.to_csv(OUT_DIR / "pattern_v2_table.csv", encoding="utf-8-sig")
        print(f"\nv2パターン表(6艇相対評価版)を {OUT_DIR / 'pattern_v2_table.csv'} に保存しました。")

    chain_v2 = v2[v2["chain_beneficiary_course"].notna()]
    if len(chain_v2) > 0:
        agg_chain = chain_v2.groupby("pattern_key_v2").agg(
            n=("race_id", "count"),
            chain_beneficiary_1st_rate=("chain_beneficiary_is_1st", "mean"),
        ).sort_values("n", ascending=False)
        print("\n=== (連動有のパターンのみ・参考)連動先艇の1着率(サンプル数上位10) ===")
        print(agg_chain.head(10).round(3).to_string())


def export_v2_table_json(records: pd.DataFrame, out_path: Path = None) -> dict:
    """
    v2パターンテーブルを JSON 形式で書き出す。
    prob_scenario_engine.py の _calc_tenkai_scores がルックアップとして使用する。

    出力形式:
    {
      "1号[粘り型] | 筆頭[2号:差し] | 連動有": {
        "n": 26888,
        "boat1_rate":  0.660,   # 1号艇1着率
        "force1_rate": 0.127,   # 筆頭威力艇1着率
        "chain_rate":  0.087,   # 連動先艇1着率（連動有のみ、なければnull）
      },
      ...
    }

    この辞書は auto_push.py から DATA_BASE_URL/v2_pattern_table.json として配信し、
    master_ext.json の "v2_pattern_table" キーに格納することで JS 側から参照できる。
    """
    if out_path is None:
        out_path = OUT_DIR / "v2_pattern_table.json"

    import json

    v2 = records[records["pattern_key_v2"].notna()].copy()
    if len(v2) == 0:
        print("[export_v2] v2パターンが0件のためJSONを生成しません")
        return {}

    role_v2   = v2[v2["role_of_winner"].notna()].copy()
    chain_v2  = v2[v2["chain_beneficiary_course"].notna()].copy()

    role_order = ["1号艇", "威力1位", "威力2位", "威力3位", "威力4位", "威力5位"]

    # --- 各パターンの役割別1着率を集計 ---
    cross = pd.crosstab(role_v2["pattern_key_v2"], role_v2["role_of_winner"], normalize="index")
    cross = cross.reindex(columns=role_order, fill_value=0.0)

    n_per_pattern = role_v2.groupby("pattern_key_v2")["race_id"].count()
    cross.insert(0, "n", n_per_pattern)

    # --- 連動先1着率を別途集計 ---
    chain_agg = chain_v2.groupby("pattern_key_v2").agg(
        chain_rate=("chain_beneficiary_is_1st", "mean")
    )

    # --- JSON辞書を組み立て ---
    result = {}
    for pk, row in cross.iterrows():
        entry = {
            "n":            int(row["n"]),
            "boat1_rate":   round(float(row.get("1号艇",  0.0)), 4),
            "force1_rate":  round(float(row.get("威力1位", 0.0)), 4),
            "force2_rate":  round(float(row.get("威力2位", 0.0)), 4),
            "chain_rate":   round(float(chain_agg.loc[pk, "chain_rate"]), 4)
                            if pk in chain_agg.index else None,
        }
        # サンプル数が少ないパターンは精度が低いのでフラグを立てる
        entry["reliable"] = entry["n"] >= 500
        result[pk] = entry

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n[export_v2] v2パターンテーブルを {out_path} に書き出しました ({len(result)}パターン)")
    print(f"  うちreliable(n>=500): {sum(1 for v in result.values() if v['reliable'])}パターン")
    return result


if __name__ == "__main__":
    paths = sorted(DATA_DIR.glob("*_results.csv"))
    if not paths:
        raise SystemExit(
            f"[エラー] {DATA_DIR} の中に *_results.csv が見つかりません。\n"
            f"  → スクリプト冒頭の DATA_DIR を、実際にCSVが入っているフォルダのパスに書き換えてください。"
        )
    print(f"[info] {len(paths)}ファイルを1ヶ月ずつ逐次処理します: {paths[0].name} ~ {paths[-1].name}")

    store = None
    record_frames = []
    for i, p in enumerate(paths, 1):
        print(f"[info] ({i}/{len(paths)}) {p.name} 処理中...")
        month_df = load_data(str(p))
        recs, _diag, store = process(month_df, store)  # storeを次のファイルへ引き継ぐ
        record_frames.append(recs)
        del month_df, recs  # 1ヶ月分が終わったらすぐ解放(メモリ節約)

    records = pd.concat(record_frames, ignore_index=True)
    summarize(records)
    summarize_v2(records)

    # ★ v2テーブルをJSONに書き出す（prob_scenario_engine.py から参照される）
    export_v2_table_json(records)
