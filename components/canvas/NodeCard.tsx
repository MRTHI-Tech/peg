'use client';

import {MoreHorizontal, Play, Sparkles} from 'lucide-react';

import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack} from '@astryxdesign/core/Stack';
import {Spinner} from '@astryxdesign/core/Spinner';

import {PORT_SPACING, PORT_TOP_OFFSET, PORT_TYPE_COLOR} from '@/lib/canvas-geometry';
import type {Port, PegNode} from '@/lib/types';

import {NODE_HEADER_HEIGHT} from './node-metrics';

interface Props {
  node: PegNode;
  isSelected: boolean;
  zoom: number;
  /** Media type of an in-flight connection, used to highlight valid targets. */
  pendingType?: string;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onOutputPointerDown: (e: React.PointerEvent, portId: string, type: string) => void;
  onInputPointerUp: (portId: string) => void;
}

const STATUS_RING: Record<PegNode['status'], string | undefined> = {
  idle: undefined,
  queued: 'var(--color-warning)',
  running: 'var(--color-accent)',
  complete: undefined,
  error: 'var(--color-error)',
};

export function NodeCard({
  node,
  isSelected,
  zoom,
  pendingType,
  onHeaderPointerDown,
  onOutputPointerDown,
  onInputPointerUp,
}: Props) {
  const ring = isSelected ? 'var(--color-accent)' : STATUS_RING[node.status];
  const isTextNode = node.text != null;

  return (
    <div
      onPointerDown={e => {
        // Ports handle their own pointer events and stop propagation.
        e.stopPropagation();
        onHeaderPointerDown(e);
      }}
      style={{
        position: 'absolute',
        insetInlineStart: node.x,
        insetBlockStart: node.y,
        inlineSize: node.width,
        backgroundColor: 'var(--color-background-card)',
        border: `1px solid ${ring ?? 'var(--color-border)'}`,
        boxShadow: isSelected ? `0 0 0 1px ${ring}, var(--shadow-med)` : 'var(--shadow-low)',
        borderRadius: 'var(--radius-container)',
        // Cheaper compositing while the canvas is zoomed out.
        contentVisibility: zoom < 0.3 ? 'auto' : 'visible',
      }}>
      {/* ------------------------------------------------------------- header */}
      <HStack
        gap={1}
        align="center"
        justify="between"
        paddingInline={1.5}
        style={{
          blockSize: NODE_HEADER_HEIGHT,
          cursor: 'grab',
          borderBlockEnd: '1px solid var(--color-border)',
        }}>
        <HStack gap={1} align="center" style={{minInlineSize: 0}}>
          <Icon icon={Sparkles} size="xsm" color="secondary" />
          <Text type="supporting" color="primary" maxLines={1}>
            {node.title}
          </Text>
        </HStack>
        <HStack gap={1} align="center">
          {node.status === 'running' && <Spinner size="sm" />}
          <Icon icon={MoreHorizontal} size="xsm" color="secondary" />
        </HStack>
      </HStack>

      {/* --------------------------------------------------------------- body */}
      {isTextNode ? (
        <div style={{padding: 'var(--spacing-2)', maxBlockSize: 180, overflow: 'hidden'}}>
          <Text type="supporting" color="secondary" maxLines={9}>
            {node.text}
          </Text>
        </div>
      ) : node.result ? (
        <div style={{position: 'relative', lineHeight: 0}}>
          {/* eslint-disable-next-line @next/next/no-img-element -- data-URI placeholder */}
          <img
            src={node.result.url}
            alt={`${node.title} output`}
            draggable={false}
            style={{inlineSize: '100%', aspectRatio: '1 / 1', objectFit: 'cover', display: 'block'}}
          />
        </div>
      ) : (
        <div
          style={{
            blockSize: 96,
            display: 'grid',
            placeItems: 'center',
            backgroundColor: 'var(--color-background-muted)',
          }}>
          <Text type="supporting" color="disabled">
            No output yet
          </Text>
        </div>
      )}

      {/* ------------------------------------------------------------- footer */}
      {!isTextNode && (
        <HStack
          gap={1}
          align="center"
          justify="between"
          padding={1}
          style={{borderBlockStart: '1px solid var(--color-border)'}}>
          {node.cost > 0 ? (
            <HStack gap={0.5} align="center">
              <Icon icon={Sparkles} size="xsm" color="secondary" />
              <Text type="supporting" color="secondary">
                {node.cost}
              </Text>
            </HStack>
          ) : (
            <span />
          )}
          <HStack gap={0.5} align="center">
            <Icon icon={Play} size="xsm" color="accent" />
            <Text type="supporting" color="accent">
              Run Model
            </Text>
          </HStack>
        </HStack>
      )}

      {/* --------------------------------------------------------------- ports */}
      {node.inputs.map((port, i) => (
        <PortDot
          key={port.id}
          nodeId={node.id}
          port={port}
          side="input"
          index={i}
          isTarget={pendingType === port.type}
          onPointerUp={() => onInputPointerUp(port.id)}
        />
      ))}
      {node.outputs.map((port, i) => (
        <PortDot
          key={port.id}
          nodeId={node.id}
          port={port}
          side="output"
          index={i}
          onPointerDown={e => onOutputPointerDown(e, port.id, port.type)}
        />
      ))}
    </div>
  );
}

function PortDot({
  nodeId,
  port,
  side,
  index,
  isTarget,
  onPointerDown,
  onPointerUp,
}: {
  nodeId: string;
  port: Port;
  side: 'input' | 'output';
  index: number;
  isTarget?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerUp?: () => void;
}) {
  const color = PORT_TYPE_COLOR[port.type] ?? 'var(--color-border-emphasized)';
  return (
    <span
      title={`${port.name} (${port.type})`}
      data-node-id={nodeId}
      data-port-id={port.id}
      data-port-side={side}
      // Stop propagation either way so grabbing a port never drags the node.
      onPointerDown={onPointerDown ?? (e => e.stopPropagation())}
      onPointerUp={onPointerUp}
      style={{
        position: 'absolute',
        [side === 'input' ? 'insetInlineStart' : 'insetInlineEnd']: -5,
        insetBlockStart: PORT_TOP_OFFSET + index * PORT_SPACING - 5,
        inlineSize: 10,
        blockSize: 10,
        borderRadius: '50%',
        backgroundColor: isTarget ? color : 'var(--color-background-card)',
        border: `2px solid ${color}`,
        // color-mix, not `${color}33` — appending alpha hex to a var() is invalid CSS.
        boxShadow: isTarget ? `0 0 0 4px color-mix(in srgb, ${color} 30%, transparent)` : undefined,
        cursor: side === 'output' ? 'crosshair' : 'pointer',
      }}
    />
  );
}
