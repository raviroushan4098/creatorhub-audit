// Runs inside the review tab as an extension iframe (sensor.html?mode=face|voice).
// Face mode: webcam + MediaPipe face landmarks -> nod = approve, shake = reject.
// Voice mode: speech recognition -> "approve" / "reject" / "skip" / "cancel" / "stop".
// Results go to the review tab's decision bar through the background worker,
// never via window.postMessage, so the host page can't fake a decision.
import { FaceLandmarker, FilesetResolver } from './vendor/vision_bundle.mjs';
import { createDetector, headPose, pickNearestFace, SENSITIVITY } from './gesture.js';
import { matchCommand } from './commands.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const sensitivity = SENSITIVITY[params.get('sens')] || SENSITIVITY.high;
const tag = document.getElementById('tag');
const video = document.getElementById('video');

const send = (payload) => chrome.runtime.sendMessage({ type: 'sensor', ...payload }).catch(() => {});
let lastStatus = '';
function status(text) {
  tag.textContent = text;
  if (text !== lastStatus) { lastStatus = text; send({ status: text }); }
}

function permissionProblem(err) {
  if (err && /NotAllowed|not-allowed|Permission/i.test(String(err.name || err.error || err))) {
    status('Permission needed');
    send({ needPermission: mode });
    return true;
  }
  return false;
}

// ---------- face ----------

// Box around the tracked (nearest) face on the camera tile.
const overlayCanvas = document.getElementById('boxes');
const ctx = overlayCanvas.getContext('2d');
function drawBox(box, count) {
  const w = (overlayCanvas.width = overlayCanvas.clientWidth * devicePixelRatio);
  const h = (overlayCanvas.height = overlayCanvas.clientHeight * devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  if (!box) return;
  // The video is cropped to fill the tile (object-fit: cover); map coordinates the same way.
  const vw = video.videoWidth || 4, vh = video.videoHeight || 3;
  const scale = Math.max(w / vw, h / vh);
  const ox = (w - vw * scale) / 2, oy = (h - vh * scale) / 2;
  const pad = 0.15 * (box.maxX - box.minX);
  const bw = (box.maxX - box.minX + 2 * pad) * vw * scale, bh = (box.maxY - box.minY + 2 * pad) * vh * scale;
  // The video tile is mirrored, so mirror the box too (the label stays readable).
  const x = w - (ox + (box.minX - pad) * vw * scale) - bw, y = oy + (box.minY - pad) * vh * scale;
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.strokeStyle = '#4ade80';
  ctx.strokeRect(x, y, bw, bh);
  if (count > 1) {
    ctx.fillStyle = '#4ade80';
    ctx.font = `${10 * devicePixelRatio}px system-ui`;
    ctx.fillText('YOU', x + 3 * devicePixelRatio, y - 3 * devicePixelRatio > 8 ? y - 3 * devicePixelRatio : y + 11 * devicePixelRatio);
  }
}

// Uses the camera picked on the setup page; otherwise prefers the built-in
// one over phone (Continuity Camera) or virtual cameras.
async function pickCamera() {
  const { cameraId } = await chrome.storage.local.get('cameraId');
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  if (cameraId && cams.some((c) => c.deviceId === cameraId)) return cameraId;
  const builtIn = cams.find((c) => /facetime|built-?in|integrated/i.test(c.label));
  const notPhone = cams.find((c) => c.label && !/iphone|continuity|desk view|virtual|obs|snap/i.test(c.label));
  return (builtIn || notPhone || cams[0])?.deviceId;
}

async function startFace() {
  status('Starting camera…');
  let stream;
  try {
    const deviceId = await pickCamera();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) },
      audio: false,
    });
  } catch (e) {
    if (!permissionProblem(e)) status('Camera error: ' + e.name);
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  const label = stream.getVideoTracks()[0]?.label || 'camera';
  tag.title = 'Using: ' + label + ' (⚙ to change)';

  status('Loading face model…');
  const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/wasm'));
  const create = (delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: chrome.runtime.getURL('vendor/face_landmarker.task'), delegate },
    runningMode: 'VIDEO',
    numFaces: 4, // see everyone, but only the nearest face is used
  });
  // GPU is faster, but some machines/drivers don't support it.
  const landmarker = await create('GPU').catch(() => create('CPU'));

  const detector = createDetector(sensitivity);
  let lastTime = -1;
  let tracked = null; // box of the face we're locked on
  let missed = 0;
  const loop = () => {
    if (video.readyState >= 2 && video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      const now = performance.now();
      const faces = landmarker.detectForVideo(video, now).faceLandmarks || [];
      const pick = pickNearestFace(faces, tracked);
      if (!pick) {
        // Keep the lock through a brief miss (blink, quick turn) before letting go.
        if (++missed > 15 && tracked) { tracked = null; detector.lost(); }
        status(faces.length ? 'Too far – move closer' : 'No face – look at camera');
        drawBox(null, faces.length);
      } else {
        missed = 0;
        if (pick.switched) detector.lost(); // a different person: start fresh
        tracked = pick.box;
        status(faces.length > 1 ? `Face ✓ nearest of ${faces.length}` : 'Face ✓ nod = approve, shake = reject');
        drawBox(pick.box, faces.length);
        const g = detector.update(headPose(faces[pick.index]), now);
        drawMeter(detector.levels());
        if (g) send({ decision: g === 'nod' ? 'approve' : 'reject', source: g });
      }
    }
    video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
  };
  loop();
}

