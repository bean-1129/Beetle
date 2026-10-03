// Case 2: deterministic compile. Owner: world package.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorldSpecSchema, GEOMETRY, type WorldSpec } from '@beetle/contracts';
import { compileWorld, fixtureWorld, specDigest } from '@beetle/world';

const fixturePath = (name: string) => fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));

describe('case 2: compileWorld is deterministic', () => {
  it('compiles the same fixture twice and from a JSON round-trip with equal digest and deep-equal surfaces', () => {
    const spec = fixtureWorld('garden5');
    const a = compileWorld(spec);
    const b = compileWorld(fixtureWorld('garden5'));
    const roundTrip = JSON.parse(JSON.stringify(spec)) as WorldSpec;
    const c = compileWorld(roundTrip);
    const fromFile = WorldSpecSchema.parse(JSON.parse(readFileSync(fixturePath('garden5'), 'utf8')));
    const d = compileWorld(fromFile);

    for (const other of [b, c, d]) {
      expect(other.structuralDigest).toBe(a.structuralDigest);
      expect(other.surfaces).toEqual(a.surfaces);
      expect(other.obstacles).toEqual(a.obstacles);
      expect(Buffer.from(other.nav.walkable).equals(Buffer.from(a.nav.walkable))).toBe(true);
      expect(Buffer.from(other.nav.gateCells).equals(Buffer.from(a.nav.gateCells))).toBe(true);
      expect(other.renderHints).toEqual(a.renderHints);
    }
    expect(a.structuralDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(specDigest(spec)).toBe(specDigest(roundTrip));
  });

  it('changing only the seed keeps structuralDigest but changes renderHints', () => {
    const spec = fixtureWorld('garden5');
    const a = compileWorld(spec);
    const reseeded: WorldSpec = { ...spec, seed: spec.seed + 1 };
    const b = compileWorld(reseeded);
    expect(b.structuralDigest).toBe(a.structuralDigest);
    expect(b.surfaces).toEqual(a.surfaces);
    expect(b.obstacles).toEqual(a.obstacles);
    expect(b.renderHints).not.toEqual(a.renderHints);
    expect(specDigest(reseeded)).not.toBe(specDigest(spec));
  });

  it('exposes support, blocking and fit queries with the documented semantics', () => {
    const c = compileWorld(fixtureWorld('garden5'));
    expect(c.supportAt(0, 0)).toBe('centre');
    expect(c.supportAt(13, 0)).toBe('bridge-east');
    expect(c.supportAt(13, 1.3)).toBeNull(); // beyond the 2.4 m bridge half-width
    expect(c.supportAt(24, 0)).toBe('east');
    expect(c.supportAt(50, 50)).toBeNull();
    expect(c.worldPos('east', { x: 2, z: 0 })).toEqual({ x: 26, z: 0 });
    expect(c.worldPos('bridge-east', { x: 0, z: 0 })).toBeNull();
    // gate at (0, 20.5) blocks only while locked
    expect(c.blockedAt(0, 20.5, { gateOpen: false })).toBe('gate');
    expect(c.blockedAt(0, 20.5, { gateOpen: true })).toBeNull();
    // tree-1 at (5, 5): radius 0.7 + playerRadius
    expect(c.blockedAt(5 + 0.7 + GEOMETRY.playerRadius - 0.01, 5, { gateOpen: true })).toBe('tree-1');
    expect(c.blockedAt(5 + 0.7 + GEOMETRY.playerRadius + 0.01, 5, { gateOpen: true })).toBeNull();
    // fits: centre of island yes, island rim no (one of the four probe points is over the hazard)
    expect(c.fits(0, 0, { gateOpen: false })).toBe(true);
    expect(c.fits(8.9, 0.0001, { gateOpen: false })).toBe(true); // rim point toward the east bridge is still supported
    expect(c.fits(0, 8.9, { gateOpen: false })).toBe(true); // rim point toward the north bridge
    expect(c.fits(6.4, 6.4, { gateOpen: false })).toBe(false); // diagonal rim, no bridge
    expect(c.nav.cell).toBe(GEOMETRY.navCell);
    expect(c.nav.cols * c.nav.rows).toBe(c.nav.walkable.length);
    const i = c.nav.indexOf(0, 0);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(c.nav.walkable[i]).toBe(1);
    expect(c.nav.indexOf(1000, 0)).toBe(-1);
    const centre = c.nav.centerOf(i);
    expect(Math.abs(centre.x)).toBeLessThanOrEqual(GEOMETRY.navCell);
    expect(Math.abs(centre.z)).toBeLessThanOrEqual(GEOMETRY.navCell);
  });
});
