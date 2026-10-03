#!/usr/bin/env bash
# scripts/record-demo.sh - best-effort screen capture for the Beetle demo video.
#
# Uses whatever capture tool actually exists on this machine, prints exactly what
# it is about to do, then does it. Never uses sudo. Never overwrites a recording.
#
#   X11 + ffmpeg (x11grab)       -> data/recordings/demo-<timestamp>.mp4  (H.264, native size, 30 fps)
#   X11 + GStreamer (ximagesrc)  -> data/recordings/demo-<timestamp>.webm (VP8, native size, 30 fps)
#   Wayland                      -> prints the GNOME built-in recorder steps (Ctrl+Shift+Alt+R);
#                                   offers ffmpeg only if a pipewire or kmsgrab input is really usable
#
# Usage:
#   scripts/record-demo.sh [--duration SECONDS] [--fps N] [--display :N]
#                          [--tool auto|ffmpeg|gst|gnome] [--yes] [--dry-run]
#   scripts/record-demo.sh --import        copy the newest GNOME screencast into data/recordings/
#   scripts/record-demo.sh --help
#
# Stop a running capture with Ctrl+C (or q in the ffmpeg terminal). The file is
# finalised on stop. A sidecar demo-<timestamp>.meta.txt records when and how the
# capture was made so the uncut file can be traced later.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/data/recordings"
FPS=30
DURATION=""
TOOL=auto
DRY_RUN=0
ASSUME_YES=0
IMPORT=0
DISPLAY_ARG="${DISPLAY:-}"
COUNTDOWN=3

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed -e 's/^# \{0,1\}//'
}

say() { printf '%s\n' "$*"; }
die() { printf 'record-demo: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION="${2:-}"; shift 2 ;;
    --fps) FPS="${2:-}"; shift 2 ;;
    --display) DISPLAY_ARG="${2:-}"; shift 2 ;;
    --tool) TOOL="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --import) IMPORT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ "$FPS" =~ ^[0-9]+$ ]] || die "--fps must be an integer"
[[ -z "$DURATION" || "$DURATION" =~ ^[0-9]+$ ]] || die "--duration must be whole seconds"
case "$TOOL" in auto|ffmpeg|gst|gnome) ;; *) die "--tool must be auto, ffmpeg, gst or gnome" ;; esac

if [[ "$(id -u)" == 0 || -n "${SUDO_USER:-}" ]]; then
  die "run this as your normal desktop user, without sudo (the capture needs your own session)"
fi

# ---------------------------------------------------------------------------
# Facts about the session
# ---------------------------------------------------------------------------
SESSION="${XDG_SESSION_TYPE:-}"
if [[ -z "$SESSION" ]] && have loginctl; then
  sid="$(loginctl list-sessions --no-legend 2>/dev/null | awk 'NR==1{print $1}')"
  [[ -n "$sid" ]] && SESSION="$(loginctl show-session "$sid" -p Type --value 2>/dev/null || true)"
fi
[[ -n "$SESSION" ]] || SESSION=unknown

detect_size() {
  local dims=""
  if [[ "$SESSION" == x11 && -n "$DISPLAY_ARG" ]]; then
    if have xdpyinfo; then
      dims="$(DISPLAY="$DISPLAY_ARG" xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2; exit}')"
    fi
    if [[ -z "$dims" ]] && have xrandr; then
      dims="$(DISPLAY="$DISPLAY_ARG" xrandr --current 2>/dev/null \
        | awk '/ connected/{for(i=1;i<=NF;i++) if($i ~ /^[0-9]+x[0-9]+\+/){split($i,a,"+"); print a[1]; exit}}')"
    fi
  fi
  [[ -n "$dims" ]] || dims="1920x1200"
  printf '%s' "$dims"
}

SIZE="$(detect_size)"
WIDTH="${SIZE%x*}"
HEIGHT="${SIZE#*x}"
# x11grab and most encoders want even dimensions
WIDTH=$(( WIDTH - WIDTH % 2 ))
HEIGHT=$(( HEIGHT - HEIGHT % 2 ))

FFMPEG_DEVICES=""
FFMPEG_ENCODERS=""
if have ffmpeg; then
  FFMPEG_DEVICES="$(ffmpeg -hide_banner -devices 2>/dev/null || true)"
  FFMPEG_ENCODERS="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
