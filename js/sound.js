/*
 * เสียงเตือน — สังเคราะห์ด้วย Web Audio API (ไม่ต้องมีไฟล์เสียง)
 *
 * เบราว์เซอร์ไม่อนุญาตให้เล่นเสียงจนกว่าผู้ใช้จะแตะหน้าจออย่างน้อย 1 ครั้ง
 * ถ้ายังเล่นไม่ได้ Sound.blocked จะเป็น true และแอปจะแสดงแถบ "แตะเพื่อเปิดเสียง"
 */
(function () {
  'use strict';

  const KEY = 'mtn.sound';
  let ctx = null;
  let enabled = (() => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } })();
  const listeners = new Set();

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      ctx.onstatechange = notify;
    }
    return ctx;
  }

  function notify() { listeners.forEach(fn => fn()); }

  function unlock() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume().then(notify, notify);
  }

  function tone(c, freq, start, dur, type, gain) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.02);
    g.gain.setValueAtTime(gain, start + dur - 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(c.destination);
    o.start(start);
    o.stop(start + dur + 0.02);
  }

  const Sound = {
    get enabled() { return enabled; },
    get blocked() { return !!ctx && ctx.state !== 'running'; },

    setEnabled(on) {
      enabled = !!on;
      try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* ignore */ }
      if (enabled) unlock();
      notify();
    },

    /** เรียกหลังผู้ใช้แตะ/คลิก เพื่อปลดล็อกเสียง */
    unlock,

    /** สร้าง AudioContext ล่วงหน้า (จะอยู่ในสถานะ suspended จนกว่าผู้ใช้แตะ) */
    init() { ensure(); notify(); },

    onChange(fn) { listeners.add(fn); },

    /**
     * kind: 'normal' = แจ้งซ่อมทั่วไป (ติ๊ง-ต่อง 2 รอบ)
     *       'stopped' = เครื่องหยุดทำงาน (ไซเรนสลับเสียง ดังและยาวกว่า + สั่น)
     *       'test'    = ทดสอบเสียง
     */
    play(kind = 'normal') {
      if (!enabled) return;
      const c = ensure();
      if (!c) return;
      if (c.state === 'suspended') c.resume().catch(() => {});
      const t = c.currentTime + 0.05;
      if (kind === 'stopped') {
        for (let i = 0; i < 8; i++) tone(c, i % 2 ? 660 : 990, t + i * 0.24, 0.22, 'square', 0.22);
        if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400]);
      } else {
        for (let r = 0; r < 2; r++) {
          tone(c, 880, t + r * 0.7, 0.18, 'sine', 0.35);
          tone(c, 1320, t + r * 0.7 + 0.22, 0.28, 'sine', 0.35);
        }
        if (navigator.vibrate) navigator.vibrate(200);
      }
    },
  };

  // ปลดล็อกเสียงอัตโนมัติเมื่อผู้ใช้แตะหน้าจอครั้งแรก
  ['pointerdown', 'keydown'].forEach(ev =>
    document.addEventListener(ev, () => { if (enabled) unlock(); }, { capture: true, passive: true }));

  window.Sound = Sound;
})();
