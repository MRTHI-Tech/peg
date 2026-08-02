'use client';

import {useCallback, useEffect, useState} from 'react';
import {Check, Image as ImageIcon, Shapes, Type as TypeIcon} from 'lucide-react';

import {AppShell} from '@astryxdesign/core/AppShell';
import {TopNav} from '@astryxdesign/core/TopNav';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';
import {Banner} from '@astryxdesign/core/Banner';
import {Card} from '@astryxdesign/core/Card';
import {Grid} from '@astryxdesign/core/Grid';
import {TextInput} from '@astryxdesign/core/TextInput';
import {TextArea} from '@astryxdesign/core/TextArea';
import {FileInput} from '@astryxdesign/core/FileInput';
import {Spinner} from '@astryxdesign/core/Spinner';

import {PegLogo} from '@/components/brand/PegLogo';
import {
  emptyBrand,
  fetchBrand,
  saveBrand,
  uploadBrandAsset,
  type Brand,
  type BrandAsset,
} from '@/lib/brand';

/**
 * Brand setup: what every generation is locked against.
 *
 * The two upload lanes are deliberately separate. Style references teach the
 * model palette, lighting, and materials. Logos are only ever composited on top
 * of a finished plate — feeding one in as a style reference produces garbled
 * logo-like shapes, so the UI never invites that.
 */
export function BrandSetup() {
  const [brand, setBrand] = useState<Brand>(emptyBrand());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [uploading, setUploading] = useState<'style' | 'logo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    fetchBrand()
      .then(setBrand)
      .catch(e => setError((e as Error).message))
      .finally(() => setIsLoading(false));
  }, []);

  const upload = useCallback(async (files: File | File[] | null, isLogo: boolean) => {
    const list = Array.isArray(files) ? files : files ? [files] : [];
    if (list.length === 0) return;

    setUploading(isLogo ? 'logo' : 'style');
    setError(null);
    try {
      for (const file of list) {
        await uploadBrandAsset(file, isLogo);
      }
      // Re-read rather than patching locally: the service owns palette merging.
      setBrand(await fetchBrand());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(null);
    }
  }, []);

  const persist = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      setBrand(await saveBrand(brand));
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsSaving(false);
    }
  }, [brand]);

  const removeAsset = (asset: BrandAsset, isLogo: boolean) => {
    setBrand(current =>
      isLogo
        ? {...current, logos: current.logos.filter(a => a.asset_key !== asset.asset_key)}
        : {
            ...current,
            style_references: current.style_references.filter(a => a.asset_key !== asset.asset_key),
          },
    );
  };

  const ready = brand.description.trim().length > 0 && brand.style_references.length > 0;

  return (
    <AppShell
      contentPadding={0}
      variant="section"
      topNav={
        <TopNav
          label="Brand"
          heading={
            <HStack gap={1.5} align="center">
              <PegLogo width={24} height={24} />
              <Text type="body" weight="semibold">
                PEG
              </Text>
            </HStack>
          }
          endContent={
            <HStack gap={2} align="center">
              {savedAt && (
                <Text type="supporting" color="disabled">
                  Saved {savedAt}
                </Text>
              )}
              <Button
                label={isSaving ? 'Saving…' : 'Save brand'}
                variant="primary"
                size="sm"
                isLoading={isSaving}
                onClick={persist}
              />
            </HStack>
          }
        />
      }>
      <VStack gap={6} padding={6} width="100%" maxWidth={980}>
        <VStack gap={1}>
          <Heading level={1} type="display-3">
            Brand kit
          </Heading>
          <Text type="supporting">
            Define the look once. Every asset PEG generates is locked to it.
          </Text>
        </VStack>

        {error && (
          <Banner
            status="error"
            title="Something went wrong"
            description={error}
            isDismissable
            onDismiss={() => setError(null)}
          />
        )}

        {isLoading ? (
          <HStack gap={2} align="center">
            <Spinner size="sm" />
            <Text type="supporting">Loading your brand…</Text>
          </HStack>
        ) : (
          <>
            {/* ------------------------------------------------ style references */}
            <VStack gap={3}>
              <VStack gap={0.5}>
                <HStack gap={1.5} align="center">
                  <Icon icon={ImageIcon} size="sm" color="secondary" />
                  <Heading level={2}>Style references</Heading>
                </HStack>
                <Text type="supporting">
                  Existing artwork that shows the look — palette, lighting, materials. These teach
                  generation. Colours are read from them automatically.
                </Text>
              </VStack>

              <FileInput
                label="Upload style references"
                isLabelHidden
                mode="dropzone"
                accept="image/*"
                isMultiple
                value={null}
                isLoading={uploading === 'style'}
                placeholder="Drop brand artwork here, or choose files"
                onChange={() => {}}
                changeAction={files => upload(files, false)}
              />

              {brand.style_references.length > 0 && (
                <Grid columns={{minWidth: 150, repeat: 'fill'}} gap={2}>
                  {brand.style_references.map(asset => (
                    <AssetTile
                      key={asset.asset_key}
                      asset={asset}
                      onRemove={() => removeAsset(asset, false)}
                    />
                  ))}
                </Grid>
              )}

              {brand.palette.length > 0 && (
                <VStack gap={1}>
                  <Text type="label">Extracted palette</Text>
                  <HStack gap={1} wrap="wrap">
                    {brand.palette.map(hex => (
                      <Swatch key={hex} hex={hex} />
                    ))}
                  </HStack>
                </VStack>
              )}
            </VStack>

            <Divider />

            {/* ------------------------------------------------------- the look */}
            <VStack gap={3}>
              <VStack gap={0.5}>
                <Heading level={2}>The look</Heading>
                <Text type="supporting">
                  Plain language, as you would brief a photographer. This text and the palette above
                  are prepended to every generation.
                </Text>
              </VStack>

              <TextInput
                label="Brand name"
                value={brand.name}
                onChange={value => setBrand(b => ({...b, name: value}))}
                placeholder="e.g. Frame ZA"
                width="100%"
              />
              <TextArea
                label="Look description"
                rows={4}
                value={brand.description}
                onChange={value => setBrand(b => ({...b, description: value}))}
                placeholder="Deep violet-to-magenta gradient environment, dark studio falloff, glossy reflective surfaces, hard rim light, fine particle sparkle."
                width="100%"
              />
            </VStack>

            <Divider />

            {/* ----------------------------------------------------------- logos */}
            <VStack gap={3}>
              <VStack gap={0.5}>
                <HStack gap={1.5} align="center">
                  <Icon icon={Shapes} size="sm" color="secondary" />
                  <Heading level={2}>Logos and product cutouts</Heading>
                </HStack>
                <Text type="supporting">
                  Transparent PNGs, composited onto finished artwork. These are never generated and
                  never used as style references — a model cannot redraw your mark accurately.
                </Text>
              </VStack>

              <FileInput
                label="Upload logos"
                isLabelHidden
                mode="dropzone"
                accept="image/png,image/svg+xml"
                isMultiple
                value={null}
                isLoading={uploading === 'logo'}
                placeholder="Drop logos or product cutouts here"
                onChange={() => {}}
                changeAction={files => upload(files, true)}
              />

              {brand.logos.length > 0 && (
                <Grid columns={{minWidth: 150, repeat: 'fill'}} gap={2}>
                  {brand.logos.map(asset => (
                    <AssetTile
                      key={asset.asset_key}
                      asset={asset}
                      onRemove={() => removeAsset(asset, true)}
                    />
                  ))}
                </Grid>
              )}
            </VStack>

            <Divider />

            {/* ------------------------------------------------------ typography */}
            <VStack gap={3}>
              <VStack gap={0.5}>
                <HStack gap={1.5} align="center">
                  <Icon icon={TypeIcon} size="sm" color="secondary" />
                  <Heading level={2}>Typography</Heading>
                </HStack>
                <Text type="supporting">
                  Recorded for the layout layer that sits over generated artwork. Type is never sent
                  to a model — no image model reproduces a specific typeface.
                </Text>
              </VStack>

              <Grid columns={{minWidth: 240, repeat: 'fill'}} gap={3}>
                <TextInput
                  label="Heading typeface"
                  value={brand.typography.heading}
                  onChange={value =>
                    setBrand(b => ({...b, typography: {...b.typography, heading: value}}))
                  }
                  placeholder="e.g. Outfit"
                  width="100%"
                />
                <TextInput
                  label="Body typeface"
                  value={brand.typography.body}
                  onChange={value =>
                    setBrand(b => ({...b, typography: {...b.typography, body: value}}))
                  }
                  placeholder="e.g. Inter"
                  width="100%"
                />
              </Grid>
            </VStack>

            <Divider />

            <HStack justify="between" align="center" gap={3}>
              <HStack gap={1.5} align="center">
                <Icon
                  icon={Check}
                  size="sm"
                  color={ready ? 'success' : 'disabled'}
                />
                <Text type="supporting" color={ready ? 'primary' : 'secondary'}>
                  {ready
                    ? 'Ready to generate on-brand assets.'
                    : 'Add at least one style reference and describe the look to start generating.'}
                </Text>
              </HStack>
              <Button
                label="Save and continue"
                variant="primary"
                isDisabled={!ready}
                isLoading={isSaving}
                href={ready ? '/project/new' : undefined}
                onClick={persist}
              />
            </HStack>
          </>
        )}
      </VStack>
    </AppShell>
  );
}

