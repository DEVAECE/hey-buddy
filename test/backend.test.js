// Backend tests for Buddy (src/): tasks, reminders, scheduler, triggers, reports, AI connections,
// instant answers and sign-in scripts. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.BUDDY_ROOT || path.resolve(__dirname, '..');
const { Store } = require(path.join(ROOT, 'src/store'));
const { TaskService, advanceUntilFuture } = require(path.join(ROOT, 'src/tasks'));
const { Scheduler } = require(path.join(ROOT, 'src/scheduler'));
const { gather, buildFallback } = require(path.join(ROOT, 'src/reports'));
const { AI } = require(path.join(ROOT, 'src/ai'));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-test-'));
const H = 3600000;
function setup() {
  const store = new Store(tmpDir());
  let changes = 0;
  const ts = new TaskService(store, () => { changes++; });
  return { store, ts, changes: () => changes };
}

// ---------------- Store ----------------
test('store: fresh store has defaults and round-trips to disk', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  assert.equal(s.data.settings.model, 'claude-sonnet-5-5');
  assert.equal(s.newTaskId(), 'T-1');
  s.data.tasks.push({ id: 'T-1', title: 'x' });
  s.saveNow();
  const s2 = new Store(dir);
  assert.equal(s2.data.tasks.length, 1);
  assert.equal(s2.data.meta.nextId, 2);
});

test('store: corrupt main file falls back to backup', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  s.data.tasks.push({ id: 'T-1', title: 'first' }); s.saveNow();
  s.data.tasks.push({ id: 'T-2', title: 'second' }); s.saveNow(); // backup now has 1 task
  fs.writeFileSync(path.join(dir, 'buddy-data.json'), '{broken');
  const s2 = new Store(dir);
  assert.equal(s2.data.tasks.length, 1);
});

test('store: migrate fills missing settings/meta', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'buddy-data.json'), JSON.stringify({ tasks: [{ id: 'T-1' }], settings: { userName: 'D' } }));
  const s = new Store(dir);
  assert.equal(s.data.settings.userName, 'D');
  assert.equal(s.data.settings.briefingTime, '09:00');
  assert.equal(s.data.meta.nextId, 1);
  assert.deepEqual(s.data.chat, []);
});

test('store: findTask normalises spoken ids', () => {
  const { store, ts } = setup();
  ts.create({ title: 'a' });
  for (const q of ['T-1', 't-1', 't1', 'T 1', ' t - 1 ']) assert.ok(store.findTask(q), q);
  assert.equal(store.findTask('T-9'), null);
});

// ---------------- Tasks ----------------
test('tasks: create validates and normalises', () => {
  const { ts, changes } = setup();
  assert.throws(() => ts.create({ title: '  ' }), /title/);
  assert.throws(() => ts.create({ title: 'x', due: 'whenever' }), /due date/);
  const t = ts.create({ title: 'Audit', priority: 'high', status: 'wip', assigned_by: 'Priya', due: '2030-01-01T10:00:00Z' });
  assert.equal(t.id, 'T-1');
  assert.equal(t.priority, 'High');
  assert.equal(t.status, 'In progress');
  assert.equal(t.assignedBy, 'Priya');
  assert.equal(t.log[0].type, 'created');
  assert.ok(changes() >= 1);
});

test('tasks: update logs changes, Done sets completedAt/100%', () => {
  const { ts } = setup();
  const t = ts.create({ title: 'A' });
  ts.update('T-1', { priority: 'Critical', status: 'done' });
  assert.equal(t.priority, 'Critical');
  assert.equal(t.status, 'Done');
  assert.equal(t.progress, 100);
  assert.ok(t.completedAt);
  assert.match(t.log.at(-1).text, /Priority Medium → Critical; Status Not started → Done/);
  ts.update('T-1', { status: 'In progress' });
  assert.equal(t.completedAt, null);
  assert.throws(() => ts.update('T-1', { priority: 'urgent' }), /Priority must be/);
  assert.throws(() => ts.update('T-1', { status: 'meh' }), /Status must be/);
  assert.throws(() => ts.update('T-99', {}), /No task/);
  ts.update('T-1', { progress: 150 });
  assert.equal(t.progress, 100);
});

test('tasks: blockers and progress drive status', () => {
  const { ts } = setup();
  const t = ts.create({ title: 'Migration' });
  ts.logUpdate('T-1', 'progress', 'Schema drafted', 30);
  assert.equal(t.status, 'In progress');
  assert.equal(t.progress, 30);
  assert.match(t.log.at(-1).text, /\(30%\)/);
  ts.logUpdate('T-1', 'blocker', 'Waiting for DB access');
  assert.equal(t.status, 'Blocked');
  ts.logUpdate('T-1', 'blocker_resolved', '');
  assert.equal(t.status, 'In progress');
  assert.equal(t.log.at(-1).text, 'Blocker resolved');
  ts.logUpdate('T-1', 'garbage-kind', 'hello');
  assert.equal(t.log.at(-1).type, 'note');
});

test('tasks: remove', () => {
  const { ts, store } = setup();
  ts.create({ title: 'a' }); ts.create({ title: 'b' });
  ts.remove('t2');
  assert.deepEqual(store.data.tasks.map((t) => t.id), ['T-1']);
  assert.throws(() => ts.remove('T-2'), /No task/);
});

test('reminders: at / before_due / past / repeating / due change', () => {
  const { ts } = setup();
  const due = new Date(Date.now() + 5 * H).toISOString();
  const t = ts.create({ title: 'r', due });
  const { reminder: r1 } = ts.addReminder('T-1', { at: new Date(Date.now() + H).toISOString() });
  assert.equal(r1.kind, 'at');
  const { reminder: r2 } = ts.addReminder('T-1', { minutes_before_due: 60 });
  assert.equal(new Date(r2.nextAt).getTime(), new Date(due).getTime() - H);
  assert.throws(() => ts.addReminder('T-1', { at: new Date(Date.now() - 2 * H).toISOString() }), /in the past/);
  assert.throws(() => ts.addReminder('T-1', {}), /needs a time/);
  const { reminder: r3 } = ts.addReminder('T-1', { at: new Date(Date.now() - 2 * H).toISOString(), repeat: 'daily' });
  assert.ok(new Date(r3.nextAt) > new Date(), 'repeating reminder advanced to future');

  const newDue = new Date(Date.now() + 10 * H).toISOString();
  ts.update('T-1', { due: newDue });
  assert.equal(new Date(r2.nextAt).getTime(), new Date(newDue).getTime() - H, 'before_due follows due date');
  ts.update('T-1', { due: null });
  assert.equal(r2.active, false);

  const t2 = ts.create({ title: 'no due' });
  assert.throws(() => ts.addReminder(t2.id, { minutes_before_due: 30 }), /no due date/);
  ts.removeReminder('T-1', r1.id);
  assert.ok(!t.reminders.some((r) => r.id === r1.id));
  assert.throws(() => ts.removeReminder('T-1', 'nope'), /not found/);
});

test('advanceUntilFuture: weekdays skips weekends', () => {
  const sat = new Date(); sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7) + 7); sat.setHours(9, 0, 0, 0);
  const d = new Date(advanceUntilFuture(sat.toISOString(), 'weekdays', true));
  assert.equal(d.getDay(), 1);
  const past = new Date(Date.now() - 3 * 86400000).toISOString();
  const n = new Date(advanceUntilFuture(past, 'weekdays', false));
  assert.ok(n > new Date() && n.getDay() !== 0 && n.getDay() !== 6);
});

