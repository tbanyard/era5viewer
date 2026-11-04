/* Dependency-free projection checks: round trips, limbs, poles and wind bases. */
const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../web/projections.js"),"utf8"),context);
const {forward,inverse,View,wrap}=context.window.ERA5Projections;
const close=(a,b,eps=1e-7)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
let checked=0;
for(const mode of ["north","south","globe"]){
 for(const centre of [{lat:0,lng:0},{lat:53,lng:168},{lat:-72,lng:-135},{lat:90,lng:20}]){
  for(let lat=-85;lat<=85;lat+=5)for(let lon=-180;lon<180;lon+=7){
   const p=forward(mode,lat,lon,centre);if(!p)continue;
   const ll=inverse(mode,p.x,p.y,centre);assert.ok(ll);close(ll.lat,lat,2e-6);close(wrap(ll.lng-lon),0,2e-6);checked++;
  }
 }
}
close(forward("north",90,25).x,0);close(forward("north",90,25).y,0);
close(forward("south",-90,25).x,0);close(forward("north",0,90).x,2);
assert.equal(forward("globe",0,180,{lat:0,lng:0}),null);
assert.equal(inverse("globe",1.001,0),null);
const view=Object.create(View.prototype);view.mode="north";view.rotation={lat:90,lng:0};view.pan={x:0,y:0};view.factor=1;view.map={getSize:()=>({x:1000,y:900})};
const east=view.vector(60,0,20,0),north=view.vector(60,0,0,20);
assert.ok(east.x>0&&Math.abs(east.y)<1);assert.ok(north.y<0&&Math.abs(north.x)<1);
view.rotation.lng=90;const rotated=view.vector(60,0,20,0);assert.ok(rotated.y>0&&Math.abs(rotated.x)<1);
view.mode="south";view.rotation={lat:-90,lng:0};const southNorth=view.vector(-60,0,0,20);assert.ok(southNorth.y<0);
console.log(`Projection checks: PASS (${checked} forward/inverse samples, poles, globe limb and rotated wind bases)`);
