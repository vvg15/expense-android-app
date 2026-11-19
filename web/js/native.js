// Bridge to the Android app (window.AndroidBridge, see Bridge.java).
// In a normal browser (the PWA) `isNative` is false and none of this is used,
// so the same web code runs in both places.

const B = typeof window !== 'undefined' ? window.AndroidBridge : undefined;
export const isNative = !!B;

const listeners = {};
// Native → page events: window.__native('type', value)
window.__native = (type, value) => (listeners[type] || []).slice().forEach((f) => { try { f(value); } catch (e) { console.error(e); } });

export function onNative(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
function once(type) {
  return new Promise((resolve) => {
    const fn = (v) => { listeners[type] = listeners[type].filter((x) => x !== fn); resolve(v); };
    onNative(type, fn);
  });
}
const has = (m) => !!B && typeof B[m] === 'function';

export const native = {
  version: () => (has('appVersion') ? B.appVersion() : null),
  /** 'granted' | 'prompt' | 'denied' | 'blocked' | 'unavailable' */
  smsState: () => (has('smsPermissionState') ? B.smsPermissionState() : 'unavailable'),
  async requestSms() { const p = once('smsPermission'); B.requestSmsPermission(); return p; },
  /** Received SMS between two timestamps → [{ address, ts, body }] (oldest first). */
  readSms(fromMs, toMs, skipPersonal) {
    if (!has('readSms')) return [];
    try { return JSON.parse(B.readSms(String(Math.floor(fromMs)), String(Math.floor(toMs)), !!skipPersonal)) || []; }
    catch { return []; }
  },
  /** Opens the system "save as" screen. Resolves true if saved. */
  async saveFile(name, mime, text) { const p = once('fileSaved'); B.saveFile(name, mime, text); return p; },
  shareFile: (name, mime, text) => (has('shareFile') ? B.shareFile(name, mime, text) : false),
  openSettings: () => has('openAppSettings') && B.openAppSettings(),
  checkUpdate: () => has('checkForUpdate') && B.checkForUpdate(),
  completeUpdate: () => has('completeUpdate') && B.completeUpdate(),

  // ── Automatic backup to a folder the user picks (bridge v2) ──
  canAutoBackup: () => has('writeBackup'),
  /** Opens Android's folder picker. Resolves with the folder's name, or '' if cancelled. */
  async chooseBackupFolder() { const p = once('backupFolder'); B.chooseBackupFolder(); return p; },
  backupFolderName: () => (has('backupFolderName') ? B.backupFolderName() : ''),
  /** Writes the file into the folder, keeping the newest `keep` auto-backups. Returns 'ok' or an error text. */
  writeBackup: (name, text, keep) => (has('writeBackup') ? B.writeBackup(name, text, keep) : 'unavailable'),
  clearBackupFolder: () => has('clearBackupFolder') && B.clearBackupFolder(),

  // ── App lock (bridge v2) ──
  /** { available, enabled, delay } — available = the phone has a screen lock set up. */
  lockState() {
    if (!has('lockState')) return { error: 'not available in this app version' };
    try { return JSON.parse(B.lockState()); } catch (e) { return { error: String((e && e.message) || e) }; }
  },
  // ── Appearance (bridge v3): colours the status / navigation bars to match the chosen theme ──
  setTheme: (mode) => has('setTheme') && B.setTheme(String(mode)),
  bridgeVersion: () => { try { return has('bridgeVersion') ? B.bridgeVersion() : 1; } catch { return 0; } },
  /** Asks for fingerprint/screen lock, then turns the lock on or off. Resolves with the new state. */
  async setLock(enabled) { const p = once('lockChanged'); B.setLock(!!enabled); return p; },
  setLockDelay: (sec) => has('setLockDelay') && B.setLockDelay(sec | 0),
};
