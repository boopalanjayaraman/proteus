/**
 * The decorative dependency graph on the home screen (UX v1.3).
 *
 * A fixed, hand-placed subset of the canvas's own node set rather than anything
 * live: nobody is signed in yet, so there is no project to draw and inventing
 * one would put a fabricated finding on the first screen a visitor sees. These
 * ten nodes are the payments fixture, which is the same graph the discovery
 * screen builds for real once a project exists.
 *
 * Positions are percentages of the pane, taken verbatim from the design.
 */

export interface LoginNode {
  id: string;
  name: string;
  /** Percent across and down the pane. */
  left: number;
  top: number;
  colour: string;
}

export interface LoginEdge {
  x1: number; y1: number; x2: number; y2: number;
  /** Inferred relationships are dashed; observed ones are solid. */
  inferred: boolean;
}

/** The impact classes the graph colours by, matching `--bad`/`--warn`/… */
const COLOUR = {
  required: 'var(--bad)',
  likely: 'var(--warn)',
  investigate: 'var(--acc)',
  none: 'var(--ok)',
  vendor: 'var(--vio)',
} as const;

type Impact = keyof typeof COLOUR;

/** `[left%, top%, name, impact]` */
const PLACED: Record<string, [number, number, string, Impact]> = {
  app: [16, 13, 'Payments Web App', 'none'],
  tls: [44, 9, 'TLS 1.3', 'none'],
  api: [33, 31, 'payments-api', 'required'],
  cs: [58, 22, 'CryptoService', 'required'],
  rsa: [80, 11, 'RSA-2048 key transport', 'required'],
  lib: [73, 38, 'bouncycastle 1.72', 'likely'],
  cert: [44, 46, 'pay-api leaf certificate', 'investigate'],
  gw: [80, 53, 'Gateway-X200', 'vendor'],
  hsm: [48, 61, 'Thales p400 HSM', 'vendor'],
  mock: [13, 50, 'PartnerHandshakeMock', 'required'],
};

/** `[from, to, inferred]` — only pairs where both ends are placed. */
const LINKS: Array<[string, string, boolean]> = [
  ['app', 'tls', false],
  ['tls', 'api', false],
  ['api', 'cs', false],
  ['cs', 'rsa', false],
  ['cs', 'lib', false],
  ['cs', 'mock', false],
  ['api', 'cert', false],
  ['cert', 'hsm', true],
  ['api', 'gw', false],
  ['rsa', 'gw', true],
];

export const LOGIN_VIEWBOX = { width: 1000, height: 560 };

export const loginNodes: LoginNode[] = Object.entries(PLACED).map(
  ([id, [left, top, name, impact]]) => ({
    id, name, left, top, colour: COLOUR[impact],
  }),
);

/**
 * Edges in viewBox units.
 *
 * The SVG stretches with `preserveAspectRatio="none"` while the node chips are
 * positioned in percentages, so both scale with the pane and the lines stay
 * attached to the boxes at any width.
 */
export const loginEdges: LoginEdge[] = LINKS.map(([from, to, inferred]) => {
  const a = PLACED[from]!;
  const b = PLACED[to]!;
  const sx = LOGIN_VIEWBOX.width / 100;
  const sy = LOGIN_VIEWBOX.height / 100;
  return {
    x1: a[0] * sx, y1: a[1] * sy,
    x2: b[0] * sx, y2: b[1] * sy,
    inferred,
  };
});
