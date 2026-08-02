/**
 * The node catalog: every block available in the left palette.
 *
 * Scope rule: a node is `live` only if it maps to a model verified in Genblaze's
 * model matrix (docs/reference/model-matrix.md) or to a local operation we can
 * implement in the browser. Everything else is either `coming-soon` (visible,
 * not addable) or absent entirely.
 *
 * Removed in the executable-set pass, and why:
 *   - Higgsfield, Recraft, Mystic/Freepik, Ideogram — no Genblaze connector.
 *   - Flux Dev LoRA, Import Model — Genblaze has no LoRA/fine-tune concept.
 *   - Mask Extractor, Mask by Text — no segmentation models are registered.
 *     Masks can be *consumed* (bria-genfill/eraser) but not generated.
 *   - Levels, Blur, Invert, Channels, Crop, Resize, Merge Alpha, iterators —
 *     out of scope for the brand key-visual workflow.
 *
 * Parameter rule: only parameters the matrix actually lists are exposed —
 * prompt, negative_prompt, resolution, seed, strength, number_of_images, and
 * image/mask inputs. `guidance` and `steps` were dropped; they are not in the
 * documented surface.
 */

import type {NodeCategory, NodeDef, ParamSpec, Port} from './types';

// ---------------------------------------------------------------------- ports

const promptIn = (name = 'Prompt', isRequired = true): Port => ({
  id: 'prompt',
  name,
  type: 'text',
  isRequired,
});
const imageIn = (id = 'image', name = 'Image', isRequired = true): Port => ({
  id,
  name,
  type: 'image',
  isRequired,
});
const styleIn = (isRequired = false): Port => ({
  id: 'style',
  name: 'Style',
  type: 'style',
  isRequired,
});
const maskIn = (isRequired = true): Port => ({id: 'mask', name: 'Mask', type: 'mask', isRequired});
const imageOut = (name = 'Result'): Port => ({id: 'result', name, type: 'image'});
const textOut = (name = 'Text'): Port => ({id: 'text', name, type: 'text'});

// ----------------------------------------------------------------- parameters

const RESOLUTION = {
  key: 'resolution',
  label: 'Resolution',
  kind: 'select',
  options: ['1024x1024', '1536x640', '1920x600', '1280x720', '1080x1350', '1080x1920'],
  default: '1536x640',
  tooltip: 'Output pixel dimensions. Match this to the target breakpoint.',
} satisfies ParamSpec;

const NEGATIVE_PROMPT = {
  key: 'negativePrompt',
  label: 'Negative prompt',
  kind: 'text',
  default: '',
  multiline: true,
  tooltip: 'What to keep out of the frame, e.g. text, logos, watermarks.',
} satisfies ParamSpec;

const SEED = {
  key: 'seed',
  label: 'Seed',
  kind: 'number',
  default: 285241,
  tooltip: 'Lock the seed to keep a look reproducible across a campaign.',
} satisfies ParamSpec;

const RANDOM_SEED = {
  key: 'randomSeed',
  label: 'Random',
  kind: 'toggle',
  default: true,
} satisfies ParamSpec;

const STRENGTH = {
  key: 'strength',
  label: 'Strength',
  kind: 'slider',
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.65,
  tooltip: 'How far the result may drift from the reference image.',
} satisfies ParamSpec;

const NUMBER_OF_IMAGES = {
  key: 'numberOfImages',
  label: 'Variations',
  kind: 'slider',
  min: 1,
  max: 4,
  step: 1,
  default: 1,
  tooltip: 'How many options to generate per run.',
} satisfies ParamSpec;

const GEN_TAIL: ParamSpec[] = [NEGATIVE_PROMPT, SEED, RANDOM_SEED, NUMBER_OF_IMAGES];

