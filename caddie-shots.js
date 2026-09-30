/* Shot-log analysis for the AI caddie.
 *
 * A logged shot is: where the player stood (from), where they aimed (aim), where the ball
 * finished (to), the club, the lie, and two flags (bad strike, hit an obstacle).
 * From each shot we measure, relative to the AIM LINE:
 *   along   = distance travelled along the aim line (m)            (short / long)
 *   lateral = distance right (+) or left (-) of the aim line (m)   (the miss)
 * then estimate per-club carry, sideways spread and bias, and pooled distance spread,
 * distance-proportional bias and bad-strike rate.
 *
 * Honest limits, all of which the code or the UI states:
 *  - Phone GPS is only good to a few metres. Its noise is subtracted from the variances
 *    (two fixes per shot), but it is an estimate, not a cure.
 *  - "Aim" is where the player (or the plan) pointed; aiming error is included in the sideways
 *    spread, because it cannot be separated from swing error.
 *  - Measured distance is to where the ball STOPPED (carry + roll). Carry is estimated by
 *    subtracting the roll the engine assumes for the finishing lie.
 *  - Suggestions are blended slowly toward the current estimate, and only offered once enough
 *    shots exist. Nothing here proves the plans are good; it only replaces guesses with
 *    measurements of this player.
 */
