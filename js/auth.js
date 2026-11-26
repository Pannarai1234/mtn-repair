/*
 * Auth — จุดต่อระบบล็อกอิน
 *
 * ตอนนี้: เลือกบทบาท + ใส่ชื่อ แล้วเก็บ session ไว้ใน localStorage (ยังไม่มีรหัสผ่าน)
 * อนาคต: แก้แค่ฟังก์ชัน login() ให้เรียก POST /auth/login ที่ Worker
 *        แล้วเก็บ token ที่ได้ไว้ใน session.token — ApiStore จะแนบ
 *        "Authorization: Bearer <token>" ให้ทุกคำขอโดยอัตโนมัติ (ดู authHeaders)
 *        ฝั่ง Worker มีฟังก์ชัน authenticate()/requirePerm() รอไว้แล้ว
 */
(function () {
  'use strict';

  const KEY = 'mtn.session';

  // สิทธิ์ของแต่ละบทบาท — ต้องตรงกับ PERMS ใน worker/src/index.js
  const ROLES = {
    employee: { label: 'พนักงาน', icon: 'user', desc: 'แจ้งซ่อมเครื่องจักร',
      perms: ['job:create', 'job:view'] },
    tech:     { label: 'ช่าง', icon: 'wrench', desc: 'ดูงานค้างและปิดงาน',
      perms: ['job:create', 'job:view', 'job:close'] },
    admin:    { label: 'แอดมิน', icon: 'sliders', desc: 'ตั้งค่าแผนผังและเครื่องจักร',
      perms: ['job:create', 'job:view', 'job:close', 'layout:edit', 'machine:edit', 'settings:edit'] },
  };

  // session เก็บ 2 ที่: sessionStorage (เฉพาะแท็บนี้) มาก่อน แล้วค่อย localStorage (จำไว้ตอนเปิดใหม่)
  // ทำให้เปิดหลายแท็บคนละบทบาทได้ เช่น แท็บช่าง + แท็บพนักงาน ตอนทดสอบ
  const stores = () => {
    const out = [];
    try { out.push(window.sessionStorage); } catch { /* blocked */ }
    try { out.push(window.localStorage); } catch { /* blocked */ }
    return out;
  };

  function read() {
    for (const st of stores()) {
      try {
        const s = JSON.parse(st.getItem(KEY));
        if (s) return s;
      } catch { /* ignore */ }
    }
    return null;
  }

  const Auth = {
    ROLES,

    /** ผู้ใช้ปัจจุบัน { name, role } หรือ null */
    current() {
      const s = read();
      return s && s.user && ROLES[s.user.role] ? s.user : null;
    },

    /**
     * เข้าสู่ระบบ
     * TODO(auth): เปลี่ยนเป็น
     *   const res = await fetch(API_BASE + '/auth/login', { method:'POST', body: JSON.stringify({ username, password }) })
     *   const { token, user } = await res.json()
     */
    async login({ name, role }) {
      if (!ROLES[role]) throw new Error('บทบาทไม่ถูกต้อง');
      const user = { name: (name || '').trim() || ROLES[role].label, role };
      const session = { user, token: null, at: new Date().toISOString() };
      for (const st of stores()) {
        try { st.setItem(KEY, JSON.stringify(session)); } catch { /* private mode */ }
      }
      return user;
    },

    logout() {
      for (const st of stores()) {
        try { st.removeItem(KEY); } catch { /* ignore */ }
      }
    },

    token() {
      const s = read();
      return s ? s.token : null;
    },

    /** header ที่ต้องแนบไปกับทุกคำขอ API */
    authHeaders() {
      const t = this.token();
      return t ? { Authorization: 'Bearer ' + t } : {};
    },

    can(perm) {
      const u = this.current();
      return !!(u && ROLES[u.role].perms.includes(perm));
    },
  };

  window.Auth = Auth;
})();
