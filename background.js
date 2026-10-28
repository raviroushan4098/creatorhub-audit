// Opens each content URL in one review tab next to the admin tab, injects the
// decision bar (overlay.js) into it, and relays decisions back to the admin tab.
// State lives in storage.session because the service worker can be restarted.

const getState = async () => (await chrome.storage.session.get('review')).review || {};
const setState = (patch) => getState().then((s) => chrome.storage.session.set({ review: { ...s, ...patch } }));

async function tabExists(id) {
  if (!id) return false;
  try { await chrome.tabs.get(id); return true; } catch { return false; }
}

async function openReview(adminTab, url, info) {
  const s = await getState();
  await setState({ adminTabId: adminTab.id, pending: info });
  if (await tabExists(s.reviewTabId)) {
    await chrome.tabs.update(s.reviewTabId, { url, active: true });
  } else {
    const tab = await chrome.tabs.create({ url, index: adminTab.index + 1, openerTabId: adminTab.id, active: true });
    await setState({ reviewTabId: tab.id });
  }
}

async function injectOverlay(tabId) {
  const { pending } = await getState();
  if (!pending) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, func: (p) => window.__auditOverlay.show(p), args: [pending] });
  } catch (e) {
    // Pages like chrome:// or the Web Store can't be scripted; the admin panel still works.
    console.warn('Overlay injection failed', e);
  }
}

// Camera/mic permission has to be granted once on an extension page.
async function openSetup(mode) {
  const s = await getState();
  if (await tabExists(s.setupTabId)) return chrome.tabs.update(s.setupTabId, { active: true });
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`setup.html?mode=${mode}`), active: true });
  await setState({ setupTabId: tab.id });
}

async function endReview() {
  const s = await getState();
  await chrome.storage.session.remove('review');
  if (await tabExists(s.reviewTabId)) await chrome.tabs.remove(s.reviewTabId);
  if (await tabExists(s.adminTabId)) await chrome.tabs.update(s.adminTabId, { active: true });
}

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== 'complete') return;
  const s = await getState();
  if (tabId === s.reviewTabId) injectOverlay(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (tabId !== s.reviewTabId) return;
  await setState({ reviewTabId: null, pending: null });
  // Closing the review tab by hand stops the run.
  if (await tabExists(s.adminTabId)) chrome.tabs.sendMessage(s.adminTabId, { type: 'decision', decision: 'stop' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const s = await getState();
    if (msg.type === 'review') await openReview(sender.tab, msg.url, msg.info);
    else if (msg.type === 'decision' && sender.tab?.id === s.reviewTabId && (await tabExists(s.adminTabId)))
      await chrome.tabs.sendMessage(s.adminTabId, { type: 'decision', decision: msg.decision });
    else if (msg.type === 'status' && (await tabExists(s.reviewTabId)))
      await chrome.tabs.sendMessage(s.reviewTabId, { type: 'status', text: msg.text }).catch(() => {});
    else if (msg.type === 'endReview') await endReview();
    else if (msg.type === 'sensor' && sender.tab?.id === s.reviewTabId && sender.frameId !== 0) {
      // From the sensor iframe: hand it to the decision bar in the same tab.
      if (msg.needPermission) await openSetup(msg.needPermission);
      if (msg.openSetup) return openSetup(msg.openSetup);
      await chrome.tabs.sendMessage(s.reviewTabId, msg, { frameId: 0 }).catch(() => {});
    } else if (msg.type === 'permissionGranted' && (await tabExists(s.reviewTabId))) {
      await setState({ setupTabId: null });
      await chrome.tabs.update(s.reviewTabId, { active: true });
      await chrome.tabs.sendMessage(s.reviewTabId, { type: 'sensorReload' }, { frameId: 0 }).catch(() => {});
    }
  })().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
