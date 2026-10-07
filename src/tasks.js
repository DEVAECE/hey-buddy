// Task operations. Every change goes through here so the activity log
// (which feeds the manager reports) stays complete and accurate.
const crypto = require('crypto');

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
const STATUSES = ['Not started', 'In progress', 'Blocked', 'Done'];
const REPEATS = ['none', 'hourly', 'daily', 'weekdays', 'weekly'];

const rid = () => crypto.randomBytes(4).toString('hex');
const nowIso = () => new Date().toISOString();

function normPriority(p) {
  if (!p) return null;
  const m = PRIORITIES.find((x) => x.toLowerCase() === String(p).toLowerCase());
  return m || null;
}
function normStatus(s) {
  if (!s) return null;
  const v = String(s).toLowerCase().replace(/[_-]/g, ' ').trim();
  if (v === 'todo' || v === 'to do' || v === 'open' || v === 'new') return 'Not started';
  if (v === 'done' || v === 'complete' || v === 'completed' || v === 'closed') return 'Done';
  if (v === 'in progress' || v === 'wip' || v === 'started' || v === 'ongoing') return 'In progress';
  if (v === 'blocked' || v === 'on hold') return 'Blocked';
  return STATUSES.find((x) => x.toLowerCase() === v) || null;
}
function parseDate(d) {
  if (d === null || d === '' || d === undefined) return null;
  const t = new Date(d);
  return isNaN(t.getTime()) ? undefined : t.toISOString();
}

