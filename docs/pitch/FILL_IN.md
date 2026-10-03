# Pitch deck placeholders

Deck: `docs/pitch/Beetle-pitch.pptx` (six slides). Every value in square brackets is a placeholder. Replace each one only with a value read from the file named in the "Source" column. If the source file does not exist or the field is missing when the deck is finalised, leave the bracket in place and say "measurement pending" out loud; never estimate.

Regenerate the deck by editing the generator (the bracketed strings are literal text in the slide shapes, so they can also be replaced directly in PowerPoint or LibreOffice with Find and Replace).

## Slide 3: the working video

| Placeholder | Meaning | Source |
|---|---|---|
| `[VIDEO PLACEHOLDER]` (the large frame) | 90 to 120 second demo recording, inserted as a video object | the rehearsal recording (Insert Video over the frame); shot list and captions come from `docs/STORYBOARD.md` |

The caption list on the slide is copied from `docs/STORYBOARD.md`. If a shot is cut during rehearsal, delete its caption line; do not reword it to describe something that was not recorded.

## Slide 4: agent architecture and validation

| Placeholder | Meaning | Source |
|---|---|---|
| `[max attempts]` | bounded number of repair attempts per request | `BEETLE_MAX_REPAIR_ATTEMPTS` in `.env` (default `2` in `.env.example`); confirm against the `attempts` field in `data/reports/*.json` |

## Slide 5: measured local-first results

| Placeholder | Meaning | Source |
|---|---|---|
| `[model tag]` | Ollama model tag used for the measured runs | `data/benchmarks/*.json` (model field); summarised in `docs/RESULTS.md` |
| `[quantization]` | quantization of that model | `data/benchmarks/*.json` (model field); `ollama list` output recorded in `docs/RESULTS.md` |
| `[min] / [p50] / [max] s` (brief to playable) | brief submitted to first playable version, warm | `data/benchmarks/*.json` (brief to playable timings) |
| `[N]` (runs) | number of brief-to-playable runs behind min, p50, max | `data/benchmarks/*.json` (run count) |
| `[cold s]` | cold-load brief-to-playable time, reported separately | `data/benchmarks/*.json` (cold run) |
| `[min] / [p50] / [max] s` (edit to commit) | edit request to committed version | `data/benchmarks/*.json` (edit timings) and the per-version timings in `data/reports/*.json` |
| `[caught]` | invalid edits refused by the validator | `data/reports/*.json` (validation issues per version) |
| `[attempts]` | total edit attempts in those sessions | `data/reports/*.json` (attempts per version) |
| `[repaired]` | repairs that produced a committed version | `data/reports/*.json` (versions committed after a repair) |
| `[players kept]` | players still connected across the commits | `data/reports/*.json` (session continuity) |
| `[relics kept]` | collected relics preserved across the commits | `data/reports/*.json` (preserved summary) |
| `[reconnects]` | phone reconnects observed during the session | `data/reports/*.json` (connection events) |
| `[N commits]` | number of committed versions in the measured session | `data/reports/*.json` (version count) |
| `[what was disconnected]` | what was unplugged or blocked for the offline proof | `docs/RESULTS.md` (offline proof section, from the `docs/LOCAL_ONLY_CHECKLIST.md` run) |
| `[what still worked]` | what kept working while disconnected | `docs/RESULTS.md` (offline proof section) |

## Notes

- `docs/RESULTS.md` does not exist yet. It should be written from the same `data/benchmarks/*.json` and `data/reports/*.json` files, and the deck should agree with it line for line.
- `data/benchmarks/` and `data/reports/` are ignored by git and were empty when this deck was built. `BUILD_STATUS.md` records a probe of qwen3.5:4b (world draft 54 s cold, 20 s warm; edit patch 1.6 to 2.2 s) but that is a probe, not a benchmark, so it is not on the slide.
- Slides 1, 2 and 6 contain no placeholders.
