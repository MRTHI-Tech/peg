'use client';

import {useState} from 'react';
import {Eraser, Lock, LockOpen, Pencil, Play, Sparkles, Trash2} from 'lucide-react';

import {Button} from '@astryxdesign/core/Button';
import {DialogHeader, useImperativeDialog} from '@astryxdesign/core/Dialog';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {MoreMenu} from '@astryxdesign/core/MoreMenu';
import {HStack} from '@astryxdesign/core/Stack';
import {Spinner} from '@astryxdesign/core/Spinner';
import {TextInput} from '@astryxdesign/core/TextInput';

import {PORT_SPACING, PORT_TOP_OFFSET, PORT_TYPE_COLOR} from '@/lib/canvas-geometry';
import {isExecutableNode} from '@/lib/graph-execution';
import type {Port, PegNode} from '@/lib/types';

import {NODE_HEADER_HEIGHT} from './node-metrics';

/** Transparent grab/drop area around each port dot. */
const HIT_SIZE = 24;

interface Props {
  node: PegNode;
  isSelected: boolean;
  zoom: number;
  /** Media type of an in-flight connection, used to highlight valid targets. */
  pendingType?: string;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onOutputPointerDown: (e: React.PointerEvent, portId: string, type: string) => void;
  onRun: () => void;
  onClear: () => void;
  onRename: (title: string) => void;
  onToggleLock: () => void;
  onDelete: () => void;
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
  onRun,
  onClear,
  onRename,
  onToggleLock,
  onDelete,
}: Props) {
  const ring = isSelected ? 'var(--color-accent)' : STATUS_RING[node.status];
  const isTextNode = node.text != null;
  const isBusy = node.status === 'queued' || node.status === 'running';
  const referenceImage = node.type === 'reference' ? String(node.params.image ?? '') : '';
  const previewUrl = node.result?.url || referenceImage;
  const renameDialog = useImperativeDialog({purpose: 'form', width: 400});

  const openRenameDialog = () => {
    renameDialog.show(
      <RenameNodeDialog
        initialTitle={node.title}
        onRename={onRename}
        onClose={() => renameDialog.hide()}
      />,
    );
  };

  return (
    <>
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
      {/* Keep visual content inside the card curve without clipping the ports. */}
      <div style={{borderRadius: 'inherit', overflow: 'hidden'}}>
        {/* ----------------------------------------------------------- header */}
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
            {isBusy && <Spinner size="sm" />}
            <span onPointerDown={e => e.stopPropagation()}>
              <MoreMenu
                label={`${node.title} actions`}
                size="sm"
                items={[
                  {label: 'Clear', icon: Eraser, onClick: onClear},
                  {label: 'Rename', icon: Pencil, onClick: openRenameDialog},
                  {
                    label: node.isLocked ? 'Unlock' : 'Lock',
                    icon: node.isLocked ? LockOpen : Lock,
                    onClick: onToggleLock,
                  },
                  {type: 'divider'},
                  {label: 'Delete', icon: Trash2, onClick: onDelete},
                ]}
              />
            </span>
          </HStack>
        </HStack>

        {/* ------------------------------------------------------------- body */}
        {isTextNode ? (
          <div
            style={{
              minBlockSize: 96,
              padding: 'var(--spacing-2)',
              maxBlockSize: 180,
              overflow: 'hidden',
            }}>
            <Text type="supporting" color="secondary" maxLines={9}>
              {node.text}
            </Text>
          </div>
        ) : previewUrl ? (
          <div style={{position: 'relative', lineHeight: 0}}>
            {/* eslint-disable-next-line @next/next/no-img-element -- data-URI placeholder */}
            <img
              src={previewUrl}
              alt={referenceImage && !node.result ? `${node.title} image` : `${node.title} output`}
              draggable={false}
              style={{
                inlineSize: '100%',
                aspectRatio:
                  node.result?.width && node.result.height
                    ? `${node.result.width} / ${node.result.height}`
                    : referenceImage
                      ? '16 / 10'
                      : '1 / 1',
                objectFit: 'cover',
                display: 'block',
              }}
            />
          </div>
        ) : (
          <div
            style={{
              blockSize: 96,
              display: 'grid',
              placeItems: 'center',
              padding: 'var(--spacing-2)',
              backgroundColor: 'var(--color-background-muted)',
            }}>
            {node.status === 'error' ? (
              <Text type="supporting" color="primary" maxLines={4} style={{color: 'var(--color-error)'}}>
                {node.error ?? 'Run failed'}
              </Text>
            ) : (
              <Text type="supporting" color="disabled">
                {isBusy ? 'Generating…' : 'No output yet'}
              </Text>
            )}
          </div>
        )}

        {/* ----------------------------------------------------------- footer */}
        {/* Only model-backed nodes can run. Brand nodes (Style Kit, Format,
            Product Asset) carry constraints, so offering them a Run button
            promises something that would silently do nothing. */}
        {!isTextNode && isExecutableNode(node) && (
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
            <button
              type="button"
              // The card itself starts a drag on pointerdown, so the button has to
              // claim the event before it bubbles.
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation();
                onRun();
              }}
              disabled={isBusy}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-0-5)',
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: isBusy ? 'progress' : 'pointer',
                color: 'inherit',
              }}>
              <Icon icon={Play} size="xsm" color={isBusy ? 'disabled' : 'accent'} />
              <Text type="supporting" color={isBusy ? 'disabled' : 'accent'}>
                {isBusy ? 'Running…' : 'Run'}
              </Text>
            </button>
          </HStack>
        )}
      </div>

      {/* --------------------------------------------------------------- ports */}
      {node.inputs.map((port, i) => (
        <PortDot
          key={port.id}
          nodeId={node.id}
          port={port}
          side="input"
          index={i}
          isTarget={pendingType === port.type}
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
      {renameDialog.element}
    </>
  );
}

function RenameNodeDialog({
  initialTitle,
  onRename,
  onClose,
}: {
  initialTitle: string;
  onRename: (title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const trimmedTitle = title.trim();

  const save = () => {
    if (!trimmedTitle) return;
    onRename(trimmedTitle);
    onClose();
  };

  return (
    <Layout
      header={<DialogHeader title="Rename node" onOpenChange={onClose} />}
      content={
        <LayoutContent>
          <TextInput
            label="Node name"
            value={title}
            onChange={setTitle}
            hasAutoFocus
            isRequired
            width="100%"
          />
        </LayoutContent>
      }
      footer={
        <LayoutFooter>
          <HStack gap={2} justify="end">
            <Button label="Cancel" variant="secondary" onClick={onClose} />
            <Button label="Rename" variant="primary" isDisabled={!trimmedTitle} onClick={save} />
          </HStack>
        </LayoutFooter>
      }
    />
  );
}

function PortDot({
  nodeId,
  port,
  side,
  index,
  isTarget,
  onPointerDown,
}: {
  nodeId: string;
  port: Port;
  side: 'input' | 'output';
  index: number;
  isTarget?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const color = PORT_TYPE_COLOR[port.type] ?? 'var(--color-border-emphasized)';
  // The visible dot is 10px, but a 10px drop target is close to unhittable once
  // the canvas is zoomed out — so the hit area is HIT_SIZE and transparent, and
  // the dot is drawn inside it. The data attributes live on the hit area
  // because that is what elementFromPoint will find on release.
  const inset = -(HIT_SIZE / 2);
  return (
    <span
      title={`${port.name} (${port.type})`}
      data-node-id={nodeId}
      data-port-id={port.id}
      data-port-side={side}
      // Stop propagation either way so grabbing a port never drags the node.
      onPointerDown={onPointerDown ?? (e => e.stopPropagation())}
      style={{
        position: 'absolute',
        [side === 'input' ? 'insetInlineStart' : 'insetInlineEnd']: inset,
        insetBlockStart: PORT_TOP_OFFSET + index * PORT_SPACING - HIT_SIZE / 2,
        inlineSize: HIT_SIZE,
        blockSize: HIT_SIZE,
        display: 'grid',
        placeItems: 'center',
        // Above the card's own content, so a port is grabbable as well as
        // droppable. The drop path does not rely on this, but the grab does.
        zIndex: 1,
        cursor: side === 'output' ? 'crosshair' : 'pointer',
      }}>
      <span
        style={{
          inlineSize: 10,
          blockSize: 10,
          borderRadius: '50%',
          backgroundColor: isTarget ? color : 'var(--color-background-card)',
          border: `2px solid ${color}`,
          // color-mix, not `${color}33` — appending alpha hex to a var() is invalid CSS.
          boxShadow: isTarget
            ? `0 0 0 4px color-mix(in srgb, ${color} 30%, transparent)`
            : undefined,
          // The dot must never swallow the release; only the hit area is tested.
          pointerEvents: 'none',
        }}
      />
    </span>
  );
}
