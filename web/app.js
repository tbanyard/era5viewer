/* No bundler or external JavaScript is needed. All displayed fields come from
   the local reader. A disconnected viewer never invents weather data. */
(() => {
  "use strict";
  let windows = null;
  const $ = id => windows ? windows.get(id) : document.getElementById(id);
  const plots = window.ERA5Plots;
  function stored(key, fallback) { try { return localStorage.getItem("era5viewer." + key) || fallback; } catch (_) { return fallback; } }
  function remember(key, value) { try { localStorage.setItem("era5viewer." + key, value); } catch (_) {} }
  const state = {
    base: /https?:/.test(location.protocol) ? location.origin : stored("api", "http://127.0.0.1:8769"),
    catalog: null, times: [], ti: 0, date: "", variable: "t", mode: "height", value: 5, reference: "msl",
    preferredReference: stored("heightReference", "msl"),
    grid: null, selected: null, profile: null, playing: false, timer: null,
    serial: 0, daySerial: 0, connectSerial: 0, driftSerial: 0, sliceAbort: null, pointAbort: null,
    drift: null, tracks: [], trackId: 0, activeTrack: null, tracing: false,
    waypoints: [], sectionEditing: false, section: null, sectionPlot: null, sectionView: null,
    sectionAxis: "height_msl", sectionAbort: null, profileRequest: null, playViews: null,
    fitted: false, scale: [-40, 20], profileView: null, profilePlot: null,
    cacheEpoch: 0, prefetchSerial: 0, playSerial: 0, contourCache: null,
    compassCoordinates: stored("compassCoordinates", "0") === "1",
    configuration: null, configDraft: null, configEdited: false
  };
  const frames = {items: new Map(), bytes: 0, limit: 64*1024*1024};
  const pendingFrames = new Map();
  const charts = {items: new Map(), bytes: 0, limit: 24*1024*1024};
  const pendingCharts = new Map();
  state.frameCache = frames;
  const NAMES = { t: "Temperature", u: "U wind · eastward", v: "V wind · northward", wind_speed: "Wind speed" };
  const map = L.map("map", { zoomControl: false, preferCanvas: true, minZoom: 1, maxZoom: 12,
    maxBounds: [[-85.05, -720], [85.05, 720]], maxBoundsViscosity: 0.8 }).setView([35, -5], 3);

  const basemap = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    crossOrigin: "anonymous",
    maxZoom: 12, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  }).addTo(map);
  const fieldCanvas = $("field-canvas"), overlayCanvas = $("overlay-canvas");
  const ctx = fieldCanvas.getContext("2d"), overlay = overlayCanvas.getContext("2d");
  const small = document.createElement("canvas"), smallCtx = small.getContext("2d");
  const view = new window.ERA5Projections.View(map, $("projected-map"), projectionChanged,
    e => map.fire("click", e), e => e ? hover(e) : $("hover-readout").hidden = true);
  const wind = new window.ERA5Wind($("wind-canvas"), view, () => state.grid, sample);
  let renderPending = false, changeTimer = null;
  const dismissedNotices = new Set();

  function notice(message, error = false) {
    $("notice-text").textContent = message;
    $("notice").hidden = !message || dismissedNotices.has(message);
    $("notice").classList.toggle("error", error);
  }
  function empty(message, showConnect = false) {
    $("empty-state").hidden = false;
    $("empty-message").textContent = message;
    $("empty-connect").hidden = !showConnect;
  }
  function current() { return state.times[state.ti] || null; }
  function clock(record) { return record ? record.datetime.slice(11, 16) : "—"; }
  function layerLabel({mode, value, reference} = state) {
    if (mode === "model") return "Model level " + value;
    if (mode === "pressure") return value + " hPa";
    return value + " km " + (reference === "msl" ? "above sea level" : "AGL");
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
  function coordinateLabel(lat, lon, digits=3) {
    lon=((lon+180)%360+360)%360-180;
    if(state.compassCoordinates)return Math.abs(lat).toFixed(digits)+"°"+(lat<0?"S":"N")+", "+Math.abs(lon).toFixed(digits)+"°"+(lon<0?"W":"E");
    return lat.toFixed(digits)+"°, "+lon.toFixed(digits)+"°";
  }
  function updateCoordinates() {
    if(state.selected)$("point-coordinates").textContent=coordinateLabel(state.selected.lat,state.selected.lon);
    const b=$("coordinate-toggle"),label=state.compassCoordinates?"Use signed coordinates":"Use compass directions";
    b.setAttribute("aria-pressed",String(state.compassCoordinates));b.title=label;b.setAttribute("aria-label",label);
  }
  function args(extra = {}) {
    const r = current();
    if (!r) return {};
    return Object.assign({file: r.file, index: r.index, variable: state.variable, mode: state.mode,
      value: state.value, reference: state.reference, winds: ($("wind-toggle").checked || $("animated-wind").checked) ? 1 : 0}, extra);
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
    windows?.each("point", () => state.pointAbort?.abort());
    windows?.each("section", () => state.sectionAbort?.abort());
  }
  function clearDrift(all = false) {
    if (all) {state.driftSerial++; state.tracing=false; state.tracks=[];}
    else state.tracks=state.tracks.filter(t=>t.id!==state.activeTrack);
    state.activeTrack=state.tracks.length?state.tracks[state.tracks.length-1].id:null;
    renderTracks(); scheduleDraw();
  }
  function invalidate() {
    abortLoads(); state.serial++; state.grid = null; state.profile = null;
    $("colour-legend").hidden = true; $("hover-readout").hidden = true;
    $("slice-export").classList.add("disabled"); $("layer-netcdf").classList.add("disabled"); $("map-png").disabled = true;
    windows.each("point", () => {
      state.profile = null; state.profilePlot = null; $("profile-png").disabled = true;
      $("profile-export").classList.add("disabled");
      $("point-metrics").replaceChildren(); $("profile-chart").replaceChildren();
      $("point-context").textContent = current() ? state.date + " · " + clock(current()) + " UTC · " + layerLabel() : "";
      $("profile-note").textContent = ""; $("point-status").textContent = "Reading selected point…";
    });
    windows.each("section", clearSectionFrame);
    wind.update();
    scheduleDraw();
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
    $("height-reference-row").hidden = !r || !r.height_available;
    $("height-reference").options[1].disabled = !r || !r.msl_available;
    $("height-reference").value = state.reference;
    updateHead();
  }
  function debounceSlice() {
    state.prefetchSerial++; invalidate(); updateHead();
    clearTimeout(changeTimer); changeTimer = setTimeout(loadSlice, 140);
  }
  function setLevel(value) {
    stopPlay();
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
  function frameKey(request) { return state.base + "|" + JSON.stringify(request); }
  function cachedFrame(key, cache = frames) {
    const item=cache.items.get(key);
    if (item) {cache.items.delete(key);cache.items.set(key,item);return item.data;}
    return null;
  }
  function cacheFrame(cache, key, data, bytes) {
    if (bytes > cache.limit) return;
    const old = cache.items.get(key);
    if (old) { cache.bytes -= old.bytes; cache.items.delete(key); }
    while (cache.items.size && cache.bytes + bytes > cache.limit) {
      const oldest = cache.items.keys().next().value;
      cache.bytes -= cache.items.get(oldest).bytes;
      cache.items.delete(oldest);
    }
    cache.items.set(key, {data, bytes});
    cache.bytes += bytes;
  }
  async function getFrame(request,signal) {
    const key=frameKey(request),cached=cachedFrame(key);if(cached)return cached;
    let pending=pendingFrames.get(key);
    if(pending?.signal?.aborted){pendingFrames.delete(key);pending=null;}
    if(!pending){
      const epoch=state.cacheEpoch;
      pending={signal};
      pending.promise=api("/api/slice",request,signal).then(data=>{
        const arrays={};for(const [name,encoded] of Object.entries(data.arrays))arrays[name]=decodeArray(encoded,data.shape[0]*data.shape[1]);
        const decoded = Object.assign(data, {arrays});
        const bytes = Object.values(arrays).reduce((total, array) => total + array.byteLength, 0);
        if (epoch === state.cacheEpoch) cacheFrame(frames, key, decoded, bytes);
        return decoded;
      }).finally(()=>{if(pendingFrames.get(key)===pending)pendingFrames.delete(key);});
      pendingFrames.set(key,pending);
    }
    return pending.promise;
  }
  function selectionFor(record, preferred = state) {
    const variable = record.fields.some(f => f.id === preferred.variable) ? preferred.variable : record.fields[0].id;
    let {mode, value} = preferred;
    if ((mode === "height" && !record.height_available) || (mode === "pressure" && !record.pressure_available)) {
      mode = "model";
      value = record.levels.at(-1);
    }
    if (mode === "model") value = record.levels.reduce((a, b) => Math.abs(b-value) < Math.abs(a-value) ? b : a);
    return {variable, mode, value, reference: record.msl_available ? preferred.preferredReference : "agl"};
  }
  function frameArgs(record, preferred) {
    return args({file: record.file, index: record.index, ...selectionFor(record, preferred)});
  }
  async function getChart(kind, request, signal) {
    const key = kind + "|" + frameKey(request);
    const cached = cachedFrame(key, charts);
    if (cached) return cached;
    let pending = pendingCharts.get(key);
    if (pending?.signal?.aborted) pending = null;
    if (!pending) {
      const epoch = state.cacheEpoch;
      pending = {signal};
      pending.promise = api("/api/" + kind, request, signal).then(data => {
        let bytes = 8192;
        if (kind === "cross-section") {
          data.values = decodeArray(data.values, data.shape[0] * data.shape[1]);
          bytes += data.values.byteLength + 64 * data.path.length;
        } else {
          bytes += Object.values(data.profiles).reduce((total, values) => total + values.length * 8, 0);
        }
        if (epoch === state.cacheEpoch) cacheFrame(charts, key, data, bytes);
        return data;
      }).finally(() => {
        if (pendingCharts.get(key) === pending) pendingCharts.delete(key);
      });
      pendingCharts.set(key, pending);
    }
    return pending.promise;
  }
  function cacheStatus(message) {
    const count=state.times.filter(r=>frames.items.has(frameKey(frameArgs(r)))).length;
    $("animation-status").textContent=message||count+" / "+state.times.length+" frames cached";
    $("animation-status").title=(frames.bytes/1024/1024).toFixed(1)+" MiB of the 64 MiB browser frame cache";
  }
  async function warmFrames() {
    const job=++state.prefetchSerial,records=state.times.slice(),ti=state.ti,epoch=state.cacheEpoch;
    for(let n=1;n<=Math.min(2,records.length-1);n++) {
      if(job!==state.prefetchSerial||epoch!==state.cacheEpoch||state.playing)return;
      try {await getFrame(frameArgs(records[(ti+n)%records.length]));} catch(_){return;}
      if(job===state.prefetchSerial)cacheStatus();
    }
  }
  function resolutionLabel(record) {
    const r=record?.resolution;
    if(!r)return "";
    if(!r.regular)return "variable grid spacing";
    const x=plots.tickLabel(r.longitude),y=plots.tickLabel(r.latitude);
    return Math.abs(r.longitude-r.latitude)<1e-5?x+"°":x+"° lon × "+y+"° lat";
  }
  function updateScale() {
    const g=state.grid;if(!g||$("range-mode").value==="fixed")return;
    let lo=convert(g.stats.low),hi=convert(g.stats.high);
    if($("range-mode").value==="view") {
      const size=map.getSize(),values=[],bottom=Math.max(1,size.y-79);
      for(let y=0;y<=bottom;y+=14)for(let x=0;x<=size.x;x+=14){const ll=view.unproject([x,y]),v=ll ? sample(g,"values",ll.lat,ll.lng) : NaN;if(Number.isFinite(v))values.push(convert(v));}
      if(!values.length)return;
      values.sort((a,b)=>a-b);lo=plots.quantile(values,.02);hi=plots.quantile(values,.98);
    }
    state.scale=plots.niceExtent(lo,hi,6);
    $("range-min").value=plots.tickLabel(state.scale[0]);$("range-max").value=plots.tickLabel(state.scale[1]);
  }
  function showFrame(data, requestArgs) {
    notice("");
    state.grid = data;state.contourCache=null; wind.reset(); wind.update($("animated-wind").checked);
    $("empty-state").hidden = true; $("empty-connect").hidden = true;
    updateScale();
    if (!state.scale.every(Number.isFinite) || state.scale[1] <= state.scale[0]) state.scale = [0,1];
    updateLegend(); scheduleDraw();
    $("slice-export").href = url("/api/export/slice", requestArgs); $("slice-export").classList.remove("disabled");
    $("layer-netcdf").href=url("/api/export/layer.nc",requestArgs);$("layer-netcdf").classList.remove("disabled");
    $("map-png").disabled=false;
    const warnings = data.record.warnings.filter(w => state.mode === "height" || !w.includes("height") && !w.includes("Height") && !w.includes("geopotential"));
    if (!data.stats.valid) notice("This layer is outside the represented column or contains no valid values. Try another layer.");
    else if (warnings.length) notice(warnings.join(" · "));
    $("data-badge").textContent = "ERA5 · " + data.shape[1] + " × " + data.shape[0] + " · " + resolutionLabel(data.record);
    if (!state.fitted) { fitData(); state.fitted = true; }
  }
  async function loadSlice() {
    clearTimeout(changeTimer);
    if (!current()) return false;
    abortLoads();
    const serial = ++state.serial, requestArgs = args();
    const controller = new AbortController(); state.sliceAbort = controller;
    $("loading").hidden = !!cachedFrame(frameKey(requestArgs)); notice("");
    try {
      const data = await getFrame(requestArgs, controller.signal);
      if (serial !== state.serial) return false;
      showFrame(data, requestArgs);
      windows.each("point", loadPoint);
      windows.each("section", () => {if (state.waypoints.length >= 2) loadSection();});
      cacheStatus();
      if (!state.playing) warmFrames();
      return true;
    } catch (error) {
      if (error.name !== "AbortError" && serial === state.serial) {
        state.grid = null; $("colour-legend").hidden = true;
        $("slice-export").classList.add("disabled");$("layer-netcdf").classList.add("disabled");$("map-png").disabled=true;
        scheduleDraw(); notice(error.message, true);
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
    stopPlay(); state.prefetchSerial++; clearTimeout(changeTimer);
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
      Object.assign(state, selectionFor(r));
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
    $("wind-toggle").disabled = $("animated-wind").disabled = !wind; $("drift-run").disabled = !wind || state.tracing;
    const configureProfile=()=>{
      const profile=$("profile-variable"),selected=profile.value;
      const choices=["t","wind_speed","u","v"].filter(v=>r.fields.some(f=>f.id===v));
      profile.replaceChildren(...choices.map(v=>new Option(NAMES[v],v)));
      if(choices.includes(selected))profile.value=selected;
      $("drift-run").disabled=!wind||state.tracing;
    };
    if(windows.items.point.length)windows.each("point",configureProfile);else configureProfile();
    if(windows.items.section.length)windows.each("section",()=>configureSectionAxis(r));else configureSectionAxis(r);
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
  function selectTime(index, {variable, mode, value, reference} = selectionFor(state.times[index])) {
    state.ti = index;
    Object.assign(state, {variable, mode, value, reference});
    populateFields();
    configureLayer();
  }
  function changeTime(index) {
    stopPlay();
    if (!state.times.length) return;
    selectTime(Math.max(0, Math.min(state.times.length - 1, index)));
    invalidate();
    return loadSlice();
  }
  function stopPlay() {
    state.playing = false;
    state.playSerial++;
    clearTimeout(state.timer);
    state.playAbort?.abort();
    state.playViews = null;
    if (windows) for (const kind of ["point", "section"]) windows.each(kind, w => {w.playView = null;});
    $("play").textContent = "▶";
    $("play").setAttribute("aria-label", "Play available times");
    cacheStatus();
  }
  function chartResult(kind, request, signal) {
    if (!request) return null;
    return getChart(kind, request, signal).then(data => ({data, request}), error => ({error}));
  }
  function queuePlayback(generation, delay, preferred) {
    const index = (state.ti + 1) % state.times.length;
    const record = state.times[index], request = frameArgs(record, preferred);
    const signal = state.playAbort.signal;
    const jobs = [];
    for (const kind of ["point", "section"]) windows.each(kind, win => {
      const params = kind === "point" ? pointRequest(request) : sectionRequest(record, request);
      if (params) jobs.push(chartResult(kind === "point" ? "profile" : "cross-section", params, signal).then(result => ({win, result})));
    });
    const pending = Promise.allSettled([getFrame(request, signal), Promise.all(jobs)]);
    state.timer = setTimeout(async () => {
      if (!state.playing || generation !== state.playSerial) return;
      cacheStatus("Waiting for " + clock(record) + " UTC…");
      const [mapFrame, results] = await pending;
      if (!state.playing || generation !== state.playSerial) return;
      if (mapFrame.status === "rejected") {
        stopPlay();
        if (mapFrame.reason.name !== "AbortError") notice(mapFrame.reason.message, true);
        return;
      }
      abortLoads();
      state.serial++;
      selectTime(index, request);
      showFrame(mapFrame.value, request);
      if (results.status === "fulfilled") for (const {win, result} of results.value) {
        if (!win.closed) windows.with(win.kind, win, () => win.kind === "point" ? showPointFrame(result) : showSectionFrame(result));
      }
      cacheStatus();
      queuePlayback(generation, +$("animation-speed").value, preferred);
    }, delay);
  }
  function startPlay() {
    if (!state.grid || state.times.length < 2) return;
    state.playing = true;
    state.prefetchSerial++;
    const generation = ++state.playSerial;
    state.playAbort = new AbortController();
    state.playViews = {};
    windows.each("point", () => lockProfileAxes(state.profilePlot));
    windows.each("section", () => lockSectionAxes(state.sectionPlot));
    $("play").textContent = "Ⅱ";
    $("play").setAttribute("aria-label", "Pause animation");
    const {variable, mode, value, preferredReference} = state;
    queuePlayback(generation, 0, {variable, mode, value, preferredReference});
  }
  async function connect(refresh = false) {
    stopPlay(); state.daySerial++; state.cacheEpoch++; state.prefetchSerial++;
    frames.items.clear(); frames.bytes=0; pendingFrames.clear();
    charts.items.clear(); charts.bytes=0; pendingCharts.clear();
    invalidate();
    const serial = ++state.connectSerial;
    state.catalog = null; state.times = []; updateHead();
    $("connection-state").textContent = "Connecting"; $("connection-dot").className = "";
    $("loading").hidden = false;
    empty("Connecting to the ERA5 reader…");
    try {
      const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15000) : undefined;
      const [catalog,configuration] = await Promise.all([
        api("/api/catalog", refresh ? {refresh: 1} : {}, timeout),
        api("/api/config",{},timeout).catch(()=>null)
      ]);
      if (serial !== state.connectSerial) return;
      state.catalog = catalog;
      state.configuration=configuration;updateReaderConfiguration();
      $("connection-state").textContent = "Local archive"; $("connection-dot").className = "online";
      $("source-path").textContent = catalog.root;
      $("day-count").textContent = catalog.dates.length.toLocaleString() + " days";
      $("year").replaceChildren(...catalog.years.map(y=>new Option(y,y)));
      $("year").disabled = !catalog.dates.length; $("available-date").disabled = !catalog.dates.length;
      if (!catalog.dates.length) {
        empty("No ERA5 NetCDF files were found in " + catalog.root + ".\nCheck the data directory in your reader configuration, then rescan.", true);
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
    if (view.mode !== "flat") {view.reset(r); return;}
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
  function sample(grid, name, lat, lon) { if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NaN; return bilinear(grid.arrays[name],grid.shape,axisBracket(grid.latitudes,lat),lonBracket(grid,lon)); }
  const PALETTES = {
    temperature: [[35,55,129],[47,139,194],[70,189,180],[205,232,183],[253,213,121],[236,114,99],[164,47,91]],
    component: [[33,73,137],[74,137,186],[150,195,209],[241,242,224],[244,198,133],[223,135,69],[155,67,38]],
    speed: [[57,40,111],[54,85,142],[34,134,142],[46,179,124],[151,211,94],[246,224,108]]
  };
  function palette(variable = state.variable) { return variable === "t" ? PALETTES.temperature : ["u","v"].includes(variable) ? PALETTES.component : PALETTES.speed; }
  function lut(variable) {
    const p=palette(variable), result=[];
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
    $("legend-coverage").textContent=($("range-mode").value==="view"?"Visible-window scale · ":$("range-mode").value==="fixed"?"Fixed scale · ":"Full-layer scale · ")+(100*s.valid/s.total).toFixed(1)+"% represented";
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
    wind.resize();
    if (state.times.length) { makeTimeTicks(); updateHead(); }
    scheduleDraw();
  }
  function draw() {
    const size=map.getSize();
    ctx.clearRect(0,0,size.x,size.y); overlay.clearRect(0,0,size.x,size.y);
    const g=state.grid;
    if (view.mode === "globe") {const geom = view.geometry(); ctx.beginPath(); ctx.arc(geom.x, geom.y, geom.scale, 0, Math.PI * 2); ctx.fillStyle = "#dae9e1"; ctx.fill();}
    if (g) {
      updateScale(); updateLegend();
      const pixel = view.dragging ? 5 : 3, w=Math.ceil(size.x/pixel), h=Math.ceil(size.y/pixel);
      small.width=w; small.height=h;
      const image=smallCtx.createImageData(w,h), colours=lut(), [lo,hi]=state.scale, alpha=Math.round(+$("opacity").value*2.55);
      const flat = view.mode === "flat";
      const xs = flat ? Array.from({length:w},(_,x)=>lonBracket(g,view.unproject([x*pixel+pixel/2,0]).lng)) : null;
      for(let y=0;y<h;y++) {
        const ys = flat ? axisBracket(g.latitudes, view.unproject([0,y*pixel+pixel/2]).lat) : null;
        if (flat && !ys) continue;
        for(let x=0;x<w;x++) {
          const ll = flat ? null : view.unproject([x*pixel+pixel/2,y*pixel+pixel/2]);
          const raw = flat ? bilinear(g.arrays.values,g.shape,ys,xs[x]) : ll ? sample(g,"values",ll.lat,ll.lng) : NaN;
          if (!Number.isFinite(raw)) continue;
          const v=convert(raw), c=colours[Math.max(0,Math.min(255,Math.round((v-lo)/(hi-lo)*255)))], i=(y*w+x)*4;
          image.data[i]=c[0]; image.data[i+1]=c[1]; image.data[i+2]=c[2]; image.data[i+3]=alpha;
        }
      }
      smallCtx.putImageData(image,0,0); ctx.imageSmoothingEnabled=true;
      ctx.drawImage(small,0,0,size.x,size.y);
    }
    if (view.mode === "globe") {
      const g = view.geometry(), shade = ctx.createRadialGradient(g.x-g.scale*.28,g.y-g.scale*.28,g.scale*.12,g.x,g.y,g.scale);
      shade.addColorStop(0,"rgba(255,255,255,.05)"); shade.addColorStop(.8,"rgba(10,40,30,.02)"); shade.addColorStop(1,"rgba(10,40,30,.22)");
      ctx.beginPath(); ctx.arc(g.x,g.y,g.scale,0,Math.PI*2); ctx.fillStyle=shade; ctx.fill();
      ctx.strokeStyle="#70958780"; ctx.lineWidth=1; ctx.stroke();
    }
    const gridLabels = $("grid-toggle").checked ? drawGrid(size) : [];
    if ($("coastline-toggle").checked || view.mode !== "flat") drawCoastlines(size);
    if(g&&$("contour-toggle").checked)drawContours(size,g);
    if (g && $("wind-toggle").checked && !$("animated-wind").checked && g.arrays.u && g.arrays.v) drawWind(size,g);
    overlay.save(); overlay.font="10px sans-serif"; const occupied=[];
    for(const [text,x,y] of gridLabels)mapPill(text,x,y,occupied); overlay.restore();
    drawTracks(size);
    windows.each("section", drawSectionRoute);
    updateMapScale();
  }
  function geoPath(points, copies = true) {
    const size = map.getSize(), shifts = view.mode === "flat" && copies ? [-360,0,360] : [0];
    for (const shift of shifts) {
      let previous = null;
      for (const point of points) {
        const p = view.project([point[0], point[1] + shift]);
        if (!p || Math.abs(p.x) > size.x * 30 || Math.abs(p.y) > size.y * 30) {previous = null; continue;}
        if (!previous || Math.hypot(p.x-previous.x,p.y-previous.y) > Math.max(size.x,size.y)*.45) overlay.moveTo(p.x,p.y);
        else overlay.lineTo(p.x,p.y);
        previous = p;
      }
    }
  }
  function drawCoastlines(size) {
    const coast=window.ERA5Coastlines;if(!coast)return;
    overlay.save();overlay.beginPath();overlay.rect(0,0,size.x,size.y-79);overlay.clip();
    overlay.lineWidth=.85;overlay.strokeStyle="rgba(25,65,50,.72)";overlay.lineJoin="round";overlay.lineCap="round";overlay.beginPath();
    const bounds = view.mode === "flat" ? map.getBounds() : null;
    for(const line of coast.lines) {
      if (bounds && (line.bounds[3]<bounds.getSouth() || line.bounds[1]>bounds.getNorth())) continue;
      geoPath(line.points.map(([lon,lat])=>[Math.max(-89.999,Math.min(89.999,lat)),lon]));
    }
    overlay.stroke();overlay.restore();
  }
  function mapPill(text, x, y, occupied) {
    const width=overlay.measureText(text).width+14, height=19, size=map.getSize();
    x=Math.max(7,Math.min(size.x-width-7,x-width/2)); y=Math.max(10,Math.min(size.y-100,y));
    if (occupied.some(p=>Math.abs(p.x+p.w/2-x-width/2)<(p.w+width)/2+12 && Math.abs(p.y-y)<25)) return;
    occupied.push({x,y,w:width});overlay.fillStyle="#fbfef9e8";overlay.strokeStyle="#a7c3b680";overlay.lineWidth=.6;
    overlay.beginPath();overlay.roundRect(x,y-height/2,width,height,8);overlay.fill();overlay.stroke();
    overlay.fillStyle="#3d6956";overlay.textAlign="center";overlay.textBaseline="middle";overlay.fillText(text,x+width/2,y+.5);
  }
  function drawGrid(size) {
    const step=view.zoomLevel()>=7?1:view.zoomLevel()>=5?5:view.zoomLevel()>=3?15:30;
    const labels=[],queueLabel=(text,x,y)=>labels.push([text,x,y]);overlay.save();overlay.lineWidth=.65;overlay.strokeStyle="rgba(28,66,52,.23)";overlay.font="10px sans-serif";
    const b = view.mode === "flat" ? map.getBounds() : null;
    const west = b ? b.getWest() : -180, east = b ? b.getEast() : 180;
    const south = b ? Math.max(-85,b.getSouth()) : -80, north = b ? Math.min(85,b.getNorth()) : 80;
    for(let lat=Math.ceil(south/step)*step;lat<=north;lat+=step) {
      const points=[];for(let lon=west;lon<=east+.1;lon+=Math.min(2,step/3))points.push([lat,lon]);
      overlay.beginPath();geoPath(points,false);overlay.stroke();
      if(b) {const p=view.project([lat,west]);if(p&&p.y>240&&p.y<size.y-110)queueLabel(Math.abs(lat)+"°"+(lat<0?"S":lat>0?"N":""),29,p.y);}
      else {const p=view.project([lat,view.centre().lng+35]);if(p&&p.x>30&&p.x<size.x-30&&p.y>230&&p.y<size.y-120)queueLabel(Math.abs(lat)+"°"+(lat<0?"S":lat>0?"N":""),p.x,p.y);}
    }
    for(let lon=Math.ceil(west/step)*step;lon<=east;lon+=step) {
      const points=[];for(let lat=-89.9;lat<=89.91;lat+=1.5)points.push([lat,lon]);
      overlay.beginPath();geoPath(points,false);overlay.stroke();
      const normalized=window.ERA5Projections.wrap(lon),text=Math.abs(normalized)+"°"+(normalized<0?"W":normalized>0?"E":"");
      if(b) {const p=view.project([0,lon]);if(p&&p.x>30&&p.x<size.x-45)queueLabel(text,p.x,size.y-111);}
      else {
        const g=view.geometry();
        const radius=p=>Math.hypot(p.x-g.x,p.y-g.y);
        const candidates=points.map(point=>view.project(point)).filter(p=>p&&p.x>35&&p.x<size.x-35&&p.y>238&&p.y<size.y-115&&radius(p)>g.scale*.55);
        const p=candidates.sort((a,b)=>radius(b)-radius(a))[0]; if(p)queueLabel(text,p.x,p.y);
      }
    }
    overlay.restore();return labels;
  }
  function drawWind(size,g) {
    overlay.save();overlay.strokeStyle="#163b35d9";overlay.fillStyle="#163b35d9";overlay.lineWidth=1.3;
    for(let y=35;y<size.y-82;y+=57) for(let x=28;x<size.x;x+=57) {
      const ll=view.unproject([x,y]); if(!ll)continue; const u=sample(g,"u",ll.lat,ll.lng), v=sample(g,"v",ll.lat,ll.lng);
      const speed=Math.hypot(u,v); if(!Number.isFinite(speed)||speed<.2) continue;
      const vector=view.vector(ll.lat,ll.lng,u,v);if(!vector)continue;
      const length=9+Math.min(15,speed*.25), angle=Math.atan2(vector.y,vector.x);
      overlay.save();overlay.translate(x,y);overlay.rotate(angle);
      overlay.beginPath();overlay.moveTo(-length/2,0);overlay.lineTo(length/2,0);overlay.stroke();
      overlay.beginPath();overlay.moveTo(length/2,0);overlay.lineTo(length/2-4,-2.8);overlay.lineTo(length/2-4,2.8);overlay.closePath();overlay.fill();overlay.restore();
    }
    overlay.restore();
  }
  function drawContours(size,g) {
    const centre=view.centre(),key=[view.key(),state.cacheEpoch,g.record.file,g.record.index,g.variable.id,g.mode,g.value,g.reference,units(),...state.scale,centre.lat,centre.lng,map.getZoom(),size.x,size.y].join("|");
    if(state.contourCache?.key!==key){
      const levels=plots.niceTicks(state.scale[0],state.scale[1],7);
      const lines=plots.contours(size.x,Math.max(1,size.y-79),levels,(x,y)=>{const ll=view.unproject([x,y]);return ll ? convert(sample(g,"values",ll.lat,ll.lng)) : NaN;});
      state.contourCache={key,lines};
    }
    const labels=[];overlay.save();overlay.lineJoin="round";overlay.lineCap="round";overlay.font="10px sans-serif";
    for(const {level,paths} of state.contourCache.lines) {
      overlay.beginPath();
      for(const path of paths){path.forEach((p,i)=>i?overlay.lineTo(...p):overlay.moveTo(...p));}
      overlay.strokeStyle="#ffffffe0";overlay.lineWidth=3;overlay.stroke();overlay.strokeStyle="#203b36a8";overlay.lineWidth=1;overlay.stroke();
      for(const path of paths) {
        let length=0,nextLabel=90;
        for(let i=1;i<path.length;i++) {
          const a=path[i-1],b=path[i];length+=Math.hypot(b[0]-a[0],b[1]-a[1]);
          if(length<nextLabel)continue;nextLabel=length+240;
          const x=(a[0]+b[0])/2,y=(a[1]+b[1])/2;
          if(x<35||x>size.x-35||y<35||y>size.y-110||labels.some(p=>Math.hypot(p[0]-x,p[1]-y)<65))continue;
          const text=plots.tickLabel(level),width=overlay.measureText(text).width;
          let angle=Math.atan2(b[1]-a[1],b[0]-a[0]);if(angle>Math.PI/2)angle-=Math.PI;if(angle<-Math.PI/2)angle+=Math.PI;
          overlay.save();overlay.translate(x,y);overlay.rotate(angle);overlay.fillStyle="#ffffffe6";overlay.beginPath();overlay.roundRect(-width/2-4,-8,width+8,16,5);overlay.fill();overlay.fillStyle="#193d34";overlay.textAlign="center";overlay.textBaseline="middle";overlay.fillText(text,0,0);overlay.restore();labels.push([x,y]);
        }
      }
    }
    overlay.restore();
  }
  function drawTracks(size) {
    overlay.save();overlay.lineJoin="round";overlay.lineCap="round";
    for(const track of state.tracks) {
      let previous=view.centre().lng;
      const points=track.result.path.map(p=>{const lon=p.longitude+360*Math.round((previous-p.longitude)/360);previous=lon;return [p.latitude,lon];});
      overlay.beginPath();geoPath(points);overlay.globalAlpha=track.id===state.activeTrack?1:.8;
      overlay.strokeStyle="#ffffffee";overlay.lineWidth=5;overlay.stroke();overlay.strokeStyle=track.colour;overlay.lineWidth=3;overlay.stroke();
      const a=view.project(points[0]);if(a) {overlay.beginPath();overlay.arc(a.x,a.y,4,0,Math.PI*2);overlay.fillStyle=track.colour;overlay.fill();overlay.font="bold 10px sans-serif";overlay.strokeStyle="white";overlay.lineWidth=3;overlay.strokeText("T"+track.id,a.x+7,a.y-7);overlay.fillText("T"+track.id,a.x+7,a.y-7);}
    }
    windows.each("point", win=>{if(!state.selected)return;const p=view.project([state.selected.lat,state.selected.lon]);if(!p)return;
      overlay.globalAlpha=1;overlay.beginPath();overlay.arc(p.x,p.y,5,0,Math.PI*2);overlay.fillStyle="white";overlay.fill();overlay.strokeStyle="#087f75";overlay.lineWidth=2;overlay.stroke();
      overlay.font="bold 10px sans-serif";overlay.fillStyle="#1f5e4b";overlay.fillText("P"+win.id,p.x+9,p.y-7);
    });
    overlay.restore();
  }
  function captureMap(includeTiles=true) {
    if(!state.grid)throw new Error("Load a map before exporting.");draw();
    const size=map.getSize(),w=size.x,h=Math.max(1,size.y-79),head=64,foot=112,scale=2;
    const canvas=document.createElement("canvas");canvas.width=Math.round(w*scale);canvas.height=Math.round((h+head+foot)*scale);
    const c=canvas.getContext("2d");c.scale(scale,scale);c.fillStyle="white";c.fillRect(0,0,w,h+head+foot);
    c.save();c.beginPath();c.rect(0,head,w,h);c.clip();c.fillStyle="#e3ece8";c.fillRect(0,head,w,h);
    let tiles=0;
    if(includeTiles&&map.hasLayer(basemap)){
      const bounds=$("map").getBoundingClientRect();
      for(const entry of Object.values(basemap._tiles||{})) {
        const image=entry.el;if(!entry.current||!image.complete||!image.naturalWidth)continue;
        const b=image.getBoundingClientRect();try{c.drawImage(image,b.left-bounds.left,head+b.top-bounds.top,b.width,b.height);tiles++;}catch(_){}
      }
    }
    for(const layer of [fieldCanvas,...($("animated-wind").checked?[$("wind-canvas")]:[]),overlayCanvas])c.drawImage(layer,0,0,layer.width,h/size.y*layer.height,0,head,w,h);
    c.restore();
    c.fillStyle="#183033";c.font="bold 19px sans-serif";c.fillText("ERA5 · "+(NAMES[state.variable]||fieldMeta().name)+" · "+units(),14,25,w-28);
    c.font="12px sans-serif";c.fillText(state.grid.record.datetime.replace("T"," ").replace("Z"," UTC")+" · "+layerLabel()+" · "+resolutionLabel(state.grid.record),14,47,w-28);
    const left=24,width=Math.max(50,Math.min(520,w-48)),barY=head+h+24,gradient=c.createLinearGradient(left,0,left+width,0),colours=palette();
    colours.forEach((rgb,i)=>gradient.addColorStop(i/(colours.length-1),"rgb("+rgb.join(",")+")"));c.fillStyle=gradient;c.fillRect(left,barY,width,13);
    const [lo,hi]=state.scale,ticks=[lo,...plots.niceTicks(lo,hi,5).filter(v=>v>lo&&v<hi),hi];
    c.fillStyle="#304f43";c.font="11px sans-serif";
    for(const v of ticks){const x=left+(v-lo)/(hi-lo)*width;c.textAlign=v===lo?"left":v===hi?"right":"center";c.fillText(plots.tickLabel(v),x,barY+29);}
    c.textAlign="left";c.font="11px sans-serif";c.fillText($("legend-title").textContent+" ("+units()+") · "+$("range-mode").selectedOptions[0].textContent,left,barY+49,w-48);
    c.font="10px sans-serif";c.fillStyle="#607367";
    const notes=[{flat:"Web Mercator",north:"North polar stereographic",south:"South polar stereographic",globe:"Orthographic globe"}[view.mode]];if(state.mode==="height")notes.push("Geopotential height"+(current().fields.some(f=>f.id==="q")?"":" · dry air approximation (q absent)"));if(state.tracks.length)notes.push(state.tracks.length+" horizontal wind track"+(state.tracks.length===1?"":"s"));if($("coastline-toggle").checked||view.mode!=="flat")notes.push("Coastlines: Natural Earth");if(tiles)notes.push("© OpenStreetMap contributors");
    c.fillText(notes.join(" · "),left,barY+69,w-48);
    return canvas;
  }
  async function captureProfile() {
    const plot=state.profilePlot,profile=state.profile;if(!plot||!profile)throw new Error("Select a point and load its profile first.");
    const profileNote = $("profile-note").textContent;
    const svg=plot.svg.replace('<svg ', '<svg width="900" height="650" '),image=new Image();
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error("Could not render the profile PNG."));image.src="data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg)));});
    const canvas=document.createElement("canvas");canvas.width=900;canvas.height=760;const c=canvas.getContext("2d");c.fillStyle="white";c.fillRect(0,0,900,760);
    c.font="bold 22px sans-serif";c.fillStyle="#183033";c.fillText("ERA5 · "+(NAMES[$("profile-variable").value]||$("profile-variable").value)+" profile",24,29);
    c.font="14px sans-serif";c.fillText(profile.record.datetime.replace("T"," ").replace("Z"," UTC")+" · "+coordinateLabel(profile.latitude,profile.longitude),24,55);
    c.drawImage(image,0,75,900,650);c.font="12px sans-serif";c.fillStyle="#607367";c.fillText(profileNote,24,749,852);return canvas;
  }
  async function saveCanvas(canvas,name) {
    const blob=await new Promise((resolve,reject)=>{try{canvas.toBlob(b=>b?resolve(b):reject(new Error("Could not encode PNG.")),"image/png");}catch(error){reject(error);}});
    const object=URL.createObjectURL(blob),a=document.createElement("a");a.href=object;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(object),5000);
  }
  async function exportMapPNG() {
    stopPlay();
    try{let canvas=captureMap();try{await saveCanvas(canvas,"era5-map.png");}catch(error){if(error.name!=="SecurityError")throw error;await saveCanvas(captureMap(false),"era5-map.png");notice("Map PNG exported; the basemap could not be included.");}}
    catch(error){notice(error.message,true);}
  }
  async function exportProfilePNG() {
    try{await saveCanvas(await captureProfile(),"era5-profile.png");}catch(error){notice(error.message,true);}
  }

  function selectPoint(ll) {
    stopPlay();
    const win = windows.create("point");
    state.selected={lat:ll.lat,lon:ll.lng}; state.profile=null; state.profileView=null; state.profilePlot=null; $("profile-png").disabled=true;
    showPointPanel(); windows.refresh = true; updateWindowMenus(); scheduleDraw();
    updateCoordinates();
    $("point-status").textContent=state.grid?"Reading selected point…":"Load a layer to inspect this point.";
    $("point-metrics").replaceChildren();$("profile-chart").replaceChildren();
    $("profile-export").classList.add("disabled");
    if(state.grid) loadPoint();
  }
  function narrowMap() { return window.innerWidth <= 900; }
  function updatePanels() {
    if(!windows)return;
    const active=windows.active.section;
    for(const win of windows.items.section)if(win!==active)win.data.sectionEditing=false;
    const editing=!!active?.data.sectionEditing;
    $("section-tool").setAttribute("aria-pressed",String(editing));
    $("map").classList.toggle("section-editing",editing);$("projected-map").classList.toggle("section-editing",editing);
    const point=windows.items.point.some(w=>!w.panel.hidden),section=windows.items.section.some(w=>!w.panel.hidden);
    $("colour-legend").classList.toggle("panel-visible",point);
    $("colour-legend").classList.toggle("section-visible",section);
    $("map").parentElement.classList.toggle("both-plots",point&&section);
    updateWindowMenus();
  }
  function showPointPanel() {
    const win=windows.current("point");if(win)windows.focus(win);
    updatePanels();
  }
  function pointRequest(request = args()) {
    if (!state.selected) return null;
    const {winds, ...params} = request;
    return {...params, lat: state.selected.lat, lon: state.selected.lon};
  }
  async function loadPoint() {
    if (!state.selected || !state.grid) return;
    state.pointAbort?.abort();
    const controller = new AbortController();
    state.pointAbort = controller;
    const serial = state.serial, selected = state.selected, win = windows.current("point");
    $("point-status").textContent = "Reading selected point…";
    $("profile-export").classList.add("disabled");
    $("profile-png").disabled = true;
    const result = await chartResult("profile", pointRequest(), controller.signal);
    if (!controller.signal.aborted && serial === state.serial && !win.closed) windows.with("point",win,()=>{if(selected===state.selected)showPointFrame(result);});
  }
  function showPointFrame({data, request, error}) {
    if (error) {
      $("point-status").textContent = error.message + (state.profile ? " Showing " + clock(state.profile.record) + " UTC." : "");
      return;
    }
    state.profile = data;
    state.profileRequest = request;
    $("point-status").textContent = "";
    renderMetrics();
    renderProfile();
    $("profile-export").href = url("/api/export/profile", request);
    $("profile-export").classList.remove("disabled");
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
    const time = state.profile.record.datetime.slice(0, 10) + " · " + clock(state.profile.record) + " UTC";
    $("point-context").textContent = time + " · " + layerLabel(state.profileRequest) + " · bilinear grid sample";
    if(selected.wind_from_deg!=null) $("point-context").textContent+=" · wind from "+format(selected.wind_from_deg,0)+"°";
  }
  function lockProfileAxes(plot) {
    const win=windows.current("point");
    if(plot&&state.playing&&win?.playView?.key!==plot.key)win.playView={key:plot.key,x:plot.x,y:plot.y};
  }
  function renderProfile() {
    if (!state.profile) return;
    const variable = $("profile-variable").value, p = state.profile.profiles;
    const {reference, mode, value} = state.profileRequest;
    $("profile-axis").options[0].disabled = !p.height_agl_m;
    $("profile-axis").options[1].disabled = !p.pressure_hpa;
    const plot = plots.profile(state.profile, {
      variable, axis: $("profile-axis").value, reference,
      convert: v => convert(v, variable), unit: units(variable), name: NAMES[variable] || variable,
      view: state.profileView, fallbackView: windows.current("point")?.playView, selected: {mode, value}
    });
    lockProfileAxes(plot);
    if(plot)plot.svg=plot.svg.replaceAll("profile-clip","profile-clip-"+windows.current("point").id);
    state.profilePlot=plot;$("profile-png").disabled=!plot;
    if(!plot){$("profile-chart").textContent="No valid vertical profile at this location.";return;}
    $("profile-axis").value=plot.axis;$("profile-chart").innerHTML=plot.svg;
    $("profile-note").textContent = p.height_agl_m
      ? (state.profile.record.fields.some(f => f.id === "q") ? "Hydrostatic geopotential height." :
        "Height uses dry air approximation (q absent). Geopotential metres " + (reference === "msl" ? "above sea level." : "above ground."))
      : "Pressure or model-level coordinate; height is unavailable.";
    const win=windows.current("point");
    bindPlotZoom($("profile-chart"), plot, $("profile-zoom-axis"), (x,y)=>windows.with("point",win,()=>setProfileView(x,y)), ()=>windows.with("point",win,resetProfileZoom));
    syncBounds("profile",plot);
  }
  function setProfileView(x,y) {
    const plot=state.profilePlot;if(!plot||x[1]-x[0]<1e-8||y[1]-y[0]<1e-8)return;
    state.profileView={key:plot.key,x,y};renderProfile();
  }
  function resetProfileZoom() {
    stopPlay();
    state.profileView = null;
    $("profile-bounds-status").textContent="";
    renderProfile();
  }
  function bindPlotZoom(chart, plot, zoomAxis, setView, reset) {
    const svg = chart.querySelector("svg");
    let start=null,rect=null;
    const local=e=>{const b=svg.getBoundingClientRect();return {x:(e.clientX-b.left)*plot.width/b.width,y:(e.clientY-b.top)*plot.height/b.height};};
    const inside=p=>p.x>=plot.left&&p.x<=plot.right&&p.y>=plot.top&&p.y<=plot.bottom;
    const clamp=p=>({x:Math.max(plot.left,Math.min(plot.right,p.x)),y:Math.max(plot.top,Math.min(plot.bottom,p.y))});
    svg.onpointerdown=e=>{
      const p=local(e);if(!inside(p)||e.button!==0)return;e.preventDefault();if(state.playing)stopPlay();start=p;svg.setPointerCapture?.(e.pointerId);
      rect=document.createElementNS("http://www.w3.org/2000/svg","rect");rect.setAttribute("class","profile-selection");svg.append(rect);
    };
    svg.onpointermove=e=>{if(!start)return;const p=clamp(local(e));rect.setAttribute("x",Math.min(start.x,p.x));rect.setAttribute("y",Math.min(start.y,p.y));rect.setAttribute("width",Math.abs(start.x-p.x));rect.setAttribute("height",Math.abs(start.y-p.y));};
    svg.onpointerup=e=>{
      if(!start)return;const a=start,b=clamp(local(e)),mode=zoomAxis.value;start=null;rect?.remove();
      const useX=mode!=="vertical"&&Math.abs(a.x-b.x)>=6,useY=mode!=="horizontal"&&Math.abs(a.y-b.y)>=6;
      if(useX||useY)setView(useX?[plot.inverseX(Math.min(a.x,b.x)),plot.inverseX(Math.max(a.x,b.x))]:plot.x,useY?[plot.inverseY(Math.max(a.y,b.y)),plot.inverseY(Math.min(a.y,b.y))]:plot.y);
    };
    svg.onpointercancel=()=>{start=null;rect?.remove();};
    svg.addEventListener("wheel",e=>{
      const p=local(e);if(!inside(p))return;e.preventDefault();
      const factor=e.deltaY>0?1.25:.8,mode=zoomAxis.value,cx=plot.inverseX(p.x),cy=plot.inverseY(p.y);
      const zoom=(d,c)=>d.map(v=>c+(v-c)*factor);
      setView(mode==="vertical"?plot.x:zoom(plot.x,cx),mode==="horizontal"?plot.y:zoom(plot.y,cy));
    },{passive:false});
    svg.onkeydown=e=>{if(e.key==="Escape"||e.key==="0")reset();};
  }
  function sectionAxisFor(record) {
    const available = {
      height_msl: record?.msl_available,
      height_agl: record?.height_available,
      pressure: record?.pressure_available
    };
    return Object.keys(available).filter(axis => available[axis]);
  }
  function configureSectionAxis(record) {
    const input = $("section-axis"), axes = sectionAxisFor(record);
    for (const option of input.options) option.disabled = !axes.includes(option.value);
    input.value = axes.includes(state.sectionAxis) ? state.sectionAxis : axes[0] || "";
    input.disabled = !axes.length;
  }
  function sectionRequest(record = current(), {variable} = args()) {
    if (state.waypoints.length < 2) return null;
    const axes = sectionAxisFor(record);
    const axis = axes.includes(state.sectionAxis) ? state.sectionAxis : axes[0];
    if (!axis) return null;
    return {file: record.file, index: record.index, variable, axis, points: JSON.stringify(state.waypoints)};
  }
  function showSectionPanel() {
    const win=windows.current("section")||windows.create("section");
    windows.focus(win); updatePanels(); updateSectionControls();
  }
  function setSectionEditing(editing) {
    if (editing && !windows.current("section")) windows.create("section");
    windows.each("section", w=>{w.data.sectionEditing=false;});
    state.sectionEditing=editing;
    $("section-tool").setAttribute("aria-pressed",String(editing));
    $("map").classList.toggle("section-editing",editing);$("projected-map").classList.toggle("section-editing",editing);
    if(windows.current("section"))updateSectionControls();
  }
  function closeSectionPanel() {
    const win=windows.current("section");if(win){setSectionEditing(false);windows.minimise(win);}updatePanels();
  }
  function updateSectionControls() {
    const count = state.waypoints.length;
    const distance = state.section?.distance_km.at(-1);
    const route = count ? count + (count === 1 ? " waypoint" : " waypoints") +
      (distance == null ? "" : " · " + format(distance, 1) + " km") + ". " : "";
    const help = count === 26 ? "Waypoint limit reached." : state.sectionEditing
      ? "Click the map to add a waypoint." : "Ctrl-click the map to add a waypoint.";
    $("section-summary").textContent = route + help;
    $("section-content").hidden = count < 2;
    $("section-undo").disabled = $("section-clear").disabled = !count;
    updateWindowMenus();
  }
  function clearSectionFrame() {
    state.section = null;
    state.sectionPlot = null;
    $("section-axes").replaceChildren();
    $("section-raster").getContext("2d").clearRect(0, 0, 540, 286);
    $("section-legend").hidden = true;
    $("section-reset").disabled = true;
    $("section-context").textContent = $("section-note").textContent = $("section-status").textContent = "";
    updateSectionControls();
  }
  function changeRoute(points) {
    stopPlay();
    state.sectionAbort?.abort();
    state.waypoints = points;
    state.sectionView = null;
    clearSectionFrame();
    scheduleDraw();
    if (points.length >= 2) loadSection();
  }
  function addWaypoint({lat, lng}) {
    showSectionPanel();
    const points = state.waypoints;
    if (points.length >= 26) return;
    const lon = ((lng + 180) % 360 + 360) % 360 - 180;
    const next = [Number(lat.toFixed(6)), Number(lon.toFixed(6))];
    if (points.at(-1)?.every((value, i) => value === next[i])) {
      $("section-status").textContent = "Choose a different location for the next waypoint.";
      return;
    }
    changeRoute([...points, next]);
  }
  function drawSectionRoute() {
    const points=state.section?.path||state.waypoints;if(!points.length)return;
    const win=windows.current("section"),waypoints=state.section?.waypoints||state.waypoints.map((_,i)=>i);
    let previous=view.centre().lng;
    const route=points.map(([lat,lon])=>{previous=lon+360*Math.round((previous-lon)/360);return [lat,previous];});
    overlay.save();overlay.lineJoin="round";overlay.lineCap="round";overlay.font="bold 11px sans-serif";overlay.textAlign="center";overlay.textBaseline="middle";
    overlay.beginPath();geoPath(route);overlay.strokeStyle="white";overlay.lineWidth=5;overlay.stroke();overlay.strokeStyle="#25524c";overlay.lineWidth=2.5;overlay.stroke();
    for(const shift of (view.mode==="flat"?[-360,0,360]:[0]))waypoints.forEach((index,i)=>{
      const p=view.project([route[index][0],route[index][1]+shift]);if(!p)return;const {x,y}=p;
      overlay.beginPath();overlay.arc(x,y,10,0,2*Math.PI);overlay.fillStyle="#25524c";overlay.fill();overlay.strokeStyle="white";overlay.lineWidth=2;overlay.stroke();overlay.fillStyle="white";overlay.fillText(String.fromCharCode(65+i),x,y+.5);
      if(i===0){overlay.fillStyle="#25524c";overlay.fillText("C"+win.id,x,y-17);}
    });overlay.restore();
  }
  async function loadSection() {
    state.sectionAbort?.abort();
    if (!state.grid) return;
    const request = sectionRequest();
    if (!request) {
      $("section-status").textContent = "This record lacks the vertical coordinates needed for a cross-section.";
      return;
    }
    const controller = new AbortController(), serial = state.serial, win=windows.current("section");
    state.sectionAbort = controller;
    $("section-status").textContent = "Reading cross-section…";
    const result = await chartResult("cross-section", request, controller.signal);
    if (!controller.signal.aborted && serial === state.serial && !win.closed) windows.with("section",win,()=>showSectionFrame(result));
  }
  function showSectionFrame({data, error}) {
    if (error) {
      $("section-status").textContent = error.message + (state.section ? " Showing " + clock(state.section.record) + " UTC." : "");
      return;
    }
    state.section = data;
    $("section-status").textContent = "";
    updateSectionControls();
    renderSection();
    scheduleDraw();
  }
  function lockSectionAxes(plot) {
    const win=windows.current("section");
    if(plot?.valid&&state.playing&&win?.playView?.key!==plot.key)win.playView={key:plot.key,x:plot.x,y:plot.y,range:plot.range};
  }
  function renderSection() {
    const data = state.section;
    if (!data) return;
    const variable = data.variable.id, name = NAMES[variable] || data.variable.name;
    const unit = variable === "t" ? units(variable) : data.variable.units;
    const offset = convert(0, variable);
    const key = [data.axis, variable, unit].join("|");
    const held=windows.current("section")?.playView, locked=held?.key===key?held:null;
    const plot = plots.crossSection(data, {
      canvas: $("section-raster"), colours: lut(variable), name,
      symmetric: ["u", "v"].includes(variable), convert: raw => raw + offset,
      view: state.sectionView?.axis === data.axis ? state.sectionView : locked, range: locked?.range
    });
    plot.key = key; plot.svg=plot.svg.replaceAll("section-clip","section-clip-"+windows.current("section").id);
    state.sectionPlot = plot;
    lockSectionAxes(plot);
    $("section-axes").innerHTML = plot.svg;
    $("section-reset").disabled = false;
    $("section-context").textContent = data.record.datetime.slice(0, 10) + " · " + clock(data.record) + " UTC · " + name;
    $("section-legend").hidden = !plot.valid;
    $("section-low").textContent = plots.tickLabel(plot.range[0]);
    $("section-high").textContent = plots.tickLabel(plot.range[1]) + (unit ? " " + unit : "");
    $("section-gradient").style.background = "linear-gradient(90deg," + palette(variable).map(c => "rgb(" + c.join(",") + ")").join(",") + ")";
    const dry = data.axis !== "pressure" && !data.record.fields.some(f => f.id === "q");
    $("section-note").textContent = !plot.valid ? "No represented data along this route." :
      (dry ? "Dry-air height (q absent). " : "") +
      (data.axis === "pressure" ? "Brown line shows surface pressure." : "Brown line marks the ground.");
    const win=windows.current("section");
    bindPlotZoom($("section-axes"),plot,$("section-zoom-axis"),(x,y)=>windows.with("section",win,()=>setSectionView(x,y)),()=>windows.with("section",win,resetSectionZoom));
    syncBounds("section",plot);
  }
  function setSectionView(x, y) {
    if (x[1] - x[0] < 1e-8 || y[1] - y[0] < 1e-8) return;
    state.sectionView = {axis: state.section.axis, x, y};
    renderSection();
  }
  function resetSectionZoom() {
    stopPlay();
    state.sectionView = null;
    $("section-bounds-status").textContent="";
    renderSection();
  }
  const TRACK_COLOURS=["#123e35","#ac3b34","#3c5599","#814892","#a66916","#247c87"];
  function renderTracks() {windows.each("point",renderPointTracks);}
  function renderPointTracks() {
    const active=state.tracks.find(t=>t.id===state.activeTrack);state.drift=active?.result||null;
    $("track-list").replaceChildren(...state.tracks.map(t=>{
      const b=document.createElement("button");b.textContent="Track "+t.id+" · "+t.label;b.style.setProperty("--track-color",t.colour);b.classList.toggle("active",t.id===state.activeTrack);
      b.onclick=()=>{state.activeTrack=t.id;renderTracks();scheduleDraw();};return b;
    }));
    $("drift-status").textContent=active?format(active.result.drift_km,1)+" km from start · "+active.result.hours+" h · "+active.layer+". Horizontal wind only.":"";
    $("drift-export").hidden=!active;$("drift-clear").hidden=!active;$("drift-clear-all").hidden=!state.tracks.length;
    $("drift-run").disabled=state.tracing||!current()?.fields.some(f=>f.id==="u")||!current()?.fields.some(f=>f.id==="v");
  }
  async function runDrift() {
    if(!state.selected||!state.grid||state.tracing)return;
    const win=windows.current("point");
    const serial=++state.driftSerial,request=args({lat:state.selected.lat,lon:state.selected.lon,hours:$("drift-hours").value}),layer=layerLabel(),datetime=current().datetime;
    state.tracing=true;$("drift-run").disabled=true;$("drift-status").textContent="Tracing through daily ERA5 files…";
    try {
      const result=await api("/api/drift",request);if(serial!==state.driftSerial)return;
      const id=++state.trackId,track={id,result,layer,colour:TRACK_COLOURS[(id-1)%TRACK_COLOURS.length],label:datetime.slice(0,16).replace("T"," ")+" UTC · "+result.hours+" h · "+layer};
      state.tracks.push(track);state.activeTrack=id;state.tracing=false;renderTracks();scheduleDraw();
    } catch(error){if(serial===state.driftSerial&&!win.closed)windows.with("point",win,()=>{$("drift-status").textContent=error.message;});}
    finally{if(serial===state.driftSerial){state.tracing=false;renderTracks();}}
  }
  function downloadText(name,text,type="text/csv;charset=utf-8") {
    const object=URL.createObjectURL(new Blob([text],{type})),a=document.createElement("a");
    a.href=object;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(object),5000);
  }
  function hover(event) {
    if(!state.grid)return;
    const ll=event.latlng, raw=sample(state.grid,"values",ll.lat,ll.lng);
    if(!Number.isFinite(raw)) {$("hover-readout").hidden=true;return;}
    const el=$("hover-readout"),size=map.getSize();
    el.textContent=format(convert(raw))+" "+units()+"\n"+coordinateLabel(ll.lat,ll.lng,2);
    el.hidden=false;el.style.left=Math.min(event.containerPoint.x+15,size.x-170)+"px";el.style.top=Math.min(event.containerPoint.y+15,size.y-135)+"px";
  }
  function projectionChanged() {
    const projected=view.mode!=="flat";
    state.projection=view.mode; $("hover-readout").hidden=true;
    $("map").parentElement.classList.toggle("projected-mode",projected);
    document.querySelectorAll("[data-projection]").forEach(b=>{
      const active=b.dataset.projection===view.mode;b.classList.toggle("active",active);b.setAttribute("aria-pressed",String(active));
    });
    if(projected)map.removeLayer(basemap);
    else if($("basemap-toggle").checked&&!map.hasLayer(basemap))basemap.addTo(map);
    $("basemap-toggle").disabled=projected;
    $("projection-note").hidden=!projected;
    $("projection-note").textContent=view.mode==="globe"?"Drag to rotate · scroll to zoom · offline coastlines":"Polar stereographic · drag to pan · offline coastlines";
    wind.reset();state.contourCache=null;scheduleDraw();
  }
  function updateMapScale() {
    const size=map.getSize(),g=view.mode==="flat"?null:view.geometry();
    let a=view.unproject([size.x-210,size.y-140]),b=view.unproject([size.x-110,size.y-140]);
    if(!a||!b){a=view.unproject([g.x-50,g.y]);b=view.unproject([g.x+50,g.y]);}
    if(!a||!b){$("map-scale").hidden=true;return;}
    const rad=Math.PI/180,dp=(b.lat-a.lat)*rad,dl=(b.lng-a.lng)*rad;
    const h=Math.sin(dp/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dl/2)**2;
    const km=12742*Math.asin(Math.min(1,Math.sqrt(h)));
    if(!Number.isFinite(km)||km<=0){$("map-scale").hidden=true;return;}
    const magnitude=10**Math.floor(Math.log10(km)),nice=[5,2,1].map(v=>v*magnitude).find(v=>v<=km)||magnitude/2;
    $("map-scale").hidden=false;$("map-scale-label").textContent=(view.mode==="flat"?"":"≈ ")+(nice>=1?plots.tickLabel(nice)+" km":plots.tickLabel(nice*1000)+" m");
    $("map-scale-bar").style.width=Math.round(100*nice/km)+"px";
    $("map-scale").title="Approximate ground distance at "+coordinateLabel(a.lat,a.lng,1);
  }
  function syncBounds(prefix,plot) {
    const axis=prefix==="profile"?plot.axis:state.section.axis;
    const pressure=axis==="pressure",model=axis==="model",unit=pressure?"hPa":model?"level":"km";
    const physical=v=>pressure?10**(-v):model?-v:v;
    $(prefix+"-bottom-label").textContent="Bottom ("+unit+")";$(prefix+"-top-label").textContent="Top ("+unit+")";
    $(prefix+"-bottom").value=Number(physical(plot.y[0]).toPrecision(7));
    $(prefix+"-top").value=Number(physical(plot.y[1]).toPrecision(7));
    for(const side of ["bottom","top"]){const input=$(prefix+"-"+side);if(pressure||model)input.min=pressure?"0.000001":"1";else input.removeAttribute("min");}
  }
  function applyBounds(prefix) {
    const plot=prefix==="profile"?state.profilePlot:state.sectionPlot;if(!plot)return;
    const axis=prefix==="profile"?plot.axis:state.section.axis;
    const bottom=Number($(prefix+"-bottom").value),top=Number($(prefix+"-top").value);
    const reversed=axis==="pressure"||axis==="model";
    const valid=[bottom,top].every(Number.isFinite)&&(!reversed||bottom>0&&top>0)&&(reversed?bottom>top:top>bottom);
    const status=$(prefix+"-bounds-status");
    if(!valid){status.textContent=reversed?"Use positive bounds with bottom greater than top (for example 300 and 100 hPa).":"Top must be greater than bottom.";return;}
    status.textContent="";stopPlay();
    const transform=v=>axis==="pressure"?-Math.log10(v):axis==="model"?-v:v;
    const y=[transform(bottom),transform(top)];
    if(prefix==="profile")setProfileView(plot.x,y);else setSectionView(plot.x,y);
  }
  function updateWindowMenus() {
    if(!windows)return;
    for(const kind of ["point","section"]){
      $(kind+"-count").textContent=windows.items[kind].length;
      $(kind+"-window-list").replaceChildren(...windows.items[kind].map(win=>{
        const row=document.createElement("div");row.className="window-list-row";
        const open=document.createElement("button"),title=document.createElement("span"),detail=document.createElement("small");
        const selected=win.data.selected,points=win.data.waypoints;
        title.textContent=kind==="point"?"P"+win.id+" · "+(selected?coordinateLabel(selected.lat,selected.lon,2):"Choose a point"):"C"+win.id+" · "+(points.length?points.length+" waypoints":"New cross-section");
        detail.textContent=win.minimised?"Minimised · click to reopen":"Open · click to focus";
        open.append(title,detail);open.onclick=()=>{
          if(kind==="section")setSectionEditing(false);windows.focus(win);hideWindowMenus();updatePanels();
        };
        const close=document.createElement("button");close.className="icon-button";close.textContent="×";close.setAttribute("aria-label","Close "+(kind==="point"?"point P":"cross-section C")+win.id);close.onclick=()=>windows.close(win);
        row.append(open,close);return row;
      }));
    }
  }
  function hideWindowMenus() {
    for(const kind of ["point","section"]){$(kind+"-menu").hidden=true;$(kind+"-menu-toggle").setAttribute("aria-expanded","false");}
  }
  function toggleWindowMenu(kind) {
    const menu=$(kind+"-menu"),open=menu.hidden;hideWindowMenus();if(!open)return;
    menu.hidden=false;$(kind+"-menu-toggle").setAttribute("aria-expanded","true");
    const anchor=$(kind+"-menu-toggle").getBoundingClientRect(),area=$("map").parentElement.getBoundingClientRect();
    const width=Math.min(285,area.width-20);
    Object.assign(menu.style,{position:"fixed",width:width+"px",left:Math.max(area.left+10,Math.min(anchor.right-width,area.right-width-10))+"px",top:(anchor.bottom+7)+"px"});
  }
  function bindWindow(win) {
    const kind=win.kind;
    const on=(id,event,fn)=>{$(id)[event]=e=>windows.with(kind,win,()=>fn(e));};
    on(kind+"-minimise","onclick",()=>{if(kind==="section"&&win.data.sectionEditing)setSectionEditing(false);windows.minimise(win);updatePanels();});
    on(kind+"-close","onclick",()=>windows.close(win));
    if(kind==="point"){
      win.panel.querySelector(".eyebrow").textContent="SELECTED LOCATION · P"+win.id;
      const fields=current()?.fields||[];
      for(const option of $("profile-variable").options)option.disabled=!fields.some(f=>f.id===option.value);
      if($("profile-variable").selectedOptions[0]?.disabled)$("profile-variable").value=Array.from($("profile-variable").options).find(o=>!o.disabled)?.value||"t";
      on("coordinate-toggle","onclick",()=>{state.compassCoordinates=!state.compassCoordinates;remember("compassCoordinates",state.compassCoordinates?"1":"0");windows.each("point",updateCoordinates);updateWindowMenus();});
      for(const id of ["profile-variable","profile-axis"])on(id,"onchange",resetProfileZoom);
      on("profile-reset","onclick",resetProfileZoom);
      on("profile-bounds","onsubmit",e=>{e.preventDefault();applyBounds("profile");});
      on("profile-png","onclick",exportProfilePNG);on("drift-run","onclick",runDrift);
      on("drift-clear","onclick",()=>clearDrift());on("drift-clear-all","onclick",()=>clearDrift(true));
      on("drift-export","onclick",()=>{
        if(!state.drift)return;
        downloadText("era5-wind-drift.csv","datetime_utc,latitude,longitude,elapsed_seconds,mode,level_value,height_reference\n"+
          state.drift.path.map(p=>[p.datetime,p.latitude,p.longitude,p.elapsed_seconds,state.drift.mode,state.drift.value,state.drift.reference].join(",")).join("\n")+"\n");
      });
      renderPointTracks();
    }else{
      win.panel.querySelector("h2").textContent="Vertical cross-section · C"+win.id;
      configureSectionAxis(current());
      on("section-undo","onclick",()=>changeRoute(state.waypoints.slice(0,-1)));
      on("section-clear","onclick",()=>changeRoute([]));
      on("section-axis","onchange",()=>{state.sectionAxis=$("section-axis").value;changeRoute(state.waypoints);});
      on("section-reset","onclick",resetSectionZoom);
      on("section-bounds","onsubmit",e=>{e.preventDefault();applyBounds("section");});
      updateSectionControls();
    }
  }
  function initialiseWindows() {
    const fields={point:["selected","profile","profileView","profilePlot","profileRequest","pointAbort"],
      section:["waypoints","sectionEditing","section","sectionPlot","sectionView","sectionAxis","sectionAbort"]};
    const defaults={};for(const kind of Object.keys(fields))defaults[kind]=Object.fromEntries(fields[kind].map(key=>[key,state[key]]));
    windows=new window.ERA5Windows($("map").parentElement,defaults,bindWindow,()=>{updatePanels();scheduleDraw();},win=>{
      if(win.kind==="point")state.pointAbort?.abort();else{state.sectionAbort?.abort();if(win.data.sectionEditing)setSectionEditing(false);}
    });
    Object.defineProperties(state,{pointWindows:{get:()=>windows.items.point},sectionWindows:{get:()=>windows.items.section}});
    for(const kind of Object.keys(fields))for(const key of fields[kind])Object.defineProperty(state,key,{
      get(){const win=windows.current(kind);return win?win.data[key]:defaults[kind][key];},
      set(value){const win=windows.current(kind);(win?win.data:defaults[kind])[key]=value;},configurable:true
    });
    for(const kind of ["point","section"]){
      $(kind+"-menu-toggle").onclick=()=>toggleWindowMenu(kind);
    }
    $("section-new").onclick=()=>{stopPlay();windows.create("section");setSectionEditing(true);hideWindowMenus();};
    $("section-tool").onclick=()=>{
      if(state.sectionEditing)setSectionEditing(false);
      else {showSectionPanel();setSectionEditing(true);}hideWindowMenus();
    };
    $("point-open").onclick=()=>{if(windows.active.point)showPointPanel();else notice("Click the map to open a selected point profile.");hideWindowMenus();};
    $("point-new").onclick=()=>{setSectionEditing(false);notice("Click the map to open another selected point profile.");hideWindowMenus();};
    document.addEventListener("pointerdown",e=>{if(!e.target.closest(".plot-tool"))hideWindowMenus();});
    document.addEventListener("keydown",e=>{if(e.key==="Escape")hideWindowMenus();});
    document.querySelectorAll("[data-projection]").forEach(b=>b.onclick=()=>view.setMode(b.dataset.projection));
    $("map-zoom-in").onclick=()=>view.zoom(1);$("map-zoom-out").onclick=()=>view.zoom(-1);
  }
  initialiseWindows();
  map.on("move zoom resize",()=>{wind.reset();scheduleDraw();});map.on("click", e => {
    if (state.sectionEditing || e.originalEvent?.ctrlKey || e.originalEvent?.metaKey) addWaypoint(e.latlng);
    else selectPoint(e.latlng);
  });map.on("mousemove",hover);
  map.on("mouseout movestart zoomstart",()=>{$("hover-readout").hidden=true;});
  new ResizeObserver(()=>{map.invalidateSize();resize();}).observe($("map"));
  window.addEventListener("resize", () => {
    windows.clampAll(); resize();
  });
  $("variable").onchange=()=>{stopPlay();state.variable=$("variable").value;debounceSlice();};
  document.querySelectorAll("[data-field]").forEach(b=>b.onclick=()=>{if(!b.disabled){$("variable").value=b.dataset.field;$("variable").dispatchEvent(new Event("change"));}});
  document.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>{if(!b.disabled)chooseMode(b.dataset.mode);});
  $("level").oninput = e => setLevel(e.target.value === "" ? NaN : +e.target.value);
  $("level-slider").oninput = e => setLevel(+e.target.value);
  $("height-reference").onchange=()=>{stopPlay();state.reference=state.preferredReference=$("height-reference").value;remember("heightReference",state.reference);windows.each("point",()=>{state.profileView=null;});configureLayer();debounceSlice();};
  $("temperature-unit").onchange=()=>{
    stopPlay();
    windows.each("point",()=>{state.profileView=null;});
    if(state.variable==="t") {
      if(state.grid&&$("range-mode").value!=="fixed")updateScale();
      else {const delta=$("temperature-unit").value==="C"?-273.15:273.15;state.scale=state.scale.map(v=>v+delta);}
      $("range-min").value=state.scale[0].toFixed(2);$("range-max").value=state.scale[1].toFixed(2);
    }
    updateHead();updateLegend();scheduleDraw();windows.each("point",()=>{renderMetrics();renderProfile();});windows.each("section",renderSection);
  };
  $("date").onchange=()=>loadDay($("date").value);
  $("prev-day").onclick=()=>{const i=state.catalog&&state.catalog.dates.indexOf(state.date);if(i>0)loadDay(state.catalog.dates[i-1]);};
  $("next-day").onclick=()=>{const i=state.catalog&&state.catalog.dates.indexOf(state.date);if(i!=null&&i>=0&&i<state.catalog.dates.length-1)loadDay(state.catalog.dates[i+1]);};
  $("year").onchange=()=>{datesForYear();if($("available-date").options.length)loadDay($("available-date").options[0].value);};
  $("available-date").onchange=()=>loadDay($("available-date").value);
  $("time-slider").oninput=e=>changeTime(+e.target.value);
  $("prev-time").onclick=()=>changeTime(state.ti-1);$("next-time").onclick=()=>changeTime(state.ti+1);
  $("play").onclick=()=>{if(state.playing)stopPlay();else startPlay();};
  $("opacity").oninput=()=>{$("opacity-label").textContent=$("opacity").value+"%";scheduleDraw();};
  $("wind-toggle").onchange=()=>{stopPlay();invalidate();loadSlice();};
  $("animated-wind").onchange=()=>{stopPlay();wind.update($("animated-wind").checked);if(state.grid?.arrays.u&&state.grid?.arrays.v)scheduleDraw();else {invalidate();loadSlice();}};$("grid-toggle").onchange=scheduleDraw;
  $("coastline-toggle").checked=stored("coastlines","0")==="1";
  const coastAttribution='<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>';
  function coastlineChanged(){remember("coastlines",$("coastline-toggle").checked?"1":"0");map.attributionControl[$("coastline-toggle").checked?"addAttribution":"removeAttribution"](coastAttribution);scheduleDraw();}
  $("coastline-toggle").onchange=coastlineChanged;if($("coastline-toggle").checked)coastlineChanged();
  $("basemap-toggle").onchange=()=>{$("basemap-toggle").checked&&view.mode==="flat"?basemap.addTo(map):map.removeLayer(basemap);};
  $("range-mode").onchange=()=>{updateScale();updateLegend();state.contourCache=null;scheduleDraw();};
  for(const id of ["range-min","range-max"])$(id).onchange=()=>{
    const lo=+$("range-min").value,hi=+$("range-max").value;
    if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo>=hi){notice("Colour maximum must be greater than minimum.",true);return;}
    $("range-mode").value="fixed";state.scale=[lo,hi];updateLegend();state.contourCache=null;scheduleDraw();
  };

  $("fit-data").onclick=fitData;$("refresh").onclick=()=>connect(true);
  $("sidebar-toggle").onclick=()=>{$("sidebar").classList.toggle("open");setTimeout(()=>map.invalidateSize(),0);};
  $("notice-close").onclick=()=>{dismissedNotices.add($("notice-text").textContent);$("notice").hidden=true;};
  $("contour-toggle").onchange=scheduleDraw;
  $("map-png").onclick=exportMapPNG;
  function shellQuote(text) {return "'"+String(text).replace(/'/g,"'\\''")+"'";}
  function readConfigEditor() {
    const data_root=$("config-root").value.trim(),host=$("config-host").value.trim();
    const port=Number($("config-port").value),cache_mb=Number($("config-cache").value);
    const path=$("config-path").value.trim();
    if(!data_root||!host)throw new Error("Enter a data directory and reader bind address.");
    if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("Choose a reader port between 1024 and 65535.");
    if(!Number.isInteger(cache_mb)||cache_mb<16||cache_mb>1048576)throw new Error("Cache size must be an integer of at least 16 MiB.");
    if(!path.toLowerCase().endsWith(".json")||/[\r\n\0]/.test(path))throw new Error("Choose a personal filename ending in .json.");
    const shared=(state.configuration?.project||"/data1/tim/era5viewer")+"/config.json";
    if(path===shared)throw new Error("Choose a file in your own directory for your personal configuration.");
    return {data_root,host,port,cache_mb};
  }
  function fillConfigEditor(settings,path) {
    const defaults={data_root:"/data3/ERA5",host:"127.0.0.1",port:8769,cache_mb:256};
    const c=Object.assign(defaults,settings);
    $("config-root").value=c.data_root;$("config-host").value=c.host;
    $("config-port").value=c.port||8769;$("config-cache").value=c.cache_mb;
    $("config-path").value=path||stored("configPath","~/era5viewer.json");
    state.configDraft=c;updateConfigPreview();
  }
  function updateConfigPreview() {
    try {
      const c=readConfigEditor(),path=$("config-path").value.trim();state.configDraft=c;
      $("config-json").textContent=JSON.stringify(c,null,2)+"\n";$("config-download").disabled=false;
      const project=state.configuration?.project||"/data1/tim/era5viewer";
      const personal=$("personal-config").open||state.configuration?.personal;
      $("config-command").textContent="bash "+shellQuote(project+"/start.sh")+(personal?" --config "+shellQuote(path):
        " --data-root "+shellQuote(c.data_root)+" --host "+shellQuote(c.host)+" --port "+c.port+" --cache-mb "+c.cache_mb);
      const target=c.host==="0.0.0.0"?"127.0.0.1":c.host;
      const tunnelTarget=target.includes(":")?"["+target+"]":target;
      const user=state.configuration?.user||"user";
      $("config-tunnel").textContent="ssh -N -L "+c.port+":"+tunnelTarget+":"+c.port+" "+user+"@data-machine";
      $("config-address").textContent="http://127.0.0.1:"+c.port;
      $("config-status").textContent="";$("config-status").classList.remove("error");
    } catch(error) {
      $("config-download").disabled=true;$("config-status").textContent=error.message;$("config-status").classList.add("error");
      $("config-json").textContent="";$("config-command").textContent="Complete the personal settings above.";
    }
  }
  function updateReaderConfiguration() {
    const info=state.configuration;
    if(info){
      $("active-config").textContent=(info.personal?"Personal configuration: ":"Shared default: ")+(info.config_file||"reader settings")+" · user "+info.user+" · port "+info.settings.port;
      $("app-version").textContent="v"+info.version.replace(/\.0$/,"");
    }else $("active-config").textContent="Connect to a reader to see its active configuration. You can prepare a personal file below.";
    if(!state.configDraft||!state.configEdited)fillConfigEditor(info?.settings,info?.personal?info.config_file:undefined);
    else updateConfigPreview();
  }
  for(const id of ["config-root","config-host","config-port","config-cache","config-path"])$(id).oninput=()=>{state.configEdited=true;updateConfigPreview();remember("configPath",$("config-path").value);};
  $("personal-config").ontoggle=updateConfigPreview;
  $("config-current").onclick=()=>{state.configEdited=false;fillConfigEditor(state.configuration?.settings,state.configuration?.personal?state.configuration.config_file:undefined);};
  $("config-load").onclick=()=>$("config-file").click();
  $("config-file").onchange=async()=>{
    const file=$("config-file").files[0];if(!file)return;
    try {
      if(file.size>65536)throw new Error("Configuration is too large (maximum 64 KiB).");
      const text=file.text?await file.text():await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("Could not read the JSON file."));reader.readAsText(file);});
      const c=JSON.parse(text),known=["data_root","host","port","cache_mb"];
      if(!c||Array.isArray(c)||typeof c!=="object"||Object.keys(c).some(key=>!known.includes(key)))throw new Error("Use a JSON object with data_root, host, port and cache_mb settings.");
      for(const key of ["data_root","host"])if(key in c&&(typeof c[key]!=="string"||!c[key].trim()))throw new Error(key+" must be a nonempty string.");
      for(const key of ["port","cache_mb"])if(key in c&&(!Number.isInteger(c[key])||typeof c[key]!=="number"))throw new Error(key+" must be an integer.");
      if(c.port!==undefined&&(c.port<1024||c.port>65535))throw new Error("Choose a reader port between 1024 and 65535.");
      if(c.cache_mb!==undefined&&(c.cache_mb<16||c.cache_mb>1048576))throw new Error("Cache size must be at least 16 MiB.");
      state.configEdited=true;$("personal-config").open=true;fillConfigEditor(c,"~/"+file.name);
      $("config-status").textContent="Loaded "+file.name+" into the editor. Download the JSON when ready.";
    }catch(error){$("config-status").textContent=error.message;$("config-status").classList.add("error");}
    finally{$("config-file").value="";}
  };
  $("config-download").onclick=()=>{
    try {
      const c=readConfigEditor(),path=$("config-path").value.trim(),name=path.split(/[\\/]/).pop();
      downloadText(name,JSON.stringify(c,null,2)+"\n","application/json");
      $("personal-config").open=true;updateConfigPreview();
      $("config-status").textContent="Downloaded "+name+". Place it at "+path+" on the data machine, then use the startup command below.";
    }catch(error){$("config-status").textContent=error.message;$("config-status").classList.add("error");}
  };
  async function copyInstruction(id) {
    try {await navigator.clipboard.writeText($(id).textContent);$("config-status").textContent="Command copied.";}
    catch(_){const selection=window.getSelection(),range=document.createRange();range.selectNodeContents($(id));selection.removeAllRanges();selection.addRange(range);$("config-status").textContent="Command selected; copy it using Ctrl+C or ⌘C.";}
  }
  $("config-command-copy").onclick=()=>copyInstruction("config-command");$("config-tunnel-copy").onclick=()=>copyInstruction("config-tunnel");
  $("layer-netcdf").onclick=e=>{if($("layer-netcdf").classList.contains("disabled"))e.preventDefault();else stopPlay();};
  function openConnection() {$("api-url").value=state.base;updateReaderConfiguration();$("connection-dialog").showModal();}
  $("connection-open").onclick=openConnection;$("empty-connect").onclick=openConnection;
  $("connection-close").onclick=()=>{$("connection-dialog").close();};
  $("connection-form").onsubmit=e=>{
    e.preventDefault();const address=$("api-url").value.replace(/\/$/,"");
    try {const u=new URL(address);if(!["http:","https:"].includes(u.protocol))throw new Error();} catch(_){notice("Enter an HTTP reader address.",true);return;}
    state.base=address;remember("api",address);$("connection-dialog").close();connect();
  };
  function dispose() {
    stopPlay(); state.prefetchSerial++; state.cacheEpoch++; clearTimeout(changeTimer);
    state.serial++; state.daySerial++; state.connectSerial++; state.driftSerial++;
    abortLoads(); wind.dispose();
  }
  window.addEventListener("pagehide",dispose);
  // Exposed to make scientific sampling and asynchronous UI behaviour testable.
  window.era5viewer={state,map,view,wind,windows,connect,loadSlice,sample,selectPoint,changeTime,dispose,captureMap,captureProfile,setProfileView,getFrame,coordinateLabel,readConfigEditor,setProjection:mode=>view.setMode(mode)};
  updateCoordinates();updateReaderConfiguration();resize();configureLayer();updateHead();connect();
})();
