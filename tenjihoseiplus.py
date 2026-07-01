"""
tenjihoseiplus.py
====================================================================
展示タイム分析ビュー（旧 launch_analyzer.py のロジック）を
auto_push.py の監視ループから呼び出すためのモジュール。

【役割】
  結果CSV（着順・展示タイム・進入コース入り）と展示情報JSONから
  「コース×展示タイム帯別の着率」を集計し、tenjihoseiplus.html
  （boatrace_analyzer.html にデータを埋め込んだ完成形）を書き出す。

【auto_push.py 側の呼び出し方】
    from tenjihoseiplus import maybe_update_tenjihoseiplus

    updated = maybe_update_tenjihoseiplus(
        results_csv_dir=RESULTS_CSV_DIR,
        tenji_dir=TENJI_DIR,
        player_map_path=PLAYER_ID_MAP,
        template_html=TENJIHOSEIPLUS_TEMPLATE,
        output_html=TENJIHOSEIPLUS_HTML,
    )
    # updated が True のときだけ git add 対象に含める

【重要】
  結果CSVの集計（aggregate_csvs / aggregate_lap1）は重い処理なので、
  呼び出し側が毎ループ（2秒間隔など）呼んでも問題ないように、
  「結果CSVフォルダの中身に変化がない限り再集計しない」キャッシュを
  内部に持っている。展示JSON側の変化だけなら毎回軽量に再描画される。
"""

import json
import re
import csv
import glob
import io
from pathlib import Path
from collections import defaultdict

# ============================================================
# 会場名 日本語→英語スラッグ
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

def normalize_date(d) -> str:
    return str(d).replace("-", "").replace("/", "").strip()

def normalize_race(r) -> str:
    try:
        return str(int(str(r).strip()))
    except Exception:
        return str(r).strip()


# ---------- CSV集計 ----------

def aggregate_csvs(csv_paths: list[Path]) -> tuple[dict, dict, dict, dict, dict, dict, dict]:
    print("[tenjihoseiplus] 進入変更レースを検出中...")
    changed_races = set()
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
    print(f"[tenjihoseiplus] 進入変更レース除外: {len(changed_races)}レース")

    ctp = defaultdict(lambda: defaultdict(list))
    cap = defaultdict(list)
    pcp = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    pca = defaultdict(lambda: defaultdict(list))
    raw_times = defaultdict(lambda: defaultdict(list))
    pcd = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    csv_map = {}

    for path in csv_paths:
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
                continue

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

        print(f"  [tenjihoseiplus] 集計: {path.name} → {count:,}件")

    print("[tenjihoseiplus] 平均差ビン集計中...")
    pcavg = {}
    for reg, courses in raw_times.items():
        pcavg[reg] = {}
        for course, tplace_list in courses.items():
            times = [t for t, _ in tplace_list]
            avg = round(sum(times) / len(times), 3)
            pcavg[reg][course] = avg
            for t, place in tplace_list:
                dbin = bin_diff(t - avg)
                pcd[reg][course][dbin].append(place)

    def dd2d(d):
        if isinstance(d, defaultdict):
            return {k: dd2d(v) for k, v in d.items()}
        if isinstance(d, list):
            return d
        return d

    return dd2d(ctp), dd2d(cap), dd2d(pcp), dd2d(pca), dd2d(pcd), pcavg, csv_map