// ---------------- Scheduler ----------------
function sched(store) {
  const fired = { alerts: [], briefings: [] };
  const s = new Scheduler({ store, onAlerts: (a) => fired.alerts.push(...a), onBriefing: (b) => fired.briefings.push(b) });
  return { s, fired };
}

test('scheduler: fires due reminders once, repeats advance, Done tasks skipped', () => {
  const { store, ts } = setup();
  store.data.settings.briefingEnabled = false;
  const t1 = ts.create({ title: 'one-off' });
  const t2 = ts.create({ title: 'repeat' });
  const t3 = ts.create({ title: 'done one' });
  t1.reminders.push({ id: 'a', kind: 'at', repeat: 'none', active: true, nextAt: new Date(Date.now() - 1000).toISOString() });
  t2.reminders.push({ id: 'b', kind: 'at', repeat: 'hourly', active: true, nextAt: new Date(Date.now() - 2 * H).toISOString() });
  t3.reminders.push({ id: 'c', kind: 'at', repeat: 'none', active: true, nextAt: new Date(Date.now() - 1000).toISOString() });
  ts.update('T-3', { status: 'Done' });
  const { s, fired } = sched(store);
  s.tick();
  assert.deepEqual(fired.alerts.map((a) => a.taskId).sort(), ['T-1', 'T-2']);
  assert.equal(fired.alerts.find((a) => a.taskId === 'T-2').late, true);
  assert.equal(t1.reminders[0].active, false);
  assert.ok(new Date(t2.reminders[0].nextAt) > new Date());
  fired.alerts.length = 0;
  s.tick();
  assert.equal(fired.alerts.length, 0, 'nothing fires twice');
});

test('scheduler: due-time alert fires once and not alongside a reminder', () => {
  const { store, ts } = setup();
  store.data.settings.briefingEnabled = false;
  const t = ts.create({ title: 'due', due: new Date(Date.now() - 1000).toISOString() });
  const t2 = ts.create({ title: 'due+rem', due: new Date(Date.now() - 1000).toISOString() });
  t2.reminders.push({ id: 'x', kind: 'at', repeat: 'none', active: true, nextAt: new Date(Date.now() - 1000).toISOString() });
  const { s, fired } = sched(store);
  s.tick(); s.tick();
  assert.equal(fired.alerts.filter((a) => a.taskId === 'T-1' && a.kind === 'due').length, 1);
  assert.equal(fired.alerts.filter((a) => a.taskId === 'T-2').length, 1);
  assert.ok(t.dueAlerted && t2.dueAlerted);
});

test('scheduler: briefing once per day after configured time', () => {
  const { store, ts } = setup();
  ts.create({ title: 'Overdue thing', due: new Date(Date.now() - 2 * 86400000).toISOString(), priority: 'High' });
  store.data.settings.briefingWeekdaysOnly = false;
  store.data.settings.briefingTime = '00:00';
  store.data.settings.userName = 'Dev';
  const { s, fired } = sched(store);
  s.tick(); s.tick();
  assert.equal(fired.briefings.length, 1);
  assert.match(fired.briefings[0].text, /(Good (morning|afternoon|evening)|Happy (Monday|Friday)), Dev\.[^Y]*You have 1 overdue/);
  assert.match(fired.briefings[0].text, /T-1 Overdue thing/);
});

test('scheduler: briefing not before time', () => {
  const { store } = setup();
  store.data.settings.briefingWeekdaysOnly = false;
  store.data.settings.briefingTime = '23:59';
  const { s, fired } = sched(store);
  s._maybeBriefing(new Date().setHours(10, 0, 0, 0));
  assert.equal(fired.briefings.length, 0);
});

test('scheduler: spent one-off reminders cleaned after 7 days', () => {
  const { store, ts } = setup();
  store.data.settings.briefingEnabled = false;
  const t = ts.create({ title: 'x' });
  t.reminders.push({ id: 'old', active: false, nextAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  t.reminders.push({ id: 'new', active: false, nextAt: new Date(Date.now() - 1 * 86400000).toISOString() });
  sched(store).s.tick();
  assert.deepEqual(t.reminders.map((r) => r.id), ['new']);
});

// ---------------- Reports ----------------
test('reports: gather + fallback daily/weekly', () => {
  const { store, ts } = setup();
  store.data.settings.userName = 'Dev';
  ts.create({ title: 'Ship feature', due: new Date(Date.now() + 2 * 86400000).toISOString(), priority: 'High' });
  ts.logUpdate('T-1', 'progress', 'API done', 50);
  ts.create({ title: 'Old bug', due: new Date(Date.now() - 86400000).toISOString() });
  ts.create({ title: 'Billing' }); ts.logUpdate('T-3', 'blocker', 'No DB access');
  ts.create({ title: 'Docs' }); ts.update('T-4', { status: 'Done' });
  const f = gather(store.data.tasks, 'weekly');
  assert.deepEqual(f.completed.map((t) => t.id), ['T-4']);
  assert.deepEqual(f.overdue.map((t) => t.id), ['T-2']);
  assert.equal(f.blocked[0].blocker, 'No DB access');
  const weekly = buildFallback(f, store.data.settings);
  assert.match(weekly, /^Weekly summary from Dev/);
  assert.match(weekly, /- Docs/);
  assert.match(weekly, /Billing: No DB access/);
  assert.match(weekly, /Old bug is overdue/);
  const daily = buildFallback(gather(store.data.tasks, 'daily'), store.data.settings);
  assert.match(daily, /Done since last update:[\s\S]*Ship feature: API done/);
  assert.match(daily, /Blockers:\n- Billing: No DB access/);
});

// ---------------- AI (mocked API) ----------------
function mockFetch(responses) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.json };
  };
  return calls;
}
function aiSetup(key = 'sk-ant-test') {
  const { store, ts } = setup();
  const emitted = [];
  const ai = new AI({ store, taskService: ts, getApiKey: () => key, emit: (c, p) => emitted.push([c, p]) });
  return { store, ts, ai, emitted };
}

test('ai: no key gives friendly error', async () => {
  const { ai, store } = aiSetup('');
  store.data.chat.push({ role: 'user', text: 'hi' });
  await assert.rejects(ai.chat(), (e) => /AI connection/.test(e.friendly));
});

test('ai: tool loop creates task and returns final text', async () => {
  const { ai, store } = aiSetup();
  store.data.chat.push({ role: 'user', text: 'New task: vendor audit due Friday, high' });
  const calls = mockFetch([
    { json: { stop_reason: 'tool_use', content: [
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'tu1', name: 'create_task', input: { title: 'Vendor audit', priority: 'High', due: '2030-01-04T18:00+05:30' } },
      { type: 'tool_use', id: 'tu2', name: 'update_task', input: { task_id: 'T-99', status: 'Done' } },
    ] } },
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Added T-1, Vendor audit.' }] } },
  ]);
  const reply = await ai.chat();
  assert.equal(reply, 'Added T-1, Vendor audit.');
  assert.equal(store.data.tasks[0].title, 'Vendor audit');
  assert.equal(store.data.tasks[0].priority, 'High');
  assert.equal(calls[0].model, 'claude-sonnet-5-5');
  assert.equal(calls[0].tools.length, 9);
  const results = calls[1].messages.at(-1).content;
  assert.equal(results[0].is_error, undefined);
  assert.equal(results[1].is_error, true, 'bad task id reported back as tool error');
});

