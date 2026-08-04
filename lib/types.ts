/**
 * Domain types for the PEG canvas.
 *
 * These are shaped around the two integrations that come later, so that wiring
 * them up is a swap inside `lib/workflow-service.ts` rather than a refactor
 * across components:
 *
 *   - Genblaze orchestrates a run. A `PegNode` carries the `provider`/`model`
 *     pair and a flat `params` bag, which is what a Genblaze step needs.
 *   - Backblaze B2 stores every output. An `AssetRef` is a B2 object key plus
 *     enough metadata to serve it, and `Provenance` is the lineage record for
 *     one produced asset — the graph edges are the provenance graph.
 */

/**
 * Media type carried along an edge. Drives port colors and connection validity.
 *
 * `style` and `format` are not media — they are brand constraints that condition
 * generation (a locked look, and a breakpoint's geometry).
 */
export type PortType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'mask'
  | 'style'
  | 'format';

export type NodeStatus = 'idle' | 'queued' | 'running' | 'complete' | 'error';

/**
 * Whether a node can actually execute.
 *
 * `coming-soon` nodes stay visible in the palette to show the roadmap, but
 * cannot be added to a graph. Everything marked `live` maps to a verified
 * Genblaze model or a local operation we can implement.
 */
export type NodeAvailability = 'live' | 'coming-soon';

/** Palette grouping, mirroring the tool categories in the left panel. */
export type NodeCategory =
  | 'brand'
  | 'image-models'
  | 'edit'
  | 'text-tools'
  | 'video-models'
  | 'audio-models'
  | 'helpers';

export interface Port {
  id: string;
  /** Label shown on the edge, e.g. "Prompt", "Result". */
  name: string;
  type: PortType;
  /** Inputs only: a connection is required before the node can run. */
  isRequired?: boolean;
}

export interface ParamSelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface ParamSelectSection {
  type: 'section';
  title: string;
  options: ParamSelectOption[];
}

/** A parameter exposed in the right-hand inspector. */
export type ParamSpec =
  | {
      key: string;
      label: string;
      kind: 'select';
      options: Array<string | ParamSelectOption | ParamSelectSection>;
      default: string;
      tooltip?: string;
    }
  | {key: string; label: string; kind: 'slider'; min: number; max: number; step: number; default: number; tooltip?: string}
  | {key: string; label: string; kind: 'number'; min?: number; max?: number; default: number; tooltip?: string}
  | {key: string; label: string; kind: 'toggle'; default: boolean; tooltip?: string}
  | {key: string; label: string; kind: 'text'; default: string; multiline?: boolean; tooltip?: string}
  | {
      key: string;
      label: string;
      kind: 'brand-asset';
      default: string;
      assetKinds?: Array<'logo' | 'screenshot' | 'product' | 'other'>;
      isOptional?: boolean;
      tooltip?: string;
    }
  /**
   * An image the user drops onto a node, held as base64.
   *
   * Deliberately not a B2 upload: this is a campaign reference — the Pinterest
   * pin you want recreated in your own brand — not a durable brand asset. It
   * lives as long as the graph does and goes straight to the model as
   * `image_b64`. Brand assets are the ones worth a bucket key.
   */
  | {key: string; label: string; kind: 'image'; default: string; tooltip?: string};

/**
 * A catalog entry: the definition of a node type, independent of any instance
 * placed on the canvas. Maps 1:1 onto a Genblaze provider+model step.
 */
export interface NodeDef {
  type: string;
  title: string;
  category: NodeCategory;
  /** Whether this node can execute today. Defaults to 'live'. */
  availability?: NodeAvailability;
  /**
   * Genblaze connector, e.g. 'gmicloud-image'. Omitted for local operations
   * that run in the browser rather than through a provider.
   */
  provider?: string;
  /**
   * Provider-side model identifier, verified against Genblaze's model matrix.
   * These strings are passed straight through to `Step(model=...)`.
   */
  model?: string;
  /** Credit cost per run, shown in the inspector and the run footer. */
  cost: number;
  inputs: Port[];
  outputs: Port[];
  params: ParamSpec[];
  /** Short description surfaced in search results and hover cards. */
  description?: string;
}

/** An object stored in Backblaze B2. */
export interface AssetRef {
  /** B2 object key, e.g. `runs/<runId>/<nodeId>/output.png`. */
  assetKey: string;
  bucket: string;
  contentType: string;
  bytes?: number;
  /** Served URL. Local placeholder today; a B2 (or CDN-fronted) URL later. */
  url: string;
  width?: number;
  height?: number;
}

/** Lineage record for one produced asset, written alongside it in B2. */
export interface Provenance {
  runId: string;
  nodeId: string;
  producedBy: {provider: string; model: string};
  /** Asset keys of the upstream inputs that fed this node. */
  inputAssetKeys: string[];
  params: Record<string, ParamValue>;
  createdAt: string;
  /** B2 key of the signed manifest. */
  manifestKey?: string;
  /**
   * Result of Genblaze's own `manifest.verify()`. `undefined` means the check
   * could not be performed — never render that as verified.
   */
  verified?: boolean;
}

export type ParamValue = string | number | boolean;

/** An instance of a node placed on the canvas. */
export interface PegNode {
  id: string;
  type: string;
  title: string;
  category: NodeCategory;
  provider?: string;
  model?: string;
  cost: number;
  x: number;
  y: number;
  width: number;
  /** Locked nodes can be selected and edited, but not moved on the canvas. */
  isLocked?: boolean;
  status: NodeStatus;
  params: Record<string, ParamValue>;
  inputs: Port[];
  outputs: Port[];
  /** Free text for prompt-style nodes, rendered in the node body. */
  text?: string;
  result?: AssetRef;
  provenance?: Provenance;
  /** Failure reason from the last run, surfaced on the node and the inspector. */
  error?: string;
  /**
   * Non-fatal notes from the last successful run. Kept separate from `error`
   * so a run that produced a real asset never reads as a failure.
   */
  warnings?: string[];
}

export interface Edge {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
  type: PortType;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: PegNode[];
  edges: Edge[];
  updatedAt: string;
  /** Gallery thumbnail; a B2-served render of the canvas later. */
  thumbnailUrl?: string;
  nodeCount: number;
}
