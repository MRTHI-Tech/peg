import type {PegNode} from '@/lib/types';

export const NODE_HEADER_HEIGHT = 28;
export const NODE_FOOTER_HEIGHT = 32;

/**
 * Approximate rendered height of a node, in world units.
 *
 * Used for fit-to-view and for the minimap-style bounds; the DOM still sizes
 * itself, so this only needs to be close.
 */
export function estimateNodeHeight(node: PegNode): number {
  if (node.result) {
    // Square media preview plus chrome.
    return NODE_HEADER_HEIGHT + node.width + NODE_FOOTER_HEIGHT;
  }
  if (node.text != null) {
    const lines = Math.ceil(node.text.length / 34);
    return NODE_HEADER_HEIGHT + Math.min(180, Math.max(48, lines * 15)) + 12;
  }
  return NODE_HEADER_HEIGHT + 96 + NODE_FOOTER_HEIGHT;
}
