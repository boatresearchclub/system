"""
競艇分析ツール ランチャー（高速版）
Python側でCSV集計を完了させ、ブラウザには集計済みデータのみ渡す。

使い方:
  python launch_analyzer.py
  python launch_analyzer.py --tenji 2026-06-28  # 特定日の展示JSONのみ
"""

import json
import re
import csv
import glob
import sys
import io
import math
import webbrowser
import tempfile
import argparse
import subprocess
from datetime import datetime
from pathlib import Path
from collections import defaultdict

# ============================================================
# ★ パス設定
# ============================================================
BASE              = Path(r"C:\Users\user\Desktop\データ収集")
RESULTS_CSV_PATTERN = str(BASE / "data_csv" / "*.csv")
TENJI_DIR         = BASE / "scripts" / "data"
PLAYER_MAP_PATH   = BASE / "scripts" / "player_id_map.json"
TEMPLATE_HTML     = Path(__file__).parent / "boatrace_analyzer.html"
# ============================================================

# ============================================================
# ★ GitHub公開用設定
#   事前準備:
#   1. GitHubでリポジトリを作成し、ローカルに clone しておく
#        git clone https://github.com/<あなたのID>/<リポジトリ名>.git
#   2. clone したフォルダのパスを GITHUB_REPO_DIR に書き換える
#   3. GitHub の Settings → Pages → Source を
#        "Deploy from a branch" / Branch: main / Folder: /docs
#      に設定する（これで GITHUB_REPO_DIR/docs/index.html が
#      https://<あなたのID>.github.io/<リポジトリ名>/ として公開される）
# ============================================================
GITHUB_REPO_DIR    = Path(r"C:\Users\user\Desktop\boatrace-viewer")  # ←自分のclone先パスに変更
GITHUB_OUTPUT_HTML = GITHUB_REPO_DIR / "docs" / "index.html"
# ============================================================

VENUE_JA_TO_EN = {
    "芦屋": "ashiya", "唐津": "karatsu", "徳山": "tokuyama", "尼崎": "amagasaki",
    "津": "tsu", "宮島": "miyajima", "鳴門": "naruto", "児島": "kojima",
    "平和島": "heiwajima", "福岡": "fukuoka", "蒲郡": "gamagori", "大村": "omura",
    "桐生": "kiryu", "住之江": "suminoe", "びわこ": "biwako", "丸亀": "marugame",
    "下関": "shimonoseki", "多摩川": "tamagawa", "常滑": "tokoname", "戸田": "toda",
    "江戸川": "edogawa", "浜名湖": "hamanako", "三国": "mikuni", "若松": "washinosu",
}


# ---------- ユーティリティ ----------

def read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp932", "shift_jis"):
        try:
            return path.read_text(encoding=enc)
        except Exception:
            continue
    raise ValueError(f"文字コード判定失敗: {path}")

def read_json(path: Path) -> dict:
    return json.loads(read_text(path))

def normalize_reg(r) -> str | None:
    if r is None:
        return None
    s = str(r).strip()
    return str(int(s)) if s.isdigit() else (s or None)

