/* Caddie engine — plans a hole from marked course data (GeoJSON, lon/lat).
   Works in real ground metres: every distance is on the ground, no image pixels.

   Input features (properties.kind): tee (+ tee colour), greenc, green, fairway,
   bunker, water, trees, ob. Unmarked ground inside the hole's area is rough.

   Model, in one paragraph: each shot is simulated many times with the player's
   dispersion (sideways spread = radius/2, distance spread ~4% of carry, optional
   usual-miss bias). Each ball flies a straight line on the ground with an arc
   (apex at 60% of carry); below the tree height a tree stops it. It lands, rolls,
   and gets a lie. Every spot on the hole has a value — expected strokes to hole
   out — worked backwards from the green. The best shot is the one whose simulated
   balls finish with the lowest average value. */
(function (root) {
"use strict";

/* ---------- player & physics defaults ---------- */
const DEFAULT_BAG = [            // name, carry m, dispersion radius m (~95% of shots)
  ["Driver", 230, 25], ["3-wood", 205, 22], ["Driving iron", 195, 15], ["3-iron", 180, 15],
  ["4-iron", 170, 15], ["5-iron", 160, 13], ["6-iron", 140, 12], ["7-iron", 135, 10],
  ["8-iron", 130, 10], ["9-iron", 120, 7], ["PW", 105, 6], ["52°", 80, 5], ["56°", 62, 5], ["Chip", 25, 4]];
const APEX = { "Driver": 27, "3-wood": 26, "Driving iron": 24, "3-iron": 24, "4-iron": 25, "5-iron": 26,
  "6-iron": 27, "7-iron": 27, "8-iron": 27, "9-iron": 26, "PW": 25, "52°": 22, "56°": 20, "Chip": 3, "Punch": 5 };
const PUNCH = [["Punch", 70, 12], ["Chip", 25, 4]];
const TP = 0.6, TREE_P = 0.7, CLEAR_M = 8, TEE_CLEAR_M = 20;
const BASE = [[15, 2.42], [30, 2.58], [45, 2.68], [60, 2.76], [75, 2.84], [91, 2.92], [110, 2.98], [128, 3.05],
  [146, 3.13], [165, 3.25], [183, 3.41], [201, 3.54], [230, 3.70], [260, 3.86], [300, 4.05], [350, 4.30], [400, 4.55], [450, 4.78], [550, 5.2]];
const PUTT = [[0.3, 1.0], [1, 1.35], [2, 1.55], [4, 1.72], [7, 1.86], [12, 2.00], [20, 2.15], [30, 2.32]];
const PEN = { F: 0, R: .25, S: .46, T: .72, O: 1.2 };
const ROLL = { F: 9, R: 4, G: 3, S: 0, T: 2 };
const NAME = { F: "fairway", R: "rough", S: "sand", W: "water", T: "trees", G: "green", O: "OB", X: "off the map" };

function interp(t, d) {
  if (d <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (d <= t[i][0]) { const [a, av] = t[i - 1], [b, bv] = t[i]; return av + (bv - av) * (d - a) / (b - a); }
  const [a, av] = t[t.length - 2], [b, bv] = t[t.length - 1]; return bv + (bv - av) * (d - b) / (b - a);
}
function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ---------- reading the marked hole ---------- */
const KIND = { tee: "tee", teebox: "tee", tee_box: "tee", greenc: "greenc", green_centre: "greenc", green_center: "greenc",
  pin: "greenc", green: "green", fairway: "fairway", bunker: "bunker", sand: "bunker", water: "water", pond: "water",
  trees: "trees", tree: "trees", canopy: "trees", ob: "ob", out_of_bounds: "ob", oob: "ob",
  holeline: "holeline", hole_line: "holeline", hole: "holeline" };
function kindOf(p) {
  const k = String(p.kind || p.type || p.feature || p.category || p.layer || "").toLowerCase().replace(/[\s-]+/g, "_");
  return KIND[k] || null;
}
function teeOf(p) { return String(p.tee || p.teeColor || p.tee_colour || p.colour || p.color || "").toLowerCase() || null; }

/* Local flat projection around the tee: fine to well under 0.1% over a golf hole. */
function projector(lon0, lat0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
  return { to: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
           from: ([x, y]) => [lon0 + x / kx, lat0 + y / ky] };
}
function inPoly(x, y, rings) {             // even-odd over all rings (holes supported)
  let c = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/* Build the hole: a 2 m surface raster in ground metres. */
function buildHole(geojson, holeNo, teeColour) {
  const fs = (geojson.features || []).filter(f => f && f.geometry && (holeNo == null || +f.properties.hole === +holeNo || f.properties.hole == null));
  const byKind = k => fs.filter(f => kindOf(f.properties) === k);
  const tees = byKind("tee");
  if (!tees.length) throw new Error("Mark at least one tee.");
  const tee = tees.find(t => teeOf(t.properties) === teeColour) || tees[0];
  const P = projector(...tee.geometry.coordinates);
  let pin = byKind("greenc")[0];
  const greens = byKind("green");
  let pinXY;
  if (pin) pinXY = P.to(pin.geometry.coordinates);
  else if (greens.length) { const r = greens[0].geometry.coordinates[0].map(P.to); pinXY = [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length]; }
  else throw new Error("Mark the green centre or the green edge.");
  const polys = k => byKind(k).filter(f => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
    .flatMap(f => f.geometry.type === "Polygon" ? [f.geometry.coordinates.map(r => r.map(P.to))]
      : f.geometry.coordinates.map(pg => pg.map(r => r.map(P.to))));
  const G = polys("green"), F = polys("fairway"), S = polys("bunker"), W = polys("water"), T = polys("trees");
  const OBL = byKind("ob").filter(f => f.geometry.type === "LineString").map(f => f.geometry.coordinates.map(P.to));
  // bends of the hole's routing line: extra targets so dog-legs can be played to the corner
  const via = byKind("holeline").filter(f => f.geometry.type === "LineString")
    .flatMap(f => f.geometry.coordinates.slice(1, -1).map(P.to));

  // area of the hole: everything marked, plus a margin; beyond it is unknown ground
  const all = [[0, 0], pinXY, ...[G, F, S, W, T].flat(3), ...OBL.flat()];
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const M = 45, C = 2;
  const x0 = Math.min(...xs) - M, y0 = Math.min(...ys) - M, x1 = Math.max(...xs) + M, y1 = Math.max(...ys) + M;
  const NX = Math.ceil((x1 - x0) / C), NY = Math.ceil((y1 - y0) / C);
  const grid = new Uint8Array(NX * NY);   // 0 R, 1 F, 2 S, 3 W, 4 T, 5 G, 6 O(OB)
  const CODE = ["R", "F", "S", "W", "T", "G", "O"];
  const midTG = [pinXY[0] / 2, pinXY[1] / 2];
  // OB: for each OB line, the side away from the tee-green midpoint is out of bounds
  function obSide(x, y) {
    for (const L of OBL) {
      let best = null;
      for (let i = 0; i < L.length - 1; i++) {
        const [ax, ay] = L[i], [bx, by] = L[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        const t = ((x - ax) * dx + (y - ay) * dy) / l2;
        if (t < -0.02 || t > 1.02) continue;
        const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(x - px, y - py);
        if (!best || d < best.d) best = { d, s: Math.sign(dx * (y - ay) - dy * (x - ax)), ref: Math.sign(dx * (midTG[1] - ay) - dy * (midTG[0] - ax)) };
      }
      if (best && best.s !== 0 && best.s !== best.ref) return true;
    }
    return false;
  }
  for (let k = 0; k < NY; k++) for (let i = 0; i < NX; i++) {
    const x = x0 + (i + .5) * C, y = y0 + (k + .5) * C;
    let c = 0;
    if (F.some(p => inPoly(x, y, p))) c = 1;
    if (T.some(p => inPoly(x, y, p))) c = 4;
    if (W.some(p => inPoly(x, y, p))) c = 3;
    if (S.some(p => inPoly(x, y, p))) c = 2;
    if (G.some(p => inPoly(x, y, p))) c = 5;
    if (OBL.length && obSide(x, y)) c = 6;
    grid[k * NX + i] = c;
  }
  if (!G.length) {                          // no green edge: a 12 m disc around the pin
    for (let k = 0; k < NY; k++) for (let i = 0; i < NX; i++) {
      const x = x0 + (i + .5) * C, y = y0 + (k + .5) * C;
      if (Math.hypot(x - pinXY[0], y - pinXY[1]) < 12) grid[k * NX + i] = 5;
    }
  }
  const lie = (x, y) => {
    const i = Math.floor((x - x0) / C), k = Math.floor((y - y0) / C);
    if (i < 0 || i >= NX || k < 0 || k >= NY) return "X";
    return CODE[grid[k * NX + i]];
  };
  const counts = {}; for (const v of grid) counts[CODE[v]] = (counts[CODE[v]] || 0) + 1;
  return { P, pin: pinXY, via, tee: tee.properties, teeColour: teeOf(tee.properties), lie, bbox: [x0, y0, x1, y1],
    counts, warnings: [T.length ? null : "No trees marked: the caddie can't see any trees.",
      OBL.length ? null : "No OB line marked.", F.length ? null : "No fairway marked: everything counts as rough."].filter(Boolean) };
}

/* ---------- the planner ---------- */
function makeCaddie(hole, opts = {}) {
  const S = Object.assign({ bag: DEFAULT_BAG, off: .25, treeH: 15, disp: 1, missM: 0, wind: 0, seed: 7 }, opts);
  const rnd = mulberry(S.seed);
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const hAt = (apex, t) => t <= TP ? apex * (1 - ((TP - t) / TP) ** 2) : apex * (1 - ((t - TP) / (1 - TP)) ** 2);
  const plays = c => c + S.wind * .7 * (c / 150);
  const [px, py] = hole.pin;
  const dPin = (x, y) => Math.hypot(x - px, y - py);
  function es(l, x, y) {
    const d = dPin(x, y);
    if (l === "G") return interp(PUTT, Math.max(d, .5)) + S.off * .4;
    const b = interp(BASE, Math.max(d, 12)) + S.off;
    return b + (PEN[l] !== undefined ? PEN[l] : .3);
  }
  /* flight: straight line on the ground; below tree height a tree stops the ball */
  function flightHit(x0, y0, x1, y1, club, prob, fromTee) {
    const apex = APEX[club[0]] || 25, len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 8) return null;
    const clear = fromTee ? TEE_CLEAR_M : CLEAR_M, n = Math.max(6, Math.round(len / 4));
    for (let i = 1; i < n; i++) {
      const t = i / n; if (hAt(apex, t) >= S.treeH || t * len < clear) continue;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (hole.lie(x, y) === "T" && rnd() < prob) return { x, y, dist: t * len };
    }
    return null;
  }
  /* value field on a 4 m ground grid */
  const [bx0, by0, bx1, by1] = hole.bbox, VC = 4;
  const VX = Math.ceil((bx1 - bx0) / VC), VY = Math.ceil((by1 - by0) / VC);
  const V = new Float32Array(VX * VY);
  const vAt = (x, y) => {
    const i = Math.max(0, Math.min(VX - 1, Math.floor((x - bx0) / VC))), k = Math.max(0, Math.min(VY - 1, Math.floor((y - by0) / VC)));
    return V[k * VX + i];
  };
  function sampleShot(x, y, club, aimX, aimY, fromTee) {
    const carry = plays(club[1]), rad = club[2] * S.disp;
    const dx = aimX - x, dy = aimY - y, L = Math.hypot(dx, dy) || 1, ex = dx / L, ey = dy / L, qx = ey, qy = -ex; // q = right
    const al = carry + gauss() * Math.max(4, carry * .042 * S.disp), lat = gauss() * rad / 2 + S.missM;
    let nx = x + ex * al + qx * lat, ny = y + ey * al + qy * lat;
    const hit = flightHit(x, y, nx, ny, club, TREE_P, fromTee);
    if (hit) return { x: hit.x, y: hit.y, k: "hit" };
    let l = hole.lie(nx, ny);
    if (l !== "W" && l !== "O" && l !== "X") { const r = (ROLL[l] || 3) * (.6 + rnd() * .8); nx += ex * r; ny += ey * r; l = hole.lie(nx, ny); }
    return { x: nx, y: ny, k: l };
  }
  function outcomeValue(o, x, y) {           // x,y = where the shot was played from
    if (o.k === "hit") return Math.max(vAt(o.x, o.y), es("T", o.x, o.y));
    if (o.k === "O") return 1 + vAt(x, y);                        // stroke and distance
    if (o.k === "X") return es("O", o.x, o.y) + .5;                // unknown ground: pessimistic
    if (o.k === "W") { const bx = o.x + (x - o.x) * .05, by = o.y + (y - o.y) * .05; return 1 + Math.max(vAt(bx, by), es("R", bx, by)); }
    return vAt(o.x, o.y);
  }
  function aimPoint(x, y, club, off, tgt) {  // off = metres right (+) / left (-) of the line to the target
    const [tx, ty] = tgt || [px, py];
    const dx = tx - x, dy = ty - y, L = Math.hypot(dx, dy) || 1, ex = dx / L, ey = dy / L;
    const c = plays(club[1]);
    return [x + ex * c + ey * off, y + ey * c - ex * off];
  }
  function ev(x, y, club, off, N, fromTee, tgt) {
    const [ax, ay] = aimPoint(x, y, club, off, tgt);
    let t = 0; for (let i = 0; i < N; i++) t += outcomeValue(sampleShot(x, y, club, ax, ay, fromTee), x, y);
    return 1 + t / N;
  }
  function candidates(x, y, l, fromTee) {
    if (l === "T") return PUNCH;
    const d = dPin(x, y);
    const bag = S.bag.filter(c => fromTee || c[0] !== "Driver");
    const c = bag.filter(q => q[1] <= d + 18).sort((a, b) => Math.abs(a[1] - d) - Math.abs(b[1] - d)).slice(0, 4);
    if (d > 190) for (const q of bag.slice(0, 2)) if (!c.includes(q)) c.push(q);
    return c.length ? c : [bag[bag.length - 1]];
  }
  // seed, then sweep backwards-in-effect (value iteration)
  for (let k = 0; k < VY; k++) for (let i = 0; i < VX; i++) {
    const x = bx0 + (i + .5) * VC, y = by0 + (k + .5) * VC, l = hole.lie(x, y);
    V[k * VX + i] = l === "O" || l === "X" ? 9 : es(l, x, y);
  }
  for (let sw = 0; sw < 3; sw++) {
    const NV = V.slice();
    for (let k = 0; k < VY; k++) for (let i = 0; i < VX; i++) {
      const x = bx0 + (i + .5) * VC, y = by0 + (k + .5) * VC, l = hole.lie(x, y);
      if (l === "G" || l === "O" || l === "X" || dPin(x, y) < 14) continue;
      let best = Infinity;
      for (const c of candidates(x, y, l, false)) for (const a of (l === "T" ? [-24, -12, 0, 12, 24] : [-9, 0, 9])) {
        const v = ev(x, y, c, a, 20, false); if (v < best) best = v;
      }
      if (l === "W") best = 1 + vAt(x, y);
      NV[k * VX + i] = Math.min(best, V[k * VX + i] + .4);
    }
    V.set(NV);
  }

  function mix(x, y, club, off, N, fromTee, tgt) {
    const [ax, ay] = aimPoint(x, y, club, off, tgt), m = {};
    for (let i = 0; i < N; i++) { const o = sampleShot(x, y, club, ax, ay, fromTee); const k = o.k === "hit" ? "T" : o.k; m[k] = (m[k] || 0) + 1 / N; }
    return m;
  }
  function planFrom(x, y, fromTee) {
    const l0 = fromTee ? "F" : hole.lie(x, y);
    const clubs = fromTee ? S.bag.filter(c => c[1] <= dPin(x, y) + 25) : candidates(x, y, l0, false);
    const offs = []; for (let a = -36; a <= 36; a += 3) offs.push(a);
    // targets: the flag, plus any bend of the hole line that is still ahead of the ball
    const dNow = dPin(x, y);
    const targets = [null, ...(hole.via || []).filter(v => dPin(...v) < dNow - 20 && Math.hypot(v[0] - x, v[1] - y) > 60)];
    const perClub = [];
    for (const c of clubs) {
      let bc = null;
      for (const tg of targets) for (const a of (l0 === "T" ? [-24, -18, -12, -6, 0, 6, 12, 18, 24] : offs)) {
        const v = ev(x, y, c, a, fromTee ? 200 : 120, fromTee, tg); if (!bc || v < bc.v) bc = { v, club: c, off: a, tgt: tg };
      }
      perClub.push(bc);
    }
    perClub.sort((a, b) => a.v - b.v);
    const best = perClub[0];
    const options = perClub.slice(0, 3).map(o => Object.assign(o, { mix: mix(x, y, o.club, o.off, 400, fromTee, o.tgt) }));
    const [ax, ay] = aimPoint(x, y, best.club, best.off, best.tgt);
    const cloud = []; for (let i = 0; i < 160; i++) cloud.push(sampleShot(x, y, best.club, ax, ay, fromTee));
    // the rest of the hole, following the middle of each shot
    const chain = [{ club: best.club[0], carry: Math.round(plays(best.club[1])), from: [x, y], aim: [ax, ay] }];
    let cx = ax, cy = ay, cl = hole.lie(ax, ay), guard = 0;
    while (guard++ < 5 && cl !== "G" && dPin(cx, cy) > 14 && cl !== "O" && cl !== "X") {
      let nb = null;
      for (const c of candidates(cx, cy, cl, false)) for (const a of (cl === "T" ? [-24, -12, 0, 12, 24] : [-6, -3, 0, 3, 6])) {
        const v = ev(cx, cy, c, a, 60, false); if (!nb || v < nb.v) nb = { v, c, a };
      }
      const [nx, ny] = aimPoint(cx, cy, nb.c, nb.a);
      chain.push({ club: nb.c[0], carry: Math.round(plays(nb.c[1])), from: [cx, cy], aim: [nx, ny] });
      if (Math.hypot(nx - cx, ny - cy) < 3) break;
      cx = nx; cy = ny; cl = hole.lie(cx, cy);
    }
    chain.forEach(s => { s.lie = NAME[hole.lie(...s.aim)] || "rough"; s.left = Math.round(dPin(...s.aim)); });
    return { best, options, cloud, chain, expected: best.v, toPin: dPin(x, y) };
  }
  return { planTee: () => planFrom(0, 0, true), planFrom: (x, y) => planFrom(x, y, false), lie: hole.lie, es };
}

const api = { DEFAULT_BAG, NAME, buildHole, makeCaddie, projector };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CaddieEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
