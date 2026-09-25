#!/usr/bin/env python3
"""Recap Studio - local web shell around app.py.

This file never touches the translation/voice/video pipeline logic in
app.py - it runs app.py as a subprocess (passing options as a JSON file,
which app.py's own CLI already knows how to read) and reports back
whatever app.py already prints, so the pipeline stays exactly as proven
in app.py/CLAUDE.md.
"""

import json
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path

import edge_tts
import requests
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

import app as engine  # aliased - this file's own FastAPI instance is also named `app` below

SCRIPT_DIR = Path(__file__).resolve().parent
JOBS_DIR = SCRIPT_DIR / "web_jobs"
JOBS_DIR.mkdir(exist_ok=True)
APP_PY = SCRIPT_DIR / "app.py"
PYTHON_BIN = sys.executable
# yt-dlp is installed into this same venv (pip install -U yt-dlp) - resolve
# its console script directly rather than relying on PATH.
YT_DLP_BIN = str(Path(PYTHON_BIN).parent / "yt-dlp")

# Maps a keyword substring of a line app.py prints to the coarse stage/
# percent we report to the frontend. Keyword-based (not tied to exact
# "[N/8]" step numbers) because the three modes in app.py have different
# step counts. app.py itself is untouched - we just read its stdout.
STAGE_MARKERS = [
    ("transcribing with AssemblyAI", "transcribing", 15),
    ("translating", "translating", 35),
    ("synthesizing Burmese voice", "synthesizing", 58),
    ("muxing", "rendering", 85),
]

PREVIEW_TEXT = "ဒါက ကျွန်တော့် အသံပါ။ Recap Studio က မင်္ဂလာပါ။"
VOICE_PREVIEW_DIR = SCRIPT_DIR / "web_voice_cache"
VOICE_PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Recap Studio")

jobs = {}
jobs_lock = threading.Lock()
active_job_id = None

# The browser keeps a "last 3 results" history with re-download links, so
# we keep the last 3 PROCESSED jobs' files on disk (not just the current
# one) - anything older is pruned as a new job starts.
MAX_KEPT_JOBS = 3
recent_job_ids = []


def new_job_id():
    return uuid.uuid4().hex[:12]


def track_and_prune(job_id):
    if job_id in recent_job_ids:
        recent_job_ids.remove(job_id)
    recent_job_ids.append(job_id)
    while len(recent_job_ids) > MAX_KEPT_JOBS:
        old_id = recent_job_ids.pop(0)
        shutil.rmtree(JOBS_DIR / old_id, ignore_errors=True)
        jobs.pop(old_id, None)


def find_job_output(job_id, suffix):
    """Fallback for the history panel: if the server restarted, `jobs` is
    empty in memory even though the files are still on disk (pruning only
    happens on a new job, not on shutdown) - look them up directly."""
    job_dir = JOBS_DIR / job_id
    if not job_dir.is_dir():
        return None
    matches = list(job_dir.glob(f"*-mm{suffix}"))
    return matches[0] if matches else None


@app.get("/", response_class=HTMLResponse)
async def index():
    return (SCRIPT_DIR / "index.html").read_text(encoding="utf-8")


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    job_id = new_job_id()
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    safe_name = Path(file.filename or "input.mp4").name
    dest = job_dir / safe_name
    with open(dest, "wb") as out:
        shutil.copyfileobj(file.file, out)

    with jobs_lock:
        jobs[job_id] = {
            "status": "uploaded",
            "percent": 0,
            "video_path": str(dest),
            "job_dir": str(job_dir),
            "output_mp4": None,
            "output_srt": None,
            "error": None,
            "options": None,
            "options_path": None,
            "process": None,
            "cancelled": False,
            "started_at": None,
            "intro_path": None,
            "outro_path": None,
        }
    return {"job_id": job_id, "filename": safe_name}


@app.post("/process/{job_id}")
async def process_job(job_id: str, body: dict | None = None):
    global active_job_id
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "unknown job_id")
        if active_job_id is not None and active_job_id != job_id:
            raise HTTPException(409, "another job is already running")
        if not job.get("video_path"):
            raise HTTPException(409, "source video isn't ready yet (still downloading?)")
        options = body or {}
        # intro/outro come from their own dedicated upload calls (server-side
        # state), not the client's JSON body - merge them in here.
        options["intro_path"] = job.get("intro_path")
        options["outro_path"] = job.get("outro_path")
        job["options"] = options
        job["status"] = "queued"
        job["percent"] = 0
        job["error"] = None
        job["cancelled"] = False
        job["started_at"] = time.time()
        active_job_id = job_id

        # app.py's own CLI reads this file (its second argv) - this is the
        # ONLY way options reach the pipeline, no other coupling to app.py.
        options_path = Path(job["job_dir"]) / "options.json"
        options_path.write_text(json.dumps(options))
        job["options_path"] = str(options_path)

    track_and_prune(job_id)
    threading.Thread(target=run_job, args=(job_id,), daemon=True).start()
    return {"job_id": job_id, "status": "queued"}


