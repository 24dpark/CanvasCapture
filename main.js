/*
 * Canvas Timelapse — capture engine
 * PS 2026 / UXP. Event-driven history detection + imaging snapshots.
 *
 * Strategy:
 *   - Subscribe to Photoshop's "historyStateChanged" notification (event-driven,
 *     no polling). Each brush stroke / edit pushes a new history state -> we snapshot.
 *   - Debounce so a burst of rapid states within `throttle` ms collapses to 1 frame.
 *   - Snapshot = duplicate-flatten-downscale into a temp doc, export PNG via imaging API,
 *     write numbered frame to the session folder. Then discard the temp doc.
 *   - Export = hand the PNG sequence to Photoshop's Render Video (H.264) if available,
 *     else fall back to ffmpeg over the WSL/OS shell.
 *
 * Sections flagged [VERIFY] use APIs that can vary across PS builds — check on first run.
 */

const photoshop = require("photoshop");
const app = photoshop.app;
const core = photoshop.core;
const imaging = require("photoshop").imaging;
const action = photoshop.action;
const fs = require("uxp").storage.localFileSystem;
const formats = require("uxp").storage.formats;

// ---------- state ----------
const state = {
  recording: false,
  frame: 0,
  lastCaptureTs: 0,
  folder: null,          // UXP folder token for this session's frames
  folderNativePath: null,
  busy: false,           // guard against overlapping snapshots
  needsModal: false,     // latched true if this PS build rejects a non-modal getPixels
  settings: { fps: 24, maxSize: 1920, throttle: 0, duration: 30,
              holdLast: 2,
              aspect: "original", fit: "pad",
              autoStart: false },
  docId: null,           // lock recording to the doc we started on
  libraryRoot: null,     // one-time root folder; each project auto-gets a subfolder
};

// ---------- tiny logger ----------
const logEl = () => document.getElementById("log");
function log(msg, cls) {
  const el = logEl();
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.childNodes.length > 200) el.removeChild(el.firstChild);
}

// ---------- UI helpers ----------
const $ = (id) => document.getElementById(id);
function refreshUI() {
  $("frameCount").textContent = state.frame;
  // est length reflects target-duration mode
  let secs;
  if (state.settings.duration === "full") {
    secs = state.settings.fps ? (state.frame / state.settings.fps) : 0;
  } else {
    secs = state.settings.duration; // fixed target
  }
  $("estDur").textContent = secs < 1 ? `${Math.round(secs*10)/10}s` : `${Math.round(secs)}s`;
  const dot = $("dot");
  if (state.recording) {
    dot.className = "dot rec";
    $("statusLabel").textContent = "Recording";
    $("statusMeta").textContent = `Capturing edits · ${state.frame} frames`;
  } else {
    dot.className = "dot idle";
    $("statusLabel").textContent = state.frame ? "Stopped" : "Idle";
    $("statusMeta").textContent = state.frame ? `${state.frame} frames ready to export` : "Press Start to record";
  }
  $("btnStart").disabled = state.recording;
  $("btnStop").disabled = !state.recording;
  $("btnExport").disabled = state.recording || state.frame === 0;
}

// ---------- session folder ----------
async function createSessionFolder() {
  // Ask once for a place to store frames + output. Reused for the session.
  const root = await fs.getFolder();               // user picks a folder
  if (!root) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sess = await root.createFolder(`timelapse_${stamp}`);
  state.folder = sess;
  state.folderNativePath = sess.nativePath;
  await persistSessionToken(sess);
  await writeSessionMeta();
  log(`Session folder: ${sess.nativePath}`, "ok");
  return true;
}

// ---------- crash resilience ----------
// Persistent token lets us re-find the folder after a reload/restart.
async function persistSessionToken(folderEntry) {
  try {
    const token = await fs.createPersistentToken(folderEntry);
    localStorage.setItem("tl_folderToken", token);
  } catch (e) {
    log(`(could not persist folder token: ${e.message})`, "err");
  }
}

// A tiny manifest refreshed on each capture so a crash leaves a recoverable record.
async function writeSessionMeta() {
  if (!state.folder) return;
  try {
    const meta = {
      version: 1,
      frame: state.frame,
      settings: state.settings,
      docId: state.docId,
      lastUpdated: new Date().toISOString(),
      status: state.recording ? "recording" : "stopped",
    };
    const f = await state.folder.createFile("session.json", { overwrite: true });
    await f.write(JSON.stringify(meta, null, 2), { format: formats.utf8 });
  } catch (e) {
    // non-fatal; frames are what matter
  }
}

