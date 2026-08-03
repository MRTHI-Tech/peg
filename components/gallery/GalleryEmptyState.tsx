'use client';

import {CloudOff, Sparkles} from 'lucide-react';

import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';

/**
 * The gallery with nothing in it.
 *
 * A client component specifically so the lucide icon can be handed to Astryx's
 * `Icon`. `Icon` is itself a client component, so a server parent cannot render
 * it — React has to serialize the element, and `icon={Sparkles}` is a function.
 * The gallery page is a server component, so this has to live on this side of
 * the boundary. See the Next.js/React note in AGENTS.md.
 */
export function GalleryEmptyState({
  reachable,
  newProjectHref,
}: {
  /**
   * Whether storage answered. "You have made nothing" and "we could not reach
   * your storage" are both an empty list, and on the free tier the second
   * happens whenever the service has idled down — saying the wrong one would be
   * the app lying about what the workspace contains.
   */
  reachable: boolean;
  newProjectHref: string;
}) {
  if (!reachable) {
    return (
      <EmptyState
        title="Couldn't reach your storage"
        description="The generation service may still be waking up, which takes up to a minute on the free tier. Reload in a moment."
        icon={<Icon icon={CloudOff} size="lg" />}
      />
    );
  }

  return (
    <EmptyState
      title="Nothing generated yet"
      description="Start from a template above, or open a blank canvas. Everything you make lands here with its signed lineage."
      icon={<Icon icon={Sparkles} size="lg" />}
      actions={<Button label="New project" variant="primary" href={newProjectHref} />}
    />
  );
}