test('ai: HTTP errors map to friendly messages', async () => {
  const { ai, store } = aiSetup();
  store.data.chat.push({ role: 'user', text: 'hi' });
  for (const [status, re] of [[401, /rejected the API key/], [429, /rate-limiting/], [404, /wasn't found/]]) {
    mockFetch([{ status, json: { error: { message: 'x' } } }]);
    await assert.rejects(ai.chat(), (e) => re.test(e.friendly), String(status));
  }
  mockFetch([new TypeError('fetch failed')]);
  await assert.rejects(ai.chat(), (e) => /can't reach/.test(e.friendly));
});

test('ai: history starts with user and merges consecutive roles', () => {
  const { ai, store } = aiSetup();
  store.data.chat.push(
    { role: 'buddy', text: 'briefing' },
    { role: 'user', text: 'a' }, { role: 'user', text: 'b' },
    { role: 'buddy', text: 'r' },
  );
  const h = ai._history();
  assert.equal(h[0].role, 'user');
  assert.equal(h[0].content, 'a\n\nb');
});

test('ai: history ending with an assistant turn (alert/second message race)', () => {
  // Reproduces: user sends msg, a reminder alert lands in chat before the queued AI call runs.
  const { ai, store } = aiSetup();
  store.data.chat.push({ role: 'user', text: 'what is due?' }, { role: 'buddy', text: '🔔 T-1 reminder', kind: 'alert' });
  const h = ai._history();
  assert.equal(h.at(-1).role, 'user', `last message sent to API is "${h.at(-1).role}" — the API treats a trailing assistant turn as prefill`);
});

test('ai: report falls back without key and with key on API failure', async () => {
  const { ai, store, ts } = aiSetup('');
  ts.create({ title: 'x' }); ts.logUpdate('T-1', 'progress', 'did stuff', 20);
  let r = await ai.report('daily');
  assert.equal(r.ai, false);
  assert.match(r.text, /did stuff/);
  const b = aiSetup();
  b.ts.create({ title: 'x' }); b.ts.logUpdate('T-1', 'progress', 'did stuff', 20);
  mockFetch([500, 500, 500].map((status) => ({ status, json: {} })));
  r = await b.ai.report('weekly');
  assert.equal(r.ai, false);
  assert.match(r.note, /trouble/);
  mockFetch([{ json: { content: [{ type: 'text', text: 'Hi boss' }] } }]);
  r = await b.ai.report('weekly');
  assert.deepEqual(r, { text: 'Hi boss', ai: true });
});

// ---------------- OpenAI provider ----------------
function mockFetchFull(responses) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const r = responses.shift();
    return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.json };
  };
  return calls;
}

test('openai: tool loop in Chat Completions format', async () => {
  const { ai, store } = aiSetup('sk-proj-test');
  store.data.settings.provider = 'openai'; // model still claude-sonnet-5-5 -> must fall back to gpt default
  store.data.chat.push({ role: 'user', text: 'Add vendor audit due Friday, high, and block T-9' });
  const calls = mockFetchFull([
    { json: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'create_task', arguments: JSON.stringify({ title: 'Vendor audit', priority: 'High', due: '2030-01-04T18:00+05:30' }) } },
      { id: 'c2', type: 'function', function: { name: 'log_update', arguments: JSON.stringify({ task_id: 'T-9', kind: 'blocker', text: 'x' }) } },
      { id: 'c3', type: 'function', function: { name: 'create_task', arguments: '{not json' } },
    ] } }] } },
    { json: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Added T-1. I could not find T-9.' } }] } },
  ]);
  const reply = await ai.chat();
  assert.equal(reply, 'Added T-1. I could not find T-9.');
  assert.equal(store.data.tasks.length, 1);
  assert.equal(store.data.tasks[0].priority, 'High');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-proj-test');
  assert.equal(calls[0].headers['x-api-key'], undefined);
  assert.equal(calls[0].body.model, 'gpt-5-mini');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.equal(calls[0].body.tools[0].type, 'function');
  assert.equal(calls[0].body.tools[0].function.name, 'create_task');
  const second = calls[1].body.messages;
  assert.equal(second.at(-4).role, 'assistant');
  assert.equal(second.at(-4).tool_calls.length, 3);
  const toolMsgs = second.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['c1', 'c2', 'c3']);
  assert.match(toolMsgs[0].content, /^Created T-1/);
  assert.match(toolMsgs[1].content, /^Error: No task/);
  assert.match(toolMsgs[2].content, /^Error:/);
});

test('openai: custom model kept, report and quota error', async () => {
  const { ai, store, ts } = aiSetup('sk-proj-test');
  Object.assign(store.data.settings, { provider: 'openai', model: 'gpt-5' });
  ts.create({ title: 'x' }); ts.logUpdate('T-1', 'progress', 'did stuff', 20);
  let calls = mockFetchFull([{ json: { choices: [{ message: { content: 'Hi Asha' } }] } }]);
  assert.deepEqual(await ai.report('daily'), { text: 'Hi Asha', ai: true });
  assert.equal(calls[0].body.model, 'gpt-5');
  assert.ok(calls[0].body.max_completion_tokens);
  store.data.chat.push({ role: 'user', text: 'hi' });
  mockFetchFull([{ status: 429, json: { error: { message: 'You exceeded your current quota, please check your plan and billing details.' } } }]);
  await assert.rejects(ai.chat(), (e) => /OpenAI account has no credit/.test(e.friendly));
  mockFetchFull([{ status: 401, json: { error: { message: 'Incorrect API key' } } }]);
  await assert.rejects(ai.chat(), (e) => /OpenAI rejected the API key/.test(e.friendly));
});

test('anthropic: still default, still uses x-api-key', async () => {
  const { ai, store } = aiSetup();
  store.data.chat.push({ role: 'user', text: 'hi' });
  const calls = mockFetchFull([{ json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello' }] } }]);
  assert.equal(await ai.chat(), 'Hello');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(calls[0].body.model, 'claude-sonnet-5-5');
});

// ---------------- Gemini provider ----------------
test('gemini: OpenAI-compatible endpoint, flat schema, thought signatures kept', async () => {
  const { ai, store, ts } = aiSetup('AIzaTestKey');
  store.data.settings.provider = 'gemini'; // model still claude -> gemini default
  ts.create({ title: 'Audit', due: '2030-01-01T10:00:00Z' });
  store.data.chat.push({ role: 'user', text: 'remove the due date on the audit' });
  const call = { id: 'fc-1', type: 'function', function: { name: 'update_task', arguments: JSON.stringify({ task_id: 'T-1', due: '' }) },
    extra_content: { google: { thought_signature: 'sig123' } } };
  const calls = mockFetchFull([
    { json: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [call] } }] } },
    { json: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Removed the due date from T-1.' } }] } },
  ]);
  assert.equal(await ai.chat(), 'Removed the due date from T-1.');
  assert.equal(store.data.tasks[0].due, null, 'empty string clears due date');
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer AIzaTestKey');
  assert.equal(calls[0].body.model, 'gemini-flash-latest');
  assert.equal(calls[0].body.max_tokens, 4000);
  assert.equal(calls[0].body.max_completion_tokens, undefined);
  const upd = calls[0].body.tools.find((t) => t.function.name === 'update_task');
  assert.equal(upd.function.parameters.properties.due.type, 'string', 'no type unions sent to Gemini');
  assert.ok(!JSON.stringify(calls[0].body.tools).includes('"null"'));
  const msgs = calls[1].body.messages;
  const asst = msgs.find((m) => m.role === 'assistant');
  assert.equal(asst.tool_calls[0].extra_content.google.thought_signature, 'sig123');
  assert.ok(!('content' in asst), 'no null content sent');
  const tool = msgs.find((m) => m.role === 'tool');
  assert.deepEqual([tool.tool_call_id, tool.name], ['fc-1', 'update_task']);
});

