import {AppShell} from '@astryxdesign/core/AppShell';
import {TopNav} from '@astryxdesign/core/TopNav';
import {Grid} from '@astryxdesign/core/Grid';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';

import {BrandGateBanner} from '@/components/brand/BrandGateBanner';
import {PegLogo} from '@/components/brand/PegLogo';
import {CreditsPill} from '@/components/chrome/CreditsPill';
import {WorkflowCard} from '@/components/gallery/WorkflowCard';
import {TemplateCard} from '@/components/gallery/TemplateCard';
import {listWorkflows} from '@/lib/workflow-service';
import {NEW_WORKFLOW_ID, TEMPLATES} from '@/lib/mock-data';

/**
 * Project gallery.
 *
 * Archetype: media library / gallery — AppShell + TopNav with a card grid, per
 * `astryx docs layout`. Cards are the right container here (self-contained
 * gallery entries), unlike the dense rows used for tabular data.
 */
export default function GalleryPage() {
  const workflows = listWorkflows();

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
            Brand-locked key visuals, composed for every breakpoint. Each run writes its asset and signed
            lineage to storage.
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
            <Heading level={2}>Recent projects</Heading>
            <Text type="supporting">{workflows.length} projects</Text>
          </HStack>
          <Grid columns={{minWidth: 280, repeat: 'fit'}} gap={4}>
            {workflows.map(workflow => (
              <WorkflowCard key={workflow.id} workflow={workflow} />
            ))}
          </Grid>
        </VStack>
      </VStack>
    </AppShell>
  );
}