fi
ffmpeg_has_dev() { grep -qiw -- "$1" <<<"$FFMPEG_DEVICES"; }
ffmpeg_has_enc() { grep -qw -- "$1" <<<"$FFMPEG_ENCODERS"; }

gst_has() {
  have gst-inspect-1.0 && gst-inspect-1.0 --exists "$1" 2>/dev/null
}
GST_OK=0
if have gst-launch-1.0 && gst_has ximagesrc && gst_has vp8enc && gst_has webmmux; then GST_OK=1; fi

GNOME_DIR="$HOME/Videos/Screencasts"

gnome_instructions() {
  cat <<EOF
GNOME built-in screen recorder (works on Wayland and X11, nothing to install, no sudo):
  1. Put the director page on the recording screen, press F11 for full screen.
  2. Press Ctrl+Shift+Alt+R. The screenshot/screencast overlay opens in record mode
     (the video camera icon is selected). Choose "Screen" to capture the whole display.
  3. Press the round red button. A red dot with a running timer appears in the top bar.
  4. Run the demo. To stop, click that red indicator in the top bar
     (or press Ctrl+Shift+Alt+R again).
  5. The file lands in $GNOME_DIR/ as
     "Screencast From YYYY-MM-DD HH-MM-SS.webm" (VP8 in WebM, native size, 30 fps).
     The folder is created by GNOME on the first recording.
  6. Copy it into the repo, do not move or rename the original:
       scripts/record-demo.sh --import
     (copies the newest screencast to data/recordings/demo-<timestamp>.webm and writes a .meta.txt)
EOF
}

# ---------------------------------------------------------------------------
# --import: copy the newest GNOME screencast into data/recordings
# ---------------------------------------------------------------------------
if [[ "$IMPORT" == 1 ]]; then
  newest=""
  for d in "$GNOME_DIR" "$HOME/Videos"; do
    [[ -d "$d" ]] || continue
    f="$(ls -t "$d"/*.webm "$d"/*.mp4 2>/dev/null | head -n 1 || true)"
    if [[ -n "$f" ]]; then newest="$f"; break; fi
  done
  [[ -n "$newest" ]] || die "no .webm or .mp4 found in $GNOME_DIR or $HOME/Videos (record one first)"
  mkdir -p "$OUT_DIR"
  stamp="$(date -r "$newest" +%Y%m%d-%H%M%S)"
  dest="$OUT_DIR/demo-$stamp.${newest##*.}"
  [[ -e "$dest" ]] && die "$dest already exists; not overwriting"
  say "Will copy (not move):"
  say "  from: $newest"
  say "  to:   $dest"
  [[ "$DRY_RUN" == 1 ]] && exit 0
  cp -p -- "$newest" "$dest"
  {
    echo "imported_at: $(date --iso-8601=seconds)"
    echo "source: $newest"
    echo "source_mtime: $(date -r "$newest" --iso-8601=seconds)"
    echo "tool: gnome-shell screencast (Ctrl+Shift+Alt+R)"
    echo "uncut: yes (copy of the original, untouched)"
    echo "sha256: $(sha256sum -- "$dest" | awk '{print $1}')"
  } > "$dest.meta.txt"
  say "Copied. Sidecar: $dest.meta.txt"
  exit 0
fi

# ---------------------------------------------------------------------------
# Choose the tool
# ---------------------------------------------------------------------------
CHOSEN=""
REASON=""
if [[ "$TOOL" == gnome ]]; then
  CHOSEN=gnome; REASON="requested with --tool gnome"
elif [[ "$SESSION" == x11 ]]; then
  if [[ "$TOOL" == auto || "$TOOL" == ffmpeg ]] && have ffmpeg && ffmpeg_has_dev x11grab; then
    CHOSEN=ffmpeg; REASON="X11 session and ffmpeg has the x11grab device"
  elif [[ "$TOOL" == ffmpeg ]]; then
    die "--tool ffmpeg requested but ffmpeg with x11grab is not available ($(have ffmpeg && echo 'ffmpeg present, x11grab missing' || echo 'ffmpeg not installed'))"
  elif [[ "$TOOL" == auto || "$TOOL" == gst ]] && [[ "$GST_OK" == 1 ]]; then
    CHOSEN=gst; REASON="X11 session, ffmpeg not available, GStreamer ximagesrc + vp8enc + webmmux present"
  elif [[ "$TOOL" == gst ]]; then
    die "--tool gst requested but gst-launch-1.0 with ximagesrc/vp8enc/webmmux is not available"
  else
    CHOSEN=gnome; REASON="X11 session but neither ffmpeg (x11grab) nor GStreamer (ximagesrc) is available"
  fi