class TaskService {
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange || (() => {});
  }
  get tasks() { return this.store.data.tasks; }

  _log(task, type, text) {
    task.log = task.log || [];
    task.log.push({ at: nowIso(), type, text });
    task.updatedAt = nowIso();
  }

  _changed() {
    this.store.save();
    this.onChange();
  }

  create(input) {
    const title = String(input.title || '').trim();
    if (!title) throw new Error('A task needs a title.');
    const due = parseDate(input.due);
    if (due === undefined) throw new Error(`Could not understand the due date "${input.due}".`);
    const task = {
      id: this.store.newTaskId(),
      title,
      description: input.description || '',
      assignedBy: input.assigned_by || input.assignedBy || '',
      priority: normPriority(input.priority) || 'Medium',
      status: normStatus(input.status) || 'Not started',
      progress: typeof input.progress === 'number' ? clampPct(input.progress) : null,
      due,
      tags: Array.isArray(input.tags) ? input.tags : [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      dueAlerted: false,
      log: [],
      reminders: [],
    };
    this._log(task, 'created', `Task added${task.assignedBy ? ` (from ${task.assignedBy})` : ''}`);
    this.tasks.push(task);
    this._changed();
    return task;
  }

  update(id, fields) {
    const task = this.store.findTask(id);
    if (!task) throw new Error(`No task with id ${id}.`);
    const changes = [];
    if (fields.title !== undefined && fields.title !== task.title) {
      changes.push(`Renamed to "${fields.title}"`);
      task.title = String(fields.title);
    }
    if (fields.description !== undefined) task.description = String(fields.description);
    const ab = fields.assigned_by ?? fields.assignedBy;
    if (ab !== undefined) task.assignedBy = String(ab);
    if (fields.priority !== undefined) {
      const p = normPriority(fields.priority);
      if (!p) throw new Error(`Priority must be one of ${PRIORITIES.join(', ')}.`);
      if (p !== task.priority) changes.push(`Priority ${task.priority} → ${p}`);
      task.priority = p;
    }
    if (fields.due !== undefined) {
      const d = parseDate(fields.due);
      if (d === undefined) throw new Error(`Could not understand the due date "${fields.due}".`);
      if (d !== task.due) {
        changes.push(d ? `Due date set to ${fmt(d)}` : 'Due date removed');
        task.due = d;
        task.dueAlerted = false;
        this._recomputeRelative(task);
      }
    }
    if (fields.progress !== undefined && fields.progress !== null) {
      const pr = clampPct(Number(fields.progress));
      if (pr !== task.progress) changes.push(`Progress ${pr}%`);
      task.progress = pr;
    }
    if (fields.status !== undefined) {
      const s = normStatus(fields.status);
      if (!s) throw new Error(`Status must be one of ${STATUSES.join(', ')}.`);
      if (s !== task.status) {
        changes.push(`Status ${task.status} → ${s}`);
        this._setStatus(task, s);
      }
    }
    if (changes.length) this._log(task, 'edit', changes.join('; '));
    else task.updatedAt = nowIso();
    this._changed();
    return task;
  }

  _setStatus(task, s) {
    task.status = s;
    if (s === 'Done') {
      task.completedAt = nowIso();
      task.progress = 100;
    } else {
      task.completedAt = null;
    }
  }

  logUpdate(id, kind, text, progress) {
    const task = this.store.findTask(id);
    if (!task) throw new Error(`No task with id ${id}.`);
    const k = ['progress', 'blocker', 'blocker_resolved', 'note'].includes(kind) ? kind : 'note';
    if (typeof progress === 'number') task.progress = clampPct(progress);
    if (k === 'blocker') {
      this._log(task, 'blocker', text);
      if (task.status !== 'Blocked') this._setStatus(task, 'Blocked');
    } else if (k === 'blocker_resolved') {
      this._log(task, 'resolved', text || 'Blocker resolved');
      if (task.status === 'Blocked') this._setStatus(task, 'In progress');
    } else {
      this._log(task, k === 'progress' ? 'progress' : 'note',
        text + (typeof progress === 'number' ? ` (${task.progress}%)` : ''));
      if (k === 'progress' && task.status === 'Not started') this._setStatus(task, 'In progress');
    }
    this._changed();
    return task;
  }

  remove(id) {
    const i = this.tasks.findIndex((t) => t === this.store.findTask(id));
    if (i < 0) throw new Error(`No task with id ${id}.`);
    const [t] = this.tasks.splice(i, 1);
    this._changed();
    return t;
  }

  // ---------- reminders ----------
  // A reminder lives on a task (task.reminders) or stands alone (store.data.reminders, with a title).
  // Both share one shape: {id, kind: 'at'|'before_due', nextAt, offsetMinutes?, repeat, note, active, title?}.
  get standalone() {
    if (!Array.isArray(this.store.data.reminders)) this.store.data.reminders = [];
    return this.store.data.reminders;
  }

  // Set when (at / minutes_before_due) and repeat on r, validating against its task (if any).
  _schedule(r, task, { at, minutes_before_due, repeat }) {
    if (repeat !== undefined) r.repeat = REPEATS.includes(repeat) ? repeat : 'none';
    r.repeat = r.repeat || 'none';
    if (minutes_before_due !== undefined && minutes_before_due !== null && !at) {
      if (!task) throw new Error('A "before due" reminder needs a task with a due date.');
      if (!task.due) throw new Error('This task has no due date yet, so a "before due" reminder cannot be set.');
      r.kind = 'before_due';
      r.offsetMinutes = Math.max(0, Number(minutes_before_due));
      r.nextAt = new Date(new Date(task.due).getTime() - r.offsetMinutes * 60000).toISOString();
    } else if (at !== undefined) {
      const d = parseDate(at);
      if (!d) throw new Error('A reminder needs a time ("at") or minutes_before_due.');
      r.kind = 'at';
      delete r.offsetMinutes;
      r.nextAt = d;
    }
    if (!r.nextAt) throw new Error('A reminder needs a time ("at") or minutes_before_due.');
    this._settle(r);
  }

  // Active reminders must be in the future: repeating ones move to their next occurrence,
  // a one-off in the past is refused (it would fire immediately).
  _settle(r) {
    if (!r.active) return;
    if (r.repeat !== 'none') r.nextAt = advanceUntilFuture(r.nextAt, r.repeat, true);
    else if (new Date(r.nextAt).getTime() < Date.now() - 60000) {
      throw new Error(`That reminder time (${fmt(r.nextAt)}) is already in the past. Pick a new time.`);
    }
  }

  addReminder(id, opts) {
    const task = this.store.findTask(id);
    if (!task) throw new Error(`No task with id ${id}.`);
    const r = { id: rid(), repeat: 'none', note: opts.note || '', active: true, createdAt: nowIso() };
    this._schedule(r, task, { ...opts, at: opts.at === undefined && (opts.minutes_before_due === undefined || opts.minutes_before_due === null) ? null : opts.at });
    task.reminders = task.reminders || [];
    task.reminders.push(r);
    task.updatedAt = nowIso();
    this._changed();
    return { task, reminder: r };
  }

  // A reminder not tied to a task ("Call the vendor at 4 pm").
  addStandaloneReminder({ title, at, repeat, note }) {
    const t = String(title || '').trim();
    if (!t) throw new Error('A reminder needs something to remind you about.');
    const r = { id: rid(), title: t, repeat: 'none', note: note || '', active: true, createdAt: nowIso() };
    this._schedule(r, null, { at: at === undefined ? null : at, repeat });
    this.standalone.push(r);
    this._changed();
    return { task: null, reminder: r };
  }

  findReminder(reminderId) {
    for (const t of this.tasks) {
      const r = (t.reminders || []).find((x) => x.id === reminderId);
      if (r) return { r, task: t };
    }
    const r = this.standalone.find((x) => x.id === reminderId);
    return r ? { r, task: null } : null;
  }

  // Edit any reminder: title (standalone), note, time, repeat, on/off, or move it to/from a task.
  updateReminder(reminderId, fields = {}) {
    const found = this.findReminder(reminderId);
    if (!found) throw new Error('Reminder not found.');
    const { r } = found;
    let { task } = found;
    const draft = { ...r };
    // Move between a task and standalone
    if (fields.taskId !== undefined && (fields.taskId || null) !== (task ? task.id : null)) {
      const target = fields.taskId ? this.store.findTask(fields.taskId) : null;
      if (fields.taskId && !target) throw new Error(`No task with id ${fields.taskId}.`);
      if (!target) draft.title = String(fields.title || r.title || task.title).trim();
      else delete draft.title;
      if (draft.kind === 'before_due' && !target) { draft.kind = 'at'; delete draft.offsetMinutes; }
      task = target;
    }
    if (fields.title !== undefined && !task) {
      const t = String(fields.title).trim();
      if (!t) throw new Error('A reminder needs something to remind you about.');
      draft.title = t;
    }
    if (fields.note !== undefined) draft.note = String(fields.note || '');
    if (fields.active !== undefined && !!fields.active !== !!r.active) {
      draft.active = !!fields.active;
      if (draft.active) { delete draft.pausedAt; delete draft.firedAt; } // paused ones are kept; fired ones get cleaned up
      else draft.pausedAt = nowIso();
    }
    // Giving an already-fired one-off a new time schedules it again.
    if (fields.active === undefined && draft.firedAt && !draft.active && fields.at) { draft.active = true; delete draft.firedAt; }
    const timing = {};
    if (fields.at !== undefined && fields.at !== null && fields.at !== '') timing.at = fields.at;
    if (fields.minutes_before_due !== undefined && fields.minutes_before_due !== null) timing.minutes_before_due = fields.minutes_before_due;
    if (fields.repeat !== undefined) timing.repeat = fields.repeat;
    if (draft.kind === 'before_due' && task && timing.at === undefined && timing.minutes_before_due === undefined) {
      timing.minutes_before_due = draft.offsetMinutes; // keep following the due date
    }
    this._schedule(draft, task, timing); // validates; throws without touching r
    // Commit: replace in place, or move to the new container
    const from = found.task ? found.task.reminders : this.standalone;
    const to = task ? (task.reminders = task.reminders || []) : this.standalone;
    for (const k of Object.keys(r)) delete r[k];
    Object.assign(r, draft);
    if (from !== to) { from.splice(from.indexOf(r), 1); to.push(r); }
    if (task) task.updatedAt = nowIso();
    this._changed();
    return { task, reminder: r };
  }

  deleteReminder(reminderId) {
    const found = this.findReminder(reminderId);
    if (!found) throw new Error('Reminder not found.');
    const list = found.task ? found.task.reminders : this.standalone;
    list.splice(list.indexOf(found.r), 1);
    this._changed();
    return found;
  }

  // "Remind me again in N minutes" for any reminder (adds a one-off; the original keeps its schedule).
  snoozeReminder(reminderId, minutes) {
    const found = this.findReminder(reminderId);
    if (!found) return null;
    if (found.task) return this.snooze(found.task.id, minutes);
    const at = new Date(Date.now() + minutes * 60000).toISOString();
    this.standalone.push({ id: rid(), kind: 'at', title: found.r.title, repeat: 'none', note: 'Snoozed', active: true, nextAt: at, snooze: true, createdAt: nowIso() });
    this._changed();
    return found.r;
  }

  removeReminder(id, reminderId) {
    const task = this.store.findTask(id);
    if (!task) throw new Error(`No task with id ${id}.`);
    const before = (task.reminders || []).length;
    task.reminders = (task.reminders || []).filter((r) => r.id !== reminderId);
    if (task.reminders.length === before) throw new Error('Reminder not found.');
    this._changed();
    return task;
  }

  snooze(id, minutes) {
    const task = this.store.findTask(id);
    if (!task) return null;
    const at = new Date(Date.now() + minutes * 60000).toISOString();
    task.reminders = task.reminders || [];
    task.reminders.push({ id: rid(), kind: 'at', repeat: 'none', note: 'Snoozed', active: true, nextAt: at, snooze: true, createdAt: nowIso() });
    this._changed();
    return task;
  }

  _recomputeRelative(task) {
    for (const r of task.reminders || []) {
      if (r.kind !== 'before_due') continue;
      if (!task.due) { r.active = false; continue; }
      r.active = true;
      r.nextAt = new Date(new Date(task.due).getTime() - r.offsetMinutes * 60000).toISOString();
      if (r.repeat !== 'none') r.nextAt = advanceUntilFuture(r.nextAt, r.repeat, true);
    }
  }
}

function clampPct(n) {
  if (isNaN(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function fmt(iso) {
  if (!iso) return 'none';
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function stepRepeat(date, repeat) {
  const d = new Date(date);
  switch (repeat) {
    case 'hourly': d.setHours(d.getHours() + 1); break;
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'weekdays':
      do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
      break;
    default: return null;
  }
  return d;
}

// Move a repeating reminder forward to its next occurrence after now.
// inclusive=true keeps a time that is still in the future as-is.
function advanceUntilFuture(iso, repeat, inclusive) {
  let d = new Date(iso);
  const now = Date.now();
  if (inclusive && d.getTime() > now) {
    if (repeat === 'weekdays') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  let guard = 0;
  while (d.getTime() <= now && guard++ < 5000) {
    const n = stepRepeat(d, repeat);
    if (!n) break;
    d = n;
  }
  return d.toISOString();
}

module.exports = { TaskService, PRIORITIES, STATUSES, REPEATS, advanceUntilFuture, fmt };
