#!/usr/bin/env python3
"""Build the dashboard's data files from a clone of the wowforeverAH repo.
usage: build_dashboard_data.py <repo_clone> <out_dir>
Writes: snaps.json, history.json (one row per item, arrays aligned to snaps), names.json, runs.json and the other datasets below
Snapshots whose prices equal the previous one are skipped. Old snapshots are thinned out and rarely traded
items are left out so that the page stays small (budget below)."""
import csv, glob, gzip, hashlib, json, os, sys
from datetime import datetime, timezone

repo, out = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
BUDGET = 9_000_000          # bytes for history.json
H = 3600
names = json.load(open(os.path.join(repo, "items.json"), encoding="utf-8"))

def to_int(v):
    return int(v) if v not in ("", None) else None

# ---- read snapshots ----
snaps = []   # [(epoch_seconds, {item_id: row})]
last_hash = None
for f in sorted(glob.glob(os.path.join(repo, "data/*/*/*/*.csv.gz"))):
    raw = gzip.open(f, "rb").read()
    rows = list(csv.DictReader(raw.decode().splitlines()))
    core = hashlib.md5(json.dumps([[r["item_id"], r["min_price"], r["median_price"], r["total_qty"], r["num_listings"]]
                                    for r in rows if r["num_listings"] != "0"]).encode()).hexdigest()
    if core == last_hash:
        continue
    last_hash = core
    p = f.split(os.sep)
    stamp = "".join(p[-4:-1]) + p[-1][:4]
    t = int(datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc).timestamp())
    snaps.append((t, {int(r["item_id"]): r for r in rows}))
snaps.sort(key=lambda s: s[0])

