# Demo runbook (2D)

## Shell setup

```bash
cd /home/dell/Beetle
export PATH=$PWD/.tools/node/bin:$PWD/.tools/ollama/bin:$PATH
```

Ollama must be serving on 127.0.0.1:11434 with `qwen3.5:4b` present (`ollama list`). Run no other Ollama client during the demo; the measured times in docs/RESULTS.md were taken on a shared GPU and contention makes them longer.

## Before the demo (T minus 15 minutes)

1. `npm run demo:check` must pass.
2. `npm run build` if `apps/web/dist` is older than the last web change, then `npm start`.
3. Open `http://127.0.0.1:7700/` on this machine. The status dot should show the local model online.
4. Warm the model with one throwaway idea. The first call after a cold start includes model load (5.5 s of the 14.0 s warm-up in docs/RESULTS.md); say so if it happens on camera.

## Demo sequence

1. Type "a platformer where a fox collects acorns across floating cliffs". Press Design it. Show the design document (title, genre, hero, setting). Press Build. The bot playtest runs per level; the game starts.
2. Play the first level for a few seconds.
3. Change in words: "make the jumps higher", then "more rain". Each change is validated before it applies; a refused change shows its reason.
4. New idea: "a tower defense where bees protect a hive". Show that the genre changes to lane defense.
5. Out-of-genre idea: "tetris". A shipped template plays. Then an idea no template covers: the studio maps it to the closest genre and says so.
6. Export the HTML file, open it from disk, play it with the network off.
7. Open the library and reload a saved game.

## If something fails

| Symptom | Action |
|---|---|
| Status shows model offline | `ollama list`; start Ollama on 127.0.0.1:11434; reload the page. The studio still builds games without the model (idea reader only). |
| Design takes more than 30 s | Another client is using the GPU. Cancel, wait, retry. Say on camera that the GPU is shared. |
| Bot rebuilds a level several times | Normal for side-view genres; it is the level builder regenerating a level the bot could not finish. |
| A change is refused | Read the reason aloud; it is the validator keeping every level beatable. Rephrase. |
| Page says the director token is missing | The page was opened from another device. Use this machine. |

## After the demo

Keep the benchmark output (`data/studio2d-runs/`). Numbers quoted on camera come from docs/RESULTS.md only.
