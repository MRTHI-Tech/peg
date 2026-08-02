/**
 * Fixture data standing in for the backend.
 *
 * Everything here is read through `lib/workflow-service.ts`, which is the single
 * module to replace when Genblaze (orchestration) and B2 (storage) are wired up.
 */

import {getNodeDef, defaultParams} from './catalog';
import {placeholderImage} from './placeholder';
import type {AssetRef, Edge, PegNode, Workflow} from './types';

const BUCKET = 'peg-media';

function asset(seed: string, palette: string, caption?: string): AssetRef {
  return {
    assetKey: `runs/demo/${seed}/output.png`,
    bucket: BUCKET,
    contentType: 'image/png',
    bytes: 1_482_000,
    url: placeholderImage({seed, palette, caption}),
    width: 512,
    height: 512,
  };
}

interface NodeSeed {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  text?: string;
  status?: PegNode['status'];
  params?: Record<string, string | number | boolean>;
  result?: AssetRef;
}

/** Build a canvas node from a catalog entry plus per-instance overrides. */
function node(seed: NodeSeed): PegNode {
  const def = getNodeDef(seed.type);
  if (!def) throw new Error(`Unknown node type: ${seed.type}`);
  return {
    id: seed.id,
    type: def.type,
    title: def.title,
    category: def.category,
    provider: def.provider,
    model: def.model,
    cost: def.cost,
    x: seed.x,
    y: seed.y,
    width: seed.width ?? 240,
    status: seed.status ?? (seed.result ? 'complete' : 'idle'),
    params: {...defaultParams(def), ...seed.params},
    inputs: def.inputs,
    outputs: def.outputs,
    text: seed.text,
    result: seed.result,
    provenance: seed.result
      ? {
          runId: 'run_8f21c',
          nodeId: seed.id,
          producedBy: {provider: def.provider ?? 'local', model: def.model ?? def.type},
          inputAssetKeys: [],
          params: {...defaultParams(def), ...seed.params},
          createdAt: '2026-07-28T14:12:00Z',
        }
      : undefined,
  };
}

/**
 * The reference workflow: one brief plus a locked brand kit becomes a
 * breakpoint-correct hero plate with the real product composited on top.
 */
const HERO_NODES: PegNode[] = [
  node({
    id: 'n-kit',
    type: 'style-kit',
    x: 40,
    y: 120,
    width: 220,
    params: {
      name: 'Brand Kit',
      notes:
        'Deep violet-to-magenta gradient environment, dark studio falloff, glossy reflective podiums, hard rim light, fine particle sparkle, high specular.',
    },
    result: asset('brand-style-kit', 'dusk'),
  }),
  node({
    id: 'n-format',
    type: 'format',
    x: 40,
    y: 480,
    width: 220,
    params: {preset: 'Desktop hero', safeArea: 'Left third', focalPoint: 'Right'},
  }),
  node({
    id: 'n-brief',
    type: 'prompt',
    x: 40,
    y: 680,
    width: 220,
    text: 'Launch hero for the new account tier. Three cards floating above reflective podiums, camera slightly low, generous negative space on the left for the headline.',
  }),
  node({
    id: 'n-enhancer',
    type: 'prompt-enhancer',
    x: 340,
    y: 640,
    width: 220,
    params: {intent: 'Campaign hero'},
  }),
  node({
    id: 'n-plate',
    type: 'brand-scene',
    x: 640,
    y: 160,
    width: 280,
    params: {resolution: '1920x600', numberOfImages: 1, randomSeed: false, seed: 285241},
    result: asset('hero-plate', 'dusk'),
  }),
  node({
    id: 'n-product',
    type: 'product-asset',
    x: 640,
    y: 620,
    width: 220,
    params: {assetKey: 'brand/cards/tier-3-front.png'},
    result: asset('product-cutout', 'mono'),
  }),
  node({
    id: 'n-composite',
    type: 'composite',
    x: 1000,
    y: 400,
    width: 260,
    params: {scale: 100, opacity: 100, shadow: true},
    result: asset('hero-composite', 'bloom'),
  }),
  node({
    id: 'n-preview',
    type: 'preview',
    x: 1340,
    y: 160,
    width: 240,
    params: {showOverlay: true},
    result: asset('hero-preview', 'bloom'),
  }),
  node({
    id: 'n-export',
    type: 'export',
    x: 1340,
    y: 560,
    width: 220,
    params: {format: 'png'},
    result: asset('hero-final', 'ice'),
  }),
];

