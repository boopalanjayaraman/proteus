import { genkit, type GenkitBeta } from 'genkit/beta';
import { googleAI } from '@genkit-ai/googleai';
import type { z } from 'zod';

/**
 * The model, behind an interface.
 *
 * Every agent asks for structured output against a Zod schema, so what comes
 * back is either the shape the caller declared or an error. Behind an interface
 * because tests must exercise the surrounding logic — tool tables, evidence
 * classes, checkpointing — without a network call or an API key, and because a
 * test that mocks the thing under test proves nothing.
 */

export interface StructuredRequest<S extends z.ZodTypeAny> {
  system: string;
  prompt: string;
  schema: S;
  /** Recorded on the agent_action for the audit trail. */
  purpose: string;
}

export interface StructuredResponse<T> {
  output: T;
  model: string;
  promptTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ModelClient {
  generate<S extends z.ZodTypeAny>(req: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>>;
  readonly modelName: string;
}

export class GeminiClient implements ModelClient {
  private readonly ai: GenkitBeta;

  constructor(readonly modelName: string, apiKey?: string) {
    this.ai = genkit({
      plugins: [googleAI(apiKey ? { apiKey } : {})],
      model: googleAI.model(modelName),
    });
  }

  async generate<S extends z.ZodTypeAny>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>> {
    const started = Date.now();

    // Genkit 1.41 is typed against Zod 3 and this project is on Zod 4; the
    // runtime shapes are compatible but the types are not. The cast is confined
    // to this line, and the parse below is the authoritative check regardless —
    // Genkit's coercion is a convenience, our schema is the contract. See TD-009.
    const result = await this.ai.generate({
      system: req.system,
      prompt: req.prompt,
      output: { schema: req.schema as unknown as Parameters<typeof this.ai.generate>[0] extends { output?: { schema?: infer T } } ? T : never },
    });

    const output = result.output as z.infer<S> | null;
    if (output === null) {
      throw new ModelOutputError(`${req.purpose}: model returned no output matching the schema`);
    }
    // Validate again rather than trusting the plugin: this is the boundary where
    // a model's answer becomes data the system acts on.
    const parsed = req.schema.safeParse(output);
    if (!parsed.success) {
      throw new ModelOutputError(
        `${req.purpose}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    return {
      output: parsed.data,
      model: this.modelName,
      promptTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

/**
 * A model that answers from a script.
 *
 * Not a mock of the agent — the agent, its tool table and its validation all run
 * for real. Only the token generation is replaced, which is the one part a test
 * cannot meaningfully assert on anyway.
 */
export class ScriptedModel implements ModelClient {
  readonly modelName = 'scripted';
  readonly calls: Array<{ purpose: string; prompt: string }> = [];

  constructor(private readonly answers: Record<string, unknown>) {}

  async generate<S extends z.ZodTypeAny>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>> {
    this.calls.push({ purpose: req.purpose, prompt: req.prompt });
    const scripted = this.answers[req.purpose];
    if (scripted === undefined) throw new ModelOutputError(`no scripted answer for ${req.purpose}`);

    // Scripted answers go through the same validation as real ones, so a test
    // cannot accidentally assert on a shape the schema would have rejected.
    const parsed = req.schema.safeParse(scripted);
    if (!parsed.success) {
      throw new ModelOutputError(`scripted answer for ${req.purpose} does not match its schema`);
    }
    return {
      output: parsed.data, model: this.modelName,
      promptTokens: 0, outputTokens: 0, latencyMs: 0,
    };
  }
}
