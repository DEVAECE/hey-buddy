// Instant answers for common, unambiguous requests, straight from local data with no AI round trip.
// Deliberately narrow: only whole-message matches; anything else goes to the AI as usual.
const { fmt } = require('./tasks');

const DAY = 86400000;
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfWeek = (ms) => { const d = new Date(startOfDay(ms)); const day = d.getDay(); return d.getTime() + ((7 - day) % 7 + 1) * DAY; }; // through Sunday
const PRI = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const byDue = (a, b) => (a.due || '9').localeCompare(b.due || '9') || PRI[a.priority] - PRI[b.priority];

function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/[’']/g, "'").replace(/[?.!,]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(hey |hi |ok |okay )?buddy /, '').replace(/^(please |can you |could you )/, '').replace(/ please$/, '').trim();
}

const item = (t) => `${t.id} ${t.title}${t.due ? ` (${fmt(t.due)})` : ''}`;
const list = (ts) => (ts.length <= 2 ? ts.map(item).join(' and ') : `\n${ts.map((t) => `- ${item(t)}`).join('\n')}`);

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, half: 0.5, 'half an': 0.5 };
function minutesFrom(n, unit) {
  const v = Number(n) || WORDS[n] || 0;
  if (!v) return undefined;
  return /^h/.test(unit) ? Math.round(v * 60) : Math.round(v);
}

/**
 * @param {string} text the user's message
 * @param {{tasks: object[], now?: number, focus: (action: string, minutes?: number) => string, markDone: (id: string) => object}} ctx
 * @returns {string|null} the reply, or null to let the AI handle it
 */
function quickReply(text, ctx) {
  const q = normalize(text);
  if (!q || q.length > 60) return null;
  const now = ctx.now || Date.now();
  const open = ctx.tasks.filter((t) => t.status !== 'Done');
  const overdue = open.filter((t) => t.due && Date.parse(t.due) < now).sort(byDue);

  // Focus mode
  let m = /^(?:start |go to |go into |enter |turn on |switch to |begin )?focus(?: mode)?(?: on)?(?: for (\d+|an|a|one|two|three|half an) ?(minutes?|mins?|m|hours?|hrs?|h))?$/.exec(q);
  if (m) return ctx.focus('start', m[1] ? minutesFrom(m[1], m[2]) : undefined);
  if (/^(?:stop|end|exit|cancel|turn off|quit|finish) (?:the )?focus(?: mode)?$|^focus(?: mode)? off$/.test(q)) return ctx.focus('stop');

  // "T-3 done" / "mark T-3 as done"
  m = /^(?:mark )?t ?-? ?(\d+)(?: is)? (?:as )?(?:done|complete|completed|finished)$/.exec(q);
  if (m) {
    const id = `T-${m[1]}`;
    const t = ctx.tasks.find((x) => x.id === id);
    if (!t) return `I couldn't find ${id}. Check the task number on the board.`;
    if (t.status === 'Done') return `${id} "${t.title}" is already done.`;
    ctx.markDone(id);
    return `Nice work! Marked ${id} "${t.title}" as done.`;
  }

  // What's due today / tomorrow / this week
  m = /^(?:what(?:'s| is| are)? |what do i have |anything |show (?:me )?)?(?:(?:is |are )?(?:anything |my |things |tasks |my tasks )?(?:due|pending|on) )?(?:for )?(today|tomorrow|this week)$/.exec(q);
  if (m && /due|pending|have|on |today|tomorrow|week/.test(q)) {
    const span = m[1];
    const from = span === 'tomorrow' ? startOfDay(now) + DAY : now;
    const to = span === 'today' ? startOfDay(now) + DAY : span === 'tomorrow' ? startOfDay(now) + 2 * DAY : endOfWeek(now);
    const due = open.filter((t) => t.due && Date.parse(t.due) >= from && Date.parse(t.due) < to).sort(byDue);
    const when = span === 'this week' ? 'this week' : span;
    const parts = [due.length ? `Due ${when}: ${list(due)}` : `Nothing is due ${when}.`];
    if (overdue.length && span !== 'tomorrow') parts.push(`${due.length ? '\n' : ' '}Also overdue: ${list(overdue)}`);
    return parts.join('').trim();
  }

  // Overdue
  if (/^(?:what(?:'s| is| are)? |anything |show (?:me )?)?(?:my )?(?:overdue|late)(?: tasks)?$/.test(q)) {
    return overdue.length ? `Overdue: ${list(overdue)}` : 'Nothing is overdue. Nice!';
  }

  // Reminders: "what are my reminders", "reminders today", "any reminders this week"
  m = /^(?:what are |what's |show (?:me )?|list |any )?(?:my |the )?(?:upcoming )?reminders?(?: (?:for |do i have )?(today|tomorrow|this week))?$|^what (?:are my|reminders do i have) ?(today|tomorrow|this week)?$/.exec(q);
  if (m && /reminder/.test(q)) {
    const span = m[1] || m[2] || '';
    const to = span === 'today' ? startOfDay(now) + DAY : span === 'tomorrow' ? startOfDay(now) + 2 * DAY : span === 'this week' ? endOfWeek(now) : Infinity;
    const from = span === 'tomorrow' ? startOfDay(now) + DAY : now;
    const all = [
      ...ctx.tasks.filter((t) => t.status !== 'Done').flatMap((t) => (t.reminders || []).map((r) => ({ r, label: `${t.id} ${t.title}` }))),
      ...(ctx.reminders || []).map((r) => ({ r, label: r.title })),
    ].filter(({ r }) => r.active && r.nextAt && Date.parse(r.nextAt) >= from && Date.parse(r.nextAt) < to)
      .sort((a, b) => a.r.nextAt.localeCompare(b.r.nextAt));
    const when = span ? ` ${span}` : ' coming up';
    if (!all.length) return `No reminders${when}.`;
    const lines = all.slice(0, 8).map(({ r, label }) => `${label} (${fmt(r.nextAt)}${r.repeat !== 'none' ? `, ${r.repeat}` : ''})`);
    return `Reminders${when}: ${lines.length <= 2 ? lines.join(' and ') : `\n${lines.map((l) => `- ${l}`).join('\n')}`}${all.length > 8 ? `\n…and ${all.length - 8} more in the Reminders tab.` : ''}`;
  }

  // Blockers
  if (/^(?:what am i|what's|what is|what are|am i) (?:blocked|stuck)(?: on)?$|^(?:show (?:me )?)?(?:my )?blockers$/.test(q)) {
    const blocked = open.filter((t) => t.status === 'Blocked');
    if (!blocked.length) return 'You\'re not blocked on anything right now.';
    return `Blocked: ${blocked.map((t) => {
      const b = [...(t.log || [])].reverse().find((e) => e.type === 'blocker');
      return `\n- ${t.id} ${t.title}${b ? `: ${b.text}` : ''}`;
    }).join('')}`;
  }
  return null;
}

module.exports = { quickReply, normalize };
