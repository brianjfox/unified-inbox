import { type } from "arktype";
import { ConversationState } from "@inbox/shared/schema";
import { CONVERSATION_ARTIFACT_KIND } from "@inbox/shared/protocol";
import type { ArtifactListItem, RelayClient } from "@inbox/shared/relay-client";
import { openBlob } from "@inbox/shared/crypto";

export type KnownVersion = (artifactId: string) => number | undefined;

export type SyncPlan = {
  /** Artifact ids to fetch, in the order the relay listed them. */
  fetch: string[];
  /** True once the page reached an artifact already cached at its listed version. */
  reachedKnown: boolean;
};

/**
 * The sync diff. The relay lists artifacts newest-updated first, and every
 * change bumps `updatedAt`, so the first listed artifact whose (id, version)
 * is already cached marks the point past which nothing changed: everything
 * before it is new or revised and gets fetched; the walk stops there.
 */
export function planSync(page: readonly Pick<ArtifactListItem, "id" | "version" | "archivedAt">[], known: KnownVersion): SyncPlan {
  const fetch: string[] = [];
  for (const item of page) {
    if (item.archivedAt) continue;
    if (known(item.id) === item.version) return { fetch, reachedKnown: true };
    fetch.push(item.id);
  }
  return { fetch, reachedKnown: false };
}

export type ChangedConversation = { artifactId: string; version: number; state: ConversationState };

export type PullResult = { changed: ChangedConversation[]; problems: string[] };

export function conversationKey(state: Pick<ConversationState, "service" | "conversationId">): string {
  return `${state.service}:${state.conversationId}`;
}

/**
 * One sync pass: page through the relay's listing until the plan says the
 * rest is known, fetch each changed artifact, open it with the inbox key and
 * validate it against the shared schema. A blob that will not open or does
 * not validate is reported, never cached.
 */
export async function pullChanges(relay: RelayClient, inboxKey: string, known: KnownVersion, pageSize = 100): Promise<PullResult> {
  const changed: ChangedConversation[] = [];
  const problems: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res: { artifacts: ArtifactListItem[]; nextCursor: string | null } = await relay.listArtifacts({ kind: CONVERSATION_ARTIFACT_KIND, limit: pageSize, cursor });
    const plan = planSync(res.artifacts, known);
    for (const id of plan.fetch) {
      const { artifact } = await relay.getArtifact(id);
      let opened: unknown;
      try {
        opened = openBlob(inboxKey, artifact.content);
      } catch (err) {
        problems.push(`Conversation ${id} v${artifact.version} did not open: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const state = ConversationState(opened);
      if (state instanceof type.errors) {
        problems.push(`Conversation ${id} v${artifact.version} is not a valid conversation: ${state.summary}`);
        continue;
      }
      changed.push({ artifactId: artifact.id, version: artifact.version, state });
    }
    if (plan.reachedKnown || !res.nextCursor || res.artifacts.length === 0) break;
    cursor = res.nextCursor;
  }
  return { changed, problems };
}
