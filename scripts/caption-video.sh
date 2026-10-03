#!/usr/bin/env bash
# scripts/caption-video.sh - burn storyboard captions into a demo recording.
#
# Usage:
#   scripts/caption-video.sh INPUT CAPTIONS [options]
#   scripts/caption-video.sh --storyboard            write data/recordings/captions-storyboard.txt
#                                                    from the shot table in docs/STORYBOARD.md
#
#   INPUT     the recording (.mp4 or .webm). It is never modified.
#   CAPTIONS  text file, one caption per line:  START_SECONDS END_SECONDS CAPTION TEXT
#             blank lines and lines starting with # are ignored. Decimal seconds are fine.
#
# Options:
#   --compressed START END   show a "time compressed" label between START and END seconds (repeatable)
#   --label TEXT             text of that label (default: TIME COMPRESSED)
#   --name NAME              output base name, written to data/recordings/NAME-captioned.mp4
#                            (default: the input file's base name)
#   --font FILE              TTF/OTF font file (default: fc-match "DejaVu Sans:bold")
#   --size PX                caption font size (default: 44 at 1200 px high, scaled to the input)
#   --backend ffmpeg|gst     ffmpeg (default) burns with drawtext and writes .mp4 (H.264).
#                            gst is the fallback when ffmpeg is absent: GStreamer subtitleoverlay,
#                            writes .webm (VP8), input must be VP8/VP9 (what the GNOME recorder makes).
#   --dry-run                print the command and exit
#   --help
#
# Output: data/recordings/<name>-captioned.mp4 (or .webm with --backend gst). Existing
# outputs are not overwritten; a -2, -3 suffix is added.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/data/recordings"
STORYBOARD="$ROOT/docs/STORYBOARD.md"
STORYBOARD_OUT="$OUT_DIR/captions-storyboard.txt"

INPUT=""
CAPTIONS=""
NAME=""
FONT=""
SIZE=""
LABEL="TIME COMPRESSED"
BACKEND=ffmpeg
DRY_RUN=0
DO_STORYBOARD=0
COMPRESSED=()   # "start end" pairs

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed -e 's/^# \{0,1\}//'; }
say() { printf '%s\n' "$*"; }
die() { printf 'caption-video: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
is_num() { [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compressed)
      is_num "${2:-}" && is_num "${3:-}" || die "--compressed needs START END in seconds"
      COMPRESSED+=("$2 $3"); shift 3 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --font) FONT="${2:-}"; shift 2 ;;
    --size) SIZE="${2:-}"; shift 2 ;;
    --backend) BACKEND="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --storyboard) DO_STORYBOARD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *)
      if [[ -z "$INPUT" ]]; then INPUT="$1"
      elif [[ -z "$CAPTIONS" ]]; then CAPTIONS="$1"
      else die "unexpected argument: $1"; fi
      shift ;;
  esac
done

# ---------------------------------------------------------------------------
# --storyboard: shot table -> editable captions file
# ---------------------------------------------------------------------------
if [[ "$DO_STORYBOARD" == 1 ]]; then
  [[ -f "$STORYBOARD" ]] || die "missing $STORYBOARD"
  mkdir -p "$OUT_DIR"
  {
    echo "# Captions for scripts/caption-video.sh, generated from docs/STORYBOARD.md on $(date --iso-8601=seconds)."
    echo "# Format: START_SECONDS END_SECONDS CAPTION   (one shot per line)"
    echo "# Edit the seconds to match the real recording after you have watched it. Do not invent shots:"
    echo "# a shot that did not happen on screen is deleted here, not re-timed."
    echo "# Re-generate from the storyboard: scripts/caption-video.sh --storyboard"
    echo "#"
    awk -F'|' '
      /^\| *[0-9]+ *\|/ {
        s=$3; c=$5
        gsub(/^[ \t]+|[ \t]+$/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", c)
        n=split(s, a, / +to +/)
        if (n == 2 && c != "") printf "%s %s %s\n", a[1], a[2], c
      }' "$STORYBOARD"
  } > "$STORYBOARD_OUT"
  n="$(grep -vc '^#' "$STORYBOARD_OUT" || true)"
  say "wrote $STORYBOARD_OUT ($n shots)"
  [[ -n "$INPUT" ]] || exit 0
fi

# ---------------------------------------------------------------------------
# Validate inputs
# ---------------------------------------------------------------------------
[[ -n "$INPUT" && -n "$CAPTIONS" ]] || { usage >&2; exit 2; }
[[ -f "$INPUT" ]] || die "input not found: $INPUT"
[[ -f "$CAPTIONS" ]] || die "captions file not found: $CAPTIONS"
case "$BACKEND" in ffmpeg|gst) ;; *) die "--backend must be ffmpeg or gst" ;; esac
[[ -z "$SIZE" || "$SIZE" =~ ^[0-9]+$ ]] || die "--size must be a whole number of pixels"

if [[ "$BACKEND" == ffmpeg ]] && ! have ffmpeg; then
  cat >&2 <<EOF
