/*
 * PlantMap — ผังโรงงานแบบเวกเตอร์ (SVG)
 *
 *   พื้นหลัง : ผนัง/ห้อง จาก js/layout-data.js
 *   โซน     : กรอบเส้นประ + ชื่อ + จำนวนงานค้าง
 *   เครื่อง  : กล่องสีเขียว = ปกติ/ปิดงานแล้ว, แดงกะพริบ = มีงานค้าง (เครื่องหยุดกะพริบเร็วกว่า)
 *             ถ้าซูมออกจนอ่านรหัสไม่ออก เครื่องที่เสียจะมีป้ายสีแดงขนาดคงที่ชี้ตำแหน่งให้
 *   ผังรวม   : setPlant([โรง 1, โรง 2, …]) วางทุกโรงในผังเดียว (มีชื่อโรง + จำนวนเครื่องเสียกำกับ)
 *   แนวนอน   : ผังที่สูงมาก (เช่น โรง 1) หมุนเป็นแนวนอนให้เองเมื่อกรอบกว้าง ทำให้ภาพใหญ่ขึ้น
 *             ปุ่มหมุนบนผังใช้สลับแนวตั้ง/แนวนอนเองได้
 *             ระบบเลือกการจัดวางที่ทำให้ภาพใหญ่ที่สุดในกรอบ และคำนวณใหม่เมื่อขนาดจอเปลี่ยน
 *   เฉพาะอาคาร (opts.crop): แสดงเฉพาะกรอบอาคารหลัก (plant.focus) ภาพจะใหญ่ขึ้น ไม่แสดงพื้นที่นอกอาคารเลย
 *             เครื่องนอกอาคารที่เสียมีป้ายเตือนมุมซ้ายล่าง (กดแล้วเปิดรายละเอียดเครื่อง)
 *
 *   ซูม: ปุ่ม + −, ดับเบิลคลิก, Ctrl+ล้อเมาส์ (เต็มจอใช้ล้อเมาส์ได้เลย), กางนิ้ว · เลื่อน: ลาก
 *   โหมดแก้ไข (editable): ไม่หมุนผัง · ลากย้าย, ลากมุมขวาล่างปรับขนาด, ลูกศร = ย้าย, Shift+ลูกศร = ปรับขนาด
 */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const GAP = 70;        // ผังรวม: ระยะห่างระหว่างโรง
  const TITLE = 84;      // ผังรวม: ที่ว่างเหนือกรอบโรงสำหรับชื่อโรง
  const PAD = 18;        // ผังรวม: ขอบในกรอบโรง
  const TALL = 1.25;     // สูง ÷ กว้าง เกินเท่านี้ = ผังแนวตั้ง (หมุนเป็นแนวนอนได้)
  const KEEP = 0.93;     // การจัดวางเดิมยังใหญ่ได้ ≥ 93% ของแบบที่ดีที่สุด → ไม่เปลี่ยน (ไม่ให้ผังกระโดดไปมา)
  const STRETCH = 2.6;   // ผังรวม: ยืดให้เต็มกรอบได้สูงสุดกี่เท่า (แนวนอนหรือแนวตั้ง)
  let uid = 0;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const COARSE = window.matchMedia('(pointer: coarse)').matches;

  function mk(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  /**
   * พิกัดในแบบของโรง → พิกัดบนผัง
   *   rot 0   : เลื่อนตำแหน่งอย่างเดียว
   *   rot -90 : หมุนทวนเข็ม 90° (ด้านบนของแบบไปอยู่ซ้าย ด้านซ้ายไปอยู่ล่าง)   (x, y) → (dx + y, dy − x)
   *   (X, Y)  : มุมซ้ายบนของผังโรงนี้หลังวางแล้ว
   *   area    : ส่วนของแบบที่แสดง [x, y, w, h] (plant.view หรือ plant.focus)
   *   sx, sy  : ขยาย/ย่อแนวนอน/แนวตั้งบนจอ (ผังรวมปรับแต่ละโรงไม่เท่ากัน และยืดให้เต็มกรอบได้)
   *             s = ค่าที่เล็กกว่า ใช้คิดขนาดตัวอักษร
   */
  function placement(plant, rot, X, Y, area, sx = 1, sy = sx) {
    const [vx, vy, vw, vh] = area;
    const s = Math.min(sx, sy);
    if (!rot) {
      return {
        plant, rot: 0, s, sx, sy, box: { x: X, y: Y, w: vw * sx, h: vh * sy },
        pt: (x, y) => ({ x: X + (x - vx) * sx, y: Y + (y - vy) * sy }),
        rect: r => ({ x: X + (r.x - vx) * sx, y: Y + (r.y - vy) * sy, w: r.w * sx, h: r.h * sy }),
      };
    }
    return {
      plant, rot: -90, s, sx, sy, box: { x: X, y: Y, w: vh * sx, h: vw * sy },
      pt: (x, y) => ({ x: X + (y - vy) * sx, y: Y + (vx + vw - x) * sy }),
      rect: r => ({ x: X + (r.y - vy) * sx, y: Y + (vx + vw - r.x - r.w) * sy, w: r.h * sx, h: r.w * sy }),
    };
  }
  const isTall = a => a[3] / a[2] > TALL;

  // ---------- จัดวางหลายโรง: กล่องโรง (ชื่อ + กรอบ) ต่อกันเป็นแถว/คอลัมน์ ----------
  const leaf = (p, rot, a, sx = 1, sy = sx) => {
    const cw0 = rot ? a[3] : a[2], ch0 = rot ? a[2] : a[3];       // ขนาดผังตามแบบ (หลังหมุน)
    const w = cw0 * sx + PAD * 2;
    const h = ch0 * sy + PAD * 2 + TITLE;
    return { w, h, put: (x, y) => [{ p, rot, sx, sy, cw0, ch0, x, y, w, h }] };
  };
  const row = ns => (ns.length === 1 ? ns[0] : {
    w: ns.reduce((a, n) => a + n.w, 0) + GAP * (ns.length - 1),
    h: Math.max(...ns.map(n => n.h)),
    put(x, y) { return ns.flatMap(n => { const r = n.put(x, y); x += n.w + GAP; return r; }); },
  });
  const col = ns => (ns.length === 1 ? ns[0] : {
    w: Math.max(...ns.map(n => n.w)),
    h: ns.reduce((a, n) => a + n.h, 0) + GAP * (ns.length - 1),
    put(x, y) { return ns.flatMap(n => { const r = n.put(x, y); y += n.h + GAP; return r; }); },
  });
  /** แบ่ง [0..n-1] เป็นกลุ่มทุกแบบ (กลุ่มเรียงตามสมาชิกตัวแรก) */
  function partitions(list) {
    if (!list.length) return [[]];
    const [first, ...rest] = list;
    const out = [];
    for (const p of partitions(rest)) {
      out.push([[first], ...p]);
      p.forEach((_, i) => out.push(p.map((g, j) => (j === i ? [first, ...g] : g))));
    }
    return out.map(p => p.sort((a, b) => a[0] - b[0]));
  }

  class PlantMap {
    /**
     * opts.plant      ข้อมูลจาก PLANT_LAYOUT.plants (หรือ array = ผังรวมหลายโรง)
     * opts.mini       true = แผนที่ย่อ (ไม่มีปุ่ม/ไม่โต้ตอบ/ไม่หมุน)
     * opts.editable   true = โหมดแก้ไข (ไม่หมุน ไม่ตัดขอบ)
     * opts.crop       true = แสดงเฉพาะกรอบอาคารหลัก (plant.focus)
     * opts.arrange    ผังรวม: ตำแหน่งโรงแบบตายตัว [['1'], ['3', '2']] = คอลัมน์ซ้าย→ขวา แต่ละคอลัมน์บน→ล่าง
     *                 (ไม่กำหนด = ระบบเลือกการจัดวางที่ภาพใหญ่ที่สุดเอง)
     * opts.onMachine(id), opts.onZone(id), opts.onPart(plantId)      โหมดดู
     * opts.onSelect({type,id}|null), opts.onChange(type, obj)        โหมดแก้ไข (type = 'machine' | 'zone')
     */
    constructor(host, opts) {
      this.host = host;
      this.opts = opts;
      this.editable = !!opts.editable;
      this.mini = !!opts.mini;
      this.mEls = new Map();
      this.zEls = new Map();
      this.pins = new Map();
      this.titles = new Map();
      this.machines = [];
      this.zones = [];
      this.parts = [];
      this.partOf = new Map();
      this.state = {};
      this.pointers = new Map();
      this.drag = null;
      this.pending = null;
      this.rotPref = 'auto';        // 'auto' | 0 | -90
      this.crop = !!opts.crop && !this.editable && !this.mini;    // แสดงเฉพาะกรอบอาคารหลัก
      this.clips = [];
      this.id = ++uid;
      this.cur = null;              // การจัดวางที่ใช้อยู่

      host.classList.add('pmap');
      if (this.editable) host.classList.add('pmap-edit');
      if (this.mini) host.classList.add('pmap-mini');
      host.innerHTML = '';
      this.svg = mk('svg', { class: 'pmap-svg', role: this.mini ? 'img' : 'group', preserveAspectRatio: 'xMidYMid meet' }, host);
      // เส้นตารางแบบกระดาษเขียนแบบ
      const pid = 'pm-grid-' + this.id;
      this.defs = mk('defs', {}, this.svg);
      const pat = mk('pattern', { id: pid, width: 50, height: 50, patternUnits: 'userSpaceOnUse' }, this.defs);
      mk('path', { d: 'M50 0H0V50', class: 'grid-line' }, pat);
      mk('rect', { x: -5000, y: -5000, width: 16000, height: 16000, fill: `url(#${pid})` }, this.svg);
      this.gParts = mk('g', { class: 'parts' }, this.svg);
      this.gArch = mk('g', { class: 'arch' }, this.svg);
      this.gZones = mk('g', { class: 'zones' }, this.svg);
      this.gMach = mk('g', { class: 'machs' }, this.svg);
      this.gPins = mk('g', { class: 'pins' }, this.svg);
      this.handle = mk('rect', { class: 'handle', visibility: 'hidden' }, this.svg);

      if (!this.mini) this._bind();
      this.setPlant(opts.plant);
      if (window.ResizeObserver) new ResizeObserver(() => { if (!this._layout()) this._applyView(); }).observe(host);
    }

    /** plant = โรงเดียว หรือ array หลายโรง (ผังรวม) */
    setPlant(plant) {
      const list = Array.isArray(plant) ? plant : [plant];
      const key = list.map(p => p.id).join(',');
      if (key === this.key) return;
      this.key = key;
      this.plants = list;
      this.multi = list.length > 1;
      this.plant = this.multi ? { id: 'all', name: 'ทุกโรง' } : list[0];
      this.svg.setAttribute('aria-label', this.multi ? `ผังรวม ${list.map(p => p.name).join(', ')}` : `ผัง${list[0].name}`);
      this._layout(true);
    }

    /** ส่วนของแบบที่แสดง: กรอบอาคารหลัก (ถ้าเปิดตัดขอบ) หรือทั้งพื้นที่ */
    _area(p) { return this.crop && p.focus ? p.focus : p.view; }
    /** มีผังแนวตั้งที่หมุนได้ไหม */
    get rotatable() {
      if (this.editable || this.mini) return false;
      if (this.multi && this.opts.arrange) return true;      // ผังรวม: หมุนทั้งภาพ แนวตั้ง ↔ แนวนอน
      return this.plants.some(p => isTall(this._area(p)));
    }
    /** ตอนนี้มีโรงที่หมุนเป็นแนวนอนอยู่ไหม */
    get rotated() { return this.parts.some(p => p.rot); }

    /** สลับแนวตั้ง ↔ แนวนอน (ผู้ใช้เลือกเอง ใช้ค่านี้จนกว่าจะโหลดหน้าใหม่) */
    toggleRotate() {
      this.rotPref = this.rotated ? 0 : -90;
      this._layout(true);
    }

    // ---------------------------------------------------------------
    //  จัดวาง
    // ---------------------------------------------------------------
    /**
     * แบบการจัดวางที่เป็นไปได้ — แต่ละแบบมี w, h (หน่วยผัง), items (ตำแหน่งแต่ละโรง), content (พื้นที่ผังรวม)
     * W, H = ขนาดกรอบบนจอ (ใช้คำนวณสเกลของผังรวมแบบกำหนดตำแหน่ง)
     */
    _candidates(W, H) {
      const rots = p => (!this.rotatable || !isTall(this._area(p)) ? [0] : this.rotPref === 'auto' ? [0, -90] : [this.rotPref]);
      if (!this.multi) {
        const p = this.plants[0], a = this._area(p);
        return rots(p).map(rot => ({
          w: rot ? a[3] : a[2], h: rot ? a[2] : a[3], content: a[2] * a[3],
          items: [{ p, rot, x: a[0], y: a[1] }],
        }));
      }
      const ps = this.plants;
      if (this.opts.arrange) {
        // ตำแหน่งตายตัว: คอลัมน์ซ้าย→ขวา แต่ละคอลัมน์บน→ล่าง (โรงที่ไม่ได้ระบุต่อท้ายเป็นคอลัมน์ใหม่)
        const byId = new Map(ps.map(p => [p.id, p]));
        const cols = this.opts.arrange.map(c => c.map(id => byId.get(id)).filter(Boolean)).filter(c => c.length);
        const used = new Set(cols.flat());
        const rest = ps.filter(p => !used.has(p));
        if (rest.length) cols.push(rest);
        // แนวตั้ง = ตามแบบ เรียงเป็นคอลัมน์ (opts.arrange)
        // แนวนอน = ทุกโรงหมุนทวนเข็ม 90° จัดตาม opts.arrangeWide ({ cols } หรือ { rows })
        //          ถ้าไม่กำหนด = หมุนทั้งภาพ (คอลัมน์ขวา→ซ้าย กลายเป็นแถวบน→ล่าง)
        //   จอกว้าง (กว้าง ≥ สูง) ใช้แนวนอนเอง ปุ่มหมุนบนผังสลับเองได้
        const aspect = W && H ? W / H : 1.6;
        const land = this.rotPref === -90 || (this.rotPref === 'auto' && aspect >= 1);
        if (!land) return [this._fill(cols, cols.map(() => 0), aspect)];
        const pick = groups => {
          const g = groups.map(r => r.map(id => byId.get(id)).filter(Boolean)).filter(r => r.length);
          const seen = new Set(g.flat());
          const left = ps.filter(p => !seen.has(p));
          if (left.length) g.push(left);
          return g;
        };
        const wide = this.opts.arrangeWide || {};
        if (wide.cols) {
          const wc = pick(wide.cols);
          return [this._fill(wc, wc.map(() => -90), aspect)];
        }
        return [this._fillRows(wide.rows ? pick(wide.rows) : [...cols].reverse().map(c => [...c]), aspect)];
      }
      let combos = [[]];
      for (const p of ps) combos = combos.flatMap(c => rots(p).map(r => [...c, r]));
      const groupsList = partitions(ps.map((_, i) => i));
      const vy = i => ps[i].view[1];
      const out = [];
      const content = items => items.reduce((t, i) => t + (i.w - PAD * 2) * (i.h - PAD * 2 - TITLE), 0);
      for (const rs of combos) {
        const L = ps.map((p, i) => leaf(p, rs[i], this._area(p)));
        for (const groups of groupsList) {
          const a = row(groups.map(g => col([...g].sort((i, j) => vy(i) - vy(j) || i - j).map(i => L[i]))));
          const b = col(groups.map(g => row(g.map(i => L[i]))));
          for (const n of [a, b]) {
            const items = n.put(0, 0);
            out.push({ w: n.w, h: n.h, framed: true, items, content: content(items) });
          }
        }
      }
      return out;
    }

    /**
     * ผังรวมแนวตั้ง (คอลัมน์): ปรับสเกลแต่ละโรงให้เต็มกรอบ (ไม่ยึดสเกลเดียวกัน)
     *   1) ในคอลัมน์เดียวกัน ขยายโรงที่แคบกว่าให้กว้างเท่าโรงที่กว้างที่สุด
     *   2) ขยายทุกคอลัมน์ให้สูงเท่ากัน
     *   3) ยืดให้พอดีสัดส่วนจอ (_stretch)
     */
    _fill(cols, rs, aspect) {
      const dims = (p, rot) => { const a = this._area(p); return rot ? [a[3], a[2]] : [a[2], a[3]]; };
      const C = cols.map((c, j) => {
        const ds = c.map(p => dims(p, rs[j]));
        const cw = Math.max(...ds.map(d => d[0]));
        const s = ds.map(d => cw / d[0]);
        return {
          c, rot: rs[j], s, cw,
          ch: ds.reduce((t, d, i) => t + d[1] * s[i], 0),
          F: c.length * (PAD * 2 + TITLE) + (c.length - 1) * GAP,
        };
      });
      const Hc = Math.max(...C.map(x => x.ch + x.F));
      for (const x of C) { x.k = (Hc - x.F) / x.ch; x.ww = x.k * x.cw; }
      this._weigh(C, x => x.c, x => x.ww);      // คอลัมน์ที่ให้น้ำหนักมาก ได้ความกว้างมากขึ้น (ยืดแนวนอน)
      const n = row(C.map(x => col(x.c.map((p, i) => leaf(p, x.rot, this._area(p), x.s[i] * x.k * x.m, x.s[i] * x.k)))));
      return this._stretch({ w: n.w, h: n.h, framed: true, items: n.put(0, 0) }, aspect);
    }

    /**
     * น้ำหนักขนาดในผังรวม (opts.weight เช่น { '1': 1.6 } = โรง 1 ได้พื้นที่มากกว่า 1.6 เท่า)
     * ใส่ x.m ให้แต่ละแถว/คอลัมน์ โดยผลรวมขนาดเท่าเดิม (ผังรวมไม่โตขึ้น แค่แบ่งพื้นที่ใหม่)
     */
    _weigh(list, plantsOf, sizeOf) {
      const W = this.opts.weight || {};
      for (const x of list) x.m = Math.max(...plantsOf(x).map(p => W[p.id] || 1));
      const tot = list.reduce((t, x) => t + sizeOf(x), 0);
      const totW = list.reduce((t, x) => t + sizeOf(x) * x.m, 0);
      for (const x of list) x.m *= tot / totW;
    }

    /**
     * ผังรวมแนวนอน: ทุกโรงหมุนทวนเข็ม 90° เรียงเป็นแถว (บน→ล่าง) แต่ละแถวเรียงซ้าย→ขวา
     *   1) ในแถวเดียวกัน ขยายโรงที่เตี้ยกว่าให้สูงเท่าโรงที่สูงที่สุด
     *   2) ขยายทุกแถวให้กว้างเท่ากัน
     *   3) ยืดให้พอดีสัดส่วนจอ (_stretch)
     */
    _fillRows(rows, aspect) {
      const dims = p => { const a = this._area(p); return [a[3], a[2]]; };     // หมุนแล้ว: กว้าง = สูงเดิม
      const R = rows.map(r => {
        const ds = r.map(dims);
        const rh = Math.max(...ds.map(d => d[1]));
        const s = ds.map(d => rh / d[1]);
        return { r, s, rh, rw: ds.reduce((t, d, i) => t + d[0] * s[i], 0), Fw: r.length * PAD * 2 + (r.length - 1) * GAP };
      });
      const Wc = Math.max(...R.map(x => x.rw + x.Fw));
      for (const x of R) { x.k = (Wc - x.Fw) / x.rw; x.hh = x.k * x.rh; }
      this._weigh(R, x => x.r, x => x.hh);      // แถวที่ให้น้ำหนักมาก ได้ความสูงมากขึ้น
      const n = col(R.map(x => row(x.r.map((p, i) => leaf(p, -90, this._area(p), x.s[i] * x.k, x.s[i] * x.k * x.m)))));
      return this._stretch({ w: n.w, h: n.h, framed: true, items: n.put(0, 0) }, aspect);
    }

    /**
     * ยืดผังรวมให้พอดีสัดส่วนกรอบบนจอ (ไม่เหลือที่ว่าง) — ยืดได้สูงสุด STRETCH เท่า
     * ยืดเฉพาะตัวผัง ชื่อโรงและตัวอักษรไม่ยืด (คำนวณขนาดตัวอักษรจากกล่องใหม่)
     */
    _stretch(c, aspect) {
      const want = aspect * c.h;           // ความกว้างที่ต้องการเมื่อความสูงเท่าเดิม
      if (c.w < want) {                    // ผังแคบกว่ากรอบ → ยืดแนวนอน
        const f = Math.min(STRETCH, want / c.w);
        for (const it of c.items) {
          const nw = it.w * f;
          it.x *= f;
          it.sx = (nw - PAD * 2) / it.cw0;
          it.w = nw;
        }
        c.w *= f;
      } else if (c.w > want) {             // ผังเตี้ยกว่ากรอบ → ยืดแนวตั้ง
        const f = Math.min(STRETCH, c.w / want);
        for (const it of c.items) {
          const nh = it.h * f;
          it.y *= f;
          it.sy = (nh - PAD * 2 - TITLE) / it.ch0;
          it.h = nh;
        }
        c.h *= f;
      }
      c.content = c.items.reduce((t, it) => t + it.cw0 * it.sx * it.ch0 * it.sy, 0);
      return c;
    }

    /** เลือกการจัดวางที่ผังใหญ่ที่สุด (กินพื้นที่จอมากสุด) แล้ววาดใหม่ถ้าเปลี่ยน — คืน true ถ้าวาดใหม่ */
    _layout(force) {
      const W = this.host.clientWidth, H = this.host.clientHeight;
      if (!force && !(W && H)) return false;
      // พื้นที่ผังที่เห็นบนจอ (หน่วยผัง × สเกลจอ²)
      const val = c => (W && H ? c.content * Math.min(W / c.w, H / c.h) ** 2 : 0);
      const cands = this._candidates(W, H);
      let best = cands[0];
      for (const c of cands) if (val(c) > val(best) * 1.001) best = c;
      // แบบเดิมยังดีพอ → ไม่วาดใหม่ (ไม่ให้ผังกระโดดไปมาตอนขนาดจอเปลี่ยนนิดหน่อย)
      if (!force && this.cur && val(this.cur) >= val(best) * KEEP * KEEP) return false;
      this.cur = best;

      const f = best.framed;
      this.parts = best.items.map(i => Object.assign(
        placement(i.p, i.rot, i.x + (f ? PAD : 0), i.y + (f ? PAD + TITLE : 0), this._area(i.p), i.sx || 1, i.sy || i.sx || 1), { block: i }));
      this.partOf = new Map(this.parts.map(p => [p.plant.id, p]));
      this.base = f ? { x: 0, y: 0, w: best.w, h: best.h } : { ...this.parts[0].box };
      this.vb = { ...this.base };
      for (const g of [this.gParts, this.gArch, this.gZones, this.gMach, this.gPins]) g.textContent = '';
      for (const c of this.clips) c.remove();
      this.clips = [];
      this.mEls.clear(); this.zEls.clear(); this.pins.clear(); this.titles.clear();
      for (const part of this.parts) {
        // ตัดขอบ: วาดเฉพาะในกรอบอาคาร (clip) และเครื่อง/โซนนอกกรอบไม่แสดง
        const fr = this.crop && part.plant.focus;
        let attrs = {};
        if (fr) {
          const id = `pm-clip-${this.id}-${part.plant.id}`;
          const cp = mk('clipPath', { id }, this.defs);
          mk('rect', { x: part.box.x, y: part.box.y, width: part.box.w, height: part.box.h }, cp);
          this.clips.push(cp);
          attrs = { 'clip-path': `url(#${id})` };
        }
        part.inside = !fr ? () => true : o => {
          const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
          return cx > fr[0] && cx < fr[0] + fr[2] && cy > fr[1] && cy < fr[1] + fr[3];
        };
        part.gA = mk('g', attrs, this.gArch);
        part.gZ = mk('g', attrs, this.gZones);
        part.gM = mk('g', attrs, this.gMach);
        if (f) this._drawFrame(part);
        this._drawArch(part);
      }
      this.host.classList.toggle('pmap-rot', this.rotated);
      this.host.classList.toggle('pmap-multi', this.multi);
      if (this.bar) {
        const b = this.bar.querySelector('[data-z="rot"]');
        b.hidden = !this.rotatable;
        const t = this.rotated ? 'แสดงผังแนวตั้ง (ตามแบบ)' : 'หมุนผังเป็นแนวนอน';
        b.title = t;
        b.setAttribute('aria-label', t);
        b.setAttribute('aria-pressed', this.rotated);
      }
      if (this.state.zones) this._draw(); else this._applyView();
      return true;
    }

    /** กรอบ + ชื่อโรง (ผังรวม) */
    _drawFrame(part) {
      const b = part.block;
      mk('rect', { x: b.x, y: b.y + TITLE, width: b.w, height: b.h - TITLE, rx: 18, class: 'part-frame' }, this.gParts);
      if (this.mini) return;
      const g = mk('g', { class: 'part-title', 'data-part': part.plant.id, tabindex: 0, role: 'button' }, this.gParts);
      g._hit = mk('rect', { x: b.x, y: b.y, width: b.w, height: TITLE - 10, rx: 14, class: 'part-hit' }, g);
      g._text = mk('text', { x: b.x + 14, y: b.y + (TITLE - 10) / 2, class: 'part-name' }, g);
      g._name = mk('tspan', { class: 'pn' }, g._text);
      g._ok = mk('tspan', { class: 'pk' }, g._text);
      g._bad = mk('tspan', { class: 'pb' }, g._text);
      g._go = mk('tspan', { class: 'pg' }, g._text);
      g._name.textContent = part.plant.name;
      g._go.textContent = '  ›';
      g._title = mk('title', {}, g);
      this.titles.set(part.plant.id, g);
    }

    _renderTitles(o) {
      const cnt = new Map(this.parts.map(p => [p.plant.id, { total: 0, bad: 0, stop: 0 }]));
      for (const m of this.allMachines) {       // นับทุกเครื่องของโรง รวมที่อยู่นอกกรอบอาคาร
        const c = cnt.get(m.plant);
        const b = o.broken && o.broken.get(m.id);
        c.total++;
        if (b) { c.bad++; if (b.stopped) c.stop++; }
      }
      for (const [id, g] of this.titles) {
        const c = cnt.get(id);
        g.classList.toggle('bad', c.bad > 0);
        g.classList.toggle('stop', c.stop > 0);
        g._ok.textContent = `   ปกติ ${c.total - c.bad}`;
        g._bad.textContent = c.bad ? `   เสีย ${c.bad}${c.stop ? ` (หยุด ${c.stop})` : ''}` : '';
        const label = `${g._name.textContent}: ปกติ ${c.total - c.bad} เครื่อง${c.bad ? ` เสีย ${c.bad} เครื่อง` : ''} — แตะเพื่อเปิดผังโรงนี้`;
        g._title.textContent = label;
        g.setAttribute('aria-label', label);
      }
    }

    // ---------------------------------------------------------------
    //  วาด
    // ---------------------------------------------------------------
    /** กรอบของ object (เครื่อง/โซน ที่มี plant, x, y, w, h) บนผัง */
    _srect(o) { return (this.partOf.get(o.plant) || this.parts[0]).rect(o); }

    _drawArch(part) {
      const sp = s => s.split(' ').map(q => { const [x, y] = q.split(',').map(Number); const p = part.pt(x, y); return `${p.x},${p.y}`; }).join(' ');
      for (const s of part.plant.arch) {
        const [k, ...a] = s;
        // ผนังที่ปิดครบรอบ = พื้นห้อง/อาคาร (ลงสีพื้น)
        const pts = k === 'p' ? a[0].split(' ') : null;
        const floor = (k === 'r' && a[4] === 'wall') || (pts && a[1] === 'wall' && pts.length > 3 && pts[0] === pts[pts.length - 1]) ? ' a-floor' : '';
        const G = part.gA;
        if (k === 'r') {
          const r = part.rect({ x: +a[0], y: +a[1], w: +a[2], h: +a[3] });
          mk('rect', { x: r.x, y: r.y, width: r.w, height: r.h, class: 'a-' + (a[4] || 'thin') + floor }, G);
        } else if (k === 'c') {
          const p = part.pt(+a[0], +a[1]);
          mk('ellipse', { cx: p.x, cy: p.y, rx: a[2] * part.sx, ry: a[2] * part.sy, class: 'a-' + (a[3] || 'thin') }, G);
        } else if (k === 'p') mk('polyline', { points: sp(a[0]), class: 'a-' + (a[1] || 'thin') + floor }, G);
        else if (k === 't' && !this.mini) {
          const p = part.pt(+a[0], +a[1]);
          // หมุนตามผัง แต่ไม่ให้กลับหัว
          let ang = (+a[4] || 0) + part.rot;
          if (ang <= -135) ang += 180; else if (ang > 135) ang -= 180;
          const t = mk('text', { x: p.x, y: p.y, 'font-size': (a[3] || 7) * part.s, class: 'a-text' }, G);
          if (ang) t.setAttribute('transform', `rotate(${ang} ${p.x} ${p.y})`);
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
      this._draw();
    }

    _draw() {
      const o = this.state;
      const inside = x => this.partOf.has(x.plant) && this.partOf.get(x.plant).inside(x);
      this.allMachines = o.machines.filter(m => this.partOf.has(m.plant));
      this.zones = o.zones.filter(inside);
      this.machines = this.allMachines.filter(inside);
      if (this.editable) this.host.dataset.layer = o.layer || 'machine';
      if (!this.mini) this._renderZones(o);
      this._renderMachines(o);
      if (this.titles.size) this._renderTitles(o);
      if (!this.mini) this._renderOutside(o, this.allMachines.filter(m => !inside(m)));
      this._applyView();
    }

    /** ป้ายเตือน: เครื่องที่เสียแต่อยู่นอกกรอบอาคาร (ไม่ได้แสดงบนผังตอนตัดขอบ) */
    _renderOutside(o, hidden) {
      const bad = hidden.filter(m => o.broken && o.broken.get(m.id));
      if (!this.outEl) {
        if (!bad.length) return;
        this.outEl = document.createElement('div');
        this.outEl.className = 'pmap-out';
        this.outEl.addEventListener('click', e => {
          const b = e.target.closest('[data-m]');
          if (b && this.opts.onMachine) this.opts.onMachine(Number(b.dataset.m));
        });
        this.host.appendChild(this.outEl);
      }
      this.outEl.hidden = !bad.length;
      const sig = bad.map(m => `${m.id}:${m.name}:${o.broken.get(m.id).stopped ? 1 : 0}`).join('|');
      if (sig === this.outSig) return;
      this.outSig = sig;
      this.outEl.textContent = '';
      const lab = document.createElement('span');
      lab.textContent = 'เสียนอกอาคาร';
      this.outEl.appendChild(lab);
      for (const m of bad) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.m = m.id;
        b.className = o.broken.get(m.id).stopped ? 'stop' : '';
        b.textContent = m.name;
        b.title = `${m.name} อยู่นอกอาคาร — กดเพื่อดูรายละเอียด`;
        this.outEl.appendChild(b);
      }
    }

    _renderZones(o) {
      const seen = new Set();
      for (const z of this.zones) {
        seen.add(z.id);
        let g = this.zEls.get(z.id);
        if (!g) {
          g = mk('g', { class: 'z', 'data-z': z.id, tabindex: 0, role: 'button' }, this.partOf.get(z.plant).gZ);
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

    /** สเกลของโรงที่ object นี้อยู่ (ผังรวมแต่ละโรงขยายไม่เท่ากัน) */
    _s(o) { return (this.partOf.get(o.plant) || this.parts[0]).s; }

    _placeZone(g, z) {
      const r = this._srect(z), s = this._s(z);
      const fs = clamp(r.w / (Math.max(g._len, 1) * 0.5), 2.6 * s, 8 * s);
      const set = (e, x, y, w, h) => { e.setAttribute('x', x); e.setAttribute('y', y); e.setAttribute('width', Math.max(0, w)); e.setAttribute('height', Math.max(0, h)); };
      set(g._box, r.x, r.y, r.w, r.h);
      set(g._hit, r.x, r.y, r.w, Math.min(r.h, 11 * s));
      g._text.setAttribute('x', r.x + 4 * s);
      g._text.setAttribute('y', r.y + 2 * s + fs * 0.85);
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
          g = mk('g', this.mini ? { class: 'm' } : { class: 'm', 'data-m': m.id, tabindex: 0, role: 'button' }, this.partOf.get(m.plant).gM);
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
      const r = this._srect(m), s = this._s(m);
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      if (m.shape === 'circle') {
        b.setAttribute('cx', cx); b.setAttribute('cy', cy); b.setAttribute('rx', r.w / 2); b.setAttribute('ry', r.h / 2);
      } else {
        b.setAttribute('x', r.x); b.setAttribute('y', r.y); b.setAttribute('width', r.w); b.setAttribute('height', r.h);
        b.setAttribute('rx', Math.min(2.5 * s, r.w / 6, r.h / 6));
      }
      if (this.mini) return;

      // ตัวอักษร: กล่องสูงแคบ (บนจอ) ให้เขียนแนวตั้ง แล้วคำนวณขนาดให้พอดีกล่อง
      const vert = r.h > r.w * 1.5 && r.h > 14 * s;
      let W = (vert ? r.h : r.w) * 0.92, H = (vert ? r.w : r.h) * 0.92;
      if (m.shape === 'circle') { W *= 0.88; H *= 0.7; }
      const det = g._det.textContent;
      const showDet = det && H >= 13 * s;
      const fs = Math.min(11 * s, H * (showDet ? 0.48 : 0.72), W / (m.name.length * 0.62));
      const fd = showDet ? Math.min(fs * 0.72, H * 0.26, W / (det.length * 0.58)) : 0;
      const total = fs + (showDet ? fd * 1.3 : 0);
      const place = (t, dy, size) => {
        t.setAttribute('font-size', size.toFixed(2));
        if (vert) {      // หมุน -90°: บรรทัดถัดไปอยู่ทางขวา
          t.setAttribute('x', cx + dy); t.setAttribute('y', cy);
          t.setAttribute('transform', `rotate(-90 ${cx + dy} ${cy})`);
        } else {
          t.setAttribute('x', cx); t.setAttribute('y', cy + dy);
          t.removeAttribute('transform');
        }
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
    /** ซูมได้สูงสุด: ให้กรอบเล็กสุดราว 110 หน่วยตามด้านยาว */
    get maxZoom() { return clamp(Math.max(this.base.w, this.base.h) / 110, 6, 40); }

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
        const r = this._srect(p._m);
        if (this.mini) { p.setAttribute('transform', `translate(${r.x + r.w / 2} ${r.y + r.h / 2}) scale(${1 / scale})`); continue; }
        const g = this.mEls.get(p._m.id);
        p.style.display = g && g._fs * scale >= 9 ? 'none' : '';       // กล่องใหญ่พออ่านได้แล้ว ไม่ต้องมีป้าย
        p.setAttribute('transform', `translate(${r.x + r.w / 2} ${r.y}) scale(${1 / scale})`);
      }
      // ชื่อโรงในผังรวม: ให้อ่านออกบนจอราว 17px (แต่ไม่ล้นที่ว่าง)
      const tf = clamp(17 / scale, 30, 60);
      for (const g of this.titles.values()) g._text.setAttribute('font-size', tf.toFixed(1));
      this._placeHandle(scale);
    }

    zoomAt(f, cx, cy) {
      const { r } = this._metrics();
      if (cx == null) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
      const p = this._toSvg(cx, cy);
      const w = clamp(this.vb.w / f, this.base.w / this.maxZoom, this.base.w);
      const k = w / this.vb.w;
      this.vb = { x: p.x - (p.x - this.vb.x) * k, y: p.y - (p.y - this.vb.y) * k, w, h: this.vb.h * k };
      this._applyView();
    }
    fit() { this.vb = { ...this.base }; this._applyView(); }

    /** กลางภาพปัจจุบัน (ใช้วางของใหม่ในโหมดแก้ไข — โหมดนี้ไม่หมุนผัง พิกัดผัง = พิกัดแบบ) */
    center() { return { x: Math.round(this.vb.x + this.vb.w / 2), y: Math.round(this.vb.y + this.vb.h / 2) }; }

    /** ซูมไปที่เครื่อง แล้วกะพริบวงแหวนให้เห็น */
    /** คืน false ถ้าเครื่องไม่อยู่บนผังนี้ (เช่น อยู่นอกอาคารตอนแสดงเฉพาะในอาคาร) */
    focusMachine(id) {
      const m = this.machines.find(x => x.id === id);
      if (!m) return false;
      const r = this._srect(m);
      const z = clamp(Math.max(this.base.w, this.base.h) / Math.max(r.w * 6, r.h * 6, 150), 1, this.maxZoom);
      const w = this.base.w / z, h = this.base.h / z;
      this.vb = { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
      this._applyView();
      const g = this.mEls.get(id);
      if (g) {
        g.classList.remove('found');
        void g.getBoundingClientRect();
        g.classList.add('found');
        setTimeout(() => g.classList.remove('found'), 4000);
      }
      return true;
    }

    // ---------------------------------------------------------------
    //  โต้ตอบ
    // ---------------------------------------------------------------
    _bind() {
      const s = this.svg;
      const bar = document.createElement('div');
      bar.className = 'pmap-bar';
      const btn = (z, icon, label) => `<button type="button" data-z="${z}" title="${label}" aria-label="${label}"><svg class="ico" aria-hidden="true"><use href="#i-${icon}"/></svg></button>`;
      bar.innerHTML = btn('in', 'plus', 'ขยาย') + btn('out', 'minus', 'ย่อ') + btn('fit', 'fit', 'แสดงทั้งผัง') + btn('rot', 'rotate', 'หมุนผัง');
      bar.addEventListener('click', e => {
        const k = e.target.closest('button');
        if (!k) return;
        if (k.dataset.z === 'in') this.zoomAt(1.6);
        else if (k.dataset.z === 'out') this.zoomAt(1 / 1.6);
        else if (k.dataset.z === 'rot') this.toggleRotate();
        else this.fit();
      });
      this.host.appendChild(bar);
      this.bar = bar;

      s.addEventListener('pointerdown', e => this._down(e));
      s.addEventListener('pointermove', e => this._move(e));
      s.addEventListener('pointerup', e => this._up(e, false));
      s.addEventListener('pointercancel', e => this._up(e, true));
      s.addEventListener('click', e => this._click(e));
      s.addEventListener('keydown', e => this._key(e));
      s.addEventListener('dblclick', e => {
        if (this.editable || e.target.closest('[data-part]')) return;
        e.preventDefault();
        this.zoomAt(2, e.clientX, e.clientY);
      });
      s.addEventListener('wheel', e => {
        // ปกติต้องกด Ctrl (ไม่แย่งการเลื่อนหน้า) — เต็มจอแล้วใช้ล้อเมาส์ซูมได้เลย
        if (!(e.ctrlKey || e.metaKey || document.fullscreenElement || this.host.closest('.is-full'))) return;
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
      const r = this._srect(o);
      const s = (COARSE ? 24 : 14) / scale;
      this.handle.setAttribute('visibility', 'visible');
      this.handle.setAttribute('x', r.x + r.w - s / 2);
      this.handle.setAttribute('y', r.y + r.h - s / 2);
      this.handle.setAttribute('width', s);
      this.handle.setAttribute('height', s);
    }

    _click(e) {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (this.editable) {
        if (!this._target(e) && this.opts.onSelect) this.opts.onSelect(null);
        return;
      }
      const part = e.target.closest('[data-part]');
      if (part) { if (this.opts.onPart) this.opts.onPart(part.dataset.part); return; }
      const t = this._target(e);
      if (!t) return;
      if (t.type === 'machine' && this.opts.onMachine) this.opts.onMachine(t.id);
      else if (t.type === 'zone' && this.opts.onZone) this.opts.onZone(t.id);
    }

    _key(e) {
      const part = e.target.closest && e.target.closest('[data-part]');
      if (part && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        if (this.opts.onPart) this.opts.onPart(part.dataset.part);
        return;
      }
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
