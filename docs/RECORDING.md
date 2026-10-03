# Recording the demo video (operator guide)

One page. Shot list: docs/STORYBOARD.md. Run order and failure handling: docs/RUNBOOK.md.
Tools: scripts/record-demo.sh (capture), scripts/caption-video.sh (captions). Output folder: data/recordings/.

## What this machine has (checked 2026-10-03 12:40 CDT, nothing installed)

| Item | Finding |
|---|---|
| Session | Ubuntu, aarch64, GNOME Shell 46.0, **X11** (`XDG_SESSION_TYPE=x11`, `DISPLAY=:1`), not Wayland |
| Display | USB-C-0, **1920x1200** at 59.95 Hz, 302x188 mm. GNOME scaling factor 0 (auto, 100%), text scaling 1.0. One monitor connected |
| ffmpeg | **not installed** (`which ffmpeg` empty; not in /usr/bin, /usr/local/bin, /snap/bin, ~/.local/bin). `ffmpeg -version` and `ffmpeg -devices` print nothing, so x11grab, kmsgrab and pipewire inputs could not be checked |
| wf-recorder, kooha, obs | not installed. `gnome-screenshot` is present (stills only) |
| GStreamer | 1.24.2 with ximagesrc, pipewiresrc, videotestsrc, vp8enc/vp9enc, vp8dec/vp9dec, webmmux, matroskamux, mp4mux, subtitleoverlay, subparse, textoverlay. No H.264 encoder or decoder (no x264enc, avdec_h264 or openh264), and vp9 cannot be muxed into mp4 (no vp9parse) |
| PipeWire | running (pipewire, pipewire-pulse, wireplumber) |
| GNOME recorder | shortcut **Ctrl+Shift+Alt+R** is bound (`gsettings get org.gnome.shell.keybindings show-screen-recording-ui`). Works on X11 and Wayland, needs no install and no sudo, records the native 1920x1200 at 30 fps as VP8/WebM into `~/Videos/Screencasts/`. This is the practical option on this machine |
| Fonts | DejaVu Sans and DejaVu Sans Bold (`/usr/share/fonts/truetype/dejavu/`), Liberation Sans, Ubuntu. `fc-match "DejaVu Sans:bold"` resolves to DejaVuSans-Bold.ttf, which the caption script uses |

## Screen setup

- Leave GNOME at 100% scaling and record at the native 1920x1200. Fractional scaling on X11 blurs text and changes the capture size. Deliver the file as recorded; if an upload form insists on 1920x1080, letterbox, never crop.
- Browser zoom 125% (Ctrl and plus) so the studio panels, the design document and the playtest progress stay legible. Press F11 so no tabs or URL bar are captured.
- Switch on Do Not Disturb in the notification pane before the take. Close chat clients.
- The terminal running `npm start` is on another workspace, not on the recording screen. Do not switch workspace during the take.
- Do one 10 second test take, play it back and check that the studio text is readable at 50% size.

## What to show

- The studio at `/` with the model status online.
- The design document after Design it, and the level build with bot playtest progress after Build.
- Play, then the plain-word changes, including one refused change with its reason.
- The export opened from disk with the network off.
- The measured table from docs/RESULTS.md and the `npm run demo:check` output.

## Capture

Option A, recommended: GNOME recorder.
1. Studio page full screen. Press Ctrl+Shift+Alt+R. The overlay opens in record mode (video camera icon). Choose "Screen".
2. Press the red button. A red dot with a timer appears in the top bar. Run the sequence from docs/RUNBOOK.md.
3. Stop by clicking the red indicator in the top bar (or Ctrl+Shift+Alt+R again). GNOME writes `~/Videos/Screencasts/Screencast From YYYY-MM-DD HH-MM-SS.webm` (folder created on the first recording).
4. `scripts/record-demo.sh --import` copies the newest screencast to `data/recordings/demo-<timestamp>.webm` and writes a `.meta.txt` sidecar with source path, time and sha256. The original stays in `~/Videos/Screencasts/`.

Option B: `scripts/record-demo.sh [--duration SECONDS]`. It prints its plan (session, size, fps, tool, exact command), waits for Enter, counts down 3 seconds, and records until Ctrl+C. On this machine it picks GStreamer ximagesrc (X11, no ffmpeg) and writes `data/recordings/demo-<timestamp>.webm` at 1920x1200, 30 fps target. If ffmpeg is installed later it switches to x11grab and writes `.mp4` (H.264). On a Wayland session it prints the GNOME steps and offers ffmpeg only if a pipewire or kmsgrab input is really usable without sudo. `--dry-run` shows the plan only. Tested here with a 2 second take: 1920x1200, 30 fps, 1.97 s written.

## Keep the uncut capture

- The original capture is never edited, trimmed, renamed or re-encoded. Every take is kept, including bad ones. `record-demo.sh` refuses to overwrite and writes a sidecar with start time, command and sha256 for each take.
- Derived files get new names next to the original: `<name>-captioned.webm` or `.mp4`. Trimmed exports, if any, are also new files.
- Record every take in BUILD_STATUS.md: take number, start time, what happened, whether it is the one used.

## Label time compression

- Any part of the published video that runs faster than real time, or that skips time inside a shot, carries "TIME COMPRESSED" on screen for the whole span: `--compressed START END` on the caption script (repeat the flag for several spans). Say in that shot's caption what was compressed, for example "level build, 4 s shown as 1 s".
- Model waits up to about 10 seconds are shown at real speed. Longer waits may be compressed, labelled, and the measured time stays visible in the trail.
- A failed attempt is never cut out silently. Show it, show the retry, label any compression.

## Captions

1. `scripts/caption-video.sh --storyboard` writes `data/recordings/captions-storyboard.txt` from the shot table in docs/STORYBOARD.md (format `START END CAPTION`, one shot per line). Watch the uncut take and edit the seconds to match it. Delete the line of any shot that did not happen; do not re-time a shot into existence.
2. `scripts/caption-video.sh data/recordings/demo-<timestamp>.webm data/recordings/captions-storyboard.txt --compressed 40 52`
   writes `data/recordings/demo-<timestamp>-captioned.mp4` (ffmpeg drawtext, DejaVu Sans Bold, white on a dark box at the bottom, yellow label top right).
3. On this machine ffmpeg is absent: the script says so and exits 1. Add `--backend gst` to use the GStreamer fallback: same captions through subtitleoverlay, output `.webm` (VP8), input must be VP8/VP9 (a GNOME screencast or a record-demo `.webm`; an H.264 `.mp4` cannot be decoded here), audio dropped, the label appears as a bracketed second caption line. Verified on a 5 second synthetic clip.
4. Captions contain no em dashes (storyboard rule). `--dry-run` prints the command (and the subtitle track for gst) without writing.

## Honest footage rules

- No fake progress. The design document, build progress, bot playtest results and timings on screen are what the software did in that take. Nothing is mocked, replayed, re-ordered or sped up without a label.
- Shots that cannot be produced honestly are cut, not faked.
- Keep all attempts. Every take and every generation attempt, including failures and retries, stays on disk and is listed in BUILD_STATUS.md. A refused change is shown, not skipped.
- All time compression is labelled on screen.
- The cold model load is reported separately in the benchmark, never hidden. The warm-up idea run before recording is declared.
- If the model is offline, show the idea reader building the game without it and say so in the caption.
- Numbers shown or quoted come from docs/RESULTS.md and data/studio2d-runs, nothing else.
