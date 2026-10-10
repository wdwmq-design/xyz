#!/usr/bin/env python3
"""
Debris Tracker - MATLAB bridge server.

Runs on YOUR PC next to MATLAB. The website (GitHub Pages) talks to it through
a Cloudflare/ngrok tunnel. It can:
  * run the MATLAB pipeline on the sample frames, or on BMPs uploaded from the site
  * report progress (MATLAB's console output)
  * serve the result files (JSON / CSV / PNG / GIF) and the frames

Security model (this endpoint runs a command on your PC, so it is locked down):
  * every /api call except /api/health needs the secret X-Token header
  * only origins listed in ALLOWED_ORIGINS may call it from a browser
  * the command that runs is FIXED (MATLAB_CMD); nothing from the client is executed
  * uploads: BMP only, header-validated, size/count limited, saved under server-chosen names
  * only one MATLAB job at a time; only a whitelist of result files is served
  * listens on 127.0.0.1 only (the tunnel is the only way in)

Environment variables (all optional except DEBRIS_TOKEN is strongly advised):
  DEBRIS_TOKEN      secret shared with the website (random one is printed if unset)
  ALLOWED_ORIGINS   comma list, default https://tan3650.github.io
  MATLAB_EXE        default "matlab" (set full path if not on PATH)
  MATLAB_CMD        default "main; track_debris"
  MATLAB_TIMEOUT    seconds, default 1200
  DEBRIS_REPO       repo root, default = parent of this folder
  PORT              default 5000
"""
import collections
import hmac
import json
import os
import re
import secrets
import shutil
import struct
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
REPO = Path(os.environ.get("DEBRIS_REPO", Path(__file__).resolve().parent.parent)).resolve()
DATA = REPO / "data"
FRAMES = DATA / "frames_bmp_debris"
RESULTS = DATA / "results"
LAST = RESULTS / "last_frames"          # copy of the frames used by the latest run
TRUTH = DATA / "debris_truth.mat"
SWAP = DATA / "_swap_backup"            # temporary home of the originals during an upload run
DEFAULTS = REPO / "debris_defaults.m"

MATLAB = os.environ.get("MATLAB_EXE", "matlab")
MATLAB_CMD = os.environ.get("MATLAB_CMD", "main; track_debris")
TIMEOUT = int(os.environ.get("MATLAB_TIMEOUT", "1200"))
PORT = int(os.environ.get("PORT", "5000"))
ORIGINS = {
    o.strip().rstrip("/")
    for o in os.environ.get("ALLOWED_ORIGINS", os.environ.get("ALLOWED_ORIGIN", "https://tan3650.github.io")).split(",")
    if o.strip()
}
TOKEN = os.environ.get("DEBRIS_TOKEN", "")
TOKEN_GENERATED = False
if not TOKEN:
    TOKEN = secrets.token_urlsafe(18)
    TOKEN_GENERATED = True

MIN_FRAMES, MAX_FRAMES = 3, 12
MAX_FILE = 8 * 1024 * 1024
MAX_DIM = 4096
EXPECTED_OUTPUTS = ["detections.json", "detections.csv", "tracks.json", "tracks.csv",
                    "detection_preview.png", "tracking_preview.png"]
SERVABLE = set(EXPECTED_OUTPUTS) | {"blink.gif", "frames_montage.png", "run_info.json", "evaluation.csv"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_FRAMES * MAX_FILE + 1024 * 1024

lock = threading.Lock()
job = {"id": None, "state": "idle", "mode": None, "started": None, "finished": None,
       "message": "", "log": collections.deque(maxlen=300)}


def log(msg):
    job["log"].append(str(msg).rstrip())


# --------------------------------------------------------------------------
# Security: token + origin + CORS
# --------------------------------------------------------------------------
@app.before_request
def guard():
    origin = request.headers.get("Origin")
    if origin and origin.rstrip("/") not in ORIGINS:
        return jsonify(error="origin not allowed"), 403
    if request.method == "OPTIONS" or request.path == "/api/health":
        return None
    if not request.path.startswith("/api/"):
        abort(404)
    sent = request.headers.get("X-Token", "")
    if not hmac.compare_digest(sent.encode(), TOKEN.encode()):
        time.sleep(0.6)                                  # slow down guessing
        return jsonify(error="bad token"), 401
    return None


@app.after_request
def cors(resp):
    origin = request.headers.get("Origin", "").rstrip("/")
    if origin in ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Headers"] = "X-Token, Content-Type, ngrok-skip-browser-warning"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Max-Age"] = "600"
        if request.headers.get("Access-Control-Request-Private-Network"):
            resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def natural_key(name):
    nums = re.findall(r"\d+", name or "")
    return (int(nums[-1]) if nums else 0, name or "")


