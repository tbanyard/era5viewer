/* Spherical projections. ERA5 latitude/longitude stays authoritative; no
   resampled archive or online projection service is required. */
(() => {
  "use strict";
  const RAD = Math.PI / 180, DEG = 180 / Math.PI;
  const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function forward(mode, lat, lon, centre = {lat: 25, lng: 0}) {
    const p = lat * RAD, d = wrap(lon - centre.lng) * RAD;
    if (mode === "globe") {
      const c = centre.lat * RAD;
      const depth = Math.sin(c) * Math.sin(p) + Math.cos(c) * Math.cos(p) * Math.cos(d);
      if (depth < -1e-9) return null;
      return {x: Math.cos(p) * Math.sin(d), y: Math.sin(c) * Math.cos(p) * Math.cos(d) - Math.cos(c) * Math.sin(p)};
    }
    const sign = mode === "south" ? -1 : 1;
    if (sign * lat < -89.9) return null;
    const rho = 2 * Math.tan(Math.PI / 4 - sign * p / 2);
    return {x: rho * Math.sin(d), y: sign * rho * Math.cos(d)};
  }
  function inverse(mode, x, y, centre = {lat: 25, lng: 0}) {
    const rho = Math.hypot(x, y);
    if (mode === "globe") {
      if (rho > 1 + 1e-9) return null;
      if (rho < 1e-12) return {lat: centre.lat, lng: wrap(centre.lng)};
      const c = Math.asin(Math.min(1, rho)), p = centre.lat * RAD;
      return {lat: Math.asin(clamp(Math.cos(c) * Math.sin(p) - y * Math.sin(c) * Math.cos(p) / rho, -1, 1)) * DEG,
        lng: wrap(centre.lng + Math.atan2(x * Math.sin(c), rho * Math.cos(p) * Math.cos(c) + y * Math.sin(p) * Math.sin(c)) * DEG)};
    }
    const sign = mode === "south" ? -1 : 1;
    return {lat: sign * (Math.PI / 2 - 2 * Math.atan(rho / 2)) * DEG,
      lng: rho < 1e-12 ? centre.lng : wrap(centre.lng + Math.atan2(x, sign * y) * DEG)};
  }
  class View {
    constructor(map, surface, onChange, onClick, onHover) {
      this.map = map; this.surface = surface; this.onChange = onChange;
      this.mode = "flat"; this.rotation = {lat: 25, lng: 0}; this.factor = 1;
      this.pan = {x: 0, y: 0}; this.dragging = false;
      const local = e => {const b = surface.getBoundingClientRect(); return {x: e.clientX - b.left, y: e.clientY - b.top};};
      let start;
      surface.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        start = {p: local(e), rotation: {...this.rotation}, pan: {...this.pan}, moved: false};
        surface.setPointerCapture(e.pointerId); surface.classList.add("dragging");
      });
      surface.addEventListener("pointermove", e => {
        const p = local(e);
        if (start) {
          const dx = p.x - start.p.x, dy = p.y - start.p.y;
          if (Math.hypot(dx, dy) > 4) start.moved = this.dragging = true;
          if (this.dragging) {
            if (this.mode === "globe") {
              this.rotation.lng = wrap(start.rotation.lng - dx / this.geometry().scale * DEG);
              this.rotation.lat = clamp(start.rotation.lat + dy / this.geometry().scale * DEG, -90, 90);
            } else this.pan = {x: start.pan.x + dx, y: start.pan.y + dy};
            this.onChange();
          }
        } else {const ll = this.unproject(p); onHover(ll ? {latlng: ll, containerPoint: p} : null);}
      });
      surface.addEventListener("pointerup", e => {
        if (!start) return;
        const moved = start.moved; start = null; this.dragging = false; surface.classList.remove("dragging");
        if (!moved) {const ll = this.unproject(local(e)); if (ll) onClick({latlng: ll, originalEvent: e});}
      });
      surface.addEventListener("pointercancel", () => {start = null; this.dragging = false; surface.classList.remove("dragging");});
      surface.addEventListener("mouseleave", () => onHover(null));
      surface.addEventListener("wheel", e => {e.preventDefault(); this.zoom(e.deltaY < 0 ? 1 : -1, local(e));}, {passive: false});
      surface.addEventListener("keydown", e => {
        if (["+", "="].includes(e.key)) this.zoom(1);
        else if (e.key === "-") this.zoom(-1);
        else if (e.key.startsWith("Arrow")) {
          if (this.mode === "globe") {
            this.rotation.lng = wrap(this.rotation.lng + (e.key === "ArrowRight" ? 10 : e.key === "ArrowLeft" ? -10 : 0));
            this.rotation.lat = clamp(this.rotation.lat + (e.key === "ArrowUp" ? 10 : e.key === "ArrowDown" ? -10 : 0), -90, 90);
          } else {
            this.pan.x += e.key === "ArrowRight" ? 30 : e.key === "ArrowLeft" ? -30 : 0;
            this.pan.y += e.key === "ArrowDown" ? 30 : e.key === "ArrowUp" ? -30 : 0;
          }
          this.onChange();
        } else return;
        e.preventDefault();
      });
    }
    geometry() {
      const s = this.map.getSize(), radius = Math.max(65, Math.min(s.x - 40, s.y - 220) * .47);
      return {x: s.x / 2 + this.pan.x, y: (s.y - 79) / 2 + 28 + this.pan.y,
        scale: radius * this.factor / (this.mode === "globe" ? 1 : 1.154700538)};
    }
    project(ll) {
      const lat = Array.isArray(ll) ? ll[0] : ll.lat, lon = Array.isArray(ll) ? ll[1] : (ll.lng ?? ll.lon);
      // Keep subpixel precision: Leaflet's marker helper rounds coordinates,
      // which would erase the small displacement used for wind vectors.
      if (this.mode === "flat") return this.map.layerPointToContainerPoint(this.map.project([lat, lon], this.map.getZoom()).subtract(this.map.getPixelOrigin()));
      const p = forward(this.mode, lat, lon, this.rotation), g = this.geometry();
      return p ? {x: g.x + p.x * g.scale, y: g.y + p.y * g.scale} : null;
    }
    unproject(p) {
      const x = Array.isArray(p) ? p[0] : p.x, y = Array.isArray(p) ? p[1] : p.y;
      if (this.mode === "flat") return this.map.containerPointToLatLng([x, y]);
      const g = this.geometry(); return inverse(this.mode, (x - g.x) / g.scale, (y - g.y) / g.scale, this.rotation);
    }
    centre() {return this.mode === "flat" ? this.map.getCenter() : this.rotation;}
    zoomLevel() {return this.mode === "flat" ? this.map.getZoom() : 2 + Math.log2(this.factor);}
    key() {return [this.mode, this.centre().lat, this.centre().lng, this.zoomLevel(), this.pan.x, this.pan.y].join("|");}
    setMode(mode) {
      if (!["flat", "north", "south", "globe"].includes(mode)) return;
      if (mode === "globe" && this.mode === "flat") this.rotation = {...this.map.getCenter()};
      this.mode = mode; this.pan = {x: 0, y: 0}; this.factor = 1;
      if (mode === "north" || mode === "south") this.rotation = {lat: mode === "north" ? 90 : -90, lng: 0};
      this.surface.hidden = mode === "flat"; this.onChange();
    }
    zoom(direction, anchor) {
      if (this.mode === "flat") {this.map.setZoom(this.map.getZoom() + direction); return;}
      const old = this.factor, next = clamp(old * 1.25 ** direction, .4, 16);
      if (anchor && this.mode !== "globe") {
        const g = this.geometry(), ratio = next / old;
        this.pan.x += (anchor.x - g.x) * (1 - ratio); this.pan.y += (anchor.y - g.y) * (1 - ratio);
      }
      this.factor = next; this.onChange();
    }
    reset(record) {
      this.pan = {x: 0, y: 0}; this.factor = 1;
      if (this.mode === "globe" && record && !record.cyclic) this.rotation = {lat: (record.bounds[0] + record.bounds[2]) / 2, lng: (record.bounds[1] + record.bounds[3]) / 2};
      this.onChange();
    }
    vector(lat, lon, u, v) {
      const speed = Math.hypot(u, v); if (!Number.isFinite(speed) || speed < .01) return null;
      const p = lat * RAD, l = lon * RAD, a = 1e-5;
      const east = u / speed, north = v / speed;
      const x = Math.cos(p) * Math.cos(l) + a * (-east * Math.sin(l) - north * Math.sin(p) * Math.cos(l));
      const y = Math.cos(p) * Math.sin(l) + a * (east * Math.cos(l) - north * Math.sin(p) * Math.sin(l));
      const z = Math.sin(p) + a * north * Math.cos(p);
      const from = this.project([lat, lon]), to = this.project([Math.atan2(z, Math.hypot(x, y)) * DEG, lon + wrap(Math.atan2(y, x) * DEG - lon)]);
      if (!from || !to) return null;
      const dx = (to.x - from.x) / a * speed, dy = (to.y - from.y) / a * speed;
      return Math.hypot(dx, dy) < 1e8 ? {x: dx, y: dy} : null;
    }
  }
  window.ERA5Projections = {forward, inverse, View, wrap};
})();
