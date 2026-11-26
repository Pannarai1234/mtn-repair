/*
 * Data layer — หน้าเว็บเรียกใช้ผ่าน interface เดียวกันทั้ง 2 แบบ
 *
 *   LocalStore : เก็บใน localStorage (ช่วงทดสอบ)
 *   ApiStore   : เรียก Cloudflare Worker REST API (ข้อมูลอยู่ใน D1)
 *
 * เมธอดที่ทั้งสองต้องมี (คืนค่าเป็น Promise ทั้งหมด)
 *   ping()
 *   listZones()                 createZone(data)    updateZone(id, data)    deleteZone(id)
 *   listMachines()              createMachine(data) updateMachine(id, data) deleteMachine(id)
 *   listJobs()                  createJob(data)     closeJob(id, { note, closed_by })
 *   totalJobs  (number|null)    จำนวนงานทั้งหมดในฐานข้อมูล (null = ใช้ความยาวของ listJobs())
 *
 * ข้อผิดพลาดโยนเป็น StoreError(message, status) — status ใช้ค่าเดียวกับ HTTP
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const SETTINGS_KEY = 'mtn.settings';
  const DATA_VERSION = '2';             // รุ่นของข้อมูลใน localStorage (2 = มีตำแหน่งเครื่องบนผัง)

  class StoreError extends Error {
    constructor(message, status = 400) {
      super(message);
      this.name = 'StoreError';
      this.status = status;
    }
  }

  const nowISO = () => new Date().toISOString();
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const int = (v, min, max, def) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const flag = v => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
  const normCode = window.PLANT_LAYOUT.normCode;

  // ---------- validation (ให้ผลเหมือนฝั่ง Worker) ----------
  function zoneInput(b) {
    const name = str(b.name, 60);
    if (!name) throw new StoreError('กรุณาระบุชื่อโซน');
    return {
      name,
      plant: str(b.plant, 10) || '1',
      x: int(b.x, 0, 10000, 0),
      y: int(b.y, 0, 10000, 0),
      w: int(b.w, 6, 10000, 120),
      h: int(b.h, 6, 10000, 80),
    };
  }

  /** others = เครื่องอื่นทั้งหมด (ใช้กันรหัสซ้ำ) */
  function machineInput(b, zones, others) {
    const name = str(b.name, 80);
    if (!name) throw new StoreError('กรุณาระบุรหัสเครื่องจักร');
    const key = normCode(name);
    if (others.some(m => normCode(m.name) === key)) throw new StoreError(`มีเครื่องรหัส ${name} อยู่แล้ว`, 409);
    const zone_id = (b.zone_id === '' || b.zone_id == null) ? null : Number(b.zone_id);
    if (zone_id != null && !zones.some(z => z.id === zone_id)) throw new StoreError('ไม่พบโซนที่เลือก');
    return {
      name,
      detail: str(b.detail, 120),
      plant: str(b.plant, 10) || '1',
      zone_id,
      x: int(b.x, 0, 10000, 0),
      y: int(b.y, 0, 10000, 0),
      w: int(b.w, 6, 10000, 40),
      h: int(b.h, 6, 10000, 30),
      shape: b.shape === 'circle' ? 'circle' : 'rect',
      verify: flag(b.verify),
    };
  }
  function jobInput(b, machines) {
    const machine_id = Number(b.machine_id);
    if (!machines.some(m => m.id === machine_id)) throw new StoreError('ไม่พบเครื่องจักรที่เลือก');
    const problem = str(b.problem, 1000);
    if (!problem) throw new StoreError('กรุณาระบุปัญหาที่พบ');
    return {
      machine_id,
      problem,
      impact: str(b.impact, 1000),
      stopped: flag(b.stopped),
      reported_by: str(b.reported_by, 60) || null,
    };
  }

  // =====================================================================
  //  LocalStore — localStorage
  // =====================================================================
  class LocalStore {
    constructor(prefix = 'mtn.db.') {
      this.mode = 'local';
      this.p = prefix;
      this.totalJobs = null;
    }

    _get(t) {
      try { return JSON.parse(localStorage.getItem(this.p + t)) || []; } catch { return []; }
    }
    _set(t, rows) {
      try {
        localStorage.setItem(this.p + t, JSON.stringify(rows));
      } catch {
        throw new StoreError('บันทึกไม่ได้: พื้นที่ localStorage เต็มหรือถูกปิดใช้งาน', 507);
      }
    }
    _nextId(t) {
      const k = this.p + 'seq.' + t;
      const max = this._get(t).reduce((m, r) => Math.max(m, r.id), 0);
      const n = Math.max(Number(localStorage.getItem(k)) || 0, max) + 1;
      localStorage.setItem(k, String(n));
      return n;
    }

    async ping() { return { ok: true, mode: 'local' }; }

    // ----- zones -----
    async listZones() { return this._get('zones').sort((a, b) => a.id - b.id); }

    async createZone(b) {
      const input = zoneInput(b);
      const z = { id: this._nextId('zones'), ...input };
      this._set('zones', [...this._get('zones'), z]);
      return z;
    }

    async updateZone(id, b) {
      const rows = this._get('zones');
      const i = rows.findIndex(r => r.id === id);
      if (i < 0) throw new StoreError('ไม่พบโซน', 404);
      rows[i] = { id, ...zoneInput({ ...rows[i], ...b }) };
      this._set('zones', rows);
      return rows[i];
    }

    async deleteZone(id) {
      const rows = this._get('zones');
      if (!rows.some(r => r.id === id)) throw new StoreError('ไม่พบโซน', 404);
      this._set('machines', this._get('machines').map(m => m.zone_id === id ? { ...m, zone_id: null } : m));
      this._set('zones', rows.filter(r => r.id !== id));
      return { ok: true, id };
    }

    // ----- machines -----
    async listMachines() { return this._get('machines').sort((a, b) => a.id - b.id); }

    async createMachine(b) {
      const input = machineInput(b, this._get('zones'), this._get('machines'));
      const m = { id: this._nextId('machines'), ...input };
      this._set('machines', [...this._get('machines'), m]);
      return m;
    }

    async updateMachine(id, b) {
      const rows = this._get('machines');
      const i = rows.findIndex(r => r.id === id);
      if (i < 0) throw new StoreError('ไม่พบเครื่องจักร', 404);
      rows[i] = { id, ...machineInput({ ...rows[i], ...b }, this._get('zones'), rows.filter(r => r.id !== id)) };
      this._set('machines', rows);
      return rows[i];
    }

    async deleteMachine(id) {
      const rows = this._get('machines');
      if (!rows.some(r => r.id === id)) throw new StoreError('ไม่พบเครื่องจักร', 404);
      const open = this._get('jobs').filter(j => j.machine_id === id && j.status === 'open').length;
      if (open) throw new StoreError(`ลบไม่ได้: เครื่องนี้ยังมีงานค้าง ${open} งาน`, 409);
      this._set('machines', rows.filter(r => r.id !== id));
      return { ok: true, id };
    }

    // ----- jobs -----
    async listJobs() { return this._get('jobs').sort((a, b) => b.id - a.id); }

    async createJob(b) {
      const now = nowISO();
      const j = {
        id: this._nextId('jobs'),
        ...jobInput(b, this._get('machines')),
        status: 'open',
        created_at: now,
        closed_at: null,
        note: null,
        closed_by: null,
        updated_at: now,
      };
      this._set('jobs', [...this._get('jobs'), j]);
      return j;
    }

    async closeJob(id, b) {
      const note = str(b && b.note, 2000);
      if (!note) throw new StoreError('กรุณาบันทึกวิธีแก้ไขก่อนปิดงาน');
      const rows = this._get('jobs');
      const i = rows.findIndex(r => r.id === id);
      if (i < 0) throw new StoreError('ไม่พบงาน', 404);
      if (rows[i].status !== 'open') throw new StoreError('งานนี้ถูกปิดไปแล้ว', 409);
      const now = nowISO();
      rows[i] = { ...rows[i], status: 'closed', closed_at: now, note, closed_by: str(b.closed_by, 60) || null, updated_at: now };
      this._set('jobs', rows);
      return rows[i];
    }

    // ----- เฉพาะโหมดทดสอบ -----

    /**
     * เตรียมข้อมูลครั้งแรก: โหลดผังเครื่องจักรจาก js/layout-data.js
     * ถ้ามีข้อมูลรุ่นเก่า (ก่อนมีผังเครื่อง) จะสำรองไว้ที่ mtn.backup.v1.* ก่อน ไม่ลบทิ้ง
     * คืนค่า 'ready' | 'seeded' | 'migrated'
     */
    prepare() {
      if (localStorage.getItem(this.p + 'version') === DATA_VERSION) return 'ready';
      const old = ['zones', 'machines', 'jobs'].map(t => [t, localStorage.getItem(this.p + t)]).filter(([, v]) => v !== null);
      old.forEach(([t, v]) => localStorage.setItem('mtn.backup.v1.' + t, v));
      this.seedLayout();
      return old.length ? 'migrated' : 'seeded';
    }

    /** โหลดโซน/เครื่องจักรจากแบบแปลนใหม่ทั้งหมด และล้างงานแจ้งซ่อม */
    seedLayout() {
      const { zones, machines } = window.PLANT_LAYOUT.build();
      ['zones', 'machines', 'jobs'].forEach(t => localStorage.removeItem(this.p + 'seq.' + t));
      this._set('zones', zones);
      this._set('machines', machines);
      this._set('jobs', []);
      localStorage.setItem(this.p + 'version', DATA_VERSION);
    }

    clearJobs() {
      this._set('jobs', []);
      localStorage.removeItem(this.p + 'seq.jobs');
    }

    /** สุ่มเครื่องให้เสีย เพื่อดูสีแดงบนผัง */
    async addDemoJobs(n = 3) {
      const busy = new Set(this._get('jobs').filter(j => j.status === 'open').map(j => j.machine_id));
      const free = this._get('machines').filter(m => !busy.has(m.id));
      const problems = ['มีเสียงดังผิดปกติ', 'มอเตอร์ไม่หมุน', 'น้ำมันรั่ว', 'เซนเซอร์ไม่ทำงาน', 'หน้าจอขึ้น Alarm'];
      for (let i = 0; i < n && free.length; i++) {
        const m = free.splice(Math.floor(Math.random() * free.length), 1)[0];
        await this.createJob({
          machine_id: m.id, problem: `[ตัวอย่าง] ${problems[i % problems.length]}`, impact: 'ทดสอบระบบ',
          stopped: i === 0 ? 1 : 0, reported_by: 'ตัวอย่าง',
        });
      }
    }
  }
  // =====================================================================
  //  ApiStore — Cloudflare Worker
  // =====================================================================
  const FULL_RELOAD_MS = 10 * 60 * 1000;  // โหลดใหม่ทั้งหมดทุก 10 นาที กันข้อมูลคลาดเคลื่อน
  const SINCE_OVERLAP_MS = 60 * 1000;     // ดึงย้อนหลังเผื่อ 60 วิ กันพลาดจากเวลาเซิร์ฟเวอร์ไม่ตรงกัน

  class ApiStore {
    constructor(base) {
      this.mode = 'api';
      this.base = String(base || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(this.base)) throw new StoreError('ยังไม่ได้ตั้งค่า URL ของ API');
      this.jobs = new Map();
      this.maxUpdated = null;
      this.lastFull = 0;
      this.totalJobs = null;
    }

    async _req(method, path, body) {
      const headers = { ...window.Auth.authHeaders() };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetch(this.base + path, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          cache: 'no-store',
        });
      } catch {
        throw new StoreError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 0);
      }
      let data = null;
      try { data = await res.json(); } catch { /* ไม่มี body */ }
      if (res.status === 401) window.dispatchEvent(new CustomEvent('auth:unauthorized'));
      if (!res.ok) throw new StoreError((data && data.error) || `เซิร์ฟเวอร์ตอบกลับผิดพลาด (${res.status})`, res.status);
      return { data, res };
    }

    async ping() { return (await this._req('GET', '/health')).data; }

    // ----- zones -----
    async listZones() { return (await this._req('GET', '/zones')).data; }
    async createZone(b) { return (await this._req('POST', '/zones', b)).data; }
    async updateZone(id, b) { return (await this._req('PUT', `/zones/${id}`, b)).data; }
    async deleteZone(id) { return (await this._req('DELETE', `/zones/${id}`)).data; }

    // ----- machines -----
    async listMachines() { return (await this._req('GET', '/machines')).data; }
    async createMachine(b) { return (await this._req('POST', '/machines', b)).data; }
    async updateMachine(id, b) { return (await this._req('PUT', `/machines/${id}`, b)).data; }
    async deleteMachine(id) { return (await this._req('DELETE', `/machines/${id}`)).data; }

    // ----- jobs -----
    /**
     * โหลดครั้งแรก: งานค้างทั้งหมด + งานล่าสุด N รายการ
     * ครั้งต่อไป: ดึงเฉพาะงานที่เปลี่ยนแปลง (?since=) แล้วรวมเข้ากับที่มีอยู่ — ประหยัด rows read ของ D1
     */
    async listJobs() {
      const full = !this.maxUpdated || Date.now() - this.lastFull > FULL_RELOAD_MS;
      if (full) {
        const { data, res } = await this._req('GET', `/jobs?limit=${CFG.RECENT_JOBS || 300}`);
        this.jobs = new Map(data.map(j => [j.id, j]));
        this.maxUpdated = null;
        this.lastFull = Date.now();
        this._readTotal(res);
      } else {
        const since = new Date(Date.parse(this.maxUpdated) - SINCE_OVERLAP_MS).toISOString();
        const { data, res } = await this._req('GET', `/jobs?since=${encodeURIComponent(since)}`);
        data.forEach(j => this.jobs.set(j.id, j));
        this._readTotal(res);
      }
      for (const j of this.jobs.values()) {
        if (!this.maxUpdated || j.updated_at > this.maxUpdated) this.maxUpdated = j.updated_at;
      }
      return [...this.jobs.values()].sort((a, b) => b.id - a.id);
    }

    _readTotal(res) {
      const h = res.headers.get('X-Total-Count');
      this.totalJobs = h == null ? null : Math.max(Number(h) || 0, this.jobs.size);
    }

    async createJob(b) {
      const { data } = await this._req('POST', '/jobs', b);
      this.jobs.set(data.id, data);
      if (this.totalJobs != null) this.totalJobs = Math.max(this.totalJobs, data.id);
      return data;
    }

    async closeJob(id, b) {
      const { data } = await this._req('PUT', `/jobs/${id}/close`, b);
      this.jobs.set(data.id, data);
      return data;
    }
  }

  // =====================================================================
  //  เลือก store ตามค่าตั้ง
  // =====================================================================
  function getSettings() {
    if (!CFG.ALLOW_SETTINGS_OVERRIDE) return {};
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function resolveSettings() {
    const s = getSettings();
    return {
      mode: s.mode || CFG.MODE || 'local',
      apiBase: s.apiBase != null ? s.apiBase : (CFG.API_BASE || ''),
    };
  }

  /** สร้าง store ตามค่าตั้ง — ถ้าโหมด API แต่ยังไม่ได้ใส่ URL จะโยน StoreError */
  function create() {
    const { mode, apiBase } = resolveSettings();
    return mode === 'api' ? new ApiStore(apiBase) : new LocalStore();
  }

  window.Store = { create, resolveSettings, getSettings, saveSettings, LocalStore, ApiStore, StoreError };
})();
