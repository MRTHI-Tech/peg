"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Image as ImageIcon,
  Shapes,
  Type as TypeIcon,
} from "lucide-react";

import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav } from "@astryxdesign/core/TopNav";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Icon } from "@astryxdesign/core/Icon";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Spinner } from "@astryxdesign/core/Spinner";

import { AccountControls } from "@/components/chrome/AccountControls";
import { PegLogo } from "@/components/brand/PegLogo";
import {
  COMPOSITE_KINDS,
  MAX_UPLOAD_BYTES,
  TYPE_CLASSES,
  emptyBrand,
  fetchBrand,
  guessKind,
  removeBrandAsset,
  saveBrand,
  setAssetKind,
  uploadBrandAsset,
  type Brand,
  type BrandAsset,
  type CompositeKind,
} from "@/lib/brand";

/** Wide enough for two tiles and a palette row, narrow enough to read as a form. */
const FORM_WIDTH = 720;

/** The conventional transparency backdrop, in tokens. */
const CHECKER_SQUARE = "10px";
const CHECKERBOARD = {
  backgroundColor: "var(--color-background-surface)",
  backgroundImage: `
    linear-gradient(45deg, var(--color-background-muted) 25%, transparent 25%),
    linear-gradient(-45deg, var(--color-background-muted) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--color-background-muted) 75%),
    linear-gradient(-45deg, transparent 75%, var(--color-background-muted) 75%)`,
  backgroundSize: `${CHECKER_SQUARE} ${CHECKER_SQUARE}`,
  backgroundPosition: `0 0, 0 5px, 5px -5px, -5px 0`,
} as const;

/** Progress across one drop of files. */
interface UploadState {
  lane: "style" | "composite";
  done: number;
  total: number;
}

/**
 * Take the server's assets and palette, keep the form's text.
 *
 * Every asset call returns a whole brand, and adopting it wholesale would throw
 * away a name the user has typed but not yet saved.
 */
function withServerAssets(local: Brand, server: Brand): Brand {
  return {
    ...local,
    style_references: server.style_references,
    composites: server.composites,
    palette: server.palette,
    updated_at: server.updated_at,
    is_complete: server.is_complete,
  };
}

/**
 * Brand setup: what every generation is locked against.
 *
 * The two upload lanes are deliberately separate. Style references teach the
 * model palette, lighting, and materials. Everything in the second lane is
 * composited on top of a finished plate — feeding a logo in as a style reference
 * produces garbled logo-like shapes, so the UI never invites that.
 *
 * The look is not described here. A marketing team briefs a campaign per asset,
 * on the canvas; this page is only the durable part that outlives any one brief.
 */
