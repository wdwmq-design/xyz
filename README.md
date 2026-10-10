# Debris Tracker web console

```
Browser (GitHub Pages)  ->  tunnel  ->  server/server.py (your PC)  ->  matlab -batch "main; track_debris"
        ^                                                                       |
        +------------------ data/results/*.json, *.csv, *.png <----------------+
```

Two modes, shown in the Connection window:
- **DEMO**: reads the saved files in `data/results/` from the repository. MATLAB is not running.
- **LIVE**: your PC runs MATLAB when you press a button; the page then shows the fresh results.

## 1. Copy the files into your repo

```
debris-tracker/
  frontend/   index.html  style.css  app.js
  server/     server.py   requirements.txt
```

Add to `.gitignore`:

```
data/results/last_frames/
data/_swap_backup/
```

## 2. Two edits so MATLAB can run unattended

In `debris_defaults.m` set both blink flags to false (the blink tool opens an interactive window and would hang `matlab -batch`; the server refuses to run while they are true):

```matlab
cfg.blink = false;
tc.blink  = false;
```

Needs MATLAB R2019a or newer (`-batch`) and the Image Processing Toolbox, as before.
Test it once by hand from the repo folder: `matlab -batch "main; track_debris"`. If that does not finish and write `data\results\tracks.json`, the server cannot work either.

## 3. Start the server (Windows PowerShell)

```powershell
cd C:\Users\Test\OneDrive\Desktop\debris-tracker\server
pip install -r requirements.txt
$env:DEBRIS_TOKEN = "choose-a-long-random-secret"
# if "matlab" is not found on PATH:
# $env:MATLAB_EXE = "C:\Program Files\MATLAB\R2024b\bin\matlab.exe"
python server.py
```

The console prints the repo path, whether MATLAB was found, and the allowed origin.

### Test locally first (no tunnel)

```powershell
# terminal 1 (server also allows the local page)
$env:ALLOWED_ORIGINS = "https://tan3650.github.io,http://localhost:8000"
python server.py
# terminal 2, from the repo root
python -m http.server 8000
```

Open `http://localhost:8000/frontend/`, enter `http://localhost:5000` and your token, press Connect, then Run on sample data.

## 4. Tunnel (so the GitHub Pages site can reach your PC)

Cloudflare quick tunnel (no account needed; the address changes every time):

```powershell
cloudflared tunnel --url http://localhost:5000
```

Copy the `https://....trycloudflare.com` address it prints into the site's Server URL box. (ngrok works the same way: `ngrok http 5000`.)

## 5. Publish the site

Push the repo, then on GitHub: Settings -> Pages -> Deploy from branch `main`, folder `/ (root)`.
The site will be at `https://tan3650.github.io/debris-tracker/frontend/`
(demo mode reads `../data/results/` and `../data/frames_bmp_debris/`, so commit those folders).

## 6. Safety rules (this endpoint can run MATLAB on your PC)

- Use a long random `DEBRIS_TOKEN`; never commit it. Anyone with the tunnel address AND the token can start a MATLAB run.
- Only run the tunnel while you are presenting; stop it afterwards.
- Do not widen `ALLOWED_ORIGINS` to `*`. The server also locks it to the listed sites.
- The server never runs anything the page sends: the command is fixed (`MATLAB_CMD`). Uploads are checked as real BMPs, capped at 12 files of 8 MB, and stored under names the server picks.
- It listens on 127.0.0.1 only; the tunnel is the only way in.

## 7. What happens on an upload run

The server temporarily moves your sample frames and `debris_truth.mat` to `data/_swap_backup`, writes the uploaded frames as `debris_01.bmp...`, runs MATLAB, then **restores your originals** (also automatically at the next server start if a crash interrupted it). Uploaded runs have no ground truth, so the accuracy panel says so. The page flags any result file that the run did not rewrite (for example `blink.gif`, which only `blink_frames.m` makes).

## Known limits

- It only works while your PC, MATLAB, the server and the tunnel are all running; otherwise use DEMO mode.
- One run at a time. A run times out after 20 minutes (`MATLAB_TIMEOUT`).
- `tracks.json` was not available when this was written; the track window reads `tracks.csv` for the paths and uses `tracks.json` best-effort (speed, heading, predictions, ellipses, PINN). If an overlay is missing, check that file's structure.
- Coordinates are image pixels, not sky coordinates.