def bin_time(t) -> float | None:
    try:
        v = float(t)
        v100 = round(v * 100)
        return round((v100 // 6) * 6 / 100, 2)
    except Exception:
        return None

def bin_diff(diff: float) -> str:
    """平均との差をビン文字列に変換。
    A: 〜-0.11 / B: -0.10〜-0.06 / C: -0.05〜-0.01
    D: 0〜+0.04 / E: +0.05〜+0.09 / F: +0.10〜
    """
    d = round(diff * 100)
    if d <= -11: return "A"
    if d <=  -6: return "B"
    if d <=  -1: return "C"
    if d <=   4: return "D"
    if d <=   9: return "E"
    return "F"


def calc_rates(places: list) -> dict | None:
    n = len(places)
    if n == 0:
        return None
    return {
        "n":    n,
        "r1":   round(places.count(1) / n * 100, 1),
        "r2":   round(places.count(2) / n * 100, 1),
        "r3":   round(places.count(3) / n * 100, 1),
        "r123": round(sum(1 for p in places if p <= 3) / n * 100, 1),
    }


# ---------- CSV集計（Python側） ----------

def aggregate_csvs(csv_paths: list[Path]) -> tuple[dict, dict, dict, dict, dict]:
    """
    返り値:
      ctp     : {course_str: {tbin_str: [places]}}
      cap     : {course_str: [places]}
      pcp     : {reg: {course_str: {tbin_str: [places]}}}
      pca     : {reg: {course_str: [places]}}
      csv_map : {"venue_en|date|race|reg": place}  ← lap1集計用
    """
    # まず進入変更レースのキーを収集
    print("[INFO] 進入変更レースを検出中...")
    changed_races = set()  # "venue_en|date|race"
    for path in csv_paths:
        text = read_text(path)
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            frame_raw  = row.get("艇番", "").strip()
            course_raw = row.get("進入コース", "").strip()
            date_raw   = row.get("日付", "").strip()
            venue_raw  = row.get("会場名", "").strip()
            race_raw   = row.get("レース番号", "").strip()
            if not frame_raw or not course_raw:
                continue
            try:
                if int(frame_raw) != int(course_raw):
                    venue_en = VENUE_JA_TO_EN.get(venue_raw, venue_raw)
                    changed_races.add(f"{venue_en}|{normalize_date(date_raw)}|{normalize_race(race_raw)}")
            except Exception:
                continue
    print(f"[OK] 進入変更レース除外: {len(changed_races)}レース")

    ctp = defaultdict(lambda: defaultdict(list))
    cap = defaultdict(list)
    pcp = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    pca = defaultdict(lambda: defaultdict(list))
    # 平均差ビン集計用: raw_times[reg][course] = [times...]
    raw_times = defaultdict(lambda: defaultdict(list))
    pcd = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))  # reg->course->diff_bin->[places]
    csv_map = {}

    for path in csv_paths:
        print(f"  集計中: {path.name}", end="", flush=True)
        text = read_text(path)
        reader = csv.DictReader(io.StringIO(text))
        count = 0
        for row in reader:
            tenji_raw  = row.get("展示タイム", "").strip()
            course_raw = row.get("進入コース", "").strip()
            place_raw  = row.get("着順", "").strip()
            reg_raw    = row.get("登録番号", "").strip()
            date_raw   = row.get("日付", "").strip()
            venue_raw  = row.get("会場名", "").strip()
            race_raw   = row.get("レース番号", "").strip()

            if not tenji_raw or not course_raw or not place_raw or not reg_raw:
                continue

            venue_en = VENUE_JA_TO_EN.get(venue_raw, venue_raw)
            race_key = f"{venue_en}|{normalize_date(date_raw)}|{normalize_race(race_raw)}"
            if race_key in changed_races:
                continue  # 進入変更レース除外

            try:
                course = str(int(course_raw))
                place  = int(place_raw)
                tbin   = bin_time(tenji_raw)
                reg    = normalize_reg(reg_raw)
            except Exception:
                continue
            if tbin is None or reg is None:
                continue

            tbin_s = f"{tbin:.2f}"
            ctp[course][tbin_s].append(place)
            cap[course].append(place)
            pcp[reg][course][tbin_s].append(place)
            pca[reg][course].append(place)
            raw_times[reg][course].append((float(tenji_raw), place))
            count += 1

            if date_raw and race_raw and reg:
                key = f"{venue_en}|{normalize_date(date_raw)}|{normalize_race(race_raw)}|{reg}"
                csv_map[key] = place

        print(f" → {count:,}件")

    # 平均差ビン集計（全データ蓄積後に平均を計算してから差分ビンに振り分け）
    print("[INFO] 平均差ビン集計中...")
    pcavg = {}  # reg -> course -> avg_time
    for reg, courses in raw_times.items():
        pcavg[reg] = {}
        for course, tplace_list in courses.items():
            times = [t for t, _ in tplace_list]
            avg = round(sum(times) / len(times), 3)
            pcavg[reg][course] = avg
            for t, place in tplace_list:
                dbin = bin_diff(t - avg)
                pcd[reg][course][dbin].append(place)
    print(f"[OK] 平均差ビン集計: {sum(len(c) for r in pcd.values() for c in r.values()):,}件")

    def dd2d(d):
        if isinstance(d, defaultdict):
            return {k: dd2d(v) for k, v in d.items()}
        if isinstance(d, list):
            return d
        return d

    return dd2d(ctp), dd2d(cap), dd2d(pcp), dd2d(pca), dd2d(pcd), pcavg, csv_map


def normalize_date(d) -> str:
    """日付を YYYYMMDD 形式に統一（ハイフン・スラッシュ除去）。"""
    return str(d).replace("-", "").replace("/", "").strip()

