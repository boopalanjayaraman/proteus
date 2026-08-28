# Proteus — Agent Architecture v1

Companion to `docs/pqc_migration_data_model_v1.md` and `engine/rulesets/`.

**Constraint this design answers to.** Product Spec §45: *"Use one orchestrating
migration agent. Do not introduce multiple agents merely for the appearance of agentic
architecture. Sub-agents can be introduced later if the implementation genuinely
benefits from them."*

That warning is right, and this architecture takes it as a test to pass rather than an
obstacle. The answer below is **four agents** — not because four is a good number, but
because four capability boundaries in this product should be enforced by tooling instead
of by instructions in a prompt. Everything else that looks agent-shaped is a tool, a
rule, or a state transition.

---

## 1. When something earns the right to be an agent

A component is an agent only if **both** hold:

1. **It exercises genuine judgment** — the output cannot be derived by rules or code
   from its inputs, and
2. **It needs a capability boundary** — there is something it must be structurally
   unable to do, and enforcing that by tool availability is safer than enforcing it by
   telling a model not to.

One without the other is something else:

| Has judgment | Needs a boundary | It is a… |
|---|---|---|
| yes | yes | **agent** |
| yes | no | **flow** — one model call, no loop, no tool grants (e.g. report narrative) |
| no | yes | **tool** — deterministic, capability-scoped (e.g. deploy_sandbox) |
| no | no | **rule or code** (e.g. detection, disposition, verification) |

The second test is what keeps the count down. After the ruleset work, most of this
product's decisions are rules: 110 of them across `pqc-migration-rules.yaml` and
`migration-execution-rules.yaml`. Detection, disposition, failure classification,
repair authorisation, escalation and verification are all decided in code. What remains
for a model is narrower than it first appears.

---

## 2. The four agents

### A1 · Discovery Agent

**Judgment:** where to look next in an unfamiliar repository; which document claim
corroborates which code fact; what a weak usage signal actually means.

**Boundary:** *no write capability of any kind.* Spec §6 makes the pre-approval phase
read-only. This agent physically cannot create a branch or modify a file, because those
tools are not in its table — not because its prompt says not to.

| Tools | |
|---|---|
| `clone_repository_readonly` `list_files` `read_file` `search_repository` | repository |
| `inspect_dependencies` `inspect_configuration` `inspect_tests` | structure |
| `analyze_uploaded_document` `extract_existing_findings` | documents |
| `assert_finding` `upsert_graph_node` `upsert_graph_edge` `attach_evidence` | persistence |

**Rules that bracket it.** `EXEC-DET-001..007` run *before* the agent and hand it
candidate locations with a proposed usage and a strength. The agent's job is the residue:
resolving `strength: WEAK` matches, correlating an uploaded HSM specification against a
graph node, deciding when discovery has enough evidence (spec §13). It cannot invent a
node type or a relationship outside the enums, because `UpsertGraphNodeInput` is the tool
schema.

**Output:** findings, graph nodes and edges, evidence — all persisted. Nothing else
crosses the boundary.

---

### A2 · Assessment Agent

**Judgment:** composing findings into an ordered plan; writing the four Screen-3
narratives; deciding plan-item grouping and risk.

**Boundary:** *no repository access at all.* Not read-only — none. It sees only the
persisted findings, graph and evidence.

This is the one boundary that looks like ceremony and is not. An assessment is frozen and
versioned (`Assessment.snapshot`), and the migration is later audited against exactly what
the human approved. An agent that can still call `read_file` while composing the plan will
keep discovering, and the plan will then describe evidence the snapshot does not contain.
Removing the tools makes the snapshot authoritative by construction.

| Tools | |
|---|---|
| `get_findings` `get_graph` `get_evidence` `get_policy` | read persisted state |
| `compose_plan_item` `write_assessment` `raise_recommendation` | produce assessment |

**Rules that bracket it.** `EXEC-DISP-001..009` assign every disposition *before* the
agent runs; it composes plan items from findings already dispositioned. It cannot promote
a finding to `AUTONOMOUS_MIGRATION` — `EXEC-DISP-009` decides that, and every clause in it
is checked in code. `PROHIB-001` suppresses signature findings from the plan regardless of
what the model proposes.

**Output:** one immutable `Assessment` (version N+1), plan items, recommendations.

