/* Golf decision-support simulator, not a learned AI or a rules adjudicator.
 * Merged build: reviewed engine (deterministic, validated) + style strategies,
 * amateur short game and penalty-area drops from the previous engine.
 * Coordinates: GeoJSON longitude/latitude in; local ground metres in planner.
 * Node: require("./caddie-engine"); browser: globalThis.CaddieEngine.
 */
(function (root) {
"use strict";

/* Bag rows: [name, carry m, lateral 95% half-width m]. The third number means 95% of shots finish
   within +/- that distance sideways of the aim line (lateral sd = value / 2); it is NOT a circle radius.
   Distance spread is separate (7% of carry, 12-handicap assumption). */
const DEFAULT_BAG = [
  ["Driver", 230, 25], ["3-wood", 205, 22], ["Driving iron", 195, 15], ["3-iron", 180, 15],
  ["4-iron", 170, 15], ["5-iron", 160, 13], ["6-iron", 140, 12], ["7-iron", 135, 10],
  ["8-iron", 130, 10], ["9-iron", 120, 7], ["PW", 105, 6], ["52°", 80, 5],
  ["56°", 62, 5], ["Chip", 25, 4]
];
const NAME = { F: "fairway", R: "rough", S: "sand", W: "water", T: "trees",
  G: "green", O: "OB", X: "off the map", U: "uncertain" };
const APEX = { Driver: 27, "3-wood": 26, "Driving iron": 24, "3-iron": 24, "4-iron": 25, "5-iron": 26,
  "6-iron": 27, "7-iron": 27, "8-iron": 27, "9-iron": 26, PW: 25, "52°": 22, "56°": 20, Chip: 3, Punch: 5 };
const BASE = [[0, 2.15], [15, 2.42], [30, 2.58], [60, 2.76], [91, 2.92],
  [128, 3.05], [165, 3.25], [201, 3.54], [260, 3.86], [350, 4.30], [450, 4.78], [550, 5.2]];
const PUTT = [[0, 1], [1, 1.12], [2, 1.42], [3, 1.6], [5, 1.8], [8, 1.95],
  [12, 2.1], [20, 2.3], [30, 2.5]];
const PEN = { F: 0, R: .25, S: .46, T: .72, U: .6 };
const ROLL = { F: 9, R: 4, G: 3, S: 0, T: 2, U: 2 };
const KIND = { tee: "tee", teebox: "tee", tee_box: "tee", greenc: "greenc",
  green_centre: "greenc", green_center: "greenc", pin: "greenc", green: "G",
  fairway: "F", rough: "R", bunker: "S", sand: "S", water: "W", pond: "W",
  trees: "T", tree: "T", canopy: "T", ob: "O", out_of_bounds: "O", oob: "O",
  holeline: "route", hole_line: "route", hole: "route", course: "course", golf_course: "course" };
const norm = s => String(s == null ? "" : s).trim().toLowerCase().replace(/[\s-]+/g, "_");
const kindOf = (p = {}) => KIND[norm(p.kind || p.type || p.feature || p.category || p.layer)];
const teeOf = (p = {}) => norm(p.tee || p.teeColor || p.tee_colour || p.colour || p.color) || null;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const legal = l => !["W", "O", "X"].includes(l);
function finite(v, name, min = -Infinity, max = Infinity) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new TypeError(`${name} must be a finite number in [${min}, ${max}].`);
  return v;
}
function integer(v, name, min, max) {
  finite(v, name, min, max);
  if (!Number.isInteger(v)) throw new TypeError(`${name} must be an integer.`);
  return v;
}
function point(p, geographic = false) {
  if (!Array.isArray(p) || p.length < 2) throw new TypeError("Invalid coordinate pair.");
  finite(p[0], "coordinate x", geographic ? -180 : -Infinity, geographic ? 180 : Infinity);
  finite(p[1], "coordinate y", geographic ? -89 : -Infinity, geographic ? 89 : Infinity);
  return p;
}
function interp(table, d) {
  if (d <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (d <= table[i][0]) {
      const [a, av] = table[i - 1], [b, bv] = table[i];
      return av + (bv - av) * (d - a) / (b - a);
    }
  }
  const [a, av] = table[table.length - 2], [b, bv] = table[table.length - 1];
  return bv + (bv - av) * (d - b) / (b - a);
}
function projector(lon0, lat0) {
  point([lon0, lat0], true);
  const r = lat0 * Math.PI / 180;
  const kx = 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r) + .118 * Math.cos(5 * r);
  const ky = 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r) - .0023 * Math.cos(6 * r);
  return {
    to(p) { point(p, true); return [(p[0] - lon0) * kx, (p[1] - lat0) * ky]; },
    from(p) { point(p); return [lon0 + p[0] / kx, lat0 + p[1] / ky]; }
  };
}
function onSegment(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return Math.abs(dx * (y - a[1]) - dy * (x - a[0])) < 1e-7 &&
    x >= Math.min(a[0], b[0]) - 1e-7 && x <= Math.max(a[0], b[0]) + 1e-7 &&
    y >= Math.min(a[1], b[1]) - 1e-7 && y <= Math.max(a[1], b[1]) + 1e-7;
}
function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if (onSegment(x, y, a, b)) return true;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
function inPoly(x, y, rings) {
  const b = rings.bounds;
  if (b && (x < b[0] || y < b[1] || x > b[2] || y > b[3])) return false;
  if (!inRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (inRing(x, y, rings[i])) return false;
  return true;
}
function polygons(g) {
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return [];
}
function validateGeometry(g) {
  if (!["Point", "LineString", "Polygon", "MultiPolygon"].includes(g.type))
    throw new TypeError(`Unsupported marked geometry: ${g.type}.`);
  if (g.type === "Point") { point(g.coordinates, true); return; }
  const lines = g.type === "LineString" ? [g.coordinates] : polygons(g).flat();
  if (!lines.length) throw new TypeError("Empty marked geometry.");
  for (const line of lines) {
    if (!Array.isArray(line) || line.length < (g.type === "LineString" ? 2 : 4))
      throw new TypeError("Incomplete line or polygon ring.");
    line.forEach(p => point(p, true));
    if (g.type !== "LineString" && distance(line[0], line[line.length - 1]) > 1e-12)
      throw new TypeError("GeoJSON polygon rings must be closed.");
  }
}
function ringArea(r) {
  return Math.abs(r.reduce((s, p, i) => {
    const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2);
}
function interior(rings) {
  const ring = rings[0], xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  let twiceArea = 0, sx = 0, sy = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], c = a[0] * b[1] - b[0] * a[1];
    twiceArea += c; sx += (a[0] + b[0]) * c; sy += (a[1] + b[1]) * c;
  }
  const centre = twiceArea ? [sx / (3 * twiceArea), sy / (3 * twiceArea)] : ring[0];
  if (inPoly(...centre, rings)) return centre;
  const loX = Math.min(...xs), loY = Math.min(...ys), w = Math.max(...xs) - loX, h = Math.max(...ys) - loY;
  let best = null;
  for (let j = 0; j < 48; j++) for (let i = 0; i < 48; i++) {
    const p = [loX + (i + .5) * w / 48, loY + (j + .5) * h / 48];
    if (inPoly(...p, rings) && (!best || distance(p, centre) < distance(best, centre))) best = p;
  }
  if (!best) throw new TypeError("Cannot locate polygon interior; mark an explicit centre.");
  return best;
}
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return distance(p, [a[0] + t * dx, a[1] + t * dy]);
}

