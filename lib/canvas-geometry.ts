/**
 * Canvas coordinate math, kept out of the React layer so it stays testable.
 *
 * Two spaces are in play:
 *   - world:  the infinite canvas. Node x/y live here.
 *   - screen: pixels inside the canvas viewport element.
 *
 * screen = world * zoom + pan
 * world  = (screen - pan) / zoom
 */

import type {Edge, PegNode} from './types';

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2.5;

/** Vertical offset of the first port from the node's top edge. */
export const PORT_TOP_OFFSET = 26;
/** Spacing between successive ports on the same edge. */
export const PORT_SPACING = 20;

export function worldToScreen(wx: number, wy: number, vp: Viewport): {x: number; y: number} {
  return {x: wx * vp.zoom + vp.x, y: wy * vp.zoom + vp.y};
}

export function screenToWorld(sx: number, sy: number, vp: Viewport): {x: number; y: number} {
  return {x: (sx - vp.x) / vp.zoom, y: (sy - vp.y) / vp.zoom};
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zoom about a fixed screen point, so the point under the cursor stays put. */
export function zoomAt(vp: Viewport, nextZoom: number, screenX: number, screenY: number): Viewport {
  const zoom = clampZoom(nextZoom);
  const world = screenToWorld(screenX, screenY, vp);
  return {zoom, x: screenX - world.x * zoom, y: screenY - world.y * zoom};
}

/** World-space position of a port anchor, used as a bezier endpoint. */
export function portPosition(
  node: PegNode,
  portId: string,
  side: 'input' | 'output',
): {x: number; y: number} {
  const ports = side === 'input' ? node.inputs : node.outputs;
  const index = Math.max(0, ports.findIndex(p => p.id === portId));
  return {
    x: side === 'input' ? node.x : node.x + node.width,
    y: node.y + PORT_TOP_OFFSET + index * PORT_SPACING,
  };
}

/** Cubic bezier with horizontal control handles, matching the canvas edge style. */
export function edgePath(from: {x: number; y: number}, to: {x: number; y: number}): string {
  const dx = Math.abs(to.x - from.x);
  const handle = Math.max(40, Math.min(160, dx * 0.5));
  return `M ${from.x} ${from.y} C ${from.x + handle} ${from.y}, ${to.x - handle} ${to.y}, ${to.x} ${to.y}`;
}

/** Midpoint of the same curve, used to place the edge's type label. */
export function edgeMidpoint(
  from: {x: number; y: number},
  to: {x: number; y: number},
): {x: number; y: number} {
  const dx = Math.abs(to.x - from.x);
  const handle = Math.max(40, Math.min(160, dx * 0.5));
  const c1 = {x: from.x + handle, y: from.y};
  const c2 = {x: to.x - handle, y: to.y};
  // Cubic bezier evaluated at t = 0.5.
  return {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
  };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of all nodes, in world space. Heights are estimated. */
export function graphBounds(nodes: PegNode[], estimateHeight: (n: PegNode) => number): Bounds | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + estimateHeight(n));
  }
  return {minX, minY, maxX, maxY};
}

/** Viewport that fits `bounds` inside a viewport of the given size. */
export function fitViewport(bounds: Bounds, width: number, height: number, padding = 80): Viewport {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = clampZoom(Math.min((width - padding * 2) / bw, (height - padding * 2) / bh));
  return {
    zoom,
    x: width / 2 - (bounds.minX + bw / 2) * zoom,
    y: height / 2 - (bounds.minY + bh / 2) * zoom,
  };
}

/** A connection is valid when types match and it doesn't loop back on itself. */
export function canConnect(
  source: {node: PegNode; portId: string},
  target: {node: PegNode; portId: string},
  edges: Edge[],
): boolean {
  if (source.node.id === target.node.id) return false;
  const out = source.node.outputs.find(p => p.id === source.portId);
  const inp = target.node.inputs.find(p => p.id === target.portId);
  if (!out || !inp) return false;
  if (out.type !== inp.type) return false;
  // An input accepts a single upstream connection.
  return !edges.some(e => e.toNode === target.node.id && e.toPort === target.portId);
}

/** Edge colors are keyed by port type, matching the palette's type chips. */
export const PORT_TYPE_COLOR: Record<string, string> = {
  text: 'var(--color-icon-pink)',
  image: 'var(--color-icon-teal)',
  video: 'var(--color-icon-purple)',
  audio: 'var(--color-icon-orange)',
  mask: 'var(--color-icon-blue)',
  // Brand constraints rather than media — yellow/green so they read as a
  // different class of connection on the canvas.
  style: 'var(--color-icon-yellow)',
  format: 'var(--color-icon-green)',
};
