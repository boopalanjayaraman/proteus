# Decisions

Open questions that need a call, in one place, so they can be reviewed periodically
instead of being rediscovered in the middle of an increment.

The list below is YAML inside a fenced block — edit it in place. Fill in `comment` and
`decision`, then move `status` and set `decided_on`. See [README.md](README.md) for the
workflow and the field meanings.

**Entries stay in this file once closed.** A decision whose reasoning is deleted becomes
a mystery six weeks later, which is the thing this file exists to prevent.

---

## At a glance

0 blocking · 13 open · 1 deferred · 5 accepted
| ID      | Title                                                                      | Status        | Category       | Blocks                 |
| ------- | -------------------------------------------------------------------------- | ------------- | -------------- | ---------------------- |
| `D-001` | The demo repository does not exist                                         | `NEEDS_INPUT` | delivery       | PRD-06, PRD-11, PRD-13 |
| `D-002` | Gemini model id is unconfirmed                                             | `ACCEPTED`    | delivery       | PRD-07                 |
| `D-003` | BehavioralInvariant cannot represent an expected change                    | `NEEDS_INPUT` | data-model     | PRD-11, PRD-13         |
| `D-004` | Genkit or ADK — the specs disagree                                         | `OPEN`        | architecture   | —                      |
| `D-005` | Four agents against the spec's "one orchestrating agent"                   | `OPEN`        | architecture   | —                      |
| `D-006` | Execution ruleset holds discovery-time rules despite its name              | `OPEN`        | architecture   | —                      |
| `D-007` | The RSA-2048 to 112-bit security strength mapping is not in the corpus     | `OPEN`        | standards      | —                      |
| `D-008` | The signature prohibition has no direct citation                           | `OPEN`        | standards      | —                      |
| `D-009` | Project creation spans MongoDB and Secret Manager with no transaction      | `OPEN`        | security       | —                      |
| `D-010` | 404 rather than 403 for a project the caller does not own                  | `OPEN`        | security       | —                      |
| `D-011` | Sandbox lifetime and teardown                                              | `OPEN`        | security       | —                      |
| `D-012` | Parameter set selection needs application context the engine does not have | `OPEN`        | product        | —                      |
| `D-013` | Material performance tradeoff has no threshold                             | `OPEN`        | product        | —                      |
| `D-014` | Partial plan approval is modelled but not in the UX                        | `OPEN`        | product        | —                      |
| `D-015` | Report format and rendering toolchain                                      | `OPEN`        | product        | —                      |
| `D-016` | MongoDB — Atlas or self-hosted                                             | `OPEN`        | infrastructure | PRD-02                 |
| `D-017` | Rotation reminders need a scheduler                                        | `DEFERRED`    | infrastructure | —                      |
| `D-018` | IR 8547 Table 5 names ML-DSA parameter sets in an ML-KEM table             | `ACCEPTED`    | standards      | —                      |

`NEEDS_INPUT` stops work on the PRDs named in **Blocks**. `OPEN` means I proceed on the
stated recommendation unless you say otherwise.

---

## The list