test('gemini: errors (array-wrapped, bad key, free-tier limit) and report', async () => {
  const { ai, store, ts } = aiSetup('AIzaTestKey');
  Object.assign(store.data.settings, { provider: 'gemini', model: 'gemini-2.5-pro' });
  store.data.chat.push({ role: 'user', text: 'hi' });
  mockFetchFull([{ status: 400, json: [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }] }]);
  await assert.rejects(ai.chat(), (e) => /Google Gemini rejected the API key/.test(e.friendly));
  mockFetchFull([{ status: 429, json: [{ error: { message: 'Resource has been exhausted (e.g. check quota).' } }] }]);
  await assert.rejects(ai.chat(), (e) => /usage limit/.test(e.friendly));
  ts.create({ title: 'x' }); ts.logUpdate('T-1', 'progress', 'did stuff', 20);
  const calls = mockFetchFull([{ json: { choices: [{ message: { content: 'Hi Asha' } }] } }]);
  assert.deepEqual(await ai.report('weekly'), { text: 'Hi Asha', ai: true });
  assert.equal(calls[0].body.model, 'gemini-2.5-pro');
});

test('unknown provider falls back to anthropic', async () => {
  const { ai, store } = aiSetup();
  store.data.settings.provider = 'bogus';
  store.data.chat.push({ role: 'user', text: 'hi' });
  const calls = mockFetchFull([{ json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }]);
  await ai.chat();
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
});

test('server errors: retried, then succeed or explain', async () => {
  const { ai, store } = aiSetup('AQ.test');
  store.data.settings.provider = 'gemini';
  store.data.chat.push({ role: 'user', text: 'hi' });
  const busy = { status: 503, json: [{ error: { code: 503, message: 'This model is currently experiencing high demand.' } }] };
  let calls = mockFetchFull([busy, { json: { choices: [{ message: { content: 'Hello!' } }] } }]);
  assert.equal(await ai.chat(), 'Hello!');
  assert.equal(calls.length, 2, 'one retry then success');
  calls = mockFetchFull([busy, busy, busy]);
  await assert.rejects(ai.chat(), (e) => /Google Gemini is having trouble.*tried 3 times.*high demand/.test(e.friendly));
  assert.equal(calls.length, 3);
});

test('tools ran, then reply request fails: report saved changes, not an error', async () => {
  const busy = { status: 503, json: [{ error: { message: 'This model is currently experiencing high demand.' } }] };
  // Gemini / OpenAI format
  const g = aiSetup('AQ.test');
  g.store.data.settings.provider = 'gemini';
  g.store.data.chat.push({ role: 'user', text: 'plan...' });
  mockFetchFull([{ json: { choices: [{ message: { tool_calls: [
    { id: 'a', type: 'function', function: { name: 'create_task', arguments: '{"title":"Atlas plan"}' } },
    { id: 'b', type: 'function', function: { name: 'create_task', arguments: '{"title":"Hiring"}' } },
  ] } }] } }, busy, busy, busy]);
  const r1 = await g.ai.chat();
  assert.match(r1, /^I saved these changes, but couldn't finish my reply \(Google Gemini is having trouble right now\)/);
  assert.match(r1, /Created T-1 "Atlas plan"[\s\S]*Created T-2 "Hiring"/);
  assert.equal(g.store.data.tasks.length, 2);
  // Anthropic format
  const a = aiSetup();
  a.store.data.chat.push({ role: 'user', text: 'plan...' });
  mockFetchFull([{ json: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'create_task', input: { title: 'X' } }] } }, busy, busy, busy]);
  assert.match(await a.ai.chat(), /^I saved these changes[\s\S]*Created T-1 "X"/);
  // Nothing saved yet -> still a normal error
  mockFetchFull([busy, busy, busy]);
  await assert.rejects(a.ai.chat(), (e) => /having trouble/.test(e.friendly));
});

// ---------------- Companion triggers ----------------
const wed = (h, m = 0) => new Date(2026, 9, 7, h, m).getTime(); // Wednesday
const sat = (h, m = 0) => new Date(2026, 9, 10, h, m).getTime(); // Saturday
function trig(over = {}, active = () => true) {
  const { store, ts } = setup();
  Object.assign(store.data.settings, { briefingEnabled: false, checkinMinutes: 0, breakMinutes: 0, wrapupEnabled: false, workStart: '09:30', workEnd: '18:30', workWeekdaysOnly: true }, over);
  const fired = [];
  const s = new Scheduler({ store, onAlerts: (a) => fired.push(...a), onBriefing: (b) => fired.push({ kind: 'briefing', ...b }), onTrigger: (t) => fired.push(t), isUserActive: active });
  return { store, ts, s, fired, kinds: () => fired.map((f) => f.kind) };
}

test('triggers: focus check-in on interval within work hours, names in-progress task', () => {
  const { s, ts, fired, kinds } = trig({ checkinMinutes: 90, userName: 'Dev' });
  ts.create({ title: 'Atlas BOM', status: 'In progress' });
  s.tick(wed(10, 30)); assert.deepEqual(kinds(), []);
  s.tick(wed(11, 0)); assert.deepEqual(kinds(), ['checkin']);
  assert.match(fired[0].text, /Quick check-in, Dev.*T-1 "Atlas BOM"/);
  s.tick(wed(11, 5)); s.tick(wed(12, 29)); assert.equal(fired.length, 1);
  s.tick(wed(12, 31)); assert.deepEqual(kinds(), ['checkin', 'checkin']);
});

test('triggers: breaks alternate water/stretch, snooze brings the same one back, water count per day', () => {
  const { s, fired, kinds } = trig({ breakMinutes: 60, breakKind: 'both' });
  s.tick(wed(10, 30)); s.tick(wed(11, 31)); s.tick(wed(12, 32));
  assert.deepEqual(kinds(), ['water', 'stretch', 'water']);
  s.snoozeTrigger('water', 10, wed(12, 33));
  s.tick(wed(12, 40)); assert.equal(fired.length, 3);
  s.tick(wed(12, 44)); assert.deepEqual(kinds().slice(-1), ['water']);
  assert.equal(s.drankWater(wed(13)), 1); assert.equal(s.drankWater(wed(14)), 2);
  assert.equal(s.waterCount(wed(15)), 2); assert.equal(s.waterCount(sat(10)), 0);
  s.tick(wed(13, 45)); assert.equal(fired.at(-1).count, 2, 'bubble shows glasses so far');
});

test('triggers: silent outside work hours, weekends, when away, or in quiet mode', () => {
  for (const [label, t, over, active] of [
    ['before work', wed(8), {}, () => true],
    ['after work', wed(20), {}, () => true],
    ['weekend', sat(12), {}, () => true],
    ['away', wed(12), {}, () => false],
    ['quiet', wed(12), { quiet: true }, () => true],
  ]) {
    const { s, store, fired } = trig({ checkinMinutes: 30, breakMinutes: 30, ...over }, active);
    if (over.quiet) store.data.meta.quietUntil = wed(13);
    s.tick(t);
    assert.equal(fired.length, 0, label);
  }
  const { s, fired } = trig({ checkinMinutes: 30, workWeekdaysOnly: false });
  s.tick(sat(12)); assert.equal(fired.length, 1, 'weekend allowed when configured');
});

test('triggers: wrap-up once per workday within 3h of its time, before check-ins', () => {
  const { s, kinds } = trig({ wrapupEnabled: true, wrapupTime: '18:00', checkinMinutes: 30 });
  s.tick(wed(17, 59)); assert.deepEqual(kinds(), ['checkin']);
  s.tick(wed(18, 10)); assert.deepEqual(kinds(), ['checkin', 'wrapup']);
  s.tick(wed(18, 25)); assert.deepEqual(kinds(), ['checkin', 'wrapup'], 'not again, and gap respected');
  const late = trig({ wrapupEnabled: true, wrapupTime: '18:00' });
  late.s.tick(wed(21, 30)); assert.deepEqual(late.kinds(), [], 'too late for a wrap-up');
});

