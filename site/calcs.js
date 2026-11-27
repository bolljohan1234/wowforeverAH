// All calculations. Each one is self-contained so that readers can check the formula in Sources.
(function () {
  dash.calc("hist", {
    title: "Price history per item",
    description: "The history file with each list of per-snapshot values read as numbers.",
    inputs: ["history"],
    fn: (history) => history.map((r) => {
      const a = (v) => (typeof v === "string" ? JSON.parse(v) : v);
      return { id: Number(r.id), m: a(r.m), d: a(r.d), q: a(r.q), n: a(r.n), o: a(r.o), x: a(r.x) };
    }),
  });

  dash.calc("latest", {
    title: "Latest prices",
    description: "Newest prices: one row per item that has listings. From your own AH scan (addon) when it is newer than the collector's newest snapshot, otherwise from that snapshot.",
    inputs: ["hist", "snaps", "names", "scan_saved"],
    fn: (history, snaps, names, scan) => {
      const K = snaps.length;
      if (!K) return [];
      const last = K - 1, tNow = snaps[last].t;
      const nm = new Map(names.map((r) => [r.id, r.name])), vd = new Map(names.map((r) => [r.id, r.vendor == null ? null : Number(r.vendor)])), qm = new Map(names.map((r) => [r.id, r.q == null ? null : Number(r.q)]));
      const out = [], S = scan[0] && scan[0].t > tNow ? scan[0] : null;   // items your scan did not see keep Blizzard's newest price
      for (const r of history) {
        const base = { q: qm.has(r.id) ? qm.get(r.id) : null, id: r.id, name: nm.get(r.id) || "Item " + r.id, vendor: vd.has(r.id) ? vd.get(r.id) : null, sold: r.o[last], exp: r.x[last] };
        const s = S ? S.p.get(r.id) : null;
        if (s && s[0] > 0) {
          out.push(Object.assign(base, { min: s[0], med: r.d[last] != null ? r.d[last] : s[0], qty: s[3], n: s[4], t: S.t, src: "scan" }));
        } else {
          if (r.m[last] == null) continue;
          out.push(Object.assign(base, { min: r.m[last], med: r.d[last], qty: r.q[last], n: r.n[last], t: tNow, src: "api" }));
        }
      }
      return out;
    },
  });

  dash.calc("hold_totals", {
    title: "Units in the game, per item",
    description: "Total units of each item across all characters (bags, bank, mail, auctions, equipped). Empty until the game file is read.",
    inputs: ["holdings_saved"],
    fn: (saved) => {
      const m = new Map();
      for (const c of saved) { const items = typeof c.items === "string" ? JSON.parse(c.items) : c.items || {}; for (const [k, v] of Object.entries(items)) m.set(Number(k), (m.get(Number(k)) || 0) + v.reduce((a, b) => a + b, 0)); }
      return [...m].map(([id, total]) => ({ id: id, total: total }));
    },
  });

  dash.calc("ledger_all", {
    title: "All purchases",
    description: "Every purchase, collection and sale in your private log, oldest first.",
    inputs: ["ledger_saved"],
    fn: (fromPage) => {
      const out = [];
      fromPage.forEach((r) => out.push({ key: "p" + r.id, how: r.how === "collected" || r.how === "sold" ? r.how : "bought", item: r.item, id: Number(r.item_id), unit: Number(r.unit) || 0, qty: Number(r.qty), date: r.date, doc: r.id, src: r.src || "" }));
      return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    },
  });

  dash.calc("ledger_pl", {
    title: "Positions vs current prices",
    description: "Purchases, collections and sales grouped per item. Cost basis is the average cost of every unit you acquired (collected units cost nothing); what you still hold is valued at the lowest buyout in the newest snapshot.",
    inputs: ["ledger_all", "latest", "hold_totals", "names"],
    fn: (ledger, latest, htot, names) => {
      const now = new Map(latest.map((r) => [r.id, r]));
      // once your game inventory is known, units you no longer own (used, sold outside the log) stop counting
      const inGame = htot.length ? new Map(htot.map((r) => [r.id, r.total])) : null;
      const groups = new Map();
      for (const l of ledger) {
        const g = groups.get(l.id) || { item: l.item, id: l.id, bq: 0, cq: 0, sq: 0, cost: 0, revenue: 0 };
        if (l.how === "sold") { g.sq += l.qty; g.revenue += l.qty * l.unit; }
        else if (l.how === "collected") g.cq += l.qty;
        else { g.bq += l.qty; g.cost += l.qty * l.unit; }
        groups.set(l.id, g);
      }
      // items in your game inventory that are not in the log count as collected (cost nothing)
      const nm = new Map(names.map((r) => [r.id, r.name]));
      if (inGame) for (const [id, total] of inGame) {
        if (!now.has(id) || !(total > 0)) continue;
        const g = groups.get(id) || { item: nm.get(id) || "Item " + id, id: id, bq: 0, cq: 0, sq: 0, cost: 0, revenue: 0 };
        const logQ = Math.max(0, g.bq + g.cq - g.sq);
        if (total > logQ) { g.cq += total - logQ; g.auto = total - logQ; }
        groups.set(id, g);
      }
      return [...groups.values()].map((g) => {
        const n = now.get(g.id);
        const acquired = g.bq + g.cq, logHeld = Math.max(0, acquired - g.sq - (g.auto || 0));
        const held = inGame ? Math.min(Math.max(0, acquired - g.sq), inGame.get(g.id) || 0) : logHeld;
        const unitCost = acquired ? g.cost / acquired : 0;
        const costHeld = inGame ? held * unitCost : Math.max(0, g.cost - Math.min(g.sq, acquired) * unitCost);
        const price = n ? n.min : null;
        const value = held > 0 && price != null ? price * held : null;
        const pl = value == null ? null : value - costHeld;
        const after = value == null ? null : Math.round(price * 0.95) * held;
        const after_pl = after == null ? null : after - costHeld;
        const vend = n && n.vendor != null && n.vendor > 0 ? n.vendor : null;
        const realized = g.sq ? g.revenue - Math.min(g.sq, acquired) * unitCost : 0;
        // split into the part that was bought and the part that was collected (assumes sales and holdings mix in proportion)
        const fb = acquired ? g.bq / acquired : 0, held_b = Math.round(held * fb), sold_b = Math.round(g.sq * fb);
        const revenue_b = g.revenue * fb, realized_b = g.sq ? revenue_b - Math.min(g.sq, acquired) * unitCost : 0;
        return {
          held_b: held_b, held_c: held - held_b, sold_b: sold_b, sold_c: g.sq - sold_b, fb: fb, bought: g.bq,
          revenue_b: revenue_b, revenue_c: g.revenue - revenue_b, realized_b: realized_b, realized_c: realized - realized_b,
          item: g.item, id: g.id, qty: held, log_qty: logHeld, collected: g.cq, auto: g.auto || 0, sold: g.sq, revenue: g.revenue, realized: realized,
          cost: costHeld, avg: g.bq ? Math.round(g.cost / g.bq) : null, avg_sale: g.sq ? Math.round(g.revenue / g.sq) : null,
          vendor: vend, vendor_value: vend == null || !held ? null : vend * held, price: price, value: value, pl: pl, pct: pl == null || !costHeld ? null : pl / costHeld, med: n ? n.med : null, after: after, after_pl: after_pl, after_pct: after_pl == null || !costHeld ? null : after_pl / costHeld,
        };
      });
    },
  });

  dash.calc("portfolio", {
    title: "Portfolio summary",
    description: "Totals over what you still hold (that has a current price). profit_today = profit from sales already made + what you hold sold at today's lowest buyout after the 5% cut, minus what it cost.",
    inputs: ["ledger_pl", "snaps"],
    fn: (pl, snaps) => {
      const held = pl.filter((r) => r.qty > 0);
      const priced = held.filter((r) => r.value != null);
      const invested = priced.reduce((a, r) => a + r.cost, 0);
      const value = priced.reduce((a, r) => a + r.value, 0);
      const realized = pl.reduce((a, r) => a + r.realized, 0);
      return [{
        invested: invested, value: value, pl: value - invested,
        pct: invested ? (value - invested) / invested : null,
        after_cut: Math.round(value * 0.95) - invested,
        profit_today: realized + Math.round(value * 0.95) - invested,
        realized: realized, total: realized + value - invested, total_pct: invested ? (realized + value - invested) / invested : null, revenue: pl.reduce((a, r) => a + r.revenue, 0),
        snapshots: snaps.length, latest: snaps.length ? snaps[snaps.length - 1].t : null,
        unpriced: held.length - priced.length,
        floor: held.reduce((a, r) => a + (r.vendor_value || 0), 0), floor_known: held.filter((r) => r.vendor_value != null).length,
      }];
    },
  });

  dash.calc("pf_items", {
    title: "Position value over time, per item",
    description: "For every item you hold or have held (logged, collected, or in the game file): how many units you owned at each snapshot times its lowest buyout then. Units that are in the game but not in your log are assumed to have been held the whole time. Value is empty when the item had no listings.",
    inputs: ["ledger_all", "hist", "snaps", "ledger_pl"],
    fn: (ledger, history, snaps, pl) => {
      const day = (t) => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
      const byId = new Map(history.map((r) => [r.id, r]));
      const items = new Map();
      for (const l of ledger) { if (!items.has(l.id)) items.set(l.id, { id: l.id, item: l.item, ev: [], extra: 0 }); items.get(l.id).ev.push(l); }
      for (const p of pl) {
        if (!(p.qty > 0)) continue;
        if (!items.has(p.id)) items.set(p.id, { id: p.id, item: p.item, ev: [], extra: 0 });
        const it = items.get(p.id);
        let fin = 0; for (const e of it.ev) fin += e.how === "sold" ? -e.qty : e.qty;
        it.extra = Math.max(0, p.qty - Math.max(0, fin));   // units that are in the game but not in the log
      }
      const days = snaps.map((s) => day(s.t));
      const out = [];
      for (const it of items.values()) {
        const h = byId.get(it.id);
        if (!h) continue;
        for (let k = 0; k < snaps.length; k++) {
          let q = 0;
          for (const e of it.ev) if (e.date <= days[k]) q += e.how === "sold" ? -e.qty : e.qty;
          q = Math.max(0, q) + it.extra;
          if (q <= 0) continue;
          out.push({ t: snaps[k].t, id: it.id, item: it.item, qty: q, value: h.m[k] == null ? null : h.m[k] * q });
        }
      }
      return out;
    },
  });

  dash.calc("trends", {
    title: "Price, supply and sell-through signals",
    description: "Per item: change since the previous snapshot and 24 h ago, position against its 7-day average, supply change, and estimated sales per day.",
    inputs: ["hist", "snaps", "latest"],
    fn: (history, snaps, latest) => {
      const H = 3600e3, K = snaps.length;
      if (!K) return [];
      const T = snaps.map((s) => s.t), last = K - 1, tNow = T[last];
      let k24 = -1, best = 1e18;
      for (let k = 0; k < last; k++) { const d = Math.abs(T[k] - (tNow - 24 * H)); if (d <= 6 * H && d < best) { best = d; k24 = k; } }
      const win = [];
      for (let k = 0; k < K; k++) if (T[k] >= tNow - 7 * 24 * H) win.push(k);
      const enough = win.length >= 4 && tNow - T[win[0]] >= 12 * H;
      const hasEst = T.map(() => false);
      for (const r of history) for (let k = 0; k < K; k++) if (!hasEst[k] && r.o[k] != null) hasEst[k] = true;
      const ks = [];
      let hrs = 0;
      for (let k = 1; k < K; k++) if (hasEst[k] && T[k] >= tNow - 24 * H) { ks.push(k); hrs += (T[k] - T[k - 1]) / H; }
      const byId = new Map(history.map((r) => [r.id, r]));
      return latest.map((L) => {
        const r = byId.get(L.id), m = r.m;
        let pk = -1;
        for (let k = L.t > tNow ? last : last - 1; k >= 0; k--) if (m[k] != null) { pk = k; break; }   // a newer own scan is compared with the newest snapshot
        let avg7 = null, sd7 = null;
        if (enough) {
          const v = [];
          for (const k of win) if (m[k] != null) v.push(m[k]);
          if (v.length >= 4) {
            avg7 = v.reduce((a, b) => a + b, 0) / v.length;
            sd7 = Math.sqrt(v.reduce((a, b) => a + (b - avg7) * (b - avg7), 0) / v.length);
          }
        }
        let sold = 0, exp = 0;
        for (const k of ks) { sold += r.o[k] || 0; exp += r.x[k] || 0; }
        const perDay = hrs > 0 ? (sold / hrs) * 24 : null;
        return {
          id: L.id, name: L.name, now: L.min, qty: L.qty, n: L.n,
          prev: pk >= 0 ? m[pk] : null,
          chg_prev: pk >= 0 && m[pk] > 0 ? (L.min - m[pk]) / m[pk] : null,
          chg24: k24 >= 0 && m[k24] > 0 ? (L.min - m[k24]) / m[k24] : null,
          avg7: avg7, dev7: avg7 ? (L.min - avg7) / avg7 : null,
          vol7: avg7 ? sd7 / avg7 : null,
          supply24: k24 >= 0 && r.q[k24] > 0 ? (L.qty - r.q[k24]) / r.q[k24] : null,
          sold_day: perDay,
          exp_share: sold + exp > 0 ? exp / (sold + exp) : null,
          days_supply: perDay > 0 ? L.qty / perDay : null,
          turnover: perDay != null ? perDay * L.min : null,
        };
      });
    },
  });

  dash.calc("movers", {
    title: "Movers",
    description: "Change in lowest buyout since the previous snapshot, items with at least 5 listings.",
    inputs: ["trends"],
    fn: (trends) => {
      const rows = trends.filter((t) => t.chg_prev != null && t.n >= 5 && t.prev != null).sort((a, b) => b.chg_prev - a.chg_prev);
      const mk = (t, dir) => ({ id: t.id, name: t.name, prev: t.prev, now: t.now, pct: t.chg_prev, n: t.n, dir: dir });
      return [...rows.filter((t) => t.chg_prev > 0).slice(0, 8).map((t) => mk(t, "up")), ...rows.filter((t) => t.chg_prev < 0).slice(-8).reverse().map((t) => mk(t, "down"))];
    },
  });

  dash.calc("supply_view", {
    title: "Supply changes",
    description: "Change in units for sale over about 24 hours, items with at least 10 listings.",
    inputs: ["trends"],
    fn: (trends) => {
      const rows = trends.filter((t) => t.supply24 != null && t.n >= 10).sort((a, b) => b.supply24 - a.supply24);
      const mk = (t, dir) => ({ id: t.id, name: t.name, qty: t.qty, pct: t.supply24, chg24: t.chg24, now: t.now, dir: dir });
      return [...rows.filter((t) => t.supply24 > 0).slice(0, 8).map((t) => mk(t, "up")), ...rows.filter((t) => t.supply24 < 0).slice(-8).reverse().map((t) => mk(t, "down"))];
    },
  });

  dash.calc("sellthru_view", {
    title: "Sell-through",
    description: "Items ranked by estimated gold turnover per day (units sold per day times lowest buyout).",
    inputs: ["trends"],
    fn: (trends) =>
      trends.filter((t) => t.sold_day != null && t.sold_day > 0 && t.n >= 3).sort((a, b) => b.turnover - a.turnover).slice(0, 15)
        .map((t) => ({ id: t.id, name: t.name, sold_day: t.sold_day, exp_share: t.exp_share, days_supply: t.days_supply, now: t.now, turnover: t.turnover })),
  });

  dash.calc("buywatch", {
    title: "Buy watch",
    description: "Items at least 8% below their 7-day average with at least 10 listings, cheapest relative to normal first.",
    inputs: ["trends"],
    fn: (trends) =>
      trends.filter((t) => t.dev7 != null && t.dev7 <= -0.08 && t.n >= 10).sort((a, b) => a.dev7 - b.dev7).slice(0, 15)
        .map((t) => ({ id: t.id, name: t.name, now: t.now, avg7: t.avg7, dev7: t.dev7, chg24: t.chg24, supply24: t.supply24, sold_day: t.sold_day })),
  });

  dash.calc("opportunity", {
    title: "Opportunity map",
    description: "Every item with a 7-day average: price against normal (x) and estimated sales per day (y).",
    inputs: ["trends"],
    fn: (trends) => trends.filter((t) => t.dev7 != null && t.n >= 10 && t.sold_day != null).map((t) => ({ id: t.id, name: t.name, dev7: t.dev7, sold_day: t.sold_day, now: t.now })),
  });

  dash.calc("advice", {
    title: "Hold or sell",
    description: "A simple rule-based read on each position (rules are listed under Info).",
    inputs: ["ledger_pl", "trends"],
    fn: (pl, trends) => {
      const tr = new Map(trends.map((t) => [t.id, t]));
      return pl.filter((p) => p.qty > 0).map((p) => {
        const t = tr.get(p.id);
        let text = "Not enough history yet", short = "Too early", tone = "flat";
        if (p.price == null) { text = "No listings right now"; short = "No listings"; }
        else if (t && t.dev7 != null) {
          const falling = t.chg24 != null && t.chg24 < 0;
          if (t.dev7 >= 0.1 && (p.avg == null || p.price > p.avg)) { text = "Consider selling: 10%+ above its normal price and above your avg buy price"; short = "Consider selling"; tone = "up"; }
          else if (t.dev7 >= 0.1) { text = "High vs normal but still below your buy price: wait"; short = "Wait"; tone = "flat"; }
          else if (t.dev7 <= -0.1 && falling) { text = "Below normal and still falling: hold, don't add yet"; short = "Hold, don't add"; tone = "down"; }
          else if (t.dev7 <= -0.08) { text = "Cheap vs normal and not falling: could add more"; short = "Could add more"; tone = "up"; }
          else { text = "Near normal: hold"; short = "Hold"; }
        }
        return { item: p.item, id: p.id, avg: p.avg, price: p.price, dev7: t ? t.dev7 : null, chg24: t ? t.chg24 : null, advice: text, short: short, tone: tone };
      });
    },
  });

  dash.calc("recipe_margins", {
    title: "Crafting margins",
    description: "For every recipe: reagent cost at the lowest buyout, against what the product sells for at its lowest buyout after a 5% auction cut.",
    inputs: ["recipes", "latest", "trends", "names"],
    fn: (recipes, latest, trends, names) => {
      const P = new Map(latest.map((r) => [r.id, r.min]));
      const nm = new Map(names.map((r) => [r.id, r.name]));
      const S = new Map(trends.map((t) => [t.id, t.sold_day]));
      return recipes.map((r) => {
        const reag = typeof r.r === "string" ? JSON.parse(r.r) : r.r;
        let cost = 0; const missing = [], detail = [];
        for (const [id, q] of reag) {
          if (P.has(id)) cost += P.get(id) * q; else missing.push(nm.get(id) || "item " + id);
          detail.push({ id: id, name: nm.get(id) || "Item " + id, q: q, price: P.has(id) ? P.get(id) : null });
        }
        const out = Number(r.out), qty = Number(r.q) || 1;
        const price = P.has(out) ? P.get(out) : null;
        const ok = missing.length === 0;
        const profit = ok && price != null ? Math.round(price * qty * 0.95 - cost) : null;
        return {
          id: Number(r.id), name: r.name || nm.get(out) || "Item " + out, p: r.p, cat: r.cat || r.tier || "Other", out: out, qty: qty,
          lvl: r.lvl == null || r.lvl === "" ? null : Number(r.lvl), reag: detail, cost: ok ? cost : null, missing: missing.slice(0, 3).join(", ") + (missing.length > 3 ? "…" : ""), price: price,
          profit: profit, margin: profit != null && cost > 0 ? profit / cost : null, sold_day: S.has(out) ? S.get(out) : null,
        };
      });
    },
  });


  dash.calc("ladder_view", {
    title: "Price ladders",
    description: "For each item, the cheapest price levels on the auction house with the units offered at each (saved by the collector).",
    inputs: ["ladder"],
    fn: (ladder) => ladder.map((r) => ({ id: Number(r.id), lv: typeof r.l === "string" ? JSON.parse(r.l) : r.l })),
  });

  dash.calc("expired_view", {
    title: "Listings that expired unsold",
    description: "Per item, over the stored sale-price window: units that disappeared from the about-to-expire bucket (probably expired unsold) with their average price, set against what units probably sold for and today's lowest price.",
    inputs: ["expiredprices", "salesprices", "latest"],
    fn: (ex, sa, latest) => {
      const L = new Map(latest.map((r) => [r.id, r]));
      const agg = (rows) => { const m = new Map(); for (const r of rows) { const id = Number(r.id), a = m.get(id) || { u: 0, v: 0 }; a.u += Number(r.u); a.v += Number(r.u) * Number(r.av); m.set(id, a); } return m; };
      const E = agg(ex), S = agg(sa);
      const out = [];
      for (const [id, a] of E) {
        const l = L.get(id); if (!l || a.u < 3) continue;
        const s = S.get(id), eAvg = Math.round(a.v / a.u), sAvg = s && s.u ? Math.round(s.v / s.u) : null, su = s ? s.u : 0;
        out.push({ id: id, name: l.name, exp_units: a.u, exp_avg: eAvg, sold_units: su, sold_avg: sAvg, exp_share: a.u / (a.u + su),
          over_sold: sAvg ? (eAvg - sAvg) / sAvg : null, over_now: l.min > 0 ? (eAvg - l.min) / l.min : null, now: l.min });
      }
      return out.sort((x, y) => y.exp_units - x.exp_units);
    },
  });

  dash.calc("ladder_gap", {
    title: "Price gap history",
    description: "Per item, the cheapest price level and the next one at each saved ladder time, the gap between them, and the share of times the gap was at least 10%.",
    inputs: ["ladderhist"],
    fn: (rows) => rows.map((r) => {
      const a = (v) => (typeof v === "string" ? JSON.parse(v) : v), t = a(r.t), p1 = a(r.p1), p2 = a(r.p2), q1 = a(r.q1);
      let n = 0, held = 0;
      for (let k = 0; k < t.length; k++) if (p1[k] != null && p2[k] != null) { n++; if ((p2[k] - p1[k]) / p1[k] >= 0.1) held++; }
      return { id: Number(r.id), t: t, p1: p1, p2: p2, q1: q1, n: n, held: n >= 2 ? held / n : null };
    }),
  });

  dash.calc("holdings_view", {
    title: "Everything you own, all characters",
    description: "Item counts per character from the game file (bags, bank, mail, auctions, equipped), joined with the lowest price now and what your log says you hold.",
    inputs: ["holdings_saved", "ledger_pl", "latest", "names"],
    fn: (saved, pl, latest, names) => {
      const L = new Map(latest.map((r) => [r.id, r])), N = new Map(names.map((r) => [r.id, r])), P = new Map(pl.map((r) => [r.id, r.log_qty]));
      const by = new Map();
      for (const c of saved) {
        const items = typeof c.items === "string" ? JSON.parse(c.items) : c.items || {};
        for (const [k, v] of Object.entries(items)) {
          const id = Number(k); let r = by.get(id);
          if (!r) { r = { id: id, loc: [0, 0, 0, 0, 0], chars: [] }; by.set(id, r); }
          v.forEach((n, i) => { r.loc[i] += n; });
          r.chars.push({ name: c.char, qty: v.reduce((a, b) => a + b, 0) });
        }
      }
      return [...by.values()].map((r) => {
        const l = L.get(r.id), n = N.get(r.id), total = r.loc.reduce((a, b) => a + b, 0), logq = P.get(r.id) || 0;
        return { id: r.id, name: n ? n.name : null, q: n && n.q != null ? Number(n.q) : null, total: total, bags: r.loc[0], bank: r.loc[1], mail: r.loc[2], ah: r.loc[3], eq: r.loc[4],
          log: logq, missing: Math.max(0, total - logq), price: l ? l.min : null, worth: l && l.min ? l.min * total : null, chars: r.chars };
      });
    },
  });

  dash.calc("holdings_chars", {
    title: "Characters",
    description: "Per character from the game file: gold, number of items and what they are worth at today's lowest prices.",
    inputs: ["holdings_saved", "latest"],
    fn: (saved, latest) => {
      const L = new Map(latest.map((r) => [r.id, r]));
      return saved.map((c) => {
        const items = typeof c.items === "string" ? JSON.parse(c.items) : c.items || {};
        let units = 0, worth = 0, kinds = 0;
        for (const [k, v] of Object.entries(items)) { const q = v.reduce((a, b) => a + b, 0), l = L.get(Number(k)); units += q; kinds++; if (l && l.min) worth += l.min * q; }
        return { char: c.char, cls: c.cls, money: c.money || 0, units: units, kinds: kinds, worth: worth, at: c.at || null };
      }).sort((a, b) => (b.worth + b.money) - (a.worth + a.money));
    },
  });

  dash.calc("flip_view", {
    title: "Flip scanner",
    description: "Items where the cheapest listing sits well below the next one: buy at the lowest price, resell near the next listing (median if no ladder), after the 5% auction cut.",
    inputs: ["latest", "trends", "ladder_view"],
    fn: (latest, trends, ladders) => {
      const Lm = new Map(ladders.map((r) => [r.id, r.lv])), T = new Map(trends.map((t) => [t.id, t]));
      const out = [];
      for (const L of latest) {
        if (L.n < 3 || !(L.min > 0)) continue;
        const lv = Lm.get(L.id);
        let ref = null, units = null, basis = "median";
        if (lv && lv.length >= 2) { ref = lv[1][0]; units = lv[0][1]; basis = "next listing"; }
        else if (L.med > L.min) ref = L.med;
        if (ref == null || ref <= L.min) continue;
        const profit = Math.round(ref * 0.95 - L.min);
        if (profit <= 0 || profit / L.min < 0.1) continue;
        const t = T.get(L.id) || {};
        out.push({ id: L.id, q: L.q, name: L.name, min: L.min, ref: ref, basis: basis, units: units, profit: profit, roi: profit / L.min, total: units == null ? null : profit * units, n: L.n, sold_day: t.sold_day == null ? null : t.sold_day });
      }
      return out.sort((a, b) => (b.total == null ? b.profit : b.total) - (a.total == null ? a.profit : a.total)).slice(0, 300);
    },
  });

  dash.calc("writ_view", {
    title: "Craftsman's Writ tracker",
    description: "Every item that has a Craftsman's Writ: what the item and the writ cost on the auction house, and what the item costs to craft.",
    inputs: ["iteminfo", "latest", "recipe_margins", "trends", "names"],
    fn: (info, latest, margins, trends, names) => {
      const L = new Map(latest.map((r) => [r.id, r])), T = new Map(trends.map((t) => [t.id, t])), N = new Map(names.map((r) => [r.id, r.name]));
      const craft = new Map();
      for (const m of margins) if (m.cost != null && (!craft.has(m.out) || m.cost < craft.get(m.out).cost)) craft.set(m.out, { cost: m.cost, p: m.p });
      return info.filter((r) => r.writ_id != null).map((r) => {
        const it = L.get(r.id), w = L.get(r.writ_id), cr = craft.get(r.id);
        return {
          id: r.id, name: N.get(r.id) || (it && it.name) || "Item " + r.id, price: it ? it.min : null, n: it ? it.n : 0,
          writ_id: r.writ_id, writ_price: w ? w.min : null, writ_n: w ? w.n : 0,
          craft_cost: cr ? cr.cost : null, craft_p: cr ? cr.p : "", sold_day: T.has(r.id) ? T.get(r.id).sold_day : null, writ_sold: T.has(r.writ_id) ? T.get(r.writ_id).sold_day : null,
        };
      });
    },
  });

  dash.calc("runs_view", {
    title: "Collector runs",
    description: "Every run of the collector, newest first.",
    inputs: ["runs"],
    fn: (runs) => runs.map((r, i) => ({ key: r.run + "|" + i, t: Date.parse(r.run), run: r.run, result: r.result, snap: r.snap, snap_t: r.snap ? Date.parse(r.snap) : null, items: r.items, listings: r.listings, seconds: r.seconds, note: r.note }))
      .sort((a, b) => b.t - a.t),
  });

  dash.calc("runs_summary", {
    title: "Run summary",
    description: "When the collector last ran and when Blizzard's prices last changed.",
    inputs: ["runs_view", "snaps"],
    fn: (runs, snaps) => [{
      last_run: runs.length ? runs[0].t : null,
      last_data: snaps.length ? snaps[snaps.length - 1].t : null,
      runs: runs.length,
      failed: runs.filter((r) => r.result === "failed").length,
      snapshots: snaps.length,
    }],
  });


  dash.calc("iteminfo", {
    title: "Item info for hover bubbles",
    description: "Professions that use or make each item (from the profession data) and the Craftsman's Writ item linked to it, found by name.",
    inputs: ["names", "profs", "latest"],
    fn: (names, profs, latest) => {
      const P = new Map(profs.map((r) => [Number(r.id), r]));
      const price = new Map(latest.map((r) => [r.id, r.min]));
      const prefix = "Craftsman's Writ: ";
      const byName = new Map();
      for (const n of names) if (!byName.has(n.name)) byName.set(n.name, n.id);
      const W = new Map();
      for (const n of names) {
        if (!n.name.startsWith(prefix)) continue;
        const target = byName.get(n.name.slice(prefix.length));
        if (target != null) W.set(target, { id: n.id, name: n.name });
      }
      const ids = new Set([...P.keys(), ...W.keys()]);
      return [...ids].map((id) => {
        const p = P.get(id), w = W.get(id);
        return { id: id, uses: p && p.uses ? p.uses : "", makes: p && p.makes ? p.makes : "", writ_id: w ? w.id : null, writ_name: w ? w.name : "", writ_min: w && price.has(w.id) ? price.get(w.id) : null };
      });
    },
  });

  dash.calc("scanner", {
    title: "All items",
    description: "Every item with listings: price, vendor value, how far the price is from vendor value, and trend signals.",
    inputs: ["latest", "trends", "iteminfo", "ladder_view"],
    fn: (latest, trends, info, ladders) => {
      const LD = new Map(ladders.map((r) => [r.id, r.lv]));
      const T = new Map(trends.map((r) => [r.id, r]));
      const I = new Map(info.map((r) => [r.id, r]));
      return latest.map((L) => {
        const t = T.get(L.id) || {};
        const v = L.vendor != null && L.vendor > 0 ? L.vendor : null;
        const lv = LD.get(L.id);
        let uu = null, up = null, uc = false;
        if (v && lv && lv.length) { uu = 0; up = 0; for (const [pr, q] of lv) { if (pr < v) { uu += q; up += (v - pr) * q; } else break; } uc = lv[lv.length - 1][0] < v; }
        return {
          under_units: uu, under_profit: up, under_capped: uc,
          id: L.id, q: L.q, name: L.name, min: L.min, med: L.med, n: L.n, qty: L.qty, vendor: v,
          vs_vendor: v ? (L.min - v) / v : null,
          floor_profit: v ? v - L.min : null,
          chg_prev: t.chg_prev == null ? null : t.chg_prev, chg24: t.chg24 == null ? null : t.chg24,
          dev7: t.dev7 == null ? null : t.dev7, supply24: t.supply24 == null ? null : t.supply24,
          sold_day: t.sold_day == null ? null : t.sold_day,
          uses: (I.get(L.id) || {}).uses || "", makes: (I.get(L.id) || {}).makes || "", writ: I.has(L.id) && I.get(L.id).writ_id != null,
        };
      });
    },
  });
})();
