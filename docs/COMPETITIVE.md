# Where Beetle 2D fits

A framework for comparing one-prompt game generators, with Beetle's answers. No claims are made about specific competitors' internals; check any product against the same questions.

| Question | Beetle 2D |
|---|---|
| Where does the model run? | On this machine: Ollama on loopback, `qwen3.5:4b`. No cloud model, no cloud fallback. |
| What does the model write? | Data only: a design document or patch operations, checked against JSON schemas. Model-written game code is turned off. |
| Is the result playable every time? | Every level is built from a genre kit, validated, and finished by a bot before it ships. Six of six measured prompts were valid on the first call (docs/RESULTS.md). |
| How fast? | 10.7 to 16.9 s from prompt to validated, playtested spec in the measured run, model already loaded. |
| Can you change it after? | Yes, in plain words; each change is validated and must keep every level beatable. |
| What can it make? | Seven genres (platformer, runner, top-down, arena, puzzle, builder, lane defense) plus shipped templates for classic games. Other ideas map to the closest genre, and the studio says so. |
| What do you take away? | One HTML file with runtime, spec and art inlined, playable offline. |
| Where is your work kept? | A library in the browser on this machine. |

## Trade-off

Code-writing generators can attempt any idea but can return games that do not run, and they execute model output. Beetle covers fewer kinds of game and in exchange every result is validated, playtested and free of model-written code.