@app.post("/upload/{job_id}/{kind}")
async def upload_side_clip(job_id: str, kind: str, file: UploadFile = File(...)):
    if kind not in ("intro", "outro"):
        raise HTTPException(404, "unknown kind")
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "unknown job_id")
        job_dir = Path(job["job_dir"])

    safe_name = Path(file.filename or f"{kind}.mp4").name
    dest = job_dir / f"{kind}_{safe_name}"
    with open(dest, "wb") as out:
        shutil.copyfileobj(file.file, out)

    with jobs_lock:
        job[f"{kind}_path"] = str(dest)
    return {"status": "ok", "filename": safe_name}


@app.delete("/upload/{job_id}/{kind}")
async def clear_side_clip(job_id: str, kind: str):
    if kind not in ("intro", "outro"):
        raise HTTPException(404, "unknown kind")
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "unknown job_id")
        path = job.get(f"{kind}_path")
        job[f"{kind}_path"] = None
    if path:
        Path(path).unlink(missing_ok=True)
    return {"status": "cleared"}


YT_DLP_UPDATE_MSG = (
    "Could not download this video (the site may be blocking anonymous "
    "downloads, or yt-dlp is out of date for it). Try: pip install -U yt-dlp, "
    "then try the link again."
)
NO_AUDIO_MSG = "Downloaded video has no audio track - nothing to transcribe. Try a different link."

# TikTok/Douyin often reject requests that don't look like a real browser
# navigation - a plausible Referer and desktop Chrome UA make even the
# plain (no-cookies) attempt look like one, and are cheap insurance on
# every attempt regardless.
YT_DLP_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
YT_DLP_EXTRA_ARGS = [
    "--add-header", "Referer: https://www.tiktok.com/",
    "--user-agent", YT_DLP_USER_AGENT,
]


def is_tiktok_url(url):
    return "tiktok.com" in url or "douyin.com" in url


def try_tikwm_download(url, dest_path):
    """tikwm.com is a public TikTok/Douyin video-fetch API - it does its
    own challenge-solving server-side and just hands back a clean,
    watermark-free, audio-included download link, which sidesteps
    fighting TikTok's anti-bot measures through yt-dlp entirely. Returns
    True on success (dest_path written), False on any failure (network,
    an unexpected response shape, or the actual video fetch failing) - the
    caller falls back to the yt-dlp attempts either way."""
    try:
        api_resp = requests.get(
            "https://www.tikwm.com/api/",
            params={"url": url, "hd": 1},
            headers={"User-Agent": YT_DLP_USER_AGENT},
            timeout=30,
        )
        api_resp.raise_for_status()
        play_url = (api_resp.json().get("data") or {}).get("play")
        if not play_url:
            print(f"[download] tikwm.com returned no data.play for {url}")
            return False

        with requests.get(play_url, headers={"User-Agent": YT_DLP_USER_AGENT},
                           timeout=120, stream=True) as video_resp:
            video_resp.raise_for_status()
            with open(dest_path, "wb") as f:
                for chunk in video_resp.iter_content(chunk_size=1 << 16):
                    f.write(chunk)
        return True
    except Exception as e:
        print(f"[download] tikwm.com attempt failed for {url}: {e}")
        Path(dest_path).unlink(missing_ok=True)
        return False


