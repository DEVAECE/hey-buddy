/* global buddy, BuddyVoice */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let S = { tasks: [], chat: [], settings: {}, meta: {} };
  const ui = { filter: 'focus', selected: null, thinking: false, reportType: 'daily', detailDirty: false, view: 'tasks', remFilter: 'upcoming', remEdit: null, highlightRem: null };
  const PRI = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const STATUSES = ['Not started', 'In progress', 'Blocked', 'Done'];

  // ---------- time helpers ----------
  const DAY = 86400000;
  const sod = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  function timeStr(d) { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function dayStr(d) {
    const o = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString(undefined, o);
  }
  function fmtWhen(iso) {
    const d = new Date(iso); const today = sod(new Date());
    const diff = Math.round((sod(d) - today) / DAY);
    if (diff === 0) return `Today ${timeStr(d)}`;
    if (diff === 1) return `Tomorrow ${timeStr(d)}`;
    if (diff === -1) return `Yesterday ${timeStr(d)}`;
    return `${dayStr(d)}, ${timeStr(d)}`;
  }
  function dueInfo(t) {
    if (!t.due) return { label: 'No due date', cls: '' };
    const d = new Date(t.due); const now = new Date();
    if (t.status !== 'Done' && d < now) {
      const days = Math.floor((now - d) / DAY);
      return { label: days >= 1 ? `Overdue ${days}d` : `Overdue since ${timeStr(d)}`, cls: 'overdue' };
    }
    const soon = t.status !== 'Done' && d - now < DAY;
    return { label: `Due ${fmtWhen(t.due)}`, cls: soon ? 'soon' : '' };
  }
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

  // ---------- filters ----------
  const isOverdue = (t) => t.status !== 'Done' && t.due && new Date(t.due) < new Date();
  const dueBefore = (t, end) => t.due && new Date(t.due) < end;
  const FILTERS = [
    { id: 'focus', label: 'Focus', fn: (t) => t.status !== 'Done' && (isOverdue(t) || dueBefore(t, new Date(sod(new Date()).getTime() + 2 * DAY)) || t.status === 'Blocked' || t.status === 'In progress' || PRI[t.priority] <= 1) },
    { id: 'today', label: 'Today', fn: (t) => t.status !== 'Done' && dueBefore(t, new Date(sod(new Date()).getTime() + DAY)) },
    { id: 'week', label: 'This week', fn: (t) => t.status !== 'Done' && dueBefore(t, new Date(sod(new Date()).getTime() + 7 * DAY)) },
    { id: 'overdue', label: 'Overdue', fn: isOverdue, alert: true },
    { id: 'blocked', label: 'Blocked', fn: (t) => t.status === 'Blocked', alert: true },
    { id: 'open', label: 'All open', fn: (t) => t.status !== 'Done' },
    { id: 'done', label: 'Done', fn: (t) => t.status === 'Done' },
  ];
  function sortTasks(list, done) {
    if (done) return list.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
    return list.sort((a, b) =>
      (isOverdue(b) - isOverdue(a)) ||
      ((a.due || '9999').localeCompare(b.due || '9999')) ||
      (PRI[a.priority] - PRI[b.priority]));
  }

  // ---------- rendering: board ----------
  function renderFilters() {
    $('#filters').innerHTML = FILTERS.map((f) => {
      const n = S.tasks.filter(f.fn).length;
      return `<button class="filter${f.alert && n ? ' alert' : ''}" role="tab" data-f="${f.id}" aria-selected="${ui.filter === f.id}">${f.label}<b>${n}</b></button>`;
    }).join('');
  }

  function taskRow(t) {
    const due = dueInfo(t);
    const reminders = (t.reminders || []).filter((r) => r.active).length;
    const blocker = t.status === 'Blocked' ? [...(t.log || [])].reverse().find((e) => e.type === 'blocker') : null;
    const prog = t.progress !== null && t.progress !== undefined && t.status !== 'Done'
      ? `<div class="prog" title="${t.progress}% done"><i style="width:${t.progress}%"></i></div>` : '';
    return `<button class="task p-${t.priority}${t.status === 'Done' ? ' is-done' : ''}${ui.selected === t.id ? ' selected' : ''}" data-id="${t.id}">
      <span class="bar" aria-hidden="true"></span>
      <span>
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
          <span class="id">${t.id}</span>
          <span class="due ${due.cls}">${t.status === 'Done' && t.completedAt ? `Done ${fmtWhen(t.completedAt)}` : due.label}</span>
          ${t.assignedBy ? `<span>from ${esc(t.assignedBy)}</span>` : ''}
        </div>
      </span>
      <span class="task-right">
        <span class="pill s-${t.status.replace(' ', '-')}">${t.status}</span>
        ${prog}
        ${reminders ? `<span class="bell" title="${reminders} reminder${reminders > 1 ? 's' : ''}">🔔 ${reminders}</span>` : ''}
      </span>
      ${blocker ? `<span class="blocker-line">Blocked: ${esc(blocker.text)}</span>` : ''}
    </button>`;
  }

  function renderTasks() {
    const f = FILTERS.find((x) => x.id === ui.filter);
    const list = sortTasks(S.tasks.filter(f.fn), f.id === 'done');
    const el = $('#taskList');
    if (!list.length) {
      const msg = {
        focus: ['Nothing needs attention right now', 'Tell Buddy about a new task, or check All open.'],
        overdue: ['Nothing overdue', 'Nice work keeping on top of things.'],
        blocked: ['No blockers', 'If something gets stuck, tell Buddy "I\'m blocked on…".'],
        done: ['Nothing completed yet', 'Finished tasks show up here.'],
      }[f.id] || ['No tasks here', 'Add one with the button above or just tell Buddy.'];
      el.innerHTML = S.tasks.length
        ? `<div class="empty"><strong>${msg[0]}</strong>${msg[1]}</div>`
        : `<div class="empty"><strong>No tasks yet</strong>Type or say something like "New task from Priya: vendor audit due Thursday, high priority."</div>`;
      return;
    }
    if (f.id === 'open' || f.id === 'week') {
      // group by day bucket
      const groups = {};
      for (const t of list) {
        let g = 'No due date';
        if (t.due) {
          const diff = Math.round((sod(t.due) - sod(new Date())) / DAY);
          g = isOverdue(t) ? 'Overdue' : diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff < 7 ? dayStr(new Date(t.due)).split(',')[0] : 'Later';
        }
        (groups[g] = groups[g] || []).push(t);
      }
      el.innerHTML = Object.entries(groups).map(([g, ts]) => `<div class="group-label">${esc(g)}</div>${ts.map(taskRow).join('')}`).join('');
    } else {
      el.innerHTML = list.map(taskRow).join('');
    }
  }

  // ---------- tabs: Tasks | Reminders ----------
  function setView(view) {
    ui.view = view;
    $$('#boardTabs [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
    $('#tasksView').hidden = view !== 'tasks';
    $('#remindersView').hidden = view !== 'reminders';
    if (view !== 'tasks' && ui.selected) closeDetail();
    renderReminders();
  }

  // ---------- rendering: reminders ----------
  // Every reminder in one list: those on tasks and standalone ones.
  function allReminders() {
    const out = [];
    for (const t of S.tasks) for (const r of t.reminders || []) out.push({ r, task: t, title: t.title, taskDone: t.status === 'Done' });
    for (const r of S.reminders || []) out.push({ r, task: null, title: r.title });
    return out;
  }
  const remOn = (x) => x.r.active && !x.taskDone;
  const remPaused = (x) => !remOn(x) && (!!x.r.pausedAt || (x.taskDone && x.r.active));
  const remFired = (x) => !remOn(x) && !remPaused(x);
  const REPEAT_LABEL = { hourly: 'every hour', daily: 'every day', weekdays: 'weekdays', weekly: 'every week' };
  const REM_FILTERS = [
    { id: 'upcoming', label: 'Upcoming', fn: remOn },
    { id: 'today', label: 'Today', fn: (x) => remOn(x) && new Date(x.r.nextAt) < new Date(sod(new Date()).getTime() + DAY) },
    { id: 'repeating', label: 'Repeating', fn: (x) => x.r.repeat !== 'none' && !remFired(x) },
    { id: 'paused', label: 'Paused', fn: remPaused },
    { id: 'past', label: 'Past', fn: remFired },
    { id: 'all', label: 'All', fn: () => true },
  ];

  function renderReminders() {
    const all = allReminders();
    $('#tabTasks').textContent = S.tasks.filter((t) => t.status !== 'Done').length;
    $('#tabReminders').textContent = all.filter(remOn).length;
    if (ui.view !== 'reminders') return;
    $('#remFilters').innerHTML = REM_FILTERS.map((f) => `<button class="filter" role="tab" data-rf="${f.id}" aria-selected="${ui.remFilter === f.id}">${f.label}<b>${all.filter(f.fn).length}</b></button>`).join('');
    const f = REM_FILTERS.find((x) => x.id === ui.remFilter) || REM_FILTERS[0];
    const list = all.filter(f.fn).sort((a, b) => (f.id === 'past' ? -1 : 1) * String(a.r.nextAt).localeCompare(String(b.r.nextAt)));
    const el = $('#remList');
    if (!list.length) {
      const empty = {
        upcoming: ['No upcoming reminders', 'Add one with the button above, or say "Remind me to call the vendor at 4 pm".'],
        today: ['Nothing to remind you about today', ''], paused: ['No paused reminders', 'Switch a reminder off to pause it.'],
        past: ['No past reminders', 'Reminders that already went off show here for a week.'],
      }[f.id] || ['No reminders here', ''];
      el.innerHTML = `<div class="empty"><strong>${empty[0]}</strong>${empty[1]}</div>`;
      return;
    }
    el.innerHTML = list.map((x) => {
      const { r, task } = x;
      const on = remOn(x);
      const soon = on && new Date(r.nextAt) - new Date() < 3600000;
      const when = on ? fmtWhen(r.nextAt)
        : remPaused(x) ? (x.taskDone && r.active ? 'Off: task is done' : `Paused · was ${fmtWhen(r.nextAt)}`)
          : `Went off ${fmtWhen(r.firedAt || r.nextAt)}`;
      return `<div class="rem${on ? '' : ' off'}${ui.highlightRem === r.id ? ' highlight' : ''}" data-rid="${esc(r.id)}">
        <button class="switch" role="switch" aria-checked="${on}" aria-label="${on ? 'Turn reminder off' : 'Turn reminder on'}" data-rtoggle></button>
        <button class="rem-main" data-redit aria-label="Edit reminder">
          <div class="rem-title">${esc(x.title)}</div>
          <div class="task-meta">
            <span class="rem-when${soon ? ' soon' : ''}${on ? '' : ' past'}">${esc(when)}</span>
            ${r.kind === 'before_due' && r.offsetMinutes !== undefined ? `<span>${humanMins(r.offsetMinutes)} before due</span>` : ''}
            ${r.repeat !== 'none' ? `<span>🔁 ${REPEAT_LABEL[r.repeat] || r.repeat}</span>` : ''}
            ${task ? `<span class="rem-task">${esc(task.id)}</span>` : ''}
            ${r.note ? `<span>${esc(r.note)}</span>` : ''}
          </div>
        </button>
        <span class="rem-actions"><button class="icon-btn x" data-rdel aria-label="Delete reminder">✕</button></span>
      </div>`;
    }).join('');
  }

  // ---------- reminder editor (add / edit) ----------
  function openRemEditor(rid, presetTaskId) {
    const found = rid ? allReminders().find((x) => x.r.id === rid) : null;
    if (rid && !found) { toast('That reminder no longer exists'); return; }
    ui.remEdit = rid || null;
    const r = found ? found.r : null;
    const taskSel = $('#rmTask');
    const taskId = found ? (found.task ? found.task.id : '') : (presetTaskId || '');
    const tasks = S.tasks.filter((t) => t.status !== 'Done' || t.id === taskId);
    taskSel.innerHTML = '<option value="">No, a standalone reminder</option>' + tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.id)} · ${esc(t.title)}</option>`).join('');
    taskSel.value = taskId;
    $('#rmText').value = r && !found.task ? r.title : '';
    $('#rmMode').value = r && r.kind === 'before_due' ? 'before' : 'at';
    $('#rmBefore').value = String(r && r.offsetMinutes !== undefined ? r.offsetMinutes : 60);
    if (!$('#rmBefore').value) $('#rmBefore').value = '60';
    const nextHour = new Date(); nextHour.setMinutes(0, 0, 0); nextHour.setHours(nextHour.getHours() + 1);
    $('#rmAt').value = toLocalInput(r && r.active ? r.nextAt : nextHour.toISOString());
    $('#rmRepeat').value = r ? r.repeat || 'none' : 'none';
    // A reminder that already went off is shown as "on", so saving it with a new time schedules it again.
    $('#rmActive').checked = r ? remOn(found) || remFired(found) : true;
    $('#rmNote').value = r && r.note !== 'Snoozed' ? r.note || '' : '';
    $('#remTitle').textContent = r ? 'Edit reminder' : 'Add reminder';
    $('#rmDelete').hidden = !r;
    syncRemEditor();
    $('#remModal').hidden = false;
    (taskId ? $('#rmAt') : $('#rmText')).focus();
  }

  function syncRemEditor() {
    const task = S.tasks.find((t) => t.id === $('#rmTask').value);
    $('#rmTitleField').hidden = !!task;
    const before = $('#rmMode').querySelector('[value=before]');
    before.disabled = !(task && task.due);
    if (before.disabled && $('#rmMode').value === 'before') $('#rmMode').value = 'at';
    const mode = $('#rmMode').value;
    $('#rmAtField').hidden = mode !== 'at';
    $('#rmBeforeField').hidden = mode !== 'before';
    $('#rmQuick').hidden = mode !== 'at';
  }

  function quickTime(q) {
    const d = new Date();
    if (q === '30m') d.setMinutes(d.getMinutes() + 30);
    else if (q === '1h') d.setHours(d.getHours() + 1);
    else if (q === '5pm') { d.setHours(17, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); }
    else if (q === 'tom9') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
    return toLocalInput(d.toISOString());
  }

  async function saveReminder(e) {
    e.preventDefault();
    const taskId = $('#rmTask').value || null;
    const fields = { note: $('#rmNote').value.trim(), repeat: $('#rmRepeat').value };
    if ($('#rmMode').value === 'before') fields.minutes_before_due = Number($('#rmBefore').value);
    else {
      if (!$('#rmAt').value) { toast('Pick a date and time'); return; }
      fields.at = fromLocalInput($('#rmAt').value);
    }
    if (!taskId) {
      fields.title = $('#rmText').value.trim();
      if (!fields.title) { toast('What should I remind you about?'); $('#rmText').focus(); return; }
    }
    const active = $('#rmActive').checked;
    let r;
    if (ui.remEdit) r = await buddy.remUpdate(ui.remEdit, { ...fields, active, taskId: taskId || '' });
    else {
      r = await buddy.remAdd({ ...fields, taskId });
      if (r.ok && !active) await buddy.remUpdate(r.result, { active: false });
    }
    if (!r.ok) { toast(r.error); return; }
    $('#remModal').hidden = true;
    ui.highlightRem = r.result;
    toast(ui.remEdit ? 'Reminder updated' : 'Reminder added');
  }

  function wireReminders() {
    $('#boardTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
    $('#remFilters').addEventListener('click', (e) => { const b = e.target.closest('[data-rf]'); if (b) { ui.remFilter = b.dataset.rf; renderReminders(); } });
    $('#addReminderBtn').onclick = () => openRemEditor(null);
    $('#remList').addEventListener('click', async (e) => {
      const row = e.target.closest('[data-rid]'); if (!row) return;
      const rid = row.dataset.rid;
      if (e.target.closest('[data-redit]')) { openRemEditor(rid); return; }
      if (e.target.closest('[data-rdel]')) {
        if (!confirm('Delete this reminder?')) return;
        const r = await buddy.remDelete(rid);
        toast(r.ok ? 'Reminder deleted' : r.error);
        return;
      }
      if (e.target.closest('[data-rtoggle]')) {
        const x = allReminders().find((y) => y.r.id === rid);
        const turnOn = !remOn(x);
        const r = await buddy.remUpdate(rid, { active: turnOn });
        if (!r.ok) { toast(r.error); if (turnOn) openRemEditor(rid); return; } // e.g. a past one-off needs a new time
        toast(turnOn ? 'Reminder on' : 'Reminder paused');
      }
    });
    $('#remEditForm').addEventListener('submit', saveReminder);
    $('#rmTask').addEventListener('change', syncRemEditor);
    $('#rmMode').addEventListener('change', syncRemEditor);
    $('#rmQuick').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) $('#rmAt').value = quickTime(b.dataset.q); });
    $('#rmDelete').onclick = async () => {
      if (!ui.remEdit || !confirm('Delete this reminder?')) return;
      const r = await buddy.remDelete(ui.remEdit);
      if (r.ok) { $('#remModal').hidden = true; toast('Reminder deleted'); } else toast(r.error);
    };
    buddy.onFocusReminder((rid) => {
      ui.remFilter = 'all'; ui.highlightRem = rid; setView('reminders');
      const row = $(`#remList [data-rid="${CSS.escape(rid)}"]`); if (row) row.scrollIntoView({ block: 'center' });
    });
  }

  // ---------- rendering: detail ----------
  function openDetail(id) {
    ui.selected = id;
    $('#detail').hidden = false;
    renderDetail(true);
    renderTasks();
  }
  function closeDetail() {
    ui.selected = null;
    $('#detail').hidden = true;
    renderTasks();
  }

  function renderDetail(force) {
    if (!ui.selected) return;
    const t = S.tasks.find((x) => x.id === ui.selected);
    if (!t) { closeDetail(); return; }
    const body = $('#detailBody');
    if (!force && body.contains(document.activeElement) && document.activeElement !== body) { ui.detailDirty = true; return; }
    ui.detailDirty = false;
    $('#detailId').textContent = t.id;
    const rems = (t.reminders || []).slice().sort((a, b) => (a.nextAt || '').localeCompare(b.nextAt || ''));
    const log = (t.log || []).slice().reverse();
    body.innerHTML = `
      <textarea class="detail-title" id="dTitle" rows="1" aria-label="Title">${esc(t.title)}</textarea>
      <div class="seg" id="dStatus" role="group" aria-label="Status">
        ${STATUSES.map((s) => `<button data-s="${s}" class="st-${s.replace(' ', '-')}" aria-pressed="${t.status === s}">${s}</button>`).join('')}
      </div>
      <div class="row2" style="margin-top:14px">
        <label class="field"><span>Due</span><input type="datetime-local" id="dDue" value="${toLocalInput(t.due)}" /></label>
        <label class="field"><span>Priority</span><select id="dPri">${['Critical', 'High', 'Medium', 'Low'].map((p) => `<option${p === t.priority ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Progress</span>
        <div class="progress-row"><input type="range" id="dProg" min="0" max="100" step="5" value="${t.progress ?? 0}" /><b id="dProgVal">${t.progress ?? 0}%</b></div>
      </label>
      <label class="field"><span>From</span><input id="dFrom" value="${esc(t.assignedBy)}" placeholder="Who gave you this?" /></label>
      <label class="field"><span>Details</span><textarea id="dDesc" rows="3" placeholder="Notes, links, acceptance criteria…">${esc(t.description)}</textarea></label>

      <div class="section">
        <h3>Reminders</h3>
        ${rems.length ? rems.map((r) => `<div class="reminder${r.active ? '' : ' spent'}">
            <span>${r.active ? '🔔' : '✓'}</span>
            <button type="button" class="link" data-remedit="${r.id}" title="Edit reminder">${r.nextAt ? fmtWhen(r.nextAt) : '-'}${r.repeat !== 'none' ? `, repeats ${r.repeat}` : ''}${r.kind === 'before_due' ? ` (${humanMins(r.offsetMinutes)} before due)` : ''}${r.note ? ` · ${esc(r.note)}` : ''}${r.active ? '' : r.pausedAt ? ' · paused' : ''}</button>
            <button class="icon-btn x" data-rem="${r.id}" aria-label="Remove reminder">✕</button>
          </div>`).join('') : '<p class="hint">No reminders yet.</p>'}
        <div class="inline-form" id="remForm">
          <select id="remMode"><option value="at">At</option><option value="before"${t.due ? '' : ' disabled'}>Before due</option></select>
          <input type="datetime-local" id="remAt" value="${toLocalInput(new Date(Date.now() + 3600000).toISOString())}" />
          <select id="remBefore" hidden>
            <option value="15">15 min</option><option value="30">30 min</option><option value="60" selected>1 hour</option>
            <option value="120">2 hours</option><option value="240">4 hours</option><option value="1440">1 day</option><option value="2880">2 days</option>
          </select>
          <select id="remRepeat"><option value="none">Once</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="hourly">Hourly</option></select>
          <button class="btn ghost small" id="remAdd">Add reminder</button>
        </div>
      </div>

      <div class="section">
        <h3>Updates and blockers</h3>
        <div class="inline-form">
          <select id="logKind"><option value="progress">Progress</option><option value="blocker">Blocker</option><option value="blocker_resolved">Unblocked</option><option value="note">Note</option></select>
          <input type="text" id="logText" placeholder="What changed?" />
          <button class="btn ghost small" id="logAdd">Add</button>
        </div>
        <ul class="timeline">
          ${log.map((e) => `<li class="t-${e.type}"><time>${fmtWhen(e.at)}</time>${e.type === 'blocker' ? '<b>Blocker:</b> ' : e.type === 'resolved' ? '<b>Unblocked:</b> ' : ''}${esc(e.text)}</li>`).join('')}
        </ul>
      </div>`;
  }
  function humanMins(m) {
    if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
    if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
    return `${m} min`;
  }

  async function upd(fields) {
    const r = await buddy.updateTask(ui.selected, fields);
    if (!r.ok) toast(r.error);
  }

  function wireDetail() {
    const body = $('#detailBody');
    body.addEventListener('click', async (e) => {
      const sb = e.target.closest('#dStatus button');
      if (sb) { upd({ status: sb.dataset.s }); return; }
      const re = e.target.closest('[data-remedit]');
      if (re) { openRemEditor(re.dataset.remedit); return; }
      const rm = e.target.closest('[data-rem]');
      if (rm) { const r = await buddy.removeReminder(ui.selected, rm.dataset.rem); if (!r.ok) toast(r.error); return; }
      if (e.target.id === 'remAdd') {
        const mode = $('#remMode').value;
        const payload = { repeat: $('#remRepeat').value };
        if (mode === 'before') payload.minutes_before_due = Number($('#remBefore').value);
        else payload.at = fromLocalInput($('#remAt').value);
        const r = await buddy.addReminder(ui.selected, payload);
        if (!r.ok) toast(r.error); else toast('Reminder added');
        return;
      }
      if (e.target.id === 'logAdd') addLog();
    });
    body.addEventListener('change', (e) => {
      const id = e.target.id;
      if (id === 'dDue') upd({ due: fromLocalInput(e.target.value) });
      if (id === 'dPri') upd({ priority: e.target.value });
      if (id === 'dProg') upd({ progress: Number(e.target.value) });
      if (id === 'remMode') { $('#remAt').hidden = e.target.value !== 'at'; $('#remBefore').hidden = e.target.value === 'at'; }
    });
    body.addEventListener('input', (e) => { if (e.target.id === 'dProg') $('#dProgVal').textContent = `${e.target.value}%`; });
    body.addEventListener('focusout', (e) => {
      const t = S.tasks.find((x) => x.id === ui.selected); if (!t) return;
      const id = e.target.id; const v = e.target.value;
      if (id === 'dTitle' && v.trim() && v.trim() !== t.title) upd({ title: v.trim() });
      if (id === 'dFrom' && v !== (t.assignedBy || '')) upd({ assigned_by: v });
      if (id === 'dDesc' && v !== (t.description || '')) upd({ description: v });
      setTimeout(() => { if (ui.detailDirty && !body.contains(document.activeElement)) renderDetail(); }, 50);
    });
    body.addEventListener('keydown', (e) => {
      if (e.target.id === 'logText' && e.key === 'Enter') { e.preventDefault(); addLog(); }
      if (e.target.id === 'dTitle' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
    async function addLog() {
      const text = $('#logText').value.trim();
      if (!text) return;
      const r = await buddy.logUpdate(ui.selected, $('#logKind').value, text);
      if (!r.ok) toast(r.error);
      else { $('#logText').value = ''; renderDetail(true); }
    }
    $('#detailBack').onclick = closeDetail;
    $('#detailDelete').onclick = async () => {
      const t = S.tasks.find((x) => x.id === ui.selected);
      if (!t || !confirm(`Delete ${t.id} "${t.title}"? This can't be undone.`)) return;
      const r = await buddy.deleteTask(t.id);
      if (r.ok) { closeDetail(); toast(`Deleted ${t.id}`); } else toast(r.error);
    };
  }

  // ---------- rendering: chat ----------
  function linkify(text) {
    return esc(text).replace(/\bT-(\d+)\b/g, (m) => (S.tasks.some((t) => t.id === m) ? `<button class="tlink" data-task="${m}">${m}</button>` : m));
  }

  function renderChat() {
    const el = $('#messages');
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    el.innerHTML = (!S.settings.hasKey || !S.chat.length ? welcomeHtml() : '') + chatHtml();
    if (ui.thinking) el.insertAdjacentHTML('beforeend', '<div class="typing" aria-label="Buddy is thinking"><i></i><i></i><i></i></div>');
    if (nearBottom || ui.forceScroll) { el.scrollTop = el.scrollHeight; ui.forceScroll = false; }
  }

  function chatHtml() {
    let lastDay = '';
    return S.chat.map((m) => {
      const d = new Date(m.at);
      const day = d.toDateString();
      let sep = '';
      if (day !== lastDay) {
        lastDay = day;
        const diff = Math.round((sod(d) - sod(new Date())) / DAY);
        sep = `<div class="day-sep">${diff === 0 ? 'Today' : diff === -1 ? 'Yesterday' : dayStr(d)}</div>`;
      }
      const cls = m.role === 'user' ? 'user' : `buddy${m.error ? ' error' : ''}${m.kind ? ` ${m.kind}` : ''}`;
      return `${sep}<div class="msg ${cls}">${m.voice ? '<span class="voice-tag">🎙</span>' : ''}${linkify(m.text)}<span class="when">${timeStr(d)}</span></div>`;
    }).join('');
  }

  function welcomeHtml() {
    const name = S.settings.userName ? `, ${esc(S.settings.userName)}` : '';
    if (!S.settings.hasKey) {
      return `<div class="welcome">
        <h2>Hi${name}. I'm Buddy.</h2>
        <p>I keep track of your tasks, remind you before things are due, and write your stand-up and weekly updates for your manager.</p>
        <p>One step before we start: connect me to the AI service so I can understand what you tell me.</p>
        <button class="btn primary" id="setupBtn">Set up Buddy</button>
      </div>`;
    }
    return `<div class="welcome">
      <h2>Hi${name}. What's on your plate?</h2>
      <p>Talk to me the way you'd talk to a colleague. Type below, click the blue orb, or just say "Hey Buddy".</p>
      <div class="examples">
        <div>"New task from Priya: vendor audit due Thursday 5pm, high priority."</div>
        <div>"Remind me about the audit Wednesday at 10."</div>
        <div>"Blocked on the billing migration, waiting for DB access from IT."</div>
        <div>"Prepare my weekly summary."</div>
      </div>
    </div>`;
  }

  // ---------- render all ----------
  function render() {
    renderFilters();
    renderTasks();
    renderReminders();
    renderDetail(false);
    renderChat();
    $('#chips').hidden = !S.settings.hasKey;
  }

  // ---------- chat sending ----------
  async function send(text, meta = {}) {
    text = String(text || '').trim();
    if (!text) return;
    // Typed messages: go straight to Settings. Voice commands still go through, so the
    // companion and the spoken reply can explain what's missing instead of silently dropping them.
    if (!S.settings.hasKey && !meta.voice) { openSettings(); toast('Connect an AI first'); return; }
    ui.forceScroll = true;
    await buddy.send(text, meta);
  }

  function autosize() {
    const ta = $('#input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }

  // ---------- reports ----------
  let reportSeq = 0;
  async function openReport(type) {
    ui.reportType = type;
    $('#reportModal').hidden = false;
    $$('#reportTabs button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.type === type));
    const ta = $('#reportText');
    ta.value = 'Writing your report from your logged updates…';
    ta.classList.add('loading');
    $('#reportNote').textContent = '';
    const seq = ++reportSeq;
    const r = await buddy.report(type);
    if (seq !== reportSeq) return;
    ta.classList.remove('loading');
    if (!r.ok) { ta.value = ''; $('#reportNote').textContent = r.error; return; }
    ta.value = r.result.text;
    $('#reportNote').textContent = r.result.note
      ? `Basic version (AI unavailable: ${r.result.note})`
      : r.result.ai ? 'Written from your logged updates. Edit freely before copying.' : 'Basic version. Log more updates for a richer report.';
  }

  // ---------- settings ----------
  // ---------- AI connections ----------
  const CONN_UI = {
    chatgpt: { name: 'ChatGPT account', signIn: true, info: 'Uses your ChatGPT plan through OpenAI\'s Codex tool. About 5–10 s per reply.', model: 'Model: gpt-6-luna (fast) · smarter: gpt-6.1-sol' },
    claude: { name: 'Claude account', signIn: true, info: 'Uses your Claude plan through Claude Code. About 5 s per reply.', model: 'Model: sonnet · faster: haiku · smartest: opus' },
    google: { name: 'Google account (Gemini)', signIn: true, info: 'Uses your Google account through the Gemini CLI (free tier available).', model: 'Model: Gemini default' },
    anthropic: { name: 'Claude API key', info: 'Pay-as-you-go API key from console.anthropic.com. About 2–4 s per reply.', model: 'Model: claude-sonnet-5-5', keyHint: 'Paste a key starting with sk-ant-' },
    openai: { name: 'OpenAI API key', info: 'Pay-as-you-go API key from platform.openai.com (needs credit).', model: 'Model: gpt-5-mini', keyHint: 'Paste a key starting with sk-' },
    gemini: { name: 'Gemini API key', info: 'Free API key from aistudio.google.com (daily limits).', model: 'Model: gemini-flash-latest', keyHint: 'Paste your Gemini API key' },
  };
  const connStatus = new Map(); // id -> {state, text}
  const connMsg = new Map();    // id -> {text, error}

  function renderConnections() {
    const list = S.settings.connections || [];
    const el = $('#connList');
    if (!list.length) {
      el.innerHTML = '<li class="conn-empty">No AI connected yet. Add one below: signing in with your ChatGPT, Claude or Google account needs no API key.</li>';
      return;
    }
    el.innerHTML = list.map((c, i) => {
      const ui = CONN_UI[c.type] || { name: c.type, info: '', model: 'Model' };
      const st = connStatus.get(c.id);
      const msg = connMsg.get(c.id);
      return `<li class="conn${i === 0 ? ' main' : ''}" data-id="${esc(c.id)}">
        <div class="conn-top">
          <span class="conn-name">${esc(ui.name)}</span>${i === 0 ? '<span class="conn-badge">Main</span>' : `<span class="hint">Backup ${i}</span>`}
          <span class="conn-state ${st ? esc(st.state) : 'busy'}">${st ? esc(st.text) : 'Checking'}</span>
        </div>
        <div class="hint">${esc(ui.info)}</div>
        <div class="conn-sub">
          <input class="conn-model" value="${esc(c.model)}" placeholder="${esc(ui.model)}" aria-label="Model" />
          ${ui.signIn ? '' : `<input class="conn-key" type="password" placeholder="${c.hasKey ? 'Key saved · paste to replace' : esc(ui.keyHint)}" autocomplete="off" aria-label="API key" />`}
        </div>
        <div class="conn-sub">
          ${ui.signIn ? `<button type="button" class="btn ghost small" data-act="signin">${st && st.state === 'missing' ? 'Install and sign in' : st && (st.state === 'ok') ? 'Sign in again' : 'Sign in'}</button>` : ''}
          <button type="button" class="btn ghost small" data-act="test">Test</button>
          ${i ? '<button type="button" class="btn ghost small" data-act="main">Make main</button>' : ''}
          <button type="button" class="btn ghost small danger" data-act="remove">Remove</button>
        </div>
        ${msg ? `<div class="conn-msg${msg.error ? ' error' : ''}">${esc(msg.text)}</div>` : ''}
      </li>`;
    }).join('');
    for (const c of list) if (!connStatus.has(c.id)) checkConnStatus(c.id);
  }

  async function checkConnStatus(id) {
    connStatus.set(id, { state: 'busy', text: 'Checking' });
    const r = await buddy.connStatus(id);
    connStatus.set(id, r.ok ? r.result : { state: 'signin', text: 'Unknown' });
    if (!$('#settingsModal').hidden) renderConnections();
  }

  async function refreshConnections() {
    S = await buddy.getState();
    renderConnections();
  }

  function wireConnections() {
    const typeSel = $('#connType'); const keyIn = $('#connKey');
    const syncAdd = () => {
      const ui = CONN_UI[typeSel.value];
      keyIn.hidden = !!ui.signIn;
      keyIn.placeholder = ui.keyHint || '';
    };
    typeSel.addEventListener('change', syncAdd);
    syncAdd();
    $('#connAddBtn').onclick = async () => {
      const type = typeSel.value;
      const r = await buddy.connAdd({ type, key: keyIn.value.trim() });
      if (!r.ok) { toast(r.error); return; }
      keyIn.value = '';
      connMsg.set(r.result, { text: CONN_UI[type].signIn ? 'Added. If it shows "Not signed in", click Sign in; then click Test.' : 'Added. Click Test to check the key.' });
      await refreshConnections();
    };

    const list = $('#connList');
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = b.closest('[data-id]').dataset.id;
      const act = b.dataset.act;
      if (act === 'remove') {
        if (!confirm('Remove this AI connection?')) return;
        await buddy.connRemove(id); connStatus.delete(id); connMsg.delete(id);
      } else if (act === 'main') {
        await buddy.connMain(id);
      } else if (act === 'signin') {
        const r = await buddy.connSignIn(id);
        connMsg.set(id, r.ok
          ? { text: 'A sign-in window opened. Finish signing in (it may open your browser), then click Test.' }
          : { text: r.error, error: true });
        connStatus.delete(id);
      } else if (act === 'test') {
        b.disabled = true; b.textContent = 'Testing…';
        const t0 = performance.now();
        const r = await buddy.connTest(id);
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        connMsg.set(id, r.ok ? { text: `Connected: it answered in ${secs} s.` } : { text: r.error, error: true });
        connStatus.set(id, r.ok ? { state: 'ok', text: 'Working' } : { state: 'signin', text: 'Not working' });
      }
      await refreshConnections();
    });
    list.addEventListener('change', async (e) => {
      const id = e.target.closest('[data-id]')?.dataset.id; if (!id) return;
      if (e.target.classList.contains('conn-model')) {
        const r = await buddy.connUpdate({ id, model: e.target.value.trim() });
        if (r.ok) connMsg.set(id, { text: 'Model saved.' });
      } else if (e.target.classList.contains('conn-key') && e.target.value.trim()) {
        const r = await buddy.connUpdate({ id, key: e.target.value.trim() });
        connMsg.set(id, r.ok ? { text: 'Key saved. Click Test to check it.' } : { text: r.error, error: true });
      }
      await refreshConnections();
    });
  }

  // ---------- custom companion character ----------
  function renderCharacterPicker() {
    $('#customChar').hidden = $('#charSelect').value !== 'custom';
    const v = S.settings.customCharacterVersion;
    for (const [pose, imgId, emptyId] of [['idle', '#charIdle', '#charIdleEmpty'], ['talk', '#charTalk', '#charTalkEmpty']]) {
      const img = $(imgId); const empty = $(emptyId);
      img.hidden = true; empty.hidden = false;
      if (!v) continue;
      img.onload = () => { img.hidden = false; empty.hidden = true; };
      img.onerror = () => { img.hidden = true; empty.hidden = false; };
      img.src = `app://buddy/character/${pose}.png?v=${v}`;
    }
  }

  const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file could not be read as an image.')); i.src = src; });

  // Make the plain background transparent (flood fill from the edges), crop to the
  // character and scale it to a sensible size. Images that already have transparency are kept.
  async function prepareCharacter(dataUrl) {
    const src = await loadImage(dataUrl);
    const k = Math.min(1, 700 / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * k)); const h = Math.max(1, Math.round(src.height * k));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(src, 0, 0, w, h);
    const im = c.getImageData(0, 0, w, h); const d = im.data;
    const at = (x, y) => (y * w + x) * 4;
    const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
    if (corners.some((i) => d[i + 3] > 20)) {
      const bg = [0, 1, 2].map((ch) => corners.reduce((s, i) => s + d[i + ch], 0) / 4);
      const dist = (i) => Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
      const TOL = 48;
      const seen = new Uint8Array(w * h); const stack = [];
      const seed = (x, y) => { const p = y * w + x; if (!seen[p] && dist(p * 4) < TOL) { seen[p] = 1; stack.push(p); } };
      for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
      for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
      while (stack.length) {
        const p = stack.pop(); const x = p % w; const y = (p - x) / w;
        d[p * 4 + 3] = 0;
        if (x > 0) seed(x - 1, y); if (x < w - 1) seed(x + 1, y);
        if (y > 0) seed(x, y - 1); if (y < h - 1) seed(x, y + 1);
      }
      // Soften the fringe left by anti-aliasing against the old background
      for (let p = 0; p < w * h; p++) {
        if (seen[p] || dist(p * 4) > TOL * 1.8) continue;
        const x = p % w; const y = (p - x) / w;
        if ((x > 0 && seen[p - 1]) || (x < w - 1 && seen[p + 1]) || (y > 0 && seen[p - w]) || (y < h - 1 && seen[p + w])) d[p * 4 + 3] = 110;
      }
      c.putImageData(im, 0, 0);
    }
    // Crop to the visible character
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[at(x, y) + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) throw new Error('The whole image looked like background. Try a picture with more contrast.');
    const cw = x1 - x0 + 1; const ch = y1 - y0 + 1;
    const s = Math.min(1, 260 / ch);
    const out = document.createElement('canvas');
    out.width = Math.round(cw * s); out.height = Math.round(ch * s);
    out.getContext('2d').drawImage(cv, x0, y0, cw, ch, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  async function chooseCharacterImage(pose) {
    const pick = await buddy.pickCharacterImage();
    if (!pick.ok) { toast(pick.error); return; }
    if (!pick.result) return;
    try {
      const png = await prepareCharacter(pick.result);
      const r = await buddy.saveCharacterImage(pose, png);
      if (!r.ok) { toast(r.error); return; }
      S.settings.customCharacterVersion = r.result;
      renderCharacterPicker();
      toast(pose === 'idle' ? 'Standing pose saved. Save settings to use your character.' : 'Talking pose saved');
    } catch (err) { toast(err.message); }
  }

  function populateVoices() {
    const sel = $('#voiceSelect');
    const voices = window.speechSynthesis.getVoices();
    sel.innerHTML = '<option value="">Windows default</option>' + voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
    sel.value = S.settings.voiceName || '';
  }

  function openSettings() {
    const f = $('#settingsForm');
    const s = S.settings;
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') el.checked = el.name === 'useBackups' ? s.useBackups !== false : !!s[el.name];
      else if (s[el.name] !== undefined) el.value = s[el.name];
    }
    connStatus.clear(); connMsg.clear(); // re-check sign-in status each time Settings opens
    renderConnections();
    renderCharacterPicker();
    $('#versionLabel').textContent = `Buddy ${S.version || ''}`;
    populateVoices();
    populateMics();
    $('#settingsModal').hidden = false;
    startVoiceCheck();
    (s.hasKey ? f.userName : $('#connType')).focus();
  }

  // ---------- voice check (Settings) ----------
  async function populateMics() {
    const sel = $('#micSelect');
    try {
      const mics = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      sel.innerHTML = '<option value="">Windows default</option>' + mics.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Microphone ${i + 1}`)}</option>`).join('');
    } catch (_) { /* keep the default option */ }
    sel.value = S.settings.micDeviceId || '';
    if (sel.value !== (S.settings.micDeviceId || '')) sel.value = '';
  }

  // While Settings is open: live mic level and the last things the recogniser heard.
  let voiceCheckTimer = null;
  function startVoiceCheck() {
    clearInterval(voiceCheckTimer);
    let lastHeard = '';
    const tick = () => {
      if ($('#settingsModal').hidden) { clearInterval(voiceCheckTimer); return; }
      const running = voice && voice.mode !== 'stopped' && voice.mode !== 'loading';
      $('#micLevel').style.width = `${Math.round((running ? voice.level() : 0) * 100)}%`;
      $('#micName').textContent = running ? voice.micLabel : voice && voice.mode === 'loading' ? 'Starting…' : 'Voice is off';
      const items = running ? voice.heard.slice().reverse() : [];
      const key = items.map((h) => h.at).join();
      if (key === lastHeard) return;
      lastHeard = key;
      $('#heardList').innerHTML = items.length
        ? items.map((h) => `<li class="${h.wake ? 'wake' : ''}">"${esc(h.text)}"</li>`).join('')
        : `<li>${running ? 'Say "Hey Buddy, what\'s due today?" — what I hear shows up here. A ✓ means I recognised it.' : 'Tick "Listen for Hey Buddy" and save, or click the orb, to start the microphone.'}</li>`;
    };
    tick();
    voiceCheckTimer = setInterval(tick, 100);
  }

  // Save the settings form; returns false (after showing why) if saving failed.
  async function persistSettings() {
    const f = $('#settingsForm');
    const out = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'range' || el.dataset.num !== undefined) out[el.name] = Number(el.value);
      else out[el.name] = el.value.trim();
    }
    const r = await buddy.saveSettings(out);
    if (!r.ok) { toast(r.error); return false; }
    Object.assign(S.settings, out);
    applyVoiceSettings();
    return true;
  }

  async function saveSettings(e) {
    e.preventDefault();
    if (!(await persistSettings())) return;
    $('#settingsModal').hidden = true;
    toast('Settings saved');
  }

  // ---------- voice ----------
  let voice = null;
  function setVoiceStatus(state, text) {
    const st = $('#voiceStatus');
    st.textContent = text;
    st.classList.toggle('warn', state === 'error');
    const orb = $('#orb');
    orb.classList.toggle('idle', state === 'idle');
    orb.classList.toggle('off', state === 'off' || state === 'error' || state === 'loading');
    orb.classList.toggle('active', state === 'active');
    $('#micBtn').classList.toggle('on', state === 'active');
  }

  function initVoice() {
    voice = new BuddyVoice({
      getSettings: () => S.settings,
      onStatus: setVoiceStatus,
      onWake: (initial) => {
        buddy.wake();
        $('#listening').hidden = false;
        $('#listeningLabel').textContent = 'Listening…';
        $('#listeningTranscript').textContent = initial || 'Say a new task, an update, or a question.';
        chime(880, 0.08);
      },
      onPartial: (text) => { $('#listeningTranscript').textContent = text || '…'; buddy.voicePartial(text); },
      onCommand: (text) => {
        $('#listening').hidden = true;
        send(text, { voice: true });
      },
      onCancel: () => { $('#listening').hidden = true; buddy.voiceEnd(); },
    });
    if (S.settings.wakeWordEnabled) voice.start();
    else setVoiceStatus('off', 'Wake word off - click the orb or press Ctrl+Space to talk');
  }

  function applyVoiceSettings() {
    if (!voice) return;
    if (S.settings.wakeWordEnabled && voice.mode === 'stopped') voice.start();
    else {
      voice.setWakeEnabled(!!S.settings.wakeWordEnabled);
      if ((S.settings.micDeviceId || '') !== voice.micDeviceId) voice.switchMic();
    }
  }

  function chime(freq = 660, dur = 0.12) {
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + dur + 0.02);
      setTimeout(() => ctx.close(), 400);
    } catch (_) {}
  }

  // ---------- snackbar ----------
  let snackTimer;
  function toast(msg) {
    const el = $('#snackbar');
    el.textContent = msg; el.hidden = false;
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ---------- events ----------
  function wire() {
    $('#filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      ui.filter = b.dataset.f; renderFilters(); renderTasks();
    });
    $('#taskList').addEventListener('click', (e) => {
      const b = e.target.closest('.task'); if (b) openDetail(b.dataset.id);
    });
    $('#messages').addEventListener('click', (e) => {
      const l = e.target.closest('[data-task]'); if (l) openDetail(l.dataset.task);
      if (e.target.id === 'setupBtn') openSettings();
    });

    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#input').value; $('#input').value = ''; autosize(); send(v);
    });
    $('#input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
    });
    $('#input').addEventListener('input', autosize);
    $('#chips').addEventListener('click', (e) => { const c = e.target.closest('[data-say]'); if (c) send(c.dataset.say); });

    $('#orb').onclick = () => voice.listenNow();
    $('#micBtn').onclick = () => voice.listenNow();
    $('#listeningCancel').onclick = () => voice.cancel();

    $$('[data-report]').forEach((b) => { b.onclick = () => openReport(b.dataset.report); });
    $('#reportTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) openReport(b.dataset.type); });
    $('#reportRegen').onclick = () => openReport(ui.reportType);
    $('#reportCopy').onclick = async () => { await buddy.copy($('#reportText').value); toast('Report copied - paste it into email or Teams'); };

    $('#addTaskBtn').onclick = () => {
      const f = $('#addForm'); f.reset();
      $('#addModal').hidden = false; f.title.focus();
    };
    $('#addForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const r = await buddy.createTask({
        title: f.title.value, due: fromLocalInput(f.due.value), priority: f.priority.value,
        assigned_by: f.assigned_by.value, description: f.description.value,
      });
      if (!r.ok) { toast(r.error); return; }
      $('#addModal').hidden = true;
      toast(`Added ${r.result.id}`);
    });

    $('#settingsBtn').onclick = openSettings;
    $('#settingsForm').addEventListener('submit', saveSettings);
    wireConnections();
    $('#charSelect').addEventListener('change', renderCharacterPicker);
    $('#customChar').addEventListener('click', (e) => { const b = e.target.closest('[data-pose]'); if (b) chooseCharacterImage(b.dataset.pose); });
    $('#testVoice').onclick = () => {
      const f = $('#settingsForm');
      const u = new SpeechSynthesisUtterance('Hi, I\'m Buddy. You have two tasks due today.');
      const v = window.speechSynthesis.getVoices().find((x) => x.name === f.voiceName.value);
      if (v) u.voice = v; u.rate = Number(f.speechRate.value) || 1;
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    };
    $('#exportBtn').onclick = async () => { const r = await buddy.exportData(); if (r.ok && r.result) toast('Backup saved'); else if (!r.ok) toast(r.error); };
    $('#importBtn').onclick = async () => {
      if (!confirm('Restoring replaces all current tasks and chat with the backup. Continue?')) return;
      const r = await buddy.importData(); if (r.ok && r.result) toast('Backup restored'); else if (!r.ok) toast(r.error);
    };
    $('#folderBtn').onclick = () => buddy.openDataFolder();
    $('#quitBtn').onclick = () => {
      if (confirm('Quit Buddy? Reminders stop until you open Buddy again.')) buddy.quitApp();
    };
    $('#clearChatBtn').onclick = async () => { if (confirm('Clear the chat history? Tasks are not affected.')) { await buddy.clearChat(); toast('Chat cleared'); } };

    $$('.modal').forEach((m) => {
      m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
    });

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); voice.listenNow(); }
      if (e.key === 'Escape') {
        if (voice && voice.mode === 'command') { voice.cancel(); return; }
        const open = $$('.modal').find((m) => !m.hidden);
        if (open) { open.hidden = true; return; }
        if (ui.selected) closeDetail();
      }
    });

    window.speechSynthesis.onvoiceschanged = () => { if (!$('#settingsModal').hidden) populateVoices(); };

    // from main process
    buddy.onState((st) => { S = st; render(); });
    buddy.onThinking((on) => { ui.thinking = on; renderChat(); });
    buddy.onReply((r) => { if (r.voice) voice.speak(r.text); });
    buddy.onOpenReport((type) => openReport(type));
    buddy.onFocusTask((id) => openDetail(id));
    buddy.onVoiceToggle((on) => { S.settings.wakeWordEnabled = on; applyVoiceSettings(); });
    buddy.onVoiceCancel(() => voice && voice.cancel());
    buddy.onAlertSpeak((alerts) => {
      if (!S.settings.speakReplies) return;
      const a = alerts[0];
      if (a.kind === 'briefing') voice.speak(a.text);
      else voice.speak(alerts.length > 1 ? `You have ${alerts.length} reminders. First: ${a.title}.` : `Reminder: ${a.title}${a.kind === 'due' ? ' is due now' : ''}.`);
    });

    // keep relative times ("Today 5 pm", overdue) fresh
    setInterval(() => { renderFilters(); renderTasks(); renderReminders(); }, 60000);
  }

  // ---------- boot ----------
  (async function boot() {
    S = await buddy.getState();
    wire();
    wireDetail();
    wireReminders();
    ui.forceScroll = true;
    render();
    initVoice();
    if (!S.settings.hasKey) setTimeout(openSettings, 400);
  })();
})();
