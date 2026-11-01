// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The only things the window can ask the app to do. Nothing from Node or Electron is exposed.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('goodBoy', {
  state: () => ipcRenderer.invoke('gb:state'),
  start: () => ipcRenderer.invoke('gb:start'),
  stop: () => ipcRenderer.invoke('gb:stop'),
  restart: () => ipcRenderer.invoke('gb:restart'),
  openDashboard: () => ipcRenderer.invoke('gb:open-dashboard'),
  recheck: () => ipcRenderer.invoke('gb:recheck'),
  summary: () => ipcRenderer.invoke('gb:summary'),
  chrome: (dark) => ipcRenderer.invoke('gb:chrome', !!dark),
  chooseFolder: () => ipcRenderer.invoke('gb:choose-folder'),
  chooseNode: () => ipcRenderer.invoke('gb:choose-node'),
  setupFind: () => ipcRenderer.invoke('gb:setup-find'),
  setupPick: () => ipcRenderer.invoke('gb:setup-pick'),
  setupImport: (dir) => ipcRenderer.invoke('gb:setup-import', String(dir)),
  setupSave: (form) => ipcRenderer.invoke('gb:setup-save', { token: String(form?.token ?? ''), clientSecret: String(form?.clientSecret ?? '') }),
  verifyToken: (token) => ipcRenderer.invoke('gb:verify-token', token == null ? null : String(token)),
  openLink: (kind) => ipcRenderer.invoke('gb:open-link', String(kind)),
  setupSecret: (secret) => ipcRenderer.invoke('gb:setup-secret', String(secret ?? '')),
  setupFinish: (start) => ipcRenderer.invoke('gb:setup-finish', !!start),
  copy: (text) => ipcRenderer.invoke('gb:copy', String(text ?? '')),
  brandStatus: () => ipcRenderer.invoke('gb:brand-status'),
  brandApply: () => ipcRenderer.invoke('gb:brand-apply'),
  brandCustom: (form) => ipcRenderer.invoke('gb:brand-custom', { name: form?.name == null ? null : String(form.name), pickImage: !!form?.pickImage }),
  licState: () => ipcRenderer.invoke('gb:lic-state'),
  licKeygen: () => ipcRenderer.invoke('gb:lic-keygen'),
  licCreate: (form) => ipcRenderer.invoke('gb:lic-create', { appId: String(form?.appId ?? ''), to: String(form?.to ?? ''), days: String(form?.days ?? ''), until: String(form?.until ?? ''), features: Array.isArray(form?.features) ? form.features.map(String) : [] }),
  licRevoke: (id) => ipcRenderer.invoke('gb:lic-revoke', String(id)),
  licApply: (key) => ipcRenderer.invoke('gb:lic-apply', String(key ?? '')),
  modules: (guildId) => ipcRenderer.invoke('gb:modules', guildId == null ? null : String(guildId)),
  moduleSet: (form) => ipcRenderer.invoke('gb:module-set', { guildId: form?.guildId == null ? null : String(form.guildId), name: String(form?.name ?? ''), enabled: !!form?.enabled }),
  moduleAdd: () => ipcRenderer.invoke('gb:module-add'),
  moduleSign: () => ipcRenderer.invoke('gb:module-sign'),
  saveSettings: (patch) => ipcRenderer.invoke('gb:save-settings', patch),
  takeover: () => ipcRenderer.invoke('gb:takeover'),
  dataExport: () => ipcRenderer.invoke('gb:data-export'),
  dataImport: () => ipcRenderer.invoke('gb:data-import'),
  updateCheck: () => ipcRenderer.invoke('gb:update-check'),
  updateOpen: () => ipcRenderer.invoke('gb:update-open'),
  updateInstall: () => ipcRenderer.invoke('gb:update-install'),
  shareState: () => ipcRenderer.invoke('gb:share-state'),
  shareOn: () => ipcRenderer.invoke('gb:share-on'),
  shareOff: () => ipcRenderer.invoke('gb:share-off'),
  shareSetup: () => ipcRenderer.invoke('gb:share-setup'),
  onShareStep: listen('share-step'),
  shareLink: (url) => ipcRenderer.invoke('gb:share-link', String(url ?? '')),
  onState: listen('state'),
  onLog: listen('log'),
});