// On startup, try to reattach to an unfinished session.
async function restoreSession() {
  const token = localStorage.getItem("tl_folderToken");
  if (!token) return;
  try {
    const folder = await fs.getEntryForPersistentToken(token);
    if (!folder || !folder.isFolder) return;
    // read the manifest
    let meta = null;
    try {
      const mf = await folder.getEntry("session.json");
      meta = JSON.parse(await mf.read({ format: formats.utf8 }));
    } catch (_) { /* no manifest -> count frames instead */ }

    // count actual frame_*.(jpg|png) on disk (source of truth over the manifest)
    // Older sessions saved JPEG bytes under a .png name, so we accept both.
    const entries = await folder.getEntries();
    const pngs = entries.filter(e => /^frame_\d{6}\.(jpe?g|png)$/i.test(e.name));
    if (pngs.length === 0) return;   // nothing to recover

    state.folder = folder;
    state.folderNativePath = folder.nativePath;
    state.frame = pngs.length;
    if (meta && meta.settings) {
      state.settings = { ...state.settings, ...meta.settings };
      applySettingsToUI();
    }
    state.recording = false;         // never auto-resume recording
    refreshUI();
    log(`Recovered previous session: ${pngs.length} frames on disk.`, "ok");
    log(`Press Export to render them, or Start to record a new one.`, "ok");
  } catch (e) {
    // token stale (folder moved/deleted) — clear it silently
    localStorage.removeItem("tl_folderToken");
  }
}

// Reflect restored settings back into the dropdowns/slider.
function applySettingsToUI() {
  try {
    $("fps").value = state.settings.fps;
    $("fpsVal").textContent = state.settings.fps;
    $("holdLast").value = state.settings.holdLast;
    $("holdLastVal").textContent = state.settings.holdLast;
    const durMap = { "full": 0, 15: 1, 30: 2, 60: 3 };
    $("duration").selectedIndex = durMap[state.settings.duration] ?? 0;
    const aspMap = { "original":0, "1:1":1, "9:16":2, "16:9":3, "4:5":4 };
    $("aspect").selectedIndex = aspMap[state.settings.aspect] ?? 0;
    $("fit").selectedIndex = state.settings.fit === "crop" ? 1 : 0;
    $("autoStart").checked = !!state.settings.autoStart;
  } catch (_) {}
}

// ---------- per-document registry ----------
// Maps a saved document's file path -> its persistent folder token, so the
// same artwork reconnects to the same timelapse folder across launches.
function docKey(doc) {
  // prefer the saved file path (stable identity); untitled docs have none
  try { if (doc.path) return doc.path; } catch (_) {}
  return null;   // unsaved -> no cross-launch identity
}
function loadRegistry() {
  try { return JSON.parse(localStorage.getItem("tl_registry") || "{}"); }
  catch (_) { return {}; }
}
function saveRegistry(reg) {
  try { localStorage.setItem("tl_registry", JSON.stringify(reg)); } catch (_) {}
}
async function registerDoc(doc, folderEntry) {
  const key = docKey(doc);
  if (!key) return;   // can't register an unsaved doc
  try {
    const token = await fs.createPersistentToken(folderEntry);
    const reg = loadRegistry();
    reg[key] = { token, path: folderEntry.nativePath, updated: new Date().toISOString() };
    saveRegistry(reg);
  } catch (_) {}
}
// Try to reattach the active doc to a folder it used before. Returns true if linked.
async function reconnectDoc(doc) {
  const key = docKey(doc);
  if (!key) return false;
  const reg = loadRegistry();
  const rec = reg[key];
  if (!rec) return false;
  try {
    const folder = await fs.getEntryForPersistentToken(rec.token);
    if (!folder || !folder.isFolder) return false;
    const entries = await folder.getEntries();
    const pngs = entries.filter(e => /^frame_\d{6}\.(jpe?g|png)$/i.test(e.name));
    state.folder = folder;
    state.folderNativePath = folder.nativePath;
    // resume numbering from the highest existing frame index
    let maxIdx = 0;
    for (const e of pngs) {
      const m = e.name.match(/^frame_(\d{6})\.(?:jpe?g|png)$/i);
      if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
    }
    state.frame = maxIdx;
    log(`Reconnected "${doc.title}" to its timelapse (${maxIdx} frames so far).`, "ok");
    return true;
  } catch (_) {
    return false;   // token stale (folder moved/deleted)
  }
}

