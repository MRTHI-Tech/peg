'use client';

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {AppShell} from '@astryxdesign/core/AppShell';
import {Layout, LayoutPanel} from '@astryxdesign/core/Layout';
import {HStack} from '@astryxdesign/core/Stack';
import {EmptyState} from '@astryxdesign/core/EmptyState';

import {NodeCanvas} from '@/components/canvas/NodeCanvas';
import {estimateNodeHeight} from '@/components/canvas/node-metrics';
import {defaultParams, getNodeDef} from '@/lib/catalog';
import {
  findOpenNodePosition,
  fitViewport,
  graphBounds,
  screenToWorld,
  type Viewport,
} from '@/lib/canvas-geometry';
import {presetSize, safeAreaForTarget, toOutpaintFormat, toRunFormat} from '@/lib/formats';
import {executeInDependencyOrder, isExecutableNode} from '@/lib/graph-execution';
import {useBrand} from '@/lib/use-brand';
import {useMediaQuery} from '@/lib/use-media-query';
import {resolveBriefTarget} from '@/lib/brief-context';
import {
  enhanceBrief,
  executeRun,
  loadWorkflow,
  saveWorkflow,
  toAssetRef,
  toProvenance,
} from '@/lib/workflow-service';
import {
  readIndexedWorkflowDraft,
  readWorkflowDraft,
  recoverWorkflow,
  workflowFingerprint,
  workflowTimestamp,
  writeIndexedWorkflowDraft,
  writeWorkflowDraft,
} from '@/lib/workflow-draft';
import type {Edge, NodeCategory, ParamValue, PegNode, Workflow} from '@/lib/types';

import {EditorTopBar} from './EditorTopBar';
import {IconRail, type RailSection} from './IconRail';
import {PalettePanel} from './PalettePanel';
import {InspectorPanel} from './InspectorPanel';
import {ZoomToolbar} from './ZoomToolbar';