# ---- thin out old snapshots: all in last 48 h, 1 per 6 h up to 14 days, 1 per day beyond ----
def thin(snaps):
    if not snaps:
        return snaps
    newest = snaps[-1][0]
    keep, seen = [], set()
    for t, rows in snaps:
        age = newest - t
        if age <= 48 * H:
            keep.append((t, rows)); continue
        bucket = ("6h", t // (6 * H)) if age <= 14 * 24 * H else ("d", t // (24 * H))
        if bucket in seen:
            continue
        seen.add(bucket); keep.append((t, rows))
    return keep
snaps = thin(snaps)
T = [s[0] for s in snaps]

# ---- per-item columns, dropping rarely listed items until the file fits the budget ----
ids = sorted({i for _, rows in snaps for i in rows if str(i) in names})
def build(threshold):
    out_rows = []
    for i in ids:
        cols = {k: [] for k in "mdqnox"}
        maxn = 0
        for _, rows in snaps:
            r = rows.get(i)
            if r is None:
                for k in cols: cols[k].append(None)
                continue
            listed = r["num_listings"] != "0"
            cols["m"].append(to_int(r["min_price"]) if listed else None)
            cols["d"].append(to_int(r["median_price"]) if listed else None)
            cols["q"].append(to_int(r["total_qty"]))
            cols["n"].append(to_int(r["num_listings"]))
            cols["o"].append(to_int(r.get("sold_est")))
            cols["x"].append(to_int(r.get("expired_est")))
            maxn = max(maxn, to_int(r["num_listings"]) or 0)
        if maxn >= threshold:
            out_rows.append({"id": i, **cols})
    return out_rows
for threshold in (3, 5, 10, 20, 40, 80, 160):
    hist = build(threshold)
    blob = json.dumps({"rows": hist}, separators=(",", ":"))
    if len(blob) <= BUDGET:
        break
meta_note = f"Items with at least {threshold} listings at some point; old snapshots thinned (all <48 h, 6-hourly <14 d, then daily)"
hist_doc = {"rows": hist, "meta": [
    {"label": "Source", "value": "Blizzard Game Data API, ruleset 1 (PvP), EU, Horde Auction House"},
    {"label": "Collector", "value": "collect.py in github.com/bolljohan1234/wowforeverAH (GitHub Actions)"},
    {"label": "Columns", "value": "m = lowest buyout, d = median, q = units for sale, n = listings, o = est. units sold, x = est. units expired; copper per item; arrays follow the snapshot list"},
    {"label": "Coverage", "value": meta_note},
]}
json.dump(hist_doc, open(os.path.join(out, "history.json"), "w"), separators=(",", ":"))
json.dump({"rows": [{"t": t * 1000} for t in T]}, open(os.path.join(out, "snaps.json"), "w"), separators=(",", ":"))
kept = {r["id"] for r in hist}
vp = os.path.join(repo, "vendor.json")
vendor = json.load(open(vp)) if os.path.exists(vp) else {}
qp = os.path.join(repo, "quality.json")
quality = json.load(open(qp)) if os.path.exists(qp) else {}
ip = os.path.join(repo, "icons.json")
icondoc = json.load(open(ip)) if os.path.exists(ip) else {"items": {}, "data": {}}
icon_of = icondoc.get("items", {})
json.dump({"rows": [{"id": i, "name": names[str(i)], "vendor": vendor.get(str(i)), "icon": icon_of.get(str(i)), "q": quality.get(str(i))} for i in sorted(kept)]}, open(os.path.join(out, "names.json"), "w"), separators=(",", ":"), ensure_ascii=False)

# ---- runs ----
runs = []
rp = os.path.join(repo, "runs.csv")
if os.path.exists(rp):
    for r in csv.DictReader(open(rp, encoding="utf-8")):
        runs.append({"run": r["run_utc"], "result": r["result"], "snap": r["snapshot_utc"], "items": to_int(r["items"]),
                     "listings": to_int(r["listings"]), "house": r["house_id"], "seconds": to_int(r["seconds"]), "note": r["note"]})
else:
    for f in sorted(glob.glob(os.path.join(repo, "data/*/*/*/*.csv.gz"))):
        p = f.split(os.sep); stamp = "".join(p[-4:-1]) + p[-1][:4]
        iso = datetime.strptime(stamp, "%Y%m%d%H%M").strftime("%Y-%m-%dT%H:%M:00Z")
        runs.append({"run": iso, "result": "legacy", "snap": iso, "items": None, "listings": None, "house": "", "seconds": None,
                     "note": "run time taken from the snapshot file name"})
json.dump({"rows": runs, "meta": [{"label": "Source", "value": "runs.csv in the repository" if os.path.exists(rp) else "Snapshot file names (runs.csv does not exist yet)"}]},
          open(os.path.join(out, "runs.json"), "w"), separators=(",", ":"))

print(f"{len(T)} distinct snapshots, {len(hist)} items (threshold {threshold}), history {len(blob)/1e6:.2f} MB, {len(runs)} runs")

# profession data (optional): professions.json from the collector -> profs.json rows {id, uses, makes}
pp = os.path.join(repo, "professions.json")
prof_rows = []
if os.path.exists(pp):
    pd = json.load(open(pp, encoding="utf-8"))
    uses, makes = pd.get("uses", {}), pd.get("makes", {})
    for k in sorted(set(uses) | set(makes), key=int):
        prof_rows.append({"id": int(k), "uses": ", ".join(uses.get(k, [])), "makes": ", ".join(makes.get(k, []))})
json.dump({"rows": prof_rows}, open(os.path.join(out, "profs.json"), "w"), separators=(",", ":"), ensure_ascii=False)
print("profession rows:", len(prof_rows))

# icons: only icons of kept items
used = {icon_of.get(str(i)) for i in kept} - {None}
json.dump({"rows": [{"name": n, "data": d} for n, d in sorted(icondoc.get("data", {}).items()) if n in used]}, open(os.path.join(out, "icons.json"), "w"), separators=(",", ":"))
print("icon images:", len(used & set(icondoc.get("data", {}))))
# recipes (optional)
rec_rows = []
sk_path = os.path.join(repo, "skills.json") if "repo" in globals() else "skills.json"
skills = json.load(open(sk_path)).get("recipes", {}) if os.path.exists(sk_path) else {}
if os.path.exists(pp):
    cats = pd.get("cats", {})
    for rid, rec in pd.get("recipes", {}).items():
        if rec.get("o") is None or not rec.get("r") or "[DNT]" in rec.get("p", ""):
            continue
        t, c = cats.get(rid, ["", ""])
        rec_rows.append({"id": int(rid), "p": rec["p"], "tier": t, "cat": c, "name": rec.get("n") or "", "out": rec["o"], "q": rec.get("q") or 1, "r": json.dumps(rec["r"], separators=(",", ":")), "lvl": (skills.get(rid) or [None])[0]})
json.dump({"rows": rec_rows}, open(os.path.join(out, "recipes.json"), "w"), separators=(",", ":"), ensure_ascii=False)
print("recipes:", len(rec_rows))

# price ladders (optional): cheapest price levels per item, only for kept items
import gzip
lad_rows = []
lp = os.path.join(repo, "ladder.json.gz")
if os.path.exists(lp):
    ld = json.load(gzip.open(lp, "rt", encoding="utf-8")).get("l", {})
    for iid, lv in ld.items():
        if int(iid) in kept or str(iid) in {str(k) for k in kept}:
            lad_rows.append({"id": int(iid), "l": json.dumps(lv, separators=(",", ":"))})
json.dump({"rows": lad_rows}, open(os.path.join(out, "ladder.json"), "w"), separators=(",", ":"))
print("ladders:", len(lad_rows))

# sale prices (optional): what vanished, not-about-to-expire auctions were listed at; last 7 days
import glob
sale_rows = []
from datetime import timedelta
cut = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%MZ")
for fp in sorted(glob.glob(os.path.join(repo, "sales", "*", "*", "*.csv.gz"))):
    try:
        for ln in gzip.open(fp, "rt", encoding="utf-8").read().splitlines()[1:]:
            t, i, k, u, lo, av, hi = ln.split(",")
            if t >= cut:
                sale_rows.append({"k": k, "id": int(i), "t": t, "u": int(u), "lo": int(lo), "av": int(av), "hi": int(hi)})
    except Exception as e:
        print("sales file skipped", fp, e)
json.dump({"rows": [{k: v for k, v in r.items() if k != "k"} for r in sale_rows if r["k"] == "s"]}, open(os.path.join(out, "salesprices.json"), "w"), separators=(",", ":"))
json.dump({"rows": [{k: v for k, v in r.items() if k != "k"} for r in sale_rows if r["k"] == "e"]}, open(os.path.join(out, "expiredprices.json"), "w"), separators=(",", ":"))
print("sale price rows:", len(sale_rows))

# ladder history (optional): per item, the cheapest and second cheapest price level at each saved ladder time, last 7 days
cut3 = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%MZ")
lh = {}
times = []
for fp in sorted(glob.glob(os.path.join(repo, "ladderhist", "*", "*", "*.csv.gz"))):
    try:
        for ln in gzip.open(fp, "rt", encoding="utf-8").read().splitlines()[1:]:
            t, i, lv = ln.split(",")
            if t < cut3:
                continue
            if not times or times[-1] != t:
                times.append(t)
            lh.setdefault(int(i), {})[t] = lv
    except Exception as e:
        print("ladderhist file skipped", fp, e)
ms = [int(datetime.strptime(t, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc).timestamp() * 1000) for t in times]
lh_rows = []
for i, d in lh.items():
    if i not in kept and str(i) not in {str(k) for k in kept}:
        continue
    p1, q1, p2 = [], [], []
    for t in times:
        lv = d.get(t)
        if not lv:
            p1.append(None); q1.append(None); p2.append(None); continue
        lvls = [x.split("x") for x in lv.split(";")]
        p1.append(int(lvls[0][0])); q1.append(int(lvls[0][1])); p2.append(int(lvls[1][0]) if len(lvls) > 1 else None)
    lh_rows.append({"id": i, "t": ms, "p1": p1, "q1": q1, "p2": p2})
json.dump({"rows": lh_rows}, open(os.path.join(out, "ladderhist.json"), "w"), separators=(",", ":"))
print("ladder history items:", len(lh_rows), "times:", len(times))

# items in the newest snapshot that still have no name (the collector keeps trying), most listings first
import csv as _csv
_files = sorted(glob.glob(os.path.join(repo, "data/*/*/*/*.csv.gz")))
unnamed = []
if _files:
    for r in _csv.reader(gzip.open(_files[-1], "rt", encoding="utf-8")):
        if r and r[0].isdigit() and r[0] not in names:
            unnamed.append({"id": int(r[0]), "min": int(r[1] or 0), "n": int(r[4] or 0), "qty": int(r[3] or 0)})
unnamed.sort(key=lambda x: -x["n"])
json.dump({"rows": unnamed}, open(os.path.join(out, "unnamed.json"), "w"), separators=(",", ":"))
print("unnamed items:", len(unnamed))

# categories as the auction house shows them: [class, subclass, item level, required level, slot, binding, stack]
_cf = os.path.join(repo, "categories.json")
cats = []
if os.path.exists(_cf):
    for k, v in json.load(open(_cf, encoding="utf-8")).items():
        v = (v + [None] * 7)[:7]
        cats.append({"id": int(k), "cls": v[0], "sub": v[1] or "", "il": v[2], "rl": v[3], "slot": v[4], "bind": v[5], "stack": v[6]})
json.dump({"rows": cats}, open(os.path.join(out, "cats.json"), "w"), separators=(",", ":"))
print("categorised items:", len(cats))

# ---- gear variants (items sold in several versions that carry their own price, e.g. different suffixes) ----
vrows, vstamp = [], ""
vpath = os.path.join(repo, "variants.csv.gz")
if os.path.exists(vpath):
    with gzip.open(vpath, "rt", encoding="utf-8") as fh:
        first = fh.readline().strip()
        vstamp = first.lstrip("# ").strip() if first.startswith("#") else ""
        rd = csv.DictReader(fh if not first.startswith("#") else fh)
        for r in rd:
            try:
                vrows.append({"id": int(r["item_id"]), "b": r["bonus"], "lo": int(r["min_price"]), "md": int(r["median_price"]), "q": int(r["qty"]), "n": int(r["listings"])})
            except (KeyError, ValueError):
                continue
json.dump({"rows": vrows, "asof": vstamp}, open(os.path.join(out, "variants.json"), "w"), separators=(",", ":"))
print("variant rows:", len(vrows), "as of", vstamp)