function AssetTile({asset, onRemove}: {asset: BrandAsset; onRemove: () => void}) {
  return (
    <Card padding={0} variant="muted">
      <VStack gap={0}>
        {/* eslint-disable-next-line @next/next/no-img-element -- presigned B2 URL */}
        <img
          src={asset.url}
          alt={asset.filename}
          style={{
            inlineSize: '100%',
            aspectRatio: '4 / 3',
            objectFit: 'cover',
            display: 'block',
            borderStartStartRadius: 'var(--radius-container)',
            borderStartEndRadius: 'var(--radius-container)',
          }}
        />
        <HStack gap={1} justify="between" align="center" padding={1.5}>
          <Text type="supporting" color="secondary" maxLines={1}>
            {asset.filename}
          </Text>
          <Button label="Remove" variant="ghost" size="sm" onClick={onRemove} />
        </HStack>
      </VStack>
    </Card>
  );
}

function Swatch({hex}: {hex: string}) {
  return (
    <HStack gap={1} align="center">
      <span
        aria-hidden="true"
        style={{
          inlineSize: 20,
          blockSize: 20,
          borderRadius: 'var(--radius-inner)',
          backgroundColor: hex,
          border: '1px solid var(--color-border)',
        }}
      />
      <Text type="supporting" color="secondary" hasTabularNumbers>
        {hex}
      </Text>
    </HStack>
  );
}
