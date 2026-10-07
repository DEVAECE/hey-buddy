// The AI "brain": turns natural language into task actions via tool use,
// and writes manager reports from the logged facts.
const { gather, buildFallback } = require('./reports');
const { fmt } = require('./tasks');
const { runCodex } = require('./codex');
const { runClaude, runGemini } = require('./cli');

// format 'openai' = Chat Completions request/response shape (Gemini offers an OpenAI-compatible endpoint).
// API-key connections, then account sign-ins (no key) through each company's command-line tool.
const PROVIDERS = {
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages', defaultModel: 'claude-sonnet-5-5', modelPattern: /^claude/i, format: 'anthropic' },
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', defaultModel: 'gpt-5-mini', modelPattern: /^(gpt|o\d|chatgpt)/i, format: 'openai', tokenParam: 'max_completion_tokens' },
  gemini: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', defaultModel: 'gemini-flash-latest', modelPattern: /^gemini/i, format: 'openai', tokenParam: 'max_tokens' },
  // ChatGPT sign-in through the Codex CLI. Defaults to the fast model (about 3x quicker than
  // Codex's default for a pasted plan); if it's unavailable Buddy falls back to Codex's default.
  chatgpt: { name: 'ChatGPT', defaultModel: 'gpt-6-luna', modelPattern: /^(gpt|o\d|codex)/i, format: 'codex', noKey: true },
  // Claude sign-in through Claude Code (about 5 s per reply).
  claude: { name: 'Claude', defaultModel: 'sonnet', modelPattern: /^(sonnet|opus|haiku|claude)/i, format: 'claudecode', noKey: true },
  // Google sign-in through the Gemini CLI. Empty model = the CLI's default.
  google: { name: 'Gemini', defaultModel: '', modelPattern: /^gemini/i, format: 'geminicli', noKey: true },
};

// Codex returns one JSON object per turn: the tool calls to make, and what to say.
// (Strict structured output can't take free-form objects, so each input is a JSON string.)
const CODEX_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { tool: { type: 'string' }, input_json: { type: 'string' } },
        required: ['tool', 'input_json'],
        additionalProperties: false,
      },
    },
    reply: { type: 'string' },
  },
  required: ['actions', 'reply'],
  additionalProperties: false,
};

// Codex is a coding agent; tell it this isn't a coding task.
const CODEX_NOTE = 'You are answering on behalf of Buddy, a task-tracking app. This is not a coding task: do not run commands, read files or explore the working directory. Use only the information below.';

function parseCodexJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = /\{[\s\S]*\}/.exec(text || '');
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return { actions: [], reply: String(text || '').trim() };
}

// Both take a connection-like object: {provider, model}.
function providerId(conn) { return conn && PROVIDERS[conn.provider] ? conn.provider : 'anthropic'; }

// Gemini rejects JSON-schema type unions like ["string","null"]; keep the first non-null type.
// (An empty string still clears a due date, see parseDate in tasks.js.)
function flatSchema(schema) {
  return JSON.parse(JSON.stringify(schema, (k, v) => (k === 'type' && Array.isArray(v) ? v.find((t) => t !== 'null') : v)));
}

// Falls back to the provider's default if the saved model belongs to the other provider
// (e.g. the user switched to OpenAI but left "claude-sonnet-5-5" in the Model box).
function modelFor(settings) {
  const p = PROVIDERS[providerId(settings)];
  const m = String(settings.model || '').trim();
  return m && p.modelPattern.test(m) ? m : p.defaultModel;
}