def normalize_race(r) -> str:
    """レース番号を int→str で統一（ゼロパディング除去）。"""
    try:
        return str(int(str(r).strip()))
    except Exception:
        return str(r).strip()

def aggregate_lap1(tenji_all: dict, csv_map: dict, player_map: dict) -> tuple[dict, dict, dict, dict]:
    """全展示JSONのlap1+tenji合計で集計。着順はcsv_mapから引く（進入変更は既に除外済み）。"""
    ctpL = defaultdict(lambda: defaultdict(list))
    capL = defaultdict(list)
    pcpL = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    pcaL = defaultdict(lambda: defaultdict(list))

    name_to_reg = {v.replace(" ", ""): normalize_reg(k) for k, v in player_map.items()}
    count = 0
    skip_no_lap1 = 0
    skip_no_place = 0

    for race_key, race_data in tenji_all.items():
        if not isinstance(race_data, dict):
            continue
        for fk, entry in race_data.items():
            if not isinstance(entry, dict):
                continue
            lap1_raw   = entry.get("lap1")
            tenji_raw  = entry.get("tenji")
            course_raw = entry.get("course")
            venue_raw  = entry.get("venue", "")
            venue      = VENUE_JA_TO_EN.get(venue_raw, venue_raw)
            date       = normalize_date(entry.get("date", ""))
            race       = normalize_race(entry.get("race", ""))

            if lap1_raw is None or tenji_raw is None or not course_raw:
                skip_no_lap1 += 1
                continue
            try:
                lap1   = float(lap1_raw)
                tenji  = float(tenji_raw)
                course = str(int(course_raw))
                total  = round(lap1 + tenji, 2)
                tbin   = bin_time(total)
            except Exception:
                skip_no_lap1 += 1
                continue
            if tbin is None:
                skip_no_lap1 += 1
                continue

            reg_raw = entry.get("reg")
            if reg_raw not in (None, ""):
                reg = normalize_reg(reg_raw)
            else:
                name = (entry.get("racer") or "").replace(" ", "")
                reg = name_to_reg.get(name)
            if not reg:
                skip_no_lap1 += 1
                continue

            # csv_mapにあるキー＝進入変更除外済みレースのみ
            key = f"{venue}|{date}|{race}|{reg}"
            place = csv_map.get(key)
            if place is None:
                skip_no_place += 1
                continue

            tbin_s = f"{tbin:.2f}"
            ctpL[course][tbin_s].append(place)
            capL[course].append(place)
            pcpL[reg][course][tbin_s].append(place)
            pcaL[reg][course].append(place)
            count += 1

    print(f"[OK] lap1集計完了: {count:,}件マッチ")
    print(f"     スキップ(lap1/tenji/course/reg欠損): {skip_no_lap1:,}件")
    print(f"     スキップ(csv_mapキー不一致):         {skip_no_place:,}件")

    def dd2d(d):
        if isinstance(d, defaultdict):
            return {k: dd2d(v) for k, v in d.items()}
        if isinstance(d, list):
            return d
        return d

    return dd2d(ctpL), dd2d(capL), dd2d(pcpL), dd2d(pcaL)


# ---------- 展示JSON ----------

def find_tenji_files(tenji_dir: Path, date_str: str = None, all_files: bool = False) -> list[Path]:
    files = sorted(glob.glob(str(tenji_dir / "tenji_*.json")))
    if not files:
        return []
    if date_str:
        d = date_str.replace("-", "")
        return [Path(f) for f in files if d in Path(f).name]
    if all_files:
        return [Path(f) for f in files]
    return [Path(files[-1])]

def _load_one_tenji(path: Path) -> dict:
    try:
        return read_json(path)
    except Exception as e:
        print(f"[WARN] スキップ {path.name}: {e}")
        return {}

def load_tenji(paths: list[Path]) -> dict:
    from concurrent.futures import ThreadPoolExecutor
    merged = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for data in ex.map(_load_one_tenji, paths):
            merged.update(data)
    return merged


# ---------- エントリー生成 ----------

