# Migration Execution Ruleset — Authoring Prompt v1

Produces `engine/rulesets/migration-execution-rules.yaml`.

**This is not an extraction prompt.** `ruleset_extraction_prompt_v2.md` reads the standards
in `knowledge/` and requires a verbatim quotation behind every rule. Nothing here can work
that way: NIST does not publish which tests to generate, when a mock may be edited, or how
many repair attempts are enough. These rules are **authored** against the product's own
authorities, and their discipline is provenance and completeness rather than citation.

Do not attempt to cite a standard for a rule that has none. If a rule needs a citation it
cannot get, it belongs in the standards file or nowhere.

---

## 1. Why this file exists at all

The model can write Java. That is not what these rules are for.

These rules exist for decisions that must be **stable across runs**, not decisions that
must be good. The load-bearing example: `makeProblemKey()` in `schema/src/ids.ts` takes a
`FailureClassification` as an input. If classification is a free model judgment, the same
failure classified `MOCK_INCOMPATIBILITY` on attempt 1 and `TEST_FIXTURE_OUTDATED` on
attempt 2 produces two different problem keys, `meaningfulAttempts` never reaches 4, and
`MAX_MEANINGFUL_AUTONOMOUS_ATTEMPTS` silently never fires. A guardrail that looks present
and is not.

Every rule you write should be defensible in those terms: *what breaks, silently, if this
decision is left to the model each time?* If nothing breaks, it is not a rule — it is
prompt guidance, and it belongs in the agent's instructions instead.

---

## 2. The three failure modes

In order of severity:

1. **A rule that fails a correct implementation.** Worse than a missing rule, because the
   agent will then "repair" working code until the rule is satisfied. See the traps in §8 —
   this is not hypothetical; it happened.
2. **A rule that authorises a wrong action.** The agent acts autonomously after one
   approval. A rule that lets it edit a test which encodes a real requirement defeats the
   product's central guarantee.
3. **A missing rule that leaves a decision to the model.** Usually surfaces as an
   unreachable enum value — see §7.

---

## 3. Provenance, and what each tier may do

Every rule declares exactly one:

| Provenance | Means | May gate |
|---|---|---|
| `STANDARDS_DERIVED` | derived from a rule in `pqc-migration-rules.yaml`; names it in `derivedFrom` | yes |
| `SPEC_DERIVED` | from `Autonomous_PQC_Migration_Engineer_MVP_Product_Spec_v1.2.md`; names the section in `specSection` | yes |
| `ENGINEERING` | authored convention. No external authority. | **never** |

`gating: true` means the rule can block a migration from being marked VERIFIED, or refuse
an action outright. An `ENGINEERING` rule that gates is an unsourced assertion stopping a
migration — it is an error, not a judgment call.

Detection rules are the clearest case: NIST publishes no Java regexes, so the entire
detection family is `ENGINEERING` and therefore non-gating **by construction**. That is not
a weakness of the family; it is the provenance model working.

Every `derivedFrom` must resolve to a real `ruleId` in the standards file. A dangling
reference means the rule is asserting something the standards do not establish.

---

## 4. Authorities to work from

Read all of these before writing a rule. They are not interchangeable.

| Source | Supplies |
|---|---|
| `requirements/Autonomous_PQC_Migration_Engineer_MVP_Product_Spec_v1.2.md` | §18 dispositions · §24 baseline · §25 test/mock generation · §26 anti-cheating · §27 execution · §28–29 diagnosis · §30 gates · §31 retry · §34–36 verification/sandbox · §39–40 audit and reports |
| `engine/rulesets/pqc-migration-rules.yaml` | what is *true* about the cryptography; the target of every `derivedFrom` |
| `requirements/ux design/v1.1/` | what the user is actually shown — dispositions, recommendations with owners, the verification checklist, the migration feed |
| `schema/src/enums.ts` | the closed vocabularies. **Read this before writing a single rule.** Any value not in these enums is invalid output. |
| `docs/pqc_migration_data_model_v1.md` | the shapes rules read and write; the constraints already enforced at the write boundary |

Where the spec and the UX differ on shape, the UX wins — it is later and more specific.
Where they differ on meaning, the spec wins.

---

## 5. Rule families

Nine. Each rule belongs to exactly one.