function offsetString(d = new Date()) {
  const m = -d.getTimezoneOffset();
  const sign = m >= 0 ? '+' : '-';
  const a = Math.abs(m);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
function localIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}${offsetString(d)}`;
}

const TOOLS = [
  {
    name: 'create_task',
    description: 'Add a new task. Only call once you know at least the title. If the user gave no due date, ask for one first unless they say there is none.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, clear task title' },
        description: { type: 'string' },
        assigned_by: { type: 'string', description: 'Who gave this task, if mentioned' },
        priority: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
        due: { type: 'string', description: 'ISO 8601 date-time with the user\'s UTC offset, e.g. 2026-10-09T17:00+05:30. If only a day is given, use 18:00 that day.' },
        status: { type: 'string', enum: ['Not started', 'In progress', 'Blocked', 'Done'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Change fields of an existing task (title, priority, due date, status, progress, description, assigned_by). Use log_update instead for status notes and blockers.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'e.g. T-12' },
        title: { type: 'string' },
        description: { type: 'string' },
        assigned_by: { type: 'string' },
        priority: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
        due: { type: ['string', 'null'], description: 'ISO 8601 with offset, or null (or empty string) to remove' },
        status: { type: 'string', enum: ['Not started', 'In progress', 'Blocked', 'Done'] },
        progress: { type: 'number', description: '0-100' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'log_update',
    description: 'Record a status update, progress note, blocker, or resolved blocker against a task. These entries feed the manager reports, so write them as clear, factual one-liners in the user\'s voice.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        kind: { type: 'string', enum: ['progress', 'blocker', 'blocker_resolved', 'note'] },
        text: { type: 'string' },
        progress: { type: 'number', description: 'Optional new % complete' },
      },
      required: ['task_id', 'kind', 'text'],
    },
  },
  {
    name: 'add_reminder',
    description: 'Set a reminder. For a task, give task_id. For anything else ("remind me to call the vendor at 4"), omit task_id and give a short title; do NOT create a task just to hold a reminder. Give either "at" (absolute time) or, for a task with a due date, "minutes_before_due". Repeating reminders on a task stop automatically when the task is Done.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task this reminder is about, if any' },
        title: { type: 'string', description: 'What to remind about, for reminders not tied to a task' },
        at: { type: 'string', description: 'ISO 8601 with offset' },
        minutes_before_due: { type: 'number' },
        repeat: { type: 'string', enum: ['none', 'hourly', 'daily', 'weekdays', 'weekly'] },
        note: { type: 'string', description: 'Optional short note shown in the reminder' },
      },
    },
  },
  {
    name: 'update_reminder',
    description: 'Change an existing reminder (on a task or standalone): move its time, change the repeat, rename it, edit the note, pause it (active=false) or turn it back on (active=true), or attach it to a task (task_id) / detach it (task_id="").',
    input_schema: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string' },
        at: { type: 'string', description: 'New time, ISO 8601 with offset' },
        minutes_before_due: { type: 'number' },
        repeat: { type: 'string', enum: ['none', 'hourly', 'daily', 'weekdays', 'weekly'] },
        title: { type: 'string' },
        note: { type: 'string' },
        active: { type: 'boolean' },
        task_id: { type: 'string' },
      },
      required: ['reminder_id'],
    },
  },
  {
    name: 'remove_reminder',
    description: 'Delete a reminder (on a task or standalone) by its id.',
    input_schema: {
      type: 'object',
      properties: { reminder_id: { type: 'string' }, task_id: { type: 'string', description: 'Optional, ignored' } },
      required: ['reminder_id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently delete a task. Only when the user explicitly asks to delete or remove it (not when it is done).',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'focus_mode',
    description: 'Start or stop focus mode. While it runs, Buddy pauses check-ins and breaks (reminders still come through) and the on-screen companion wears headphones and shows a countdown. Use when the user asks to focus, do deep work, not be disturbed, or to stop/end focus mode. Default length is the user\'s setting; use the minutes they say ("focus for 25 minutes", "for an hour" = 60).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'] },
        minutes: { type: 'number', description: 'Session length in minutes (start only)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'open_report',
    description: 'Open the manager report panel and generate the daily stand-up or weekly summary for the user to review and copy.',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['daily', 'weekly'] } }, required: ['type'] },
  },
];

function taskSnapshot(tasks) {
  const cutoff = Date.now() - 14 * 86400000;
  const rows = tasks
    .filter((t) => t.status !== 'Done' || new Date(t.completedAt || t.updatedAt).getTime() > cutoff)
    .map((t) => {
      const rem = (t.reminders || []).filter((r) => r.active || r.pausedAt).map(reminderLine);
      const recent = (t.log || []).slice(-3).map((e) => `${e.type}: ${e.text}`);
      return {
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        due: localIso(t.due), progress: t.progress, from: t.assignedBy || undefined,
        desc: t.description ? t.description.slice(0, 200) : undefined,
        reminders: rem.length ? rem : undefined,
        recent: recent.length ? recent : undefined,
      };
    });
  return JSON.stringify(rows);
}

function reminderLine(r) {
  return `${r.id}@${localIso(r.nextAt)}${r.repeat !== 'none' ? `/${r.repeat}` : ''}${r.kind === 'before_due' ? `(${r.offsetMinutes}m before due)` : ''}${r.active ? '' : ' (paused)'}${r.note && r.note !== 'Snoozed' ? ` "${r.note.slice(0, 60)}"` : ''}`;
}

// Reminders not tied to a task: "id@time/repeat "title"".
function standaloneSnapshot(reminders) {
  return JSON.stringify((reminders || []).filter((r) => r.active || r.pausedAt).map((r) => `${reminderLine(r)} :: ${r.title}`));
}

function systemPrompt(settings, tasks, reminders) {
  const now = new Date();
  return `You are Buddy, a sharp, friendly work companion running on the user's Windows PC. You keep track of their tasks, reminders, status updates and blockers, help them prioritise, and prepare reports for their manager.

