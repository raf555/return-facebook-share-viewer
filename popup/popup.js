// Popup: reads and writes settings in chrome.storage.local. bridge.js passes
// them to content.js on the next Facebook page load, and background.js
// watches updateCheck.

const DEFAULTS = {
  enabled: true,
  updateCheck: true,
  debug: false,
  disableSeeding: false,
};

const FB_TABS = ['*://www.facebook.com/*', '*://facebook.com/*', '*://web.facebook.com/*'];

const current = chrome.runtime.getManifest().version;
const statusEl = document.getElementById('update-status');
const checkBtn = document.getElementById('check-now');
const errorEl = document.getElementById('error');

document.getElementById('version').textContent = `Version ${current}`;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

function renderUpdate(update) {
  statusEl.classList.remove('has-error');
  statusEl.replaceChildren();
  if (!update || !update.checkedAt) {
    statusEl.textContent = 'Not checked yet.';
    return;
  }
  if (update.latest && isNewer(update.latest, current)) {
    statusEl.append(`Version ${update.latest} is out. `);
    const a = document.createElement('a');
    a.href = update.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = 'Open release page';
    statusEl.append(a);
    return;
  }
  if (update.error) {
    statusEl.classList.add('has-error');
    statusEl.textContent = `Couldn't reach GitHub (${update.error}), ${ago(update.checkedAt)}.`;
    return;
  }
  statusEl.textContent = `Up to date. Checked ${ago(update.checkedAt)}.`;
}

// Settings content.js reads at page load. updateCheck lives in the service
// worker and applies at once.
const PAGE_KEYS = ['enabled', 'debug', 'disableSeeding'];

// Shows the reload notice only when a Facebook tab is open and its settings
// differ from the saved ones. bridge.js stores what the last page load got as
// `applied`. Until a page has loaded once there's nothing to compare, so the
// notice stays hidden.
async function refreshNotice() {
  const s = await chrome.storage.local.get({ ...DEFAULTS, applied: null });
  const stale = s.applied !== null && PAGE_KEYS.some((k) => s.applied[k] !== s[k]);
  const tabs = stale ? await chrome.tabs.query({ url: FB_TABS }) : [];
  document.getElementById('reload-notice').hidden = tabs.length === 0;
}

async function init() {
  const stored = await chrome.storage.local.get({ ...DEFAULTS, update: null });
  for (const input of document.querySelectorAll('input[data-key]')) {
    input.checked = stored[input.dataset.key];
    input.addEventListener('change', async () => {
      try {
        await chrome.storage.local.set({ [input.dataset.key]: input.checked });
        showError('');
        await refreshNotice();
      } catch (e) {
        input.checked = !input.checked;
        showError(`Couldn't save: ${e.message}`);
      }
    });
  }
  renderUpdate(stored.update);
  await refreshNotice();
}

// Reloaded tabs write `applied`, which can hide the notice while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'applied' in changes) refreshNotice();
});

checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  checkBtn.textContent = 'Checking…';
  statusEl.classList.remove('has-error');
  statusEl.textContent = 'Asking GitHub for the latest release…';
  try {
    renderUpdate(await chrome.runtime.sendMessage({ type: 'check-update' }));
  } catch (e) {
    statusEl.classList.add('has-error');
    statusEl.textContent = `Check failed: ${e.message}`;
  } finally {
    checkBtn.disabled = false;
    checkBtn.textContent = 'Check now';
  }
});

document.getElementById('reload-tabs').addEventListener('click', async () => {
  try {
    const tabs = await chrome.tabs.query({ url: FB_TABS });
    await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
    document.getElementById('reload-notice').hidden = true;
  } catch (e) {
    showError(`Couldn't reload tabs: ${e.message}`);
  }
});

init().catch((e) => showError(`Couldn't load settings: ${e.message}`));
