const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, protocol, net, screen,
  session, safeStorage, globalShortcut, powerMonitor, dialog, clipboard, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { Store } = require('./src/store');
const { TaskService } = require('./src/tasks');
const { AI } = require('./src/ai');
const { Scheduler, inWorkHours } = require('./src/scheduler');
const { quickReply } = require('./src/quick');
const { PROVIDERS } = require('./src/ai');
const { signInStatus, openSignInWindow, isInstalled } = require('./src/cli');

const CLI_FOR = { chatgpt: 'codex', claude: 'claude', google: 'gemini' }; // sign-in connection → its tool

const APP_ID = 'com.buddy.workcompanion';
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let mainWin = null;
let companionWin = null;
let companionReady = false;
let companionPending = [];
let tray = null;
let quitting = false;
let store, tasks, ai, scheduler;

const ICON = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');

// ---------- helpers ----------
// ---------- AI connections ----------
// settings.connections: [{id, type, model, keyEnc, keyPlain}] in priority order (first = main).
// type is a provider id from src/ai.js: chatgpt | claude | google (sign-in) or anthropic | openai | gemini (API key).
const encryptKey = (k) => (safeStorage.isEncryptionAvailable()
  ? { keyEnc: safeStorage.encryptString(k).toString('base64'), keyPlain: '' }
  : { keyEnc: '', keyPlain: k });
function decryptKey(c) {
  if (c.keyEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(c.keyEnc, 'base64')); } catch (_) { return ''; }
  }
  return c.keyPlain || '';
}
const newConnId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// One-time move from the single provider/key setting to the connections list.
function migrateConnections() {
  const s = store.data.settings;
  if (Array.isArray(s.connections)) return;
  s.connections = [];
  if (s.provider === 'chatgpt') s.connections.push({ id: newConnId(), type: 'chatgpt', model: s.model || '' });
  else if (s.apiKeyEnc || s.apiKeyPlain) s.connections.push({ id: newConnId(), type: s.provider || 'anthropic', model: s.model || '', keyEnc: s.apiKeyEnc || '', keyPlain: s.apiKeyPlain || '' });
  store.saveNow();
}

// For the AI: usable connections, main first, keys decrypted.
const getConnections = () => (store.data.settings.connections || []).map((c) => ({ id: c.id, provider: c.type, model: c.model || '', key: decryptKey(c) }));

// For the renderer: never includes keys.
const publicConnections = () => (store.data.settings.connections || []).map((c) => ({ id: c.id, type: c.type, model: c.model || '', hasKey: !!(c.keyEnc || c.keyPlain) }));

function stripSecrets(settings) {
  const { apiKeyEnc, apiKeyPlain, connections, ...rest } = settings;
  return rest;
}

function publicState() {
  const settings = { ...stripSecrets(store.data.settings), connections: publicConnections() };
  return {
    tasks: store.data.tasks,
    reminders: store.data.reminders || [], // standalone reminders (task reminders live on each task)
    chat: store.data.chat.slice(-200),
    settings: { ...settings, hasKey: ai.hasAccess() }, // "hasKey" = AI is usable (key saved, or ChatGPT sign-in)
    meta: store.data.meta,
    version: app.getVersion(),
  };
}

let pushTimer = null;
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('state', publicState());
  }, 60);
}

function emit(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

function addChat(role, text, extra = {}) {
  const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), role, text, at: new Date().toISOString(), ...extra };
  store.data.chat.push(entry);
  if (store.data.chat.length > 500) store.data.chat.splice(0, store.data.chat.length - 500);
  store.save();
  pushState();
  return entry;
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow(true);
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: !!store.data.settings.startWithWindows,
    path: process.execPath,
    args: ['--hidden'],
  });
}

// ---------- windows ----------
function createMainWindow(show) {
  mainWin = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 920,
    minHeight: 600,
    show: false,
    title: 'Buddy',
    icon: ICON,
    backgroundColor: '#E9EDF1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep the wake word listening while hidden
    },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadURL('app://buddy/index.html');
  mainWin.once('ready-to-show', () => { if (show) mainWin.show(); });

  // Windows is shutting down / signing out: write any pending change to disk right away.
  mainWin.on('query-session-end', () => { if (store) store.saveNow(); });
  mainWin.on('session-end', () => { quitting = true; if (store) store.saveNow(); });

  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWin.hide();
    if (!store.data.meta.trayHintShown) {
      store.data.meta.trayHintShown = true;
      store.save();
      companionShow([{ kind: 'info', text: 'I\'m still here! I\'ll keep tracking your reminders from the corner of the screen and the system tray. Click me, say "Hey Buddy" or press Ctrl+Alt+B to open the full window.' }]);
    }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- companion (the on-screen character) ----------