Now: ${now.toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (local ISO ${localIso(now.toISOString())}, UTC offset ${offsetString(now)}).
User: ${settings.userName || 'not set'}. Manager: ${settings.managerName || 'not set'}.

Current tasks (JSON): ${taskSnapshot(tasks)}
Standalone reminders (not tied to a task): ${standaloneSnapshot(reminders)}

How to work:
- Use the tools to make every change. Never claim something was saved unless a tool call succeeded.
- When confirming a date or time, copy it from the tool result (e.g. "Fri, 9 Oct, 1:01 pm"); don't work out weekdays yourself.
- One message can contain several things (e.g. a new task plus a blocker on another). Handle all of them.
- Match updates to existing tasks by meaning, not exact words. If two tasks could match, ask which one before acting.
- New task with no due date: ask once ("When's it due?"). If the user says there's no deadline, create it without one. Infer priority from words like urgent/ASAP (High or Critical); default Medium.
- Pasted plans (weekly goals, priority lists, meeting notes, emails with several action items): don't ask questions, create every actionable item right away in this turn, calling create_task once per item (all in one response).
  - One task per actionable item. A heading whose sub-bullets are details of one goal is ONE task; put the sub-bullets (condensed, keeping names, numbers and specifics) in description. Items under a heading that are separate goals each become their own task.
  - Title: short and specific (max ~8 words), include the product/project name, e.g. "Atlas v2: plan next HW revision".
  - Tags: the section/project heading (e.g. "Atlas", "Firmware", "Hiring", "Operations"); add "ongoing" for continuous support items.
  - Due: an explicit date in the item (deadline, ETA) wins; otherwise items in a "this week" plan are due this Friday 18:00; ongoing/continuous support items get no due date.
  - Priority: "Priority 1"/"P1"/top item → High; "Priority 2"/"P2" → Medium; ongoing support → Low; otherwise Medium. Use Critical only if the text says urgent/critical.
  - People to involve or sync with go in the description ("Involve Alex", "Sync with Sam"). assigned_by only if the text says who assigned the work.
  - Skip items already in Current tasks (same meaning): update those instead of duplicating.
  - Then reply with a one-line summary plus the list of created tasks as "T-n title (due)" lines, and mention any assumption you made (like the Friday due date).
- Relative dates ("Friday", "next week", "EOD") resolve against Now. EOD = 18:00. "Next week" with no day = Monday 10:00.
- Blockers: use log_update kind=blocker (this marks the task Blocked). When unblocked, kind=blocker_resolved.
- "Remind me..." → add_reminder. About a task: pass its task_id. About anything else ("remind me to call the vendor at 4", "drink water every 2 hours"): no task_id, just a short title; don't create a task for it. Repeating reminders are fine ("every morning at 9 until it's done" = daily at 09:00).
- Changing a reminder ("move it to 5", "make it daily", "pause/stop/resume the water reminder") → update_reminder with its id from the lists above; deleting → remove_reminder.
- Prioritisation questions: rank by overdue first, then due soonest, then priority, and call out blockers and clashes. Be decisive.
- Messages may come from voice transcription, so expect missing punctuation and misheard words ("tea twelve" = T-12). Interpret sensibly.
- Replies are short and conversational (they may be read aloud): 1-3 sentences, plain text, no markdown, no bullet symbols unless listing 3+ tasks. Mention task ids like T-4 when useful. Format dates naturally ("Thu 9 Oct, 5 pm").`;
}

// The AI made changes, then failed before writing its reply: report what was saved
// rather than an error, so the user doesn't retry and create duplicates.
function savedSummary(done, err) {
  const why = err.friendly ? err.friendly.split(' (')[0] : 'the AI service stopped responding';
  return `I saved these changes, but couldn't finish my reply (${why.replace(/\.$/, '')}):\n${done.join('\n')}`;
}

