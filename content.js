// CreatorHub Audit Assistant: floating panel on /admin/submissions that walks
// through "Awaiting Audit" Web/Forum rows one at a time. For each row it opens
// the Content URL in a preview window and waits for you: Approve clicks the
// green tick, Reject double-clicks the Reject button. Every decision is yours.
(() => {
  if (window.__auditAssistant) return;
  window.__auditAssistant = true;

  const PLATFORMS = [
    'all platforms', 'bluesky', 'careers360', 'collegedekho', 'collegedunia', 'facebook',
    'instagram', 'linkedin', 'medium', 'mouthshut', 'pagalguy', 'pinterest', 'quora',
    'reddit', 'reviewadda', 'shiksha', 'twitter', 'youtube',
  ];
  const AWAITING = 'awaiting audit';
  // Page-level bulk controls this script must never touch.
  const FORBIDDEN = /approve all|delete|purge/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.offsetParent !== null;
  const text = (el) => (el?.innerText || el?.textContent || '').trim().replace(/\s+/g, ' ');
  const hasExt = typeof chrome !== 'undefined' && chrome.runtime?.id;

  const state = {
    running: false,
    current: null,
    resolveDecision: null,
    dryRun: false,
    stats: { approved: 0, rejected: 0, skipped: 0, unconfirmed: 0 },
    skipped: new WeakSet(),
    toggled: new WeakSet(),
  };

  // ---------- page helpers ----------

  // Resolves when fn() is truthy, re-checking on DOM changes. Uses a
  // MutationObserver plus one timeout (not a polling loop) so it keeps working
  // while this tab sits in the background and Chrome throttles timers.
  function waitFor(fn, timeout = 8000) {
    return new Promise((resolve) => {
      const first = fn();
      if (first) return resolve(first);
      const done = (v) => { obs.disconnect(); clearTimeout(timer); resolve(v); };
      const obs = new MutationObserver(() => { const v = fn(); if (v) done(v); });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      const timer = setTimeout(() => done(fn() || null), timeout);
    });
  }

  function safeClick(el) {
    if (!el || FORBIDDEN.test(text(el))) throw new Error('Refusing to click: ' + text(el));
    el.scrollIntoView({ block: 'center' });
    const o = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', { ...o, detail: 1 }));
  }

  async function doubleClick(el) {
    if (!el || FORBIDDEN.test(text(el))) throw new Error('Refusing to click: ' + text(el));
    el.scrollIntoView({ block: 'center' });
    const o = { bubbles: true, cancelable: true, view: window, button: 0 };
    for (const detail of [1, 2]) {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...o, detail }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...o, detail }));
      el.dispatchEvent(new MouseEvent('click', { ...o, detail }));
      if (detail === 1) await sleep(120);
    }
    el.dispatchEvent(new MouseEvent('dblclick', { ...o, detail: 2 }));
  }

  function findButton(label) {
    return [...document.querySelectorAll('button')].find(
      (b) => visible(b) && text(b).toLowerCase() === label.toLowerCase()
    );
  }

  async function switchToWebForum() {
    const btn = await waitFor(() => findButton('Web / Forum'));
    if (!btn) throw new Error('"Web / Forum" tab not found');
    safeClick(btn);
    await sleep(1500);
  }

  function platformFilterButton() {
    return [...document.querySelectorAll('button')].find(
      (b) => visible(b) && !b.closest('table') && PLATFORMS.includes(text(b).toLowerCase())
    );
  }

  async function applyPlatform(platform) {
    const trigger = await waitFor(platformFilterButton);
    if (!trigger) throw new Error('Platform filter not found');
    if (text(trigger).toLowerCase() === platform) return;
    safeClick(trigger);
    const search = await waitFor(() =>
      [...document.querySelectorAll('input')].find((i) => /search platform/i.test(i.placeholder) && visible(i))
    );
    if (!search) throw new Error('Platform dropdown did not open');
    let menu = search.parentElement;
    while (menu && !menu.querySelector('button')) menu = menu.parentElement;
    const option = [...menu.querySelectorAll('button')].find((b) => text(b).toLowerCase() === platform);
    if (!option) throw new Error('Platform option not found: ' + platform);
    safeClick(option);
    await sleep(1500);
  }

  function columnMap(table) {
    const map = {};
    table.querySelectorAll('th').forEach((th, i) => (map[text(th).toLowerCase()] = i));
    return {
      platform: map['platform'] ?? 2,
      url: map['content url'] ?? 5,
      status: map['audit status'] ?? 8,
      actions: map['operational actions'] ?? 9,
    };
  }

  function rowInfo(tr) {
    const table = tr.closest('table');
    if (!table) return null;
    const cols = columnMap(table);
    const cells = tr.querySelectorAll(':scope > td');
    if (cells.length <= cols.actions) return null;
    let card = tr;
    while (card && !card.querySelector('h3')) card = card.parentElement;
    const actions = [...cells[cols.actions].querySelectorAll('button')];
    return {
      tr,
      platform: text(cells[cols.platform]).toLowerCase(),
      status: text(cells[cols.status]).toLowerCase(),
      link: cells[cols.url].querySelector('a[href]'),
      approveBtn: actions[0],
      rejectBtn: actions.find((b) => /reject/i.test(text(b))),
      creator: card ? text(card.querySelector('h3')) : '',
      school: card ? text([...card.querySelectorAll('span')].find((s) => /^school of/i.test(text(s)))) : '',
      sr: text(cells[0]),
    };
  }

  function nextPendingRow(platform) {
    for (const tr of document.querySelectorAll('tr')) {
      if (!visible(tr) || state.skipped.has(tr)) continue;
      const info = rowInfo(tr);
      if (!info || !info.status.includes(AWAITING) || !info.link) continue;
      if (platform !== 'all platforms' && info.platform !== platform) continue;
      if (!info.approveBtn || !info.rejectBtn) continue;
      return info;
    }
    return null;
  }

  // Expand the next collapsed creator card (its header lacks "Approve All Pending").
  function expandNextCard() {
    for (const fb of document.querySelectorAll('button')) {
      if (!visible(fb) || text(fb) !== 'Feedback' || fb.closest('table')) continue;
      const group = fb.parentElement;
      const btns = [...group.querySelectorAll(':scope > button')];
      const chevron = btns[btns.length - 1];
      if (!chevron || chevron === fb || text(chevron) || state.toggled.has(chevron)) continue;
      if (btns.some((b) => /approve all/i.test(text(b)))) continue; // already expanded
      state.toggled.add(chevron);
      chevron.click(); // chevron has no label, so it can't be a bulk action
      return true;
    }
    return false;
  }

  async function waitForRowResolved(tr) {
    return waitFor(() => {
      if (!tr.isConnected || !visible(tr)) return true;
      const info = rowInfo(tr);
      return info && !info.status.includes(AWAITING);
    }, 8000);
  }

  // Opens the content in the review tab, where overlay.js shows the decision bar.
  function openReview(info) {
    const meta = { sr: info.sr, creator: info.creator, school: info.school, platform: info.platform, dryRun: state.dryRun, mode: state.mode, sens: ui.sens.value };
    if (hasExt) chrome.runtime.sendMessage({ type: 'review', url: info.link.href, info: meta });
    else window.open(info.link.href, 'auditReview');
  }

  function reviewStatus(text) {
    if (hasExt) chrome.runtime.sendMessage({ type: 'status', text });
  }

  // ---------- main loop ----------

  async function run() {
    const platform = ui.platform.value;
    state.dryRun = ui.dry.checked;
    state.mode = selectedMode();
    if (!state.mode) return;
    state.running = true;
    renderControls();
    try {
      log('Approval flow: ' + { keys: 'A · Button / keys', face: 'B · Face gesture', voice: 'C · Voice' }[state.mode]);
      log('Switching to Web / Forum…');
      await switchToWebForum();
      log('Applying platform filter: ' + platform);
      await applyPlatform(platform);

      let idle = 0;
      while (state.running) {
        const info = nextPendingRow(platform);
        if (!info) {
          reviewStatus('Loading next…');
          if (expandNextCard()) { await waitFor(() => nextPendingRow(platform), 4000); idle = 0; continue; }
          window.scrollTo(0, document.body.scrollHeight);
          await waitFor(() => nextPendingRow(platform), 2500);
          if (++idle >= 3) { log('No more pending rows. Done.'); break; }
          continue;
        }
        idle = 0;
        state.current = info;
        info.tr.style.outline = '3px solid #f472b6';
        info.tr.scrollIntoView({ block: 'center' });
        openReview(info);
        showPrompt(info);

        const decision = await new Promise((r) => (state.resolveDecision = r));
        state.resolveDecision = null;
        hidePrompt();
        info.tr.style.outline = '';
        if (decision === 'stop') break;
        if (decision === 'skip') {
          state.skipped.add(info.tr);
          state.stats.skipped++;
          log(`Skipped #${info.sr} ${info.creator}`);
          renderStats();
          continue;
        }

        if (state.dryRun) {
          log(`[dry run] Would ${decision} #${info.sr} ${info.creator}`);
          state.skipped.add(info.tr);
        } else {
          if (decision === 'approve') safeClick(info.approveBtn);
          else await doubleClick(info.rejectBtn);
          const ok = await waitForRowResolved(info.tr);
          if (!ok && !document.hidden) {
            log(`⚠ Row #${info.sr} did not change after ${decision}. Stopping so you can check.`);
            reviewStatus(`⚠ #${info.sr} didn't change. Stopped.`);
            break;
          }
          if (!ok) {
            // A background tab may hold back the row's re-render; don't revisit it.
            state.skipped.add(info.tr);
            state.stats.unconfirmed++;
            log(`? ${decision} sent for #${info.sr} ${info.creator}, not yet confirmed (tab in background)`);
          } else {
            log(`${decision === 'approve' ? '✔ Approved' : '✖ Rejected'} #${info.sr} ${info.creator}`);
          }
        }
        state.stats[decision === 'approve' ? 'approved' : 'rejected']++;
        renderStats();
      }
    } catch (e) {
      log('Error: ' + e.message);
    } finally {
      state.running = false;
      state.current = null;
      hidePrompt();
      renderControls();
      if (hasExt) chrome.runtime.sendMessage({ type: 'endReview' });
    }
  }

  function decide(d) {
    if (state.resolveDecision) state.resolveDecision(d);
  }

  // ---------- site layering fix ----------
  // The filter bar's backdrop-filter traps its dropdowns in a stacking context,
  // so the Bulk Operations panel (incl. "Delete EVERYTHING") paints over them.
  // Lift the bar above later panels and make its dropdowns opaque.
  const zfix = document.createElement('style');
  zfix.textContent = `
    .glassmorphic:has(input[placeholder^="Search by creator"]) { position: relative !important; z-index: 60 !important; }
    .glassmorphic:has(input[placeholder^="Search by creator"]) .absolute.top-full { background: #1c1a26 !important; }
  `;
  document.documentElement.appendChild(zfix);

  // ---------- UI ----------

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: system-ui, sans-serif; }
      .panel { width: 320px; background: #17151f; color: #eee; border: 1px solid #3a3550;
        border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,.5); font-size: 12px; overflow: hidden; }
      .head { display:flex; justify-content:space-between; align-items:center; padding:10px 14px;
        background: linear-gradient(90deg,#db2777,#7c3aed); font-weight:700; cursor:pointer; }
      .body { padding: 12px 14px; display: grid; gap: 8px; }
      .min .body { display:none; }
      select, button { font-size: 12px; border-radius: 10px; border: 1px solid #3a3550; padding: 7px 10px; }
      select { background:#221f2e; color:#eee; width:100%; }
      button { cursor:pointer; font-weight:700; color:#fff; background:#2a2638; }
      button:disabled { opacity:.4; cursor:default; }
      .row { display:flex; gap:6px; align-items:center; }
      .row > * { flex:1; }
      .go { background:#7c3aed; } .ok { background:#16a34a; } .no { background:#dc2626; }
      .stats { display:flex; gap:10px; color:#bbb; }
      .log { max-height:110px; overflow:auto; background:#0f0d16; border-radius:8px; padding:6px 8px;
        color:#aaa; font-family: ui-monospace, monospace; font-size:11px; white-space:pre-wrap; }
      .prompt { display:none; border:1px solid #f472b6; border-radius:12px; padding:10px; background:#221a2b; gap:6px; }
      .prompt.show { display:grid; }
      .prompt .who { font-weight:800; font-size:15px; color:#fff; }
      .prompt a { color:#93c5fd; word-break:break-all; }
      .hint { color:#888; font-size:11px; }
      label { display:flex; gap:6px; align-items:center; color:#bbb; }
      .modes { display:grid; gap:4px; }
      .mode { display:grid; grid-template-columns:auto auto 1fr; column-gap:6px; padding:6px 8px; border:1px solid #3a3550;
        border-radius:10px; cursor:pointer; color:#eee; }
      .mode b { color:#f9a8d4; }
      .mode span { grid-column:3; color:#888; font-size:11px; }
      .mode:has(input:checked) { border-color:#f472b6; background:#2a1f33; }
      .sens { display:none; justify-content:space-between; padding:0 8px 4px 28px; font-size:11px; }
      .sens select { width:auto; padding:4px 6px; font-size:11px; }
      .modes:has(input[value=face]:checked) .sens { display:flex; }
    </style>
    <div class="panel">
      <div class="head" id="head"><span>Audit Assistant</span><span id="toggle">–</span></div>
      <div class="body">
        <div class="row">
          <select id="platform">${PLATFORMS.map((p) => `<option value="${p}">${p === 'all platforms' ? 'All Platforms' : p}</option>`).join('')}</select>
        </div>
        <div class="modes" id="modes">
          <div class="hint">Approval flow (choose one to start)</div>
          <label class="mode"><input type="radio" name="mode" value="keys"><b>A</b> Button / click / keys<span>Shift approve · R reject · S skip</span></label>
          <label class="mode"><input type="radio" name="mode" value="face"><b>B</b> Face gesture<span>Nod approve · shake reject (camera)</span></label>
          <label class="sens" id="sensRow">Gesture sensitivity
            <select id="sens">
              <option value="high">High (small / slow moves)</option>
              <option value="medium">Medium</option>
              <option value="low">Low (big, clear moves)</option>
            </select>
          </label>
          <label class="mode"><input type="radio" name="mode" value="voice"><b>C</b> Voice command<span>Say "ok" / "theek hai", "not ok" / "theek nahi", "skip"</span></label>
        </div>
        <label><input type="checkbox" id="dry"> Dry run (don't click approve/reject)</label>
        <div class="row">
          <button class="go" id="start" disabled>Start</button>
          <button id="stop" disabled>Stop</button>
        </div>
        <div class="prompt" id="prompt">
          <div class="who" id="who"></div>
          <div class="hint" id="sub"></div>
          <a id="url" target="_blank" rel="noopener"></a>
          <div class="row">
            <button class="ok" id="approve">Approve (Shift)</button>
            <button class="no" id="reject">Reject (R)</button>
            <button id="skip">Skip (S)</button>
          </div>
          <div class="hint">Decide from the review tab's bar, or here. Esc stops.</div>
        </div>
        <div class="stats"><span id="sa">✔ 0</span><span id="sr">✖ 0</span><span id="ss">↷ 0</span><span id="su" title="Sent while this tab was in the background; check the rows later">? 0</span></div>
        <div class="log" id="log"></div>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById(id);
  const ui = { platform: $('platform'), dry: $('dry'), sens: $('sens') };

  function log(msg) {
    const el = $('log');
    el.textContent += new Date().toLocaleTimeString() + '  ' + msg + '\n';
    el.scrollTop = el.scrollHeight;
  }
  function renderStats() {
    $('sa').textContent = '✔ ' + state.stats.approved;
    $('sr').textContent = '✖ ' + state.stats.rejected;
    $('ss').textContent = '↷ ' + state.stats.skipped;
    $('su').textContent = '? ' + state.stats.unconfirmed;
  }
  const selectedMode = () => root.querySelector('input[name=mode]:checked')?.value || null;
  function renderControls() {
    $('start').disabled = state.running || !selectedMode();
    $('stop').disabled = !state.running;
    ui.platform.disabled = state.running;
    ui.dry.disabled = state.running;
    ui.sens.disabled = state.running;
    root.querySelectorAll('input[name=mode]').forEach((r) => (r.disabled = state.running));
  }
  root.querySelectorAll('input[name=mode]').forEach((r) => (r.onchange = renderControls));
  function showPrompt(info) {
    $('who').textContent = `Student: ${info.creator || 'Unknown'}`;
    $('sub').textContent = `#${info.sr} · ${info.platform}${info.school ? ' · ' + info.school : ''}`;
    $('url').textContent = info.link.href;
    $('url').href = info.link.href;
    $('prompt').classList.add('show');
    host.style.display = '';
    root.querySelector('.panel').classList.remove('min');
  }
  function hidePrompt() {
    $('prompt').classList.remove('show');
  }

  $('head').onclick = () => root.querySelector('.panel').classList.toggle('min');
  $('start').onclick = () => !state.running && run();
  $('stop').onclick = () => { state.running = false; decide('stop'); log('Stopped.'); };
  $('approve').onclick = () => decide('approve');
  $('reject').onclick = () => decide('reject');
  $('skip').onclick = () => decide('skip');

  // Same hotkeys as the review tab: Shift alone approves, R rejects, S skips, Esc stops.
  let shiftClean = false;
  const editing = (e) => !!e.target.closest?.('input,textarea,select,[contenteditable=true]');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') { shiftClean = !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey; return; }
    shiftClean = false;
    if (!state.resolveDecision || editing(e) || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const d = { r: 'reject', s: 'skip', escape: 'stop' }[e.key.toLowerCase()];
    if (d) { e.preventDefault(); e.stopPropagation(); decide(d); }
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Shift') return;
    const ok = shiftClean;
    shiftClean = false;
    if (ok && state.resolveDecision && !editing(e)) { e.preventDefault(); decide('approve'); }
  }, true);

  // Decisions made in the review tab arrive via the background worker.
  if (hasExt) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'decision') {
        if (msg.decision === 'stop') { state.running = false; log('Stopped.'); }
        decide(msg.decision);
      }
    });
  }

  // Remember the chosen platform / dry-run setting.
  if (hasExt) {
    chrome.storage.local.get(['platform', 'dryRun', 'sens']).then(({ platform, dryRun, sens }) => {
      if (platform) ui.platform.value = platform;
      ui.dry.checked = !!dryRun;
      if (sens) ui.sens.value = sens;
    });
    ui.sens.onchange = () => chrome.storage.local.set({ sens: ui.sens.value });
    ui.platform.onchange = () => chrome.storage.local.set({ platform: ui.platform.value });
    ui.dry.onchange = () => chrome.storage.local.set({ dryRun: ui.dry.checked });
  }

  // Only show the panel on the submissions page (Next.js navigates client-side).
  const syncVisibility = () => (host.style.display = location.pathname.startsWith('/admin/submissions') ? '' : 'none');
  syncVisibility();
  setInterval(syncVisibility, 1000);

  log('Ready. Pick a platform and press Start.');
})();