// ---------- library root (one-time) : each project auto-gets its own subfolder ----------
// Persist a single root folder. From then on, any SAVED .psd we haven't seen
// before gets a deterministic subfolder created under the root automatically —
// no per-project folder picker.
async function chooseLibraryRoot() {
  try {
    const root = await fs.getFolder();
    if (!root) return false;
    const token = await fs.createPersistentToken(root);
    localStorage.setItem("tl_libraryToken", token);
    state.libraryRoot = root;
    log(`Library folder set: ${root.nativePath}`, "ok");
    log(`New projects will auto-create a subfolder here.`, "ok");
    return true;
  } catch (e) {
    log(`Could not set library folder: ${e.message}`, "err");
    return false;
  }
}
async function resolveLibraryRoot() {
  if (state.libraryRoot) return state.libraryRoot;
  const token = localStorage.getItem("tl_libraryToken");
  if (!token) return null;
  try {
    const root = await fs.getEntryForPersistentToken(token);
    if (root && root.isFolder) { state.libraryRoot = root; return root; }
  } catch (_) {
    localStorage.removeItem("tl_libraryToken");   // stale
  }
  return null;
}
// Deterministic, collision-safe folder name for a document.
// <sanitized filename>_<short hash of full path> — so two files named the same
// in different locations never clash, and the SAME file always maps to the same
// folder even if the localStorage registry is wiped.
function folderNameForDoc(doc) {
  let base = (doc.name || "untitled").replace(/\.[^.]+$/, "");
  base = base.replace(/[^\w\-]+/g, "_").slice(0, 40) || "untitled";
  const key = docKey(doc) || base;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `${base}_${h.toString(36).slice(0, 6)}`;
}

// The one entry point that binds state.folder to a given document.
// Order of preference:
//   1. registry reconnect (fastest; resumes numbering from prior token)
//   2. library root -> deterministic per-project subfolder (hands-free)
//   3. manual folder picker (only when we're allowed to prompt)
// Returns true if state.folder is now set for this doc.
async function ensureFolderForDoc(doc, opts = {}) {
  // 1. known document -> reuse its registered folder
  if (await reconnectDoc(doc)) return true;

  // 2. saved document + a library root -> auto subfolder
  const root = await resolveLibraryRoot();
  const key = docKey(doc);
  if (root && key) {
    try {
      const name = folderNameForDoc(doc);
      let sub;
      try { sub = await root.getEntry(name); }
      catch (_) { sub = await root.createFolder(name); }
      state.folder = sub;
      state.folderNativePath = sub.nativePath;
      // resume numbering from any frames already on disk
      const entries = await sub.getEntries();
      let maxIdx = 0;
      for (const e of entries) {
        const m = e.name.match(/^frame_(\d{6})\.(?:jpe?g|png)$/i);
        if (m) maxIdx = Math.max(maxIdx, parseInt(m[1], 10));
      }
      state.frame = maxIdx;
      await registerDoc(doc, sub);
      await persistSessionToken(sub);
      log(`Project folder: ${sub.nativePath} (${maxIdx} frames so far)`, "ok");
      return true;
    } catch (e) {
      log(`Library folder step failed: ${e.message}`, "err");
    }
  }

  // 3. fall back to a manual pick, unless we're in silent/auto mode
  if (!opts.silent) {
    const ok = await createSessionFolder();
    if (ok) { await registerDoc(doc, state.folder); return true; }
    return false;
  }

  // silent + nowhere to put frames
  const why = key ? "set a Library folder to auto-file it" : "save the .psd first, then it gets its own folder";
  log(`Auto: "${doc.title}" has no linked folder — ${why}.`, "err");
  return false;
}

