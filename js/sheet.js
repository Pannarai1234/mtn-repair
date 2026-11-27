/*
 * SheetFeed — ดึงใบงานจริงจาก Google Sheet ของ Monitoring Center
 * แล้วแปลงเป็นรายการ { wo, code, mid?, open, stopped, time, problem, status, line }
 *
 * แหล่งข้อมูลที่ใช้ได้ (ใส่ใน APP_CONFIG.SHEET.URL หรือหน้า "ตั้งค่าระบบ")
 *   1) ลิงก์ "เผยแพร่ไปยังเว็บ" แบบ CSV ของแท็บใบงาน   …/pub?gid=…&single=true&output=csv
 *   2) ลิงก์ Google Sheet ธรรมดา ที่แชร์ "ทุกคนที่มีลิงก์ดูได้"   …/spreadsheets/d/<ID>/edit#gid=…
 *   3) URL ของ Apps Script ที่ส่งข้อมูลเป็น JSON (array ของแถว หรือ array ของ object)
 *   4) SOURCE: 'apps-script' — หน้าผังที่เปิดผ่าน Apps Script ของ Monitoring Center (?page=layout)
 *      ขอใบงานค้างจาก google.script.run.getLayoutWorkOrders(token) ชีตไม่ต้องเปิดสาธารณะ
 *      ต้องล็อกอินด้วยบัญชีในชีต AuthorizedUsers ก่อน (verifyDashboardLogin) — ดู apps-script/Layout.gs
 *
 * คอลัมน์: เว้นว่างใน COLUMNS = ให้ระบบเดาจากชื่อหัวคอลัมน์ (เช่น "MACHINE CODE", "ประทับเวลา")
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG.SHEET || {};
  const norm = window.PLANT_LAYOUT.normCode;
  const KEY = 'mtn.sheet';

  const CLOSED = (CFG.CLOSED || ['เสร็จสิ้น', 'เสร็จ', 'ปิดงาน', 'ปิดแล้ว', 'completed', 'complete', 'closed', 'done', 'finish'])
    .map(s => s.toLowerCase());
  const OPENISH = ['รอ', 'กำลัง', 'ค้าง', 'pending', 'repairing', 'open', 'waiting', 'in progress'];

  // ลำดับความสำคัญของรูปแบบชื่อหัวคอลัมน์ (ตัวแรกที่ตรงชนะ)
  const PATTERNS = {
    wo: [/work\s*order|w\s*\/?\s*o\s*no|เลขที่ใบ|ใบงาน|ใบแจ้ง/i],
    code: [/machine\s*code|รหัสเครื่อง|หมายเลขเครื่อง|เลขเครื่อง/i, /machine|เครื่องจักร/i],
    status: [/status|สถานะ/i],
    time: [/ประทับเวลา|timestamp|วันที่แจ้ง|เวลาแจ้ง|date\s*time/i, /วันที่|date|เวลา|time/i],
    problem: [/issued|อาการ|ปัญหา|problem|symptom/i, /รายละเอียด|detail/i],
    stopped: [/เครื่องหยุด|หยุดเครื่อง|machine\s*stop|downtime/i],
    line: [/^\s*line|ไลน์/i],
  };

  function settings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* ignore */ }
    return {
      url: s.url != null ? s.url : (CFG.URL || ''),
      tab: s.tab != null ? s.tab : (CFG.TAB || ''),
    };
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }

  /** แปลงลิงก์ที่วางมา ให้เป็น URL ที่ดึงข้อมูลได้ */
  function sourceUrl(url, tab) {
    url = String(url || '').trim();
    if (!url) return null;
    if (/output=csv|tqx=out:csv|script\.google(usercontent)?\.com/.test(url) || !/\/spreadsheets\/d\//.test(url)) return url;
    const id = url.match(/\/spreadsheets\/d\/([\w-]+)/)[1];
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
    let u = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv`;
    if (tab) u += `&sheet=${encodeURIComponent(tab)}`;
    else if (gid) u += `&gid=${gid}`;
    return u;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(v => String(v).trim() !== ''));
  }

  /** เวลา: รองรับ ISO, "26/11/2026 11:37:47", ปี พ.ศ. และวันที่แบบ Date(…) ของ gviz */
  function parseTime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v > 1e11 ? v : null;
    const s = String(v).trim();
    let m = s.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/);
    if (m) return new Date(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      let a = +m[1], b = +m[2], y = +m[3];
      if (y < 100) y += 2000;
      if (y > 2400) y -= 543;
      const [d, mo] = b > 12 ? [b, a] : [a, b];          // ค่าเริ่มต้น วัน/เดือน/ปี
      return new Date(y, mo - 1, d, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }

  const isClosed = v => {
    const s = String(v || '').toLowerCase();
    return !/ไม่|not|un/.test(s) && CLOSED.some(w => s.includes(w));
  };
  const isStopFlag = v => {
    const s = String(v || '').trim().toLowerCase();
    if (!s || /ไม่|no|false|^0$|^n$/.test(s)) return false;
    return /ใช่|หยุด|yes|true|^1$|^y$|stop|✓|✔/.test(s);
  };

  /** หาคอลัมน์ให้แต่ละฟิลด์ (ใช้ชื่อที่กำหนดใน COLUMNS ก่อน ถ้าไม่มีค่อยเดา) */
  function mapColumns(headers, rows) {
    const H = headers.map(h => String(h || '').trim());
    const forced = CFG.COLUMNS || {};
    const out = {};
    for (const field of Object.keys(PATTERNS)) {
      if (forced[field]) {
        const i = H.findIndex(h => h.toLowerCase() === String(forced[field]).toLowerCase());
        out[field] = i >= 0 ? i : -1;
        continue;
      }
      let idx = -1;
      for (const re of PATTERNS[field]) {
        const hits = H.map((h, i) => (re.test(h) ? i : -1)).filter(i => i >= 0 && !Object.values(out).includes(i));
        if (!hits.length) continue;
        if (field === 'status' && hits.length > 1) {
          // หลายคอลัมน์ชื่อ "สถานะ" — เลือกคอลัมน์ที่มีคำว่า เสร็จสิ้น/รอซ่อม ฯลฯ มากที่สุด
          const score = i => rows.reduce((n, r) => {
            const s = String(r[i] || '').toLowerCase();
            return n + (CLOSED.some(w => s.includes(w)) || OPENISH.some(w => s.includes(w)) ? 1 : 0);
          }, 0);
          idx = hits.sort((a, b) => score(b) - score(a))[0];
        } else idx = hits[0];
        break;
      }
      out[field] = idx;
    }
    return out;
  }

  /**
   * ดึงและแปลงข้อมูล
   * คืน { url, headers, cols, rows } — rows ทุกแถวที่มีรหัสเครื่อง
   */
  /** หน้าเว็บนี้รันอยู่ใน Apps Script (มี google.script.run) และตั้งให้อ่านชีตผ่าน Apps Script */
  const viaAppsScript = () => CFG.SOURCE === 'apps-script' && !!(window.google && google.script && google.script.run);

  /** เรียกฟังก์ชันฝั่งเซิร์ฟเวอร์ของ Apps Script แบบ Promise */
  const gsRun = (name, ...args) => new Promise((resolve, reject) => {
    google.script.run.withSuccessHandler(resolve).withFailureHandler(err => reject(err))[name](...args);
  });

  // ---------- ล็อกอิน (บัญชีเดียวกับ Monitoring Center: ชีต AuthorizedUsers) ----------
  const TOKEN_KEY = 'mtn.wo.token';
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  const setToken = t => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

  /** ล็อกอินด้วย Email + รหัสผ่าน — คืน { ok, error } */
  async function login(email, password) {
    try {
      const r = await gsRun('verifyDashboardLogin', email, password);
      if (r && r.success && r.token) { setToken(r.token); return { ok: true }; }
      return { ok: false, error: (r && r.error) || 'เข้าสู่ระบบไม่สำเร็จ' };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
  const logout = () => setToken('');
  // ต้อง Login ไหม — ฝั่ง Apps Script บอกมา (ตาม REQUIRE_LOGIN ตัวเดียวกับ Dashboard)
  let loginRequired = false;

  async function load(opts = {}) {
    let table;
    if (opts.url == null && viaAppsScript()) {
      const needLogin = () => Object.assign(new Error('กรุณาเข้าสู่ระบบเพื่อดูใบงาน'), { code: 'LOGIN' });
      let r;
      try {
        r = await gsRun('getLayoutWorkOrders', getToken());
      } catch (err) {
        throw new Error(`อ่านใบงานไม่ได้: ${String((err && err.message) || err)}`);
      }
      loginRequired = !!(r && r.login);
      if (!r || r.auth === false) { setToken(''); throw needLogin(); }     // ต้อง Login / token หมดอายุ / ถูกระงับสิทธิ์
      if (r.error) throw new Error(r.error);
      table = r.values || [];
      return parseTable(table, 'apps-script');
    }
    const st = opts.url != null ? opts : settings();
    const url = sourceUrl(st.url, st.tab);
    if (!url) throw new Error('ยังไม่ได้ใส่ลิงก์ Google Sheet');
    let res;
    try {
      res = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store', redirect: 'follow' });
    } catch {
      throw new Error('ดึงข้อมูลจาก Google Sheet ไม่ได้ (เครือข่ายหรือชีตไม่ได้เปิดให้อ่าน)');
    }
    if (!res.ok) throw new Error(`Google Sheet ตอบกลับผิดพลาด (${res.status}) ตรวจว่าแชร์หรือเผยแพร่แล้ว`);
    const text = await res.text();
    if (/^\s*[[{]/.test(text)) {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : (data.rows || data.data || []);
      if (list.length && !Array.isArray(list[0])) {
        const headers = Object.keys(list[0]);
        table = [headers, ...list.map(o => headers.map(h => o[h]))];
      } else table = list;
    } else {
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('ได้หน้าเว็บแทนข้อมูล แปลว่าชีตยังไม่ได้แชร์ "ทุกคนที่มีลิงก์" หรือยังไม่ได้เผยแพร่');
      table = parseCsv(text);
    }
    return parseTable(table, url);
  }

  /** ตาราง (แถวแรก = หัวคอลัมน์) → { url, headers, cols, rows } */
  function parseTable(table, url) {
    // ข้ามแถวว่างด้านบน (บางชีตมีหัวรายงานก่อนหัวตาราง): ใช้แถวแรกที่หาคอลัมน์รหัสเครื่องเจอเป็นหัวตาราง
    table = table.filter(r => r && r.some(v => String(v ?? '').trim() !== ''));
    const hi = table.slice(0, 10).findIndex(r => mapColumns(r.map(h => String(h ?? '').trim()), []).code >= 0);
    if (hi > 0) table = table.slice(hi);
    if (table.length < 2) throw new Error('ชีตว่าง หรือไม่มีแถวข้อมูล');
    const headers = table[0].map(h => String(h ?? '').trim());
    const body = table.slice(1);
    const cols = mapColumns(headers, body.slice(0, 300));
    if (cols.code < 0) throw new Error('ไม่พบคอลัมน์รหัสเครื่อง (เช่น "MACHINE CODE") ตั้งชื่อคอลัมน์ใน APP_CONFIG.SHEET.COLUMNS.code');
    const get = (r, f) => (cols[f] >= 0 ? r[cols[f]] : '');
    const rows = [];
    for (const r of body) {
      const code = String(get(r, 'code') || '').trim();
      if (!code) continue;
      const status = String(get(r, 'status') || '').trim();
      rows.push({
        wo: String(get(r, 'wo') || '').trim(),
        code,
        key: norm(code),
        status,
        open: cols.status >= 0 ? !isClosed(status) : true,
        // เครื่องหยุด: คอลัมน์เครื่องหยุดเป็น "ใช่" หรือสถานะบอกว่าหยุด (เช่น "MACHINE STOP")
        stopped: isStopFlag(get(r, 'stopped')) || (/stop|หยุด/i.test(status) && !/ไม่|non/i.test(status)),
        time: parseTime(get(r, 'time')),
        problem: String(get(r, 'problem') || '').trim(),
        line: String(get(r, 'line') || '').trim(),
      });
    }
    return { url, headers, cols, rows };
  }

  /**
   * แปลงแถวใบงานเป็น "งานค้าง" ของเว็บนี้ (เฉพาะใบงานที่ยังไม่ปิด และหาเครื่องบนผังเจอ)
   *   machines  รายการเครื่องจักรของผัง
   *   firstSeen Map(id → เวลาที่เห็นครั้งแรก) ใช้แทนเวลาแจ้ง ถ้าชีตไม่มีคอลัมน์เวลา
   * คืน { jobs, unmatched: [[รหัสในชีต, จำนวนใบงาน], …] }
   */
  function toJobs(rows, machines, firstSeen = new Map()) {
    const byKey = new Map(machines.map(m => [norm(m.name), m]));
    // รหัสตรงตัว หรือมีรหัสเครื่องปนอยู่ในข้อความ เช่น "F1139 (EXTRUDER)"
    const find = code => byKey.get(norm(code))
      || String(code).split(/[\s,/()|:;]+/).map(t => byKey.get(norm(t))).find(Boolean) || null;
    const maxDays = Number(CFG.MAX_DAYS) || 0;
    const now = Date.now();
    const jobs = [];
    const unmatched = new Map();
    const seen = new Set();
    for (const r of rows) {
      if (!r.open) continue;
      if (maxDays && r.time && now - r.time > maxDays * 864e5) continue;
      const m = find(r.code);
      if (!m) { unmatched.set(r.code, (unmatched.get(r.code) || 0) + 1); continue; }
      const id = 'WO:' + (r.wo || `${r.key}:${r.time || ''}:${r.problem}`);
      if (seen.has(id)) continue;                 // แถวซ้ำของใบงานเดียวกัน
      seen.add(id);
      if (!firstSeen.has(id)) firstSeen.set(id, now);
      jobs.push({
        id, source: 'sheet', wo: r.wo, machine_id: m.id, status: 'open',
        stopped: r.stopped ? 1 : 0,
        problem: r.problem || r.status || 'ใบงานจาก Monitoring Center',
        impact: r.line ? `ไลน์ ${r.line}` : '',
        created_at: new Date(r.time || firstSeen.get(id)).toISOString(),
        reported_by: '',
        sheet_status: r.status,
      });
    }
    return { jobs, unmatched: [...unmatched] };
  }

  window.SheetFeed = {
    settings, save, load, toJobs, sourceUrl, parseTime,
    enabled: () => viaAppsScript() || !!settings().url,
    viaAppsScript, login, logout, loggedIn: () => !!getToken(), loginRequired: () => loginRequired,
  };
})();