---

### A3 · Migration Engineer Agent

**Judgment:** the actual patch. Given a plan item, a file and a target, write the code.
Given a diagnosis and an authorised repair, write that. This is where the model does the
work only a model can do.

**Boundary:** write access confined to **the migration branch and the sandbox**. Never the
original branch, never production, never HSM or vendor configuration
(`EXEC-REP-001`, `EXEC-ESC-008`).

| Tools | |
|---|---|
| `create_branch` `apply_patch` `revert_patch` `commit` `push` `get_diff` | git |
| `generate_test` `generate_mock` `generate_fixture` | test engineering |
| `run_cloud_build` `run_tests` | execution (returns evidence, not verdicts) |
| `deploy_sandbox` `run_e2e` | sandbox (gated on verification — `EXEC-REP-004`) |

**Rules that bracket it.** `EXEC-TEST-001..007` say *what* every generated test must
assert; the agent decides how to write it in Java. `EXEC-MOCK-004` refuses any patch that
mocks the primitive under migration. `MigrationChange` validation rejects a TEST/MOCK
change without a `testIntegrity` record. `EXEC-VER-001` checks the resulting diff against
`PlanItem.expectedChanges` — the scope the human approved.

**What it may not decide.** Whether its own build passed. Whether its own test failure is
legitimate. Both come from elsewhere.

---

### A4 · Diagnostic Agent

**Judgment:** root cause of a failure the deterministic classifiers could not resolve.

**Boundary:** *read-only on failure evidence, and it did not write the code it is judging.*

This is the strongest structural argument in the design, and it is specific to this
product's central risk. Spec §26 forbids weakening a test to get a pass. If the agent that
wrote the failing patch also decides whether the failing test is legitimate, it is
adjudicating its own work while motivated to conclude that the test is wrong. A separate
agent that cannot modify code and did not produce the patch has no such incentive.

| Tools | |
|---|---|
| `get_failure_evidence` `get_execution_log` `get_baseline` `get_change` `read_file` | evidence |
| `record_diagnosis` | produce a `Diagnosis` |

**Rules that bracket it.** `EXEC-DIAG-002..012` classify deterministically *first*; A4 runs
only on the residue. `EXEC-DIAG-005` outranks everything: a failing baseline invariant is
never a test defect, and the agent is never asked. `EXEC-DIAG-008` makes an unclassifiable
failure a gate rather than a guess. Whatever A4 returns, `REPAIR_AUTHORIZATION` rules —
not the agent — decide what may be done about it.

**Why this is not a bureaucratic split.** A4's output feeds `makeProblemKey()`. A stable
classification is what makes the four-attempt retry budget fire at all. Keeping diagnosis
in the same context as patch authorship makes it drift with the patch.

---

## 3. What is deliberately not an agent

The more consequential half of the design.

| Component | What it is | Why not an agent |
|---|---|---|
| **Orchestrator** | deterministic state machine | The loop must be checkpointable and resumable (§5, §9). A loop inside model reasoning cannot be. |
| **Verification Service** | pure code, `computeOverallVerdict()` | Spec §34: only tool evidence marks a migration verified. An agent here would be the exact failure the spec forbids. |
| **Detection** | rules `EXEC-DET-001..007` | No judgment — pattern matching with an explicit strength. |
| **Disposition** | rules `EXEC-DISP-001..009` | Deterministic mapping. An agent would make Screen 3 non-reproducible. |
| **Sandbox deployment** | tools | Build image, push, deploy, probe. Nothing to decide. |
| **Report generation** | a **flow** — single model call over persisted state | Judgment (narrative) but no boundary and no loop. |
| **Event emission** | code | Persist first, stream second. |

---

## 4. Orchestration

