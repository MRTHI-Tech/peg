'use client';

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {AppShell} from '@astryxdesign/core/AppShell';
import {Layout, LayoutPanel} from '@astryxdesign/core/Layout';
import {HStack} from '@astryxdesign/core/Stack';

import {NodeCanvas} from '@/components/canvas/NodeCanvas';
import {estimateNodeHeight} from '@/components/canvas/node-metrics';
import {defaultParams, getNodeDef} from '@/lib/catalog';
import {fitViewport, graphBounds, type Viewport} from '@/lib/canvas-geometry';
import {toRunFormat} from '@/lib/formats';
import {useMediaQuery} from '@/lib/use-media-query';
import {executeRun, toAssetRef, toProvenance} from '@/lib/workflow-service';
import type {Edge, NodeCategory, ParamValue, PegNode, Workflow} from '@/lib/types';

import {EditorTopBar} from './EditorTopBar';
import {IconRail, type RailSection} from './IconRail';
import {PalettePanel} from './PalettePanel';
import {InspectorPanel} from './InspectorPanel';
import {ZoomToolbar} from './ZoomToolbar';

/**
 * Canvas editor frame.
 *
 * Responsive contract:
 *   > 1100px  rail 52 | palette 232 | canvas | inspector 292
 *   <= 1100px palette auto-closes so the canvas keeps a usable width; the rail
 *             icons reopen it on demand
 *   <= 820px  inspector hides unless something is selected
 *
 * All graph state lives here so the inspector and the canvas stay in sync from a
 * single source. Persistence and run execution go through lib/workflow-service.
 */