def aggregate_lap1(tenji_all: dict, csv_map: dict, player_map: dict) -> tuple[dict, dict, dict, dict, dict, dict]:
    ctpL = defaultdict(lambda: defaultdict(list))
    capL = defaultdict(list)
    pcpL = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    pcaL = defaultdict(lambda: defaultdict(list))
    raw_timesL = defaultdict(lambda: defaultdict(list))  # reg -> course -> [(total, place)]
    pcdL = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))

    name_to_reg = {v.replace(" ", ""): normalize_reg(k) for k, v in player_map.items()}
    count = 0

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
                continue
            try:
                lap1   = float(lap1_raw)
                tenji  = float(tenji_raw)
                course = str(int(course_raw))
                total  = round(lap1 + tenji, 2)
                tbin   = bin_time(total)
            except Exception:
                continue
            if tbin is None:
                continue

            reg_raw = entry.get("reg")
            if reg_raw not in (None, ""):
                reg = normalize_reg(reg_raw)
            else:
                name = (entry.get("racer") or "").replace(" ", "")
                reg = name_to_reg.get(name)
            if not reg:
                continue

            key = f"{venue}|{date}|{race}|{reg}"
            place = csv_map.get(key)
            if place is None:
                continue

            tbin_s = f"{tbin:.2f}"
            ctpL[course][tbin_s].append(place)
            capL[course].append(place)
            pcpL[reg][course][tbin_s].append(place)
            pcaL[reg][course].append(place)
            raw_timesL[reg][course].append((total, place))
            count += 1

    print(f"[tenjihoseiplus] lap1集計完了: {count:,}件マッチ")

    print("[tenjihoseiplus] 1周+展示 平均差ビン集計中...")
    pcavgL = {}
    for reg, courses in raw_timesL.items():
        pcavgL[reg] = {}
        for course, tplace_list in courses.items():
            times = [t for t, _ in tplace_list]
            avg = round(sum(times) / len(times), 3)
            pcavgL[reg][course] = avg
            for t, place in tplace_list:
                dbin = bin_diff(t - avg)
                pcdL[reg][course][dbin].append(place)

    def dd2d(d):
        if isinstance(d, defaultdict):
            return {k: dd2d(v) for k, v in d.items()}
        if isinstance(d, list):
            return d
        return d

    return dd2d(ctpL), dd2d(capL), dd2d(pcpL), dd2d(pcaL), dd2d(pcdL), pcavgL


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
        print(f"[tenjihoseiplus][WARN] スキップ {path.name}: {e}")
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
                  ctp: dict, cap: dict, pcp: dict, pca: dict,
                  deadline_map: dict = None) -> tuple[list, list]:

    name_to_reg = {v.replace(" ", ""): normalize_reg(k) for k, v in player_map.items()}
    cap_rates = {ck: calc_rates(v) for ck, v in cap.items()}

    # __deadline は tenji JSON に埋め込まれている場合はそちらを優先
    # フォーマット: {"mikuni": {"1": "10:30", "2": "11:00"}, ...}
    _dl_map = tenji.get("__deadline") or deadline_map or {}

    entries = []
    seen_vr = set()
    venue_races = []

    for race_key, race_data in tenji.items():
        if race_key.startswith("__") or not isinstance(race_data, dict):
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
                # 締切時刻を取得（slug キーで検索）
                venue_slug = e["venue"] or ""
                rno = e["race"]
                vm = _dl_map.get(venue_slug, {})
                dl = vm.get(str(rno)) or vm.get(rno)
                venue_races.append({
                    "venue": e["venue"], "venueJa": e["venue"],
                    "race": rno, "key": vr_key,
                    "deadline": dl,  # "HH:MM" or None
                })

    VENUE_ORDER = [
        "kiryu","toda","edogawa","heiwajima","tamagawa","hamanako",
        "gamagori","tokoname","tsu","mikuni","biwako","suminoe",
        "amagasaki","naruto","marugame","kojima","miyajima","tokuyama",
        "shimonoseki","wakamatsu","washinosu","ashiya","fukuoka","karatsu","omura",
    ]
    venue_races.sort(key=lambda x: (
        VENUE_ORDER.index(x["venue"]) if x["venue"] in VENUE_ORDER else 999,
        x["race"]
    ))
    return entries, venue_races


# ---------- JS埋め込み ----------

