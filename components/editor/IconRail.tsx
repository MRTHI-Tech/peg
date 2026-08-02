'use client';

import {
  Clock,
  FolderOpen,
  HelpCircle,
  Image as ImageIcon,
  Layers,
  Palette,
  Search,
  Settings,
  Type,
  Video,
  Wand2,
} from 'lucide-react';

import {IconButton} from '@astryxdesign/core/IconButton';
import {Icon} from '@astryxdesign/core/Icon';
import {VStack} from '@astryxdesign/core/Stack';
import {Divider} from '@astryxdesign/core/Divider';

import type {NodeCategory} from '@/lib/types';

export type RailSection = NodeCategory | 'search' | 'history' | 'projects';

const PRIMARY: Array<{id: RailSection; label: string; icon: typeof Search}> = [
  {id: 'search', label: 'Search nodes', icon: Search},
  {id: 'history', label: 'History', icon: Clock},
  {id: 'projects', label: 'Projects', icon: FolderOpen},
  {id: 'brand', label: 'Brand', icon: Palette},
  {id: 'image-models', label: 'Image models', icon: ImageIcon},
  {id: 'edit', label: 'Edit', icon: Layers},
  {id: 'text-tools', label: 'Text tools', icon: Type},
  {id: 'video-models', label: 'Motion & audio', icon: Video},
  {id: 'helpers', label: 'Helpers', icon: Wand2},
];

interface Props {
  active: RailSection;
  onSelect: (section: RailSection) => void;
  isPaletteOpen: boolean;
  onTogglePalette: () => void;
}

/** The 52px icon rail. Selecting an entry swaps what the palette panel shows. */
export function IconRail({active, onSelect, isPaletteOpen, onTogglePalette}: Props) {
  return (
    <VStack
      gap={0.5}
      align="center"
      paddingBlock={1.5}
      style={{
        inlineSize: 52,
        blockSize: '100%',
        borderInlineEnd: '1px solid var(--color-border)',
        backgroundColor: 'var(--color-background-surface)',
        flexShrink: 0,
      }}>
      {PRIMARY.map(item => (
        <IconButton
          key={item.id}
          icon={<Icon icon={item.icon} size="sm" />}
          label={item.label}
          size="sm"
          tooltip={item.label}
          variant={active === item.id && isPaletteOpen ? 'primary' : 'ghost'}
          onClick={() => (active === item.id ? onTogglePalette() : onSelect(item.id))}
        />
      ))}

      <div style={{flex: 1}} />
      <Divider />
      <IconButton
        icon={<Icon icon={HelpCircle} size="sm" />}
        label="Help"
        size="sm"
        variant="ghost"
        tooltip="Help"
      />
      <IconButton
        icon={<Icon icon={Settings} size="sm" />}
        label="Settings"
        size="sm"
        variant="ghost"
        tooltip="Settings"
      />
    </VStack>
  );
}