// Live movement meter on the tile: a vertical bar for nod (up/down) and a
// horizontal bar for shake (left/right). Ticks mark the trigger point; dots
// count the swings so far (3 needed).
function drawMeter(lv) {
  const k = devicePixelRatio;
  const clamp = (v) => Math.max(-1.4, Math.min(1.4, v));
  const bar = (x, y, w, h, level, vertical, swings) => {
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(x * k, y * k, w * k, h * k);
    const len = vertical ? h : w;
    const mid = len / 2;
    const span = (len / 2 - 2) / 1.4;
    const v = clamp(level) * span;
    ctx.fillStyle = Math.abs(level) >= 1 ? '#4ade80' : '#f9a8d4';
    if (vertical) ctx.fillRect((x + 1) * k, (y + mid + Math.min(0, v)) * k, (w - 2) * k, Math.abs(v) * k);
    else ctx.fillRect((x + mid + Math.min(0, v)) * k, (y + 1) * k, Math.abs(v) * k, (h - 2) * k);
    ctx.fillStyle = '#fff';
    for (const t of [-span, span]) {
      if (vertical) ctx.fillRect(x * k, (y + mid + t) * k, w * k, 1 * k);
      else ctx.fillRect((x + mid + t) * k, y * k, 1 * k, h * k);
    }
    for (let i = 0; i < lv.needed; i++) {
      ctx.fillStyle = i < swings ? '#4ade80' : 'rgba(255,255,255,.3)';
      const cx = vertical ? x + w / 2 : x + w + 5 + i * 6;
      const cy = vertical ? y + h + 5 + i * 6 : y + h / 2;
      ctx.beginPath(); ctx.arc(cx * k, cy * k, 2 * k, 0, Math.PI * 2); ctx.fill();
    }
  };
  bar(4, 12, 6, 34, lv.pitch, true, lv.pitchSwings);
  bar(18, 4, 60, 6, -lv.yaw, false, lv.yawSwings); // mirrored to match the preview
}

// ---------- voice ----------

function startVoice() {
  document.body.classList.add('voice');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { status('Voice not supported'); return; }
  const rec = new SR();
  rec.lang = 'en-IN';
  rec.continuous = true;
  rec.interimResults = true;
  let stopped = false;
  const handled = new Set();

  rec.onstart = () => { document.body.classList.add('listening'); status('Listening… say ok / not ok / skip'); };
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const said = e.results[i][0].transcript.toLowerCase().trim();
      if (!said || handled.has(i)) continue;
      // Most commands act before the phrase is final, for speed; plain "ok"
      // waits for the final result so "not ok" can never approve.
      const { decision, wait } = matchCommand(said, e.results[i].isFinal);
      if (decision) {
        handled.add(i);
        status(`Heard "${said}"`);
        send({ decision, source: 'voice', heard: said });
      } else if (e.results[i].isFinal && !wait) {
        status(`Heard "${said}" (no command)`);
      }
    }
  };
  rec.onerror = (e) => {
    if (permissionProblem(e)) { stopped = true; return; }
    if (e.error !== 'no-speech' && e.error !== 'aborted') status('Voice error: ' + e.error);
  };
  rec.onend = () => {
    document.body.classList.remove('listening');
    handled.clear();
    if (!stopped) setTimeout(() => { try { rec.start(); } catch {} }, 250);
  };
  try { rec.start(); } catch (e) { permissionProblem(e); }
}

document.getElementById('gear').onclick = () => send({ openSetup: mode });

if (mode === 'face') startFace().catch((e) => status('Face error: ' + (e.message || e)));
else if (mode === 'voice') startVoice();
else status('No mode');