// ---------- live document-switch watcher ----------
// Poll the active document id; when it changes, rebind to that project's folder
// so opening a different .psd continues (or starts) its own timelapse.
let docWatchTimer = null;
let lastSeenDocId = null;
function startDocWatch() {
  if (docWatchTimer) return;
  docWatchTimer = setInterval(onDocTick, 1000);
}
async function onDocTick() {
  let doc = null;
  try { doc = app.activeDocument; } catch (_) { doc = null; }
  const id = doc ? doc.id : null;
  if (id === lastSeenDocId) return;      // nothing changed
  lastSeenDocId = id;
  if (!doc) return;                       // all docs closed
  if (id === state.docId) return;         // already bound to this one
  // only auto-react when we're recording or auto-start mode is on
  if (!state.recording && !state.settings.autoStart) return;
  await onDocSwitch(doc);
}
async function onDocSwitch(doc) {
  const wasActive = state.recording || state.settings.autoStart;
  if (state.folder) writeSessionMeta();   // flush the outgoing project
  // detach the old binding; ensureFolderForDoc will repopulate frame count
  state.folder = null; state.folderNativePath = null; state.frame = 0; state.docId = null;
  const linked = await ensureFolderForDoc(doc, { silent: true });
  if (linked) {
    state.docId = doc.id;
    if (wasActive) {
      state.recording = true;
      await attachListener();
      log(`Switched to "${doc.title}" — recording its timelapse.`, "ok");
    }
  } else {
    state.recording = false;             // unknown/unsaved doc: pause safely
    log(`Switched to "${doc.title}" — press Start (or set a Library folder).`);
  }
  refreshUI();
}
// Grab the flattened composite straight from the live doc via the imaging API.
// No duplicate, no doc switch -> no black flash, and much faster.
async function captureFrame() {
  if (state.busy || !state.recording) return;
  const doc = app.activeDocument;
  if (!doc || doc.id !== state.docId) return;   // only record our doc
  state.busy = true;
  try {
    // work out target size (downscale longest edge if requested)
    let targetSize = undefined;
    const maxS = state.settings.maxSize;
    if (maxS && maxS !== "full") {
      const longest = Math.max(doc.width, doc.height);
      if (longest > maxS) {
        const scale = maxS / longest;
        targetSize = {
          width: Math.round(doc.width * scale),
          height: Math.round(doc.height * scale),
        };
      }
    }

    // CURSOR-FLICKER FIX (v2): the flicker comes from executeAsModal — Photoshop
    // swaps the brush cursor to the default OS arrow for the ENTIRE duration of
    // any modal scope. v1 shrank that scope; this version tries to AVOID it.
    //
    // imaging.getPixels is a read-only grab and on PS 2026 can often run WITHOUT
    // a modal scope. When it does, there is no cursor swap at all -> zero flicker.
    // Older/stricter builds throw "photoshop is not in a modal state" — so we try
    // non-modal first and fall back to the minimal modal scope automatically.
    // Once a build tells us it needs modal, we remember it (needsModal) and stop
    // retrying the non-modal path so we don't pay a throw per frame.
    const grabOpts = {
      documentID: doc.id,
      applyAlpha: true,
      ...(targetSize ? { targetSize } : {}),
    };
    let pixels;
    if (!state.needsModal) {
      try {
        // getPixels on the composite (all visible layers merged). No layerID ->
        // flattened result. targetSize scales during the grab. No modal = no swap.
        pixels = await imaging.getPixels(grabOpts);
      } catch (e) {
        // this build requires modal for getPixels — latch it and use modal below
        state.needsModal = true;
        log("(pixel grab needs modal on this build — minor cursor blink expected)", "err");
      }
    }
    if (!pixels) {
      await core.executeAsModal(async () => {
        pixels = await imaging.getPixels(grabOpts);
      }, { commandName: "Timelapse snapshot" });
    }

    // --- everything below runs OUTSIDE modal (no cursor swap) ---
    try {
      // NOTE: this build's imaging.encodeImageData returns JPEG (Adobe/mjpeg)
      // bytes regardless of what we ask for, so we name the file .jpg to match
      // the ACTUAL bytes. A prior version requested format:"png" and saved the
      // JPEG bytes as frame_*.png — that mislabel made ffmpeg's png demuxer and
      // Photoshop's Render Video reject every frame. Now the extension is honest
      // and we set an explicit quality so the JPEG is intentional, not accidental.
      const jpg = await imaging.encodeImageData({
        imageData: pixels.imageData,
        base64: false,
        format: "jpg",
        quality: 0.92,
      });

      const num = String(state.frame + 1).padStart(6, "0");
      const file = await state.folder.createFile(`frame_${num}.jpg`, { overwrite: true });
      await file.write(jpg, { format: formats.binary });
      state.frame += 1;
    } finally {
      // always release the pixel buffer, even if encode/write throws
      pixels.imageData.dispose && pixels.imageData.dispose();
    }

    // refresh recoverable manifest (every 10th frame to limit disk churn)
    if (state.frame % 10 === 0 || state.frame === 1) { writeSessionMeta(); }
    refreshUI();
  } catch (e) {
    log(`snapshot failed: ${e.message}`, "err");
  } finally {
    state.busy = false;
  }
}

