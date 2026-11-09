/* Rise Dialer dashboard — plain JavaScript, no build step. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const digits = (s) => String(s || '').replace(/[^\d+]/g, '');

  function fmtPhone(n) {
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(n || '');
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (n || '');
  }
  function toE164(input) {
    const s = String(input || '').trim();
    const d = s.replace(/\D/g, '');
    if (s.startsWith('+')) return '+' + d;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return d ? '+' + d : '';
  }
  // SQLite datetime('now') is UTC without a zone marker.
  const parseDate = (s) => (s ? new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') : null);
  function timeAgo(s) {
    const d = parseDate(s); if (!d) return '';
    const sec = (Date.now() - d) / 1000;
    if (sec < 60) return 'now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h';
    if (sec < 7 * 86400) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  const fmtDateTime = (s) => { const d = parseDate(s); return d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
  const fmtDur = (sec) => { sec = Number(sec || 0); const m = Math.floor(sec / 60); const s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; };
  const initials = (name, num) => (name ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '#');

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Please log in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  function openOverlay(html, { center = false } = {}) {
    const root = $('#overlayRoot');
    root.innerHTML = `<div class="overlay ${center ? 'center' : ''}"><div class="${center ? 'modal' : 'drawer'}">${html}</div></div>`;
    const ov = $('.overlay', root);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeOverlay(); });
    return $(center ? '.modal' : '.drawer', root);
  }
  const closeOverlay = () => { $('#overlayRoot').innerHTML = ''; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay(); });

  const formData = (form) => Object.fromEntries(new FormData(form).entries());

  // ---------------------------------------------------------------- state
  const S = {
    me: null, numbers: [], tab: 'messages', threads: [], thread: null, calls: [], callFilter: 'all',
    agents: [], contacts: [], device: null, deviceState: 'offline', call: null, incoming: null,
    callStart: 0, muted: false, dial: '', fromNumber: '', aiConfigured: false, twilioConfigured: false,
  };
  const contactName = (num) => { const c = S.contacts.find((x) => x.phone === num); return c ? c.name : null; };
  const label = (num) => contactName(num) || fmtPhone(num);

  // ---------------------------------------------------------------- auth
  function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try { await api('/login', { body: formData(e.target) }); boot(); }
    catch (err) { $('#loginErr').textContent = err.message; }
  });
  $('#logoutLink').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    if (S.device) S.device.destroy();
    location.reload();
  });

  async function boot() {
    let me;
    try { me = await api('/me'); } catch { return showLogin(); }
    S.me = me.user; S.numbers = me.numbers; S.aiConfigured = me.aiConfigured; S.twilioConfigured = me.twilioConfigured;
    S.fromNumber = (S.numbers.find((n) => n.id === S.me.default_number_id) || S.numbers.find((n) => n.assigned_user_id === S.me.id) || S.numbers[0] || {}).number || '';
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    $('#meName').textContent = S.me.name;
    $('#brandName').textContent = me.businessName || 'Rise Dialer';
    $$('.admin-only').forEach((el) => el.classList.toggle('hidden', S.me.role !== 'admin'));
    renderStatus();
    [S.contacts, S.agents] = await Promise.all([api('/contacts').catch(() => []), api('/agents').catch(() => [])]);
    setTab(location.hash.slice(1) || 'messages');
    renderPhone();
    connectEvents();
    refreshUnread();
    if (S.twilioConfigured) setupDevice();
  }

  // ---------------------------------------------------------------- nav
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
  function setTab(tab) {
    if (!['messages', 'calls', 'agents', 'contacts', 'admin'].includes(tab)) tab = 'messages';
    if (tab === 'admin' && S.me.role !== 'admin') tab = 'messages';
    S.tab = tab; history.replaceState(null, '', '#' + tab);
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    ({ messages: renderMessages, calls: renderCalls, agents: renderAgents, contacts: renderContacts, admin: renderAdmin })[tab]();
  }

  // ---------------------------------------------------------------- my status / settings
  function renderStatus() {
    const away = S.me.status === 'away';
    $('#statusDot').className = 'dot ' + (away ? 'away' : S.deviceState === 'ready' ? 'on' : 'off');
    $('#statusText').textContent = away ? 'Away (calls skip you)' : S.deviceState === 'ready' ? 'Available' : 'Available · phone offline';
  }
  $('#statusBtn').addEventListener('click', async () => {
    const r = await api('/me', { body: { status: S.me.status === 'away' ? 'available' : 'away' } });
    S.me = r.user; renderStatus();
  });
  $('#mySettingsLink').addEventListener('click', () => {
    const m = openOverlay(`
      <h3>My settings</h3>
      <form id="meForm">
        <label>Call & text from (default number)</label>
        <select name="default_number_id"><option value="">Automatic</option>${S.numbers.map((n) => `<option value="${n.id}" ${n.id === S.me.default_number_id ? 'selected' : ''}>${esc(fmtPhone(n.number))} ${esc(n.friendly_name || '')}</option>`).join('')}</select>
        <label>My cell phone (for "Ring my cell" calls)</label>
        <input type="tel" name="cell_phone" value="${esc(S.me.cell_phone || '')}" placeholder="(555) 555-5555">
        <label class="check"><input type="checkbox" name="ring_cell" ${S.me.ring_cell ? 'checked' : ''}> Also ring my cell when the team line rings</label>
        <label>New password (leave blank to keep)</label>
        <input type="password" name="password" autocomplete="new-password">
        <div class="err" id="meErr"></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="meCancel">Cancel</button></div>
      </form>`, { center: true });
    $('#meCancel', m).onclick = closeOverlay;
    $('#meForm', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        const r = await api('/me', { body: { default_number_id: f.default_number_id ? Number(f.default_number_id) : null, cell_phone: f.cell_phone, ring_cell: !!f.ring_cell, password: f.password || undefined } });
        S.me = r.user; closeOverlay(); toast('Saved');
        const n = S.numbers.find((x) => x.id === S.me.default_number_id); if (n) { S.fromNumber = n.number; renderPhone(); }
      } catch (err) { $('#meErr', m).textContent = err.message; }
    };
  });

  // ---------------------------------------------------------------- live events
  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('message', (e) => onMessageEvent(JSON.parse(e.data)));
    es.addEventListener('message_status', (e) => {
      const d = JSON.parse(e.data);
      const el = document.querySelector(`[data-msg-status="${d.id}"]`);
      if (el) el.textContent = d.status + (d.error ? ` (error ${d.error})` : '');
    });
    es.addEventListener('call', (e) => onCallEvent(JSON.parse(e.data)));
  }

  function onMessageEvent(m) {
    if (S.thread && S.thread.other === m.other_number && S.thread.our === m.our_number) {
      if (!S.thread.messages.find((x) => x.id === m.id)) { S.thread.messages.push(m); renderBubbles(); }
      if (m.direction === 'inbound') api(`/threads/${encodeURIComponent(m.other_number)}?our=${encodeURIComponent(m.our_number)}`).catch(() => {});
    } else if (m.direction === 'inbound') {
      toast(`New text from ${label(m.other_number)}`);
      notify(`Text from ${label(m.other_number)}`, m.body);
    }
    if (S.tab === 'messages') loadThreads();
    refreshUnread();
  }

  function onCallEvent(c) {
    const i = S.calls.findIndex((x) => x.id === c.id);
    if (i >= 0) S.calls[i] = { ...S.calls[i], ...c }; else S.calls.unshift(c);
    if (S.tab === 'calls') renderCallRows();
    renderRecent();
    const open = $('#callDetail');
    if (open && Number(open.dataset.id) === c.id) openCall(c.id);
  }

  async function refreshUnread() {
    const t = await api('/threads?unread=1&limit=200').catch(() => []);
    const n = t.reduce((a, x) => a + (x.unread || 0), 0);
    const b = $('#unreadBadge'); b.textContent = n; b.classList.toggle('hidden', !n);
    document.title = n ? `(${n}) Rise Dialer` : 'Rise Dialer';
  }

  function notify(title, body) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted' && document.hidden) new Notification(title, { body });
    else if (Notification.permission === 'default') Notification.requestPermission();
  }

  // ================================================================ MESSAGES
  function renderMessages() {
    $('#main').innerHTML = `
      <div class="page-head"><h2>Messages</h2><div class="spacer"></div><button class="btn primary" id="newMsg">+ New text</button></div>
      <div class="card msg-layout">
        <div class="threads"><div class="search"><input type="search" id="threadSearch" placeholder="Search name or number"></div><div id="threadList"></div></div>
        <div class="convo" id="convo"><div class="empty">Pick a conversation, or start a new text.</div></div>
      </div>`;
    $('#newMsg').onclick = () => newTextModal();
    $('#threadSearch').oninput = renderThreadList;
    loadThreads().then(() => { if (S.thread) openThread(S.thread.other, S.thread.our); });
  }

  async function loadThreads() {
    S.threads = await api('/threads?limit=200').catch(() => []);
    renderThreadList();
  }

  function renderThreadList() {
    const el = $('#threadList'); if (!el) return;
    const q = ($('#threadSearch')?.value || '').toLowerCase();
    const list = S.threads.filter((t) => !q || (t.contact_name || '').toLowerCase().includes(q) || t.other_number.includes(digits(q)));
    if (!list.length) { el.innerHTML = `<div class="empty small">No conversations yet.</div>`; return; }
    el.innerHTML = list.map((t) => `
      <div class="thread ${t.unread ? 'unread' : ''} ${S.thread && S.thread.other === t.other_number && S.thread.our === t.our_number ? 'active' : ''}" data-other="${esc(t.other_number)}" data-our="${esc(t.our_number)}">
        <div class="top"><span class="name">${esc(t.contact_name || fmtPhone(t.other_number))}</span><span class="meta">${timeAgo(t.last_at)}</span></div>
        <div class="preview">${t.last_direction === 'outbound' ? 'You: ' : ''}${esc(t.last_body || '[media]')}</div>
        ${S.numbers.length > 1 ? `<div class="meta">via ${esc(fmtPhone(t.our_number))}</div>` : ''}
      </div>`).join('');
    $$('.thread', el).forEach((d) => d.onclick = () => openThread(d.dataset.other, d.dataset.our));
  }

  async function openThread(other, our) {
    S.thread = { other, our, messages: [] };
    renderThreadList();
    const convo = $('#convo'); if (!convo) return;
    const name = contactName(other);
    convo.innerHTML = `
      <div class="convo-head">
        <div class="avatar" style="width:36px;height:36px;font-size:14px;margin:0">${esc(initials(name))}</div>
        <div><div class="title">${esc(name || fmtPhone(other))}</div><div class="meta">${esc(fmtPhone(other))} · our line ${esc(fmtPhone(our))}</div></div>
        <div style="flex:1"></div>
        <button class="btn sm" id="tCall">📞 Call</button>
        ${name ? '' : '<button class="btn sm" id="tSave">Save contact</button>'}
      </div>
      <div class="bubbles" id="bubbles"></div>
      <form class="composer" id="composer">
        <textarea name="body" placeholder="Text ${esc(name || fmtPhone(other))}…" rows="1"></textarea>
        <button class="btn primary" type="submit">Send</button>
      </form>`;
    $('#tCall').onclick = () => { S.fromNumber = our; dialNumber(other); };
    const save = $('#tSave'); if (save) save.onclick = () => contactModal({ phone: other });
    const ta = $('textarea', convo);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
    $('#composer').onsubmit = async (e) => {
      e.preventDefault();
      const body = ta.value.trim(); if (!body) return;
      ta.disabled = true;
      try { await api('/messages', { body: { to: other, from: our, body } }); ta.value = ''; }
      catch (err) { toast(err.message); }
      ta.disabled = false; ta.focus();
    };
    S.thread.messages = await api(`/threads/${encodeURIComponent(other)}?our=${encodeURIComponent(our)}`);
    renderBubbles();
    refreshUnread();
    const t = S.threads.find((x) => x.other_number === other && x.our_number === our); if (t) { t.unread = 0; renderThreadList(); }
  }

  function renderBubbles() {
    const el = $('#bubbles'); if (!el || !S.thread) return;
    el.innerHTML = S.thread.messages.map((m) => {
      const dir = m.direction === 'inbound' ? 'in' : 'out';
      const media = (m.media || []).map((u) => `<a href="/api/media?url=${encodeURIComponent(u)}" target="_blank"><img src="/api/media?url=${encodeURIComponent(u)}" alt="attachment"></a>`).join('');
      return `<div class="bubble ${dir}">${esc(m.body)}${media}</div>
        <div class="meta ${dir}">${fmtDateTime(m.created_at)}${dir === 'out' ? ` · ${esc(m.sent_by || '')} · <span data-msg-status="${m.id}">${esc(m.status || '')}</span>` : ''}</div>`;
    }).join('') || '<div class="empty">No messages yet.</div>';
    el.scrollTop = el.scrollHeight;
  }

  function numberOptions(selected) {
    return S.numbers.map((n) => `<option value="${esc(n.number)}" ${n.number === selected ? 'selected' : ''}>${esc(fmtPhone(n.number))}${n.friendly_name ? ' — ' + esc(n.friendly_name) : ''}</option>`).join('');
  }

  function newTextModal(prefill = '') {
    const m = openOverlay(`
      <h3>New text</h3>
      <form id="ntForm">
        <label>To</label><input type="tel" name="to" value="${esc(prefill)}" placeholder="Number or pick a contact" list="contactList" required>
        <datalist id="contactList">${S.contacts.map((c) => `<option value="${esc(c.phone)}">${esc(c.name || '')}</option>`).join('')}</datalist>
        <label>From</label><select name="from">${numberOptions(S.fromNumber)}</select>
        <label>Message</label><textarea name="body" required></textarea>
        <div class="err" id="ntErr"></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" type="submit">Send</button><button class="btn" type="button" id="ntCancel">Cancel</button></div>
      </form>`, { center: true });
    $('#ntCancel', m).onclick = closeOverlay;
    $('#ntForm', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        const msg = await api('/messages', { body: f });
        closeOverlay(); setTab('messages'); setTimeout(() => openThread(msg.other_number, msg.our_number), 200);
      } catch (err) { $('#ntErr', m).textContent = err.message; }
    };
  }

  // ================================================================ CALLS
  function renderCalls() {
    $('#main').innerHTML = `
      <div class="page-head"><h2>Calls</h2><div class="spacer"></div>
        <div class="filters" id="callFilters">
          ${[['all', 'All'], ['inbound', 'Inbound'], ['outbound', 'Outbound'], ['ai', 'AI calls'], ['missed', 'Missed & voicemail']].map(([k, l]) => `<button data-f="${k}" class="${S.callFilter === k ? 'active' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="card"><table class="list"><thead><tr><th></th><th>Who</th><th>Details</th><th>Result</th><th>When</th></tr></thead><tbody id="callRows"></tbody></table></div>`;
    $('#callFilters').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.callFilter = b.dataset.f; renderCalls(); };
    api('/calls?limit=200').then((c) => { S.calls = c; renderCallRows(); renderRecent(); });
  }

  function callTags(c) {
    const tags = [];
    tags.push(c.direction === 'inbound' ? '<span class="tag in">IN</span>' : '<span class="tag out">OUT</span>');
    if (c.kind === 'ai') tags.push('<span class="tag ai">AI</span>');
    if (c.kind === 'click_to_call') tags.push('<span class="tag">CELL</span>');
    return tags.join(' ');
  }
  function statusTag(c) {
    if (c.voicemail) return '<span class="tag miss">Voicemail</span>';
    if (['missed', 'no-answer', 'busy', 'failed', 'canceled'].includes(c.status)) return `<span class="tag miss">${esc(c.status)}</span>`;
    if (c.status === 'completed') return `<span class="tag ok">${fmtDur(c.duration)}</span>`;
    return `<span class="tag">${esc(c.status || '')}</span>`;
  }

  function renderCallRows() {
    const el = $('#callRows'); if (!el) return;
    const f = S.callFilter;
    const list = S.calls.filter((c) => f === 'all' || (f === 'ai' ? c.kind === 'ai' : f === 'missed' ? (c.voicemail || ['missed', 'no-answer'].includes(c.status)) : c.direction === f));
    el.innerHTML = list.map((c) => `
      <tr class="click" data-id="${c.id}">
        <td style="white-space:nowrap">${callTags(c)}</td>
        <td><strong>${esc(c.contact_name || fmtPhone(c.other_number))}</strong><div class="meta">${c.contact_name ? esc(fmtPhone(c.other_number)) + '<br>' : ''}via ${esc(fmtPhone(c.our_number))}</div></td>
        <td class="small">${c.user_name ? esc(c.user_name) : c.ai_agent_name ? '🤖 ' + esc(c.ai_agent_name) : '<span class="muted">—</span>'}${c.summary ? `<div class="muted" style="max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.summary)}</div>` : ''}</td>
        <td>${statusTag(c)}${c.outcome ? `<div class="meta">${esc(c.outcome)}</div>` : ''}</td>
        <td class="meta" style="white-space:nowrap">${fmtDateTime(c.started_at)}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted" style="text-align:center;padding:30px">No calls yet.</td></tr>';
    $$('tr.click', el).forEach((tr) => tr.onclick = () => openCall(Number(tr.dataset.id)));
  }

  async function openCall(id) {
    const c = await api('/calls/' + id);
    const d = openOverlay(`<div id="callDetail" data-id="${c.id}">
      <div class="row" style="align-items:flex-start"><div><h3>${esc(c.contact_name || fmtPhone(c.other_number))}</h3><div>${callTags(c)} ${statusTag(c)}</div></div>
        <div style="flex:0;white-space:nowrap"><button class="btn sm" id="cdCall">📞 Call back</button> <button class="btn sm" id="cdText">💬 Text</button> <button class="btn sm ghost" id="cdClose">✕</button></div></div>
      <div class="kv">
        <div>Number</div><div>${esc(fmtPhone(c.other_number))}</div>
        <div>Our line</div><div>${esc(fmtPhone(c.our_number))}</div>
        <div>Handled by</div><div>${esc(c.user_name || (c.ai_agent_name ? 'AI: ' + c.ai_agent_name : '—'))}</div>
        <div>When</div><div>${fmtDateTime(c.started_at)}</div>
        <div>Length</div><div>${fmtDur(c.duration)}</div>
        ${c.outcome ? `<div>Outcome</div><div>${esc(c.outcome)}</div>` : ''}
      </div>
      ${c.summary ? `<div class="section-title">Summary</div><div class="summary">${esc(c.summary)}</div>` : ''}
      ${c.ai_context ? `<div class="section-title">Instructions for this call</div><div class="small" style="white-space:pre-wrap">${esc(c.ai_context)}</div>` : ''}
      ${c.has_recording ? `<div class="section-title">${c.voicemail ? 'Voicemail' : 'Recording'}</div><audio controls preload="none" src="/api/calls/${c.id}/recording"></audio>` : ''}
      <div class="section-title">Notes</div>
      <textarea id="cdNotes" placeholder="Add notes…">${esc(c.notes || '')}</textarea>
      <button class="btn sm" id="cdSaveNotes" style="margin-top:6px">Save notes</button>
      ${c.transcript && c.transcript.length ? `<div class="section-title">Transcript</div><div class="transcript">${c.transcript.map((t) => `<div class="t ${t.role}"><span class="who">${t.role === 'agent' ? 'AI agent' : 'Them'}</span>${esc(t.text)}</div>`).join('')}</div>` : ''}
    </div>`);
    $('#cdClose', d).onclick = closeOverlay;
    $('#cdCall', d).onclick = () => { closeOverlay(); S.fromNumber = c.our_number || S.fromNumber; dialNumber(c.other_number); };
    $('#cdText', d).onclick = () => { closeOverlay(); setTab('messages'); setTimeout(() => openThread(c.other_number, c.our_number || S.fromNumber), 200); };
    $('#cdSaveNotes', d).onclick = async () => { await api(`/calls/${c.id}/notes`, { body: { notes: $('#cdNotes', d).value } }); toast('Notes saved'); };
  }

  // ================================================================ AI AGENTS
  const AGENT_TEMPLATES = {
    receptionist: {
      name: 'Receptionist',
      greeting: 'Thanks for calling Rise Public Adjusting, this is the virtual assistant. How can I help you today?',
      instructions: `You answer the main line for Rise Public Adjusting, a licensed Texas public adjusting firm that represents homeowners and businesses on property insurance claims (storm, hail, wind, water, fire) and handles insurance appraisals.

- Find out who is calling and why. Get their name, the best callback number, the property address, and their insurance company and claim number if they have one.
- New claims or questions about hiring us: collect the details above and a short description of the damage, then use take_message and tell them someone will call back today.
- Existing clients asking for a status update: take a message with their name and claim; do not guess at any status, amounts or timelines.
- Contractors, attorneys or adjusters asking for Joseph: offer to transfer, or take a message.
- If it is urgent (active leak, fire, someone needs Joseph right now), transfer to a human.`,
    },
    followup: {
      name: 'Follow-up caller',
      greeting: '',
      instructions: `You make short, polite outbound follow-up calls for Rise Public Adjusting.

- Introduce yourself as the virtual assistant calling from Rise Public Adjusting, confirm you are speaking with the right person, and state the reason for the call from "About this specific call".
- Stick to the facts you were given. If they have questions you cannot answer, offer to have a team member call them back and take a message.
- Be warm and brief. Confirm any commitment they make (a date, a signature, a document) back to them before you end the call.
- If they want to talk to someone, transfer to a human.`,
    },
    carrier: {
      name: 'Carrier status caller',
      greeting: '',
      instructions: `You call insurance companies' claim lines on behalf of Rise Public Adjusting to get claim status updates.

- Navigate phone menus with press_keys toward "existing claim" or "speak to a representative". Stay silent while on hold.
- When a representative answers, say you are calling from Rise Public Adjusting, the public adjuster on the claim, and give the insured's name and claim number from "About this specific call".
- Ask for: the current status, the assigned adjuster's name and direct contact, and any outstanding items they need. Repeat the details back to confirm.
- If they will not speak with you, ask what they need to verify authorization and note it. Never invent policy details.`,
    },
  };

  async function renderAgents() {
    S.agents = await api('/agents');
    $('#main').innerHTML = `
      <div class="page-head"><h2>AI Agents</h2><div class="spacer"></div><button class="btn ai" id="aiCallBtn">🤖 Start an AI call</button><button class="btn primary" id="newAgent">+ New agent</button></div>
      ${S.aiConfigured ? '' : '<div class="banner">AI is not switched on yet — add ANTHROPIC_API_KEY in Railway to turn on AI calls.</div>'}
      <p class="muted" style="margin-top:-6px">Agents answer calls on any number you set to "AI" (Admin → Phone numbers), pick up missed calls, and make outbound calls you or Claude start. They speak with an ElevenLabs voice and think with Claude.</p>
      <div class="grid2" id="agentGrid"></div>`;
    $('#newAgent').onclick = () => agentModal();
    $('#aiCallBtn').onclick = () => aiCallModal();
    $('#agentGrid').innerHTML = S.agents.map((a) => `
      <div class="card agent-card">
        <div class="name">🤖 ${esc(a.name)} ${a.active ? '' : '<span class="tag">off</span>'}</div>
        <div class="desc">${esc(a.instructions)}</div>
        <div class="meta">${a.transfer_number ? 'Transfers to ' + esc(fmtPhone(a.transfer_number)) : 'Transfers ring the team in the app'}</div>
        <div class="row" style="justify-content:flex-start;margin-top:6px"><button class="btn sm" data-edit="${a.id}" style="flex:0">Edit</button><button class="btn sm ai" data-call="${a.id}" style="flex:0">Call someone</button></div>
      </div>`).join('') || '<div class="card card-pad muted">No agents yet. Click “New agent” — there are ready-made templates.</div>';
    $$('[data-edit]').forEach((b) => b.onclick = () => agentModal(S.agents.find((a) => a.id === Number(b.dataset.edit))));
    $$('[data-call]').forEach((b) => b.onclick = () => aiCallModal({ agentId: Number(b.dataset.call) }));
  }

  function agentModal(agent = null) {
    const a = agent || {};
    const m = openOverlay(`
      <h3>${agent ? 'Edit agent' : 'New AI agent'}</h3>
      ${agent ? '' : `<label>Start from a template</label><div class="filters" id="tpl">${Object.entries(AGENT_TEMPLATES).map(([k, t]) => `<button type="button" data-t="${k}">${esc(t.name)}</button>`).join('')}</div>`}
      <form id="agForm">
        <label>Name</label><input type="text" name="name" value="${esc(a.name || '')}" required>
        <label>Greeting (spoken first on inbound calls — leave blank to let the AI open)</label><input type="text" name="greeting" value="${esc(a.greeting || '')}">
        <label>Instructions — who it works for, what it can say, how to handle situations</label><textarea name="instructions" style="min-height:220px" required>${esc(a.instructions || '')}</textarea>
        <div class="row">
          <div><label>Transfer calls to (blank = ring the team in the app)</label><input type="tel" name="transfer_number" value="${esc(a.transfer_number || '')}"></div>
          <div><label>ElevenLabs voice ID (optional)</label><input type="text" name="voice" value="${esc(a.voice || '')}" placeholder="Default voice"></div>
        </div>
        <label class="check"><input type="checkbox" name="active" ${a.active === 0 ? '' : 'checked'}> Active</label>
        <div class="err" id="agErr"></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" type="submit">Save agent</button><button class="btn" type="button" id="agCancel">Cancel</button>${agent && S.me.role === 'admin' ? '<button class="btn stop" type="button" id="agDelete" style="flex:0">Delete</button>' : ''}</div>
      </form>`, { center: true });
    const form = $('#agForm', m);
    const tpl = $('#tpl', m);
    if (tpl) tpl.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const t = AGENT_TEMPLATES[b.dataset.t];
      form.name.value = t.name; form.greeting.value = t.greeting; form.instructions.value = t.instructions;
    };
    $('#agCancel', m).onclick = closeOverlay;
    const del = $('#agDelete', m);
    if (del) del.onclick = async () => { if (!confirm(`Delete ${a.name}?`)) return; await api('/agents/' + a.id, { method: 'DELETE' }); closeOverlay(); renderAgents(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(form);
      try { await api('/agents', { body: { ...f, id: a.id, active: !!f.active } }); closeOverlay(); toast('Agent saved'); renderAgents(); }
      catch (err) { $('#agErr', m).textContent = err.message; }
    };
  }

  function aiCallModal({ agentId, to } = {}) {
    if (!S.agents.length) { toast('Create an AI agent first.'); return agentModal(); }
    const m = openOverlay(`
      <h3>Start an AI call</h3>
      <p class="muted small">The AI calls this person now. When it hangs up you'll get a summary in Calls${'' /* and Slack */}.</p>
      <form id="acForm">
        <div class="row">
          <div><label>Agent</label><select name="agentId">${S.agents.filter((a) => a.active).map((a) => `<option value="${a.id}" ${a.id === agentId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
          <div><label>Call from</label><select name="from">${numberOptions(S.fromNumber)}</select></div>
        </div>
        <label>Number to call</label><input type="tel" name="to" value="${esc(to || S.dial || '')}" list="contactList2" required>
        <datalist id="contactList2">${S.contacts.map((c) => `<option value="${esc(c.phone)}">${esc(c.name || '')}</option>`).join('')}</datalist>
        <label>What should it do on this call? Who is it calling, why, and what facts can it share?</label>
        <textarea name="context" style="min-height:140px" placeholder="Example: Calling Maria Lopez about invoice #1042 for $1,850 for the appraisal on 123 Oak St, sent Oct 20. Ask if she received it and when she expects to pay. Payment can be made by check to Rise Public Adjusting."></textarea>
        <div class="err" id="acErr"></div>
        <div class="row" style="margin-top:10px"><button class="btn ai" type="submit">🤖 Call now</button><button class="btn" type="button" id="acCancel">Cancel</button></div>
      </form>`, { center: true });
    $('#acCancel', m).onclick = closeOverlay;
    $('#acForm', m).onsubmit = async (e) => {
      e.preventDefault();
      try { const c = await api('/ai-calls', { body: formData(e.target) }); closeOverlay(); toast(`AI is calling ${label(c.other_number)}…`); }
      catch (err) { $('#acErr', m).textContent = err.message; }
    };
  }

  // ================================================================ CONTACTS
  async function renderContacts() {
    S.contacts = await api('/contacts');
    $('#main').innerHTML = `
      <div class="page-head"><h2>Contacts</h2><div class="spacer"></div><input type="search" id="cSearch" placeholder="Search" style="width:220px;flex:0 0 220px"><button class="btn primary" id="newContact">+ Add contact</button></div>
      <div class="card"><table class="list"><thead><tr><th>Name</th><th>Phone</th><th>Company</th><th>Notes</th><th></th></tr></thead><tbody id="cRows"></tbody></table></div>`;
    $('#newContact').onclick = () => contactModal();
    $('#cSearch').oninput = drawContacts;
    drawContacts();
  }
  function drawContacts() {
    const q = ($('#cSearch')?.value || '').toLowerCase();
    const list = S.contacts.filter((c) => !q || [c.name, c.phone, c.company, c.email].some((v) => (v || '').toLowerCase().includes(q)));
    $('#cRows').innerHTML = list.map((c) => `
      <tr><td><strong>${esc(c.name || '—')}</strong>${c.email ? `<div class="meta">${esc(c.email)}</div>` : ''}</td><td>${esc(fmtPhone(c.phone))}</td><td>${esc(c.company || '')}</td>
      <td class="small muted" style="max-width:260px">${esc(c.notes || '')}</td>
      <td style="white-space:nowrap;text-align:right"><button class="btn sm" data-call="${esc(c.phone)}">📞</button> <button class="btn sm" data-text="${esc(c.phone)}">💬</button> <button class="btn sm ai" data-ai="${esc(c.phone)}">🤖</button> <button class="btn sm" data-edit="${c.id}">Edit</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted" style="text-align:center;padding:30px">No contacts yet.</td></tr>';
    $$('[data-call]').forEach((b) => b.onclick = () => dialNumber(b.dataset.call));
    $$('[data-text]').forEach((b) => b.onclick = () => { setTab('messages'); setTimeout(() => openThread(b.dataset.text, S.fromNumber), 200); });
    $$('[data-ai]').forEach((b) => b.onclick = async () => { S.agents = await api('/agents'); aiCallModal({ to: b.dataset.ai }); });
    $$('[data-edit]').forEach((b) => b.onclick = () => contactModal(S.contacts.find((c) => c.id === Number(b.dataset.edit))));
  }
  function contactModal(c = {}) {
    const m = openOverlay(`
      <h3>${c.id ? 'Edit contact' : 'Add contact'}</h3>
      <form id="ctForm">
        <div class="row"><div><label>Name</label><input type="text" name="name" value="${esc(c.name || '')}"></div><div><label>Phone</label><input type="tel" name="phone" value="${esc(c.phone || '')}" required></div></div>
        <div class="row"><div><label>Company</label><input type="text" name="company" value="${esc(c.company || '')}"></div><div><label>Email</label><input type="email" name="email" value="${esc(c.email || '')}"></div></div>
        <label>Notes (the AI agent sees these when it talks to this person)</label><textarea name="notes">${esc(c.notes || '')}</textarea>
        <div class="err" id="ctErr"></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="ctCancel">Cancel</button>${c.id ? '<button class="btn stop" type="button" id="ctDel" style="flex:0">Delete</button>' : ''}</div>
      </form>`, { center: true });
    $('#ctCancel', m).onclick = closeOverlay;
    const del = $('#ctDel', m);
    if (del) del.onclick = async () => { await api('/contacts/' + c.id, { method: 'DELETE' }); closeOverlay(); S.contacts = await api('/contacts'); if (S.tab === 'contacts') drawContacts(); };
    $('#ctForm', m).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/contacts', { body: { ...formData(e.target), id: c.id } });
        S.contacts = await api('/contacts'); closeOverlay(); toast('Contact saved');
        if (S.tab === 'contacts') drawContacts(); else if (S.tab === 'messages') { loadThreads(); if (S.thread) openThread(S.thread.other, S.thread.our); }
      } catch (err) { $('#ctErr', m).textContent = err.message; }
    };
  }

  // ================================================================ ADMIN
  async function renderAdmin() {
    const [users, numbers, settings, agents] = await Promise.all([api('/admin/users'), api('/admin/numbers'), api('/admin/settings'), api('/agents')]);
    S.numbers = numbers; S.agents = agents;
    const modeLabel = { ring_all: 'Ring everyone available', user: 'Ring one person', ai: 'AI agent answers' };
    $('#main').innerHTML = `
      <div class="page-head"><h2>Admin</h2></div>
      ${S.twilioConfigured ? '' : '<div class="banner">Twilio isn’t connected yet — add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Railway, then redeploy.</div>'}

      <div class="section-title">Phone numbers</div>
      <div class="card">
        <table class="list"><thead><tr><th>Number</th><th>When someone calls</th><th>AI backup</th><th></th></tr></thead><tbody>
        ${numbers.map((n) => `<tr><td><strong>${esc(fmtPhone(n.number))}</strong><div class="meta">${esc(n.friendly_name || '')}</div></td>
          <td>${esc(modeLabel[n.inbound_mode])}${n.inbound_mode === 'user' ? ': ' + esc(n.assigned_user_name || '—') : ''}${n.inbound_mode === 'ai' ? ': ' + esc(n.ai_agent_name || 'first active agent') : ''}</td>
          <td class="small">${n.ai_on_no_answer && n.ai_agent_name ? '🤖 ' + esc(n.ai_agent_name) + ' if nobody answers' : '<span class="muted">Voicemail if nobody answers</span>'}</td>
          <td style="text-align:right"><button class="btn sm" data-num="${n.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted" style="padding:20px;text-align:center">No numbers yet — buy one or sync from Twilio.</td></tr>'}
        </tbody></table>
        <div class="card-pad row" style="border-top:1px solid var(--line);justify-content:flex-start"><button class="btn" id="syncNums" style="flex:0;white-space:nowrap">↻ Sync from Twilio</button><button class="btn primary" id="buyNum" style="flex:0;white-space:nowrap">+ Buy a number</button></div>
      </div>

      <div class="section-title">Team</div>
      <div class="card">
        <table class="list"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Cell</th><th>Default line</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td><strong>${esc(u.name)}</strong> ${u.active ? '' : '<span class="tag">disabled</span>'}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(fmtPhone(u.cell_phone || ''))}</td>
          <td>${esc(fmtPhone((numbers.find((n) => n.id === u.default_number_id) || {}).number || '')) || '<span class="muted">auto</span>'}</td>
          <td style="text-align:right"><button class="btn sm" data-user="${u.id}">Edit</button></td></tr>`).join('')}
        </tbody></table>
        <div class="card-pad" style="border-top:1px solid var(--line)"><button class="btn primary" id="addUser">+ Add teammate</button></div>
      </div>

      <div class="section-title">Connect to Claude</div>
      <div class="card card-pad">
        <p style="margin-top:0">In Claude, go to <strong>Settings → Connectors → Add custom connector</strong> and paste this URL. Claude can then send texts, start AI calls, ring your cell to connect you, and read call summaries and text threads.</p>
        <div class="copy-field"><input type="text" readonly value="${esc(settings.mcp_url)}" id="mcpUrl"><button class="btn" id="copyMcp" style="flex:0">Copy</button><button class="btn" id="rotateMcp" style="flex:0;white-space:nowrap">New link</button></div>
        <p class="meta">Keep this link private — anyone with it can use your phone system through Claude. “New link” turns the old one off.</p>
      </div>

      <div class="section-title">General</div>
      <div class="card card-pad">
        <form id="setForm" class="row" style="align-items:flex-end"><div><label style="margin-top:0">Business name (the AI uses it)</label><input type="text" name="business_name" value="${esc(settings.business_name)}"></div><button class="btn" type="submit" style="flex:0">Save</button></form>
        <div class="kv"><div>Call recording</div><div>${settings.record_calls ? 'On' : 'Off'} <span class="meta">(RECORD_CALLS)</span></div><div>Slack summaries</div><div>${settings.slack ? 'On' : 'Off'} <span class="meta">(SLACK_WEBHOOK_URL)</span></div><div>AI model</div><div>${esc(settings.voice_model)}</div><div>App URL</div><div class="mono">${esc(settings.public_url)}</div></div>
      </div>`;

    $('#copyMcp').onclick = () => { navigator.clipboard.writeText($('#mcpUrl').value); toast('Copied'); };
    $('#rotateMcp').onclick = async () => { if (!confirm('Make a new link? Claude will stop working until you paste the new one.')) return; const r = await api('/admin/settings/rotate-mcp', { method: 'POST' }); $('#mcpUrl').value = r.mcp_url; };
    $('#setForm').onsubmit = async (e) => { e.preventDefault(); await api('/admin/settings', { body: formData(e.target) }); toast('Saved'); };
    $('#syncNums').onclick = async () => { try { await api('/admin/numbers/sync', { method: 'POST' }); toast('Numbers synced and connected'); renderAdmin(); } catch (e) { toast(e.message); } };
    $('#buyNum').onclick = buyNumberModal;
    $('#addUser').onclick = () => userModal();
    $$('[data-user]').forEach((b) => b.onclick = () => userModal(users.find((u) => u.id === Number(b.dataset.user))));
    $$('[data-num]').forEach((b) => b.onclick = () => numberModal(numbers.find((n) => n.id === Number(b.dataset.num)), users, agents));
  }

  function numberModal(n, users, agents) {
    const m = openOverlay(`
      <h3>${esc(fmtPhone(n.number))}</h3>
      <form id="nForm">
        <label>Label</label><input type="text" name="friendly_name" value="${esc(n.friendly_name || '')}" placeholder="e.g. Main line, Appraisals">
        <label>When someone calls this number</label>
        <select name="inbound_mode">
          <option value="ring_all" ${n.inbound_mode === 'ring_all' ? 'selected' : ''}>Ring everyone who is Available</option>
          <option value="user" ${n.inbound_mode === 'user' ? 'selected' : ''}>Ring one person</option>
          <option value="ai" ${n.inbound_mode === 'ai' ? 'selected' : ''}>AI agent answers every call</option>
        </select>
        <label>Person (for “Ring one person”)</label>
        <select name="assigned_user_id"><option value="">—</option>${users.map((u) => `<option value="${u.id}" ${u.id === n.assigned_user_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        <label>AI agent</label>
        <select name="ai_agent_id"><option value="">None</option>${agents.map((a) => `<option value="${a.id}" ${a.id === n.ai_agent_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
        <label class="check"><input type="checkbox" name="ai_on_no_answer" ${n.ai_on_no_answer ? 'checked' : ''}> If nobody picks up, the AI agent answers (instead of voicemail)</label>
        <div class="err" id="nErr"></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="nCancel">Cancel</button></div>
      </form>`, { center: true });
    $('#nCancel', m).onclick = closeOverlay;
    $('#nForm', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        await api('/admin/numbers/' + n.id, { body: { friendly_name: f.friendly_name, inbound_mode: f.inbound_mode, assigned_user_id: f.assigned_user_id ? Number(f.assigned_user_id) : null, ai_agent_id: f.ai_agent_id ? Number(f.ai_agent_id) : null, ai_on_no_answer: !!f.ai_on_no_answer } });
        closeOverlay(); toast('Saved'); renderAdmin();
      } catch (err) { $('#nErr', m).textContent = err.message; }
    };
  }

  function buyNumberModal() {
    const m = openOverlay(`
      <h3>Buy a phone number</h3>
      <form id="bForm" class="row" style="align-items:flex-end">
        <div><label>Area code</label><input type="text" name="areaCode" placeholder="254" maxlength="3"></div>
        <div><label>Contains (optional)</label><input type="text" name="contains" placeholder="e.g. 7777"></div>
        <label class="check" style="flex:0;white-space:nowrap"><input type="checkbox" name="tollFree"> Toll-free</label>
        <button class="btn" type="submit" style="flex:0">Search</button>
      </form>
      <div id="bRes" style="margin-top:14px"></div>
      <p class="meta">Local numbers are about $1.15/month on Twilio. Texting to US phones requires A2P 10DLC registration in Twilio (see the setup guide).</p>`, { center: true });
    $('#bForm', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      $('#bRes', m).innerHTML = '<div class="muted">Searching…</div>';
      try {
        const list = await api(`/admin/numbers/search?areaCode=${encodeURIComponent(f.areaCode || '')}&contains=${encodeURIComponent(f.contains || '')}&tollFree=${f.tollFree ? 1 : 0}`);
        $('#bRes', m).innerHTML = list.map((n) => `<div class="recent item" style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)"><span><strong>${esc(fmtPhone(n.number))}</strong> <span class="meta">${esc([n.locality, n.region].filter(Boolean).join(', '))}</span></span><button class="btn sm primary" data-buy="${esc(n.number)}">Buy</button></div>`).join('') || '<div class="muted">No numbers found — try another area code.</div>';
        $$('[data-buy]', m).forEach((b) => b.onclick = async () => {
          if (!confirm(`Buy ${fmtPhone(b.dataset.buy)}? Twilio will bill your account.`)) return;
          b.disabled = true;
          try { await api('/admin/numbers/buy', { body: { number: b.dataset.buy } }); closeOverlay(); toast('Number added and connected'); const me = await api('/me'); S.numbers = me.numbers; renderAdmin(); renderPhone(); }
          catch (err) { toast(err.message); b.disabled = false; }
        });
      } catch (err) { $('#bRes', m).innerHTML = `<div class="err">${esc(err.message)}</div>`; }
    };
  }

  function userModal(u = null) {
    const x = u || {};
    const m = openOverlay(`
      <h3>${u ? 'Edit teammate' : 'Add teammate'}</h3>
      <form id="uForm">
        <div class="row"><div><label>Name</label><input type="text" name="name" value="${esc(x.name || '')}" required></div><div><label>Email (their login)</label><input type="email" name="email" value="${esc(x.email || '')}" required></div></div>
        <div class="row"><div><label>${u ? 'Reset password (optional)' : 'Temporary password'}</label><input type="text" name="password" ${u ? '' : 'required minlength="8"'}></div>
          <div><label>Role</label><select name="role"><option value="agent" ${x.role !== 'admin' ? 'selected' : ''}>Team member</option><option value="admin" ${x.role === 'admin' ? 'selected' : ''}>Admin</option></select></div></div>
        <div class="row"><div><label>Cell phone</label><input type="tel" name="cell_phone" value="${esc(x.cell_phone || '')}"></div>
          <div><label>Default line</label><select name="default_number_id"><option value="">Automatic</option>${S.numbers.map((n) => `<option value="${n.id}" ${n.id === x.default_number_id ? 'selected' : ''}>${esc(fmtPhone(n.number))}</option>`).join('')}</select></div></div>
        <label class="check"><input type="checkbox" name="ring_cell" ${x.ring_cell ? 'checked' : ''}> Also ring their cell on team calls</label>
        ${u ? `<label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> Account active</label>` : ''}
        <div class="err" id="uErr"></div>
        <div class="row" style="margin-top:10px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="uCancel">Cancel</button></div>
      </form>`, { center: true });
    $('#uCancel', m).onclick = closeOverlay;
    $('#uForm', m).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try {
        await api('/admin/users', { body: { ...f, id: x.id, password: f.password || undefined, default_number_id: f.default_number_id ? Number(f.default_number_id) : null, ring_cell: !!f.ring_cell, active: u ? !!f.active : undefined } });
        closeOverlay(); toast(u ? 'Saved' : `Added — send ${f.email} their temporary password`); renderAdmin();
      } catch (err) { $('#uErr', m).textContent = err.message; }
    };
  }

  // ================================================================ PHONE (Twilio Voice SDK)
  async function setupDevice() {
    try {
      const { token } = await api('/token');
      const device = new Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'], closeProtection: 'A call is in progress. Leave anyway?', allowIncomingWhileBusy: false });
      S.device = device;
      device.on('registered', () => { S.deviceState = 'ready'; renderStatus(); renderPhone(); });
      device.on('unregistered', () => { S.deviceState = 'offline'; renderStatus(); renderPhone(); });
      device.on('error', (err) => {
        console.warn('Device error', err);
        if (S.deviceState !== 'ready') { S.deviceState = 'error'; renderStatus(); renderPhone(); }
        else toast('Phone: ' + (err.message || err.code));
      });
      device.on('tokenWillExpire', async () => { const r = await api('/token'); device.updateToken(r.token); });
      device.on('incoming', (call) => onIncoming(call));
      await device.register();
    } catch (e) {
      S.deviceState = 'error'; renderStatus(); renderPhone();
      console.warn('Phone setup failed', e);
    }
  }

  function onIncoming(call) {
    S.incoming = call;
    const from = call.parameters.From;
    notify('Incoming call', label(from));
    call.on('cancel', () => { S.incoming = null; renderPhone(); });
    call.on('disconnect', () => { S.incoming = null; renderPhone(); });
    call.on('reject', () => { S.incoming = null; renderPhone(); });
    renderPhone();
  }

  function bindCall(call, otherNumber) {
    S.call = call; S.callOther = otherNumber; S.muted = false; S.callStart = 0; S.callState = 'ringing';
    call.on('accept', () => { S.callState = 'live'; S.callStart = Date.now(); renderPhone(); });
    call.on('disconnect', () => endCallUi());
    call.on('cancel', () => endCallUi());
    call.on('reject', () => endCallUi());
    call.on('error', (e) => { toast('Call error: ' + e.message); endCallUi(); });
    renderPhone();
  }
  function endCallUi() { S.call = null; S.callState = null; renderPhone(); setTimeout(() => api('/calls?limit=10').then((c) => { mergeCalls(c); renderRecent(); }).catch(() => {}), 1500); }
  function mergeCalls(list) { for (const c of list) { const i = S.calls.findIndex((x) => x.id === c.id); if (i >= 0) S.calls[i] = c; else S.calls.push(c); } S.calls.sort((a, b) => parseDate(b.started_at) - parseDate(a.started_at)); }

  async function dialNumber(num) {
    const to = toE164(num);
    if (!to) return toast('Enter a number');
    if (!S.device || S.deviceState !== 'ready') return toast('Browser phone is offline — try "Ring my cell" instead.');
    if (S.call) return toast('You are already on a call');
    S.dial = to;
    const call = await S.device.connect({ params: { To: to, CallerId: S.fromNumber } });
    bindCall(call, to);
  }

  let timerInt;
  function renderPhone() {
    const el = $('#phone'); if (!el) return;
    clearInterval(timerInt);
    const ready = S.deviceState === 'ready';
    const head = `<h3>Phone</h3><div class="phone-status"><span class="dot ${ready ? 'on' : 'off'}"></span>${ready ? 'Browser phone ready' : !S.twilioConfigured ? 'Twilio not connected' : S.deviceState === 'error' ? 'Browser phone offline — reload the page, or use Ring my cell' : 'Connecting…'}</div>`;

    if (S.incoming) {
      const from = S.incoming.parameters.From;
      el.innerHTML = `${head}<div class="active-call ringing"><div class="avatar">${esc(initials(contactName(from)))}</div><div class="who">${esc(label(from))}</div><div class="meta">Incoming call${contactName(from) ? ' · ' + esc(fmtPhone(from)) : ''}</div>
        <div class="ctrls"><button class="round answer" id="pAccept" title="Answer">📞</button><button class="round hang" id="pReject" title="Decline">✕</button></div></div>`;
      $('#pAccept').onclick = () => { const c = S.incoming; S.incoming = null; c.accept(); bindCall(c, from); S.callState = 'live'; S.callStart = Date.now(); renderPhone(); };
      $('#pReject').onclick = () => { S.incoming.reject(); S.incoming = null; renderPhone(); };
      return;
    }

    if (S.call) {
      el.innerHTML = `${head}<div class="active-call"><div class="avatar">${esc(initials(contactName(S.callOther)))}</div><div class="who">${esc(label(S.callOther))}</div>
        <div class="timer" id="pTimer">${S.callState === 'live' ? '0:00' : 'Ringing…'}</div>
        <div class="ctrls"><button class="round ${S.muted ? 'on' : ''}" id="pMute" title="Mute">${S.muted ? '🔇' : '🎙️'}</button><button class="round" id="pPad" title="Keypad">⌨️</button><button class="round hang" id="pHang" title="Hang up">✕</button></div>
        <div id="dtmfPad" class="hidden">${keypadHtml()}</div></div>`;
      $('#pHang').onclick = () => S.call && S.call.disconnect();
      $('#pMute').onclick = () => { S.muted = !S.muted; S.call.mute(S.muted); renderPhone(); };
      $('#pPad').onclick = () => $('#dtmfPad').classList.toggle('hidden');
      $$('#dtmfPad .keypad button').forEach((b) => b.onclick = () => S.call && S.call.sendDigits(b.dataset.k));
      if (S.callState === 'live') timerInt = setInterval(() => { const t = $('#pTimer'); if (t) t.textContent = fmtDur(Math.floor((Date.now() - S.callStart) / 1000)); }, 1000);
      return;
    }

    el.innerHTML = `${head}
      <input class="dial-input" type="tel" id="dialInput" value="${esc(S.dial ? fmtPhone(S.dial) : '')}" placeholder="Enter a number" list="dialContacts">
      <datalist id="dialContacts">${S.contacts.map((c) => `<option value="${esc(c.phone)}">${esc(c.name || '')}</option>`).join('')}</datalist>
      ${keypadHtml()}
      <label style="margin-top:0">Call from</label>
      <select id="fromSel">${numberOptions(S.fromNumber) || '<option>No numbers yet</option>'}</select>
      <button class="btn go call-btn" id="pCall" style="margin-top:10px" ${ready ? '' : 'disabled'}>📞 Call</button>
      <div class="alt"><button class="btn sm" id="pCell" title="Rings your cell, then connects the call from the business number">📱 Ring my cell</button><button class="btn sm ai" id="pAi">🤖 AI call</button></div>
      <div class="alt"><button class="btn sm" id="pText">💬 Text</button><button class="btn sm" id="pSave">👤 Save</button></div>
      <div class="recent"><div class="section-title" style="margin-top:6px">Recent</div><div id="recentList"></div></div>`;
    const input = $('#dialInput');
    input.oninput = () => { S.dial = toE164(input.value); };
    input.onkeydown = (e) => { if (e.key === 'Enter') dialNumber(input.value); };
    $$('#phone > .keypad button').forEach((b) => b.onclick = () => { input.value = digits(input.value) + b.dataset.k; S.dial = toE164(input.value); });
    $('#fromSel').onchange = (e) => { S.fromNumber = e.target.value; };
    $('#pCall').onclick = () => dialNumber(input.value);
    $('#pCell').onclick = async () => {
      if (!toE164(input.value)) return toast('Enter a number');
      try { await api('/click-to-call', { body: { to: input.value, from: S.fromNumber } }); toast('Calling your cell — answer it to connect'); }
      catch (e) { toast(e.message); }
    };
    $('#pAi').onclick = async () => { S.agents = await api('/agents'); aiCallModal({ to: input.value }); };
    $('#pText').onclick = () => newTextModal(input.value);
    $('#pSave').onclick = () => contactModal({ phone: input.value });
    renderRecent();
    if (!S.calls.length) api('/calls?limit=15').then((c) => { mergeCalls(c); renderRecent(); }).catch(() => {});
  }

  function keypadHtml() {
    const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
    return `<div class="keypad">${keys.map(([k, s]) => `<button type="button" data-k="${k}">${k}<small>${s || '&nbsp;'}</small></button>`).join('')}</div>`;
  }

  function renderRecent() {
    const el = $('#recentList'); if (!el) return;
    el.innerHTML = S.calls.slice(0, 8).map((c) => `
      <div class="item" data-n="${esc(c.other_number)}"><div><div class="n">${c.direction === 'inbound' ? '↙' : '↗'} ${esc(c.contact_name || fmtPhone(c.other_number))}</div><div class="meta">${c.kind === 'ai' ? '🤖 ' : ''}${esc(c.voicemail ? 'voicemail' : c.status || '')}</div></div><span class="meta">${timeAgo(c.started_at)}</span></div>`).join('') || '<div class="meta">No calls yet.</div>';
    $$('.item', el).forEach((d) => d.onclick = () => { S.dial = d.dataset.n; renderPhone(); });
  }

  // go
  boot();
})();
