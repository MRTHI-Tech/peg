'use client';

import {Play, Sparkles, Trash2} from 'lucide-react';

import {LayoutPanel} from '@astryxdesign/core/Layout';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Selector} from '@astryxdesign/core/Selector';
import {Slider} from '@astryxdesign/core/Slider';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Switch} from '@astryxdesign/core/Switch';
import {TextArea} from '@astryxdesign/core/TextArea';
import {TextInput} from '@astryxdesign/core/TextInput';

import {getNodeDef} from '@/lib/catalog';
import type {ParamSpec, ParamValue, PegNode} from '@/lib/types';

interface Props {
  nodes: PegNode[];
  totalCost: number;
  onParamChange: (nodeId: string, key: string, value: ParamValue) => void;
  onDelete: () => void;
}

/**
 * Right-hand inspector. Shows the parameters of a single selection, or a
 * summary plus run controls when several nodes are selected.
 */
export function InspectorPanel({nodes, totalCost, onParamChange, onDelete}: Props) {
  const single = nodes.length === 1 ? nodes[0] : null;

  return (
    <LayoutPanel width={292} hasDivider isScrollable padding={0} label="Node properties">
      <VStack gap={0} style={{blockSize: '100%'}}>
        <VStack gap={3} padding={3} style={{flex: 1, overflowY: 'auto'}}>
          {nodes.length === 0 ? (
            <EmptyState
              title="Nothing selected"
              description="Select a node to edit its parameters."
              isCompact
            />
          ) : single ? (
            <SingleNodeFields node={single} onParamChange={onParamChange} />
          ) : (
            <VStack gap={2}>
              <Text type="label">{nodes.length} nodes selected</Text>
              <VStack gap={1}>
                {nodes.map(n => (
                  <HStack key={n.id} justify="between" align="center">
                    <Text type="supporting" color="primary" maxLines={1}>
                      {n.title}
                    </Text>
                    {n.cost > 0 && (
                      <Text type="supporting" color="secondary">
                        {n.cost}
                      </Text>
                    )}
                  </HStack>
                ))}
              </VStack>
            </VStack>
          )}
        </VStack>

        {nodes.length > 0 && (
          <>
            <Divider />
            <VStack gap={2} padding={3}>
              <Text type="supporting" color="secondary">
                Run selected nodes
              </Text>
              <HStack justify="between" align="center">
                <Text type="supporting" color="secondary">
                  Total cost
                </Text>
                <HStack gap={0.5} align="center">
                  <Icon icon={Sparkles} size="xsm" color="secondary" />
                  <Text type="supporting" color="primary">
                    {totalCost} credits
                  </Text>
                </HStack>
              </HStack>
              <Button
                label="Run selected"
                variant="primary"
                size="sm"
                width="100%"
                icon={<Icon icon={Play} size="xsm" />}
                isDisabled
                tooltip="Generation is not wired up yet"
              />
              <Button
                label="Delete"
                variant="ghost"
                size="sm"
                width="100%"
                icon={<Icon icon={Trash2} size="xsm" />}
                onClick={onDelete}
              />
            </VStack>
          </>
        )}
      </VStack>
    </LayoutPanel>
  );
}

function SingleNodeFields({
  node,
  onParamChange,
}: {
  node: PegNode;
  onParamChange: (nodeId: string, key: string, value: ParamValue) => void;
}) {
  const def = getNodeDef(node.type);

  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <HStack justify="between" align="center" gap={2}>
          <HStack gap={1} align="center" style={{minInlineSize: 0}}>
            <Icon icon={Sparkles} size="xsm" color="secondary" />
            <Text type="label" color="primary" maxLines={1}>
              {node.title}
            </Text>
          </HStack>
          {node.cost > 0 && (
            <Text type="supporting" color="secondary">
              {node.cost}
            </Text>
          )}
        </HStack>
        {node.provider && (
          <Text type="supporting" color="disabled">
            {node.provider}
            {node.model ? ` · ${node.model}` : ''}
          </Text>
        )}
      </VStack>

      <Divider />

      <VStack gap={3}>
        {def?.params.map(spec => (
          <ParamField
            key={spec.key}
            spec={spec}
            value={node.params[spec.key]}
            onChange={value => onParamChange(node.id, spec.key, value)}
          />
        ))}
        {def?.params.length === 0 && (
          <Text type="supporting" color="disabled">
            This node has no parameters.
          </Text>
        )}
      </VStack>

      {node.result && (
        <>
          <Divider />
          {/* Storage identity for the produced asset. Becomes a real B2 object
              key and provenance record once generation is wired up. */}
          <VStack gap={1}>
            <Text type="supporting" color="secondary">
              Output
            </Text>
            <Text type="supporting" color="disabled" maxLines={2}>
              {node.result.bucket}/{node.result.assetKey}
            </Text>
          </VStack>
        </>
      )}
    </VStack>
  );
}

function ParamField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: ParamValue | undefined;
  onChange: (value: ParamValue) => void;
}) {
  switch (spec.kind) {
    case 'select':
      return (
        <Selector
          label={spec.label}
          labelTooltip={spec.tooltip}
          size="sm"
          options={spec.options}
          value={String(value ?? spec.default)}
          onChange={onChange}
          width="100%"
        />
      );
    case 'slider':
      return (
        <Slider
          label={spec.label}
          labelTooltip={spec.tooltip}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={Number(value ?? spec.default)}
          onChange={(v: number | [number, number]) => onChange(Array.isArray(v) ? v[0] : v)}
          valueDisplay="text"
          width="100%"
        />
      );
    case 'number':
      return (
        <NumberInput
          label={spec.label}
          labelTooltip={spec.tooltip}
          size="sm"
          value={Number(value ?? spec.default)}
          onChange={onChange}
          width="100%"
        />
      );
    case 'toggle':
      return (
        <Switch
          label={spec.label}
          size="sm"
          value={Boolean(value ?? spec.default)}
          onChange={onChange}
        />
      );
    case 'text':
      return spec.multiline ? (
        <TextArea
          label={spec.label}
          size="sm"
          rows={4}
          value={String(value ?? spec.default)}
          onChange={onChange}
          width="100%"
        />
      ) : (
        <TextInput
          label={spec.label}
          size="sm"
          value={String(value ?? spec.default)}
          onChange={onChange}
          width="100%"
        />
      );
  }
}
