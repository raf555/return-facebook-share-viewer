// FB Share Revealer — service worker
// Checks GitHub once a day for a newer release and badges the toolbar icon.
// Unpacked extensions can't update themselves, so the popup links to the
// release page instead.

const RELEASE_API = 'https://api.github.com/repos/raf555/return-facebook-share-viewer/releases/latest';
const ALARM = 'update-check';
const CHECK_EVERY_MINUTES = 24 * 60;

// Returns >0 when a is newer than b. Versions are 1-4 dot-separated integers.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function setBadge(update) {
  const current = chrome.runtime.getManifest().version;
  const newer = update && update.latest && compareVersions(update.latest, current) > 0;
  await chrome.action.setBadgeText({ text: newer ? 'NEW' : '' });
  if (newer) await chrome.action.setBadgeBackgroundColor({ color: '#0861e0' });
}

// Stores and returns { latest, url, checkedAt, error }. On failure it keeps
// the last known release so the popup can still show it.
async function checkForUpdate() {
  const { update: prev } = await chrome.storage.local.get('update');
  let update;
  try {
    const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = await res.json();
    update = {
      latest: String(release.tag_name || '').replace(/^v/, ''),
      url: release.html_url,
      checkedAt: Date.now(),
      error: null,
    };
  } catch (e) {
    update = {
      ...prev,
      checkedAt: Date.now(),
      error: e.message || String(e),
    };
  }
  await chrome.storage.local.set({ update });
  await setBadge(update);
  return update;
}

async function syncAlarm() {
  const { updateCheck } = await chrome.storage.local.get({ updateCheck: true });
  if (!updateCheck) {
    await chrome.alarms.clear(ALARM);
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (!(await chrome.alarms.get(ALARM))) {
    chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: CHECK_EVERY_MINUTES });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await syncAlarm();
  const { updateCheck } = await chrome.storage.local.get({ updateCheck: true });
  if (updateCheck) await checkForUpdate();
});

chrome.runtime.onStartup.addListener(syncAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) checkForUpdate();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'updateCheck' in changes) syncAlarm();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'check-update') {
    checkForUpdate().then(sendResponse);
    return true; // keeps sendResponse alive for the async reply
  }
});
