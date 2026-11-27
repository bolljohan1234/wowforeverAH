// AH Tracker runtime for the hosted page (GitHub Pages).
// It gives the page code the same small "dash" surface the Claude artifact had:
//   dash.data(id) -> {status: "loading"|"ok"|"error", data, error}
//   dash.calc(id, {inputs, fn})   a value worked out from other datasets, kept until the data changes
//   dash.draw(name, fn)           fn(el) for every element with data-draw="name"; dash.draw(name) draws again
//   dash.onData(fn)               called whenever any data changes, before everything is drawn again
//   dash.setLink(tab)             remembers the open tab in the address
// Public auction house data comes from data/*.json next to this page (rebuilt by GitHub Actions after every collector run).
// Your own data (holdings, gold, trades, professions, goal) is read straight from WoWForeverCompanion.lua on your PC and never leaves it.
(function () {
  const PUBLIC = ["history", "snaps", "names", "runs", "ladder", "ladderhist", "salesprices", "expiredprices", "unnamed", "variants", "cats", "icons", "profs", "recipes"];
  const DS = new Map();      // dataset id -> {status, data, error}
  const CALC = new Map();    // calc id -> {inputs, fn}
  const CC = new Map();      // calc id -> cached result
  const DRAW = new Map();    // draw name -> fn
  const LISTEN = [];
  let pending = false;

  const set = (id, v) => { DS.set(id, v); };
  function changed() {
    CC.clear();
    LISTEN.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; drawAll(); });
  }
  function data(id) {
    if (DS.has(id)) return DS.get(id);
    const c = CALC.get(id);
    if (!c) return { status: "error", data: null, error: new Error("Unknown data: " + id) };
    if (CC.has(id)) return CC.get(id);
    let out;
    const ins = c.inputs.map(data);
    const bad = ins.find((d) => d.status === "error");
    if (bad) out = { status: "error", data: null, error: bad.error };
    else if (ins.some((d) => d.status !== "ok")) out = { status: "loading", data: null };
    else {
      try { out = { status: "ok", data: c.fn(...ins.map((d) => d.data)) }; }
      catch (e) { console.error("calc " + id, e); out = { status: "error", data: null, error: e }; }
    }
    CC.set(id, out);
    return out;
  }
  function drawOne(name) {
    const fn = DRAW.get(name);
    if (!fn) return;
    document.querySelectorAll('[data-draw="' + name + '"]').forEach((el) => { try { fn(el); } catch (e) { console.error("draw " + name, e); } });
  }
  function drawAll() { for (const name of DRAW.keys()) drawOne(name); }

  window.dash = {
    data: data,
    calc: (id, spec) => { CALC.set(id, spec); },
    draw: (name, fn) => { if (fn) { DRAW.set(name, fn); drawOne(name); } else drawOne(name); },
    onData: (fn) => { LISTEN.push(fn); },
    setLink: (tab) => { try { history.replaceState(null, "", "#" + tab); } catch (e) { /* ignore */ } },
  };

  // ---------- public data ----------
  PUBLIC.forEach((id) => set(id, { status: "loading", data: null }));
  set("notes", { status: "ok", data: [] });
  const bust = "?v=" + Math.floor(Date.now() / 600000);   // a new copy at most every 10 minutes
  Promise.all(PUBLIC.map((id) => fetch("data/" + id + ".json" + bust).then((r) => { if (!r.ok) throw new Error(id + ".json: HTTP " + r.status); return r.json(); })
    .then((j) => ({ id: id, ok: true, rows: Array.isArray(j) ? j : j.rows || [] }), (e) => ({ id: id, ok: false, error: e }))))
    .then((all) => { all.forEach((r) => set(r.id, r.ok ? { status: "ok", data: r.rows } : { status: "error", data: null, error: r.error })); changed(); });

  // ---------- your game file ----------
  set("gamedb", { status: "ok", data: [] });
  const day = (sec) => { const d = new Date(sec * 1000); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const E = (m) => window.LUA.entries(m);
  dash.calc("holdings_saved", {
    inputs: ["gamedb"],
    fn: (g) => {
      const db = g[0]; if (!db) return [];
      const out = [];
      for (const [name, c] of E(db.chars)) {
        const items = {}, I = c.items || {};
        ["bags", "bank", "mail", "auctions", "equipped"].forEach((k, loc) => { for (const [id, n] of E(I[k])) (items[id] || (items[id] = [0, 0, 0, 0, 0]))[loc] += Number(n) || 0; });
        for (const k of Object.keys(items)) if (!items[k].some(Boolean)) delete items[k];
        const at = Math.max(0, ...Object.values(c.at || {}).map(Number).filter(isFinite));
        out.push({ id: name, char: name, cls: c.class || null, money: Number(c.money) || 0, items: items, at: at ? at * 1000 : null, src: "addon" });
      }
      const W = db.warband && db.warband.items;
      if (W && E(W).length) { const items = {}; for (const [id, n] of E(W)) items[id] = [0, Number(n) || 0, 0, 0, 0]; out.push({ id: "warband", char: "Warband bank", cls: null, money: 0, items: items, at: db.warband.at ? db.warband.at * 1000 : null, src: "addon" }); }
      return out;
    },
  });
  // one total per day: each character's gold that day, or the last known amount before it
  dash.calc("gold_saved", {
    inputs: ["gamedb"],
    fn: (g) => {
      const db = g[0]; if (!db) return [];
      const log = E(db.moneyLog).map(([d, m]) => [String(d), m]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const last = new Map(), out = [];
      for (const [d, m] of log) {
        for (const [k, v] of E(m)) last.set(k, Number(v) || 0);
        let sum = 0; for (const v of last.values()) sum += v;
        out.push({ id: d, date: d, amount: sum, src: "addon" });
      }
      // today's figure from what every character holds now (characters that never logged gold are counted too)
      const now = E(db.chars).reduce((s, [, c]) => s + (Number(c.money) || 0), 0), today = day(Date.now() / 1000);
      const t = out.find((r) => r.date === today);
      if (t) t.amount = now; else out.push({ id: today, date: today, amount: now, src: "addon" });
      return out;
    },
  });
  dash.calc("skills_saved", {
    inputs: ["gamedb"],
    fn: (g) => {
      const db = g[0]; if (!db) return [];
      const best = new Map();
      for (const [, c] of E(db.chars)) for (const [p, l] of E(c.profs)) best.set(String(p), Math.max(best.get(String(p)) || 0, Number(l) || 0));
      return [...best].map(([p, lvl]) => ({ id: p, p: p, lvl: lvl, src: "addon" }));
    },
  });
  dash.calc("goal_saved", {
    inputs: ["gamedb"],
    fn: (g) => { const db = g[0], G = db && db.legacy && db.legacy.goal; return G && Number(G.target) > 0 ? [{ id: "goal", target: Number(G.target), by: G.by || "" }] : []; },
  });
  // purchases and sales from the auction house mails the addon read, plus the ones typed in before the addon existed
  dash.calc("ledger_saved", {
    inputs: ["gamedb", "names"],
    fn: (g, names) => {
      const db = g[0]; if (!db) return [];
      const nm = new Map(names.map((r) => [r.id, r.name])), byName = new Map(names.map((r) => [String(r.name).toLowerCase(), r.id]));
      const out = [], seen = new Set();
      for (const [k, r] of E(db.legacy && db.legacy.purchases)) {
        const id = Number(r.item_id);
        out.push({ id: "legacy-" + k, item: r.item || nm.get(id) || "Item " + id, item_id: id, unit: Number(r.unit) || 0, qty: Number(r.qty) || 0, date: r.date, how: r.how || "bought", src: "legacy" });
      }
      for (const [, e] of E(db.events)) {
        if (e.kind !== "buy" && e.kind !== "sell") continue;
        const qty = Number(e.qty) || 0, total = Number(e.total) || 0;
        const id = e.id != null ? Number(e.id) : byName.get(String(e.name || "").toLowerCase());
        if (!(qty > 0) || !(total > 0) || id == null) continue;
        const key = "addon|" + e.char + "|" + e.kind + "|" + e.t + "|" + id + "|" + qty + "|" + total;
        if (seen.has(key)) continue;
        seen.add(key);
        // a sale is booked at what you received per item: the price minus the 5% auction cut
        const unit = e.kind === "sell" ? Math.round((total - (Number(e.cut) || 0)) / qty) : Math.round(total / qty);
        out.push({ id: key, item: nm.get(id) || e.name || "Item " + id, item_id: id, unit: unit, qty: qty, date: day(Number(e.t) || Date.now() / 1000), how: e.kind === "sell" ? "sold" : "bought", src: "addon", char: e.char, key: key });
      }
      return out;
    },
  });

  // ---------- connecting the file: picked once, remembered by this browser, read again on every visit and when you come back to the tab ----------
  const IDB = {
    open: () => new Promise((res, rej) => { const r = indexedDB.open("ahtracker", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
    get: async (k) => { const d = await IDB.open(); return new Promise((res, rej) => { const r = d.transaction("kv").objectStore("kv").get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    put: async (k, v) => { const d = await IDB.open(); return new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
    del: async (k) => { const d = await IDB.open(); return new Promise((res) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").delete(k); t.oncomplete = () => res(); }); },
  };
  const canPick = "showOpenFilePicker" in window;
  const S = { handle: null, mtime: 0, loadedAt: 0, name: "", state: "none", msg: "" };
  window.GAMEFILE = { loaded: () => S.state === "ok" };

  async function readFile(file) {
    if (file.lastModified === S.mtime && S.state === "ok") return;
    const text = await file.text();
    const root = window.LUA.parse(text), db = root.WoWForeverCompanionDB;
    if (!db || !db.chars) throw new Error("This does not look like WoWForeverCompanion.lua");
    S.mtime = file.lastModified; S.loadedAt = Date.now(); S.name = file.name; S.state = "ok"; S.msg = "";
    set("gamedb", { status: "ok", data: [db] });
    changed();
    paint();
  }
  async function readHandle(ask) {
    if (!S.handle) return;
    let p = await S.handle.queryPermission({ mode: "read" });
    if (p !== "granted" && ask) p = await S.handle.requestPermission({ mode: "read" });
    if (p !== "granted") { S.state = "ask"; paint(); return; }
    try { await readFile(await S.handle.getFile()); }
    catch (e) { S.state = "error"; S.msg = e && e.message ? e.message : String(e); paint(); }
  }
  async function pick() {
    try {
      const [h] = await window.showOpenFilePicker({ id: "wowsv", types: [{ description: "WoW saved variables", accept: { "text/plain": [".lua"] } }], multiple: false });
      S.handle = h; S.mtime = 0;
      await IDB.put("gamefile", h);
      await readHandle(true);
    } catch (e) { if (e && e.name !== "AbortError") { S.state = "error"; S.msg = e.message; paint(); } }
  }
  async function forget() {
    await IDB.del("gamefile");
    S.handle = null; S.state = "none"; S.mtime = 0;
    set("gamedb", { status: "ok", data: [] }); changed(); paint();
  }
  function btn(text, fn) { const b = document.createElement("button"); b.type = "button"; b.className = "btn sm"; b.textContent = text; b.onclick = fn; return b; }
  function paint() {
    const el = document.getElementById("gamefile");
    if (!el) return;
    const span = (cls, t) => { const s = document.createElement("span"); s.className = cls; s.textContent = t; return s; };
    const kids = [span("lbl", "Your game file")];
    const hm = (t) => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
    if (S.state === "ok") {
      const s = span("pill", "✓ " + S.name + ", saved by the game " + hm(S.mtime)); s.dataset.tone = "up"; s.title = "Read from your PC. It is read again every time you open this page or come back to it.";
      kids.push(s);
      if (canPick) kids.push(btn("Read again", () => readHandle(true)), btn("Forget this file", forget));
      else kids.push(btn("Pick the file again", () => input.click()));
    } else if (S.state === "ask") {
      kids.push(btn("Allow reading " + (S.handle ? S.handle.name : "the file"), () => readHandle(true)), span("sm", "The browser asks once per visit unless you choose \"Allow on every visit\"."));
    } else {
      if (S.state === "error") { const s = span("pill", "Could not read the file: " + S.msg); s.dataset.tone = "down"; kids.push(s); }
      kids.push(btn("Connect WoWForeverCompanion.lua", () => (canPick ? pick() : input.click())),
        span("sm", "Find it in World of Warcraft\\_forever_\\WTF\\Account\\<your account>\\SavedVariables. It stays on your PC; only this page in your browser reads it." + (canPick ? "" : " This browser cannot remember the file, so pick it again on each visit (Chrome or Edge can remember it).")));
    }
    el.replaceChildren(...kids);
  }
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".lua"; input.hidden = true;
  input.addEventListener("change", async () => { const f = input.files && input.files[0]; if (!f) return; S.mtime = 0; try { await readFile(f); } catch (e) { S.state = "error"; S.msg = e.message; paint(); } input.value = ""; });
  document.body.append(input);
  async function boot() {
    paint();
    if (!canPick) return;
    try { S.handle = (await IDB.get("gamefile")) || null; } catch (e) { S.handle = null; }
    if (S.handle) await readHandle(false);
    paint();
  }
  const again = () => { if (document.visibilityState === "visible" && S.handle && S.state === "ok") readHandle(false); };
  window.addEventListener("focus", again);
  document.addEventListener("visibilitychange", again);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
