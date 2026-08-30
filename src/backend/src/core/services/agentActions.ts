import { gcsPath, type AgentAction } from '@proteus/schema';
import type { Repositories } from '../repositories';
import type { BlobStore } from '../../integrations/storage/blobs';

/**
 * Writes the audit row for one model call.
 *
 * The shape is declared here rather than imported from `agent/`, because
 * `core/` may not depend on the agent layer. The decorator that produces it
 * lives in `agent/model.ts` and the two are joined in `worker/`, which is
 * allowed to see both.
 */
export interface RecordedModelCall {
  purpose: string;
  system?: string;
  prompt: string;
  model: string;
  status: 'SUCCESS' | 'ERROR';
  error?: string;
  output?: unknown;
  promptTokens: number;
  outputTokens: number;
  latencyMs: number;
  startedAt: Date;
  endedAt: Date;
}

/**
 * Beyond this the prompt goes to blob storage instead of the document.
 *
 * A migration prompt carries whole source files and can run to tens of
 * kilobytes; a few hundred of them would make the collection unpleasant to
 * query for the one field anyone reads. Mongo's own 16MB limit is far away —
 * this is about keeping the audit trail usable, not about fitting.
 */
const INLINE_LIMIT = 60_000;

export class AgentActionRecorder {
  private n = 0;

  constructor(
    private readonly repos: Repositories,
    /**
     * Optional: without it an oversized prompt is truncated in the document
     * rather than spilled. Discovery has no blob store and its prompts are
     * small; refusing to record them for want of a bucket would be the wrong
     * trade.
     */
    private readonly blobs: BlobStore | undefined,
    private readonly context: {
      projectId: string;
      migrationRunId?: string;
      attemptId?: string;
    },
  ) {}

  /**
   * Never throws and never blocks the caller.
   *
   * A migration must not fail because its audit row could not be written, and a
   * model call must not wait on a database round trip to return.
   */
  record(call: RecordedModelCall): void {
    void this.write(call).catch(() => undefined);
  }

  private async write(call: RecordedModelCall): Promise<void> {
    const agentActionId = `act_${this.context.projectId}_${Date.now().toString(36)}_${++this.n}`;

    const oversized = call.prompt.length > INLINE_LIMIT;
    let promptGcsUri: string | undefined;
    if (oversized && this.blobs) {
      promptGcsUri = (await this.blobs.put(
        gcsPath.agentAction(this.context.projectId, agentActionId),
        Buffer.from(`### system\n${call.system ?? ''}\n\n### prompt\n${call.prompt}`, 'utf8'),
        'text/plain; charset=utf-8',
      ).catch(() => undefined))?.gcsUri;
    }

    const doc = {
      _schemaVersion: 1,
      createdAt: call.startedAt,
      updatedAt: new Date(),
      agentActionId,
      projectId: this.context.projectId,
      ...(this.context.migrationRunId ? { migrationRunId: this.context.migrationRunId } : {}),
      ...(this.context.attemptId ? { attemptId: this.context.attemptId } : {}),
      kind: 'MODEL_TURN' as const,
      toolName: call.purpose,
      input: {
        purpose: call.purpose,
        // Truncated only when it went to GCS, and the marker says which.
        prompt: oversized ? `${call.prompt.slice(0, INLINE_LIMIT)}\n…[truncated]` : call.prompt,
        ...(call.system ? { systemBytes: call.system.length } : {}),
        promptBytes: call.prompt.length,
      },
      ...(call.output !== undefined
        ? { output: { value: call.output } as Record<string, unknown> }
        : {}),
      ...(promptGcsUri ? { promptGcsUri } : {}),
      model: {
        name: call.model,
        promptTokens: call.promptTokens,
        outputTokens: call.outputTokens,
        latencyMs: Math.max(0, Math.round(call.latencyMs)),
      },
      status: call.status,
      ...(call.error ? { error: call.error.slice(0, 2000) } : {}),
      startedAt: call.startedAt,
      endedAt: call.endedAt,
    } as unknown as AgentAction;

    await this.repos.agentActions.insert(doc);
  }
}
