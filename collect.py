#!/usr/bin/env python3
"""
Collects Horde Auction House prices for WoW: Forever (EU, PvP ruleset) and saves
one compact snapshot per run to data/YYYY/MM/DD/HHMM.csv.gz.
Also keeps items.json (item id -> item name). Standard library only.

Needs two environment variables (GitHub secrets):
  BNET_CLIENT_ID, BNET_CLIENT_SECRET
"""
import base64
import csv
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

REGION = os.environ.get("WOW_REGION", "eu")
RULESET_ID = os.environ.get("WOW_RULESET_ID", "1")  # 1 = PvP
HOUSE_NAME = os.environ.get("WOW_HOUSE_NAME", "Horde Auction House")
DYNAMIC_NS = f"dynamic-forever-{REGION}"
STATIC_NS = f"static-forever-{REGION}"
API = f"https://{REGION}.api.blizzard.com"
DATA_DIR = Path("data")
ITEMS_FILE = Path("items.json")
MAX_NAME_LOOKUPS = 8000  # new item names resolved per run


def fetch(req, retries=3):
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
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
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    return fetch(req)["access_token"]


def api(path, namespace, token):
    sep = "&" if "?" in path else "?"
    url = f"{API}{path}{sep}namespace={namespace}&locale=en_GB"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
        },
    )
    return fetch(req)


def unit_price(a):
    """Price per single item, in copper."""
    if a.get("unit_price"):
        return int(a["unit_price"])
    buyout = a.get("buyout")
    qty = a.get("quantity") or 1
    if buyout:
        return int(buyout // qty)
    return None  # bid-only listing, ignored


def as_list(x):
    if isinstance(x, list):
        return x
    if isinstance(x, dict) and isinstance(x.get("auctions"), list):
        return x["auctions"]
    return []


def weighted_median(pairs):
    """pairs = [(price, qty)] -> quantity-weighted median price."""
    pairs = sorted(pairs)
    total = sum(q for _, q in pairs)
    half = total / 2
    run = 0
    for price, qty in pairs:
        run += qty
        if run >= half:
            return price
    return pairs[-1][0]


def aggregate(listings):
    by_item = defaultdict(list)
    for a in listings:
        item = a.get("item") or {}
        item_id = item.get("id")
        price = unit_price(a)
        if item_id is None or price is None:
            continue
        by_item[item_id].append((price, int(a.get("quantity") or 1)))
    rows = []
    for item_id, pairs in sorted(by_item.items()):
        rows.append(
            [
                item_id,
                min(p for p, _ in pairs),
                weighted_median(pairs),
                sum(q for _, q in pairs),
                len(pairs),
            ]
        )
    return rows


def save_snapshot(rows, now):
    folder = DATA_DIR / f"{now:%Y}" / f"{now:%m}" / f"{now:%d}"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{now:%H%M}.csv.gz"
    with gzip.open(path, "wt", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["item_id", "min_price", "median_price", "total_qty", "num_listings"])
        w.writerows(rows)
    return path


def lookup_name(item_id, token):
    try:
        data = api(f"/data/wow/item/{item_id}", STATIC_NS, token)
        name = data.get("name")
        if isinstance(name, dict):
            name = name.get("en_GB") or name.get("en_US") or next(iter(name.values()), None)
        return item_id, name
    except Exception:
        return item_id, None  # item not resolvable right now; retried next run


def update_item_names(item_ids, token):
    names = {}
    if ITEMS_FILE.exists():
        names = json.loads(ITEMS_FILE.read_text(encoding="utf-8"))
    missing = [i for i in item_ids if str(i) not in names][:MAX_NAME_LOOKUPS]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for item_id, name in pool.map(lambda i: lookup_name(i, token), missing):
            if name:
                names[str(item_id)] = name
    ITEMS_FILE.write_text(
        json.dumps(names, ensure_ascii=False, sort_keys=True, indent=0), encoding="utf-8"
    )
    print(f"Item names known: {len(names)} (tried {len(missing)} this run)")


def main():
    now = datetime.now(timezone.utc)
    token = get_token()
    print("Token OK")

    ruleset = api(f"/data/wow/ruleset/{RULESET_ID}", DYNAMIC_NS, token)
    print(f"Ruleset {RULESET_ID}: {ruleset.get('name')} (status: {ruleset.get('status')})")

    # NOTE: the trailing slash on the index is required.
    index = api(f"/data/wow/ruleset/{RULESET_ID}/auctions/", DYNAMIC_NS, token)
    houses = index.get("auctions", [])
    print("Auction houses:", [(h.get("id"), h.get("name")) for h in houses])
    match = [h for h in houses if h.get("name") == HOUSE_NAME]
    if not match:
        sys.exit(f"Could not find '{HOUSE_NAME}' in the auction house index")
    house_id = match[0]["id"]

    house = api(f"/data/wow/ruleset/{RULESET_ID}/auctions/{house_id}", DYNAMIC_NS, token)
    print("House response keys:", list(house.keys()))
    listings = as_list(house.get("auctions"))
    commodities = as_list(house.get("commodities"))
    if not commodities:
        try:
            commodities = as_list(
                api(f"/data/wow/ruleset/{RULESET_ID}/auctions/{house_id}/commodities", DYNAMIC_NS, token)
            )
        except urllib.error.HTTPError as e:
            print(f"No commodities endpoint data (HTTP {e.code})")
    print(f"Regular listings: {len(listings)}, commodity listings: {len(commodities)}")
    all_listings = listings + commodities
    if all_listings:
        print("Sample listing:", json.dumps(all_listings[0]))
    else:
        sys.exit("No listings returned - check the log above (response structure may differ)")

    rows = aggregate(all_listings)
    path = save_snapshot(rows, now)
    print(f"Saved {len(rows)} items to {path}")
    update_item_names([r[0] for r in rows], token)


if __name__ == "__main__":
    main()
