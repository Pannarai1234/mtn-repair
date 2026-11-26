/*
 * PlantMap — ผังโรงงานแบบเวกเตอร์ (SVG)
 *
 *   พื้นหลัง : ผนัง/ห้อง จาก js/layout-data.js
 *   โซน     : กรอบเส้นประ + ชื่อ + จำนวนงานค้าง
 *   เครื่อง  : กล่องสีเขียว = ปกติ/ปิดงานแล้ว, แดงกะพริบ = มีงานค้าง (เครื่องหยุดกะพริบเร็วกว่า)
 *             ถ้าซูมออกจนอ่านรหัสไม่ออก เครื่องที่เสียจะมีป้ายสีแดงขนาดคงที่ชี้ตำแหน่งให้
 *
 *   ซูม: ปุ่ม + −, ดับเบิลคลิก, Ctrl+ล้อเมาส์, กางนิ้ว · เลื่อน: ลาก
 *   โหมดแก้ไข (editable): ลากย้าย, ลากมุมขวาล่างปรับขนาด, ลูกศร = ย้าย, Shift+ลูกศร = ปรับขนาด
 */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const MAX_ZOOM = 16;
  let uid = 0;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const COARSE = window.matchMedia('(pointer: coarse)').matches;

  function mk(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  class PlantMap {
    /**
     * opts.plant      ข้อมูลจาก PLANT_LAYOUT.plants
     * opts.mini       true = แผนที่ย่อ (ไม่มีปุ่ม/ไม่โต้ตอบ)
     * opts.editable   true = โหมดแก้ไข
     * opts.onMachine(id), opts.onZone(id)            โหมดดู
     * opts.onSelect({type,id}|null), opts.onChange(type, obj)   โหมดแก้ไข (type = 'machine' | 'zone')
     */
    constructor(host, opts) {
      this.host = host;
      this.opts = opts;
      this.editable = !!opts.editable;
      this.mini = !!opts.mini;
      this.mEls = new Map();
      this.zEls = new Map();
      this.pins = new Map();
      this.machines = [];
      this.zones = [];
      this.state = {};
      this.pointers = new Map();
      this.drag = null;
      this.pending = null;

      host.classList.add('pmap');
      if (this.editable) host.classList.add('pmap-edit');
      if (this.mini) host.classList.add('pmap-mini');
      host.innerHTML = '';
      this.svg = mk('svg', { class: 'pmap-svg', role: this.mini ? 'img' : 'group', preserveAspectRatio: 'xMidYMid meet' }, host);
      // เส้นตารางแบบกระดาษเขียนแบบ
      const pid = 'pm-grid-' + (++uid);
      const pat = mk('pattern', { id: pid, width: 50, height: 50, patternUnits: 'userSpaceOnUse' }, mk('defs', {}, this.svg));
      mk('path', { d: 'M50 0H0V50', class: 'grid-line' }, pat);
      mk('rect', { x: -3000, y: -3000, width: 8000, height: 8000, fill: `url(#${pid})` }, this.svg);
      this.gArch = mk('g', { class: 'arch' }, this.svg);
      this.gZones = mk('g', { class: 'zones' }, this.svg);
      this.gMach = mk('g', { class: 'machs' }, this.svg);
      this.gPins = mk('g', { class: 'pins' }, this.svg);
      this.handle = mk('rect', { class: 'handle', visibility: 'hidden' }, this.svg);

      if (!this.mini) this._bind();
      this.setPlant(opts.plant);
      if (window.ResizeObserver) new ResizeObserver(() => this._applyView()).observe(host);
    }

    setPlant(plant) {
      if (this.plant && this.plant.id === plant.id) return;
      this.plant = plant;
      const [x, y, w, h] = plant.view;
      this.base = { x, y, w, h };
      this.vb = { ...this.base };
      for (const g of [this.gArch, this.gZones, this.gMach, this.gPins]) g.textContent = '';
      this.mEls.clear(); this.zEls.clear(); this.pins.clear();
      this.svg.setAttribute('aria-label', `ผัง${plant.name}`);
      this._drawArch(plant.arch);
      this._applyView();
    }

    // ---------------------------------------------------------------
    //  วาด
    // ---------------------------------------------------------------
    _drawArch(list) {
      for (const s of list) {
        const [k, ...a] = s;
        // ผนังที่ปิดครบรอบ = พื้นห้อง/อาคาร (ลงสีพื้น)
        const pts = k === 'p' ? a[0].split(' ') : null;
        const floor = (k === 'r' && a[4] === 'wall') || (pts && a[1] === 'wall' && pts.length > 3 && pts[0] === pts[pts.length - 1]) ? ' a-floor' : '';
        if (k === 'r') mk('rect', { x: a[0], y: a[1], width: a[2], height: a[3], class: 'a-' + (a[4] || 'thin') + floor }, this.gArch);
        else if (k === 'c') mk('circle', { cx: a[0], cy: a[1], r: a[2], class: 'a-' + (a[3] || 'thin') }, this.gArch);
        else if (k === 'p') mk('polyline', { points: a[0], class: 'a-' + (a[1] || 'thin') + floor }, this.gArch);
        else if (k === 't' && !this.mini) {
          const t = mk('text', { x: a[0], y: a[1], 'font-size': a[3] || 7, class: 'a-text' }, this.gArch);
          if (a[4]) t.setAttribute('transform', `rotate(${a[4]} ${a[0]} ${a[1]})`);
          t.textContent = a[2];
        }
      }
    }

    /**
     * o: { zones, machines, broken: Map(machineId → {open, stopped}), stats: Map(zoneId → {open, stopped}),
     *      filterZone, selected: {type,id}|null, layer: 'machine'|'zone', flash: Set(machineId) }
     */
    render(o) {
      if (this.drag) { this.pending = o; return; }
      this.state = o;
      this.zones = o.zones.filter(z => z.plant === this.plant.id);
      this.machines = o.machines.filter(m => m.plant === this.plant.id);
      if (this.editable) this.host.dataset.layer = o.layer || 'machine';
      if (!this.mini) this._renderZones(o);
      this._renderMachines(o);
      this._applyView();
    }

    _renderZones(o) {
      const seen = new Set();
      for (const z of this.zones) {
        seen.add(z.id);
        let g = this.zEls.get(z.id);
        if (!g) {
          g = mk('g', { class: 'z', 'data-z': z.id, tabindex: 0, role: 'button' }, this.gZones);
          g._box = mk('rect', { class: 'z-box', rx: 4 }, g);
          g._hit = mk('rect', { class: 'z-hit' }, g);
          g._text = mk('text', { class: 'z-name' }, g);
          this.zEls.set(z.id, g);
        }
        const s = o.stats && o.stats.get(z.id);
        const open = s ? s.open : 0;
        g.classList.toggle('bad', open > 0);
        g.classList.toggle('stop', !!(s && s.stopped));
        g.classList.toggle('sel', !!(o.selected && o.selected.type === 'zone' && o.selected.id === z.id) || o.filterZone === z.id);
        const label = open ? `${z.name} · ค้าง ${open}` : z.name;
        if (g._text.textContent !== label) g._text.textContent = label;
        g._len = label.length;
        g.setAttribute('aria-label', `โซน ${label}`);
        this._placeZone(g, z);
      }
      for (const [id, g] of this.zEls) if (!seen.has(id)) { g.remove(); this.zEls.delete(id); }
    }

    _placeZone(g, z) {
      const fs = clamp(z.w / (Math.max(g._len, 1) * 0.5), 2.6, 8);
      const set = (e, x, y, w, h) => { e.setAttribute('x', x); e.setAttribute('y', y); e.setAttribute('width', Math.max(0, w)); e.setAttribute('height', Math.max(0, h)); };
      set(g._box, z.x, z.y, z.w, z.h);
      set(g._hit, z.x, z.y, z.w, Math.min(z.h, 11));
      g._text.setAttribute('x', z.x + 4);
      g._text.setAttribute('y', z.y + 2 + fs * 0.85);
      g._text.setAttribute('font-size', fs);
    }

    _renderMachines(o) {
      const seen = new Set();
      for (const m of this.machines) {
        seen.add(m.id);
        const b = o.broken && o.broken.get(m.id);
        let g = this.mEls.get(m.id);
        if (!g || g._shape !== m.shape) {
          if (g) g.remove();
          g = mk('g', this.mini ? { class: 'm' } : { class: 'm', 'data-m': m.id, tabindex: 0, role: 'button' }, this.gMach);
          g._shape = m.shape;
          g._box = mk(m.shape === 'circle' ? 'ellipse' : 'rect', { class: 'm-box' }, g);
          if (!this.mini) {
            g._code = mk('text', { class: 'm-code' }, g);
            g._det = mk('text', { class: 'm-det' }, g);
            g._title = mk('title', {}, g);
          }
          this.mEls.set(m.id, g);
        }
        g.classList.toggle('bad', !!b);
        g.classList.toggle('stop', !!(b && b.stopped));
        g.classList.toggle('verify', this.editable && !!m.verify);
        g.classList.toggle('dim', o.filterZone != null && m.zone_id !== o.filterZone);
        g.classList.toggle('sel', !!(o.selected && o.selected.type === 'machine' && o.selected.id === m.id));
        g.classList.toggle('is-new', !!(o.flash && o.flash.has(m.id)));
        if (!this.mini) {
          if (g._code.textContent !== m.name) g._code.textContent = m.name;
          const det = m.detail && m.detail !== m.name ? m.detail : '';
          if (g._det.textContent !== det) g._det.textContent = det;
          const status = b ? `เสีย — งานค้าง ${b.open}${b.stopped ? ' (เครื่องหยุด)' : ''}` : 'ปกติ';
          const label = `${m.name}${det ? ' ' + det : ''} — ${status}${this.editable && m.verify ? ' — รอตรวจรหัส' : ''}`;
          if (g._title.textContent !== label) { g._title.textContent = label; g.setAttribute('aria-label', label); }
        }
        this._placeMachine(g, m);
        this._pin(m, b);
      }
      for (const [id, g] of this.mEls) if (!seen.has(id)) { g.remove(); this.mEls.delete(id); }
      for (const [id, p] of this.pins) if (!seen.has(id)) { p.remove(); this.pins.delete(id); }
    }

    _placeMachine(g, m) {
      const b = g._box;
      const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
      if (m.shape === 'circle') {
        b.setAttribute('cx', cx); b.setAttribute('cy', cy); b.setAttribute('rx', m.w / 2); b.setAttribute('ry', m.h / 2);
      } else {
        b.setAttribute('x', m.x); b.setAttribute('y', m.y); b.setAttribute('width', m.w); b.setAttribute('height', m.h);
        b.setAttribute('rx', Math.min(2.5, m.w / 6, m.h / 6));
      }
      if (this.mini) return;

      // ตัวอักษร: กล่องสูงแคบให้หมุนแนวตั้ง แล้วคำนวณขนาดให้พอดีกล่อง
      const rot = m.h > m.w * 1.5 && m.h > 14;
      let W = (rot ? m.h : m.w) * 0.92, H = (rot ? m.w : m.h) * 0.92;
      if (m.shape === 'circle') { W *= 0.88; H *= 0.7; }
      const det = g._det.textContent;
      const showDet = det && H >= 13;
      const fs = Math.min(11, H * (showDet ? 0.48 : 0.72), W / (m.name.length * 0.62));
      const fd = showDet ? Math.min(fs * 0.72, H * 0.26, W / (det.length * 0.58)) : 0;
      const total = fs + (showDet ? fd * 1.3 : 0);
      const place = (t, dy, size) => {
        t.setAttribute('x', cx); t.setAttribute('y', cy + dy); t.setAttribute('font-size', size.toFixed(2));
        if (rot) t.setAttribute('transform', `rotate(-90 ${cx} ${cy})`); else t.removeAttribute('transform');
      };
      place(g._code, -total / 2 + fs / 2, fs);
      g._det.style.display = showDet ? '' : 'none';
      if (showDet) place(g._det, total / 2 - fd / 2, fd);
      g._fs = fs;
    }

    // ---------- ป้ายชี้เครื่องที่เสีย ----------
    _pin(m, b) {
      let p = this.pins.get(m.id);
      if (!b) { if (p) { p.remove(); this.pins.delete(m.id); } return; }
      if (!p) {
        p = mk('g', this.mini ? { class: 'pin' } : { class: 'pin', 'data-m': m.id }, this.gPins);
        if (this.mini) mk('circle', { class: 'pin-dot', r: 6, cy: 0 }, p);
        else {
          p._bg = mk('rect', { class: 'pin-bg', y: -27, height: 20, rx: 10 }, p);
          mk('path', { class: 'pin-bg', d: 'M-5 -8 L5 -8 L0 -1 Z' }, p);
          p._t = mk('text', { class: 'pin-text', y: -17 }, p);
        }
        this.pins.set(m.id, p);
      }
      p.classList.toggle('stop', !!b.stopped);
      p._m = m;
      if (p._t) {
        const txt = m.name + (b.stopped ? ' หยุด' : '');
        if (p._t.textContent !== txt) p._t.textContent = txt;
        const w = txt.length * 7.2 + 16;
        p._bg.setAttribute('x', -w / 2);
        p._bg.setAttribute('width', w);
      }
    }

    // ---------------------------------------------------------------
    //  มุมมอง
    // ---------------------------------------------------------------
    _metrics() {
      const r = this.svg.getBoundingClientRect();
      const scale = Math.min(r.width / this.vb.w, r.height / this.vb.h) || 0;
      return { r, scale, ox: r.left + (r.width - this.vb.w * scale) / 2, oy: r.top + (r.height - this.vb.h * scale) / 2 };
    }
    _toSvg(cx, cy) {
      const k = this._metrics();
      return { x: this.vb.x + (cx - k.ox) / k.scale, y: this.vb.y + (cy - k.oy) / k.scale };
    }
    get zoom() { return this.base.w / this.vb.w; }

    _applyView() {
      const v = this.vb, b = this.base;
      const cx = clamp(v.x + v.w / 2, b.x + Math.min(v.w, b.w) / 4, b.x + b.w - Math.min(v.w, b.w) / 4);
      const cy = clamp(v.y + v.h / 2, b.y + Math.min(v.h, b.h) / 4, b.y + b.h - Math.min(v.h, b.h) / 4);
      if (this.zoom <= 1.001) Object.assign(v, b);
      else { v.x = cx - v.w / 2; v.y = cy - v.h / 2; }
      this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
      const zoomed = this.zoom > 1.01;
      this.host.classList.toggle('zoomed', zoomed);
      this.svg.style.touchAction = this.editable || zoomed ? 'none' : 'pan-x pan-y';

      const { scale } = this._metrics();
      if (!scale) return;
      for (const p of this.pins.values()) {
        const m = p._m;
        if (this.mini) { p.setAttribute('transform', `translate(${m.x + m.w / 2} ${m.y + m.h / 2}) scale(${1 / scale})`); continue; }
        const g = this.mEls.get(m.id);
        p.style.display = g && g._fs * scale >= 9 ? 'none' : '';       // กล่องใหญ่พออ่านได้แล้ว ไม่ต้องมีป้าย
        p.setAttribute('transform', `translate(${m.x + m.w / 2} ${m.y}) scale(${1 / scale})`);
      }
      this._placeHandle(scale);
    }

    zoomAt(f, cx, cy) {
      const { r } = this._metrics();
      if (cx == null) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
      const p = this._toSvg(cx, cy);
      const w = clamp(this.vb.w / f, this.base.w / MAX_ZOOM, this.base.w);
      const k = w / this.vb.w;
      this.vb = { x: p.x - (p.x - this.vb.x) * k, y: p.y - (p.y - this.vb.y) * k, w, h: this.vb.h * k };
      this._applyView();
    }
    fit() { this.vb = { ...this.base }; this._applyView(); }

    /** กลางภาพปัจจุบัน (ใช้วางของใหม่ในโหมดแก้ไข) */
    center() { return { x: Math.round(this.vb.x + this.vb.w / 2), y: Math.round(this.vb.y + this.vb.h / 2) }; }

    /** ซูมไปที่เครื่อง แล้วกะพริบวงแหวนให้เห็น */
    focusMachine(id) {
      const m = this.machines.find(x => x.id === id);
      if (!m) return;
      const z = clamp(Math.max(this.base.w, this.base.h) / Math.max(m.w * 6, m.h * 6, 150), 1, MAX_ZOOM);
      const w = this.base.w / z, h = this.base.h / z;
      this.vb = { x: m.x + m.w / 2 - w / 2, y: m.y + m.h / 2 - h / 2, w, h };
      this._applyView();
      const g = this.mEls.get(id);
      if (g) {
        g.classList.remove('found');
        void g.getBoundingClientRect();
        g.classList.add('found');
        setTimeout(() => g.classList.remove('found'), 4000);
      }
    }

    // ---------------------------------------------------------------
    //  โต้ตอบ
    // ---------------------------------------------------------------
    _bind() {
      const s = this.svg;
      const bar = document.createElement('div');
      bar.className = 'pmap-bar';
      bar.innerHTML =
        '<button type="button" data-z="in" title="ขยาย" aria-label="ขยาย"><svg class="ico" aria-hidden="true"><use href="#i-plus"/></svg></button>' +
        '<button type="button" data-z="out" title="ย่อ" aria-label="ย่อ"><svg class="ico" aria-hidden="true"><use href="#i-minus"/></svg></button>' +
        '<button type="button" data-z="fit" title="แสดงทั้งโรง" aria-label="แสดงทั้งโรง"><svg class="ico" aria-hidden="true"><use href="#i-fit"/></svg></button>';
      bar.addEventListener('click', e => {
        const k = e.target.closest('button');
        if (!k) return;
        if (k.dataset.z === 'in') this.zoomAt(1.6);
        else if (k.dataset.z === 'out') this.zoomAt(1 / 1.6);
        else this.fit();
      });
      this.host.appendChild(bar);

      s.addEventListener('pointerdown', e => this._down(e));
      s.addEventListener('pointermove', e => this._move(e));
      s.addEventListener('pointerup', e => this._up(e, false));
      s.addEventListener('pointercancel', e => this._up(e, true));
      s.addEventListener('click', e => this._click(e));
      s.addEventListener('keydown', e => this._key(e));
      s.addEventListener('dblclick', e => { if (!this.editable) { e.preventDefault(); this.zoomAt(2, e.clientX, e.clientY); } });
      s.addEventListener('wheel', e => {
        if (!(e.ctrlKey || e.metaKey || document.fullscreenElement)) return;
        e.preventDefault();
        this.zoomAt(Math.exp(-clamp(e.deltaY, -40, 40) * 0.008), e.clientX, e.clientY);
      }, { passive: false });
    }

    _target(e) {
      const layer = this.state.layer || 'machine';
      const mg = e.target.closest('[data-m]'), zg = e.target.closest('[data-z]');
      if (this.editable) {
        if (e.target === this.handle && this.state.selected) return { ...this.state.selected, resize: true };
        if (layer === 'machine' && mg) return { type: 'machine', id: Number(mg.dataset.m) };
        if (layer === 'zone' && zg) return { type: 'zone', id: Number(zg.dataset.z) };
        return null;
      }
      if (mg) return { type: 'machine', id: Number(mg.dataset.m) };
      if (zg) return { type: 'zone', id: Number(zg.dataset.z) };
      return null;
    }
    _find(type, id) { return (type === 'machine' ? this.machines : this.zones).find(x => x.id === id); }

    _down(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.suppressClick = false;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.pointers.size === 2) {            // กางนิ้วซูม
        if (this.drag) this._cancelDrag();
        this.pan = null;
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
        this.suppressClick = true;
        return;
      }
      if (this.pointers.size > 2) return;

      if (this.editable) {
        const t = this._target(e);
        const obj = t && this._find(t.type, t.id);
        if (obj) {
          const p = this._toSvg(e.clientX, e.clientY);
          this.drag = { ...t, pid: e.pointerId, px: p.x, py: p.y, sx: e.clientX, sy: e.clientY, orig: { ...obj }, cur: { ...obj }, moved: false };
          this.svg.setPointerCapture(e.pointerId);
          e.preventDefault();
          if (this.opts.onSelect) this.opts.onSelect({ type: t.type, id: t.id });
          return;
        }
      }
      if (this.editable || this.zoom > 1.01) this.pan = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, vb: { ...this.vb }, on: false };
    }

    _move(e) {
      const pt = this.pointers.get(e.pointerId);
      if (pt) { pt.x = e.clientX; pt.y = e.clientY; }

      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this.zoomAt(d / this.pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
        this.pinch.d = d;
        return;
      }
      const g = this.drag;
      if (g && g.pid === e.pointerId) {
        if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return;
        g.moved = true;
        const p = this._toSvg(e.clientX, e.clientY);
        const dx = Math.round(p.x - g.px), dy = Math.round(p.y - g.py);
        g.cur = this._bounded(g.resize ? { ...g.orig, w: g.orig.w + dx, h: g.orig.h + dy } : { ...g.orig, x: g.orig.x + dx, y: g.orig.y + dy });
        this._preview(g.type, g.cur);
        return;
      }
      const n = this.pan;
      if (n && n.pid === e.pointerId) {
        const dx = e.clientX - n.sx, dy = e.clientY - n.sy;
        if (!n.on) {
          if (Math.hypot(dx, dy) < 5) return;
          n.on = true;
          this.suppressClick = true;
          this.svg.setPointerCapture(e.pointerId);
          this.host.classList.add('panning');
        }
        const { scale } = this._metrics();
        this.vb.x = n.vb.x - dx / scale;
        this.vb.y = n.vb.y - dy / scale;
        this._applyView();
      }
    }

    _up(e, cancel) {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pan && this.pan.pid === e.pointerId) { this.pan = null; this.host.classList.remove('panning'); }
      const g = this.drag;
      if (!g || g.pid !== e.pointerId) return;
      if (cancel) { this._cancelDrag(); return; }
      this.drag = null;
      this.suppressClick = true;
      const c = g.cur, o = g.orig;
      const pending = this.pending;
      this.pending = null;
      if (g.moved && (c.x !== o.x || c.y !== o.y || c.w !== o.w || c.h !== o.h)) {
        if (this.opts.onChange) this.opts.onChange(g.type, { ...c });
      } else if (pending) this.render(pending);
    }

    _cancelDrag() {
      const g = this.drag;
      this.drag = null;
      this._preview(g.type, g.orig);
      const pending = this.pending;
      this.pending = null;
      if (pending) this.render(pending);
    }

    _bounded(o) {
      const b = this.base;
      o.w = clamp(Math.round(o.w), 6, b.w);
      o.h = clamp(Math.round(o.h), 6, b.h);
      o.x = clamp(Math.round(o.x), b.x, b.x + b.w - o.w);
      o.y = clamp(Math.round(o.y), b.y, b.y + b.h - o.h);
      return o;
    }

    _preview(type, obj) {
      const g = (type === 'machine' ? this.mEls : this.zEls).get(obj.id);
      if (!g) return;
      if (type === 'machine') this._placeMachine(g, obj); else this._placeZone(g, obj);
      this._placeHandle(this._metrics().scale, obj);
    }

    _placeHandle(scale, obj) {
      const sel = this.editable && this.state.selected;
      const o = obj || (sel && this._find(sel.type, sel.id));
      if (!o || !scale) { this.handle.setAttribute('visibility', 'hidden'); return; }
      const s = (COARSE ? 24 : 14) / scale;
      this.handle.setAttribute('visibility', 'visible');
      this.handle.setAttribute('x', o.x + o.w - s / 2);
      this.handle.setAttribute('y', o.y + o.h - s / 2);
      this.handle.setAttribute('width', s);
      this.handle.setAttribute('height', s);
    }

    _click(e) {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (this.editable) {
        if (!this._target(e) && this.opts.onSelect) this.opts.onSelect(null);
        return;
      }
      const t = this._target(e);
      if (!t) return;
      if (t.type === 'machine' && this.opts.onMachine) this.opts.onMachine(t.id);
      else if (t.type === 'zone' && this.opts.onZone) this.opts.onZone(t.id);
    }

    _key(e) {
      const g = e.target.closest && e.target.closest('[data-m],[data-z]');
      if (!g) return;
      const t = g.dataset.m ? { type: 'machine', id: Number(g.dataset.m) } : { type: 'zone', id: Number(g.dataset.z) };
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (this.editable) { if (this.opts.onSelect) this.opts.onSelect(t); }
        else if (t.type === 'machine') { if (this.opts.onMachine) this.opts.onMachine(t.id); }
        else if (this.opts.onZone) this.opts.onZone(t.id);
        return;
      }
      if (!this.editable) return;
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const obj = dir && this._find(t.type, t.id);
      if (!obj) return;
      e.preventDefault();
      const c = this._bounded(e.shiftKey
        ? { ...obj, w: obj.w + dir[0], h: obj.h + dir[1] }
        : { ...obj, x: obj.x + dir[0], y: obj.y + dir[1] });
      this._preview(t.type, c);
      if (this.opts.onChange) this.opts.onChange(t.type, c);
    }
  }

  window.PlantMap = PlantMap;
})();