caption-video: ffmpeg is not installed on this machine, so captions cannot be burned with drawtext.
  Checked: command -v ffmpeg (nothing), /usr/bin, /usr/local/bin, /snap/bin, ~/.local/bin.
  Options:
    - install ffmpeg on a machine where you may (apt install ffmpeg needs sudo; not done by this script), or
    - re-run with --backend gst to use the GStreamer fallback that is present here
      (burns the same captions with subtitleoverlay, output is .webm, input must be VP8/VP9 such as a GNOME screencast).
EOF
  exit 1
fi
if [[ "$BACKEND" == gst ]]; then
  have gst-launch-1.0 || die "gst-launch-1.0 not found"
  for el in decodebin subtitleoverlay subparse vp8enc webmmux videoconvert; do
    gst-inspect-1.0 --exists "$el" 2>/dev/null || die "GStreamer element '$el' missing; cannot use --backend gst"
  done
  have python3 || die "python3 is needed to build the subtitle track for --backend gst"
fi

# Font: a real file path, found through fontconfig unless given.
if [[ -z "$FONT" ]]; then
  if have fc-match; then
    FONT="$(fc-match -f '%{file}' 'DejaVu Sans:bold' 2>/dev/null || true)"
    [[ -f "$FONT" ]] || FONT="$(fc-match -f '%{file}' 'sans-serif:bold' 2>/dev/null || true)"
  fi
  if [[ ! -f "$FONT" ]] && have fc-list; then
    FONT="$(fc-list 2>/dev/null | grep -iE '\.(ttf|otf):' | head -n 1 | cut -d: -f1)"
  fi
fi
[[ -f "$FONT" ]] || die "no font file found; pass --font /path/to/font.ttf (see: fc-list | head)"
FONT_FAMILY="$(fc-query -f '%{family[0]}' "$FONT" 2>/dev/null || echo 'DejaVu Sans')"

# Caption size scales with the picture height (44 px at 1200 px high).
HEIGHT=""
if have ffprobe; then
  HEIGHT="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$INPUT" 2>/dev/null | head -n 1 || true)"
elif have gst-discoverer-1.0; then
  HEIGHT="$(gst-discoverer-1.0 "$INPUT" 2>/dev/null | awk '/Height:/{print $2; exit}' || true)"
fi
[[ "$HEIGHT" =~ ^[0-9]+$ ]] || HEIGHT=1200
[[ -n "$SIZE" ]] || SIZE=$(( HEIGHT * 44 / 1200 ))
LABEL_SIZE=$(( SIZE * 3 / 4 ))
MARGIN=$(( HEIGHT / 24 ))