export const CATALOG: NodeDef[] = [
  // =========================================================== brand constraints
  {
    type: 'style-kit',
    title: 'Style Kit',
    category: 'brand',
    cost: 0,
    inputs: [],
    outputs: [{id: 'style', name: 'Style', type: 'style'}],
    params: [
      {
        key: 'name',
        label: 'Kit name',
        kind: 'text',
        default: 'Brand Kit',
      },
      {
        key: 'notes',
        label: 'Look description',
        kind: 'text',
        multiline: true,
        default: '',
        tooltip: 'Plain-language description of the brand look, folded into every prompt.',
      },
    ],
    description: 'Reference images that lock the brand look for every downstream generation.',
  },
  {
    type: 'product-asset',
    title: 'Product Asset',
    category: 'brand',
    cost: 0,
    inputs: [],
    outputs: [imageOut('Asset')],
    params: [
      {
        key: 'assetKey',
        label: 'Asset',
        kind: 'text',
        default: '',
        tooltip: 'Transparent PNG pulled from the brand library in B2.',
      },
    ],
    description:
      'A real product cutout from the brand library. Never generated — diffusion cannot render your logo.',
  },
  {
    type: 'format',
    title: 'Format',
    category: 'brand',
    cost: 0,
    inputs: [],
    outputs: [{id: 'format', name: 'Format', type: 'format'}],
    params: [
      {
        key: 'preset',
        label: 'Breakpoint',
        kind: 'select',
        options: ['Desktop hero', 'Laptop hero', 'Tablet', 'Mobile hero', 'Square social', 'Story'],
        default: 'Desktop hero',
      },
      {
        key: 'safeArea',
        label: 'Safe area',
        kind: 'select',
        options: ['Left third', 'Right third', 'Upper third', 'Lower third', 'Center'],
        default: 'Left third',
        tooltip: 'Region kept visually calm so headline copy stays legible.',
      },
      {
        key: 'focalPoint',
        label: 'Focal point',
        kind: 'select',
        options: ['Left', 'Center', 'Right'],
        default: 'Right',
        tooltip: 'Where the product should sit in frame.',
      },
    ],
    description: 'A breakpoint spec: dimensions, safe area, and focal point. Composes, never crops.',
  },

  // =============================================================== image models
  {
    type: 'scene-generate',
    title: 'New Scene',
    category: 'image-models',
    provider: 'gmicloud-image',
    model: 'seedream-5.0-lite',
    cost: 0.01,
    inputs: [promptIn(), {id: 'format', name: 'Format', type: 'format', isRequired: false}],
    outputs: [imageOut()],
    params: [RESOLUTION, ...GEN_TAIL],
    description: 'Text-to-image base. Use when there is no reference to match yet.',
  },
  {
    // Verified end to end and the most reliable model we have: it succeeded
    // first try where the Bria endpoints drop ~2 in 3 submits. Also the only
    // one that renders exact wordmarks legibly.
    type: 'brand-scene',
    title: 'Brand Scene',
    category: 'image-models',
    provider: 'gmicloud-image',
    model: 'gemini-3.1-flash-lite-image',
    cost: 0.03,
    inputs: [promptIn(), styleIn(false), {id: 'format', name: 'Format', type: 'format', isRequired: false}],
    outputs: [imageOut()],
    params: [RESOLUTION, ...GEN_TAIL],
    description:
      'The workhorse. Holds the brand look and is the only model here that renders exact text and marks.',
  },
  {
    type: 'flux-kontext',
    title: 'Match Brand Look',
    category: 'image-models',
    provider: 'gmicloud-image',
    model: 'flux-kontext-pro',
    cost: 0.04,
    inputs: [promptIn(), styleIn(true), {id: 'format', name: 'Format', type: 'format', isRequired: false}],
    outputs: [imageOut()],
    params: [RESOLUTION, ...GEN_TAIL],
    description: 'Reference-locked generation. The core node: holds the brand look across new compositions.',
  },
  {
    type: 'fibo-blend',
    title: 'Blend Reference',
    category: 'image-models',
    provider: 'gmicloud-image',
    model: 'bria-fibo-image-blend',
    cost: 0.03,
    inputs: [promptIn(), styleIn(true)],
    outputs: [imageOut()],
    params: [RESOLUTION, ...GEN_TAIL],
    description: 'Blends a reference look into a new scene. Alternative to Kontext when it drifts.',
  },
  {
    type: 'reve-remix',
    title: 'Recompose',
    category: 'image-models',
    provider: 'gmicloud-image',
    model: 'reve-remix-20250915',
    cost: 0.03,
    inputs: [promptIn(), imageIn('image', 'Reference')],
    outputs: [imageOut()],
    params: [RESOLUTION, STRENGTH, ...GEN_TAIL],
    description: 'Re-composes a reference image under a new prompt.',
  },
  {
    type: 'seededit-i2i',
    title: 'Edit Scene',
    category: 'image-models',
    provider: 'gmicloud-image',
    model: 'seededit-3-0-i2i-250628',
    cost: 0.02,
    inputs: [promptIn(), imageIn('image', 'Image')],
    outputs: [imageOut()],
    params: [RESOLUTION, STRENGTH, ...GEN_TAIL],
    description: 'Image-to-image editing driven by an instruction.',
  },

  // ======================================================================= edit
  {
    type: 'genfill',
    title: 'Extend Canvas',
    category: 'edit',
    provider: 'gmicloud-image',
    model: 'bria-genfill',
    cost: 0.02,
    // Mask is optional: connect a Format and the mask is derived from the
    // breakpoint geometry — the plate is seated at the focal point and
    // everything else is filled. Connect a mask instead for manual inpainting.
    inputs: [
      promptIn('Prompt', false),
      imageIn(),
      {id: 'format', name: 'Format', type: 'format', isRequired: false},
      maskIn(false),
    ],
    outputs: [imageOut()],
    params: [STRENGTH, ...GEN_TAIL],
    description:
      'Recomposes a plate onto a breakpoint. Connect a Format and the empty region is filled to match.',
  },
  {
    type: 'eraser',
    title: 'Remove Object',
    category: 'edit',
    provider: 'gmicloud-image',
    model: 'bria-eraser',
    cost: 0.02,
    inputs: [imageIn(), maskIn()],
    outputs: [imageOut()],
    params: [STRENGTH, NUMBER_OF_IMAGES],
    description: 'Removes whatever the mask covers and reconstructs the background.',
  },
  {
    type: 'relight',
    title: 'Relight',
    category: 'edit',
    provider: 'gmicloud-image',
    model: 'bria-fibo-relight',
    cost: 0.03,
    inputs: [promptIn('Lighting', true), imageIn()],
    outputs: [imageOut()],
    params: [RESOLUTION, ...GEN_TAIL],
    description: 'Re-lights a scene. Useful for matching a composited product to the plate.',
  },
  {
    type: 'composite',
    title: 'Place Product',
    category: 'edit',
    cost: 0,
    inputs: [
      imageIn('base', 'Plate'),
      imageIn('overlay', 'Product'),
      {id: 'format', name: 'Format', type: 'format', isRequired: false},
    ],
    outputs: [imageOut()],
    params: [
      {key: 'scale', label: 'Scale', kind: 'slider', min: 10, max: 200, step: 1, default: 100},
      {key: 'opacity', label: 'Opacity', kind: 'slider', min: 0, max: 100, step: 1, default: 100},
      {
        key: 'shadow',
        label: 'Contact shadow',
        kind: 'toggle',
        default: true,
      },
    ],
    description: 'Places the real product cutout onto the generated plate at the focal point. Runs locally.',
  },

  // ================================================================= text tools
  {
    type: 'prompt',
    title: 'Brief',
    category: 'text-tools',
    cost: 0,
    inputs: [],
    outputs: [textOut('Prompt')],
    params: [{key: 'value', label: 'Prompt', kind: 'text', default: '', multiline: true}],
    description: 'A free-text brief feeding downstream models.',
  },
  {
    type: 'prompt-enhancer',
    title: 'Art Direct',
    category: 'text-tools',
    provider: 'google-chat',
    model: 'gemini-2.5-pro',
    cost: 0.002,
    inputs: [promptIn(), styleIn(false)],
    outputs: [textOut()],
    params: [
      {
        key: 'intent',
        label: 'Intent',
        kind: 'select',
        options: ['Campaign hero', 'Product beauty', 'Abstract background', 'Lifestyle'],
        default: 'Campaign hero',
      },
    ],
    description: 'Expands a short brief into a full art-direction prompt, folding in the style kit.',
  },
  {
    type: 'style-describer',
    title: 'Read Style',
    category: 'text-tools',
    provider: 'google-chat',
    model: 'gemini-2.5-pro',
    cost: 0.002,
    inputs: [imageIn('image', 'Reference')],
    outputs: [textOut('Description')],
    params: [
      {
        key: 'instructions',
        label: 'Model instructions',
        kind: 'text',
        multiline: true,
        default:
          'Describe this image as an art-direction brief: palette, lighting, materials, camera, mood. Do not describe the subject.',
      },
    ],
    description: 'Reads a brand reference and writes the style description that locks it.',
  },

  // ==================================================================== helpers
  {
    type: 'import',
    title: 'From Library',
    category: 'helpers',
    cost: 0,
    inputs: [],
    outputs: [imageOut('Asset')],
    params: [{key: 'assetKey', label: 'Asset key', kind: 'text', default: ''}],
    description: 'Pull an existing asset out of the B2 brand library.',
  },
  {
    type: 'export',
    title: 'Publish',
    category: 'helpers',
    cost: 0,
    inputs: [imageIn('asset', 'Asset'), {id: 'format', name: 'Format', type: 'format', isRequired: false}],
    outputs: [],
    params: [
      {key: 'format', label: 'Format', kind: 'select', options: ['png', 'jpg', 'webp'], default: 'png'},
    ],
    description: 'Write the final asset and its provenance manifest to B2.',
  },
  {
    type: 'preview',
    title: 'Preview',
    category: 'helpers',
    cost: 0,
    inputs: [imageIn('asset', 'Asset'), {id: 'format', name: 'Format', type: 'format', isRequired: false}],
    outputs: [],
    params: [
      {key: 'showOverlay', label: 'Show safe area', kind: 'toggle', default: true},
    ],
    description: 'Inspect a result with the safe-area and focal-point overlay drawn on top.',
  },

  // =============================================================== coming soon
  {
    type: 'kling-i2v',
    title: 'Animate Plate',
    category: 'video-models',
    availability: 'coming-soon',
    provider: 'gmicloud-video',
    model: 'kling-image2video-v2.1-master',
    cost: 12,
    inputs: [promptIn(), imageIn('image', 'Start Frame')],
    outputs: [{id: 'result', name: 'Result', type: 'video'}],
    params: [{key: 'duration', label: 'Duration', kind: 'select', options: ['5s', '10s'], default: '5s'}],
    description: 'Animate a finished key visual. Held back on cost and validation time.',
  },
  {
    type: 'luma-ray',
    title: 'Animate Scene',
    category: 'video-models',
    availability: 'coming-soon',
    provider: 'luma',
    model: 'luma-ray-2',
    cost: 9,
    inputs: [promptIn(), imageIn('image', 'Start Frame', false)],
    outputs: [{id: 'result', name: 'Result', type: 'video'}],
    params: [{key: 'duration', label: 'Duration', kind: 'select', options: ['5s', '10s'], default: '5s'}],
    description: 'Image-to-video with a reference start frame.',
  },
  {
    type: 'seedance',
    title: 'Video from Text',
    category: 'video-models',
    availability: 'coming-soon',
    provider: 'gmicloud-video',
    model: 'seedance-2-0-260128',
    cost: 10,
    inputs: [promptIn()],
    outputs: [{id: 'result', name: 'Result', type: 'video'}],
    params: [
      {key: 'duration', label: 'Duration', kind: 'select', options: ['5s', '10s'], default: '5s'},
      {
        key: 'aspectRatio',
        label: 'Aspect Ratio',
        kind: 'select',
        options: ['16:9', '9:16', '1:1'],
        default: '16:9',
      },
    ],
    description: 'Text-to-video.',
  },
  {
    type: 'minimax-music',
    title: 'Music Bed',
    category: 'audio-models',
    availability: 'coming-soon',
    provider: 'gmicloud-audio',
    model: 'minimax-music-2.5',
    cost: 2,
    inputs: [promptIn()],
    outputs: [{id: 'result', name: 'Audio', type: 'audio'}],
    params: [],
    description: 'Campaign music beds.',
  },
  {
    type: 'elevenlabs-tts',
    title: 'Voiceover',
    category: 'audio-models',
    availability: 'coming-soon',
    provider: 'elevenlabs',
    model: 'eleven-tts',
    cost: 1,
    inputs: [promptIn('Script')],
    outputs: [{id: 'result', name: 'Audio', type: 'audio'}],
    params: [],
    description: 'Voiceover for animated cuts.',
  },
];

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  brand: 'Brand',
  'image-models': 'Image Models',
  edit: 'Edit',
  'text-tools': 'Text tools',
  'video-models': 'Video Models',
  'audio-models': 'Audio Models',
  helpers: 'Helpers',
};

const BY_TYPE = new Map(CATALOG.map(def => [def.type, def]));

export function getNodeDef(type: string): NodeDef | undefined {
  return BY_TYPE.get(type);
}

export function isLive(def: NodeDef): boolean {
  return (def.availability ?? 'live') === 'live';
}

export function catalogByCategory(category: NodeCategory): NodeDef[] {
  return CATALOG.filter(def => def.category === category);
}

/** Default params for a freshly placed node. */
export function defaultParams(def: NodeDef): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}