def build_entries(tenji: dict, player_map: dict,
                  ctp: dict, cap: dict, pcp: dict, pca: dict) -> tuple[list, list]:

    name_to_reg = {v.replace(" ", ""): normalize_reg(k) for k, v in player_map.items()}
    reg_to_name = {normalize_reg(k): v for k, v in player_map.items()}

    cap_rates = {ck: calc_rates(v) for ck, v in cap.items()}

    entries = []
    seen_vr = set()
    venue_races = []

    for race_key, race_data in tenji.items():
        if not isinstance(race_data, dict):
            continue
        for fk, entry in race_data.items():
            if not isinstance(entry, dict) or entry.get("tenji") is None:
                continue

            racer_name = (entry.get("racer") or "").replace(" ", "")
            reg_raw = entry.get("reg")
            reg = normalize_reg(reg_raw) if reg_raw not in (None, "") \
                  else name_to_reg.get(racer_name)

            try:
                course = int(entry.get("course", 0))
            except Exception:
                continue
            ck = str(course)

            try:
                tenji_val = float(entry.get("tenji"))
            except Exception:
                continue
            _tbin = bin_time(tenji_val)
            tbin_s = f"{_tbin:.2f}" if _tbin is not None else None

            base      = calc_rates(ctp.get(ck, {}).get(tbin_s, [])) if tbin_s else None
            base_c    = cap_rates.get(ck)
            pl_base   = calc_rates(pcp.get(reg, {}).get(ck, {}).get(tbin_s, [])) \
                        if reg and tbin_s else None
            pl_course = calc_rates(pca.get(reg, {}).get(ck, [])) if reg else None

            def diff(a, b, k):
                return round(a[k] - b[k], 1) if a and b else None

            motor_rate2 = entry.get("motor_rate2")
            motor_rate3 = entry.get("motor_rate3")

            # lap1
            lap1_raw = entry.get("lap1")
            lap1_val = float(lap1_raw) if lap1_raw is not None else None

            e = {
                "raceKey": race_key,
                "venue": entry.get("venue"),
                "race": int(entry.get("race", 0)),
                "frame": int(entry.get("frame", 0)),
                "racer": entry.get("racer"),
                "reg": reg,
                "grade": entry.get("grade"),
                "course": course,
                "tenji": tenji_val,
                "lap1": lap1_val,
                "tenjiRank": entry.get("tenji_rank"),
                "motorRate2": float(motor_rate2) if motor_rate2 is not None else None,
                "motorRate3": float(motor_rate3) if motor_rate3 is not None else None,
                "base": base, "baseC": base_c,
                "plBase": pl_base, "plCourse": pl_course,
                "diff1":   diff(pl_course, base_c, "r1"),
                "diff2":   diff(pl_course, base_c, "r2"),
                "diff3":   diff(pl_course, base_c, "r3"),
                "diff123": diff(pl_course, base_c, "r123"),
            }
            entries.append(e)

            vr_key = f"{e['venue']}_{e['race']}"
            if vr_key not in seen_vr:
                seen_vr.add(vr_key)
                venue_races.append({
                    "venue": e["venue"],
                    "venueJa": e["venue"],
                    "race": e["race"],
                    "key": vr_key,
                })

    venue_races.sort(key=lambda x: (x["venue"], x["race"]))
    return entries, venue_races


# ---------- JS埋め込み ----------

def build_auto_script(entries, venue_races, ctp, cap, pcp, pca,
                      ctpL, capL, pcpL, pcaL,
                      pcd, pcavg,
                      reg_to_name, name_to_reg,
                      tenji_file_names: list) -> str:

    def jd(obj, label):
        print(f"  JSON化: {label}...", end="", flush=True)
        s = json.dumps(obj, ensure_ascii=False, separators=(',',':'))
        print(f" {len(s)//1024}KB")
        return s

    entries_js     = jd(entries,     "entries")
    venue_races_js = jd(venue_races, "venue_races")
    ctp_js         = jd(ctp,         "ctp")
    cap_js         = jd(cap,         "cap")
    pcp_js         = jd(pcp,         "pcp")
    pca_js         = jd(pca,         "pca")
    pcd_js         = jd(pcd,         "pcd")
    pcavg_js       = jd(pcavg,       "pcavg")
    ctpL_js        = jd(ctpL,        "ctpL")
    capL_js        = jd(capL,        "capL")
    pcpL_js        = jd(pcpL,        "pcpL")
    pcaL_js        = jd(pcaL,        "pcaL")
    r2n_js         = jd(reg_to_name, "reg_to_name")
    n2r_js         = jd(name_to_reg, "name_to_reg")
    tenji_ui_js    = json.dumps(
        [{"name": n, "data": {}} for n in tenji_file_names],
        ensure_ascii=False, separators=(',',':')
    )

    return f"""
// ============================================================
// 自動埋め込みデータ（Python集計済み）
// ============================================================
(function() {{
  state.ctp        = {ctp_js};
  state.cap        = {cap_js};
  state.pcp        = {pcp_js};
  state.pca        = {pca_js};
  state.pcd        = {pcd_js};
  state.pcavg      = {pcavg_js};
  state.ctpL       = {ctpL_js};
  state.capL       = {capL_js};
  state.pcpL       = {pcpL_js};
  state.pcaL       = {pcaL_js};
  state.regToName  = {r2n_js};
  state.nameToReg  = {n2r_js};
  state.entries    = {entries_js};
  state.venueRaces = {venue_races_js};

  state.resultsFiles = [{{name:"Python集計済み",text:""}}];
  state.tenjiFiles   = {tenji_ui_js};
  state.playersRaw   = {{}};

  renderResultsFileList();
  renderTenjiFileList();
  var ps = document.getElementById("st-players");
  if (ps) ps.textContent = "自動読み込み済み ✓";
  var dp = document.getElementById("drop-players");
  if (dp) dp.classList.add("loaded");

  if (state.venueRaces.length > 0) {{
    state.selKey = state.venueRaces[0].key;
  }}
  document.getElementById("btn-save").style.display = "";
  renderSidebar();
  renderContent();
  initPlayerSearch();
}})();
"""


