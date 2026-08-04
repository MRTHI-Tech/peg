'use client';

import {useState} from 'react';
import {Play, ShieldAlert, ShieldCheck, Sparkles, Trash2} from 'lucide-react';

import {LayoutPanel} from '@astryxdesign/core/Layout';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Selector, SelectorOption} from '@astryxdesign/core/Selector';
import {Slider} from '@astryxdesign/core/Slider';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Switch} from '@astryxdesign/core/Switch';
import {TextArea} from '@astryxdesign/core/TextArea';
import {TextInput} from '@astryxdesign/core/TextInput';
import {FileInput} from '@astryxdesign/core/FileInput';

import {getNodeDef} from '@/lib/catalog';
import {isExecutableNode} from '@/lib/graph-execution';
import type {BrandAsset} from '@/lib/brand';
import type {ParamSelectOption, ParamSpec, ParamValue, PegNode} from '@/lib/types';

/** A reference travels inside the run request, so it stays well under the brand-asset cap. */
const MAX_REFERENCE_BYTES = 7 * 1024 * 1024;

interface Props {
  nodes: PegNode[];
  totalCost: number;
  isRunning: boolean;
  isBrandReady: boolean;
  brandAssets: BrandAsset[];
  onRun: () => void;
  onParamChange: (nodeId: string, key: string, value: ParamValue) => void;
  onDelete: () => void;
}

/**
 * Right-hand inspector. Shows the parameters of a single selection, or a
 * summary plus run controls when several nodes are selected.
 */
export function InspectorPanel({
  nodes,
  totalCost,
  isRunning,
  isBrandReady,
  brandAssets,
  onRun,
  onParamChange,
  onDelete,
}: Props) {
  const single = nodes.length === 1 ? nodes[0] : null;
  const runnable = nodes.filter(isExecutableNode);

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
            <SingleNodeFields
              node={single}
              brandAssets={brandAssets}
              onParamChange={onParamChange}
            />
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
                label={isRunning ? 'Running…' : `Run ${runnable.length || ''}`.trim()}
                variant="primary"
                size="sm"
                width="100%"
                icon={<Icon icon={Play} size="xsm" />}
                isLoading={isRunning}
                isDisabled={runnable.length === 0 || !isBrandReady}
                tooltip={
                  !isBrandReady
                    ? 'Set up your brand kit first'
                    : runnable.length === 0
                      ? 'Select a model node to run'
                      : undefined
                }
                onClick={onRun}
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
  brandAssets,
  onParamChange,
}: {
  node: PegNode;
  brandAssets: BrandAsset[];
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
            brandAssets={brandAssets}
            onChange={value => onParamChange(node.id, spec.key, value)}
          />
        ))}
        {def?.params.length === 0 && (
          <Text type="supporting" color="disabled">
            This node has no parameters.
          </Text>
        )}
      </VStack>

      {node.status === 'error' && node.error && (
        <>
          <Divider />
          <VStack gap={1}>
            <Text type="supporting" color="secondary">
              Last run failed
            </Text>
            <Text type="supporting" maxLines={6} style={{color: 'var(--color-error)'}}>
              {node.error}
            </Text>
          </VStack>
        </>
      )}

      {/* A warned run still produced an asset, so this reads as an advisory
          rather than borrowing the failure block's error colour. */}
      {node.status === 'complete' && node.warnings?.length ? (
        <>
          <Divider />
          <VStack gap={1}>
            <Text type="supporting" color="secondary">
              Check before shipping
            </Text>
            {node.warnings.map(warning => (
              <Text
                key={warning}
                type="supporting"
                maxLines={6}
                style={{color: 'var(--color-warning)'}}
              >
                {warning}
              </Text>
            ))}
          </VStack>
        </>
      ) : null}

      {node.result && (
        <>
          <Divider />
          {/* Provenance is the point of the whole storage story, so it is shown
              rather than buried: where the asset lives and whether its signed
              manifest verifies. */}
          <VStack gap={1.5}>
            <HStack justify="between" align="center">
              <Text type="supporting" color="secondary">
                Output
              </Text>
              {node.result.width && node.result.height && (
                <Text type="supporting" color="disabled">
                  {node.result.width}×{node.result.height}
                </Text>
              )}
            </HStack>

            <VStack gap={0.5}>
              <Text type="supporting" color="disabled" maxLines={3}>
                {node.result.bucket}/{node.result.assetKey}
              </Text>
              {node.provenance && (
                <>
                  <Text type="supporting" color="disabled" maxLines={1}>
                    run {node.provenance.runId}
                  </Text>
                  {/* Reports exactly what Genblaze's verify() returned. `undefined`
                      means the check could not run, which is not the same as
                      verified and must never be shown as such. */}
                  <HStack gap={1} align="center">
                    <Icon
                      icon={node.provenance.verified ? ShieldCheck : ShieldAlert}
                      size="xsm"
                      color={node.provenance.verified ? 'success' : 'warning'}
                    />
                    <Text type="supporting" color="secondary">
                      {node.provenance.verified
                        ? 'Manifest verified'
                        : node.provenance.verified === false
                          ? 'Manifest failed verification'
                          : 'Manifest not verified'}
                    </Text>
                  </HStack>
                </>
              )}
            </VStack>
          </VStack>
        </>
      )}
    </VStack>
  );
}