(function (root) {
"use strict";

const ROLL = { TEE: 9, F: 9, R: 4, G: 3, S: 0, T: 2, U: 4 };    // roll the engine assumes after landing (m)
const EXCLUDED_LIES = new Set(["S", "T", "G"]);                  // bunker, trees, green: not standard conditions
const PRIOR_SHOTS = 8;       // current estimate counts as this many pseudo-shots when blending
const MIN_CLUB = 8;          // shots before a club's carry / spread may be updated
const GOOD_CLUB = 15;        // shots before a club's numbers are called reasonable
const MIN_DIST_DOF = 20;     // pooled distance spread: degrees of freedom needed
const MIN_MISS = 20;         // shots before the distance-proportional bias is offered
const MIN_MISHIT = 40;       // shots before the bad-strike rate is offered
const MAX_ACC = 25;          // shots with a worse GPS fix than this (m) are not used

function metresPerDegree(latDeg) {
  const p = latDeg * Math.PI / 180;
  return { lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
           lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) };
}
function project(origin, p) {
  const m = metresPerDegree(origin[1]);
  return [(p[0] - origin[0]) * m.lon, (p[1] - origin[1]) * m.lat];
}
const isPoint = v => Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
// reported accuracy is a ~68% radius; per-axis standard deviation is about accuracy / 1.5
const accSigma = a => (Number.isFinite(a) && a > 0 ? a : 5) / 1.5;

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function variance(a) {
  if (a.length < 2) return 0;
  const m = mean(a); return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
}
/* the engine's own default bad-strike rate for a club (kept in sync with caddie-engine.js) */
function defaultMishitRate(name, carry) {
  return /driver|wood/i.test(name) ? .10 : carry >= 170 ? .08 : carry >= 120 ? .06 : .04;
}

/* geometry of one shot relative to its aim line */
function measure(shot, opts = {}) {
  const elevK = opts.elevK == null ? 1 : opts.elevK;
  if (!shot || !isPoint(shot.from) || !isPoint(shot.to) || !isPoint(shot.aim)) return { valid: false, reason: "missing position" };
  const end = project(shot.from, shot.to), aim = project(shot.from, shot.aim);
  const aimLen = Math.hypot(aim[0], aim[1]);
  if (aimLen < 1) return { valid: false, reason: "aim point is at the start" };
  const ex = aim[0] / aimLen, ey = aim[1] / aimLen;
  const along = end[0] * ex + end[1] * ey;
  const lateral = end[0] * ey - end[1] * ex;                     // right of the aim line is positive
  const dz = Number.isFinite(shot.zFrom) && Number.isFinite(shot.zTo) ? shot.zTo - shot.zFrom : null;
  // landing higher than you started = the ball came down sooner, so the flat-ground equivalent is longer
  const flatAlong = along + (dz == null ? 0 : elevK * dz);
  const sa = accSigma(shot.accFrom), sb = accSigma(shot.accTo);
  // GPS noise in each direction. Distance: both fixes count in full. Sideways: the aim point is fixed on the
  // map, so an error in WHERE YOU STOOD barely moves the miss of a ball that finished near the target:
  // it counts only by (1 - along/aimLength)^2. (Subtracting the full amount over-corrected by ~15%.)
  const noiseVarAlong = sa * sa + sb * sb;
  const noiseVarLat = sb * sb + sa * sa * (1 - along / aimLen) ** 2;
  return { valid: true, along, lateral, dist: Math.hypot(end[0], end[1]), dz, elevApplied: dz != null,
           flatAlong, noiseVarAlong, noiseVarLat, aimLen };
}

/* why a shot is, or is not, used for the statistics */
function usability(shot, m) {
  if (!m.valid) return "invalid";
  if (shot.ignored) return "ignored";
  if (EXCLUDED_LIES.has(shot.lie)) return "lie";
  if (shot.obstacle) return "obstacle";
  if ((shot.accFrom || 0) > MAX_ACC || (shot.accTo || 0) > MAX_ACC) return "gps";
  if (m.dist < 5) return "short";
  return "ok";
}

function analyse(shots, bag, opts = {}) {
  const elevK = opts.elevK == null ? 1 : opts.elevK, k = opts.priorShots == null ? PRIOR_SHOTS : opts.priorShots;
  const priorDistSd = opts.priorDistSd == null ? .07 : opts.priorDistSd;
  const excluded = { invalid: 0, ignored: 0, lie: 0, obstacle: 0, gps: 0, short: 0, club: 0 };
  const byClub = new Map(bag.map(c => [c[0], { club: c[0], priorCarry: c[1], priorW: c[2], used: [], logged: 0, mishits: 0 }]));
  const pooledPts = [];                                           // every usable non-mishit shot: distance, lateral
  for (const s of shots || []) {
    const m = measure(s, { elevK }), why = usability(s, m);
    if (why !== "ok") { excluded[why]++; continue; }
    const row = byClub.get(s.club);
    if (!row) { excluded.club++; continue; }
    row.logged++;
    if (s.mishit) { row.mishits++; continue; }                    // counted for the bad-strike rate only
    const roll = ROLL[s.endLie] == null ? 4 : ROLL[s.endLie];
    const u = { flat: m.flatAlong, lat: m.lateral, carry: m.flatAlong - roll, noiseA: m.noiseVarAlong, noiseL: m.noiseVarLat };
    row.used.push(u); pooledPts.push(u);
  }

  const rows = [];
  let dof = 0, relVarSum = 0, logged = 0, flagged = 0, expected = 0;
  for (const r of byClub.values()) {
    const n = r.used.length;
    const out = { club: r.club, priorCarry: r.priorCarry, priorW: r.priorW, logged: r.logged, n, mishits: r.mishits,
      status: n < MIN_CLUB ? "need" : n < GOOD_CLUB ? "provisional" : "reasonable", needed: Math.max(0, MIN_CLUB - n) };
    if (n >= 2) {
      const flats = r.used.map(u => u.flat), lats = r.used.map(u => u.lat);
      const noiseA = mean(r.used.map(u => u.noiseA)), noiseL = mean(r.used.map(u => u.noiseL));
      out.meanFlat = mean(flats);
      out.carryEst = mean(r.used.map(u => u.carry));
      out.carrySE = Math.sqrt(variance(r.used.map(u => u.carry)) / n);
      out.sdDist = Math.sqrt(Math.max(0, variance(flats) - noiseA));         // GPS noise removed
      out.sdDistPct = out.sdDist / out.meanFlat;
      out.bias = mean(lats);
      out.sdLat = Math.sqrt(Math.max(0, variance(lats) - noiseL));
      out.wMeas = 2 * out.sdLat;                                              // engine: 95% half-width = 2 sd
      if (n >= 5) { dof += n - 1; relVarSum += (n - 1) * (out.sdDist / out.meanFlat) ** 2; }
    }
    if (n >= MIN_CLUB) {
      out.carrySuggest = (n * out.carryEst + k * r.priorCarry) / (n + k);
      out.wSuggest = (n * out.wMeas + k * r.priorW) / (n + k);
    }
    logged += r.logged; flagged += r.mishits; expected += r.logged * defaultMishitRate(r.club, r.priorCarry);
    rows.push(out);
  }

  const pooled = { distSd: { prior: priorDistSd, dof, needed: MIN_DIST_DOF },
                   missPct: { n: pooledPts.length, needed: MIN_MISS },
                   mishit: { logged, flagged, needed: MIN_MISHIT } };
  if (dof > 0) pooled.distSd.measured = Math.sqrt(relVarSum / dof);
  if (dof >= MIN_DIST_DOF) pooled.distSd.suggest = Math.sqrt((relVarSum + 10 * priorDistSd ** 2) / (dof + 10));

  // bias that grows with distance: lateral = beta * distance, fitted through the origin
  if (pooledPts.length >= 3) {
    let sxy = 0, sxx = 0; for (const u of pooledPts) { sxy += u.flat * u.lat; sxx += u.flat * u.flat; }
    const beta = sxy / sxx, res = pooledPts.map(u => u.lat - beta * u.flat);
    pooled.missPct.measured = beta;
    pooled.missPct.se = Math.sqrt(variance(res) / sxx);
    if (pooledPts.length >= MIN_MISS) pooled.missPct.suggest = sxy / (sxx + k * 150 * 150);   // shrinks toward "straight"
  }
  if (logged > 0) {
    pooled.mishit.rate = flagged / logged; pooled.mishit.defaultRate = expected / logged;
    if (logged >= MIN_MISHIT) {
      const blended = (flagged + 20 * pooled.mishit.defaultRate) / (logged + 20);
      pooled.mishit.suggestRate = blended;
      pooled.mishit.suggestScale = Math.max(0, Math.min(2, blended / pooled.mishit.defaultRate));
    }
  }
  return { rows, pooled, excluded, totalLogged: (shots || []).length,
           totalUsed: rows.reduce((s, r) => s + r.logged, 0) };
}

/* the bag with suggested carry and lateral half-width applied where enough shots exist */
function suggestedBag(analysis, bag) {
  const by = new Map(analysis.rows.map(r => [r.club, r]));
  return bag.map(c => {
    const r = by.get(c[0]);
    if (!r || r.carrySuggest == null) return c.slice(0, 3);
    return [c[0], Math.max(1, Math.round(r.carrySuggest)), Math.max(1, Math.round(r.wSuggest * 2) / 2)];
  });
}

const CSV_COLUMNS = ["time", "course", "hole", "tee", "club", "lie", "end_lie", "from_lon", "from_lat", "aim_lon", "aim_lat",
  "to_lon", "to_lat", "acc_from_m", "acc_to_m", "along_m", "lateral_m", "flat_along_m", "elev_change_m", "bad_strike", "obstacle", "note"];
function toCSV(shots) {
  const q = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const f = (v, d) => Number.isFinite(v) ? v.toFixed(d) : "";
  const lines = [CSV_COLUMNS.join(",")];
  for (const s of shots || []) {
    const m = measure(s);
    lines.push([s.t ? new Date(s.t).toISOString() : "", s.course, s.hole, s.tee, s.club, s.lie, s.endLie,
      f(s.from && s.from[0], 7), f(s.from && s.from[1], 7), f(s.aim && s.aim[0], 7), f(s.aim && s.aim[1], 7),
      f(s.to && s.to[0], 7), f(s.to && s.to[1], 7), f(s.accFrom, 1), f(s.accTo, 1),
      m.valid ? f(m.along, 1) : "", m.valid ? f(m.lateral, 1) : "", m.valid ? f(m.flatAlong, 1) : "", m.valid && m.dz != null ? f(m.dz, 1) : "",
      s.mishit ? 1 : 0, s.obstacle ? 1 : 0, s.note].map(q).join(","));
  }
  return lines.join("\n");
}

const api = { measure, usability, analyse, suggestedBag, toCSV, defaultMishitRate, project, metresPerDegree,
  constants: { ROLL, PRIOR_SHOTS, MIN_CLUB, GOOD_CLUB, MIN_DIST_DOF, MIN_MISS, MIN_MISHIT, MAX_ACC } };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CaddieShots = api;
})(typeof window !== "undefined" ? window : globalThis);
