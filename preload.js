const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('buddy', {
  getState: () => ipcRenderer.invoke('get-state'),
  send: (text, meta) => ipcRenderer.invoke('send-message', text, meta),
  createTask: (f) => ipcRenderer.invoke('task-create', f),
  updateTask: (id, f) => ipcRenderer.invoke('task-update', id, f),
  logUpdate: (id, kind, text, progress) => ipcRenderer.invoke('task-log', id, kind, text, progress),
  deleteTask: (id) => ipcRenderer.invoke('task-delete', id),
  addReminder: (id, r) => ipcRenderer.invoke('reminder-add', id, r),
  removeReminder: (id, rid) => ipcRenderer.invoke('reminder-remove', id, rid),
  remAdd: (r) => ipcRenderer.invoke('rem-add', r),
  remUpdate: (rid, fields) => ipcRenderer.invoke('rem-update', rid, fields),
  remDelete: (rid) => ipcRenderer.invoke('rem-delete', rid),
  onFocusReminder: on('focus-reminder'),
  report: (type) => ipcRenderer.invoke('report', type),
  connAdd: (c) => ipcRenderer.invoke('conn-add', c),
  connUpdate: (c) => ipcRenderer.invoke('conn-update', c),
  connRemove: (id) => ipcRenderer.invoke('conn-remove', id),
  connMain: (id) => ipcRenderer.invoke('conn-main', id),
  connStatus: (id) => ipcRenderer.invoke('conn-status', id),
  connTest: (id) => ipcRenderer.invoke('conn-test', id),
  connSignIn: (id) => ipcRenderer.invoke('conn-signin', id),
  copy: (text) => ipcRenderer.invoke('copy-text', text),
  clearChat: () => ipcRenderer.invoke('clear-chat'),
  saveSettings: (s) => ipcRenderer.invoke('settings-save', s),
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: () => ipcRenderer.invoke('import-data'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  quitApp: () => ipcRenderer.send('quit-app'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  wake: () => ipcRenderer.send('wake'),
  voicePartial: (text) => ipcRenderer.send('voice-partial', text),
  voiceEnd: () => ipcRenderer.send('voice-end'),
  showMain: () => ipcRenderer.send('show-main'),
  pickCharacterImage: () => ipcRenderer.invoke('character-pick'),
  saveCharacterImage: (pose, dataUrl) => ipcRenderer.invoke('character-save', pose, dataUrl),

  // companion window
  companionReady: () => ipcRenderer.send('companion-ready'),
  companionMouse: (on) => ipcRenderer.send('companion-mouse', !!on),
  companionDrag: (phase, x, y) => ipcRenderer.send('companion-drag', phase, x, y),
  companionAction: (a) => ipcRenderer.invoke('companion-action', a),
  onCompanion: on('companion'),

  onState: on('state'),
  onThinking: on('thinking'),
  onReply: on('reply'),
  onOpenReport: on('open-report'),
  onFocusTask: on('focus-task'),
  onAlertSpeak: on('alert-speak'),
  onVoiceToggle: on('voice-toggle'),
  onVoiceCancel: on('voice-cancel'),
});
