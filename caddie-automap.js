/* Caddie auto-mapper — reads Mapbox satellite imagery for the course and classifies
   every ~1.2 m cell as: R rough, F fairway, S sand, W water, T trees, G green, O out of
   bounds (buildings, roads), U uncertain (shadow, mixed, unreadable).
   Anchors from OpenStreetMap: each hole's routing line and green point, and water.
   Personal, non-commercial use of Mapbox imagery only. */
(function (root) {
"use strict";
const LET = "RFSWTGOU", CODE = { R: 0, F: 1, S: 2, W: 3, T: 4, G: 5, O: 6, U: 7 };
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };

async function fetchMosaic(bbox, token, z = 17, T = 256, onProgress) {       // bbox [w,s,e,n]
  const tx0 = Math.floor(lon2x(bbox[0], z)), tx1 = Math.floor(lon2x(bbox[2], z));
  const ty0 = Math.floor(lat2y(bbox[3], z)), ty1 = Math.floor(lat2y(bbox[1], z));
  const W = (tx1 - tx0 + 1) * T, H = (ty1 - ty0 + 1) * T;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  let done = 0; const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const url = `https://api.mapbox.com/v4/mapbox.satellite/${z}/${tx}/${ty}@2x.jpg90?access_token=${token}`;
    jobs.push(fetch(url).then(r => { if (!r.ok) throw new Error("imagery tile " + r.status); return r.blob(); })
      .then(b => createImageBitmap(b)).then(img => { ctx.drawImage(img, (tx - tx0) * T, (ty - ty0) * T, T, T); onProgress && onProgress(++done, total); }));
  }
  await Promise.all(jobs);
  const mpp = 40075016.7 * Math.cos((bbox[1] + bbox[3]) / 2 * Math.PI / 180) / (T * 2 ** z);
  return { cv, W, H, tx0, ty0, z, T, mpp };
}

/* integral-image box statistics */
function boxSD(gray, W, H, r) {
  const I = new Float64Array((W + 1) * (H + 1)), I2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let s = 0, s2 = 0;
    for (let x = 0; x < W; x++) { const v = gray[y * W + x]; s += v; s2 += v * v;
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; I2[(y + 1) * (W + 1) + x + 1] = I2[y * (W + 1) + x + 1] + s2; } }
  const sd = new Float32Array(W * H), mean = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { const ya = Math.max(0, y - r), yb = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) { const xa = Math.max(0, x - r), xb = Math.min(W, x + r + 1), n = (yb - ya) * (xb - xa);
      const A = (i, j) => I[i * (W + 1) + j], B = (i, j) => I2[i * (W + 1) + j];
      const s = A(yb, xb) - A(ya, xb) - A(yb, xa) + A(ya, xa), s2 = B(yb, xb) - B(ya, xb) - B(yb, xa) + B(ya, xa);
      const m = s / n; mean[y * W + x] = m; sd[y * W + x] = Math.sqrt(Math.max(0, s2 / n - m * m)); } }
  return { sd, mean };
}
function components(mask, W, H) {            // 4-connected labels
  const lab = new Int32Array(W * H), sizes = [0]; let n = 0; const st = [];
  for (let i = 0; i < W * H; i++) { if (!mask[i] || lab[i]) continue; n++; let c = 0; st.push(i); lab[i] = n;
    while (st.length) { const j = st.pop(); c++; const x = j % W, y = (j / W) | 0;
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1])
        if (k >= 0 && mask[k] && !lab[k]) { lab[k] = n; st.push(k); } }
    sizes.push(c); }
  return { lab, sizes };
}

