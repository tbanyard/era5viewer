/* DOM integration and real canvas rendering when a browser is unavailable.
   Python test weather is generated in test-results, never in the real archive. */
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {spawn,spawnSync}=require("node:child_process");
const {JSDOM,VirtualConsole}=require("jsdom");
const {createCanvas}=require("@napi-rs/canvas");
const root=path.resolve(__dirname,".."),out=path.join(root,"test-results");
const python=process.env.PYTHON||"python3",pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<300;i++){if(check())return;await pause(30);}throw new Error("Timed out: "+label);}

(async()=>{
 fs.mkdirSync(out,{recursive:true});const data=fs.mkdtempSync(path.join(out,"dom-weather-"));
 let server,dom;
 try{
  const fixture=spawnSync(python,[path.join(root,"scripts/make_test_data.py"),data],{cwd:root,encoding:"utf8"});
  assert.equal(fixture.status,0,fixture.stderr);
  server=spawn(python,["server.py","--data-root",data,"--port","0"],{cwd:root,env:process.env,stdio:["ignore","pipe","pipe"]});
  let log="";server.stdout.on("data",b=>log+=b);server.stderr.on("data",b=>log+=b);
  await until(()=>/Open http:\/\/127\.0\.0\.1:\d+\//.test(log),"server startup");
  const base=log.match(/Open (http:\/\/127\.0\.0\.1:\d+)\//)[1],errors=[];
  const vc=new VirtualConsole();vc.on("jsdomError",e=>errors.push(e.message));
  dom=new JSDOM(fs.readFileSync(path.join(root,"index.html"),"utf8"),{
   url:base+"/",runScripts:"outside-only",pretendToBeVisual:true,virtualConsole:vc
  });
  const w=dom.window,$=id=>w.document.getElementById(id);
  w.fetch=(u,options={})=>{
   const c=new AbortController();
   if(options.signal){if(options.signal.aborted)c.abort();else options.signal.addEventListener("abort",()=>c.abort(),{once:true});}
   return fetch(u,Object.assign({},options,{signal:c.signal}));
  };
  w.ResizeObserver=class{observe(){}disconnect(){}};
  w.SVGSVGElement.prototype.createSVGRect=()=>({});
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  Object.defineProperty(w.HTMLElement.prototype,"clientWidth",{get(){return this.id==="map"?1148:this.id==="time-ticks"?750:300;}});
  Object.defineProperty(w.HTMLElement.prototype,"clientHeight",{get(){return this.id==="map"?922:30;}});
  w.HTMLElement.prototype.getBoundingClientRect=function(){return{width:this.clientWidth,height:this.clientHeight,left:0,top:0,right:this.clientWidth,bottom:this.clientHeight,x:0,y:0};};
  for(const key of ["width","height"]){
   const original=Object.getOwnPropertyDescriptor(w.HTMLCanvasElement.prototype,key);
   Object.defineProperty(w.HTMLCanvasElement.prototype,key,{get(){return original.get.call(this);},set(v){original.set.call(this,v);if(this._native)this._native[key]=Math.max(1,+v);}});
  }
  w.HTMLCanvasElement.prototype.getContext=function(type){
   if(type!=="2d")return null;
   if(!this._native)this._native=createCanvas(Math.max(1,this.width),Math.max(1,this.height));
   if(!this._context){
    const native=this._native.getContext("2d");
    this._context=new Proxy(native,{get(target,key){
     if(key==="drawImage")return(image,...args)=>target.drawImage(image._native||image,...args);
     const value=target[key];return typeof value==="function"?value.bind(target):value;
    },set(target,key,value){target[key]=value;return true;}});
   }
   return this._context;
  };
  w.eval(fs.readFileSync(path.join(root,"web/vendor/leaflet/leaflet.js"),"utf8"));
  w.eval(fs.readFileSync(path.join(root,"web/app.js"),"utf8"));
  const state=w.era5viewer.state,change=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event("change",{bubbles:true}));};
  await until(()=>state.grid?.stats.valid>0,"initial grid");
  assert.equal($("time-label").textContent,"12:00 UTC");assert.equal(state.times.length,8);
  assert.equal($("date").value,"2016-09-26");
  const raw=w.era5viewer.sample(state.grid,"values",51,-1);assert.ok(Number.isFinite(raw));
  $("basemap-toggle").click();
  w.document.querySelector('[data-field="u"]').click();
  await until(()=>state.grid?.variable.id==="u","U field");
  w.document.querySelector('[data-mode="pressure"]').click();
  await until(()=>state.grid?.mode==="pressure","pressure coordinate");
  for(const value of [850,250,500]){$("level").value=value;$("level").dispatchEvent(new w.Event("input",{bubbles:true}));}
  await until(()=>state.grid?.value===500&&state.grid.mode==="pressure","latest slider response");
  assert.equal($("layer-badge").textContent,"500 hPa");
  w.document.querySelector('[data-mode="model"]').click();
  await until(()=>state.grid?.mode==="model","model coordinate");
  $("level").value=137;$("level").dispatchEvent(new w.Event("input",{bubbles:true}));
  await until(()=>state.grid?.value===137,"near-surface model level");
  w.document.querySelector('[data-mode="height"]').click();
  w.document.querySelector('[data-field="t"]').click();
  await until(()=>state.grid?.mode==="height"&&state.grid.variable.id==="t","5 km temperature");
  w.era5viewer.map.fire("click",{latlng:w.L.latLng(51,-1)});
  await until(()=>state.profile?.profiles.t.length===137,"point profile");
  assert.equal(w.document.querySelectorAll("#point-metrics .metric").length,4);
  assert.equal(w.document.querySelectorAll("#profile-chart svg").length,1);
  change("temperature-unit","K");assert.equal($("legend-unit").textContent,"K");
  change("temperature-unit","C");assert.equal($("legend-unit").textContent,"°C");
  $("drift-run").click();await until(()=>state.drift?.path.length>2,"wind drift");
  assert.match($("drift-status").textContent,/Horizontal wind only/);
  const csvResponse=await fetch($("profile-export").href),csv=await csvResponse.text();
  assert.equal(csvResponse.status,200,csv);
  assert.equal(csv.trim().split("\n").length,138,csv.slice(0,200));
  await pause(80);
  fs.writeFileSync(path.join(out,"field-render.png"),$("field-canvas")._native.toBuffer("image/png"));
  fs.writeFileSync(path.join(out,"wind-grid-render.png"),$("overlay-canvas")._native.toBuffer("image/png"));
  $("next-time").click();await until(()=>state.grid?.record.datetime.includes("T15:00"),"next real time");
  assert.equal(state.drift,null);assert.equal($("drift-export").hidden,true);
  await until(()=>state.profile?.record.datetime.includes("T15:00"),"profile refresh");
  $("play").click();await until(()=>state.grid?.record.datetime.includes("T18:00"),"animation");$("play").click();assert.equal(state.playing,false);
  $("prev-day").click();await until(()=>state.grid?.record.datetime.startsWith("2016-09-25"),"previous real day");
  $("connection-open").click();assert.equal($("connection-dialog").open,true);$("connection-close").click();
  assert.deepEqual(errors,[]);
  console.log("Frontend DOM and canvas checks: PASS (real reader data, fields, pressure/model/height, slider races, point/profile, units, drift, CSV, time/date, animation)");
 }finally{
  if(dom){dom.window.era5viewer?.dispose();dom.window.close();}
  if(server)server.kill();fs.rmSync(data,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
