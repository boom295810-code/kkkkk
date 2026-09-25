# ======================================================================
# REFERENCE EXTRACT — timing/sync core of the OLD Python dubbing tool
# Source: app.py (3476 lines). Only the timing-relevant parts are here.
# This is READ-ONLY reference. Do not run it; do not port it verbatim.
# ======================================================================

# ---- design comment: how dubbing sync actually works ----
# Dubbing: voice speed is synthesized once at the fixed rate (TTS_RATE, always
# +30%) and NEVER adjusted afterward - no post-hoc tempo change, ever (see
# build_dub_voice_track). The voice track is the fixed timeline; sync is
# achieved entirely by giving each block's own VIDEO segment an independent
# playback speed so that segment's retimed length matches that block's own
# voice length exactly (see build_dub_video_segments) - the video adapts to
# the voice, never the other way around.

# Dubbing: adjacent blocks from the SAME uninterrupted speaker are merged
# into ONE edge-tts synthesis call (see group_speaker_runs/
# synthesize_dub_groups), so there's no separately-synthesized clip to join
# within a speaker's run at all - zero internal seams, not just a smoothed
# one. Only between groups (always a genuine speaker change) is there a
# real gap: EDGE_FADE_MS is how long each group's OWN tail/head is faded
# to/from silence there (applied to the clip's final trimmed waveform, so
# the fade is never undone by anything downstream) - short enough to stay
# tight, long enough that speech eases out and back in instead of clicking.
EDGE_FADE_MS = 60

# Dubbing: a brief natural pause inserted between every pair of adjacent
# synthesis groups - by construction every group boundary is a genuine
# speaker change (a real scene/turn boundary, e.g. either side of a
# back-and-forth exchange). Sized like normal conversational spacing, not
# a hold.
SPEAKER_GAP_SEC = 0.30


# ---- scene spans TILE the source: no gaps exist at all ----
def compute_scene_spans(blocks, video_duration):
    n = len(blocks)
    for i, b in enumerate(blocks):
        b["scene_start"] = b["start"]
        b["scene_end"] = blocks[i + 1]["start"] if i + 1 < n else video_duration
        b["scene_end"] = max(b["scene_end"], b["scene_start"] + 0.05)
        b["scene_duration"] = b["scene_end"] - b["scene_start"]