function classify(M, anchors, onStep) {
  const { W, H, mpp } = M, N = W * H;
  const px = M.cv.getContext("2d").getImageData(0, 0, W, H).data;
  const toPix = ([lon, lat]) => [(lon2x(lon, M.z) - M.tx0) * M.T, (lat2y(lat, M.z) - M.ty0) * M.T];
  const gray = new Float32Array(N), V = new Float32Array(N), Sat = new Float32Array(N), Hue = new Float32Array(N), Bs = new Float32Array(N), ExG = new Float32Array(N);
  for (let i = 0; i < N; i++) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    gray[i] = (r + g + b) / 3; V[i] = mx / 255; Sat[i] = mx ? (mx - mn) / mx : 0; Bs[i] = b / (r + g + b + 1); ExG[i] = (2 * g - r - b) / (r + g + b + 1);
    let h = 0; if (mx !== mn) { if (mx === r) h = 60 * (((g - b) / (mx - mn)) % 6); else if (mx === g) h = 60 * ((b - r) / (mx - mn) + 2); else h = 60 * ((r - g) / (mx - mn) + 4); }
    Hue[i] = h < 0 ? h + 360 : h; }
  onStep && onStep("texture");
  const t2 = boxSD(gray, W, H, 2), t5 = boxSD(gray, W, H, 5);           // ~5 m and ~13 m windows
  // distance (m) of every pixel to the nearest routing line, on a coarse grid for speed
  const routes = anchors.routes.map(L => L.map(toPix));
  const segD = (x, y) => { let b = Infinity; for (const L of routes) for (let i = 0; i < L.length - 1; i++) {
      const [ax, ay] = L[i], [bx, by] = L[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)); b = Math.min(b, Math.hypot(x - ax - t * dx, y - ay - t * dy)); } return b * mpp; };
  const DS = 8, DW = Math.ceil(W / DS), DH = Math.ceil(H / DS), dRoute = new Float32Array(DW * DH);
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) dRoute[y * DW + x] = segD(x * DS + DS / 2, y * DS + DS / 2);
  const dR = i => dRoute[(((i / W) | 0) / DS | 0) * DW + ((i % W) / DS | 0)];
  onStep && onStep("surfaces");
  const cls = new Uint8Array(N).fill(CODE.R);
  for (let i = 0; i < N; i++) {
    const v = V[i], s = Sat[i], hu = Hue[i], sd = t2.sd[i], r = px[i * 4], b = px[i * 4 + 2];
    const greenish = hu >= 55 && hu <= 170 && ExG[i] > 0.02;
    /* thresholds calibrated on Mapbox imagery against the verified Hole 1 map (Seri Selangor):
       bunkers V 0.64-0.89, S 0.18-0.24, hue 32-51; fairway V 0.36-0.56; trees V 0.19-0.46, hue 63-129 */
    if (v > 0.64 && s < 0.27 && hu >= 20 && hu <= 60 && ExG[i] < 0.06) { cls[i] = CODE.S; continue; }         // sand
    if (v < 0.30 && Bs[i] > 0.33 && sd < 9) { cls[i] = CODE.U; continue; }                                      // shade: can't tell
    if (v < 0.33 || (v < 0.42 && hu > 95) || (v < 0.46 && sd > 14 && greenish)) { cls[i] = CODE.T; continue; } // canopy
    const roof = (s > 0.28 && (hu < 38 || hu > 300) && v > 0.35) || (s < 0.11 && v > 0.40 && !greenish);         // roofs, roads, paths
    if (roof) { cls[i] = dR(i) > 30 ? CODE.O : CODE.U; continue; }
    if (!greenish) { cls[i] = CODE.U; continue; }
  }
  onStep && onStep("water and sand");
  // water: OSM polygons, plus large smooth dark blobs
  const inPoly = (x, y, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  for (const poly of anchors.water) { const ring = poly.map(toPix); const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(H, Math.ceil(Math.max(...ys))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(W, Math.ceil(Math.max(...xs))); x++) if (inPoly(x + .5, y + .5, ring)) cls[y * W + x] = CODE.W; }
  /* no water guessing from imagery: measured on this course, ponds and forest canopy have the same
     colour and texture at this resolution. Water comes from OpenStreetMap or the golfer. */
  // bunkers only exist on holes: bright sand-coloured patches > 50 m from every line of play are roofs and roads
  // (measured on Seri Selangor: 19 of 23 ha of "sand" lay > 100 m from any hole)
  for (let i = 0; i < N; i++) if (cls[i] === CODE.S && dR(i) > 50) cls[i] = CODE.O;
  { const sand = new Uint8Array(N); for (let i = 0; i < N; i++) sand[i] = cls[i] === CODE.S ? 1 : 0;       // drop sand specks
    const { lab, sizes } = components(sand, W, H); const minPx = 5 / (mpp * mpp);
    for (let i = 0; i < N; i++) if (lab[i] && sizes[lab[i]] < minPx) cls[i] = CODE.R; }
  onStep && onStep("fairways");
  // fairway: the smoother half of the grass near each hole's line of play
  const grassSd = []; for (let i = 0; i < N; i += 3) if (cls[i] === CODE.R && dR(i) < 40) grassSd.push(t5.sd[i]);
  grassSd.sort((a, b) => a - b); const fwCut = grassSd.length ? grassSd[Math.floor(grassSd.length * .5)] : 0;
  for (let i = 0; i < N; i++) if (cls[i] === CODE.R && dR(i) < 40 && t5.sd[i] <= fwCut) cls[i] = CODE.F;
  onStep && onStep("greens");
  // greens: grow outwards from each green point over the smoothest nearby turf (max ~22 m)
  for (const g of anchors.greens) { const [gx, gy] = toPix(g).map(Math.round); if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
    const R = Math.round(22 / mpp), vals = [];
    for (let y = gy - R; y <= gy + R; y++) for (let x = gx - R; x <= gx + R; x++) { if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x; if ((cls[i] === CODE.R || cls[i] === CODE.F) && Math.hypot(x - gx, y - gy) <= R) vals.push(t2.sd[i]); }
    if (!vals.length) continue; vals.sort((a, b) => a - b); const cut = vals[Math.floor(vals.length * .45)];
    const seen = new Set(), st = [gy * W + gx];
    while (st.length) { const i = st.pop(); if (seen.has(i)) continue; seen.add(i); const x = i % W, y = (i / W) | 0;
      if (Math.hypot(x - gx, y - gy) > R) continue; if (!(cls[i] === CODE.R || cls[i] === CODE.F || i === gy * W + gx)) continue;
      if (t2.sd[i] > cut * 1.15 && i !== gy * W + gx) continue;
      cls[i] = CODE.G; for (const k of [i - 1, i + 1, i - W, i + W]) if (k >= 0 && k < N) st.push(k); } }
  onStep && onStep("tidy");
  // majority filter to remove speckle (keeps bunkers and greens)
  const out = cls.slice();
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; const c = new Uint8Array(8);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) c[cls[i + dy * W + dx]]++;
    let best = cls[i], bn = c[best]; for (let k = 0; k < 8; k++) if (c[k] > bn) { bn = c[k]; best = k; }
    if (bn >= 5) out[i] = best; }
  const counts = {}; for (let i = 0; i < N; i++) counts[LET[out[i]]] = (counts[LET[out[i]]] || 0) + 1;
  for (const k in counts) counts[k] = Math.round(counts[k] * mpp * mpp);
  return { codes: out, W, H, z: M.z, tx0: M.tx0, ty0: M.ty0, T: M.T, mpp, areasM2: counts };
}

