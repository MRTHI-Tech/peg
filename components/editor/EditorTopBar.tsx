'use client';

import {ChevronDown, Play, Share2} from 'lucide-react';

import {TopNav} from '@astryxdesign/core/TopNav';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Link} from '@astryxdesign/core/Link';

import {PegLogo} from '@/components/brand/PegLogo';
import {CreditsPill} from '@/components/chrome/CreditsPill';

interface Props {
  name: string;
  onNameChange: (name: string) => void;
  nodeCount: number;
  isRunning: boolean;
  onRunAll: () => void;
}

export function EditorTopBar({name, onNameChange, nodeCount, isRunning, onRunAll}: Props) {
  return (
    <TopNav
      label="Project"
      heading={
        <HStack gap={2} align="center">
          <Link href="/" aria-label="All projects">
            <PegLogo width={22} height={22} />
          </Link>
          <TextInput
            label="Project name"
            isLabelHidden
            size="sm"
            value={name}
            onChange={onNameChange}
            width={220}
          />
        </HStack>
      }
      endContent={
        <HStack gap={2} align="center">
          <Text type="supporting" color="disabled">
            {nodeCount} nodes
          </Text>
          <Button
            label={isRunning ? 'Running workflow…' : 'Run all'}
            variant="primary"
            size="sm"
            icon={<Icon icon={Play} size="xsm" />}
            isLoading={isRunning}
            onClick={onRunAll}
          />
          <Button
            label="Tasks"
            variant="ghost"
            size="sm"
            endContent={<Icon icon={ChevronDown} size="xsm" />}
          />
          <CreditsPill />
          <Button
            label="Share"
            variant="secondary"
            size="sm"
            icon={<Icon icon={Share2} size="xsm" />}
          />
        </HStack>
      }
    />
  );
}