# Parse the captions file into parallel arrays.
STARTS=(); ENDS=(); TEXTS=()
lineno=0
while IFS= read -r line || [[ -n "$line" ]]; do
  lineno=$((lineno + 1))
  [[ -z "${line// /}" || "$line" =~ ^[[:space:]]*# ]] && continue
  read -r s e text <<<"$line"
  is_num "$s" && is_num "$e" && [[ -n "${text:-}" ]] \
    || die "$CAPTIONS:$lineno: expected 'START END CAPTION TEXT', got: $line"
  awk -v a="$s" -v b="$e" 'BEGIN{exit !(a<b)}' || die "$CAPTIONS:$lineno: end must be after start"
  STARTS+=("$s"); ENDS+=("$e"); TEXTS+=("$text")
done < "$CAPTIONS"
[[ ${#STARTS[@]} -gt 0 ]] || die "no captions found in $CAPTIONS"

mkdir -p "$OUT_DIR"
[[ -n "$NAME" ]] || { NAME="$(basename "$INPUT")"; NAME="${NAME%.*}"; }
EXT=mp4; [[ "$BACKEND" == gst ]] && EXT=webm
OUT="$OUT_DIR/$NAME-captioned.$EXT"
k=2
while [[ -e "$OUT" ]]; do OUT="$OUT_DIR/$NAME-captioned-$k.$EXT"; k=$((k + 1)); done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/caption-video.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

say "caption-video plan"
say "  input:      $INPUT (${HEIGHT}px high)"
say "  captions:   $CAPTIONS (${#STARTS[@]} lines)"
for i in "${!STARTS[@]}"; do printf '    %7s to %-7s %s\n' "${STARTS[$i]}" "${ENDS[$i]}" "${TEXTS[$i]}"; done
if [[ ${#COMPRESSED[@]} -gt 0 ]]; then
  for r in "${COMPRESSED[@]}"; do say "  label:      \"$LABEL\" from ${r% *} to ${r#* } s"; done
else
  say "  label:      none (pass --compressed START END if any part of the footage is sped up or cut)"
fi
say "  font:       $FONT ($FONT_FAMILY), ${SIZE}px captions, ${LABEL_SIZE}px label"
say "  backend:    $BACKEND"
say "  output:     $OUT"
say ""

# ---------------------------------------------------------------------------
# ffmpeg drawtext
# ---------------------------------------------------------------------------
# Path and text escaping for the filter graph: text goes through textfile= with
# expansion=none so no escaping of the caption itself is needed.
fesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g" -e 's/:/\\:/g' -e 's/,/\\,/g'; }

if [[ "$BACKEND" == ffmpeg ]]; then
  FONT_E="$(fesc "$FONT")"
  FILTER=""
  for i in "${!STARTS[@]}"; do
    printf '%s' "${TEXTS[$i]}" > "$TMP/cap-$i.txt"
    f="drawtext=fontfile=$FONT_E:textfile=$(fesc "$TMP/cap-$i.txt"):expansion=none"
    f+=":fontsize=$SIZE:fontcolor=white:borderw=2:bordercolor=black"
    f+=":box=1:boxcolor=black@0.55:boxborderw=14:line_spacing=6"
    f+=":x=(w-text_w)/2:y=h-text_h-$MARGIN"
    f+=":enable='between(t,${STARTS[$i]},${ENDS[$i]})'"
    FILTER+="${FILTER:+,}$f"
  done
  if [[ ${#COMPRESSED[@]} -gt 0 ]]; then
    printf '%s' "$LABEL" > "$TMP/label.txt"
    for r in "${COMPRESSED[@]}"; do
      f="drawtext=fontfile=$FONT_E:textfile=$(fesc "$TMP/label.txt"):expansion=none"
      f+=":fontsize=$LABEL_SIZE:fontcolor=yellow:borderw=2:bordercolor=black"
      f+=":box=1:boxcolor=black@0.55:boxborderw=10"
      f+=":x=w-text_w-$MARGIN:y=$MARGIN"
      f+=":enable='between(t,${r% *},${r#* })'"
      FILTER+=",$f"
    done
  fi
  ENCS="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
  if grep -qw libx264 <<<"$ENCS"; then ENC=(-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p)
  elif grep -qw libopenh264 <<<"$ENCS"; then ENC=(-c:v libopenh264 -b:v 8M -pix_fmt yuv420p)
  else ENC=(-c:v mpeg4 -q:v 2); say "note: no H.264 encoder in this ffmpeg, using mpeg4 inside .mp4"; fi
  CMD=(ffmpeg -hide_banner -nostdin -i "$INPUT" -vf "$FILTER" "${ENC[@]}" -c:a aac -b:a 160k -movflags +faststart "$OUT")
fi

# ---------------------------------------------------------------------------
# GStreamer fallback: captions -> SRT -> subtitleoverlay
# ---------------------------------------------------------------------------
if [[ "$BACKEND" == gst ]]; then
  SRT="$TMP/captions.srt"
  python3 - "$CAPTIONS" "$LABEL" "$SRT" "${COMPRESSED[@]}" <<'PY'
import sys
caps_path, label, srt_path, *ranges = sys.argv[1:]
caps = []
for raw in open(caps_path, encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    s, e, text = line.split(None, 2)
    caps.append((float(s), float(e), text))
rng = [(float(r.split()[0]), float(r.split()[1])) for r in ranges]
points = sorted({p for s, e, _ in caps for p in (s, e)} | {p for s, e in rng for p in (s, e)})
def ts(t):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
out, n = [], 0
for a, b in zip(points, points[1:]):
    lines = [t for s, e, t in caps if s <= a < e]
    if any(s <= a < e for s, e in rng):
        lines.append(f"[{label}]")
    if lines:
        n += 1
        out.append(f"{n}\n{ts(a)} --> {ts(b)}\n" + "\n".join(lines) + "\n")
open(srt_path, "w", encoding="utf-8").write("\n".join(out))
PY
  PT=$(( SIZE * 3 / 4 ))   # pango sizes are points (96 dpi)
  CMD=(gst-launch-1.0 -e -q
       filesrc "location=$INPUT" ! decodebin ! videoconvert
       ! subtitleoverlay name=ov "font-desc=$FONT_FAMILY Bold $PT"
       ! videoconvert ! queue
       ! vp8enc deadline=1 cpu-used=4 "threads=$(nproc 2>/dev/null || echo 4)" target-bitrate=12000000 keyframe-max-dist=60
       ! webmmux ! filesink "location=$OUT"
       filesrc "location=$SRT" ! subparse ! ov.)
  say "note: GStreamer fallback drops audio and writes VP8/WebM; the label is shown as a bracketed second caption line."
fi

say "Command:"
printf '  %q' "${CMD[@]}"; printf '\n\n'
if [[ "$DRY_RUN" == 1 ]]; then
  [[ "$BACKEND" == gst ]] && { say "SRT that would be burned:"; sed 's/^/  /' "$SRT"; }
  say "(dry run, nothing written)"
  exit 0
fi

if ! "${CMD[@]}"; then
  rm -f -- "$OUT"
  die "$BACKEND failed (see the messages above); nothing was written"
fi
[[ -s "$OUT" ]] || die "no output written"
say ""
say "Wrote $OUT ($(du -h -- "$OUT" | cut -f1)). The input was not modified."
say "Keep both: the uncut input is the evidence, this file is the presentation copy."
