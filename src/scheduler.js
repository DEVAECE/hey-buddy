// Background clock. Runs in the main process, so it keeps working while the
// window is hidden in the tray. Missed reminders (PC asleep/off) fire once on wake.
// Also drives the companion's triggers: focus check-ins, water/stretch breaks,
// end-of-day wrap-up and the welcome-back catch-up.
const { advanceUntilFuture, fmt } = require('./tasks');
const { startOfDay } = require('./reports');

const MIN = 60000;
const HOUR = 60 * MIN;
const TRIGGER_GAP = 10 * MIN; // never stack companion triggers closer than this

function atTime(now, hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const d = new Date(now); d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}
function isWorkday(now, s) {
  const day = new Date(now).getDay();
  return !s.workWeekdaysOnly || (day !== 0 && day !== 6);
}
function inWorkHours(now, s) {
  return isWorkday(now, s) && now >= atTime(now, s.workStart) && now < atTime(now, s.workEnd);
}
function duration(ms) {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); const r = m % 60;
  return `${h} hour${h > 1 ? 's' : ''}${r ? ` ${r} min` : ''}`;
}
const PRI = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const byUrgency = (a, b) => (a.due || '9').localeCompare(b.due || '9') || PRI[a.priority] - PRI[b.priority];

class Scheduler {
  constructor({ store, onAlerts, onBriefing, onTrigger, isUserActive }) {
    this.store = store;
    this.onAlerts = onAlerts;
    this.onBriefing = onBriefing;
    this.onTrigger = onTrigger || (() => {});
    this.isUserActive = isUserActive || (() => true);
    this.timer = null;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 20000);
  }

  stop() { clearInterval(this.timer); }

  get meta() { return this.store.data.meta; }
  get settings() { return this.store.data.settings; }
  _name() { return this.settings.userName ? `, ${this.settings.userName}` : ''; }

  tick(now = Date.now()) {
    const s = this.settings;
    const alerts = [];
    let dirty = false;

    for (const t of this.store.data.tasks) {
      if (t.status === 'Done') continue;
      for (const r of t.reminders || []) {
        if (!r.active || !r.nextAt) continue;
        const at = new Date(r.nextAt).getTime();
        if (at > now) continue;
        const late = now - at > 5 * MIN;
        alerts.push({
          kind: 'reminder', taskId: t.id, reminderId: r.id, title: t.title, priority: t.priority, status: t.status,
          due: t.due, note: r.note, late, scheduledFor: r.nextAt,
        });
        this._advance(r, now);
        dirty = true;
      }
      // Due-time alert (once), if no reminder already fired for this moment
      if (s.dueTimeAlerts && t.due && !t.dueAlerted && new Date(t.due).getTime() <= now) {
        t.dueAlerted = true;
        dirty = true;
        if (!alerts.some((a) => a.taskId === t.id)) {
          alerts.push({ kind: 'due', taskId: t.id, title: t.title, priority: t.priority, status: t.status, due: t.due, late: now - new Date(t.due).getTime() > 10 * MIN });
        }
      }
    }

    // Standalone reminders (not tied to a task)
    for (const r of this.store.data.reminders || []) {
      if (!r.active || !r.nextAt) continue;
      const at = new Date(r.nextAt).getTime();
      if (at > now) continue;
      alerts.push({ kind: 'reminder', taskId: null, reminderId: r.id, title: r.title, note: r.note, late: now - at > 5 * MIN, scheduledFor: r.nextAt, repeat: r.repeat });
      this._advance(r, now);
      dirty = true;
    }

    // Clean up reminders that already fired (one-offs) more than 7 days ago; paused ones stay.
    const spent = (r) => !r.active && !r.pausedAt && (now - new Date(r.nextAt).getTime()) >= 7 * 86400000;
    for (const t of this.store.data.tasks) {
      const before = (t.reminders || []).length;
      t.reminders = (t.reminders || []).filter((r) => !spent(r));
      if (t.reminders.length !== before) dirty = true;
    }
    if (Array.isArray(this.store.data.reminders)) {
      const before = this.store.data.reminders.length;
      this.store.data.reminders = this.store.data.reminders.filter((r) => !spent(r));
      if (this.store.data.reminders.length !== before) dirty = true;
    }

    if (dirty) this.store.save();
    this._maybeFocusEnd(now);
    if (alerts.length) {
      this.meta.lastTrigger = now;
      this.onAlerts(alerts);
    }
    if (this._maybeBriefing(now) || alerts.length) return;
    this._maybeTriggers(now);
  }

  // After a reminder fires: repeating ones move to the next occurrence, one-offs switch off.
  _advance(r, now) {
    if (r.repeat && r.repeat !== 'none') r.nextAt = advanceUntilFuture(r.nextAt, r.repeat, false);
    else { r.active = false; r.firedAt = new Date(now).toISOString(); }
  }

  _maybeBriefing(now) {
    const s = this.settings;
    if (!s.briefingEnabled) return false;
    const d = new Date(now);
    if (s.briefingWeekdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) return false;
    const todayKey = d.toDateString();
    if (this.meta.lastBriefing === todayKey) return false;
    if (now < atTime(now, s.briefingTime || '09:00')) return false;
    this.meta.lastBriefing = todayKey;
    this.meta.lastTrigger = now;
    this.store.save();
    this.onBriefing(this.buildBriefing(now));
    return true;
  }

  _maybeTriggers(now) {
    const s = this.settings;
    const m = this.meta;
    if (now < (m.quietUntil || 0)) return;
    if (now - (m.lastTrigger || 0) < TRIGGER_GAP) return;
    if (!this.isUserActive()) return;

    // End-of-day wrap-up: once a workday, within 3 hours of the set time
    const todayKey = new Date(now).toDateString();
    if (s.wrapupEnabled && isWorkday(now, s) && m.lastWrapup !== todayKey) {
      const t = atTime(now, s.wrapupTime || '18:00');
      if (now >= t && now < t + 3 * HOUR) {
        m.lastWrapup = todayKey;
        return this._fire(now, {
          kind: 'wrapup',
          text: `Wrapping up for today${this._name()}? Tell me what you got done and anything that's blocked, and I'll log it for your stand-up.`,
        });
      }
    }

    if (!inWorkHours(now, s)) return;
    const dayStart = atTime(now, s.workStart);

    const checkin = Number(s.checkinMinutes) || 0;
    if (checkin > 0 && now - Math.max(m.lastCheckin || 0, dayStart) >= checkin * MIN) {
      m.lastCheckin = now;
      const focus = this.store.data.tasks.filter((t) => t.status === 'In progress').sort(byUrgency)[0];
      return this._fire(now, {
        kind: 'checkin',
        taskId: focus?.id,
        text: `Quick check-in${this._name()}: how's it going? Any progress or blockers${focus ? ` on ${focus.id} "${focus.title}"` : ''}?`,
      });
    }

    const brk = Number(s.breakMinutes) || 0;
    if (brk > 0 && now - Math.max(m.lastBreak || 0, dayStart) >= brk * MIN) {
      m.lastBreak = now;
      let kind = s.breakKind === 'water' || s.breakKind === 'stretch' ? s.breakKind : (m.nextBreakKind || 'water');
      if (s.breakKind === 'both' || !s.breakKind) m.nextBreakKind = kind === 'water' ? 'stretch' : 'water';
      if (kind !== 'stretch') kind = 'water';
      return this._fire(now, {
        kind: kind === 'water' ? 'water' : 'stretch',
        count: this.waterCount(now),
        text: kind === 'water'
          ? `Time for a glass of water${this._name()}.`
          : `Time to stand up and stretch for a minute${this._name()}. Roll your shoulders, look away from the screen.`,
      });
    }
  }

  // ---------- focus mode ----------
  // A focus session pauses check-ins and breaks (via quietUntil); reminders still come through.
  startFocus(minutes, now = Date.now()) {
    const m = Math.max(5, Math.min(240, Math.round(Number(minutes) || Number(this.settings.focusMinutes) || 50)));
    this.meta.focusUntil = now + m * MIN;
    this.meta.focusMinutes = m;
    this.meta.quietUntil = this.meta.focusUntil;
    this.store.save();
    return { until: this.meta.focusUntil, minutes: m };
  }

  stopFocus(now = Date.now()) {
    const was = this.meta.focusUntil > now;
    const elapsed = was ? Math.round((now - (this.meta.focusUntil - this.meta.focusMinutes * MIN)) / MIN) : 0;
    this.meta.focusUntil = 0;
    if (this.meta.quietUntil > now) this.meta.quietUntil = 0;
    this.store.save();
    return { wasOn: was, elapsed };
  }

  _maybeFocusEnd(now) {
    const m = this.meta;
    if (!m.focusUntil || now < m.focusUntil) return;
    const mins = m.focusMinutes || 0;
    m.focusUntil = 0;
    // The session ended: let a break come soon after, not a check-in straight away.
    m.lastCheckin = now;
    this._fire(now, {
      kind: 'focusEnd',
      minutes: mins,
      text: `Focus session done${this._name()}! ${mins} minutes of deep work. Time for a short break: stand up, drink some water.`,
    });
  }

  _fire(now, trigger) {
    this.meta.lastTrigger = now;
    this.store.save();
    this.onTrigger(trigger);
  }

  // Push a check-in/break back so it comes again in `minutes`.
  snoozeTrigger(kind, minutes, now = Date.now()) {
    const s = this.settings;
    if (kind === 'checkin') this.meta.lastCheckin = now - Math.max(0, (Number(s.checkinMinutes) || 0) - minutes) * MIN;
    if (kind === 'water' || kind === 'stretch') {
      this.meta.lastBreak = now - Math.max(0, (Number(s.breakMinutes) || 0) - minutes) * MIN;
      if (s.breakKind === 'both') this.meta.nextBreakKind = kind; // same break comes back
    }
    this.meta.lastTrigger = now - TRIGGER_GAP; // allow it to fire on time
    this.store.save();
  }

  waterCount(now = Date.now()) {
    const w = this.meta.water || {};
    return w.day === new Date(now).toDateString() ? w.count : 0;
  }

  drankWater(now = Date.now()) {
    const count = this.waterCount(now) + 1;
    this.meta.water = { day: new Date(now).toDateString(), count };
    this.store.save();
    return count;
  }

  buildWelcomeBack(awayMs, now = Date.now()) {
    const open = this.store.data.tasks.filter((t) => t.status !== 'Done');
    const overdue = open.filter((t) => t.due && new Date(t.due).getTime() < now);
    const soon = open.filter((t) => t.due && new Date(t.due).getTime() >= now && new Date(t.due).getTime() < now + 3 * HOUR).sort(byUrgency);
    const blocked = open.filter((t) => t.status === 'Blocked');
    const parts = [`Welcome back${this._name()}! You were away ${duration(awayMs)}.`];
    if (soon.length) parts.push(`Coming up: ${soon.slice(0, 3).map((t) => `${t.id} ${t.title} (${fmt(t.due)})`).join('; ')}.`);
    if (overdue.length) parts.push(`${overdue.length} task${overdue.length > 1 ? 's are' : ' is'} overdue.`);
    if (blocked.length) parts.push(`${blocked.length} blocked.`);
    if (parts.length === 1) parts.push('Nothing urgent came up.');
    return { kind: 'welcome', text: parts.join(' '), urgent: soon.length + overdue.length > 0 };
  }

  buildBriefing(nowMs = Date.now()) {
    const now = new Date(nowMs);
    const end = new Date(startOfDay(now).getTime() + 86400000);
    const open = this.store.data.tasks.filter((t) => t.status !== 'Done');
    const overdue = open.filter((t) => t.due && new Date(t.due) < now);
    const today = open.filter((t) => t.due && new Date(t.due) >= now && new Date(t.due) < end);
    const blocked = open.filter((t) => t.status === 'Blocked');
    const focus = [...overdue, ...today, ...open.filter((t) => t.priority === 'Critical' || t.priority === 'High')]
      .filter((t, i, a) => a.indexOf(t) === i)
      .sort(byUrgency)
      .slice(0, 5);

    const h = now.getHours();
    const day = now.getDay();
    const moods = this.settings.moodsEnabled !== false;
    const hello = moods && day === 1 ? 'Happy Monday' : moods && day === 5 ? 'Happy Friday' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const parts = [`${hello}${this._name()}.${moods && day === 1 ? ' New week, let\'s get focused.' : moods && day === 5 ? ' Let\'s finish the week strong.' : ''}`];
    if (!open.length) parts.push('Your list is clear. Tell me what you\'re working on today.');
    else {
      const counts = [];
      if (overdue.length) counts.push(`${overdue.length} overdue`);
      if (today.length) counts.push(`${today.length} due today`);
      if (blocked.length) counts.push(`${blocked.length} blocked`);
      parts.push(counts.length ? `You have ${counts.join(', ')}.` : `You have ${open.length} open task${open.length > 1 ? 's' : ''} and nothing due today.`);
      if (focus.length) parts.push('Suggested focus: ' + focus.map((t) => `${t.id} ${t.title}${t.due ? ` (due ${fmt(t.due)})` : ''}`).join('; ') + '.');
    }
    return { text: parts.join(' '), overdue: overdue.length, today: today.length, blocked: blocked.length, focus: focus.map((t) => ({ taskId: t.id, title: t.title, due: t.due, priority: t.priority })) };
  }
}

module.exports = { Scheduler, inWorkHours, atTime };