/* lookup for the planner: lon/lat -> surface letter */
function sampler(S) {
  return (lon, lat) => { const x = Math.floor((lon2x(lon, S.z) - S.tx0) * S.T), y = Math.floor((lat2y(lat, S.z) - S.ty0) * S.T);
    if (x < 0 || y < 0 || x >= S.W || y >= S.H) return null; return LET[S.codes[y * S.W + x]]; };
}
const COL = [[70, 120, 55, 150], [126, 224, 106, 160], [242, 210, 122, 220], [59, 143, 214, 200], [20, 60, 30, 200], [233, 255, 154, 230], [214, 59, 214, 170], [255, 255, 255, 120]];
function overlay(S) {                          // coloured picture + its map corners
  const cv = document.createElement("canvas"); cv.width = S.W; cv.height = S.H; const ctx = cv.getContext("2d");
  const im = ctx.createImageData(S.W, S.H);
  for (let i = 0; i < S.W * S.H; i++) { const c = COL[S.codes[i]]; im.data.set(c, i * 4); }
  ctx.putImageData(im, 0, 0);
  const w = x2lon(S.tx0, S.z), e = x2lon(S.tx0 + S.W / S.T, S.z), n = y2lat(S.ty0, S.z), s = y2lat(S.ty0 + S.H / S.T, S.z);
  return { url: cv.toDataURL("image/png"), coordinates: [[w, n], [e, n], [e, s], [w, s]] };
}
function pack(S) {                              // run-length encode for storage
  const out = []; let prev = S.codes[0], run = 0;
  for (let i = 0; i < S.codes.length; i++) { if (S.codes[i] === prev && run < 65535) run++; else { out.push(prev, run); prev = S.codes[i]; run = 1; } }
  out.push(prev, run);
  return JSON.stringify({ W: S.W, H: S.H, z: S.z, tx0: S.tx0, ty0: S.ty0, T: S.T, mpp: S.mpp, areasM2: S.areasM2, rle: out });
}
function unpack(txt) { const o = JSON.parse(txt), codes = new Uint8Array(o.W * o.H); let k = 0;
  for (let i = 0; i < o.rle.length; i += 2) { codes.fill(o.rle[i], k, k + o.rle[i + 1]); k += o.rle[i + 1]; }
  return Object.assign(o, { codes }); }

root.CaddieAutoMap = { fetchMosaic, classify, sampler, overlay, pack, unpack, LET };
})(typeof window !== "undefined" ? window : globalThis);
