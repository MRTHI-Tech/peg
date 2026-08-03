import {AppShell} from '@astryxdesign/core/AppShell';
import {TopNav} from '@astryxdesign/core/TopNav';
import {Grid} from '@astryxdesign/core/Grid';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';

import {BrandGateBanner} from '@/components/brand/BrandGateBanner';
import {PegLogo} from '@/components/brand/PegLogo';
import {AccountControls} from '@/components/chrome/AccountControls';
import {CreditsPill} from '@/components/chrome/CreditsPill';
import {GalleryEmptyState} from '@/components/gallery/GalleryEmptyState';
import {GenerationCard} from '@/components/gallery/GenerationCard';
import {TemplateCard} from '@/components/gallery/TemplateCard';
import {listGenerations} from '@/lib/generations';
import {requireOrganization} from '@/lib/workspace';
import {NEW_WORKFLOW_ID, TEMPLATES} from '@/lib/mock-data';

/**
 * Project gallery.
 *
 * Archetype: media library / gallery — AppShell + TopNav with a card grid, per
 * `astryx docs layout`. Cards are the right container here (self-contained
 * gallery entries), unlike the dense rows used for tabular data.
 */
export default async function GalleryPage() {
  // Protection sits with the resource, not a middleware matcher. This also
  // forces an organization, so nobody starts work in a personal workspace
  // they would later lose sight of.
  await requireOrganization();

  // Real storage, not fixtures: a workspace that has generated nothing shows
  // nothing, which is the whole point of the empty state.
  const {generations, reachable} = await listGenerations();

  return (
    <AppShell
      contentPadding={0}
      variant="section"
      topNav={
        <TopNav
          label="PEG"
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
              <Button label="Brand kit" variant="ghost" size="sm" href="/brand" />
              <CreditsPill />
              <AccountControls />
              <Button
                label="New project"
                variant="primary"
                size="sm"
                href={`/project/${NEW_WORKFLOW_ID}`}
              />
            </HStack>
          }
        />
      }>
      <VStack gap={6} padding={6} width="100%" maxWidth={1440}>
        <VStack gap={1}>
          <Heading level={1} type="display-3">
            Projects
          </Heading>
          <Text type="supporting">
            Brand-locked key visuals, composed for every breakpoint. Each run writes its asset and
            signed lineage to storage.
          </Text>
        </VStack>

        <BrandGateBanner />

        <VStack gap={3}>
          <Heading level={2}>Start from a template</Heading>
          {/* 'fill' not 'fit': fit collapses empty tracks, so a single template
              card would stretch the full width of the page. */}
          <Grid columns={{minWidth: 236, max: 4, repeat: 'fill'}} gap={3}>
            {TEMPLATES.map(template => (
              <TemplateCard key={template.id} template={template} />
            ))}
          </Grid>
        </VStack>

        <Divider />

        <VStack gap={3}>
          <HStack justify="between" align="center">
            <Heading level={2}>Recent work</Heading>
            {reachable && generations.length > 0 && (
              <Text type="supporting">
                {generations.length} {generations.length === 1 ? 'generation' : 'generations'}
              </Text>
            )}
          </HStack>
          {!reachable || generations.length === 0 ? (
            <GalleryEmptyState
              reachable={reachable}
              newProjectHref={`/project/${NEW_WORKFLOW_ID}`}
            />
          ) : (
            <Grid columns={{minWidth: 280, repeat: 'fit'}} gap={4}>
              {generations.map(generation => (
                <GenerationCard key={generation.run_id} generation={generation} />
              ))}
            </Grid>
          )}
        </VStack>
      </VStack>
    </AppShell>
  );
}