def build_auto_script(entries, venue_races, ctp, cap, pcp, pca,
                      ctpL, capL, pcpL, pcaL,
                      pcd, pcavg,
                      pcdL, pcavgL,
                      reg_to_name, name_to_reg,
                      tenji_file_names: list,
                      business_date: str = None) -> str:

    def jd(obj):
        return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))

    entries_js     = jd(entries)
    venue_races_js = jd(venue_races)
    ctp_js         = jd(ctp)
    cap_js         = jd(cap)
    pcp_js         = jd(pcp)
    pca_js         = jd(pca)
    pcd_js         = jd(pcd)
    pcavg_js       = jd(pcavg)
    pcdL_js        = jd(pcdL)
    pcavgL_js      = jd(pcavgL)
    ctpL_js        = jd(ctpL)
    capL_js        = jd(capL)
    pcpL_js        = jd(pcpL)
    pcaL_js        = jd(pcaL)
    r2n_js         = jd(reg_to_name)
    n2r_js         = jd(name_to_reg)
    tenji_ui_js    = json.dumps(
        [{"name": n, "data": {}} for n in tenji_file_names],
        ensure_ascii=False, separators=(',', ':')
    )
    business_date_js = json.dumps(business_date, ensure_ascii=False)

    return f"""
// ============================================================
// 自動埋め込みデータ（tenjihoseiplus.py 集計済み）
// ============================================================
window.__DATA__ = {{
  "entries":{entries_js},
  "venueRaces":{venue_races_js},
  "ctp":{ctp_js},
  "cap":{cap_js},
  "pcp":{pcp_js},
  "pca":{pca_js},
  "pcd":{pcd_js},
  "pcavg":{pcavg_js},
  "ctpL":{ctpL_js},
  "capL":{capL_js},
  "pcpL":{pcpL_js},
  "pcaL":{pcaL_js},
  "pcdL":{pcdL_js},
  "pcavgL":{pcavgL_js},
  "regToName":{r2n_js},
  "nameToReg":{n2r_js},
  "businessDate":{business_date_js}
}}; // END_DATA
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
  state.pcdL       = {pcdL_js};
  state.pcavgL     = {pcavgL_js};
  state.regToName  = {r2n_js};
  state.nameToReg  = {n2r_js};
  state.entries    = {entries_js};
  state.venueRaces = {venue_races_js};
  state.businessDate = {business_date_js};

  state.resultsFiles = [{{name:"自動集計済み",text:""}}];
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
    html = template_path.read_text(encoding="utf-8")
    # ── 既存の自動埋め込みブロックを全て除去 ────────────────────────────────
    # 【バグ修正 2026-xx-xx】
    #   旧実装は window.__DATA__ = {...}; // END_DATA だけを除去しており、
    #   それに続く (function() { state.ctp=...; ... })(); という大きなIIFE
    #   ブロックが除去対象に入っていなかった。
    #   そのため呼び出すたびに古いIIFEが残ったまま新しいIIFEが追記され続け、
    #   出力（テンプレートに誤って上書きされた場合は特に）が際限なく肥大化していた。
    #   （実例: 67回分のIIFEが蓄積し、ファイルサイズが約7.4MB増加していた）
    #
    #   修正: 「// 自動埋め込みデータ（tenjihoseiplus.py 集計済み）」の見出しコメントから
    #   次の見出し（＝次の埋め込みブロックの先頭）または </script> の直前までを
    #   ひとまとめに除去する。window.__DATA__ ブロックも IIFE ブロックもまとめて
    #   消えるため、ブロックがいくつ蓄積していても re.sub 一発で全部除去できる。
    html = re.sub(
        r"\n+// =+\n// 自動埋め込みデータ.*?(?=\n// =+\n// 自動埋め込みデータ|\s*</script>)",
        "\n",
        html,
        flags=re.DOTALL,
    )
    for marker in ["</script>\r\n</body>", "</script>\n</body>"]:
        if marker in html:
            return html.replace(marker, auto_script + marker, 1)
    parts = html.rsplit("</script>", 1)
    return parts[0] + auto_script + "</script>" + (parts[1] if len(parts) > 1 else "")


# ============================================================
# キャッシュ層（重いCSV集計を毎ループ実行しないため）
# ============================================================

_cache = {
    "csv_sig": None, "player_map_sig": None,
    "ctp": None, "cap": None, "pcp": None, "pca": None,
    "pcd": None, "pcavg": None, "csv_map": None,
    "ctpL": None, "capL": None, "pcpL": None, "pcaL": None,
    "pcdL": None, "pcavgL": None,
    "player_map": None, "reg_to_name": None, "name_to_reg": None,
}

def _csv_dir_signature(results_csv_dir: Path) -> tuple:
    if not results_csv_dir.exists():
        return ()
    paths = sorted(glob.glob(str(results_csv_dir / "*.csv")))
    return tuple((p, Path(p).stat().st_mtime) for p in paths)

def _ensure_csv_aggregates(results_csv_dir: Path, tenji_dir: Path,
                            player_map_path: Path, force: bool = False) -> bool:
    """結果CSV・選手マップに変更があれば再集計してキャッシュを更新する。
    変更がなければ何もせず False を返す（高速スキップ）。"""
    sig = _csv_dir_signature(results_csv_dir)
    pm_sig = player_map_path.stat().st_mtime if player_map_path.exists() else None

    if not force and sig == _cache["csv_sig"] and pm_sig == _cache["player_map_sig"] \
       and _cache["ctp"] is not None:
        return False

    csv_paths = [Path(p) for p, _ in sig]
    result_csvs = [p for p in csv_paths if "results" in p.name.lower()] or csv_paths
    if not result_csvs:
        print(f"[tenjihoseiplus][WARN] 結果CSVなし: {results_csv_dir}")
        ctp, cap, pcp, pca, pcd, pcavg, csv_map = {}, {}, {}, {}, {}, {}, {}
    else:
        print(f"[tenjihoseiplus] 結果CSV {len(result_csvs)}件を再集計中...")
        ctp, cap, pcp, pca, pcd, pcavg, csv_map = aggregate_csvs(result_csvs)

    player_map = {}
    if player_map_path.exists():
        player_map = read_json(player_map_path)
    reg_to_name = {normalize_reg(k): v for k, v in player_map.items()}
    name_to_reg = {v.replace(" ", ""): normalize_reg(k) for k, v in player_map.items()}

    all_tenji_paths = find_tenji_files(tenji_dir, all_files=True)
    if all_tenji_paths:
        all_tenji_data = load_tenji(all_tenji_paths)
        ctpL, capL, pcpL, pcaL, pcdL, pcavgL = aggregate_lap1(all_tenji_data, csv_map, player_map)
    else:
        ctpL, capL, pcpL, pcaL, pcdL, pcavgL = {}, {}, {}, {}, {}, {}

    _cache.update({
        "csv_sig": sig, "player_map_sig": pm_sig,
        "ctp": ctp, "cap": cap, "pcp": pcp, "pca": pca,
        "pcd": pcd, "pcavg": pcavg, "csv_map": csv_map,
        "ctpL": ctpL, "capL": capL, "pcpL": pcpL, "pcaL": pcaL,
        "pcdL": pcdL, "pcavgL": pcavgL,
        "player_map": player_map, "reg_to_name": reg_to_name, "name_to_reg": name_to_reg,
    })
    print(f"[tenjihoseiplus] 再集計完了: コース数={len(ctp)} 選手数={len(pcp)}")
    return True


def maybe_update_tenjihoseiplus(results_csv_dir: Path, tenji_dir: Path,
                                 player_map_path: Path, template_html: Path,
                                 output_html: Path,
                                 tenji_date: str = None,
                                 force_csv_reaggregate: bool = False,
                                 deadline_map: dict = None) -> bool:
    """
    tenjihoseiplus.html を必要なら再生成して書き出す。

    戻り値:
      True  → output_html を書き換えた（呼び出し側で git add すべき）
      False → 変更なし、またはテンプレ/展示データなしでスキップした
    """
    if not template_html.exists():
        print(f"[tenjihoseiplus][ERROR] テンプレートが見つかりません: {template_html}")
        return False

    # ── 安全装置（再発防止） ───────────────────────────────────────────
    # 過去に「出力先(tenjihoseiplus.html)の内容が、何らかの経路で
    # テンプレート(boatrace_analyzer.html)に上書きされ続け、しかも
    # 古い実装では除去漏れで埋め込みデータが際限なく蓄積する」事故があった。
    # ここで2つのことをチェックして、同じ事故が起きてもすぐ気づけるようにする。
    #
    # ① template_html と output_html が同じファイルを指していないか
    #    （設定ミスで両者が同一パスになっていると、初回実行時点で
    #      テンプレートに直接データが書き込まれてしまう）
    if template_html.resolve() == output_html.resolve():
        print(f"[tenjihoseiplus][ERROR] template_html と output_html が同一パスです → 処理中止: {template_html}")
        return False

    # ② テンプレート側に、本来あるはずのない埋め込みマーカーが
    #    すでに混入していないか（手動の誤上書き等の早期検知）
    try:
        _tpl_text = template_html.read_text(encoding="utf-8")
    except Exception:
        _tpl_text = ""
    _marker_count = _tpl_text.count("自動埋め込みデータ（tenjihoseiplus.py 集計済み）")
    if _marker_count > 0:
        print(
            f"[tenjihoseiplus][WARN] テンプレート({template_html.name})に埋め込み済みデータの"
            f"マーカーが{_marker_count}個混入しています。本来テンプレートは素のままのはずです。"
            f"出力ファイルが誤ってテンプレート側に上書きされていないか確認してください。"
        )

    _ensure_csv_aggregates(results_csv_dir, tenji_dir, player_map_path,
                           force=force_csv_reaggregate)

    tenji_paths = find_tenji_files(tenji_dir, tenji_date, all_files=False)
    if not tenji_paths:
        print(f"[tenjihoseiplus][WARN] 展示JSONが見つかりません: {tenji_dir} (date={tenji_date})")
        return False

    tenji_data = load_tenji(tenji_paths)
    tenji_file_names = [p.name for p in tenji_paths]

    # ── 営業日の算出 ─────────────────────────────────────────────
    # auto_push.py が実際に読み込んだ展示JSON（tenji_YYYYMMDD_*.json）の
    # 日付＝「CSVが切り替わった基準日」。カレンダー上の日付（深夜0時境界）
    # ではなく、この日付をフロントエンドの画面リセット判定に使う。
    business_date = None
    for _name in tenji_file_names:
        _m = re.match(r"tenji_(\d{8})", _name)
        if _m:
            business_date = _m.group(1)
            break

    entries, venue_races = build_entries(
        tenji_data, _cache["player_map"],
        _cache["ctp"], _cache["cap"], _cache["pcp"], _cache["pca"],
        deadline_map=deadline_map
    )

    auto_script = build_auto_script(
        entries, venue_races,
        _cache["ctp"], _cache["cap"], _cache["pcp"], _cache["pca"],
        _cache["ctpL"], _cache["capL"], _cache["pcpL"], _cache["pcaL"],
        _cache["pcd"], _cache["pcavg"],
        _cache["pcdL"], _cache["pcavgL"],
        _cache["reg_to_name"], _cache["name_to_reg"], tenji_file_names,
        business_date=business_date,
    )
    full_html = build_full_html(template_html, auto_script)

    if output_html.exists():
        try:
            if output_html.read_text(encoding="utf-8") == full_html:
                print(f"[tenjihoseiplus] 内容変化なし（push省略）: {output_html}")
                return False  # 内容変化なし → 無駄なpushを防ぐ
        except Exception:
            pass

    output_html.parent.mkdir(parents=True, exist_ok=True)
    output_html.write_text(full_html, encoding="utf-8")
    print(f"[tenjihoseiplus] 更新: {output_html} ({len(full_html)//1024}KB)")
    return True
