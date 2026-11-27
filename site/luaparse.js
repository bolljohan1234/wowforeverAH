// Reads a WoW SavedVariables file (plain Lua tables) into JavaScript objects.
// Same rules as tools/sync_game.py: tables with only list entries become arrays, anything with keys becomes an object.
(function () {
  function parseLua(text) {
    let i = 0;
    const n = text.length;
    const ws = () => {
      for (;;) {
        while (i < n && " \t\r\n,;".indexOf(text[i]) >= 0) i++;
        if (text[i] === "-" && text[i + 1] === "-") { while (i < n && text[i] !== "\n") i++; } else return;
      }
    };
    const NUM = /-?\d+(\.\d+)?([eE][-+]?\d+)?|true|false|nil/y;
    const NAME = /[A-Za-z_]\w*\s*=/y;
    const value = () => {
      ws();
      const c = text[i];
      if (c === "{") {
        i++;
        const arr = [], obj = {};
        let named = false;
        for (;;) {
          ws();
          if (text[i] === "}") { i++; break; }
          if (text[i] === "[") {
            i++; const k = value(); ws(); i++; ws(); i++;   // ] and =
            obj[k] = value(); named = true;
          } else {
            NAME.lastIndex = i;
            const m = NAME.exec(text);
            if (m) { i = NAME.lastIndex; obj[m[0].slice(0, -1).trim()] = value(); named = true; }
            else arr.push(value());
          }
        }
        if (named) { arr.forEach((v, k) => { if (!(k + 1 in obj)) obj[k + 1] = v; }); return obj; }
        return arr;
      }
      if (c === '"') {
        let j = i + 1, s = "";
        while (text[j] !== '"') {
          if (text[j] === "\\") { const x = text[j + 1]; s += x === "n" ? "\n" : x === "t" ? "\t" : x; j += 2; }
          else s += text[j++];
        }
        i = j + 1;
        return s;
      }
      NUM.lastIndex = i;
      const m = NUM.exec(text);
      if (!m) throw new Error("Unexpected text at position " + i + ": " + JSON.stringify(text.slice(i, i + 30)));
      i = NUM.lastIndex;
      const t = m[0];
      return t === "true" ? true : t === "false" ? false : t === "nil" ? null : Number(t);
    };
    const out = {};
    const TOP = /([A-Za-z_]\w*)\s*=/y;
    for (;;) {
      ws();
      if (i >= n) break;
      TOP.lastIndex = i;
      const m = TOP.exec(text);
      if (!m) throw new Error("Unexpected text at position " + i);
      i = TOP.lastIndex;
      out[m[1]] = value();
    }
    return out;
  }
  // a Lua table read as a list of [key, value] pairs, whether it came out as an array or an object
  const entries = (m) => (Array.isArray(m) ? m.map((v, k) => [k + 1, v]) : m && typeof m === "object" ? Object.entries(m) : []);
  window.LUA = { parse: parseLua, entries: entries };
})();