class AI {
  /**
   * getConnections: () => [{id, provider, model, key}] in priority order (first = main).
   * Without it, a single connection is derived from settings.provider/model and getApiKey().
   */
  constructor({ store, taskService, getApiKey, getConnections, emit, codexDir, runCodex: run, runClaude: rc, runGemini: rg, onFocus }) {
    this.onFocus = onFocus; // (action, minutes) => result text
    this.store = store;
    this.ts = taskService;
    this.getApiKey = getApiKey || (() => '');
    this.getConnections = getConnections;
    this.emit = emit;
    this.codexDir = codexDir; // scratch folder for the sign-in tools
    this.runCodex = run || runCodex;
    this.runClaude = rc || runClaude;
    this.runGemini = rg || runGemini;
    this.conn = null; // the connection in use for the current request
  }

  // Usable connections, main first. API connections need a key; sign-in ones are checked when used.
  connections() {
    const list = this.getConnections
      ? this.getConnections()
      : [{ id: 'settings', provider: this.store.data.settings.provider, model: this.store.data.settings.model, key: this.getApiKey() }];
    return list.map((c) => ({ ...c, provider: providerId(c) })).filter((c) => PROVIDERS[c.provider].noKey || c.key);
  }

  // True when the AI can be used at all.
  hasAccess() { return this.connections().length > 0; }

  // Run fn with the main connection; if it fails before changing anything, try the backups.
  // Returns {value, via, skipped} where skipped lists connections that failed first.
  async _withConnections(fn) {
    const all = this.connections();
    if (!all.length) {
      const e = new Error('NO_KEY');
      e.friendly = 'I need an AI connection before I can understand messages. Open Settings (the gear, top right) → AI connections, and sign in or add a key.';
      throw e;
    }
    const list = this.store.data.settings.useBackups === false ? all.slice(0, 1) : all;
    const skipped = [];
    let lastErr;
    for (const conn of list) {
      this.conn = conn;
      try {
        const value = await fn(conn);
        return { value, via: conn, skipped };
      } catch (err) {
        lastErr = err;
        skipped.push({ conn, reason: (err.friendly || err.message || '').split(/(?<=\.)\s/)[0] });
      } finally {
        this.conn = null;
      }
    }
    throw lastErr;
  }

  _pid() { return providerId(this.conn); }
  _model() { return modelFor(this.conn); }

  // One turn through a sign-in tool (Codex / Claude Code / Gemini CLI); returns its text.
  async _cliTurn(prompt, schema) {
    const format = PROVIDERS[this._pid()].format;
    const model = this._model();
    const workDir = this.codexDir;
    if (format === 'claudecode') return this.runClaude({ prompt, schema, model, workDir });
    if (format === 'geminicli') {
      return this.runGemini({ prompt: schema ? `${prompt}\n\nReply with ONLY a JSON object (no code fences) matching this JSON Schema:\n${JSON.stringify(schema)}` : prompt, model, workDir });
    }
    const fast = model === PROVIDERS.chatgpt.defaultModel;
    if (fast && this.fastModelUnavailable) return this.runCodex({ prompt, schema, model: '', workDir });
    try {
      return await this.runCodex({ prompt, schema, model, workDir });
    } catch (err) {
      // The built-in fast model may be retired or not on this plan: use Codex's default instead.
      if (fast && /model/i.test(`${err.friendly} ${err.detail || ''}`) && /not (found|supported|available)|unsupported|does not exist|unknown/i.test(`${err.friendly} ${err.detail || ''}`)) {
        this.fastModelUnavailable = true;
        return this.runCodex({ prompt, schema, model: '', workDir });
      }
      throw err;
    }
  }

