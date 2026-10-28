// Decision bar injected into the review tab (the opened content URL).
// Keys always work: Shift (pressed alone) = Approve, R = Reject, S = Skip, Esc = Stop.
// In face / voice mode an extension iframe (sensor.html) also sends decisions;
// approve/reject from a sensor starts a short countdown that can be cancelled.
(() => {
  if (window.__auditOverlay) return;

  const COUNTDOWN_MS = { face: 2000, voice: 1000 };
  const SENSOR_READY_MS = 2000; // ignore sensors right after the page opens

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      * { box-sizing:border-box; font-family: system-ui, sans-serif; }
      .bar { display:flex; align-items:center; gap:10px; padding:10px 12px; background:#17151f; color:#eee;
        border:1px solid #f472b6; border-radius:16px; box-shadow:0 10px 40px rgba(0,0,0,.6); font-size:13px; }
      iframe { width:120px; height:90px; border:0; border-radius:10px; display:none; background:#0f0d16; }
      .has-sensor iframe { display:block; }
      .who { max-width:340px; line-height:1.3; padding-right:6px; }
      .who small { display:block; color:#f9a8d4; font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
      .who b { display:block; font-size:17px; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .who span { display:block; color:#aaa; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .who em { display:block; color:#93c5fd; font-size:11px; font-style:normal; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .btns { display:flex; gap:8px; }
      button { font-size:13px; font-weight:700; color:#fff; border:0; border-radius:10px; padding:9px 14px; cursor:pointer; }
      button:disabled { opacity:.4; cursor:default; }
      kbd { font-size:10px; opacity:.8; margin-left:4px; border:1px solid rgba(255,255,255,.4); border-radius:4px; padding:0 4px; }
      .ok { background:#16a34a; } .no { background:#dc2626; } .sk { background:#3a3550; } .st { background:transparent; color:#aaa; padding:9px 6px; }
      .status { color:#f9a8d4; font-weight:600; min-width:120px; }
      .count { display:none; align-items:center; gap:10px; padding:4px 6px; }
      .counting .btns { display:none; }
      .counting .count { display:flex; }
      .count .msg { font-size:15px; font-weight:800; }
      .count .msg.approve { color:#4ade80; } .count .msg.reject { color:#f87171; }
      .ring { width:34px; height:34px; }
      .ring circle { fill:none; stroke-width:4; }
      .ring .bg { stroke:#3a3550; }
      .ring .fg { stroke:#f472b6; stroke-linecap:round; transform:rotate(-90deg); transform-origin:50% 50%; }
      .cancel { background:#f59e0b; color:#111; }
    </style>
    <div class="bar" id="bar">
      <iframe id="sensor" allow="camera; microphone"></iframe>
      <div class="who"><small>Student</small><b id="who"></b><span id="sub"></span><em id="sensorStatus"></em></div>
      <div class="btns">
        <button class="ok" id="approve">Approve<kbd>Shift</kbd></button>
        <button class="no" id="reject">Reject<kbd>R</kbd></button>
        <button class="sk" id="skip">Skip<kbd>S</kbd></button>
        <button class="st" id="stop">Stop<kbd>Esc</kbd></button>
      </div>
      <div class="count">
        <svg class="ring" viewBox="0 0 34 34"><circle class="bg" cx="17" cy="17" r="14"/><circle class="fg" id="ring" cx="17" cy="17" r="14"/></svg>
        <div class="msg" id="countMsg"></div>
        <button class="cancel" id="cancel">Cancel<kbd>Esc</kbd></button>
      </div>
      <div class="status" id="status"></div>
    </div>`;
  const $ = (id) => root.getElementById(id);
  const buttons = ['approve', 'reject', 'skip', 'stop'].map($);
  const CIRC = 2 * Math.PI * 14;
  $('ring').style.strokeDasharray = CIRC;

  let armed = false;
  let mode = 'keys';
  let sens = 'high';
  let sensorReadyAt = 0;
  let countdown = null; // { decision, timer, raf }

  function setArmed(on) {
    armed = on;
    buttons.forEach((b) => (b.disabled = !on));
  }

  function send(decision) {
    if (!armed) return;
    cancelCountdown();
    setArmed(false);
    $('status').textContent = { approve: 'Approving…', reject: 'Rejecting…', skip: 'Skipping…', stop: 'Stopping…' }[decision];
    chrome.runtime.sendMessage({ type: 'decision', decision });
  }

  function startCountdown(decision, ms, why) {
    cancelCountdown();
    const start = performance.now();
    $('countMsg').className = 'msg ' + decision;
    $('bar').classList.add('counting');
    const tick = () => {
      const left = Math.max(0, ms - (performance.now() - start));
      $('countMsg').textContent = `${decision === 'approve' ? 'Approving' : 'Rejecting'} in ${Math.ceil(left / 1000)}… (${why})`;
      $('ring').style.strokeDashoffset = CIRC * (left / ms);
      if (countdown) countdown.raf = requestAnimationFrame(tick);
    };
    countdown = { decision, timer: setTimeout(() => send(decision), ms), raf: 0 };
    tick();
  }

  function cancelCountdown(showMsg) {
    if (!countdown) return;
    clearTimeout(countdown.timer);
    cancelAnimationFrame(countdown.raf);
    countdown = null;
    $('bar').classList.remove('counting');
    if (showMsg) $('status').textContent = 'Cancelled';
  }

  // Decisions coming from the face / voice sensor.
  function onSensorDecision(decision, source) {
    if (!armed || performance.now() < sensorReadyAt) return;
    if (countdown) {
      // Any new gesture or "cancel"/"stop" while counting down cancels it.
      cancelCountdown(true);
      sensorReadyAt = performance.now() + 800;
      return;
    }
    if (decision === 'cancel') return;
    if (decision === 'skip' || decision === 'stop') return send(decision);
    const why = source === 'nod' ? 'nod' : source === 'shake' ? 'shake' : 'voice';
    startCountdown(decision, COUNTDOWN_MS[mode] || 1500, why);
  }

  $('approve').onclick = () => send('approve');
  $('reject').onclick = () => send('reject');
  $('skip').onclick = () => send('skip');
  $('stop').onclick = () => send('stop');
  $('cancel').onclick = () => cancelCountdown(true);

  // Shift approves only when pressed and released on its own (not Shift+letter),
  // and never while typing in a field on the page.
  let shiftClean = false;
  const editing = (e) => e.composedPath().some((n) => n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') { shiftClean = !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey; return; }
    shiftClean = false;
    if (e.key === 'Escape' && countdown) { e.preventDefault(); e.stopPropagation(); cancelCountdown(true); return; }
    if (!armed || editing(e) || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const d = { r: 'reject', s: 'skip', escape: 'stop' }[e.key.toLowerCase()];
    if (d) { e.preventDefault(); e.stopPropagation(); send(d); }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Shift') return;
    const ok = shiftClean;
    shiftClean = false;
    if (ok && armed && !editing(e)) { e.preventDefault(); send('approve'); }
  }, true);
  window.addEventListener('blur', () => (shiftClean = false));

  function loadSensor() {
    const on = mode === 'face' || mode === 'voice';
    $('bar').classList.toggle('has-sensor', on);
    if (!on) { $('sensor').removeAttribute('src'); $('sensorStatus').textContent = ''; return; }
    // Timestamp forces a fresh load (new camera choice) after the setup page.
    $('sensor').src = chrome.runtime.getURL(`sensor.html?mode=${mode}&sens=${sens}&t=${Date.now()}`);
    $('sensorStatus').textContent = mode === 'face' ? 'Starting camera…' : 'Starting microphone…';
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'status') $('status').textContent = msg.text;
    else if (msg.type === 'sensor') {
      if (msg.status) $('sensorStatus').textContent = msg.status;
      if (msg.needPermission) $('sensorStatus').textContent = 'Allow access in the setup tab, then come back';
      if (msg.decision) onSensorDecision(msg.decision, msg.source);
    } else if (msg.type === 'sensorReload') loadSensor();
  });

  window.__auditOverlay = {
    show(p) {
      $('who').textContent = p.creator || 'Unknown student';
      $('who').title = p.creator || '';
      $('sub').textContent = [`#${p.sr}`, p.platform, p.school, p.dryRun && 'DRY RUN'].filter(Boolean).join(' · ');
      $('sub').title = $('sub').textContent;
      $('status').textContent = '';
      cancelCountdown();
      if (!host.isConnected) document.documentElement.appendChild(host);
      const newMode = p.mode || 'keys';
      const newSens = p.sens || 'high';
      if (newMode !== mode || newSens !== sens || !$('sensor').src) { mode = newMode; sens = newSens; loadSensor(); }
      sensorReadyAt = performance.now() + SENSOR_READY_MS;
      setArmed(true);
    },
  };
})();
