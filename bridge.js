// FB Share Revealer — settings bridge
// MV3, world: ISOLATED, run_at: document_start
// content.js runs in the MAIN world and can't reach chrome.storage, so this
// script reads the popup's settings and hands them over as a JSON string.
// Settings apply on the next page load; content.js reads them once at start.

const DEFAULTS = {
  enabled: true,
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

chrome.storage.local.get(DEFAULTS).then((s) => {
  settingsJson = JSON.stringify(s);
  send();
  // The popup compares against this to decide whether Facebook needs a reload.
  chrome.storage.local.set({ applied: s });
});