/** Type-valid against the catalog: style/format/text/image ports only meet their own kind. */
const HERO_EDGES: Edge[] = [
  {id: 'e1', fromNode: 'n-kit', fromPort: 'style', toNode: 'n-enhancer', toPort: 'style', type: 'style'},
  {id: 'e2', fromNode: 'n-brief', fromPort: 'text', toNode: 'n-enhancer', toPort: 'prompt', type: 'text'},
  {id: 'e3', fromNode: 'n-kit', fromPort: 'style', toNode: 'n-plate', toPort: 'style', type: 'style'},
  {id: 'e4', fromNode: 'n-enhancer', fromPort: 'text', toNode: 'n-plate', toPort: 'prompt', type: 'text'},
  {id: 'e5', fromNode: 'n-format', fromPort: 'format', toNode: 'n-plate', toPort: 'format', type: 'format'},
  {id: 'e6', fromNode: 'n-plate', fromPort: 'result', toNode: 'n-composite', toPort: 'base', type: 'image'},
  {
    id: 'e7',
    fromNode: 'n-product',
    fromPort: 'result',
    toNode: 'n-composite',
    toPort: 'overlay',
    type: 'image',
  },
  {
    id: 'e8',
    fromNode: 'n-format',
    fromPort: 'format',
    toNode: 'n-composite',
    toPort: 'format',
    type: 'format',
  },
  {
    id: 'e9',
    fromNode: 'n-composite',
    fromPort: 'result',
    toNode: 'n-preview',
    toPort: 'asset',
    type: 'image',
  },
  {
    id: 'e10',
    fromNode: 'n-composite',
    fromPort: 'result',
    toNode: 'n-export',
    toPort: 'asset',
    type: 'image',
  },
];

export const HERO_WORKFLOW: Workflow = {
  id: 'desktop-hero',
  name: 'Launch Hero — Desktop',
  nodes: HERO_NODES,
  edges: HERO_EDGES,
  updatedAt: '2026-07-28T14:12:00Z',
  nodeCount: HERO_NODES.length,
  thumbnailUrl: placeholderImage({seed: 'hero-composite', palette: 'bloom', width: 480, height: 300}),
};

/** Gallery entries. Only HERO_WORKFLOW has a full graph; the rest are cards. */
export const WORKFLOWS: Workflow[] = [
  HERO_WORKFLOW,
  {
    id: 'mobile-hero',
    name: 'Launch Hero — Mobile',
    nodes: [],
    edges: [],
    updatedAt: '2026-07-30T09:40:00Z',
    nodeCount: 9,
    thumbnailUrl: placeholderImage({seed: 'mobile-hero', palette: 'dusk', width: 480, height: 300}),
  },
  {
    id: 'card-range-plates',
    name: 'Card Range Plates',
    nodes: [],
    edges: [],
    updatedAt: '2026-07-29T17:05:00Z',
    nodeCount: 12,
    thumbnailUrl: placeholderImage({seed: 'card-range', palette: 'bloom', width: 480, height: 300}),
  },
  {
    id: 'rewards-campaign',
    name: 'Rewards Campaign',
    nodes: [],
    edges: [],
    updatedAt: '2026-07-27T11:20:00Z',
    nodeCount: 11,
    thumbnailUrl: placeholderImage({seed: 'rewards', palette: 'ember', width: 480, height: 300}),
  },
  {
    id: 'social-square-set',
    name: 'Social Square Set',
    nodes: [],
    edges: [],
    updatedAt: '2026-07-25T08:15:00Z',
    nodeCount: 8,
    thumbnailUrl: placeholderImage({seed: 'social-square', palette: 'ice', width: 480, height: 300}),
  },
  {
    id: 'app-store-screens',
    name: 'App Store Screens',
    nodes: [],
    edges: [],
    updatedAt: '2026-07-22T19:30:00Z',
    nodeCount: 14,
    thumbnailUrl: placeholderImage({seed: 'app-store', palette: 'mono', width: 480, height: 300}),
  },
];

/** Starter graphs offered on the gallery page. */
export const TEMPLATES = [
  {
    id: 'hero-plate',
    name: 'Hero Plate',
    description: 'Brand kit plus a brief into a breakpoint-correct hero background.',
    nodeCount: 5,
    palette: 'dusk',
  },
  {
    id: 'product-composite',
    name: 'Product Composite',
    description: 'Generate the plate, then drop the real product cutout on the focal point.',
    nodeCount: 7,
    palette: 'bloom',
  },
  {
    id: 'breakpoint-set',
    name: 'Breakpoint Set',
    description: 'One brief composed separately for desktop, mobile, and square.',
    nodeCount: 9,
    palette: 'ice',
  },
  {
    id: 'extend-canvas',
    name: 'Extend Canvas',
    description: 'Take an existing plate and gen-fill it out to a taller crop.',
    nodeCount: 4,
    palette: 'ember',
  },
];

export const ACCOUNT = {
  credits: 148,
  plan: 'Studio',
  name: 'Tlotliso',
};
