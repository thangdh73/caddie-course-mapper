// Builds tests/fixtures.json: synthetic holes in real lon/lat, each with expectations written BEFORE running.
const E=require('../caddie-engine.js');
const P=E.projector(101.5883,3.105),ll=(x,y)=>P.from([x,y]).map(v=>+v.toFixed(7));
const rect=(x0,x1,y0,y1)=>[[ll(x0,y0),ll(x1,y0),ll(x1,y1),ll(x0,y1),ll(x0,y0)]];
const F=(kind,geom,extra={})=>({type:"Feature",properties:Object.assign({kind,hole:1},extra),geometry:geom});
const tee=F("tee",{type:"Point",coordinates:ll(0,0)},{tee:"blue"});
const G=(y,h=13)=>[F("greenc",{type:"Point",coordinates:ll(0,y)}),F("green",{type:"Polygon",coordinates:rect(-11,11,y-h,y+h)})];
const fixtures=[
 {id:"ob-right",about:"Par 4, 360 m. OB line 24 m right of the centre line, nothing else.",par:4,
  expect:[{check:"optimiseAim",op:"<=",value:0,why:"Should not aim toward the only hazard (OB right)."}],
  features:[tee,...G(360),F("fairway",{type:"Polygon",coordinates:rect(-16,16,120,330)}),F("ob",{type:"LineString",coordinates:[ll(24,60),ll(24,390)]})]},
 {id:"ob-left",about:"Mirror image of ob-right.",par:4,
  expect:[{check:"optimiseAim",op:">=",value:0,why:"Should not aim toward the only hazard (OB left)."}],
  features:[tee,...G(360),F("fairway",{type:"Polygon",coordinates:rect(-16,16,120,330)}),F("ob",{type:"LineString",coordinates:[ll(-24,60),ll(-24,390)]})]},
 {id:"fairway-ends",about:"Par 4, 300 m. Fairway ends at 210 m; trees across 218-240 m.",par:4,
  expect:[{check:"optimiseCarry",op:"<=",value:200,why:"Driver (230) and 3-wood (205) reach the tree band."}],
  features:[tee,...G(300),F("fairway",{type:"Polygon",coordinates:rect(-16,16,120,210)}),F("trees",{type:"Polygon",coordinates:rect(-40,40,218,240)})]},
 {id:"dogleg",about:"Dog-leg right: 235 m north then 150 m east; wood fills the inside corner; routing line given.",par:4,
  expect:[{check:"optimiseCorner",op:"==",value:true,why:"The flag line crosses the wood; the corner is the open route."}],
  features:[tee,F("greenc",{type:"Point",coordinates:ll(150,240)}),F("green",{type:"Polygon",coordinates:rect(138,162,228,252)}),
   F("fairway",{type:"Polygon",coordinates:rect(-16,16,120,255)}),F("fairway",{type:"Polygon",coordinates:rect(0,140,222,258)}),
   F("trees",{type:"Polygon",coordinates:rect(25,160,20,215)}),F("holeline",{type:"LineString",coordinates:[ll(0,0),ll(0,235),ll(150,240)]})]},
 {id:"tight-ob",about:"Par 4, 370 m. OB 18 m right in the driver landing zone (190-260 m); trees left.",par:4,
  expect:[{check:"styleConsistent",style:"safe",why:"If Safe differs from Optimise it must cut doubles beyond noise within 0.3 strokes; otherwise it must equal Optimise."},
          {check:"styleConsistent",style:"aggressive",why:"Same rule for birdies."}],
  features:[tee,...G(370),F("fairway",{type:"Polygon",coordinates:rect(-20,20,120,350)}),F("ob",{type:"LineString",coordinates:[ll(18,190),ll(18,260)]}),
   F("ob",{type:"LineString",coordinates:[ll(40,60),ll(40,190)]}),F("trees",{type:"Polygon",coordinates:rect(-60,-26,60,360)})]},
 {id:"par5-lake",about:"Par 5, 440 m, reachable in two; lake 385-425 m fronting the green.",par:5,
  expect:[{check:"styleConsistent",style:"safe",why:"As above."},{check:"styleConsistent",style:"aggressive",why:"As above."}],
  features:[tee,...G(440),F("fairway",{type:"Polygon",coordinates:rect(-22,22,110,380)}),F("water",{type:"Polygon",coordinates:rect(-45,45,385,425)})]},
 {id:"par3-water-left",about:"Par 3, 150 m. Water left of the green and short of it.",par:3,
  expect:[{check:"optimiseAim",op:">=",value:-3,why:"Should not aim meaningfully toward the water side."},{check:"styleConsistent",style:"safe",why:"As above."}],
  features:[tee,...G(150,12),F("water",{type:"Polygon",coordinates:rect(-60,-12,70,170)}),F("water",{type:"Polygon",coordinates:rect(-60,14,70,136)})]},
 {id:"par3-90m-bunker",about:"Par 3, 90 m over a bunker. Used for an external sanity bound only.",par:3,
  expect:[{check:"optimiseAverage",op:">",value:2.80,why:"External bound: PGA Tour players average 2.80 strokes from 100 yards in the fairway (Broadie); a 12-handicap model must not beat tour level. This bounds optimism; it does not establish accuracy."}],
  features:[tee,F("greenc",{type:"Point",coordinates:ll(0,90)}),F("green",{type:"Polygon",coordinates:rect(-10,10,80,100)}),
   F("bunker",{type:"Polygon",coordinates:rect(-10,10,72,80)}),F("bunker",{type:"Polygon",coordinates:rect(-22,-10,78,98)})]}
];
require('fs').writeFileSync(__dirname+'/fixtures.json',JSON.stringify({generated:"synthetic holes; expectations written before running",
  settings:{seed:7,samples:96,unmarkedLie:"R",corridor:0,treeH:15},fixtures},null,1));
console.log("wrote",fixtures.length,"fixtures");