function buildHole(geojson, holeNo, teeColour, opts = {}) {
  if (!geojson || !Array.isArray(geojson.features)) throw new TypeError("Expected a GeoJSON FeatureCollection.");
  if (!opts || typeof opts !== "object") throw new TypeError("Invalid hole options.");
  const corridor = finite(opts.corridor ?? 0, "corridor", 0, 1000);
  const maxCells = integer(opts.maxCells ?? 1000000, "maxCells", 100, 4000000);
  const unmarked = opts.unmarkedLie ?? "U";
  if (!["U", "R"].includes(unmarked)) throw new TypeError("unmarkedLie must be U or R.");
  if (opts.surface != null && typeof opts.surface !== "function") throw new TypeError("surface must be a function.");
  if (opts.courseBoundaryIsOB != null && typeof opts.courseBoundaryIsOB !== "boolean")
    throw new TypeError("courseBoundaryIsOB must be boolean.");
  const fs = geojson.features.filter(f => f && f.geometry &&
    (holeNo == null || (f.properties || {}).hole == null || String(f.properties.hole) === String(holeNo)));
  const byKind = k => fs.filter(f => kindOf(f.properties || {}) === k);
  fs.filter(f => kindOf(f.properties || {})).forEach(f => validateGeometry(f.geometry));
  const tees = byKind("tee");
  if (!tees.length) throw new Error("Mark at least one tee.");
  const colour = norm(teeColour);
  const tee = tees.find(f => teeOf(f.properties || {}) === colour) || tees[0];
  let origin;
  if (tee.geometry.type === "Point") origin = tee.geometry.coordinates;
  else {
    const gs = polygons(tee.geometry).sort((a, b) => ringArea(b[0]) - ringArea(a[0]));
    if (!gs.length) throw new TypeError("Tee must be a Point, Polygon or MultiPolygon.");
    const provisional = projector(...gs[0][0][0]);
    origin = provisional.from(interior(gs[0].map(r => r.map(p => provisional.to(p)))));
  }
  const P = projector(...origin);
  const polys = k => byKind(k).flatMap(f => polygons(f.geometry)).map(pg => {
    const projected = pg.map(r => r.map(p => P.to(p))), ps = projected[0];
    projected.bounds = [Math.min(...ps.map(p => p[0])), Math.min(...ps.map(p => p[1])),
      Math.max(...ps.map(p => p[0])), Math.max(...ps.map(p => p[1]))];
    return projected;
  });
  const surfaces = Object.fromEntries(["F", "R", "S", "W", "T", "G", "O"].map(k => [k, polys(k)]));
  const centres = byKind("greenc"), warnings = [];
  let pin;
  if (centres.length) {
    if (centres[0].geometry.type !== "Point") throw new TypeError("Green centre must be a Point.");
    pin = P.to(centres[0].geometry.coordinates);
  } else if (surfaces.G.length) {
    const largest = surfaces.G.slice().sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0];
    pin = interior(largest);
    warnings.push("No pin marked: an interior point of the largest green is used, not the actual cup.");
  } else throw new Error("Mark a green centre or green polygon.");
  const routes = byKind("route").filter(f => f.geometry.type === "LineString")
    .map(f => f.geometry.coordinates.map(p => P.to(p)));
  const via = routes.flatMap(r => r.slice(1, -1));
  const obLines = byKind("O").filter(f => f.geometry.type === "LineString")
    .map(f => f.geometry.coordinates.map(p => P.to(p)));
  const course = polys("course"), courseOB = opts.courseBoundaryIsOB === true && course.length > 0;
  if (obLines.length) warnings.push("OB line side is inferred from the tee/pin midpoint; prefer explicit OB polygons.");
  if (course.length && !courseOB) warnings.push("Course outline is not a rules boundary and is ignored for OB.");
  if (courseOB) warnings.push("Outside the course polygon is OB by explicit option; verify the boundary.");
  if (corridor && routes.length) warnings.push("Unmarked ground outside the requested route corridor is assumed trees; verify this assumption.");
  if (colour && teeOf(tee.properties || {}) !== colour) warnings.push("Requested tee colour not found; first tee used.");
  if (!surfaces.G.length) warnings.push("No green edge: a synthetic 12 m green disc is used; mark the real green.");
  warnings.push(unmarked === "U" ? "Unmarked ground is uncertain, not verified rough." : "Unmarked ground is assumed rough by explicit option.");
  if (!surfaces.T.length) warnings.push("Unmarked trees are not detected.");
  if (!surfaces.O.length && !obLines.length && !courseOB) warnings.push("No explicit OB boundary is available.");
  if (opts.surface) warnings.push("Surface callback classifications are unverified; explicit markings take precedence.");
  const all = [[0, 0], pin, ...Object.values(surfaces).flat(3), ...routes.flat(), ...obLines.flat()];
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const C = 2, x0 = Math.min(...xs) - 45, y0 = Math.min(...ys) - 45;
  const nx = Math.ceil((Math.max(...xs) + 45 - x0) / C), ny = Math.ceil((Math.max(...ys) + 45 - y0) / C);
  if (nx * ny > maxCells) throw new RangeError("Hole extent exceeds maxCells; split the course into individual holes.");
  const bbox = [x0, y0, x0 + nx * C, y0 + ny * C];
  const mid = [pin[0] / 2, pin[1] / 2];
  function obSide(x, y) {
    return obLines.some(line => {
      let best = null;
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i], dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
        if (!len2) continue;
        const t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2;
        if (t < 0 || t > 1) continue;
        const d = segmentDistance([x, y], a, b), side = dx * (y - a[1]) - dy * (x - a[0]);
        const ref = dx * (mid[1] - a[1]) - dy * (mid[0] - a[0]);
        if (!best || d < best.d) best = { d, side, ref };
      }
      return best && Math.abs(best.ref) > 1e-7 && best.side * best.ref < 0;
    });
  }
  function markedLie(x, y) {
    if (surfaces.O.some(pg => inPoly(x, y, pg)) || obSide(x, y)) return "O";
    if (surfaces.W.some(pg => inPoly(x, y, pg))) return "W";
    if (surfaces.T.some(pg => inPoly(x, y, pg))) return "T";
    if (surfaces.S.some(pg => inPoly(x, y, pg))) return "S";
    if (surfaces.G.some(pg => inPoly(x, y, pg)) || (!surfaces.G.length && distance([x, y], pin) < 12)) return "G";
    if (surfaces.F.some(pg => inPoly(x, y, pg))) return "F";
    if (surfaces.R.some(pg => inPoly(x, y, pg))) return "R";
    return null;
  }
  const codes = ["U", "R", "F", "S", "W", "T", "G", "O"], grid = new Uint8Array(nx * ny);
  const provenance = new Uint8Array(nx * ny), counts = {};
  let fromSurface = 0, assumedTrees = 0, assumedOB = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + (i + .5) * C, y = y0 + (j + .5) * C, index = j * nx + i;
    let l = markedLie(x, y);
    if (l) provenance[index] = 1;
    if (!l && opts.surface) {
      const value = opts.surface(...P.from([x, y]));
      if (value != null && value !== "") {
        if (!codes.includes(value)) throw new TypeError(`Invalid surface code: ${value}.`);
        l = value; provenance[index] = 2; fromSurface++;
      }
    }
    if (!l && courseOB && !course.some(pg => inPoly(x, y, pg))) { l = "O"; assumedOB++; }
    if (!l && corridor && routes.length && routes.every(line =>
      line.slice(1).every((b, n) => segmentDistance([x, y], line[n], b) > corridor))) {
      l = "T"; assumedTrees++;
    }
    l = l || unmarked; grid[index] = codes.indexOf(l); counts[l] = (counts[l] || 0) + 1;
  }
  function indexAt(x, y) {
    const i = Math.floor((x - x0) / C), j = Math.floor((y - y0) / C);
    return i < 0 || i >= nx || j < 0 || j >= ny ? -1 : j * nx + i;
  }
  function lie(x, y) {
    point([x, y]);
    const n = indexAt(x, y);
    if (n < 0) return "X";
    // Exact marked geometry keeps sub-cell hazards visible.
    const exact = markedLie(x, y);
    if (exact) return exact;
    return provenance[n] === 1 ? unmarked : codes[grid[n]];
  }
  function provenanceAt(x, y) {
    point([x, y]);
    const n = indexAt(x, y);
    if (n < 0) return "outside";
    if (markedLie(x, y)) return "marked";
    return provenance[n] === 2 ? "surface" : "assumed";
  }
  // Polygon boundary intersections prevent even narrow marked hazards being skipped by roll.
  const edges = ["O", "W", "S", "T"].flatMap(k => surfaces[k]).flatMap(pg => pg.flatMap(r =>
    r.slice(1).map((b, i) => [r[i], b])));
  function pathStops(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], ts = [0, 1];
    const len = distance(a, b);
    for (let i = 1, n = Math.ceil(len / .5); i < n; i++) ts.push(i / n);
    for (const [p, q] of edges) {
      const ex = q[0] - p[0], ey = q[1] - p[1], det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-10) continue;
      const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / det;
      const u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / det;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t, Math.min(1, t + 1e-7));
    }
    ts.sort((c, d) => c - d);
    for (const t of ts) {
      const p = [a[0] + t * dx, a[1] + t * dy], k = lie(...p);
      if (!legal(k) || k === "S" || k === "T") return { x: p[0], y: p[1], k };
    }
    return { x: b[0], y: b[1], k: lie(...b) };
  }
  return { P, pin, via, tee: { ...(tee.properties || {}) }, teeColour: teeOf(tee.properties || {}),
    lie, provenanceAt, pathStops, bbox, counts, fromSurfaceM2: fromSurface * C * C,
    defaults: { corridorM: routes.length ? corridor : 0, assumedTreesM2: assumedTrees * C * C,
      courseOutlineUsed: courseOB, assumedOBM2: assumedOB * C * C, unmarkedLie: unmarked },
    warnings, hasTrees: surfaces.T.length > 0 || (counts.T || 0) > 0 };
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry(seed) {
  return function () {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function packet(rnd) {
  const radius = Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))), angle = 2 * Math.PI * rnd();
  return { along: radius * Math.cos(angle), side: radius * Math.sin(angle),
    mishit: rnd(), severity: rnd(), roll: rnd(), tree: rnd(), putt: rnd() };
}
const clone = value => JSON.parse(JSON.stringify(value));
const actionKey = o => JSON.stringify([o.club, o.off, o.tgt]);

