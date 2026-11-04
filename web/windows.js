/* Independent floating plot windows with scoped controls and retained views. */
(() => {
  "use strict";
  class Windows {
    constructor(area, defaults, onCreate, onChange, onClose) {
      this.area = area; this.defaults = defaults; this.onCreate = onCreate;
      this.onChange = onChange; this.onClose = onClose; this.z = 800;
      this.items = {point: [], section: []}; this.active = {point: null, section: null};
      this.context = {}; this.ids = {}; this.templates = {}; this.sequence = {point: 0, section: 0};
      for (const kind of ["point", "section"]) {
        const panel = document.getElementById(kind + "-panel");
        for (const el of [panel, ...panel.querySelectorAll("[id]")]) {this.ids[el.id] = kind; el.dataset.ui = el.id;}
        this.templates[kind] = panel.cloneNode(true);
      }
      window.addEventListener("resize", () => this.clampAll());
    }
    current(kind) {return this.context[kind] || this.active[kind];}
    get(id) {
      const kind = this.ids[id], win = kind && this.current(kind);
      return win ? (win.panel.dataset.ui === id ? win.panel : win.panel.querySelector('[data-ui="' + id + '"]')) : document.getElementById(id);
    }
    with(kind, win, fn) {
      const previous = this.context[kind]; this.context[kind] = win;
      try {return fn();} finally {this.context[kind] = previous;}
    }
    each(kind, fn) {return this.items[kind].map(win => this.with(kind, win, () => fn(win)));}
    create(kind) {
      const id = ++this.sequence[kind];
      const panel = id === 1 ? document.getElementById(kind + "-panel") : this.templates[kind].cloneNode(true);
      if (id !== 1) {
        const mapping = new Map();
        for (const el of [panel, ...panel.querySelectorAll("[id]")]) {mapping.set(el.id, el.id + "-" + id); el.id += "-" + id;}
        for (const el of panel.querySelectorAll("[for]")) if (mapping.has(el.htmlFor)) el.htmlFor = mapping.get(el.htmlFor);
        this.area.append(panel);
      }
      panel.classList.add("plot-window"); panel.hidden = false;
      const win = {kind, id, panel, data: structuredClone(this.defaults[kind]), minimised: false, closed: false, scroll: 0};
      this.items[kind].push(win); this.active[kind] = win;
      const w = Math.min(kind === "point" ? 380 : 590, this.area.clientWidth - 24);
      const h = Math.min(kind === "point" ? 650 : 470, this.area.clientHeight - 240);
      const offset = (this.items[kind].length - 1) % 5 * 24;
      Object.assign(panel.style, {width: Math.max(260, w) + "px", height: Math.max(230, h) + "px",
        left: (kind === "point" ? Math.max(12, this.area.clientWidth - w - 20 - offset) : 20 + offset) + "px", top: (kind === "point" ? 156 + offset : Math.max(155, this.area.clientHeight - h - 106 - offset)) + "px"});
      const heading = panel.querySelector(".point-heading");
      heading.classList.add("window-drag-handle"); heading.tabIndex = 0;
      heading.title = "Drag to move this window; use arrow keys when focused";
      heading.addEventListener("keydown", e => {
        if (e.target !== heading || !e.key.startsWith("Arrow")) return;
        e.preventDefault(); const step = e.shiftKey ? 30 : 10;
        panel.style.left = (parseFloat(panel.style.left) + (e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0)) + "px";
        panel.style.top = (parseFloat(panel.style.top) + (e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0)) + "px"; this.clamp(win);
      });
      this.gesture(win, heading, "move");
      for (const edge of ["n", "s", "se"]) {
        const handle = document.createElement("button"); handle.type = "button"; handle.className = "window-resize resize-" + edge;
        handle.setAttribute("aria-label", "Resize " + kind + " window" + (edge === "se" ? " horizontally and vertically" : " vertically"));
        handle.title = "Drag to resize"; panel.append(handle); this.gesture(win, handle, edge);
        handle.addEventListener("keydown", e => {
          if (!e.key.startsWith("Arrow")) return; e.preventDefault();
          panel.style.height = (panel.offsetHeight + (e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0)) + "px";
          if (edge === "se") panel.style.width = (panel.offsetWidth + (e.key === "ArrowRight" ? 20 : e.key === "ArrowLeft" ? -20 : 0)) + "px";
          this.clamp(win);
        });
      }
      panel.addEventListener("pointerdown", () => this.focus(win, false));
      this.with(kind, win, () => this.onCreate(win)); this.clamp(win); this.focus(win); return win;
    }
    gesture(win, handle, edge) {
      const panel = win.panel; let start;
      handle.addEventListener("pointerdown", e => {
        if (e.button !== 0 || (edge === "move" && e.target.closest("button,input,select,a"))) return;
        e.preventDefault(); handle.setPointerCapture(e.pointerId);
        start = {x: e.clientX, y: e.clientY, left: parseFloat(panel.style.left), top: parseFloat(panel.style.top), width: panel.offsetWidth, height: panel.offsetHeight};
        this.focus(win, false); panel.classList.add("window-moving");
      });
      handle.addEventListener("pointermove", e => {
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (edge === "move") {panel.style.left = start.left + dx + "px"; panel.style.top = start.top + dy + "px";}
        else if (edge === "n") {
          const top = Math.max(6, Math.min(start.top + start.height - 220, start.top + dy));
          panel.style.top = top + "px"; panel.style.height = start.height + start.top - top + "px";
        } else {panel.style.height = Math.max(220, start.height + dy) + "px"; if (edge === "se") panel.style.width = Math.max(280, start.width + dx) + "px";}
        this.clamp(win);
      });
      for (const name of ["pointerup", "pointercancel"]) handle.addEventListener(name, () => {start = null; panel.classList.remove("window-moving");});
    }
    clamp(win) {
      const p = win.panel, width = this.area.clientWidth, height = this.area.clientHeight;
      const w = Math.min(parseFloat(p.style.width), Math.max(260, width - 16));
      const h = Math.min(parseFloat(p.style.height), Math.max(200, height - 100));
      p.style.width = w + "px"; p.style.height = h + "px";
      p.style.left = Math.max(8, Math.min(parseFloat(p.style.left), width - w - 8)) + "px";
      p.style.top = Math.max(6, Math.min(parseFloat(p.style.top), height - h - 88)) + "px";
    }
    clampAll() {for (const kind of ["point", "section"]) this.each(kind, w => this.clamp(w));}
    focus(win, open = true) {
      if (win.closed) return;
      this.active[win.kind] = win; win.panel.style.zIndex = String(++this.z);
      if (open) {const hidden = win.panel.hidden; win.minimised = false; win.panel.hidden = false; this.clamp(win); if(hidden)win.panel.querySelector(".plot-scroll").scrollTop = win.scroll;}
      this.onChange();
    }
    minimise(win) {
      win.scroll = win.panel.querySelector(".plot-scroll").scrollTop; win.minimised = true; win.panel.hidden = true; this.onChange();
    }
    close(win) {
      this.with(win.kind, win, () => this.onClose(win)); win.closed = true; win.panel.hidden = true;
      if (win.id !== 1) win.panel.remove();
      this.items[win.kind] = this.items[win.kind].filter(w => w !== win);
      if (this.active[win.kind] === win) this.active[win.kind] = this.items[win.kind].at(-1) || null;
      this.onChange();
    }
  }
  window.ERA5Windows = Windows;
})();
