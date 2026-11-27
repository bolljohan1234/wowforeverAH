// Formatting helpers and chart drawing used by app.js. Shared through window.WOWUI.
(function () {
  const H = 3600e3;
  // muted colours that sit with the dark slate and brass theme; nine of them, so a pie with seven named slices and "Other" never repeats one.
  // Green and red are kept for gains and losses only.
  const pal = ["#d4a94a", "#6f95c8", "#4fa59a", "#c97c52", "#9a7cb6", "#a3b46a", "#c4697c", "#7fb3d1", "#b9a07a"];
  const WH = "https://www.wowhead.com/forever/item=";
  const el$ = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const tone = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");

  // Gold / Silver / Copper, each in its own colour; with opts.tone the whole amount is green (+) or red (−) instead.
  function coin(c, o) {
    o = o || {};
    const span = el$("span", "coin");
    if (c == null || !isFinite(c)) { span.textContent = "—"; return span; }
    const a = Math.round(Math.abs(c));
    const g = Math.floor(a / 10000), s = Math.floor((a % 10000) / 100), cu = a % 100;
    const sign = c < 0 ? "−" : o.signed && c > 0 ? "+" : "";
    const tinted = o.tone && Math.round(c) !== 0;
    if (tinted) span.dataset.tone = tone(c);
    if (sign) span.append(sign);
    const parts = [[g, "g", "Gold"], [s, "s", "Silver"], [cu, "c", "Copper"]].filter((p) => p[0] > 0);
    if (!parts.length) parts.push([0, "c", "Copper"]);
    parts.forEach((p, i) => { if (i) span.append(" "); span.append(el$("span", tinted ? "" : p[1], p[0].toLocaleString("en") + p[1])); });
    span.title = sign + parts.map((p) => p[0].toLocaleString("en") + " " + p[2]).join(", ");
    return span;
  }
  function coinText(c, signed) {
    if (c == null || !isFinite(c)) return "—";
    const a = Math.round(Math.abs(c)), g = Math.floor(a / 10000), s = Math.floor((a % 10000) / 100), cu = a % 100;
    const t = [g ? g.toLocaleString("en") + "g" : "", s ? s + "s" : "", cu || !(g || s) ? cu + "c" : ""].filter(Boolean).join(" ");
    return (c < 0 ? "−" : signed && c > 0 ? "+" : "") + t;
  }
  // compact amount for chart axes, bar labels and tight spots: always g/s/c (e.g. 14g 96s 25c), never decimals
  function short(c) { return coinText(c); }
  const pct = (p, signed) => (p == null || !isFinite(p) ? "—" : (p < 0 ? "−" : signed && p > 0 ? "+" : "") + Math.abs(p * 100).toFixed(1) + "%");
  const num = (v, d) => (v == null || !isFinite(v) ? "—" : v.toLocaleString("en", { maximumFractionDigits: d == null ? 0 : d }));
  // one date style everywhere: YYYY-MM-DD and 24-hour HH:MM, in your local time
  const fmtDay = d3.timeFormat("%Y-%m-%d"), fmtHM = d3.timeFormat("%H:%M"), fmtFull = d3.timeFormat("%Y-%m-%d %H:%M");
  const when = (t) => (t == null ? "—" : fmtFull(new Date(t)));
  const ago = (t) => {
    if (t == null) return "";
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 60 ? m + " min ago" : m < 2880 ? Math.floor(m / 60) + " h " + (m % 60) + " min ago" : Math.floor(m / 1440) + " days ago";
  };
  // 24-hour clock: HH:MM, with the date at midnight (or the date only on long ranges)
  // Every time chart shares one time range (set by the page's range buttons) and the same 5 ticks, written YYYY-MM-DD over HH:MM,
  // so the same moment sits at the same place on every chart.
  const TIME = { domain: null };
  const timeDomain = (pts) => (TIME.domain ? TIME.domain() : [d3.min(pts, (p) => p.t), d3.max(pts, (p) => p.t)]);
  function timeAxis(g, x, t0, t1) {
    const ticks = d3.range(5).map((i) => new Date(t0 + ((t1 - t0) * i) / 4));
    g.call(d3.axisBottom(x).tickValues(ticks).tickFormat(() => "").tickSizeOuter(0)).call((a) => a.selectAll("line,path").style("stroke", "var(--cds-chart-axis)"));
    g.selectAll(".tick text").each(function (d, i) {
      const t = d3.select(this).text(null).attr("text-anchor", i === 0 ? "start" : i === 4 ? "end" : "middle");
      t.append("tspan").attr("x", 0).attr("dy", "0.71em").text(fmtDay(d));
      t.append("tspan").attr("x", 0).attr("dy", "1.15em").text(fmtHM(d));
    });
  }

  function empty(el, text) { el.replaceChildren(el$("p", "note", text)); }

  function tooltip(el, svg, lines) {
    const tip = el$("div", "tip");
    el.append(tip);
    return {
      show(ev, node) {
        tip.replaceChildren(...lines(node));
        tip.style.display = "block";
        const [px, py] = d3.pointer(ev, el);
        const w = tip.offsetWidth, hgt = tip.offsetHeight;
        tip.style.left = Math.max(0, Math.min(px + 12, el.clientWidth - w)) + "px";
        tip.style.top = Math.max(0, py - hgt - 8) + "px";
      },
      hide() { tip.style.display = "none"; },
    };
  }
  const line$ = (t) => el$("div", "", t);
  // width the chart may really use: the box minus its padding and border
  const availW = (el) => { const cs = getComputedStyle(el); return el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0); };
  const ICON = { of: null }; // set by the page: item id -> icon data URL
  // Faint glowing outline on whatever is highlighted
  function glowOn() {
    const n = d3.select(this), c = getComputedStyle(this).fill;
    n.style("filter", "drop-shadow(0 0 5px " + c + ") drop-shadow(0 0 2px " + c + ")").style("stroke", "rgba(255,255,255,.7)").style("stroke-width", 1.5).style("fill-opacity", 1);
  }
  function glowOff() { d3.select(this).style("filter", null).style("stroke", null).style("stroke-width", null).style("fill-opacity", null); }
  const glow = (sel) => sel.on("mouseenter.glow", glowOn).on("mouseleave.glow", glowOff);

  // series: [{label,color,pts:[{t,v}]}], ref: [{label,v}], opts: {yfmt, tipfmt, height, zero, empty, aria}
  function lineChart(el, series, ref, o) {
    if (!series.flatMap((s) => s.pts).length) return empty(el, o.empty || "No data yet.");
    let [t0, t1] = timeDomain(series.flatMap((s) => s.pts));
    if (t0 === t1) { t0 -= 12 * H; t1 += 12 * H; }
    series = series.map((s) => Object.assign({}, s, { pts: s.pts.filter((p) => p.t >= t0 && p.t <= t1) }));
    const all = series.flatMap((s) => s.pts);
    if (!all.length) return empty(el, "No data in this time range.");
    const W = Math.max(280, availW(el)), Hh = (o.height || 240) + 14;
    const vals = all.map((p) => p.v).concat((ref || []).map((r) => r.v));
    let lo = o.zero ? 0 : d3.min(vals), hi = d3.max(vals);
    const pad = (hi - lo) * 0.12 || hi * 0.15 || 1;
    if (!o.zero) lo = lo < 0 ? lo - pad : Math.max(0, lo - pad);   // losses go below zero
    hi += pad;
    const probe = d3.scaleLinear([lo, hi], [Hh - 28, 8]).nice(5);
    const maxLab = d3.max(probe.ticks(5), (v) => o.yfmt(v).length) || 4;
    const m = { l: Math.max(72, Math.round(maxLab * 6.8 + 14)), r: 40, t: 8, b: 42 };   // same edges on every chart, so times line up
    const x = d3.scaleTime([new Date(t0), new Date(t1)], [m.l, W - m.r]);
    const y = d3.scaleLinear([lo, hi], [Hh - m.b, m.t]).nice(5);

    const legend = el$("div", "legend");
    series.forEach((s) => { const sp = el$("span"); const sw = el$("i", "sw"); sw.style.background = s.color; sp.append(sw);
      if (s.id != null) { sp.dataset.tip = s.id; const src = ICON.of ? ICON.of(s.id) : null; if (src) { const im = el$("img", "ico"); im.src = src; im.alt = ""; im.width = 16; im.height = 16; sp.append(im); } }
      sp.append(s.label); legend.append(sp); });
    (ref || []).forEach((r) => { const sp = el$("span"); const sw = el$("i", "sw ref"); if (r.color) sw.style.borderColor = r.color; sp.append(sw, r.label); legend.append(sp); });

    const svg = d3.create("svg").attr("class", "wow-chart").attr("width", W).attr("height", Hh).attr("viewBox", [0, 0, W, Hh]).attr("role", "img").attr("aria-label", o.aria || "Line chart");
    timeAxis(svg.append("g").attr("transform", "translate(0," + (Hh - m.b) + ")"), x, t0, t1);
    svg.append("g").attr("transform", "translate(" + m.l + ",0)")
      .call(d3.axisLeft(y).ticks(5).tickFormat(o.yfmt).tickSize(-(W - m.l - m.r)))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll(".tick line").style("stroke", "var(--cds-chart-grid)"));
    (ref || []).forEach((r) => {
      svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(r.v)).attr("y2", y(r.v)).style("stroke", r.color || "var(--cds-chart-reference)").style("stroke-opacity", r.color ? 0.85 : 1).attr("stroke-width", 1.5).attr("stroke-dasharray", "5 4");
    });
    series.forEach((s) => {
      if (s.pts.length > 1) svg.append("path").datum(s.pts).attr("fill", "none").attr("stroke-width", 2).style("stroke", s.color).attr("d", d3.line().x((p) => x(p.t)).y((p) => y(p.v)));
      svg.selectAll(null).data(s.pts.length > 60 ? [] : s.pts).join("circle").attr("cx", (p) => x(p.t)).attr("cy", (p) => y(p.v)).attr("r", 3.2).style("fill", s.color);
    });
    const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
    el.replaceChildren(legend, svg.node());
    const tip = tooltip(el, svg, (t) => [line$(when(t))].concat(series.map((s) => {
      const k = s.pts.findIndex((q) => q.t === t), p = s.pts[k];
      const row = line$(s.label + ": "); row.append(p ? (o.tipfmt || o.yfmt)(p.v) : "—");
      if (o.tipextra && p) { const ex = o.tipextra(p); if (ex) row.append(...ex); }
      if (o.deltas && p) {
        const d = (b) => { const v = b && b.v > 0 ? (p.v - b.v) / b.v : null; const sp = el$("span", "", pct(v, true)); if (v) sp.dataset.tone = v > 0 ? "up" : "down"; return sp; };
        if (k > 0) row.append("  (", d(s.pts[k - 1]), " vs last, ", d(s.pts[0]), " vs start"); else row.append("  (first point");
        if (s.paid != null) row.append(", ", d({ v: s.paid }), " vs paid");
        row.append(")");
      }
      return row;
    }).concat((ref || []).map((r) => { const row = line$(r.label + ": "); row.append((o.tipfmt || o.yfmt)(r.v)); row.style.opacity = ".9"; return row; }))));
    const hl = svg.append("g").style("pointer-events", "none");
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
      .on("mousemove", (ev) => {
        const px = d3.pointer(ev, svg.node())[0], t = times.reduce((b, c) => (Math.abs(x(c) - px) < Math.abs(x(b) - px) ? c : b));
        tip.show(ev, t);
        hl.selectAll("*").remove();
        hl.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", m.t).attr("y2", Hh - m.b).style("stroke", "var(--cds-chart-axis)").attr("stroke-dasharray", "3 3");
        series.forEach((s) => { const p = s.pts.find((q) => q.t === t); if (p) hl.append("circle").attr("cx", x(t)).attr("cy", y(p.v)).attr("r", 5.5).style("fill", s.color).style("stroke", "rgba(255,255,255,.75)").style("stroke-width", 1.5).style("filter", "drop-shadow(0 0 5px " + s.color + ") drop-shadow(0 0 2px " + s.color + ")"); });
      })
      .on("mouseleave", () => { tip.hide(); hl.selectAll("*").remove(); });
  }

  // rows: [{label, v, tip:[lines], color?}], opts: {fmt, signed, empty, aria}. Values are printed in a column at the right.
  function hbar(el, rows, o) {
    if (!rows.length) return empty(el, o.empty || "No data yet.");
    const W = Math.max(280, availW(el)), rowH = 26, Hh = rows.length * rowH + 8;
    const icoOf = o.iconOf || ICON.of, ico = icoOf ? 24 : 0;
    const maxLab = d3.max(rows, (r) => r.label.length);
    const labW = Math.min(Math.round(W * 0.36), Math.round(Math.min(maxLab, 30) * 7 + ico + 14));
    const labChars = Math.max(6, Math.floor((labW - ico - 12) / 7));
    const valW = Math.round(d3.max(rows, (r) => o.fmt(r.v).length) * 6.4 + 10);
    const m = { l: labW, r: valW + 8 };
    const ext = d3.extent(rows, (r) => r.v);
    const lo = Math.min(0, ext[0]), hi = Math.max(0, ext[1]) || 1;
    const x = d3.scaleLinear([lo, hi], [m.l, W - m.r]);
    const svg = d3.create("svg").attr("class", "wow-chart").attr("width", W).attr("height", Hh).attr("viewBox", [0, 0, W, Hh]).attr("role", "img").attr("aria-label", o.aria || "Bar chart");
    rows.forEach((r, i) => {
      const yy = i * rowH + 4;
      const lab = r.label.length > labChars ? r.label.slice(0, labChars - 1) + "…" : r.label;
      let host = svg;
      if (r.id != null) host = svg.append("a").attr("href", WH + r.id).attr("target", "_blank").attr("rel", "noopener noreferrer").attr("data-tip", r.id).attr("class", "wh-lab");
      const src = icoOf && r.id != null ? icoOf(r.id) : null;
      if (src) host.append("image").attr("href", src).attr("x", 0).attr("y", yy + (rowH - 18) / 2).attr("width", 18).attr("height", 18);
      host.append("text").attr("x", ico).attr("y", yy + rowH / 2).attr("dy", "0.32em").attr("text-anchor", "start").text(lab);
      svg.append("rect").attr("class", "bar").attr("x", Math.min(x(0), x(r.v))).attr("y", yy + 3).attr("width", Math.max(1, Math.abs(x(r.v) - x(0)))).attr("height", rowH - 8).attr("rx", 2)
        .style("fill", r.color || (o.signed ? (r.v >= 0 ? "var(--color-ok)" : "var(--color-bad)") : pal[0])).style("cursor", (r.id != null || r.group) && o.onPick ? "pointer" : null).datum(r);
      svg.append("text").attr("x", W - 4).attr("y", yy + rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end").text(o.fmt(r.v));
    });
    svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", Hh).style("stroke", "var(--cds-chart-axis)");
    el.replaceChildren(svg.node());
    const tip = tooltip(el, svg, (r) => r.tip || [line$(r.label), line$(o.fmt(r.v))]);
    glow(svg.selectAll("rect.bar")).on("mousemove", (ev, r) => tip.show(ev, r)).on("mouseleave", tip.hide).on("click", (ev, r) => { if (o.onPick && (r.id != null || r.group)) o.onPick(r); });
  }


  // slices: [{label, v, color?, tip?:[nodes]}], opts: {fmt, aria, empty}
  function pie(el, slices, o) {
    slices = slices.filter((s) => s.v > 0);
    if (!slices.length) return empty(el, o.empty || "No data yet.");
    const total = d3.sum(slices, (s) => s.v);
    const size = Math.min(210, Math.max(140, Math.floor(availW(el) * 0.44)));
    const svg = d3.create("svg").attr("class", "wow-chart").attr("width", size).attr("height", size).attr("viewBox", [0, 0, size, size]).attr("role", "img").attr("aria-label", o.aria || "Pie chart");
    const g = svg.append("g").attr("transform", "translate(" + size / 2 + "," + size / 2 + ")");
    const arc = d3.arc().innerRadius(size * 0.2).outerRadius(size / 2 - 4);
    const arcs = d3.pie().sort(null).value((s) => s.v)(slices);
    g.selectAll("path").data(arcs).join("path").attr("class", "slice").attr("d", arc)
      .style("fill", (a, i) => a.data.color || pal[i % pal.length]).style("stroke", "var(--color-bg)").style("stroke-width", 2);
    const wrap = el$("div", "piewrap");
    const legend = el$("ul", "pielegend");
    slices.forEach((s, i) => {
      const li = el$("li");
      const sw = el$("span", "sw"); sw.style.background = s.color || pal[i % pal.length];
      let lab = el$("span", "plabel", s.label);
      if (s.id != null) { lab = el$("a", "plabel wh", s.label); lab.href = WH + s.id; lab.target = "_blank"; lab.rel = "noopener noreferrer"; lab.dataset.tip = s.id; }
      const isrc = (o.iconOf || ICON.of) && s.id != null ? (o.iconOf || ICON.of)(s.id) : null;
      if (isrc) { const im = el$("img", "ico"); im.src = isrc; im.alt = ""; im.width = 18; im.height = 18; li.append(sw, im, lab, el$("span", "pval", pct(s.v / total))); }
      else li.append(sw, lab, el$("span", "pval", pct(s.v / total)));
      legend.append(li);
    });
    wrap.append(svg.node(), legend);
    el.replaceChildren(wrap);
    const tip = tooltip(el, svg, (a) => a.data.tip || [line$(a.data.label), line$(pct(a.data.v / total) + " (" + (o.fmt ? o.fmt(a.data.v) : num(a.data.v)) + ")")]);
    glow(svg.selectAll("path.slice")).style("cursor", o.onPick ? "pointer" : null).on("mousemove", (ev, a) => tip.show(ev, a)).on("mouseleave", tip.hide).on("click", (ev, a) => { if (o.onPick && a.data.id != null) o.onPick(a.data); });
  }

  // pts: [{x,y,label}], opts: {xfmt,yfmt,xlabel,ylabel,label(n)}
  function scatter(el, pts, o) {
    if (!pts.length) return empty(el, o.empty || "No data yet.");
    const W = Math.max(280, availW(el)), Hh = o.height || 300, m = { l: 52, r: 16, t: 28, b: 40 };
    const xe = d3.extent(pts, (p) => p.x), ye = d3.extent(pts, (p) => p.y);
    const x = d3.scaleLinear(o.xdomain || [Math.min(xe[0], 0), Math.max(xe[1], 0) || 1], [m.l, W - m.r]).nice();
    const ylo = o.ylog ? Math.max(1, Math.pow(10, Math.floor(Math.log10(Math.max(1, ye[0]))))) : 0;
    const y = o.ylog ? d3.scaleLog([ylo, Math.pow(10, Math.ceil(Math.log10(Math.max(ye[1], ylo * 10))))], [Hh - m.b, m.t]) : d3.scaleSymlog([0, ye[1] || 1], [Hh - m.b, m.t]).nice();
    const yticks = o.ylog ? y.ticks(8).filter((v) => Math.abs(Math.log10(v) % 1) < 1e-9) : null;
    const svg = d3.create("svg").attr("class", "wow-chart").attr("width", W).attr("height", Hh).attr("viewBox", [0, 0, W, Hh]).attr("role", "img").attr("aria-label", o.aria || "Scatter chart");
    svg.append("g").attr("transform", "translate(0," + (Hh - m.b) + ")").call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 90))).tickFormat(o.xfmt)).call((g) => g.selectAll("line,path").style("stroke", "var(--cds-chart-axis)"));
    svg.append("g").attr("transform", "translate(" + m.l + ",0)").call((o.ylog ? d3.axisLeft(y).tickValues(yticks).tickFormat(d3.format("~s")) : d3.axisLeft(y).ticks(5, "~s")).tickSize(-(W - m.l - m.r))).call((g) => g.select(".domain").remove()).call((g) => g.selectAll(".tick line").style("stroke", "var(--cds-chart-grid)"));
    svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", Hh - m.b).style("stroke", "var(--cds-chart-reference)").attr("stroke-dasharray", "4 4");
    svg.append("text").attr("x", (m.l + W - m.r) / 2).attr("y", Hh - 6).attr("text-anchor", "middle").text(o.xlabel);
    svg.append("text").attr("transform", "rotate(-90)").attr("x", -(Hh - m.b + m.t) / 2).attr("y", 12).attr("text-anchor", "middle").text(o.ylabel);
    svg.selectAll("circle.pt").data(pts).join("circle").attr("class", "pt").attr("cx", (p) => x(p.x)).attr("cy", (p) => y(p.y)).attr("r", 4).style("fill", pal[0]).style("fill-opacity", 0.65);
    // label the best few points, skipping any label that would sit on top of one already placed
    const ranked = pts.slice().sort((a, b) => (o.rank ? o.rank(b) - o.rank(a) : b.y - a.y)), top = [], boxes = [];
    for (const p of ranked) {
      if (top.length >= (o.labels || 6)) break;
      const bx = { x0: x(p.x) + 6, x1: x(p.x) + 6 + String(p.label).length * 6.4, y0: y(p.y) - 18, y1: y(p.y) - 2 }; p.below = y(p.y) - 18 < 4;
      if (p.below) { bx.y0 += 22; bx.y1 += 22; }
      if (bx.x1 > W - 4) { const w = bx.x1 - bx.x0; bx.x1 = x(p.x) - 6; bx.x0 = bx.x1 - w; p.left = true; }
      if (boxes.some((b) => bx.x0 < b.x1 && bx.x1 > b.x0 && bx.y0 < b.y1 && bx.y1 > b.y0)) continue;
      boxes.push(bx); top.push(p);
    }
    svg.selectAll("text.lbl").data(top).join("text").attr("class", "lbl").attr("x", (p) => (p.left ? x(p.x) - 6 : x(p.x) + 6)).attr("text-anchor", (p) => (p.left ? "end" : "start")).attr("y", (p) => (p.below ? y(p.y) + 16 : y(p.y) - 6)).text((p) => p.label);
    el.replaceChildren(svg.node());
    const tip = tooltip(el, svg, (p) => [line$(p.label), line$(o.xlabel + ": " + o.xfmt(p.x)), line$(o.ylabel + ": " + num(p.y, 1))]);
    glow(svg.selectAll("circle.pt")).style("cursor", o.onPick ? "pointer" : null).on("mousemove", (ev, p) => tip.show(ev, p)).on("mouseleave", tip.hide).on("click", (ev, p) => { if (o.onPick && p.id != null) o.onPick(p); });
  }

  // runs: [{t,result,run,snap_t,note}] -> dots on a time axis
  function timeline(el, runs, o) {
    if (!runs.length) return empty(el, "No runs recorded yet.");
    const W = Math.max(280, availW(el)), Hh = 124, m = { l: 72, r: 40, t: 14, b: 42 };
    const [t0, t1] = TIME.domain ? TIME.domain() : [d3.min(runs, (r) => r.t), Math.max(d3.max(runs, (r) => r.t), Date.now())];
    runs = runs.filter((r) => r.t >= t0 && r.t <= t1);
    const x = d3.scaleTime([new Date(t0), new Date(t1)], [m.l, W - m.r]);
    const color = { new_snapshot: "var(--color-ok)", no_change: "var(--cds-chart-muted)", failed: "var(--color-bad)", legacy: "var(--cds-chart-muted)" };
    const label = { new_snapshot: "New prices saved", no_change: "Ran, prices unchanged", failed: "Failed", legacy: "Earlier snapshot (time of file)" };
    const svg = d3.create("svg").attr("class", "wow-chart").attr("width", W).attr("height", Hh).attr("viewBox", [0, 0, W, Hh]).attr("role", "img").attr("aria-label", "Timeline of collector runs");
    timeAxis(svg.append("g").attr("transform", "translate(0," + (Hh - m.b) + ")"), x, t0, t1);
    svg.selectAll("circle.run").data(runs).join("circle").attr("class", "run").attr("cx", (r) => x(new Date(r.t))).attr("cy", 40).attr("r", 6)
      .style("fill", (r) => color[r.result] || "var(--cds-chart-muted)").style("fill-opacity", (r) => (r.result === "no_change" || r.result === "legacy" ? 0.55 : 1));
    svg.append("line").attr("x1", x(new Date(t1))).attr("x2", x(new Date(t1))).attr("y1", 20).attr("y2", Hh - m.b).style("stroke", "var(--cds-chart-reference)").attr("stroke-dasharray", "3 3");
    svg.append("text").attr("x", x(new Date(t1)) - 4).attr("y", 14).attr("text-anchor", "end").text("now");
    const legend = el$("div", "legend");
    Object.keys(label).forEach((k) => { const sp = el$("span"); const sw = el$("i", "sw"); sw.style.background = color[k]; sp.append(sw, label[k]); legend.append(sp); });
    el.replaceChildren(legend, svg.node());
    const tip = tooltip(el, svg, (r) => [line$(when(r.t)), line$(label[r.result] || r.result), line$(r.note || "")]);
    glow(svg.selectAll("circle.run")).on("mousemove", (ev, r) => tip.show(ev, r)).on("mouseleave", tip.hide);
  }

  window.WOWUI = { setIcons: (f) => { ICON.of = f; }, setTimeDomain: (f) => { TIME.domain = f; }, pal, el$, tone, coin, coinText, short, pct, num, when, ago, empty, lineChart, hbar, scatter, timeline, pie };
})();
