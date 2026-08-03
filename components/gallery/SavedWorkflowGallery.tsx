'use client';

import {useEffect, useState} from 'react';

import {Grid} from '@astryxdesign/core/Grid';
import {Text} from '@astryxdesign/core/Text';

import {listSavedWorkflows} from '@/lib/workflow-service';
import type {Workflow} from '@/lib/types';

import {WorkflowCard} from './WorkflowCard';

export function SavedWorkflowGallery() {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void listSavedWorkflows().then(result => {
      if (cancelled) return;
      setWorkflows(result.workflows);
      setReachable(result.reachable);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (workflows === null) {
    return <Text type="supporting">Loading saved projects…</Text>;
  }
  if (!reachable) {
    return (
      <Text type="supporting" color="accent">
        Saved projects are temporarily unavailable while storage wakes up.
      </Text>
    );
  }
  if (workflows.length === 0) {
    return (
      <Text type="supporting" color="disabled">
        Your first canvas will appear here as soon as it autosaves.
      </Text>
    );
  }

  return (
    <Grid columns={{minWidth: 280, repeat: 'fit'}} gap={4}>
      {workflows.map(workflow => (
        <WorkflowCard key={workflow.id} workflow={workflow} />
      ))}
    </Grid>
  );
}
