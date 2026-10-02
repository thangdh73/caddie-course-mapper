// Tests for the zone method (zoneSearch / planByZones). Synthetic holes; expectations written BEFORE running.
// They check the method behaves as the golfer's philosophy says. They are software tests, not field validation.
const E = require('../caddie-engine.js');
const P = E.projector(101.5883, 3.105), ll = (x, y) => P.from([x, y]).map(v => +v.toFixed(7));
const rect = (x0, x1, y0, y1) => [[ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]];
const F = (kind, geom, extra = {}) => ({ type: 'Feature', properties: Object.assign({ kind, hole: 1 }, extra), geometry: geom });
const tee = F('tee', { type: 'Point', coordinates: ll(0, 0) }, { tee: 'blue' });
const green = (y, hw = 12) => [F('greenc', { type: 'Point', coordinates: ll(0, y) }), F('green', { type: 'Polygon', coordinates: rect(-hw, hw, y - 13, y + 13) })];
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const build = f => E.buildHole({ type: 'FeatureCollection', features: f }, 1, 'blue', { unmarkedLie: 'R', corridor: 0 });
const caddie = (f, o = {}) => E.makeCaddie(build(f), Object.assign({ samples: 96, treeH: 15, par: 4, seed: 7 }, o));

// ---------- Z1: a tree clump sits ON the flag line at driver distance; open fairway either side ----------
// Expected: the zone search slides the driver off the clump (aim offset >= 8 m), the clump is not the typical result (<= 35% trouble),
// and nobody is recommended a first shot whose typical result is trouble.
{
  const f = [tee, ...green(360), F('fairway', { type: 'Polygon', coordinates: rect(-26, 26, 100, 345) }), F('trees', { type: 'Polygon', coordinates: rect(-14, 14, 205, 255) })];
  const p = caddie(f).planByZones(0, 0, { fromTee: true });
  const d = p.strategies.aggressive, drv = p.candidates.find(c => c.club[0] === 'Driver');
  check('Z1 driver zone slides off the clump (aim offset >= 8 m)', Math.abs(drv.zone.aimOffset) >= 8, `aim ${drv.zone.aimOffset.toFixed(1)} m ${drv.zone.aimOffset > 0 ? 'right' : 'left'} of the flag line`);
  check('Z1 the driver zone keeps trouble under 35%', drv.troubleShare <= .35, `${Math.round(100 * drv.troubleShare)}%`);
  check('Z1 no strategy recommends a first shot that mostly finishes in trouble', Object.values(p.strategies).every(s => s.troubleShare <= .5));
  check('Z1 straight at the flag would be bad: the zone method does not aim at the clump', Object.values(p.strategies).every(s => Math.abs(s.zone.aimOffset) >= 8 || s.best.club[0] !== 'Driver'));
}

// ---------- Z2: water spans the fairway across the driver's arc (225-260 m) ----------
// Expected: the driver's best zone is NOT acceptable (it lands in or beside the water whatever the aim),
// and no strategy plays the driver.
{
  const f = [tee, ...green(380), F('fairway', { type: 'Polygon', coordinates: rect(-30, 30, 100, 365) }), F('water', { type: 'Polygon', coordinates: rect(-80, 80, 225, 262) })];
  const c = caddie(f), p = c.planByZones(0, 0, { fromTee: true });
  const z = p.zones.find(q => q.club === 'Driver');
  check('Z2 the driver zone is not acceptable (water across its arc)', z && !z.acceptable, `trouble score ${z && z.penalty.toFixed(2)} vs tolerance ${p.tolerance}`);
  check('Z2 no strategy plays the driver', Object.values(p.strategies).every(s => s.best.club[0] !== 'Driver'), Object.entries(p.strategies).map(([k, s]) => `${k}:${s.best.club[0]}`).join(' '));
  check('Z2 the aggressive plan plays the longest club that has an acceptable zone', (() => {
    const acc = p.zones.filter(q => q.acceptable); if (!acc.length) return true;
    const longest = Math.max(...acc.map(q => q.carry)); return p.strategies.aggressive.best.club[1] >= longest - 25; })(),
    `aggressive ${p.strategies.aggressive.best.club[0]} (${p.strategies.aggressive.best.club[1]} m); longest acceptable ${Math.max(0, ...p.zones.filter(q => q.acceptable).map(q => q.carry))} m`);
}