export function BrandSetup({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const [brand, setBrand] = useState<Brand>(emptyBrand());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [pendingAsset, setPendingAsset] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    fetchBrand()
      .then(setBrand)
      .catch((e) => setError((e as Error).message))
      .finally(() => setIsLoading(false));
  }, []);

  const uploadFiles = useCallback(
    async (files: File | File[] | null, isStyle: boolean) => {
      const list = Array.isArray(files) ? files : files ? [files] : [];
      if (list.length === 0) return;

      const lane = isStyle ? "style" : "composite";
      setUpload({ lane, done: 0, total: list.length });
      setError(null);

      // One file's failure must not strand the rest of the drop — collect and
      // report at the end, having kept everything that did land.
      const failures: string[] = [];
      for (const [index, file] of list.entries()) {
        try {
          const kind = isStyle ? "style" : guessKind(file.name);
          const { asset, brand_palette } = await uploadBrandAsset(file, kind);
          // Applied per file so tiles appear as they land, rather than the whole
          // batch arriving at once after a long silence.
          setBrand((current) =>
            isStyle
              ? {
                  ...current,
                  style_references: [...current.style_references, asset],
                  palette: brand_palette,
                }
              : { ...current, composites: [...current.composites, asset] },
          );
        } catch (e) {
          failures.push((e as Error).message);
        }
        setUpload({ lane, done: index + 1, total: list.length });
      }

      setUpload(null);
      if (failures.length > 0) setError(failures.join(" · "));
    },
    [],
  );

  const persist = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const saved = await saveBrand(brand);
      // Keeps any keystroke made while the request was in flight.
      setBrand((current) => withServerAssets(current, saved));
      setSavedAt(new Date().toLocaleTimeString());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [brand]);

  const removeAsset = useCallback(async (asset: BrandAsset) => {
    setPendingAsset(asset.asset_key);
    setError(null);
    try {
      const fresh = await removeBrandAsset(asset.asset_key);
      setBrand((current) => withServerAssets(current, fresh));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingAsset(null);
    }
  }, []);

  const relabelAsset = useCallback(
    async (asset: BrandAsset, kind: CompositeKind) => {
      // Applied optimistically: the dropdown has already moved, and snapping it
      // back for the round-trip reads as the control being broken.
      setBrand((current) => ({
        ...current,
        composites: current.composites.map((a) =>
          a.asset_key === asset.asset_key ? { ...a, kind } : a,
        ),
      }));
      try {
        const fresh = await setAssetKind(asset.asset_key, kind);
        setBrand((current) => withServerAssets(current, fresh));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );

  // Saved before navigating, not alongside: the canvas re-reads the brand on
  // mount and a race here lands there as "no brand yet".
  const saveAndContinue = useCallback(async () => {
    if (await persist()) router.push("/project/new");
  }, [persist, router]);

  const ready = brand.style_references.length > 0;
  const isBusy = upload !== null || pendingAsset !== null;

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
              {canEdit && (
                <Button
                  label={isSaving ? "Saving…" : "Save brand"}
                  variant="primary"
                  size="sm"
                  isLoading={isSaving}
                  isDisabled={isBusy}
                  onClick={persist}
                />
              )}
              <AccountControls />
            </HStack>
          }
        />
      }
    >
      <HStack justify="center" width="100%" padding={6}>
        <VStack gap={6} width="100%" maxWidth={FORM_WIDTH}>
          <VStack gap={1}>
            <Heading level={1} type="display-3">
              Brand kit
            </Heading>
            <Text type="supporting">
              Set this up once. Every asset PEG generates is locked to it — you
              describe each campaign later, on the canvas.
            </Text>
          </VStack>

          {!canEdit && (
            <Banner
              status="info"
              title="Your brand kit is managed by a workspace admin"
              description="You can see everything generation is locked to, but only an admin can change it — a edit here would alter every asset the team produces afterwards."
            />
          )}

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
              <TextInput
                label="Brand name"
                value={brand.name}
                onChange={(value) => setBrand((b) => ({ ...b, name: value }))}
                placeholder="e.g. Frame ZA"
                isDisabled={!canEdit}
                disabledMessage="Only a workspace admin can change the brand kit."
                width="100%"
              />

              <Divider />

              {/* ---------------------------------------------- style references */}
              <VStack gap={3}>
                <VStack gap={0.5}>
                  <HStack gap={1.5} align="center">
                    <Icon icon={ImageIcon} size="sm" color="secondary" />
                    <Heading level={2}>Style references</Heading>
                  </HStack>
                  <Text type="supporting">
                    Existing artwork that shows the look — palette, lighting,
                    materials. These teach generation. Colours are read from
                    them automatically.
                  </Text>
                </VStack>

                {canEdit && (
                  <FileInput
                    label="Upload style references"
                    isLabelHidden
                    mode="dropzone"
                    accept="image/*"
                    isMultiple
                    maxSize={MAX_UPLOAD_BYTES}
                    value={null}
                    isLoading={upload?.lane === "style"}
                    description={uploadHint(upload, "style")}
                    placeholder="Drop brand artwork here, or choose files"
                    onChange={() => {}}
                    changeAction={(files) => uploadFiles(files, true)}
                  />
                )}

                {brand.style_references.length > 0 && (
                  <Grid columns={{ minWidth: 150, repeat: "fill" }} gap={2}>
                    {brand.style_references.map((asset) => (
                      <AssetTile
                        key={asset.asset_key}
                        asset={asset}
                        isRemoving={pendingAsset === asset.asset_key}
                        isDisabled={isBusy}
                        canEdit={canEdit}
                        onRemove={() => removeAsset(asset)}
                      />
                    ))}
                  </Grid>
                )}

                {brand.palette.length > 0 && (
                  <VStack gap={1}>
                    <Text type="label">Extracted palette</Text>
                    <HStack gap={1} wrap="wrap">
                      {brand.palette.map((hex) => (
                        <Swatch key={hex} hex={hex} />
                      ))}
                    </HStack>
                  </VStack>
                )}
              </VStack>

              <Divider />

              {/* -------------------------------------------------- brand assets */}
              <VStack gap={3}>
                <VStack gap={0.5}>
                  <HStack gap={1.5} align="center">
                    <Icon icon={Shapes} size="sm" color="secondary" />
                    <Heading level={2}>Brand assets</Heading>
                  </HStack>
                  <Text type="supporting">
                    Logos, app screenshots, product cutouts. These get
                    composited onto finished artwork — they are never generated
                    and never used as style references, because no model redraws
                    your mark accurately.
                  </Text>
                </VStack>

                {canEdit && (
                  <FileInput
                    label="Upload brand assets"
                    isLabelHidden
                    mode="dropzone"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    isMultiple
                    maxSize={MAX_UPLOAD_BYTES}
                    value={null}
                    isLoading={upload?.lane === "composite"}
                    description={uploadHint(upload, "composite")}
                    placeholder="Drop logos, screenshots or product cutouts here"
                    onChange={() => {}}
                    changeAction={(files) => uploadFiles(files, false)}
                  />
                )}

                {brand.composites.length > 0 && (
                  <Grid columns={{ minWidth: 200, repeat: "fill" }} gap={2}>
                    {brand.composites.map((asset) => (
                      <AssetTile
                        key={asset.asset_key}
                        asset={asset}
                        isRemoving={pendingAsset === asset.asset_key}
                        isDisabled={isBusy}
                        canEdit={canEdit}
                        onRemove={() => removeAsset(asset)}
                        onKindChange={(kind) => relabelAsset(asset, kind)}
                        isTransparent
                      />
                    ))}
                  </Grid>
                )}
              </VStack>

              <Divider />

              {/* ---------------------------------------------------- typography */}
              <VStack gap={3}>
                <VStack gap={0.5}>
                  <HStack gap={1.5} align="center">
                    <Icon icon={TypeIcon} size="sm" color="secondary" />
                    <Heading level={2}>Typography</Heading>
                  </HStack>
                  <Text type="supporting">
                    The shape of your type, not the typeface — no image model
                    renders a named font. This guides the live-text layer that
                    sits over generated artwork.
                  </Text>
                </VStack>

                <Grid columns={{ minWidth: 240, repeat: "fill" }} gap={3}>
                  <Selector
                    label="Headings"
                    options={TYPE_CLASSES}
                    // Empty means unanswered, not "cleared" — passing '' through
                    // makes the selector render a clear button with nothing set.
                    value={brand.typography.heading || null}
                    isDisabled={!canEdit}
                    hasClear
                    placeholder="Choose a style"
                    onChange={(value) =>
                      setBrand((b) => ({
                        ...b,
                        typography: { ...b.typography, heading: value ?? "" },
                      }))
                    }
                    width="100%"
                  />
                  <Selector
                    label="Body"
                    options={TYPE_CLASSES}
                    value={brand.typography.body || null}
                    isDisabled={!canEdit}
                    hasClear
                    placeholder="Choose a style"
                    onChange={(value) =>
                      setBrand((b) => ({
                        ...b,
                        typography: { ...b.typography, body: value ?? "" },
                      }))
                    }
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
                    color={ready ? "success" : "disabled"}
                  />
                  <Text
                    type="supporting"
                    color={ready ? "primary" : "secondary"}
                  >
                    {ready
                      ? "Ready to generate on-brand assets."
                      : "Add at least one style reference to start generating."}
                  </Text>
                </HStack>
                {canEdit ? (
                  <Button
                    label="Save and continue"
                    variant="primary"
                    isDisabled={!ready || isBusy}
                    isLoading={isSaving}
                    onClick={saveAndContinue}
                  />
                ) : (
                  <Button
                    label="Open canvas"
                    variant="primary"
                    href="/project/new"
                  />
                )}
              </HStack>
            </>
          )}
        </VStack>
      </HStack>
    </AppShell>
  );
}

