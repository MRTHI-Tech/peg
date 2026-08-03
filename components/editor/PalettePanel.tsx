'use client';

import {useMemo, useState} from 'react';
import {
  Blend,
  Combine,
  Crop,
  Download,
  Eraser,
  Eye,
  Frame,
  Image as ImageIcon,
  Layers,
  Lightbulb,
  Music,
  Package,
  PaintBucket,
  Palette,
  Sparkles,
  Type,
  Upload,
  Video,
  Wand2,
} from 'lucide-react';

import {LayoutPanel} from '@astryxdesign/core/Layout';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Grid} from '@astryxdesign/core/Grid';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Badge} from '@astryxdesign/core/Badge';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Tooltip} from '@astryxdesign/core/Tooltip';

import {CATALOG, CATEGORY_LABELS, isLive} from '@/lib/catalog';
import {PORT_TYPE_COLOR} from '@/lib/canvas-geometry';
import type {NodeCategory, NodeDef} from '@/lib/types';

import type {RailSection} from './IconRail';

/** Rail sections that map onto one or more catalog categories. */
const SECTION_CATEGORIES: Record<string, NodeCategory[]> = {
  brand: ['brand'],
  'image-models': ['image-models'],
  edit: ['edit'],
  'text-tools': ['text-tools'],
  'video-models': ['video-models', 'audio-models'],
  helpers: ['helpers'],
};

const SECTION_TITLES: Record<string, string> = {
  brand: 'Brand',
  'image-models': 'Image Models',
  edit: 'Edit',
  'text-tools': 'Text tools',
  'video-models': 'Motion & Audio',
  helpers: 'Helpers',
  search: 'Search',
  history: 'History',
  projects: 'Projects',
};

const SECTION_SUBTITLES: Record<string, string> = {
  brand: 'Lock the look, the product, and the canvas',
  'image-models': 'Generate on-brand plates',
  edit: 'Extend, clean up, and composite',
  'text-tools': 'Turn a brief into art direction',
  'video-models': 'Not wired up yet',
  helpers: 'Move assets in and out of B2',
};

/** Per-node-type glyphs. Falls back to a category glyph. */
const TYPE_ICONS: Record<string, typeof Sparkles> = {
  'style-kit': Palette,
  'product-asset': Package,
  format: Frame,
  'scene-generate': ImageIcon,
  'flux-kontext': Sparkles,
  'fibo-blend': Blend,
  'reve-remix': Combine,
  'seededit-i2i': Crop,
  genfill: PaintBucket,
  eraser: Eraser,
  relight: Lightbulb,
  composite: Layers,
  prompt: Type,
  'prompt-enhancer': Wand2,
  'style-describer': Eye,
  import: Upload,
  export: Download,
  preview: Eye,
};

const CATEGORY_ICONS: Record<NodeCategory, typeof Sparkles> = {
  brand: Palette,
  'image-models': ImageIcon,
  edit: Layers,
  'text-tools': Type,
  'video-models': Video,
  'audio-models': Music,
  helpers: Wand2,
};

interface Props {
  section: RailSection;
  onAddNode: (type: string) => void;
  onCategoryChange: (category: string) => void;
}

export function PalettePanel({section, onAddNode}: Props) {
  const [query, setQuery] = useState('');

  const isSearch = section === 'search' || query.trim().length > 0;

  const groups = useMemo(() => {
    if (isSearch) {
      const q = query.trim().toLowerCase();
      const matches = q
        ? CATALOG.filter(
            def =>
              def.title.toLowerCase().includes(q) ||
              def.provider?.toLowerCase().includes(q) ||
              def.model?.toLowerCase().includes(q) ||
              def.description?.toLowerCase().includes(q),
          )
        : CATALOG;
      return [{category: 'results' as const, label: `${matches.length} results`, items: matches}];
    }

    const categories = SECTION_CATEGORIES[section] ?? [];
    return categories.map(category => ({
      category,
      label: CATEGORY_LABELS[category],
      items: CATALOG.filter(def => def.category === category),
    }));
  }, [isSearch, query, section]);

  const showsCatalog = isSearch || SECTION_CATEGORIES[section] != null;

  return (
    <LayoutPanel
      width={232}
      hasDivider
      isScrollable
      padding={0}
      label={SECTION_TITLES[section] ?? 'Palette'}>
      <VStack gap={2} padding={2}>
        <TextInput
          label="Search nodes"
          isLabelHidden
          placeholder="Search"
          size="sm"
          value={query}
          onChange={setQuery}
          hasClear
        />

        {!showsCatalog ? (
          <EmptyState
            title={SECTION_TITLES[section]}
            description="Nothing here yet in this prototype."
            isCompact
          />
        ) : (
          <VStack gap={3}>
            {!isSearch && SECTION_SUBTITLES[section] && (
              <VStack gap={0}>
                <Text type="label" color="primary">
                  {SECTION_TITLES[section]}
                </Text>
                <Text type="supporting" color="disabled">
                  {SECTION_SUBTITLES[section]}
                </Text>
              </VStack>
            )}

            {groups.map(group => (
              <VStack gap={1} key={group.category}>
                {(isSearch || groups.length > 1) && (
                  <Text type="supporting" color="secondary">
                    {group.label}
                  </Text>
                )}
                <Grid columns={2} gap={1}>
                  {group.items.map(def => (
                    <PaletteTile key={def.type} def={def} onClick={() => onAddNode(def.type)} />
                  ))}
                </Grid>
                {group.items.length === 0 && (
                  <Text type="supporting" color="disabled">
                    No matching nodes.
                  </Text>
                )}
              </VStack>
            ))}
          </VStack>
        )}
      </VStack>
    </LayoutPanel>
  );
}

function PaletteTile({def, onClick}: {def: NodeDef; onClick: () => void}) {
  const glyph = TYPE_ICONS[def.type] ?? CATEGORY_ICONS[def.category];
  const outputType = def.outputs[0]?.type;
  const live = isLive(def);
  const tooltip = live ? (def.description ?? def.title) : `${def.title} — coming soon`;

  return (
    <Tooltip content={tooltip} placement="end" alignment="start" hasHoverIndication={false}>
      <button
        type="button"
        onClick={live ? onClick : undefined}
        disabled={!live}
        aria-disabled={!live}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-1)',
          alignItems: 'flex-start',
          padding: 'var(--spacing-1-5)',
          minBlockSize: 70,
          backgroundColor: 'var(--color-background-card)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-element)',
          cursor: live ? 'pointer' : 'not-allowed',
          opacity: live ? 1 : 0.55,
          textAlign: 'start',
          color: 'inherit',
          // Grid items default to min-content width, so long job names need an
          // explicit escape hatch to keep both columns inside the panel.
          minInlineSize: 0,
          overflow: 'hidden',
        }}>
        <HStack gap={1} align="center" justify="between" style={{inlineSize: '100%'}}>
          <Icon icon={glyph} size="xsm" color={live ? 'secondary' : 'disabled'} />
          {outputType && live && (
            <span
              aria-hidden="true"
              style={{
                inlineSize: 6,
                blockSize: 6,
                borderRadius: '50%',
                backgroundColor: PORT_TYPE_COLOR[outputType] ?? 'var(--color-border-emphasized)',
              }}
            />
          )}
        </HStack>
        <Text type="supporting" color={live ? 'primary' : 'disabled'} maxLines={2}>
          {def.title}
        </Text>
        {!live && <Badge variant="neutral" label="Soon" />}
      </button>
    </Tooltip>
  );
}
