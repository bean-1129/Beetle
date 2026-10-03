// Spec patches: small JSON-pointer edits (a subset of RFC 6902). Both the model's edits and
// hand edits in the Play view are patches, and every patch is validated before it applies.
import type { GameSpec } from "./types.ts";
import { validateSpec, SpecError } from "./validate.ts";

export type PatchOp =
  | { op: "replace"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

export function parsePointer(path: string): string[] {
  if (path === "" || path === "/") return [];
  if (!path.startsWith("/")) throw new Error(`patch path must start with "/": ${path}`);
  return path.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function walk(root: any, parts: string[]) {
  let node = root;
  for (const key of parts.slice(0, -1)) {
    if (FORBIDDEN.has(key)) throw new Error(`patch path uses a forbidden key`);
    if (node == null || typeof node !== "object") throw new Error(`patch path not found at "${key}"`);
    const next = Array.isArray(node) ? node[resolveIndex(node, key, false)] : node[key];
    if (next === undefined) throw new Error(`patch path not found at "${key}"`);
    node = next;
  }
  return node;
}

function resolveIndex(arr: unknown[], key: string, forAdd: boolean): number {
  if (key === "-" && forAdd) return arr.length;
  // Items may be addressed by their id too: /levels/level-2/tiles.
  if (!/^\d+$/.test(key)) {
    const i = arr.findIndex((x: any) => x && typeof x === "object" && x.id === key);
    if (i < 0) throw new Error(`no item with id "${key}"`);
    return i;
  }
  const i = Number(key);
  if (i > arr.length || (!forAdd && i >= arr.length)) throw new Error(`index ${i} is out of range`);
  return i;
}

export function getAt(root: any, path: string): unknown {
  const parts = parsePointer(path);
  if (!parts.length) return root;
  const parent = walk(root, parts);
  const key = parts[parts.length - 1];
  return Array.isArray(parent) ? parent[resolveIndex(parent, key, false)] : parent?.[key];
}

function applyOne(root: any, op: PatchOp) {
  const parts = parsePointer(op.path);
  if (!parts.length) throw new Error("patches cannot replace the whole spec");
  // Game code never comes from a patch: only shipped, hand-written templates run.
  if (parts[0] === "script") throw new Error("That change would add game code, which is turned off on this machine.");
  const parent = walk(root, parts);
  const key = parts[parts.length - 1];
  if (FORBIDDEN.has(key)) throw new Error(`patch path uses a forbidden key`);
  if (parent == null || typeof parent !== "object") throw new Error(`cannot patch inside a value at ${op.path}`);
  const value = "value" in op ? structuredClone(op.value) : undefined;
  if (Array.isArray(parent)) {
    const i = resolveIndex(parent, key, op.op === "add");
    if (op.op === "add") parent.splice(i, 0, value);
    else if (op.op === "remove") parent.splice(i, 1);
    else parent[i] = value;
  } else {
    if (op.op !== "add" && !(key in parent)) {
      if (op.op === "remove") throw new Error(`nothing to remove at ${op.path}`);
    }
    if (op.op === "remove") delete parent[key];
    else parent[key] = value;
  }
}

// Apply patches atomically: all apply and the result validates, or nothing changes.
export function applyPatch(spec: GameSpec, ops: PatchOp[]): GameSpec {
  if (!Array.isArray(ops)) throw new Error("patch must be a list of operations");
  const next = structuredClone(spec);
  for (const op of ops) {
    if (!op || !["replace", "add", "remove"].includes((op as any).op) || typeof (op as any).path !== "string")
      throw new Error(`invalid patch operation ${JSON.stringify(op)}`);
    applyOne(next, op);
  }
  const v = validateSpec(next);
  if (!v.ok) throw new SpecError(v.errors);
  return next;
}

// Patch ops that set one behavior parameter on an entity (the player or an entity def).
export function setParamOps(spec: GameSpec, entityId: string, behavior: string, param: string, value: unknown): PatchOp[] | null {
  const isPlayer = spec.player.id === entityId;
  const ei = isPlayer ? -1 : spec.entities.findIndex((e) => e.id === entityId);
  if (!isPlayer && ei < 0) return null;
  const ent = isPlayer ? spec.player : spec.entities[ei];
  const bi = ent.behaviors.findIndex((b) => b.type === behavior);
  if (bi < 0) return null;
  const base = isPlayer ? `/player/behaviors/${bi}` : `/entities/${ei}/behaviors/${bi}`;
  return ent.behaviors[bi].params
    ? [{ op: "add", path: `${base}/params/${param}`, value }]
    : [{ op: "add", path: `${base}/params`, value: { [param]: value } }];
}