function ParamField({
  spec,
  value,
  brandAssets,
  onChange,
}: {
  spec: ParamSpec;
  value: ParamValue | undefined;
  brandAssets: BrandAsset[];
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
          renderOption={option => {
            const configured = findSelectOption(spec.options, option.value);
            return (
              <SelectorOption
                label={option.label ?? option.value}
                description={configured?.description}
              />
            );
          }}
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
    case 'brand-asset': {
      const matching = brandAssets.filter(
        asset => !spec.assetKinds || spec.assetKinds.some(kind => kind === asset.kind),
      );
      const emptyLabel = spec.isOptional ? 'No logo' : 'Choose an uploaded asset';
      return (
        <Selector
          label={spec.label}
          labelTooltip={spec.tooltip}
          size="sm"
          options={[
            {value: '', label: emptyLabel},
            ...matching.map(asset => ({
              value: asset.asset_key,
              label: asset.filename,
              description: asset.kind === 'screenshot' ? 'App screenshot' : asset.kind,
            })),
          ]}
          value={String(value ?? spec.default)}
          onChange={onChange}
          width="100%"
        />
      );
    }
    case 'image':
      return (
        <ReferenceImageInput
          label={spec.label}
          tooltip={spec.tooltip}
          value={String(value ?? '')}
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

function findSelectOption(
  options: Extract<ParamSpec, {kind: 'select'}>['options'],
  value: string,
): ParamSelectOption | undefined {
  for (const option of options) {
    if (typeof option === 'string') continue;
    if ('type' in option && option.type === 'section') {
      const match = option.options.find(item => item.value === value);
      if (match) return match;
    } else if ('value' in option && option.value === value) {
      return option;
    }
  }
  return undefined;
}

/**
 * A reference image, held as a data URI on the node.
 *
 * Not uploaded to B2: a campaign reference is disposable — the pin you want
 * recreated this week — and the brand library is for assets that outlive a
 * campaign. It rides along with the run as `image_b64` and is never published.
 */
function ReferenceImageInput({
  label,
  tooltip,
  value,
  onChange,
}: {
  label: string;
  tooltip?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const read = async (files: File | File[] | null) => {
    const file = Array.isArray(files) ? files[0] : files;
    if (!file) return;
    if (file.size > MAX_REFERENCE_BYTES) {
      setError(`${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_REFERENCE_BYTES / 1024 / 1024}MB`);
      return;
    }
    setError(null);
    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('could not read that file'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    onChange(dataUri);
  };

  return (
    <VStack gap={1.5}>
      <FileInput
        label={label}
        labelTooltip={tooltip}
        mode="dropzone"
        accept="image/*"
        maxSize={MAX_REFERENCE_BYTES}
        value={null}
        placeholder={value ? 'Replace reference' : 'Drop a reference image'}
        status={error ? {type: 'error', message: error} : undefined}
        onChange={() => {}}
        changeAction={read}
        width="100%"
      />
      {value && (
        <VStack gap={1}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local data URI */}
          <img
            src={value}
            alt="Reference"
            style={{
              inlineSize: '100%',
              aspectRatio: '16 / 10',
              objectFit: 'cover',
              borderRadius: 'var(--radius-inner)',
              display: 'block',
            }}
          />
          <Button label="Remove reference" variant="ghost" size="sm" onClick={() => onChange('')} />
        </VStack>
      )}
    </VStack>
  );
}