test('triggers: reminders take priority and push triggers back', () => {
  const { s, ts, kinds } = trig({ checkinMinutes: 30 });
  const t = ts.create({ title: 'r' });
  t.reminders.push({ id: 'x', kind: 'at', repeat: 'none', active: true, nextAt: new Date(wed(11)).toISOString() });
  s.tick(wed(11, 1)); assert.deepEqual(kinds(), ['reminder']);
  s.tick(wed(11, 5)); assert.deepEqual(kinds(), ['reminder'], 'gap after an alert');
  s.tick(wed(11, 12)); assert.deepEqual(kinds(), ['reminder', 'checkin']);
});

test('welcome back summarises what matters', () => {
  const { s, ts, store } = trig();
  store.data.settings.userName = 'Dev';
  assert.match(s.buildWelcomeBack(25 * 60000).text, /^Welcome back, Dev! You were away 25 min\. Nothing urgent came up\.$/);
  ts.create({ title: 'Soon thing', due: new Date(Date.now() + 3600000).toISOString() });
  ts.create({ title: 'Late thing', due: new Date(Date.now() - 3600000).toISOString() });
  const w = s.buildWelcomeBack(95 * 60000);
  assert.match(w.text, /away 1 hour 35 min\. Coming up: T-1 Soon thing.*1 task is overdue\./);
  assert.equal(w.urgent, true);
});

// ---------------- ChatGPT account via Codex CLI ----------------
const { codexError } = require(path.join(ROOT, 'src/codex'));
function codexSetup(replies) {
  const { store, ts } = setup();
  store.data.settings.provider = 'chatgpt';
  const calls = [];
  const runCodex = async (opts) => { calls.push(opts); const r = replies.shift(); if (r instanceof Error) throw r; return typeof r === 'string' ? r : JSON.stringify(r); };
  const ai = new AI({ store, taskService: ts, getApiKey: () => '', emit: () => {}, codexDir: tmpDir(), runCodex });
  return { store, ts, ai, calls };
}

test('chatgpt: works with no API key, applies actions, passes schema and context', async () => {
  const { ai, store, calls } = codexSetup([{ actions: [
    { tool: 'create_task', input_json: JSON.stringify({ title: 'Atlas v2 plan', priority: 'High', due: '2030-01-04T18:00+05:30' }) },
    { tool: 'create_task', input_json: JSON.stringify({ title: 'Hire FW engineer' }) },
  ], reply: 'Added T-1 and T-2.' }]);
  assert.equal(ai.hasAccess(), true);
  store.data.chat.push({ role: 'user', text: 'plan: zircon v1.1 high, hire fw engineer' });
  assert.equal(await ai.chat(), 'Added T-1 and T-2.');
  assert.deepEqual(store.data.tasks.map((t) => `${t.id}:${t.title}:${t.priority}`), ['T-1:Atlas v2 plan:High', 'T-2:Hire FW engineer:Medium']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].schema.required, ['actions', 'reply']);
  assert.equal(calls[0].model, 'gpt-6-luna', 'fast model by default');
  assert.match(calls[0].prompt, /not a coding task/);
  assert.match(calls[0].prompt, /- create_task: /);
  assert.match(calls[0].prompt, /User: plan: zircon v1\.1 high/);
});

test('chatgpt: failed action gets a correction round without repeating successes', async () => {
  const { ai, store, calls } = codexSetup([
    { actions: [
      { tool: 'create_task', input_json: '{"title":"A"}' },
      { tool: 'log_update', input_json: '{"task_id":"T-9","kind":"blocker","text":"x"}' },
    ], reply: 'Done both.' },
    { actions: [], reply: 'Added T-1. I could not find T-9; which task is blocked?' },
  ]);
  store.data.chat.push({ role: 'user', text: 'add A and block T-9' });
  assert.equal(await ai.chat(), 'Added T-1. I could not find T-9; which task is blocked?');
  assert.equal(store.data.tasks.length, 1);
  assert.match(calls[1].prompt, /Results of the actions[\s\S]*create_task: Created T-1[\s\S]*log_update: Error: No task with id T-9/);
});

test('chatgpt: plain reply, non-JSON output, errors after saving, reports', async () => {
  let s = codexSetup([{ actions: [], reply: 'You have nothing due today.' }]);
  s.store.data.chat.push({ role: 'user', text: 'what is due?' });
  assert.equal(await s.ai.chat(), 'You have nothing due today.');
  s = codexSetup(['Sure, nothing is due.']);
  s.store.data.chat.push({ role: 'user', text: 'what is due?' });
  assert.equal(await s.ai.chat(), 'Sure, nothing is due.');
  const limit = codexError('ERROR: You\'ve hit your usage limit. Try again in 3 hours.', { code: 1 });
  s = codexSetup([{ actions: [{ tool: 'create_task', input_json: '{"title":"A"}' }, { tool: 'delete_task', input_json: '{"task_id":"T-7"}' }], reply: 'x' }, limit]);
  s.store.data.chat.push({ role: 'user', text: 'add A, delete T-7' });
  assert.match(await s.ai.chat(), /^I saved these changes[\s\S]*Created T-1 "A"/);
  s = codexSetup([limit]);
  s.store.data.chat.push({ role: 'user', text: 'hi' });
  await assert.rejects(s.ai.chat(), (e) => /usage limit/.test(e.friendly));
  s = codexSetup(['Hi Asha, here is my update.']);
  s.ts.create({ title: 'x' }); s.ts.logUpdate('T-1', 'progress', 'did stuff', 20);
  assert.deepEqual(await s.ai.report('daily'), { text: 'Hi Asha, here is my update.', ai: true });
  assert.equal(s.calls[0].schema, undefined);
});