// ---------- idle-gate + safety-valve debounce ----------
// On this PS build getPixels forces a modal scope, which briefly swaps the brush
// cursor. To stop that happening ON EVERY STROKE, we DON'T capture the instant a
// stroke commits. Instead:
//   - IDLE GATE: capture only after painting has been quiet for `throttle` ms.
//     A burst of strokes keeps resetting the timer, so nothing fires (and nothing
//     flickers) while you're actively painting; the snapshot lands in your pause.
//   - SAFETY VALVE (maxWait): if you paint nonstop for longer than MAX_WAIT_MS,
//     force one capture anyway so a long unbroken burst still gets frames. Worst
//     case that's a single blink every MAX_WAIT_MS during continuous painting,
//     instead of one per stroke.
const MAX_WAIT_MS = 4000;   // guarantee at least one frame per this window while painting nonstop
let debounceTimer = null;
function onHistoryChange() {
  if (!state.recording) return;
  clearTimeout(debounceTimer);

  // safety valve: been too long since the last frame during a nonstop burst -> grab now
  const sinceLast = Date.now() - state.lastCaptureTs;
  if (state.lastCaptureTs && sinceLast >= MAX_WAIT_MS) {
    state.lastCaptureTs = Date.now();
    captureFrame();
    return;
  }

  // idle gate: wait until painting goes quiet for `throttle` ms, then capture
  const idle = state.settings.throttle || 0;
  debounceTimer = setTimeout(() => {
    state.lastCaptureTs = Date.now();
    captureFrame();
  }, idle);
}

// ---------- notification subscription ----------
let listenerAttached = false;
async function attachListener() {
  if (listenerAttached) return;
  // "historyStateChanged" fires on every committed edit (brush, fill, filter, transform...).
  await action.addNotificationListener(
    [{ event: "historyStateChanged" }],
    (event, descriptor) => onHistoryChange()
  );
  listenerAttached = true;
  log("History listener attached", "ok");
}

// ---------- controls ----------
async function start(opts = {}) {
  const doc = app.activeDocument;
  if (!doc) { log("No open document.", "err"); return; }

  // Bind this document to its folder (registry -> library auto-subfolder ->
  // manual pick). In silent/auto mode we never pop a picker.
  if (!state.folder) {
    const linked = await ensureFolderForDoc(doc, { silent: !!opts.silent });
    if (!linked) {
      if (!opts.silent) log("Cancelled — no folder chosen.", "err");
      return;
    }
  }
  state.docId = doc.id;
  lastSeenDocId = doc.id;
  state.recording = true;
  await attachListener();
  // capture an initial frame (the starting canvas)
  await captureFrame();
  log(`Recording started on "${doc.title}"`, "ok");
  refreshUI();
}

function stop() {
  state.recording = false;
  clearTimeout(debounceTimer);
  writeSessionMeta();          // flush final state to disk
  log("Recording stopped.");
  refreshUI();
}

function reset() {
  state.recording = false;
  state.frame = 0;
  state.folder = null;
  state.folderNativePath = null;
  state.docId = null;
  clearTimeout(debounceTimer);
  try { localStorage.removeItem("tl_folderToken"); } catch (_) {}
  log("Reset. Choose a new folder on next Start.");
  refreshUI();
}

// Manually point at any old timelapse folder and load its frames for export.
async function recoverFolder() {
  try {
    const folder = await fs.getFolder();
    if (!folder) return;
    const entries = await folder.getEntries();
    const pngs = entries.filter(e => /^frame_\d{6}\.(jpe?g|png)$/i.test(e.name));
    if (pngs.length === 0) {
      log("No frame_######.jpg files in that folder.", "err");
      return;
    }
    state.recording = false;
    state.folder = folder;
    state.folderNativePath = folder.nativePath;
    state.frame = pngs.length;
    // restore settings if a manifest is present
    try {
      const mf = await folder.getEntry("session.json");
      const meta = JSON.parse(await mf.read({ format: formats.utf8 }));
      if (meta && meta.settings) { state.settings = { ...state.settings, ...meta.settings }; applySettingsToUI(); }
    } catch (_) {}
    await persistSessionToken(folder);
    refreshUI();
    log(`Loaded ${pngs.length} frames from ${folder.nativePath}`, "ok");
    log(`Press Export MP4 to render them.`, "ok");
  } catch (e) {
    log(`Recover failed: ${e.message}`, "err");
  }
}

