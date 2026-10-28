// Permission + device page. Granting camera/microphone here gives the
// extension (not any website) access, so the sensor frame inside review tabs
// works on every site without asking again. For face mode it also lets you
// choose which camera to use (e.g. the built-in one instead of an iPhone).
const mode = new URLSearchParams(location.search).get('mode') === 'voice' ? 'voice' : 'face';
const $ = (id) => document.getElementById(id);
let previewStream = null;

$('title').textContent = mode === 'face' ? 'Camera for face gestures' : 'Microphone for voice commands';
$('why').textContent = mode === 'face'
  ? 'The camera is used only while an audit session runs. Face tracking happens on this computer; no video is uploaded.'
  : 'The microphone is used only while an audit session runs. Chrome\'s speech recognition sends audio to Google to turn it into text. It uses your system\'s default microphone.';

function stopPreview() {
  previewStream?.getTracks().forEach((t) => t.stop());
  previewStream = null;
}

async function showPreview(deviceId) {
  stopPreview();
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
    $('preview').srcObject = previewStream;
  } catch (e) {
    $('result').className = 'err';
    $('result').textContent = 'Could not open that camera (' + e.name + '). It may be in use by another app.';
  }
}

async function listCameras() {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const { cameraId } = await chrome.storage.local.get('cameraId');
  const preferred =
    cams.find((c) => c.deviceId === cameraId) ||
    cams.find((c) => /facetime|built-?in|integrated/i.test(c.label)) ||
    cams[0];
  $('camera').innerHTML = '';
  for (const c of cams) {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || 'Camera';
    $('camera').appendChild(o);
  }
  if (!cams.length) {
    $('result').className = 'err';
    $('result').textContent = 'No camera found.';
    return;
  }
  $('camera').value = preferred.deviceId;
  $('cams').classList.add('show');
  $('grant').style.display = 'none';
  showPreview(preferred.deviceId);
}

async function finish() {
  stopPreview();
  if (mode === 'face') await chrome.storage.local.set({ cameraId: $('camera').value });
  $('result').className = 'ok';
  $('result').textContent = 'Done. Returning to your review…';
  await chrome.runtime.sendMessage({ type: 'permissionGranted', mode });
  setTimeout(() => window.close(), 700);
}

$('grant').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(mode === 'face' ? { video: true } : { audio: true });
    stream.getTracks().forEach((t) => t.stop());
    $('result').textContent = '';
    if (mode === 'face') await listCameras();
    else await finish();
  } catch (e) {
    $('result').className = 'err';
    $('result').textContent = 'Access was blocked (' + e.name + '). Click the camera/mic icon in the address bar to allow it, then try again.';
  }
};

$('camera').onchange = () => showPreview($('camera').value);
$('done').onclick = finish;
window.addEventListener('pagehide', stopPreview);

// Already allowed (e.g. opened from the ⚙ button): go straight to the camera list.
if (mode === 'face') {
  navigator.permissions.query({ name: 'camera' }).then((p) => {
    if (p.state === 'granted') listCameras();
  }).catch(() => {});
}