  async _call(body) {
    const key = this.conn && this.conn.key;
    if (!key) {
      const e = new Error('NO_KEY');
      e.friendly = 'This AI connection has no API key. Open Settings → AI connections and add one.';
      throw e;
    }
    const pid = this._pid();
    const provider = PROVIDERS[pid];
    const headers = { 'content-type': 'application/json' };
    if (provider.format === 'openai') headers.authorization = `Bearer ${key}`;
    else { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
    let res;
    // Retry briefly when the provider is overloaded (e.g. Gemini 503 "high demand", Anthropic 529).
    for (const wait of [1500, 4000, 0]) {
      try {
        res = await fetch(provider.url, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (err) {
        const e = new Error('NETWORK');
        e.friendly = 'I can\'t reach the AI service right now. Check your internet connection. Your tasks and reminders still work offline, and you can edit tasks directly on the board.';
        throw e;
      }
      if (![500, 502, 503, 504, 529].includes(res.status) || !wait) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (Array.isArray(j) ? j[0] : j)?.error?.message || ''; // Gemini can wrap errors in an array
      } catch (_) {}
      const e = new Error(`HTTP ${res.status}`);
      if (pid === 'gemini' && (res.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(detail))) e.friendly = `You've hit Google Gemini's usage limit (the free tier allows a limited number of requests per minute and per day). Wait a minute and try again. (${detail})`;
      else if (res.status === 401 || res.status === 403 || /API key not valid|invalid api key/i.test(detail)) e.friendly = `${provider.name} rejected the API key. Open Settings and check the provider is right and the key was pasted fully.`;
      else if (/quota|billing|credit balance/i.test(detail)) e.friendly = `Your ${provider.name} account has no credit left. Add billing on the ${provider.name} website, then try again. (${detail})`;
      else if (res.status === 404 || /model[^.]*(not found|does not exist)|invalid model/i.test(detail)) e.friendly = `The AI model "${body.model}" wasn't found. Open Settings and check the model name. (${detail})`;
      else if (res.status === 429) e.friendly = 'The AI service is rate-limiting requests. Wait a minute and try again.';
      else if (res.status >= 500) e.friendly = `${provider.name} is having trouble right now (I tried 3 times). Try again in a moment.${detail ? ` (${detail})` : ''}`;
      else e.friendly = `The AI request failed (${res.status}). ${detail}`;
      throw e;
    }
    return res.json();
  }

  _history() {
    const recent = this.store.data.chat.slice(-24);
    const msgs = [];
    for (const m of recent) {
      const role = m.role === 'user' ? 'user' : 'assistant';
      if (!m.text) continue;
      const last = msgs[msgs.length - 1];
      if (last && last.role === role) last.content += `\n\n${m.text}`;
      else msgs.push({ role, content: m.text });
    }
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    // An alert/briefing can land after the user's message; the API needs the user turn last.
    while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();
    return msgs;
  }

  _runTool(name, input) {
    switch (name) {
      case 'create_task': {
        const t = this.ts.create(input);
        return `Created ${t.id} "${t.title}" (priority ${t.priority}, due ${t.due ? fmt(t.due) : 'none'}).`;
      }
      case 'update_task': {
        const { task_id, ...rest } = input;
        const t = this.ts.update(task_id, rest);
        return `Updated ${t.id}: status ${t.status}, priority ${t.priority}, due ${t.due ? fmt(t.due) : 'none'}, progress ${t.progress ?? '-'}%.`;
      }
      case 'log_update': {
        const t = this.ts.logUpdate(input.task_id, input.kind, input.text, input.progress);
        return `Logged ${input.kind} on ${t.id}. Status is now ${t.status}.`;
      }
      case 'add_reminder': {
        const { task, reminder } = input.task_id
          ? this.ts.addReminder(input.task_id, input)
          : this.ts.addStandaloneReminder({ ...input, title: input.title || input.note });
        const what = task ? `on ${task.id}` : `"${reminder.title}"`;
        return `Reminder ${reminder.id} set ${what} for ${fmt(reminder.nextAt)}${reminder.repeat !== 'none' ? `, repeating ${reminder.repeat}` : ''}.`;
      }
      case 'update_reminder': {
        const { reminder_id: id, task_id: taskId, ...rest } = input;
        const { task, reminder } = this.ts.updateReminder(id, { ...rest, ...(taskId !== undefined ? { taskId } : {}) });
        return `Updated reminder ${reminder.id}${task ? ` on ${task.id}` : ` "${reminder.title}"`}: ${reminder.active ? `next ${fmt(reminder.nextAt)}` : 'paused'}${reminder.repeat !== 'none' ? `, repeating ${reminder.repeat}` : ''}.`;
      }
      case 'remove_reminder': {
        const { task, r } = this.ts.deleteReminder(input.reminder_id);
        return task ? `Removed the reminder from ${task.id}.` : `Removed the reminder "${r.title}".`;
      }
      case 'delete_task': {
        const t = this.ts.remove(input.task_id);
        return `Deleted ${t.id} "${t.title}".`;
      }
      case 'focus_mode': {
        if (!this.onFocus) throw new Error('Focus mode is not available.');
        return this.onFocus(input.action === 'stop' ? 'stop' : 'start', input.minutes);
      }
      case 'open_report':
        this.emit('open-report', input.type === 'weekly' ? 'weekly' : 'daily');
        return `The ${input.type} report panel is open and generating.`;
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  // Main chat entry point. Returns the reply text. Uses the main connection, falling back to
  // the others in order if it fails before changing anything (busy, out of quota, signed out…).
  async chat() {
    const { value, via, skipped } = await this._withConnections(() => this._chatWith());
    if (!skipped.length) return value;
    const names = [...new Set(skipped.map((s) => PROVIDERS[s.conn.provider].name))].join(' and ');
    return `${value}\n\n(${names} wasn't available, so ${PROVIDERS[via.provider].name} answered.)`;
  }

  // The chat loop for the connection in use (this.conn), by request format.
  _chatWith() {
    const settings = this.store.data.settings;
    const messages = this._history();
    const format = PROVIDERS[this._pid()].format;
    if (format === 'openai') return this._chatOpenAI(settings, messages);
    if (format === 'codex' || format === 'claudecode' || format === 'geminicli') return this._chatJson(settings, messages);
    return this._chatAnthropic(settings, messages);
  }

  async _chatAnthropic(settings, messages) {
    const done = [];
    for (let i = 0; i < 8; i++) {
      let data;
      try {
        data = await this._call({
          model: this._model(),
          max_tokens: 4000, // room for a pasted plan that becomes a dozen create_task calls
          system: systemPrompt(settings, this.store.data.tasks, this.store.data.reminders),
          tools: TOOLS,
          messages,
        });
      } catch (err) {
        if (done.length) return savedSummary(done, err);
        throw err;
      }
      const content = data.content || [];
      const toolUses = content.filter((c) => c.type === 'tool_use');
      if (!toolUses.length || data.stop_reason !== 'tool_use') {
        return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() || 'Done.';
      }
      messages.push({ role: 'assistant', content });
      const results = toolUses.map((tu) => {
        try {
          const content = this._runTool(tu.name, tu.input || {});
          done.push(content);
          return { type: 'tool_result', tool_use_id: tu.id, content };
        } catch (err) {
          return { type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true };
        }
      });
      messages.push({ role: 'user', content: results });
    }
    return 'I made the changes, but that took more steps than expected. Check the board to confirm everything looks right.';
  }

  // Same tool loop as chat(), in the Chat Completions format (OpenAI and Gemini).
  async _chatOpenAI(settings, history) {
    const pid = this._pid();
    const { tokenParam } = PROVIDERS[pid];
    const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: flatSchema(t.input_schema) } }));
    const messages = [{ role: 'system', content: '' }, ...history];
    const done = [];
    for (let i = 0; i < 8; i++) {
      messages[0].content = systemPrompt(settings, this.store.data.tasks, this.store.data.reminders);
      let data;
      try {
        data = await this._call({ model: this._model(), [tokenParam]: 4000, tools, messages });
      } catch (err) {
        if (done.length) return savedSummary(done, err);
        throw err;
      }
      const msg = data.choices?.[0]?.message || {};
      const calls = msg.tool_calls || [];
      if (!calls.length) return String(msg.content || '').trim() || 'Done.';
      // Pass tool_calls back untouched: Gemini attaches thought signatures it expects to see again.
      messages.push({ role: 'assistant', tool_calls: calls, ...(msg.content ? { content: msg.content } : {}) });
      for (const c of calls) {
        let content;
        try { content = this._runTool(c.function.name, JSON.parse(c.function.arguments || '{}')); done.push(content); }
        catch (err) { content = `Error: ${err.message}`; }
        messages.push({ role: 'tool', tool_call_id: c.id ?? '', content, ...(pid === 'gemini' ? { name: c.function.name } : {}) });
      }
    }
    return 'I made the changes, but that took more steps than expected. Check the board to confirm everything looks right.';
  }

