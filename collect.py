#!/usr/bin/env python3
"""
Collects Horde Auction House prices for WoW: Forever (EU, PvP ruleset).

Each run:
  * finds the right auction house (the Horde house that belongs to the PvP ruleset)
  * saves one snapshot to data/YYYY/MM/DD/HHMM.csv.gz when Blizzard's data has changed
  * estimates units sold / expired since the previous snapshot (needs the cached state/ folder)
  * keeps items.json (item id -> name) and appends one line per run to runs.csv

Standard library only. Needs BNET_CLIENT_ID and BNET_CLIENT_SECRET (GitHub secrets).
"""
import base64
import csv
import email.utils
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta, datetime, timezone
from pathlib import Path

REGION = os.environ.get("WOW_REGION", "eu")
RULESET_ID = os.environ.get("WOW_RULESET_ID", "1")  # 1 = PvP
HOUSE_NAME = os.environ.get("WOW_HOUSE_NAME", "Horde Auction House")
FORCE_HOUSE_ID = os.environ.get("WOW_HOUSE_ID", "")  # optional manual override
DYNAMIC_NS = f"dynamic-forever-{REGION}"
STATIC_NS = f"static-forever-{REGION}"
FALLBACK_NS = []  # other game databases are not used, only the Forever one (plus its search endpoint)
API = f"https://{REGION}.api.blizzard.com"
DATA_DIR = Path("data")
ITEMS_FILE = Path("items.json")
VENDOR_FILE = Path("vendor.json")
QUALITY_FILE = Path("quality.json")
CATEGORY_FILE = Path("categories.json")  # item id -> [item class, item subclass, item level, required level, equipment slot, binding, stack size], class and subclass as the auction house shows them, e.g. ["Trade Goods", "Leather", ...]
QUALITY_NUM = {"POOR": 0, "COMMON": 1, "UNCOMMON": 2, "RARE": 3, "EPIC": 4, "LEGENDARY": 5, "ARTIFACT": 6, "HEIRLOOM": 7}
RUNS_FILE = Path("runs.csv")
HOUSE_FILE = Path("house_choice.json")
STATE_FILE = Path("state/auctions.json.gz")  # cached between runs, not committed
MAX_NAME_LOOKUPS = 8000
SNAP_HEADER = ["item_id", "min_price", "median_price", "total_qty", "num_listings", "sold_est", "expired_est"]
RUN_HEADER = ["run_utc", "result", "snapshot_utc", "items", "listings", "names_known", "house_id", "seconds", "note"]
HDR = {}  # headers of the most recent API response


def fetch(req, retries=3):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                raw = r.read()
                HDR.clear()
                HDR.update({k.lower(): v for k, v in r.headers.items()})
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise
        except urllib.error.URLError:
            if attempt < retries - 1:
                time.sleep(5)
                continue
            raise


def get_token():
    cid = os.environ["BNET_CLIENT_ID"]
    secret = os.environ["BNET_CLIENT_SECRET"]
    basic = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    req = urllib.request.Request(
        "https://oauth.battle.net/token",
        data=b"grant_type=client_credentials",
        headers={"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    return fetch(req)["access_token"]


def api(path, namespace, token):
    sep = "&" if "?" in path else "?"
    url = f"{API}{path}{sep}namespace={namespace}&locale=en_GB"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "Accept-Encoding": "gzip"},
    )
    return fetch(req)


def as_list(x):
    if isinstance(x, list):
        return x
    if isinstance(x, dict) and isinstance(x.get("auctions"), list):
        return x["auctions"]
    return []


