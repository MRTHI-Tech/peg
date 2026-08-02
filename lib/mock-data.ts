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

function asset(
  seed: string,
  palette: string,
  {
    caption,
    width = 512,
    height = 512,
  }: {caption?: string; width?: number; height?: number} = {},
): AssetRef {
  return {
    assetKey: `runs/demo/${seed}/output.png`,
    bucket: BUCKET,
    contentType: 'image/png',
    bytes: 1_482_000,
    url: placeholderImage({seed, palette, caption, width, height}),
    width,
    height,
  };
}

interface NodeSeed {
  id: string;
  type: string;
  title?: string;
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
  const params = {...defaultParams(def), ...seed.params};
  if (def.type === 'prompt' && seed.text != null && seed.params?.value == null) {
    params.value = seed.text;
  }
  return {
    id: seed.id,
    type: def.type,
    title: seed.title ?? def.title,
    category: def.category,
    provider: def.provider,
    model: def.model,
    cost: def.cost,
    x: seed.x,
    y: seed.y,
    width: seed.width ?? 240,
    status: seed.status ?? (seed.result ? 'complete' : 'idle'),
    params,
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
          params,
          createdAt: '2026-07-28T14:12:00Z',
        }
      : undefined,
  };
}

/**
 * The demo's core argument in one graph: generate the brand scene once, then
 * compose a distinct desktop, mobile, and square plate from that same result.
 */
const HERO_NODES: PegNode[] = [
  node({
    id: 'n-kit',
    type: 'style-kit',
    x: 40,
    y: 100,
    width: 220,
    params: {
      name: 'Brand Kit',
      notes:
        'Deep violet-to-magenta gradient environment, dark studio falloff, glossy reflective podiums, hard rim light, fine particle sparkle, high specular.',
    },
    result: asset('brand-style-kit', 'dusk'),
  }),
  node({
    id: 'n-brief',
    type: 'prompt',
    x: 40,
    y: 500,
    width: 220,
    text:
      'Launch hero for the new account tier. Three cards floating above reflective podiums, camera slightly low, with calm copy space around the focal product.',
  }),
  node({
    id: 'n-plate',
    type: 'brand-scene',
    title: 'Master Brand Scene',
    x: 360,
    y: 240,
    width: 260,
    params: {resolution: '1024x1024', numberOfImages: 1, randomSeed: false, seed: 285241},
    result: asset('master-brand-scene', 'dusk', {
      caption: 'Master',
      width: 1024,
      height: 1024,
    }),
  }),
  node({
    id: 'n-format-desktop',
    type: 'format',
    title: 'Desktop Format',
    x: 720,
    y: 40,
    width: 220,
    params: {preset: 'Desktop hero', safeArea: 'Left third', focalPoint: 'Right'},
  }),
  node({
    id: 'n-compose-desktop',
    type: 'genfill',
    title: 'Compose Desktop',
    x: 1040,
    y: 40,
    width: 300,
    params: {strength: 0.65, numberOfImages: 1, randomSeed: false, seed: 285241},
    result: asset('desktop-composition', 'dusk', {
      caption: 'Desktop',
      width: 1920,
      height: 600,
    }),
  }),
  node({
    id: 'n-format-mobile',
    type: 'format',
    title: 'Mobile Format',
    x: 720,
    y: 400,
    width: 220,
    params: {preset: 'Mobile hero', safeArea: 'Upper third', focalPoint: 'Center'},
  }),
  node({
    id: 'n-compose-mobile',
    type: 'genfill',
    title: 'Compose Mobile',
    x: 1040,
    y: 360,
    width: 240,
    params: {strength: 0.65, numberOfImages: 1, randomSeed: false, seed: 285241},
    result: asset('mobile-composition', 'dusk', {
      caption: 'Mobile',
      width: 828,
      height: 1104,
    }),
  }),
  node({
    id: 'n-format-square',
    type: 'format',
    title: 'Square Format',
    x: 720,
    y: 840,
    width: 220,
    params: {preset: 'Square social', safeArea: 'Upper third', focalPoint: 'Center'},
  }),
  node({
    id: 'n-compose-square',
    type: 'genfill',
    title: 'Compose Square',
    x: 1040,
    y: 820,
    width: 260,
    params: {strength: 0.65, numberOfImages: 1, randomSeed: false, seed: 285241},
    result: asset('square-composition', 'dusk', {
      caption: 'Square',
      width: 1080,
      height: 1080,
    }),
  }),
];

/** Type-valid against the catalog: style/format/text/image ports only meet their own kind. */
const HERO_EDGES: Edge[] = [
  {id: 'e1', fromNode: 'n-kit', fromPort: 'style', toNode: 'n-plate', toPort: 'style', type: 'style'},
  {id: 'e2', fromNode: 'n-brief', fromPort: 'text', toNode: 'n-plate', toPort: 'prompt', type: 'text'},
  {
    id: 'e3',
    fromNode: 'n-plate',
    fromPort: 'result',
    toNode: 'n-compose-desktop',
    toPort: 'image',
    type: 'image',
  },
  {
    id: 'e4',
    fromNode: 'n-format-desktop',
    fromPort: 'format',
    toNode: 'n-compose-desktop',
    toPort: 'format',
    type: 'format',
  },
  {
    id: 'e5',
    fromNode: 'n-plate',
    fromPort: 'result',
    toNode: 'n-compose-mobile',
    toPort: 'image',
    type: 'image',
  },
  {
    id: 'e6',
    fromNode: 'n-format-mobile',
    fromPort: 'format',
    toNode: 'n-compose-mobile',
    toPort: 'format',
    type: 'format',
  },
  {
    id: 'e7',
    fromNode: 'n-plate',
    fromPort: 'result',
    toNode: 'n-compose-square',
    toPort: 'image',
    type: 'image',
  },
  {
    id: 'e8',
    fromNode: 'n-format-square',
    fromPort: 'format',
    toNode: 'n-compose-square',
    toPort: 'format',
    type: 'format',
  },
];

export const HERO_WORKFLOW: Workflow = {
  id: 'desktop-hero',
  name: 'Launch Hero — Breakpoint Fan-out',
  nodes: HERO_NODES,
  edges: HERO_EDGES,
  updatedAt: '2026-07-28T14:12:00Z',
  nodeCount: HERO_NODES.length,
  thumbnailUrl: placeholderImage({seed: 'desktop-composition', palette: 'dusk', width: 480, height: 300}),
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

/** The id the editor treats as "start from nothing". */
export const NEW_WORKFLOW_ID = 'new';

/** A blank canvas. Everything is added from the palette. */
export function createEmptyWorkflow(): Workflow {
  return {
    id: NEW_WORKFLOW_ID,
    name: 'Untitled project',
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
    nodeCount: 0,
  };
}

/**
 * Starter graphs offered on the gallery page.
 *
 * Only templates that map to a workflow that actually exists are listed —
 * a card that opens a 404, or silently drops you on a blank canvas, is worse
 * than not offering it. Add entries here as their graphs get built.
 */
export const TEMPLATES = [
  {
    id: 'breakpoint-fan-out',
    workflowId: HERO_WORKFLOW.id,
    name: 'Breakpoint Fan-out',
    description: 'One brief and one generation, composed for desktop, mobile, and square.',
    nodeCount: HERO_WORKFLOW.nodeCount,
    palette: 'dusk',
  },
];

export const ACCOUNT = {
  credits: 148,
  plan: 'Studio',
  name: 'Tlotliso',
};
