/**
 * Deterministic placeholder imagery for generated-media results.
 *
 * Renders a layered gradient mesh as an inline SVG data URI so the canvas has
 * believable output thumbnails with zero network requests. Swap this for real
 * B2-served asset URLs once generation is wired up — every call site already
 * goes through `AssetRef.url`.
 */

/** Small deterministic PRNG so a given seed always yields the same image. */
function makeRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, ch => {
    switch (ch) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });
}

type Palette = {hues: number[]; sat: number; light: number};

/** Palettes loosely echoing the look of different model families. */
const PALETTES: Record<string, Palette> = {
  forest: {hues: [95, 140, 165, 60], sat: 55, light: 42},
  ember: {hues: [18, 35, 5, 45], sat: 68, light: 46},
  dusk: {hues: [250, 280, 215, 320], sat: 52, light: 44},
  ice: {hues: [190, 210, 175, 230], sat: 48, light: 52},
  mono: {hues: [220, 215, 225, 210], sat: 8, light: 40},
  bloom: {hues: [330, 350, 300, 20], sat: 60, light: 50},
};

export const PALETTE_NAMES = Object.keys(PALETTES);

export interface PlaceholderOptions {
  seed: string;
  palette?: keyof typeof PALETTES | string;
  width?: number;
  height?: number;
  /** Optional caption burned into the image, as PEG's sample outputs have. */
  caption?: string;
}

export function placeholderImage({
  seed,
  palette = 'dusk',
  width = 512,
  height = 512,
  caption,
}: PlaceholderOptions): string {
  const rand = makeRandom(seed);
  const pal = PALETTES[palette] ?? PALETTES.dusk;

  const blobs = Array.from({length: 5}, (_, i) => {
    const hue = pal.hues[i % pal.hues.length] + Math.round(rand() * 24 - 12);
    const light = pal.light + Math.round(rand() * 22 - 8);
    const cx = Math.round(rand() * 100);
    const cy = Math.round(rand() * 100);
    const r = Math.round(38 + rand() * 44);
    return {id: `g${i}`, hue, light, cx, cy, r, sat: pal.sat};
  });

  const defs = blobs
    .map(
      b =>
        `<radialGradient id="${b.id}" cx="${b.cx}%" cy="${b.cy}%" r="${b.r}%">` +
        `<stop offset="0%" stop-color="hsl(${b.hue} ${b.sat}% ${b.light}%)" stop-opacity="0.95"/>` +
        `<stop offset="100%" stop-color="hsl(${b.hue} ${b.sat}% ${b.light}%)" stop-opacity="0"/>` +
        `</radialGradient>`,
    )
    .join('');

  const rects = blobs.map(b => `<rect width="${width}" height="${height}" fill="url(#${b.id})"/>`).join('');

  const baseHue = pal.hues[0];
  const text = caption
    ? `<text x="50%" y="52%" text-anchor="middle" font-family="Georgia, serif" font-size="${Math.round(
        width / 11,
      )}" font-weight="700" fill="#fff" fill-opacity="0.94" style="paint-order:stroke" stroke="#000" stroke-opacity="0.28" stroke-width="${Math.round(
        width / 120,
      )}">${escapeXml(caption)}</text>`
    : '';

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${defs}` +
    `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="${
      Math.round(rand() * 1000)
    }"/><feColorMatrix type="saturate" values="0"/></filter>` +
    `</defs>` +
    `<rect width="${width}" height="${height}" fill="hsl(${baseHue} ${pal.sat}% ${Math.max(
      8,
      pal.light - 30,
    )}%)"/>` +
    rects +
    `<rect width="${width}" height="${height}" filter="url(#grain)" opacity="0.16"/>` +
    text +
    `</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