def list_frames(folder):
    return sorted(folder.glob("*.bmp"), key=lambda p: natural_key(p.name))


def bmp_dims(b):
    """Validate a BMP header; return (w, h) or None."""
    if len(b) < 34 or b[:2] != b"BM":
        return None
    hdr = struct.unpack_from("<I", b, 14)[0]
    if hdr < 40:
        return None
    w, h = struct.unpack_from("<ii", b, 18)
    bpp = struct.unpack_from("<H", b, 28)[0]
    comp = struct.unpack_from("<I", b, 30)[0]
    h = abs(h)
    if not (1 <= w <= MAX_DIM and 1 <= h <= MAX_DIM):
        return None
    if bpp not in (8, 24, 32) or comp not in (0, 3):
        return None
    return (w, h)


def blink_is_on():
    """The blink comparator opens an interactive window and would hang MATLAB in batch mode."""
    try:
        txt = DEFAULTS.read_text(errors="replace")
    except OSError:
        return None
    return bool(re.search(r"^\s*(cfg|tc)\.blink\s*=\s*true", txt, re.M))


def read_uploads():
    files = request.files.getlist("frames")
    if not (MIN_FRAMES <= len(files) <= MAX_FRAMES):
        return None, f"Upload between {MIN_FRAMES} and {MAX_FRAMES} BMP files."
    items, dims = [], None
    for f in files:
        data = f.read()
        label = os.path.basename(f.filename or "file")
        if len(data) > MAX_FILE:
            return None, f"{label} is larger than {MAX_FILE // (1024 * 1024)} MB."
        d = bmp_dims(data)
        if d is None:
            return None, f"{label} is not a supported BMP (8/24/32-bit, uncompressed)."
        if dims is None:
            dims = d
        elif d != dims:
            return None, "All frames must have the same width and height."
        items.append((natural_key(f.filename), data))
    items.sort(key=lambda t: t[0])
    return [d for _, d in items], None


# --------------------------------------------------------------------------
# Swapping frames in/out for upload runs (always restored, also after a crash)
# --------------------------------------------------------------------------
def swap_in(frames):
    SWAP.mkdir(parents=True, exist_ok=False)
    if FRAMES.exists():
        shutil.move(str(FRAMES), str(SWAP / "frames_bmp_debris"))
    if TRUTH.exists():                                    # truth belongs to the sample frames only
        shutil.move(str(TRUTH), str(SWAP / "debris_truth.mat"))
    FRAMES.mkdir(parents=True)
    for i, b in enumerate(frames, 1):
        (FRAMES / f"debris_{i:02d}.bmp").write_bytes(b)


def recover_swap():
    if not SWAP.exists():
        return
    if FRAMES.exists():
        shutil.rmtree(FRAMES)
    bak = SWAP / "frames_bmp_debris"
    if bak.exists():
        shutil.move(str(bak), str(FRAMES))
    t = SWAP / "debris_truth.mat"
    if t.exists():
        shutil.move(str(t), str(TRUTH))
    shutil.rmtree(SWAP, ignore_errors=True)


# --------------------------------------------------------------------------
# The job
# --------------------------------------------------------------------------
def run_matlab():
    log(f'> {MATLAB} -batch "{MATLAB_CMD}"')
    proc = subprocess.Popen([MATLAB, "-batch", MATLAB_CMD], cwd=str(REPO),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, errors="replace", bufsize=1)
    timed_out = threading.Event()

    def kill():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(TIMEOUT, kill)
    timer.start()
    try:
        for line in proc.stdout:
            log(line)
        rc = proc.wait()
    finally:
        timer.cancel()
    if timed_out.is_set():
        raise RuntimeError(f"MATLAB timed out after {TIMEOUT} s and was stopped.")
    if rc != 0:
        raise RuntimeError(f"MATLAB exited with code {rc}. See the log.")


def snapshot_frames():
    LAST.mkdir(parents=True, exist_ok=True)
    for f in LAST.glob("*.bmp"):
        f.unlink()
    for f in list_frames(FRAMES):
        shutil.copy2(f, LAST / f.name)


