/**
 * Breakpoint presets for the Format node.
 *
 * These are the dimensions PEG actually composes for. No GMI image model
 * honours size parameters, so the target is reached by outpainting onto a
 * canvas of exactly these dimensions rather than by asking for them.
 */

import type {ParamSelectSection} from './types';
import type {RunFormat} from './workflow-service';

export interface FormatPreset {
  value: string;
  label: string;
  description: string;
  width: number;
  height: number;
}

const EXACT_SIZE_PRESETS: FormatPreset[] = [
  {value: '1024x1024', label: '1024 × 1024', description: 'Square', width: 1024, height: 1024},
  {value: '1536x640', label: '1536 × 640', description: 'Wide', width: 1536, height: 640},
  {value: '1920x600', label: '1920 × 600', description: 'Extra wide', width: 1920, height: 600},
  {value: '1280x720', label: '1280 × 720', description: 'Landscape', width: 1280, height: 720},
  {value: '1080x1350', label: '1080 × 1350', description: 'Portrait', width: 1080, height: 1350},
  {value: '1080x1920', label: '1080 × 1920', description: 'Vertical', width: 1080, height: 1920},
];

const POPULAR_FORMAT_PRESETS: FormatPreset[] = [
  {
    value: 'instagram-post',
    label: 'Instagram post',
    description: '1080 × 1080',
    width: 1080,
    height: 1080,
  },
  {
    value: 'instagram-portrait',
    label: 'Instagram portrait post',
    description: '1080 × 1350',
    width: 1080,
    height: 1350,
  },
  {
    value: 'instagram-story',
    label: 'Instagram story or reel',
    description: '1080 × 1920',
    width: 1080,
    height: 1920,
  },
  {
    value: 'twitter-post',
    label: 'X (Twitter) post',
    description: '1600 × 900',
    width: 1600,
    height: 900,
  },
  {
    value: 'twitter-header',
    label: 'X (Twitter) header',
    description: '1500 × 500',
    width: 1500,
    height: 500,
  },
  {
    value: 'linkedin-banner',
    label: 'LinkedIn banner',
    description: '1584 × 396',
    width: 1584,
    height: 396,
  },
  {
    value: 'youtube-thumbnail',
    label: 'YouTube thumbnail',
    description: '3840 × 2160',
    width: 3840,
    height: 2160,
  },
];

const APP_STORE_PRESETS: FormatPreset[] = [
  {
    value: 'app-store-iphone-6-9',
    label: 'iPhone 6.9″',
    description: '1320 × 2868 portrait',
    width: 1320,
    height: 2868,
  },
  {
    value: 'app-store-iphone-6-5',
    label: 'iPhone 6.5″',
    description: '1284 × 2778 portrait',
    width: 1284,
    height: 2778,
  },
  {
    value: 'app-store-iphone-6-1',
    label: 'iPhone 6.1″',
    description: '1170 × 2532 portrait',
    width: 1170,
    height: 2532,
  },
  {
    value: 'app-store-ipad-13',
    label: 'iPad 13″',
    description: '2064 × 2752 portrait',
    width: 2064,
    height: 2752,
  },
];

export const FORMAT_PRESETS: FormatPreset[] = [
  ...EXACT_SIZE_PRESETS,
  ...POPULAR_FORMAT_PRESETS,
  ...APP_STORE_PRESETS,
];

/** Shared by output-size fields so the same destinations resolve identically everywhere. */
export const FORMAT_SELECTOR_OPTIONS: ParamSelectSection[] = [
  {
    type: 'section',
    title: 'Exact sizes',
    options: EXACT_SIZE_PRESETS.map(({value, label, description}) => ({value, label, description})),
  },
  {
    type: 'section',
    title: 'Popular formats',
    options: POPULAR_FORMAT_PRESETS.map(({value, label, description}) => ({
      value,
      label,
      description,
    })),
  },
  {
    type: 'section',
    title: 'App Store',
    options: APP_STORE_PRESETS.map(({value, label, description}) => ({
      value,
      label,
      description,
    })),
  },
];

const BY_VALUE = new Map(FORMAT_PRESETS.map(p => [p.value, p]));

// Older demo graphs stored these labels as values. Keep them readable without
// making obsolete names compete with the clearer grouped choices in the UI.
const LEGACY_PRESETS = new Map<string, Pick<FormatPreset, 'width' | 'height'>>([
  ['Desktop hero', {width: 1920, height: 600}],
  ['Laptop hero', {width: 1440, height: 520}],
  ['Tablet', {width: 1024, height: 600}],
  ['Mobile hero', {width: 828, height: 1104}],
  ['Square social', {width: 1080, height: 1080}],
  ['Story', {width: 1080, height: 1920}],
]);

const FOCAL: Record<string, RunFormat['focal_point']> = {
  Left: 'left',
  Center: 'center',
  Right: 'right',
};

const SAFE_AREA: Record<string, RunFormat['safe_area']> = {
  'Left third': 'left-third',
  'Right third': 'right-third',
  'Upper third': 'upper-third',
  'Lower third': 'lower-third',
  Center: 'center',
};

/** Turn a Format node's params into the geometry the service expects. */
export function toRunFormat(params: Record<string, string | number | boolean>): RunFormat {
  const storedValue = String(params.preset ?? params.resolution ?? '');
  const preset = BY_VALUE.get(storedValue) ?? LEGACY_PRESETS.get(storedValue) ?? FORMAT_PRESETS[0];
  return {
    width: preset.width,
    height: preset.height,
    focal_point: FOCAL[String(params.focalPoint)] ?? 'right',
    safe_area: SAFE_AREA[String(params.safeArea)] ?? 'left-third',
  };
}

/**
 * What Extend Canvas targets when nothing else says otherwise.
 *
 * Matches the Format node's own default so a graph built either way lands on
 * the same canvas, and so a node saved before the size moved onto it does not
 * silently resolve to a square.
 */
export const DEFAULT_OUTPAINT_PRESET = '1920x600';

/**
 * Resolve an Extend Canvas node's own target canvas.
 *
 * The size lives on the node so a plate can be extended without wiring up a
 * Format. A connected Format node still wins; this is the fallback.
 */
export function toOutpaintFormat(params: Record<string, string | number | boolean>): RunFormat {
  return toRunFormat({
    ...params,
    preset: String(params.outputSize ?? '') || DEFAULT_OUTPAINT_PRESET,
  });
}

export function presetLabels(): string[] {
  return FORMAT_PRESETS.map(p => p.label);
}

export function describeFormat(params: Record<string, string | number | boolean>): string {
  const f = toRunFormat(params);
  return `${f.width}×${f.height}`;
}