def build_full_html(template_path: Path, auto_script: str) -> str:
    """テンプレートHTMLに集計済みデータ（auto_script）を埋め込んだ完全なHTML文字列を返す。"""
    html = template_path.read_text(encoding="utf-8")
    # 既存の window.__DATA__ = {...}; // END_DATA ブロックを全て除去
    # （テンプレートに誤ってデータ入りHTMLが上書きされていた場合の重複混入を防ぐ）
    html = re.sub(
        r"\s*window\.__DATA__\s*=\s*\{.*?\};\s*//\s*END_DATA\s*",
        "\n",
        html,
        flags=re.DOTALL,
    )
    # CRLF/LF両対応
    for marker in ["</script>\r\n</body>", "</script>\n</body>"]:
        if marker in html:
            return html.replace(marker, auto_script + marker, 1)
    parts = html.rsplit("</script>", 1)
    return parts[0] + auto_script + "</script>" + (parts[1] if len(parts) > 1 else "")


def open_in_browser(full_html: str) -> str:
    """ローカル確認用に一時HTMLを生成してブラウザで開く。"""
    tmp = tempfile.NamedTemporaryFile(
        suffix=".html", delete=False,
        mode="w", encoding="utf-8", prefix="boatrace_"
    )
    tmp.write(full_html)
    tmp.close()
    webbrowser.open(f"file:///{tmp.name}")
    print(f"[OK] ブラウザで開きました: {tmp.name}")
    return tmp.name