| Family | Decides | Silent failure if missing |
|---|---|---|
| `DETECTION_SIGNATURE` | how crypto is located in source, config, manifests, certificates | discovery has nothing to key on |
| `DISPOSITION` | classified finding → proposed action and owner | Screen 3 cannot render; `AUTONOMOUS_MIGRATION` unreachable |
| `INVARIANT_CAPTURE` | what the baseline records, and what may legitimately change | verification compares against a moving target |
| `TEST_GENERATION` | what a generated test must assert | test set differs every run; demo not reproducible |
| `MOCK_STRATEGY` | when a mock may be created, extended or edited | anti-cheating guardrail unenforceable |
| `FAILURE_CLASSIFICATION` | structured evidence → `FailureClassification` | `problemKey` unstable; retry budget dead |
| `REPAIR_AUTHORIZATION` | classification → permitted actions and targets | agent repairs whatever it likes |
| `ESCALATION` | when to raise which gate or recommendation | stops too often, or never |
| `VERIFICATION` | how `verificationOverall: VERIFIED` is actually reached | the verdict is consumed but never computed |

---

## 6. Output schema

```yaml
  - ruleId: EXEC-{FAMILY}-{3-digit}      # DET DISP INV TEST MOCK DIAG REP ESC VER
    family: FAILURE_CLASSIFICATION
    title: <one line, states the decision>
    provenance: SPEC_DERIVED
    specSection: "§26"                   # SPEC_DERIVED only
    derivedFrom: [FIPS203-3.3-004]       # STANDARDS_DERIVED only
    gating: true
    stage: ANALYZING_FAILURE             # a MigrationStage, a DiscoveryStage, or ANY
    when: { }                            # conditions; ANDed
    then: { }                            # family-specific outcome
    prohibitedActions: []                # closed set below
    rationale: >-
      Why this rule exists and what breaks without it. Not a restatement of the title.
```

`prohibitedActions` is closed:

```text
REPLACE_ALGORITHM · MODIFY_SOURCE · UPGRADE_DEPENDENCY · MODIFY_CONFIGURATION
GENERATE_KEY · REUSE_EXISTING_KEY_MATERIAL · CREATE_TEST · MODIFY_TEST · MODIFY_MOCK
REMOVE_LEGACY_ALGORITHM · DEPLOY_SANDBOX · ASSUME_CAPABILITY
```

A file-level `policy:` block carries constants (`maxMeaningfulAutonomousAttempts: 4`,
autonomy boundary, production access). A file-level `subtypes:` block carries any taxonomy
that refines an enum value — see §8, trap 4.

---

## 7. Completion criterion — enum reachability

**This is the strongest check in this prompt.** Most of the gaps in the first draft of
this file were found by it and by nothing else.

For every enum in `schema/src/enums.ts` that the product renders to a user, every value
must be reachable from at least one rule, or be explicitly justified in a file-level
comment as unreachable by design:

- `Disposition` — all 7
- `RecommendationDisposition` — all 4
- `FailureClassification` — all 11
- `HumanGateType` — all 11
- `VerificationCheck` — all 9

**When a value is unreachable, the default conclusion is that a rule is missing, not that
the value is dead.** Getting this backwards is a real failure mode: an earlier draft
concluded `HARDWARE_REPLACEMENT` and `VENDOR_DECISION` were dead gate types and proposed
removing them from the schema. Spec §30 lists *"hardware must be replaced"* and *"vendor
selection/procurement is required"* as human-intervention triggers. The rules were missing.

Before declaring any value dead, search the spec for the phrase behind it.

Equally: **do not pad rules to satisfy the checker.** If a value genuinely has no path,
say so in a comment with the reason. A rule invented to turn a check green is worse than
an honest gap.

---

## 8. Traps

Every one of these was hit while authoring the current file, and caught only in review.
Check each rule against all seven.

**1 · Would this rule fail a *correct* implementation?**
The deepest trap. A draft `TEST_GENERATION` rule asserted "malformed ciphertext is
rejected". FIPS 203 §7.3 rejects a ciphertext of the wrong **length** at the input check —
but §3.2 shows a tampered ciphertext of the **right** length is *implicitly rejected*:
`Decaps` returns a pseudorandom secret and raises nothing. A test asserting "tampered
ciphertext throws" fails against a correct implementation, and the agent then repairs
working code to satisfy it. For every generated-test rule, ask what a **correct**
implementation does, not what a naive one does.

**2 · Does an absence check match the approved scope, or the whole tree?**
`PROHIBITED_CRYPTO_ABSENT` must be scoped to the algorithm-and-usage pairs the approved
plan items cover. A global "no RSA anywhere" check fails the *correct* migration: the
reference scenario deliberately leaves two RSA signature usages and an RSA-signed leaf
certificate in place. Residual crypto outside scope is reported through `cryptoAssertions`
as `NOTED` — which is why that field carries a third state the nine gating checks do not.

