/**
 * Breakpoint presets for the Format node.
 *
 * These are the dimensions PEG actually composes for. No GMI image model
 * honours size parameters, so the target is reached by outpainting onto a
 * canvas of exactly these dimensions rather than by asking for them.
 */

import type {RunFormat} from './workflow-service';

export interface FormatPreset {
  label: string;
  width: number;
  height: number;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  {label: 'Desktop hero', width: 1920, height: 600},
  {label: 'Laptop hero', width: 1440, height: 520},
  {label: 'Tablet', width: 1024, height: 600},
  {label: 'Mobile hero', width: 828, height: 1104},
  {label: 'Square social', width: 1080, height: 1080},
  {label: 'Story', width: 1080, height: 1920},
];

const BY_LABEL = new Map(FORMAT_PRESETS.map(p => [p.label, p]));

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
  const preset = BY_LABEL.get(String(params.preset)) ?? FORMAT_PRESETS[0];
  return {
    width: preset.width,
    height: preset.height,
    focal_point: FOCAL[String(params.focalPoint)] ?? 'right',
    safe_area: SAFE_AREA[String(params.safeArea)] ?? 'left-third',
  };
}

export function presetLabels(): string[] {
  return FORMAT_PRESETS.map(p => p.label);
}

export function describeFormat(params: Record<string, string | number | boolean>): string {
  const f = toRunFormat(params);
  return `${f.width}×${f.height}`;
}