export function CanvasEditor({workflow}: {workflow: Workflow}) {
  const [name, setName] = useState(workflow.name);
  const [nodes, setNodes] = useState<PegNode[]>(workflow.nodes);
  const [edges, setEdges] = useState<Edge[]>(workflow.edges);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [viewport, setViewport] = useState<Viewport>({x: 0, y: 0, zoom: 0.75});
  const [railSection, setRailSection] = useState<RailSection>('image-models');
  const [isPaletteOpen, setIsPaletteOpen] = useState(true);

  const isNarrow = useMediaQuery('(max-width: 1100px)');
  const isVeryNarrow = useMediaQuery('(max-width: 820px)');

  const canvasHostRef = useRef<HTMLDivElement>(null);
  /** Set once the user pans/zooms, so auto-fit stops fighting them. */
  const hasUserAdjustedRef = useRef(false);

  // Reclaim canvas width when the window gets narrow. The rail can reopen it.
  useEffect(() => {
    if (isNarrow) setIsPaletteOpen(false);
  }, [isNarrow]);

  const selectedNodes = useMemo(
    () => nodes.filter(n => selectedIds.includes(n.id)),
    [nodes, selectedIds],
  );

  // ------------------------------------------------------------ fit to view
  const fitToView = useCallback(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const bounds = graphBounds(nodes, estimateNodeHeight);
    if (!bounds) return;
    const {width, height} = host.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    setViewport(fitViewport(bounds, width, height));
  }, [nodes]);

  /** Explicit fit (toolbar button / "F") always wins and re-arms auto-fit. */
  const fitToViewManual = useCallback(() => {
    hasUserAdjustedRef.current = false;
    fitToView();
  }, [fitToView]);

  /** Pan/zoom coming from the user, as opposed to a programmatic fit. */
  const handleViewportChange = useCallback((vp: Viewport) => {
    hasUserAdjustedRef.current = true;
    setViewport(vp);
  }, []);

  // Fit once, as soon as the canvas has a real size.
  //
  // Driven by ResizeObserver rather than a mount effect because the panels
  // settle their widths after first paint, and fitting against a zero-width
  // canvas clamps to the minimum zoom. It stops after the first success so that
  // later layout changes — opening the palette, showing the inspector — don't
  // yank the user's viewport around.
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      if (hasUserAdjustedRef.current) return;
      const {width, height} = host.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      fitToView();
      hasUserAdjustedRef.current = true;
      observer.disconnect();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [fitToView]);

  // ------------------------------------------------------------ graph edits
  const moveNode = useCallback((id: string, x: number, y: number) => {
    setNodes(prev => prev.map(n => (n.id === id ? {...n, x, y} : n)));
  }, []);

  const connect = useCallback((edge: Omit<Edge, 'id'>) => {
    setEdges(prev => [...prev, {...edge, id: `e-${crypto.randomUUID().slice(0, 8)}`}]);
  }, []);

  const deleteEdge = useCallback((id: string) => {
    setEdges(prev => prev.filter(e => e.id !== id));
  }, []);

  const updateParam = useCallback((nodeId: string, key: string, value: ParamValue) => {
    setNodes(prev => prev.map(n => (n.id === nodeId ? {...n, params: {...n.params, [key]: value}} : n)));
  }, []);

  const addNode = useCallback(
    (type: string) => {
      const def = getNodeDef(type);
      const host = canvasHostRef.current;
      if (!def || !host) return;
      const {width, height} = host.getBoundingClientRect();
      // Drop the new node at the center of the current view.
      const x = (width / 2 - viewport.x) / viewport.zoom - 120;
      const y = (height / 2 - viewport.y) / viewport.zoom - 60;
      const id = `n-${crypto.randomUUID().slice(0, 8)}`;
      const node: PegNode = {
        id,
        type: def.type,
        title: def.title,
        category: def.category,
        provider: def.provider,
        model: def.model,
        cost: def.cost,
        x,
        y,
        width: 240,
        status: 'idle',
        params: defaultParams(def),
        inputs: def.inputs,
        outputs: def.outputs,
        text: def.type === 'prompt' ? '' : undefined,
      };
      setNodes(prev => [...prev, node]);
      setSelectedIds([id]);
    },
    [viewport],
  );

  const deleteSelection = useCallback(() => {
    if (selectedIds.length === 0) return;
    setNodes(prev => prev.filter(n => !selectedIds.includes(n.id)));
    setEdges(prev => prev.filter(e => !selectedIds.includes(e.fromNode) && !selectedIds.includes(e.toNode)));
    setSelectedIds([]);
  }, [selectedIds]);

  // --------------------------------------------------------------- running
  /**
   * Resolve a node's inputs from the graph.
   *
   * The prompt comes from whatever text node feeds its prompt port; the target
   * geometry from whatever Format node feeds its format port. A node with an
   * upstream image input becomes an outpaint rather than a fresh generation,
   * which is how a plate gets recomposed to a breakpoint.
   */
  const resolveInputs = useCallback(
    (node: PegNode) => {
      const sourceOf = (target: PegNode, portId: string) => {
        const edge = edges.find(e => e.toNode === target.id && e.toPort === portId);
        return edge ? nodes.find(n => n.id === edge.fromNode) : undefined;
      };

      /**
       * Walk upstream for prompt text.
       *
       * The chain is usually Brief → Art Direct → Brand Scene, and Art Direct is
       * itself a model node. Looking only one hop finds an unrun Art Direct with
       * no text and submits an empty prompt, which the API rejects. So keep
       * walking until actual text turns up.
       */
      const resolvePrompt = (start: PegNode, seen = new Set<string>()): string => {
        if (seen.has(start.id)) return ''; // cycles are possible; the graph is user-built
        seen.add(start.id);

        const own = (start.text ?? String(start.params.value ?? '')).trim();
        if (own) return own;

        const upstream = sourceOf(start, 'prompt');
        return upstream ? resolvePrompt(upstream, seen) : '';
      };

      const formatNode = sourceOf(node, 'format');
      const imageNode =
        sourceOf(node, 'image') ?? sourceOf(node, 'base') ?? sourceOf(node, 'asset');

      const upstreamPrompt = sourceOf(node, 'prompt');
      return {
        prompt: upstreamPrompt ? resolvePrompt(upstreamPrompt) : resolvePrompt(node),
        format: formatNode ? toRunFormat(formatNode.params) : undefined,
        sourceAssetKey: imageNode?.result?.assetKey,
      };
    },
    [edges, nodes],
  );

  const patchNode = useCallback((id: string, patch: Partial<PegNode>) => {
    setNodes(prev => prev.map(n => (n.id === id ? {...n, ...patch} : n)));
  }, []);

  const runNode = useCallback(
    async (node: PegNode) => {
      if (!node.model) return;
      const {prompt, format, sourceAssetKey} = resolveInputs(node);

      // Outpaint when there is an upstream plate and a target to hit.
      const isOutpaint = Boolean(sourceAssetKey && format);

      // Fail here rather than spending a call the API will reject anyway.
      if (!prompt && !isOutpaint) {
        patchNode(node.id, {
          status: 'error',
          error: 'No prompt. Connect a Brief node, or type one into this node.',
        });
        return;
      }

      patchNode(node.id, {status: 'queued', error: undefined});

      try {
        const result = await executeRun(
          {
            operation: isOutpaint ? 'outpaint' : 'generate',
            node_id: node.id,
            model: node.model,
            prompt,
            negative_prompt: String(node.params.negativePrompt ?? '') || undefined,
            params: {seed: Number(node.params.seed ?? 0)},
            source_asset_key: isOutpaint ? sourceAssetKey : undefined,
            format: isOutpaint ? format : undefined,
          },
          {
            onProgress: r =>
              patchNode(node.id, {status: r.status === 'queued' ? 'queued' : 'running'}),
          },
        );

        patchNode(node.id, {
          status: 'complete',
          result: toAssetRef(result),
          provenance: toProvenance(result, node.id),
          error: undefined,
        });
      } catch (error) {
        patchNode(node.id, {status: 'error', error: (error as Error).message});
      }
    },
    [patchNode, resolveInputs],
  );

  const runSelected = useCallback(() => {
    // Sequential: GMI is flaky under load and the service caps concurrency anyway.
    void selectedNodes.filter(n => n.model).reduce(
      (chain, node) => chain.then(() => runNode(node)),
      Promise.resolve(),
    );
  }, [runNode, selectedNodes]);

  const isRunning = nodes.some(n => n.status === 'queued' || n.status === 'running');

  // ------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't hijack keys while the user is typing in a field.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;

      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === 'Escape') {
        setSelectedIds([]);
      } else if (e.key === 'f' || e.key === 'F') {
        fitToViewManual();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelection, fitToViewManual]);

  const totalCost = selectedNodes.reduce((sum, n) => sum + n.cost, 0);

  return (
    <AppShell
      contentPadding={0}
      variant="section"
      mobileNav={false}
      topNav={<EditorTopBar name={name} onNameChange={setName} nodeCount={nodes.length} />}>
      <Layout
        start={
          <HStack gap={0} style={{blockSize: '100%'}}>
            <IconRail
              active={railSection}
              onSelect={section => {
                setRailSection(section);
                setIsPaletteOpen(true);
              }}
              isPaletteOpen={isPaletteOpen}
              onTogglePalette={() => setIsPaletteOpen(open => !open)}
            />
            {isPaletteOpen && (
              <PalettePanel
                section={railSection}
                onAddNode={addNode}
                onCategoryChange={category => setRailSection(category as RailSection)}
              />
            )}
          </HStack>
        }
        end={
          isVeryNarrow && selectedNodes.length === 0 ? undefined : (
            <InspectorPanel
              nodes={selectedNodes}
              totalCost={totalCost}
              isRunning={isRunning}
              onRun={runSelected}
              onParamChange={updateParam}
              onDelete={deleteSelection}
            />
          )
        }>
        <div ref={canvasHostRef} style={{position: 'relative', blockSize: '100%', inlineSize: '100%'}}>
          <NodeCanvas
            nodes={nodes}
            edges={edges}
            selectedIds={selectedIds}
            viewport={viewport}
            onViewportChange={handleViewportChange}
            onSelectionChange={setSelectedIds}
            onNodeMove={moveNode}
            onConnect={connect}
            onEdgeDelete={deleteEdge}
            onRunNode={runNode}
          />
          <ZoomToolbar
            viewport={viewport}
            onViewportChange={handleViewportChange}
            onFit={fitToViewManual}
          />
        </div>
      </Layout>
    </AppShell>
  );
}

export type {NodeCategory};
