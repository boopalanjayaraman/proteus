# Tech debt

Things that work but are not right, recorded when incurred so they are reviewed
deliberately rather than rediscovered. Sister file to `decisions.md`: a decision is a
choice awaiting your input; debt is a choice already made that we would make differently
with more time.

Each entry says what it costs to leave, which is the only number that matters when
deciding whether to pay it down.

| Severity | Meaning |
|---|---|
| `HIGH` | Will cause a defect or block an increment. Pay before the increment named. |
| `MEDIUM` | Will slow work or hide a bug. Pay when touching that area. |
| `LOW` | Untidy. Pay if convenient, or never. |

---

```yaml
version: 1
updated: 2026-08-29

debt:

  - id: TD-001
    title: Partial updates bypass schema validation
    severity: MEDIUM
    raised: 2026-08-29
    incurred_in: PRD-02
    where: src/backend/src/core/repositories/base.ts — Repository.patch()
    context: >
      Every insert validates through its Zod schema. `patch()` does not, because a
      partial cannot satisfy a whole-document schema. So a caller can write a field that
      would never survive an insert, and the guarantee "every document in this collection
      matches its schema" holds only for documents nobody has patched.
    costs: >
      A malformed value reaches the database and fails later, somewhere else, with no
      path back to the write that caused it. Exactly the failure the validation layer
      exists to prevent.
    fix: >
      Derive a partial schema per collection (`Schema.partial()`) and validate the patch
      against that. Zod supports it; it was skipped for time.
    revisit: Before PRD-05, which is the first increment to patch documents in anger.

  - id: TD-002
    title: A lost idempotency race leaves a gap in the event sequence
    severity: LOW
    raised: 2026-08-29
    incurred_in: PRD-02
    where: src/backend/src/core/repositories/events.ts — EventRepository.emit()
    context: >
      Two emitters racing on the same idempotencyKey both allocate a sequence number;
      the loser discards its event and its number. The sequence stays monotonic and
      ordered but is no longer contiguous.
    costs: >
      Nothing observable. The SSE cursor uses `seq > n`, which tolerates gaps. It only
      matters if something later assumes contiguity — counting events by max(seq), for
      instance.
    fix: >
      Allocate the sequence after winning the unique-index race rather than before.
      Requires an insert-then-number ordering that is more intricate than it is worth
      today.
    revisit: If anything starts treating seq as a count rather than a cursor.

  - id: TD-003
    title: The event sequence counter is a single-document contention point
    severity: LOW
    raised: 2026-08-29
    incurred_in: PRD-02
    where: src/backend/src/core/db/counters.ts
    context: >
      Every event write does a findOneAndUpdate against one counter document per project.
      Atomic and correct, but serialised. Measured at 1,000 concurrent writes in ~500ms,
      which is far beyond anything the product generates.
    costs: >
      None at prototype volume. A throughput ceiling that will never be approached by one
      migration run.
    fix: Batch allocation, or a per-instance block of numbers. Neither is warranted.
    revisit: Only if event write latency is ever measured as a problem.

  - id: TD-004
    title: prohibitedActions rescans all 110 rules on every call
    severity: LOW
    raised: 2026-08-29
    incurred_in: PRD-01
    where: src/backend/src/core/rules/engine.ts — RuleEngine.prohibitedActions()
    context: >
      The union of prohibited actions is computed by evaluating every rule in both files
      against the facts, with no index or short-circuit. Microseconds at this size.
    costs: >
      None today. Becomes visible if the ruleset grows an order of magnitude, or if this
      is called inside a tight loop.
    fix: Index rules by the fact keys they reference; evaluate only candidates.
    revisit: If the ruleset passes ~500 rules.

  - id: TD-005
    title: No lint, format or CI
    severity: PARTIALLY_RESOLVED
    raised: 2026-08-29
    incurred_in: PRD-01
    where: repository root
    context: >
      Typecheck and tests run only when invoked by hand. There is no ESLint config, no
      formatter, and nothing runs on push. The import rule the folder-structure document
      relies on — `core/` and `verification/` may never import `agent/` — is documented
      but unenforced.
    costs: >
      The import rule is the mechanism behind "Gemini reasons, tools establish truth". A
      documented rule nobody checks will be broken, probably by me, probably in PRD-07
      when the agent code arrives and the temptation is highest.
    fix: >
      ESLint with `import/no-restricted-paths` for the boundary, Prettier, and a GitHub
      Actions workflow running typecheck plus tests.
    revisit: Before PRD-07 — that is the increment that introduces agent code.
    resolved: 2026-08-29
    resolution: >
      The part that mattered is done. The import boundary is enforced by
      test/architecture.test.ts rather than a lint rule — eslint-plugin-import does not
      support eslint 9, and a test states the rule more directly and runs in CI with
      everything else. It found a real violation on its first run: api/sse/stream.ts
      imported the Mongo driver for a type, so the repository now returns an opaque
      Subscription handle. eslint.config.js exists for general linting.
      STILL OUTSTANDING: no CI workflow. Nothing runs on push.

  - id: TD-006
    title: The rules engine loads YAML from a relative path with no caching
    severity: LOW
    raised: 2026-08-29
    incurred_in: PRD-01
    where: src/backend/src/core/rules/loader.ts
    context: >
      Callers pass filesystem paths and every construction reparses both files. Works from
      a test and from a local run; a container with a different working directory or a
      read-only filesystem will need this resolved differently.
    costs: A confusing startup failure in a deployed container rather than a clear one.
    fix: Resolve relative to the module, and cache the parsed ruleset per path.
    revisit: Before the first Cloud Run deployment.

  - id: TD-007
    title: The fixture migration spans two files
    severity: LOW
    raised: 2026-08-29
    incurred_in: fixtures/payments-api
    where: CryptoService.wrapSessionKey and CryptoUtils.wrapKey
    context: >
      A second RSA wrap in CryptoUtils duplicates the transform, because the nightly
      export runs outside the Spring context. Deliberate — real migrations are not
      single-file — but it doubles what the agent must get right in a live demo.
    costs: >
      A second place the autonomous migration can fail in front of an audience.
    fix: >
      Remove CryptoUtils.wrapKey and route the export through CryptoService. Four lines,
      and the demo becomes more reliable and less honest at the same time.
    revisit: After the first end-to-end run. Keep it if the agent handles both cleanly.

  - id: TD-009
    title: Genkit is typed against Zod 3; this project uses Zod 4
    severity: LOW
    raised: 2026-08-29
    incurred_in: PRD-07
    where: src/backend/src/agent/model.ts
    context: >
      genkit 1.41 declares its output schema parameter as a Zod 3 type. The runtime shapes
      are compatible but the types are not, so passing our Zod 4 schema needs a cast. It is
      confined to one line.
    costs: >
      Nothing functionally — the schema is re-validated immediately afterwards with our own
      parser, which is the authoritative check regardless. The cast could hide a genuine
      shape error at that boundary, though the re-parse would catch it.
    fix: Upgrade when Genkit supports Zod 4, and delete the cast.
    revisit: On the next Genkit upgrade.

  - id: TD-008
    title: No structured logging
    severity: RESOLVED
    raised: 2026-08-29
    incurred_in: PRD-02
    where: src/backend
    context: >
      Nothing logs. The event log is the product's audit trail, not its operational one —
      when a repository write or a lease acquisition fails, there is currently no record
      outside the thrown error.
    costs: >
      Debugging a failed migration in Cloud Run means reading events that were never
      written, because the failure happened before the emitter ran.
    fix: >
      Pino, with the redaction from `redactTokens` applied to the serialiser so an
      operational log cannot leak what the event log is careful about.
    revisit: PRD-03, alongside the server bootstrap.
    resolved: 2026-08-29
    resolution: >
      src/backend/src/config/logger.ts. Pino with scrubbing at the serialiser hook plus
      key-path redaction, so neither a token in a message nor a secret in a nested object
      reaches stdout. Wired through Fastify and the startup banner.
```

---

## Not debt

Three of the five deviations recorded in PRD-02 §10 are deliberate and correct, and are
listed here only so they are not re-litigated:

- **Change-stream support is probed by opening one.** Reading `hello.setName` is
  unreliable on managed deployments that support change streams without advertising a
  replica-set name. The probe is the only honest test.
- **Redaction runs inside `Repository.prepare()`.** Applying it at each call site is what
  fails; applying it at the boundary is what makes design rule 8 hold.
- **`setLastEventSeq` refuses to move backwards.** A late write from a slow emitter would
  otherwise rewind the resume cursor and replay events the client has already rendered.