def write_run_info(mode, started, ok, truth_used):
    fresh = [n for n in EXPECTED_OUTPUTS if (RESULTS / n).exists() and (RESULTS / n).stat().st_mtime >= started - 1]
    info = {"mode": mode, "ok": ok, "finished": datetime.now().isoformat(timespec="seconds"),
            "nFrames": len(list_frames(FRAMES)), "groundTruthUsed": truth_used,
            "fresh": fresh, "stale": [n for n in EXPECTED_OUTPUTS if n not in fresh]}
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "run_info.json").write_text(json.dumps(info, indent=2))


def worker(mode, frames):
    started = time.time()
    swapped = False
    ok = False
    truth_used = False
    try:
        recover_swap()
        RESULTS.mkdir(parents=True, exist_ok=True)
        if mode == "upload":
            log(f"Saving {len(frames)} uploaded frame(s); ground truth is NOT used for these.")
            swap_in(frames)
            swapped = True
        else:
            truth_used = TRUTH.exists()
            log("Running on the sample frames in data/frames_bmp_debris.")
        run_matlab()
        ok = True
    except Exception as e:                               # noqa: BLE001 - report everything to the UI
        job["message"] = str(e)
        log(f"ERROR: {e}")
    finally:
        try:
            snapshot_frames()
            write_run_info(mode, started, ok, truth_used)
        except Exception as e:                           # noqa: BLE001
            log(f"(could not write run info: {e})")
        if swapped:
            recover_swap()
            log("Original sample frames restored.")
        job["finished"] = time.time()
        job["state"] = "done" if ok else "error"
        if ok:
            job["message"] = "Finished."


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return jsonify(ok=True, busy=job["state"] == "running",
                   matlabFound=bool(shutil.which(MATLAB)),
                   blinkOff=(None if blink_is_on() is None else not blink_is_on()))


@app.get("/api/status")
def status():
    return jsonify(id=job["id"], state=job["state"], mode=job["mode"], message=job["message"],
                   elapsed=round((job["finished"] or time.time()) - job["started"], 1) if job["started"] else 0,
                   log=list(job["log"])[-120:])


@app.post("/api/run")
def run():
    mode = request.form.get("mode", "sample")
    if mode not in ("sample", "upload"):
        return jsonify(error="mode must be 'sample' or 'upload'"), 400
    if not shutil.which(MATLAB):
        return jsonify(error=f"MATLAB executable '{MATLAB}' not found. Set MATLAB_EXE to its full path."), 400
    if blink_is_on():
        return jsonify(error="debris_defaults.m has cfg.blink / tc.blink = true. It opens an interactive "
                             "window that hangs batch mode. Set both to false and try again."), 400
    frames = None
    if mode == "upload":
        frames, err = read_uploads()
        if err:
            return jsonify(error=err), 400
    elif not list_frames(FRAMES):
        return jsonify(error="No sample frames in data/frames_bmp_debris."), 400
    with lock:
        if job["state"] == "running":
            return jsonify(error="A MATLAB job is already running."), 409
        job.update(id=secrets.token_hex(4), state="running", mode=mode, started=time.time(),
                   finished=None, message="")
        job["log"].clear()
    threading.Thread(target=worker, args=(mode, frames), daemon=True).start()
    return jsonify(ok=True, id=job["id"]), 202


@app.get("/api/results/<name>")
def results(name):
    if name not in SERVABLE:
        abort(404)
    return send_from_directory(RESULTS, name)


@app.get("/api/frame/<int:k>")
def frame(k):
    folder = LAST if list_frames(LAST) else FRAMES
    files = list_frames(folder)
    if not (1 <= k <= len(files)):
        abort(404)
    return send_from_directory(folder, files[k - 1].name, mimetype="image/bmp")


# --------------------------------------------------------------------------
if __name__ == "__main__":
    recover_swap()
    print("=" * 64)
    print(" Debris Tracker bridge")
    print(f" repo           : {REPO}")
    print(f" MATLAB         : {MATLAB}  ({'found' if shutil.which(MATLAB) else 'NOT FOUND - set MATLAB_EXE'})")
    print(f" allowed origins: {', '.join(sorted(ORIGINS))}")
    if TOKEN_GENERATED:
        print(f" TOKEN (random, changes every start): {TOKEN}")
    else:
        print(" token          : taken from DEBRIS_TOKEN")
        if len(TOKEN) < 12:
            print(" WARNING        : token is short - use 16+ random characters")
    if blink_is_on():
        print(" WARNING        : debris_defaults.m has blink = true; set it to false for batch runs")
    print(f" listening on   : http://127.0.0.1:{PORT}  (point the tunnel here)")
    print("=" * 64)
    app.run(host="127.0.0.1", port=PORT, threaded=True)
