/**
 * The brand kit, client side.
 *
 * Mirrors `service/brand.py`. Two shapes matter and must not be collapsed:
 * style references condition generation, logos are only ever composited on top.
 */

export interface BrandAsset {
  asset_key: string;
  filename: string;
  content_type: string;
  bytes: number;
  url: string;
}

export interface Typography {
  heading: string;
  body: string;
  notes: string;
}

export interface Brand {
  name: string;
  description: string;
  palette: string[];
  style_references: BrandAsset[];
  logos: BrandAsset[];
  typography: Typography;
  updated_at: string;
  /** True once there is both a stated look and something to look at. */
  is_complete: boolean;
}

export function emptyBrand(): Brand {
  return {
    name: '',
    description: '',
    palette: [],
    style_references: [],
    logos: [],
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

/** Persist everything except assets, which are added through uploadBrandAsset. */
export async function saveBrand(brand: Brand): Promise<Brand> {
  const response = await fetch('/api/brand', {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      name: brand.name,
      description: brand.description,
      palette: brand.palette,
      // Strip presigned URLs: they expire, and the service re-signs on read.
      style_references: brand.style_references.map(({url: _url, ...rest}) => rest),
      logos: brand.logos.map(({url: _url, ...rest}) => rest),
      typography: brand.typography,
    }),
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
  extracted_palette: string[];
}

export async function uploadBrandAsset(file: File, isLogo: boolean): Promise<UploadResult> {
  const response = await fetch('/api/brand/assets', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      filename: file.name,
      content_type: file.type || 'image/png',
      data_b64: await toBase64(file),
      is_logo: isLogo,
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}
