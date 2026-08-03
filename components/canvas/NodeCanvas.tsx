'use client';

import {useCallback, useEffect, useRef, useState} from 'react';

import {
  PORT_TYPE_COLOR,
  clampZoom,
  canConnect,
  edgeMidpoint,
  edgePath,
  portPosition,
  screenToWorld,
  zoomAt,
  type Viewport,
} from '@/lib/canvas-geometry';
import type {Edge, PegNode} from '@/lib/types';

import {NodeCard} from './NodeCard';

/** A connection being dragged out of a port but not yet dropped. */
interface PendingConnection {
  fromNode: string;
  fromPort: string;
  type: string;
  to: {x: number; y: number};
}

interface DragState {
  nodeId: string;
  /** Grab offset in world units, so the node doesn't jump to the cursor. */
  offsetX: number;
  offsetY: number;
}

interface Props {
  nodes: PegNode[];
  edges: Edge[];
  selectedIds: string[];
  viewport: Viewport;
  onViewportChange: (vp: Viewport) => void;
  onSelectionChange: (ids: string[]) => void;
  onNodeMove: (id: string, x: number, y: number) => void;
  onNodeClear: (id: string) => void;
  onNodeRename: (id: string, title: string) => void;
  onNodeLockToggle: (id: string) => void;
  onNodeDelete: (id: string) => void;
  onConnect: (edge: Omit<Edge, 'id'>) => void;
  onEdgeDelete: (id: string) => void;
  onRunNode: (node: PegNode) => void;
}

