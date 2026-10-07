/* No bundler or external JavaScript is needed. All displayed fields come from
   the local reader. A disconnected viewer never invents weather data. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  function stored(key, fallback) { try { return localStorage.getItem("era5viewer." + key) || fallback; } catch (_) { return fallback; } }
  function remember(key, value) { try { localStorage.setItem("era5viewer." + key, value); } catch (_) {} }
  const state = {
    base: /https?:/.test(location.protocol) ? location.origin : stored("api", "http://127.0.0.1:8765"),
    catalog: null, times: [], ti: 0, date: "", variable: "t", mode: "height", value: 5, reference: "agl",
    grid: null, selected: null, profile: null, playing: false, timer: null,
    serial: 0, daySerial: 0, connectSerial: 0, driftSerial: 0, sliceAbort: null, pointAbort: null,
    drift: null, driftLine: null, fitted: false, scale: [-40, 20]
  };
  const NAMES = { t: "Temperature", u: "U wind · eastward", v: "V wind · northward", wind_speed: "Wind speed" };
  const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 1, maxZoom: 12,
    maxBounds: [[-85.05, -720], [85.05, 720]], maxBoundsViscosity: 0.8 }).setView([35, -5], 3);
  L.control.zoom({position: "bottomright"}).addTo(map);
  L.control.scale({position: "bottomright", imperial: false}).addTo(map);
  map.createPane("drift");
  map.getPane("drift").style.zIndex = "615";
  const basemap = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  }).addTo(map);
  const marker = L.marker([0, 0], {icon: L.divIcon({className: "selected-point", iconSize: [12, 12], iconAnchor: [6, 6]})});
  const fieldCanvas = $("field-canvas"), overlayCanvas = $("overlay-canvas");
  const ctx = fieldCanvas.getContext("2d"), overlay = overlayCanvas.getContext("2d");
  const small = document.createElement("canvas"), smallCtx = small.getContext("2d");
  let renderPending = false, changeTimer = null;

  function notice(message, error = false) {
    $("notice").textContent = message;
    $("notice").hidden = !message;
    $("notice").classList.toggle("error", error);
  }
  function empty(message, showConnect = false) {
    $("empty-state").hidden = false;
    $("empty-message").textContent = message;
    $("empty-connect").hidden = !showConnect;
  }
  function current() { return state.times[state.ti] || null; }
  function clock(record) { return record ? record.datetime.slice(11, 16) : "—"; }
  function layerLabel() {
    if (state.mode === "model") return "Model level " + state.value;
    if (state.mode === "pressure") return state.value + " hPa";
    return state.value + " km " + (state.reference === "msl" ? "above sea level" : "AGL");
  }
  function fieldMeta() { const r = current(); return r && r.fields.find(f => f.id === state.variable); }
  function units(variable = state.variable) {
    if (variable === "t") return $("temperature-unit").value === "C" ? "°C" : "K";
    if (["u", "v", "wind_speed"].includes(variable)) return "m s⁻¹";
    const r = current(); return r ? (r.fields.find(f => f.id === variable) || {}).units || "" : "";
  }
  function convert(value, variable = state.variable) {
    return variable === "t" && $("temperature-unit").value === "C" ? value - 273.15 : value;
  }
  function format(value, digits = 1) { return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits); }
  function args(extra = {}) {
    const r = current();
    if (!r) return {};
    return Object.assign({file: r.file, index: r.index, variable: state.variable, mode: state.mode,
      value: state.value, reference: state.reference, winds: $("wind-toggle").checked ? 1 : 0}, extra);
  }
  function url(path, params = {}) { return state.base.replace(/\/$/, "") + path + (Object.keys(params).length ? "?" + new URLSearchParams(params) : ""); }
  async function api(path, params = {}, signal) {
    let response;
    try { response = await fetch(url(path, params), {signal, cache: "no-store"}); }
    catch (error) {
      if (error.name === "AbortError" || error.name === "TimeoutError") throw error;
      throw new Error("Could not reach the local ERA5 reader. Start ./start.sh and check the reader address.");
    }
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The reader returned HTTP " + response.status);
    return body;
  }
  function abortLoads() {
    if (state.sliceAbort) state.sliceAbort.abort();
    if (state.pointAbort) state.pointAbort.abort();
  }
  function clearDrift() {
    state.driftSerial++;
    state.drift = null;
    if (state.driftLine) { map.removeLayer(state.driftLine); state.driftLine = null; }
    $("drift-status").textContent = "";
    $("drift-export").hidden = true;
    $("drift-clear").hidden = true;
    $("drift-run").disabled = false;
  }
  function invalidate() {
    abortLoads(); state.serial++; state.grid = null; state.profile = null;
    $("colour-legend").hidden = true; $("hover-readout").hidden = true;
    $("slice-export").classList.add("disabled"); $("profile-export").classList.add("disabled");
    $("point-metrics").replaceChildren(); $("profile-chart").replaceChildren();
    $("point-context").textContent = current() ? state.date + " · " + clock(current()) + " UTC · " + layerLabel() : "";
    $("profile-note").textContent = "";
    if (state.selected) $("point-status").textContent = "Reading selected point…";
    clearDrift(); scheduleDraw();
  }
  function updateHead() {
    const r = current(), f = fieldMeta();
    $("time-label").textContent = clock(r) + " UTC";
    $("map-field").textContent = NAMES[state.variable] || (f && f.name) || state.variable;
    $("map-context").textContent = r ? state.date + " · " + clock(r) + " UTC · " + layerLabel() : "Connect to your local ERA5 archive";
    $("layer-badge").textContent = layerLabel().replace("Model level ", "ML ").replace("above sea level", "MSL");
    $("units-badge").textContent = units();
    $("temp-unit-row").hidden = state.variable !== "t";
    document.querySelectorAll("[data-field]").forEach(b => {
      b.classList.toggle("active", b.dataset.field === state.variable);
      b.disabled = !r || !r.fields.some(f => f.id === b.dataset.field);
    });
    $("file-info").textContent = r ? r.filename + " · " + r.shape[1] + " × " + r.shape[0] + " grid" : "";
    $("time-count").textContent = state.times.length + " times";
    $("time-slider").value = state.ti;
    $("prev-time").disabled = !r || state.ti <= 0;
    $("next-time").disabled = !r || state.ti >= state.times.length - 1;
    document.querySelectorAll("#time-ticks button").forEach(b => b.classList.toggle("active", +b.dataset.index === state.ti));
    if (state.catalog) {
      const i = state.catalog.dates.indexOf(state.date);
      $("prev-day").disabled = i <= 0;
      $("next-day").disabled = i < 0 || i >= state.catalog.dates.length - 1;
    }
  }
  function configureLayer() {
    const r = current();
    document.querySelectorAll("[data-mode]").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === state.mode);
      b.disabled = !r || (b.dataset.mode === "pressure" && !r.pressure_available) || (b.dataset.mode === "height" && !r.height_available);
    });
    const slider = $("level-slider"), input = $("level");
    let presets;
    if (state.mode === "model") {
      const levels = r ? r.levels : Array.from({length: 137}, (_, i) => i + 1);
      if (!levels.includes(state.value)) state.value = levels.reduce((a, b) => Math.abs(b-state.value) < Math.abs(a-state.value) ? b : a);
      slider.min = input.min = levels[0]; slider.max = input.max = levels[levels.length-1]; slider.step = input.step = 1;
      $("level-label").textContent = "Model level"; $("level-unit").textContent = "";
      $("level-min").textContent = levels[0] + " · upper"; $("level-max").textContent = levels[levels.length-1] + " · lower";
      $("level-note").textContent = "Model levels follow terrain. In L137, level 1 is at the top and 137 is near the surface.";
      presets = [50, 80, 100, 120, 137].filter(x => levels.includes(x));
    } else if (state.mode === "pressure") {
      slider.min = input.min = 1; slider.max = input.max = 1100; slider.step = input.step = 1;
      $("level-label").textContent = "Pressure"; $("level-unit").textContent = "hPa";
      $("level-min").textContent = "1 hPa"; $("level-max").textContent = "1100 hPa";
      $("level-note").textContent = "Pressure from lnsp and the L137 coefficients. Variables are interpolated in log-pressure; unrepresented levels are transparent.";
      presets = [100, 250, 500, 850, 1000];
    } else {
      slider.min = 0.1; input.min = 0; slider.max = 80; input.max = 100; slider.step = input.step = 0.1;
      $("level-label").textContent = "Height"; $("level-unit").textContent = "km";
      $("level-min").textContent = "0.1 km"; $("level-max").textContent = "80 km";
      const dry = r && !r.fields.some(f => f.id === "q");
      $("level-note").textContent = (dry ? "Dry-air approximation · " : "") + "geopotential height " +
        (state.reference === "agl" ? "above ground." : "above the sea-level geoid.") + " No extrapolation beyond represented levels.";
      presets = [1, 5, 10, 20, 30];
    }
    input.value = state.value; slider.value = state.value;
    $("presets").replaceChildren(...presets.map(value => {
      const b = document.createElement("button"); b.textContent = value + (state.mode === "height" ? " km" : "");
      b.onclick = () => { setLevel(value); }; return b;
    }));
    $("height-reference-row").hidden = state.mode !== "height";
    $("height-reference").options[1].disabled = !r || !r.msl_available;
    $("height-reference").value = state.reference;
    updateHead();
  }
  function debounceSlice() {
    invalidate(); updateHead();
    clearTimeout(changeTimer); changeTimer = setTimeout(loadSlice, 140);
  }
  function setLevel(value) {
    if (!Number.isFinite(value)) { invalidate(); notice("Enter a numeric layer value.", true); return; }
    if (state.mode === "model" && current()) value = current().levels.reduce((a,b) => Math.abs(b-value) < Math.abs(a-value) ? b : a);
    state.value = value; $("level").value = value; $("level-slider").value = value;
    debounceSlice();
  }
  function chooseMode(mode) {
    stopPlay();
    if (mode === state.mode) return;
    state.mode = mode; state.value = mode === "model" ? 100 : mode === "pressure" ? 500 : 5;
    configureLayer(); debounceSlice();
  }
  function decodeArray(encoded, expected) {
    const binary = atob(encoded), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.byteLength !== expected * 4) throw new Error("The reader returned an incomplete grid.");
    const view = new DataView(bytes.buffer), out = new Float32Array(expected);
    for (let i = 0; i < expected; i++) out[i] = view.getFloat32(i*4, true);
    return out;
  }
  async function loadSlice() {
    clearTimeout(changeTimer);
    if (!current()) return false;
    abortLoads();
    const serial = ++state.serial, requestArgs = args();
    const controller = new AbortController(); state.sliceAbort = controller;
    $("loading").hidden = false; notice("");
    try {
      const data = await api("/api/slice", requestArgs, controller.signal);
      if (serial !== state.serial) return false;
      const arrays = {};
      for (const [name, encoded] of Object.entries(data.arrays)) arrays[name] = decodeArray(encoded, data.shape[0] * data.shape[1]);
      state.grid = Object.assign(data, {arrays});
      $("empty-state").hidden = true; $("empty-connect").hidden = true;
      if ($("auto-range").checked) state.scale = [convert(data.stats.low), convert(data.stats.high)];
      if (!state.scale.every(Number.isFinite) || state.scale[1] <= state.scale[0]) state.scale = [0,1];
      $("range-min").value = state.scale[0].toFixed(2); $("range-max").value = state.scale[1].toFixed(2);
      updateLegend(); scheduleDraw();
      $("slice-export").href = url("/api/export/slice", requestArgs); $("slice-export").classList.remove("disabled");
      const warnings = data.record.warnings.filter(w => state.mode === "height" || !w.includes("height") && !w.includes("Height") && !w.includes("geopotential"));
      if (!data.stats.valid) notice("This layer is outside the represented column or contains no valid values. Try another layer.");
      else if (warnings.length) notice(warnings[0]);
      $("data-badge").textContent = "ERA5 · " + data.shape[1] + " × " + data.shape[0];
      if (!state.fitted) { fitData(); state.fitted = true; }
      if (state.selected) loadPoint();
      return true;
    } catch (error) {
      if (error.name !== "AbortError" && serial === state.serial) {
        state.grid = null; $("colour-legend").hidden = true;
        $("slice-export").classList.add("disabled"); scheduleDraw(); notice(error.message, true);
        empty("This selection could not be loaded.\n" + error.message);
      }
      return false;
    } finally { if (serial === state.serial) $("loading").hidden = true; }
  }
  function datesForYear() {
    const dates = state.catalog ? state.catalog.dates.filter(d => d.slice(0,4) === $("year").value) : [];
    $("available-date").replaceChildren(...dates.map(d => new Option(d.slice(5) + " · " + new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", {weekday:"short", timeZone:"UTC"}), d)));
    $("available-date").value = state.date;
  }
  async function loadDay(date, preferredClock) {
    stopPlay(); clearTimeout(changeTimer);
    const serial = ++state.daySerial, lastClock = preferredClock || clock(current()) || "12:00";
    state.date = date; state.times = []; state.ti = 0;
    invalidate(); $("loading").hidden = false; updateHead(); notice("");
    $("date").value = date; $("year").value = date.slice(0,4); datesForYear();
    $("time-slider").disabled = true; $("play").disabled = true; $("variable").disabled = true;
    $("time-ticks").replaceChildren();
    try {
      const result = await api("/api/day", {date});
      if (serial !== state.daySerial) return;
      state.times = result.times;
      const minutes = s => +s.slice(0,2)*60 + +s.slice(3,5);
      const preferred = /^\d\d:\d\d$/.test(lastClock) ? minutes(lastClock) : 720;
      state.ti = result.times.reduce((best,r,i) => Math.abs(minutes(clock(r))-preferred) < Math.abs(minutes(clock(result.times[best]))-preferred) ? i : best, 0);
      const r = current();
      state.variable = r.fields.some(f => f.id === state.variable) ? state.variable : r.fields[0].id;
      if (state.mode === "height" && !r.height_available || state.mode === "pressure" && !r.pressure_available) { state.mode = "model"; state.value = r.levels[r.levels.length-1]; }
      if (state.reference === "msl" && !r.msl_available) state.reference = "agl";
      populateFields(); configureLayer(); makeTimeTicks();
      $("time-slider").max = state.times.length - 1; $("time-slider").disabled = state.times.length < 2;
      $("play").disabled = state.times.length < 2;
      remember("date", date); updateHead(); await loadSlice();
    } catch (error) {
      if (serial === state.daySerial) {
        notice(error.message, true); empty(error.message);
        $("loading").hidden = true; state.times = []; updateHead();
      }
    }
  }
  function populateFields() {
    const r = current();
    $("variable").replaceChildren(...r.fields.map(f => new Option(NAMES[f.id] || f.name, f.id)));
    $("variable").value = state.variable; $("variable").disabled = false;
    const wind = r.fields.some(f=>f.id==="u") && r.fields.some(f=>f.id==="v");
    $("wind-toggle").disabled = !wind; $("drift-run").disabled = !wind;
    $("profile-variable").replaceChildren(...["t","wind_speed","u","v"].filter(v => r.fields.some(f=>f.id===v)).map(v=>new Option(NAMES[v], v)));
  }
  function makeTimeTicks() {
    const size = Math.max(2, Math.floor($("time-ticks").clientWidth / 44));
    const every = Math.max(1, Math.ceil((state.times.length-1)/size));
    $("time-ticks").replaceChildren(...state.times.flatMap((r,i) => {
      if (i % every && i !== state.times.length-1) return [];
      const b = document.createElement("button"); b.textContent = clock(r); b.dataset.index = i;
      b.style.left = (state.times.length === 1 ? 0 : i/(state.times.length-1)*100) + "%";
      b.onclick = () => changeTime(i); return [b];
    }));
  }
  function changeTime(index, play = false) {
    if (!play) stopPlay();
    if (!state.times.length) return;
    state.ti = Math.max(0, Math.min(state.times.length-1, index));
    const r = current();
    if (!r.fields.some(f=>f.id===state.variable)) state.variable = r.fields[0].id;
    if (state.mode === "height" && !r.height_available || state.mode === "pressure" && !r.pressure_available) { state.mode = "model"; state.value = r.levels[r.levels.length-1]; }
    if (!r.msl_available) state.reference = "agl";
    populateFields(); configureLayer(); invalidate(); updateHead();
    return loadSlice();
  }
  function stopPlay() { state.playing = false; clearTimeout(state.timer); $("play").textContent = "▶"; $("play").setAttribute("aria-label", "Play available times"); }
  async function playNext() {
    if (!state.playing) return;
    const ok = await changeTime((state.ti+1)%state.times.length, true);
    if (!ok) { stopPlay(); return; }
    if (state.playing) state.timer = setTimeout(playNext, 1100);
  }
  async function connect(refresh = false) {
    stopPlay(); state.daySerial++; invalidate();
    const serial = ++state.connectSerial;
    state.catalog = null; state.times = []; updateHead();
    $("connection-state").textContent = "Connecting"; $("connection-dot").className = "";
    $("loading").hidden = false;
    empty("Connecting to the ERA5 reader…");
    try {
      const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15000) : undefined;
      const catalog = await api("/api/catalog", refresh ? {refresh: 1} : {}, timeout);
      if (serial !== state.connectSerial) return;
      state.catalog = catalog;
      $("connection-state").textContent = "Local archive"; $("connection-dot").className = "online";
      $("source-path").textContent = catalog.root;
      $("day-count").textContent = catalog.dates.length.toLocaleString() + " days";
      $("year").replaceChildren(...catalog.years.map(y=>new Option(y,y)));
      $("year").disabled = !catalog.dates.length; $("available-date").disabled = !catalog.dates.length;
      if (!catalog.dates.length) {
        empty("No ERA5 NetCDF files were found in " + catalog.root + ".\nCheck data_root in config.json, then rescan.", true);
        notice(catalog.messages.join(" · ")); $("loading").hidden = true; return;
      }
      $("date").min = catalog.dates[0]; $("date").max = catalog.dates[catalog.dates.length-1];
      const saved = state.date || stored("date","");
      const date = catalog.dates.includes(saved) ? saved : catalog.dates[catalog.dates.length-1];
      state.fitted = false;
      await loadDay(date, "12:00");
    } catch (error) {
      if (serial === state.connectSerial) {
        $("connection-state").textContent = "Reader offline"; $("connection-dot").className = "offline";
        $("loading").hidden = true;
        empty(error.name === "TimeoutError" ? "The reader did not respond. Start ./start.sh and check the reader address." : error.message, true);
        notice(""); $("source-path").textContent = "Open connection settings to start the local reader.";
      }
    }
  }
  function fitData() {
    const r = current(); if (!r) return;
    if (r.cyclic) map.setView([30,0], 2);
    else map.fitBounds([[Math.max(-84,r.bounds[0]),r.bounds[1]],[Math.min(84,r.bounds[2]),r.bounds[3]]], {padding:[35,100], maxZoom:7});
  }

  function axisBracket(axis, value, cyclic = false) {
    if (cyclic) {
      value = ((value-axis[0])%360+360)%360+axis[0];
      if (value > axis[axis.length-1]) return [axis.length-1, 0, (value-axis[axis.length-1])/(axis[0]+360-axis[axis.length-1])];
    }
    if (value < axis[0]-1e-7 || value > axis[axis.length-1]+1e-7) return null;
    value = Math.max(axis[0], Math.min(axis[axis.length-1], value));
    let lo = 0, hi = axis.length-1;
    while (hi-lo > 1) { const mid = (lo+hi)>>1; if (axis[mid] <= value) lo=mid; else hi=mid; }
    return [lo,hi,(value-axis[lo])/(axis[hi]-axis[lo])];
  }
  function lonBracket(grid, lon) {
    if (!grid.cyclic) { const c = (grid.longitudes[0]+grid.longitudes[grid.longitudes.length-1])/2; lon += 360*Math.round((c-lon)/360); }
    return axisBracket(grid.longitudes,lon,grid.cyclic);
  }
  function bilinear(array, shape, y, x) {
    if (!array || !y || !x) return NaN;
    let sum = 0;
    for (const [yi, wy] of [[y[0],1-y[2]],[y[1],y[2]]]) for (const [xi,wx] of [[x[0],1-x[2]],[x[1],x[2]]]) {
      const w=wy*wx;
      if (w>1e-12) { const v=array[yi*shape[1]+xi]; if (!Number.isFinite(v)) return NaN; sum+=v*w; }
    }
    return sum;
  }
  function sample(grid, name, lat, lon) { return bilinear(grid.arrays[name],grid.shape,axisBracket(grid.latitudes,lat),lonBracket(grid,lon)); }
  const PALETTES = {
    temperature: [[35,55,129],[47,139,194],[70,189,180],[205,232,183],[253,213,121],[236,114,99],[164,47,91]],
    component: [[33,73,137],[74,137,186],[150,195,209],[241,242,224],[244,198,133],[223,135,69],[155,67,38]],
    speed: [[57,40,111],[54,85,142],[34,134,142],[46,179,124],[151,211,94],[246,224,108]]
  };
  function palette() { return state.variable === "t" ? PALETTES.temperature : ["u","v"].includes(state.variable) ? PALETTES.component : PALETTES.speed; }
  function lut() {
    const p=palette(), result=[];
    for(let i=0;i<256;i++) { const v=i/255*(p.length-1), j=Math.min(p.length-2,Math.floor(v)), w=v-j; result.push(p[j].map((a,k)=>Math.round(a*(1-w)+p[j+1][k]*w))); }
    return result;
  }
  function updateLegend() {
    if (!state.grid) return;
    const f=fieldMeta(), [low,high]=state.scale;
    $("colour-legend").hidden=false; $("legend-title").textContent=NAMES[state.variable] || f.name;
    $("legend-unit").textContent=units(); $("legend-low").textContent=format(low);
    $("legend-mid").textContent=format((low+high)/2); $("legend-high").textContent=format(high);
    $("legend-gradient").style.background="linear-gradient(90deg,"+palette().map(c=>"rgb("+c.join(",")+")").join(",")+")";
    const s=state.grid.stats;
    $("legend-coverage").textContent=(100*s.valid/s.total).toFixed(1)+"% of grid represented · transparent = no data";
  }
  function scheduleDraw() {
    if (renderPending) return;
    renderPending=true;
    requestAnimationFrame(()=>{renderPending=false; draw();});
  }
  function resize() {
    const size=map.getSize(), dpr=Math.min(2,window.devicePixelRatio||1);
    for(const c of [fieldCanvas,overlayCanvas]) { c.width=Math.round(size.x*dpr); c.height=Math.round(size.y*dpr); }
    ctx.setTransform(dpr,0,0,dpr,0,0); overlay.setTransform(dpr,0,0,dpr,0,0);
    if (state.times.length) { makeTimeTicks(); updateHead(); }
    scheduleDraw();
  }
  function draw() {
    const size=map.getSize();
    ctx.clearRect(0,0,size.x,size.y); overlay.clearRect(0,0,size.x,size.y);
    const g=state.grid;
    if (g) {
      const pixel=3, w=Math.ceil(size.x/pixel), h=Math.ceil(size.y/pixel);
      small.width=w; small.height=h;
      const image=smallCtx.createImageData(w,h), colours=lut(), [lo,hi]=state.scale, alpha=Math.round(+$("opacity").value*2.55);
      const xs=Array.from({length:w},(_,x)=>lonBracket(g,map.containerPointToLatLng([x*pixel+pixel/2,0]).lng));
      for(let y=0;y<h;y++) {
        const lat=map.containerPointToLatLng([0,y*pixel+pixel/2]).lat, ys=axisBracket(g.latitudes,lat);
        if (!ys) continue;
        for(let x=0;x<w;x++) {
          const raw=bilinear(g.arrays.values,g.shape,ys,xs[x]);
          if (!Number.isFinite(raw)) continue;
          const v=convert(raw), c=colours[Math.max(0,Math.min(255,Math.round((v-lo)/(hi-lo)*255)))], i=(y*w+x)*4;
          image.data[i]=c[0]; image.data[i+1]=c[1]; image.data[i+2]=c[2]; image.data[i+3]=alpha;
        }
      }
      smallCtx.putImageData(image,0,0); ctx.imageSmoothingEnabled=true;
      ctx.drawImage(small,0,0,size.x,size.y);
    }
    if ($("grid-toggle").checked) drawGrid(size);
    if (g && $("wind-toggle").checked && g.arrays.u && g.arrays.v) drawWind(size,g);
  }
  function drawGrid(size) {
    const b=map.getBounds(), step=map.getZoom()>=7?1:map.getZoom()>=5?5:map.getZoom()>=3?15:30;
    overlay.save(); overlay.lineWidth=.7; overlay.strokeStyle="rgba(28,66,52,.22)";
    overlay.fillStyle="#466f60"; overlay.font="9px sans-serif";
    for(let lat=Math.ceil(b.getSouth()/step)*step;lat<=Math.min(85,b.getNorth());lat+=step) {
      if(lat<-85) continue; const p=map.latLngToContainerPoint([lat,b.getWest()]);
      overlay.beginPath();overlay.moveTo(0,p.y);overlay.lineTo(size.x,p.y);overlay.stroke();
      if(p.y>155 && p.y<size.y-90) {overlay.fillStyle="#ffffffe0";overlay.fillRect(8,p.y-11,34,13);overlay.fillStyle="#466f60";overlay.fillText(Math.abs(lat)+"°"+(lat<0?"S":lat>0?"N":""),11,p.y-2);}
    }
    for(let lon=Math.ceil(b.getWest()/step)*step;lon<=b.getEast();lon+=step) {
      const p=map.latLngToContainerPoint([b.getSouth(),lon]);overlay.beginPath();overlay.moveTo(p.x,0);overlay.lineTo(p.x,size.y);overlay.stroke();
      const l=((lon+180)%360+360)%360-180;
      if(p.x>20&&p.x<size.x-40) {overlay.fillStyle="#ffffffe0";overlay.fillRect(p.x-15,size.y-97,37,13);overlay.fillStyle="#466f60";overlay.fillText(Math.abs(l)+"°"+(l<0?"W":l>0?"E":""),p.x-12,size.y-87);}
    }
    overlay.restore();
  }
  function drawWind(size,g) {
    overlay.save();overlay.strokeStyle="#163b35d9";overlay.fillStyle="#163b35d9";overlay.lineWidth=1.3;
    for(let y=35;y<size.y-82;y+=57) for(let x=28;x<size.x;x+=57) {
      const ll=map.containerPointToLatLng([x,y]), u=sample(g,"u",ll.lat,ll.lng), v=sample(g,"v",ll.lat,ll.lng);
      const speed=Math.hypot(u,v); if(!Number.isFinite(speed)||speed<.2) continue;
      const length=9+Math.min(15,speed*.25), angle=Math.atan2(-v,u);
      overlay.save();overlay.translate(x,y);overlay.rotate(angle);
      overlay.beginPath();overlay.moveTo(-length/2,0);overlay.lineTo(length/2,0);overlay.stroke();
      overlay.beginPath();overlay.moveTo(length/2,0);overlay.lineTo(length/2-4,-2.8);overlay.lineTo(length/2-4,2.8);overlay.closePath();overlay.fill();overlay.restore();
    }
    overlay.restore();
  }
  function selectPoint(ll) {
    state.selected={lat:ll.lat,lon:ll.lng}; state.profile=null; clearDrift();
    marker.setLatLng(ll).addTo(map); showPointPanel();
    $("point-coordinates").textContent=ll.lat.toFixed(3)+"°, "+(((ll.lng+180)%360+360)%360-180).toFixed(3)+"°";
    $("point-status").textContent=state.grid?"Reading selected point…":"Load a layer to inspect this point.";
    $("point-metrics").replaceChildren();$("profile-chart").replaceChildren();
    if(state.grid) loadPoint();
  }
  function showPointPanel() {
    $("point-panel").hidden=false; $("point-open").hidden=true; $("colour-legend").classList.add("panel-visible");
  }
  async function loadPoint() {
    if(!state.selected||!state.grid) return;
    if(state.pointAbort) state.pointAbort.abort();
    const controller=new AbortController();state.pointAbort=controller;
    const serial=state.serial, selected=state.selected;
    const request=args({lat:selected.lat,lon:selected.lon});
    $("point-status").textContent="Reading selected point…";
    $("profile-export").classList.add("disabled");
    try {
      const data=await api("/api/profile",request,controller.signal);
      if(serial!==state.serial||selected!==state.selected) return;
      state.profile=data; $("point-status").textContent="";
      $("point-context").textContent=clock(current())+" UTC · "+layerLabel()+" · bilinear grid sample";
      renderMetrics();renderProfile();
      $("profile-export").href=url("/api/export/profile",request);$("profile-export").classList.remove("disabled");
    } catch(error) {
      if(error.name!=="AbortError"&&serial===state.serial&&selected===state.selected) {
        state.profile=null; $("point-status").textContent=error.message;
        $("point-metrics").replaceChildren();$("profile-chart").replaceChildren();
      }
    }
  }
  function renderMetrics() {
    const selected=state.profile&&state.profile.selected; if(!selected)return;
    const rows=[["t","Temperature"],["wind_speed","Wind speed"],["u","U · eastward"],["v","V · northward"]];
    $("point-metrics").replaceChildren(...rows.filter(([id])=>id in selected).map(([id,name])=>{
      const box=document.createElement("div");box.className="metric";
      const label=document.createElement("span");label.textContent=name;
      const value=document.createElement("strong");value.textContent=format(selected[id]==null?null:convert(selected[id],id));
      const unit=document.createElement("small");unit.textContent=units(id);
      value.append(unit);box.append(label,value);return box;
    }));
    if(selected.wind_from_deg!=null) $("point-context").textContent+=" · wind from "+format(selected.wind_from_deg,0)+"°";
  }
  function renderProfile() {
    if(!state.profile) return;
    const p=state.profile.profiles, variable=$("profile-variable").value;
    let coordinate, ylabel, transform=v=>v;
    if(p.height_agl_m) {coordinate=state.reference==="msl"&&p.height_msl_m?p.height_msl_m:p.height_agl_m;ylabel=state.reference==="msl"?"km MSL":"km AGL";transform=v=>v/1000;}
    else if(p.pressure_hpa) {coordinate=p.pressure_hpa;ylabel="log₁₀ hPa";transform=v=>-Math.log10(v);}
    else {coordinate=state.profile.levels;ylabel="model level";transform=v=>-v;}
    const values=p[variable];
    if(!values) { $("profile-chart").textContent="This profile variable is unavailable.";return; }
    const points=values.map((v,i)=>[v==null?null:convert(v,variable),coordinate[i]==null?null:transform(coordinate[i]),i]);
    const valid=points.filter(v=>v[0]!=null&&v[1]!=null&&v.slice(0,2).every(Number.isFinite));
    if(valid.length<2) {$("profile-chart").innerHTML='<div class="no-profile">No valid vertical profile at this location.</div>';return;}
    let xmin=Math.min(...valid.map(p=>p[0])),xmax=Math.max(...valid.map(p=>p[0]));
    const pad=Math.max((xmax-xmin)*.08,1);xmin-=pad;xmax+=pad;
    const ymin=Math.min(...valid.map(p=>p[1])),ymax=Math.max(...valid.map(p=>p[1]));
    const left=40,right=278,top=22,bottom=177;
    const x=v=>left+(v-xmin)/(xmax-xmin)*(right-left),y=v=>bottom-(v-ymin)/(ymax-ymin)*(bottom-top);
    let content='<svg viewBox="0 0 290 205" role="img" aria-label="Vertical '+(NAMES[variable]||variable)+' profile">';
    content+='<text x="0" y="10">'+ylabel+'</text><text x="280" y="202" text-anchor="end">'+units(variable)+'</text>';
    for(let i=0;i<=4;i++) {
      const v=ymin+(ymax-ymin)*i/4, yy=y(v), label=ylabel==="model level"?-v:v;
      content+='<line x1="'+left+'" y1="'+yy+'" x2="'+right+'" y2="'+yy+'" stroke="#e1e9e2"/><text x="34" y="'+(yy+3)+'" text-anchor="end">'+format(label,ylabel==="model level"?0:1)+'</text>';
    }
    for(let i=0;i<4;i++) {const v=xmin+(xmax-xmin)*i/3;content+='<text x="'+x(v)+'" y="192" text-anchor="middle">'+format(v,0)+'</text>';}
    let path="",previous=-2;
    for(const point of points) {
      if(point[0]==null||point[1]==null||!point.slice(0,2).every(Number.isFinite)) {previous=-2;continue;}
      const continuous=point[2]===previous+1&&state.profile.levels[point[2]]===state.profile.levels[previous]+1;
      path+=(continuous?" L":" M")+x(point[0]).toFixed(2)+","+y(point[1]).toFixed(2);previous=point[2];
    }
    content+='<path d="'+path+'" fill="none" stroke="#087f75" stroke-width="2.2" stroke-linejoin="round"/>';
    if(state.mode==="height"&&p.height_agl_m) {
      const yy=y(state.value);
      if(yy>=top&&yy<=bottom) content+='<line x1="'+left+'" y1="'+yy+'" x2="'+right+'" y2="'+yy+'" stroke="#be9048" stroke-dasharray="4 3"/>';
    }
    content+='</svg>';$("profile-chart").innerHTML=content;
    $("profile-note").textContent=p.height_agl_m?
      (current().fields.some(f=>f.id==="q")?"Hydrostatic geopotential height.":"Dry-air height estimate; humidity is not available."):"Pressure or model-level coordinate; height is unavailable.";
  }
  async function runDrift() {
    if(!state.selected||!state.grid) return;
    clearDrift();const serial=++state.driftSerial;
    const request=args({lat:state.selected.lat,lon:state.selected.lon,hours:$("drift-hours").value});
    $("drift-run").disabled=true;$("drift-status").textContent="Tracing through available ERA5 times…";
    try {
      const result=await api("/api/drift",request);
      if(serial!==state.driftSerial)return;
      state.drift=result;
      let prev=state.selected.lon;
      const points=result.path.map(p=>{let lon=p.longitude+360*Math.round((prev-p.longitude)/360);prev=lon;return[p.latitude,lon];});
      state.driftLine=L.polyline(points,{pane:"drift",color:"#133b32",weight:3,dashArray:"6 4"}).addTo(map);
      $("drift-status").textContent=format(result.drift_km,1)+" km from start · "+result.hours+" h · "+layerLabel()+". Horizontal wind only.";
      $("drift-export").hidden=false;$("drift-clear").hidden=false;
    } catch(error) { if(serial===state.driftSerial)$("drift-status").textContent=error.message; }
    finally {if(serial===state.driftSerial)$("drift-run").disabled=false;}
  }
  function downloadText(name,text) {
    const object=URL.createObjectURL(new Blob([text],{type:"text/csv;charset=utf-8"})),a=document.createElement("a");
    a.href=object;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(object),5000);
  }
  function hover(event) {
    if(!state.grid)return;
    const ll=event.latlng, raw=sample(state.grid,"values",ll.lat,ll.lng);
    if(!Number.isFinite(raw)) {$("hover-readout").hidden=true;return;}
    const el=$("hover-readout"),size=map.getSize();
    el.textContent=format(convert(raw))+" "+units()+"\n"+ll.lat.toFixed(2)+"°, "+(((ll.lng+180)%360+360)%360-180).toFixed(2)+"°";
    el.hidden=false;el.style.left=Math.min(event.containerPoint.x+15,size.x-170)+"px";el.style.top=Math.min(event.containerPoint.y+15,size.y-135)+"px";
  }
  map.on("move zoom resize",scheduleDraw);map.on("click",e=>selectPoint(e.latlng));map.on("mousemove",hover);
  map.on("mouseout movestart zoomstart",()=>{$("hover-readout").hidden=true;});
  new ResizeObserver(()=>{map.invalidateSize();resize();}).observe($("map"));
  window.addEventListener("resize",resize);
  $("variable").onchange=()=>{stopPlay();state.variable=$("variable").value;$("auto-range").checked=true;debounceSlice();};
  document.querySelectorAll("[data-field]").forEach(b=>b.onclick=()=>{if(!b.disabled){$("variable").value=b.dataset.field;$("variable").dispatchEvent(new Event("change"));}});
  document.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>{if(!b.disabled)chooseMode(b.dataset.mode);});
  $("level").oninput=e=>{stopPlay();setLevel(e.target.value===""?NaN:+e.target.value);};
  $("level-slider").oninput=e=>{stopPlay();setLevel(+e.target.value);};
  $("height-reference").onchange=()=>{stopPlay();state.reference=$("height-reference").value;configureLayer();debounceSlice();};
  $("temperature-unit").onchange=()=>{
    if(state.variable==="t") {
      if(state.grid&&$("auto-range").checked)state.scale=[convert(state.grid.stats.low),convert(state.grid.stats.high)];
      else {const delta=$("temperature-unit").value==="C"?-273.15:273.15;state.scale=state.scale.map(v=>v+delta);}
      $("range-min").value=state.scale[0].toFixed(2);$("range-max").value=state.scale[1].toFixed(2);
    }
    updateHead();updateLegend();scheduleDraw();renderMetrics();renderProfile();
  };
  $("date").onchange=()=>loadDay($("date").value);
  $("prev-day").onclick=()=>{const i=state.catalog&&state.catalog.dates.indexOf(state.date);if(i>0)loadDay(state.catalog.dates[i-1]);};
  $("next-day").onclick=()=>{const i=state.catalog&&state.catalog.dates.indexOf(state.date);if(i!=null&&i>=0&&i<state.catalog.dates.length-1)loadDay(state.catalog.dates[i+1]);};
  $("year").onchange=()=>{datesForYear();if($("available-date").options.length)loadDay($("available-date").options[0].value);};
  $("available-date").onchange=()=>loadDay($("available-date").value);
  $("time-slider").oninput=e=>changeTime(+e.target.value);
  $("prev-time").onclick=()=>changeTime(state.ti-1);$("next-time").onclick=()=>changeTime(state.ti+1);
  $("play").onclick=()=>{if(state.playing)stopPlay();else{state.playing=true;$("play").textContent="Ⅱ";$("play").setAttribute("aria-label","Pause animation");playNext();}};
  $("opacity").oninput=()=>{$("opacity-label").textContent=$("opacity").value+"%";scheduleDraw();};
  $("wind-toggle").onchange=()=>{invalidate();loadSlice();};$("grid-toggle").onchange=scheduleDraw;
  $("basemap-toggle").onchange=()=>{$("basemap-toggle").checked?basemap.addTo(map):map.removeLayer(basemap);};
  $("auto-range").onchange=()=>{if($("auto-range").checked&&state.grid){state.scale=[convert(state.grid.stats.low),convert(state.grid.stats.high)];$("range-min").value=state.scale[0].toFixed(2);$("range-max").value=state.scale[1].toFixed(2);updateLegend();scheduleDraw();}};
  for(const id of ["range-min","range-max"])$(id).onchange=()=>{
    const lo=+$("range-min").value,hi=+$("range-max").value;
    if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo>=hi){notice("Colour maximum must be greater than minimum.",true);return;}
    $("auto-range").checked=false;state.scale=[lo,hi];updateLegend();scheduleDraw();
  };
  $("fit-data").onclick=fitData;$("refresh").onclick=()=>connect(true);
  $("sidebar-toggle").onclick=()=>{$("sidebar").classList.toggle("open");setTimeout(()=>map.invalidateSize(),0);};
  $("point-close").onclick=()=>{$("point-panel").hidden=true;$("point-open").hidden=false;$("colour-legend").classList.remove("panel-visible");};
  $("point-open").onclick=showPointPanel;$("profile-variable").onchange=renderProfile;
  $("drift-run").onclick=runDrift;$("drift-clear").onclick=clearDrift;
  $("drift-hours").oninput=clearDrift;
  $("drift-export").onclick=()=>{
    if(!state.drift)return;
    downloadText("era5-wind-drift.csv","datetime_utc,latitude,longitude,elapsed_seconds,mode,level_value,height_reference\n"+
      state.drift.path.map(p=>[p.datetime,p.latitude,p.longitude,p.elapsed_seconds,state.drift.mode,state.drift.value,state.drift.reference].join(",")).join("\n")+"\n");
  };
  function openConnection() {$("api-url").value=state.base;$("connection-dialog").showModal();}
  $("connection-open").onclick=openConnection;$("empty-connect").onclick=openConnection;
  $("connection-close").onclick=()=>{$("connection-dialog").close();};
  $("connection-form").onsubmit=e=>{
    e.preventDefault();const address=$("api-url").value.replace(/\/$/,"");
    try {const u=new URL(address);if(!["http:","https:"].includes(u.protocol))throw new Error();} catch(_){notice("Enter an HTTP reader address.",true);return;}
    state.base=address;remember("api",address);$("connection-dialog").close();connect();
  };
  function dispose() {
    stopPlay(); clearTimeout(changeTimer);
    state.serial++; state.daySerial++; state.connectSerial++; state.driftSerial++;
    abortLoads();
  }
  window.addEventListener("pagehide",dispose);
  // Exposed to make scientific sampling and asynchronous UI behaviour testable.
  window.era5viewer={state,map,connect,loadSlice,sample,selectPoint,changeTime,dispose};
  resize();configureLayer();updateHead();connect();
})();