**3 · Is this invariant something the migration is supposed to change?**
RSA-2048 produces a 256-byte ciphertext; ML-KEM-768 produces 1088. An invariant pinning
ciphertext length, negotiated algorithm identifier or wire encoding blocks the correct
outcome. Every captured observation must be classified `MUST_PRESERVE` or
`EXPECTED_TO_CHANGE`; the latter is re-run and reported before-and-after, never asserted.

**4 · Am I flattening a taxonomy the user needs?**
A draft escalation rule assigned `HARDWARE_REPLACEMENT` to every hardware case — telling
an HSM owner to replace a device when the actual finding was that its specification is
*silent*. "Replace the device" and "the spec does not say" are different problems for
different owners. Where one enum value covers materially different situations, introduce a
`subtype` in the file-level `subtypes:` block and carry it on every path that surfaces the
value.

**5 · Is this unconditional when it should be conditional?**
A draft mock rule always retained the legacy protocol path. Correct when the approved scope
requires classical/PQC coexistence; wrong when it replaces the path outright, where it
preserves coverage of behaviour the migration deliberately removed. Ask what the approved
plan actually says before writing an always.

**6 · Can the subject of the test be mocked?**
The cheapest possible green suite: stub `Encaps`/`Decaps` and every PQC assertion passes
with zero cryptography executing. Spec §26 forbids weakening assertions but says nothing
about faking the subject. A rule must prohibit mocking the primitive under migration, and
the verification family must assert `mockedPrimitive: false` — without that, the entire
verification chain is satisfiable by a stub. Mocking the *peer* stays permitted.

**7 · Does this charge unfixable failures to the retry budget?**
Spec §31 reserves the budget for meaningful attempts against an unresolved problem.
Environment flakes and external-dependency blockers must set
`countsTowardRetryBudget: false`, or four Cloud Build timeouts exhaust the budget before
any engineering is tried.

---

## 9. Coherence requirements

**Precedence must be explicit.** Where two rules can match the same input, the more
specific must say so in its rationale and the general one must not contradict it. Three
that matter:

- A failing **baseline invariant** is never a test defect — that classifier outranks the
  mock-incompatibility classifier and is evaluated first.
- `AUTONOMOUS_MIGRATION` disposition is evaluated **last**, after every rule that could
  place the finding outside the autonomy boundary.
- A `PROHIBITION` in the standards file outranks any `MIGRATION_TARGET` it contradicts.

**The pipeline must close.** Do not write a rule that consumes a state nothing produces.
The first draft gated sandbox deployment on `verificationOverall: VERIFIED` while no rule
computed it. Trace each `when` back to a rule or a tool that sets it.

**Verification must be computed, never asserted.** The verdict is a pure function of the
nine checks, implemented in `computeOverallVerdict()`. No model output may set it, and
`cryptoAssertions` is explicitly excluded from it.

**Stage coverage.** Every stage where something is *decided* needs a rule. Stages where
nothing is decided (`BUILDING`, `RUNNING_TESTS`) correctly have none — a rule there would
restate an exit code.

---

## 10. Self-checks

Run all of these and report results.

1. **Provenance discipline.** No `ENGINEERING` rule has `gating: true`. No detection rule
   gates.
2. **References resolve.** Every `derivedFrom` names a real rule in
   `pqc-migration-rules.yaml`. Every `specSection` names a real section.
3. **Enums valid.** Every enum-typed value in every `then` exists in `schema/src/enums.ts`.
4. **Closed vocabulary.** No `prohibitedActions` entry outside the §6 set.
5. **Enum reachability (§7).** Report per enum: reachable, and any value not reachable with
   the reason it is not a missing rule.
6. **Subtype integrity.** Every subtype used is declared in `subtypes:`; every declared
   taxonomy is referenced by at least one rule.
7. **Pipeline closure.** No `when` condition depends on state no rule or tool produces.
8. **Trap sweep.** Confirm each of the seven traps in §8 was checked against every rule in
   the families it applies to.
9. **Ids unique**, and no near-duplicates differing only in a parameter value — one rule
   with a predicate beats six rules for six values.

Finish with: rules by family, by provenance, how many gate, enum reachability per enum, and
anything left deliberately unreachable with its justification.

---

## 11. Output

One file: `engine/rulesets/migration-execution-rules.yaml`.

Header comment must state the split from `pqc-migration-rules.yaml` (that file says what is
*true* about cryptography; this one says what the agent *does* about it), the provenance
tiers, and the `makeProblemKey` argument from §1 for why the file exists.

No timestamps or run ids — a re-run over unchanged inputs must produce a zero diff.
