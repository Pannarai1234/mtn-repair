/*
 * ตัวโหลดหน้าผังโรงงานเข้าไปใน Google Apps Script (Monitoring Center ?page=layout)
 *
 * ไฟล์ Layout.html ใน Apps Script มีแค่สคริปต์เรียกไฟล์นี้ — ตัวผังทั้งหมด (HTML/CSS/JS) โหลดจาก GitHub Pages
 * แก้เว็บแล้วอัปโหลดขึ้น GitHub ก็พอ ไม่ต้องแก้ Apps Script
 * ส่วนข้อมูลใบงาน (ความลับ) ขอผ่าน google.script.run หลังล็อกอินเท่านั้น ไม่ได้อยู่บน GitHub
 */
(async function () {
  'use strict';
  const BASE = window.MTN_BASE || 'https://pannarai1234.github.io/mtn-repair/';
  const v = Math.floor(Date.now() / 300000);          // เปลี่ยนทุก 5 นาที: ได้ไฟล์ใหม่หลังอัปเดต แต่ยังใช้แคชได้
  const abs = href => (/^(https?:|data:)/.test(href) ? href : BASE + href);
  const boot = document.getElementById('boot');

  try {
    const res = await fetch(BASE + 'index.html?v=' + v, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

    // หัวหน้า: สคริปต์ธีม, ฟอนต์, CSS
    for (const s of doc.head.querySelectorAll('script:not([src])')) {
      const e = document.createElement('script');
      e.textContent = s.textContent;
      document.head.appendChild(e);
    }
    const css = [];
    for (const l of doc.head.querySelectorAll('link')) {
      const e = document.createElement('link');
      for (const a of l.attributes) e.setAttribute(a.name, a.value);
      if (l.getAttribute('href')) e.setAttribute('href', abs(l.getAttribute('href')) + (l.rel === 'stylesheet' && !/^https?:/.test(l.getAttribute('href')) ? '?v=' + v : ''));
      if (l.rel === 'stylesheet') css.push(new Promise(ok => { e.onload = e.onerror = ok; }));
      document.head.appendChild(e);
    }
    await Promise.all(css);

    // เนื้อหน้า (ไม่รวมสคริปต์) แล้วโหลดสคริปต์ตามลำดับ
    const scripts = [...doc.querySelectorAll('script[src]')].map(s => s.getAttribute('src'));
    doc.querySelectorAll('script').forEach(s => s.remove());
    document.body.innerHTML = doc.body.innerHTML;
    for (const a of doc.body.attributes) document.body.setAttribute(a.name, a.value);

    for (const src of scripts) {
      await new Promise((ok, fail) => {
        const e = document.createElement('script');
        e.src = abs(src) + '?v=' + v;
        e.onload = ok;
        e.onerror = () => fail(new Error('โหลดไม่ได้: ' + src));
        document.body.appendChild(e);
      });
      if (src === 'js/config.js') {
        // แสดงผังอย่างเดียว และอ่านใบงานผ่าน Apps Script (ต้องล็อกอิน)
        window.APP_CONFIG.EMBED = 'layout';
        window.APP_CONFIG.SHEET = Object.assign({}, window.APP_CONFIG.SHEET, { SOURCE: 'apps-script', URL: '', ONLY: true });
      }
    }
  } catch (err) {
    console.error('[gas-loader]', err);
    const msg = 'โหลดผังโรงงานไม่ได้ (' + (err && err.message || err) + ') ลองกดรีเฟรช';
    if (boot) boot.textContent = msg; else document.body.textContent = msg;
  }
})();
