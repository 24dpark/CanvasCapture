# Canvas Timelapse — Photoshop 2026 UXP plugin

Auto-records a timelapse of your artwork by snapshotting the canvas on every
edit, then stitches the frames into an MP4 — the Procreate/Krita workflow,
brought to Photoshop.

## What it does
- Listens to Photoshop's history (event-driven, no polling) and captures a PNG
  frame every time you commit an edit (brush stroke, fill, filter, transform…).
- Grabs the flattened composite straight from your live document — no duplicate
  doc, no document switching, no canvas flicker. Your real document and its undo
  history are never touched.
- Choose a target video length (Full / 15s / 30s / 60s) and export to `timelapse.mp4`.
- Crash-resilient: frames are written to disk instantly and the session can be
  recovered after a reload, restart, or crash.

## How detection works (honest version)
Photoshop gives plugins NO "brush stroke ended" event, so instead of hooking
strokes directly we subscribe to `historyStateChanged`. Every committed edit
creates a history state → we snapshot. A short debounce (the "throttle" setting)
collapses a burst of rapid states into one frame so the file doesn't explode.

Consequences to know:
- 1 frame = 1 history state, NOT literally 1 brush-down. Fills/filters/transforms
  also produce frames. In practice it looks just like a normal drawing timelapse.
- Very fast successive strokes inside one throttle window merge into one frame.
- Snapshotting adds a little overhead per edit. Downscaling (default longest
  edge 1920px) keeps Photoshop responsive on big canvases.

## How capture works (no black flash)
Snapshots use the UXP `imaging.getPixels()` API to read the merged composite of
your live document directly, downscaling during the grab. Nothing is duplicated,
made active, or closed — so the canvas never flickers and captures are fast.
(An earlier build duplicated + closed a temp doc per capture, which caused a
black flash on every stroke. That approach is gone.)

Note on transparency: capture uses `applyAlpha: true`. If your document has a
fully transparent background, those areas may render dark in the PNG. Put a
filled background layer at the bottom if you want an opaque timelapse.

## Video length control
Pick a target length in the panel:
- **Full length** — every frame plays at your chosen Playback FPS.
  Duration = frames ÷ fps.
- **15 / 30 / 60 seconds** — the export always lands at ~that length:
  - Too many frames → evenly **samples** frames down (drops the excess) while
    keeping FPS smooth.
  - Too few frames → **stretches** by lowering FPS so the frames fill the target
    (can look choppy if you drew very little — that's unavoidable without
    inventing frames).

The log panel prints the exact plan each export, e.g.
`30s · sampled 720/2000 frames @ 24fps`.

Export builds a clean, renumbered `frames_render/` subfolder containing exactly
the frames to encode — your original `frame_######.png` files are never altered.

## Crash resilience & recovery
- **Every frame is written to disk the instant it's captured.** Closing
  Photoshop, closing without pressing Stop, or a crash never loses captured
  frames (at most a hard kill mid-write can truncate the single last PNG).
- A `session.json` manifest (frame count + settings) is refreshed every ~10
  frames and on Stop.
- A **persistent folder token** lets the plugin re-find your session folder
  after a reload/restart.
- On startup the panel auto-detects an unfinished session and reattaches:
  *"Recovered previous session: N frames on disk."* It never auto-resumes
  recording — it just makes those frames one-click exportable again.
- **Recover folder…** button: manually point at ANY old timelapse folder and
  load its frames + settings for export. Frame count is read from the actual
  `frame_######.png` files on disk (source of truth).

Note: "close the program" and "close without pressing Stop" are the same event —
closing tears down the plugin either way. Stop is not what saves your work; the
per-frame disk writes are. Stop just flushes the final manifest.

## Install / load (dev)
1. Install **Adobe UXP Developer Tool (UDT)** from Creative Cloud → Apps →
   "UXP Developer Tools".
2. Open UDT → **Add Plugin** → select this folder's `manifest.json`
   (`C:\Users\dnlpr\Desktop\projects\canvas-timelapse\manifest.json`).