// A transparent, always-on-top window in the bottom-right corner. It ignores the mouse
// except over the character and its speech bubble (the renderer reports which).
const COMPANION_W = 460;
const COMPANION_H = 440;

const CORNERS = ['br', 'bl', 'tr', 'tl'];

// Where the window sits: the chosen corner of the chosen screen (primary if that screen is gone).
function companionBounds() {
  const s = store.data.settings;
  const display = screen.getAllDisplays().find((d) => d.id === s.companionDisplay) || screen.getPrimaryDisplay();
  const wa = display.workArea;
  const c = CORNERS.includes(s.companionCorner) ? s.companionCorner : 'br';
  return {
    x: c[1] === 'r' ? wa.x + wa.width - COMPANION_W : wa.x,
    y: c[0] === 'b' ? wa.y + wa.height - COMPANION_H : wa.y,
    width: COMPANION_W, height: COMPANION_H,
  };
}

let glideTimer = null;
function placeCompanion(animate = false) {
  if (!companionWin || companionWin.isDestroyed()) return;
  clearInterval(glideTimer);
  const to = companionBounds();
  if (!animate) { companionWin.setBounds(to); return; }
  const from = companionWin.getBounds();
  let i = 0; const steps = 8;
  glideTimer = setInterval(() => {
    i += 1;
    const k = 1 - (1 - i / steps) ** 3; // ease-out
    companionWin.setBounds({ ...to, x: Math.round(from.x + (to.x - from.x) * k), y: Math.round(from.y + (to.y - from.y) * k) });
    if (i >= steps) clearInterval(glideTimer);
  }, 16);
}

// Dragging: the renderer reports screen coordinates; on release, snap to the nearest corner
// of whichever screen the character was dropped on, and remember it.
let dragStart = null;
function companionDrag(phase, sx, sy) {
  if (!companionWin || companionWin.isDestroyed()) return;
  if (phase === 'start') {
    clearInterval(glideTimer);
    const b = companionWin.getBounds();
    dragStart = { sx, sy, x: b.x, y: b.y };
  } else if (phase === 'move' && dragStart) {
    companionWin.setBounds({ x: Math.round(dragStart.x + sx - dragStart.sx), y: Math.round(dragStart.y + sy - dragStart.sy), width: COMPANION_W, height: COMPANION_H });
  } else if (phase === 'end' && dragStart) {
    dragStart = null;
    const b = companionWin.getBounds();
    // Judge by where the character is: it sits near the window's current corner.
    const cur = store.data.settings.companionCorner || 'br';
    const cx = cur[1] === 'l' ? b.x + 70 : b.x + b.width - 70;
    const cy = cur[0] === 't' ? b.y + 90 : b.y + b.height - 70;
    const display = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
    const wa = display.workArea;
    const corner = `${cy < wa.y + wa.height / 2 ? 't' : 'b'}${cx < wa.x + wa.width / 2 ? 'l' : 'r'}`;
    store.data.settings.companionCorner = corner;
    store.data.settings.companionDisplay = display.id;
    store.save();
    companionSend({ type: 'corner', corner });
    pushState();
    placeCompanion(true);
  }
}

