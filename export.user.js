// ==UserScript==
// @name         Huginn → Horarios (exportar turnos)
// @namespace    jenspt.tools
// @version      1.1.0
// @description  Botón flotante en Huginn que copia al portapapeles los turnos de una persona (por defecto tú), listos para pegar en la app Horarios.
// @author       Jenspt
// @match        https://huginn.vibe.oddin.gg/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=oddin.gg
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---- 1. Token: primero el almacenamiento del navegador, después (solo si hace falta) las llamadas de la página ----
  let authHeader = null;
  const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
  function decode(tok) {
    try { let p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); p += '='.repeat((4 - p.length % 4) % 4); return JSON.parse(atob(p)); } catch (e) { return null; }
  }
  function tokenFromStorage() {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const v = store.getItem(store.key(i)); if (!v) continue;
        const cands = [];
        if (JWT.test(v.trim())) cands.push(v.trim());
        else if (v[0] === '{') { try { const o = JSON.parse(v); (function walk(x) { if (typeof x === 'string' && JWT.test(x)) cands.push(x); else if (x && typeof x === 'object') Object.values(x).forEach(walk); })(o); } catch (e) {} }
        for (const t of cands) { const d = decode(t); if (d && d.userId && d.purpose === 'access' && (!d.exp || d.exp * 1000 > Date.now())) return 'Bearer ' + t; }
      }
    }
    return null;
  }
  let patched = false;
  function patchFetch() {
    if (patched) return; patched = true;
    const of = window.fetch;
    window.fetch = function (input, init) {
      try {
        const h = init && init.headers;
        let a = null;
        if (h instanceof Headers) a = h.get('Authorization'); else if (h) a = h.Authorization || h.authorization;
        if (!a && input instanceof Request) a = input.headers.get('Authorization');
        if (a) authHeader = a;
      } catch (e) {}
      return of.apply(this, arguments);
    };
  }
  function getAuth() { return tokenFromStorage() || authHeader; }
  function myUserId() { const a = getAuth(); const d = a && decode(a.replace(/^Bearer\s+/i, '')); return d ? d.userId : null; }

  // ---- 2. UI ----
  const css = `
    #hx-box{position:fixed;right:16px;bottom:16px;z-index:99999;font:13px system-ui,sans-serif;color:#e8e6f0}
    #hx-row{display:flex;align-items:center;gap:6px}
    #hx-btn{background:#6121fe;color:#fff;border:0;border-radius:10px;padding:9px 13px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35)}
    #hx-btn:disabled{opacity:.6;cursor:wait}
    #hx-box select{background:#1b1b21;color:#e8e6f0;border:1px solid #2d2d37;border-radius:8px;padding:6px 8px;max-width:180px}
    #hx-msg{margin-top:6px;background:#1b1b21;border:1px solid #2d2d37;border-radius:8px;padding:6px 10px;display:none;max-width:320px}
  `;
  function mount() {
    if (document.getElementById('hx-box') || !document.body) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const box = document.createElement('div'); box.id = 'hx-box';
    box.innerHTML = `
      <div id="hx-row">
        <select id="hx-who" title="Persona"><option value="">Yo</option></select>
        <select id="hx-range" title="Rango">
          <option value="week">Esta semana</option>
          <option value="2w">Esta y la siguiente</option>
          <option value="4w" selected>Próximas 4 semanas</option>
          <option value="8w">Próximas 8 semanas</option>
        </select>
        <button id="hx-btn">📋 Copiar turnos</button>
      </div>
      <div id="hx-msg"></div>`;
    document.body.appendChild(box);
    document.getElementById('hx-btn').addEventListener('click', run);
    document.getElementById('hx-who').addEventListener('focus', loadUsers, { once: true });
  }
  function msg(t, ok) {
    const m = document.getElementById('hx-msg'); if (!m) return; m.style.display = 'block'; m.textContent = t;
    m.style.borderColor = ok ? '#22c55e' : '#ef4444';
    clearTimeout(msg._t); msg._t = setTimeout(() => { m.style.display = 'none'; }, 7000);
  }
  async function api(path) {
    const a = getAuth(); if (!a) throw new Error('sin sesión');
    const res = await fetch(path, { headers: { Accept: 'application/json', Authorization: a } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  let users = null;
  async function loadUsers() {
    try {
      const r = await api('/api/users?page=1&limit=1000');
      users = (r.data || r).filter(u => u.isActive !== false).sort((a, b) => a.displayName.localeCompare(b.displayName));
      const sel = document.getElementById('hx-who'); const me = myUserId();
      sel.innerHTML = '';
      users.forEach(u => { const o = document.createElement('option'); o.value = u.id; o.textContent = u.displayName + (u.id === me ? ' (yo)' : ''); if (u.id === me) o.selected = true; sel.appendChild(o); });
    } catch (e) { msg('No pude cargar la lista de personas: ' + (e.message || e), false); }
  }
  function range() {
    const v = document.getElementById('hx-range').value;
    const now = new Date(); const day = (now.getDay() + 6) % 7; // lunes = 0
    const from = new Date(now); from.setDate(now.getDate() - day); from.setHours(0, 0, 0, 0);
    const weeks = v === 'week' ? 1 : v === '2w' ? 2 : v === '4w' ? 4 : 8;
    const to = new Date(from); to.setDate(from.getDate() + 7 * weeks); to.setMilliseconds(-1);
    return { from, to };
  }

  // ---- 3. Pedir eventos y filtrar por persona ----
  async function run() {
    const btn = document.getElementById('hx-btn');
    const who = document.getElementById('hx-who').value || myUserId();
    if (!getAuth()) { patchFetch(); msg('No encontré tu sesión. Cambia de semana en el calendario y vuelve a intentar.', false); return; }
    if (!who) { msg('No pude identificar al usuario.', false); return; }
    btn.disabled = true;
    try {
      const { from, to } = range();
      const all = await api(`/api/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      const list = Array.isArray(all) ? all : (all.data || []);
      const mine = list.filter(e => Array.isArray(e.attendeeIds) && e.attendeeIds.includes(who));
      const person = users && users.find(u => u.id === who);
      const out = mine.map(e => ({
        id: e.id, title: e.title, startTime: e.startTime, endTime: e.endTime,
        allDay: !!e.allDay, eventFormat: e.eventFormat || null, notes: e.notes || '',
        attendeeIds: [who], attendeeName: person ? person.displayName : undefined, isRecurring: !!e.isRecurring
      }));
      const text = JSON.stringify(out);
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text'); else await navigator.clipboard.writeText(text);
      msg(`Copiados ${out.length} turnos de ${person ? person.displayName : 'ti'} (de ${list.length} eventos). Pega en Horarios → Importar.`, true);
    } catch (e) {
      if (/sin sesión|401/.test(String(e.message))) patchFetch();
      msg('Error: ' + (e.message || e), false);
    } finally { btn.disabled = false; }
  }

  mount();
  setInterval(mount, 4000); // la SPA puede redibujar el body; re-montar si desaparece
})();