// ---------- wire up UI ----------
function bind() {
  $("btnStart").addEventListener("click", start);
  $("btnStop").addEventListener("click", stop);
  $("btnReset").addEventListener("click", reset);
  $("btnExport").addEventListener("click", async () => {
    // Loud, defensive handler: if anything is wrong we want the PANEL LOG to
    // say why, instead of the click silently throwing into the void.
    log("Export clicked…");
    if (typeof window.__exportMP4 !== "function") {
      log("ERROR: export module not loaded (window.__exportMP4 is undefined). Reload the plugin in UDT.", "err");
      return;
    }
    if (!state.folder) {
      log("ERROR: no session folder bound — press Start (or Recover folder…) first.", "err");
      return;
    }
    if (state.frame === 0) {
      log("ERROR: 0 frames captured — nothing to export.", "err");
      return;
    }
    // Frames land in the session folder; the .mp4 is named after your PSD.
    log(`Output folder: ${state.folderNativePath} (file named after your PSD)`, "ok");
    try {
      await window.__exportMP4();
    } catch (e) {
      log(`Export threw: ${e && (e.message || e)}`, "err");
    }
  });
  $("btnRecover").addEventListener("click", recoverFolder);
  $("btnLibrary").addEventListener("click", chooseLibraryRoot);

  $("fps").addEventListener("input", (e) => {
    state.settings.fps = parseInt(e.target.value, 10);
    $("fpsVal").textContent = state.settings.fps;
    refreshUI();
  });
  $("holdLast").addEventListener("input", (e) => {
    state.settings.holdLast = parseFloat(e.target.value);
    $("holdLastVal").textContent = state.settings.holdLast;
    savePrefs();
  });
  $("maxSize").addEventListener("change", (e) => {
    const v = e.target.selectedIndex;
    const map = [1280, 1920, 2560, "full"];
    state.settings.maxSize = map[v];
  });
  $("throttle").addEventListener("change", (e) => {
    const map = [0, 150, 300, 600];
    state.settings.throttle = map[e.target.selectedIndex];
  });
  $("duration").addEventListener("change", (e) => {
    const map = ["full", 15, 30, 60];
    state.settings.duration = map[e.target.selectedIndex];
    refreshUI();
  });
  $("aspect").addEventListener("change", (e) => {
    const map = ["original", "1:1", "9:16", "16:9", "4:5"];
    state.settings.aspect = map[e.target.selectedIndex];
    savePrefs();
  });
  $("fit").addEventListener("change", (e) => {
    state.settings.fit = e.target.selectedIndex === 1 ? "crop" : "pad";
    savePrefs();
  });
  $("autoStart").addEventListener("change", (e) => {
    state.settings.autoStart = !!e.target.checked;
    savePrefs();
  });

  loadPrefs();
  applySettingsToUI();
  refreshUI();
  log("Canvas Timelapse ready.");

  // pre-resolve the library root (if one was set before) so auto-filing works
  resolveLibraryRoot().then((r) => {
    if (r) log(`Library folder: ${r.nativePath}`, "ok");
  });

  restoreSession();   // offer recovery if a prior session's frames exist

  // watch for the user switching between open documents
  lastSeenDocId = app.activeDocument ? app.activeDocument.id : null;
  startDocWatch();

  // auto-start on launch (silent = don't pop a folder picker on a new doc)
  if (state.settings.autoStart && app.activeDocument) {
    log("Auto-start enabled — attempting to reconnect…");
    setTimeout(() => start({ silent: true }), 600);
  }
}

// ---------- preference persistence (settings that outlive a session) ----------
function savePrefs() {
  try {
    const p = {
      aspect: state.settings.aspect, fit: state.settings.fit,
      autoStart: state.settings.autoStart,
      fps: state.settings.fps, duration: state.settings.duration,
      maxSize: state.settings.maxSize, throttle: state.settings.throttle,
      holdLast: state.settings.holdLast,
    };
    localStorage.setItem("tl_prefs", JSON.stringify(p));
  } catch (_) {}
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("tl_prefs") || "{}");
    state.settings = { ...state.settings, ...p };
  } catch (_) {}
}

// expose for export module
window.__tlState = state;
window.__tlLog = log;

document.addEventListener("DOMContentLoaded", bind);
if (document.readyState !== "loading") bind();
