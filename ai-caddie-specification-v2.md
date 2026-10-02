# AI Golf Caddie — Specification v2

*One consistent description of the current prototype (engine "merged v2"), written so another AI assistant or engineer can review it and brainstorm. It replaces the earlier brief entirely; nothing here is superseded by anything else.*

## 0. How to read this document

Every factual claim carries an evidence label:

| Label | Meaning |
|---|---|
| **[M]** Measured | Derived from data (imagery, OpenStreetMap, terrain, the golfer's own marks) |
| **[A]** Assumption | A default or estimate not verified against reality (player skill, tree height, ground defaults) |
| **[H]** Model choice | A deliberate heuristic or simplification in the engine |
| **[T]** Software-tested | Checked by the regression suite on synthetic holes (§13). Shows the code behaves as specified, **not** that it is accurate on real courses |
| **[X]** External benchmark | Checked against a published outside source |

**Not yet done:** no recommendation or score has been compared with real rounds. Real-world accuracy is **untested**.

---

## 1. What it is, and what it is not

- A **decision-support simulator** for golf: for each hole it simulates many possible shots and whole-hole play-outs for one player, then recommends a first shot and a plan.
- It is **not** a learned AI model, not a rules adjudicator, not field-calibrated.
- Scope: any course the player can load. Test course: Kelab Golf Seri Selangor (Petaling Jaya, Malaysia), par 72. Test player: 12 handicap.

---

## 2. Architecture

```
Data sources                        Course model (lon/lat)            Engine (per hole, per tee)          App
OpenStreetMap: holes, par,  ─┐      GeoJSON features            ─┐    2 m surface grid + exact polygons ┌─> plan card, 3 strategies,
  routing, water, outline    ├────> + auto-map raster (~1.2 m)   ├──> shot simulation (§7–9)          ├─> reasons, near-ties,
Mapbox satellite → auto-map ─┤      + golfer marks/brush fixes   │    lazy continuation policy (§10)    ├─> sampling ranges,
Mapbox terrain (elevation) ──┤      + provenance per cell (§4)  ─┘    play-outs + strategies (§10–11)   └─> trouble sources, map overlays
Golfer marks and fixes ──────┘
```

- Static web app on GitHub Pages: `caddie.html` (UI), `caddie-engine.js` (planner), `caddie-automap.js` (imagery classifier), `tests/` (regression suite). **[M]**
- Map: Mapbox GL JS + Mapbox Draw; geometry with Turf.js. All data stays in the browser (localStorage); the Mapbox public token is entered per device and never stored in the repository. **[M]**
- Planning time in the app: about 1–5 s per hole at 192 simulated trials per option **[T]**.

There is **no** precomputed value grid and **no** value iteration in the current engine.

---

## 3. Coordinates

- Stored: GeoJSON in longitude/latitude. **[M]**
- Planning frame: flat local metres centred on the chosen tee, with latitude-dependent metres-per-degree (series expansion). **[H]**

Feature `properties`: `kind` (`tee`, `greenc`, `green`, `fairway`, `rough`, `bunker`, `water`, `trees`, `ob`, `holeline`, `course`), `hole`, `tee` colour, `source` (`osm` for imports). Features without `hole` apply to all holes (course outline). Geometry is validated: rings must close, coordinates must be finite; tees may be points or polygons; greens may be multi-polygons. **[T]**

---

## 4. Where each patch of ground comes from — provenance

Each 2 m cell gets one surface code and a **provenance**, in this order of precedence **[H]**:

| Provenance | Source | Trust |
|---|---|---|
| **marked** | Golfer-drawn polygons/lines (and exact polygon tests at any point) | Highest: verified by a person |
| **surface** | Auto-map raster from imagery, including the golfer's brush/fill corrections | Unverified imagery classification **[M]** with known error modes (§6) |
| **assumed** | Defaults: "assumed trees" beyond a corridor, "assumed OB" outside the course outline, or the unmarked-ground lie | **[A]** Not observed |

**Ground defaults are explicit options, never silent** **[H]**:

| Situation | `unmarkedLie` | `corridor` | `courseBoundaryIsOB` |
|---|---|---|---|
| Auto-map present | `U` (uncertain) | 0 (off) | only if ≥ 95% of the hole's routing lies inside the OSM outline |
| No auto-map | `R` (rough) | 32 m: ground farther than this from the routing is **assumed trees** | same rule |

Why the 95% rule: the OSM outline for Seri Selangor misses holes 11–13 entirely **[M]**.

**Display rule:** outcomes are reported by provenance — e.g. "Trees hit: auto-map 4%, assumed default 2%" — so assumed trees and assumed OB are never presented as observed facts **[T]**.

---

## 5. Surface classes

| Code | Class | How a ball there is treated **[H]** |
|---|---|---|
| F | Fairway | Baseline lie; roll 9 m ± 40% |
| R | Rough | +0.25 strokes; roll 4 m |
| G | Green | Putting model (§7.6); roll 3 m |
| S | Bunker | +0.46 strokes; **no roll**; only wedges/short clubs from sand |
| W | Water | Simplified relief (§9) |
| T | Trees | +0.72 strokes; obstacle to ball flight (§8); from trees only a punch or chip |
| O | OB | Stroke and distance (§9) |
| U | Uncertain | +0.6 strokes; not a flight obstacle |
| X | Off the map | Stroke and distance (§9) |

Rolls stop at the exact edge of a bunker, water, OB or tree polygon (segment intersection), so narrow hazards are not skipped **[T]**.

---

## 6. Auto-map (imagery classifier)

Input: Mapbox satellite tiles, zoom 17, resampled to ~1.2 m/px **[M]**. Anchors: OSM routing lines, green points, water.

**Calibration [M]:** thresholds were set from pixel statistics inside golfer-verified Hole 1 polygons and OSM water (10th–90th percentile):

| Surface | Brightness V | Saturation | Hue |
|---|---|---|---|
| Bunker | 0.64–0.89 | 0.18–0.24 | 32–51° |
| Green | 0.44–0.55 | 0.29–0.35 | 57–84° |
| Fairway | 0.36–0.56 | 0.30–0.42 | 42–104° |
| Trees | 0.19–0.46 | 0.27–0.53 | 63–129° |
| Forest | 0.22–0.32 | 0.36–0.54 | 118–131° |
| Water | 0.18–0.32 | 0.35–0.53 | 85–143° |

**Rules [H], in order:** sand (V > 0.64, S < 0.27, hue 20–60°) — but sand-coloured pixels > 50 m from every hole become OB (roofs/roads; 19 of 23 ha of first-pass "sand" were buildings **[M]**); shade (dark, blue-ish, smooth) → U; canopy → T; roofs/grey surfaces → O far from holes, U near them; grass hue 35–170° (includes dry tan fairway); water **only** from OSM or marks (ponds and forest canopy are indistinguishable in colour and texture at this resolution **[M]**); fairway = smoother half of grass within 40 m of routing; greens region-grown ≤ 22 m from OSM green points; 3×3 majority filter.

**Known reliability [M, qualitative]:** good for bunkers, trees, buildings; fair for greens; approximate for fairway edges; water not inferred.

**Golfer corrections:** brush (1–15 m), fill-patch (refused above 1 ha), undo; protected from being overwritten by re-running the auto-map **[T]**.

---

## 7. Player model

### 7.1 Clubs **[A — player-stated or estimated]**
Carries (m): Driver 230, 3-wood 205, driving iron 195, 3-iron 180, 4-iron 170, 5-iron 160, 6-iron 140, 7-iron 135, 8-iron 130, 9-iron 120, PW 105, 52° 80, 56° 62.

### 7.2 Lateral spread — precise definition
Each club has a **lateral 95% half-width** *w* (m): 95% of shots finish within ±*w* sideways of the aim line. Simulation: lateral offset ~ Normal(mean = usual-miss bias, sd = *w*/2). It is **not** a circle radius; distance spread is separate. Values: driver 25, 3-wood 22, long irons 15, 7–8 iron 10, short irons 5–7 **[A]** (driver, long-iron, 7–8 iron and short-iron values are the player's estimates; others filled in).

### 7.3 Distance spread
Normal, sd = 7% of carry (12-handicap assumption; tour players are closer to 4%) **[A]**.

### 7.4 Mishits **[A]**
Probability per shot: woods 10%, clubs ≥ 170 m 8%, ≥ 120 m 6%, shorter 4%; a mishit flies 55–85% of normal carry with lateral spread ×1.6. A slider scales the rates.

### 7.5 Short game **[H + A]**
Partial wedges and chips near the green use a scatter floor: distance sd ≥ 1.5 m + 5% of the shot; lateral half-width ≥ 3 m + 8% of the shot. (Scatter proportional to length alone gave tour-level chipping.)

### 7.6 Putting **[A]**
Expected putts by distance: 1 m 1.12, 2 m 1.42, 3 m 1.6, 5 m 1.8, 8 m 1.95, 12 m 2.1, 20 m 2.3, 30 m 2.5 (plus 40% of the player's offset); realised as whole putts with matching probabilities.

### 7.7 Baseline and offset **[A]**
One-step shot evaluation uses a peer-group expected-strokes table (e.g. 91 m 2.92, 201 m 3.54, 350 m 4.30) plus the player's offset (+0.25 by default) and lie penalties (§5).

### 7.8 Elevation **[M data, H model]**
Terrain from Mapbox Terrain-RGB (zoom ≤ 14): height = −10000 + (R·65536 + G·256 + B)·0.1 m. Plays-as distance: 1 m of rise ≈ 1 m of distance. Hole 1 green is +24.9 m above the blue tee **[M]**. Hole-scale only; not suitable for green reading; may include canopy height.

---

## 8. Ball flight and trees **[H]**

- Straight line over the ground (no draw/fade).
- Height: parabola peaking at 60% of carry; apex per club (driver 27 m, long irons 24–25 m, mid irons 26–27 m, wedges 20–25 m), scaled down for very short shots.
- **Clearance is measured above the actual terrain** under the ball **[T]**.
- **One tree-gap draw per shot:** 70% of shots can be stopped by canopy below the assumed tree height (default 15 m **[A]**); 30% pass through gaps. (Not one draw per metre.)
- Launch windows: tee shots ignore canopy in the first 20 m; other shots in the first 2 m.

---

## 9. Penalties — exact rules as implemented **[H]**

- **OB and off-map:** stroke and distance — one penalty stroke, replay from the previous spot.
- **Water — simplified relief, not Rule 17:** one penalty stroke; the ball is placed 2 m onto the **first dry, playable ground found walking back along the line of flight** from the splash point toward where the shot was played. If none is found, stroke and distance. The Rules' back-on-the-line (from the hole through the crossing point) and lateral (two club-lengths, red areas) options are **not** modelled.

---

## 10. Planning

1. **Candidates** from a spot: every club from the tee (driver only from the tee); elsewhere the 4 clubs nearest the remaining distance, lay-up clubs leaving ~70/100 m, controlled partial wedges and chips near the green; wedges only from sand; punch/chip only from trees **[H]**.
2. **Targets:** the flag plus every bend of the OSM routing line still ahead (for dog-legs) **[H]**.
3. **Aims:** from the tee −36…+36 m in steps (±36, ±24, ±18, ±12, ±6, 0); later shots −9, 0, +9 m **[H]**.
4. **Screening:** every (club, target, aim) simulated on the same random draws, scored one step ahead with the baseline table **[H]**.
5. **Shortlist:** 5 best screened options plus each club's best and least-trouble option **[H]**.
6. **Play-outs:** each shortlisted option is played to the last putt on **common random numbers** — the same simulated trials for every option — so differences between options are paired **[T]**. The app uses 192 trials per option.
7. **Later shots** follow a lazy **continuation policy**: for each 6 m cell (or exact point near hazards), a one-step heuristic chooses the club/aim with the best screened value (12 draws). Not a converged optimal policy **[H]**.
8. Plan chains shown in the app follow one representative trial's **actual resting points**, not idealised aim points **[T]**.

**Known statistical bias [T]:** selecting the best of many noisy options makes the winner's average look better than it is ("winner's curse"). On the test holes, averages rise as trials increase (e.g. 90 m par 3: 2.99 at 96 trials, 3.06 at 384).

---

## 11. Strategies — exact definitions **[H, behaviour T]**

- **Optimise:** the plan with the lowest simulated average score.
- **Safe:** goal = lowest chance of double bogey or worse (unfinished trials count as doubles).
- **Aggressive:** goal = highest chance of birdie or better.

A Safe or Aggressive plan is evaluated as a **whole plan** — first shot plus later shots played in that style (later shots may trade up to 0.15 screened strokes for a longer club / less trouble) — on the **same trials** as Optimise. It is adopted only if:

1. its **paired** average cost vs Optimise is ≤ **0.3 strokes** (point estimate; the 95% interval is reported), **and**
2. it improves its own goal by **more than 1.96 paired standard errors**.

Otherwise the strategy **equals Optimise**, and the app states why (e.g. "No plan within 0.3 strokes cuts doubles-or-worse by more than simulation noise"). **Agreement is a valid, expected outcome.** If a styled plan scores a lower average than the default plan, Optimise adopts it.

**Observed [T]:** on the 8 test holes, strategies agree on 7 at 96, 192 and 384 trials; the one exception (par 3 over water) is borderline — Safe bails out right at ~+0.2–0.3 strokes at some sample sizes. Earlier versions that made strategies "differ" by style rules (e.g. "Aggressive = longest club") created variety without evidence of better decisions and were removed.

---

## 12. Uncertainty reporting

- Averages come with a 95% interval; probabilities with Wilson intervals; each plan with a paired comparison against the next-best club, flagged **near-tie** when not distinguishable **[T]**.
- **All of these describe simulation sampling noise only.** They say nothing about whether the map, the player model or the physics are right. Model error is not quantified.

---

## 13. Testing

### 13.1 Software regression suite **[T]** (`tests/`)
- `make-fixtures.js` builds `fixtures.json`: 8 synthetic holes in real coordinates, each with expectations **written before running**, and settings (seed 7, 192 trials, `unmarkedLie: R`, `corridor: 0`, tree height 15 m).
- `run-acceptance.js` runs them, checks expectations and determinism (same inputs twice → identical output), and writes `acceptance-results.json` / `.md` with averages, intervals, probabilities and near-tie flags.
- Current result: **19 passed, 0 failed.**

| Fixture | Independent expectation |
|---|---|
| ob-right / ob-left | Optimise does not aim toward the only hazard |
| fairway-ends | Optimise's first club carries ≤ 200 m (trees at 218–240 m) |
| dogleg | Optimise plays to the corner (flag line crosses the wood) |
| tight-ob, par5-lake, par3-water-left | Any Safe/Aggressive plan that differs from Optimise meets both adoption rules; otherwise it equals Optimise |
| par3-90m-bunker | External bound (below) |
| all | Deterministic |

### 13.2 External sanity bound **[X]**
PGA Tour players average **2.80 strokes from 100 yards in the fairway** (Broadie, strokes-gained research). A 12-handicap model must not beat this. Current model: 3.03 at 192 trials (95% sampling interval reported in the results). This **bounds optimism only**; it does not establish that 3.03 is accurate for a 12 handicap. No published amateur table was used.

### 13.3 Real-world accuracy — **not tested**
Proposed: log planned vs actual outcomes over N rounds (club, aim, landing, lie, score), compare predicted and observed distributions per hole and per shot type, and calibrate §7 parameters.

---

## 14. Data sources and licensing

| Source | Gives | Limits |
|---|---|---|
| OpenStreetMap (Overpass, three servers with fallback) | Holes, par, routing, water, outline, sometimes greens/bunkers/tees | Often incomplete (Seri Selangor: no greens, bunkers or trees; outline misses holes 11–13 **[M]**). ODbL: attribution, share-alike on databases |
| Mapbox satellite | Georeferenced imagery (true scale, GPS) | Extraction permitted only for personal, non-commercial use or OSM; commercial use needs a Mapbox commercial licence; raw tiles cacheable ≤ 30 days |
| Mapbox terrain | Elevation (§7.8) | Hole-scale; possible canopy bias |
| Golfer | Marks, fixes, tee colours, tree heights, OB | Effort |
| Yardage books (earlier work) | Distances, widths | Copyright: each golfer's own book, never redistributed |

Hosting on GitHub Pages is for non-commercial testing only.

---

## 15. Lessons that shaped this design

1. Validation must be independent of the data being validated (no circular checks).
2. Scale and position must be measured (a Google Earth screenshot was fitted to Mapbox with four bunker anchors: max misfit 1.5 m, scale within 2.6% of a measured line **[M]**).
3. Shadows are not trees; unknown ground must never look safer than known ground.
4. Amateur realism (distance spread, mishits, short game, putting) changes decisions; tour-level defaults made risk look free.
5. "Strategies differ" is not a success measure; each strategy must meet its stated goal, and agreement is acceptable.
6. Close decisions must be shown as near-ties, not as single answers.

---

## 16. Open questions for collaborators

1. **Player model:** what is the minimum on-course logging (taps per shot) that measures per-club bias, spread and mishit rate well enough to move §7 from [A] to [M]?
2. **Continuation policy:** is a one-step heuristic good enough, or does a value-iteration or rollout policy materially change recommendations? How would we test that without field data?
3. **Winner's curse:** should reported averages be debiased (e.g. hold-out trials: select on one set, report on another)?
4. **Strategy adoption:** is "0.3 strokes, paired point estimate" the right cap, or should the cap apply to the upper 95% bound? Should the cap be a player setting?
5. **Rules:** implement Rule 17 back-on-the-line and lateral relief (needs penalty-area colour and crossing point)?
6. **Map confidence:** which cells drive each decision (sensitivity to tree height, fairway edges, dispersion), and how should the app ask the golfer to verify exactly those?
7. **Field validation design:** sample size and metrics to show whether plans improve scores.

---

## 17. Glossary

- **Plays-as distance:** carry adjusted for elevation (wind not yet sourced).
- **Lateral 95% half-width:** ±distance sideways containing 95% of shots (§7.2).
- **Routing line:** OSM tee → corner(s) → green line of play.
- **Play-out:** one simulated hole from the chosen first shot to the last putt.
- **Common random numbers / paired comparison:** every option judged on the same simulated trials; differences computed trial by trial.
- **Near-tie:** plan and next-best club not distinguishable beyond sampling noise.
- **Provenance:** where a cell's surface came from — marked, auto-map (surface), or assumed default.
- **Trouble rate:** share of simulated first shots ending in trees, sand, water, OB or off the map.


---

## 18. Zone method (added; engine `zoneSearch` and `planByZones`)

The golfer's way of choosing a shot, implemented as a second planner that sits beside the average-minimising one in §10–11. **Not yet shown in the app.**

**18.1 The rule [H]**
1. A club's landing distance is fixed by the club: a driver lands on its own arc and never beyond its reach.
2. Slide the aim along that arc (±30° in 1° steps; also around each routing corner on dog-legs) to where the club's simulated landing pattern sits furthest from trouble. Trouble is weighted in the golfer's order: water, OB and off-map 1.0; bunker 0.7; trees 0.55; uncertain ground 0.35; rough 0.15; fairway and green 0. Every direction and club is judged on the same simulated shots.
3. A zone is **acceptable** if its weighted trouble score is at most `zoneTol` (default 0.10 **[A]**). Take the club that leaves the shortest distance to the hole among acceptable zones; if none is acceptable, the club with the least trouble.
4. Later shots follow the same rule (`style: "zone"`; coarser scan, ±18° in 6° steps, 16 shots per direction). Option `zoneRank: "average"` ranks acceptable zones by expected strokes instead of closeness.

**18.2 Critics and debate [H]** — each candidate first shot (one per club) is played out to the last putt on common random numbers, then cross-examined. An objection is sustained only when the paired numbers back it beyond simulation noise.

| Critic | Objection | Effect |
|---|---|---|
| typical-result | more than 50% of first shots finish in trees, sand, water, OB or uncertain ground | vetoes the plan for Aggressive and Safe |
| next-shot | more than 35% leave a recovery rather than an advance | vetoes it for Aggressive |
| cost | paired average cost over the best plan exceeds `styleCost` (0.3) | vetoes it for Aggressive and Safe |
| disaster | sustainably more doubles-or-worse than the safest plan | vetoes it for Safe; flagged for others |
| evidence | most of the trouble comes from auto-map or assumed ground, not marked ground | flagged "check the map" |
| challenger | the average-minimising planner's plan is distinguishably better than the zone Optimise plan | flagged with the gap and its range |

Advocates: **Optimise** = lowest average. **Aggressive** = shortest approach (plans within 8 m tie; then most birdies, then lowest average). **Safe** = fewest doubles-or-worse; plans not sustainably worse than the safest tie, and the cheapest tied plan wins. Ties are decided by these fixed rules, not by noise. Each verdict lists the best rejected alternatives with the objection that sank them.

**18.3 Robustness check [H]** (`sensitivity: true`, about 6 re-runs at 64 trials): trees ±5 m, distance spread −20% / +25%, all carries ±4%. Reports how often each strategy's club survives; a choice that holds in fewer than 4 of 6 is marked fragile.

**18.4 What was found on Seri Selangor Hole 1 [T, synthetic and traced map]**
- Zones sit on each club's own arc; a tree clump on the flag line pushes the driver zone 28 m sideways; water across the driver's arc makes the driver zone unacceptable and no strategy plays it; OB on one side moves the aim to the other. 19/19 tests (`tests/run-zone-tests.js`), including a check that breaking the tolerance makes tests fail.
- On the traced Hole 1 (fewer trees than the auto-map) all three strategies agree on the driver 2° right. Safe's apparent 4-iron advantage (2% vs 5% doubles) is within noise; before the tie rule existed it flipped between 3-wood, 3-iron and 4-iron under small changes.
- **The zone rule costs about 0.13 strokes against the average-minimising planner** on that hole (95% −0.23 to −0.03, same trials). Ranking acceptable zones by average instead of closeness does not close it (4.34 → 4.32). The cause is the approach: greens ringed by bunkers fail a strict 0.10 tolerance, so the zone rule plays short of the pin. Whether to relax the tolerance near the green is an open design decision.
- Speed in Node on this detailed hole: zone planning 9.5 s, the existing planner 12.3 s, robustness check about 25 s more. Too slow for a phone without reducing trials.

**18.5 Not established.** Whether zone plans score better in real rounds (untested). Whether `zoneTol` 0.10 and the trouble weights match this player's judgement: they are assumptions until compared with the golfer's own choices on marked holes (the golfer-judgement test set still to be built).
