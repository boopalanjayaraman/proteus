import { redactTokens } from '@proteus/schema';
import type { Collection, Db, Filter, OptionalUnlessRequiredId } from 'mongodb';
import type { z } from 'zod';

/**
 * A typed collection.
 *
 * Two things happen on every write and neither is optional:
 *
 *   VALIDATE  through the collection's Zod schema, so a malformed document fails
 *             at the boundary with a path rather than three reads later.
 *   REDACT    anything token-shaped, so design rule 8 holds even if a caller
 *             puts a credential somewhere it should not be. Enforcing it here
 *             rather than at each call site is the point — there is no log
 *             statement or event emitter that can forget.
 */
export class ValidationError extends Error {
  constructor(collection: string, issues: string[]) {
    super(`${collection}: ${issues.join('; ')}`);
    this.name = 'ValidationError';
  }
}

export class Repository<S extends z.ZodTypeAny, T = z.infer<S>> {
  constructor(
    protected readonly database: Db,
    public readonly name: string,
    protected readonly schema: S,
  ) {}

  get collection(): Collection<T & Document> {
    return this.database.collection(this.name) as unknown as Collection<T & Document>;
  }

  /** Validates, redacts, then inserts. */
  async insert(doc: T): Promise<T> {
    const clean = this.prepare(doc);
    await this.collection.insertOne(
      clean as unknown as OptionalUnlessRequiredId<T & Document>,
    );
    return clean;
  }

  async insertMany(docs: T[]): Promise<T[]> {
    if (docs.length === 0) return [];
    const clean = docs.map((d) => this.prepare(d));
    await this.collection.insertMany(
      clean as unknown as OptionalUnlessRequiredId<T & Document>[],
    );
    return clean;
  }

  async findOne(filter: Filter<T & Document>): Promise<T | null> {
    return (await this.collection.findOne(filter)) as T | null;
  }

  async find(filter: Filter<T & Document>, limit = 200): Promise<T[]> {
    return (await this.collection.find(filter).limit(limit).toArray()) as unknown as T[];
  }

  async count(filter: Filter<T & Document> = {} as Filter<T & Document>): Promise<number> {
    return this.collection.countDocuments(filter);
  }

  /**
   * Partial update. The patch is redacted but NOT schema-validated — a partial
   * cannot satisfy a whole-document schema. Callers changing something
   * structural should read, amend and `insert` a replacement instead.
   */
  async patch(filter: Filter<T & Document>, set: Partial<T>): Promise<boolean> {
    const r = await this.collection.updateOne(filter, {
      $set: redactTokens(set) as never,
    });
    return r.matchedCount > 0;
  }

  protected prepare(doc: T): T {
    const parsed = this.schema.safeParse(doc);
    if (!parsed.success) {
      throw new ValidationError(
        this.name,
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      );
    }
    return redactTokens(parsed.data) as T;
  }
}

type Document = Record<string, unknown>;