// ---------- Z3: OB tight on the right in the landing area ----------
// Expected: Optimise and Safe aim left of the flag line.
{
  const f = [tee, ...green(370), F('fairway', { type: 'Polygon', coordinates: rect(-20, 20, 120, 350) }), F('ob', { type: 'LineString', coordinates: [ll(20, 60), ll(20, 340)] })];
  const p = caddie(f).planByZones(0, 0, { fromTee: true });
  check('Z3 Optimise aims left of the flag line (OB right)', p.strategies.optimise.zone.aimOffset <= 0.5, `${p.strategies.optimise.zone.aimOffset.toFixed(1)} m`);
  check('Z3 Safe aims left of the flag line (OB right)', p.strategies.safe.zone.aimOffset <= 0.5, `${p.strategies.safe.zone.aimOffset.toFixed(1)} m`);
  const mirror = [tee, ...green(370), F('fairway', { type: 'Polygon', coordinates: rect(-20, 20, 120, 350) }), F('ob', { type: 'LineString', coordinates: [ll(-20, 60), ll(-20, 340)] })];
  const q = caddie(mirror).planByZones(0, 0, { fromTee: true });
  check('Z3 mirror image: aims right of the flag line (OB left)', q.strategies.optimise.zone.aimOffset >= -0.5, `${q.strategies.optimise.zone.aimOffset.toFixed(1)} m`);
}

// ---------- Z4: an open hole with nothing to avoid ----------
// Expected: the driver is acceptable, every strategy agrees, and agreement is reported rather than invented away.
{
  const f = [tee, ...green(350), F('fairway', { type: 'Polygon', coordinates: rect(-60, 60, 100, 345) })];
  const p = caddie(f).planByZones(0, 0, { fromTee: true });
  const z = p.zones.find(q => q.club === 'Driver');
  check('Z4 open hole: the driver zone is acceptable', z && z.acceptable, `trouble score ${z && z.penalty.toFixed(3)}`);
  check('Z4 open hole: all three strategies agree on the first club', new Set(Object.values(p.strategies).map(s => s.best.club[0])).size === 1,
    Object.entries(p.strategies).map(([k, s]) => `${k}:${s.best.club[0]}`).join(' '));
  check('Z4 open hole: no critic objects to any plan for any strategy', Object.values(p.strategies).every(s => s.verdict.rejected.every(r => r.critic === 'advocate')),
    Object.values(p.strategies).flatMap(s => s.verdict.rejected.filter(r => r.critic !== 'advocate').map(r => r.critic)).join(',') || 'none');
}

// ---------- Z5: the club fixes the landing distance ----------
// Expected: for every club, the median landing distance is within 8% (+12 m roll) of its carry, whatever direction was chosen.
{
  const f = [tee, ...green(420), F('fairway', { type: 'Polygon', coordinates: rect(-60, 60, 60, 410) })];
  const zs = caddie(f).zoneSearch(0, 0, { fromTee: true });
  const bad = zs.filter(z => { const ds = z.cloud.map(s => Math.hypot(s.x, s.y)).sort((a, b) => a - b), m = ds[Math.floor(ds.length / 2)]; return m < z.carry * .92 || m > z.carry * 1.08 + 12; });
  check('Z5 every zone sits on its club\'s own distance arc', bad.length === 0 && zs.length >= 5, `${zs.length} clubs checked${bad.length ? '; off-arc: ' + bad.map(z => z.club).join(', ') : ''}`);
}

// ---------- Z6: determinism and tolerance ----------
{
  const f = [tee, ...green(360), F('fairway', { type: 'Polygon', coordinates: rect(-26, 26, 100, 345) }), F('trees', { type: 'Polygon', coordinates: rect(-14, 14, 205, 255) })];
  const a = JSON.stringify(caddie(f).planByZones(0, 0, { fromTee: true }).strategies), b = JSON.stringify(caddie(f).planByZones(0, 0, { fromTee: true }).strategies);
  check('Z6 same inputs twice give identical output', a === b);
  const n = tol => caddie(f, { zoneTol: tol }).planByZones(0, 0, { fromTee: true }).zones.filter(z => z.acceptable).length;
  const n1 = n(.03), n2 = n(.10), n3 = n(.30);
  check('Z6 a looser tolerance never makes fewer zones acceptable', n1 <= n2 && n2 <= n3, `${n1} <= ${n2} <= ${n3}`);
}

// ---------- Z7: the verdict is honest about what it did ----------
{
  const f = [tee, ...green(370), F('fairway', { type: 'Polygon', coordinates: rect(-20, 20, 120, 350) }), F('ob', { type: 'LineString', coordinates: [ll(20, 60), ll(20, 340)] })];
  const p = caddie(f).planByZones(0, 0, { fromTee: true });
  check('Z7 every strategy carries a reason and a rejected list', Object.values(p.strategies).every(s => s.verdict.reason && Array.isArray(s.verdict.rejected)));
  check('Z7 a strategy that differs from Optimise states its cost with a paired range', Object.entries(p.strategies).every(([k, s]) => k === 'optimise' || s.verdict.same || /95%/.test(s.verdict.reason)));
  check('Z7 sampling-noise wording is attached to the averages', Object.values(p.strategies).every(s => /simulation|Sampling noise/i.test(s.uncertainty.note)));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
