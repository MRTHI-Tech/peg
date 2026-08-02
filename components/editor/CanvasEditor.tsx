'use client';

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {AppShell} from '@astryxdesign/core/AppShell';
import {Layout, LayoutPanel} from '@astryxdesign/core/Layout';
import {HStack} from '@astryxdesign/core/Stack';
import {EmptyState} from '@astryxdesign/core/EmptyState';

import {NodeCanvas} from '@/components/canvas/NodeCanvas';
import {estimateNodeHeight} from '@/components/canvas/node-metrics';
import {defaultParams, getNodeDef} from '@/lib/catalog';
import {fitViewport, graphBounds, type Viewport} from '@/lib/canvas-geometry';
import {toRunFormat} from '@/lib/formats';
import {executeInDependencyOrder, isExecutableNode} from '@/lib/graph-execution';
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

  // Mirrors of graph state for the run engine. A chained run needs values
  // written by earlier steps of the same chain, which a render-time closure
  // cannot see.
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);

  /** Commit to React and the run engine's synchronous snapshot together. */
  const updateNodes = useCallback((updater: (current: PegNode[]) => PegNode[]) => {
    const next = updater(nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
  }, []);

  const updateEdges = useCallback((updater: (current: Edge[]) => Edge[]) => {
    const next = updater(edgesRef.current);
    edgesRef.current = next;
    setEdges(next);
  }, []);

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
    updateNodes(current => current.map(n => (n.id === id ? {...n, x, y} : n)));
  }, [updateNodes]);

  const connect = useCallback((edge: Omit<Edge, 'id'>) => {
    updateEdges(current => [...current, {...edge, id: `e-${crypto.randomUUID().slice(0, 8)}`}]);
  }, [updateEdges]);

  const deleteEdge = useCallback((id: string) => {
    updateEdges(current => current.filter(e => e.id !== id));
  }, [updateEdges]);

  const updateParam = useCallback((nodeId: string, key: string, value: ParamValue) => {
    updateNodes(current =>
      current.map(n =>
        n.id === nodeId
          ? {
              ...n,
              params: {...n.params, [key]: value},
              // Brief cards and their inspector field are two views of one value.
              text: n.type === 'prompt' && key === 'value' ? String(value) : n.text,
            }
          : n,
      ),
    );
  }, [updateNodes]);

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
      updateNodes(current => [...current, node]);
      setSelectedIds([id]);
    },
    [updateNodes, viewport],
  );

  const deleteSelection = useCallback(() => {
    if (selectedIds.length === 0) return;
    updateNodes(current => current.filter(n => !selectedIds.includes(n.id)));
    updateEdges(current =>
      current.filter(e => !selectedIds.includes(e.fromNode) && !selectedIds.includes(e.toNode)),
    );
    setSelectedIds([]);
  }, [selectedIds, updateEdges, updateNodes]);

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
      // Read through refs, not the render closure. A chained run needs the
      // upstream node's *just-written* result — the plate that step 1 produced —
      // and a closure captured before the chain started would still show it empty.
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;

      const sourceOf = (target: PegNode, portId: string) => {
        const edge = currentEdges.find(e => e.toNode === target.id && e.toPort === portId);
        return edge ? currentNodes.find(n => n.id === edge.fromNode) : undefined;
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

        const own = String(start.params.value ?? '').trim() || (start.text ?? '').trim();
        if (own) return own;

        const upstream = sourceOf(start, 'prompt');
        return upstream ? resolvePrompt(upstream, seen) : '';
      };

      const formatNode = sourceOf(node, 'format');
      const styleNode = sourceOf(node, 'style');
      const imageNode =
        sourceOf(node, 'image') ?? sourceOf(node, 'base') ?? sourceOf(node, 'asset');

      const upstreamPrompt = sourceOf(node, 'prompt');
      return {
        prompt: upstreamPrompt ? resolvePrompt(upstreamPrompt) : resolvePrompt(node),
        styleNotes: String(styleNode?.params.notes ?? '').trim(),
        format: formatNode ? toRunFormat(formatNode.params) : undefined,
        sourceAssetKey: imageNode?.result?.assetKey,
      };
    },
    [],
  );

  const patchNode = useCallback((id: string, patch: Partial<PegNode>) => {
    updateNodes(current => current.map(n => (n.id === id ? {...n, ...patch} : n)));
  }, [updateNodes]);

  const runNode = useCallback(
    async (node: PegNode): Promise<boolean> => {
      if (!isExecutableNode(node)) return false;
      const {prompt, styleNotes, format, sourceAssetKey} = resolveInputs(node);
      const directedPrompt = styleNotes
        ? `${prompt}\n\nBrand look to preserve: ${styleNotes}`.trim()
        : prompt;

      // Outpaint is the explicit Extend Canvas job, not a generic property of
      // every image model that happens to have image and format inputs.
      const isOutpaint = node.type === 'genfill' && Boolean(sourceAssetKey && format);

      // Fail here rather than spending a call the API will reject anyway.
      if (!directedPrompt && !isOutpaint) {
        patchNode(node.id, {
          status: 'error',
          error: 'No prompt. Connect a Brief node, or type one into this node.',
        });
        return false;
      }

      patchNode(node.id, {status: 'queued', error: undefined});

      try {
        const params: Record<string, string | number | boolean> = {};
        if (!Boolean(node.params.randomSeed) && node.params.seed != null) {
          params.seed = Number(node.params.seed);
        }
        if (node.params.strength != null) params.strength = Number(node.params.strength);
        if (node.params.numberOfImages != null) {
          params.number_of_images = Number(node.params.numberOfImages);
        }

        const result = await executeRun(
          {
            operation: isOutpaint ? 'outpaint' : 'generate',
            node_id: node.id,
            model: node.model,
            prompt: directedPrompt,
            negative_prompt: String(node.params.negativePrompt ?? '') || undefined,
            params,
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
        return true;
      } catch (error) {
        patchNode(node.id, {status: 'error', error: (error as Error).message});
        return false;
      }
    },
    [patchNode, resolveInputs],
  );

  /**
   * Run a set of nodes in dependency order, sequentially.
   *
   * Sequential on purpose: GMI drops submits under load, and the service caps
   * concurrency regardless. Failed dependencies suppress only their own
   * descendants, so one failed breakpoint does not cancel its siblings.
   */
  const runNodes = useCallback(
    async (ids: string[]) => {
      const runnableIds = ids.filter(id => {
        const node = nodesRef.current.find(n => n.id === id);
        return node ? isExecutableNode(node) : false;
      });

      await executeInDependencyOrder({
        ids: runnableIds,
        edges: edgesRef.current,
        // Re-read here, after the preceding step updated nodesRef synchronously.
        run: async id => {
          const node = nodesRef.current.find(n => n.id === id);
          return node ? runNode(node) : false;
        },
        onSkip: (id, reason) =>
          patchNode(id, {
            status: 'error',
            error:
              reason.kind === 'dependency-cycle'
                ? 'Run skipped: dependency cycle detected.'
                : 'Run skipped because an upstream node failed.',
          }),
      });
    },
    [patchNode, runNode],
  );

  const runSelected = useCallback(() => {
    void runNodes(selectedIds);
  }, [runNodes, selectedIds]);

  /** Run the whole graph — the fan-out in one click, for the demo. */
  const runAll = useCallback(() => {
    void runNodes(nodesRef.current.map(n => n.id));
  }, [runNodes]);

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

  const totalCost = selectedNodes
    .filter(isExecutableNode)
    .reduce((sum, n) => sum + n.cost, 0);

  return (
    <AppShell
      contentPadding={0}
      variant="section"
      mobileNav={false}
      topNav={
        <EditorTopBar
          name={name}
          onNameChange={setName}
          nodeCount={nodes.length}
          isRunning={isRunning}
          runnableCount={nodes.filter(isExecutableNode).length}
          onRunAll={runAll}
        />
      }>
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
          {nodes.length === 0 && (
            // A blank canvas is otherwise just an empty grid with no affordance.
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                pointerEvents: 'none',
                zIndex: 1,
              }}>
              <EmptyState
                title="Empty canvas"
                description="Add a Brand Kit and a Brief from the palette, then a Brand Scene to generate."
                isCompact
              />
            </div>
          )}
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
