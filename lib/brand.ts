/**
 * The brand kit, client side.
 *
 * Mirrors `service/brand.py`. Two shapes matter and must not be collapsed:
 * Style references teach the look. Logos stay in the composite lane as the
 * approved originals, while capable models may also receive a rasterized copy
 * as separately labelled identity artwork.
 */

/** What a composited asset is. Decides how it gets placed, never whether it is generated. */
export type CompositeKind = 'logo' | 'screenshot' | 'product' | 'other';
export type AssetKind = 'style' | CompositeKind;

export const COMPOSITE_KINDS: {value: CompositeKind; label: string; hint: string}[] = [
  {value: 'logo', label: 'Logo', hint: 'Wordmark or symbol, composited onto a plate'},
  {value: 'screenshot', label: 'App screenshot', hint: 'A screen from your product'},
  {value: 'product', label: 'Product cutout', hint: 'The hero object, on transparency'},
  {value: 'other', label: 'Other', hint: 'Anything else to composite'},
];

/**
 * Typeface classifications, not typeface names.
 *
 * No image model renders a named font, so what is worth capturing is the shape
 * of the type — which is also what a marketing team can answer without going to
 * look up the licence.
 */
export const TYPE_CLASSES = [
  {value: 'sans-serif', label: 'Sans-serif'},
  {value: 'serif', label: 'Serif'},
  {value: 'slab-serif', label: 'Slab serif'},
  {value: 'monospace', label: 'Monospace'},
  {value: 'display', label: 'Display'},
  {value: 'script', label: 'Script'},
];

export interface BrandAsset {
  asset_key: string;
  filename: string;
  content_type: string;
  bytes: number;
  url: string;
  /** Colours this reference contributed. Empty for composites. */
  palette: string[];
  kind: AssetKind;
}

/** The server's cap, mirrored so oversized files are rejected before upload. */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export interface Typography {
  heading: string;
  body: string;
  notes: string;
}

export interface Brand {
  name: string;
  /**
   * The look, in words. No longer collected by the form — the brief is written
   * on the canvas — but still honoured by the server's prompt prefix when a
   * stored value exists.
   */
  description: string;
  palette: string[];
  style_references: BrandAsset[];
  composites: BrandAsset[];
  typography: Typography;
  updated_at: string;
  /** True once there is artwork to lock generation against. */
  is_complete: boolean;
}

export function emptyBrand(): Brand {
  return {
    name: '',
    description: '',
    palette: [],
    style_references: [],
    composites: [],
    typography: {heading: '', body: '', notes: ''},
    updated_at: '',
    is_complete: false,
  };
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {error?: string} | null;
  return body?.error ?? `request failed (${response.status})`;
}

export async function fetchBrand(): Promise<Brand> {
  const response = await fetch('/api/brand', {cache: 'no-store'});
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

/**
 * Persist the text fields.
 *
 * Assets and the palette derived from them are owned by the asset endpoints, so
 * they are deliberately not sent: a save that carried a stale client copy of the
 * lists would undo an upload that landed while the form sat open.
 */
export async function saveBrand(brand: Brand): Promise<Brand> {
  const response = await fetch('/api/brand', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      name: brand.name,
      typography: brand.typography,
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

/** Relabel a composite. Returns the updated brand. */
export async function setAssetKind(assetKey: string, kind: CompositeKind): Promise<Brand> {
  const response = await fetch('/api/brand/assets', {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({asset_key: assetKey, kind}),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

/** Delete one asset from the brand and the bucket. Returns the updated brand. */
export async function removeBrandAsset(assetKey: string): Promise<Brand> {
  const response = await fetch(`/api/brand/assets?asset_key=${encodeURIComponent(assetKey)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result);
      // Strip the `data:<mime>;base64,` prefix — the service wants raw base64.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export interface UploadResult {
  asset: BrandAsset;
  /** What this file contributed. */
  extracted_palette: string[];
  /** The whole brand palette after merging it in. */
  brand_palette: string[];
}

/**
 * A first guess at what a composited file is, from its name.
 *
 * Wrong sometimes, which is why every tile carries an editable kind — but it
 * means a marketing team dropping `acme-logo.svg` and `dashboard-screen.png`
 * usually has nothing left to correct.
 */
export function guessKind(filename: string): CompositeKind {
  const name = filename.toLowerCase();
  if (/logo|wordmark|lockup|\bmark\b|icon/.test(name)) return 'logo';
  if (/screen|capture|ui|app|dashboard/.test(name)) return 'screenshot';
  if (/product|pack|bottle|device|render|cutout/.test(name)) return 'product';
  return 'logo';
}

export async function uploadBrandAsset(file: File, kind: AssetKind): Promise<UploadResult> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      }MB`,
    );
  }
  const response = await fetch('/api/brand/assets', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      filename: file.name,
      content_type: file.type || 'image/png',
      data_b64: await toBase64(file),
      kind,
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}
