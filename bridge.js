// FB Share Revealer — settings bridge
// MV3, world: ISOLATED, run_at: document_start
// content.js runs in the MAIN world and can't reach chrome.storage, so this
// script reads the popup's settings and hands them over as a JSON string.
// Settings apply on the next page load; content.js reads them once at start.

const DEFAULTS = {
  enabled: true,
  hoverPreview: true,
  debug: false,
  disableSeeding: false,
};

let settingsJson = null;

function send() {
  if (settingsJson === null) return;
  document.dispatchEvent(new CustomEvent('fbsr:settings', { detail: settingsJson }));
}

// content.js asks when it loads after this script; the push below covers the
// case where it loaded first.
document.addEventListener('fbsr:settings-request', send);

// Keeps the last 20 warnings and errors from content.js for the popup's
// "Copy debug info" button. A repeat of the previous message bumps its count.
// The queue stops two quick reports from overwriting each other.
const MAX_LOGS = 20;
let logQueue = Promise.resolve();

document.addEventListener('fbsr:log', (e) => {
  let entry;
  try { entry = JSON.parse(e.detail); } catch (err) { return; }
  const message = String(entry.message).slice(0, 200);
  logQueue = logQueue.then(async () => {
    const { logs = [] } = await chrome.storage.local.get('logs');
    const last = logs[logs.length - 1];
    if (last && last.level === entry.level && last.message === message) {
      last.count += 1;
      last.time = Date.now();
    } else {
      logs.push({
        time: Date.now(),
        level: entry.level,
        message,
        count: 1,
      });
    }
    await chrome.storage.local.set({ logs: logs.slice(-MAX_LOGS) });
  }).catch(() => { /* extension reloaded under this page; storage is gone */ });
});

chrome.storage.local.get(DEFAULTS).then((s) => {
  settingsJson = JSON.stringify(s);
  send();
  // The popup compares against this to decide whether Facebook needs a reload.
  chrome.storage.local.set({ applied: s });
});