```yaml
# Proteus — open decisions
#
# Fill in `comment` and `decision`, then move `status`. See README.md.
# Entries are kept after closing; the reasoning is the point.

version: 1
updated: 2026-08-29

decisions:

  # ───────────────────────────────────────────────────────────── BLOCKING ──

  - id: D-001
    title: The test fixture repository does not exist
    category: delivery
    status: ACCEPTED
    raised: 2026-08-29
    blocks: [PRD-06, PRD-11, PRD-13]
    context: >
      NOT the same thing as the demo repositories shown to customers (see D-019). This is
      a frozen fixture used only by CI, never shown to anyone. It exists so acceptance
      criteria can assert exact numbers against files at known paths.
      Everything from repository access onward assumes a Java / Spring Boot application
      matching the UX scenario: CryptoService.wrapSessionKey using RSA in WRAP_MODE,
      bcprov-jdk18on 1.72 in pom.xml, a PartnerHandshakeMock that hardcodes an RSA
      public key assertion, two RSA signature usages that must be left alone, an
      RSA-signed leaf certificate, 78 unit and 6 integration tests of which none touch
      key establishment, and one pre-existing test failure. Roughly a dozen acceptance
      criteria across three PRDs assert against these specifics.
    options:
      - Build it now, before PRD-06
      - Point at a real open-source Java project and rewrite the ACs to match it
      - Stub the GitHub adapter and defer the fixture until PRD-11
    recommendation: >
      Build it. Roughly a day. A real project cannot serve this purpose: acceptance
      criteria asserting "78 unit tests, 1 pre-existing failure" need a repository that
      does not change underneath them. It must be a plausible payments service that
      happens to have the scenario's properties, not a scaffold with them bolted on — a
      fixture built to make tests pass proves nothing.
      It must NOT be special-cased. The rules were extracted from NIST documents before
      any repository existed, so the fixture validates them rather than defining them. If
      that ordering slips, the demo repositories in D-019 will expose it immediately.
    impact_if_unresolved: >
      PRD-06 cannot start. Every downstream increment inherits the block.
    comment: "Built and pushed to a standalone repo."
    decision: >
      Built as fixtures/payments-api and published to its own repository. 40 files,
      20 main classes, 13 test classes, 34 unit and 2 integration tests, verified green in
      maven:3.9-eclipse-temurin-17 and as a running container. Two failures are rigged —
      both in PartnerHandshakeIntegrationTest, in separate methods so neither masks the
      other — and about nine further details are placed to be found without failing
      anything. Doubles as the primary demo repository. Nothing published mentions
      Proteus, PQC or ML-KEM. PRD-06, PRD-11 and PRD-13 are unblocked.
    decided_on: 2026-08-29

  - id: D-019
    title: Which real repositories are used for customer demos
    category: delivery
    status: ACCEPTED
    raised: 2026-08-29
    blocks: []
    context: >
      Separate from the CI fixture in D-001. These are real GitHub repositories run in
      front of an audience, so the product must handle them without special-casing.
      Three constraints narrow the candidate list, and the second is the hard one.
      WRITE ACCESS. Proteus does not only read — it creates agent/pqc/{projectId} and
      pushes commits, which is why the create-project screen collects a PAT with
      contents read & write. Candidates must be in your organisation or forks you
      control, never upstream projects you cannot write to.
      RSA KEY TRANSPORT, NOT JUST SIGNING. Many Java projects sign with RSA; far fewer
      wrap a session key with it. A repository with only signature usage produces a
      correct but undramatic result — Proteus reports no autonomous migration in scope,
      which is the right answer and a flat demo.
      A REAL REPOSITORY MAY NOT FAIL. WOW moment 2 depends on a build breaking so the
      agent can diagnose and repair it. The fixture's mock is rigged to fail on cue; a
      real repository may migrate cleanly on the first attempt.
      Also: Java and Maven only for the prototype (spec §49), a test suite that actually
      builds and runs, and a size the discovery pass can cover in demo time.
    options:
      - Forks of real Java projects in your org, scenario left untouched
      - Forks with a deliberate seeded failure so the repair loop always demonstrates
      - Fixture for the on-rails demo, one real repository as a live follow-up
    recommendation: >
      The third. Lead with a repository that reliably shows the whole loop, then run a
      real one live to show it was not staged. Seeding a failure into a real repository
      gets the worst of both — it is neither honest nor reliably reproducible.
    impact_if_unresolved: >
      No effect on the build. Affects demo preparation and needs settling before the
      first customer showing, not before PRD-06.
    comment: "Candidates listed in docs/demo_repos_github.md. Revisit the list if needed."
    decision: >
      Candidate repositories recorded in docs/demo_repos_github.md; the fixture leads the
      on-rails demo and a real repository follows live. The list is expected to change and
      is not a build dependency — no PRD is blocked on it.
    decided_on: 2026-08-29

  - id: D-002
    title: Gemini model id is unconfirmed
    category: delivery
    status: ACCEPTED
    raised: 2026-08-29
    blocks: [PRD-07]
    context: >
      Tech Stack §2 and §3 require "Gemini 3.5 Flash or newer". I set
      GEMINI_MODEL=gemini-3.5-flash and enforce the 3.5 floor at startup, but I cannot
      verify from here that this is the live model id. If it is wrong the first agent
      call fails at runtime, not at startup.
    options:
      - Confirm the id in AI Studio or `gcloud ai models list` and set it in .env
      - Use Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=true) and confirm the id there
    recommendation: >
      Confirm before PRD-07. Only the .env value changes; the floor check parses
      whatever version is in the string.
    impact_if_unresolved: >
      No agent can run. PRD-07 onward is blocked.
    comment: "Confirmed. We will use gemini-3.5-flash or gemini-3.7-flash"
    decision: "ACCEPTED"
    decided_on: ""

  - id: D-003
    title: BehavioralInvariant cannot represent an expected change
    category: data-model
    status: ACCEPTED
    raised: 2026-08-29
    blocks: [PRD-11, PRD-13]
    context: >
      schema/src/migration.ts declares `mustHold: z.literal(true)`, so every captured
      invariant is by construction something that must be preserved. But the baseline
      also observes things the migration is SUPPOSED to change: RSA-2048 produces a
      256-byte ciphertext, ML-KEM-768 produces 1088. Recording that as an invariant
      makes BASELINE_INVARIANTS_PRESERVED fail the correct migration. Not recording it
      means a material change is absent from the report. EXEC-INV-003 already requires
      the classification; the schema cannot yet express it.
    options:
      - "Replace `mustHold: z.literal(true)` with `disposition: MUST_PRESERVE | EXPECTED_TO_CHANGE`"
      - Keep `mustHold` and add a parallel `expectedChanges` list on the baseline
      - Leave it and exclude such observations from the baseline entirely
    recommendation: >
      Option 1. One field, and it keeps every observation in one list so the report can
      show before-and-after for the things that changed. Option 3 loses evidence the
      migration report needs.
    impact_if_unresolved: >
      PRD-11 cannot capture a correct baseline; PRD-13 cannot verify one.
    comment: "Confirmed. Fix it."
    decision: >
      Option 1 applied. `mustHold: z.literal(true)` replaced with
      `disposition: MUST_PRESERVE | EXPECTED_TO_CHANGE`, plus an optional `observedAfter`
      so the report can show before-and-after for the changed set. Verification asserts
      the preserve set and reports the change set (EXEC-VER-005); the schemaNote on
      EXEC-INV-003 is resolved. Six tests pin the behaviour, including one that rejects
      the old `mustHold` field so it cannot return.
      The fixture made this concrete rather than theoretical: its integration test asserts
      the wrapped key is 256 bytes, ML-KEM-768 produces 1088, and under the old schema that
      raised a BASELINE_CONTRACT_CHANGE gate — ending the demo with one human engineering
      action instead of the zero the UX outcome tile claims.
    decided_on: 2026-08-29

  # ─────────────────────────────────────────────────── ARCHITECTURE ──

  - id: D-004
    title: Genkit or ADK — the specs disagree
    category: architecture
    status: OPEN
    raised: 2026-08-28
    blocks: []
    context: >
      Product Spec §45 labels the agent "Google ADK + Gemini". Tech Stack §2 and §7
      specify Google Genkit. ADK is strongest in Python; Genkit's JS SDK takes Zod
      schemas directly as tool definitions, which is what the whole single-source-of-truth
      schema design assumes. I followed the Tech Stack.
    options:
      - Genkit + TypeScript, as built
      - ADK + Python, which reintroduces the second runtime and a Pydantic restatement
        of ~21 collection shapes
      - Genkit now, note ADK as a post-hackathon option
    recommendation: >
      Genkit. But if the hackathon rules require ADK by name, this needs settling before
      PRD-07, not after — it changes the backend language decision.
    impact_if_unresolved: >
      None today. Becomes expensive once agent code exists.
    comment: ""
    decision: ""
    decided_on: ""

  - id: D-005
    title: Four agents against the spec's "one orchestrating agent"
    category: architecture
    status: OPEN
    raised: 2026-08-28
    blocks: []
    context: >
      Spec §45 says "use one orchestrating migration agent" and warns against multiple
      agents for the appearance of agentic architecture. The agentic architecture doc
      proposes four, each with a capability boundary enforced by tool availability
      rather than instruction: A1 read-only, A2 no repository access, A3 branch write,
      A4 read-only diagnosis that did not write the code it judges.
    options:
      - Four, as designed
      - Three — merge A1 and A2; the snapshot boundary becomes orchestrator-enforced
      - One, spec-literal; the read/write boundary becomes prompt discipline
    recommendation: >
      Four, or three if you want to be closer to the spec. Keep A4 separate at any
      count — it protects the anti-test-cheating guarantee rather than a preference.
    impact_if_unresolved: >
      None today. Cheap to collapse before PRD-07, expensive after.
    comment: ""
    decision: ""
    decided_on: ""

  - id: D-006
    title: Execution ruleset holds discovery-time rules despite its name
    category: architecture
    status: OPEN
    raised: 2026-08-29
    blocks: []
    context: >
      migration-execution-rules.yaml now contains DETECTION_SIGNATURE and DISPOSITION
      families, which run during discovery and assessment, not migration execution. The
      split between the two files is by provenance — standards-cited versus product —
      not by phase. The filename says otherwise.
    options:
      - Rename to product-rules.yaml or proteus-rules.yaml
      - Split detection and disposition into a third file
      - Leave it; document the split in the header
    recommendation: >
      Rename. The header already explains the provenance split; the filename is the
      thing that will mislead someone reading the tree for the first time.
    impact_if_unresolved: >
      Cosmetic, but compounds — every reference to the file inherits the confusion.
    comment: ""
    decision: ""
    decided_on: ""

  # ────────────────────────────────────────────────────── STANDARDS ──

  - id: D-007
    title: The RSA-2048 to 112-bit security strength mapping is not in the corpus
    category: standards
    status: OPEN
    raised: 2026-08-28
    blocks: []
    context: >
      IR8547-4.1.2-001 keys on securityStrengthBits = 112 to apply the 2030 deprecation
      and 2035 disallowance. No document in knowledge/ states that RSA-2048 provides 112
      bits; IR 8547 Table 4 assumes the reader knows. SP 800-57 Part 1 supplies it and
      is not in the corpus. The rule is correctly transcribed and currently unfirable
      against a detected RSA-2048 usage.
    options:
      - Add NIST SP 800-57 Part 1 to knowledge/ and re-run the extraction for that rule
      - Add the mapping as an ENGINEERING rule in the product ruleset, non-gating
      - Leave it; transition timelines are informational for the demo
    recommendation: >
      Add SP 800-57 Part 1. It is one document and it closes a chain the assessment
      screen otherwise cannot complete honestly.
    impact_if_unresolved: >
      Transition dates cannot be shown for the primary finding. Nothing else breaks.
    comment: ""
    decision: ""
    decided_on: ""

  - id: D-008
    title: The signature prohibition has no direct citation
    category: standards
    status: OPEN
    raised: 2026-08-28
    blocks: []
    context: >
      PROHIB-001 — a signature usage must not be migrated to a KEM — is the most
      important prohibition in the product. No document in the corpus states it
      directly. It is INFERRED from FIPS 203's definition of a KEM plus SP 1800-38B
      listing RSA Encryption and RSA Signature as separate entries, and therefore
      cannot gate.
    options:
      - Add FIPS 204 or SP 800-131A to knowledge/ and look for a direct statement
      - Accept it as INFERRED and non-gating; EXEC-DISP-002 still excludes signatures
      - Promote it to ENGINEERING with an explicit product-policy justification
    recommendation: >
      Accept as INFERRED for the prototype. The behaviour is correct either way —
      EXEC-DISP-002 keeps signatures out of the plan. What is missing is the citation,
      not the enforcement.
    impact_if_unresolved: >
      None functionally. The assessment report cites an inferred rule where a normative
      one would be stronger.
    comment: ""
    decision: ""
    decided_on: ""

  # ─────────────────────────────────────────────────────── SECURITY ──

  - id: D-009
    title: Project creation spans MongoDB and Secret Manager with no transaction
    category: security
    status: OPEN
    raised: 2026-08-29
    blocks: []
    context: >
      POST /projects writes a secret and a document across two systems. A failure
      between them leaves one orphaned. I ordered it secret-first, so a failure leaves
      an orphaned secret — a live credential with nothing watching it — rather than an
      orphaned project, which would be a project that cannot reach its repository.
    options:
      - Secret first, sweep orphans (deployment §8)
      - Project first, mark credential MISSING, allow retry
      - Two-phase with a pending marker on the project
    recommendation: >
      Secret first. An orphaned secret is recoverable by a sweep; an orphaned project is
      broken and visible to the user. Worth your view — it trades a security smell
      against a UX failure.
    impact_if_unresolved: >
      I proceed with secret-first in PRD-05.
    comment: ""
    decision: ""
    decided_on: ""

  - id: D-010
    title: 404 rather than 403 for a project the caller does not own
    category: security
    status: OPEN
    raised: 2026-08-29
    blocks: []
    context: >
      A 403 confirms the project exists, which leaks the id space to an authenticated
      user probing for other tenants' projects. PRD-03 FR-2 returns 404 and logs the
      real distinction server-side.
    options:
      - 404 everywhere, log the distinction
      - 403 — clearer for debugging, leaks existence
    recommendation: 404.
    impact_if_unresolved: >
      I proceed with 404.
    comment: ""
    decision: ""
    decided_on: ""

  - id: D-011
    title: Sandbox lifetime and teardown
    category: security
    status: OPEN
    raised: 2026-08-29
    blocks: []
    context: >
      Spec §36 allows the sandbox to persist long enough for review rather than being
      destroyed immediately. Nothing states how long. A Cloud Run service that is not
      production but looks like one, left running indefinitely, is the kind of thing
      that is still there a year later.
    options:
      - 24 hours, swept
      - 7 days, swept
      - Manual teardown only
    recommendation: >
      7 days with expiresAt recorded on the deployment and a sweep. Long enough for a
      hackathon review, short enough that nothing drifts.
    impact_if_unresolved: >
      I proceed with 7 days in PRD-13.
    comment: ""
    decision: ""
    decided_on: ""

  # ───────────────────────────────────────────────────── PRODUCT ──

  - id: D-012
    title: Parameter set selection needs application context the engine does not have
    category: product
    status: OPEN
    raised: 2026-08-28
    blocks: []
    context: >
      SP 800-227 RM2 requires "a parameter set with an application-appropriate security
      strength". Appropriateness depends on protection lifetime and data sensitivity,
      neither of which the engine observes. In practice FIPS203-8-001's default
      recommendation of ML-KEM-768 carries the selection.
    options:
      - Default to ML-KEM-768 and report the basis
      - Ask for a protection lifetime on the create-project screen
      - Ask only when the finding is high severity
    recommendation: >
      Default and report. Adding a field to the create screen for a value most users
      cannot answer confidently trades a real cost for a theoretical gain.
    impact_if_unresolved: >
      I proceed with the default in PRD-09.
    comment: ""
    decision: ""
    decided_on: ""

  - id: D-013
    title: Material performance tradeoff has no threshold
    category: product
    status: OPEN
    raised: 2026-08-29
    blocks: []
    context: >
      EXEC-ESC-007 raises a gate when a performance regression is material. The
      reference scenario records +4.1ms end to end, which is immaterial; the same
      substitution on a hot path may not be. The engine cannot define "material" without
      a budget. The rule is currently non-gating with whenThresholdUnset REPORT_ONLY.
    options:
      - Leave unset — always measure and report, never block
      - Set a default such as +20% or +50ms
      - Ask for a budget on the create-project screen
    recommendation: >
      Leave unset for the prototype. A wrong default blocks correct migrations, and a
      reported delta is enough for a reviewer to judge.
    impact_if_unresolved: >
      I proceed with report-only.
    comment: ""
    decision: ""
    decided_on: ""

  - id: D-014
    title: Partial plan approval is modelled but not in the UX
    category: product
    status: OPEN
    raised: 2026-08-29
    blocks: []
    context: >
      The schema supports approvedPlanItemIds, so a user could approve some plan items
      and not others. UX v1.2 shows a single approve action for the whole scope.
    options:
      - Keep the field, approve all autonomous items from the UI
      - Remove the field until the UX calls for it
      - Build per-item approval
    recommendation: >
      Keep the field, approve-all in the UI. Removing it later is cheap; adding it to a
      frozen assessment shape later is not.
    impact_if_unresolved: >
      I proceed with approve-all.
    comment: ""
    decision: ""
    decided_on: ""

  - id: D-015
    title: Report format and rendering toolchain
    category: product
    status: OPEN
    raised: 2026-08-29
    blocks: []
    context: >
      Spec §19 and §40 require downloadable assessment and migration reports. UX v1.2
      shows them as PDFs with page counts. No renderer is chosen. contentSnapshot makes
      the source reproducible whichever is used.
    options:
      - Markdown only for the prototype
      - Markdown rendered to PDF
      - HTML to PDF via headless Chrome
    recommendation: >
      Markdown to PDF. The page count on the evidence card implies PDF, and the
      structured snapshot means the renderer can change without changing the data.
    impact_if_unresolved: >
      Decided at PRD-14; nothing earlier depends on it.
    comment: ""
    decision: ""
    decided_on: ""

  # ───────────────────────────────────────────────── INFRASTRUCTURE ──

  - id: D-016
    title: MongoDB — Atlas or self-hosted
    category: infrastructure
    status: OPEN
    raised: 2026-08-29
    blocks: [PRD-02]
    context: >
      A replica set is required, not optional: the SSE fan-out tails a change stream and
      a standalone mongod cannot open one. Atlas M0 is a replica set on the free tier.
      Local Docker needs --replSet. Tests can use mongodb-memory-server, which starts a
      real replica set.
    options:
      - Atlas M0 for development and demo
      - Self-hosted replica set in Docker
      - Atlas for demo, memory-server for tests only
    recommendation: >
      Atlas M0 plus mongodb-memory-server for tests. Removes a class of local setup
      problems that has nothing to do with the product.
    impact_if_unresolved: >
      PRD-02 needs a connection string to test against. Memory-server unblocks the tests;
      a demo still needs a real instance.
    comment: ""
    decision: ""
    decided_on: ""

  - id: D-017
    title: Rotation reminders need a scheduler
    category: infrastructure
    status: DEFERRED
    raised: 2026-08-29
    blocks: []
    revisit_at: PRD-14
    context: >
      UX v1.2 states a 90-day rotation reminder. rotationDueAt is stored and indexed, but
      nothing runs a sweep. Cloud Scheduler hitting an endpoint is the smallest thing
      that works.
    options:
      - Cloud Scheduler to an authenticated endpoint
      - Check lazily whenever a project is opened
      - Skip for the prototype
    recommendation: >
      Lazy check on project open for the prototype, Cloud Scheduler after. The reminder
      is only useful when someone is looking at the project anyway.
    impact_if_unresolved: >
      Reminders do not fire. No functional impact on a migration.
    comment: ""
    decision: ""
    decided_on: ""

  # ──────────────────────────────────────────────────────── CLOSED ──

  - id: D-018
    title: IR 8547 Table 5 names ML-DSA parameter sets in an ML-KEM table
    category: standards
    status: ACCEPTED
    raised: 2026-08-28
    blocks: []
    context: >
      NIST IR 8547 ipd Table 5, "Post-quantum key-establishment schemes", lists the
      ML-KEM family and then names its parameter sets ML-KEM-512, ML-DSA-768 and
      ML-DSA-1024. The latter two are plainly typographical errors — ML-DSA is a
      signature scheme and cannot appear in a key-establishment table.
    options:
      - Transcribe as printed, flag, and let the Tier A document settle the fact
      - Silently correct to ML-KEM-768 and ML-KEM-1024
    recommendation: Transcribe as printed.
    impact_if_unresolved: none
    comment: "Recorded during extraction; no action needed."
    decision: >
      Transcribed as printed in IR8547-4.1.2-004 with a transcription note, superseded by
      FIPS203-3.2-001 which is Tier A and settles the parameter set names. An extractor
      that silently corrects a source produces an uncitable rule; one that copies blindly
      produces a wrong one.
    decided_on: 2026-08-28
```
