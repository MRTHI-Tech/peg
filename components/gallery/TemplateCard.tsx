'use client';

import {ArrowRight} from 'lucide-react';

import {ClickableCard} from '@astryxdesign/core/ClickableCard';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';

import {placeholderImage} from '@/lib/placeholder';

interface Template {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  palette: string;
}

export function TemplateCard({template}: {template: Template}) {
  return (
    <ClickableCard label={`Start from ${template.name}`} href="/project/my-first-peg" padding={0}>
      <VStack gap={0}>
        <div
          style={{
            height: 'var(--spacing-10)',
            backgroundImage: `url("${placeholderImage({
              seed: template.id,
              palette: template.palette,
              width: 320,
              height: 80,
            })}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            borderStartStartRadius: 'var(--radius-container)',
            borderStartEndRadius: 'var(--radius-container)',
          }}
        />
        <VStack gap={1} padding={3}>
          <HStack justify="between" align="center" gap={2}>
            <Text type="body" weight="medium">
              {template.name}
            </Text>
            <Icon icon={ArrowRight} size="xsm" color="secondary" />
          </HStack>
          <Text type="supporting" maxLines={2}>
            {template.description}
          </Text>
          <Text type="supporting" color="disabled">
            {template.nodeCount} nodes
          </Text>
        </VStack>
      </VStack>
    </ClickableCard>
  );
}
