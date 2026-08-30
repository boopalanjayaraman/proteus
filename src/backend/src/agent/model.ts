import { genkit, type GenkitBeta } from 'genkit/beta';
// Both backends from one package. The older `@genkit-ai/vertexai` refuses the
// `global` location, which is the only place newer Gemini models are served —
// the plugin says so itself and names this package as the replacement.
import { googleAI, vertexAI } from '@genkit-ai/google-genai';
import { z } from 'zod';

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

/**
 * Where the model is reached, and how it authenticates.
 *
 * `API_KEY`  → generativelanguage.googleapis.com with a Gemini API key.
 * `VERTEX`   → Vertex AI in a GCP project, with application-default credentials
 *              and no key at all.
 *
 * The two are genuinely different endpoints with different auth, quotas and
 * model ids. `GOOGLE_GENAI_USE_VERTEXAI` chose between them in configuration
 * long before anything here honoured it — the key was passed regardless, so a
 * deployment that asked for Vertex still called the API-key endpoint and failed
 * on the key rather than on anything it had configured.
 */
export type ModelBackend =
  | { kind: 'API_KEY'; apiKey?: string }
  /** Vertex requires a region; there is no global endpoint to fall back to. */
  | { kind: 'VERTEX'; projectId?: string; location: string };

export class GeminiClient implements ModelClient {
  private readonly ai: GenkitBeta;
  readonly backend: ModelBackend['kind'];

  constructor(readonly modelName: string, backend: ModelBackend) {
    this.backend = backend.kind;

    if (backend.kind === 'VERTEX') {
      // No API key anywhere in this branch: Vertex authenticates with the
      // service account Cloud Run attaches, or with `gcloud auth
      // application-default login` locally.
      this.ai = genkit({
        plugins: [vertexAI({
          location: backend.location,
          ...(backend.projectId ? { projectId: backend.projectId } : {}),
        })],
        model: vertexAI.model(modelName),
      });
      return;
    }

    const apiKey = backend.kind === 'API_KEY' ? backend.apiKey : undefined;
    this.ai = genkit({
      plugins: [googleAI(apiKey ? { apiKey } : {})],
      model: googleAI.model(modelName),
    });
  }

  async generate<S extends z.ZodTypeAny>(
    req: StructuredRequest<S>,
  ): Promise<StructuredResponse<z.infer<S>>> {
    const started = Date.now();

    /**
     * The schema is converted here rather than handed over as a Zod object.
     *
     * Genkit 1.41 is typed and built against Zod 3, and this project is on
     * Zod 4. Passing a Zod 4 schema does not throw — it silently converts to
     * nothing, so the model receives no response schema at all and answers with
     * whatever field names it likes. Against a scripted model that is invisible,
     * which is why every test passed while this was broken.
     *
     * `z.toJSONSchema` produces the constraint the model is actually given.
     * The parse below is still the authoritative check: this makes the model
     * likely to comply, it does not make it trustworthy (TD-009).
     */
    const jsonSchema = z.toJSONSchema(req.schema, { target: 'draft-7' });

    const result = await this.ai.generate({
      system: req.system,
      prompt: req.prompt,
      output: { jsonSchema },
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

/**
 * One model call, as it happened.
 *
 * `GeminiClient` built the prompt, sent it, and discarded it. `agent_actions`
 * has existed since PRD-02 — with `promptGcsUri` for spilling large payloads —
 * and the report reads it and prints a count. Nothing ever wrote a row.
 *
 * The cost was not academic. Debugging a failed migration meant reconstructing
 * the agent's inputs by hand from the code, testing the reconstruction, and
 * reporting the result as though it described the system. Two runs behaved
 * differently on the same prompt template and there was no way to see why,
 * because nobody had kept what was sent.
 *
 * For a product whose claim is auditable evidence, the one artefact never
 * captured was what the agent was actually asked.
 */
export interface ModelCallRecord {
  purpose: string;
  system?: string;
  prompt: string;
  model: string;
  status: 'SUCCESS' | 'ERROR';
  error?: string;
  /** The parsed output, when the call succeeded and validated. */
  output?: unknown;
  promptTokens: number;
  outputTokens: number;
  latencyMs: number;
  startedAt: Date;
  endedAt: Date;
}

/**
 * Wraps a client so every call is recorded, including the ones that throw.
 *
 * A decorator rather than a field on `GeminiClient`, because `agent/` may not
 * reach the database: the sink is supplied by `worker/`, which may see both
 * layers. The sink never affects the call — a recorder that could fail a
 * migration by failing to record it would be worse than no recorder.
 */
export function recordingModel(
  inner: ModelClient,
  sink: (record: ModelCallRecord) => void,
): ModelClient {
  return {
    modelName: inner.modelName,
    async generate(req) {
      const startedAt = new Date();
      const emit = (r: Omit<ModelCallRecord, 'startedAt' | 'endedAt' | 'model'>) => {
        try {
          sink({ ...r, model: inner.modelName, startedAt, endedAt: new Date() });
        } catch {
          // Recording is observability, never a failure mode of the migration.
        }
      };

      try {
        const result = await inner.generate(req);
        emit({
          purpose: req.purpose,
          ...(req.system ? { system: req.system } : {}),
          prompt: req.prompt,
          status: 'SUCCESS',
          output: result.output,
          promptTokens: result.promptTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
        });
        return result;
      } catch (e) {
        // The failures are the ones most worth having: a refused schema or a
        // truncated response is invisible without the prompt that produced it.
        emit({
          purpose: req.purpose,
          ...(req.system ? { system: req.system } : {}),
          prompt: req.prompt,
          status: 'ERROR',
          error: (e as Error).message,
          promptTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt.getTime(),
        });
        throw e;
      }
    },
  };
}
