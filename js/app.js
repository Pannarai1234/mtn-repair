/*
 * ตัวควบคุมหลักของหน้าเว็บ
 * ไม่เรียก localStorage/fetch โดยตรง — ใช้ผ่าน `store` (ดู js/store.js) เท่านั้น
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const { Auth, Sound, Store, PlantMap } = window;
  const PLANTS = window.PLANT_LAYOUT.plants;
  const norm = window.PLANT_LAYOUT.normCode;
  const plantById = id => PLANTS.find(p => p.id === id) || PLANTS[0];
  const plantName = id => (PLANTS.find(p => p.id === id) || { name: `โรง ${id}` }).name;

  // =====================================================================
  //  helpers
  // =====================================================================
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const byName = (a, b) => a.name.localeCompare(b.name, 'th', { numeric: true });
  const isStopped = j => Number(j.stopped) === 1;
  /** ไอคอนจาก sprite ใน index.html */
  const ico = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  /** ป้ายรหัสเครื่อง */
  const tag = (name, bad, cls = '') => `<span class="tag ${bad ? 'bad' : ''} ${cls}">${esc(name)}</span>`;

  function fmtTime(iso, withYear) {
    if (!iso) return '–';
    return new Date(iso).toLocaleString('th-TH', {
      day: 'numeric', month: 'short', ...(withYear ? { year: '2-digit' } : {}),
      hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtDur(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return 'ไม่ถึง 1 นาที';
    if (m < 60) return `${m} นาที`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ชม.${m % 60 ? ` ${m % 60} นาที` : ''}`;
    const d = Math.floor(h / 24);
    return `${d} วัน${h % 24 ? ` ${h % 24} ชม.` : ''}`;
  }

  /** ผู้ใช้กำลังโฟกัส/พิมพ์อยู่ใน element นี้หรือไม่ */
  const focusIn = el => !!el && el.contains(document.activeElement) && document.activeElement !== document.body;

  /** render เฉพาะเมื่อข้อมูลเปลี่ยน และไม่ทับช่องที่ผู้ใช้กำลังพิมพ์ */
  const sigs = new Map();
  function patch(el, key, deps, html, { force = false, keepFocus = false } = {}) {
    const sig = JSON.stringify(deps);
    if (!force && sigs.get(key) === sig) return false;
    const focused = focusIn(el);
    if (!force && focused && !keepFocus) return false;
    const v = focused && keepFocus ? document.activeElement.dataset.v : null;   // แถบปุ่ม: คืนโฟกัสให้ปุ่มเดิม
    sigs.set(key, sig);
    el.innerHTML = typeof html === 'function' ? html() : html;
    if (v) { const b = el.querySelector(`[data-v="${v}"]`); if (b) b.focus({ preventScroll: true }); }
    return true;
  }

  function toast(msg, type = 'info', { ms = 3500, onClick } = {}) {
    const box = $('#toasts');
    // dialog แบบ modal อยู่ชั้นบนสุด — ย้ายกล่องแจ้งเตือนเข้าไปใน dialog ไม่งั้นจะโดนบัง
    const host = document.querySelector('dialog[open]') || document.fullscreenElement || document.body;
    if (box.parentElement !== host) host.appendChild(box);
    const max = window.matchMedia('(max-width: 760px)').matches ? 2 : 4;   // จอมือถือ: ไม่ให้บังทั้งจอ
    while (box.children.length >= max) box.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' || type === 'alert' ? 'alert' : 'status');
    const icon = { ok: 'check-circle', error: 'alert', alert: 'stop', warn: 'bell' }[type] || 'bell';
    el.innerHTML = `${ico(icon)}<div class="toast-msg"></div><button type="button" class="toast-x" aria-label="ปิด">${ico('x')}</button>`;
    el.querySelector('.toast-msg').textContent = msg;
    const remove = () => {
      clearTimeout(timer);
      el.classList.add('out');
      setTimeout(() => el.remove(), 250);
    };
    const timer = setTimeout(remove, ms);
    el.querySelector('.toast-x').addEventListener('click', e => { e.stopPropagation(); remove(); });
    if (onClick) {
      el.classList.add('clickable');
      el.addEventListener('click', () => { onClick(); remove(); });
    }
    box.appendChild(el);
  }

  /**
   * กล่องยืนยันในหน้าเว็บ — ใช้แทน window.confirm()
   * เพราะบางเบราว์เซอร์ (in-app browser ของแอปแชท, webview) บล็อก confirm() แล้วตอบ "ยกเลิก" เสมอ
   * คืนค่า Promise<boolean>
   */
  function ask(message, { ok = 'ยืนยัน', danger = true } = {}) {
    const dlg = $('#confirm-dialog');
    if (dlg.open) dlg.close('cancel');
    $('#cf-msg').textContent = message;
    const okBtn = $('#cf-ok');
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
    dlg.returnValue = '';
    return new Promise(resolve => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  }

  // =====================================================================
  //  state
  // =====================================================================
  const S = {
    user: null,
    view: null,
    zones: [],
    machines: [],
    jobs: [],
    metaAt: 0,
    loaded: false,          // โหลดงานรอบแรกแล้ว (ใช้แยกงานใหม่ vs งานเดิม)
    seen: new Set(),        // id งานที่เคยเห็น
    mine: new Set(),        // id งานที่แท็บนี้เพิ่งส่ง (ไม่ต้องส่งเสียงเตือนตัวเอง)
    flash: new Map(),       // machineId → เวลาหมดเอฟเฟกต์ "งานใหม่"
    writes: 0,              // จำนวนการบันทึกที่กำลังทำงาน
    metaGen: 0,             // เพิ่มทุกครั้งที่มีการบันทึก ใช้ทิ้งผลดึงข้อมูลที่ค้างมาก่อนการแก้ไข
    online: true,
    lastOk: null,
    zoneFilter: null,
    jobsStatus: 'all',
    jobsQ: '',
    jobsShow: 100,
    mQ: '',
    plant: 'all',           // โรงที่แสดงในหน้าติดตามงาน ('all' = ภาพรวม)
    mdStatus: 'all',
    rPlant: 'all',          // หน้าแจ้งซ่อม: โรง / คำค้น
    rQ: '',
    rPick: null,            // id เครื่องที่เลือกไว้ในหน้าแจ้งซ่อม
    pickPlant: PLANTS[0].id,
    adminPlant: PLANTS[0].id,
    layer: 'machine',       // หน้าตั้งค่า: แก้เครื่องจักร หรือโซน
    selected: null,         // { type: 'machine' | 'zone', id }
    adminTab: 'map',
    mFilter: 'all',
    mShow: 60,
    dialogJob: null,
  };

  let store;
  let boardMap;
  let adminMap;
  let overview = [];
  let pickMap = null;       // ผังในหน้าต่าง "เลือกจากผัง" (สร้างเมื่อเปิดครั้งแรก)

  const VIEWS = [
    { id: 'report', label: 'แจ้งซ่อม', sub: 'เลือกเครื่อง บอกอาการ แล้วส่งให้ช่าง', icon: 'report', perm: 'job:create' },
    { id: 'board', label: 'ติดตามงาน', sub: 'สถานะเครื่องจักรทุกโรง อัปเดตอัตโนมัติ', icon: 'board', perm: 'job:view' },
    { id: 'admin', label: 'ตั้งค่า', sub: 'ผังโรงงาน เครื่องจักร และระบบ', icon: 'sliders', perm: 'layout:edit' },
  ];
  const HOME = { employee: 'report', tech: 'board', admin: 'admin' };

  // =====================================================================
  //  derived data
  // =====================================================================
  function derive() {
    const zoneById = new Map(S.zones.map(z => [z.id, z]));
    const machineById = new Map(S.machines.map(m => [m.id, m]));
    const open = S.jobs.filter(j => j.status === 'open');
    const zoneStats = new Map();
    const broken = new Map();      // เครื่องที่มีงานค้าง → { open, stopped }
    for (const j of open) {
      const m = machineById.get(j.machine_id);
      let b = broken.get(j.machine_id);
      if (!b) broken.set(j.machine_id, (b = { open: 0, stopped: 0 }));
      b.open++;
      if (isStopped(j)) b.stopped++;
      const zid = m && zoneById.has(m.zone_id) ? m.zone_id : null;
      if (zid == null) continue;
      let s = zoneStats.get(zid);
      if (!s) zoneStats.set(zid, (s = { open: 0, stopped: 0 }));
      s.open++;
      if (isStopped(j)) s.stopped++;
    }
    const stoppedMachines = new Set(open.filter(isStopped).map(j => j.machine_id));
    const now = Date.now();
    const flash = new Set();
    for (const [mid, until] of S.flash) {
      if (until > now) flash.add(mid); else S.flash.delete(mid);
    }
    return { zoneById, machineById, open, zoneStats, broken, stoppedMachines, flash };
  }

  const machineLabel = (X, id) => {
    const m = X.machineById.get(id);
    return m ? m.name : `เครื่อง #${id} (ถูกลบ)`;
  };
  const machineFull = m => m.detail && m.detail !== m.name ? `${m.name} · ${m.detail}` : m.name;
  /** "โรง 2 · NISSAN (3)" */
  const locText = (X, m) => {
    const z = m && X.zoneById.get(m.zone_id);
    if (!m) return 'ไม่ทราบตำแหน่ง';
    if (!z) return plantName(m.plant);
    return z.name.startsWith('โรง ') ? z.name : `${plantName(m.plant)} · ${z.name}`;
  };
  const locOf = (X, machineId) => locText(X, X.machineById.get(machineId));
  const zoneOf = (X, machineId) => {
    const m = X.machineById.get(machineId);
    return (m && X.zoneById.get(m.zone_id)) || null;
  };
  const jobZoneId = (X, j) => {
    const z = zoneOf(X, j.machine_id);
    return z ? z.id : null;
  };

  function statusBadge(j) {
    return j.status === 'open'
      ? `<span class="badge badge-warn">${ico('clock')}ค้าง</span>`
      : `<span class="badge badge-ok">${ico('check')}ปิดแล้ว</span>`;
  }
  function stoppedBadge(j) {
    return isStopped(j)
      ? `<span class="badge badge-danger">${ico('stop')}หยุดทำงาน</span>`
      : '<span class="badge badge-muted">ยังทำงานได้</span>';
  }

  // =====================================================================
  //  store / data loading
  // =====================================================================
  function initStore() {
    try {
      store = Store.create();
    } catch (err) {
      store = new Store.LocalStore();
      setTimeout(() => toast(`${err.message}\nใช้โหมดทดสอบ (localStorage) ไปก่อน`, 'warn', { ms: 7000 }), 300);
    }
    if (store.mode === 'local') {
      const r = store.prepare();
      if (r === 'migrated') setTimeout(() => toast('โหลดผังเครื่องจักรจากแบบแปลนแล้ว\nข้อมูลทดสอบชุดเดิมสำรองไว้ในเบราว์เซอร์นี้', 'info', { ms: 7000 }), 400);
    }
  }

  function resetData() {
    S.zones = []; S.machines = []; S.jobs = [];
    S.metaAt = 0; S.loaded = false; S.seen.clear(); S.mine.clear(); S.flash.clear();
    S.zoneFilter = null; S.selected = null;
    sigs.clear();
  }

  let inflight = null;
  let queued = null;

  /** ดึงข้อมูลล่าสุด แล้ว render — เรียกซ้อนกันได้ (จะรอคิว) */
  function refresh({ meta = false } = {}) {
    if (inflight) {
      queued = { meta: meta || (queued ? queued.meta : false) };
      return inflight;
    }
    inflight = (async () => {
      try {
        const want = meta || store.mode === 'local' || !S.metaAt || Date.now() - S.metaAt > CFG.META_POLL_MS;
        const doMeta = want && S.writes === 0;   // กำลังบันทึกอยู่ — อย่าดึงทับค่าที่เพิ่งแก้
        const gen = S.metaGen;
        const [zones, machines, jobs] = await Promise.all([
          doMeta ? store.listZones() : S.zones,
          doMeta ? store.listMachines() : S.machines,
          store.listJobs(),
        ]);
        // ถ้ามีการแก้ไขเกิดขึ้นระหว่างรอ ข้อมูลที่ได้อาจเก่ากว่าหน้าจอ — ข้ามไป รอบหน้าค่อยดึงใหม่
        if (doMeta && gen === S.metaGen) {
          S.zones = zones;
          S.machines = machines;
          S.metaAt = Date.now();
        }
        S.jobs = jobs;
        detectNewJobs(jobs);
        setConn(true);
        renderAll();
      } catch (err) {
        console.warn('[refresh]', err);
        setConn(false, err.message);
      } finally {
        inflight = null;
        if (queued) {
          const q = queued;
          queued = null;
          refresh(q);
        }
      }
    })();
    return inflight;
  }

  let pollTimer = null;
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => { if (S.user) refresh(); }, CFG.POLL_MS || 5000);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /** ห่อการบันทึกข้อมูล: แสดง error, ดึงข้อมูลใหม่ทุกครั้ง; คืน null ถ้าไม่สำเร็จ */
  async function write(fn, okMsg) {
    S.writes++;
    S.metaGen++;
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r;
    } catch (err) {
      toast(err.message || 'เกิดข้อผิดพลาด', 'error', { ms: 5000 });
      return null;
    } finally {
      S.writes--;
      await refresh({ meta: true });
    }
  }

  // =====================================================================
  //  แจ้งเตือนงานใหม่
  // =====================================================================
  function detectNewJobs(jobs) {
    if (!S.loaded) {
      jobs.forEach(j => S.seen.add(j.id));
      S.loaded = true;
      return;
    }
    const fresh = jobs.filter(j => !S.seen.has(j.id));
    if (!fresh.length) return;
    fresh.forEach(j => S.seen.add(j.id));
    const alerts = fresh.filter(j => j.status === 'open' && !S.mine.has(j.id));
    if (!alerts.length) return;

    const X = derive();
    Sound.play(alerts.some(isStopped) ? 'stopped' : 'normal');
    const until = Date.now() + 15000;
    alerts.forEach(j => S.flash.set(j.machine_id, until));
    // เครื่องหยุดสำคัญกว่า ให้แสดงท้ายสุด (ไม่ถูกแจ้งเตือนอื่นดันออก)
    for (const j of [...alerts].sort((a, b) => Number(a.stopped) - Number(b.stopped)).slice(-4)) {
      const head = isStopped(j) ? 'เครื่องหยุดทำงาน!' : 'แจ้งซ่อมใหม่';
      toast(`${head}\n${machineLabel(X, j.machine_id)} · ${locOf(X, j.machine_id)}\n${j.problem}`,
        isStopped(j) ? 'alert' : 'warn',
        { ms: 12000, onClick: () => { go('board'); openJob(j.id); } });
    }
  }

  // =====================================================================
  //  สถานะการเชื่อมต่อ / ส่วนหัว
  // =====================================================================
  function setConn(ok, msg) {
    S.online = ok;
    if (ok) S.lastOk = new Date();
    const el = $('#conn');
    el.classList.toggle('live', store.mode !== 'local' && ok);
    el.classList.toggle('off', store.mode !== 'local' && !ok);
    if (store.mode === 'local') {
      el.textContent = 'โหมดทดสอบ';
      el.title = 'ข้อมูลเก็บใน localStorage ของเบราว์เซอร์นี้';
    } else {
      el.textContent = ok ? 'ออนไลน์' : 'ออฟไลน์';
      el.title = ok ? 'เชื่อมต่อ API แล้ว' : (msg || 'เชื่อมต่อไม่ได้');
    }
    const lu = $('#last-update');
    if (lu) {
      lu.textContent = S.lastOk
        ? `อัปเดต ${S.lastOk.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
        : '';
      if (!ok) lu.textContent = `เชื่อมต่อไม่ได้ · ${lu.textContent || 'ยังไม่มีข้อมูล'}`;
    }
  }

  function renderUser() {
    const r = Auth.ROLES[S.user.role];
    const letter = (S.user.name.match(/[ก-ฮA-Za-z0-9]/) || ['?'])[0].toUpperCase();
    $('#btn-user').innerHTML = `<span class="avatar" aria-hidden="true">${esc(letter)}</span><span class="user-name">${esc(S.user.name)}</span><span class="user-role">${r.label}</span>`;
    $('#btn-user').title = `${S.user.name} (${r.label}) · แตะเพื่อออกจากระบบ`;
    $('#btn-user').setAttribute('aria-label', $('#btn-user').title);
  }

  function renderNav() {
    $('#nav').innerHTML = VIEWS.filter(v => Auth.can(v.perm)).map(v => `
      <button type="button" class="nav-btn" data-view="${v.id}">
        ${ico(v.icon)}
        <span class="nav-label">${v.label}</span>
        ${v.id === 'board' ? '<span class="nav-badge" id="nav-badge" hidden></span>' : ''}
      </button>`).join('');
  }

  function renderSoundUi() {
    $('#btn-sound').innerHTML = ico(Sound.enabled ? 'bell' : 'bell-off');
    $('#btn-sound').title = Sound.enabled ? 'เสียงเตือน: เปิด (แตะเพื่อปิด)' : 'เสียงเตือน: ปิด (แตะเพื่อเปิด)';
    $('#sound-banner').hidden = !(S.user && Sound.enabled && Sound.blocked);
  }

  const THEMES = ['light', 'dark', 'auto'];
  const THEME_ICON = { light: 'sun', dark: 'moon', auto: 'auto' };
  const THEME_LABEL = { light: 'สว่าง', dark: 'มืด', auto: 'ตามระบบ' };
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme(t) {
    document.documentElement.dataset.theme = t === 'dark' || (t === 'auto' && prefersDark.matches) ? 'dark' : 'light';
    const b = $('#btn-theme');
    b.innerHTML = ico(THEME_ICON[t]);
    b.title = `ธีม: ${THEME_LABEL[t]} (แตะเพื่อสลับ)`;
  }
  function currentTheme() {
    let t = null;
    try { t = localStorage.getItem('mtn.ui.theme'); } catch { /* ignore */ }
    return THEMES.includes(t) ? t : 'light';
  }
  prefersDark.addEventListener('change', () => applyTheme(currentTheme()));

  // =====================================================================
  //  routing
  // =====================================================================
  function allowedViews() { return VIEWS.filter(v => Auth.can(v.perm)); }

  function go(id) {
    if (location.hash !== '#' + id) location.hash = id;
    else route();
  }

  function route() {
    if (!S.user) return;
    const views = allowedViews();
    const want = location.hash.slice(1);
    const v = views.find(x => x.id === want) || views.find(x => x.id === HOME[S.user.role]) || views[0];
    if (!v) { logout(); return; }   // session หายไประหว่างใช้งาน (เช่น ออกจากระบบจากแท็บอื่น)
    if (want !== v.id) history.replaceState(null, '', '#' + v.id);
    const changedView = S.view !== v.id;
    S.view = v.id;
    $$('.view').forEach(el => { el.hidden = el.id !== 'view-' + v.id; });
    $$('#nav .nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v.id));
    $('#page-title').textContent = v.label;
    $('#page-sub').textContent = v.sub;
    if (changedView) window.scrollTo(0, 0);
    renderAll();
  }

  // =====================================================================
  //  render
  // =====================================================================
  function renderAll() {
    if (!S.user) return;
    const X = derive();
    const badge = $('#nav-badge');
    if (badge) {
      badge.textContent = X.open.length;
      badge.hidden = !X.open.length;
      badge.classList.toggle('danger', X.stoppedMachines.size > 0);
    }
    document.title = (X.open.length ? `(${X.open.length}) ` : '') + 'แจ้งซ่อมเครื่องจักร';
    if (S.view === 'report') renderReport(X);
    if (S.view === 'board') renderBoard(X);
    if (S.view === 'admin') renderAdmin(X);
  }

  // ---------- แจ้งซ่อม ----------
  function renderReport(X) {
    patch($('#f-plant'), 'fplant', [S.rPlant], () => plantSeg(S.rPlant), { keepFocus: true });

    if (S.rPick != null && !X.machineById.has(S.rPick)) S.rPick = null;
    const picked = S.rPick != null ? X.machineById.get(S.rPick) : null;
    const q = norm(S.rQ);
    const list = S.machines.filter(m => (S.rPlant === 'all' || m.plant === S.rPlant)
      && (!q || norm(m.name).includes(q) || norm(m.detail).includes(q)));

    // เลือกแล้ว: แสดงการ์ดเครื่อง / ยังไม่เลือก: ค้นหา, รายการ, หรือผัง
    $('#f-picked').hidden = !picked;
    $('#f-pickbox').hidden = !!picked;
    if (picked) {
      const b = X.broken.get(picked.id);
      patch($('#f-picked'), 'fpicked', [picked, b, S.zones], () => `
        <div class="picked">
          ${tag(picked.name, b, 'tag-lg')}
          <span class="picked-text"><b>${esc(picked.detail || locText(X, picked))}</b>${picked.detail ? `<span class="muted small">${esc(locText(X, picked))}</span>` : ''}</span>
          <button type="button" class="btn btn-sm" data-act="clear">เปลี่ยน</button>
        </div>`, { force: true });
    } else {
      const res = $('#f-results');
      res.hidden = !q;
      $('#f-pickrow').hidden = !!q;
      if (q) {
        // รหัสที่ขึ้นต้นตรงกับคำค้นมาก่อน
        const hits = [...list].sort((a, b) => (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || byName(a, b));
        patch(res, 'fresults', [hits.slice(0, 20), hits.length, S.zones, [...X.broken.keys()]], () => hits.length
          ? hits.slice(0, 20).map(m => `
            <button type="button" class="result" data-id="${m.id}">
              ${tag(m.name, X.broken.has(m.id))}
              <span class="result-text">${m.detail ? `<span>${esc(m.detail)}</span><small>${esc(locText(X, m))}</small>` : `<span>${esc(locText(X, m))}</span>`}</span>
            </button>`).join('') + (hits.length > 20 ? `<p class="muted small">พบ ${hits.length} เครื่อง พิมพ์เพิ่มเพื่อให้แคบลง</p>` : '')
          : '<p class="muted">ไม่พบเครื่องตามที่พิมพ์ ลองเปลี่ยนโรงหรือเลือกจากผัง</p>');
      } else {
        patch($('#f-machine'), 'msel', [list.map(m => [m.id, m.name, m.detail, m.zone_id]), S.zones], () => {
          let html = `<option value="">เลือกจากรายการ (${list.length} เครื่อง)</option>`;
          const opt = m => `<option value="${m.id}">${esc(machineFull(m))}</option>`;
          for (const p of PLANTS) {
            for (const z of S.zones.filter(z => z.plant === p.id)) {
              const ms = list.filter(m => m.zone_id === z.id).sort(byName);
              if (ms.length) html += `<optgroup label="${esc(p.name)} · ${esc(z.name)}">${ms.map(opt).join('')}</optgroup>`;
            }
          }
          const loose = list.filter(m => !X.zoneById.has(m.zone_id)).sort(byName);
          if (loose.length) html += `<optgroup label="ไม่ระบุโซน">${loose.map(opt).join('')}</optgroup>`;
          return html;
        });
      }
    }
    renderPickMap(X);
    renderSteps();
    $('#f-empty').hidden = S.machines.length > 0 || !S.loaded;
    renderMachineWarn(X);

    const mine = S.jobs.filter(j => j.reported_by && j.reported_by === S.user.name).slice(0, 8);
    patch($('#my-jobs'), 'myjobs', [mine, S.machines.length], () => mine.length
      ? mine.map(j => `
        <button type="button" class="mini-job" data-id="${j.id}">
          <span class="mini-main">
            ${tag(machineLabel(X, j.machine_id), j.status === 'open')}
            <span class="muted small">#${j.id} · ${esc(j.problem)}</span>
          </span>
          <span class="mini-side">${statusBadge(j)}<span class="muted small">${fmtTime(j.created_at)}</span></span>
        </button>`).join('')
      : '<p class="empty">ยังไม่มีงานที่คุณแจ้ง</p>');
  }

  function pickMachine(id) {
    S.rPick = id;
    S.rQ = '';
    $('#f-search').value = '';
    $('#f-machine').value = '';
    $('#f-pickbox').classList.remove('invalid');
    renderAll();
  }

  /** เปิดหน้าแจ้งซ่อมโดยเลือกเครื่องไว้ให้แล้ว */
  function reportMachine(m) {
    go('report');
    pickMachine(m.id);
    if (window.matchMedia('(pointer: fine)').matches) $('#f-problem').focus();
  }

  /** ติ๊กหัวข้อที่กรอกแล้ว */
  function renderSteps() {
    const done = [S.rPick != null, $('#f-problem').value.trim(), $('#f-impact').value.trim(), $('input[name="stopped"]:checked')];
    $$('#report-form .step').forEach((el, i) => el.classList.toggle('done', !!done[i]));
  }

  // ---------- หน้าต่าง "เลือกจากผัง" ----------
  function openPickMap() {
    if (S.rPlant !== 'all') S.pickPlant = S.rPlant;
    const dlg = $('#pick-dialog');
    dlg.showModal();
    if (!pickMap) {
      pickMap = new PlantMap($('#pick-map'), {
        plant: plantById(S.pickPlant),
        onMachine: id => { dlg.close(); pickMachine(id); },
      });
    }
    renderPickMap(derive());
    pickMap.fit();
  }

  function renderPickMap(X) {
    if (!pickMap || !$('#pick-dialog').open) return;
    patch($('#pick-plants'), 'pickplants', [S.pickPlant], () => plantTabs(S.pickPlant), { keepFocus: true });
    pickMap.setPlant(plantById(S.pickPlant));
    pickMap.render({ zones: S.zones, machines: S.machines, broken: X.broken, stats: X.zoneStats });
  }

  function renderMachineWarn(X) {
    const id = S.rPick;
    const dup = id != null ? X.open.filter(j => j.machine_id === id) : [];
    const el = $('#f-machine-warn');
    el.hidden = !dup.length;
    if (dup.length) {
      el.innerHTML = `เครื่องนี้มีงานค้างอยู่แล้ว ${dup.length} งาน: ` +
        dup.map(j => `<b>#${j.id}</b> ${esc(j.problem)}`).join(' · ') +
        '<br><span class="small">ถ้าเป็นปัญหาเดิม ไม่ต้องแจ้งซ้ำ</span>';
    }
  }

  // ---------- ติดตามงาน ----------
  /** นับเครื่องต่อโรง: { total, bad, stopped } */
  function plantCounts(X) {
    const out = new Map(PLANTS.map(p => [p.id, { total: 0, bad: 0, stopped: 0 }]));
    for (const m of S.machines) {
      const c = out.get(m.plant);
      if (!c) continue;
      c.total++;
      const b = X.broken.get(m.id);
      if (b) { c.bad++; if (b.stopped) c.stopped++; }
    }
    return out;
  }

  const segBtn = (id, label, on, bad) => `<button type="button" data-v="${id}" class="${on ? 'on' : ''}">${esc(label)}${bad ? ` <span class="tab-bad">${bad}</span>` : ''}</button>`;
  const plantTabs = (active, counts) => PLANTS.map(p => segBtn(p.id, p.name, active === p.id, counts ? counts.get(p.id).bad : 0)).join('');
  const plantSeg = (active, counts) => segBtn('all', 'ทุกโรง', active === 'all', 0) + plantTabs(active, counts);

  function renderBoard(X) {
    $('#st-total').textContent = store.totalJobs != null ? store.totalJobs : S.jobs.length;
    $('#st-open').textContent = X.open.length;
    $('#st-stopped').textContent = X.stoppedMachines.size;
    $('#stat-stopped').classList.toggle('alarm', X.stoppedMachines.size > 0);
    const okCount = S.machines.filter(m => !X.broken.has(m.id)).length;
    $('#st-ok').textContent = okCount;
    $('#st-okof').textContent = `/ ${S.machines.length}`;
    $('#st-okbar').style.width = (S.machines.length ? okCount / S.machines.length * 100 : 100) + '%';
    if (S.zoneFilter != null && !X.zoneById.has(S.zoneFilter)) S.zoneFilter = null;

    const counts = plantCounts(X);
    patch($('#plant-tabs'), 'ptabs', [S.plant, [...counts]], () => plantSeg(S.plant, counts), { keepFocus: true });

    const all = S.plant === 'all';
    $('#board-overview').hidden = !all;
    $('#board-map').hidden = all;
    const view = { zones: S.zones, machines: S.machines, broken: X.broken, stats: X.zoneStats, flash: X.flash, filterZone: S.zoneFilter };
    if (all) {
      for (const o of overview) {
        const c = counts.get(o.plant.id);
        o.map.render(view);
        o.card.classList.toggle('bad', c.bad > 0);
        o.info.innerHTML = `<span class="ok-dot">${c.total - c.bad}</span>${c.bad ? `<span class="bad-dot">${c.bad}</span>` : ''}`;
        o.card.setAttribute('aria-label', `${o.plant.name} ปกติ ${c.total - c.bad} เครื่อง เสีย ${c.bad} เครื่อง`);
      }
    } else {
      boardMap.setPlant(plantById(S.plant));
      boardMap.render(view);
    }
    const sum = [...counts].filter(([id]) => all || id === S.plant).reduce((a, [, c]) => ({ total: a.total + c.total, bad: a.bad + c.bad }), { total: 0, bad: 0 });
    $('#lg-ok').textContent = sum.total - sum.bad;
    $('#lg-bad').textContent = sum.bad;
    $('#map-hint').textContent = all ? 'แตะโรงเพื่อดูรายละเอียด' : 'แตะเครื่องเพื่อดูรายละเอียด · แตะชื่อโซนเพื่อกรอง';
    patch($('#machine-codes'), 'codes', [S.machines.map(m => m.name)], () => S.machines.map(m => `<option value="${esc(m.name)}">${esc(m.detail)}</option>`).join(''));

    const zf = S.zoneFilter != null ? X.zoneById.get(S.zoneFilter) : null;
    $$('.zone-chip').forEach(c => {
      c.hidden = !zf;
      c.textContent = zf ? `${plantName(zf.plant)} · ${zf.name}  ✕` : '';
      c.title = 'ล้างตัวกรองโซน';
    });

    renderMachineDetails(X);
    renderPending(X);
    renderAllJobs(X);
  }

  /** ตารางเครื่องจักรใต้ผัง (แสดงเมื่อกางออก) */
  function renderMachineDetails(X) {
    $('#md-title').textContent = S.plant === 'all' ? ' ทุกโรง' : ` ${plantName(S.plant)}`;
    if (!$('#machine-details').open) return;
    const list = S.machines.filter(m => (S.plant === 'all' || m.plant === S.plant)
      && (S.zoneFilter == null || m.zone_id === S.zoneFilter)
      && (S.mdStatus === 'all' || (S.mdStatus === 'bad') === X.broken.has(m.id)));
    const order = new Map(S.zones.map((z, i) => [z.id, i]));
    list.sort((a, b) => (X.broken.has(b.id) - X.broken.has(a.id))
      || ((order.get(a.zone_id) ?? 999) - (order.get(b.zone_id) ?? 999)) || byName(a, b));
    patch($('#md-list'), 'mdlist', [list, S.zones, [...X.broken]], () => list.length ? `
      <div class="table-wrap"><table class="jobs-table md-table">
        <thead><tr><th>รหัส</th><th>รายละเอียด</th><th>โรง / โซน</th><th>สถานะ</th></tr></thead>
        <tbody>${list.map(m => {
          const b = X.broken.get(m.id);
          return `<tr data-mid="${m.id}">
            <td data-label="รหัส"><span>${tag(m.name, b)}</span></td>
            <td data-label="รายละเอียด" class="${m.detail ? '' : 'empty-cell'}">${esc(m.detail) || '–'}</td>
            <td data-label="โรง / โซน">${esc(locText(X, m))}</td>
            <td data-label="สถานะ"><span>${machineBadge(b)}</span></td></tr>`;
        }).join('')}</tbody>
      </table></div>` : '<div class="empty">ไม่มีเครื่องตามเงื่อนไขนี้</div>');
  }

  function machineBadge(b) {
    if (!b) return '<span class="badge badge-ok badge-dot">ปกติ</span>';
    return b.stopped
      ? `<span class="badge badge-danger">${ico('stop')}เสีย หยุดทำงาน</span>`
      : '<span class="badge badge-danger badge-dot">เสีย</span>';
  }

  /** หน้าต่างรายละเอียดเครื่องจักร (เปิดจากผัง) */
  function openMachine(id) {
    const m = S.machines.find(x => x.id === id);
    if (!m) return;
    const X = derive();
    const b = X.broken.get(id);
    const open = X.open.filter(j => j.machine_id === id);
    const hist = S.jobs.filter(j => j.machine_id === id && j.status === 'closed').slice(0, 5);
    const z = X.zoneById.get(m.zone_id);
    const canClose = Auth.can('job:close');
    $('#md-name').innerHTML = tag(m.name, b, 'tag-lg');
    $('#md-body').innerHTML = `
      <div class="m-banner ${b ? 'bad' : 'ok'}">${b ? (b.stopped ? ico('stop') + 'เสีย เครื่องหยุดทำงาน' : ico('alert') + 'เสีย มีงานค้าง') : ico('check-circle') + 'ปกติ'}</div>
      <dl class="dl">
        <dt>รายละเอียด</dt><dd>${esc(m.detail) || '–'}</dd>
        <dt>โรง</dt><dd>${esc(plantName(m.plant))}</dd>
        <dt>โซน</dt><dd>${esc(z ? z.name : 'ไม่ระบุโซน')}</dd>
      </dl>
      ${open.length ? `<h3>งานค้าง (${open.length})</h3>${open.map(j => `
        <div class="m-job">
          <div class="job-top"><b>#${j.id} ${esc(j.problem)}</b>${stoppedBadge(j)}</div>
          <div class="job-meta"><span>${ico('clock')}${fmtTime(j.created_at)}</span><span>ค้าง ${fmtDur(Date.now() - Date.parse(j.created_at))}</span>${j.reported_by ? `<span>${ico('user')}${esc(j.reported_by)}</span>` : ''}</div>
          <button type="button" class="btn ${canClose ? 'btn-ok' : ''} btn-block" data-job="${j.id}">${canClose ? ico('wrench') + 'ดำเนินการ / ปิดงาน' : 'ดูรายละเอียดงาน'}</button>
        </div>`).join('')}` : ''}
      <h3>ประวัติซ่อมล่าสุด</h3>
      ${hist.length ? hist.map(j => `
        <button type="button" class="mini-job" data-job="${j.id}">
          <span class="mini-main"><b>#${j.id} ${esc(j.problem)}</b><span class="muted small">${esc(j.note || '')}</span></span>
          <span class="mini-side"><span class="muted small">ปิด ${fmtTime(j.closed_at, true)}</span></span>
        </button>`).join('') : '<p class="muted">ยังไม่มีประวัติ</p>'}`;
    $('#md-actions').innerHTML = Auth.can('job:create')
      ? `<button type="button" class="btn btn-primary btn-lg" data-report="${m.id}">${ico('report')}แจ้งซ่อมเครื่องนี้</button>` : '';
    const dlg = $('#machine-dialog');
    if (!dlg.open) dlg.showModal();
  }

  /** หาเครื่องจากรหัส แล้วพาไปดูบนผัง */
  function findOnMap(text) {
    const q = norm(text);
    if (!q) return;
    const hits = S.machines.filter(m => norm(m.name) === q);
    const list = hits.length ? hits : S.machines.filter(m => norm(m.name).includes(q) || norm(m.detail).includes(q));
    if (!list.length) { toast(`ไม่พบเครื่อง "${text}" บนผัง`, 'error'); return; }
    if (list.length > 1) toast(`พบ ${list.length} เครื่อง แสดงเครื่องแรก: ${list[0].name}`, 'info');
    setPlant(list[0].plant);
    requestAnimationFrame(() => boardMap.focusMachine(list[0].id));
  }

  function setPlant(id) {
    const changed = S.plant !== id;
    S.plant = id;
    if (changed && S.zoneFilter != null) S.zoneFilter = null;
    try { localStorage.setItem('mtn.plant', id); } catch { /* ignore */ }
    renderAll();
    if (changed && id !== 'all') boardMap.fit();
  }

  function jobCard(X, j, canClose) {
    const m = X.machineById.get(j.machine_id);
    const age = Date.now() - Date.parse(j.created_at);
    const ageCls = age >= 4 * 3600e3 ? 'age-bad' : age >= 3600e3 ? 'age-warn' : '';
    return `
      <article class="job ${isStopped(j) ? 'job-stopped' : ''}" data-id="${j.id}">
        <div class="job-top">${tag(machineLabel(X, j.machine_id), true, 'tag-lg')}${stoppedBadge(j)}</div>
        <p class="job-sub">${esc([m && m.detail, locOf(X, j.machine_id)].filter(Boolean).join(' · '))}</p>
        <p class="job-problem">${esc(j.problem)}</p>
        ${j.impact ? `<p class="job-impact"><span class="muted">ผลกระทบ:</span> ${esc(j.impact)}</p>` : ''}
        <div class="job-meta">
          <span>#${j.id}</span>
          <span class="${ageCls}">${ico('clock')}ค้าง ${fmtDur(age)}</span>
          <span>${fmtTime(j.created_at)}</span>
          ${j.reported_by ? `<span>${ico('user')}${esc(j.reported_by)}</span>` : ''}
        </div>
        ${canClose ? `<button type="button" class="btn btn-ok btn-lg btn-block" data-act="close" data-id="${j.id}">${ico('wrench')}ดำเนินการ / ปิดงาน</button>` : ''}
      </article>`;
  }

  function renderPending(X) {
    let list = X.open;
    if (S.zoneFilter != null) list = list.filter(j => jobZoneId(X, j) === S.zoneFilter);
    // เครื่องหยุดขึ้นก่อน แล้วเรียงงานเก่าสุดขึ้นก่อน
    list = [...list].sort((a, b) => (Number(b.stopped) - Number(a.stopped)) || a.created_at.localeCompare(b.created_at));
    $('#pending-count').textContent = list.length;
    const canClose = Auth.can('job:close');
    const minute = Math.floor(Date.now() / 60000);
    patch($('#pending-list'), 'pending', [list, canClose, minute, S.machines, S.zones], () => list.length
      ? list.map(j => jobCard(X, j, canClose)).join('')
      : `<div class="empty">${ico('check-circle')}ไม่มีงานค้าง${S.zoneFilter != null ? 'ในโซนนี้' : ' เครื่องทำงานปกติทุกเครื่อง'}</div>`);
  }

  function renderAllJobs(X) {
    const q = S.jobsQ.trim().toLowerCase();
    let list = S.jobs;
    if (S.jobsStatus !== 'all') list = list.filter(j => j.status === S.jobsStatus);
    if (S.zoneFilter != null) list = list.filter(j => jobZoneId(X, j) === S.zoneFilter);
    if (q) {
      list = list.filter(j => {
        return ['#' + j.id, machineLabel(X, j.machine_id), locOf(X, j.machine_id), j.problem, j.impact, j.note, j.reported_by, j.closed_by]
          .some(v => v && String(v).toLowerCase().includes(q));
      });
    }
    const rows = list.slice(0, S.jobsShow);
    const total = store.totalJobs;
    patch($('#all-jobs'), 'alljobs', [rows, list.length, S.machines, S.zones, total, S.jobs.length], () => {
      if (!rows.length) return '<div class="empty">ไม่พบงาน</div>';
      const body = rows.map(j => {
        const dur = j.closed_at ? fmtDur(Date.parse(j.closed_at) - Date.parse(j.created_at)) : '–';
        return `
          <tr data-id="${j.id}">
            <td data-label="งาน" class="nowrap"><b>#${j.id}</b></td>
            <td data-label="เครื่องจักร"><div>${tag(machineLabel(X, j.machine_id), j.status === 'open')}<div class="muted small">${esc(locOf(X, j.machine_id))}</div></div></td>
            <td data-label="ปัญหา"><div><span class="clip">${esc(j.problem)}</span>${isStopped(j) ? `<span class="badge ${j.status === 'open' ? 'badge-danger' : 'badge-muted'}">${ico('stop')}เครื่องหยุด</span>` : ''}</div></td>
            <td data-label="สถานะ"><span>${statusBadge(j)}</span></td>
            <td data-label="แจ้งเมื่อ" class="nowrap">${fmtTime(j.created_at, true)}</td>
            <td data-label="ปิดเมื่อ" class="nowrap ${j.closed_at ? '' : 'empty-cell'}">${fmtTime(j.closed_at, true)}</td>
            <td data-label="ใช้เวลา" class="nowrap ${j.closed_at ? '' : 'empty-cell'}">${dur}</td>
            <td data-label="วิธีแก้ไข" class="${j.note ? '' : 'empty-cell'}"><span class="clip">${esc(j.note || '–')}</span></td>
          </tr>`;
      }).join('');
      const more = list.length > rows.length
        ? `<button type="button" class="btn" data-act="more">แสดงเพิ่ม (${list.length - rows.length})</button>` : '<span></span>';
      const info = store.mode === 'api' && total != null && total > S.jobs.length
        ? `<span class="muted small">แสดงงานล่าสุด ${S.jobs.length} จากทั้งหมด ${total} งาน</span>` : `<span class="muted small">${list.length} รายการ</span>`;
      return `
        <div class="table-wrap">
          <table class="jobs-table">
            <thead><tr><th>งาน</th><th>เครื่องจักร</th><th>ปัญหา</th><th>สถานะ</th><th>แจ้งเมื่อ</th><th>ปิดเมื่อ</th><th>ใช้เวลา</th><th>วิธีแก้ไข</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <div class="list-foot">${info}${more}</div>`;
    });
  }

  // ---------- ตั้งค่า (แอดมิน) ----------
  function selectedObj() {
    if (!S.selected) return null;
    return (S.selected.type === 'machine' ? S.machines : S.zones).find(o => o.id === S.selected.id) || null;
  }

  function renderAdminMap() {
    adminMap.setPlant(plantById(S.adminPlant));
    adminMap.render({ zones: S.zones, machines: S.machines, selected: S.selected, layer: S.layer });
  }

  function renderAdmin(X) {
    if (S.selected && !selectedObj()) S.selected = null;
    patch($('#admin-plants'), 'aplants', [S.adminPlant], () => PLANTS.map(p =>
      `<button type="button" data-v="${p.id}" class="${p.id === S.adminPlant ? 'on' : ''}">${esc(p.name)}</button>`).join(''), { keepFocus: true });
    $$('#admin-layer button').forEach(b => b.classList.toggle('on', b.dataset.v === S.layer));
    $$('#admin-tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === S.adminTab));
    $$('#view-admin .pane').forEach(p => { p.hidden = p.dataset.pane !== S.adminTab; });
    if (S.adminTab === 'map') { renderAdminMap(); renderPanel(X); }
    if (S.adminTab === 'list') renderMachines(X);
    if (S.adminTab === 'sys') renderSettings();
  }

  const xywhFields = o => ['x', 'y', 'w', 'h'].map((k, i) =>
    `<label class="field"><span>${['X', 'Y', 'กว้าง', 'สูง'][i]}</span><input name="${k}" type="number" inputmode="numeric" step="1" value="${o[k]}"></label>`).join('');

  function renderPanel(X, force = false) {
    const panel = $('#zone-panel');
    const o = selectedObj();
    patch(panel, 'zpanel', [S.selected, o, S.adminPlant, S.zones, S.machines], () => {
      if (!o) {
        const ms = S.machines.filter(m => m.plant === S.adminPlant);
        const todo = ms.filter(m => m.verify).sort(byName);
        return `
          <h2 class="card-title">${esc(plantName(S.adminPlant))}</h2>
          <p class="muted">แตะเครื่องหรือโซนบนผังเพื่อแก้ไข · มี ${ms.length} เครื่อง</p>
          ${todo.length ? `
            <h3>รอตรวจรหัส ${todo.length} เครื่อง</h3>
            <p class="muted small">ภาพแบบแปลนไม่ชัด หรือไม่มีรหัสในแบบ แตะเพื่อเทียบตำแหน่งบนผังแล้วแก้รหัสให้ถูก</p>
            <div class="zone-picks">${todo.map(m => `<button type="button" class="chip chip-warn" data-act="pick" data-id="${m.id}">${esc(m.name)}</button>`).join('')}</div>`
          : '<p class="note ok">ไม่มีรหัสที่รอตรวจในโรงนี้</p>'}`;
      }
      const head = `<div class="card-head"><h2 class="card-title">${S.selected.type === 'machine' ? tag(o.name, false, 'tag-lg') : esc(o.name)}</h2>
        <button type="button" class="icon-btn" data-act="deselect" aria-label="ปิดรายละเอียด">${ico('x')}</button></div>`;
      const plantSel = `<label class="field"><span>โรง</span><select name="plant">${PLANTS.map(p => `<option value="${p.id}"${p.id === o.plant ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>`;

      if (S.selected.type === 'machine') {
        const zs = S.zones.filter(z => z.plant === o.plant);
        return `${head}
          ${o.verify ? '<p class="note warn" style="margin:0 0 16px">รหัสนี้อ่านจากแบบไม่ชัด แก้ให้ถูกหรือกดยืนยัน<br><button type="button" class="btn btn-sm" data-act="verify">รหัสถูกต้องแล้ว</button></p>' : ''}
          <form data-form="obj" novalidate>
            <label class="field"><span>รหัสเครื่อง</span><input name="name" value="${esc(o.name)}" maxlength="80" required></label>
            <label class="field"><span>รายละเอียด / ชนิดเครื่อง</span><input name="detail" value="${esc(o.detail)}" maxlength="120"></label>
            <label class="field"><span>โซน</span><select name="zone_id"><option value="">— ไม่ระบุโซน —</option>${zs.map(z => `<option value="${z.id}"${z.id === o.zone_id ? ' selected' : ''}>${esc(z.name)}</option>`).join('')}</select></label>
            ${plantSel}
            <div class="grid-4">${xywhFields(o)}</div>
            <label class="field"><span>รูปร่าง</span><select name="shape"><option value="rect"${o.shape !== 'circle' ? ' selected' : ''}>สี่เหลี่ยม</option><option value="circle"${o.shape === 'circle' ? ' selected' : ''}>วงกลม (ถัง)</option></select></label>
          </form>
          <button type="button" class="btn btn-danger btn-block" data-act="delete-machine">${ico('trash')}ลบเครื่องนี้</button>`;
      }
      const inZone = S.machines.filter(m => m.zone_id === o.id).sort(byName);
      const others = S.machines.filter(m => m.plant === o.plant && m.zone_id !== o.id).sort(byName);
      return `${head}
        <form data-form="obj" novalidate>
          <label class="field"><span>ชื่อโซน</span><input name="name" value="${esc(o.name)}" maxlength="60" required></label>
          ${plantSel}
          <div class="grid-4">${xywhFields(o)}</div>
        </form>
        <h3>เครื่องจักรในโซนนี้ (${inZone.length})</h3>
        <ul class="zp-machines">${inZone.length
          ? inZone.map(m => `<li><span>${esc(machineFull(m))}</span><button type="button" class="btn btn-sm" data-act="unassign" data-id="${m.id}">นำออก</button></li>`).join('')
          : '<li class="muted">ยังไม่มีเครื่องจักรในโซนนี้</li>'}</ul>
        ${others.length ? `<label class="field"><span>ย้ายเครื่องเข้าโซนนี้</span>
          <select data-act="assign"><option value="">— เลือกเครื่อง —</option>${others.map(m => `<option value="${m.id}">${esc(machineFull(m))}</option>`).join('')}</select></label>` : ''}
        <hr>
        <button type="button" class="btn btn-danger btn-block" data-act="delete-zone">${ico('trash')}ลบโซนนี้</button>`;
    }, { force });
  }

  function renderMachines(X) {
    $('#machine-count').textContent = S.machines.length;
    const todo = S.machines.filter(m => m.verify).length;
    patch($('#m-filter'), 'mfilter', [S.mFilter, todo], () => plantSeg(S.mFilter) + (todo || S.mFilter === 'verify' ? segBtn('verify', `รอตรวจรหัส ${todo}`, S.mFilter === 'verify') : ''), { keepFocus: true });
    const q = norm(S.mQ);
    const list = S.machines.filter(m => (S.mFilter === 'all' || (S.mFilter === 'verify' ? m.verify : m.plant === S.mFilter))
      && (!q || norm(m.name).includes(q) || norm(m.detail).includes(q) || norm(X.zoneById.get(m.zone_id)?.name).includes(q)))
      .sort((a, b) => a.plant.localeCompare(b.plant) || byName(a, b));
    const rows = list.slice(0, S.mShow);
    patch($('#machine-table'), 'mtable', [rows, list.length, S.zones, rows.map(m => X.broken.get(m.id))], () => {
      if (!rows.length) return '<p class="empty">ไม่พบเครื่องจักร</p>';
      return `<div class="mrows">${rows.map(m => `
        <div class="mrow" data-id="${m.id}">
          <input class="m-name" value="${esc(m.name)}" maxlength="80" aria-label="รหัสเครื่อง">
          <input class="m-detail" value="${esc(m.detail)}" maxlength="120" placeholder="รายละเอียด" aria-label="รายละเอียดของ ${esc(m.name)}">
          <span class="m-loc muted small">${esc(locText(X, m))}</span>
          <span class="m-status">${m.verify ? '<span class="badge badge-warn">รอตรวจ</span>' : machineBadge(X.broken.get(m.id))}</span>
          <span class="m-btns">
            ${m.verify ? `<button type="button" class="btn btn-sm" data-act="ok-machine" title="ยืนยันว่ารหัสถูกต้อง" aria-label="ยืนยันรหัส ${esc(m.name)}">${ico('check')}</button>` : ''}
            <button type="button" class="btn btn-sm" data-act="locate" title="ดูบนผัง" aria-label="ดู ${esc(m.name)} บนผัง">${ico('target')}</button>
            <button type="button" class="btn btn-danger btn-sm" data-act="del-machine" title="ลบเครื่องจักร" aria-label="ลบ ${esc(m.name)}">${ico('trash')}</button>
          </span>
        </div>`).join('')}</div>
        <div class="list-foot"><span class="muted small">${list.length} เครื่อง</span>${list.length > rows.length ? `<button type="button" class="btn" data-act="more">แสดงเพิ่ม (${list.length - rows.length})</button>` : '<span></span>'}</div>`;
    });
  }

  function renderSettings(force = false) {
    const s = Store.resolveSettings();
    const allow = CFG.ALLOW_SETTINGS_OVERRIDE;
    patch($('#settings-body'), 'settings', [s, store.mode, allow], () => `
      ${allow ? `
      <h2>แหล่งข้อมูล</h2>
      <fieldset class="field" aria-label="แหล่งข้อมูล">
        <div class="toggle-2">
          <label class="opt opt-plain"><input type="radio" name="mode" value="local"${s.mode !== 'api' ? ' checked' : ''}><span>${ico('device')}ทดสอบในเครื่องนี้</span></label>
          <label class="opt opt-plain"><input type="radio" name="mode" value="api"${s.mode === 'api' ? ' checked' : ''}><span>${ico('cloud')}Cloudflare API</span></label>
        </div>
      </fieldset>
      <label class="field"><span>URL ของ Cloudflare Worker</span>
        <input id="set-api" type="url" inputmode="url" value="${esc(s.apiBase)}" placeholder="https://mtn-repair-api.xxxx.workers.dev"></label>
      <div class="btn-row">
        <button type="button" class="btn" data-act="test-api">${ico('plug')}ทดสอบการเชื่อมต่อ</button>
        <button type="button" class="btn btn-primary" data-act="save-settings">${ico('save')}บันทึกและใช้งาน</button>
      </div>
      <p class="muted small" style="margin:14px 0 0">ตอนนี้ใช้: <b>${store.mode === 'api' ? 'Cloudflare API' : 'ทดสอบ (localStorage)'}</b> · ค่านี้มีผลเฉพาะเบราว์เซอร์เครื่องนี้ ค่าเริ่มต้นของทุกเครื่องตั้งที่ <code>js/config.js</code></p>
      ` : `<p class="muted">แหล่งข้อมูล: <b>${store.mode === 'api' ? 'Cloudflare API' : 'ทดสอบ (localStorage)'}</b> (ตั้งที่ js/config.js)</p>`}
      ${store.mode === 'local' ? `
      <hr>
      <h2>ข้อมูลทดสอบ</h2>
      <div class="btn-row">
        <button type="button" class="btn" data-act="demo">${ico('flask')}จำลองเครื่องเสีย 3 เครื่อง</button>
        <button type="button" class="btn btn-danger" data-act="clear">${ico('trash')}ล้างงานแจ้งซ่อมทั้งหมด</button>
        <button type="button" class="btn btn-danger" data-act="seed">${ico('refresh')}โหลดผังจากแบบแปลนใหม่</button>
      </div>` : ''}
      <hr>
      <h2>เสียงเตือน</h2>
      <div class="btn-row">
        <button type="button" class="btn" data-act="sound-normal">${ico('bell')}ทดสอบเสียงแจ้งซ่อม</button>
        <button type="button" class="btn" data-act="sound-stopped">${ico('stop')}ทดสอบเสียงเครื่องหยุด</button>
      </div>`, { force });
  }

  // =====================================================================
  //  dialog: รายละเอียดงาน / ปิดงาน
  // =====================================================================
  function openJob(id) {
    const j = S.jobs.find(x => x.id === id);
    if (!j) return;
    const X = derive();
    const canClose = j.status === 'open' && Auth.can('job:close');
    S.dialogJob = id;
    $('#jd-title').innerHTML = `${tag(machineLabel(X, j.machine_id), j.status === 'open', 'tag-lg')}<span>งาน #${j.id}</span>`;
    $('#jd-body').innerHTML = `
      <dl class="dl">
        <dt>ตำแหน่ง</dt><dd>${esc(locOf(X, j.machine_id))}</dd>
        <dt>สถานะ</dt><dd>${statusBadge(j)} ${stoppedBadge(j)}</dd>
        <dt>ปัญหา</dt><dd class="pre">${esc(j.problem)}</dd>
        <dt>ผลกระทบ</dt><dd class="pre">${esc(j.impact) || '–'}</dd>
        <dt>ผู้แจ้ง</dt><dd>${esc(j.reported_by) || '–'}</dd>
        <dt>แจ้งเมื่อ</dt><dd>${fmtTime(j.created_at, true)}</dd>
        ${j.status === 'closed' ? `
          <dt>ปิดเมื่อ</dt><dd>${fmtTime(j.closed_at, true)} (ใช้เวลา ${fmtDur(Date.parse(j.closed_at) - Date.parse(j.created_at))})</dd>
          <dt>ผู้ปิดงาน</dt><dd>${esc(j.closed_by) || '–'}</dd>
          <dt>วิธีแก้ไข</dt><dd class="pre">${esc(j.note) || '–'}</dd>`
        : `<dt>ค้างมาแล้ว</dt><dd>${fmtDur(Date.now() - Date.parse(j.created_at))}</dd>`}
      </dl>`;
    $('#jd-close').hidden = !canClose;
    $('#jd-submit').hidden = !canClose;
    $('#jd-note').value = '';
    $('#jd-note').classList.remove('invalid');
    $$('#note-chips .chip').forEach(c => c.classList.remove('on'));
    const dlg = $('#job-dialog');
    if (!dlg.open) dlg.showModal();
    if (canClose && window.matchMedia('(pointer: fine)').matches) setTimeout(() => $('#jd-note').focus(), 50);
  }

  async function submitClose(e) {
    e.preventDefault();
    const note = $('#jd-note').value.trim();
    if (!note) {
      $('#jd-note').classList.add('invalid');
      $('#jd-note').focus();
      toast('กรุณาบันทึกวิธีแก้ไขก่อนปิดงาน', 'error');
      return;
    }
    const btn = $('#jd-submit');
    btn.disabled = true;
    const id = S.dialogJob;
    const r = await write(() => store.closeJob(id, { note, closed_by: S.user.name }), `ปิดงาน #${id} เรียบร้อย`);
    btn.disabled = false;
    if (r || !S.jobs.some(j => j.id === id && j.status === 'open')) $('#job-dialog').close();
  }

  // =====================================================================
  //  ส่งแจ้งซ่อม
  // =====================================================================
  const SUBMIT_LABEL = `${ico('send')}ส่งแจ้งซ่อม`;

  async function submitReport(e) {
    e.preventDefault();
    const pickbox = $('#f-pickbox');
    const problem = $('#f-problem');
    const stopped = $('input[name="stopped"]:checked');
    [pickbox, problem, $('#f-stopped')].forEach(el => el.classList.remove('invalid'));

    const missing = [];
    if (S.rPick == null) { missing.push('เครื่องที่เสีย'); pickbox.classList.add('invalid'); }
    if (!problem.value.trim()) { missing.push('อาการที่พบ'); problem.classList.add('invalid'); }
    if (!stopped) { missing.push('เครื่องหยุดทำงานหรือไม่'); $('#f-stopped').classList.add('invalid'); }
    if (missing.length) {
      toast(`กรอกข้อมูลไม่ครบ\n${missing.join(', ')}`, 'error');
      const first = $('.invalid', $('#report-form'));
      if (first) (first.matches('input,select,textarea') ? first : $('input', first)).focus();
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }

    const btn = $('#btn-submit');
    btn.disabled = true;
    btn.textContent = 'กำลังส่ง…';
    const job = await write(async () => {
      const j = await store.createJob({
        machine_id: S.rPick,
        problem: problem.value.trim(),
        impact: $('#f-impact').value.trim(),
        stopped: stopped.value === '1' ? 1 : 0,
        reported_by: S.user.name,
      });
      // จำไว้ก่อน refresh เพื่อไม่ให้แท็บที่ส่งเองส่งเสียงเตือน
      S.mine.add(j.id);
      S.seen.add(j.id);
      return j;
    });
    btn.disabled = false;
    btn.innerHTML = SUBMIT_LABEL;
    if (job) {
      toast(`ส่งแจ้งซ่อมแล้ว\nงาน #${job.id} — ช่างจะได้รับแจ้งเตือนทันที`, 'ok', { ms: 5000 });
      $('#report-form').reset();
      S.rPick = null;
      S.rQ = '';
      $$('#impact-chips .chip').forEach(c => c.classList.remove('on'));
      renderAll();
    }
  }

  /** chip ช่วยกรอก: แตะเพื่อเพิ่ม/ลบข้อความใน textarea */
  function bindChips(chipsBox, textarea) {
    const sync = () => {
      const parts = textarea.value.split(',').map(s => s.trim());
      $$('.chip', chipsBox).forEach(c => c.classList.toggle('on', parts.includes(c.textContent.trim())));
    };
    chipsBox.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const t = chip.textContent.trim();
      let parts = textarea.value.split(',').map(s => s.trim()).filter(Boolean);
      parts = parts.includes(t) ? parts.filter(p => p !== t) : [...parts, t];
      textarea.value = parts.join(', ');
      textarea.classList.remove('invalid');
      sync();
    });
    textarea.addEventListener('input', sync);
  }

  // =====================================================================
  //  แอดมิน: การกระทำ
  // =====================================================================
  function select(sel) {
    S.selected = sel;
    if (sel) {
      const o = selectedObj();
      S.layer = sel.type;
      if (o && o.plant !== S.adminPlant) S.adminPlant = o.plant;
    }
    renderPanel(derive(), true);
    renderAdminMap();
    $$('#admin-layer button').forEach(b => b.classList.toggle('on', b.dataset.v === S.layer));
  }

  function locate(id) {
    S.adminTab = 'map';
    select({ type: 'machine', id });
    renderAll();
    $('#admin-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    adminMap.focusMachine(id);
  }

  /** อัปเดตหน้าจอทันที แล้วค่อยบันทึก */
  async function saveObj(type, o) {
    if (type === 'machine') S.machines = S.machines.map(m => m.id === o.id ? { ...m, ...o } : m);
    else S.zones = S.zones.map(z => z.id === o.id ? { ...z, ...o } : z);
    return write(() => type === 'machine' ? store.updateMachine(o.id, o) : store.updateZone(o.id, o));
  }

  function freeCode() {
    const used = new Set(S.machines.map(m => norm(m.name)));
    let n = 1;
    while (used.has(norm(`NEW-${n}`))) n++;
    return `NEW-${n}`;
  }

  async function addMachine() {
    const c = adminMap.center();
    const m = await write(() => store.createMachine({
      name: freeCode(), detail: '', plant: S.adminPlant, zone_id: null, x: c.x - 20, y: c.y - 15, w: 40, h: 30, verify: 1,
    }), 'เพิ่มเครื่องแล้ว — ลากไปวาง แล้วแก้รหัส');
    if (m) select({ type: 'machine', id: m.id });
  }

  async function addZone() {
    const c = adminMap.center();
    const z = await write(() => store.createZone({
      name: `โซนใหม่ ${S.zones.length + 1}`, plant: S.adminPlant, x: c.x - 80, y: c.y - 45, w: 160, h: 90,
    }), 'เพิ่มโซนแล้ว — ลากเพื่อจัดตำแหน่ง');
    if (z) select({ type: 'zone', id: z.id });
  }

  /** อ่านค่าจากฟอร์มในแผงด้านข้าง (จำกัดให้อยู่ในผังของโรงนั้น) */
  function formValues(form, o, type) {
    const f = form.elements;
    const num = (k, min, max) => {
      const v = Math.round(Number(f[k].value));
      return Math.min(max, Math.max(min, Number.isFinite(v) ? v : o[k]));
    };
    const plant = f.plant.value;
    const [vx, vy, vw, vh] = plantById(plant).view;
    const w = num('w', 6, vw), h = num('h', 6, vh);
    const v = { id: o.id, name: f.name.value.trim() || o.name, plant, w, h, x: num('x', vx, vx + vw - w), y: num('y', vy, vy + vh - h) };
    if (type === 'machine') {
      v.detail = f.detail.value.trim();
      v.shape = f.shape.value;
      v.zone_id = f.zone_id.value ? Number(f.zone_id.value) : null;
      if (plant !== o.plant) v.zone_id = null;
      if (v.name !== o.name) v.verify = 0;       // แก้รหัสเองแล้ว = ตรวจแล้ว
    }
    return v;
  }

  async function removeMachine(m) {
    if (!await ask(`ลบเครื่องจักร "${m.name}"?\nประวัติงานซ่อมเดิมยังอยู่`, { ok: 'ลบเครื่อง' })) return;
    const r = await write(() => store.deleteMachine(m.id), `ลบ "${m.name}" แล้ว`);
    if (r && S.selected && S.selected.type === 'machine' && S.selected.id === m.id) select(null);
  }

  // =====================================================================
  //  events
  // =====================================================================
  function bindEvents() {
    // ----- login -----
    $('#role-grid').innerHTML = Object.entries(Auth.ROLES).map(([key, r]) => `
      <button type="submit" class="role-btn" name="role" value="${key}" aria-label="เข้าเป็น${r.label} ${r.desc}">
        <span class="role-ico" aria-hidden="true">${ico(r.icon)}</span>
        <span class="role-text"><span class="role-name">${r.label}</span><span class="role-desc">${r.desc}</span></span>${ico('chevron', 'role-go')}
      </button>`).join('');
    $('#login-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    $('#login-form').addEventListener('submit', async e => {
      e.preventDefault();
      const role = e.submitter && e.submitter.value;
      if (!role) return;
      const name = $('#login-name').value.trim();
      try { localStorage.setItem('mtn.lastName', name); } catch { /* ignore */ }
      Sound.unlock();
      S.user = await Auth.login({ name, role });
      history.replaceState(null, '', location.pathname + location.search);
      startApp();
    });

    // ----- header -----
    $('#nav').addEventListener('click', e => {
      const b = e.target.closest('.nav-btn');
      if (b) go(b.dataset.view);
    });
    window.addEventListener('hashchange', route);
    $('#btn-user').addEventListener('click', async () => {
      if (await ask(`ออกจากระบบ (${S.user.name})?`, { ok: 'ออกจากระบบ', danger: false })) logout();
    });
    $('#btn-sound').addEventListener('click', () => {
      Sound.setEnabled(!Sound.enabled);
      toast(Sound.enabled ? 'เปิดเสียงเตือนแล้ว' : 'ปิดเสียงเตือนแล้ว', 'info', { ms: 2000 });
    });
    $('#btn-theme').addEventListener('click', () => {
      const t = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
      try { localStorage.setItem('mtn.ui.theme', t); } catch { /* ignore */ }
      applyTheme(t);
    });
    $('#sound-banner').addEventListener('click', () => Sound.unlock());
    Sound.onChange(renderSoundUi);

    // ----- report -----
    $('#report-form').addEventListener('submit', submitReport);
    $('#btn-submit').innerHTML = SUBMIT_LABEL;
    $('#f-plant').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.rPlant = b.dataset.v;
      renderAll();
    });
    $('#f-search').addEventListener('input', e => { S.rQ = e.target.value; renderAll(); });
    $('#f-search').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Enter = เลือก เมื่อรหัสตรงเป๊ะ หรือเหลือผลเดียว (ไม่เดาให้)
      const ids = $$('#f-results .result').map(b => Number(b.dataset.id));
      const exact = S.machines.find(m => ids.includes(m.id) && norm(m.name) === norm(S.rQ));
      if (exact) pickMachine(exact.id);
      else if (ids.length === 1) pickMachine(ids[0]);
    });
    $('#f-results').addEventListener('click', e => {
      const b = e.target.closest('.result');
      if (b) pickMachine(Number(b.dataset.id));
    });
    $('#f-machine').addEventListener('change', e => { if (e.target.value) pickMachine(Number(e.target.value)); });
    $('#f-picked').addEventListener('click', e => {
      if (!e.target.closest('[data-act="clear"]')) return;
      S.rPick = null;
      renderAll();
      $('#f-search').focus();
    });
    $('#btn-pick-map').addEventListener('click', openPickMap);
    $('#pick-plants').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.pickPlant = b.dataset.v;
      renderPickMap(derive());
      pickMap.fit();
    });
    const pdlg = $('#pick-dialog');
    $$('[data-close]', pdlg).forEach(b => b.addEventListener('click', () => pdlg.close()));
    pdlg.addEventListener('click', e => { if (e.target === pdlg) pdlg.close(); });
    pdlg.addEventListener('close', () => document.body.appendChild($('#toasts')));
    $('#report-form').addEventListener('input', renderSteps);
    $('#impact-chips').addEventListener('click', () => setTimeout(renderSteps, 0));
    $('#f-problem').addEventListener('input', e => e.target.classList.remove('invalid'));
    $('#f-stopped').addEventListener('change', e => e.currentTarget.classList.remove('invalid'));
    bindChips($('#impact-chips'), $('#f-impact'));
    $('#my-jobs').addEventListener('click', e => {
      const b = e.target.closest('.mini-job');
      if (b) openJob(Number(b.dataset.id));
    });

    // ----- ผังโรงงาน -----
    $('#plant-tabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (b) setPlant(b.dataset.v);
    });
    $('#map-search').addEventListener('change', e => { findOnMap(e.target.value); e.target.value = ''; e.target.blur(); });
    $('#machine-details').addEventListener('toggle', renderAll);
    $('#md-status').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.mdStatus = b.dataset.v;
      $$('#md-status button').forEach(x => x.classList.toggle('on', x === b));
      renderAll();
    });
    $('#md-list').addEventListener('click', e => {
      const tr = e.target.closest('[data-mid]');
      if (tr) openMachine(Number(tr.dataset.mid));
    });
    const mapCard = $('#map-card');
    $('#btn-full').hidden = !mapCard.requestFullscreen;
    $('#btn-full').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else mapCard.requestFullscreen().catch(() => toast('เบราว์เซอร์นี้ไม่รองรับเต็มจอ', 'error'));
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) document.body.appendChild($('#toasts'));
    });
    const mdlg = $('#machine-dialog');
    $$('[data-close]', mdlg).forEach(b => b.addEventListener('click', () => mdlg.close()));
    mdlg.addEventListener('click', e => {
      if (e.target === mdlg) { mdlg.close(); return; }
      const j = e.target.closest('[data-job]');
      const r = e.target.closest('[data-report]');
      if (j) { mdlg.close(); openJob(Number(j.dataset.job)); }
      else if (r) {
        mdlg.close();
        const m = S.machines.find(x => x.id === Number(r.dataset.report));
        if (document.fullscreenElement) document.exitFullscreen();
        if (m) reportMachine(m);
      }
    });
    mdlg.addEventListener('close', () => document.body.appendChild($('#toasts')));

    // ----- board -----
    const onJobClick = e => {
      const el = e.target.closest('[data-id]');
      if (el) openJob(Number(el.dataset.id));
    };
    $('#pending-list').addEventListener('click', onJobClick);
    $('#all-jobs').addEventListener('click', e => {
      if (e.target.closest('[data-act="more"]')) {
        S.jobsShow += 100;
        renderAll();
        return;
      }
      onJobClick(e);
    });
    $('#jobs-status').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.jobsStatus = b.dataset.v;
      S.jobsShow = 100;
      $$('#jobs-status button').forEach(x => x.classList.toggle('on', x === b));
      renderAll();
    });
    $('#jobs-q').addEventListener('input', e => {
      S.jobsQ = e.target.value;
      S.jobsShow = 100;
      renderAll();
    });
    $$('.zone-chip').forEach(c => c.addEventListener('click', () => {
      S.zoneFilter = null;
      renderAll();
    }));

    // ----- dialog -----
    const dlg = $('#job-dialog');
    $('#jd-form').addEventListener('submit', submitClose);
    $$('[data-close]', dlg).forEach(b => b.addEventListener('click', () => dlg.close()));
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });   // แตะพื้นหลัง = ปิด
    dlg.addEventListener('close', () => document.body.appendChild($('#toasts')));
    const cf = $('#confirm-dialog');
    cf.addEventListener('click', e => { if (e.target === cf) cf.close('cancel'); });
    cf.addEventListener('close', () => document.body.appendChild($('#toasts')));
    bindChips($('#note-chips'), $('#jd-note'));

    // ----- admin -----
    $('#btn-add-zone').addEventListener('click', addZone);
    $('#btn-add-machine').addEventListener('click', addMachine);
    $('#admin-tabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.adminTab = b.dataset.v;
      renderAll();
    });
    $('#admin-plants').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.adminPlant = b.dataset.v;
      S.selected = null;
      S.mShow = 60;
      renderAll();
      adminMap.fit();
    });
    $('#admin-layer').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.layer = b.dataset.v;
      S.selected = null;
      renderAll();
      renderPanel(derive(), true);
    });

    const panel = $('#zone-panel');
    panel.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const o = selectedObj();
      if (act === 'pick') { select({ type: 'machine', id: Number(b.dataset.id) }); adminMap.focusMachine(Number(b.dataset.id)); }
      else if (act === 'deselect') select(null);
      else if (act === 'verify' && o) {
        await write(() => store.updateMachine(o.id, { verify: 0 }), `ยืนยันรหัส ${o.name} แล้ว`);
        renderPanel(derive(), true);
      } else if (act === 'unassign') {
        await write(() => store.updateMachine(Number(b.dataset.id), { zone_id: null }));
        renderPanel(derive(), true);
      } else if (act === 'delete-machine' && o) {
        await removeMachine(o);
      } else if (act === 'delete-zone' && o) {
        const n = S.machines.filter(m => m.zone_id === o.id).length;
        if (!await ask(`ลบโซน "${o.name}"?${n ? `\nเครื่องจักร ${n} เครื่องในโซนนี้จะกลายเป็น "ไม่ระบุโซน"` : ''}`, { ok: 'ลบโซน' })) return;
        const r = await write(() => store.deleteZone(o.id), `ลบโซน "${o.name}" แล้ว`);
        if (r) select(null);
      }
    });
    panel.addEventListener('change', async e => {
      const o = selectedObj();
      if (!o) return;
      if (e.target.matches('select[data-act="assign"]')) {
        const id = Number(e.target.value);
        if (!id) return;
        await write(() => store.updateMachine(id, { zone_id: o.id }));
        renderPanel(derive(), true);
        return;
      }
      const form = e.target.closest('form[data-form="obj"]');
      if (form) {
        const type = S.selected.type;
        const v = formValues(form, o, type);
        if (Object.keys(v).every(k => v[k] === o[k])) return;
        const r = await saveObj(type, v);
        if (r && r.plant !== S.adminPlant) S.adminPlant = r.plant;
        renderPanel(derive(), true);
        renderAll();
      }
    });
    panel.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('form[data-form="obj"] input')) {
        e.preventDefault();
        e.target.blur();          // blur → change → บันทึก
      }
    });
    panel.addEventListener('submit', e => e.preventDefault());

    $('#m-search').addEventListener('input', e => {
      S.mQ = e.target.value;
      S.mShow = 60;
      renderAll();
    });
    $('#m-filter').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      S.mFilter = b.dataset.v;
      S.mShow = 60;
      renderAll();
    });

    const mt = $('#machine-table');
    mt.addEventListener('change', async e => {
      const row = e.target.closest('.mrow');
      const m = row && S.machines.find(x => x.id === Number(row.dataset.id));
      if (!m) return;
      const val = e.target.value.trim();
      if (e.target.matches('.m-name')) {
        if (!val) { e.target.value = m.name; toast('รหัสเครื่องต้องไม่ว่าง', 'error'); return; }
        if (val === m.name) return;
        const r = await write(() => store.updateMachine(m.id, { name: val, verify: 0 }), `บันทึกรหัส ${val} แล้ว`);
        if (!r) e.target.value = m.name;
      } else if (e.target.matches('.m-detail') && val !== m.detail) {
        await write(() => store.updateMachine(m.id, { detail: val }), 'บันทึกรายละเอียดแล้ว');
      }
    });
    mt.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('.m-name, .m-detail')) { e.preventDefault(); e.target.blur(); }
    });
    mt.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'more') { S.mShow += 100; b.blur(); renderAll(); return; }
      const m = S.machines.find(x => x.id === Number(b.closest('.mrow').dataset.id));
      if (!m) return;
      b.blur();
      if (b.dataset.act === 'locate') locate(m.id);
      else if (b.dataset.act === 'ok-machine') await write(() => store.updateMachine(m.id, { verify: 0 }), `ยืนยันรหัส ${m.name} แล้ว`);
      else if (b.dataset.act === 'del-machine') await removeMachine(m);
    });
    // เมื่อออกจากช่องที่พิมพ์ ให้ render ส่วนที่ค้างไว้
    [panel, mt].forEach(el => el.addEventListener('focusout', () => setTimeout(() => {
      if (!focusIn(el)) renderAll();
    }, 0)));

    $('#settings-body').addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const body = $('#settings-body');
      if (act === 'sound-normal') { Sound.unlock(); Sound.play('normal'); }
      else if (act === 'sound-stopped') { Sound.unlock(); Sound.play('stopped'); }
      else if (act === 'test-api') {
        const url = $('#set-api', body).value.trim();
        b.disabled = true;
        try {
          const r = await new Store.ApiStore(url).ping();
          const t = r && r.tables ? r.tables.length : 0;
          if (t >= 3) toast(`เชื่อมต่อสำเร็จ\nพบตารางครบ (${r.tables.join(', ')})`, 'ok', { ms: 5000 });
          else toast(`เชื่อมต่อ Worker ได้ แต่ยังไม่พบตารางใน D1 (${t}/3)\nรัน worker/schema.sql ก่อน`, 'warn', { ms: 8000 });
        } catch (err) {
          toast(`เชื่อมต่อไม่สำเร็จ\n${err.message}`, 'error', { ms: 6000 });
        } finally {
          b.disabled = false;
        }
      } else if (act === 'save-settings') {
        const mode = ($('input[name="mode"]:checked', body) || {}).value || 'local';
        const apiBase = $('#set-api', body).value.trim();
        if (mode === 'api' && !/^https?:\/\//i.test(apiBase)) {
          toast('กรุณาใส่ URL ของ Worker ให้ถูกต้อง (ขึ้นต้นด้วย https://)', 'error');
          $('#set-api', body).focus();
          return;
        }
        Store.saveSettings({ mode, apiBase });
        switchStore();
        toast(mode === 'api' ? 'เปลี่ยนไปใช้ Cloudflare API แล้ว' : 'เปลี่ยนไปใช้โหมดทดสอบ (localStorage) แล้ว', 'ok');
      } else if (act === 'demo') {
        await write(() => store.addDemoJobs(3), 'จำลองเครื่องเสีย 3 เครื่องแล้ว — ดูที่หน้า "ติดตามงาน"');
      } else if (act === 'clear') {
        if (!await ask('ล้างงานแจ้งซ่อมทั้งหมดในโหมดทดสอบ?\nผังและเครื่องจักรยังอยู่ · กู้คืนไม่ได้', { ok: 'ล้างงาน' })) return;
        store.clearJobs();
        resetData();
        await refresh({ meta: true });
        renderSettings(true);
        toast('ล้างงานแจ้งซ่อมแล้ว', 'ok');
      } else if (act === 'seed') {
        if (!await ask('โหลดโซนและเครื่องจักรจากแบบแปลนใหม่ทั้งหมด?\nรหัส/ตำแหน่งที่แก้ไว้ และงานแจ้งซ่อม จะถูกล้าง · กู้คืนไม่ได้', { ok: 'โหลดใหม่' })) return;
        store.seedLayout();
        resetData();
        await refresh({ meta: true });
        renderSettings(true);
        toast('โหลดผังจากแบบแปลนแล้ว', 'ok');
      }
    });

    // ----- อื่น ๆ -----
    // โหมดทดสอบ: เปิดหลายแท็บ (เช่น แท็บพนักงาน + แท็บช่าง) แล้วอัปเดตกันทันที
    window.addEventListener('storage', e => {
      if (S.user && store.mode === 'local' && e.key && e.key.startsWith('mtn.db.')) refresh({ meta: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && S.user) refresh();
    });
    window.addEventListener('auth:unauthorized', () => {
      if (!S.user) return;
      toast('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'error');
      logout();
    });
  }

  function switchStore() {
    initStore();
    resetData();
    setConn(true);
    renderSettings(true);
    refresh({ meta: true });
  }

  // =====================================================================
  //  start
  // =====================================================================
  let loginMap = null;
  function showLogin() {
    $('#view-app').hidden = true;
    $('#view-login').hidden = false;
    try { $('#login-name').value = localStorage.getItem('mtn.lastName') || ''; } catch { /* ignore */ }
    document.title = 'แจ้งซ่อมเครื่องจักร';
    // ภาพประกอบ: ผังโรงงานจริง (โรง 2)
    if (!loginMap) {
      const art = window.PLANT_LAYOUT.build();
      const plant = plantById('2');
      loginMap = new PlantMap($('#login-map'), { plant, mini: true });
      loginMap.render({ zones: [], machines: art.machines });
    }
  }

  function logout() {
    Auth.logout();
    stopPolling();
    S.user = null;
    S.view = null;
    if ($('#job-dialog').open) $('#job-dialog').close();
    renderSoundUi();
    showLogin();
  }

  function startApp() {
    S.user = Auth.current();
    if (!S.user) return showLogin();
    $('#view-login').hidden = true;
    $('#view-app').hidden = false;
    S.view = null;
    S.loaded = false;
    S.seen.clear();
    sigs.clear();
    renderUser();
    renderNav();
    setConn(true);
    Sound.init();
    renderSoundUi();
    route();
    refresh({ meta: true });
    startPolling();
  }

  function init() {
    applyTheme(currentTheme());
    try {
      const p = localStorage.getItem('mtn.plant');
      if (p && (p === 'all' || PLANTS.some(x => x.id === p))) S.plant = p;
    } catch { /* ignore */ }
    initStore();

    // ภาพรวมทุกโรง
    const ov = $('#board-overview');
    overview = PLANTS.map(plant => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'ov-card';
      card.dataset.plant = plant.id;
      card.style.setProperty('--ratio', plant.view[2] / plant.view[3]);
      card.innerHTML = `<span class="ov-head"><b>${esc(plant.name)}</b><span class="ov-info"></span></span><span class="muted small">${esc(plant.note)}</span><div class="ov-map"></div>`;
      card.addEventListener('click', () => setPlant(plant.id));
      ov.appendChild(card);
      return { plant, card, info: $('.ov-info', card), map: new PlantMap($('.ov-map', card), { plant, mini: true }) };
    });

    boardMap = new PlantMap($('#board-map'), {
      plant: plantById(S.plant),
      onMachine: openMachine,
      onZone: id => {
        S.zoneFilter = S.zoneFilter === id ? null : id;
        renderAll();
      },
    });
    adminMap = new PlantMap($('#admin-map'), {
      plant: PLANTS[0],
      editable: true,
      onSelect: select,
      onChange: (type, o) => saveObj(type, o).then(() => renderPanel(derive(), true)),
    });
    bindEvents();
    startApp();
  }

  // สำหรับดีบักในคอนโซล: MTN.store, MTN.state
  window.MTN = { get store() { return store; }, state: S, refresh };

  init();
})();
