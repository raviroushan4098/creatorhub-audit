# CreatorHub Audit Assistant (Chrome extension)

Steps through **Web / Forum** submissions that are *Awaiting Audit*. Each
Content URL opens in a **review tab** next to the admin tab, with a decision bar
at the bottom showing the student's name, school, platform and row number.

## Approval flows
Before **Start**, the auditor picks one approval flow in the admin panel:

| Flow | Approve | Reject | Skip | Stop |
|------|---------|--------|------|------|
| **A · Button / keys** | click or `Shift` (alone) | click or `R` | click or `S` | `Esc` |
| **B · Face gesture** | **nod** (up-down, ~2 times) | **shake** (left-right, ~2 times) | `S` | `Esc` |
| **C · Voice** | say **"ok"** / "okay" / **"theek hai"** / "approve" | say **"not ok"** / "theek nahi hai" / "reject" | say **"skip"** / "next" | say **"stop"** |

- In B and C, approve and reject start a short **countdown** (2 s face, 1 s
  voice) with a progress ring. Any new gesture, saying "cancel", pressing `Esc`
  or clicking **Cancel** stops it, and nothing is clicked.
- Gestures and voice are ignored for the first 2 seconds after each page opens,
  so a head movement while it loads doesn't count.
- Keys and buttons work in every flow as a backup.

### Voice: "ok" vs "not ok"
"not ok" is checked before "ok", and "not approved" counts as reject. A
plain "ok" is acted on only after Chrome has heard the whole phrase. That way,
when you say "not ok", the "ok" part can never approve while "not" is still
being recognised. "ok" is about half a second slower than the other words
because of this. All commands are in `commands.js`.

### Privacy
- **Face gesture:** the camera runs only while a review session is open. Face
  tracking (Google MediaPipe, bundled in `vendor/`) runs on this computer, and
  no video is uploaded.
- **Voice:** uses Chrome's built-in speech recognition, which **sends audio to
  Google** to turn it into text.

### First use of B or C
The first time, a **setup tab** opens asking for camera or microphone access.
Click **Allow** once. The extension then remembers it for every site, and you're
taken back to the review.

### Wrong camera? (e.g. iPhone Continuity Camera)
The extension prefers the Mac's built-in FaceTime camera. To choose another,
click **⚙** on the camera tile in the review bar, pick the camera while watching
its live preview, then click **Use this camera**. The choice is remembered.

### Only the nearest face counts
If several people are in view, only the face **nearest the camera** (the
biggest one) is tracked. It gets a green box on the camera tile, labelled
**YOU** when others are visible. The tracker stays locked on you. Someone else
takes over only if they come clearly closer to the camera than you. Faces more
than about 1.5 m away are ignored completely, so people behind you can't
approve or reject anything, even if you step away. Tune it with `FACE_DEFAULTS` in `gesture.js`.

### Gesture sensitivity
When **B · Face gesture** is selected, the admin panel shows a sensitivity picker:

| Level | Detects |
|-------|---------|
| **High** (default) | small (~4–5°) and slow nods/shakes, up to ~3.8 s for the whole gesture |
| **Medium** | normal and slow nods/shakes, ~5° and up |
| **Low** | only clear, bigger moves |

At every level, sitting still, reading, a single glance, looking aside,
leaning, talking and webcam noise do **not** trigger anything. A gesture always
needs 3 alternating swings: down-up-down, or left-right-left.

### Live movement meter
The camera tile shows two small bars: a **vertical** one for nodding and a
**horizontal** one for shaking. White ticks mark the trigger point. The bar
turns green when you pass it. Dots count your swings (3 needed). If the bar
doesn't reach the ticks, pick a higher sensitivity or move a little more.

### Tips for face gestures
- Face the camera with light on your face. The camera tile says
  *"Face ✓"* when it can see you, and *"No face"* when it can't.
- In poor light the camera image is noisier; the detector then automatically
  needs a slightly bigger movement so noise can't trigger it.
- Fine-tuning: edit `SENSITIVITY` in `gesture.js` (smaller numbers = more sensitive).

## Install / update
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this `audit-extension` folder.
   After updating the files, click the reload ↻ icon on the extension.
3. Open (or reload) https://influncergalgotias.vercel.app/admin/submissions

The extension asks for access to all sites because it has to show the decision
bar on whatever site the content is on (Quora, Reddit, Shiksha, …).

## Use
1. In the **Audit Assistant** panel (bottom right of the admin page), pick a platform.
2. Choose an approval flow **A**, **B** or **C**. Start stays disabled until you do.
3. Optional: tick **Dry run** to try everything without approving or rejecting.
4. Press **Start**. The review tab opens. Decide using your chosen flow.
   The next submission loads in the same tab. Closing the tab stops the run.

## Safety
- Nothing is approved or rejected without your action (click, key, gesture or word).
- After each action it waits for the row to leave *Awaiting Audit*. Because
  the admin tab is in the background, the site may not redraw the row right
  away. Such rows are counted under **?** in the panel. Look over those rows
  once you're back on the admin tab.
- If the admin tab is visible and a row doesn't change, it stops so you can check.
- It never clicks "Approve All Pending", "Purge…" or "Delete EVERYTHING…".
- It fixes a site bug where the filter dropdowns open *behind* the Bulk
  Operations panel, right over "Delete EVERYTHING Displayed".
- A few pages (e.g. Chrome Web Store) block extensions. There, no bar shows;
  switch to the admin tab and use its panel buttons instead.

## Files
- `content.js`: admin page panel, flow picker, filter/row automation
- `overlay.js`: decision bar in the review tab (keys, countdown, sensor frame)
- `sensor.html` / `sensor.js`: camera + face tracking, or speech recognition
- `gesture.js`: nod / shake detection from face landmarks
- `setup.html` / `setup.js`: one-time camera/microphone permission page
- `background.js`: opens tabs and passes messages between them
- `vendor/`: MediaPipe tasks-vision 0.10.35 and the face landmarker model
# creatorhub-audit