# ---- continuous voice track = the fixed master timeline ----
def build_dub_voice_track(groups, out_wav):
    """Dubbing's voice track is the fixed timeline everything else adapts
    to, built from GROUPS (see synthesize_dub_groups) rather than individual
    blocks - within one group there is no separately-synthesized clip to
    join at all (it's already one continuous edge-tts render), so there's
    nothing to fade or gap internally. Every group's own tail/head IS faded
    to/from silence over EDGE_FADE_MS before it's placed on the track - a
    real crossfade (overlapping two different clips' actual waveforms) is
    what made short joins sound like a hard cut/warble before; fading each
    group's own final (already-trimmed) waveform instead means the
    boundary is always speech easing to true silence, then true silence
    easing back to speech.

    A real SPEAKER_GAP_SEC (~0.2-0.4s) silence separates every pair of
    groups - by construction every group boundary IS a genuine speaker
    change (see group_speaker_runs) - a brief natural breath so
    back-and-forth exchanges don't sound jammed together.

    Returns (total_duration, placements, gap_count) where placements[i] is
    the i-th ORIGINAL block's own (start, start+raw_dur) absolute position
    on the continuous track (group's own absolute start + that block's
    b["_group_offset"]) - same shape as before, so every downstream
    consumer (captions, per-block video-segment duration) is unaffected by
    the switch to group-level synthesis."""
    track = AudioSegment.empty()
    placements = []
    gap_count = 0
    for gi, group in enumerate(groups):
        clip = AudioSegment.from_file(group["tts_path"])
        fade = min(EDGE_FADE_MS, len(clip) // 2)
        if fade > 0:
            clip = clip.fade_in(fade).fade_out(fade)
        if gi > 0:
            track = track + AudioSegment.silent(duration=int(round(SPEAKER_GAP_SEC * 1000)))
            gap_count += 1
        group_start_s = len(track) / 1000.0
        track = track + clip
        for b in group["blocks"]:
            abs_start = group_start_s + b["_group_offset"]
            placements.append((abs_start, abs_start + b["raw_dur"]))
    total = len(track) / 1000.0
    track.export(out_wav, format="wav")
    return total, placements, gap_count

# ---- per-block video speed, UNCLAMPED ----
def build_dub_video_segments(blocks, video_seg_durations, video_duration):
    """Video adapts to voice, never the other way around: each block keeps
    its own original scene span (never reordered, never dropped) but gets
    an INDEPENDENT playback speed so that span's retimed length matches
    that block's own share of the continuous voice track exactly -
    video_seg_durations[i] (see process_dubbing - telescoped from real
    crossfade-adjusted voice placements so the segments sum to the whole
    voice track with no drift). Block 0's scene_start is expected to
    already have been pulled back to 0.0 by the caller, since the voice
    has no silent gap left for any lead-in footage to sit in - it has to
    ride along inside block 0's own segment instead."""
    segments = []
    for b, voice_dur in zip(blocks, video_seg_durations):
        seg_start = b["scene_start"]
        seg_end = min(b["scene_end"], video_duration)
        seg_end = max(seg_end, seg_start + 0.02)
        span = seg_end - seg_start
        voice_dur = max(voice_dur, 0.02)
        segments.append({
            "start": seg_start, "end": seg_end, "span": span,
            "voice_dur": voice_dur, "speed": span / voice_dur,
        })
    return segments


def build_segmented_video_filter(input_label, segments):
    """One trim+setpts per block, each retimed independently to its own
    speed, then concatenated back to back in original order. Only retimes
    existing footage: never reorders, drops, or duplicates a segment.

    An explicit `split` fans the source out to N copies FIRST - reusing
    input_label directly as the input to N separate trim filters looks like
    it should work the same way a bare stream specifier like [0:v] does
    (ffmpeg auto-splits those), but when input_label is itself a FILTER's
    output pad (e.g. [vsrc] after an aspect-crop/flip pre-filter), ffmpeg
    does NOT reliably auto-split it - confirmed by a real failure where the
    second+ reuse silently fell back to the pre-crop source instead of
    [vsrc]'s actual output, so concat saw mismatched frame sizes and
    aborted. Splitting explicitly avoids relying on that reuse at all."""
    n = len(segments)
    split_labels = [f"[vsplit{i}]" for i in range(n)]
    stages = [f"{input_label}split={n}{''.join(split_labels)}"]
    seg_labels = []
    for i, seg in enumerate(segments):
        lbl = f"[vseg{i}]"
        stages.append(
            f"{split_labels[i]}trim=start={seg['start']:.6f}:end={seg['end']:.6f},"
            f"setpts=(PTS-STARTPTS)/{seg['speed']:.6f}{lbl}"
        )
        seg_labels.append(lbl)
    out_label = "[vcat]"
    stages.append(f"{''.join(seg_labels)}concat=n={n}:v=1:a=0{out_label}")
    return stages, out_label


# ---- telescoping of segment durations (from process_dubbing) ----
    print("[7/8] joining voice into one continuous track (natural pause at speaker turns), fitting video per segment")
    audio_wav = workdir / "final_audio.wav"
    total_voice_duration, placements, gap_count = build_dub_voice_track(groups, audio_wav)

    # Each block's VIDEO segment gets the exact slice of the continuous
    # voice timeline between its own real start and the next block's real
    # start (the last block gets whatever remains to the very end) - these
    # telescope to total_voice_duration exactly, so N independently-retimed
    # segments can never drift from the voice track no matter how many
    # blocks there are. Any speaker-turn gap lands inside the PRECEDING
    # block's own slice (it's silence added right before the next block's
    # clip), so that segment's video simply gets a touch more time to fill -
    # the gap is accounted for automatically, no separate bookkeeping needed.
    n = len(blocks)
    video_seg_durations = [
        (placements[i + 1][0] - placements[i][0]) if i + 1 < n
        else (total_voice_duration - placements[i][0])
        for i in range(n)
    ]
    segments = build_dub_video_segments(blocks, video_seg_durations, video_duration)
    total_video_duration = sum(s["voice_dur"] for s in segments)

    print(f"      voice duration: {total_voice_duration:.2f}s (continuous; {gap_count} speaker-turn "
          f"pause(s) of {SPEAKER_GAP_SEC:.2f}s = {gap_count * SPEAKER_GAP_SEC:.2f}s total included)")
    print(f"      video duration: {total_video_duration:.2f}s (source: {video_duration:.2f}s)")


# ---- mux: tpad + -shortest so streams end frame-exact together ----
    span and retimed at its own independent speed BEFORE concatenation (see
    build_segmented_video_filter), so sync never depends on one global speed
    working for the whole video. Segment durations are built (see
    build_dub_video_segments/process_dubbing) to sum exactly to the
    continuous voice duration, but ffmpeg's frame-boundary snapping on each
    trim can still leave the rendered concat a hair short - pad a small
    safety margin and let `-shortest` cut the final output at the audio's
    end, so the voice is never cut off and the two streams end frame-exact
    together."""
    pre_stages, cur = build_pre_filters(flip_video, auto_color, aspect_filter)
    seg_stages, cur = build_segmented_video_filter(cur, segments)
    post_stages, cur = build_post_filters(cur, blur_boxes, ass_path, width, height)
    stages = pre_stages + seg_stages + post_stages

    safety_pad = 0.12
    stages.append(f"{cur}tpad=stop_mode=clone:stop_duration={safety_pad:.3f}[vpad]")
    cur = "[vpad]"

    cmd = [FFMPEG_BIN, "-y", "-i", str(input_video), "-i", str(audio_wav)]
    cmd += ["-filter_complex", ";".join(stages), "-map", cur, "-map", "1:a:0"]
    cmd += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
        str(out_path),
    ]
    run(cmd, capture_output=True)


# ============================================================