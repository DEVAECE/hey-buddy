// Gathers the facts for daily/weekly reports from the task activity log.
// buildFallback() produces a plain report without AI (used if the AI is unreachable).

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function previousWorkday(now) {
  const d = startOfDay(now);
  do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

function startOfWeek(now) {
  const d = startOfDay(now);
  const day = d.getDay(); // 0 Sun
  const diff = day === 0 ? 6 : day - 1; // week starts Monday
  d.setDate(d.getDate() - diff);
  return d;
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function gather(tasks, type, now = new Date()) {
  const since = type === 'daily' ? previousWorkday(now) : startOfWeek(now);
  const todayEnd = new Date(startOfDay(now).getTime() + 86400000);
  const weekAhead = new Date(startOfDay(now).getTime() + 8 * 86400000);
  const inRange = (iso) => iso && new Date(iso) >= since;

  const completed = tasks.filter((t) => t.status === 'Done' && inRange(t.completedAt));
  const active = tasks.filter((t) => t.status !== 'Done');
  const activity = [];
  for (const t of tasks) {
    for (const e of t.log || []) {
      if (inRange(e.at)) activity.push({ task: t.id, title: t.title, at: e.at, type: e.type, text: e.text });
    }
  }
  activity.sort((a, b) => a.at.localeCompare(b.at));
  const blocked = active.filter((t) => t.status === 'Blocked').map((t) => ({
    ...pick(t),
    blocker: [...(t.log || [])].reverse().find((e) => e.type === 'blocker')?.text || '',
  }));
  const overdue = active.filter((t) => t.due && new Date(t.due) < now).map(pick);
  const dueToday = active.filter((t) => t.due && new Date(t.due) >= now && new Date(t.due) < todayEnd).map(pick);
  const upcoming = active.filter((t) => t.due && new Date(t.due) >= todayEnd && new Date(t.due) < weekAhead).map(pick);
  const inProgress = active.filter((t) => t.status === 'In progress').map(pick);
  const newTasks = tasks.filter((t) => inRange(t.createdAt)).map(pick);

  return {
    type, since: since.toISOString(), now: now.toISOString(),
    completed: completed.map(pick), inProgress, blocked, overdue, dueToday, upcoming, newTasks, activity,
  };
}

function pick(t) {
  return {
    id: t.id, title: t.title, status: t.status, priority: t.priority,
    progress: t.progress, due: t.due, assignedBy: t.assignedBy,
  };
}

const PRI = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const byPri = (a, b) => (PRI[a.priority] - PRI[b.priority]) || ((a.due || '9') .localeCompare(b.due || '9'));

function line(t) {
  const bits = [];
  if (t.progress !== null && t.progress !== undefined && t.status !== 'Done') bits.push(`${t.progress}%`);
  if (t.due) bits.push(`due ${shortDate(t.due)}`);
  if (t.priority === 'Critical' || t.priority === 'High') bits.push(t.priority.toLowerCase() + ' priority');
  return `- ${t.title}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

function buildFallback(facts, settings) {
  const name = settings.userName ? ` from ${settings.userName}` : '';
  const out = [];
  if (facts.type === 'daily') {
    out.push(`Daily update${name} - ${shortDate(facts.now)}`, '');
    out.push('Done since last update:');
    const doneLines = facts.completed.map(line);
    const progLines = facts.activity.filter((a) => a.type === 'progress' || a.type === 'note').map((a) => `- ${a.title}: ${a.text}`);
    out.push(...(doneLines.length || progLines.length ? [...doneLines, ...progLines] : ['- No completed items logged']));
    out.push('', 'Today:');
    const today = [...facts.overdue, ...facts.dueToday, ...facts.inProgress]
      .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i).sort(byPri);
    out.push(...(today.length ? today.map(line) : ['- Picking up next priorities']));
    out.push('', 'Blockers:');
    out.push(...(facts.blocked.length ? facts.blocked.map((b) => `- ${b.title}: ${b.blocker || 'blocked'}`) : ['- None']));
  } else {
    out.push(`Weekly summary${name} - week of ${shortDate(facts.since)}`, '');
    out.push('Completed:');
    out.push(...(facts.completed.length ? facts.completed.map(line) : ['- None this week']));
    out.push('', 'In progress:');
    out.push(...(facts.inProgress.length ? facts.inProgress.sort(byPri).map(line) : ['- None']));
    out.push('', 'Coming up:');
    out.push(...(facts.upcoming.length || facts.dueToday.length ? [...facts.dueToday, ...facts.upcoming].sort(byPri).map(line) : ['- Nothing due in the next week']));
    out.push('', 'Risks and blockers:');
    const risks = [
      ...facts.blocked.map((b) => `- ${b.title}: ${b.blocker || 'blocked'}`),
      ...facts.overdue.map((t) => `- ${t.title} is overdue (was due ${shortDate(t.due)})`),
    ];
    out.push(...(risks.length ? risks : ['- None']));
    if (facts.newTasks.length) {
      out.push('', 'New this week:');
      out.push(...facts.newTasks.map((t) => `- ${t.title}${t.assignedBy ? ` (from ${t.assignedBy})` : ''}`));
    }
  }
  return out.join('\n');
}

module.exports = { gather, buildFallback, startOfDay };