test('codex errors become friendly messages', () => {
  const f = (err, o = {}) => codexError(err, { code: 1, ...o }).friendly;
  assert.match(f('', { spawnError: 'ENOENT' }), /needs its sign-in tool installed.*click Install/);
  assert.match(f('Error: Not logged in. Please run `codex login`'), /not signed in to your ChatGPT account.*Sign in/);
  assert.match(f('Please set an Auth method in your settings.json'), /not signed in/);
  assert.match(f('stream error: unexpected status 401 Unauthorized'), /not signed in/);
  assert.match(f('ERROR: You\'ve hit your usage limit.'), /usage limit/);
  assert.match(f('', { timedOut: true, code: null }), /took too long/);
  assert.match(f('error sending request for url'), /can't reach ChatGPT/);
  assert.match(f('ERROR: something odd happened'), /something odd happened/);
});

// ---------------- Focus mode & moods ----------------
test('focus mode: pauses triggers, ends with a focusEnd trigger, can be stopped early', () => {
  const { s, store, kinds, fired } = trig({ checkinMinutes: 30, breakMinutes: 0, focusMinutes: 50 });
  const r = s.startFocus(undefined, wed(10));
  assert.equal(r.minutes, 50);
  assert.equal(store.data.meta.quietUntil, wed(10, 50));
  s.tick(wed(10, 20)); s.tick(wed(10, 45)); assert.deepEqual(kinds(), [], 'check-ins paused');
  s.tick(wed(10, 51)); assert.deepEqual(kinds(), ['focusEnd']);
  assert.match(fired[0].text, /Focus session done.*50 minutes/);
  assert.equal(store.data.meta.focusUntil, 0);
  s.tick(wed(10, 55)); assert.deepEqual(kinds(), ['focusEnd'], 'no check-in straight after');
  s.startFocus(25, wed(11));
  const stop = s.stopFocus(wed(11, 10));
  assert.deepEqual(stop, { wasOn: true, elapsed: 10 });
  assert.equal(store.data.meta.quietUntil, 0);
  assert.equal(s.stopFocus(wed(11, 11)).wasOn, false);
  assert.equal(s.startFocus(1000, wed(12)).minutes, 240, 'clamped');
});

test('briefing greeting follows the day when moods are on', () => {
  const mon = new Date(2026, 9, 5, 9, 30).getTime(); const fri = new Date(2026, 9, 9, 9, 30).getTime();
  const { s, store } = trig({ userName: 'Dev' });
  assert.match(s.buildBriefing(mon).text, /^Happy Monday, Dev\. New week, let's get focused\./);
  assert.match(s.buildBriefing(fri).text, /^Happy Friday, Dev\. Let's finish the week strong\./);
  assert.match(s.buildBriefing(wed(9)).text, /^Good morning, Dev\./);
  store.data.settings.moodsEnabled = false;
  assert.match(s.buildBriefing(mon).text, /^Good morning, Dev\./);
});

test('ai: focus_mode tool starts/stops focus (API and ChatGPT paths)', async () => {
  const { ai, store } = aiSetup();
  const calls = [];
  ai.onFocus = (action, minutes) => { calls.push([action, minutes]); return action === 'start' ? 'Focus mode on for 25 min.' : 'Focus mode stopped.'; };
  store.data.chat.push({ role: 'user', text: 'focus for 25 minutes' });
  const reqs = mockFetchFull([
    { json: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'f', name: 'focus_mode', input: { action: 'start', minutes: 25 } }] } },
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Focus on, 25 minutes.' }] } },
  ]);
  assert.equal(await ai.chat(), 'Focus on, 25 minutes.');
  assert.deepEqual(calls, [['start', 25]]);
  assert.ok(reqs[0].body.tools.some((t) => t.name === 'focus_mode'));
  const c = codexSetup([{ actions: [{ tool: 'focus_mode', input_json: '{"action":"stop"}' }], reply: 'Stopped focus mode.' }]);
  c.ai.onFocus = (action) => { calls.push([action]); return 'Focus mode stopped after 12 min.'; };
  c.store.data.chat.push({ role: 'user', text: 'stop focus mode' });
  assert.equal(await c.ai.chat(), 'Stopped focus mode.');
  assert.deepEqual(calls.at(-1), ['stop']);
  assert.match(c.calls[0].prompt, /- focus_mode: /);
});

// ---------------- Instant answers (no AI) ----------------
const { quickReply } = require(path.join(ROOT, 'src/quick'));
function quickCtx() {
  const now = new Date(2026, 9, 7, 10, 0).getTime(); // Wed 10:00
  const iso = (d, h) => new Date(2026, 9, d, h, 0).toISOString();
  const tasks = [
    { id: 'T-1', title: 'Atlas plan', status: 'In progress', priority: 'High', due: iso(9, 18), log: [] },
    { id: 'T-2', title: 'Vendor call', status: 'Not started', priority: 'Medium', due: iso(7, 16), log: [] },
    { id: 'T-3', title: 'Old audit', status: 'Not started', priority: 'Low', due: iso(5, 18), log: [] },
    { id: 'T-4', title: 'Billing', status: 'Blocked', priority: 'Critical', due: null, log: [{ type: 'blocker', text: 'Waiting for DB access' }] },
    { id: 'T-5', title: 'PCBA bring-up', status: 'Not started', priority: 'Medium', due: iso(12, 18), log: [] },
    { id: 'T-6', title: 'Docs', status: 'Done', priority: 'Low', due: iso(7, 12), log: [] },
  ];
  const calls = [];
  return { calls, ctx: { tasks, now, focus: (a, m) => { calls.push([a, m]); return `focus ${a} ${m ?? 'default'}`; }, markDone: (id) => { calls.push(['done', id]); tasks.find((t) => t.id === id).status = 'Done'; } } };
}

test('instant answers: due today / tomorrow / this week, overdue, blockers', () => {
  const { ctx } = quickCtx();
  const today = quickReply("What's due today?", ctx);
  assert.match(today, /^Due today: T-2 Vendor call/);
  assert.match(today, /Also overdue: T-3 Old audit/);
  assert.doesNotMatch(today, /Docs|Atlas/);
  assert.equal(quickReply('what is due tomorrow', ctx), 'Nothing is due tomorrow.');
  const week = quickReply("Hey Buddy what's due this week", ctx);
  assert.match(week, /Due this week: T-2 Vendor call .* and T-1 Atlas plan/);
  assert.doesNotMatch(week, /PCBA/, 'next Monday is not this week');
  assert.match(quickReply('what do I have today', ctx), /^Due today/);
  assert.match(quickReply("what's overdue?", ctx), /^Overdue: T-3 Old audit/);
  assert.match(quickReply('What am I blocked on?', ctx), /Blocked: \n- T-4 Billing: Waiting for DB access/);
});