```text
                         ┌──────────────────────────────┐
                         │        ORCHESTRATOR          │
                         │   deterministic · leased     │
                         │   checkpointed per step      │
                         └──────────────┬───────────────┘
      DISCOVERY                         │                     MIGRATION
   ┌──────────────┐                     │            ┌─────────────────────┐
   │ A1 Discovery │◄────────────────────┼───────────►│ A3 Migration Eng.   │
   └──────┬───────┘                     │            └─────────┬───────────┘
          │ findings, graph             │                      │ patch, tests
          ▼                             │                      ▼
   ┌──────────────┐                     │            ┌─────────────────────┐
   │ A2 Assessment│                     │            │ Cloud Build (tool)  │
   └──────┬───────┘                     │            └─────────┬───────────┘
          │ assessment + plan           │                      │ evidence
          ▼                             │                      ▼
   ╔══════════════╗                     │            ┌─────────────────────┐
   ║  HUMAN GATE  ║  ◄──────────────────┘            │ A4 Diagnostician    │
   ║   approve    ║                                  └─────────┬───────────┘
   ╚══════════════╝                                            │ diagnosis
                                                               ▼
                                                     ┌─────────────────────┐
                                                     │ Verification (code) │
                                                     └─────────────────────┘
```

The orchestrator is a state machine over `MigrationStage`. It owns the lease, writes the
checkpoint, applies the rules, and dispatches agents. **Agents never call each other.**

---

## 5. Handoff

**Handoff is persisted state, never message passing.** Each agent writes typed documents;
the next reads them.

```text
A1 → findings, graph_nodes, graph_edges, evidence   ─┐
                                                     ├→ A2 reads (repo tools absent)
A2 → assessments{planItems}, recommendations        ─┘
                    │
              HUMAN GATE  (HumanGate, type MIGRATION_APPROVAL)
                    │
A3 → migration_changes, execution_runs, commits     ─┐
                                                     ├→ A4 reads (write tools absent)
A4 → migration_attempts.diagnosis                   ─┘
                    │
              Verification (code) → verification_results
```

Three properties fall out for free:

- **Resumability.** An evicted worker rereads the same documents and continues. No
  in-flight conversation to reconstruct.
- **Auditability.** The handoff *is* the audit trail (spec §39). No separate logging path.
- **Context isolation.** A4 receives a failure and a baseline, not A3's authoring
  transcript — which is exactly why its judgment is independent.

---

## 6. The migration loop

The loop lives in the orchestrator. A3 is invoked once per patch; it does not iterate.

```
for planItem in approvedPlanItems (ordered):
    checkpoint(stage = APPLYING_MIGRATION_CHANGES, cursor = planItem.id)

    attempt = newAttempt(intent = planItem.action)
    patch   = A3.produce(planItem, context = filesFor(planItem))
    validate(patch)                      # EXEC-VER-001 scope · testIntegrity · EXEC-MOCK-004
    commit(patch)

    result = tool.runCloudBuild(branchHead)          # TRUTH — not a model claim

    if result.passed:
        attempt.result = SUCCEEDED
        continue                                      # next plan item

    # ---- failure path -------------------------------------------------
    evidence       = structureFailure(result)         # ≤20 lines; full log → GCS
    classification = rules.classify(evidence)         # EXEC-DIAG-002..012 FIRST
    if classification is None:
        classification = A4.diagnose(evidence, baseline)   # model only for the residue

    problemKey = makeProblemKey(classification, failedTest, error)
    thread     = problemThreads.upsert(problemKey)

    if not classification.countsTowardRetryBudget:     # env flake, external blocker
        continue                                       # retry freely — spec §31

    thread.meaningfulAttempts += 1
    if thread.meaningfulAttempts >= 4:                 # EXEC-ESC-001
        raiseGate(RETRY_BUDGET_EXHAUSTED, blocking = false)
        continue                                       # unrelated work proceeds — §30

    authorisation = rules.authoriseRepair(classification)   # EXEC-REP-*
    if not authorisation.permitted:
        raiseGate(authorisation.gateType); continue

    if thread.meaningfulAttempts >= 2:                 # EXEC-REP-003
        revert(lastChange)                             # don't stack partial fixes

    repair = A3.repair(classification, evidence, authorisation)
    # loop
```

Then, once every plan item is resolved:

```
checkpoint(CRYPTO_VERIFYING)
checks   = verification.run()            # EXEC-VER-001..013 — pure code
verdict  = computeOverallVerdict(checks) # nine checks; cryptoAssertions excluded
if verdict != VERIFIED: raiseGate(...); stop

checkpoint(SANDBOX_DEPLOYING);   deploy()       # EXEC-REP-004 gates on verdict
checkpoint(END_TO_END_VERIFYING); runE2E()
checkpoint(COMPLETED);           generateArtifacts()   # EXEC-VER-013
```

