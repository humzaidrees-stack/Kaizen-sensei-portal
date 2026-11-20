// Kaizen Sensei Portal front end. No build step.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 16 }, (_, i) => i + 6); // 06:00 to 21:00 blocks

let me = null, today = null, source = null;

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') { init.body = opts.body; init.headers['Content-Type'] = 'text/plain'; }
    else { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { me = null; render(); throw new Error(data.error || 'Please sign in.'); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200); }

// ---------- dates ----------
const dateObj = d => new Date(d.slice(0, 10) + 'T12:00:00Z');
const dayName = d => dateObj(d).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const dayLong = d => dateObj(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayShort = d => dateObj(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const time = d => d.slice(11, 16);
const addDays = (d, n) => { const x = dateObj(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const mondayOf = d => addDays(d, -((dateObj(d).getUTCDay() + 6) % 7));
function relDay(d) {
  const diff = Math.round((dateObj(d) - dateObj(today)) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : dayLong(d);
}
function groupByDay(items) {
  const g = new Map();
  for (const it of items) { const k = it.start.slice(0, 10); if (!g.has(k)) g.set(k, []); g.get(k).push(it); }
  return [...g.entries()];
}
const rangeText = t => {
  const dates = t.start_date === t.end_date ? dayLong(t.start_date) : `${dayShort(t.start_date)} to ${dayShort(t.end_date)}`;
  return t.start_time ? `${dates}, ${t.start_time} to ${t.end_time}` : `${dates}${t.start_date === t.end_date ? ', all day' : ''}`;
};
// SQLite stores UTC; show studio time.
const stamp = utc => new Date(utc.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// One tap from the dashboard: opens WhatsApp with the message written; the manager picks the sensei group and sends.
const waLink = text => 'https://wa.me/?text=' + encodeURIComponent(text);
const waMessage = shifts => {
  const line = s => `${dayName(s.start)} ${dayShort(s.start)}, ${time(s.start)} ${s.name}${s.location ? ` (${s.location})` : ''}`;
  const head = shifts.length === 1 ? 'Class open for pick-up:' : 'Classes open for pick-up:';
  const list = shifts.slice(0, 15).map(s => `• ${line(s)}`).join('\n') + (shifts.length > 15 ? `\n…and ${shifts.length - 15} more` : '');
  return `${head}\n${list}\n\nPick one up in the Sensei portal: ${location.origin}/#/shifts`;
};
const REASON = { sensei: 'Unassigned', unavailable: 'Cover needed', manual: 'Posted' };

// ---------- modal ----------
function modal(html, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(bg);
  onMount?.(bg, close);
  bg.querySelector('input,select,button')?.focus();
  return close;
}
const confirmBox = (title, text, yes = 'Confirm') => new Promise(res => {
  modal(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="yes">${esc(yes)}</button></div>`,
    (bg, close) => { $('#yes', bg).onclick = () => { close(); res(true); }; bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) res(false); }); });
});

// ---------- login ----------
function renderLogin() {
  app.innerHTML = `
  <div class="login">
    <div class="login-art"><img src="/lockup-white.png" alt="kaizen pilates"></div>
    <div class="login-panel">
      <img class="wordmark" src="/wordmark.png" alt="kaizen pilates">
      <form id="f" autocomplete="on">
        <h1>Sensei portal</h1>
        <p>Your availability, your time off and open classes to pick up.</p>
        <div id="err"></div>
        <label class="field"><span>Your ID</span><input name="code" autocomplete="username" autocapitalize="characters" placeholder="KP101" required></label>
        <label class="field"><span>PIN</span><input name="pin" type="password" inputmode="numeric" autocomplete="current-password" required></label>
        <button class="btn block" type="submit">Sign in</button>
        <p class="small muted" style="margin-top:20px">Forgot your PIN? Ask the studio to reset it.</p>
      </form>
    </div>
  </div>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('/api/login', { method: 'POST', body: { code: f.get('code'), pin: f.get('pin') } });
      me = r.user;
      const target = me.role === 'sensei' ? '#/week' : '#/shifts';
      if (location.hash === target) route(); else location.hash = target; // hashchange renders
    } catch (err) { $('#err').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  };
}

// ---------- shell ----------
function shell(tabs, active, content, counts = {}) {
  app.innerHTML = `
  <header class="top"><div class="top-inner">
    <div class="top-row"><img src="/wordmark.png" alt="kaizen pilates">
      <div class="who"><span>${esc(me.name)}${me.role === 'front_desk' ? ' · Front desk' : me.role === 'manager' ? ' · Manager' : ''}</span><button id="pinbtn">PIN</button><button id="out">Sign out</button></div></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/${k}" class="${k === active ? 'on' : ''}">${l}${counts[k] ? `<span class="count">${counts[k]}</span>` : ''}</a>`).join('')}</nav>
  </div></header>
  <main id="main">${content}</main>`;
  $('#out').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; location.hash = ''; render(); };
  $('#pinbtn').onclick = changePin;
}
function changePin() {
  modal(`<h2>Change your PIN</h2><p class="muted small">4 to 8 digits.</p><div id="perr"></div>
    <label class="field"><span>Current PIN</span><input id="p1" type="password" inputmode="numeric"></label>
    <label class="field"><span>New PIN</span><input id="p2" type="password" inputmode="numeric"></label>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="psave">Save</button></div>`,
  (bg, close) => { $('#psave', bg).onclick = async () => {
    try { await api('/api/my/pin', { method: 'PUT', body: { current: $('#p1', bg).value, next: $('#p2', bg).value } }); close(); toast('PIN updated'); }
    catch (e) { $('#perr', bg).innerHTML = `<div class="error">${esc(e.message)}</div>`; } }; });
}
const demoBanner = () => source === 'demo' ? `<div class="banner">Demo copy. The schedule here is built from the November template, not live from Mindbody.</div>`
  : source === 'none' ? `<div class="banner">No schedule loaded yet.</div>` : '';

// =====================================================================
// INSTRUCTOR
// =====================================================================
function tabsFor(user) {
  if (user.role === 'sensei') return [['week', 'My classes'], ['shifts', 'Open shifts'], ['availability', 'Availability'], ['timeoff', 'Time off']];
  if (user.role === 'front_desk') return [['shifts', 'Shifts'], ['schedule', 'Schedule'], ['timeoff', 'Time off']];
  return [['shifts', 'Shifts'], ['schedule', 'Schedule'], ['timeoff', 'Time off'], ['team', 'Instructors'], ['sync', 'Mindbody'], ['mine', 'My classes'], ['mine-hours', 'My hours'], ['mine-off', 'My time off']];
}

let mine = null;
async function instructorView(tab, activeKey) {
  try { mine = await api('/api/my/overview'); } catch (e) { return; }
  if (!me) return;
  const tabs = tabsFor(me);
  source = mine.source; today = mine.today;
  const fresh = mine.shifts.filter(s => s.my_claim !== 'pending' && !s.away && !s.busy).length;
  const view = { week: iWeek, shifts: iShifts, availability: iAvailability, timeoff: iTimeoff }[tab] || iWeek;
  const active = activeKey || (view === iWeek ? 'week' : tab);
  shell(tabs, active, '', me.role === 'sensei' ? { shifts: fresh } : {});
  view();
}

function iWeek() {
  const items = [...mine.classes.map(c => ({ ...c, kind: 'class' })), ...mine.picked.map(s => ({ ...s, kind: 'picked' }))].sort((a, b) => a.start.localeCompare(b.start));
  $('#main').innerHTML = `${demoBanner()}
    <div class="head"><div><h1>Hello ${esc(me.name.split(' ')[0])}</h1><p>Your next four weeks.</p></div>
      <a class="btn ghost" href="${me.role === 'manager' ? '#/mine-off' : '#/timeoff'}">Mark time off</a></div>
    ${items.length ? groupByDay(items).map(([d, list]) => `
      <div class="daygroup"><span class="label">${esc(relDay(d))}</span><div class="list">
      ${list.map(c => `<div class="item"><div class="when"><b>${time(c.start)}</b><span>to ${time(c.end)}</span></div>
        <div class="what"><h3>${esc(c.name)}</h3><div class="small muted">${esc(c.location || '')}</div>
          ${c.kind === 'picked' ? '<span class="chip dark">Picked up</span>' : ''}
          ${c.kind === 'class' && c.shift?.status === 'open' ? '<span class="chip warm">You are away. Posted for cover</span>' : ''}
          ${c.kind === 'class' && c.shift?.status === 'filled' ? `<span class="chip">Covered by ${esc(c.shift.assigned)}</span>` : ''}
        </div></div>`).join('')}
      </div></div>`).join('') : `<div class="empty">No classes on your schedule in the next four weeks.</div>`}`;
}

function iShifts() {
  const s = mine.shifts;
  const card = x => {
    const blocked = x.away ? 'You are away then' : x.busy ? 'You are teaching then' : null;
    return `<div class="item"><div class="when"><b>${time(x.start)}</b><span>to ${time(x.end)}</span></div>
      <div class="what"><h3>${esc(x.name)}</h3><div class="small muted">${esc(x.location || '')}</div>
        ${x.fits ? '<span class="chip warm">In your availability</span>' : '<span class="chip line">Outside your usual hours</span>'}
        ${x.my_claim === 'pending' ? '<span class="chip dark">Requested</span>' : ''}
        ${x.my_claim === 'declined' ? '<span class="chip line">Given to someone else</span>' : ''}
        ${x.claimants && x.my_claim !== 'pending' ? `<span class="chip line">${x.claimants} asked</span>` : ''}
      </div>
      <div class="act">${blocked ? `<span class="small muted">${blocked}</span>` : x.my_claim === 'pending'
        ? `<button class="btn ghost small" data-withdraw="${x.id}">Withdraw</button>`
        : `<button class="btn small" data-claim="${x.id}">Pick up</button>`}</div></div>`;
  };
  $('#main').innerHTML = `${demoBanner()}
    <div class="head"><div><h1>Open shifts</h1><p>Classes that need an instructor. Pick one up and the studio will confirm it.</p></div></div>
    ${s.length ? groupByDay(s).map(([d, list]) => `<div class="daygroup"><span class="label">${esc(relDay(d))}</span><div class="list">${list.map(card).join('')}</div></div>`).join('')
      : '<div class="empty">No open shifts right now.</div>'}`;
  $('#main').onclick = async e => {
    const c = e.target.closest('[data-claim]'), w = e.target.closest('[data-withdraw]');
    try {
      if (c) { await api(`/api/shifts/${c.dataset.claim}/claim`, { method: 'POST' }); toast('Requested. The studio will confirm.'); }
      else if (w) { await api(`/api/shifts/${w.dataset.withdraw}/claim`, { method: 'DELETE' }); toast('Request withdrawn'); }
      else return;
      route();
    } catch (err) { toast(err.message); }
  };
}

// Tap or drag across the grid to mark the hours you can teach each week.
function availabilityGrid(container, blocks, teaching = new Set(), readOnly = false) {
  const on = new Set(blocks.map(b => `${b.dow}-${b.hour}`));
  container.innerHTML = `<div class="avail-wrap"><div class="avail">
    <div></div>${DAYS.map(d => `<div class="h">${d}</div>`).join('')}
    ${HOURS.map(h => `<div class="t">${String(h).padStart(2, '0')}:00</div>${DAYS.map((_, d) =>
      `<div class="c ${on.has(`${d}-${h}`) ? 'on' : ''} ${teaching.has(`${d}-${h}`) ? 'teach' : ''}" data-k="${d}-${h}" title="${DAYS[d]} ${h}:00 to ${h + 1}:00"></div>`).join('')}`).join('')}
  </div></div>`;
  if (!readOnly) {
    let painting = null;
    const grid = $('.avail', container);
    const apply = cell => { if (!cell?.dataset.k) return; cell.classList.toggle('on', painting); painting ? on.add(cell.dataset.k) : on.delete(cell.dataset.k); container.dispatchEvent(new Event('change')); };
    grid.addEventListener('pointerdown', e => { const c = e.target.closest('.c'); if (!c) return; painting = !c.classList.contains('on'); apply(c); e.preventDefault(); });
    grid.addEventListener('pointermove', e => { if (painting === null) return; apply(document.elementFromPoint(e.clientX, e.clientY)?.closest('.c')); });
    window.addEventListener('pointerup', () => { painting = null; }, { once: false });
  }
  return () => [...on].map(k => k.split('-').map(Number));
}

function iAvailability() {
  const teaching = new Set();
  for (const c of mine.classes) {
    const d = (dateObj(c.start).getUTCDay() + 6) % 7;
    for (let h = Number(c.start.slice(11, 13)); h < Math.ceil((Number(c.end.slice(11, 13)) * 60 + Number(c.end.slice(14, 16))) / 60); h++) teaching.add(`${d}-${h}`);
  }
  $('#main').innerHTML = `
    <div class="head"><div><h1>Weekly availability</h1><p>Tap or drag to mark the hours you can teach in a normal week. We use this to offer you open shifts and to plan the schedule.</p></div></div>
    <div id="grid"></div>
    <div class="legend"><span><i class="on"></i>Available</span><span><i></i>Not available</span><span><i class="teach"></i>Your current classes</span></div>
    <div class="sticky-save"><span class="small muted" id="dirty"></span><button class="btn" id="save">Save availability</button></div>`;
  const read = availabilityGrid($('#grid'), mine.availability, teaching);
  $('#grid').addEventListener('change', () => { $('#dirty').textContent = 'Unsaved changes'; });
  $('#save').onclick = async () => {
    try { await api('/api/my/availability', { method: 'PUT', body: { blocks: read() } }); $('#dirty').textContent = ''; toast('Availability saved'); mine = await api('/api/my/overview'); }
    catch (e) { toast(e.message); }
  };
}

function iTimeoff() {
  $('#main').innerHTML = `
    <div class="head"><div><h1>Time off</h1><p>Dates you cannot teach. Any of your classes in that time go up for cover straight away.</p></div></div>
    <div class="grid">
      <form class="card sand" id="tf">
        <h2 style="margin-bottom:14px">Add time off</h2><div id="terr"></div>
        <div class="row"><label class="field"><span>From</span><input type="date" name="start_date" min="${today}" required></label>
          <label class="field"><span>To</span><input type="date" name="end_date" min="${today}"></label></div>
        <label class="small muted" style="display:flex;gap:8px;align-items:center;margin:-6px 0 14px"><input type="checkbox" id="part" style="width:auto;min-height:0"> Only part of the day</label>
        <div class="row" id="times" hidden><label class="field"><span>From time</span><input type="time" name="start_time" step="900"></label>
          <label class="field"><span>To time</span><input type="time" name="end_time" step="900"></label></div>
        <label class="field"><span>Note (optional)</span><input name="note" maxlength="300" placeholder="Holiday, appointment, travel"></label>
        <div id="affect" class="small muted" style="margin-bottom:14px"></div>
        <button class="btn block" type="submit">Save time off</button>
      </form>
      <div><h2 style="margin-bottom:12px">Coming up</h2>
        ${mine.timeoff.length ? `<div class="list">${mine.timeoff.map(t => `<div class="item"><div class="what"><h3>${esc(rangeText(t))}</h3>${t.note ? `<div class="small muted">${esc(t.note)}</div>` : ''}</div>
          <div class="act"><button class="linkbtn" data-del="${t.id}">Remove</button></div></div>`).join('')}</div>` : '<div class="empty">Nothing booked.</div>'}
      </div>
    </div>`;
  const f = $('#tf');
  $('#part').onchange = e => { $('#times').hidden = !e.target.checked; if (!e.target.checked) { f.start_time.value = ''; f.end_time.value = ''; } preview(); };
  const preview = () => {
    const s = f.start_date.value, e = f.end_date.value || s; if (!s) { $('#affect').textContent = ''; return; }
    const st = f.start_time.value, et = f.end_time.value;
    const hit = mine.classes.filter(c => { const d = c.start.slice(0, 10); if (d < s || d > e) return false; return !st || !et || (time(c.start) < et && time(c.end) > st); });
    $('#affect').innerHTML = hit.length ? `This covers ${hit.length} of your classes: ${hit.slice(0, 4).map(c => `${esc(dayName(c.start))} ${dayShort(c.start)} ${time(c.start)} ${esc(c.name)}`).join(', ')}${hit.length > 4 ? '…' : ''}. They will be posted for cover.` : 'None of your scheduled classes fall in this time.';
  };
  f.addEventListener('input', e => { if (e.target.name === 'start_date' && !f.end_date.value) f.end_date.min = e.target.value; preview(); });
  f.onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(f));
    try {
      const r = await api('/api/my/timeoff', { method: 'POST', body: b });
      toast(r.opened ? `Saved. ${r.opened} class${r.opened > 1 ? 'es' : ''} posted for cover.` : 'Time off saved');
      if (r.clashes?.length) setTimeout(() => toast(`Heads up: you picked up ${r.clashes.length} shift(s) in this time. Let the studio know.`), 3400);
      route();
    } catch (err) { $('#terr').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  };
  $('#main').addEventListener('click', async e => {
    const d = e.target.closest('[data-del]'); if (!d) return;
    if (!await confirmBox('Remove this time off?', 'Any classes posted for cover because of it will come off the board if nobody has picked them up yet.', 'Remove')) return;
    await api(`/api/my/timeoff/${d.dataset.del}`, { method: 'DELETE' }); toast('Removed'); route();
  });
}

// =====================================================================
// ADMIN
// =====================================================================
let adm = null;
async function adminView(tab) {
  try { adm = await api('/api/admin/overview'); } catch (e) { return; }
  if (!me) return;
  const tabs = tabsFor(me);
  today = adm.today; source = adm.sync.source;
  const allowed = new Set(tabs.map(([k]) => k));
  const active = allowed.has(tab) ? tab : 'shifts';
  const view = { shifts: aShifts, schedule: aSchedule, timeoff: aTimeoff, team: aTeam, sync: aSync }[active] || aShifts;
  shell(tabs, active, '', { shifts: adm.stats.pending });
  view();
}

function aShifts() {
  const open = adm.shifts.filter(s => s.status === 'open'), filled = adm.shifts.filter(s => s.status === 'filled');
  const item = s => `<div class="item"><div class="when"><b>${time(s.start)}</b><span>${esc(dayName(s.start))} ${dayShort(s.start)}</span></div>
    <div class="what"><h3>${esc(s.name)}</h3>
      <div class="small muted">${esc(s.location || '')}${s.reason === 'unavailable' ? ` · ${esc(s.original)} is away` : s.reason === 'sensei' ? ' · Kaizen Sensei in Mindbody' : s.note ? ` · ${esc(s.note)}` : ''}</div>
      <span class="chip ${s.status === 'filled' ? 'dark' : 'warm'}">${s.status === 'filled' ? `Covered by ${esc(s.assigned)}` : REASON[s.reason]}</span>
      ${s.mb_note ? `<div class="small muted" style="margin-top:6px">${esc(s.mb_note)}</div>` : ''}
      ${s.status === 'open' && s.claims.some(c => c.status === 'pending') ? `<div class="claims">${s.claims.filter(c => c.status === 'pending').map(c => `
        <div class="claim"><span><b>${esc(c.name)}</b> <span class="small muted">asked ${esc(stamp(c.created_at))}</span></span>
          <span class="btns"><button class="btn small" data-assign="${s.id}" data-who="${c.instructor_id}" data-name="${esc(c.name)}">Approve</button><button class="btn ghost small" data-decline="${c.id}">Decline</button></span></div>`).join('')}</div>` : ''}
      ${s.status === 'open' ? `<details><summary>Assign directly · ${s.candidates.length ? `${s.candidates.length} free, ${s.candidates.filter(c => c.fits).length} within their usual hours` : 'nobody free'}</summary><div class="candlist">
        ${s.candidates.map(c => `<button class="${c.fits ? 'fit' : ''}" data-assign="${s.id}" data-who="${c.id}" data-name="${esc(c.name)}" title="${c.fits ? 'Inside their weekly availability' : 'Free, but outside their usual hours'}">${esc(c.name)}${c.fits ? ' ✓' : ''}</button>`).join('') || '<span class="small muted">Nobody is free at this time.</span>'}
      </div></details>` : ''}
    </div>
    <div class="act">${s.status === 'filled' ? `<button class="linkbtn" data-reopen="${s.id}">Reopen</button>`
      : `<a class="linkbtn" target="_blank" rel="noopener" href="${waLink(waMessage([s]))}">WhatsApp</a> <button class="linkbtn" data-close-shift="${s.id}">Close</button>`}</div></div>`;
  const soon = open.filter(s => s.start.slice(0, 10) <= addDays(today, 14));
  $('#main').innerHTML = `${demoBanner()}
    <div class="stats">
      <div class="stat"><b>${adm.stats.open}</b><span>Open shifts</span></div>
      <div class="stat"><b>${adm.stats.pending}</b><span>Pick-up requests</span></div>
      <div class="stat"><b>${adm.stats.filled}</b><span>Covered</span></div>
      <div class="stat"><b>${adm.stats.classes}</b><span>Upcoming classes</span></div>
    </div>
    ${adm.unmatched.length ? `<div class="banner">Not matched to an instructor here: ${adm.unmatched.map(esc).join(', ')}. ${me.role === 'manager' ? 'Link them under Instructors so their time off is picked up.' : 'A manager needs to link them so their time off is picked up.'}</div>` : ''}
    <div class="head"><div><h1>Open shifts</h1><p>Kaizen Sensei classes and classes whose instructor is away. Updated each time the schedule syncs or someone adds time off.</p></div>
      <div class="btns">${soon.length ? `<a class="btn ghost" target="_blank" rel="noopener" href="${waLink(waMessage(soon))}" title="Opens WhatsApp with the next two weeks of open shifts written out. Pick the sensei group and send.">Post to WhatsApp</a>` : ''}<button class="btn" id="post">Post a shift</button></div></div>
    ${open.length ? `<div class="list">${open.map(item).join('')}</div>` : '<div class="empty">Every upcoming class has an instructor.</div>'}
    <div class="section"><h2>Covered</h2>${filled.length ? `<div class="list">${filled.map(item).join('')}</div>` : '<div class="empty">Nothing covered yet.</div>'}</div>
    ${adm.recentClosed.length ? `<div class="section"><h2>Recently closed</h2><div class="list">${adm.recentClosed.map(s => `<div class="item"><div class="when"><b>${time(s.start)}</b><span>${esc(dayName(s.start))} ${dayShort(s.start)}</span></div><div class="what"><h3>${esc(s.name)}</h3><div class="small muted">${esc(s.note || '')}</div></div></div>`).join('')}</div></div>` : ''}
    ${(adm.alerts || []).length ? `<div class="section"><h2>Desk alerts</h2><div class="list">${adm.alerts.map(a => `<div class="item"><div class="what"><h3>${esc(a.body)}</h3><div class="small muted">${esc(stamp(a.created_at))} · ${esc(a.status)}${a.channel ? ` via ${esc(a.channel)}` : ''}${a.detail ? ` · ${esc(a.detail)}` : ''}</div></div></div>`).join('')}</div></div>` : ''}`;
  $('#post').onclick = postShift;
  $('#main').onclick = async e => {
    const a = e.target.closest('[data-assign]'), d = e.target.closest('[data-decline]'), c = e.target.closest('[data-close-shift]'), r = e.target.closest('[data-reopen]');
    try {
      if (a) {
        if (!await confirmBox(`Give this class to ${a.dataset.name}?`, 'Other requests for it will be declined.', 'Assign')) return;
        const res = await api(`/api/admin/shifts/${a.dataset.assign}/assign`, { method: 'POST', body: { instructor_id: Number(a.dataset.who) } });
        toast(res.mb_note || 'Assigned');
      } else if (d) { await api(`/api/admin/claims/${d.dataset.decline}/decline`, { method: 'POST' }); toast('Declined'); }
      else if (c) { if (!await confirmBox('Close this shift?', 'It comes off the board. Use this if the class is cancelled or sorted another way.', 'Close')) return; await api(`/api/admin/shifts/${c.dataset.closeShift}/close`, { method: 'POST', body: {} }); toast('Closed'); }
      else if (r) { if (!await confirmBox('Reopen this shift?', 'It goes back on the board for anyone to pick up. If it was changed in Mindbody, change it back there too.', 'Reopen')) return; await api(`/api/admin/shifts/${r.dataset.reopen}/reopen`, { method: 'POST' }); toast('Reopened'); }
      else return;
      route();
    } catch (err) { toast(err.message); }
  };
}

function postShift() {
  modal(`<h2>Post a shift</h2><p class="muted small">For anything not picked up from the schedule automatically.</p><div id="serr"></div>
    <label class="field"><span>Date</span><input type="date" id="sd" min="${today}"></label>
    <div class="row"><label class="field"><span>Start</span><input type="time" id="ss" step="900"></label><label class="field"><span>End</span><input type="time" id="se" step="900"></label></div>
    <label class="field"><span>Class</span><input id="sn" placeholder="Gentle Flow"></label>
    <label class="field"><span>Location</span><input id="sl" placeholder="Kaizen Saadiyat"></label>
    <label class="field"><span>Note</span><input id="so" placeholder="Optional"></label>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="sgo">Post</button></div>`,
  (bg, close) => {
    $('#ss', bg).onchange = e => { if (!$('#se', bg).value && e.target.value) { const [h, m] = e.target.value.split(':').map(Number); const t = h * 60 + m + 50; $('#se', bg).value = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; } };
    $('#sgo', bg).onclick = async () => {
      try { await api('/api/admin/shifts', { method: 'POST', body: { date: $('#sd', bg).value, start: $('#ss', bg).value, end: $('#se', bg).value, name: $('#sn', bg).value, location: $('#sl', bg).value, note: $('#so', bg).value } }); close(); toast('Shift posted'); route(); }
      catch (e) { $('#serr', bg).innerHTML = `<div class="error">${esc(e.message)}</div>`; }
    };
  });
}

let weekFrom = null;
async function aSchedule() {
  weekFrom = weekFrom || mondayOf(today);
  const data = await api(`/api/admin/schedule?from=${weekFrom}`);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekFrom, i));
  $('#main').innerHTML = `${demoBanner()}
    <div class="head"><div><h1>Schedule</h1><p>As it stands in ${source === 'mindbody' ? 'Mindbody' : 'the loaded schedule'}, with who is away and what needs cover.</p></div>
      <div class="btns"><button class="btn ghost small" id="prev">Previous</button><button class="btn ghost small" id="this">This week</button><button class="btn ghost small" id="next">Next</button></div></div>
    <p class="label" style="margin:0 0 12px">Week of ${dayLong(weekFrom)}</p>
    <div class="legend" style="margin:0 0 16px"><span><i style="background:var(--attention);box-shadow:inset 0 0 0 1px var(--porcelain)"></i>Needs cover</span><span><i></i>Covered</span></div>
    <div class="week">${days.map(d => {
      const list = data.classes.filter(c => c.start.startsWith(d));
      return `<div class="col"><span class="label">${dayName(d)} ${dayShort(d)}</span>${list.map(c => {
        const cls = c.cancelled ? 'cancelled' : c.shift?.status === 'open' ? 'open' : c.shift?.status === 'filled' ? 'filled' : '';
        const who = c.shift?.status === 'filled' ? `${esc(c.shift.assigned)} (cover)` : c.placeholder ? 'Kaizen Sensei' : esc(c.instructor || c.staff_name || '');
        return `<div class="slot ${cls}"><b>${time(c.start)} ${esc(c.name)}</b><span class="who">${who}${c.away && c.shift?.status !== 'filled' ? ' · away' : ''}</span>${c.capacity ? `<span class="small muted">${c.booked ?? 0}/${c.capacity} booked</span>` : ''}</div>`;
      }).join('') || '<span class="small muted">No classes</span>'}</div>`;
    }).join('')}</div>`;
  $('#prev').onclick = () => { weekFrom = addDays(weekFrom, -7); aSchedule(); };
  $('#next').onclick = () => { weekFrom = addDays(weekFrom, 7); aSchedule(); };
  $('#this').onclick = () => { weekFrom = mondayOf(today); aSchedule(); };
}

function aTimeoff() {
  $('#main').innerHTML = `<div class="head"><div><h1>Time off</h1><p>Everything instructors have booked from today on.</p></div></div>
    ${adm.timeoff.length ? `<div class="tablewrap"><table><thead><tr><th>Instructor</th><th>When</th><th>Note</th><th>Classes affected</th></tr></thead><tbody>
      ${adm.timeoff.map(t => `<tr><td><b>${esc(t.name)}</b></td><td>${esc(rangeText(t))}</td><td class="muted">${esc(t.note || '')}</td><td>${t.affected || '<span class="muted">None</span>'}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No time off booked.</div>'}`;
}

function aTeam() {
  $('#main').innerHTML = `<div class="head"><div><h1>Instructors</h1><p>Each instructor signs in with their ID and a PIN. Link them to their Mindbody staff profile so classes and time off line up.</p></div>
      <button class="btn" id="add">Add instructor</button></div>
    <div class="tablewrap"><table><thead><tr><th>Name</th><th>Login ID</th><th>Mindbody</th><th>Availability</th><th></th></tr></thead><tbody>
    ${adm.instructors.map(i => `<tr style="${i.active ? '' : 'opacity:.5'}"><td><b>${esc(i.name)}</b>${i.active ? '' : ' <span class="chip line">Inactive</span>'}</td><td>${esc(i.code)}</td>
      <td class="small">${i.mb_staff_id ? `ID ${esc(i.mb_staff_id)}` : ''}${i.mb_name ? `<div class="muted">${esc(i.mb_name)}</div>` : ''}${!i.mb_staff_id && !i.mb_name ? '<span class="muted">Not linked</span>' : ''}</td>
      <td class="small">${i.blocks ? `<button class="linkbtn" data-avail="${i.id}">${i.blocks} hours a week</button>` : '<span class="muted">Not set</span>'}${i.avail_updated ? `<div class="muted">Updated ${esc(i.avail_updated.slice(0, 10))}</div>` : ''}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn ghost small" data-edit="${i.id}">Edit</button> <button class="btn ghost small" data-pin="${i.id}">New PIN</button></td></tr>`).join('')}
    </tbody></table></div>`;
  $('#add').onclick = () => editInstructor(null);
  $('#main').onclick = async e => {
    const ed = e.target.closest('[data-edit]'), p = e.target.closest('[data-pin]'), av = e.target.closest('[data-avail]');
    if (ed) editInstructor(adm.instructors.find(i => i.id == ed.dataset.edit));
    if (av) { const i = adm.instructors.find(x => x.id == av.dataset.avail); modal(`<h2>${esc(i.name)}</h2><p class="muted small">Weekly availability</p><div id="ag"></div><div class="actions"><button class="btn" data-close>Done</button></div>`, bg => availabilityGrid($('#ag', bg), i.availability, new Set(), true)); }
    if (p) {
      const i = adm.instructors.find(x => x.id == p.dataset.pin);
      if (!await confirmBox(`New PIN for ${i.name}?`, 'Their old PIN stops working and they are signed out.', 'Create PIN')) return;
      const r = await api(`/api/admin/instructors/${i.id}/reset-pin`, { method: 'POST' });
      showPin(i.name, i.code, r.pin);
    }
  };
}
function showPin(name, code, pin) {
  modal(`<h2>${esc(name)}</h2><p class="muted small">Share this with them privately. It will not be shown again. They can change it after signing in.</p>
    <div class="small muted">Login ID</div><div class="pinbox" style="font-size:22px">${esc(code)}</div>
    <div class="small muted">PIN</div><div class="pinbox">${esc(pin)}</div>
    <div class="actions"><button class="btn" data-close>Done</button></div>`);
}
async function editInstructor(i) {
  let staff = [];
  if (adm.sync.mindbody) { try { staff = (await api('/api/admin/mb-staff')).staff; } catch {} }
  modal(`<h2>${i ? 'Edit instructor' : 'Add instructor'}</h2><div id="ierr"></div>
    <label class="field"><span>Name</span><input id="in" value="${esc(i?.name || '')}"></label>
    <label class="field"><span>Login ID</span><input id="ic" value="${esc(i?.code || '')}" placeholder="Leave blank to create one" style="text-transform:uppercase"></label>
    ${staff.length ? `<label class="field"><span>Mindbody staff</span><select id="is"><option value="">Not linked</option>${staff.map(s => `<option value="${esc(s.id)}" data-name="${esc(s.name)}" ${String(i?.mb_staff_id) === s.id ? 'selected' : ''}>${esc(s.name)} (${esc(s.id)})</option>`).join('')}</select></label>`
      : `<div class="row"><label class="field"><span>Mindbody staff ID</span><input id="is" value="${esc(i?.mb_staff_id || '')}" placeholder="Optional"></label>
        <label class="field"><span>Name in Mindbody</span><input id="im" value="${esc(i?.mb_name || '')}" placeholder="As it appears on classes"></label></div>`}
    ${i ? `<label class="small muted" style="display:flex;gap:8px;align-items:center;margin-bottom:16px"><input type="checkbox" id="ia" ${i.active ? 'checked' : ''} style="width:auto;min-height:0"> Active (can sign in)</label>` : ''}
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="isave">${i ? 'Save' : 'Add and create PIN'}</button></div>`,
  (bg, close) => { $('#isave', bg).onclick = async () => {
    const sel = $('#is', bg);
    const body = { name: $('#in', bg).value, code: $('#ic', bg).value, mb_staff_id: sel.value || null,
      mb_name: $('#im', bg) ? ($('#im', bg).value || null) : (sel.selectedOptions?.[0]?.dataset.name || null) };
    if (i) body.active = $('#ia', bg).checked;
    try {
      if (i) { await api(`/api/admin/instructors/${i.id}`, { method: 'PUT', body }); close(); toast('Saved'); route(); }
      else { const r = await api('/api/admin/instructors', { method: 'POST', body }); close(); await adminView('team'); showPin(body.name, r.code, r.pin); }
    } catch (e) { $('#ierr', bg).innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  }; });
}

function aSync() {
  const s = adm.sync;
  $('#main').innerHTML = `<div class="head"><div><h1>Mindbody</h1><p>Where the schedule comes from, and how open shifts are found.</p></div></div>
    <div class="grid">
      <div class="card ${s.mindbody ? 'sand' : 'attn'}">
        <span class="label">Connection</span>
        <h2 style="margin:6px 0 8px">${s.mindbody ? 'Connected' : 'Not connected yet'}</h2>
        <p class="small muted" style="margin:0 0 14px">${s.mindbody
          ? `Classes for the next six weeks sync on the schedule (every 30 minutes on Vercel Pro) and when you press Sync now. ${s.mbWrite ? 'Approved pick-ups are written back to Mindbody as substitutes.' : 'Add a staff login to have approved pick-ups written back to Mindbody.'}`
          : 'Add the Mindbody API key and site ID to the server settings to pull classes automatically. Until then, import a schedule CSV.'}</p>
        <p class="small" style="margin:0 0 14px">Schedule source: <b>${{ mindbody: 'Mindbody', csv: 'CSV import', demo: 'Demo data', none: 'None' }[s.source]}</b>${s.last ? `<br><span class="muted">Last updated ${esc(new Date(s.last).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' }))}</span>` : ''}</p>
        ${s.lastError ? `<div class="error">${esc(s.lastError)}</div>` : ''}
        ${s.mindbody ? '<button class="btn" id="sync">Sync now</button>' : ''}
      </div>
      <div class="card">
        <span class="label">Import</span><h2 style="margin:6px 0 8px">Schedule CSV</h2>
        <p class="small muted" style="margin:0 0 14px">Columns: date, start, class, instructor. End and location are optional. Classes in the file's date range are replaced.</p>
        <input type="file" id="csv" accept=".csv,text/csv" style="margin-bottom:12px"><button class="btn ghost" id="imp">Import</button>
      </div>
      <div class="card">
        <span class="label">Rule</span><h2 style="margin:6px 0 8px">Placeholder instructor</h2>
        <p class="small muted" style="margin:0 0 14px">Any class with this instructor in Mindbody is posted as an open shift.</p>
        <div class="row"><input id="ph" value="${esc(s.placeholder)}"><button class="btn ghost" id="phs" style="flex:0 0 auto">Save</button></div>
      </div>
    </div>`;
  if ($('#sync')) $('#sync').onclick = async e => {
    e.target.disabled = true; e.target.textContent = 'Syncing…';
    try { const r = await api('/api/admin/sync', { method: 'POST' }); toast(`${r.classes} classes synced. ${r.opened} new open shifts.`); route(); }
    catch (err) { toast(err.message); route(); }
  };
  $('#imp').onclick = async () => {
    const f = $('#csv').files[0]; if (!f) return toast('Choose a CSV first');
    try { const r = await api('/api/admin/import', { method: 'POST', body: await f.text() }); toast(`${r.classes} classes imported. ${r.opened} new open shifts.`); route(); }
    catch (err) { toast(err.message); }
  };
  $('#phs').onclick = async () => { try { const r = await api('/api/admin/settings', { method: 'PUT', body: { placeholder_name: $('#ph').value } }); toast(`Saved. ${r.opened} opened, ${r.closed} closed.`); } catch (e) { toast(e.message); } };
}

// ---------- router ----------
function route() {
  const tab = (location.hash.replace(/^#\/?/, '') || '').split('/')[0];
  if (!me) return renderLogin();
  if (me.role === 'sensei') {
    const known = { week: 'week', shifts: 'shifts', availability: 'availability', timeoff: 'timeoff' };
    return instructorView(known[tab] || 'week');
  }
  if (me.role === 'manager' && tab === 'mine') return instructorView('week', 'mine');
  if (me.role === 'manager' && tab === 'mine-hours') return instructorView('availability', 'mine-hours');
  if (me.role === 'manager' && tab === 'mine-off') return instructorView('timeoff', 'mine-off');
  return adminView(tab || 'shifts');
}
const render = route;
async function boot() {
  try { const r = await api('/api/me'); me = r.user; today = r.today; source = r.source; } catch { me = null; }
  route();
}
window.addEventListener('hashchange', route);
boot();
