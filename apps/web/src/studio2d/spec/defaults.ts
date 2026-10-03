import type { ControlMap, Genre, HudItem, MenuDef, Rule } from "./types.ts";

export function defaultControls(genre: Genre): ControlMap {
  const base: ControlMap = {
    left: ["ArrowLeft", "KeyA", "pad:left"],
    right: ["ArrowRight", "KeyD", "pad:right"],
    up: ["ArrowUp", "KeyW", "pad:up"],
    down: ["ArrowDown", "KeyS", "pad:down"],
    jump: ["Space", "KeyZ", "pad:a"],
    action: ["KeyX", "Enter", "pad:b"],
    pause: ["Escape", "KeyP", "pad:start"],
  };
  // Top-down and arena games have no jump: up moves, space acts.
  if (genre === "top-down" || genre === "arena" || genre === "puzzle" || genre === "defense") {
    base.jump = [];
    base.action = ["Space", "KeyX", "Enter", "pad:a"];
  }
  if (genre === "runner") base.up = ["ArrowUp", "KeyW"];
  return base;
}

export function defaultHud(genre: Genre): HudItem[] {
  switch (genre) {
    case "platformer":
      return [{ kind: "score" }, { kind: "lives", anchor: "top-right" }, { kind: "collected", anchor: "top-center" }];
    case "top-down":
      return [{ kind: "health" }, { kind: "collected", anchor: "top-center" }, { kind: "score", anchor: "top-right" }];
    case "runner":
      return [{ kind: "distance" }, { kind: "score", anchor: "top-right" }];
    case "arena":
      return [{ kind: "health" }, { kind: "score", anchor: "top-right" }, { kind: "timer", anchor: "top-center" }];
    case "puzzle":
      return [{ kind: "level" }, { kind: "timer", anchor: "top-right" }];
    case "builder":
      return [{ kind: "parts" }, { kind: "level", anchor: "top-right" }];
    case "defense":
      return [{ kind: "currency" }, { kind: "wave", anchor: "top-right" }, { kind: "score", anchor: "top-right" }];
  }
}

export function defaultMenus(title: string): MenuDef[] {
  return [
    { id: "title", title, items: ["Play", "Controls"] },
    { id: "pause", title: "Paused", items: ["Resume", "Restart level", "Quit to title"] },
    { id: "win", title: "You did it!", items: ["Next level", "Replay"] },
    { id: "lose", title: "Try again", items: ["Retry", "Quit to title"] },
    { id: "level", title: "Level", items: ["Start"] },
  ];
}

export function defaultRules(genre: Genre): Rule[] {
  switch (genre) {
    case "platformer":
      return [
        { type: "win", when: "reach-goal" },
        { type: "lives", count: 3 },
        { type: "lose", when: "no-lives" },
        { type: "score", event: "collect", points: 10 },
        { type: "score", event: "defeat", points: 50 },
      ];
    case "top-down":
      return [
        { type: "win", when: "reach-goal" },
        { type: "lose", when: "health-zero" },
        { type: "score", event: "collect", points: 10 },
      ];
    case "runner":
      return [
        { type: "win", when: "reach-goal" },
        { type: "lives", count: 1 },
        { type: "lose", when: "no-lives" },
        { type: "score", event: "distance", points: 1 },
        { type: "score", event: "collect", points: 5 },
      ];
    case "arena":
      return [
        { type: "win", when: "defeat-all" },
        { type: "lose", when: "health-zero" },
        { type: "score", event: "defeat", points: 25 },
      ];
    case "puzzle":
      return [{ type: "win", when: "reach-goal" }, { type: "timer", seconds: 0, countDown: false }];
    case "builder":
      return [{ type: "win", when: "reach-goal" }];
    case "defense":
      return [
        { type: "win", when: "defeat-all" },
        { type: "lose", when: "base-reached" },
        { type: "score", event: "defeat", points: 10 },
      ];
  }
}

export const DEFAULT_GRAVITY: Record<Genre, number> = {
  platformer: 60, // tiles/s² (scaled by tile size at runtime)
  runner: 70,
  builder: 40,
  "top-down": 0,
  arena: 0,
  puzzle: 0,
  defense: 0,
};

export const PALETTES: Record<string, string[]> = {
  forest: ["#12241c", "#1f3d2b", "#2e6b3f", "#58a653", "#a7d86b", "#f2e8b6", "#e08a3c", "#b0413e", "#5b8fd6", "#2a2f4a"],
  night: ["#0d1026", "#1c2150", "#34408a", "#5c6fd6", "#9fb4ff", "#e7ecff", "#ffcf5c", "#ff6b8a", "#3fd6a8", "#161616"],
  desert: ["#2b1a12", "#5e3423", "#a0562e", "#d68a45", "#f2c07a", "#fff1d0", "#6aa3b8", "#2f6f73", "#c2413b", "#1a1a1a"],
  candy: ["#2d1b3d", "#5a2d6e", "#a54aa5", "#f278b8", "#ffc1dc", "#fff4f8", "#7fd6ff", "#4a90e2", "#ffd35c", "#1f1f2e"],
  snow: ["#18232e", "#2e4556", "#58819a", "#9cc3d9", "#dff1fb", "#ffffff", "#f2a65a", "#c94f4f", "#6fbf73", "#101418"],
  lava: ["#1a0b0b", "#3d1414", "#7a2418", "#c43d1c", "#f2781c", "#ffd05c", "#fff4d6", "#5c5c70", "#2e2e3d", "#0b0b0f"],
  ocean: ["#08202e", "#0f3b52", "#17658a", "#2aa3c4", "#7fe0e8", "#e6fbff", "#f7d774", "#f07a5a", "#3d8b5c", "#0a0f14"],
  space: ["#05050f", "#141432", "#2b2b6e", "#5b4bd6", "#a88bff", "#f0eaff", "#5cf2d6", "#ff5c8a", "#ffd65c", "#1a1a1a"],
};
