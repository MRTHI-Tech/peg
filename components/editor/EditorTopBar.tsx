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
  /** How many nodes the backend can actually execute. Zero disables Run all. */
  runnableCount: number;
  /** Shown when a brand is locked in, so it is visible what output is bound to. */
  brandName: string;
  isBrandReady: boolean;
  saveStatus: 'loading' | 'load-error' | 'unsaved' | 'saving' | 'saved' | 'error';
  saveError?: string;
  onRetrySave: () => void;
  onRunAll: () => void;
}

export function EditorTopBar({
  name,
  onNameChange,
  nodeCount,
  isRunning,
  runnableCount,
  brandName,
  isBrandReady,
  saveStatus,
  saveError,
  onRetrySave,
  onRunAll,
}: Props) {
  const isHydrating = saveStatus === 'loading' || saveStatus === 'load-error';

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
            isDisabled={isHydrating}
            disabledMessage="Loading the saved project"
            width={220}
          />
        </HStack>
      }
      endContent={
        <HStack gap={2} align="center">
          {saveStatus === 'load-error' ? (
            <Button
              label="Couldn't load · Retry"
              variant="ghost"
              size="sm"
              tooltip={saveError}
              onClick={onRetrySave}
            />
          ) : saveStatus === 'error' ? (
            <HStack gap={1} align="center">
              <Text type="supporting" color="accent">
                Saved on this device
              </Text>
              <Button
                label="Retry cloud save"
                variant="ghost"
                size="sm"
                tooltip={saveError}
                onClick={onRetrySave}
              />
            </HStack>
          ) : (
            <Text type="supporting" color="disabled">
              {saveStatus === 'loading'
                ? 'Loading…'
                : saveStatus === 'saving'
                  ? 'Saving…'
                  : saveStatus === 'unsaved'
                    ? 'Unsaved changes'
                    : 'Saved'}
            </Text>
          )}
          {isBrandReady ? (
            <Text type="supporting" color="disabled">
              {brandName || 'Brand'} · {nodeCount} nodes
            </Text>
          ) : (
            <Link href="/brand">
              <Text type="supporting" color="accent">
                Set up brand kit
              </Text>
            </Link>
          )}
          <Button
            label={isRunning ? 'Running workflow…' : 'Run all'}
            variant="primary"
            size="sm"
            icon={<Icon icon={Play} size="xsm" />}
            isLoading={isRunning}
            isDisabled={runnableCount === 0 || isHydrating}
            tooltip={
              !isBrandReady
                ? 'Set up your brand kit first — generation is locked to it'
                : runnableCount === 0
                  ? 'Add a model node before running the workflow'
                  : undefined
            }
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
