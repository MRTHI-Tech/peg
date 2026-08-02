'use client';

import {Hand, Maximize2, MousePointer2, Redo2, Undo2, ZoomIn, ZoomOut} from 'lucide-react';

import {Toolbar} from '@astryxdesign/core/Toolbar';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Icon} from '@astryxdesign/core/Icon';
import {Text} from '@astryxdesign/core/Text';
import {Divider} from '@astryxdesign/core/Divider';
import {HStack} from '@astryxdesign/core/Stack';

import {clampZoom, type Viewport} from '@/lib/canvas-geometry';

interface Props {
  viewport: Viewport;
  onViewportChange: (vp: Viewport) => void;
  onFit: () => void;
}

/** Floating toolbar pinned to the bottom center of the canvas. */
export function ZoomToolbar({viewport, onViewportChange, onFit}: Props) {
  const setZoom = (next: number) => onViewportChange({...viewport, zoom: clampZoom(next)});

  return (
    <div
      style={{
        position: 'absolute',
        insetBlockEnd: 'var(--spacing-4)',
        insetInlineStart: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: 'var(--color-background-popover)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-container)',
        boxShadow: 'var(--shadow-high)',
      }}>
      <Toolbar
        label="Canvas controls"
        size="sm"
        gap={0.5}
        startContent={
          <HStack gap={0.5} align="center">
            <IconButton
              icon={<Icon icon={MousePointer2} size="sm" />}
              label="Select tool"
              size="sm"
              variant="primary"
              tooltip="Select"
            />
            <IconButton
              icon={<Icon icon={Hand} size="sm" />}
              label="Pan tool"
              size="sm"
              variant="ghost"
              tooltip="Pan (or drag empty canvas)"
            />
            <Divider orientation="vertical" />
            <IconButton
              icon={<Icon icon={Undo2} size="sm" />}
              label="Undo"
              size="sm"
              variant="ghost"
              tooltip="Undo"
              isDisabled
            />
            <IconButton
              icon={<Icon icon={Redo2} size="sm" />}
              label="Redo"
              size="sm"
              variant="ghost"
              tooltip="Redo"
              isDisabled
            />
            <Divider orientation="vertical" />
            <IconButton
              icon={<Icon icon={ZoomOut} size="sm" />}
              label="Zoom out"
              size="sm"
              variant="ghost"
              tooltip="Zoom out"
              onClick={() => setZoom(viewport.zoom / 1.2)}
            />
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {Math.round(viewport.zoom * 100)}%
            </Text>
            <IconButton
              icon={<Icon icon={ZoomIn} size="sm" />}
              label="Zoom in"
              size="sm"
              variant="ghost"
              tooltip="Zoom in"
              onClick={() => setZoom(viewport.zoom * 1.2)}
            />
            <IconButton
              icon={<Icon icon={Maximize2} size="sm" />}
              label="Fit to view"
              size="sm"
              variant="ghost"
              tooltip="Fit to view (F)"
              onClick={onFit}
            />
          </HStack>
        }
      />
    </div>
  );
}
