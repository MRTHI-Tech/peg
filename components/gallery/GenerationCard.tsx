'use client';

import {Layers} from 'lucide-react';

import {ClickableCard} from '@astryxdesign/core/ClickableCard';
import {AspectRatio} from '@astryxdesign/core/AspectRatio';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';

import type {Generation} from '@/lib/generations';

/**
 * One completed run, as stored.
 *
 * Unlike WorkflowCard this is backed by real objects in B2, so there is no
 * fixture name to show — the run id and its date are what actually exist. A
 * friendlier title needs the manifest, which would be one GET per card.
 */
export function GenerationCard({generation}: {generation: Generation}) {
  return (
    <ClickableCard
      label={`Open generation ${generation.run_id}`}
      href={`/project/${generation.run_id}`}
      padding={0}
      elevation="low">
      <VStack gap={0}>
        <AspectRatio ratio={16 / 10} fit="cover">
          {/* eslint-disable-next-line @next/next/no-img-element -- presigned B2 URL */}
          <img
            src={generation.url}
            alt=""
            style={{width: '100%', height: '100%', objectFit: 'cover', display: 'block'}}
          />
        </AspectRatio>
        <VStack gap={0.5} padding={3}>
          <Text type="body" weight="semibold" maxLines={1}>
            {generation.run_id}
          </Text>
          <HStack gap={1.5} align="center">
            <Icon icon={Layers} size="xsm" color="secondary" />
            <Text type="supporting" color="secondary">
              {/* The date comes from the storage key, already YYYY-MM-DD. Rendered
                  as-is rather than through Timestamp: locale formatting of a
                  date-only string is exactly the en-US/en-GB hydration trap. */}
              {generation.asset_count}{' '}
              {generation.asset_count === 1 ? 'asset' : 'assets'} · {generation.created_at}
            </Text>
          </HStack>
        </VStack>
      </VStack>
    </ClickableCard>
  );
}