def unit_price(a):
    """Price per single item, in copper."""
    if a.get("unit_price"):
        return int(a["unit_price"])
    buyout = a.get("buyout")
    qty = a.get("quantity") or 1
    if buyout:
        return int(buyout // qty)
    return None  # bid-only listing, ignored


def is_short(a):
    tl = a.get("time_left")
    if isinstance(tl, dict):
        tl = tl.get("type") or tl.get("name")
    return str(tl or "").upper() == "SHORT"


def weighted_median(pairs):
    pairs = sorted(pairs)
    half = sum(q for _, q in pairs) / 2
    run = 0
    for price, qty in pairs:
        run += qty
        if run >= half:
            return price
    return pairs[-1][0]


def ruleset_of(house):
    rs = house.get("ruleset")
    if isinstance(rs, dict):
        return rs.get("id"), rs.get("name")
    return rs, None


PROBE_ITEMS = {13466: "Plaguebloom", 13422: "Stonescale Eel", 249428: "Pristine Hide", 12811: "Righteous Orb", 213548: "Scroll of Liminal Passage",
               10056: "Orange Mageweave Shirt", 864: "Knightly Longsword", 5964: "Barbaric Shoulders", 4324: "Azure Silk Vest", 804: "Large Blue Sack"}
DIAG = {}


def diag_house(hid, house, lm):
    """Prints and remembers how each candidate house looks, so the right one can be told apart by its prices."""
    regular, comm = as_list(house.get("auctions")), as_list(house.get("commodities"))
    rows, _ = aggregate(regular + comm)
    probes = {}
    for iid, nm in PROBE_ITEMS.items():
        r = rows.get(iid)
        probes[nm] = {"min": r[1], "median": r[2], "units": r[3], "listings": r[4]} if r else None
    # what a listing's item looks like: any extra field (random suffix, bonus list, ...) means one item id can be several different goods
    keys, extra = {}, []
    for a in regular[:20000]:
        it = a.get("item") or {}
        for k in it:
            keys[k] = keys.get(k, 0) + 1
        if len(extra) < 6 and len(it) > 1:
            extra.append({"item": it, "quantity": a.get("quantity"), "buyout": a.get("buyout"), "unit_price": a.get("unit_price")})
    DIAG[str(hid)] = {"regular_listings": len(regular), "commodity_listings": len(comm), "items": len(rows), "last_modified": lm, "probes": probes, "item_fields": keys, "item_examples": extra}
    print(f"    listings={len(regular)} commodities={len(comm)} items={len(rows)}")
    for nm, p in probes.items():
        print(f"    probe {nm}: {p}")


def pick_house(houses, token):
    """Several Horde houses can be listed. Pick the one that belongs to RULESET_ID and remember it."""
    ids = [h["id"] for h in houses if h.get("name") == HOUSE_NAME]
    override = Path("house_override.txt")
    forced = FORCE_HOUSE_ID or (override.read_text().strip() if override.exists() else "")
    if forced:
        print(f"House forced to {forced} (env WOW_HOUSE_ID or house_override.txt)")
        ids = [int(forced)]
    elif HOUSE_FILE.exists():
        cached = json.loads(HOUSE_FILE.read_text()).get("house_id")
        if cached in ids:
            ids = [cached] + [i for i in ids if i != cached]
    if not ids:
        sys.exit(f"Could not find '{HOUSE_NAME}' in the auction house index")
    print(f"Candidate '{HOUSE_NAME}' ids: {ids}")
    unverified, seen = None, []
    for hid in ids:
        house = api(f"/data/wow/ruleset/{RULESET_ID}/auctions/{hid}", DYNAMIC_NS, token)
        lm = HDR.get("last-modified")
        rid, rname = ruleset_of(house)
        print(f"  house {hid}: ruleset={rid} ({rname}), keys={list(house.keys())}, last-modified={lm}")
        seen.append((hid, rid))
        try:
            diag_house(hid, house, lm)
        except Exception as e:  # diagnostics must never break a run
            print(f"    (diagnostic failed: {e})")
        if forced or (rid is not None and str(rid) == str(RULESET_ID)):
            HOUSE_FILE.write_text(json.dumps({"ruleset": RULESET_ID, "region": REGION, "house_id": hid}))
            return hid, house, lm
        if rid is None and unverified is None:
            unverified = (hid, house, lm)
    if DIAG:
        HOUSE_FILE.write_text(json.dumps({"ruleset": RULESET_ID, "region": REGION, "house_id": None, "note": "ruleset field missing from house responses", "diagnostic": DIAG}, indent=1))
    if unverified:
        print("WARNING: the response has no ruleset field, so the house could not be verified; using the first candidate")
        return unverified
    sys.exit(f"No '{HOUSE_NAME}' belongs to ruleset {RULESET_ID}. Seen (house, ruleset): {seen}")


LADDER = {}  # filled by aggregate(): item -> cheapest price levels
LADDER_FILE = Path("ladder.json.gz")


def save_ladder(when):
    with gzip.open(LADDER_FILE, "wt", encoding="utf-8") as f:
        json.dump({"t": when.strftime("%Y-%m-%dT%H:%M:%SZ"), "l": {str(k): v for k, v in LADDER.items()}}, f, separators=(",", ":"))
    print(f"Saved price ladders for {len(LADDER)} items")


def aggregate(listings):
    """-> (rows per item, {auction_id: [item_id, qty, short]})."""
    by_item = defaultdict(list)
    cur = {}
    for a in listings:
        item = a.get("item") or {}
        item_id = item.get("id")
        if item_id is None:
            continue
        qty = int(a.get("quantity") or 1)
        price = unit_price(a)
        if a.get("id") is not None:
            cur[str(a["id"])] = [int(item_id), qty, 1 if is_short(a) else 0, price if price is not None else 0]
        if price is None:
            continue
        by_item[item_id].append((price, qty))
    rows = {}
    LADDER.clear()
    for item_id, pairs in by_item.items():
        rows[item_id] = [item_id, min(p for p, _ in pairs), weighted_median(pairs), sum(q for _, q in pairs), len(pairs)]
        if len(pairs) >= 3:  # price ladder: the cheapest price levels with the units offered at each
            levels = {}
            for p, q in pairs:
                levels[p] = levels.get(p, 0) + q
            LADDER[item_id] = [[p, levels[p]] for p in sorted(levels)[:10]]
    return rows, cur


def removed_estimates(prev, cur):
    """Units whose auction vanished since the previous snapshot. A vanished auction that was in the SHORT
    time bucket before is counted as expired, any other as sold (cancellations are indistinguishable)."""
    sold, expired = defaultdict(int), defaultdict(int)
    for aid, v in prev.items():
        item, qty, short = v[0], v[1], v[2]
        if aid not in cur:
            (expired if short else sold)[item] += qty
    return sold, expired


SALES_DIR = Path("sales")  # one small gz file per day: what vanished (probably sold) auctions were priced at


def removed_sales(prev, cur):
    """{(item, kind): [units, min_price, avg_price, max_price]} for vanished auctions, per unit in copper.
    kind 's' = was not about to expire (probably sold, cancellations look the same),
    kind 'e' = was in the SHORT bucket (probably expired unsold at that price)."""
    acc = {}
    for aid, v in prev.items():
        if aid in cur or len(v) < 4 or not v[3]:
            continue
        item, qty, short, price = v[0], v[1], v[2], v[3]
        a = acc.setdefault((item, "e" if short else "s"), [0, price, 0, price])
        a[0] += qty
        a[2] += price * qty
        a[1] = min(a[1], price)
        a[3] = max(a[3], price)
    return {k: [a[0], a[1], round(a[2] / a[0]), a[3]] for k, a in acc.items() if a[0]}


def save_sales(when, sales):
    if not sales:
        return
    folder = SALES_DIR / f"{when:%Y}" / f"{when:%m}"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{when:%d}.csv.gz"
    header = "time,item_id,kind,units,min_price,avg_price,max_price"
    lines = [header]
    if path.exists():
        with gzip.open(path, "rt", encoding="utf-8") as f:
            lines = f.read().splitlines()
    stamp = when.strftime("%Y-%m-%dT%H:%MZ")
    lines = [l for l in lines if not l.startswith(stamp + ",")]
    lines += [f"{stamp},{i},{k},{v[0]},{v[1]},{v[2]},{v[3]}" for (i, k), v in sorted(sales.items())]
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Saved sold/expired prices for {len(sales)} item groups")


LADDER_HIST_DIR = Path("ladderhist")  # price ladder history: every ~4 hours, cheapest 5 price levels per item


def save_ladder_history(when, min_hours=3.8):
    if not LADDER:
        return
    folder = LADDER_HIST_DIR / f"{when:%Y}" / f"{when:%m}"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{when:%d}.csv.gz"
    lines = ["time,item_id,levels"]
    if path.exists():
        with gzip.open(path, "rt", encoding="utf-8") as f:
            lines = f.read().splitlines()
        last = lines[-1].split(",")[0] if len(lines) > 1 else None
        if last:
            lt = datetime.strptime(last, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
            if (when - lt).total_seconds() < min_hours * 3600:
                return
    stamp = when.strftime("%Y-%m-%dT%H:%MZ")
    for item_id, lv in sorted(LADDER.items()):
        lines.append(f"{stamp},{item_id}," + ";".join(f"{p}x{q}" for p, q in lv[:5]))
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Saved ladder history for {len(LADDER)} items")


def load_state():
    try:
        with gzip.open(STATE_FILE, "rt", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_state(ts, cur):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(STATE_FILE, "wt", encoding="utf-8") as f:
        json.dump({"ts": ts, "a": cur}, f, separators=(",", ":"))


def same_as_latest(rows):
    files = sorted(DATA_DIR.glob("*/*/*/*.csv.gz"))
    if not files:
        return False
    with gzip.open(files[-1], "rt", newline="", encoding="utf-8") as f:
        old = [r[:5] for r in list(csv.reader(f))[1:] if len(r) > 4 and r[4] != "0"]
    return old == [[str(v) for v in r[:5]] for r in rows if str(r[4]) != "0"]


def save_snapshot(rows, when):
    if same_as_latest(rows):
        print("Prices are identical to the latest snapshot - nothing new to save")
        return None
    folder = DATA_DIR / f"{when:%Y}" / f"{when:%m}" / f"{when:%d}"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{when:%H%M}.csv.gz"
    if path.exists():
        print("A snapshot for this data time already exists - nothing new to save")
        return None
    with gzip.open(path, "wt", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(SNAP_HEADER)
        w.writerows(rows)
    return path


def search_item(item_id, token):
    """Looks an item up through Blizzard's search API (Forever database). Returns the item's data dict or None."""
    for ns in [STATIC_NS] + FALLBACK_NS:
        try:
            res = api(f"/data/wow/search/item?id={item_id}&orderby=id", ns, token).get("results") or []
            for r in res:
                d = r.get("data") or {}
                if str(d.get("id")) == str(item_id) and d.get("name"):
                    return d
        except Exception:
            continue
    return None


def lookup_item(item_id, token):
    """Returns (id, name, vendor_sell_price_in_copper, quality 0-5). Vendor price 0 = cannot be sold to a vendor. Quality 0 = grey."""
    try:
        data = None
        for ns in [STATIC_NS] + FALLBACK_NS:  # the Forever item database is incomplete, so try the other game databases for the same item id
            try:
                data = api(f"/data/wow/item/{item_id}", ns, token)
                break
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
                if ns == (FALLBACK_NS[-1] if FALLBACK_NS else STATIC_NS):
                    data = search_item(item_id, token)  # last resort: the search endpoint sometimes knows items the item endpoint does not
                    if not data:
                        raise
        name = data.get("name")
        if isinstance(name, dict):
            name = name.get("en_GB") or name.get("en_US") or next(iter(name.values()), None)
        sell = data.get("sell_price")
        if isinstance(sell, dict):
            sell = sell.get("value")
        try:
            sell = int(sell or 0)
        except (TypeError, ValueError):
            sell = 0
        q = data.get("quality")
        q = QUALITY_NUM.get(str(q.get("type") if isinstance(q, dict) else q).upper())
        def _cat(x):
            x = x.get("name") if isinstance(x, dict) else x
            if isinstance(x, dict):
                x = x.get("en_GB") or x.get("en_US") or next(iter(x.values()), None)
            return x
        inv = data.get("inventory_type")
        inv = _cat(inv) if isinstance(inv, dict) else None
        bind = ((data.get("preview_item") or {}).get("binding") or {})
        bind = _cat(bind) if isinstance(bind, dict) and bind else None
        # [class, subclass, item level, required level, equipment slot, binding, stack size]
        cat = [_cat(data.get("item_class")), _cat(data.get("item_subclass")) or "", data.get("level"), data.get("required_level"), inv, bind, data.get("max_count")]
        CATS[str(item_id)] = cat if cat[0] else ["Uncategorized", ""] + cat[2:]  # Blizzard returned no class for this item
        return item_id, name, sell, q
    except Exception as e:
        code = getattr(e, "code", None)
        FAILS[str(item_id)] = "404:all" if code == 404 else str(code or type(e).__name__)
        return item_id, None, None, None


CATS = {}  # item id -> [class, subclass] found during this run
FAILS = {}  # item id -> why the lookup failed (HTTP code or error type), saved to item_failures.json


def update_item_names(rows, token, budget_seconds=300):
    """Keeps items.json (id -> name) and vendor.json (id -> vendor sell price in copper) up to date."""
    started = time.time()
    names = json.loads(ITEMS_FILE.read_text(encoding="utf-8")) if ITEMS_FILE.exists() else {}
    vendor = json.loads(VENDOR_FILE.read_text(encoding="utf-8")) if VENDOR_FILE.exists() else {}
    quality = json.loads(QUALITY_FILE.read_text(encoding="utf-8")) if QUALITY_FILE.exists() else {}
    cats = json.loads(CATEGORY_FILE.read_text(encoding="utf-8")) if CATEGORY_FILE.exists() else {}
    order = sorted(rows, key=lambda r: -r[4])
    try:
        FAILS.update(json.loads(Path("item_failures.json").read_text(encoding="utf-8")))
    except Exception:
        pass
    given_up = set()  # nothing is given up: items without a name are tried again on every run
    missing = [r[0] for r in order if (str(r[0]) not in names or str(r[0]) not in vendor or str(r[0]) not in quality or str(r[0]) not in cats) and str(r[0]) not in given_up][:MAX_NAME_LOOKUPS]
    print(f"Names known: {len(names)}, vendor prices known: {len(vendor)}, items to look up: {len(missing)}")
    tried = failed = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i in range(0, len(missing), 200):
            if time.time() - started > budget_seconds:
                print("Time budget reached - the next run continues from here")
                break
            for item_id, name, sell, q in pool.map(lambda x: lookup_item(x, token), missing[i : i + 200]):
                tried += 1
                if name:
                    FAILS.pop(str(item_id), None)
                    names[str(item_id)] = name
                    vendor[str(item_id)] = sell or 0
                    if q is not None:
                        quality[str(item_id)] = q
                    if CATS.get(str(item_id)):
                        cats[str(item_id)] = CATS[str(item_id)]
                else:
                    failed += 1
            ITEMS_FILE.write_text(json.dumps(names, ensure_ascii=False, sort_keys=True, indent=0), encoding="utf-8")
            VENDOR_FILE.write_text(json.dumps(vendor, sort_keys=True, indent=0), encoding="utf-8")
            QUALITY_FILE.write_text(json.dumps(quality, sort_keys=True, indent=0), encoding="utf-8")
            CATEGORY_FILE.write_text(json.dumps(cats, ensure_ascii=False, sort_keys=True, indent=0), encoding="utf-8")
            print(f"  progress: {tried} tried, {failed} failed, {len(names)} names, {len(vendor)} vendor prices, {time.time()-started:.0f}s")
    try:
        from collections import Counter
        print("Lookup failures by reason:", dict(Counter(FAILS.values())))
        Path("item_failures.json").write_text(json.dumps(FAILS, sort_keys=True), encoding="utf-8")
    except Exception as e:
        print("Could not save item failures:", e)
    return len(names)


PROF_FILE = Path("professions.json")


def _name(x):
    if isinstance(x, dict):
        return x.get("en_GB") or x.get("en_US") or next(iter(x.values()), None)
    return x


def build_professions(token, budget_seconds=180):
    """Which professions use or make which items, from the Blizzard recipe data. Best effort: any failure is
    written to professions.json under 'status' so it can be diagnosed, and never stops a run."""
    started = time.time()
    data = json.loads(PROF_FILE.read_text(encoding="utf-8")) if PROF_FILE.exists() else {}
    recipes = data.get("recipes", {})
    status = {"errors": [], "professions": 0, "recipe_ids": 0, "fetched": len(recipes)}
    if data.get("complete") and data.get("v") == 2 and data.get("built_at", "") > (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d"):
        print(f"Profession data is current ({len(recipes)} recipes)")
        return
    def note(msg):
        print("  professions:", msg)
        if len(status["errors"]) < 12:
            status["errors"].append(str(msg)[:300])
    try:
        index = api("/data/wow/profession/index", STATIC_NS, token)
        profs = [(p.get("id"), _name(p.get("name"))) for p in index.get("professions", [])]
        status["professions"] = len(profs)
        print(f"Professions listed: {[n for _, n in profs]}")
        todo = {}
        cats = {}
        for pid, pname in profs:
            try:
                detail = api(f"/data/wow/profession/{pid}", STATIC_NS, token)
            except Exception as e:
                note(f"profession {pid} {pname}: {e}")
                continue
            for tier in detail.get("skill_tiers", []) or []:
                try:
                    t = api(f"/data/wow/profession/{pid}/skill-tier/{tier.get('id')}", STATIC_NS, token)
                except Exception as e:
                    note(f"skill tier {tier.get('id')} of {pname}: {e}")
                    continue
                tname = _name(t.get("name")) or _name(tier.get("name")) or ""
                for r in t.get("recipes", []) or []:
                    todo[str(r.get("id"))] = pname
                    cats[str(r.get("id"))] = [tname, ""]
                for cat in t.get("categories", []) or []:
                    cname = _name(cat.get("name")) or ""
                    for r in cat.get("recipes", []) or []:
                        todo[str(r.get("id"))] = pname
                        cats[str(r.get("id"))] = [tname, cname]
        status["recipe_ids"] = len(todo)
        print(f"Recipes listed: {len(todo)}")
        missing = [rid for rid in todo if rid not in recipes]

        def fetch(rid):
            try:
                r = api(f"/data/wow/recipe/{rid}", STATIC_NS, token)
            except Exception as e:
                return rid, None, str(e)
            out = r.get("crafted_item") or {}
            if not out:
                out = (r.get("alliance_crafted_item") or r.get("horde_crafted_item") or {})
            reag = []
            for g in r.get("reagents", []) or []:
                rid2 = (g.get("reagent") or {}).get("id")
                if rid2 is not None:
                    reag.append([rid2, g.get("quantity", 1)])
            return rid, {"p": todo[rid], "n": _name(r.get("name")), "o": out.get("id"), "q": r.get("crafted_quantity", {}).get("value", 1) if isinstance(r.get("crafted_quantity"), dict) else 1, "r": reag}, None

        with ThreadPoolExecutor(max_workers=8) as pool:
            for i in range(0, len(missing), 200):
                if time.time() - started > budget_seconds:
                    print("Profession time budget reached - the next run continues")
                    break
                for rid, rec, err in pool.map(fetch, missing[i:i + 200]):
                    if rec is not None:
                        recipes[rid] = rec
                    else:
                        note(f"recipe {rid}: {err}")
        status["fetched"] = len(recipes)
        data["cats"] = cats
        data["complete"] = all(r in recipes for r in todo) and len(todo) > 0
    except Exception as e:
        note(f"index: {e}")
        data["complete"] = False
    uses, makes = defaultdict(set), defaultdict(set)
    for rec in recipes.values():
        for item_id, _ in rec.get("r", []):
            uses[str(item_id)].add(rec["p"])
        if rec.get("o") is not None:
            makes[str(rec["o"])].add(rec["p"])
    data.update({"v": 2, "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "status": status, "recipes": recipes,
                 "uses": {k: sorted(v) for k, v in uses.items()}, "makes": {k: sorted(v) for k, v in makes.items()}})
    PROF_FILE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Profession data: {len(recipes)} recipes, {len(uses)} items used as reagents, {len(makes)} items made. Errors: {len(status['errors'])}")


ICON_FILE = Path("icons.json")


def fetch_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": "wowforeverAH-collector"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def lookup_icon(item_id, token):
    try:
        media = api(f"/data/wow/media/item/{item_id}", STATIC_NS, token)
        for a in media.get("assets", []) or []:
            if a.get("key") == "icon" and a.get("value"):
                return item_id, a["value"].rsplit("/", 1)[-1].rsplit(".", 1)[0].lower(), None
        return item_id, None, "no icon asset"
    except Exception as e:
        return item_id, None, str(e)


def update_icons(rows, token, budget_seconds=240):
    """icons.json: {"items": {item_id: icon_name}, "data": {icon_name: data URL}} so the page can show item icons."""
    started = time.time()
    d = json.loads(ICON_FILE.read_text(encoding="utf-8")) if ICON_FILE.exists() else {}
    items, data, bad = d.get("items", {}), d.get("data", {}), d.get("bad", {})
    order = sorted(rows, key=lambda r: -r[4])
    todo = [r[0] for r in order if str(r[0]) not in items and str(r[0]) not in bad]
    print(f"Icons known for {len(items)} items ({len(data)} images); {len(todo)} items to look up")
    errs = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i in range(0, len(todo), 200):
            if time.time() - started > budget_seconds:
                print("Icon time budget reached - the next run continues")
                break
            for item_id, name, err in pool.map(lambda x: lookup_icon(x, token), todo[i:i + 200]):
                if name:
                    items[str(item_id)] = name
                elif err and "404" in err:
                    bad[str(item_id)] = 1
                elif err and len(errs) < 5:
                    errs.append(f"{item_id}: {err}")
            need = sorted({n for n in items.values() if n not in data})

            def grab(n):
                for url in (f"https://wow.zamimg.com/images/wow/icons/small/{n}.jpg", f"https://render.worldofwarcraft.com/us/icons/56/{n}.jpg"):
                    try:
                        return n, "data:image/jpeg;base64," + base64.b64encode(fetch_bytes(url)).decode(), None
                    except Exception as e:
                        last = str(e)
                return n, None, last

            for n, url, err in pool.map(grab, need):
                if url:
                    data[n] = url
                elif len(errs) < 5:
                    errs.append(f"image {n}: {err}")
            ICON_FILE.write_text(json.dumps({"items": items, "data": data, "bad": bad}, separators=(",", ":")), encoding="utf-8")
            print(f"  icons: {len(items)} items, {len(data)} images, {time.time()-started:.0f}s")
    if errs:
        print("  icon problems (first few):", errs)


ADDON_DIR = Path("addon/AHTracker")


def make_addon_data():
    """Writes addon/AHTracker/Data.lua: latest lowest price, 7-day average of the lowest price, vendor price and listing count per item."""
    files = sorted(DATA_DIR.glob("*/*/*/*.csv.gz"))
    if not files:
        return
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    total, count, latest, latest_t = defaultdict(int), defaultdict(int), {}, None
    for p in files:
        try:
            t = datetime.strptime("".join(p.parts[-4:-1]) + p.name[:4], "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if t < cutoff:
            continue
        cur = {}
        with gzip.open(p, "rt", encoding="utf-8") as fh:
            for row in csv.reader(fh):
                if len(row) < 5 or not row[0].isdigit() or not row[1]:
                    continue
                item, mn = int(row[0]), int(float(row[1]))
                total[item] += mn
                count[item] += 1
                cur[item] = (mn, int(float(row[4] or 0)))
        if latest_t is None or t >= latest_t:
            latest_t, latest = t, cur
    vendor = json.loads(VENDOR_FILE.read_text(encoding="utf-8")) if VENDOR_FILE.exists() else {}
    ADDON_DIR.mkdir(parents=True, exist_ok=True)
    lines = [f"AHTrackerData = {{ t = {int(latest_t.timestamp())}, items = {{}} }}", "local I = AHTrackerData.items"]
    for item in sorted(latest):
        mn, n = latest[item]
        avg = round(total[item] / count[item]) if count[item] >= 3 else 0
        lines.append(f"I[{item}]={{{mn},{avg},{int(vendor.get(str(item), 0) or 0)},{n}}}")
    (ADDON_DIR / "Data.lua").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Addon data: {len(latest)} items")


SKILL_FILE = Path("skills.json")
PATTERN_PREFIXES = ("Pattern: ", "Recipe: ", "Plans: ", "Formula: ", "Schematic: ", "Manual: ", "Design: ", "Technique: ", "Book of ")


def skill_level_of(item):
    """The profession level a recipe item requires ('Requires Tailoring (150)'), or None."""
    try:
        s = ((item.get("preview_item") or {}).get("requirements") or {}).get("skill") or {}
        if s.get("level") is not None:
            return int(s["level"])
        m = re.search(r"Requires ([A-Za-z ]+) \((\d+)\)", json.dumps(item))
        return int(m.group(2)) if m else None
    except Exception:
        return None


def build_skills(token, budget_seconds=150):
    """skills.json: {"recipes": {recipe_id: [required_level_or_null, recipe_item_id]}}. The level comes from the recipe item
    (Pattern: X, Plans: X ...) when that item has been seen on the auction house. Trainer recipes have no such item."""
    started = time.time()
    if not PROF_FILE.exists() or not ITEMS_FILE.exists():
        return
    recipes = json.loads(PROF_FILE.read_text(encoding="utf-8")).get("recipes", {})
    names = json.loads(ITEMS_FILE.read_text(encoding="utf-8"))
    by_name = {}
    for iid, n in names.items():
        if n and n not in by_name:
            by_name[n] = int(iid)
    d = json.loads(SKILL_FILE.read_text(encoding="utf-8")) if SKILL_FILE.exists() else {}
    got = d.get("recipes", {})
    todo = []
    for rid, r in recipes.items():
        if rid in got:
            continue
        for pre in PATTERN_PREFIXES:
            iid = by_name.get(pre + (r.get("n") or ""))
            if iid:
                todo.append((rid, iid))
                break
    print(f"Skill levels known for {len(got)} recipes; {len(todo)} recipe items to look up")

    def look(x):
        rid, iid = x
        try:
            return rid, iid, skill_level_of(api(f"/data/wow/item/{iid}", STATIC_NS, token)), None
        except Exception as e:
            return rid, iid, None, str(e)
    errs = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i in range(0, len(todo), 200):
            if time.time() - started > budget_seconds:
                print("Skill time budget reached - the next run continues")
                break
            for rid, iid, lvl, err in pool.map(look, todo[i:i + 200]):
                if err:
                    if len(errs) < 5:
                        errs.append(f"{iid}: {err}")
                    continue
                got[rid] = [lvl, iid]
    SKILL_FILE.write_text(json.dumps({"v": 1, "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "recipes": got}, separators=(",", ":")), encoding="utf-8")
    print(f"  skills: {len(got)} recipes, {sum(1 for v in got.values() if v[0] is not None)} with a level, {time.time()-started:.0f}s")
    if errs:
        print("  skill problems (first few):", errs)


def ensure_runs_log():
    """First time only: list the snapshot files that exist from before this log, so history is not lost."""
    if RUNS_FILE.exists():
        return
    with open(RUNS_FILE, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(RUN_HEADER)
        for p in sorted(DATA_DIR.glob("*/*/*/*.csv.gz")):
            stamp = "".join(p.parts[-4:-1]) + p.name[:4]
            try:
                snap = datetime.strptime(stamp, "%Y%m%d%H%M").strftime("%Y-%m-%dT%H:%M:00Z")
            except ValueError:
                continue
            w.writerow([snap, "legacy", snap, "", "", "", "", "", "run time of an older snapshot file"])


def log_run(info):
    ensure_runs_log()
    with open(RUNS_FILE, "a", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow([info[k] for k in RUN_HEADER])


def main():
    started = time.time()
    now = datetime.now(timezone.utc)
    info = {"run_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "result": "failed", "snapshot_utc": "", "items": "",
            "listings": "", "names_known": "", "house_id": "", "seconds": "", "note": ""}
    try:
        ensure_runs_log()
        token = get_token()
        print("Token OK")
        ruleset = api(f"/data/wow/ruleset/{RULESET_ID}", DYNAMIC_NS, token)
        print(f"Ruleset {RULESET_ID}: {ruleset.get('name')} (status: {ruleset.get('status')})")
        index = api(f"/data/wow/ruleset/{RULESET_ID}/auctions/", DYNAMIC_NS, token)  # trailing slash required
        houses = index.get("auctions", [])
        print("Auction houses:", [(h.get("id"), h.get("name")) for h in houses])

        house_id, house, lm = pick_house(houses, token)
        info["house_id"] = house_id
        listings = as_list(house.get("auctions"))
        commodities = as_list(house.get("commodities"))
        if not commodities:
            try:
                commodities = as_list(api(f"/data/wow/ruleset/{RULESET_ID}/auctions/{house_id}/commodities", DYNAMIC_NS, token))
                lm = HDR.get("last-modified") or lm
            except urllib.error.HTTPError as e:
                print(f"No commodities endpoint data (HTTP {e.code})")
        print(f"Regular listings: {len(listings)}, commodity listings: {len(commodities)}")
        all_listings = listings + commodities
        if not all_listings:
            sys.exit("No listings returned - check the log above (response structure may differ)")
        print("Sample listing:", json.dumps(all_listings[0]))
        info["listings"] = len(all_listings)

        when = now
        if lm:
            try:
                when = email.utils.parsedate_to_datetime(lm).astimezone(timezone.utc)
            except Exception:
                pass
        rows_by_item, cur = aggregate(all_listings)

        sold = expired = None
        sale_prices = None
        try:  # estimates are optional: they must never stop the price snapshot from being saved
            prev = load_state()
            if prev and prev.get("a"):
                sold, expired = removed_estimates(prev["a"], cur)
                try:
                    sale_prices = removed_sales(prev["a"], cur)
                except Exception as e:
                    print("Sale prices skipped:", e)
                print(f"Removed since previous state ({prev.get('ts')}): {sum(sold.values())} units sold/cancelled, {sum(expired.values())} expired")
        except Exception as e:
            print("Sell-through estimate skipped:", e)

        rows = []
        for item_id, r in rows_by_item.items():
            rows.append(r + ([sold.get(item_id, 0), expired.get(item_id, 0)] if sold is not None else ["", ""]))
        if sold is not None:  # items that sold out completely have no listing left but still sold
            for item_id in (set(sold) | set(expired)) - set(rows_by_item):
                rows.append([item_id, "", "", 0, 0, sold.get(item_id, 0), expired.get(item_id, 0)])
        rows.sort(key=lambda r: r[0])
        info["items"] = len(rows_by_item)

        path = save_snapshot(rows, when)
        if path:
            print(f"Saved {len(rows)} items to {path}")
            info["result"] = "new_snapshot"
            try:
                save_ladder_history(when)
            except Exception as e:
                print("Could not save ladder history:", e)
            try:
                save_sales(when, sale_prices)
            except Exception as e:
                print("Could not save sale prices:", e)
            try:
                save_ladder(when)
            except Exception as e:
                print("Could not save ladders:", e)
            info["snapshot_utc"] = when.strftime("%Y-%m-%dT%H:%M:00Z")
            try:
                save_state(when.strftime("%Y-%m-%dT%H:%M:%SZ"), cur)
            except Exception as e:
                print("Could not save state:", e)
        else:
            info["result"] = "no_change"
            if not STATE_FILE.exists():  # start tracking now so the next change can be compared
                try:
                    save_state(when.strftime("%Y-%m-%dT%H:%M:%SZ"), cur)
                except Exception as e:
                    print("Could not save state:", e)
        info["names_known"] = update_item_names(list(rows_by_item.values()), token)
        try:
            build_professions(token)
        except Exception as e:
            print(f"Profession step failed: {e}")
        try:
            update_icons(list(rows_by_item.values()), token)
        except Exception as e:
            print(f"Icon step failed: {e}")
        try:
            build_skills(token)
        except Exception as e:
            print(f"Skill step failed: {e}")
    except SystemExit as e:
        info["note"] = str(e.code)[:200]
        raise
    except Exception as e:
        info["note"] = f"{type(e).__name__}: {e}"[:200]
        raise
    finally:
        info["seconds"] = round(time.time() - started)
        try:
            log_run(info)
        except Exception as e:
            print("Could not write runs.csv:", e)


if __name__ == "__main__":
    main()