test('instant answers: focus mode and marking done', () => {
  const { ctx, calls } = quickCtx();
  assert.equal(quickReply('focus mode', ctx), 'focus start default');
  assert.equal(quickReply('Go to focus mode for 25 minutes', ctx), 'focus start 25');
  assert.equal(quickReply('focus for an hour', ctx), 'focus start 60');
  assert.equal(quickReply('focus mode for half an hour', ctx), 'focus start 30');
  assert.equal(quickReply('stop focus mode', ctx), 'focus stop default');
  assert.equal(quickReply('focus off', ctx), 'focus stop default');
  assert.equal(quickReply('T-2 done', ctx), 'Nice work! Marked T-2 "Vendor call" as done.');
  assert.equal(quickReply('mark t 1 as complete', ctx), 'Nice work! Marked T-1 "Atlas plan" as done.');
  assert.match(quickReply('T-6 is done', ctx), /already done/);
  assert.match(quickReply('T-99 done', ctx), /couldn't find T-99/);
  assert.deepEqual(calls.filter((c) => c[0] === 'done'), [['done', 'T-2'], ['done', 'T-1']]);
});

test('instant answers: anything else goes to the AI', () => {
  const { ctx, calls } = quickCtx();
  for (const msg of [
    'What should I focus on today?', 'go to focus mode for 25 minutes, I need to finish the BOM',
    'New task: email Alex about the DC-DC converter, due today', 'Atlas plan is 40% done', 'remind me today at 5',
    'what is the status of T-1', "I'm done with the audit", 'today I finished the BOM review and started the cascading deck',
  ]) assert.equal(quickReply(msg, ctx), null, msg);
  assert.equal(calls.length, 0);
});

test('chatgpt: falls back to Codex default if the fast model is unavailable', async () => {
  const err = codexError('ERROR: {"error":{"message":"The model `gpt-6-luna` does not exist or you do not have access to it."}}', { code: 1 });
  const { ai, store, calls } = codexSetup([err, { actions: [], reply: 'Hi!' }, { actions: [], reply: 'Again!' }]);
  store.data.chat.push({ role: 'user', text: 'hi' });
  assert.equal(await ai.chat(), 'Hi!');
  assert.deepEqual(calls.map((c) => c.model), ['gpt-6-luna', '']);
  assert.equal(await ai.chat(), 'Again!');
  assert.equal(calls.at(-1).model, '', 'remembers the fallback');
});

// ---------------- AI connections (several, with backups) ----------------
const { cliError } = require(path.join(ROOT, 'src/cli'));
function connSetup(conns, runners = {}) {
  const { store, ts } = setup();
  const calls = [];
  const wrapRunner = (name) => async (opts) => {
    calls.push({ name, model: opts.model, schema: !!opts.schema, prompt: opts.prompt });
    const q = runners[name] || [];
    const r = q.shift();
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? r : JSON.stringify(r);
  };
  const ai = new AI({ store, taskService: ts, emit: () => {}, codexDir: tmpDir(), getConnections: () => conns,
    runCodex: wrapRunner('codex'), runClaude: wrapRunner('claude'), runGemini: wrapRunner('gemini') });
  return { store, ts, ai, calls };
}
const limitErr = (tool) => cliError(tool, { code: 1, stderr: "ERROR: You've hit your usage limit." });

test('connections: main answers; Claude and Gemini sign-ins use the JSON action loop', async () => {
  let s = connSetup([{ id: 'a', provider: 'claude', model: '' }], { claude: [{ actions: [{ tool: 'create_task', input_json: '{"title":"Email Alex"}' }], reply: 'Added T-1.' }] });
  s.store.data.chat.push({ role: 'user', text: 'add email Alex' });
  assert.equal(await s.ai.chat(), 'Added T-1.');
  assert.deepEqual(s.calls.map((c) => [c.name, c.model, c.schema]), [['claude', 'sonnet', true]]);
  assert.equal(s.store.data.tasks[0].title, 'Email Alex');
  s = connSetup([{ id: 'g', provider: 'google', model: '' }], { gemini: ['```json\n{"actions":[],"reply":"Nothing due."}\n```'] });
  s.store.data.chat.push({ role: 'user', text: 'what is due' });
  assert.equal(await s.ai.chat(), 'Nothing due.', 'fenced JSON from Gemini is tolerated');
  assert.match(s.calls[0].prompt, /Reply with ONLY a JSON object/);
});

test('connections: falls back to the next one and says so; no fallback after changes were saved', async () => {
  const conns = [{ id: 'm', provider: 'chatgpt', model: '' }, { id: 'b', provider: 'claude', model: 'haiku' }];
  let s = connSetup(conns, { codex: [limitErr('codex')], claude: [{ actions: [], reply: 'Here you go.' }] });
  s.store.data.chat.push({ role: 'user', text: 'hi' });
  assert.equal(await s.ai.chat(), "Here you go.\n\n(ChatGPT wasn't available, so Claude answered.)");
  assert.deepEqual(s.calls.map((c) => c.name), ['codex', 'claude']);
  // useBackups off: the error surfaces
  s = connSetup(conns, { codex: [limitErr('codex')] });
  s.store.data.settings.useBackups = false;
  s.store.data.chat.push({ role: 'user', text: 'hi' });
  await assert.rejects(s.ai.chat(), (e) => /usage limit/.test(e.friendly));
  assert.equal(s.calls.length, 1);
  // all fail: last error surfaces
  s = connSetup(conns, { codex: [limitErr('codex')], claude: [cliError('claude', { notFound: true })] });
  s.store.data.chat.push({ role: 'user', text: 'hi' });
  await assert.rejects(s.ai.chat(), (e) => /Claude connection needs its sign-in tool installed/.test(e.friendly));
  // changes saved, then the main fails: report what was saved, don't re-run on the backup
  s = connSetup(conns, { codex: [{ actions: [{ tool: 'create_task', input_json: '{"title":"A"}' }, { tool: 'delete_task', input_json: '{"task_id":"T-9"}' }], reply: 'x' }, limitErr('codex')] });
  s.store.data.chat.push({ role: 'user', text: 'add A, delete T-9' });
  assert.match(await s.ai.chat(), /^I saved these changes/);
  assert.equal(s.store.data.tasks.length, 1, 'no duplicate task from a backup');
  assert.ok(!s.calls.some((c) => c.name === 'claude'));
});

test('connections: API-key connections need a key; none at all gives a helpful error; test a specific one', async () => {
  let s = connSetup([{ id: 'k', provider: 'anthropic', model: '', key: '' }, { id: 'c', provider: 'claude', model: '' }], { claude: [{ actions: [], reply: 'ok' }] });
  assert.deepEqual(s.ai.connections().map((c) => c.id), ['c'], 'keyless API connection skipped');
  s = connSetup([]);
  assert.equal(s.ai.hasAccess(), false);
  s.store.data.chat.push({ role: 'user', text: 'hi' });
  await assert.rejects(s.ai.chat(), (e) => /AI connections/.test(e.friendly));
  s = connSetup([{ id: 'm', provider: 'chatgpt' }, { id: 'b', provider: 'claude' }], { claude: ['Connected'] });
  assert.equal(await s.ai.testConnection({ id: 'b', provider: 'claude', model: '' }), 'Connected');
  assert.deepEqual(s.calls.map((c) => c.name), ['claude'], 'tests only the chosen connection');
});

test('connections: reports use backups too', async () => {
  const s = connSetup([{ id: 'm', provider: 'google' }, { id: 'b', provider: 'chatgpt' }], { gemini: [limitErr('gemini')], codex: ['Hi Asha, update below.'] });
  s.ts.create({ title: 'x' }); s.ts.logUpdate('T-1', 'progress', 'did stuff', 20);
  assert.deepEqual(await s.ai.report('daily'), { text: 'Hi Asha, update below.', ai: true });
});

// ---------------- Reminders section: standalone + unified editing ----------------
const inH = (h) => new Date(Date.now() + h * 3600000).toISOString();
test('reminders: standalone add / edit / pause / resume / delete / snooze', () => {
  const { ts, store } = setup();
  assert.throws(() => ts.addStandaloneReminder({ at: inH(1) }), /something to remind/);
  assert.throws(() => ts.addStandaloneReminder({ title: 'x', at: inH(-2) }), /in the past/);
  const { reminder: r } = ts.addStandaloneReminder({ title: 'Call the vendor', at: inH(2), note: 'PCBA ETA' });
  assert.equal(store.data.reminders.length, 1);
  assert.equal(r.title, 'Call the vendor');
  ts.updateReminder(r.id, { at: inH(3), repeat: 'daily', title: 'Call the vendor about PCBA' });
  assert.equal(r.repeat, 'daily'); assert.equal(r.title, 'Call the vendor about PCBA');
  ts.updateReminder(r.id, { active: false });
  assert.equal(r.active, false); assert.ok(r.pausedAt);
  ts.updateReminder(r.id, { active: true });
  assert.equal(r.active, true); assert.equal(r.pausedAt, undefined);
  ts.snoozeReminder(r.id, 15);
  assert.equal(store.data.reminders.length, 2);
  assert.equal(store.data.reminders[1].title, 'Call the vendor about PCBA');
  ts.deleteReminder(r.id);
  assert.equal(store.data.reminders.length, 1);
  assert.throws(() => ts.updateReminder('nope', { note: 'x' }), /not found/);
});

test('reminders: failed edit leaves the reminder untouched; past one-off can be rescheduled', () => {
  const { ts } = setup();
  const { reminder: r } = ts.addStandaloneReminder({ title: 'Stand-up', at: inH(1) });
  const before = JSON.stringify(r);
  assert.throws(() => ts.updateReminder(r.id, { at: inH(-3) }), /in the past/);
  assert.equal(JSON.stringify(r), before, 'unchanged after a rejected edit');
  r.active = false; r.firedAt = new Date().toISOString(); r.nextAt = inH(-1); // as if it fired
  assert.throws(() => ts.updateReminder(r.id, { active: true }), /Pick a new time/);
  ts.updateReminder(r.id, { at: inH(5) });
  assert.equal(r.active, true, 'new time re-activates it');
  assert.equal(r.firedAt, undefined);
});

test('reminders: move between a task and standalone, keep "before due" with the task', () => {
  const { ts, store } = setup();
  const t = ts.create({ title: 'Atlas plan', due: inH(48) });
  const { reminder: r } = ts.addStandaloneReminder({ title: 'Ping Alex', at: inH(4) });
  ts.updateReminder(r.id, { taskId: 'T-1' });
  assert.equal(store.data.reminders.length, 0);
  assert.equal(t.reminders[0], r);
  assert.equal(r.title, undefined, 'task reminders use the task title');
  ts.updateReminder(r.id, { minutes_before_due: 60 });
  assert.equal(r.kind, 'before_due');
  assert.equal(new Date(r.nextAt).getTime(), new Date(t.due).getTime() - 3600000);
  ts.updateReminder(r.id, { note: 'bring BOM' });
  assert.equal(r.kind, 'before_due', 'still follows the due date');
  ts.updateReminder(r.id, { taskId: '', at: inH(6) });
  assert.equal(t.reminders.length, 0);
  assert.equal(store.data.reminders[0], r);
  assert.equal(r.title, 'Atlas plan', 'detached reminder keeps a title');
  assert.equal(r.kind, 'at');
  assert.throws(() => ts.updateReminder(r.id, { taskId: 'T-9' }), /No task/);
});

test('scheduler: standalone reminders fire; paused ones are kept, fired ones cleaned after 7 days', () => {
  const { store, ts } = setup();
  store.data.settings.briefingEnabled = false;
  const { reminder: a } = ts.addStandaloneReminder({ title: 'Water plants', at: inH(1), repeat: 'daily' });
  const { reminder: b } = ts.addStandaloneReminder({ title: 'Pay bill', at: inH(1) });
  a.nextAt = inH(-0.01); b.nextAt = inH(-0.01);
  const fired = [];
  const s = new Scheduler({ store, onAlerts: (x) => fired.push(...x), onBriefing: () => {} });
  s.tick();
  assert.deepEqual(fired.map((f) => [f.title, f.taskId, !!f.reminderId]), [['Water plants', null, true], ['Pay bill', null, true]]);
  assert.ok(new Date(a.nextAt) > new Date() && a.active, 'repeating moves on');
  assert.equal(b.active, false); assert.ok(b.firedAt);
  const { reminder: c } = ts.addStandaloneReminder({ title: 'Paused one', at: inH(1) });
  ts.updateReminder(c.id, { active: false });
  c.nextAt = new Date(Date.now() - 8 * 86400000).toISOString();
  b.nextAt = c.nextAt;
  s.tick();
  assert.deepEqual(store.data.reminders.map((r) => r.title), ['Water plants', 'Paused one']);
});

test('ai: reminder tools work for standalone and task reminders', async () => {
  const { ai, store, ts } = aiSetup();
  ts.create({ title: 'Audit', due: inH(30) });
  store.data.chat.push({ role: 'user', text: 'remind me to call the vendor in 2 hours' });
  const reqs = mockFetchFull([
    { json: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'add_reminder', input: { title: 'Call the vendor', at: inH(2) } },
      { type: 'tool_use', id: 'b', name: 'add_reminder', input: { task_id: 'T-1', minutes_before_due: 30 } }] } },
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } },
  ]);
  await ai.chat();
  assert.equal(store.data.reminders[0].title, 'Call the vendor');
  assert.equal(store.data.tasks[0].reminders[0].kind, 'before_due');
  assert.match(reqs[1].body.messages.at(-1).content[0].content, /Reminder \w+ set "Call the vendor"/);
  const rid = store.data.reminders[0].id;
  store.data.chat.push({ role: 'buddy', text: 'Done.' }, { role: 'user', text: 'pause the vendor reminder, delete the audit one' });
  const req2 = mockFetchFull([
    { json: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'update_reminder', input: { reminder_id: rid, active: false } },
      { type: 'tool_use', id: 'd', name: 'remove_reminder', input: { reminder_id: store.data.tasks[0].reminders[0].id } }] } },
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Paused and removed.' }] } },
  ]);
  await ai.chat();
  assert.equal(store.data.reminders[0].active, false);
  assert.equal(store.data.tasks[0].reminders.length, 0);
  assert.match(req2[0].body.system, new RegExp(`Standalone reminders.*${rid}.*Call the vendor`));
});