  // Sign-in tools (Codex / Claude Code / Gemini CLI): no native tool calls, so each turn returns
  // {actions, reply} as JSON. Buddy runs the actions; if any fail, the AI sees the results and
  // gets one more turn to fix them and correct its reply.
  async _chatJson(settings, history) {
    const toolDocs = TOOLS.map((t) => {
      const s = flatSchema(t.input_schema);
      return `- ${t.name}: ${t.description}\n  input fields: ${JSON.stringify(s.properties)}; required: ${JSON.stringify(s.required || [])}`;
    }).join('\n');
    const transcript = history.map((m) => `${m.role === 'user' ? 'User' : 'Buddy'}: ${m.content}`).join('\n\n');
    const done = [];
    let results = '';
    for (let round = 0; round < 3; round++) {
      const prompt = `${CODEX_NOTE}

${systemPrompt(settings, this.store.data.tasks, this.store.data.reminders)}

Tools (to use one, add {"tool": name, "input_json": "<the input as a JSON object string>"} to "actions"):
${toolDocs}

Conversation:
${transcript}
${results}
Answer the last User message as one JSON object: "actions" lists every tool call to make (empty if none), "reply" is what Buddy says. Write the reply as if the actions succeed.`;
      let out;
      try { out = await this._cliTurn(prompt, CODEX_SCHEMA); } catch (err) {
        if (done.length) return savedSummary(done, err);
        throw err;
      }
      const { actions = [], reply = '' } = parseCodexJson(out);
      if (!actions.length) return String(reply).trim() || 'Done.';
      const lines = [];
      let failed = false;
      for (const a of actions) {
        try {
          const input = typeof a.input_json === 'string' ? JSON.parse(a.input_json || '{}') : (a.input || {});
          const r = this._runTool(a.tool, input);
          done.push(r); lines.push(`- ${a.tool}: ${r}`);
        } catch (err) { failed = true; lines.push(`- ${a.tool}: Error: ${err.message}`); }
      }
      if (!failed) return String(reply).trim() || 'Done.';
      results = `\nResults of the actions you asked for (already applied where they succeeded; do not repeat those):\n${lines.join('\n')}\n`;
    }
    return 'I made the changes I could, but some failed. Check the board to confirm everything looks right.';
  }