/** Progress text for a lane mid-drop; the size limit otherwise. */
function uploadHint(
  upload: UploadState | null,
  lane: "style" | "composite",
): string {
  const limit = `PNG, JPG, WebP or SVG up to ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`;
  if (upload?.lane !== lane) return limit;
  return upload.total > 1
    ? `Uploading ${upload.done + 1} of ${upload.total}…`
    : lane === "style"
      ? "Uploading and reading colours…"
      : "Uploading…";
}

function AssetTile({
  asset,
  onRemove,
  onKindChange,
  isRemoving,
  isDisabled,
  canEdit,
  isTransparent = false,
}: {
  asset: BrandAsset;
  onRemove: () => void;
  /** Present only for composites; style references have no kind to choose. */
  onKindChange?: (kind: CompositeKind) => void;
  isRemoving: boolean;
  isDisabled: boolean;
  /** Members see the kit, admins change it. */
  canEdit: boolean;
  /** Cutouts get a contain fit rather than a crop. */
  isTransparent?: boolean;
}) {
  return (
    <Card padding={0} variant="muted">
      <VStack gap={0}>
        {/* eslint-disable-next-line @next/next/no-img-element -- presigned B2 URL */}
        <img
          src={asset.url}
          alt={asset.filename}
          style={{
            inlineSize: "100%",
            aspectRatio: "4 / 3",
            objectFit: isTransparent ? "contain" : "cover",
            padding: isTransparent ? "var(--spacing-2)" : 0,
            opacity: isRemoving ? 0.4 : 1,
            display: "block",
            borderStartStartRadius: "var(--radius-container)",
            borderStartEndRadius: "var(--radius-container)",
            // Cutouts are transparent and frequently dark, which makes them
            // invisible against a dark card. The checker both lifts them off the
            // background and says "this has an alpha channel".
            ...(isTransparent ? CHECKERBOARD : null),
          }}
        />
        <VStack gap={1.5} padding={1.5}>
          {onKindChange && (
            <Selector
              isDisabled={isDisabled || !canEdit}
              label={`What ${asset.filename} is`}
              isLabelHidden
              size="sm"
              options={COMPOSITE_KINDS}
              value={asset.kind}
              onChange={(value) => onKindChange(value as CompositeKind)}
              width="100%"
            />
          )}
          <HStack gap={1} justify="between" align="center">
            <Text type="supporting" color="secondary" maxLines={1}>
              {asset.filename}
            </Text>
            {canEdit && (
              <Button
                label={isRemoving ? "Removing…" : "Remove"}
                variant="ghost"
                size="sm"
                isLoading={isRemoving}
                isDisabled={isDisabled}
                onClick={onRemove}
              />
            )}
          </HStack>
        </VStack>
      </VStack>
    </Card>
  );
}

function Swatch({ hex }: { hex: string }) {
  return (
    <HStack gap={1} align="center">
      <span
        aria-hidden="true"
        style={{
          inlineSize: 20,
          blockSize: 20,
          borderRadius: "var(--radius-inner)",
          backgroundColor: hex,
          border: "1px solid var(--color-border)",
        }}
      />
      <Text type="supporting" color="secondary" hasTabularNumbers>
        {hex}
      </Text>
    </HStack>
  );
}
