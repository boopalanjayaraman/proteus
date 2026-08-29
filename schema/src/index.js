/**
 * Proteus shared data model.
 *
 * Single source of truth for the product's persisted shapes. Zod schemas here are
 * reused three ways: Mongo write validation, REST request/response contracts, and
 * Genkit tool input/output schemas — so structured Gemini output lands
 * pre-validated in exactly the shape the database stores, with no hand-written
 * mapping layer in between.
 *
 * See docs/pqc_migration_data_model_v1.md for the rationale behind each
 * collection, and requirements/ux design/v1.1/ for the screens they serve.
 */
export * from './common';
export * from './enums';
export * from './ids';
export * from './evidence';
export * from './project';
export * from './discovery';
export * from './assessment';
export * from './migration';
export * from './verification';
export * from './governance';
export * from './collections';
export * from './rules';