test('instant answers: reminders list', () => {
  const now = new Date(2026, 9, 7, 10, 0).getTime();
  const iso = (d, h) => new Date(2026, 9, d, h, 0).toISOString();
  const ctx = {
    now, focus: () => '', markDone: () => {},
    tasks: [{ id: 'T-1', title: 'Atlas plan', status: 'In progress', reminders: [{ id: 'r1', active: true, nextAt: iso(7, 15), repeat: 'none' }] }],
    reminders: [
      { id: 'r2', title: 'Call vendor', active: true, nextAt: iso(7, 11), repeat: 'daily' },
      { id: 'r3', title: 'Paused', active: false, nextAt: iso(7, 12), repeat: 'none' },
      { id: 'r4', title: 'Friday thing', active: true, nextAt: iso(9, 9), repeat: 'none' },
    ],
  };
  const today = quickReply('what are my reminders today', ctx);
  assert.match(today, /^Reminders today: Call vendor \(.*, daily\) and T-1 Atlas plan/);
  assert.doesNotMatch(today, /Paused|Friday/);
  assert.match(quickReply('my reminders', ctx), /\n- Call vendor[\s\S]*\n- Friday thing/);
  assert.equal(quickReply('reminders tomorrow', ctx), 'No reminders tomorrow.');
  assert.equal(quickReply('remind me to call Alex at 4', ctx), null, 'creating reminders goes to the AI');
});

// ---------------- Sign-in window script ----------------
test('sign-in script: Node check cannot be cut short; PATH is reloaded; correct commands', () => {
  const { signInScript } = require(path.join(ROOT, 'src/cli'));
  for (const [name, pkg, cmd] of [['codex', '@openai/codex', 'codex login'], ['claude', '@anthropic-ai/claude-code', 'claude auth login'], ['gemini', '@google/gemini-cli', 'gemini']]) {
    const lines = signInScript(name, { install: true }).split('\r\n');
    // No parenthesised if-blocks: a ")" in echoed text would end them early and run the rest unconditionally.
    assert.ok(!lines.some((l) => /^\s*if .*\($/.test(l)), `${name}: no if ( ... ) blocks`);
    assert.ok(!lines.some((l) => /^echo .*[()]/.test(l)), `${name}: no brackets in echoed text`);
    const check = lines.indexOf('where npm >nul 2>nul');
    assert.ok(check > 0 && lines[check + 1] === 'if not errorlevel 1 goto :have_node', `${name}: Node check jumps past the download step`);
    const label = lines.indexOf(':have_node');
    const opens = lines.findIndex((l) => l.includes('https://nodejs.org/'));
    assert.ok(opens > check && opens < label && lines.slice(opens, label).includes('goto :eof'), `${name}: nodejs.org only on the no-Node path`);
    assert.ok(lines.some((l) => /^for \/f .*GetEnvironmentVariable\('Path','Machine'\)/.test(l)), `${name}: reloads PATH from Windows`);
    assert.ok(!lines.some((l) => /in \(`"/.test(l)), `${name}: no leading quote inside for /f`);
    assert.ok(lines.indexOf(`call npm install -g ${pkg}`) > label, `${name}: installs after the check`);
    assert.equal(lines.at(-1), `call ${cmd}`);
  }
  const noInstall = signInScript('claude', { install: false }); // tool already installed on this PC
  assert.doesNotMatch(noInstall, /npm install/);
  assert.match(noInstall, /call claude auth login$/);
});