def probe_audio_info(path):
    """Returns (codec, duration) for the file's first audio stream, or
    (None, None) if it has no audio stream at all - the check that catches
    a video-only download before it ever reaches the pipeline."""
    result = subprocess.run(
        [engine.FFPROBE_BIN, "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    line = result.stdout.strip()
    if not line:
        return None, None
    parts = line.split(",")
    codec = parts[0] or None
    duration = None
    if len(parts) > 1 and parts[1] not in ("", "N/A"):
        try:
            duration = float(parts[1])
        except ValueError:
            pass
    return codec, duration


def run_url_download(job_id, url):
    """Downloads in a background thread so /download-url can return right
    away and the frontend polls /download-status - a real download can take
    a while and must not block the request.

    For TikTok/Douyin, tries tikwm.com's API first (see try_tikwm_download)
    - it fights that site's anti-bot measures server-side and has been far
    more reliable than driving yt-dlp against TikTok directly. Any
    failure there (or a non-TikTok URL) falls through to yt-dlp: a plain
    download first, then Chrome's cookies (the browser the user is
    actually logged into TikTok in - Safari's cookie store needs Full Disk
    Access and reliably fails to even open under this app's sandboxing, so
    it's not worth a wasted attempt). If both yt-dlp attempts still fail,
    it runs `yt-dlp -U` (the extractor itself may just be behind for this
    site) and gives the Chrome-cookies attempt one last try before giving
    up with a short, actionable message.

    Downloads straight into the job's own job_dir (not a separate temp
    dir) - app.py writes its output NEXT TO its input video with no
    separate output-dir argument, so the source has to already be sitting
    where run_job expects the output to land too. It's still cleaned up
    like a temp file (see run_job) - just deleted as one specific file
    instead of a whole directory, since the job_dir also holds the real
    output that must survive that cleanup.

    Format selection is "bv*+ba/b" (best video + best audio, merged; fall
    back to best pre-combined) - NEVER a bare "mp4" alternative first,
    since that matches any mp4-extension stream including a video-only
    one and yt-dlp will happily pick it without ever trying to add audio.
    Even so, every successful download is verified with ffprobe before
    being accepted - if it somehow still has no audio, one more attempt
    forces a genuinely pre-combined format."""
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return
        job_dir = job["job_dir"]

    out_template = str(Path(job_dir) / "source.%(ext)s")
    expected_path = Path(job_dir) / "source.mp4"
    base_cmd = [
        YT_DLP_BIN, "-f", "bv*+ba/b", "--merge-output-format", "mp4",
        "--no-playlist", *YT_DLP_EXTRA_ARGS, "-o", out_template, url,
    ]
    chrome_cmd = base_cmd + ["--cookies-from-browser", "chrome"]
    attempts = [base_cmd, chrome_cmd]

    def clear_partials():
        """When a merge (separate video+audio streams, common on YouTube)
        gets interrupted partway - e.g. an earlier attempt in this same
        retry loop failing after downloading the video-only stream but
        before the audio+merge finished - yt-dlp leaves the per-format
        intermediate file (source.f<id>.<ext>) behind uncleaned; only a
        fully successful merge deletes them. A later attempt's glob could
        otherwise pick one of those (video-only or audio-only, no true
        merged file) instead of the real source.mp4."""
        for stale in Path(job_dir).glob("source.*"):
            stale.unlink(missing_ok=True)

    def try_attempt(cmd):
        """Runs one yt-dlp invocation. Returns (downloaded_path, output) -
        downloaded_path is None on any failure (exit code or timeout)."""
        clear_partials()
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired:
            return None, "download timed out"
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode != 0:
            return None, output
        if expected_path.exists():
            return expected_path, output
        # Prefer the exact merged filename yt-dlp was told to produce;
        # fall back to a sorted glob only if that's somehow missing.
        candidates = sorted(p for p in Path(job_dir).glob("source.*") if p.is_file())
        return (candidates[0] if candidates else None), output

    last_output = ""
    downloaded_path = None

    # For TikTok/Douyin specifically, try tikwm.com's API first - it does
    # the anti-bot fight server-side and just hands back a clean download
    # link, which has been far more reliable than yt-dlp's own extractor
    # for this site. Falls through to the yt-dlp attempts on any failure.
    if is_tiktok_url(url):
        clear_partials()
        if try_tikwm_download(url, expected_path):
            downloaded_path = expected_path
            print(f"[download] job {job_id}: got source via tikwm.com")

    if not downloaded_path:
        for cmd in attempts:
            downloaded_path, last_output = try_attempt(cmd)
            if downloaded_path:
                break

    if not downloaded_path:
        # Last resort before giving up: the extractor itself may just be
        # behind for this site (this is exactly what yt-dlp's own error
        # messages suggest - "Confirm you are on the latest version using
        # yt-dlp -U"), so update in place and give the Chrome-cookies
        # attempt one final try.
        print(f"[download] job {job_id}: plain + Chrome-cookies both failed, "
              f"running yt-dlp -U before giving up")
        try:
            subprocess.run([YT_DLP_BIN, "-U"], capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            pass
        downloaded_path, last_output = try_attempt(chrome_cmd)

    if not downloaded_path:
        clear_partials()
        print(f"[download] yt-dlp failed for job {job_id} / {url}:\n{last_output[-2000:]}")
        with jobs_lock:
            job["dl_status"] = "failed"
            job["dl_error"] = YT_DLP_UPDATE_MSG
        return

    codec, duration = probe_audio_info(downloaded_path)
    if not codec:
        # probe_audio_info selects only the audio stream, so duration is
        # always None here too (nothing matched) - use the whole file's
        # duration instead so this log line actually says something.
        video_dur = engine.ffprobe_duration(downloaded_path)
        print(f"[download] job {job_id}: {downloaded_path.name} has NO audio stream "
              f"(video duration {video_dur:.2f}s) - retrying once with a forced combined format")
        force_cmd = [
            YT_DLP_BIN, "-f", "best", "--merge-output-format", "mp4",
            "--no-playlist", *YT_DLP_EXTRA_ARGS, "--cookies-from-browser", "chrome",
            "-o", out_template, url,
        ]
        downloaded_path, last_output = try_attempt(force_cmd)
        codec, duration = probe_audio_info(downloaded_path) if downloaded_path else (None, None)
        if not codec:
            clear_partials()
            print(f"[download] job {job_id}: still no audio after forced re-download - giving up.\n"
                  f"{last_output[-2000:]}")
            with jobs_lock:
                job["dl_status"] = "failed"
                job["dl_error"] = NO_AUDIO_MSG
            return

    dur_str = f"{duration:.2f}s" if duration is not None else "?"
    print(f"[download] job {job_id}: audio ok - codec={codec}, duration={dur_str}")
    with jobs_lock:
        job["video_path"] = str(downloaded_path)
        job["downloaded_source_path"] = str(downloaded_path)
        job["dl_status"] = "done"


@app.post("/download-url")
async def download_url(body: dict):
    url = (body or {}).get("url", "").strip()
    if not url:
        raise HTTPException(400, "missing url")

    job_id = new_job_id()
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    with jobs_lock:
        jobs[job_id] = {
            "status": "uploaded",
            "percent": 0,
            "video_path": None,
            "job_dir": str(job_dir),
            "output_mp4": None,
            "output_srt": None,
            "error": None,
            "options": None,
            "options_path": None,
            "process": None,
            "cancelled": False,
            "started_at": None,
            "intro_path": None,
            "outro_path": None,
            "dl_status": "downloading",
            "dl_error": None,
            "downloaded_source_path": None,
        }

    threading.Thread(target=run_url_download, args=(job_id, url), daemon=True).start()
    return {"job_id": job_id, "status": "downloading"}


@app.get("/download-status/{job_id}")
async def download_status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "unknown job_id")
        filename = Path(job["video_path"]).name if job.get("video_path") else None
        return {"status": job.get("dl_status", "done"), "error": job.get("dl_error"), "filename": filename}


@app.get("/source-preview/{job_id}")
async def source_preview(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        path = Path(job["video_path"]) if job and job.get("video_path") else None
    if not path or not path.exists():
        raise HTTPException(404, "not available")
    return FileResponse(path, media_type="video/mp4", filename=path.name)


def run_job(job_id):
    global active_job_id
    with jobs_lock:
        job = jobs[job_id]
        video_path = job["video_path"]
        options_path = job["options_path"]

    try:
        proc = subprocess.Popen(
            [PYTHON_BIN, "-u", str(APP_PY), video_path, options_path],
            cwd=str(SCRIPT_DIR),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        with jobs_lock:
            job["process"] = proc

        # app.py prints its own clear reason on failure (see its main()) -
        # keep the tail of stdout so a failure can show that reason instead
        # of just an exit code, which told the web UI nothing about WHY.
        tail = deque(maxlen=40)
        for line in proc.stdout:
            tail.append(line)
            with jobs_lock:
                if job["cancelled"]:
                    continue
                for marker, stage, pct in STAGE_MARKERS:
                    if marker in line:
                        job["status"] = stage
                        job["percent"] = pct
                        break

        proc.wait()
        with jobs_lock:
            if job["cancelled"]:
                return
            if proc.returncode == 0:
                stem = Path(video_path).stem
                job_dir = Path(job["job_dir"])
                mp4 = job_dir / f"{stem}-mm.mp4"
                srt = job_dir / f"{stem}-mm.srt"
                job["output_mp4"] = str(mp4) if mp4.exists() else None
                job["output_srt"] = str(srt) if srt.exists() else None
                if job["output_mp4"]:
                    job["status"] = "done"
                    job["percent"] = 100
                else:
                    job["status"] = "failed"
                    job["error"] = "app.py finished but produced no output mp4"
            else:
                job["status"] = "failed"
                reason = "".join(tail).strip()
                job["error"] = (f"app.py exited with code {proc.returncode}:\n{reason}"
                                 if reason else f"app.py exited with code {proc.returncode}")
    except Exception as e:
        with jobs_lock:
            job["status"] = "failed"
            job["error"] = str(e)
    finally:
        with jobs_lock:
            if active_job_id == job_id:
                active_job_id = None
            downloaded_source = job.pop("downloaded_source_path", None)
        # The subprocess above has already finished reading video_path by
        # this point, so a yt-dlp-downloaded source (not an uploaded file -
        # those are the user's own and stay until the job dir is pruned) is
        # safe to remove now. Only that one file, not the job dir - the
        # real output (-mm.mp4/.srt) lives right next to it.
        if downloaded_source:
            Path(downloaded_source).unlink(missing_ok=True)


@app.get("/status/{job_id}")
async def status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "unknown job_id")
        return {"status": job["status"], "percent": job["percent"], "error": job["error"]}


ALLOWED_PREVIEW_VOICES = {"my-MM-ThihaNeural", "my-MM-NilarNeural"}
ALLOWED_PREVIEW_VOICES |= {v["id"] for v in engine.ENGLISH_VOICE_CANDIDATES}

ENGLISH_PREVIEW_TEXT = "This is my voice. Welcome to Recap Studio."

# edge-tts's own voice catalog doesn't change within a server's lifetime,
# so the live availability check (english_voices) only needs to actually
# call edge_tts.list_voices() once - cached here after the first request.
_english_voices_cache = None


@app.get("/fonts")
async def list_fonts():
    """Scans fonts/ fresh on every call (not cached at startup) so a font
    dropped in while the server's running just shows up on next page load."""
    return {
        "fonts": [{"file": "", "family": engine.SUBTITLE_FONT_NAME}] + engine.list_custom_fonts(),
    }


@app.get("/english-voices")
async def list_english_voices():
    """English Recap's voice picker: only ever offers a candidate voice
    (engine.ENGLISH_VOICE_CANDIDATES) that's actually present in edge-tts's
    OWN current voice list right now, verified live via
    edge_tts.list_voices() rather than trusting the candidate list blindly -
    edge-tts's catalog isn't something this codebase controls and can
    change out from under it."""
    global _english_voices_cache
    if _english_voices_cache is None:
        available = await edge_tts.list_voices()
        available_ids = {v["ShortName"] for v in available}
        _english_voices_cache = [
            v for v in engine.ENGLISH_VOICE_CANDIDATES if v["id"] in available_ids
        ]
    return {"voices": _english_voices_cache, "default": engine.ENGLISH_VOICE_DEFAULT}


@app.get("/voice-preview/{voice}")
async def voice_preview(voice: str):
    if voice not in ALLOWED_PREVIEW_VOICES:
        raise HTTPException(404, "unknown voice")
    cached = VOICE_PREVIEW_DIR / f"{voice}.mp3"
    if not cached.exists():
        tmp = VOICE_PREVIEW_DIR / f"{voice}.tmp.mp3"
        is_english = voice in {v["id"] for v in engine.ENGLISH_VOICE_CANDIDATES}
        text = ENGLISH_PREVIEW_TEXT if is_english else PREVIEW_TEXT
        communicate = edge_tts.Communicate(text, voice=voice, rate="+30%")
        await communicate.save(str(tmp))
        tmp.rename(cached)
    return FileResponse(cached, media_type="audio/mpeg")


@app.get("/result/{job_id}")
async def result(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "unknown job_id")
        if job["status"] != "done":
            raise HTTPException(409, "job not finished")
        return {
            "mp4_url": f"/download/{job_id}/mp4",
            "srt_url": f"/download/{job_id}/srt" if job.get("output_srt") else None,
        }


@app.get("/download/{job_id}/mp4")
async def download_mp4(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    path = Path(job["output_mp4"]) if job and job.get("output_mp4") else find_job_output(job_id, ".mp4")
    if not path or not path.exists():
        raise HTTPException(404, "not available")
    return FileResponse(path, media_type="video/mp4", filename=path.name)


@app.get("/download/{job_id}/srt")
async def download_srt(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    path = Path(job["output_srt"]) if job and job.get("output_srt") else find_job_output(job_id, ".srt")
    if not path or not path.exists():
        raise HTTPException(404, "not available")
    return FileResponse(path, media_type="text/plain", filename=path.name)


@app.post("/cancel/{job_id}")
async def cancel(job_id: str):
    global active_job_id
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "unknown job_id")
        job["cancelled"] = True
        job["status"] = "failed"
        job["error"] = "Cancelled by user"
        proc = job.get("process")
        if active_job_id == job_id:
            active_job_id = None

    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    return {"status": "cancelled"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
