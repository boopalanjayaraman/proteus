import { describe, expect, it } from 'vitest';
import { LOGIN_VIEWBOX, loginEdges, loginNodes } from '../src/lib/loginGraph';

/**
 * The home screen's decorative graph (UX v1.3).
 *
 * Fixed data, so what is worth asserting is that it is internally consistent —
 * an edge whose endpoint drifts off a node is the kind of thing that looks
 * fine at one window width and wrong at the next.
 */

describe('loginGraph', () => {
  it('places every node inside the pane', () => {
    expect(loginNodes).toHaveLength(10);
    for (const n of loginNodes) {
      expect(n.left, n.id).toBeGreaterThan(0);
      expect(n.left, n.id).toBeLessThan(100);
      expect(n.top, n.id).toBeGreaterThan(0);
      expect(n.top, n.id).toBeLessThan(100);
      expect(n.name.length, n.id).toBeGreaterThan(0);
    }
  });

  it('gives every node a themed colour rather than a literal', () => {
    // A hard-coded hex here would survive the light theme and look wrong in it.
    for (const n of loginNodes) expect(n.colour).toMatch(/^var\(--[a-z]+\)$/);
  });

  it('anchors every edge to a node position', () => {
    const points = new Set(
      loginNodes.map((n) => `${n.left * (LOGIN_VIEWBOX.width / 100)},`
        + `${n.top * (LOGIN_VIEWBOX.height / 100)}`),
    );
    expect(loginEdges).toHaveLength(10);
    for (const e of loginEdges) {
      expect(points.has(`${e.x1},${e.y1}`)).toBe(true);
      expect(points.has(`${e.x2},${e.y2}`)).toBe(true);
    }
  });

  it('draws inferred relationships differently from observed ones', () => {
    // The caption claims the two are kept separate; this is that claim.
    const inferred = loginEdges.filter((e) => e.inferred);
    expect(inferred.length).toBeGreaterThan(0);
    expect(inferred.length).toBeLessThan(loginEdges.length);
  });

  it('has no edge that starts and ends in the same place', () => {
    for (const e of loginEdges) {
      expect(`${e.x1},${e.y1}`).not.toBe(`${e.x2},${e.y2}`);
    }
  });
});
