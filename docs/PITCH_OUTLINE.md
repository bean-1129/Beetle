# Beetle pitch outline (six slides, five minutes)

Numbers in brackets are placeholders to be replaced with values from data/benchmarks and data/reports before the deck deadline. Nothing unmeasured goes on a slide.

## 1. The problem and the user

- Technical designers at small studios iterate on playable prototypes by stopping the session, editing, rebuilding, and re-gathering playtesters.
- Every "stop" costs the thing they are trying to observe: how people actually play.
- Beetle's promise: change the game without stopping the game.

## 2. The Beetle workflow

- Brief to playable world, two phones join, designer edits while people play, agent validates and repairs, new version lands without a reset, version report.
- One machine, one local model, one real agent runtime (OpenClaw), zero cloud.

## 3. The working video

- 90 to 120 seconds: fresh world, two phones, an edit prepared while players move, preserved progress, a conflicting edit caught by the validator, the repaired version committed.
- Any time compression is labelled on screen.

## 4. Agent architecture and validation

- WorldSpec (structure) is separate from SessionState (players, relics, score). Versions advance only on committed transactions.
- The agent reads state, proposes, validates, repairs within a bounded budget, commits only with a server-issued proof, and reports.
- Validation is deterministic game code: geometry, bridge sockets, walk field, reachability with the gate locked, occupied-support checks at commit time. An LLM saying valid is never approval.
- Nothing from the model is executed. Output is schema-checked JSON only.

## 5. Measured local-first results

- Model: [tag, quantization] on the GB10 via Ollama on loopback.
- Brief to playable: [min / p50 / max over N runs, cold load reported separately].
- Edit to commit: [min / p50 / max].
- Invalid edits caught: [count] of [attempts]; repairs that succeeded: [count].
- Session continuity: [players kept, relics kept, reconnects] across [N] commits.
- Offline proof: [what was disconnected, what still worked].

## 6. Business hypothesis and next validation

- Hypothesis: studios will pay for faster prototype iteration that keeps playtests running, with data staying on their machines.
- Not claimed: market size, pricing, customer traction, speed-up percentages without a measured baseline.
- Next validation: time a conventional edit-rebuild-regather loop with the same designers and the same change list, and compare against Beetle's measured edit-to-commit times.