function newestWorkflow(...candidates: Array<Workflow | null>): Workflow | null {
  return candidates.reduce<Workflow | null>(
    (newest, candidate) =>
      candidate && (!newest || workflowTimestamp(candidate) > workflowTimestamp(newest))
        ? candidate
        : newest,
    null,
  );
}

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
export function CanvasEditor({
  workflow,
  workspaceId,
  isNew = false,
}: {
  workflow: Workflow;
  workspaceId: string;
  isNew?: boolean;
}) {
  const [name, setName] = useState(workflow.name);
  const [nodes, setNodes] = useState<PegNode[]>(workflow.nodes);
  const [edges, setEdges] = useState<Edge[]>(workflow.edges);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [viewport, setViewport] = useState<Viewport>({x: 0, y: 0, zoom: 0.75});
  const [railSection, setRailSection] = useState<RailSection>('image-models');
  const [isPaletteOpen, setIsPaletteOpen] = useState(true);
  const [saveStatus, setSaveStatus] = useState<
    'loading' | 'load-error' | 'unsaved' | 'saving' | 'saved' | 'error'
  >('loading');
  const [saveError, setSaveError] = useState<string>();
  const [persistenceReady, setPersistenceReady] = useState(false);

  // Brief enhancement. Transient by design: an enhanced brief is just text in
  // the node, and the pre-enhancement copy is kept here rather than on the node
  // so an undo buffer never reaches the saved document.
  const [enhancingId, setEnhancingId] = useState<string | null>(null);
  const [enhanceErrors, setEnhanceErrors] = useState<Record<string, string>>({});
  const [briefOriginals, setBriefOriginals] = useState<Record<string, string>>({});

  // Soft gate: the canvas always opens, but generation is withheld until the
  // brand can actually lock it — otherwise output is on-brand by accident.
  const {brand, isReady: isBrandReady} = useBrand();

  const isNarrow = useMediaQuery('(max-width: 1100px)');
  const isVeryNarrow = useMediaQuery('(max-width: 820px)');

  // Mirrors of graph state for the run engine. A chained run needs values
  // written by earlier steps of the same chain, which a render-time closure
  // cannot see.
  const nameRef = useRef(name);
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

  const updateName = useCallback((next: string) => {
    nameRef.current = next;
    setName(next);
  }, []);

  // ---------------------------------------------------------- persistence
  const persistenceReadyRef = useRef(false);
  const localUpdatedAtRef = useRef(workflow.updatedAt);
  const latestDraftRef = useRef<Workflow | null>(null);
  const lastSavedFingerprintRef = useRef('');
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const saveAgainRef = useRef(false);
  const flushSaveRef = useRef<() => void>(() => {});
  const isNewRef = useRef(isNew);
  const isMountedRef = useRef(true);

  const buildWorkflow = useCallback(
    (updatedAt = localUpdatedAtRef.current): Workflow => ({
      id: workflow.id,
      name: nameRef.current.trim() || 'Untitled project',
      nodes: nodesRef.current,
      edges: edgesRef.current,
      updatedAt,
      nodeCount: nodesRef.current.length,
      thumbnailUrl: workflow.thumbnailUrl,
    }),
    [workflow.id, workflow.thumbnailUrl],
  );

  const writeCurrentDraft = useCallback(() => {
    const updatedAt = new Date().toISOString();
    localUpdatedAtRef.current = updatedAt;
    const draft = buildWorkflow(updatedAt);
    latestDraftRef.current = draft;
    if (typeof window !== 'undefined') {
      writeWorkflowDraft(window.localStorage, workspaceId, draft);
      void writeIndexedWorkflowDraft(workspaceId, draft);
    }
    return draft;
  }, [buildWorkflow, workspaceId]);

  const applyRestoredWorkflow = useCallback((restored: Workflow) => {
    const recovered = recoverWorkflow(restored);
    nameRef.current = recovered.name;
    nodesRef.current = recovered.nodes;
    edgesRef.current = recovered.edges;
    localUpdatedAtRef.current = recovered.updatedAt;
    latestDraftRef.current = recovered;
    setName(recovered.name);
    setNodes(recovered.nodes);
    setEdges(recovered.edges);
  }, []);

  const flushSave = useCallback(async () => {
    if (!persistenceReadyRef.current) return;
    if (saveInFlightRef.current) {
      saveAgainRef.current = true;
      return;
    }

    const snapshot = buildWorkflow();
    const fingerprint = workflowFingerprint(snapshot);
    if (fingerprint === lastSavedFingerprintRef.current) {
      if (isMountedRef.current) setSaveStatus('saved');
      return;
    }

    saveInFlightRef.current = true;
    saveAgainRef.current = false;
    if (isMountedRef.current) {
      setSaveStatus('saving');
      setSaveError(undefined);
    }

    try {
      const saved = await saveWorkflow(snapshot);
      lastSavedFingerprintRef.current = fingerprint;

      // Do not apply the response over live state: edits may have happened while
      // the request was in flight. Only advance the saved timestamp when this
      // exact snapshot is still current.
      const latest = buildWorkflow();
      if (workflowFingerprint(latest) === fingerprint) {
        localUpdatedAtRef.current = saved.updatedAt;
        latestDraftRef.current = {...latest, updatedAt: saved.updatedAt};
        if (typeof window !== 'undefined') {
          writeWorkflowDraft(window.localStorage, workspaceId, latestDraftRef.current);
          void writeIndexedWorkflowDraft(workspaceId, latestDraftRef.current);
          if (isNewRef.current) {
            window.history.replaceState(
              window.history.state,
              '',
              `/project/${encodeURIComponent(workflow.id)}`,
            );
            isNewRef.current = false;
          }
        }
        if (isMountedRef.current) setSaveStatus('saved');
      } else {
        saveAgainRef.current = true;
      }
    } catch (error) {
      if (isMountedRef.current) {
        setSaveStatus('error');
        setSaveError((error as Error).message);
      }
    } finally {
      saveInFlightRef.current = false;
      if (saveAgainRef.current) {
        saveAgainRef.current = false;
        window.setTimeout(() => flushSaveRef.current(), 0);
      }
    }
  }, [buildWorkflow, workflow.id, workspaceId]);

  flushSaveRef.current = () => {
    void flushSave();
  };

  const forceSave = useCallback(() => {
    if (saveStatus === 'load-error') {
      window.location.reload();
      return;
    }
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    flushSaveRef.current();
  }, [saveStatus]);

  // Recover the local safety copy first, then reconcile it with B2. A local
  // draft wins only when it is newer; otherwise the server copy also refreshes
  // any expiring asset URLs embedded in completed nodes.
  useEffect(() => {
    let cancelled = false;
    isMountedRef.current = true;

    const local = readWorkflowDraft(window.localStorage, workspaceId, workflow.id);
    if (local) applyRestoredWorkflow(local);

    const finish = (status: 'unsaved' | 'saved' | 'error', error?: string) => {
      if (cancelled) return;
      persistenceReadyRef.current = true;
      setPersistenceReady(true);
      setSaveStatus(status);
      setSaveError(error);
    };

    void (async () => {
      const indexed = await readIndexedWorkflowDraft(workspaceId, workflow.id);
      if (cancelled) return;
      const browserDraft = newestWorkflow(local, indexed, latestDraftRef.current);
      if (browserDraft) applyRestoredWorkflow(browserDraft);

      if (isNewRef.current) {
        finish('unsaved');
        return;
      }

      try {
        const remote = await loadWorkflow(workflow.id);
        if (cancelled) return;

        // Re-read after the request: the user may have edited while a cold
        // service was waking up, and that local edit must beat the older B2 copy.
        const currentLocal = newestWorkflow(
          readWorkflowDraft(window.localStorage, workspaceId, workflow.id),
          await readIndexedWorkflowDraft(workspaceId, workflow.id),
          latestDraftRef.current,
        );
        const sameContent =
          remote &&
          currentLocal &&
          workflowFingerprint(recoverWorkflow(remote)) ===
            workflowFingerprint(recoverWorkflow(currentLocal));
        const restored =
          remote &&
          (!currentLocal || sameContent || workflowTimestamp(remote) >= workflowTimestamp(currentLocal))
            ? remote
            : currentLocal ?? remote ?? workflow;

        if (remote) lastSavedFingerprintRef.current = workflowFingerprint(recoverWorkflow(remote));
        applyRestoredWorkflow(restored);
        finish(
          remote &&
            workflowFingerprint(recoverWorkflow(restored)) === lastSavedFingerprintRef.current
            ? 'saved'
            : 'unsaved',
        );
      } catch (error) {
        if (!browserDraft && workflow.nodes.length === 0) {
          // An unknown id may be a real cloud-only project. Keep the editor
          // locked instead of treating an outage as an empty canvas and later
          // overwriting the graph with that placeholder.
          setSaveStatus('load-error');
          setSaveError((error as Error).message);
          return;
        }
        // The local copy remains fully usable. The status makes it explicit that
        // this device is safe but cloud persistence needs retrying.
        finish('error', (error as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      isMountedRef.current = false;
    };
  }, [applyRestoredWorkflow, workflow, workspaceId]);

  // Every graph edit lands in the browser immediately and is coalesced into a
  // B2 write after the user pauses. Sequential flushing prevents an older,
  // slower request from overwriting a newer snapshot.
  useEffect(() => {
    if (!persistenceReadyRef.current) return;
    const current = buildWorkflow();
    if (workflowFingerprint(current) === lastSavedFingerprintRef.current) {
      writeWorkflowDraft(window.localStorage, workspaceId, current);
      void writeIndexedWorkflowDraft(workspaceId, current);
      setSaveStatus('saved');
      return;
    }

    writeCurrentDraft();
    setSaveStatus(current => (current === 'saving' ? current : 'unsaved'));
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => flushSaveRef.current(), 650);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [name, nodes, edges, persistenceReady, buildWorkflow, writeCurrentDraft, workspaceId]);

  // A hard reload can happen inside the debounce window. localStorage is
  // synchronous, so the current graph is committed before the document exits;
  // the next mount restores it and resumes the cloud save.
  useEffect(() => {
    const preserve = () => {
      // Never turn the empty loading placeholder into a newer draft. On a cold
      // first open that would beat the real remote graph on the next reload.
      if (!persistenceReadyRef.current) return;
      writeCurrentDraft();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return;
      preserve();
      flushSaveRef.current();
    };
    window.addEventListener('pagehide', preserve);
    window.addEventListener('beforeunload', preserve);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', preserve);
      window.removeEventListener('beforeunload', preserve);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [writeCurrentDraft]);

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
    updateNodes(current => current.map(n => (n.id === id && !n.isLocked ? {...n, x, y} : n)));
  }, [updateNodes]);

  const clearNode = useCallback((id: string) => {
    updateNodes(current =>
      current.map(node => {
        if (node.id !== id) return node;
        const def = getNodeDef(node.type);
        return {
          ...node,
          status: 'idle',
          params: def ? defaultParams(def) : node.params,
          text: node.type === 'prompt' ? '' : undefined,
          result: undefined,
          provenance: undefined,
          error: undefined,
        };
      }),
    );
  }, [updateNodes]);

  const renameNode = useCallback((id: string, title: string) => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    updateNodes(current => current.map(node => (node.id === id ? {...node, title: trimmedTitle} : node)));
  }, [updateNodes]);

  const toggleNodeLock = useCallback((id: string) => {
    updateNodes(current =>
      current.map(node => (node.id === id ? {...node, isLocked: !node.isLocked} : node)),
    );
  }, [updateNodes]);

  const deleteNode = useCallback((id: string) => {
    updateNodes(current => current.filter(node => node.id !== id));
    updateEdges(current => current.filter(edge => edge.fromNode !== id && edge.toNode !== id));
    setSelectedIds(current => current.filter(selectedId => selectedId !== id));
  }, [updateEdges, updateNodes]);

  const connect = useCallback((edge: Omit<Edge, 'id'>) => {
    updateEdges(current => [...current, {...edge, id: `e-${crypto.randomUUID().slice(0, 8)}`}]);
  }, [updateEdges]);

  const deleteEdge = useCallback((id: string) => {
    updateEdges(current => current.filter(e => e.id !== id));
  }, [updateEdges]);

  /**
   * Move the copy-safe band when a new target makes the current one impossible.
   *
   * Picking a portrait preset used to leave `Left third` in place, which the
   * service then had to refuse — a source contained in a portrait canvas spans
   * its full width, so that band is entirely preserved pixels. Correcting it
   * here keeps the failure from ever reaching a paid request.
   */
  const applySafeAreaForTarget = (
    params: Record<string, ParamValue>,
    key: string,
  ): Record<string, ParamValue> => {
    if (key !== 'preset' && key !== 'resolution') return params;
    const size = presetSize(String(params[key] ?? ''));
    if (!size) return params;
    const safeArea = safeAreaForTarget(size.width, size.height, String(params.safeArea ?? ''));
    return safeArea === params.safeArea ? params : {...params, safeArea};
  };

  const updateParam = useCallback((nodeId: string, key: string, value: ParamValue) => {
    // Hand-editing an enhanced brief retires the undo: from here the text is
    // theirs again, and offering to "put it back" would throw away their edit.
    if (key === 'value') {
      setBriefOriginals(current => {
        if (!(nodeId in current)) return current;
        const {[nodeId]: _dropped, ...rest} = current;
        return rest;
      });
    }
    updateNodes(current =>
      current.map(n =>
        n.id === nodeId
          ? {
              ...n,
              params: applySafeAreaForTarget({...n.params, [key]: value}, key),
              // Brief cards and their inspector field are two views of one value.
              text: n.type === 'prompt' && key === 'value' ? String(value) : n.text,
              // Brand Asset is a zero-cost source node. Selecting an approved
              // file makes it immediately available to previews and downstream
              // local composition without pretending it was generated.
              result:
                n.type === 'product-asset' && key === 'assetKey'
                  ? (() => {
                      const asset = brand.composites.find(item => item.asset_key === value);
                      return asset
                        ? {
                            assetKey: asset.asset_key,
                            bucket: 'brand-library',
                            contentType: asset.content_type,
                            bytes: asset.bytes,
                            url: asset.url,
                          }
                        : undefined;
                    })()
                  : n.result,
            }
          : n,
      ),
    );
  }, [brand.composites, updateNodes]);

  // ------------------------------------------------------- brief enhancement
  /** Write a brief onto its node. Card and inspector are two views of one value. */
  const applyBrief = useCallback(
    (nodeId: string, text: string) => {
      updateNodes(current =>
        current.map(n =>
          n.id === nodeId ? {...n, params: {...n.params, value: text}, text} : n,
        ),
      );
    },
    [updateNodes],
  );

  /**
   * Rewrite a rough brief as art direction.
   *
   * The brand is not sent from here — the service loads it for the workspace,
   * so an enhanced brief can only ever name a palette this workspace owns. What
   * the browser does contribute is the target canvas, because only the graph
   * knows which breakpoint this brief is wired to.
   */
  const enhanceNodeBrief = useCallback(
    async (nodeId: string) => {
      const node = nodesRef.current.find(n => n.id === nodeId);
      if (!node) return;

      const brief = String(node.params.value ?? '').trim() || (node.text ?? '').trim();
      if (!brief || enhancingId) return;

      setEnhanceErrors(current => {
        const {[nodeId]: _dropped, ...rest} = current;
        return rest;
      });
      setEnhancingId(nodeId);

      const target = resolveBriefTarget(nodeId, nodesRef.current, edgesRef.current);

      try {
        const result = await enhanceBrief({
          brief,
          format: target
            ? target.source === 'format'
              ? toRunFormat(target.params)
              : toOutpaintFormat(target.params)
            : undefined,
        });
        applyBrief(nodeId, result.brief);
        // Keep what they wrote, not what the last enhancement produced: two
        // enhancements in a row should still undo back to the human sentence.
        setBriefOriginals(current => ({...current, [nodeId]: current[nodeId] ?? result.original}));
      } catch (error) {
        setEnhanceErrors(current => ({...current, [nodeId]: (error as Error).message}));
      } finally {
        setEnhancingId(null);
      }
    },
    [applyBrief, enhancingId],
  );

  const revertBrief = useCallback(
    (nodeId: string) => {
      const original = briefOriginals[nodeId];
      if (original == null) return;
      applyBrief(nodeId, original);
      setBriefOriginals(current => {
        const {[nodeId]: _dropped, ...rest} = current;
        return rest;
      });
    },
    [applyBrief, briefOriginals],
  );

  const enhanceControls = useMemo(
    () => ({
      busyId: enhancingId,
      errors: enhanceErrors,
      originals: briefOriginals,
      onEnhance: enhanceNodeBrief,
      onRevert: revertBrief,
    }),
    [briefOriginals, enhanceErrors, enhanceNodeBrief, enhancingId, revertBrief],
  );

  const addNode = useCallback(
    (type: string) => {
      const def = getNodeDef(type);
      const host = canvasHostRef.current;
      if (!def || !host) return;
      const {width, height} = host.getBoundingClientRect();
      // Prefer the center of the current view, then expand into the nearest
      // visible open slot so a new node never hides under the previous one.
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
      const topLeft = screenToWorld(0, 0, viewport);
      const bottomRight = screenToWorld(width, height, viewport);
      updateNodes(current => {
        const position = findOpenNodePosition({
          desired: {x, y},
          size: {width: node.width, height: estimateNodeHeight(node)},
          occupied: current.map(existing => ({
            x: existing.x,
            y: existing.y,
            width: existing.width,
            height: estimateNodeHeight(existing),
          })),
          visibleBounds: {
            minX: topLeft.x,
            minY: topLeft.y,
            maxX: bottomRight.x,
            maxY: bottomRight.y,
          },
        });
        return [...current, {...node, ...position}];
      });
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
   * geometry from whatever Format node feeds its format port. An upstream image
   * becomes the source for an edit; Extend Canvas additionally uses a Format to
   * turn that source into a dedicated canvas-expansion request.
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
      const imageNode = sourceOf(node, 'image') ?? sourceOf(node, 'asset');
      const baseNode = sourceOf(node, 'base');
      const overlayNode = sourceOf(node, 'overlay');
      const assetKey = (source: PegNode | undefined) =>
        source?.result?.assetKey || String(source?.params.assetKey ?? '') || undefined;

      const upstreamPrompt = sourceOf(node, 'prompt');
      // A Reference node carries the image on its style output. The model wants
      // raw base64, so the `data:<mime>;base64,` prefix comes off here.
      const referenceUri = String(styleNode?.params.image ?? '');
      const referenceB64 = referenceUri.includes(',')
        ? referenceUri.slice(referenceUri.indexOf(',') + 1)
        : undefined;

      return {
        prompt: upstreamPrompt ? resolvePrompt(upstreamPrompt) : resolvePrompt(node),
        styleNotes: String(styleNode?.params.notes ?? '').trim(),
        format: formatNode ? toRunFormat(formatNode.params) : undefined,
        sourceAssetKey: assetKey(imageNode ?? baseNode),
        baseAssetKey: assetKey(baseNode),
        overlayAssetKey: assetKey(overlayNode),
        referenceB64,
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
      const {
        prompt,
        styleNotes,
        format,
        sourceAssetKey,
        baseAssetKey,
        overlayAssetKey,
        referenceB64,
      } = resolveInputs(node);
      const directedPrompt = styleNotes
        ? `${prompt}\n\nBrand look to preserve: ${styleNotes}`.trim()
        : prompt;

      // Outpaint is the explicit Extend Canvas job, not a generic property of
      // every image model that happens to have image and format inputs. The
      // target comes from a connected Format when there is one, so a fan-out
      // still runs from a single node, and otherwise from the node itself.
      const outpaintFormat =
        node.type === 'genfill' ? format ?? toOutpaintFormat(node.params) : undefined;
      const isOutpaint = Boolean(outpaintFormat && sourceAssetKey);
      const isCompose = node.type === 'app-store-compose';

      // Fail here rather than spending a call the API will reject anyway.
      if (!directedPrompt && !isOutpaint && !isCompose) {
        patchNode(node.id, {
          status: 'error',
          error: 'No prompt. Connect a Brief node, or type one into this node.',
        });
        return false;
      }
      if (isCompose && (!baseAssetKey || !overlayAssetKey)) {
        patchNode(node.id, {
          status: 'error',
          error: 'Connect a generated background and an uploaded app screenshot.',
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
        if (isCompose) {
          for (const key of [
            'layout',
            'frameStyle',
            'deviceScale',
            'deviceOffsetX',
            'deviceOffsetY',
            'shadow',
            'headline',
            'subheadline',
            'textColor',
          ]) {
            const value = node.params[key];
            if (value != null) params[key] = value;
          }
        }

        const composeFormat = isCompose
          ? format ??
            toRunFormat({
              preset: node.params.outputSize,
              safeArea: 'Upper third',
              focalPoint: 'Center',
            })
          : undefined;

        const result = await executeRun(
          {
            operation: isCompose ? 'compose' : isOutpaint ? 'outpaint' : 'generate',
            node_id: node.id,
            // Reference conditioning is unproven, so the node exposes a model
            // picker and it wins over the catalog default.
            model: String(node.params.model ?? '') || node.model,
            prompt: directedPrompt,
            negative_prompt: String(node.params.negativePrompt ?? '') || undefined,
            params,
            // Every image-input job receives the upstream B2 object. Outpaint
            // uses it to build a canvas/mask; edit models receive it as `image`.
            source_asset_key: isCompose ? baseAssetKey : sourceAssetKey,
            overlay_asset_key: isCompose ? overlayAssetKey : undefined,
            logo_asset_key: isCompose ? String(node.params.logoAssetKey ?? '') || undefined : undefined,
            format: isCompose ? composeFormat : isOutpaint ? outpaintFormat : undefined,
            // Outpaint already has an image; a reference would fight it.
            image_b64: isOutpaint ? undefined : referenceB64,
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
          warnings: result.warnings?.length ? result.warnings : undefined,
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        forceSave();
        return;
      }

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
  }, [deleteSelection, fitToViewManual, forceSave]);

  const totalCost = selectedNodes
    .filter(isExecutableNode)
    .reduce((sum, n) => sum + n.cost, 0);

  const isCanvasLoading = saveStatus === 'loading' || saveStatus === 'load-error';

  return (
    <AppShell
      contentPadding={0}
      variant="section"
      mobileNav={false}
      topNav={
        <EditorTopBar
          name={name}
          onNameChange={updateName}
          nodeCount={nodes.length}
          isRunning={isRunning}
          runnableCount={isBrandReady ? nodes.filter(isExecutableNode).length : 0}
          brandName={brand.name}
          isBrandReady={isBrandReady}
          saveStatus={saveStatus}
          saveError={saveError}
          onRetrySave={forceSave}
          onRunAll={runAll}
        />
      }>
      <Layout
        start={
          isCanvasLoading ? undefined : (
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
          )
        }
        end={
          isCanvasLoading || (isVeryNarrow && selectedNodes.length === 0) ? undefined : (
            <InspectorPanel
              nodes={selectedNodes}
              totalCost={totalCost}
              isRunning={isRunning}
              isBrandReady={isBrandReady}
              brandAssets={brand.composites}
              onRun={runSelected}
              onParamChange={updateParam}
              onDelete={deleteSelection}
              enhance={enhanceControls}
            />
          )
        }>
        <div ref={canvasHostRef} style={{position: 'relative', blockSize: '100%', inlineSize: '100%'}}>
          {isCanvasLoading ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
              }}>
              <EmptyState
                title={saveStatus === 'load-error' ? "Couldn't load project" : 'Loading project'}
                description={
                  saveStatus === 'load-error'
                    ? 'Storage could not be reached. Retry without editing so the saved graph stays protected.'
                    : 'Restoring the latest saved canvas and its outputs.'
                }
                isCompact
              />
            </div>
          ) : nodes.length === 0 ? (
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
          ) : null}
          {!isCanvasLoading && (
            <>
              <NodeCanvas
                nodes={nodes}
                edges={edges}
                selectedIds={selectedIds}
                viewport={viewport}
                onViewportChange={handleViewportChange}
                onSelectionChange={setSelectedIds}
                onNodeMove={moveNode}
                onNodeClear={clearNode}
                onNodeRename={renameNode}
                onNodeLockToggle={toggleNodeLock}
                onNodeDelete={deleteNode}
                onConnect={connect}
                onEdgeDelete={deleteEdge}
                onRunNode={runNode}
                onEnhanceNode={node => enhanceNodeBrief(node.id)}
                enhancingId={enhancingId}
              />
              <ZoomToolbar
                viewport={viewport}
                onViewportChange={handleViewportChange}
                onFit={fitToViewManual}
              />
            </>
          )}
        </div>
      </Layout>
    </AppShell>
  );
}

export type {NodeCategory};