else
  # Wayland (or unknown): x11grab cannot see the screen. ffmpeg only if a real device exists.
  if have ffmpeg && [[ "$TOOL" == auto || "$TOOL" == ffmpeg ]] && ffmpeg_has_dev pipewire; then
    CHOSEN=ffmpeg-pipewire; REASON="$SESSION session and ffmpeg lists a pipewire input device"
  elif have ffmpeg && [[ "$TOOL" == auto || "$TOOL" == ffmpeg ]] && ffmpeg_has_dev kmsgrab; then
    CHOSEN=ffmpeg-kmsgrab; REASON="$SESSION session and ffmpeg lists the kmsgrab device"
  elif [[ "$TOOL" == ffmpeg || "$TOOL" == gst ]]; then
    die "--tool $TOOL cannot capture a $SESSION session here (no pipewire or kmsgrab input); use the GNOME recorder"
  else
    CHOSEN=gnome; REASON="$SESSION session: no usable ffmpeg input device (x11grab needs X11; pipewire/kmsgrab not listed)"
  fi
fi

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

say "record-demo plan"
say "  session:     $SESSION   display: ${DISPLAY_ARG:-none}"
say "  screen size: ${WIDTH}x${HEIGHT} (native, no scaling applied by this script)"
say "  fps:         $FPS"
say "  duration:    ${DURATION:-until Ctrl+C}"
say "  ffmpeg:      $(have ffmpeg && ffmpeg -version 2>/dev/null | head -n 1 || echo 'not installed')"
say "  gstreamer:   $(have gst-launch-1.0 && gst-launch-1.0 --version 2>/dev/null | head -n 1 || echo 'not installed') (ximagesrc path usable: $([[ $GST_OK == 1 ]] && echo yes || echo no))"
say "  chosen:      $CHOSEN ($REASON)"
say ""

run_capture() {
  # $1 = output file, rest = command
  local out="$1"; shift
  local meta="$out.meta.txt"
  say "Command:"
  printf '  %q' "$@"; printf '\n\n'
  if [[ "$DRY_RUN" == 1 ]]; then say "(dry run, nothing captured)"; return 0; fi
  if [[ "$ASSUME_YES" != 1 && -t 0 ]]; then
    read -r -p "Press Enter to start the capture (Ctrl+C to abort)... " _
  fi
  for ((i=COUNTDOWN; i>0; i--)); do printf 'starting in %d...\r' "$i"; sleep 1; done
  printf '\n'
  {
    echo "started_at: $(date --iso-8601=seconds)"
    echo "host: $(hostname) $(uname -m)"
    echo "session: $SESSION display: ${DISPLAY_ARG:-none}"
    echo "size: ${WIDTH}x${HEIGHT} fps: $FPS duration: ${DURATION:-manual stop}"
    echo "tool: $CHOSEN"
    printf 'command:'; printf ' %q' "$@"; printf '\n'
    echo "uncut: yes (this file is the original capture; derived files live next to it)"
  } > "$meta"
  say "Recording to $out  (stop with Ctrl+C)"
  set +e
  "$@"
  local rc=$?
  set -e
  # ffmpeg returns 255 on SIGINT, gst-launch 0; both leave a valid file when stopped cleanly
  {
    echo "ended_at: $(date --iso-8601=seconds)"
    echo "exit_code: $rc"
    if [[ -s "$out" ]]; then echo "sha256: $(sha256sum -- "$out" | awk '{print $1}')"; fi
  } >> "$meta"
  if [[ -s "$out" ]]; then
    say ""
    say "Saved: $out ($(du -h -- "$out" | cut -f1))"
    if have ffprobe; then
      ffprobe -v error -show_entries format=duration -of default=nw=1 "$out" 2>/dev/null | sed 's/^/  /' || true
    elif have gst-discoverer-1.0; then
      gst-discoverer-1.0 "$out" 2>/dev/null | grep -E 'Duration|Width|Height|Frame rate' | sed 's/^ */  /' || true
    fi
    say "Sidecar: $meta"
    say "Keep this file untouched. Burn captions with scripts/caption-video.sh into a separate file."
  else
    say "No file was written (exit code $rc). Check the messages above." >&2
    return 1
  fi
}

