/* Optional full-browser checks. Run npm install, npx playwright install
   chromium, then npm run test:browser. Python dependencies must be installed.
   Test weather is generated explicitly; the user's archive is never touched. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {spawn, spawnSync} = require("node:child_process");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright");
const root = path.resolve(__dirname, "..");
const out = path.join(root, "test-results");
const python = process.env.PYTHON || (fs.existsSync(path.join(root, ".venv/bin/python")) ? path.join(root, ".venv/bin/python") : "python3");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(out, {recursive:true});
  const data=fs.mkdtempSync(path.join(out,"weather-"));
  let browser, server;
  const errors=[];
  try {
    const fixture=spawnSync(python, [path.join(root,"scripts/make_test_data.py"),data,"--topography"], {cwd:root,encoding:"utf8"});
    if(fixture.status!==0)throw new Error(fixture.stderr||"Fixture generation failed.");
    server=spawn(python, ["server.py","--data-root",data,"--port","0"], {cwd:root,env:process.env,stdio:["ignore","pipe","pipe"]});
    let log="";
    server.stdout.on("data",b=>{log+=b.toString();});
    server.stderr.on("data",b=>{log+=b.toString();});
    let base;
    for(let i=0;i<150;i++) {
      const match=log.match(/Open (http:\/\/127\.0\.0\.1:\d+)\//);
      if(match){base=match[1];break;}
      if(server.exitCode!=null)throw new Error(log);
      await delay(100);
    }
    if(!base)throw new Error("Reader did not start: "+log);
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,
      args:["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"]});
    const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
    // Avoid requesting public basemap tiles during automated testing.
    await context.route(/tile\.openstreetmap\.org/,route=>route.fulfill({contentType:"image/png",
      body:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64")}));
    const page=await context.newPage();
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(()=>window.era5viewer?.state.grid?.stats.valid>0);
    assert.equal(await page.locator("#time-label").textContent(),"12:00 UTC");
    assert.equal(await page.locator("#date").inputValue(),"2016-09-26");
    assert.equal(await page.locator("#time-slider").getAttribute("max"),"7");
    assert.equal(await page.locator("#app-version").textContent(),"v1.4");
    assert.equal(await page.locator('[data-field="wind_speed"]').textContent(),"Wind speed");
    await page.locator("#basemap-toggle").uncheck();
    await page.locator("#coastline-toggle").check();
    const layerDownload=page.waitForEvent("download");await page.locator("#layer-netcdf").click();
    const layer=await layerDownload;assert.match(layer.suggestedFilename(),/^era5-t-.*\.nc$/);
    await layer.saveAs(path.join(out,"layer.nc"));
    assert.equal(fs.readFileSync(path.join(out,"layer.nc")).subarray(0,4).toString("binary"),"CDF\x02");

    await page.locator('[data-field="u"]').click();
    await page.waitForFunction(()=>window.era5viewer.state.grid?.variable.id==="u");
    await page.locator('[data-mode="pressure"]').click();
    await page.waitForFunction(()=>window.era5viewer.state.grid?.mode==="pressure");
    await page.locator("#level").fill("850");
    await page.locator("#level").fill("250");
    await page.locator("#level").fill("500");
    await page.waitForFunction(()=>window.era5viewer.state.grid?.mode==="pressure"&&window.era5viewer.state.grid?.value===500);
    assert.equal(await page.locator("#layer-badge").textContent(),"500 hPa");
    await page.locator('[data-mode="model"]').click();
    await page.waitForFunction(()=>window.era5viewer.state.grid?.mode==="model");
    await page.locator("#level").fill("137");
    await page.waitForFunction(()=>window.era5viewer.state.grid?.value===137);
    await page.locator('[data-mode="height"]').click();
    await page.locator('[data-field="t"]').click();
    await page.waitForFunction(()=>window.era5viewer.state.grid?.mode==="height"&&window.era5viewer.state.grid?.variable.id==="t");

    // A genuine map click drives the point/profile workflow.
    await page.locator("#map").click({position:{x:560,y:380}});
    await page.waitForFunction(()=>window.era5viewer.state.profile?.profiles.t?.length===137);
    assert.equal(await page.locator("#point-metrics .metric").count(),4);
    assert.equal(await page.locator("#profile-chart svg").count(),1);
    await page.locator("#coordinate-toggle").click();
    assert.match(await page.locator("#point-coordinates").textContent(),/°[NS], .*°[EW]/);
    assert.equal(await page.evaluate(()=>window.era5viewer.state.reference),"msl");
    await page.locator("#profile-axis").selectOption("pressure");
    assert.equal(await page.evaluate(()=>window.era5viewer.state.profilePlot.axis),"pressure");
    await page.locator("#profile-axis").selectOption("height");
    const svgBounds=await page.locator("#profile-chart svg").boundingBox();
    await page.mouse.move(svgBounds.x+svgBounds.width*.5,svgBounds.y+svgBounds.height*.5);
    await page.mouse.wheel(0,-100);
    await page.waitForFunction(()=>window.era5viewer.state.profileView!==null);
    await page.locator("#profile-reset").click();
    await page.locator("#contour-toggle").check();
    await page.locator("#range-mode").selectOption("view");
    await page.waitForFunction(()=>window.era5viewer.state.contourCache!==null);
    await page.locator("#temperature-unit").selectOption("K");
    assert.equal(await page.locator("#legend-unit").textContent(),"K");
    await page.locator("#temperature-unit").selectOption("C");
    await page.locator(".drift-tools summary").click();
    await page.locator("#drift-run").click();
    await page.waitForFunction(()=>window.era5viewer.state.drift?.path.length>2);
    assert.match(await page.locator("#drift-status").textContent(),/Horizontal wind only/);
    const profileDownload=page.waitForEvent("download");
    await page.locator("#profile-export").click();
    const download=await profileDownload;
    assert.equal(download.suggestedFilename(),"era5-profile.csv");
    await download.saveAs(path.join(out,"profile.csv"));
    assert.equal(fs.readFileSync(path.join(out,"profile.csv"),"utf8").trim().split("\n").length,138);
    const mapDownload=page.waitForEvent("download");await page.locator("#map-png").click();
    await (await mapDownload).saveAs(path.join(out,"browser-map-export.png"));
    const profilePNG=page.waitForEvent("download");await page.locator("#profile-png").click();
    await (await profilePNG).saveAs(path.join(out,"browser-profile-export.png"));
    await page.locator("#connection-open").click();
    await page.locator("#personal-config summary").first().click();
    await page.locator("#config-file").setInputFiles({name:"my-era5.json",mimeType:"application/json",
      buffer:Buffer.from(JSON.stringify({data_root:"/my/ERA5",host:"127.0.0.1",port:8788,cache_mb:128}))});
    await page.waitForFunction(()=>document.getElementById("config-root").value==="/my/ERA5");
    assert.match(await page.locator("#config-command").textContent(),/--config '~\/my-era5.json'/);
    assert.match(await page.locator("#config-tunnel").textContent(),/-L 8788:127.0.0.1:8788/);
    const settingsDownload=page.waitForEvent("download");await page.locator("#config-download").click();
    const settings=await settingsDownload;assert.equal(settings.suggestedFilename(),"my-era5.json");
    await settings.saveAs(path.join(out,"personal-settings.json"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(out,"personal-settings.json"),"utf8")).port,8788);
    assert.equal(await page.evaluate(()=>window.era5viewer.state.catalog.root),data);
    await page.locator("#connection-close").click();
    await page.screenshot({path:path.join(out,"desktop.png"),fullPage:true});

    await page.locator("#next-time").click();
    await page.waitForFunction(()=>window.era5viewer.state.grid?.record.datetime.includes("T15:00"));
    assert.equal(await page.locator("#drift-export").isVisible(),true);
    assert.equal(await page.evaluate(()=>window.era5viewer.state.tracks.length),1);
    await page.locator("#play").click();
    await page.waitForFunction(()=>window.era5viewer.state.grid?.record.datetime.includes("T18:00"));
    await page.locator("#play").click();
    assert.equal(await page.evaluate(()=>window.era5viewer.state.playing),false);
    await page.locator("#prev-day").click();
    await page.waitForFunction(()=>window.era5viewer.state.grid?.record.datetime.startsWith("2016-09-25"));

    // Opening the HTML directly must use ordinary browser CORS, without
    // disabling web security. The connection dialog selects the test reader.
    const filePage=await context.newPage();
    filePage.on("pageerror",error=>errors.push(error.message));
    await filePage.goto(pathToFileURL(path.join(root,"index.html")).href);
    await filePage.locator("#connection-open").click();
    await filePage.locator("#api-url").fill(base);
    await filePage.locator('#connection-form button[type="submit"]').click();
    await filePage.waitForFunction(()=>window.era5viewer?.state.grid?.stats.valid>0);
    assert.equal(await filePage.locator("#connection-state").textContent(),"Local archive");
    await filePage.screenshot({path:path.join(out,"file-html.png"),fullPage:true});

    await page.setViewportSize({width:390,height:844});
    await page.locator("#point-close").click();
    await page.locator("#sidebar-toggle").click();
    assert.equal(await page.locator("#sidebar").isVisible(),true);
    await page.locator("#sidebar-toggle").click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=390),true);
    await page.screenshot({path:path.join(out,"mobile.png"),fullPage:true});
    // v1.4 interaction and projection checks in a real browser.
    await page.setViewportSize({width:1440,height:1000});
    const first=await page.evaluate(()=>{const a=window.era5viewer;a.selectPoint(L.latLng(65,-30));return a.windows.active.point.panel.id;});
    await page.waitForFunction(()=>window.era5viewer.state.profile?.profiles.t.length===137);
    const firstPanel=page.locator("#"+first);
    await firstPanel.locator('[data-ui="profile-axis"]').selectOption("pressure");
    await firstPanel.locator('[data-ui="profile-bottom"]').fill("300");
    await firstPanel.locator('[data-ui="profile-top"]').fill("100");
    await firstPanel.locator('[data-ui="profile-bounds"] button').click();
    const initial=await page.evaluate(()=>JSON.stringify(window.era5viewer.state.profileView));
    await firstPanel.locator('[data-ui="point-minimise"]').click();
    assert.equal(await firstPanel.isVisible(),false);
    await page.locator("#point-menu-toggle").click();
    await page.locator("#point-window-list .window-list-row > button:first-child").first().click();
    assert.equal(await firstPanel.isVisible(),true);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.era5viewer.state.profileView)),initial);
    let before=await firstPanel.boundingBox();const heading=await firstPanel.locator(".window-drag-handle").boundingBox();
    await page.mouse.move(heading.x+50,heading.y+20);await page.mouse.down();await page.mouse.move(heading.x-10,heading.y+40,{steps:5});await page.mouse.up();
    let after=await firstPanel.boundingBox();assert.ok(after.x<before.x-30);
    const grip=await firstPanel.locator(".resize-s").boundingBox();before=after;
    await page.mouse.move(grip.x+30,grip.y+3);await page.mouse.down();await page.mouse.move(grip.x+30,grip.y-57,{steps:5});await page.mouse.up();
    after=await firstPanel.boundingBox();assert.ok(after.height<before.height-40);
    const second=await page.evaluate(()=>{const a=window.era5viewer;a.selectPoint(L.latLng(-50,120));return a.windows.active.point.panel.id;});
    await page.waitForFunction(()=>window.era5viewer.state.profile?.latitude===-50);
    const secondPanel=page.locator("#"+second);
    await secondPanel.locator('[data-ui="profile-axis"]').selectOption("pressure");
    await secondPanel.locator('[data-ui="profile-bottom"]').fill("1000");
    await secondPanel.locator('[data-ui="profile-top"]').fill("850");
    await secondPanel.locator('[data-ui="profile-bounds"] button').click();
    assert.equal(await firstPanel.locator('[data-ui="profile-bottom"]').inputValue(),"300");
    await secondPanel.locator('[data-ui="point-minimise"]').click();
    for(const mode of ["north","south","globe"]){
      await page.locator('[data-projection="'+mode+'"]').click();
      await page.waitForFunction(mode=>window.era5viewer.view.mode===mode,mode);
      assert.equal(await page.locator("#basemap-toggle").isDisabled(),true);
    }
    const rotation=await page.evaluate(()=>window.era5viewer.view.rotation.lng);
    const surface=await page.locator("#projected-map").boundingBox();
    await page.mouse.move(surface.x+150,surface.y+400);await page.mouse.down();await page.mouse.move(surface.x+220,surface.y+420,{steps:6});await page.mouse.up();
    assert.notEqual(await page.evaluate(()=>window.era5viewer.view.rotation.lng),rotation);
    await page.locator("#animated-wind").check();
    await page.waitForFunction(()=>window.era5viewer.wind.steps>3);
    assert.ok(await page.evaluate(()=>window.era5viewer.wind.particles.some(p=>p.life>0)));
    await page.screenshot({path:path.join(out,"v14-desktop.png"),fullPage:true});
    await page.locator("#animated-wind").uncheck();
    assert.equal(await page.evaluate(()=>window.era5viewer.wind.frame),null);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=390),true);
    await page.locator("#point-menu-toggle").click();
    const menuBounds=await page.locator("#point-menu").boundingBox();assert.ok(menuBounds.x>=0&&menuBounds.x+menuBounds.width<=390);
    await page.screenshot({path:path.join(out,"v14-mobile.png"),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log("Browser checks: PASS (v1.4 polar/globe controls, animated wind, independent pressure bounds, drag/resize/minimise, mobile menus, plus archive, exports, drift, time playback and file:// checks)");
  } finally {
    if(browser)await browser.close();
    if(server)server.kill();
    fs.rmSync(data,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