function makeCaddie(hole, opts = {}) {
  if (!hole || typeof hole.lie !== "function") throw new TypeError("Expected a built hole.");
  point(hole.pin); point(hole.bbox && hole.bbox.slice(0, 2)); point(hole.bbox.slice(2, 4));
  if (hole.bbox[2] <= hole.bbox[0] || hole.bbox[3] <= hole.bbox[1]) throw new TypeError("Invalid hole bounding box.");
  if (!opts || typeof opts !== "object") throw new TypeError("Invalid caddie options.");
  const S = { bag: DEFAULT_BAG, off: .25, treeH: 15, disp: 1, missM: 0, wind: 0,
    seed: 7, elev: null, elevK: 1, par: 4, mishit: 1, samples: 96, policySamples: 12,
    maxShots: 16, styleCost: .3,
    distSd: .07,      // distance spread as a fraction of carry (12-handicap assumption; replace with measured)
    missPct: 0,       // sideways bias as a fraction of carry, + = right (a fade grows with distance)
    ...opts };
  for (const [key, min, max] of [["off", 0, 10], ["treeH", 0, 100], ["disp", 0, 5],
    ["missM", -100, 100], ["wind", -50, 50], ["elevK", 0, 3], ["mishit", 0, 5],
    ["styleCost", 0, 3], ["distSd", .01, .3], ["missPct", -.3, .3]]) finite(S[key], key, min, max);
  integer(S.seed, "seed", 0, 4294967295); integer(S.par, "par", 1, 10);
  integer(S.samples, "samples", 16, 4096); integer(S.policySamples, "policySamples", 4, 256);
  integer(S.maxShots, "maxShots", 2, 64);
  if (S.elev != null && typeof S.elev !== "function") throw new TypeError("elev must be a function.");
  if (!Array.isArray(S.bag) || !S.bag.length) throw new TypeError("bag must not be empty.");
  const names = new Set();
  S.bag = S.bag.map(c => {
    if (!Array.isArray(c) || typeof c[0] !== "string" || !c[0].trim() || names.has(c[0]))
      throw new TypeError("Club names must be nonempty and unique.");
    names.add(c[0]); finite(c[1], "club carry", .5, 400); finite(c[2], "club dispersion", 0, 200);
    return c.slice(0, 3);
  });
  const warnings = [...(hole.warnings || []),
    "Heuristic simulation, not learned AI; scores and probabilities are not field-calibrated.",
    "Water: simplified relief, not Rule 17: one stroke, ball placed 2 m onto the first dry ground back along the line of flight. OB and off-map: stroke and distance.",
    "Straight-flight and flat roll approximations omit spin, bounce, slope roll and wind direction. Elevation affects carry and tree clearance only.",
    "Future shots use a sampled one-step heuristic, not a converged optimal value field; Aggressive and Safe also play their later shots in style.",
    "Monte Carlo intervals describe sampling noise only, not model or map error; candidate selection can make them optimistic."];
  const pin = hole.pin.slice(), dPin = (x, y) => distance([x, y], pin);
  const Z = (x, y) => {
    if (!S.elev) return null;
    const z = S.elev(x, y);
    if (z == null) return null;
    return finite(z, "elevation");
  };
  const zPin = Z(...pin);
  const rise = (a, b) => {
    const za = Z(...a), zb = Z(...b); return za == null || zb == null ? 0 : zb - za;
  };
  const plays = carry => Math.max(.3, carry + S.wind * .7 * carry / 150);
  function es(l, x, y) {
    point([x, y]);
    if (!NAME[l]) throw new TypeError("Unknown lie code.");
    const z = Z(x, y), d = Math.max(0, dPin(x, y) + (z == null || zPin == null ? 0 : S.elevK * (zPin - z)));
    if (l === "G") return interp(PUTT, d) + S.off * .4;
    if (!legal(l)) return 1 + interp(BASE, d) + S.off + PEN.U;
    return interp(BASE, d) + S.off + (PEN[l] ?? .6);
  }
  function samples(key, n) {
    const rnd = mulberry(hash(`${S.seed}|${key}`));
    return Array.from({ length: n }, () => packet(rnd));
  }
  function aimPoint(x, y, o) {
    const target = o.tgt || pin, dx = target[0] - x, dy = target[1] - y;
    const len = Math.hypot(dx, dy), ex = len ? dx / len : 1, ey = len ? dy / len : 0;
    return [x + ex * plays(o.club[1]) + ey * o.off, y + ey * plays(o.club[1]) - ex * o.off];
  }
  function sampleShot(x, y, o, fromTee, p) {
    const aim = aimPoint(x, y, o), dx = aim[0] - x, dy = aim[1] - y, len = Math.hypot(dx, dy) || 1;
    const ex = dx / len, ey = dy / len, c = o.club;
    /* partial wedges and chips: a ~12 handicap leaves chips about 3 m away on average,
       so short shots get a scatter floor instead of shrinking in proportion to length */
    const partial = c[3] === "partial";
    const sdAlong = partial ? Math.max(c[1] * S.distSd, 1.5 + .05 * c[1]) : Math.max(.3, c[1] * S.distSd);
    const radius = partial ? Math.max(c[2], 3 + .08 * c[1]) : c[2];
    let along = Math.max(.1, plays(c[1]) + p.along * sdAlong * S.disp);
    let side = p.side * radius * S.disp / 2 + S.missM + S.missPct * c[1];
    const mishitP = Math.min(.5, S.mishit * (/driver|wood/i.test(c[0]) ? .10 : c[1] >= 170 ? .08 : c[1] >= 120 ? .06 : .04));
    if (p.mishit < mishitP) { along *= .55 + .3 * p.severity; side *= 1.6; }
    let landing = [x + ex * along + ey * side, y + ey * along - ex * side];
    along = Math.max(.1, along - S.elevK * rise([x, y], landing));
    landing = [x + ex * along + ey * side, y + ey * along - ex * side];
    const startZ = Z(x, y), endZ = Z(...landing), flightLen = distance([x, y], landing);
    const apex = (APEX[c[0]] ?? 25) * Math.min(1, c[1] / 60);
    if (hole.hasTrees !== false && S.treeH > 0 && p.tree < .7) {
      const n = Math.max(2, Math.ceil(flightLen / 2));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        if (t * flightLen < (fromTee ? 20 : 2)) continue;
        const pos = [x + (landing[0] - x) * t, y + (landing[1] - y) * t];
        const arc = t <= .6 ? apex * (1 - ((.6 - t) / .6) ** 2) :
          apex * (1 - ((t - .6) / .4) ** 2);
        const terrainZ = Z(...pos);
        const height = startZ == null || endZ == null || terrainZ == null ? arc :
          startZ + (endZ - startZ) * t + arc - terrainZ;
        if (height < S.treeH && hole.lie(...pos) === "T")
          return { x: pos[0], y: pos[1], k: "T", hit: true, prov: hole.provenanceAt ? hole.provenanceAt(...pos) : "marked" };
      }
    }
    const l = hole.lie(...landing);
    if (!legal(l)) return { x: landing[0], y: landing[1], k: l, prov: hole.provenanceAt ? hole.provenanceAt(...landing) : "marked" };
    const roll = (ROLL[l] ?? 2) * (.6 + p.roll * .8) * Math.min(1, c[1] / 60);
    const end = [landing[0] + ex * roll, landing[1] + ey * roll];
    if (hole.pathStops) { const st = hole.pathStops(landing, end);
      if (st.k === "T" && hole.provenanceAt) st.prov = hole.provenanceAt(st.x, st.y);
      return st; }
    for (let i = 0, n = Math.max(1, Math.ceil(roll / .5)); i <= n; i++) {
      const pos = [landing[0] + (end[0] - landing[0]) * i / n, landing[1] + (end[1] - landing[1]) * i / n];
      const k = hole.lie(...pos);
      if (!legal(k) || k === "S" || k === "T") return { x: pos[0], y: pos[1], k };
    }
    return { x: end[0], y: end[1], k: hole.lie(...end) };
  }
  // Stroke and distance is deliberately conservative and always returns a playable origin.
  function recover(o, origin) {
    if (legal(o.k)) return { x: o.x, y: o.y, k: o.k, penalty: 0 };
    if (o.k === "W") {
      // penalty area: one stroke, drop on the first dry, playable ground back along the line of flight
      const dx = origin[0] - o.x, dy = origin[1] - o.y, L = Math.hypot(dx, dy);
      for (let s = 1; s < L; s += 1) {
        const q = [o.x + dx * s / L, o.y + dy * s / L], k = hole.lie(...q);
        if (legal(k) && k !== "W") {
          const r = Math.min(L, s + 2), dropAt = [o.x + dx * r / L, o.y + dy * r / L], kd = hole.lie(...dropAt);
          return legal(kd) && kd !== "W" ? { x: dropAt[0], y: dropAt[1], k: kd, penalty: 1 } : { x: q[0], y: q[1], k, penalty: 1 };
        }
      }
    }
    // OB and off-map: stroke and distance
    return { x: origin[0], y: origin[1], k: hole.lie(...origin), penalty: 1 };
  }
  function candidates(x, y, l, fromTee) {
    const d = dPin(x, y);
    let bag = S.bag.filter(c => fromTee || !/driver/i.test(c[0]));
    if (l === "S") bag = bag.filter(c => /wedge|pw|sw|lw|°|chip/i.test(c[0]) || c[1] <= 105);
    if (l === "T") return [["Punch", Math.min(70, Math.max(2, d * .75)), 12],
      ["Chip", Math.min(25, Math.max(.5, d * .8)), 4]];
    // Generated recovery/short-game shots keep custom sparse bags and tiny holes usable.
    if (!bag.length) bag = [["Recovery wedge", Math.min(60, Math.max(.5, d * .85)), 6]];
    const sorted = bag.slice().sort((a, b) => Math.abs(a[1] - d) - Math.abs(b[1] - d));
    const result = (fromTee ? bag : sorted.slice(0, 4)).map(c => c.slice());
    if (!fromTee && d > 150) for (const leave of [70, 100]) {
      const c = bag.slice().sort((a, b) => Math.abs(a[1] - (d - leave)) - Math.abs(b[1] - (d - leave)))[0];
      if (!result.some(q => q[0] === c[0] && q[1] === c[1])) result.push(c.slice());
    }
    if (d < 110) {
      const adjusted = Math.max(.5, (d - (l === "S" ? 1 : 2)) / (1 + S.wind * .7 / 150));
      const wedges = bag.filter(c => (/wedge|pw|sw|lw|°|chip/i.test(c[0]) || c[1] <= 105) &&
        (l !== "S" || !/chip/i.test(c[0]))).sort((a, b) => a[1] - b[1]);
      const wedge = wedges.find(c => c[1] >= adjusted) || (wedges.length ? null : ["Recovery wedge", 110, 6]);
      if (wedge)
        result.push([wedge[0], adjusted, Math.max(.6, wedge[2] * adjusted / wedge[1]), "partial"]);
      if (d < 35 && l !== "S") result.push(["Chip", Math.max(.5, (d - 1) / (1 + S.wind * .7 / 150)), Math.max(.6, d * .08), "partial"]);
    }
    return result.filter((c, i) => result.findIndex(q => q[0] === c[0] && q[1] === c[1]) === i);
  }
  function targets(x, y) {
    return [null, ...(hole.via || []).filter(v => distance([x, y], v) > 8 && dPin(...v) < dPin(x, y) - 8)];
  }
  function actions(x, y, fromTee, full) {
    const l = fromTee ? "F" : hole.lie(x, y), offs = full ? [-36, -24, -18, -12, -6, 0, 6, 12, 18, 24, 36] : [-9, 0, 9];
    const result = [];
    for (const club of candidates(x, y, l, fromTee))
      for (const tgt of targets(x, y)) for (const off of offs) result.push({ club, off, tgt });
    return result;
  }
  function screen(x, y, o, fromTee, packets) {
    let sum = 0, trouble = 0;
    for (const p of packets) {
      const shot = sampleShot(x, y, o, fromTee, p), r = recover(shot, [x, y]);
      sum += 1 + r.penalty + es(r.k, r.x, r.y);
      if (["S", "T", "W", "O", "X"].includes(shot.k)) trouble++;
    }
    return { mean: sum / packets.length, trouble: trouble / packets.length };
  }
  const policyCache = new Map(), planCache = new Map(), evidenceCache = new Map();
  const STYLE_STEP = .15;   // later shots may give up this much (screened) to play in style
  function policyAt(x, y, style = "optimise") {
    const l = hole.lie(x, y);
    if (!legal(l)) throw new RangeError("Cannot play a shot from water, OB or off-map ground.");
    if (l === "G") return null;
    // Lazy, canonical 6 m policy cells: never clamp out-of-map positions to an edge.
    const ix = Math.floor(x / 6), iy = Math.floor(y / 6), key = `cell|${ix}|${iy}|${l}|${style}`;
    if (policyCache.has(key)) return policyCache.get(key);
    let cx = (ix + .5) * 6, cy = (iy + .5) * 6;
    // A cell straddling a hazard/green uses the actual point and exact-point cache key.
    const canonical = hole.lie(cx, cy) === l && dPin(cx, cy) > 18;
    const actualKey = canonical ? key : `point|${x}|${y}|${l}|${style}`;
    if (policyCache.has(actualKey)) return policyCache.get(actualKey);
    if (!canonical) { cx = x; cy = y; }
    const ps = samples(`policy|${actualKey}`, S.policySamples);
    const list = actions(cx, cy, false, false).map(o => ({ ...o, ...screen(cx, cy, o, false, ps) }));
    list.sort((a, b) => a.mean - b.mean || actionKey(a).localeCompare(actionKey(b)));
    let best = list[0];
    if (style !== "optimise") {
      const near = list.filter(o => o.mean <= list[0].mean + STYLE_STEP);
      best = style === "aggressive"
        ? near.sort((a, b) => b.club[1] - a.club[1] || Math.abs(a.off) - Math.abs(b.off) || a.mean - b.mean)[0]
        : near.sort((a, b) => a.trouble - b.trouble || a.mean - b.mean)[0];
    }
    if (policyCache.size >= 12000) policyCache.clear();
    policyCache.set(actualKey, best);
    return best;
  }
  function playOut(x, y, first, fromTee, packets, style = "optimise") {
    let strokes = 0, cx = x, cy = y, tee = fromTee, o = first, firstShot;
    const chain = [];
    for (let step = 0; step < S.maxShots; step++) {
      const l = hole.lie(cx, cy), p = packets[step];
      if (!o && l === "G") {
        const mean = Math.max(1, es("G", cx, cy)), low = Math.floor(mean);
        return { score: strokes + low + (p.putt < mean - low ? 1 : 0), completed: true, chain, firstShot };
      }
      o = o || policyAt(cx, cy, style);
      if (!o) throw new Error("No playable action.");
      const aim = aimPoint(cx, cy, o), shot = sampleShot(cx, cy, o, tee, p), r = recover(shot, [cx, cy]);
      if (!firstShot) firstShot = shot;
      chain.push({ club: o.club[0], carry: Math.round(plays(o.club[1])), from: [cx, cy], aim,
        rest: [r.x, r.y], outcome: shot.k, penalty: r.penalty, lie: NAME[r.k],
        left: Math.round(dPin(r.x, r.y)), rise: Math.round(rise([cx, cy], [r.x, r.y])) });
      strokes += 1 + r.penalty; cx = r.x; cy = r.y; tee = tee && r.penalty > 0; o = null;
    }
    if (hole.lie(cx, cy) === "G") {
      const mean = Math.max(1, es("G", cx, cy)), low = Math.floor(mean);
      return { score: strokes + low + (packets[S.maxShots - 1].putt < mean - low ? 1 : 0),
        completed: true, chain, firstShot };
    }
    // Report non-completion explicitly, adding a labelled heuristic tail rather than fabricated putts.
    return { score: strokes + es(hole.lie(cx, cy), cx, cy), completed: false, chain, firstShot };
  }
  function evidence(x, y, o, fromTee, trials, style = "optimise") {
    const runs = trials.map(ps => playOut(x, y, o, fromTee, ps, style)), scores = runs.map(r => r.score);
    const n = scores.length, avg = scores.reduce((a, b) => a + b, 0) / n;
    const variance = scores.reduce((s, v) => s + (v - avg) ** 2, 0) / (n - 1);
    const se = Math.sqrt(variance / n), sorted = scores.slice().sort((a, b) => a - b);
    const mix = {};
    let trouble = 0, completed = 0, birdie = 0, bogey = 0, dbl = 0;
    const sources = { T: { marked: 0, surface: 0, assumed: 0, outside: 0 }, O: { marked: 0, surface: 0, assumed: 0, outside: 0 } };
    for (const r of runs) {
      const k = r.firstShot.k; mix[k] = (mix[k] || 0) + 1 / n;
      if (sources[k]) sources[k][r.firstShot.prov || "marked"] += 1 / n;
      if (["S", "T", "W", "O", "X"].includes(k)) trouble++;
      if (r.completed) { completed++; if (r.score <= S.par - 1) birdie++;
        if (r.score >= S.par + 1) bogey++; if (r.score >= S.par + 2) dbl++; }
    }
    const representative = runs.slice().sort((a, b) => Math.abs(a.score - sorted[Math.floor(n / 2)]) -
      Math.abs(b.score - sorted[Math.floor(n / 2)]))[0];
    const wilson = k => {
      const z2 = 1.96 ** 2, p = k / n, centre = (p + z2 / (2 * n)) / (1 + z2 / n);
      const half = 1.96 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
      return [Math.max(0, centre - half), Math.min(1, centre + half)];
    };
    return { ...o, avg, v: avg, good: sorted[Math.floor(.25 * (n - 1))],
      bad: sorted[Math.floor(.8 * (n - 1))], trouble: trouble / n, mix,
      pBirdie: completed === n ? birdie / n : null,
      pBogey: completed === n ? bogey / n : null, pDouble: completed === n ? dbl / n : null,
      completedFraction: completed / n, incompleteFraction: 1 - completed / n,
      sampleCount: n, standardError: se, confidence95: [avg - 1.96 * se, avg + 1.96 * se],
      probability95: completed === n ? { birdie: wilson(birdie), bogey: wilson(bogey), double: wilson(dbl) } : null,
      sources, completedRuns: runs.map(r => r.completed),
      cloud: runs.map(r => r.firstShot), chain: representative.chain,
      chainCompleted: representative.completed, scores };
  }
  /* Strategies by style, each within styleCost strokes of the best simulated average:
     aggressive = the boldest option (longest club, then nearest the flag line, then most birdies);
     safe = fewest doubles-or-worse plus half the shot's trouble rate;
     optimise = lowest average. (Percentiles of whole-number hole scores tie almost always,
     which made all three identical in testing.) */
  function pick(list, style) {
    const bestMean = Math.min(...list.map(o => o.avg));
    const viable = style === "optimise" ? list : list.filter(o => o.avg <= bestMean + S.styleCost);
    const tie = (a, b) => a.avg - b.avg || actionKey(a).localeCompare(actionKey(b));
    if (style === "aggressive") return viable.slice().sort((a, b) => b.club[1] - a.club[1] ||
      Math.abs(a.off) - Math.abs(b.off) || (b.pBirdie ?? 0) - (a.pBirdie ?? 0) || tie(a, b))[0];
    if (style === "safe") return viable.slice().sort((a, b) =>
      ((a.pDouble ?? a.incompleteFraction) + .5 * a.trouble) - ((b.pDouble ?? b.incompleteFraction) + .5 * b.trouble) || tie(a, b))[0];
    return viable.slice().sort(tie)[0];
  }
  function publicOption(o) {
    const { cloud, chain, scores, chainCompleted, ...option } = o;
    return option;
  }
  function planFrom(x, y, fromTee) {
    point([x, y]);
    const l = hole.lie(x, y);
    if (!legal(l)) throw new RangeError("Move to a legal relief/replay position before requesting a plan.");
    const key = `${x}|${y}|${fromTee}`;
    if (planCache.has(key)) return clone(planCache.get(key));
    if (l === "G" && !fromTee) {
      const expected = es(l, x, y);
      const base = { best: { club: ["Putt", dPin(x, y), 0], off: 0, tgt: null, avg: expected, v: expected },
        options: [], cloud: [], chain: [], expected, pBirdie: null, pBogey: null, pDouble: null,
        toPin: dPin(x, y), status: "putt", warnings };
      const out = { ...base, strategies: { optimise: base, safe: base, aggressive: base }, agree: true,
        climb: zPin == null || Z(x, y) == null ? null : zPin - Z(x, y) };
      return clone(out);
    }
    const ps = samples(`screen|${key}`, S.samples);
    const tried = actions(x, y, fromTee, true).map(o => ({ ...o, ...screen(x, y, o, fromTee, ps) }));
    tried.sort((a, b) => a.mean - b.mean || actionKey(a).localeCompare(actionKey(b)));
    const pool = [], seen = new Set();
    const add = o => { const k = actionKey(o); if (!seen.has(k)) { seen.add(k); pool.push(o); } };
    tried.slice(0, 5).forEach(add);
    const byClub = new Map();
    for (const o of tried) {
      const k = JSON.stringify(o.club);
      if (!byClub.has(k)) byClub.set(k, []);
      byClub.get(k).push(o);
    }
    for (const list of byClub.values()) {
      add(list[0]);
      add(list.filter(o => o.mean <= list[0].mean + .3).sort((a, b) => a.trouble - b.trouble || a.mean - b.mean)[0]);
    }
    // Every option and every strategy sees exactly the same trial/step random packets.
    const trials = Array.from({ length: S.samples }, (_, i) => samples(`rollout|${key}|${i}`, S.maxShots));
    const scored = pool.map(o => evidence(x, y, o, fromTee, trials));
    /* Strategies (paired, whole-plan):
       Optimise = lowest simulated average.
       Safe = lowest chance of double bogey or worse; Aggressive = highest chance of birdie or better.
       A Safe/Aggressive plan is evaluated as a WHOLE plan (first shot + later shots played in that
       style) on the SAME trials as Optimise. It is used only if (1) its paired average costs at most
       styleCost strokes and (2) it improves its own goal by more than 1.96 paired standard errors.
       Otherwise the strategy equals Optimise, with the reason stated. */
    const optBest = pick(scored, "optimise");
    const paired = (a, b) => { const d = a.map((v, i) => v - b[i]), n = d.length, m = d.reduce((s, v) => s + v, 0) / n;
      const se = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, n - 1) / n); return { mean: m, se, ci95: [m - 1.96 * se, m + 1.96 * se] }; };
    const flags = (ev, goal) => ev.scores.map((s, i) => goal === "safe" ? (!ev.completedRuns[i] || s >= S.par + 2 ? 1 : 0) : (ev.completedRuns[i] && s <= S.par - 1 ? 1 : 0));
    const strategyOf = (best, style, verdict) => {
      const perClub = new Map();
      for (const o of scored) { const k = JSON.stringify(o.club); if (!perClub.has(k) || o.avg < perClub.get(k).avg) perClub.set(k, o); }
      const alternatives = [...perClub.values()].filter(o => actionKey(o) !== actionKey(best)).sort((a, b) => a.avg - b.avg);
      // is the plan actually better than the next-best club, or a near-tie?
      let comparison = null;
      const next = alternatives[0];
      if (next && next.scores && best.scores && next.scores.length === best.scores.length) {
        const c = paired(best.scores, next.scores);
        comparison = { versus: `${next.club[0]} ${next.tgt ? "to the corner" : next.off + " m"}`, meanDifference: c.mean, pairedConfidence95: c.ci95,
          distinguishable: Math.abs(c.mean) > 1.96 * c.se };
      }
      return { best: publicOption(best), comparison, options: [best, ...alternatives].slice(0, 3).map(publicOption),
        cloud: best.cloud, chain: best.chain, chainCompleted: best.chainCompleted,
        expected: best.avg, pBirdie: best.pBirdie, pBogey: best.pBogey, pDouble: best.pDouble,
        sources: best.sources, toPin: dPin(x, y), status: best.incompleteFraction ? "incomplete-model-tail" : "simulated",
        uncertainty: { note: "Sampling noise only; says nothing about map or player-model error.",
          standardError: best.standardError, confidence95: best.confidence95, probability95: best.probability95, sampleCount: best.sampleCount },
        verdict, incompleteFraction: best.incompleteFraction, warnings };
    };
    const strategies = { optimise: strategyOf(optBest, "optimise", { style: "optimise", chosen: true, reason: "Lowest simulated average." }) };
    for (const style of ["safe", "aggressive"]) {
      const goal = style === "safe" ? "pDouble" : "pBirdie", better = style === "safe" ? 1 : -1;   // safe: lower is better
      const shortlist = scored.slice().sort((a, b) => better * ((a[goal] ?? 1) - (b[goal] ?? 1)) || a.avg - b.avg).slice(0, 6);
      if (!shortlist.some(o => actionKey(o) === actionKey(optBest))) shortlist.push(optBest);
      const baseFlags = flags(optBest, style);
      let chosen = null, tested = 0;
      for (const cand of shortlist) {
        const plan = evidence(x, y, cand, fromTee, trials, style); tested++;
        const cost = paired(plan.scores, optBest.scores), gain = paired(flags(plan, style), baseFlags);
        const improves = style === "safe" ? gain.mean < -1.96 * gain.se && gain.mean < 0 : gain.mean > 1.96 * gain.se && gain.mean > 0;
        if (cost.mean <= S.styleCost && improves) {
          const score = style === "safe" ? gain.mean : -gain.mean;
          if (!chosen || score < chosen.score - 1e-12 || (Math.abs(score - chosen.score) < 1e-12 && cost.mean < chosen.cost.mean)) chosen = { plan, cost, gain, score };
        }
      }
      if (chosen) {
        const what = style === "safe" ? "doubles or worse" : "birdies or better";
        strategies[style] = strategyOf(chosen.plan, style, { style, chosen: true, candidatesTested: tested,
          reason: `Changes ${what} by ${(100 * chosen.gain.mean).toFixed(1)} points (95% ${(100 * chosen.gain.ci95[0]).toFixed(1)} to ${(100 * chosen.gain.ci95[1]).toFixed(1)}) for ${chosen.cost.mean >= 0 ? "+" : ""}${chosen.cost.mean.toFixed(2)} strokes (95% ${chosen.cost.ci95[0].toFixed(2)} to ${chosen.cost.ci95[1].toFixed(2)}), paired over ${optBest.scores.length} trials.`,
          goalChange: chosen.gain, costChange: chosen.cost });
      } else {
        strategies[style] = strategyOf(optBest, style, { style, chosen: false, candidatesTested: tested,
          reason: style === "safe"
            ? `No plan within ${S.styleCost} strokes cuts doubles-or-worse by more than simulation noise; Safe = Optimise.`
            : `No plan within ${S.styleCost} strokes raises birdies-or-better by more than simulation noise; Aggressive = Optimise.` });
      }
    }
    // Optimise must be the lowest average of the plans shown: adopt a styled plan that beat it
    for (const style of ["aggressive", "safe"])
      if (strategies[style].verdict.chosen && strategies[style].expected < strategies.optimise.expected - 1e-9)
        strategies.optimise = { ...strategies[style], verdict: { style: "optimise", chosen: true,
          reason: `Lowest simulated average (a ${style} plan scored lower than the default plan, so Optimise uses it).` } };
    const out = { ...strategies.optimise, strategies,
      agree: actionKey(strategies.safe.best) === actionKey(strategies.optimise.best) &&
        actionKey(strategies.aggressive.best) === actionKey(strategies.optimise.best),
      climb: zPin == null || Z(x, y) == null ? null : Math.round(zPin - Z(x, y)) };
    if (planCache.size >= 64) { planCache.clear(); evidenceCache.clear(); }
    evidenceCache.set(key, scored);
    planCache.set(key, clone(out));
    return clone(out);
  }
  function teeByClub(n = S.samples) {
    integer(n, "teeByClub samples", 16, 4096);
    planFrom(0, 0, true);
    const scored = evidenceCache.get("0|0|true");
    const trials = n === S.samples ? null :
      Array.from({ length: n }, (_, i) => samples(`rollout|0|0|true|${i}`, S.maxShots));
    const rows = [];
    for (const name of new Set(scored.map(o => o.club[0]))) {
      const bestAim = scored.filter(o => o.club[0] === name).sort((a, b) => a.avg - b.avg ||
        actionKey(a).localeCompare(actionKey(b)))[0];
      const score = trials ? evidence(0, 0, bestAim, true, trials) : bestAim;
      rows.push({ club: name, carry: bestAim.club[1], off: bestAim.off, corner: !!bestAim.tgt,
        tgt: bestAim.tgt, avg: score.avg, pBirdie: score.pBirdie, pBogey: score.pBogey,
        pDouble: score.pDouble, confidence95: score.confidence95,
        incompleteFraction: score.incompleteFraction, sampleCount: n });
    }
    return rows;
  }
  return { teeByClub, planTee: () => planFrom(0, 0, true), planFrom: (x, y) => planFrom(x, y, false),
    lie: hole.lie, es, warnings: warnings.slice(), model: "deterministic-heuristic-monte-carlo" };
}

const api = { DEFAULT_BAG, NAME, buildHole, makeCaddie, projector };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.CaddieEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