def save_for_github(full_html: str, output_path: Path) -> None:
    """GitHub公開用の固定パスにHTMLを書き出す（毎回上書き）。"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(full_html, encoding="utf-8")
    size_kb = output_path.stat().st_size // 1024
    print(f"[OK] GitHub公開用HTML生成: {output_path} ({size_kb:,}KB)")
    if size_kb > 50_000:
        print("[WARN] ファイルサイズが50MBを超えています。GitHubへのpushに失敗する可能性があります。")


def git_publish(repo_dir: Path, output_path: Path) -> None:
    """git add / commit / push を自動実行してGitHubに反映する。"""
    if not (repo_dir / ".git").exists():
        print(f"[ERROR] {repo_dir} はgitリポジトリではありません。")
        print(f"   先に以下を実行してください: git clone <あなたのリポジトリURL> \"{repo_dir}\"")
        return
    rel = output_path.relative_to(repo_dir)
    try:
        subprocess.run(["git", "add", str(rel)], cwd=repo_dir, check=True)
        msg = f"update: {datetime.now():%Y-%m-%d %H:%M}"
        result = subprocess.run(
            ["git", "commit", "-m", msg],
            cwd=repo_dir, capture_output=True, text=True
        )
        combined = result.stdout + result.stderr
        if result.returncode != 0:
            if "nothing to commit" in combined:
                print("[INFO] 前回から変更なし（コミットをスキップ）")
                return
            print("[ERROR] git commit に失敗しました:")
            print(combined)
            return
        subprocess.run(["git", "push"], cwd=repo_dir, check=True)
        print("[OK] GitHubへpushしました")
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] git操作に失敗しました: {e}")
        print("手動で以下を実行してください:")
        print(f'  cd "{repo_dir}"')
        print(f"  git add {rel}")
        print(f'  git commit -m "update"')
        print("  git push")


# ---------- メイン ----------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenji", default=None, help="展示JSON日付 YYYY-MM-DD（省略=最新1日）")
    parser.add_argument("--all-tenji", action="store_true", help="全展示JSONを読み込む（低速）")
    parser.add_argument("--no-browser", action="store_true", help="ローカルでブラウザを開かない")
    parser.add_argument("--publish", action="store_true",
                         help="GitHub用HTML保存後、git add/commit/push まで自動実行する")
    args = parser.parse_args()

    print("=" * 50)
    print("競艇分析ツール ランチャー（高速版）")
    print("=" * 50)

    if not TEMPLATE_HTML.exists():
        print(f"[ERROR] HTMLが見つかりません: {TEMPLATE_HTML}")
        sys.exit(1)

    # CSV集計
    csv_paths = [Path(p) for p in sorted(glob.glob(RESULTS_CSV_PATTERN))]
    result_csvs = [p for p in csv_paths if "results" in p.name.lower()]
    if not result_csvs:
        print(f"[WARN] results CSVなし: {RESULTS_CSV_PATTERN}")
    else:
        print(f"[INFO] results CSV {len(result_csvs)}件を集計中...")

    ctp, cap, pcp, pca, pcd, pcavg, csv_map = aggregate_csvs(result_csvs)
    print(f"[OK] 集計完了: コース数={len(ctp)}, 選手数={len(pcp)}")

    # 選手マップ
    player_map = {}
    if PLAYER_MAP_PATH.exists():
        player_map = read_json(PLAYER_MAP_PATH)
        print(f"[OK] 選手マップ: {len(player_map)}件")

    reg_to_name = {normalize_reg(k): v for k, v in player_map.items()}
    name_to_reg = {v.replace(" ", ""): normalize_reg(k) for k, v in player_map.items()}

    # 展示JSON（今日分のみ）
    tenji_paths = find_tenji_files(TENJI_DIR, args.tenji, all_files=args.all_tenji)
    if not tenji_paths:
        print(f"[WARN] 展示JSONなし: {TENJI_DIR}")
        tenji_data = {}
    else:
        print(f"[OK] 展示JSON {len(tenji_paths)}件を読み込み中...")
        tenji_data = load_tenji(tenji_paths)

    tenji_file_names = [p.name for p in tenji_paths]

    # lap1集計（全JSONを対象）
    print("[INFO] lap1集計用に全展示JSONを読み込み中...")
    all_tenji_paths = find_tenji_files(TENJI_DIR, all_files=True)
    if all_tenji_paths:
        all_tenji_data = load_tenji(all_tenji_paths)
        ctpL, capL, pcpL, pcaL = aggregate_lap1(all_tenji_data, csv_map, player_map)
    else:
        ctpL, capL, pcpL, pcaL = {}, {}, {}, {}

    # エントリー生成
    print("[INFO] エントリー生成中...")
    entries, venue_races = build_entries(tenji_data, player_map, ctp, cap, pcp, pca)
    print(f"[OK] エントリー: {len(entries)}件 / レース: {len(venue_races)}件")

    # HTML生成
    auto_script = build_auto_script(
        entries, venue_races, ctp, cap, pcp, pca,
        ctpL, capL, pcpL, pcaL,
        pcd, pcavg,
        reg_to_name, name_to_reg, tenji_file_names
    )
    full_html = build_full_html(TEMPLATE_HTML, auto_script)

    # ローカル確認用にブラウザで開く（--no-browser で抑制可）
    if not args.no_browser:
        open_in_browser(full_html)

    # GitHub公開用の固定パスへ保存（毎回上書き）
    save_for_github(full_html, GITHUB_OUTPUT_HTML)

    if args.publish:
        git_publish(GITHUB_REPO_DIR, GITHUB_OUTPUT_HTML)
    else:
        rel = GITHUB_OUTPUT_HTML.relative_to(GITHUB_REPO_DIR)
        print("[INFO] GitHubへ反映するには以下を実行してください:")
        print(f'  cd "{GITHUB_REPO_DIR}"')
        print(f"  git add {rel}")
        print(f'  git commit -m "update"')
        print("  git push")
        print("  (次回以降は `python launch_analyzer.py --publish` で自動実行できます)")

    print("\n完了！")


if __name__ == "__main__":
    main()