**Four properties this ordering buys.** The model never decides whether to loop again.
The build result is a tool fact. The retry budget is enforced outside the reasoning that
would like to keep trying. And every iteration is a checkpoint, so eviction costs one
attempt rather than the run.

---

## 7. Rules bracket every model call

No agent output reaches the database unvalidated.

```text
        ┌──────────────┐        ┌───────┐        ┌────────────────┐
input → │ PRE:  rules  │ ────►  │ MODEL │ ────►  │ POST: validate │ → persisted
        │ constrain    │        └───────┘        │ Zod + rules    │
        └──────────────┘                         └────────────────┘
```

- **Pre.** Detection rules hand A1 candidates. Disposition rules pre-assign before A2
  composes. Repair authorisation is resolved before A3 is asked for a repair.
- **Post.** Zod schemas reject malformed output at the boundary. `Evidence` refuses
  `OBSERVED` from a model actor. `MigrationChange` refuses a mock edit without
  `testIntegrity`. `VerificationCheckResult` refuses a `PASS` with no execution behind it.

A model that returns something disallowed does not produce a bad record; it produces a
validation error, and the orchestrator retries or escalates.

---

## 8. Context given to each agent

Long autonomous runs fail on context bloat before they fail on reasoning. Each agent
receives only its own slice.

| Agent | Receives | Never receives |
|---|---|---|
| A1 | file tree, current file, detection candidates, project instructions | migration state |
| A2 | findings + graph + evidence (dispositioned), policy | repository contents |
| A3 | one plan item, target files, applicable rules, last failure | full discovery transcript |
| A4 | structured failure, baseline invariants, changed files, diff | A3's authoring transcript |

The last row is deliberate. A4's independence is partly a matter of what it is *not* told.

---

## 9. Failure, eviction and concurrency

- **One writer.** `migration_runs.lease` (holder + TTL, refreshed ~30 s). A double-clicked
  Approve or a scale-out cannot start two migrations.
- **Resume.** `migration_runs.checkpoint` is written at each stage boundary and each loop
  iteration. A restarted worker reads it and continues; at worst one attempt is repeated.
- **Sequential plan items.** Deliberate: parallel patches on one branch make the diff
  unreviewable and failure attribution ambiguous. The scenario has five plan items — there
  is nothing to gain.
- **Cloud Run Job**, not an HTTP request. The run outlives the browser (data model §6d).

---

## 10. If you want fewer agents

The count is defensible at 4, 3 or 2. It is not defensible at 7.

| Count | Merge | Cost |
|---|---|---|
| **4** | as designed | — |
| **3** | A1 + A2 into one agent, tools swapped at the phase change | The snapshot boundary becomes orchestrator-enforced rather than tool-enforced. Acceptable. |
| **2** | also merge A4 into A3 | **Loses the anti-cheating separation.** The patch author judges its own failures. Recoverable only if you never relax `EXEC-DIAG-005`. |
| **1** | spec-literal | The read/write autonomy boundary becomes prompt discipline. For a product whose central claim is that boundary, that is the wrong economy. |

If pressed, drop to 3 by merging Discovery and Assessment. Keep A4 separate at any count —
it is the one split that protects a stated product guarantee rather than a preference.

---

## 11. Genkit mapping

```ts
// Four agents = four tool tables over one model. Not four services.
const discoveryAgent  = ai.defineFlow({ name: 'discovery',  tools: READ_ONLY_TOOLS });
const assessmentAgent = ai.defineFlow({ name: 'assessment', tools: PERSISTED_STATE_TOOLS });
const engineerAgent   = ai.defineFlow({ name: 'engineer',   tools: BRANCH_WRITE_TOOLS });
const diagnosticAgent = ai.defineFlow({ name: 'diagnostic', tools: EVIDENCE_READ_TOOLS });

// Tool I/O schemas come from @proteus/schema — the same Zod definitions Mongo validates,
// so structured output lands pre-validated in the shape the database stores.
```

All four live in `src/backend/src/agent/`. The orchestrator lives in
`src/backend/src/worker/` and the verification service in
`src/backend/src/verification/` — which, per the import rule in the folder-structure
document, **cannot import from `agent/` at all**. "Gemini reasons, tools establish truth"
is enforced by the dependency graph, not by a paragraph in a prompt.
