#!/usr/bin/env python3
"""
Rebuild canvas-timelapse.ccx from the plugin source files.

Usage:
    python3 build-ccx.py            # rebuild, auto-bump patch version (1.0.0 -> 1.0.1)
    python3 build-ccx.py --no-bump  # rebuild, keep the current version
    python3 build-ccx.py 1.3.0      # rebuild and set an explicit version

A .ccx is just a ZIP of the plugin files with manifest.json at the archive ROOT.
Photoshop only UPGRADES an installed plugin when manifest "version" increases,
so this bumps the patch number by default. After it runs, double-click the .ccx.
"""
import json, os, sys, zipfile

PROJ = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(PROJ, "canvas-timelapse.ccx")
# Runtime files only — README / build script / stray icons are dev-only.
INCLUDE = ["manifest.json", "index.html", "main.js", "export.js"]

def bump_patch(v):
    parts = v.split(".")
    while len(parts) < 3:
        parts.append("0")
    parts[2] = str(int(parts[2]) + 1)
    return ".".join(parts[:3])

def main():
    mpath = os.path.join(PROJ, "manifest.json")
    with open(mpath) as f:
        mani = json.load(f)          # also validates the manifest parses

    arg = sys.argv[1] if len(sys.argv) > 1 else None
    old = mani.get("version", "1.0.0")
    if arg == "--no-bump":
        new = old
    elif arg:
        new = arg                    # explicit version like 1.3.0
    else:
        new = bump_patch(old)

    if new != old:
        mani["version"] = new
        with open(mpath, "w") as f:
            json.dump(mani, f, indent=2)
            f.write("\n")

    # Confirm every file exists before zipping
    missing = [n for n in INCLUDE if not os.path.exists(os.path.join(PROJ, n))]
    if missing:
        print("ERROR missing files:", missing); sys.exit(1)

    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for name in INCLUDE:
            z.write(os.path.join(PROJ, name), arcname=name)  # root-level, no folder

    with zipfile.ZipFile(OUT) as z:                # integrity check
        assert z.testzip() is None, "archive corrupt"
        entries = z.namelist()

    print(f"version: {old} -> {new}" if new != old else f"version: {new} (unchanged)")
    print("entries:", entries)
    print("size:", os.path.getsize(OUT), "bytes")
    print("built:", OUT)
    print("\nNext: double-click canvas-timelapse.ccx to (re)install, then restart Photoshop.")

if __name__ == "__main__":
    main()
