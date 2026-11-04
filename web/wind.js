/* Animated streamlets of the current U/V field. Visual advection is sped up;
   these particles are not a forecast or the time-dependent drift calculation. */
(() => {
  "use strict";
  class Wind {
    constructor(canvas, view, getGrid, sample) {
      this.canvas = canvas; this.ctx = canvas.getContext("2d"); this.view = view;
      this.getGrid = getGrid; this.sample = sample; this.enabled = false;
      this.particles = []; this.frame = null; this.steps = 0; this.last = 0;
      document.addEventListener("visibilitychange", () => this.update());
    }
    resize() {
      const s = this.view.map.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(s.x * dpr); this.canvas.height = Math.round(s.y * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.reset();
    }
    reset() {this.particles = []; this.last = 0; this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);}
    update(enabled = this.enabled) {
      this.enabled = enabled;
      const g = this.getGrid(), run = enabled && !!g?.arrays.u && !!g?.arrays.v && !document.hidden;
      this.canvas.hidden = !enabled;
      if (!run) {if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null; this.reset();}
      else if (this.frame === null) this.frame = requestAnimationFrame(t => this.tick(t));
    }
    seed(p, size, g) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const x = Math.random() * size.x, y = Math.random() * Math.max(1, size.y - 79), ll = this.view.unproject([x, y]);
        if (ll && Number.isFinite(this.sample(g, "u", ll.lat, ll.lng)) && Number.isFinite(this.sample(g, "v", ll.lat, ll.lng))) {
          p.x = x; p.y = y; p.life = 1.5 + Math.random() * 4; return true;
        }
      }
      p.life = 0; return false;
    }
    tick(t) {
      this.frame = null;
      const g = this.getGrid();
      if (!this.enabled || document.hidden || !g?.arrays.u || !g?.arrays.v) {this.update(); return;}
      const dt = this.last ? Math.min(.06, (t - this.last) / 1000) : .033;
      if (dt < .028) {this.frame = requestAnimationFrame(n => this.tick(n)); return;}
      this.last = t;
      const size = this.view.map.getSize(), c = this.ctx;
      const count = Math.min(1900, Math.max(250, Math.round(size.x * (size.y - 79) / 700)));
      while (this.particles.length < count) this.particles.push({life: 0});
      this.particles.length = count;
      c.save(); c.globalCompositeOperation = "destination-in"; c.fillStyle = "rgba(0,0,0," + Math.exp(-dt * 2.8) + ")"; c.fillRect(0, 0, size.x, size.y); c.restore();
      c.strokeStyle = "rgba(255,255,255,.8)"; c.lineWidth = 1.15; c.lineCap = "round"; c.beginPath();
      for (const p of this.particles) {
        p.life -= dt;
        if (p.life <= 0 && !this.seed(p, size, g)) continue;
        const ll = this.view.unproject([p.x, p.y]); if (!ll) {p.life = 0; continue;}
        const u = this.sample(g, "u", ll.lat, ll.lng), v = this.sample(g, "v", ll.lat, ll.lng);
        const vector = this.view.vector(ll.lat, ll.lng, u, v); if (!vector) {p.life = 0; continue;}
        const magnitude = Math.hypot(vector.x, vector.y), gain = Math.min(.0035, 95 / magnitude);
        const x = p.x + vector.x * gain * dt, y = p.y + vector.y * gain * dt, next = this.view.unproject([x, y]);
        if (x < 0 || x > size.x || y < 0 || y > size.y - 79 || !next || !Number.isFinite(this.sample(g, "u", next.lat, next.lng)) || !Number.isFinite(this.sample(g, "v", next.lat, next.lng))) {p.life = 0; continue;}
        c.moveTo(p.x, p.y); c.lineTo(x, y); p.x = x; p.y = y;
      }
      c.stroke(); this.steps++; this.frame = requestAnimationFrame(n => this.tick(n));
    }
    dispose() {this.enabled = false; this.update(false);}
  }
  window.ERA5Wind = Wind;
})();
