/* Plot helpers; all data and assets remain local. */
(() => {
  "use strict";
  const finite=v=>typeof v==="number"&&Number.isFinite(v);
  const escape=v=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));
  function niceStep(span,count=6){const raw=Math.max(Math.abs(span)/count,1e-12),p=10**Math.floor(Math.log10(raw));return [1,2,2.5,5,10].find(n=>n*p>=raw*.999999)*p;}
  function niceTicks(low,high,count=6){const step=niceStep(high-low,count),out=[];for(let i=Math.ceil(low/step-1e-9);i<=Math.floor(high/step+1e-9)&&out.length<100;i++)out.push(Number((i*step).toPrecision(12)));return out;}
  function niceExtent(low,high,count=6){if(!finite(low)||!finite(high))return [0,1];if(high<=low){const pad=Math.max(.5,Math.abs(low)*.01);low-=pad;high+=pad;}const step=niceStep(high-low,count);return [Number((Math.floor(low/step)*step).toPrecision(12)),Number((Math.ceil(high/step)*step).toPrecision(12))];}
  function tickLabel(v){if(Math.abs(v)<1e-10)return "0";if(Math.abs(v)>=1e6||Math.abs(v)<.001)return v.toExponential(1);return String(Number(v.toPrecision(7)));}
  function quantile(a,q){const i=(a.length-1)*q,l=Math.floor(i),w=i-l;return a[l]*(1-w)+a[Math.min(a.length-1,l+1)]*w;}
  const PRESSURES=[1100,1000,850,700,500,300,200,100,50,20,10,5,2,1,.5,.2,.1,.05,.02,.01,.005,.002,.001];
  function interpolateAxis(xs,ys,target,levels){
    for(let i=0;i<xs.length;i++){
      if(!finite(xs[i])||!finite(ys[i]))continue;
      if(Math.abs(xs[i]-target)<1e-6)return ys[i];
      if(i+1<xs.length&&finite(xs[i+1])&&finite(ys[i+1])&&(!levels||levels[i+1]===levels[i]+1)&&target>Math.min(xs[i],xs[i+1])&&target<Math.max(xs[i],xs[i+1])){const w=(target-xs[i])/(xs[i+1]-xs[i]);return ys[i]*(1-w)+ys[i+1]*w;}
    }return NaN;
  }
  function spacedTicks(ticks,y,top,bottom,gap=17){const out=[];for(const t of ticks.filter(t=>finite(t.coordinate)).sort((a,b)=>y(a.coordinate)-y(b.coordinate))){const yy=y(t.coordinate);if(yy>=top-1e-6&&yy<=bottom+1e-6&&(!out.length||yy-y(out[out.length-1].coordinate)>=gap))out.push(t);}return out;}
  function profile(profile,o){
    const p=profile.profiles,levels=profile.levels,variable=o.variable;
    const height=(o.reference==="msl"?p.height_msl_m:p.height_agl_m)?.map(v=>finite(v)?v/1000:NaN),pressure=p.pressure_hpa?.map(v=>finite(v)&&v>0?-Math.log10(v):NaN);
    let axis=o.axis;if(axis==="height"&&!height)axis=pressure?"pressure":"model";if(axis==="pressure"&&!pressure)axis=height?"height":"model";
    const coordinate=axis==="height"?height:axis==="pressure"?pressure:levels.map(v=>-v),ylabel=axis==="height"?"Height (km "+(o.reference==="msl"?"MSL":"AGL")+")":axis==="pressure"?"Pressure (hPa, log)":"Model level",values=p[variable];
    if(!values)return null;
    const points=values.map((v,i)=>({x:finite(v)?o.convert(v):NaN,y:coordinate[i],index:i})),valid=points.filter(v=>finite(v.x)&&finite(v.y));if(valid.length<2)return null;
    const xs=valid.map(v=>v.x),ys=valid.map(v=>v.y),xmin=Math.min(...xs),xmax=Math.max(...xs),pad=Math.max((xmax-xmin)*.06,.5),fullX=niceExtent(xmin-pad,xmax+pad,5);
    let fullY;if(axis==="height")fullY=niceExtent(Math.min(0,...ys),Math.max(...ys),8);else if(axis==="pressure")fullY=[-Math.log10(Math.ceil(10**(-Math.min(...ys))/100)*100),Math.ceil(Math.max(...ys)-1e-8)];else fullY=niceExtent(Math.min(...ys),Math.max(...ys),7);
    const key=[axis,variable,o.reference,o.unit].join("|"),view=[o.view,o.fallbackView].find(v=>v?.key===key),xd=view?view.x:fullX,yd=view?view.y:fullY;
    const width=360,heightPx=260,left=48,right=300,top=30,bottom=216,x=v=>left+(v-xd[0])/(xd[1]-xd[0])*(right-left),y=v=>bottom-(v-yd[0])/(yd[1]-yd[0])*(bottom-top),inverseX=v=>xd[0]+(v-left)/(right-left)*(xd[1]-xd[0]),inverseY=v=>yd[0]+(bottom-v)/(bottom-top)*(yd[1]-yd[0]);
    let ticks=axis==="pressure"?PRESSURES.map(v=>({label:tickLabel(v),coordinate:-Math.log10(v)})):niceTicks(yd[0],yd[1],axis==="height"?8:7).map(v=>({label:tickLabel(axis==="model"?-v:v),coordinate:v}));ticks=spacedTicks(ticks,y,top,bottom,axis==="pressure"?18:16);
    let secondary=[],secondaryLabel="";
    if(axis==="height"&&pressure){secondaryLabel="Pressure (hPa)";secondary=PRESSURES.map(v=>({label:tickLabel(v),coordinate:interpolateAxis(pressure,coordinate,-Math.log10(v),levels)}));}
    else if(height&&axis==="pressure"){secondaryLabel="Height (km "+(o.reference==="msl"?"MSL":"AGL")+")";const vh=height.filter(finite);secondary=niceTicks(Math.min(0,...vh),Math.max(...vh),8).map(v=>({label:tickLabel(v),coordinate:interpolateAxis(height,coordinate,v,levels)}));}
    else if(axis==="model"&&pressure){secondaryLabel="Pressure (hPa)";secondary=PRESSURES.map(v=>({label:tickLabel(v),coordinate:interpolateAxis(pressure,coordinate,-Math.log10(v),levels)}));}
    secondary=spacedTicks(secondary,y,top,bottom,18);const xticks=niceTicks(xd[0],xd[1],5);
    let svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 260" tabindex="0" role="img" aria-label="Vertical '+escape(o.name)+' profile" data-axis="'+axis+'"><rect width="360" height="260" fill="white"/><defs><clipPath id="profile-clip"><rect x="'+left+'" y="'+top+'" width="'+(right-left)+'" height="'+(bottom-top)+'"/></clipPath></defs><g font-family="sans-serif" font-size="10" fill="#526c63">';
    svg+='<text x="4" y="14">'+escape(ylabel)+'</text><text x="356" y="14" text-anchor="end">'+escape(secondaryLabel)+'</text>';
    for(const t of ticks){const yy=y(t.coordinate);svg+='<line x1="'+left+'" y1="'+yy+'" x2="'+right+'" y2="'+yy+'" stroke="#e1e9e2"/><text class="primary-tick" x="41" y="'+(yy+3)+'" text-anchor="end">'+escape(t.label)+'</text>';}
    for(const t of secondary){const yy=y(t.coordinate);svg+='<line x1="'+right+'" y1="'+yy+'" x2="'+(right+4)+'" y2="'+yy+'" stroke="#93aaa0"/><text class="secondary-tick" x="307" y="'+(yy+3)+'">'+escape(t.label)+'</text>';}
    for(const v of xticks)svg+='<line x1="'+x(v)+'" y1="'+top+'" x2="'+x(v)+'" y2="'+bottom+'" stroke="#f0f4f1"/><text class="x-tick" x="'+x(v)+'" y="234" text-anchor="middle">'+escape(tickLabel(v))+'</text>';
    svg+='<text x="174" y="253" text-anchor="middle">'+escape(o.name+' ('+o.unit+')')+'</text><path d="M'+left+','+top+' V'+bottom+' H'+right+' V'+top+'" stroke="#9bb0a6" fill="none"/>';
    let path="",previous=-2;for(const point of points){if(!finite(point.x)||!finite(point.y)){previous=-2;continue;}const continuous=point.index===previous+1&&levels[point.index]===levels[previous]+1;path+=(continuous?" L":" M")+x(point.x).toFixed(3)+","+y(point.y).toFixed(3);previous=point.index;}
    let selectedY=NaN;if(o.selected.mode==="height"&&height)selectedY=interpolateAxis(height,coordinate,o.selected.value,levels);else if(o.selected.mode==="pressure"&&pressure)selectedY=interpolateAxis(pressure,coordinate,-Math.log10(o.selected.value),levels);else if(o.selected.mode==="model")selectedY=coordinate[levels.indexOf(o.selected.value)];
    if(finite(selectedY))svg+='<line clip-path="url(#profile-clip)" x1="'+left+'" y1="'+y(selectedY)+'" x2="'+right+'" y2="'+y(selectedY)+'" stroke="#be9048" stroke-dasharray="4 3"/>';
    svg+='<path clip-path="url(#profile-clip)" d="'+path+'" fill="none" stroke="#087f75" stroke-width="2.2" stroke-linejoin="round"/></g></svg>';
    return {svg,key,axis,x:xd,y:yd,fullX,fullY,left,right,top,bottom,width,height:heightPx,inverseX,inverseY,primaryTicks:ticks,secondaryTicks:secondary,xTicks:xticks};
  }
  function crossSection(data, o) {
    const pressure = data.axis === "pressure";
    const coordinate = value => pressure ? -Math.log10(value) : value;
    const {distance_km: distances, vertical, surface, values, waypoints, shape: [rows, cols]} = data;
    const minY = coordinate(vertical[0]), maxY = coordinate(vertical[rows - 1]);
    const fullX = [0, distances[cols - 1]];
    let low = Infinity, high = -Infinity, representedTop = minY;
    for (let i = 0; i < values.length; i++) {
      if (!finite(values[i])) continue;
      low = Math.min(low, o.convert(values[i]));
      high = Math.max(high, o.convert(values[i]));
      representedTop = coordinate(vertical[Math.floor(i / cols)]);
    }
    const terrain = surface.filter(finite).map(coordinate);
    const base = pressure ? Math.min(-3, ...terrain) : Math.min(0, ...terrain);
    const fullY = pressure
      ? [Math.max(minY, base), Math.min(maxY, Math.max(-2, Math.ceil(representedTop)))]
      : niceExtent(Math.max(minY, base), Math.max(base + 1, representedTop), 7);
    if (o.symmetric && finite(low)) high = Math.max(1, -low, high), low = -high;
    const range = o.range || niceExtent(low, high, 6);
    const xd = o.view?.x || fullX, yd = o.view?.y || fullY;
    const width = 540, height = 286, left = 56, right = 520, top = 59, bottom = 244;
    const x = v => left + (v - xd[0]) / (xd[1] - xd[0]) * (right - left);
    const y = v => bottom - (v - yd[0]) / (yd[1] - yd[0]) * (bottom - top);
    const inverseX = v => xd[0] + (v - left) / (right - left) * (xd[1] - xd[0]);
    const inverseY = v => yd[0] + (bottom - v) / (bottom - top) * (yd[1] - yd[0]);
    const axisLabel = pressure ? "Pressure (hPa, log)" : "Geopotential height (km " + (data.axis === "height_msl" ? "MSL" : "AGL") + ")";
    let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 286" tabindex="0" role="img" aria-label="' +
      escape(o.name + " cross-section, " + axisLabel + " against distance") +
      '"><defs><clipPath id="section-clip"><rect x="56" y="59" width="464" height="185"/></clipPath></defs>' +
      '<g font-family="sans-serif" font-size="11" fill="#465f56"><text x="56" y="15">' + escape(axisLabel) + '</text>';
    const ticks = pressure
      ? PRESSURES.map(p => ({label: tickLabel(p), coordinate: coordinate(p)}))
      : niceTicks(...yd, 6).map(v => ({label: tickLabel(v), coordinate: v}));
    for (const tick of spacedTicks(ticks, y, top, bottom)) {
      const py = y(tick.coordinate);
      svg += '<path d="M51,' + py + 'H520" stroke="#a4b4ac" stroke-opacity=".46"/>' +
        '<text x="47" y="' + (py + 4) + '" text-anchor="end">' + tick.label + '</text>';
    }
    for (const distance of niceTicks(...xd, 6)) {
      const px = x(distance);
      svg += '<path d="M' + px + ',59V249" stroke="#a4b4ac" stroke-opacity=".38"/>' +
        '<text x="' + px + '" y="262" text-anchor="middle">' + tickLabel(distance) + '</text>';
    }
    let line = [], ground = "";
    function finishGround() {
      if (line.length > 1) {
        const trace = line.map(p => p.join(",")).join(" L");
        ground += '<path d="M' + trace + ' L' + line.at(-1)[0] + ',244 H' + line[0][0] +
          'Z" fill="#d8cbbb"/><path class="section-terrain" d="M' + trace + '" fill="none" stroke="#755944" stroke-width="1.5"/>';
      }
      line = [];
    }
    surface.forEach((v, i) => {
      if (finite(v)) line.push([x(distances[i]).toFixed(2), y(coordinate(v)).toFixed(2)]);
      else finishGround();
    });
    finishGround();
    svg += '<g clip-path="url(#section-clip)">' + ground + '</g>';
    const labelRows = [-Infinity, -Infinity, -Infinity];
    waypoints.forEach((index, i) => {
      const px = x(distances[index]);
      if (px < left - 1e-5 || px > right + 1e-5) return;
      const row = labelRows.findIndex(last => px - last >= 14);
      if (row >= 0) labelRows[row] = px;
      const label = String.fromCharCode(65 + i);
      svg += '<g class="section-waypoint" data-distance="' + distances[index] + '"><title>' + label + ' · ' +
        tickLabel(distances[index]) + ' km</title><path d="M' + px + ',59V244" stroke="#244f46" stroke-dasharray="4 3"/>' +
        '<text x="' + px + '" y="' + (row < 0 ? 52 : 52 - 12 * row) + '" text-anchor="middle" font-weight="bold">' + label + '</text></g>';
    });
    svg += '<rect x="56" y="59" width="464" height="185" fill="none" stroke="#94a89d"/>' +
      '<text x="288" y="281" text-anchor="middle">Distance along route (km)</text></g></svg>';

    const c = o.canvas.getContext("2d"), w = right - left, h = bottom - top;
    const pixels = c.createImageData(w, h);
    const columns = new Int16Array(w).fill(-1);
    for (let px = 0, j = 0; px < w; px++) {
      const distance = inverseX(left + px + .5);
      if (distance < 0 || distance > fullX[1]) continue;
      while (j + 1 < cols && distance > (distances[j] + distances[j + 1]) / 2) j++;
      columns[px] = j;
    }
    for (let py = 0; py < h; py++) {
      const v = inverseY(top + py + .5);
      if (v < minY || v > maxY) continue;
      const row = Math.round((v - minY) / (maxY - minY) * (rows - 1)) * cols;
      for (let px = 0; px < w; px++) {
        if (columns[px] < 0) continue;
        const raw = values[row + columns[px]];
        if (!finite(raw)) continue;
        const colour = o.colours[Math.max(0, Math.min(255, Math.round((o.convert(raw) - range[0]) / (range[1] - range[0]) * 255)))];
        const i = (py * w + px) * 4;
        pixels.data[i] = colour[0]; pixels.data[i + 1] = colour[1]; pixels.data[i + 2] = colour[2]; pixels.data[i + 3] = 255;
      }
    }
    c.clearRect(0, 0, width, height);
    c.putImageData(pixels, left, top);
    return {svg, x: xd, y: yd, fullX, fullY, range, valid: finite(low), left, right, top, bottom, width, height, inverseX, inverseY};
  }

  function joinSegments(segments){
    const key=p=>p[0].toFixed(4)+","+p[1].toFixed(4),nodes=new Map(),used=new Set(),paths=[];segments.forEach((s,i)=>s.forEach(p=>{const k=key(p);if(!nodes.has(k))nodes.set(k,[]);nodes.get(k).push(i);}));
    function grow(path,forward){while(true){const point=forward?path[path.length-1]:path[0],k=key(point),next=(nodes.get(k)||[]).find(i=>!used.has(i));if(next===undefined)break;used.add(next);const seg=segments[next],other=key(seg[0])===k?seg[1]:seg[0];if(forward)path.push(other);else path.unshift(other);}}
    segments.forEach((s,i)=>{if(!used.has(i)){used.add(i);const path=s.slice();grow(path,true);grow(path,false);paths.push(path);}});return paths;
  }
  function contours(width,height,levels,sample,pixel=12){
    const nx=Math.ceil(width/pixel),ny=Math.ceil(height/pixel),rows=[];for(let yi=0;yi<=ny;yi++){const row=[];for(let xi=0;xi<=nx;xi++)row.push(sample(Math.min(width,xi*pixel),Math.min(height,yi*pixel)));rows.push(row);}
    return levels.map(level=>{const segments=[];for(let yi=0;yi<ny;yi++)for(let xi=0;xi<nx;xi++){
      const values=[rows[yi][xi],rows[yi][xi+1],rows[yi+1][xi+1],rows[yi+1][xi]];if(!values.every(finite))continue;
      const x0=xi*pixel,x1=Math.min(width,(xi+1)*pixel),y0=yi*pixel,y1=Math.min(height,(yi+1)*pixel),corners=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],cross=[];
      for(let e=0;e<4;e++){const n=(e+1)%4;if((values[e]>=level)!==(values[n]>=level)){const w=(level-values[e])/(values[n]-values[e]);cross.push([corners[e][0]+w*(corners[n][0]-corners[e][0]),corners[e][1]+w*(corners[n][1]-corners[e][1])]);}}
      if(cross.length===2)segments.push(cross);else if(cross.length===4){const centre=values.reduce((a,b)=>a+b)/4;if((values[0]>=level)===(centre>=level))segments.push([cross[0],cross[1]],[cross[2],cross[3]]);else segments.push([cross[0],cross[3]],[cross[1],cross[2]]);}
    }return {level,paths:joinSegments(segments)};});
  }
  window.ERA5Plots={niceStep,niceTicks,niceExtent,tickLabel,quantile,profile,crossSection,contours,interpolateAxis,escape};
})();
