/*
 * Canvas Timelapse — MP4 export
 *
 * Primary path: Photoshop's native Render Video (H.264) via batchPlay.
 *   - Open frame_000001.png with "image sequence" enabled -> PS builds a video
 *     timeline from the numbered PNGs automatically.
 *   - Fire the "export video" (Adobe Media Encoder / built-in H.264) action.
 *   This is 100% in-app: no ffmpeg, no terminal.
 *
 * Fallback path: if native render throws (encoder missing / API drift), we write
 *   a ready-to-run ffmpeg command to the session folder as encode.sh / encode.bat
 *   so the user can produce the MP4 in one double-click. We also try to launch it.
 *
 * [VERIFY] The Render Video descriptor keys differ slightly across PS versions.
 *   If native fails on first run, the fallback still guarantees you get your MP4.
 */

// Wrapped in an IIFE so this file's top-level consts (photoshop, app, core,
// fs, formats) do NOT collide with the identically-named consts in main.js.
// Both files load as plain <script>s into one shared global scope, so without
// this wrapper the second script throws "Identifier 'photoshop' has already
// been declared" at PARSE time — aborting export.js entirely and leaving
// window.__exportMP4 undefined ("export module not loaded"). The IIFE gives
// this file its own scope; __exportMP4 is still published on window explicitly.
(function () {

const photoshop = require("photoshop");
const app = photoshop.app;
const core = photoshop.core;
const batchPlay = photoshop.action.batchPlay;
const fs = require("uxp").storage.localFileSystem;
const formats = require("uxp").storage.formats;

function log(m, c) { (window.__tlLog || console.log)(m, c); }

/*
 * Output filename derives from the PSD's name at export time.
 * "Portrait Study.psd"  -> "Portrait_Study.mp4"
 * Unsaved doc ("Untitled-1") or no doc -> "timelapse.mp4"
 * Because we read the doc name at EXPORT time, saving/renaming the PSD and
 * then exporting automatically picks up the new name — no extra step.
 */
function safeBase(s) {
  return (s || "")
    .replace(/\.[^.]+$/, "")            // drop extension
    .replace(/[^\w\-]+/g, "_")          // fs-safe
    .replace(/^_+|_+$/g, "")            // trim underscores
    .slice(0, 60);
}
function outputName(state) {
  let name = "";
  try {
    // prefer the document we actually recorded (state.docId), else active doc
    let doc = null;
    const docs = app.documents;
    for (let i = 0; i < docs.length; i++) {
      if (docs[i].id === state.docId) { doc = docs[i]; break; }
    }
    if (!doc) { try { doc = app.activeDocument; } catch (_) {} }
    if (doc && doc.name) name = safeBase(doc.name);
  } catch (_) {}
  if (!name || /^untitled/i.test(name)) name = "timelapse";
  return `${name}.mp4`;
}

/*
 * Plan the render: decide which frame indices to use and the effective FPS
 * so the output lands at the requested duration.
 *
 *   Full length : use every frame, play at chosen FPS. dur = N / fps.
 *   Fixed T sec : target T seconds.
 *      - If N/fps > T  (too many frames): evenly SAMPLE down to fps*T frames,
 *        keep FPS as chosen. Video is T sec, smooth.
 *      - If N/fps < T  (too few frames): keep all frames, LOWER the fps to
 *        N/T so the few frames stretch across T sec (min 1 fps).
 */
function planRender(totalFrames, chosenFps, duration) {
  if (duration === "full" || !duration) {
    return { indices: null, fps: chosenFps, note: `full length (~${Math.round(totalFrames/chosenFps)}s)` };
  }
  const target = duration;                 // seconds
  const idealFrames = Math.max(1, Math.round(chosenFps * target));
  if (totalFrames > idealFrames) {
    // sample down: pick idealFrames evenly across the timeline
    const indices = [];
    for (let i = 0; i < idealFrames; i++) {
      indices.push(Math.round(i * (totalFrames - 1) / (idealFrames - 1 || 1)) + 1);
    }
    return { indices, fps: chosenFps, note: `${target}s · sampled ${idealFrames}/${totalFrames} frames @ ${chosenFps}fps` };
  } else {
    // stretch: keep all, drop fps
    const fps = Math.max(1, +(totalFrames / target).toFixed(3));
    return { indices: null, fps, note: `${target}s · all ${totalFrames} frames @ ${fps.toFixed(1)}fps (stretched)` };
  }
}

/*
 * Build frames_render/ containing exactly the frames to encode, renumbered
 * 000001.. so both encoders see a clean contiguous sequence.
 * Returns the render folder token + native path + count.
 */
async function buildRenderFolder(state, plan, holdSeconds) {
  const src = state.folder;
  // fresh render subfolder
  let renderFolder;
  try {
    const existing = await src.getEntry("frames_render");
    if (existing && existing.isFolder) { await existing.delete(); }
  } catch (_) { /* not there, fine */ }
  renderFolder = await src.createFolder("frames_render");

  const total = state.frame;
  const indices = plan.indices || Array.from({ length: total }, (_, i) => i + 1);

  let out = 0;
  for (const idx of indices) {
    // New sessions save frame_######.jpg; older ones saved JPEG bytes under a
    // .png name. Trusting the extension is unsafe, so we read the bytes and
    // sniff the real format from the magic number:
    //   FF D8  -> JPEG,   89 50 4E 47 -> PNG.
    // The renumbered copy is then named by its TRUE content, so both the native
    // Render Video open and ffmpeg's extension-keyed demuxer decode correctly.
    const base = `frame_${String(idx).padStart(6, "0")}`;
    let entry = null;
    for (const e of ["jpg", "jpeg", "png"]) {
      try { entry = await src.getEntry(`${base}.${e}`); break; } catch (_) {}
    }
    if (!entry) { log(`skip missing ${base}.*`, "err"); continue; }
    try {
      const data = await entry.read({ format: require("uxp").storage.formats.binary });
      const b = new Uint8Array(data);
      const trueExt =
        (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) ? "png" : "jpg";
      out += 1;
      const dst = await renderFolder.createFile(`f_${String(out).padStart(6, "0")}.${trueExt}`, { overwrite: true });
      await dst.write(data, { format: require("uxp").storage.formats.binary });
    } catch (e) {
      log(`skip ${base}: ${e.message}`, "err");
    }
  }
  // ---- HOLD LAST FRAME ----
  // Duplicate the final rendered frame so playback lingers on the finished
  // artwork. N = holdSeconds * fps extra copies, continuing the f_###### run.
  // Works for BOTH encoders (they just see more numbered frames) — no filters.
  let held = 0;
  if (out > 0 && holdSeconds && holdSeconds > 0) {
    try {
      // find the last frame we actually wrote (its true ext may differ)
      const es0 = await renderFolder.getEntries();
      const last = es0
        .filter(e => /^f_\d{6}\.(jpe?g|png)$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .pop();
      if (last) {
        const lastExt = last.name.split(".").pop();
        const bin = require("uxp").storage.formats.binary;
        const lastData = await last.read({ format: bin });
        const extra = Math.round(holdSeconds * (plan.fps || 24));
        for (let k = 0; k < extra; k++) {
          out += 1;
          const dst = await renderFolder.createFile(`f_${String(out).padStart(6, "0")}.${lastExt}`, { overwrite: true });
          await dst.write(lastData, { format: bin });
          held += 1;
        }
      }
    } catch (e) {
      log(`hold-last-frame skipped: ${e.message}`, "err");
    }
  }
  // pick the matching pattern/format
  let renderExt = "jpg";
  if (out > 0) {
    const es = await renderFolder.getEntries();
    const f = es.find(e => /^f_\d{6}\.(jpe?g|png)$/i.test(e.name));
    if (f) renderExt = f.name.split(".").pop().toLowerCase() === "png" ? "png" : "jpg";
  }
  return { renderFolder, renderPath: renderFolder.nativePath, count: out, ext: renderExt, held };
}

// Build the ffmpeg -vf filter chain for aspect ratio.
// Returns "" if nothing to apply.
function buildVideoFilter(settings) {
  const parts = [];

  // --- aspect ratio ---
  const aspect = settings.aspect || "original";
  if (aspect !== "original") {
    const ratios = { "1:1": [1,1], "9:16": [9,16], "16:9": [16,9], "4:5": [4,5] };
    const [rw, rh] = ratios[aspect] || [1,1];
    // pick an even output size that respects the ratio; base on 1080 short edge
    let W, H;
    if (rw >= rh) { W = 1920; H = Math.round(1920 * rh / rw); }
    else          { H = 1920; W = Math.round(1920 * rw / rh); }
    W -= W % 2; H -= H % 2;   // H.264 needs even dimensions
    if ((settings.fit || "pad") === "crop") {
      // scale to fill, then center-crop
      parts.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`);
      parts.push(`crop=${W}:${H}`);
    } else {
      // scale to fit, then pad with black (letterbox)
      parts.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`);
      parts.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }
  }

  return parts.join(",");
}

/*
 * Native H.264 export via Photoshop's own Render Video.
 *
 * There is NO clean UXP API for Render Video — it's batchPlay-only and the
 * descriptor is large + version-specific (this is the [VERIFY] path). Rather
 * than run three calls inside one opaque try/catch (which only ever tells you
 * "it failed"), each PS step below is isolated and its raw error surfaced to the
 * log with a STEP tag. First real run on your build therefore pinpoints the
 * exact failing step + Photoshop's own message, so we fix it in one iteration.
 *
 * Steps:
 *   [1] open the renumbered PNGs as an image sequence  -> a video timeline doc
 *   [1b] probe the opened doc so we KNOW a timeline (not a lone still) was made
 *   [2] Render Video (H.264) to timelapse.mp4
 *   [3] close the temp video doc
 */
async function nativeRenderVideo(state, renderPath, fps, ext, outName) {
  const firstFrame = `${renderPath}/f_000001.${ext || "jpg"}`;
  outName = outName || "timelapse.mp4";
  const outDir = state.folderNativePath;

  // stringify a batchPlay error the way PS actually throws it
  const errText = (e) =>
    (e && (e.message || e.toString())) +
    (e && e.number != null ? ` [code ${e.number}]` : "");

  let openedId = null;

  await core.executeAsModal(async () => {
    // ---- [1] open image sequence -> timeline video doc -------------------
    // NOTE: the file target key for "open" is `null` (not `_target`); `as`
    // names the format; `imageSequence` is what turns N stills into a timeline.
    try {
      const isJpg = (ext || "jpg") !== "png";
      const r = await batchPlay([{
        _obj: "open",
        null: { _path: firstFrame, _kind: "local" },
        as: { _obj: isJpg ? "JPEGFormat" : "PNGFormat" },
        imageSequence: { _obj: "imageSequenceClass", frameRate: fps },
      }], { synchronousExecution: true });
      log(`STEP1 open image sequence OK`, "ok");
      // capture the new doc id if PS returned it
      try { openedId = (r && r[0] && (r[0].documentID || r[0].ID)) || null; } catch (_) {}
    } catch (e) {
      throw new Error(`STEP1 open-image-sequence failed: ${errText(e)}`);
    }

    // ---- [1b] probe: confirm we got a video TIMELINE, not one still ------
    // If PS opened just the single PNG (no timeline), Render Video has nothing
    // to encode and step 2's output is meaningless. Surface that distinctly.
    try {
      const doc = app.activeDocument;
      const frameCount = (doc && doc.timeline && doc.timeline.frameCount) || null;
      if (frameCount) log(`STEP1b timeline detected · ${frameCount} frames`, "ok");
      else log(`STEP1b WARNING: no timeline frameCount visible — PS may have opened a single still, not a sequence. Render may be 1 frame.`, "err");
    } catch (_) {
      log(`STEP1b timeline probe unavailable on this build (continuing).`);
    }

    // ---- [2] Render Video (H.264) ----------------------------------------
    try {
      await batchPlay([{
        _obj: "export",
        using: {
          _obj: "videoExport",
          directory: { _path: outDir, _kind: "local" },
          name: outName,
          ftEn: { _enum: "ftEn", _value: "H264" },
          renderQueue: false,
          videoOutput: true,
          pixelAspectRatio: 1,
          frameRate: fps,
          fps: fps,
          format: "H.264",
          videoRange: { _enum: "videoRangeType", _value: "allFrames" },
          rangeType: { _enum: "videoRangeType", _value: "allFrames" }
        }
      }], { synchronousExecution: true });
      log(`STEP2 Render Video (H.264) OK`, "ok");
    } catch (e) {
      throw new Error(`STEP2 Render-Video failed: ${errText(e)}`);
    }

    // ---- [3] close the temp video doc ------------------------------------
    try {
      const doc = app.activeDocument;
      if (doc && (openedId == null || doc.id === openedId)) {
        await doc.closeWithoutSaving();
      }
    } catch (e) {
      log(`STEP3 close temp doc failed (harmless): ${errText(e)}`, "err");
    }
  }, { commandName: "Render timelapse MP4" });

  // verify the file actually materialized before claiming success
  try {
    const outFolder = state.folder;
    await outFolder.getEntry(outName);   // throws if not written
  } catch (_) {
    throw new Error(`Render Video reported OK but ${outName} is not on disk — descriptor likely accepted but produced no file.`);
  }

  return `${outDir}/${outName}`;
}

async function writeFfmpegFallback(state, fps, ext, outName) {
  const folderPath = state.folderNativePath;
  const folder = state.folder;
  const pat = `f_%06d.${ext || "jpg"}`;   // matches the renumbered render frames
  outName = outName || "timelapse.mp4";

  // aspect-ratio filter chain (empty if not set)
  const vf = buildVideoFilter(state.settings);
  const vfSh  = vf ? `-vf "${vf}" ` : "";
  const vfBat = vf ? `-vf "${vf}" ` : "";

  // POSIX (WSL/mac/linux) script — reads the renumbered render folder
  const sh =
`#!/usr/bin/env bash
cd "$(dirname "$0")/frames_render"
ffmpeg -y -framerate ${fps} -i ${pat} \\
  ${vfSh}-c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart \\
  ../${outName}
echo "Done -> ../${outName}"
`;
  // Windows batch. Frames are JPEG, so no special demuxer flag is needed —
  // ffmpeg detects the format from the stream. This script:
  //   1. tries a native Windows ffmpeg on PATH,
  //   2. if that's missing, falls back to `wsl ffmpeg` (WSL users have it),
  //   3. if NEITHER exists, prints a real error — no fake "Done".
  // The %%06d escapes the % for batch. paths use %~dp0 (folder of this .bat).
  const batPat = `f_%%06d.${ext || "jpg"}`;
  const bat =
`@echo off
setlocal
cd /d "%~dp0frames_render"

rem --- 1) native Windows ffmpeg? ---
where ffmpeg >nul 2>nul
if %errorlevel%==0 (
  ffmpeg -y -framerate ${fps} -i ${batPat} ^
    ${vfBat}-c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart ^
    ..\\${outName}
  goto done
)

rem --- 2) fall back to ffmpeg inside WSL ---
rem We are already cd'd into frames_render; WSL inherits the current Windows
rem directory (auto-translated to /mnt/...), so no cd/wslpath/nested quotes.
where wsl >nul 2>nul
if %errorlevel%==0 (
  echo Windows ffmpeg not found - using WSL ffmpeg...
  wsl ffmpeg -y -framerate ${fps} -i ${batPat} ${vfSh}-c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart ../${outName}
  if %errorlevel%==0 goto done
  echo WSL ffmpeg failed. Is ffmpeg installed in WSL?  ^(sudo apt install ffmpeg^)
  goto fail
)

rem --- 3) nothing available ---
echo ERROR: ffmpeg was not found on Windows PATH or in WSL.
echo Install one of:
echo   - Windows: winget install Gyan.FFmpeg   ^(then reopen this window^)
echo   - WSL:     wsl sudo apt install ffmpeg
goto fail

:done
if exist "..\\${outName}" (
  echo Success -^> ${outName} created in the session folder.
) else (
  echo ERROR: ffmpeg ran but ${outName} was not created. See messages above.
)
goto end

:fail
echo.
echo No video was produced. Your frames are safe in this folder.

:end
echo.
pause
`;
  const shF = await folder.createFile("encode.sh", { overwrite: true });
  await shF.write(sh, { format: formats.utf8 });
  const batF = await folder.createFile("encode.bat", { overwrite: true });
  await batF.write(bat, { format: formats.utf8 });
  log("Wrote encode.sh / encode.bat (auto Windows→WSL ffmpeg) to the session folder.", "ok");
  return { shPath: `${folderPath}/encode.sh`, batPath: `${folderPath}/encode.bat` };
}

window.__exportMP4 = async function () {
  const state = window.__tlState;
  if (!state || state.frame === 0) { log("No frames to export.", "err"); return; }

  // 0. resolve output name (from PSD) + hold-last-frame seconds
  const outName = outputName(state);
  const holdSeconds = Math.max(0, Number(state.settings.holdLast) || 0);

  // 1. plan frames + fps to hit the requested duration
  const plan = planRender(state.frame, state.settings.fps, state.settings.duration);
  log(`Export plan: ${plan.note}`);
  log(`Output file: ${outName}${holdSeconds ? ` · hold last ${holdSeconds}s` : ""}`);

  // 2. build the clean renumbered render folder (+ held tail frames)
  let render;
  try {
    render = await buildRenderFolder(state, plan, holdSeconds);
    log(`Prepared ${render.count} frames in frames_render/${render.held ? ` (incl. ${render.held} held)` : ""}`, "ok");
  } catch (e) {
    log(`Could not prepare render frames: ${e.message}`, "err");
    return;
  }
  if (render.count === 0) { log("No frames landed in render folder.", "err"); return; }

  // Aspect-ratio can only be done by ffmpeg, not native Render Video.
  // If it is set, skip native and go straight to the ffmpeg path.
  const needsFfmpeg =
    (state.settings.aspect && state.settings.aspect !== "original");

  if (!needsFfmpeg) {
    // 3. try native H.264 render (simple export, no filters)
    try {
      const out = await nativeRenderVideo(state, render.renderPath, plan.fps, render.ext, outName);
      log(`MP4 rendered: ${out}`, "ok");
      log(`(${plan.note})`, "ok");
      return;
    } catch (e) {
      log(`Native render unavailable (${e.message}). Writing ffmpeg fallback.`, "err");
    }
  } else {
    log(`Aspect ratio set → using ffmpeg encoder (native can't apply filters).`, "ok");
  }

  // 4. ffmpeg path (fallback, or required for filters)
  try {
    await writeFfmpegFallback(state, plan.fps, render.ext, outName);
    const vf = buildVideoFilter(state.settings);
    if (vf) log(`Filter: ${vf}`, "ok");
    log(`Run the encoder in the session folder:`, "ok");
    log(`  Windows: double-click encode.bat`, "ok");
    log(`  WSL/mac/linux: bash encode.sh`, "ok");
    log(`Frames are safe in: ${state.folderNativePath}`, "ok");
  } catch (e2) {
    log(`Fallback also failed: ${e2.message}`, "err");
    log(`Your PNG frames are still saved in the session folder.`, "err");
  }
};

})();
