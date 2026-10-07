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
    const fixture=spawnSync(python, [path.join(root,"scripts/make_test_data.py"),data], {cwd:root,encoding:"utf8"});
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
    await page.locator("#basemap-toggle").uncheck();

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
    await page.screenshot({path:path.join(out,"desktop.png"),fullPage:true});

    await page.locator("#next-time").click();
    await page.waitForFunction(()=>window.era5viewer.state.grid?.record.datetime.includes("T15:00"));
    assert.equal(await page.locator("#drift-export").isVisible(),false);
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
    assert.deepEqual(errors,[]);
    console.log("Browser checks: PASS (fields, dates/times, layers, profile, drift, CSV, animation, file:// HTML, mobile)");
  } finally {
    if(browser)await browser.close();
    if(server)server.kill();
    fs.rmSync(data,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