function createCompanion() {
  companionWin = new BrowserWindow({
    ...companionBounds(),
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, focusable: true, title: 'Buddy companion',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  companionWin.setAlwaysOnTop(true, 'floating');
  companionWin.setIgnoreMouseEvents(true, { forward: true });
  companionWin.loadURL('app://buddy/companion.html');
  companionWin.on('closed', () => { companionWin = null; companionReady = false; });
}

function companionSettings() {
  return stripSecrets(store.data.settings);
}

function companionSend(msg) {
  if (!companionWin || companionWin.isDestroyed()) return;
  if (!companionReady) { companionPending.push(msg); return; }
  companionWin.webContents.send('companion', msg);
}

function companionShow(items) {
  if (!companionWin || companionWin.isDestroyed()) createCompanion();
  companionSend({ type: 'show', items });
}

// Hide the idle character (and skip check-ins/breaks) for a while. Reminders still appear.
function setQuiet(minutes) {
  store.data.meta.quietUntil = minutes ? Date.now() + minutes * 60000 : 0;
  store.save();
  companionSend({ type: 'quiet', until: store.data.meta.quietUntil });
  refreshTrayMenu();
  if (minutes) setTimeout(refreshTrayMenu, minutes * 60000 + 1000);
}

// ---------- focus mode ----------
function setFocus(action, minutes) {
  if (action === 'stop') {
    const r = scheduler.stopFocus();
    companionSend({ type: 'focus', until: 0 });
    companionSend({ type: 'quiet', until: store.data.meta.quietUntil || 0 });
    refreshTrayMenu();
    return r.wasOn ? `Focus mode stopped after ${r.elapsed} min.` : 'Focus mode was not on.';
  }
  const r = scheduler.startFocus(minutes);
  companionSend({ type: 'focus', until: r.until, minutes: r.minutes });
  companionSend({ type: 'quiet', until: store.data.meta.quietUntil });
  refreshTrayMenu();
  setTimeout(refreshTrayMenu, r.minutes * 60000 + 25000);
  const end = new Date(r.until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `Focus mode on for ${r.minutes} min, until ${end}. Check-ins and breaks are paused; reminders still come through.`;
}

// ---------- presence: away / back ----------
// "Away" = screen locked, PC asleep, or no keyboard/mouse input for IDLE_SECS.
const IDLE_SECS = 300;
let locked = false;
let awaySince = 0;
let lastAwayState = null;

function markAway(since = Date.now()) { if (!awaySince) awaySince = since; }

function backFromAway() {
  if (!awaySince) return;
  const away = Date.now() - awaySince;
  awaySince = 0;
  const mins = Number(store.data.settings.welcomeBackMinutes) || 0;
  if (mins > 0 && away >= mins * 60000) {
    // Let the scheduler deliver missed reminders first; the catch-up follows them.
    setTimeout(() => {
      store.data.meta.lastTrigger = Date.now();
      companionShow([scheduler.buildWelcomeBack(away)]);
    }, 4000);
  }
}

function pollPresence() {
  const idle = powerMonitor.getSystemIdleTime();
  if (idle >= IDLE_SECS) markAway(Date.now() - idle * 1000);
  else if (!locked && idle < 60) backFromAway();
  const away = locked || idle >= IDLE_SECS || !inWorkHours(Date.now(), store.data.settings);
  if (away !== lastAwayState) { lastAwayState = away; companionSend({ type: 'away', away }); }
}

// ---------- tray ----------
function buildTray() {
  const img = nativeImage.createFromPath(fs.existsSync(TRAY_ICON) ? TRAY_ICON : ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Buddy - work companion');
  tray.on('click', () => (mainWin && mainWin.isVisible() && mainWin.isFocused() ? mainWin.hide() : showMain()));
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const s = store.data.settings;
  const open = store.data.tasks.filter((t) => t.status !== 'Done');
  const overdue = open.filter((t) => t.due && new Date(t.due) < new Date()).length;
  tray.setToolTip(`Buddy - ${open.length} open${overdue ? `, ${overdue} overdue` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Buddy', click: showMain },
    { type: 'separator' },
    { label: 'Listen for "Hey Buddy"', type: 'checkbox', checked: !!s.wakeWordEnabled, click: (item) => {
      s.wakeWordEnabled = item.checked; store.save(); pushState(); emit('voice-toggle', item.checked);
    } },
    { label: 'Show Buddy on screen', type: 'checkbox', checked: !!s.companionPeek, click: (item) => {
      s.companionPeek = item.checked; store.save(); pushState(); companionSend({ type: 'settings', settings: companionSettings() });
    } },
    Date.now() < (store.data.meta.focusUntil || 0)
      ? { label: `Stop focus mode (until ${new Date(store.data.meta.focusUntil).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})`, click: () => setFocus('stop') }
      : { label: `Focus mode (${Number(s.focusMinutes) || 50} min)`, click: () => setFocus('start') },
    Date.now() < (store.data.meta.focusUntil || 0) ? null
      : Date.now() < (store.data.meta.quietUntil || 0)
        ? { label: 'Resume check-ins and breaks', click: () => setQuiet(0) }
        : { label: 'Quiet for 1 hour (reminders only)', click: () => setQuiet(60) },
    { type: 'separator' },
    { label: 'Daily stand-up', click: () => { showMain(); emit('open-report', 'daily'); } },
    { label: 'Weekly summary', click: () => { showMain(); emit('open-report', 'weekly'); } },
    { type: 'separator' },
    { label: 'Quit Buddy', click: () => { quitting = true; app.quit(); } },
  ].filter(Boolean)));
}

// ---------- chat ----------
let chatChain = Promise.resolve();
let answeredUserId = null;
let companionVoice = false; // the current voice command was started from the companion

// meta: { voice, companion, prompt, kind }. `prompt` is the companion's question (e.g. a
// check-in) that this text answers; it goes into the chat first so the AI has the context.
function sendMessage(text, meta = {}) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  if (meta.prompt) addChat('buddy', meta.prompt, { kind: meta.kind || 'checkin' });
  addChat('user', clean, meta.voice ? { voice: true } : {});
  const toCompanion = !!(meta.companion || (meta.voice && companionVoice));
  companionVoice = false;
  emit('thinking', true);
  if (toCompanion) companionSend({ type: 'thinking', text: clean });
  chatChain = chatChain.then(async () => {
    // Messages sent in quick succession are all answered by the first call that sees them.
    const lastUser = [...store.data.chat].reverse().find((m) => m.role === 'user');
    if (!lastUser || lastUser.id === answeredUserId) { emit('thinking', false); return; }
    answeredUserId = lastUser.id;
    // Common requests ("what's due today?", "focus mode", "T-3 done") are answered instantly
    // from local data, as long as this is the only message waiting for an answer.
    const idx = store.data.chat.indexOf(lastUser);
    const quick = store.data.chat[idx - 1]?.role !== 'user' ? quickReply(lastUser.text, {
      tasks: store.data.tasks,
      reminders: store.data.reminders || [],
      focus: (action, minutes) => setFocus(action, minutes),
      markDone: (id) => tasks.update(id, { status: 'Done' }),
    }) : null;
    if (quick) {
      addChat('buddy', quick);
      emit('reply', { text: quick, voice: !!meta.voice });
      if (toCompanion) companionSend({ type: 'reply', text: quick });
      emit('thinking', false);
      return;
    }
    try {
      const reply = await ai.chat();
      addChat('buddy', reply);
      emit('reply', { text: reply, voice: !!meta.voice });
      if (toCompanion) companionSend({ type: 'reply', text: reply });
    } catch (err) {
      const msg = err.friendly || `Something went wrong: ${err.message}`;
      addChat('buddy', msg, { error: true });
      emit('reply', { text: msg, voice: !!meta.voice, error: true });
      if (toCompanion) companionSend({ type: 'reply', text: msg, error: true });
    } finally {
      emit('thinking', false);
    }
  });
  return true;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('get-state', () => publicState());

  ipcMain.handle('send-message', (_e, text, meta = {}) => sendMessage(text, { voice: !!meta.voice }));

  const wrap = (fn) => async (_e, ...args) => {
    try { return { ok: true, result: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  };

  ipcMain.handle('task-create', wrap((fields) => tasks.create(fields)));
  ipcMain.handle('task-update', wrap((id, fields) => tasks.update(id, fields)));
  ipcMain.handle('task-log', wrap((id, kind, text, progress) => tasks.logUpdate(id, kind, text, progress)));
  ipcMain.handle('task-delete', wrap((id) => tasks.remove(id)));
  ipcMain.handle('reminder-add', wrap((id, r) => tasks.addReminder(id, r)));
  ipcMain.handle('reminder-remove', wrap((id, rid) => tasks.removeReminder(id, rid)));
  // Reminders section: any reminder (on a task or standalone), by reminder id
  ipcMain.handle('rem-add', wrap(({ taskId, ...r } = {}) => (taskId ? tasks.addReminder(taskId, r) : tasks.addStandaloneReminder(r)).reminder.id));
  ipcMain.handle('rem-update', wrap((rid, fields) => tasks.updateReminder(rid, fields).reminder.id));
  ipcMain.handle('rem-delete', wrap((rid) => { tasks.deleteReminder(rid); return true; }));

  ipcMain.handle('report', wrap((type) => ai.report(type)));
  // AI connections (Settings → AI connections)
  const conns = () => store.data.settings.connections;
  const findConn = (id) => {
    const c = conns().find((x) => x.id === id);
    if (!c) throw new Error('That connection no longer exists.');
    return c;
  };
  const connsChanged = () => { store.saveNow(); pushState(); };
  ipcMain.handle('conn-add', wrap(({ type, key, model } = {}) => {
    if (!PROVIDERS[type]) throw new Error('Unknown connection type.');
    if (!PROVIDERS[type].noKey && !String(key || '').trim()) throw new Error('Paste the API key first.');
    const c = { id: newConnId(), type, model: String(model || '').trim() };
    if (key && String(key).trim()) Object.assign(c, encryptKey(String(key).trim()));
    conns().push(c);
    connsChanged();
    return c.id;
  }));
  ipcMain.handle('conn-update', wrap(({ id, key, model } = {}) => {
    const c = findConn(id);
    if (model !== undefined) c.model = String(model || '').trim();
    if (key !== undefined && String(key).trim()) Object.assign(c, encryptKey(String(key).trim()));
    connsChanged();
    return true;
  }));
  ipcMain.handle('conn-remove', wrap((id) => {
    store.data.settings.connections = conns().filter((c) => c.id !== id);
    connsChanged();
    return true;
  }));
  ipcMain.handle('conn-main', wrap((id) => { // move to the top: the main connection
    const c = findConn(id);
    store.data.settings.connections = [c, ...conns().filter((x) => x !== c)];
    connsChanged();
    return true;
  }));
  ipcMain.handle('conn-status', wrap(async (id) => {
    const c = findConn(id);
    if (!PROVIDERS[c.type].noKey) return c.keyEnc || c.keyPlain ? { state: 'ok', text: 'Key saved' } : { state: 'signin', text: 'No key' };
    return signInStatus(CLI_FOR[c.type]);
  }));
  ipcMain.handle('conn-test', async (_e, id) => {
    try {
      const c = findConn(id);
      const reply = await ai.testConnection({ id: c.id, provider: c.type, model: c.model || '', key: decryptKey(c) });
      return { ok: true, result: reply };
    } catch (err) { return { ok: false, error: err.friendly || err.message }; }
  });
  ipcMain.handle('conn-signin', wrap((id) => {
    const c = findConn(id);
    const tool = CLI_FOR[c.type];
    if (!tool) throw new Error('This connection uses an API key; paste it instead.');
    openSignInWindow(tool, { install: !isInstalled(tool) });
    return true;
  }));
  ipcMain.handle('copy-text', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

  ipcMain.handle('clear-chat', () => { store.data.chat = []; store.save(); pushState(); return true; });

  ipcMain.handle('settings-save', wrap((partial) => {
    const s = store.data.settings;
    // Secrets and connections have their own handlers (conn-*); never take them from the form.
    const { apiKey, apiKeyEnc, apiKeyPlain, connections, ...rest } = partial || {};
    Object.assign(s, rest);
    store.saveNow();
    applyLoginItem();
    refreshTrayMenu();
    pushState();
    companionSend({ type: 'settings', settings: companionSettings() });
    placeCompanion(true); // the corner may have changed
    lastAwayState = null; // re-evaluate work hours with the new settings
    return true;
  }));

  // Custom character art: the renderer removes the background and sends back a PNG.
  const characterDir = () => path.join(app.getPath('userData'), 'character');
  ipcMain.handle('character-pick', wrap(async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: 'Choose a character image', properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
    if (canceled || !filePaths?.[0]) return null;
    const ext = path.extname(filePaths[0]).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext};base64,${fs.readFileSync(filePaths[0]).toString('base64')}`;
  }));
  ipcMain.handle('character-save', wrap((pose, dataUrl) => {
    if (!['idle', 'talk'].includes(pose)) throw new Error('Unknown pose.');
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) throw new Error('Expected a PNG image.');
    fs.mkdirSync(characterDir(), { recursive: true });
    fs.writeFileSync(path.join(characterDir(), `${pose}.png`), Buffer.from(m[1], 'base64'));
    if (pose === 'idle') { // a new standing pose starts a new character: drop any old talking pose
      try { fs.unlinkSync(path.join(characterDir(), 'talk.png')); } catch (_) {}
    }
    store.data.settings.customCharacterVersion = Date.now();
    store.saveNow();
    pushState();
    companionSend({ type: 'settings', settings: companionSettings() });
    return store.data.settings.customCharacterVersion;
  }));

  // Companion window
  ipcMain.on('companion-ready', () => {
    companionReady = true;
    companionWin.webContents.send('companion', { type: 'settings', settings: companionSettings() });
    companionWin.webContents.send('companion', { type: 'quiet', until: store.data.meta.quietUntil || 0 });
    companionWin.webContents.send('companion', { type: 'focus', until: store.data.meta.focusUntil || 0, minutes: store.data.meta.focusMinutes || 0 });
    lastAwayState = null;
    pollPresence();
    for (const msg of companionPending.splice(0)) companionWin.webContents.send('companion', msg);
    companionWin.showInactive();
  });
  ipcMain.on('companion-drag', (_e, phase, x, y) => companionDrag(phase, Number(x), Number(y)));
  ipcMain.on('companion-mouse', (_e, on) => {
    if (companionWin && !companionWin.isDestroyed()) companionWin.setIgnoreMouseEvents(!on, { forward: true });
  });
  ipcMain.handle('companion-action', async (_e, a = {}) => {
    try {
      switch (a.action) {
        case 'done': tasks.update(a.taskId, { status: 'Done' }); addChat('buddy', `Marked ${a.taskId} as done.`); return true;
        case 'snooze':
          if (a.taskId) tasks.snooze(a.taskId, a.minutes || 15);
          else if (a.reminderId) tasks.snoozeReminder(a.reminderId, a.minutes || 15);
          return true;
        case 'reminder-stop': // standalone repeating reminder: "Stop reminding me"
          tasks.updateReminder(a.reminderId, { active: false });
          return true;
        case 'open':
          showMain();
          if (a.taskId) emit('focus-task', a.taskId);
          else if (a.reminderId) emit('focus-reminder', a.reminderId);
          return true;
        case 'report': showMain(); emit('open-report', a.type === 'weekly' ? 'weekly' : 'daily'); return true;
        case 'say': return sendMessage(a.text, { companion: true, prompt: a.prompt, kind: a.kind });
        case 'snooze-trigger': scheduler.snoozeTrigger(a.kind, a.minutes || 10); return true;
        case 'water': return { count: scheduler.drankWater() };
        case 'hide': setQuiet(a.minutes || 60); return true;
        case 'focus': return { text: setFocus('start', a.minutes) };
        case 'focus-stop': return { text: setFocus('stop') };
        case 'voice-cancel': emit('voice-cancel'); return true;
        default: return false;
      }
    } catch (err) {
      console.error(err);
      return { error: err.message };
    }
  });

  ipcMain.handle('export-data', wrap(async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      title: 'Back up Buddy data',
      defaultPath: `buddy-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Buddy backup', extensions: ['json'] }],
    });
    if (canceled || !filePath) return false;
    const copy = JSON.parse(JSON.stringify(store.data));
    copy.settings.apiKeyEnc = ''; copy.settings.apiKeyPlain = '';
    copy.settings.connections = (copy.settings.connections || []).map((c) => ({ ...c, keyEnc: '', keyPlain: '' }));
    fs.writeFileSync(filePath, JSON.stringify(copy, null, 2), 'utf8');
    return filePath;
  }));

  ipcMain.handle('import-data', wrap(async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: 'Restore Buddy backup', properties: ['openFile'], filters: [{ name: 'Buddy backup', extensions: ['json'] }],
    });
    if (canceled || !filePaths?.[0]) return false;
    const incoming = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (!Array.isArray(incoming.tasks)) throw new Error('That file is not a Buddy backup.');
    const keep = { apiKeyEnc: store.data.settings.apiKeyEnc, apiKeyPlain: store.data.settings.apiKeyPlain, connections: store.data.settings.connections };
    store.replaceAll(incoming);
    Object.assign(store.data.settings, keep);
    store.saveNow();
    pushState();
    return true;
  }));

  ipcMain.handle('open-data-folder', () => shell.openPath(app.getPath('userData')));
  ipcMain.on('quit-app', () => { quitting = true; app.quit(); });
  ipcMain.handle('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

  ipcMain.on('wake', () => {
    // Wake word heard: if the user isn't already in the main window, the companion listens
    // in its bubble. Without a companion, surface the main window.
    if (mainWin.isVisible() && mainWin.isFocused()) return;
    if (companionWin && !companionWin.isDestroyed()) { companionVoice = true; companionSend({ type: 'listen' }); return; }
    if (!mainWin.isVisible()) mainWin.showInactive();
    mainWin.moveTop();
  });
  ipcMain.on('voice-partial', (_e, text) => { if (companionVoice) companionSend({ type: 'partial', text: String(text || '') }); });
  ipcMain.on('voice-end', () => { if (companionVoice) companionSend({ type: 'listen-end' }); companionVoice = false; });
  ipcMain.on('show-main', () => showMain());
}

// ---------- app lifecycle ----------
app.setAppUserModelId(APP_ID);

app.on('second-instance', () => showMain());

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  tasks = new TaskService(store, () => { pushState(); refreshTrayMenu(); });
  migrateConnections();
  ai = new AI({ store, taskService: tasks, getConnections, emit, codexDir: path.join(app.getPath('userData'), 'codex-work'), onFocus: (action, minutes) => setFocus(action, minutes) });

  const rendererDir = path.join(__dirname, 'renderer');
  const modelDir = path.join(__dirname, 'assets', 'model');
  const voskDir = path.join(__dirname, 'node_modules', 'vosk-browser', 'dist');
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    let base = rendererDir;
    if (rel.startsWith('model/')) { base = modelDir; rel = rel.slice(6); }
    else if (rel.startsWith('character/')) { base = path.join(app.getPath('userData'), 'character'); rel = rel.slice(10); }
    else if (rel === 'vendor/vosk.js') { base = voskDir; rel = 'vosk.js'; }
    const full = path.normalize(path.join(base, rel || 'index.html'));
    if (!full.startsWith(base + path.sep)) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(full)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(full).toString());
  });

  // Microphone permission for the wake word / dictation
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  registerIpc();
  createMainWindow(!startHidden);
  createCompanion();
  buildTray();
  applyLoginItem();

  scheduler = new Scheduler({
    store,
    isUserActive: () => !locked && powerMonitor.getSystemIdleTime() < IDLE_SECS,
    onAlerts: (alerts) => {
      for (const a of alerts) {
        const note = a.note && a.note !== 'Snoozed' ? `: ${a.note}` : '';
        const late = a.late ? ' (missed while your PC was off or asleep)' : '';
        const text = a.kind === 'due' ? `⏰ ${a.taskId} "${a.title}" is due now${late}.`
          : a.taskId ? `🔔 ${a.taskId} "${a.title}" reminder${note}${late}.`
            : `🔔 Reminder: ${a.title}${note}${late}.`;
        addChat('buddy', text, { kind: 'alert', taskId: a.taskId || undefined });
      }
      companionShow(alerts);
      emit('alert-speak', alerts);
      refreshTrayMenu();
    },
    onBriefing: (b) => {
      addChat('buddy', b.text, { kind: 'briefing' });
      companionShow([{ kind: 'briefing', text: b.text, focus: b.focus }]);
      emit('alert-speak', [{ kind: 'briefing', text: b.text }]);
    },
    // Check-ins, breaks and wrap-up appear on screen only; they're added to the chat
    // when the user answers (see sendMessage), so ignored prompts don't clutter it.
    onTrigger: (t) => {
      if (t.kind === 'focusEnd') {
        companionSend({ type: 'focus', until: 0 });
        companionSend({ type: 'quiet', until: store.data.meta.quietUntil || 0 });
        addChat('buddy', t.text, { kind: 'focus' });
        refreshTrayMenu();
      }
      companionShow([t]);
      emit('alert-speak', [{ kind: 'briefing', text: t.text }]);
    },
  });
  scheduler.start();

  powerMonitor.on('lock-screen', () => { locked = true; markAway(); });
  powerMonitor.on('suspend', () => markAway());
  powerMonitor.on('resume', () => { setTimeout(() => scheduler.tick(), 3000); if (!locked) backFromAway(); });
  powerMonitor.on('unlock-screen', () => { locked = false; scheduler.tick(); backFromAway(); });
  setInterval(pollPresence, 30000);

  // Keep the companion in the corner when the screen layout changes
  const reposition = () => placeCompanion(false);
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);

  globalShortcut.register('Control+Alt+B', () => (mainWin.isVisible() && mainWin.isFocused() ? mainWin.hide() : showMain()));

  // Keep the tray tooltip's overdue count fresh
  setInterval(refreshTrayMenu, 5 * 60000);
});

app.on('before-quit', () => { quitting = true; if (store) store.saveNow(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => { /* stay alive in the tray */ });