export function NodeCanvas({
  nodes,
  edges,
  selectedIds,
  viewport,
  onViewportChange,
  onSelectionChange,
  onNodeMove,
  onNodeClear,
  onNodeRename,
  onNodeLockToggle,
  onNodeDelete,
  onConnect,
  onEdgeDelete,
  onRunNode,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{startX: number; startY: number; origin: Viewport} | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [pending, setPending] = useState<PendingConnection | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  const nodeById = useCallback((id: string) => nodes.find(n => n.id === id), [nodes]);

  /** Pointer position in world coordinates. */
  const pointerWorld = useCallback(
    (e: {clientX: number; clientY: number}) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return {x: 0, y: 0};
      return screenToWorld(e.clientX - rect.left, e.clientY - rect.top, viewport);
    },
    [viewport],
  );

  // ----------------------------------------------------------------- panning
  const handleBackgroundPointerDown = (e: React.PointerEvent) => {
    // Left button on empty canvas pans and clears selection; middle button always pans.
    if (e.button !== 0 && e.button !== 1) return;
    panRef.current = {startX: e.clientX, startY: e.clientY, origin: viewport};
    if (e.button === 0) onSelectionChange([]);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (panRef.current) {
      const {startX, startY, origin} = panRef.current;
      onViewportChange({...origin, x: origin.x + (e.clientX - startX), y: origin.y + (e.clientY - startY)});
      return;
    }
    if (dragRef.current) {
      const world = pointerWorld(e);
      const {nodeId, offsetX, offsetY} = dragRef.current;
      onNodeMove(nodeId, world.x - offsetX, world.y - offsetY);
      return;
    }
    if (pending) {
      setPending({...pending, to: pointerWorld(e)});
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    panRef.current = null;
    dragRef.current = null;

    // Dropping a connection has to be resolved by hit-testing, not by letting
    // the port handle its own pointerup. Starting a drag captures the pointer on
    // the canvas root, and a captured pointer retargets every later event to the
    // capturing element — so the port never receives the release, and the
    // connection silently evaporated.
    if (pending) {
      dropConnection(e.clientX, e.clientY);
      setPending(null);
    }

    if ((e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  // ------------------------------------------------------------------ zoom
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    // Registered natively (not via onWheel) so it can be non-passive and
    // preventDefault the browser's pinch-zoom / overscroll.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.002);
        onViewportChange(zoomAt(viewport, viewport.zoom * factor, px, py));
      } else {
        onViewportChange({...viewport, x: viewport.x - e.deltaX, y: viewport.y - e.deltaY});
      }
    };

    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewport, onViewportChange]);

  // --------------------------------------------------------------- node drag
  const startNodeDrag = (e: React.PointerEvent, node: PegNode) => {
    const additive = e.shiftKey || e.metaKey;
    if (additive) {
      onSelectionChange(
        selectedIds.includes(node.id) ? selectedIds.filter(id => id !== node.id) : [...selectedIds, node.id],
      );
    } else if (!selectedIds.includes(node.id)) {
      onSelectionChange([node.id]);
    }
    if (node.isLocked) return;

    const world = pointerWorld(e);
    dragRef.current = {nodeId: node.id, offsetX: world.x - node.x, offsetY: world.y - node.y};
    (e.currentTarget as HTMLElement).closest('[data-canvas-root]')?.setPointerCapture?.(e.pointerId);
  };

  // -------------------------------------------------------------- connecting
  const startConnection = (e: React.PointerEvent, node: PegNode, portId: string, type: string) => {
    e.stopPropagation();
    setPending({fromNode: node.id, fromPort: portId, type, to: pointerWorld(e)});
    (e.currentTarget as HTMLElement).closest('[data-canvas-root]')?.setPointerCapture?.(e.pointerId);
  };

  /** Find the input port under the pointer and connect to it, if any. */
  const dropConnection = (clientX: number, clientY: number) => {
    // elementsFromPoint, not elementFromPoint: the port dot is absolutely
    // positioned inside the node card with no z-index, so card content paints
    // over it and the topmost element at the drop point is never the port.
    // Walking the whole hit stack avoids depending on the card's paint order.
    const hit = document
      .elementsFromPoint(clientX, clientY)
      .map(el => (el as HTMLElement).closest?.('[data-port-side="input"]'))
      .find(Boolean) as HTMLElement | undefined;
    if (!hit) return;
    const nodeId = hit.dataset.nodeId;
    const portId = hit.dataset.portId;
    if (!nodeId || !portId) return;
    const target = nodeById(nodeId);
    if (target) completeConnection(target, portId);
  };

  const completeConnection = (targetNode: PegNode, portId: string) => {
    if (!pending) return;
    const source = nodeById(pending.fromNode);
    if (!source) return;
    if (canConnect({node: source, portId: pending.fromPort}, {node: targetNode, portId}, edges)) {
      onConnect({
        fromNode: pending.fromNode,
        fromPort: pending.fromPort,
        toNode: targetNode.id,
        toPort: portId,
        type: pending.type as Edge['type'],
      });
    }
    setPending(null);
  };

  // Escape cancels an in-flight connection.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  const pendingFrom = pending ? nodeById(pending.fromNode) : undefined;

  return (
    <div
      ref={rootRef}
      data-canvas-root
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        position: 'relative',
        inlineSize: '100%',
        blockSize: '100%',
        overflow: 'hidden',
        cursor: panRef.current ? 'grabbing' : 'default',
        backgroundColor: 'var(--color-background-body)',
        // Dot grid, scaled with the viewport so it reads as depth while panning.
        backgroundImage: 'radial-gradient(var(--color-border-emphasized) 1px, transparent 1px)',
        backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        touchAction: 'none',
        userSelect: 'none',
      }}>
      <div
        style={{
          position: 'absolute',
          insetInlineStart: 0,
          insetBlockStart: 0,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
        }}>
        {/* Edge layer sits beneath the nodes but inside the same transform. */}
        <svg
          style={{
            position: 'absolute',
            overflow: 'visible',
            pointerEvents: 'none',
            inlineSize: 1,
            blockSize: 1,
          }}>
          {edges.map(edge => {
            const from = nodeById(edge.fromNode);
            const to = nodeById(edge.toNode);
            if (!from || !to) return null;
            const a = portPosition(from, edge.fromPort, 'output');
            const b = portPosition(to, edge.toPort, 'input');
            const color = PORT_TYPE_COLOR[edge.type] ?? 'var(--color-border-emphasized)';
            const mid = edgeMidpoint(a, b);
            const isHovered = hoveredEdge === edge.id;
            return (
              <g key={edge.id}>
                {/* Wide invisible hit area so thin curves stay clickable. */}
                <path
                  d={edgePath(a, b)}
                  stroke="transparent"
                  strokeWidth={14}
                  fill="none"
                  style={{pointerEvents: 'stroke', cursor: 'pointer'}}
                  onPointerEnter={() => setHoveredEdge(edge.id)}
                  onPointerLeave={() => setHoveredEdge(null)}
                  onPointerDown={e => {
                    e.stopPropagation();
                    onEdgeDelete(edge.id);
                  }}
                />
                <path
                  d={edgePath(a, b)}
                  stroke={color}
                  strokeWidth={isHovered ? 2.5 : 1.5}
                  fill="none"
                  opacity={isHovered ? 1 : 0.85}
                />
                {viewport.zoom > 0.5 && (
                  <text
                    x={mid.x}
                    y={mid.y - 6}
                    textAnchor="middle"
                    fill={color}
                    style={{
                      fontSize: 9,
                      fontFamily: 'var(--font-family-body)',
                      pointerEvents: 'none',
                      userSelect: 'none',
                    }}>
                    {to.inputs.find(p => p.id === edge.toPort)?.name ?? edge.type}
                  </text>
                )}
              </g>
            );
          })}

          {pending && pendingFrom && (
            <path
              d={edgePath(portPosition(pendingFrom, pending.fromPort, 'output'), pending.to)}
              stroke={PORT_TYPE_COLOR[pending.type] ?? 'var(--color-accent)'}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              fill="none"
            />
          )}
        </svg>

        {nodes.map(node => (
          <NodeCard
            key={node.id}
            node={node}
            isSelected={selectedIds.includes(node.id)}
            zoom={viewport.zoom}
            pendingType={pending?.type}
            onHeaderPointerDown={e => startNodeDrag(e, node)}
            onOutputPointerDown={(e, portId, type) => startConnection(e, node, portId, type)}
            onRun={() => onRunNode(node)}
            onClear={() => onNodeClear(node.id)}
            onRename={title => onNodeRename(node.id, title)}
            onToggleLock={() => onNodeLockToggle(node.id)}
            onDelete={() => onNodeDelete(node.id)}
          />
        ))}
      </div>
    </div>
  );
}

export {clampZoom};