3. Make sure Photoshop 2026 is running, then in UDT click **Load** next to the
   plugin. The "Canvas Timelapse" panel appears in Photoshop
   (Window → Extensions / Plugins if it doesn't auto-show).
4. When you change the code, hit **Reload** in UDT — no reinstall needed.
   (If a manifest change fails to load, **Remove** the entry and Add Plugin fresh
   so UDT doesn't reuse a cached manifest.)

## Use
1. Open/create a document.
2. Press **Start** → pick a folder to store this session's frames.
3. Draw. The frame counter climbs as you work.
4. **Stop** when done.
5. Pick a **Video length** and press **Export MP4** → renders `timelapse.mp4`
   into the session folder.

## Hands-free multi-project workflow (auto-start + per-document folders)
Two features let the plugin record every project automatically without picking a
folder each time:

**1. Set a Library folder (once).** Click **Set Library folder…** and choose a
root, e.g. `Desktop\timelapses`. From then on, every SAVED `.psd` you work on
automatically gets its own subfolder created under that root — named from the
file plus a short hash of its full path (so two files with the same name in
different places never collide). No per-project picker ever again.

**2. Tick "Auto-start on launch".** When the panel opens it silently reconnects
the active document to its folder and begins recording. Combined with a
permanent install (below), opening Photoshop = the timelapse is already running.

**Switching documents live.** While the panel is open, a watcher notices when you
switch to a different open `.psd`. It flushes the outgoing project, then rebinds
to the new document's own folder and continues *its* timelapse — resuming the
frame count from whatever's already on disk. Open a piece you drew last week and
it keeps counting up from frame N, not from 1.

How a document finds its folder, in order:
1. **Registry reconnect** — we've seen this exact file before → reuse its folder.
2. **Library auto-subfolder** — saved file + a Library root set → deterministic
   subfolder (created if missing).
3. **Manual pick** — only when you press Start yourself and neither above applies.

Honest caveats (unchanged from the reconnect design):
- Identity is the **saved .psd path**. An unsaved/untitled doc has no
  cross-launch identity, so auto-start/auto-file wait until you save it once.
- Renaming or moving the .psd breaks the link → it starts a fresh folder (the
  path is the identity). The deterministic hash means re-opening from the *same*
  path always re-finds the same folder even if the in-app registry was wiped.
- Frame numbering resumes from the highest existing `frame_######.png`, so
  manually deleting frames shifts where the next capture continues.
- The switch watcher polls once per second — a ~1s settle after switching docs is
  normal (UXP exposes no document-activated event, so polling is the honest way).

## Permanent install — no UDT every session (.ccx)
UDT (the UXP Developer Tool) is a *developer* loader: it deliberately forgets the
plugin every time Photoshop restarts. To make Canvas Timelapse a real installed
plugin — shows up under **Plugins** menu on every launch, panel reopens where you
docked it, survives restarts — package it as a `.ccx` and double-click to install:

1. Get a `.ccx`. Easiest — no tooling:
   UDT → Add Plugin → select `manifest.json` → plugin row ••• → **Package…** →
   save `canvas-timelapse.ccx`.
   A `.ccx` is just a ZIP of the plugin files with `manifest.json` at the archive
   ROOT, so you can also build it directly (what was done here):
   `python3 -c "import zipfile;
   [zipfile.ZipFile('canvas-timelapse.ccx','w',zipfile.ZIP_DEFLATED).write(f,f) for f in ['manifest.json','index.html','main.js','export.js']]"`
   (Do NOT nest the files inside a folder — manifest.json must be top-level or the
   installer rejects it.)
2. **Double-click the `.ccx`.** Creative Cloud's UXP installer registers it with
   Photoshop permanently. Reopen Photoshop → Plugins menu → **Canvas Timelapse**.
3. To update after code changes: bump `version` in `manifest.json`, re-package,
   double-click the new `.ccx` — it upgrades in place.

Notes:
- A self-packaged `.ccx` is *unsigned* — Photoshop may warn "from an unidentified
  developer" on install. That's expected for a personal/sideloaded plugin; click
  through. A signed, warning-free install requires Adobe Marketplace submission.
- Use UDT for active development (live Reload), the `.ccx` for daily use. They can
  coexist; just don't run both copies of the panel at once.

Settings:
- **Video length** — Full, or a fixed 15 / 30 / 60s target.
- **Playback FPS** — frame rate used for Full length and as the smooth cap when
  sampling.
- **Max frame size** — downscale cap; "Full res" for archival (slower, big files).
- **Throttle** — min ms between frames; higher = fewer, cleaner frames.

## Export: two paths
- **Primary** — Photoshop's built-in H.264 Render Video (fully in-app, no
  external tools).
- **Fallback** — if the native encoder API differs on your build, the plugin
  writes `encode.sh` (WSL/mac/linux) and `encode.bat` (Windows) into the session
  folder, pointed at `frames_render/`. Double-click `encode.bat` (needs ffmpeg on
  PATH) to produce the MP4. Your PNG frames are always safe regardless.

## Files
- `manifest.json` — plugin metadata + permissions
- `index.html` — panel UI
- `main.js` — capture engine (history listener, live-composite snapshot,
  session persistence + recovery)
- `export.js` — render planner + MP4 render (native + ffmpeg fallback)
- `README.md` — this file

Generated per-session in your chosen folder:
- `frame_######.png` — raw captured frames
- `session.json` — recovery manifest
- `frames_render/` — renumbered frames actually encoded (rebuilt each export)
- `timelapse.mp4` — the output
- `encode.sh` / `encode.bat` — only if the ffmpeg fallback is used

## Known first-run checks (flagged [VERIFY] in code)
- `imaging.getPixels` / `imaging.encodeImageData` signatures — `main.js`
- Render Video batchPlay descriptor keys — `export.js`
Both have graceful fallbacks; if either throws, the log panel tells you exactly
what happened and your frames remain on disk.

## Not done yet (release checklist)
Before a public release, still to do:
- End-to-end export verified on real hardware (both [VERIFY] paths).
- Proper icon assets (23×23 + 48×48) re-added to the manifest.
- Tighten `localFileSystem` permission if possible for Marketplace review.
- Unique publisher name + final plugin ID in `manifest.json`.
- Do NOT bundle ffmpeg binaries (GPL/LGPL) — rely on native render or the user's
  own ffmpeg.
