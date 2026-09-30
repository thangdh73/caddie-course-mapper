# Acceptance results (software regression only)

Synthetic holes, seed 7, 192 simulated trials per option. These check that the engine behaves as specified. **They are not evidence of real-world accuracy.** Intervals are simulation sampling noise only.

**19 passed, 0 failed.**

## ob-right
Par 4, 360 m. OB line 24 m right of the centre line, nothing else. (1.7 s)

| Strategy | First shot | Average (95% sampling) | Birdie+ | Double+ | Used? |
|---|---|---|---|---|---|
| optimise | Driver -12 m | 4.07 (3.988–4.147) | 13% | 0% | yes |
| safe | Driver -12 m | 4.07 (3.988–4.147) | 13% | 0% | = Optimise |
| aggressive | Driver -12 m | 4.07 (3.988–4.147) | 13% | 0% | = Optimise |

- PASS — deterministic: same inputs twice give identical output
- PASS — optimiseAim: aim -12 m (<= 0) *(Should not aim toward the only hazard (OB right).)*

## ob-left
Mirror image of ob-right. (1.3 s)

| Strategy | First shot | Average (95% sampling) | Birdie+ | Double+ | Used? |
|---|---|---|---|---|---|
| optimise | Driver 12 m | 4.08 (4–4.167) | 12% | 1% | yes |
| safe | Driver 12 m | 4.08 (4–4.167) | 12% | 1% | = Optimise |
| aggressive | Driver 12 m | 4.08 (4–4.167) | 12% | 1% | = Optimise |

- PASS — deterministic: same inputs twice give identical output
- PASS — optimiseAim: aim 12 m (>= 0) *(Should not aim toward the only hazard (OB left).)*

## fairway-ends
Par 4, 300 m. Fairway ends at 210 m; trees across 218-240 m. (1.5 s)

| Strategy | First shot | Average (95% sampling) | Birdie+ | Double+ | Used? |
|---|---|---|---|---|---|
| optimise | 5-iron 0 m | 4.15 (4.063–4.229) | 8% | 2% | yes (near-tie with 4-iron 0 m) |
| safe | 5-iron 0 m | 4.15 (4.063–4.229) | 8% | 2% | = Optimise (near-tie with 4-iron 0 m) |
| aggressive | 5-iron 0 m | 4.15 (4.063–4.229) | 8% | 2% | = Optimise (near-tie with 4-iron 0 m) |

- PASS — deterministic: same inputs twice give identical output
- PASS — optimiseCarry: 5-iron 160 m (<= 200) *(Driver (230) and 3-wood (205) reach the tree band.)*

## dogleg
Dog-leg right: 235 m north then 150 m east; wood fills the inside corner; routing line given. (3.0 s)

| Strategy | First shot | Average (95% sampling) | Birdie+ | Double+ | Used? |
|---|---|---|---|---|---|
| optimise | Driver corner | 4.21 (4.134–4.293) | 7% | 1% | yes |
| safe | Driver corner | 4.21 (4.134–4.293) | 7% | 1% | = Optimise |
| aggressive | Driver corner | 4.21 (4.134–4.293) | 7% | 1% | = Optimise |

- PASS — deterministic: same inputs twice give identical output
- PASS — optimiseCorner: plays to the corner *(The flag line crosses the wood; the corner is the open route.)*

## tight-ob
Par 4, 370 m. OB 18 m right in the driver landing zone (190-260 m); trees left. (2.0 s)

| Strategy | First shot | Average (95% sampling) | Birdie+ | Double+ | Used? |
|---|---|---|---|---|---|
| optimise | Driving iron -6 m | 4.30 (4.227–4.378) | 4% | 0% | yes (near-tie with 3-wood -6 m) |
| safe | Driving iron -6 m | 4.30 (4.227–4.378) | 4% | 0% | = Optimise (near-tie with 3-wood -6 m) |
| aggressive | Driving iron -6 m | 4.30 (4.227–4.378) | 4% | 0% | = Optimise (near-tie with 3-wood -6 m) |

- PASS — deterministic: same inputs twice give identical output
- PASS — styleConsistent:safe: No plan within 0.3 strokes cuts doubles-or-worse by more than simulation noise; Safe = Optimise. *(If Safe differs from Optimise it must cut doubles beyond noise within 0.3 strokes; otherwise it must equal Optimise.)*
- PASS — styleConsistent:aggressive: No plan within 0.3 strokes raises birdies-or-better by more than simulation noise; Aggressive = Optimise. *(Same rule for birdies.)*

## par5-lake
Par 5, 440 m, reachable in two; lake 385-425 m fronting the green. (1.3 s)

| Strategy | First shot | Average (95% sampling) | Birdie+ | Double+ | Used? |
|---|---|---|---|---|---|
| optimise | Driver -12 m | 4.79 (4.675–4.908) | 42% | 3% | yes (near-tie with Driver 0 m) |
| safe | Driver -12 m | 4.79 (4.675–4.908) | 42% | 3% | = Optimise (near-tie with Driver 0 m) |
| aggressive | Driver -12 m | 4.79 (4.675–4.908) | 42% | 3% | = Optimise (near-tie with Driver 0 m) |

- PASS — deterministic: same inputs twice give identical output
- PASS — styleConsistent:safe: No plan within 0.3 strokes cuts doubles-or-worse by more than simulation noise; Safe = Optimise. *(As above.)*
- PASS — styleConsistent:aggressive: No plan within 0.3 strokes raises birdies-or-better by more than simulation noise; Aggressive = Optimise. *(As above.)*

## par3-water-left
Par 3, 150 m. Water left of the green and short of it. (0.7 s)

| Strategy | First shot | Average (95% sampling) | Birdie+ | Double+ | Used? |
|---|---|---|---|---|---|
| optimise | 5-iron 0 m | 3.44 (3.349–3.536) | 4% | 6% | yes |
| safe | 5-iron 0 m | 3.44 (3.349–3.536) | 4% | 6% | = Optimise |
| aggressive | 5-iron 0 m | 3.44 (3.349–3.536) | 4% | 6% | = Optimise |

- PASS — deterministic: same inputs twice give identical output
- PASS — optimiseAim: aim 0 m (>= -3) *(Should not aim meaningfully toward the water side.)*
- PASS — styleConsistent:safe: No plan within 0.3 strokes cuts doubles-or-worse by more than simulation noise; Safe = Optimise. *(As above.)*

## par3-90m-bunker
Par 3, 90 m over a bunker. Used for an external sanity bound only. (0.8 s)

| Strategy | First shot | Average (95% sampling) | Birdie+ | Double+ | Used? |
|---|---|---|---|---|---|
| optimise | PW 0 m | 3.03 (2.956–3.106) | 13% | 0% | yes |
| safe | PW 0 m | 3.03 (2.956–3.106) | 13% | 0% | = Optimise |
| aggressive | PW 0 m | 3.03 (2.956–3.106) | 13% | 0% | = Optimise |

- PASS — deterministic: same inputs twice give identical output
- PASS — optimiseAverage: average 3.03 (95% sampling 2.96-3.11) > 2.8 *(External bound: PGA Tour players average 2.80 strokes from 100 yards in the fairway (Broadie); a 12-handicap model must not beat tour level. This bounds optimism; it does not establish accuracy.)*
