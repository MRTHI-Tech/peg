'use client';

import {Workflow as WorkflowIcon} from 'lucide-react';

import {ClickableCard} from '@astryxdesign/core/ClickableCard';
import {AspectRatio} from '@astryxdesign/core/AspectRatio';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Timestamp} from '@astryxdesign/core/Timestamp';

import type {Workflow} from '@/lib/types';

export function WorkflowCard({workflow}: {workflow: Workflow}) {
  return (
    <ClickableCard
      label={`Open ${workflow.name}`}
      href={`/project/${workflow.id}`}
      padding={0}
      elevation="low">
      <VStack gap={0}>
        <AspectRatio ratio={16 / 10} fit="cover">
          {/* eslint-disable-next-line @next/next/no-img-element -- data-URI placeholder, not a remote asset */}
          <img
            src={workflow.thumbnailUrl}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              borderStartStartRadius: 'var(--radius-container)',
              borderStartEndRadius: 'var(--radius-container)',
            }}
          />
        </AspectRatio>
        <VStack gap={1} padding={3}>
          <Text type="body" weight="medium" maxLines={1}>
            {workflow.name}
          </Text>
          <HStack gap={2} align="center">
            <HStack gap={1} align="center">
              <Icon icon={WorkflowIcon} size="xsm" color="secondary" />
              <Text type="supporting">{workflow.nodeCount} nodes</Text>
            </HStack>
            <Text type="supporting" color="disabled">
              ·
            </Text>
            {/* system_date, not date/relative: those format in the ambient locale,
                and Node (en-US) disagrees with the browser (en-GB here), which
                fails hydration on every card. The system_* formats are
                locale-independent, so both sides render the same string. */}
            <Timestamp value={workflow.updatedAt} format="system_date" type="supporting" />
          </HStack>
        </VStack>
      </VStack>
    </ClickableCard>
  );
}