  // Single-turn text completion (used for reports), with backup connections.
  async _complete(prompt) {
    return (await this._withConnections(() => this._completeWith(prompt))).value;
  }

  // Check one specific connection end to end (Settings → Test). Returns the reply text.
  async testConnection(conn) {
    this.conn = conn;
    try { return await this._completeWith('Reply with exactly: Connected'); } finally { this.conn = null; }
  }

  async _completeWith(prompt) {
    const model = this._model();
    const provider = PROVIDERS[this._pid()];
    if (provider.noKey) {
      return (await this._cliTurn(`${CODEX_NOTE}\n\n${prompt}\n\nReply with the finished text only.`)).trim();
    }
    if (provider.format === 'openai') {
      const data = await this._call({ model, [provider.tokenParam]: 4000, messages: [{ role: 'user', content: prompt }] });
      return String(data.choices?.[0]?.message?.content || '').trim();
    }
    const data = await this._call({ model, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
    return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  }

  async report(type) {
    const settings = this.store.data.settings;
    const facts = gather(this.store.data.tasks, type);
    const fallback = buildFallback(facts, settings);
    const hasContent = facts.activity.length || facts.inProgress.length || facts.completed.length || facts.blocked.length || facts.upcoming.length;
    if (!this.hasAccess() || !hasContent) return { text: fallback, ai: false };

    const brief = type === 'daily'
      ? 'a daily stand-up update with three short sections: "Yesterday" (what got done or progressed since the last working day), "Today" (what I am focusing on, most important first), and "Blockers" (or "None").'
      : 'a weekly status summary with sections: "Completed", "In progress" (with % or status), "Coming up" (deadlines in the next week), "Risks and blockers", and "New this week" if any were added.';
    const prompt = `Write ${brief}

It goes from ${settings.userName || 'me'} to ${settings.managerName || 'my manager'} and will be pasted into email or Teams. Rules: plain text only (no markdown symbols like ** or #); section titles on their own line followed by "- " bullet lines; first person; concise and specific; group small related items; use only the facts below and never invent work; mention dates in a short natural form. Start with a one-line greeting${settings.managerName ? ` to ${settings.managerName}` : ''} and end with no sign-off.

Facts (JSON, times in UTC, my offset is ${offsetString()}):
${JSON.stringify(facts)}`;
    try {
      const text = await this._complete(prompt);
      return { text: text || fallback, ai: !!text };
    } catch (err) {
      return { text: fallback, ai: false, note: err.friendly || err.message };
    }
  }
}

module.exports = { AI, PROVIDERS };
