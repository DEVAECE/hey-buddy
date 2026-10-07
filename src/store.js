// Local persistence: one JSON file in the user's AppData folder.
// Writes are atomic (temp file + rename) and a rolling backup is kept.
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  userName: '',
  managerName: '',
  provider: 'anthropic',  // legacy single connection; moved into `connections` on first start
  connections: undefined, // [{id, type, model, keyEnc, keyPlain}], main first (see main.js)
  useBackups: true,       // if the main connection fails, try the others in order
  model: 'claude-sonnet-5-5',
  apiKeyEnc: '',          // encrypted with Windows DPAPI via safeStorage
  apiKeyPlain: '',        // only used if encryption is unavailable
  briefingEnabled: true,
  briefingTime: '09:00',
  briefingWeekdaysOnly: true,
  dueTimeAlerts: true,
  wakeWordEnabled: true,
  wakeSensitivity: 'normal', // strict | normal | relaxed
  micDeviceId: '',            // '' = Windows default microphone
  speakReplies: true,
  voiceName: '',
  speechRate: 1.0,
  startWithWindows: true,
  chimeEnabled: true,
  // On-screen companion
  companionPeek: true,        // sit in the screen corner all the time (false = only appear for triggers)
  companionCorner: 'br',      // br | bl | tr | tl (set by dragging the character or in Settings)
  companionDisplay: null,     // id of the screen it was dropped on (null = primary)
  companionCharacter: 'pixel', // pixel (robot) | man | woman | custom
  moodsEnabled: true,         // focused Monday, happy Friday, chilled weekend, sleepy at night
  focusMinutes: 50,           // default focus session length
  customCharacterVersion: 0,  // bumped when custom images change (cache-busting)
  workStart: '09:30',
  workEnd: '18:30',
  workWeekdaysOnly: true,
  checkinMinutes: 90,         // focus check-in interval, 0 = off
  breakMinutes: 60,           // water/stretch break interval, 0 = off
  breakKind: 'both',          // water | stretch | both
  wrapupEnabled: true,
  wrapupTime: '18:00',
  welcomeBackMinutes: 20,     // greet after being away this long, 0 = off
};

function emptyData() {
  return {
    version: 1,
    tasks: [],
    reminders: [], // standalone reminders (not tied to a task)
    chat: [],
    settings: { ...DEFAULT_SETTINGS },
    meta: {
      nextId: 1, lastBriefing: null,
      lastCheckin: 0, lastBreak: 0, lastTrigger: 0, lastWrapup: null, nextBreakKind: 'water',
      water: { day: null, count: 0 }, quietUntil: 0, focusUntil: 0, focusMinutes: 0,
    },
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'buddy-data.json');
    this.backup = path.join(dir, 'buddy-data.backup.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
    this._timer = null;
  }

  _load() {
    for (const f of [this.file, this.backup]) {
      try {
        if (fs.existsSync(f)) {
          const d = JSON.parse(fs.readFileSync(f, 'utf8'));
          return this._migrate(d);
        }
      } catch (e) {
        console.error('Could not read', f, e);
      }
    }
    return emptyData();
  }

  _migrate(d) {
    const base = emptyData();
    return {
      ...base,
      ...d,
      settings: { ...base.settings, ...(d.settings || {}) },
      meta: { ...base.meta, ...(d.meta || {}) },
      tasks: Array.isArray(d.tasks) ? d.tasks : [],
      reminders: Array.isArray(d.reminders) ? d.reminders : [],
      chat: Array.isArray(d.chat) ? d.chat : [],
    };
  }

  save() {
    // debounce bursts of changes
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    clearTimeout(this._timer);
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.backup); } catch (_) {}
      }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Save failed', e);
    }
  }

  newTaskId() {
    const id = `T-${this.data.meta.nextId}`;
    this.data.meta.nextId += 1;
    return id;
  }

  findTask(id) {
    if (!id) return null;
    const norm = String(id).trim().toUpperCase().replace(/^T\s*-?\s*/, 'T-');
    return this.data.tasks.find((t) => t.id === norm || t.id === id) || null;
  }

  replaceAll(newData) {
    this.data = this._migrate(newData);
    this.saveNow();
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