case "$CHOSEN" in
  gnome)
    gnome_instructions
    exit 0
    ;;

  ffmpeg)
    OUT="$OUT_DIR/demo-$STAMP.mp4"
    if ffmpeg_has_enc libx264; then ENC=(-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p)
    elif ffmpeg_has_enc h264_nvenc; then ENC=(-c:v h264_nvenc -preset p4 -cq 19 -pix_fmt yuv420p)
    elif ffmpeg_has_enc libopenh264; then ENC=(-c:v libopenh264 -b:v 8M -pix_fmt yuv420p)
    else ENC=(-c:v mpeg4 -q:v 2); say "note: no H.264 encoder in this ffmpeg, falling back to mpeg4 in .mp4"; fi
    CMD=(ffmpeg -hide_banner -nostdin -f x11grab -framerate "$FPS" -video_size "${WIDTH}x${HEIGHT}"
         -i "${DISPLAY_ARG:-:0}+0,0")
    [[ -n "$DURATION" ]] && CMD+=(-t "$DURATION")
    CMD+=("${ENC[@]}" -movflags +faststart "$OUT")
    run_capture "$OUT" "${CMD[@]}"
    ;;

  gst)
    OUT="$OUT_DIR/demo-$STAMP.webm"
    say "note: this path writes VP8 in WebM (no H.264 encoder here). Real frame rate can drop below $FPS"
    say "      on a ${WIDTH}x${HEIGHT} screen; the GNOME recorder (--tool gnome) is the smoother option."
    CMD=(gst-launch-1.0 -e -q ximagesrc "display-name=${DISPLAY_ARG:-:0}" use-damage=false show-pointer=true)
    [[ -n "$DURATION" ]] && CMD+=("num-buffers=$(( DURATION * FPS ))")
    CMD+=(! "video/x-raw,framerate=${FPS}/1" ! videoconvert ! queue
          ! vp8enc deadline=1 cpu-used=8 "threads=$(nproc 2>/dev/null || echo 4)" target-bitrate=12000000 keyframe-max-dist=60
          ! webmmux ! filesink "location=$OUT")
    run_capture "$OUT" "${CMD[@]}"
    ;;

  ffmpeg-pipewire)
    OUT="$OUT_DIR/demo-$STAMP.mp4"
    say "ffmpeg lists a pipewire input. It goes through the desktop portal: GNOME will show a"
    say "'share your screen' dialog, pick the whole screen there. If the dialog never appears, use:"
    gnome_instructions
    say ""
    DEV="$(grep -io 'pipewire[a-z]*' <<<"$FFMPEG_DEVICES" | head -n 1)"
    CMD=(ffmpeg -hide_banner -nostdin -f "$DEV" -framerate "$FPS" -i "")
    [[ -n "$DURATION" ]] && CMD+=(-t "$DURATION")
    CMD+=(-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart "$OUT")
    run_capture "$OUT" "${CMD[@]}"
    ;;

  ffmpeg-kmsgrab)
    OUT="$OUT_DIR/demo-$STAMP.mp4"
    say "ffmpeg lists kmsgrab, but kmsgrab needs CAP_SYS_ADMIN on the ffmpeg binary (or root)."
    if have getcap && getcap "$(command -v ffmpeg)" 2>/dev/null | grep -q cap_sys_admin; then
      say "ffmpeg already carries cap_sys_admin, so kmsgrab is usable without sudo."
      CMD=(ffmpeg -hide_banner -nostdin -f kmsgrab -framerate "$FPS" -i - -vf hwdownload,format=bgr0)
      [[ -n "$DURATION" ]] && CMD+=(-t "$DURATION")
      CMD+=(-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -movflags +faststart "$OUT")
      run_capture "$OUT" "${CMD[@]}"
    else
      say "It does not, and this script never uses sudo. Use the GNOME recorder instead:"
      say ""
      gnome_instructions
      exit 0
    fi
    ;;
esac
