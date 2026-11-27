(function () {
  const U = window.WOWUI, el$ = U.el$;
  const WOW = (window.WOW = { id: null, q: "", msg: {} });
  // ---------- speed: each dataset is read once per data change ----------
  // The copy is kept until the next data change (dash.onData), so the lookup tables built from it (categories, icons, names, variants) are built once instead of once per row.
  const DC = new Map();
  dash.onData(() => { DC.clear(); });
  const D = (id) => { let v = DC.get(id); if (v === undefined) { v = dash.data(id); DC.set(id, v); } return v; };
  const rowsOf = (id) => { const d = D(id); return d.status === "ok" ? d.data : []; };
  // Category filter (item class and type as the auction house shows them), applied to the portfolio and to every big table
  WOW.cat = { cls: "", sub: "" };
  let CATC = null;
  const catMap = () => { const d = rowsOf("cats"); if (!CATC || CATC.d !== d) CATC = { d: d, m: new Map(d.map((r) => [r.id, r])) }; return CATC.m; };
  const catActive = () => !!WOW.cat.cls;
  const catOk = (id) => {
    if (!WOW.cat.cls) return true;
    const c = catMap().get(id);
    if (WOW.cat.cls === "__none") return !c;
    return !!c && c.cls === WOW.cat.cls && (!WOW.cat.sub || c.sub === WOW.cat.sub);
  };
  // Portfolio scope: everything (Total), only what you bought (Invested) or only what you collected (Collected)
  WOW.pfScope = "total";
  const scopeRow = (r, sc) => {
    const inv = sc === "invested", q = inv ? r.held_b : r.held_c, sq = inv ? r.sold_b : r.sold_c;
    const value = r.price != null && q > 0 ? r.price * q : (q > 0 ? null : 0), cost = inv ? r.cost : 0;
    const after = r.price != null && q > 0 ? Math.round(r.price * 0.95) * q : (q > 0 ? null : 0);
    const pl = value == null ? null : value - cost, after_pl = after == null ? null : after - cost;
    return Object.assign({}, r, { qty: q, sold: sq, cost: cost, value: value, pl: pl, pct: pl == null || !cost ? null : pl / cost, after: after, after_pl: after_pl, after_pct: after_pl == null || !cost ? null : after_pl / cost,
      vendor_value: r.vendor == null || !q ? null : r.vendor * q, revenue: inv ? r.revenue_b : r.revenue_c, realized: inv ? r.realized_b : r.realized_c, paid: inv ? r.paid : 0, collected: inv ? 0 : r.collected,
      avg_sale: r.avg_sale, avg: inv ? r.avg : null });
  };
  const scopedLP = () => { const sc = WOW.pfScope, L = rowsOf("ledger_pl").filter((r) => catOk(r.id)); return sc === "total" ? L : L.map((r) => scopeRow(r, sc)).filter((r) => r.qty > 0 || r.sold > 0); };
  const scopedPortfolio = () => {
    const base = rowsOf("portfolio")[0]; if (!base || (WOW.pfScope === "total" && !catActive())) return base ? [base] : [];
    const pl = scopedLP(), held = pl.filter((r) => r.qty > 0), priced = held.filter((r) => r.value != null);
    const invested = priced.reduce((a, r) => a + r.cost, 0), value = priced.reduce((a, r) => a + r.value, 0), realized = pl.reduce((a, r) => a + r.realized, 0), paid = pl.reduce((a, r) => a + (r.paid || 0), 0);
    return [Object.assign({}, base, { invested: invested, value: value, pl: value - invested, pct: invested ? (value - invested) / invested : null, paid: paid, after_cut: Math.round(value * 0.95) - invested, profit_today: realized + Math.round(value * 0.95),
      realized: realized, total: realized + value - invested, total_pct: invested ? (realized + value - invested) / invested : null, revenue: pl.reduce((a, r) => a + r.revenue, 0),
      unpriced: held.length - priced.length, floor: held.reduce((a, r) => a + (r.vendor_value || 0), 0), floor_known: held.filter((r) => r.vendor_value != null).length })];
  };
  const scopedPF = () => { const sc = WOW.pfScope, rows = rowsOf("pf_items").filter((r) => catOk(r.id)); if (sc === "total") return rows;
    const F = new Map(rowsOf("ledger_pl").map((r) => [r.id, sc === "invested" ? r.fb : 1 - r.fb]));
    return rows.map((r) => { const f = F.get(r.id) || 0; return Object.assign({}, r, { qty: r.qty * f, value: r.value == null ? null : r.value * f }); }).filter((r) => r.qty > 0); };
  const rowsS = (id) => (id === "ledger_pl" ? scopedLP() : id === "portfolio" ? scopedPortfolio() : id === "pf_items" ? scopedPF() : rowsOf(id));

  // ---------- tables are flat lists; an item's category shows when you hover its name (grouping can be turned back on with WOW.group) ----------
  const catText = (id) => { const c = catMap().get(id); return c ? c.cls + (c.sub ? " – " + c.sub : "") : "Not yet categorised"; };
  WOW.group = false; WOW.grpState = new Map(); WOW.grpAll = null;   // grpState: key -> true when the user opened it, false when closed
  const NOCAT = "Not yet categorised";
  const RD = new WeakMap(), GSUM = {};            // RD: row element -> its data row; GSUM: table key -> (rows) => cells for every column
  const reg = (r, el) => { RD.set(el, r); return el; };
  const BIG = 30;                                  // lists longer than this start with the categories closed
  // items that are sold in several versions (bonus ids; real suffix names can be added later) get a "N variants" button that lists each version with its own price
  const VAR = { src: null, map: null };
  const varMap = () => { const d = D("variants"); if (d.status !== "ok") return null;
    if (VAR.src !== d.data) { VAR.src = d.data; VAR.map = new Map(); for (const r of d.data) { if (!VAR.map.has(r.id)) VAR.map.set(r.id, []); VAR.map.get(r.id).push(r); } for (const l of VAR.map.values()) l.sort((a, b) => a.lo - b.lo); }
    return VAR.map; };
  const variantLabel = (b) => "variant " + b;
  const VCOL = [["lo", /^(lowest now|buy at \(lowest now\)|item lowest now)$/i, 1], ["md", /^median now$/i, 1], ["q", /^units for sale$/i, 0], ["n", /^(listings|item listings)$/i, 0]];
  function regroup(tb, key) {
    if (tb._busy) return; tb._busy = true;
    try {
      const table = tb.closest("table"); if (!table) return;
      key = key || table.dataset.tv || tb.dataset.draw;
      [...tb.querySelectorAll("tr.grp, tr.vrow")].forEach((r) => r.remove());
      const vm = varMap(), heads = [...table.querySelectorAll("thead th")].map((t) => t.textContent.trim());
      const vcols = vm ? VCOL.map(([k, re, coin]) => [k, heads.findIndex((h) => re.test(h)), coin]).filter((c) => c[1] >= 0) : [];
      const vmap = new Map();
      if (vm && vcols.length) for (const r of tb.querySelectorAll("tr[data-item]")) {
        const list = vm.get(+r.dataset.item); if (!list || list.length < 2) continue;
        const vk = key + "|v|" + r.dataset.item, open = WOW.grpState.get(vk) === true, first = r.children[0];
        let b = first.querySelector("button.vtoggle");
        if (!b) { b = el$("button", "btn sm vtoggle"); b.type = "button"; first.append(" ", b); }
        b.dataset.vk = vk; b.textContent = (open ? "▾ " : "▸ ") + list.length + " variants"; b.setAttribute("aria-expanded", String(open));
        // sub-rows are only built for items whose variants are open (building them for every item made each click slow)
        const rows = !open ? [] : list.map((v) => { const t = el$("tr", "vrow"); t.dataset.vfor = r.dataset.item; for (let i = 0; i < heads.length; i++) t.append(el$("td"));
          t.children[0].append(el$("span", "vname", "↳ " + variantLabel(v.b)));
          for (const [k, i, coin] of vcols) t.children[i].append(coin ? U.coin(v[k]) : U.num(v[k]));
          t.hidden = !open; return t; });
        r.after(...rows); vmap.set(r, rows);
      }
      const kids = [...tb.children].filter((r) => !r.classList.contains("vrow"));
      const items = kids.filter((r) => r.dataset && r.dataset.item);
      items.forEach((r) => { r.hidden = false; const c0 = r.children[0]; if (c0 && catMap().size && !c0.querySelector("[data-tip]")) c0.title = catText(+r.dataset.item); });
      const sorted = TV[key] && TV[key].col != null;   // sorted by a column: one flat list in that order, no category groups
      if (!WOW.group || items.length < 2 || !catMap().size || sorted) return;
      const cols = table.querySelectorAll("thead th").length || 1, by = new Map(), sumFn = GSUM[key];
      for (const r of items) {
        const c = catMap().get(+r.dataset.item), cls = c ? c.cls : NOCAT, sub = c ? c.sub || "Other" : "";
        if (!by.has(cls)) by.set(cls, new Map());
        const m = by.get(cls); if (!m.has(sub)) m.set(sub, []); m.get(sub).push(r);
      }
      const rest = kids.filter((r) => !(r.dataset && r.dataset.item));
      const placeV = (r, hidden) => { for (const v of vmap.get(r) || []) { v.hidden = hidden || v.dataset.shut === "1"; out.push(v); } };
      const out = [];
      const closedNow = (k, def) => (WOW.grpState.has(k) ? !WOW.grpState.get(k) : def);
      const head = (level, label, rows, k, def) => {
        const tr_ = el$("tr", "grp g" + level), td = el$("td"); tr_.dataset.gk = k; tr_.dataset.def = def ? "1" : "";
        const open = !closedNow(key + "|" + k, def), n = rows.length;
        td.append(el$("span", "garrow", open ? "▾ " : "▸ "), el$("b", "", label), el$("span", "sm", "  " + n + (n === 1 ? " item" : " items")));
        tr_.append(td);
        const data = sumFn ? rows.map((r) => RD.get(r)).filter(Boolean) : [];
        if (sumFn && data.length === rows.length) {
          const cells = sumFn(data).slice(1);
          cells.forEach((c) => { const t = el$("td"); if (c instanceof Node) t.append(c); else t.textContent = c == null ? "" : c; tr_.append(t); });
          while (tr_.children.length < cols) tr_.append(el$("td"));
        } else td.colSpan = cols;
        return tr_;
      };
      const defCls = WOW.grpAll ? WOW.grpAll === "closed" : items.length > BIG;
      for (const [cls, subs] of by) {
        const clsRows = [...subs.values()].flat(), clsClosed = closedNow(key + "|" + cls, defCls);
        out.push(head(1, cls, clsRows, cls, defCls));
        for (const [sub, rows] of subs) {
          const sk = cls + "|" + sub, subClosed = closedNow(key + "|" + sk, false);
          if (sub) { const h = head(2, sub, rows, sk, false); if (clsClosed) h.hidden = true; out.push(h); }
          rows.forEach((r) => { r.hidden = clsClosed || subClosed; out.push(r); placeV(r, r.hidden || !(WOW.grpState.get(key + "|v|" + r.dataset.item) === true)); });
        }
      }
      tb.replaceChildren(...out, ...rest);
    } finally { tb._busy = false; GROBS.takeRecords(); }
  }
  const GROBS = new MutationObserver((recs) => { new Set(recs.map((r) => r.target)).forEach((t) => regroup(t)); });
  const grpClick = (tb, key) => tb.addEventListener("click", (e) => {
    const vb = e.target.closest("button.vtoggle");
    if (vb) { const vk = vb.dataset.vk; WOW.grpState.set(vk, WOW.grpState.get(vk) !== true); regroup(tb, key); return; }
    const h = e.target.closest("tr.grp"); if (!h) return;
    const k = key + "|" + h.dataset.gk, was = WOW.grpState.has(k) ? !WOW.grpState.get(k) : !!h.dataset.def;
    WOW.grpState.set(k, was);   // was closed -> now open
    regroup(tb, key);
  });
  const redrawGrouped = () => { document.querySelectorAll("table[data-tv] tbody[data-draw]").forEach((t) => regroup(t)); };
  document.querySelectorAll("table[data-tv] tbody[data-draw]").forEach((tb) => { GROBS.observe(tb, { childList: true }); grpClick(tb, tb.closest("table").dataset.tv || tb.dataset.draw); });

  // ---------- category filter bar ----------
  const CAT_REDRAW = ["s_value", "s_profit", "s_iftoday", "pos_note", "ledger_rows", "sales_rows", "ch_pie", "ch_pl", "ch_pfseries", "pfchips", "pos_chips", "catsel", "itemlist", "ch_movers", "ch_supply", "ch_sell", "ch_opp"];
  function catChanged() { CAT_REDRAW.forEach((n) => dash.draw(n)); TVKEYS.forEach((k) => redrawTable(k)); }
  dash.draw("catsel", (el) => {
    // the variants list is read here, inside a drawing, so it loads once with the page; when it arrives the tables add their variant buttons
    if (D("variants").status === "ok" && !WOW._varSeen) { WOW._varSeen = true; setTimeout(redrawGrouped, 0); }
    if (!ready(el, ["cats"])) return;
    if (!WOW._catsSeen) { WOW._catsSeen = true; setTimeout(() => { TVKEYS.forEach((k) => redrawTable(k)); dash.draw('pfchips'); dash.draw('ch_pfseries'); }, 0); }
    const all = rowsOf("cats"), by = new Map();
    for (const r of all) by.set(r.cls, (by.get(r.cls) || 0) + 1);
    const mk = (label) => { const s = el$("select", "tfilter"); s.setAttribute("aria-label", label); return s; };
    const opt = (v, t, sel) => { const o = el$("option", "", t); o.value = v; o.selected = sel; return o; };
    const cs = mk("Item class"), ss = mk("Item type");
    cs.append(opt("", "All categories (" + U.num(all.length) + " items)", !WOW.cat.cls));
    [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).forEach(([c, n]) => cs.append(opt(c, c + " (" + U.num(n) + ")", WOW.cat.cls === c)));
    cs.append(opt("__none", "Not yet categorised", WOW.cat.cls === "__none"));
    const subs = new Map();
    for (const r of all) if (r.cls === WOW.cat.cls) subs.set(r.sub || "Other", (subs.get(r.sub || "Other") || 0) + 1);
    ss.append(opt("", WOW.cat.cls && WOW.cat.cls !== "__none" ? "All types" : "Pick a category first", !WOW.cat.sub));
    ss.disabled = !subs.size;
    [...subs].sort((a, b) => (a[0] < b[0] ? -1 : 1)).forEach(([c, n]) => ss.append(opt(c === "Other" ? "" : c, c + " (" + U.num(n) + ")", WOW.cat.sub === c)));
    cs.onchange = () => { WOW.cat = { cls: cs.value, sub: "" }; catChanged(); };
    ss.onchange = () => { WOW.cat.sub = ss.value; catChanged(); };
    const clr = el$("button", "btn sm", "Clear"); clr.type = "button"; clr.disabled = !WOW.cat.cls; clr.onclick = () => { WOW.cat = { cls: "", sub: "" }; catChanged(); };
    const lab = el$("span", "lbl", "Category");
    const info = el$("span", "sm", "");
    el.replaceChildren(lab, cs, ss, clr, info);
  });

  // ---------- tabs ----------
  function openTab(name) {
    document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    const tb = document.querySelector(".timebar"); if (tb) tb.classList.toggle("off", !["portfolio", "explorer", "info"].includes(name));   // only tabs with time charts
    dash.setLink(name);
  }
  function openSub(name) {
    document.querySelectorAll("[data-subpanel]").forEach((p) => { p.hidden = p.dataset.subpanel !== name; });
    document.querySelectorAll("[data-subtab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.subtab === name)));
  }
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));
  document.querySelectorAll("[data-subtab]").forEach((b) => b.addEventListener("click", () => openSub(b.dataset.subtab)));
  document.querySelectorAll("[data-morecols]").forEach((b) => b.addEventListener("click", () => {
    const t = document.querySelector('table[data-tv="' + b.dataset.morecols + '"]'); if (!t) return;
    const on = t.classList.toggle("hidex");
    b.setAttribute("aria-pressed", String(!on));
  }));
  document.querySelectorAll("[data-jump]").forEach((b) => b.addEventListener("click", () => {
    const t = document.getElementById(b.dataset.jump); if (!t) return;
    if (t.tagName === "DETAILS") t.open = true;
    if (t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  const startTab = location.hash.replace("#", "");
  if (startTab && document.querySelector('[data-panel="' + startTab + '"]')) openTab(startTab);

  // ---------- small helpers ----------
  const tn = (text, t) => { const s = el$("span", "", text); if (t) s.dataset.tone = t; return s; };
  const WH = "https://www.wowhead.com/forever/item=";
  function iconMap() {
    const n = D("names"), ic = D("icons");
    if (n.status !== "ok" || ic.status !== "ok") return null;
    if (WOW._icn && WOW._icn.n === n.data && WOW._icn.i === ic.data) return WOW._icn.map;
    const img = new Map(ic.data.map((r) => [r.name, r.data]));
    const map = new Map();
    for (const r of n.data) if (r.icon && img.has(r.icon)) map.set(r.id, img.get(r.icon));
    WOW._icn = { n: n.data, i: ic.data, map: map };
    return map;
  }
  function iconImg(id) {
    const icons = iconMap(), src = icons && icons.get(id);
    if (!src) return null;
    const im = el$("img", "ico"); im.src = src; im.alt = ""; im.width = 18; im.height = 18;
    return im;
  }
  U.setIcons((id) => { const m = iconMap(); return m ? m.get(id) || null : null; });
  function qualityOf(id) {
    const n = D("names");
    if (n.status !== "ok") return null;
    if (!WOW._q || WOW._q.src !== n.data) WOW._q = { src: n.data, map: new Map(n.data.map((r) => [r.id, r.q])) };
    const q = WOW._q.map.get(id);
    return q == null ? null : q;
  }
  function nameCell(name, id) {
    const w = el$("span", "namecell");
    const ic = iconImg(id);
    if (ic) w.append(ic, " ");
    if (id != null && !isNaN(id)) w.dataset.tip = id;
    const q = id != null && !isNaN(id) ? qualityOf(id) : null;
    w.append(q == null ? document.createTextNode(name) : el$("span", "nm q" + q, name));
    if (id != null && !isNaN(id)) {
      const a = el$("a", "wh", "↗");
      a.href = WH + id; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.setAttribute("aria-label", "Open " + name + " on Wowhead"); a.title = "Open on Wowhead";
      w.append(" ", a);
    }
    return w;
  }
  function tr(key, cells, itemId) {
    const r = el$("tr");
    if (key != null) r.dataset.key = key;
    if (itemId != null && !isNaN(itemId)) { r.dataset.item = itemId; r.classList.add("pick"); if (itemId === WOW.id) r.classList.add("sel"); }
    cells.forEach((c) => { const td = el$("td"); if (c instanceof Node) td.append(c); else td.textContent = c == null ? "—" : c; r.append(td); });
    return r;
  }
  // "sold per day" number that shows the prices sold at when hovered
  function soldCell(v, id) { if (v == null) return "—"; const sp = el$("span", "salecell", U.num(v, 1)); if (id != null) sp.dataset.sales = id; return sp; }
  // true when every source is ready; otherwise clears (table bodies) or explains (everything else)
  function ready(el, ids) {
    const ss = ids.map((i) => D(i).status);
    if (ss.every((s) => s === "ok")) return true;
    if (el.tagName === "TBODY" || el.tagName === "DATALIST") el.replaceChildren();
    else if (ss.includes("error")) U.empty(el, "This part failed to load.");
    else el.replaceChildren();
    return false;
  }
  const snapInfo = () => {
    const s = rowsOf("snaps");
    return { n: s.length, first: s.length ? s[0].t : null, last: s.length ? s[s.length - 1].t : null };
  };
  // what the "normal price" average really covers: all snapshots from the last 7 days, so it grows from hours to 7 days
  const avgName = () => { const si = snapInfo(), h = si.n > 1 ? Math.min(168, (si.last - si.first) / 3600e3) : 0; return h >= 167 ? "7-day average" : h < 1 ? "average (no data yet)" : "average of the last " + (h >= 48 ? Math.round(h / 24) + " days" : Math.round(h) + " h"); };
  const localToday = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const signedShort = (v) => (v < 0 ? "−" : "+") + U.short(Math.abs(v));

  // ---------- sortable, filterable tables ----------
  const TV = {};
  const TVKEYS = ["pos", "log", "buy", "floor", "mup", "mdn", "sup", "sell", "scan", "mar", "sales", "flip", "writ", "exp"];
  const MAXROWS = 500;
  const LIMIT = { log: 25, sales: 25, buy: 10, floor: 10, flip: 10, writ: 10, mup: 10, mdn: 10, sup: 10, sell: 10, exp: 10, scan: 25, mar: 15 };
  function tv(key, rows, cols, text) {
    const s = TV[key] || {};
    let out = WOW.cat.cls ? rows.filter((r) => { const id = r.out != null ? r.out : r.id != null ? r.id : r.item_id; return id == null || catOk(id); }) : rows;   // recipes are filtered by the item they make
    if (s.q) out = out.filter((r) => String(text(r) == null ? "" : text(r)).toLowerCase().includes(s.q));
    if (s.col != null && cols[s.col]) {
      const f = cols[s.col], d = s.dir;
      out = out.slice().sort((a, b) => {
        const x = f(a), y = f(b), xn = x == null || (typeof x === "number" && !isFinite(x)), yn = y == null || (typeof y === "number" && !isFinite(y));
        if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
        return d * (typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x - y);
      });
    }
    const lim = LIMIT[key];
    const total = out.length;
    if (lim && !s.all && !s.q && total > lim) out = out.slice(0, lim);
    if (out.length > MAXROWS) out = out.slice(0, MAXROWS);   // never draw more rows than this; the line above the table says so
    if (s.total !== total || s.shown !== out.length) { s.total = total; s.shown = out.length; TV[key] = s; setTimeout(() => dash.draw("tv_" + key), 0); }
    return out;
  }
  const tbodyDraw = (key) => { const t = document.querySelector('table[data-tv="' + key + '"] tbody[data-draw]'); return t ? t.dataset.draw : null; };
  function redrawTable(key) { const n = tbodyDraw(key); if (n) dash.draw(n); dash.draw("tv_" + key); if (key === "scan") dash.draw("scanner_note"); }
  document.querySelectorAll("table[data-tv] thead th").forEach((th) => th.addEventListener("click", () => {
    const key = th.closest("table").dataset.tv, idx = Array.prototype.indexOf.call(th.parentNode.children, th);
    const s = TV[key] || (TV[key] = {});
    if (s.col === idx) s.dir = -s.dir; else { s.col = idx; s.dir = idx === 0 ? 1 : -1; }
    redrawTable(key);
  }));
  document.querySelectorAll("input.tfilter").forEach((inp) => inp.addEventListener("input", () => {
    const key = inp.dataset.tv; (TV[key] || (TV[key] = {})).q = inp.value.trim().toLowerCase(); redrawTable(key);
  }));
  TVKEYS.forEach((k) => dash.draw("tv_" + k, (el) => {
    const s = TV[k] || {};
    const th = s.col == null ? null : document.querySelector('table[data-tv="' + k + '"] thead th:nth-child(' + (s.col + 1) + ')');
    const txt = th ? "Sorted by " + th.textContent + (s.dir > 0 ? ", low to high" : ", high to low") + ". " : "";
    const kids = [document.createTextNode(txt)];
    if (th) { const g = el$("button", "btn sm", "Default order"); g.type = "button"; g.onclick = () => { s.col = null; TV[k] = s; redrawTable(k); }; kids.push(g, document.createTextNode(" ")); }
    if (LIMIT[k] && s.total > LIMIT[k]) {
      const capped = s.shown < s.total && (s.all || s.q);
      kids.push(document.createTextNode(" Showing " + U.num(s.shown) + " of " + U.num(s.total) + (capped ? " (at most " + MAXROWS + " rows are drawn: search or filter to narrow it down)" : s.q && !s.all ? " (all matches while filtering)" : "") + ". "));
      const b = el$("button", "btn sm", s.all ? "Show top " + LIMIT[k] : s.total > MAXROWS ? "Show first " + MAXROWS : "Show all " + U.num(s.total)); b.type = "button";
      b.onclick = () => { s.all = !s.all; TV[k] = s; redrawTable(k); };
      kids.push(b);
    }
    el.replaceChildren(...kids);
  }));

  // ---------- headline figures ----------
  function stat(name, src, field, fmt) {
    dash.draw(name, (el) => {
      const d = D(src);
      if (d.status === "ok" && d.data && d.data[0]) {
        const out = fmt((name.indexOf("s_") === 0 ? rowsS(src)[0] : d.data[0])[field]);
        el.replaceChildren(out instanceof Node ? out : document.createTextNode(out));
        el.classList.remove("dash-skeleton");
      } else if (d.status === "loading") { el.textContent = "—"; el.classList.add("dash-skeleton"); }
      else { el.textContent = d.status === "error" ? "Failed to load" : "—"; el.classList.remove("dash-skeleton"); }
    });
  }
  const pctNode = (v) => tn(U.pct(v, true), v == null ? "" : U.tone(v));
  stat("s_value", "portfolio", "value", (v) => U.coin(v, { trim: true }));
  // "Profit" is only what sales have made; what you would make selling everything today is shown under it
  stat("s_profit", "portfolio", "realized", (v) => U.coin(v, { signed: true, tone: true, trim: true }));
  stat("s_iftoday", "portfolio", "profit_today", (v) => U.coin(v, { signed: true, tone: true, trim: true }));
  stat("t_worth", "portfolio", "value", (v) => U.coin(v, { trim: true }));
  stat("t_profit", "portfolio", "realized", (v) => U.coin(v, { signed: true, tone: true, trim: true }));
  stat("t_iftoday", "portfolio", "profit_today", (v) => U.coin(v, { signed: true, tone: true, trim: true }));
  dash.draw("status_strip", (el) => {
    const r = D("runs_summary"), s = D("snaps");
    if (r.status === "loading" || s.status === "loading") { el.replaceChildren(); return; }
    const pill = (txt, tone, tip) => { const p = el$("span", "pill", txt); if (tone) p.dataset.tone = tone; if (tip) p.title = tip; return p; };
    const kids = [];
    const last = r.status === "ok" && r.data[0] ? r.data[0].last_data || r.data[0].last_run : null;
    kids.push(pill(last ? "Prices from " + U.when(last) + " (" + U.ago(last) + ")" : "No run yet", last && Date.now() - last > 6 * 3600e3 ? "down" : "up", "When Blizzard's prices last changed"));
    const SC = D("scan_saved"), sc = SC.status === "ok" && SC.data[0] ? SC.data[0] : null;
    if (sc) kids.push(pill((sc.t > (last || 0) ? "Using your AH scan from " : "Your AH scan (older, not used) from ") + U.when(sc.t) + " (" + U.ago(sc.t) + ")", sc.t > (last || 0) ? "up" : "",
      "Prices from the Scan AH button in the addon. The newer of your scan and Blizzard's prices is used for every Lowest now; history, averages and sales estimates always come from Blizzard's snapshots."));
    const m = readyList(), n = m.filter((x) => x[1]).length;
    const p2 = pill(n === m.length ? "✓ All data parts ready" : "Data building: " + n + " of " + m.length + " ready", n === m.length ? "up" : "", m.map(([t, ok]) => (ok ? "✓ " : "… ") + t).join("\n") + "\nPress for details (Info, Runs & snapshots).");
    p2.style.cursor = "pointer"; p2.addEventListener("click", () => { openTab("info"); openSub("runs"); const h = document.getElementById("h-ready"); if (h && h.scrollIntoView) h.scrollIntoView({ block: "start" }); });
    kids.push(p2);
    el.replaceChildren(...kids);
  });
  // the parts of the page that need data collected over time: [name, ready, what it needs]
  function readyList() {
    const si = snapInfo(), hrs = si.n > 1 ? (si.last - si.first) / 3600e3 : 0;
    const L = D("ladder"), hasLadder = L.status === "ok" && L.data.length > 0;
    // the same test the 24 h and "vs normal" columns use, so a tick here means those columns have numbers
    const T = D("trends"), tr = T.status === "ok" ? T.data : null;
    const has24 = tr ? tr.some((t) => t.chg24 != null) : hrs >= 24, hasAvg = tr ? tr.some((t) => t.dev7 != null) : si.n >= 4 && hrs >= 12;
    return [["24 h trends", has24, "Needs a snapshot from 18 to 30 hours back"],
      ["Averages (normal price): " + (hrs >= 167 ? "full 7 days" : hrs >= 48 ? Math.round(hrs / 24) + " days so far" : Math.round(hrs) + " h so far"), hasAvg, "Needs 4 snapshots spanning 12 hours; it becomes a full 7-day average after a week"],
      ["Sales estimates", si.n >= 2, "Needs two snapshots"], ["Time of day", si.n >= 48, "Needs about 48 snapshots (" + si.n + " so far)"], ["Price ladders", hasLadder, "Needs a collector run with the ladder step"]];
  }
  dash.draw("ready_list", (el) => {
    if (!ready(el, ["snaps", "ladder"])) return;
    const si = snapInfo();
    const items = readyList().map(([t, ok, need]) => { const li = el$("li", "", (ok ? "✓ " : "… ") + t + (ok ? "" : ": " + need.charAt(0).toLowerCase() + need.slice(1))); if (ok) li.dataset.tone = "up"; return li; });
    items.unshift(el$("li", "", si.n + " distinct price snapshot" + (si.n === 1 ? "" : "s") + " stored"));
    el.replaceChildren(...items);
  });
  dash.draw("unnamed_rows", (tb) => {
    if (!ready(tb, ["unnamed"])) return;
    const rows = rowsOf("unnamed").slice(0, 100);
    tb.replaceChildren(...rows.map((r) => tr(String(r.id), [String(r.id), r.min ? U.coin(r.min) : "—", U.num(r.n), U.num(r.qty)])));
    if (rows.length) tb.append(totRow(["Total (" + rowsOf("unnamed").length + " items)", "", U.num(sumOf(rowsOf("unnamed"), (r) => r.n)), U.num(sumOf(rowsOf("unnamed"), (r) => r.qty))]));
  });
  dash.draw("unnamed_note", (el) => {
    if (!ready(el, ["unnamed"])) return;
    const n = rowsOf("unnamed").length;
    el.textContent = n ? n + " items without a name yet." : "";
  });
  stat("i_lastrun", "runs_summary", "last_run", (v) => U.when(v));
  stat("i_lastdata", "runs_summary", "last_data", (v) => U.when(v));
  stat("i_runs", "runs_summary", "runs", (v) => String(v));
  stat("i_snaps", "runs_summary", "snapshots", (v) => String(v));
  stat("i_failed", "runs_summary", "failed", (v) => String(v));
  dash.draw("i_ago", (el) => { const d = D("runs_summary"); el.textContent = d.status === "ok" && d.data[0] ? "(" + U.ago(d.data[0].last_run) + ")" : ""; });
  setInterval(() => dash.draw("i_ago"), 60000);

  // ---------- totals rows ----------
  const sumOf = (rows, f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
  const totRow = (cells) => { const r = el$("tr", "totrow"); cells.forEach((c) => { const td = el$("td"); if (c instanceof Node) td.append(c); else td.textContent = c == null ? "" : c; r.append(td); }); return r; };
  const gold = (v) => U.coin(v, { trim: true }), goldS = (v) => U.coin(v, { signed: true, tone: true, trim: true });
  // ---------- portfolio tiles: Net Worth and Profit choose which columns the positions table under them shows ----------
  WOW.tile = "worth";
  const setView = () => {
    document.querySelectorAll('table[data-tv="pos"]').forEach((t) => { t.classList.toggle("view-worth", WOW.tile !== "after"); t.classList.toggle("view-profit", WOW.tile === "after"); });
    document.querySelectorAll("[data-tile]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.tile === WOW.tile)));
  };
  document.querySelectorAll("[data-tile]").forEach((b) => b.addEventListener("click", () => {
    WOW.tile = b.dataset.tile; setView();
    ["ledger_rows", "pos_title", "pos_note"].forEach((n) => dash.draw(n));
  }));
  setView();
  document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => { const [t, s] = b.dataset.goto.split(":"); openTab(t); if (s) openSub(s); }));
  document.querySelectorAll("[data-pfscope]").forEach((b) => b.addEventListener("click", () => {
    WOW.pfScope = b.dataset.pfscope;
    document.querySelectorAll("[data-pfscope]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    ["s_value", "s_profit", "s_iftoday", "pos_note", "ledger_rows", "sales_rows", "ch_pie", "ch_pl", "ch_pfseries", "pfchips", "pos_chips"].forEach((n) => dash.draw(n));
  }));
  const share = (v, tot) => (tot > 0 ? U.pct(v / tot) : "—");
  dash.draw("pos_title", (el) => { el.textContent = WOW.tile === "after" ? "Profit" : "Net Worth"; });
  dash.draw("pos_note", (el) => {
    if (!ready(el, ["portfolio"])) return;
    const P = rowsS("portfolio")[0];
    if (!P) { el.replaceChildren(); return; }
    if (WOW.tile === "after") el.replaceChildren(document.createTextNode("Profit is what your sales have made: what you received minus the avg cost per unit (collected = free) of the units sold. It stays empty until you sell. Profit if sold today is what you would make if you also sold everything you still hold at today's lowest price, after the 5% auction cut, minus what it cost you. Vendor value (total) is what an NPC vendor would pay for the units you hold: your safety net."));
    else el.replaceChildren(document.createTextNode("What you hold, at each item's lowest buyout, before the 5% auction cut. After the cut: "), U.coin(Math.round(P.after_cut + P.invested), { trim: false }), document.createTextNode("."));
  });

  // ---------- portfolio ----------
  // positions table, 23 columns: 1 Item, 2 Qty held, 3 Lowest now, 4 Median now, 5 Your avg buy price, 6 Paid total, 7 Worth, 8 Share, 9 After 5% cut, 10 Vendor value each,
  // 11 Vendor value total, 12 Profit, 13 Profit if sold today, 14 Profit %, 15 vs normal, 16 24 h, 17 Hold or sell?, 18 Collected, 19 List at, 20 After cut each, 21 Realistic total, 22 Days to sell, 23 Sale note
  GSUM.pos = (rows) => {
    const tot = (rowsS("portfolio")[0] || {}).value || 0, pt = sumOf(rows, (r) => r.pt), cost = sumOf(rows, (r) => r.paid || 0);
    return ["Total", U.num(sumOf(rows, (r) => r.qty)), "", "", "", gold(cost), gold(sumOf(rows, (r) => r.value)), share(sumOf(rows, (r) => r.value), tot), gold(sumOf(rows, (r) => r.afterT)),
      "", gold(sumOf(rows, (r) => r.vendor_value)), goldS(sumOf(rows, (r) => r.realized)), goldS(pt), cost > 0 ? pctNode(pt / cost) : "—", "", "", "",
      U.num(sumOf(rows, (r) => r.collected)), "", "", gold(sumOf(rows, (r) => r.real_total)), "", ""];
  };
  GSUM.sales = (rows) => ["Total", U.num(sumOf(rows, (r) => r.sold)), "", gold(sumOf(rows, (r) => r.revenue)), goldS(sumOf(rows, (r) => r.realized)), U.num(sumOf(rows, (r) => r.qty))];
  dash.draw("ledger_rows", (tb) => {
    if (!ready(tb, ["ledger_pl", "advice", "latest", "trends", "portfolio"])) return;
    const Lm = new Map(rowsOf("latest").map((r) => [r.id, r])), Tm = new Map(rowsOf("trends").map((r) => [r.id, r])), Am = new Map(rowsOf("advice").map((r) => [r.id, r]));
    const tot = (rowsS("portfolio")[0] || {}).value || 0;
    const base = rowsS("ledger_pl").filter((r) => r.qty > 0 || r.sold > 0).map((r) => {   // everything held or sold, with worth, profit, the hold-or-sell read and the realistic sale value
      const L = Lm.get(r.id), T = Tm.get(r.id) || {}, A = Am.get(r.id), vend = r.vendor || 0, held = r.qty > 0 && r.value != null;
      const listAt = L ? Math.max(1, L.min - 1) : null, net = listAt ? Math.round(listAt * 0.95) : 0, useV = vend > net, each = useV ? vend : net;
      const days = T.sold_day > 0 && r.qty > 0 ? r.qty / T.sold_day : null;
      const note = !(r.qty > 0) ? "All sold" : !L ? (vend ? "No listings. Vendor pays " + U.coinText(vend) + " each" : "No listings") : useV ? "A vendor pays more" : days == null ? "Sales speed unknown yet" : days > 7 ? "Slow: more than a week of market sales" : days > 2 ? "Sells over several days" : "Should sell quickly";
      const afterT = held ? Math.round(r.value * 0.95) : null, pt = (r.realized || 0) + (held ? afterT : 0);   // Profit (sales minus everything paid) plus what you hold, sold today
      return Object.assign({}, r, { value: held ? r.value : null, share: held && tot ? r.value / tot : null, afterT: afterT, pt: pt, pt_pct: r.paid > 0 ? pt / r.paid : null,
        dev7: A ? A.dev7 : null, chg24: A ? A.chg24 : null, advice: A ? A.advice : "", short: A ? A.short || A.advice : "", tone: A ? A.tone : "", list_at: r.qty > 0 ? listAt : null, each: r.qty > 0 ? each || null : null, real_total: each && r.qty > 0 ? each * r.qty : 0, days: days, note: note });
    });
    // without a column sort, the biggest come first (by worth, or by profit if sold today in the Profit view); the category groups follow that order
    const key = WOW.tile === "after" ? (r) => r.pt : (r) => (r.value == null ? -1 : r.value);
    base.sort((a, b) => key(b) - key(a));
    const rows = tv("pos", base, [(r) => r.item, (r) => r.qty, (r) => r.price, (r) => r.med, (r) => r.avg, (r) => r.paid, (r) => r.value, (r) => r.share, (r) => r.afterT, (r) => r.vendor, (r) => r.vendor_value,
      (r) => (r.sold > 0 || r.paid > 0 ? r.realized : null), (r) => r.pt, (r) => r.pt_pct, (r) => r.dev7, (r) => r.chg24, (r) => r.advice, (r) => r.collected, (r) => r.list_at, (r) => r.each, (r) => r.real_total, (r) => r.days, (r) => r.note], (r) => r.item);
    const cn = (v, o) => (v == null ? "—" : U.coin(v, o));
    tb.replaceChildren(...rows.map((r) => reg(r, tr(r.item, [nameCell(r.item, r.id), U.num(r.qty), r.price == null ? "no listings" : U.coin(r.price), cn(r.med), cn(r.avg), U.coin(r.paid || 0),
      cn(r.value), r.share == null ? "—" : U.pct(r.share), cn(r.afterT), cn(r.vendor), cn(r.vendor_value), r.sold > 0 || r.paid > 0 ? U.coin(r.realized, { signed: true, tone: true }) : "—", U.coin(r.pt, { signed: true, tone: true }), r.pt_pct == null ? "—" : pctNode(r.pt_pct),
      r.dev7 == null ? "—" : pctNode(r.dev7), r.chg24 == null ? "—" : pctNode(r.chg24), r.advice && r.qty > 0 ? (() => { const s = tn(r.short, r.tone === "flat" ? "" : r.tone); s.title = r.advice; s.className = "why"; return s; })() : "—",
      r.collected ? U.num(r.collected) : "—", cn(r.list_at), cn(r.each), r.each ? U.coin(r.real_total) : "—", r.days == null ? "—" : U.num(r.days, 1), r.note], r.id))));
    if (rows.length) tb.append(totRow(GSUM.pos(rows)));
  });
  dash.draw("ledger_note", (el) => {
    const d = D("ledger_pl");
    el.textContent = d.status === "error" ? "The ledger failed to load." : d.status === "ok" && !d.data.length ? (window.GAMEFILE && !GAMEFILE.loaded() ? "Connect your game file at the top of the page to see what you hold." : "No purchases recorded yet. They arrive from the game by themselves.") : d.status === "ok" && !d.data.some((r) => r.qty > 0) ? "Nothing held right now. Sold items are listed under Sales." : "";
  });
  dash.draw("sales_rows", (tb) => {
    if (!ready(tb, ["ledger_pl"])) return;
    const rows = tv("sales", rowsS("ledger_pl").filter((r) => r.sold > 0), [(r) => r.item, (r) => r.sold, (r) => r.avg_sale, (r) => r.revenue, (r) => r.realized, (r) => r.qty], (r) => r.item);
    tb.replaceChildren(...rows.map((r) => reg(r, tr(r.item, [nameCell(r.item, r.id), U.num(r.sold), U.coin(r.avg_sale), U.coin(r.revenue), U.coin(r.realized, { signed: true, tone: true }), U.num(r.qty)], r.id))));
    if (rows.length) tb.append(totRow(GSUM.sales(rows)));
  });
  dash.draw("sales_note", (el) => {
    const d = D("ledger_pl");
    el.textContent = d.status === "ok" && !d.data.some((r) => r.sold > 0) ? "No sales yet." : "";
  });
  WOW.pieMode = "money";
  document.querySelectorAll("[data-piemode]").forEach((b) => b.addEventListener("click", () => {
    WOW.pieMode = b.dataset.piemode;
    document.querySelectorAll("[data-piemode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    dash.draw("ch_pie");
  }));
  dash.draw("ch_pie", (el) => {
    if (!ready(el, ["ledger_pl"])) return;
    const bycat = WOW.pieMode === "cat", units = WOW.pieMode === "units", key = units ? "qty" : "cost";
    let rows = rowsS("ledger_pl").filter((r) => (units ? r.qty > 0 : r.cost > 0));
    if (bycat) {   // one slice per class (or per type when a class is picked) instead of one per item
      const g = new Map();
      for (const r of rows) { const c = catMap().get(r.id), n = c ? (WOW.cat.cls && WOW.cat.cls !== "__none" ? c.sub || "Other" : c.cls) : NOCAT; const o = g.get(n) || { item: n, cost: 0, id: null }; o.cost += r.cost; g.set(n, o); }
      rows = [...g.values()];
    }
    rows.sort((a, b) => b[key] - a[key]);
    const top = rows.slice(0, 7), rest = rows.slice(7);
    const say = (v) => { const d = el$("div", "", units ? "Held: " + U.num(v) + " units" : "Invested: "); if (!units) d.append(U.coin(v, { trim: false })); return d; };
    const slices = top.map((r) => ({ id: r.id, label: r.item, v: r[key], tip: [el$("div", "", r.item), say(r[key])] }));
    // everything after the seven largest is added up into one grey slice; its tooltip says what is in it
    if (rest.length) { const v = rest.reduce((s, r) => s + r[key], 0), what = bycat ? "categories" : "items";
      slices.push({ label: "Other " + what + " (" + rest.length + ")", v: v, color: "#566074",
        tip: [el$("div", "", rest.length + " smaller " + what + " added up"), say(v), el$("div", "sm", rest.slice(0, 6).map((r) => r.item).join(", ") + (rest.length > 6 ? ", …" : ""))] }); }
    U.pie(el, slices, { onPick: (r) => { if (r.id != null) select(r.id, true); }, fmt: units ? U.num : U.short, aria: units ? "Share of the units you hold per item" : "Share of the money invested per item", empty: units ? "You hold nothing right now." : "Nothing bought yet. Items you collected cost nothing and are not shown here." });
  });
  // ---------- charts that start grouped by category and drill down: class, then type, then items ----------
  WOW.drill = {};
  function drillChart(el, name, rows, sp) {
    const st = WOW.drill[name] || (WOW.drill[name] = { cls: "", sub: "" });
    const info = (r) => { const c = catMap().get(r.id); return { cls: c ? c.cls : NOCAT, sub: c ? c.sub || "Other" : "" }; };
    const go = (cls, sub) => { WOW.drill[name] = { cls: cls, sub: sub }; dash.draw(name); };
    const crumb = el$("div", "drillbar"), mk = (t, fn, on) => { const b = el$("button", "chip" + (on ? " on" : ""), t); b.type = "button"; b.onclick = fn; return b; };
    crumb.append(mk("All categories", () => go("", ""), !st.cls));
    if (st.cls) crumb.append(mk(st.cls, () => go(st.cls, ""), !st.sub));
    if (st.sub) crumb.append(mk(st.sub, () => {}, true));
    const box = el$("div", "drillbox");
    if (sp.flat) el.replaceChildren(box); else el.replaceChildren(crumb, box);   // flat charts show the items straight away (the category bar still filters them)
    let level = sp.flat ? "item" : !st.cls ? "cls" : (!st.sub && st.cls !== NOCAT ? "sub" : "item");
    let pool = rows;
    if (st.cls) pool = pool.filter((r) => info(r).cls === st.cls);
    if (st.sub) pool = pool.filter((r) => info(r).sub === st.sub);
    if (level === "sub" && new Set(pool.map((r) => info(r).sub)).size < 2) level = "item";   // only one type: show its items straight away
    if (level === "item") {
      let list = pool.slice().sort((a, b) => sp.val(b) - sp.val(a));
      const c = sp.cap;
      if (c && list.length > c.top + c.bottom) list = c.bottom ? list.slice(0, c.top).concat(list.slice(-c.bottom)) : list.slice(0, c.top);
      U.hbar(box, list.map((r) => ({ id: r.id, label: sp.label(r), v: sp.val(r), color: sp.color ? sp.color(sp.val(r)) : undefined, tip: sp.tip(r) })),
        { onPick: (r) => select(r.id, true), fmt: sp.fmt, signed: sp.signed, aria: sp.aria, empty: sp.empty });
      return;
    }
    const g = new Map();
    for (const r of pool) { const i = info(r), k = level === "cls" ? i.cls : i.sub || "Other"; const o = g.get(k) || { n: 0, v: 0 }; o.n++; o.v += sp.val(r); g.set(k, o); }
    const bars = [...g].map(([k, o]) => { const v = sp.agg === "avg" ? o.v / o.n : o.v; return { id: null, group: true, key: k, label: k + " (" + o.n + ")", v: v, color: sp.color ? sp.color(v) : undefined,
      tip: [el$("div", "", k), el$("div", "", o.n + (o.n === 1 ? " item" : " items") + ", " + (sp.agg === "avg" ? "average " : "total ") + sp.fmt(v)), el$("div", "sm", "Press to open")] }; })
      .sort((a, b) => b.v - a.v);
    U.hbar(box, bars, { onPick: (b) => go(level === "cls" ? b.key : st.cls, level === "cls" ? "" : b.key), fmt: sp.fmt, signed: sp.signed, aria: sp.aria + ", grouped by category. Press a bar to open it", empty: sp.empty });
  }
  dash.draw("ch_pl", (el) => {
    if (!ready(el, ["ledger_pl"])) return;
    const pt = (r) => (r.realized || 0) + (r.qty > 0 && r.after != null ? r.after : 0), pp = (r) => (r.paid > 0 ? pt(r) / r.paid : null);
    drillChart(el, "ch_pl", rowsS("ledger_pl").filter((r) => (r.qty > 0 && r.after != null) || r.paid > 0 || r.sold > 0), { val: pt, label: (r) => r.item, agg: "sum", cap: { top: 10, bottom: 10 }, fmt: signedShort, signed: true,
      tip: (r) => [el$("div", "", r.item), (() => { const d = el$("div", "", "Profit if sold today, after the 5% cut: "); d.append(U.coin(pt(r), { signed: true, tone: true, trim: true }), " ", pctNode(pp(r))); return d; })()],
      aria: "Profit or loss per item if sold today, after the 5% cut", empty: "No positions with a current price." });
  });
  WOW.pf = new Set(["total"]);
  WOW.pfOpen = false; WOW.pfFind = ""; WOW.pfRange = "all";
  const pfLabel = (items) => {
    const keys = [...WOW.pf], t = WOW.pf.has("total"), cats = keys.filter((k) => k[0] === "c" && k[1] === ":" || k[0] === "s" && k[1] === ":"), its = keys.filter((k) => k[0] === "i");
    const parts = [];
    if (t) parts.push("Total");
    if (cats.length === 1) parts.push(cats[0].slice(2).replace("|", " › ")); else if (cats.length) parts.push(cats.length + " categories");
    if (its.length === 1) { const f = items.find(([id]) => "i" + id === its[0]); parts.push(f ? f[1] : "1 item"); } else if (its.length) parts.push(its.length + " items");
    return parts.join(" + ") || "Nothing selected";
  };
  document.addEventListener("click", (e) => { if (WOW.pfOpen && !e.target.closest(".pfdd")) { WOW.pfOpen = false; const pn = document.querySelector(".pfdd .pfpanel"); if (pn) pn.hidden = true; const tg = document.querySelector(".pfdd .pftoggle"); if (tg) tg.setAttribute("aria-expanded", "false"); } });
  dash.draw("pfchips", (el) => {
    if (D("pf_items").status !== "ok" || D("ledger_pl").status !== "ok") return;
    const seen = new Map(), clsN = new Map(), subN = new Map();
    for (const r of rowsS("pf_items")) {
      if (seen.has(r.id)) continue;
      seen.set(r.id, r.item);
      const c = catMap().get(r.id), cls = c ? c.cls : NOCAT, sub = c ? c.sub || "Other" : "";
      clsN.set(cls, (clsN.get(cls) || 0) + 1);
      if (sub) subN.set(cls + "|" + sub, (subN.get(cls + "|" + sub) || 0) + 1);
    }
    const held = new Map(rowsS("ledger_pl").map((r) => [r.id, r.qty]));
    const items = [...seen].sort((x, y) => x[1].localeCompare(y[1]));
    const wrap = el$("div", "pfdd"), tg = el$("button", "btn pftoggle"); tg.type = "button"; tg.setAttribute("aria-expanded", String(WOW.pfOpen));
    const setTg = () => { tg.replaceChildren(el$("span", "lbl", "Show "), document.createTextNode(pfLabel(items) + " ▾")); };
    setTg();
    const panel = el$("div", "pfpanel"); panel.hidden = !WOW.pfOpen;
    const find = el$("input", "pffind"); find.type = "search"; find.placeholder = "Find an item or category"; find.value = WOW.pfFind; find.setAttribute("aria-label", "Find an item or category in this list"); find.autocomplete = "off";
    const bar = el$("div", "pfbar"), allB = el$("button", "btn sm", "Select all items"), noneB = el$("button", "btn sm", "Clear"); allB.type = noneB.type = "button"; bar.append(allB, noneB);
    const list = el$("div", "pflist");
    const rowEl = (key, label, icon, count, sub) => { const lb = el$("label", "pfrow" + (sub ? " pfsub" : "")), cb = el$("input"); cb.type = "checkbox"; cb.checked = WOW.pf.has(key); cb.dataset.k = key;
      lb.append(cb); if (icon) lb.append(icon); lb.append(el$("span", "pfname", label)); if (count != null) lb.append(el$("span", "pfcount", "(" + U.num(count) + ")")); lb.dataset.name = label.toLowerCase(); return lb; };
    const hdr = (t) => { const d = el$("div", "pfhead", t); d.dataset.name = "total"; return d; };
    list.append(rowEl("total", "Total", null, null));
    if (clsN.size && catMap().size) {
      list.append(hdr("Categories"));
      [...clsN].sort((a, b) => (a[0] === NOCAT) - (b[0] === NOCAT) || a[0].localeCompare(b[0])).forEach(([cls, n]) => {
        list.append(rowEl("c:" + cls, cls, null, n));
        [...subN].filter(([k]) => k.startsWith(cls + "|")).sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, m]) => list.append(rowEl("s:" + k, k.split("|")[1], null, m, true)));
      });
    }
    list.append(hdr("Items"));
    list.append(...items.map(([id, n]) => rowEl("i" + id, n, iconImg(id), held.get(id) || 0)));
    const applyFind = () => { const q = find.value.trim().toLowerCase(); list.querySelectorAll(".pfrow").forEach((r) => { r.hidden = !!q && r.dataset.name.indexOf(q) < 0 && r.dataset.name !== "total"; }); };
    const refresh = () => { list.querySelectorAll("input[data-k]").forEach((c) => { c.checked = WOW.pf.has(c.dataset.k); }); setTg(); dash.draw("ch_pfseries"); };
    find.addEventListener("input", () => { WOW.pfFind = find.value; applyFind(); });
    list.addEventListener("change", (e) => { const c = e.target.closest("input[data-k]"); if (!c) return; if (c.checked) WOW.pf.add(c.dataset.k); else WOW.pf.delete(c.dataset.k); refresh(); });
    allB.onclick = () => { items.forEach(([id]) => WOW.pf.add("i" + id)); WOW.pf.add("total"); refresh(); };
    noneB.onclick = () => { WOW.pf.clear(); refresh(); };
    tg.onclick = () => { WOW.pfOpen = !WOW.pfOpen; panel.hidden = !WOW.pfOpen; tg.setAttribute("aria-expanded", String(WOW.pfOpen)); if (WOW.pfOpen) find.focus(); };
    panel.append(find, bar, list); wrap.append(tg, panel); el.replaceChildren(wrap); applyFind();
  });
  WOW.pfMode = "worth";   // worth only; price per unit against your avg buy price is the Explorer's price chart
  // one time range for every time chart: 24 h, week or all time (from the first snapshot or first purchase, whichever is older), always ending now
  const TIME_CHARTS = ["ch_pfseries", "chart", "chart_supply", "chart_sold", "chart_gap", "ch_profit", "ch_runs"];
  U.setTimeDomain(() => {
    const t1 = Date.now(), H = 3600e3;
    if (WOW.pfRange === "24h") return [t1 - 24 * H, t1];
    if (WOW.pfRange === "week") return [t1 - 7 * 24 * H, t1];
    const sn = rowsOf("snaps"), L = rowsOf("ledger_all");
    let t0 = sn.length ? sn[0].t : t1 - 24 * H;
    if (L.length && L[0].date) t0 = Math.min(t0, new Date(L[0].date + "T00:00:00").getTime());
    return [t0, t1];
  });
  document.querySelectorAll("[data-pfrange]").forEach((b) => b.addEventListener("click", () => {
    WOW.pfRange = b.dataset.pfrange;
    document.querySelectorAll("[data-pfrange]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    TIME_CHARTS.forEach((n) => dash.draw(n));
  }));
  // one point per hour (last 24 h), per day (last week) or per day / month / year (all time): the last snapshot of each period
  function pfBuckets(times) {
    const tN = times[times.length - 1], H = 3600e3, D1 = 24 * H;
    let from = -Infinity, unit = "day";
    if (WOW.pfRange === "24h") { from = tN - D1; unit = "hour"; }
    else if (WOW.pfRange === "week") { from = tN - 7 * D1; unit = "day"; }
    else { const span = tN - times[0]; unit = span <= 120 * D1 ? "day" : span <= 3 * 365 * D1 ? "month" : "year"; }
    const key = (t) => { const d = new Date(t), y = d.getFullYear(), m = d.getMonth(), dd = d.getDate();
      return unit === "hour" ? y + "-" + m + "-" + dd + "-" + d.getHours() : unit === "day" ? y + "-" + m + "-" + dd : unit === "month" ? y + "-" + m : String(y); };
    const last = new Map();
    for (const t of times) if (t >= from) last.set(key(t), t);   // times are ascending, so the last one wins
    return { keep: new Set(last.values()), unit: unit };
  }
  dash.draw("ch_pfseries", (el) => {
    if (!ready(el, ["pf_items", "ledger_pl"])) return;
    const all = rowsS("pf_items"), PL = rowsS("ledger_pl"), unit = WOW.pfMode === "unit";
    const allTimes = [...new Set(all.map((r) => r.t))].sort((x, y) => x - y);
    if (allTimes.length < 2) return U.empty(el, "Needs at least two snapshots. The value of what you hold, or held, will be drawn here as the data grows.");
    if (!WOW.pf.size) return U.empty(el, "Pick Total, a category or one or more items in the list above.");
    const bk = pfBuckets(allTimes), rows = all.filter((r) => bk.keep.has(r.t));
    const times = allTimes.filter((t) => bk.keep.has(t));
    if (times.length < 2) return U.empty(el, "Not enough snapshots in this period yet. Try a longer period.");
    // sums per series key and time
    const acc = new Map();   // key -> Map(t -> {v, q, n})
    const add = (k, r) => { let m = acc.get(k); if (!m) acc.set(k, m = new Map()); let o = m.get(r.t); if (!o) m.set(r.t, o = { v: 0, q: 0, n: 0, pq: 0 }); if (r.value != null) { o.v += r.value; o.n++; o.pq += r.qty; } o.q += r.qty; };
    const wantTotal = WOW.pf.has("total"), wantCls = new Set(), wantSub = new Set(), wantItem = new Set();
    for (const k of WOW.pf) { if (k.startsWith("c:")) wantCls.add(k.slice(2)); else if (k.startsWith("s:")) wantSub.add(k.slice(2)); else if (k[0] === "i") wantItem.add(+k.slice(1)); }
    const names = new Map();
    for (const r of rows) {
      names.set(r.id, r.item);
      const c = catMap().get(r.id), cls = c ? c.cls : NOCAT, sub = c ? c.sub || "Other" : "";
      if (wantTotal) add("total", r);
      if (wantCls.has(cls)) add("c:" + cls, r);
      if (sub && wantSub.has(cls + "|" + sub)) add("s:" + cls + "|" + sub, r);
      if (wantItem.has(r.id)) add("i" + r.id, r);
    }
    const toPts = (k) => { const m = acc.get(k); if (!m) return []; const pts = []; for (const t of times) { const o = m.get(t); if (o && o.n) pts.push({ t: t, v: unit ? o.v / Math.max(1, o.q) : o.v, q: o.q, pq: o.pq, one: k[0] === "i" }); } return pts; };
    // hover: how many units the point covers and the price per unit (each for one item; the average per unit for Total and categories)
    const tipextra = (p) => { if (!(p.q > 0)) return null; const out = ["  · " + U.num(p.q) + (p.q === 1 ? " unit" : " units")]; if (p.pq > 0) out.push(" at ", U.coin(Math.round(p.v / p.pq), { trim: false }), p.one ? " each" : " avg per unit"); return out; };
    // per unit this is the avg buy price: what you paid divided by the bought units you still hold (collected units left out)
    const paidFor = (test) => { const h = PL.filter((r) => r.qty > 0 && test(r)), cost = h.reduce((s, r) => s + r.cost, 0), q = h.reduce((s, r) => s + (r.held_b || 0), 0); return cost > 0 ? (unit ? (q > 0 ? cost / q : null) : cost) : null; };
    const clsOf = (r) => { const c = catMap().get(r.id); return c ? c.cls : NOCAT; }, subOf = (r) => { const c = catMap().get(r.id); return c ? c.cls + "|" + (c.sub || "Other") : ""; };
    const series = [], refs = [], avgOf = new Map();
    let ci = 0; const nextCol = () => U.pal[ci++ % U.pal.length];
    const push = (label, k, color, paid, paidLabel, id) => {
      const ser = { id: id, label: label, color: color, pts: toPts(k), paid: paid }; series.push(ser);
      if (paid != null) { refs.push({ label: paidLabel, v: paid, color: color }); avgOf.set(label, paid); }
    };
    if (wantTotal) { const pd = paidFor(() => true); push(unit ? "Total (average per unit)" : "Total", "total", nextCol(), pd, unit ? "Your avg buy price" : "What you still have invested"); }
    [...wantCls].sort().forEach((c) => { const pd = paidFor((r) => clsOf(r) === c); push(c, "c:" + c, nextCol(), pd, c + (unit ? ": your avg buy price" : ": what you have invested")); });
    [...wantSub].sort().forEach((sk) => { const pd = paidFor((r) => subOf(r) === sk); push(sk.replace("|", " › "), "s:" + sk, nextCol(), pd, sk.replace("|", " › ") + (unit ? ": your avg buy price" : ": what you have invested")); });
    [...wantItem].map((id) => [id, names.get(id) || "Item " + id]).sort((x, y) => x[1].localeCompare(y[1])).forEach(([id, nm]) => {
      const p = PL.find((r) => r.id === id);
      const pd = p && p.qty > 0 ? (unit ? p.avg : p.cost > 0 ? p.cost : null) : null;
      push(nm, "i" + id, nextCol(), pd, nm + (unit ? ": your avg buy price" : ": what you have invested"), id);
    });
    U.lineChart(el, series, refs, { yfmt: U.short, tipfmt: (v) => U.coin(v, { trim: false }), tipextra: tipextra, deltas: true, aria: unit ? "Market price per unit over time against what you paid" : "Value of your positions over time" });
    const chg = (a, b) => (b > 0 ? (a - b) / b : null);
    const tb = el$("table", "tbl sumtab"), hd = el$("tr");
    ["", unit ? "Market per unit now" : "Now", "vs last", "vs start"].concat(unit ? ["Your avg buy price", "Market vs yours"] : ["vs paid"]).forEach((t) => hd.append(el$("th", "", t)));
    const th = el$("thead"); th.append(hd); const bd = el$("tbody");
    series.forEach((s) => {
      if (!s.pts.length) return;
      const last = s.pts[s.pts.length - 1], prev = s.pts.length > 1 ? s.pts[s.pts.length - 2] : null, first = s.pts[0];
      const sw = el$("i", "sw"); sw.style.background = s.color;
      const name = el$("span"); name.append(sw);
      if (s.id != null) { const ic = iconImg(s.id); if (ic) name.append(ic, " "); name.dataset.tip = s.id; }
      name.append(document.createTextNode(s.label));
      const cell = (p) => { if (!p) return "—"; const v = chg(last.v, p.v); return v == null ? "—" : pctNode(v); };
      const cells = [name, U.coin(last.v), cell(prev), cell(first)];
      const m = avgOf.get(s.label);
      if (!unit) cells.push(m == null ? "—" : pctNode(chg(last.v, m)));
      else cells.push(m == null ? "—" : U.coin(m), m == null ? "—" : pctNode(chg(last.v, m)));
      bd.append(tr(null, cells));
    });
    tb.append(th, bd);
    const sc = el$("div", "scroll"); sc.append(tb);
    el.append(sc);
  });
  dash.draw("log_rows", (tb) => {
    if (!ready(tb, ["ledger_all"])) return;
    const rows = tv("log", rowsOf("ledger_all").slice().reverse(), [(r) => r.date, (r) => r.item, (r) => r.how, (r) => r.qty, (r) => r.unit, null], (r) => r.item);
    tb.replaceChildren(...rows.map((r) => tr(r.key, [r.date, nameCell(r.item, r.id), ({ collected: "Collected", sold: "Sold" })[r.how] || "Bought", String(r.qty), r.how === "collected" && !r.unit ? "—" : U.coin(r.unit), el$("span", "muted", r.src === "legacy" ? "typed in" : "")], r.id)));
  });
  dash.draw("itemlist", (dl) => {
    if (!ready(dl, ["names"])) return;
    // the list of ~7,000 names is only rebuilt when the names or the category filter changed, not on every data arrival
    const names = rowsOf("names"), key = names.length + "|" + WOW.cat.cls + "|" + WOW.cat.sub + "|" + (catMap().size);
    if (dl._key === key) return;
    dl._key = key;
    dl.replaceChildren(...names.filter((r) => catOk(r.id)).map((r) => { const o = el$("option"); o.value = r.name; return o; }));
  });

  // ---------- messages under the game-file sections ----------
  const drawOf = { gold: "gd_msg", hold: "hd_msg" };
  function say(k, ok, text) { WOW.msg[k] = { ok: ok, text: text }; dash.draw(drawOf[k]); }
  WOW.say = say;
  Object.keys(drawOf).forEach((k) => dash.draw(drawOf[k], (el) => { const m = WOW.msg[k]; el.textContent = m ? m.text : ""; el.dataset.tone = m ? (m.ok ? "up" : "down") : ""; }));
  function resolveItem(txt) {
    const t = txt.trim().toLowerCase();
    if (!t || D("names").status !== "ok") return null;
    const names = D("names").data;
    return names.find((r) => r.name.toLowerCase() === t) || ((p) => (p.length === 1 ? p[0] : null))(names.filter((r) => r.name.toLowerCase().includes(t)));
  }
  const val = (sel) => { const e = document.querySelector(sel); return e ? e.value : ""; };
  const coins = (g, s, c) => (+val(g) || 0) * 10000 + (+val(s) || 0) * 100 + (+val(c) || 0);

  const CLASS = { 1: "Warrior", 2: "Paladin", 3: "Hunter", 4: "Rogue", 5: "Priest", 6: "Death Knight", 7: "Shaman", 8: "Mage", 9: "Warlock", 10: "Monk", 11: "Druid", 12: "Demon Hunter", 13: "Evoker" };
  dash.draw("hold_note", (el) => {
    const bad = ["holdings_saved", "hold_totals", "ledger_pl", "holdings_view"].filter((k) => D(k).status !== "ok");
    if (bad.length) { el.textContent = D("holdings_saved").status === "loading" ? "" : "Waiting for: " + bad.map((k) => k + " (" + D(k).status + (D(k).error ? ": " + (D(k).error.message || D(k).error) : "") + ")").join(", "); return; }
    const all = rowsOf("holdings_view"), listed = all.filter((r) => r.price != null);
    const at = rowsOf("holdings_saved").reduce((m, c) => Math.max(m, c.at || 0), 0);
    const auto = rowsOf("ledger_pl").filter((r) => r.auto > 0);
    el.textContent = all.length ? "" : "Nothing read from the game yet. Connect your game file at the top of the page.";
  });
  dash.draw("hold_chars", (tb) => {
    if (!ready(tb, ["holdings_chars"])) return;
    const rows = rowsOf("holdings_chars");
    tb.replaceChildren(...rows.map((r) => tr(r.char, [r.char.replace(/-.*/, ""), CLASS[r.cls] || "—", U.coin(r.money, { trim: true }), U.num(r.units), U.coin(r.worth, { trim: true }), U.coin(r.money + r.worth, { trim: true })])));
    if (rows.length) tb.append(totRow(["Total", "", U.coin(sumOf(rows, (r) => r.money), { trim: true }), U.num(sumOf(rows, (r) => r.units)), U.coin(sumOf(rows, (r) => r.worth), { trim: true }), U.coin(sumOf(rows, (r) => r.money + r.worth), { trim: true })]));
  });


  // ---------- explorer ----------
  function selId() {
    if (WOW.id) return WOW.id;
    if (D("ledger_all").status !== "ok" || D("latest").status !== "ok") return null;
    const l = rowsOf("ledger_all");
    if (l.length) WOW.id = l[0].id;
    else { const h = rowsOf("latest"); if (h.length) WOW.id = h.reduce((m, r) => (r.n > m.n ? r : m)).id; }
    return WOW.id;
  }
  const waitSel = () => selId() == null;

  // ---------- picking an item (any row, any table) ----------
  // picking an item redraws only the Explorer; the highlighted row and chip in other tables are switched without rebuilding them
  const redrawItem = () => ["istats", "chart", "chart_gap", "chart_supply", "chart_sold", "ch_hour", "hour_note", "stack_panel", "calc_panel"].forEach((n) => dash.draw(n));
  function markSelected(id) {
    document.querySelectorAll("tr.sel").forEach((r) => r.classList.remove("sel"));
    document.querySelectorAll('tr[data-item="' + id + '"]').forEach((r) => r.classList.add("sel"));
    document.querySelectorAll("[data-draw=pos_chips] button[data-id]").forEach((b) => { if (+b.dataset.id === id) b.setAttribute("aria-pressed", "true"); else b.removeAttribute("aria-pressed"); });
  }
  function select(id, jump) {
    WOW.id = id; redrawItem(); markSelected(id);
    if (jump) { openTab("explorer"); const t = document.querySelector("#h-explorer"); if (t && t.scrollIntoView) t.scrollIntoView({ block: "start" }); }
  }
  const root = document.querySelector(".wow");
  if (root) {
    root.addEventListener("click", (e) => {
      if (e.target.closest("a, button, input, select, textarea")) return;
      const row = e.target.closest("tr[data-item]"); if (!row) return;
      select(+row.dataset.item, true);
    });
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const row = e.target.closest && e.target.closest("tr[data-item]"); if (row && e.target === row) select(+row.dataset.item, true);
    });
  }
  const pick = document.querySelector("#pick");
  function pickNow() { if (!pick) return; const it = resolveItem(pick.value); if (it) { select(it.id, false); pick.blur(); } }
  if (pick) { pick.addEventListener("change", pickNow); pick.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pickNow(); } }); }
  dash.draw("pos_chips", (el) => {
    if (!ready(el, ["ledger_pl"])) return;
    const rows = rowsS("ledger_pl");
    if (!rows.length) { el.replaceChildren(el$("span", "muted", "No positions yet.")); return; }
    const chip = (r) => { const b = el$("button", "chip"); b.type = "button"; const ic = iconImg(r.id); if (ic) b.append(ic, " "); b.append(document.createTextNode(r.item)); b.dataset.id = r.id; if (catMap().size) b.title = catText(r.id); if (r.id === WOW.id) b.setAttribute("aria-pressed", "true"); return b; };
    if (!WOW.group || !catMap().size) { el.replaceChildren(...rows.map(chip)); el.onclick = (e) => { const b = e.target.closest("button[data-id]"); if (b) select(+b.dataset.id, false); }; return; }
    const by = new Map();   // class -> type -> positions
    for (const r of rows) { const c = catMap().get(r.id), cls = c ? c.cls : NOCAT, sub = c ? c.sub || "Other" : ""; if (!by.has(cls)) by.set(cls, new Map()); const m = by.get(cls); if (!m.has(sub)) m.set(sub, []); m.get(sub).push(r); }
    const box = el$("div", "chipgroups");
    for (const [cls, subs] of [...by].sort((a, b) => (a[0] === NOCAT) - (b[0] === NOCAT) || a[0].localeCompare(b[0]))) {
      const all = [...subs.values()].flat(), key = "chips|" + cls;
      const d = el$("div", "chipgrp"), sm = el$("div", "chiphead"), body = el$("div", "chipbody");
      sm.append(el$("span", "garrow", ""), el$("b", "", cls), el$("span", "sm", "  " + all.length + (all.length === 1 ? " item" : " items")));
      sm.tabIndex = 0; sm.setAttribute("role", "button");
      const isOpen = () => (WOW.grpState.has(key) ? WOW.grpState.get(key) : WOW.grpAll ? WOW.grpAll === "open" : all.some((r) => r.id === WOW.id));   // closed at first, except the group of the item you are looking at
      const paint = () => { const o = isOpen(); body.hidden = !o; sm.setAttribute("aria-expanded", String(o)); sm.firstChild.textContent = o ? "▾ " : "▸ "; };
      const flip = () => { WOW.grpState.set(key, !isOpen()); paint(); };   // the state is stored at once, so a redraw keeps it
      sm.addEventListener("click", flip);
      sm.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
      d.append(sm, body);
      for (const [sub, list] of [...subs].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (sub) body.append(el$("div", "chipsub", sub));
        const w = el$("div", "chips"); w.append(...list.map(chip)); body.append(w);
      }
      paint();
      box.append(d);
    }
    el.replaceChildren(box);
    el.onclick = (e) => { const b = e.target.closest("button[data-id]"); if (b) select(+b.dataset.id, false); };
  });
  const q = document.querySelector("#q");
  if (q) q.addEventListener("input", () => { WOW.q = q.value; dash.draw("scanner_rows"); dash.draw("scanner_note"); });
  WOW.preset = "listed";
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
    WOW.preset = b.dataset.preset;
    document.querySelectorAll("[data-preset]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    dash.draw("scanner_rows"); dash.draw("scanner_note");
  }));
  function usesCell(r) {
    const list = r.uses ? r.uses.split(", ") : [];
    const text = (r.writ ? "Writ · " : "") + (list.length ? list.slice(0, 2).join(", ") + (list.length > 2 ? " +" + (list.length - 2) : "") : "—");
    const s = el$("span", "uses", text);
    s.title = (r.writ ? "Craftsman's Writ item. " : "") + (r.uses ? "Used in: " + r.uses : "");
    return s;
  }
  const NEAR = 0.1;
  const underUnits = (r) => (r.under_units == null ? "—" : (r.under_capped ? "at least " : "") + U.num(r.under_units));
  const underProfit = (r) => (r.under_profit == null ? "—" : r.under_profit > 0 ? U.coin(r.under_profit, { signed: true, tone: true }) : "none");
  const SCOLS = [(r) => r.name, (r) => r.min, (r) => r.vendor, (r) => r.vs_vendor, (r) => r.under_units, (r) => r.under_profit, (r) => r.n, (r) => r.chg24, (r) => r.dev7, (r) => r.sold_day, (r) => r.uses];
  WOW.tag = "";
  function scanRows() {
    const term = WOW.q.trim().toLowerCase();
    let rows = rowsOf("scanner");
    if (term) rows = rows.filter((r) => r.name.toLowerCase().includes(term));
    if (WOW.tag === "writ") rows = rows.filter((r) => r.writ);
    else if (WOW.tag) rows = rows.filter((r) => r.uses.split(", ").includes(WOW.tag) || r.makes.split(", ").includes(WOW.tag));
    const p = WOW.preset, cmp = (f, dir) => (a, b) => dir * (f(a) - f(b));
    if (p === "floor") rows = rows.filter((r) => r.vendor != null && r.vs_vendor <= NEAR).sort(cmp((r) => r.vs_vendor, 1));
    else if (p === "falling") rows = rows.filter((r) => r.chg24 != null && r.chg24 < 0 && r.n >= 5).sort(cmp((r) => r.chg24, 1));
    else if (p === "rising") rows = rows.filter((r) => r.chg24 != null && r.chg24 > 0 && r.n >= 5).sort(cmp((r) => r.chg24, -1));
    else if (p === "below") rows = rows.filter((r) => r.vendor != null && r.vs_vendor < 0).sort(cmp((r) => r.under_profit || 0, -1));
    else if (p === "selling") rows = rows.filter((r) => r.sold_day != null && r.sold_day > 0).sort(cmp((r) => r.sold_day, -1));
    else rows = rows.slice().sort(cmp((r) => r.n, -1));
    return tv("scan", rows, SCOLS, (r) => r.name);
  }
  const tagSel = document.querySelector("#tag");
  if (tagSel) tagSel.addEventListener("change", () => { WOW.tag = tagSel.value; dash.draw("scanner_rows"); dash.draw("scanner_note"); });
  dash.draw("tagsel", (el) => {
    const profs = new Set();
    if (D("scanner").status === "ok") for (const r of D("scanner").data) for (const f of [r.uses, r.makes]) if (f) f.split(", ").forEach((x) => profs.add(x));
    const opts = [["", "All items"], ["writ", "Craftsman's Writ items"]].concat([...profs].sort().map((p) => [p, "Used or made by " + p]));
    el.replaceChildren(...opts.map(([v, t]) => { const o = el$("option", "", t); o.value = v; if (v === WOW.tag) o.selected = true; return o; }));
  });
  dash.draw("scanner_rows", (tb) => {
    if (!ready(tb, ["scanner"])) return;
    selId();
    tb.replaceChildren(...scanRows().map((r) => {
      const t = tr(r.id, [nameCell(r.name, r.id), U.coin(r.min), r.vendor == null ? "—" : U.coin(r.vendor), r.vs_vendor == null ? "—" : pctNode(r.vs_vendor), underUnits(r), underProfit(r), U.num(r.n),
        r.chg24 == null ? "—" : pctNode(r.chg24), r.dev7 == null ? "—" : pctNode(r.dev7), soldCell(r.sold_day, r.id),
        usesCell(r)], r.id);
      t.tabIndex = 0; return t;
    }));
  });
  dash.draw("scanner_note", (el) => {
    if (D("scanner").status !== "ok") { el.textContent = ""; return; }
    const p = WOW.preset, hasV = rowsOf("scanner").some((r) => r.vendor != null);
    const hasT = rowsOf("scanner").some((r) => r.chg24 != null), hasS = rowsOf("scanner").some((r) => r.sold_day != null);
    const n = scanRows().length;
    let t = "Press a row to see its graphs; the arrow opens it on Wowhead.";
    if ((p === "floor" || p === "below") && !hasV) t = "No vendor values in the data.";
    else if ((p === "falling" || p === "rising") && !hasT) t = "Needs a snapshot from about 24 hours back.";
    else if (p === "selling" && !hasS) t = "No sales estimates yet.";
    else if (!n) t = "No items match.";
    el.textContent = t;
  });
  dash.draw("floor_rows", (tb) => {
    if (!ready(tb, ["scanner"])) return;
    const rows = tv("floor", rowsOf("scanner").filter((r) => r.vendor != null && r.min <= r.vendor).sort((a, b) => b.floor_profit - a.floor_profit), [(r) => r.name, (r) => r.min, (r) => r.vendor, (r) => r.floor_profit, (r) => r.under_units, (r) => r.under_profit, (r) => r.n, (r) => r.qty], (r) => r.name);
    tb.replaceChildren(...rows.map((r) => reg(r, tr(r.id, [nameCell(r.name, r.id), U.coin(r.min), U.coin(r.vendor), U.coin(r.floor_profit, { signed: true, tone: true }), underUnits(r), underProfit(r), U.num(r.n), U.num(r.qty)], r.id))));
    if (rows.length) tb.append(totRow(GSUM.floor(rows)));
  });
  GSUM.floor = (rows) => ["Total", "", "", "", U.num(sumOf(rows, (r) => r.under_units)), goldS(sumOf(rows, (r) => r.under_profit)), U.num(sumOf(rows, (r) => r.n)), U.num(sumOf(rows, (r) => r.qty))];
  GSUM.flip = (rows) => ["Total", "", "", "", "", "", U.num(sumOf(rows, (r) => r.units)), goldS(sumOf(rows, (r) => r.total)), "", "", ""];
  dash.draw("floor_note", (el) => {
    if (D("scanner").status !== "ok") { el.textContent = ""; return; }
    const hasV = rowsOf("scanner").some((r) => r.vendor != null);
    el.textContent = !hasV ? "No vendor values in the data."
      : "Items listed at or below what a vendor pays. Buying and selling to a vendor cannot lose money, but the lowest listing may be a single unit, so check the stack size before you rely on it.";
  });

  dash.draw("istats", (el) => {
    if (!ready(el, ["latest", "trends", "scanner"])) return;
    const id = selId();
    if (id == null) return;
    const L = rowsOf("latest").find((r) => r.id === id), T = rowsOf("trends").find((r) => r.id === id), SC = rowsOf("scanner").find((r) => r.id === id);
    if (!L) { el.replaceChildren(el$("span", "muted", "This item has no current listings or is not tracked here.")); return; }
    const cell = (label, node, src, field) => {
      const d = el$("div"), v = el$("b"); v.append(node);
      v.dataset.source = src; v.dataset.field = field; v.dataset.where = "id=" + id;
      d.append(el$("span", "lbl", label), v); return d;
    };
    const grid = el$("div", "mini");
    grid.append(cell("Lowest now", U.coin(L.min), "latest", "min"), cell("Median now", U.coin(L.med), "latest", "med"),
      cell("Listings", U.num(L.n), "latest", "n"), cell("Units for sale", U.num(L.qty), "latest", "qty"),
      cell("Vendor value", SC && SC.vendor != null ? U.coin(SC.vendor) : document.createTextNode("—"), "scanner", "vendor"));
    if (SC && SC.vs_vendor != null) grid.append(cell("Lowest now vs vendor", pctNode(SC.vs_vendor), "scanner", "vs_vendor"));
    const HP = rowsOf("ledger_pl").find((r) => r.id === id);
    if (HP && HP.qty > 0) {
      const mine = (label, node) => { const d = el$("div", "mine"), v = el$("b"); v.append(node instanceof Node ? node : document.createTextNode(node)); d.append(el$("span", "lbl", label), v); return d; };
      grid.append(mine("You hold", U.num(HP.qty) + " units"), mine("Your avg buy price", HP.avg == null ? "—" : U.coin(HP.avg)), mine("Paid total", U.coin(HP.cost)),
        mine("After 5% cut (total)", HP.after == null ? "—" : U.coin(HP.after)), mine("Profit if sold today", U.coin((HP.realized || 0) + (HP.qty > 0 && HP.after != null ? HP.after : 0), { signed: true, tone: true })));
    }
    if (T) {
      const pc = (v) => (v == null ? "—" : pctNode(v));
      grid.append(cell("Change since previous snapshot", pc(T.chg_prev), "trends", "chg_prev"), cell("Change over 24 h", pc(T.chg24), "trends", "chg24"),
        cell("vs normal (" + avgName() + ")", pc(T.dev7), "trends", "dev7"), cell("Supply change over 24 h", pc(T.supply24), "trends", "supply24"),
        cell("Estimated sold per day", T.sold_day == null ? "—" : U.num(T.sold_day, 1), "trends", "sold_day"),
        cell("Days of supply", T.days_supply == null ? "—" : U.num(T.days_supply, 1), "trends", "days_supply"));
    }
    const h3 = el$("h3"); h3.append(nameCell(L.name, L.id));
    el.replaceChildren(h3, grid);
  });

  function itemSeries(id) {
    if (D("hist").status !== "ok" || D("snaps").status !== "ok") return null;
    const r = D("hist").data.find((x) => x.id === id);
    return r ? { r: r, T: D("snaps").data.map((s) => s.t) } : { r: null, T: [] };
  }
  const pts = (S, key) => S.T.map((t, k) => ({ t: t, v: S.r[key][k] })).filter((p) => p.v != null);
  dash.draw("chart", (el) => {
    if (!ready(el, ["hist", "snaps", "ledger_pl"])) return;
    if (waitSel()) return;
    const S = itemSeries(WOW.id);
    if (!S || !S.r) return U.empty(el, "No price history for this item yet.");
    const lp = rowsOf("ledger_pl").find((r) => r.id === WOW.id);
    U.lineChart(el, [{ label: "Lowest price", color: U.pal[0], pts: pts(S, "m") }, { label: "Median price", color: U.pal[1], pts: pts(S, "d") }],
      lp && lp.avg != null ? [{ label: "Your avg buy price", v: lp.avg }] : [], { yfmt: U.short, tipfmt: (v) => U.coin(v, { trim: false }), aria: "Price history: lowest buyout and median" });
  });
  dash.draw("chart_supply", (el) => {
    if (!ready(el, ["hist", "snaps"])) return;
    if (waitSel()) return;
    const S = itemSeries(WOW.id);
    if (!S || !S.r) return U.empty(el, "No supply history for this item yet.");
    U.lineChart(el, [{ label: "Units for sale", color: U.pal[0], pts: pts(S, "q") }], [], { yfmt: (v) => U.num(v), tipfmt: (v) => U.num(v), height: 200, zero: true, aria: "Units for sale over time" });
  });
  dash.draw("chart_sold", (el) => {
    if (!ready(el, ["hist", "snaps"])) return;
    if (waitSel()) return;
    const S = itemSeries(WOW.id);
    if (!S || !S.r) return U.empty(el, "No sales estimates for this item yet.");
    const p = pts(S, "o");
    if (!p.length) return U.empty(el, "No sales estimates for this item yet.");
    U.lineChart(el, [{ label: "Estimated units sold", color: U.pal[0], pts: p }, { label: "Estimated units expired", color: U.pal[1], pts: pts(S, "x") }], [],
      { yfmt: (v) => U.num(v), tipfmt: (v) => U.num(v), height: 200, zero: true, aria: "Estimated units sold and expired per snapshot interval" });
  });

  // ---------- hover bubble: professions and quest links ----------
  WOW.tip = null;
  if (root) {
    root.addEventListener("mouseover", (e) => {
      const n = e.target.closest && e.target.closest("[data-tip]");
      const sc = e.target.closest && e.target.closest("[data-sales]");
      const rw = !n && !sc && e.target.closest && e.target.closest("tr[data-recipe]");
      const key = sc ? "s" + sc.dataset.sales : n ? "i" + n.dataset.tip : rw ? "r" + rw.dataset.recipe : null;
      if (key === (WOW.tip && WOW.tip.key)) return;
      if (key) { const r = (sc || n || rw).getBoundingClientRect(); WOW.tip = { key: key, sales: sc ? +sc.dataset.sales : null, id: n ? +n.dataset.tip : null, recipe: rw ? +rw.dataset.recipe : null, x: r.left, top: r.top, bottom: r.bottom }; } else WOW.tip = null;
      dash.draw("itip");
    });
  }
  if (root) root.addEventListener("mouseleave", () => { if (WOW.tip) { WOW.tip = null; dash.draw("itip"); } });
  function placeTip(el, t) {
    el.style.display = "block";
    const w = el.offsetWidth, h = el.offsetHeight, rr = root.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(t.x - rr.left, rr.width - w - 8)) + "px";
    el.style.top = (t.bottom + h + 12 > window.innerHeight ? t.top - rr.top - h - 6 : t.bottom - rr.top + 6) + "px";
  }
  dash.draw("itip", (el) => {
    const t = WOW.tip;
    if (!t) { el.style.display = "none"; el.replaceChildren(); return; }
    const row = (label, node) => { const d = el$("div", "trow"); d.append(el$("span", "tlbl", label + " "), node instanceof Node ? node : document.createTextNode(node)); return d; };
    if (t.sales != null) {
      const nm0 = (D("names").status === "ok" && (D("names").data.find((r) => r.id === t.sales) || {}).name) || "Item " + t.sales;
      const tt0 = el$("b", "ttitle"); tt0.append(document.createTextNode(nm0 + ": prices sold at"));
      const kids0 = [tt0];
      const SD = D("salesprices"), mine = SD.status === "ok" ? SD.data.filter((r) => Number(r.id) === t.sales && (r.k || "s") === "s").sort((a, b) => (a.t < b.t ? 1 : -1)) : [];
      if (!mine.length) kids0.push(el$("div", "tlbl", "No sales recorded for this item yet."));
      else {
        const units = mine.reduce((a, r) => a + Number(r.u), 0), val = mine.reduce((a, r) => a + Number(r.u) * Number(r.av), 0);
        kids0.push(row("Average sold:", U.coin(Math.round(val / units))), row("Range:", U.coin(Math.min(...mine.map((r) => Number(r.lo))))), row("Highest:", U.coin(Math.max(...mine.map((r) => Number(r.hi))))), row("Units seen sold:", U.num(units)));
        const tbl0 = el$("table", "rtab");
        for (const r of mine.slice(0, 8)) {
          const tr_ = el$("tr"), c1 = el$("td", "", U.when(Date.parse(r.t)) + ": " + r.u + " ×"), c2 = el$("td", "num");
          c2.append(U.coin(Number(r.av)));
          tr_.append(c1, c2); tbl0.append(tr_);
        }
        kids0.push(tbl0);
        kids0.push(el$("div", "tlbl", "From auctions that disappeared while not about to expire. Cancellations look the same."));
      }
      el.replaceChildren(...kids0);
      return placeTip(el, t);
    }
    if (t.recipe != null) {
      if (D("recipe_margins").status !== "ok") { el.style.display = "none"; return; }
      const R = rowsOf("recipe_margins").find((x) => x.id === t.recipe);
      if (!R) { el.style.display = "none"; return; }
      const tt = el$("b", "ttitle"); tt.append(document.createTextNode(R.name + " (" + R.p + ")"));
      const kids = [tt, row("Needs skill:", R.lvl == null ? "learned from a trainer, or level unknown" : R.p + " " + R.lvl)];
      const tbl = el$("table", "rtab");
      for (const g of R.reag) {
        const tr_ = el$("tr");
        const c1 = el$("td", "", g.q + " × " + g.name), c2 = el$("td", "num");
        c2.append(g.price == null ? document.createTextNode("no listings") : U.coin(g.price * g.q));
        tr_.append(c1, c2); tbl.append(tr_);
      }
      kids.push(tbl);
      kids.push(row("Reagent cost:", R.cost == null ? "incomplete" : U.coin(R.cost)));
      kids.push(row("Sells for:", R.price == null ? "no listings" : U.coin(R.price * R.qty)));
      if (R.profit != null) kids.push(row("Profit after 5% cut:", U.coin(R.profit, { signed: true, tone: true })));
      el.replaceChildren(...kids);
      return placeTip(el, t);
    }
    if (D("scanner").status !== "ok") { el.style.display = "none"; el.replaceChildren(); return; }
    const S = rowsOf("scanner").find((r) => r.id === t.id), I = D("iteminfo").status === "ok" ? D("iteminfo").data.find((r) => r.id === t.id) : null;
    const nm = (S && S.name) || (D("names").status === "ok" && (D("names").data.find((r) => r.id === t.id) || {}).name) || "Item " + t.id;
    const profsLoaded = D("profs").status === "ok" && D("profs").data.length > 0;
    const tt = el$("b", "ttitle"); const tic = iconImg(t.id); if (tic) tt.append(tic, " "); tt.append(document.createTextNode(nm));
    const kids = [tt];
    if (catMap().size) kids.push(row("Category:", catText(t.id)));
    if (I && I.uses) kids.push(row("Used in:", I.uses));
    if (I && I.makes) kids.push(row("Made by:", I.makes));
    if (!(I && (I.uses || I.makes))) kids.push(row("Professions:", profsLoaded ? "none use or make this item" : "profession data not loaded yet"));
    if (I && I.writ_id != null) {
      const q = row("Writ:", "This item has a Craftsman's Writ. " + (I.writ_min == null ? "No writ listed on the AH right now." : "The writ item sells for "));
      if (I.writ_min != null) q.append(U.coin(I.writ_min));
      kids.push(q);
    }
    if (S && S.vendor != null) kids.push(row("Vendor pays:", U.coin(S.vendor)));
    if (S) kids.push(row("Lowest now:", U.coin(S.min)));
    el.replaceChildren(...kids);
    placeTip(el, t);
  });


  // ---------- flip scanner and writ tracker ----------
  WOW.minq = 1; WOW.minlist = 5; WOW.minsold = 1;
  // the Flip scanner filters: rarity, fewest listings and fewest sold per day (rarity and listings also apply to the Opportunity map)
  const flipOk = (r) => (r.q == null || r.q >= WOW.minq) && (r.n == null || r.n >= WOW.minlist) && (!WOW.minsold || (r.sold_day != null && r.sold_day >= WOW.minsold));
  const flipRedraw = () => ["flip_rows", "flip_note", "ch_opp", "opp_note"].forEach((n) => dash.draw(n));
  [["#f-minq", "minq"], ["#f-minlist", "minlist"], ["#f-minsold", "minsold"]].forEach(([sel, k]) => { const s = document.querySelector(sel); if (!s) return; WOW[k] = +s.value; s.addEventListener("change", () => { WOW[k] = +s.value; flipRedraw(); }); });
  dash.draw("flip_rows", (tb) => {
    if (!ready(tb, ["flip_view"])) return;
    const rows = tv("flip", rowsOf("flip_view").filter(flipOk), [(r) => r.name, (r) => r.wall, (r) => r.cost, (r) => r.ref, (r) => r.profit, (r) => r.roi, (r) => r.units, (r) => r.total, (r) => r.share, (r) => r.sold_day, (r) => r.min], (r) => r.name);
    tb.replaceChildren(...rows.map((r) => reg(r, tr(r.id, [nameCell(r.name, r.id), U.coin(r.wall), U.coin(r.cost), U.coin(r.ref), U.coin(r.profit, { signed: true, tone: true }), pctNode(r.roi), U.num(r.units),
      U.coin(r.total, { signed: true, tone: true }), U.pct(r.share), soldCell(r.sold_day, r.id), U.coin(r.min)], r.id))));
    if (rows.length) tb.append(totRow(GSUM.flip(rows)));
  });
  dash.draw("flip_note", (el) => {
    const d = D("flip_view");
    if (d.status !== "ok") { el.textContent = ""; return; }
    const hidden = d.data.length - d.data.filter(flipOk).length, scan = d.data.some((r) => r.src === "scan");
    el.textContent = scan ? "" : "Hourly prices: cheap units may be gone. Scan the AH in game for fresh flips.";
  });
  dash.draw("writ_rows", (tb) => {
    if (!ready(tb, ["writ_view"])) return;
    const rows = tv("writ", rowsOf("writ_view"), [(r) => r.name, (r) => r.price, (r) => r.n, (r) => r.writ_price, (r) => r.writ_n, (r) => r.craft_cost, (r) => r.sold_day, (r) => r.writ_sold], (r) => r.name);
    tb.replaceChildren(...rows.map((r) => tr(r.id, [nameCell(r.name, r.id), r.price == null ? "not listed" : U.coin(r.price), U.num(r.n), r.writ_price == null ? "not listed" : U.coin(r.writ_price), U.num(r.writ_n),
      r.craft_cost == null ? "—" : U.coin(r.craft_cost), r.sold_day == null ? "—" : U.num(r.sold_day, 1), r.writ_sold == null ? "—" : U.num(r.writ_sold, 1)], r.id)));
  });
  dash.draw("writ_note", (el) => {
    const d = D("writ_view");
    if (d.status !== "ok") { el.textContent = ""; return; }
    el.textContent = d.data.length ? ""
      : "No writ items found yet.";
  });

  // ---------- price by time of day ----------
  dash.draw("ch_hour", (el) => {
    if (!ready(el, ["hist", "snaps"])) return;
    if (waitSel()) return;
    const S = itemSeries(WOW.id);
    if (!S || !S.r) return U.empty(el, "No price history for this item yet.");
    const byH = new Map();
    S.T.forEach((t, k) => { const v = S.r.m[k]; if (v == null) return; const h = new Date(t).getHours(); if (!byH.has(h)) byH.set(h, []); byH.get(h).push(v); });
    const all = [...byH.values()].flat();
    if (all.length < 2) return U.empty(el, "Needs more snapshots.");
    const mean = all.reduce((x, y) => x + y, 0) / all.length;
    const rows = [...byH].sort((x, y) => x[0] - y[0]).map(([h, v]) => { const m = v.reduce((x, y) => x + y, 0) / v.length; return { label: String(h).padStart(2, "0") + ":00", v: m / mean - 1, color: m < mean ? "var(--color-ok)" : "var(--color-bad)", tip: [el$("div", "", String(h).padStart(2, "0") + ":00 · " + v.length + " snapshot(s)"), (() => { const d = el$("div", "", "Average lowest buyout "); d.append(U.coin(Math.round(m), { trim: false })); return d; })()] }; });
    U.hbar(el, rows, { fmt: (v) => U.pct(v, true), aria: "Average price by hour of day against the item's average", empty: "" });
  });
  dash.draw("hour_note", (el) => {
    if (D("hist").status !== "ok" || D("snaps").status !== "ok" || waitSel()) { el.textContent = ""; return; }
    const S = itemSeries(WOW.id);
    if (!S || !S.r) { el.textContent = ""; return; }
    const byH = new Map(); let n = 0;
    S.T.forEach((t, k) => { const v = S.r.m[k]; if (v == null) return; n++; const h = new Date(t).getHours(); if (!byH.has(h)) byH.set(h, []); byH.get(h).push(v); });
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const mean = n ? avg([...byH.values()].flat()) : 0;
    const hs = [...byH].map(([h, v]) => [h, avg(v) / mean - 1]).sort((x, y) => x[1] - y[1]);
    const f = (h) => String(h).padStart(2, "0") + ":00";
    const thin = n < 48 || byH.size < 12;
    el.textContent = hs.length < 2 ? "Needs snapshots from more than one hour of the day." : thin ? "Too little data yet (" + n + " snapshots)." : "";
  });

  // ---------- stack check ----------
  WOW.stackN = null;
  const stackIn = document.querySelector("#stack-n");
  if (stackIn) stackIn.addEventListener("input", () => { WOW.stackN = stackIn.value === "" ? null : Math.max(1, Math.floor(+stackIn.value)); dash.draw("stack_panel"); });
  dash.draw("stack_panel", (el) => {
    if (!ready(el, ["ladder_view", "latest", "trends", "ledger_pl"])) return;
    const id = selId();
    if (id == null) return;
    const L = rowsOf("latest").find((r) => r.id === id), T = rowsOf("trends").find((r) => r.id === id), P = rowsOf("ledger_pl").find((r) => r.id === id);
    const lad = rowsOf("ladder_view").find((r) => r.id === id);
    if (!L) { el.replaceChildren(el$("span", "muted", "This item has no current listings.")); return; }
    const N = WOW.stackN || (P && P.qty > 0 ? P.qty : 20);
    const cell = (label, node) => { const d = el$("div"), v = el$("b"); v.append(node instanceof Node ? node : document.createTextNode(node)); d.append(el$("span", "lbl", label), v); return d; };
    const grid = el$("div", "mini");
    const kids = [el$("h3", "", N + " units of " + L.name)];
    if (!lad || !lad.lv.length) {
      kids.push(el$("p", "note", "No price ladder for this item, so only the sale value at the lowest price is shown."));
      grid.append(cell("Sale value at the lowest price, after 5% cut", U.coin(Math.round(N * L.min * 0.95))));
      kids.push(grid); el.replaceChildren(...kids); return;
    }
    let need = N, cost = 0, bought = 0;
    for (const [p, q] of lad.lv) { const take = Math.min(need, q); cost += take * p; bought += take; need -= take; if (!need) break; }
    const depth = lad.lv.reduce((s, x) => s + x[1], 0);
    const ahead = lad.lv[0][1];
    if (bought < N) grid.append(cell("Buying " + N + " units", "more than the " + U.num(depth) + " units in the cheapest levels"));
    else {
      grid.append(cell("Cost to buy " + N + " units", U.coin(cost)), cell("Average price each", U.coin(Math.round(cost / N))), cell("Premium over the lowest price", pctNode(cost / N / lad.lv[0][0] - 1)));
    }
    grid.append(cell("Units already listed at the lowest price", U.num(ahead)),
      cell("Sale value at the lowest price, after 5% cut", U.coin(Math.round(N * lad.lv[0][0] * 0.95))),
      cell("Estimated days to sell them all", T && T.sold_day > 0 ? U.num((ahead + N) / T.sold_day, 1) + " days" : "unknown yet"));
    kids.push(grid);
    kids.push(el$("p", "note", "Buying walks up the listings from the cheapest. Selling: you can only list, and the units already at the lowest price sell before yours. The days figure uses the rough sales-per-day estimate."));
    const table = el$("table", "tbl"), hd = el$("tr");
    ["Price each", "Units", "Units up to here", "vs lowest"].forEach((t) => hd.append(el$("th", "", t)));
    const th = el$("thead"); th.append(hd); const bd = el$("tbody"); let cum = 0;
    lad.lv.forEach(([p, q]) => { cum += q; bd.append(tr(null, [U.coin(p), U.num(q), U.num(cum), pctNode(p / lad.lv[0][0] - 1)])); });
    table.append(th, bd);
    const sc = el$("div", "scroll"); sc.append(table); kids.push(sc);
    el.replaceChildren(...kids);
  });

  // ---------- suggestions ----------
  dash.draw("daily_note", (el) => {
    const d = D("notes");
    if (d.status === "error") { el.textContent = "The note failed to load."; return; }
    const n = d.status === "ok" ? d.data.find((r) => r.id === "latest") || d.data[0] : null;
    el.textContent = n && n.text ? n.text + (n.date ? "  (" + n.date + ")" : "") : "No note yet.";
  });
  dash.draw("buywatch_rows", (tb) => {
    if (!ready(tb, ["buywatch"])) return;
    tb.replaceChildren(...tv("buy", rowsOf("buywatch"), [(r) => r.name, (r) => r.now, (r) => r.avg7, (r) => r.dev7, (r) => r.chg24, (r) => r.supply24, (r) => r.sold_day], (r) => r.name).map((r) => tr(r.id, [nameCell(r.name, r.id), U.coin(r.now), U.coin(r.avg7), pctNode(r.dev7), r.chg24 == null ? "—" : pctNode(r.chg24),
      r.supply24 == null ? "—" : pctNode(r.supply24), soldCell(r.sold_day, r.id)], r.id)));
  });
  dash.draw("buywatch_note", (el) => {
    if (D("buywatch").status !== "ok") { el.textContent = ""; return; }
    const hasAvg = rowsOf("trends").some((t) => t.dev7 != null);
    el.textContent = D("buywatch").data.length ? "" : hasAvg ? "No item is currently 8% or more below its " + avgName() + "."
      : "Needs at least 4 snapshots spanning 12 hours before the normal price exists. Snapshots so far: " + snapInfo().n + ".";
  });
  WOW.oppMode = WOW.oppMode || "cheap";
  document.querySelectorAll("[data-oppmode]").forEach((b) => b.addEventListener("click", () => {
    WOW.oppMode = b.dataset.oppmode;
    document.querySelectorAll("[data-oppmode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    dash.draw("ch_opp"); dash.draw("opp_note");
  }));
  const oppRows = () => {
    const L = new Map(rowsOf("latest").map((r) => [r.id, r]));
    const rows = rowsOf("opportunity").filter((r) => { const l = L.get(r.id); return l && (l.q == null || l.q >= (WOW.minq == null ? 1 : WOW.minq)) && l.n >= (WOW.minlist == null ? 5 : WOW.minlist); });
    return WOW.oppMode === "all" ? rows.filter((r) => r.sold_day >= 1) : rows.filter((r) => r.dev7 <= -0.05 && r.sold_day >= 10);
  };
  dash.draw("opp_note", (el) => {
    if (!ready(el, ["opportunity", "latest"])) return;
    const all = oppRows(), inView = all.filter((r) => r.dev7 >= -0.6 && r.dev7 <= 1);
    el.textContent = all.length > inView.length ? (all.length - inView.length) + " more off the chart." : "";
  });
  dash.draw("ch_opp", (el) => {
    if (!ready(el, ["opportunity", "latest"])) return;
    const pts = oppRows().filter((r) => catOk(r.id)).filter((r) => r.dev7 >= -0.6 && r.dev7 <= 1).map((r) => ({ id: r.id, x: r.dev7, y: r.sold_day, label: r.name }));
    U.scatter(el, pts, { onPick: (r) => select(r.id, true), xfmt: (v) => U.pct(v), xlabel: "Price vs normal (average)", ylabel: "Est. units sold per day", xdomain: WOW.oppMode === "all" ? [-0.6, 1] : [-0.6, 0.05], ylog: true, labels: 8, rank: (p) => p.y * Math.max(0, -p.x), height: 340,
      aria: "Opportunity map: price against normal and sales per day",
      empty: "No items match yet. This needs average prices and sales estimates, which build up as snapshots accumulate." });
  });

  // ---------- market ----------
  const moversRow = (r) => tr(r.id, [nameCell(r.name, r.id), U.coin(r.prev), U.coin(r.now), pctNode(r.pct), U.num(r.n)], r.id);
  ["up", "down"].forEach((dir) => dash.draw("movers_" + dir, (tb) => { if (!ready(tb, ["movers"])) return; tb.replaceChildren(...tv(dir === "up" ? "mup" : "mdn", rowsOf("movers").filter((r) => r.dir === dir), [(r) => r.name, (r) => r.prev, (r) => r.now, (r) => r.pct, (r) => r.n], (r) => r.name).map(moversRow)); }));
  dash.draw("movers_note", (el) => {
    if (D("movers").status !== "ok") { el.textContent = ""; return; }
    el.textContent = D("movers").data.length ? "" : "Needs at least two different price snapshots. " + snapInfo().n + " so far; this fills in as Blizzard's prices change.";
  });
  dash.draw("ch_movers", (el) => {
    if (!ready(el, ["movers"])) return;
    drillChart(el, "ch_movers", rowsOf("movers").filter((r) => catOk(r.id)), { flat: true, val: (r) => r.pct, label: (r) => r.name, agg: "avg", cap: { top: 10, bottom: 10 }, fmt: (v) => U.pct(v, true), signed: true,
      tip: (r) => [el$("div", "", r.name), (() => { const d = el$("div", "", U.short(r.prev) + " → " + U.short(r.now) + " "); d.append(pctNode(r.pct)); return d; })()],
      aria: "Biggest price rises and drops since the previous snapshot", empty: "No price changes for this selection yet." });
  });
  dash.draw("supply_rows", (tb) => {
    if (!ready(tb, ["supply_view"])) return;
    tb.replaceChildren(...tv("sup", rowsOf("supply_view"), [(r) => r.name, (r) => r.qty, (r) => r.pct, (r) => r.chg24, (r) => r.now], (r) => r.name).map((r) => tr(r.id, [nameCell(r.name, r.id), U.num(r.qty), pctNode(r.pct), r.chg24 == null ? "—" : pctNode(r.chg24), U.coin(r.now)], r.id)));
  });
  dash.draw("supply_note", (el) => {
    if (D("supply_view").status !== "ok") { el.textContent = ""; return; }
    el.textContent = D("supply_view").data.length ? ""
      : "Needs a snapshot from about 24 hours back. First snapshot: " + U.when(snapInfo().first) + ".";
  });
  dash.draw("ch_supply", (el) => {
    if (!ready(el, ["supply_view"])) return;
    drillChart(el, "ch_supply", rowsOf("supply_view").filter((r) => catOk(r.id)), { flat: true, val: (r) => r.pct, label: (r) => r.name, agg: "avg", cap: { top: 10, bottom: 10 }, fmt: (v) => U.pct(v, true), signed: true, color: (v) => (v >= 0 ? U.pal[1] : U.pal[0]),
      tip: (r) => [el$("div", "", r.name), el$("div", "", U.num(r.qty) + " units (" + U.pct(r.pct, true) + " in 24 h)")], aria: "Change in units for sale over 24 hours", empty: "No supply changes for this selection yet." });
  });
  dash.draw("sell_rows", (tb) => {
    if (!ready(tb, ["sellthru_view"])) return;
    tb.replaceChildren(...tv("sell", rowsOf("sellthru_view"), [(r) => r.name, (r) => r.sold_day, (r) => r.turnover, (r) => r.days_supply, (r) => r.exp_share, (r) => r.now], (r) => r.name).map((r) => tr(r.id, [nameCell(r.name, r.id), soldCell(r.sold_day, r.id), U.coin(r.turnover), r.days_supply == null ? "—" : U.num(r.days_supply, 1), r.exp_share == null ? "—" : U.pct(r.exp_share), U.coin(r.now)], r.id)));
  });
  GSUM.exp = (rows) => ["Total", U.num(sumOf(rows, (r) => r.exp_units)), "", U.num(sumOf(rows, (r) => r.sold_units)), "", "", "", ""];
  dash.draw("exp_rows", (tb) => {
    if (!ready(tb, ["expired_view"])) return;
    const rows = tv("exp", rowsOf("expired_view"), [(r) => r.name, (r) => r.exp_units, (r) => r.exp_avg, (r) => r.sold_units, (r) => r.sold_avg, (r) => r.over_sold, (r) => r.over_now, (r) => r.now], (r) => r.name);
    tb.replaceChildren(...rows.map((r) => reg(r, tr(r.id, [nameCell(r.name, r.id), U.num(r.exp_units), U.coin(r.exp_avg), U.num(r.sold_units), r.sold_avg == null ? "—" : U.coin(r.sold_avg),
      r.over_sold == null ? "—" : pctNode(r.over_sold), r.over_now == null ? "—" : pctNode(r.over_now), U.coin(r.now)], r.id))));
    if (rows.length) tb.append(totRow(GSUM.exp(rows)));
  });
  dash.draw("exp_note", (el) => {
    if (!ready(el, ["expiredprices", "expired_view"])) return;
    el.textContent = rowsOf("expired_view").length ? ""
      : "Nothing to show yet. An item needs at least 3 expired units in the last 7 days.";
  });
  dash.draw("chart_gap", (el) => {
    if (!ready(el, ["ladder_gap"])) return;
    if (waitSel()) return;
    const g = rowsOf("ladder_gap").find((r) => r.id === WOW.id);
    if (!g) return U.empty(el, "No price ladder history for this item yet.");
    const mk = (a) => g.t.map((t, k) => ({ t: t, v: a[k] })).filter((p) => p.v != null);
    if (mk(g.p1).length < 2) return U.empty(el, "Ladder history is saved about every 4 hours, so a line needs at least two saves. Saved so far: " + mk(g.p1).length + ".");
    U.lineChart(el, [{ label: "Cheapest price", color: U.pal[0], pts: mk(g.p1) }, { label: "Next price level", color: U.pal[1], pts: mk(g.p2) }], [],
      { yfmt: U.short, tipfmt: (v) => U.coin(v, { trim: false }), height: 220, aria: "Cheapest price and next price level over time" });
  });
  dash.draw("sell_note", (el) => {
    if (D("sellthru_view").status !== "ok") { el.textContent = ""; return; }
    el.textContent = D("sellthru_view").data.length ? ""
      : "No sales estimates yet.";
  });
  dash.draw("ch_sell", (el) => {
    if (!ready(el, ["sellthru_view"])) return;
    drillChart(el, "ch_sell", rowsOf("sellthru_view").filter((r) => catOk(r.id)), { flat: true, val: (r) => r.turnover, label: (r) => r.name, agg: "sum", cap: { top: 15, bottom: 0 }, fmt: U.short,
      tip: (r) => [el$("div", "", r.name), el$("div", "", U.num(r.sold_day, 1) + " sold per day at " + U.short(r.now))], aria: "Estimated gold turnover per day", empty: "No sales estimates for this selection yet." });
  });

  // ---------- margins ----------
  dash.draw("margin_rows", (tb) => {
    if (!ready(tb, ["recipe_margins"])) return;
    const rows = tv("mar", marRows(), MCOLS, (r) => r.name + " " + r.p + " " + r.cat);
    tb.replaceChildren(...rows.map((r) => { const nc = nameCell(r.name, r.out); delete nc.dataset.tip; const t = tr(r.id, [nc, r.p, r.cat, r.lvl == null ? "Trainer / unknown" : r.lvl, r.cost == null ? "no price for: " + r.missing : U.coin(r.cost), r.price == null ? "no listings" : U.coin(r.price),
      r.profit == null ? "—" : U.coin(r.profit, { signed: true, tone: true }), r.margin == null ? "—" : pctNode(r.margin), soldCell(r.sold_day, r.id)], r.out); t.dataset.recipe = r.id; return t; }));
  });
  dash.draw("margin_note", (el) => {
    const d = D("recipe_margins");
    if (d.status !== "ok") { el.textContent = ""; return; }
    el.textContent = !d.data.length ? "No recipe data yet."
      : marRows().length ? (WOW.mcan && !haveSkills() ? "No profession levels from the game yet." : "") : "No recipes match these filters.";
  });
  dash.draw("ch_margins", (el) => {
    if (!ready(el, ["recipe_margins"])) return;
    drillChart(el, "ch_margins", marRows().filter((r) => r.profit != null).map((r) => Object.assign({}, r, { id: r.out })), { val: (r) => r.profit, label: (r) => r.name, agg: "avg", cap: { top: 15, bottom: 0 }, fmt: signedShort, signed: true,
      tip: (r) => [el$("div", "", r.name + " (" + r.p + ")"), (() => { const d = el$("div", "", "Profit per craft: "); d.append(U.coin(r.profit, { signed: true, tone: true, trim: true })); return d; })()],
      aria: "Profit per craft in the current selection", empty: "No priced recipes match these filters." });
  });
  // ---------- margins: profession and category pickers ----------
  WOW.mp = ""; WOW.mc = ""; WOW.mprofit = false; WOW.mcan = false;
  const MCOLS = [(r) => r.name, (r) => r.p, (r) => r.cat, (r) => r.lvl, (r) => r.cost, (r) => r.price, (r) => r.profit, (r) => r.margin, (r) => r.sold_day];
  // ---------- my skills (read from the game) ----------
  const skillMap = () => { const m = new Map(); if (D("skills_saved").status === "ok") for (const r of D("skills_saved").data) { const l = Number(r.lvl); if (r.p && l > 0) m.set(r.p, l); } return m; };
  const canCraft = (r) => { const l = skillMap().get(r.p); return l != null && (r.lvl == null || r.lvl <= l); };
  const haveSkills = () => skillMap().size > 0;
  WOW.skillMsg = "";
  dash.draw("skills_msg", (el) => { el.textContent = WOW.skillMsg; });
  dash.draw("skills_panel", (el) => {
    if (!ready(el, ["recipe_margins"])) return;
    if (D("skills_saved").status === "loading") return;
    const profs = [...new Set(rowsOf("recipe_margins").map((r) => r.p))].sort(), cur = skillMap();
    if (!profs.length) { U.empty(el, "Recipe data is not loaded yet."); return; }
    // read-only: the levels come from the game (the addon reads each character's professions; the highest level counts)
    el.replaceChildren(...profs.map((p) => { const w = el$("div", "skill"); w.append(el$("span", "lbl", p), el$("b", "", cur.has(p) ? String(cur.get(p)) : "—")); return w; }));
  });
  function marRows() {
    let rows = rowsOf("recipe_margins");
    if (WOW.mp) rows = rows.filter((r) => r.p === WOW.mp);
    if (WOW.mc) rows = rows.filter((r) => r.cat === WOW.mc);
    if (WOW.mcan) rows = rows.filter(canCraft);
    if (WOW.mprofit) rows = rows.filter((r) => r.profit != null && r.profit > 0);
    if (!(TV.mar && TV.mar.col != null)) rows = rows.slice().sort((a, b) => (a.profit == null) - (b.profit == null) || (b.profit || 0) - (a.profit || 0));   // priced recipes first, most profitable on top
    return rows;
  }
  const mRedraw = () => ["margin_rows", "margin_note", "ch_margins", "msel_cat", "today_craft"].forEach((n) => dash.draw(n));
  const mp = document.querySelector("#m-prof"), mc = document.querySelector("#m-cat"), mpr = document.querySelector("#m-profit");
  if (mp) mp.addEventListener("change", () => { WOW.mp = mp.value; WOW.mc = ""; mRedraw(); });
  if (mc) mc.addEventListener("change", () => { WOW.mc = mc.value; mRedraw(); });
  const mcan = document.querySelector("#m-can");
  if (mcan) mcan.addEventListener("change", () => { WOW.mcan = mcan.checked; mRedraw(); dash.draw("today_craft"); });
  if (mpr) mpr.addEventListener("change", () => { WOW.mprofit = mpr.checked; mRedraw(); });
  const optsOf = (el, first, list, cur) => el.replaceChildren(...[["", first]].concat(list.map((x) => [x, x])).map(([v, t]) => { const o = el$("option", "", t); o.value = v; if (v === cur) o.selected = true; return o; }));
  dash.draw("msel_prof", (el) => {
    if (D("recipe_margins").status !== "ok") return;
    const set = new Set(D("recipe_margins").data.map((r) => r.p));
    optsOf(el, "All professions", [...set].sort(), WOW.mp);
  });
  dash.draw("msel_cat", (el) => {
    if (D("recipe_margins").status !== "ok") return;
    const set = new Set(D("recipe_margins").data.filter((r) => !WOW.mp || r.p === WOW.mp).map((r) => r.cat));
    optsOf(el, WOW.mp ? "All categories in " + WOW.mp : "All categories", [...set].sort(), WOW.mc);
  });

  // ---------- today ----------
  const todayRows = (tb, cols, rows, emptyText, mk) => {
    if (!rows.length) { const r = el$("tr"), td = el$("td", "muted", emptyText); td.colSpan = cols; r.append(td); tb.replaceChildren(r); return; }
    tb.replaceChildren(...rows.slice(0, 5).map(mk));
  };
  dash.draw("today_flip", (tb) => {
    if (!ready(tb, ["flip_view"])) return;
    const rows = rowsOf("flip_view").filter(flipOk).slice().sort((x, y) => (y.total == null ? -1 : y.total) - (x.total == null ? -1 : x.total) || y.profit - x.profit);
    todayRows(tb, 4, rows, "No flips right now.", (r) => tr(r.id, [nameCell(r.name, r.id), U.coin(r.min), U.coin(r.profit, { signed: true, tone: true }), pctNode(r.roi)], r.id));
  });
  dash.draw("today_floor", (tb) => {
    if (!ready(tb, ["scanner"])) return;
    const rows = rowsOf("scanner").filter((r) => r.vendor != null && r.min <= r.vendor).sort((x, y) => y.floor_profit - x.floor_profit);
    todayRows(tb, 3, rows, "Nothing at or below vendor value.", (r) => tr(r.id, [nameCell(r.name, r.id), U.coin(r.min), U.coin(r.floor_profit, { signed: true, tone: true })], r.id));
  });
  dash.draw("today_craft", (tb) => {
    if (!ready(tb, ["recipe_margins"])) return;
    const mine = haveSkills();
    let rows = rowsOf("recipe_margins").filter((r) => r.profit != null && r.profit > 0);
    if (mine) rows = rows.filter(canCraft);
    rows.sort((x, y) => y.profit - x.profit);
    todayRows(tb, 3, rows, mine ? "No profitable crafts at your levels." : "No profitable crafts. Your profession levels from the game will narrow this list once your game file is connected.", (r) => { const nc = nameCell(r.name, r.out); delete nc.dataset.tip; const t = tr(r.id, [nc, r.p, U.coin(r.profit, { signed: true, tone: true })], r.out); t.dataset.recipe = r.id; return t; });
  });
  dash.draw("today_sell", (tb) => {
    if (!ready(tb, ["advice"])) return;
    const rows = rowsOf("advice").filter((r) => /^consider selling/i.test(r.advice || ""));
    todayRows(tb, 4, rows, "Nothing you hold looks worth selling yet.", (r) => tr(r.id, [nameCell(r.item, r.id), r.avg == null ? "—" : U.coin(r.avg), r.price == null ? "no listings" : U.coin(r.price), r.dev7 == null ? "—" : pctNode(r.dev7)], r.id));
  });


  // ---------- global item search ----------
  const gs = document.querySelector("#g-search");
  if (gs) {
    const go = () => { const it = resolveItem(gs.value); if (it) { select(it.id, true); gs.value = ""; gs.blur(); } };
    gs.addEventListener("change", go);
    gs.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }

  // ---------- small stat grid helper ----------
  const statCell = (label, node, tone) => { const d = el$("div"), v = el$("b"); v.append(node instanceof Node ? node : document.createTextNode(node)); if (tone) v.dataset.tone = tone; d.append(el$("span", "lbl", label), v); return d; };
  const dayT = (s) => new Date(s + "T12:00:00").getTime();
  const fmtDate = (t) => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

  // ---------- profit calculator ----------
  ["#pc-qty", "#pc-g", "#pc-s", "#pc-c"].forEach((s) => { const i = document.querySelector(s); if (i) i.addEventListener("input", () => dash.draw("calc_panel")); });
  dash.draw("calc_panel", (el) => {
    if (!ready(el, ["latest", "trends", "ledger_pl"])) return;
    const id = selId(); if (id == null) return;
    const L = rowsOf("latest").find((r) => r.id === id), T = rowsOf("trends").find((r) => r.id === id) || {}, P = rowsOf("ledger_pl").find((r) => r.id === id);
    if (!L) { el.replaceChildren(el$("span", "muted", "This item has no current listings.")); return; }
    const qty = Math.max(1, Math.floor(+val("#pc-qty") || (P && P.qty > 0 ? P.qty : 10)));
    const typed = coins("#pc-g", "#pc-s", "#pc-c"), b = typed > 0 ? typed : L.min;
    const cost = qty * b, net = Math.round(L.min * 0.95) * qty, grid = el$("div", "mini");
    const profit = (price) => Math.round(price * 0.95) * qty - cost;
    grid.append(statCell("Total cost for " + U.num(qty) + " units", U.coin(cost)), statCell("Price each", U.coin(b)),
      statCell("Break-even sell price each", U.coin(Math.ceil(b / 0.95))),
      statCell("Profit selling at today's lowest (" + U.short(L.min) + ")", U.coin(net - cost, { signed: true, tone: true })),
      statCell("Return at today's lowest", pctNode(cost > 0 ? (net - cost) / cost : null)));
    grid.append(statCell("Profit selling at the normal price (" + avgName() + ")", T.avg7 ? U.coin(profit(T.avg7), { signed: true, tone: true }) : "needs more data"));
    grid.append(statCell("Sell price for a 10% profit", U.coin(Math.ceil((b * 1.1) / 0.95))));
    if (T.sold_day > 0) grid.append(statCell("Market sells about", U.num(T.sold_day, 1) + " per day (" + U.num(qty / T.sold_day, 1) + " days for your " + U.num(qty) + ")"));
    el.replaceChildren(el$("h3", "", L.name), grid, el$("p", "note", "Profit uses the 5% auction cut. The price and the sales speed are estimates; a big quantity will push the price up when you buy and down when you sell."));
  });

  // ---------- profit history ----------
  // Profit over time: each day adds what you received from sales and subtracts what you paid for purchases
  function salesSeries() {
    const byDay = new Map(); let any = false;
    for (const r of rowsOf("ledger_all")) {
      if (r.how === "collected") continue;
      const v = r.qty * Number(r.unit || 0) * (r.how === "sold" ? 1 : -1);
      byDay.set(r.date, (byDay.get(r.date) || 0) + v); any = true;
    }
    if (!any) return [];
    const days = [...byDay].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    let cum = 0; const pts = [{ t: dayT(days[0][0]) - 86400e3, v: 0 }];
    for (const [d, p] of days) { cum += p; pts.push({ t: dayT(d), v: Math.round(cum) }); }
    if (pts[pts.length - 1].t < Date.now()) pts.push({ t: Date.now(), v: Math.round(cum) });   // the line runs to now
    return pts;
  }
  dash.draw("ch_profit", (el) => {
    if (!ready(el, ["ledger_all", "ledger_pl"])) return;
    const pts = salesSeries();
    if (!pts.length) return U.empty(el, "No purchases or sales yet.");
    U.lineChart(el, [{ label: "Profit", color: U.pal[2 % U.pal.length], pts: pts }], [], { yfmt: signedShort, tipfmt: (v) => U.coin(v, { signed: true, tone: true, trim: false }), aria: "Profit over time: sales received minus purchases paid" });
  });
  dash.draw("ch_realized", (el) => {
    if (!ready(el, ["ledger_pl"])) return;
    const rows = rowsOf("ledger_pl").filter((r) => r.sold > 0 || r.paid > 0).sort((x, y) => y.realized - x.realized);
    U.hbar(el, rows.map((r) => ({ id: r.id, label: r.item, v: r.realized, tip: [el$("div", "", r.item), (() => { const d = el$("div", "", "Profit (sales − paid): "); d.append(U.coin(r.realized, { signed: true, tone: true, trim: false })); return d; })()] })),
      { onPick: (r) => select(r.id, true), fmt: signedShort, signed: true, aria: "Profit or loss from sales per item", empty: "Profit per item shows here once you record a sale." });
  });

  // ---------- levelling planner ----------
  WOW.lvp = "";
  const lvSel = document.querySelector("#lv-prof");
  if (lvSel) lvSel.addEventListener("change", () => { WOW.lvp = lvSel.value; ["lv_rows", "lv_note"].forEach((n) => dash.draw(n)); });
  const lvProf = () => { const m = skillMap(); return m.has(WOW.lvp) ? WOW.lvp : [...m.keys()].sort()[0] || ""; };
  dash.draw("lv_sel", (el) => {
    const m = skillMap(), list = [...m.keys()].sort(), cur = lvProf();
    if (!list.length) { el.replaceChildren(el$("option", "", "No profession levels from the game yet")); return; }
    el.replaceChildren(...list.map((p) => { const o = el$("option", "", p + " (level " + m.get(p) + ")"); o.value = p; if (p === cur) o.selected = true; return o; }));
  });
  const lvRows = () => {
    const p = lvProf(), L = skillMap().get(p);
    if (!p) return [];
    return rowsOf("recipe_margins").filter((r) => r.p === p && r.lvl != null && r.lvl <= L && r.lvl >= L - 30 && r.cost != null && r.price != null)
      .map((r) => Object.assign({ net: r.cost - Math.round(r.price * 0.95) }, r)).sort((x, y) => x.net - y.net).slice(0, 10);
  };
  dash.draw("lv_note", (el) => {
    if (D("recipe_margins").status !== "ok") { el.textContent = ""; return; }
    el.textContent = !lvProf() ? "No profession levels from the game yet. Connect your game file at the top of the page." : lvRows().length ? "" : "No priced recipes with a known required level in your range. Recipes taught by trainers are not included.";
  });
  dash.draw("lv_rows", (tb) => {
    if (!ready(tb, ["recipe_margins"])) return;
    tb.replaceChildren(...lvRows().map((r) => { const nc = nameCell(r.name, r.out); delete nc.dataset.tip; const t = tr(r.id, [nc, r.lvl, U.coin(r.cost), U.coin(Math.round(r.price * 0.95)), U.coin(-r.net, { signed: true, tone: true }), soldCell(r.sold_day, r.id)], r.out); t.dataset.recipe = r.id; return t; }));
  });

  // ---------- gold ----------
  const goldRows = () => (D("gold_saved").status === "ok" ? D("gold_saved").data : []).map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount) })).filter((r) => r.date && isFinite(r.amount)).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  const goalRow = () => { const g = D("goal_saved").status === "ok" ? D("goal_saved").data[0] : null; return g && Number(g.target) > 0 ? { id: g.id, target: Number(g.target), by: g.by || "" } : null; };
  const setBig = (el, node) => { el.classList.remove("dash-skeleton"); el.replaceChildren(node instanceof Node ? node : document.createTextNode(node)); };
  dash.draw("goal_now", (el) => {
    if (!ready(el, ["goal_saved"])) return;
    const t = goalRow();
    if (!t) { U.empty(el, "No goal saved yet. Tell Claude your goal."); return; }
    const box = el$("div", "mini"); box.append(statCell("Goal", U.coin(t.target, { trim: true })), statCell("By", t.by || "no date"));
    el.replaceChildren(box);
  });
  dash.draw("g_now", (el) => { if (!ready(el, ["gold_saved"])) return; const g = goldRows(); setBig(el, g.length ? U.coin(g[g.length - 1].amount, { trim: true }) : "Not read yet"); });
  dash.draw("g_net", (el) => {
    if (!ready(el, ["gold_saved", "portfolio"])) return;
    const g = goldRows(), P = rowsOf("portfolio")[0];
    setBig(el, g.length && P ? U.coin(g[g.length - 1].amount + (P.value || 0), { trim: true }) : "—");
  });
  dash.draw("g_goal", (el) => {
    if (!ready(el, ["gold_saved", "goal_saved"])) return;
    const g = goldRows(), t = goalRow();
    setBig(el, !t ? "No goal set" : !g.length ? "Not read yet" : U.pct(g[g.length - 1].amount / t.target));
  });
  dash.draw("gold_rows", (tb) => {
    if (!ready(tb, ["gold_saved"])) return;
    const g = goldRows();
    if (!g.length) { const r = el$("tr"), td = el$("td", "muted", "No entries yet."); td.colSpan = 4; r.append(td); tb.replaceChildren(r); return; }
    tb.replaceChildren(...g.map((r, i) => tr(r.id, [r.date, U.coin(r.amount), i ? U.coin(r.amount - g[i - 1].amount, { signed: true, tone: true }) : "—", ""])).reverse());
  });

  // ---------- info ----------
  dash.draw("ch_runs", (el) => { if (!ready(el, ["runs_view"])) return; U.timeline(el, rowsOf("runs_view")); });
  const resultLabel = { new_snapshot: "New prices saved", no_change: "Ran, prices unchanged", failed: "Failed", legacy: "Earlier snapshot" };
  dash.draw("run_rows", (tb) => {
    if (!ready(tb, ["runs_view"])) return;
    tb.replaceChildren(...rowsOf("runs_view").map((r) => tr(r.key, [U.when(r.t), tn(resultLabel[r.result] || r.result, r.result === "new_snapshot" ? "up" : r.result === "failed" ? "down" : ""), r.snap_t ? U.when(r.snap_t) : "—",
      r.items == null ? "—" : U.num(r.items), r.listings == null ? "—" : U.num(r.listings), r.seconds == null ? "—" : String(r.seconds), r.note || ""])));
  });
})();
