# PRD-01 · Rules Engine

| | |
|---|---|
| **Increment** | 01 |
| **Status** | `DELIVERED` |
| **Depends on** | — |
| **Unblocks** | PRD-06, PRD-07, PRD-09, PRD-12, PRD-13 |
| **Demoable outcome** | None — foundation. Verified by test: the 110 rules reproduce the assessment the UX renders for the reference scenario. |
| **Created** | 2026-08-28 |
| **Delivered** | 2026-08-28 |

> Written retroactively. The code existed before the PRD, which is the wrong order and
> is why this document exists — so that increments 02 onward do not repeat it.

---

## 1. Problem

The product's claim is that it decides deterministically and reasons only where judgment
is genuinely required. 110 rules encode those decisions across two YAML files, but YAML
does not execute. Without an engine, every decision the rules describe would fall back to
the model, and the guarantees would be prompt discipline rather than mechanism.

The sharpest instance: `makeProblemKey()` consumes a `FailureClassification`. If that
classification is a model judgment that varies between attempts, the same failure yields
different problem keys, `meaningfulAttempts` never reaches 4, and the retry budget
silently never fires.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §29 failure classification · §34–35 verification · §46 deterministic-first |
| Data model | §8 adopted decisions — enforcement in schema, not prompt |
| Agent architecture | §3 what is deliberately not an agent · §7 rules bracket every model call |
| Rulesets | `engine/rulesets/pqc-migration-rules.yaml` (40) · `migration-execution-rules.yaml` (70) |
| Ruleset prompts | `engine/prompts/ruleset_extraction_prompt_v2.md` · `migration_execution_ruleset_prompt_v1.md` |

## 3. Scope

**In**
- Load and validate both rule files at startup
- Evaluate `when` clauses against a fact bag
- Precedence within families where more than one rule can match
- Classification, target resolution, disposition, failure classification, required checks, detection candidates
- Prohibited-action union
- `explain()` — why each rule did or did not fire

**Out**
- Persisting decisions → PRD-02
- Calling the rules from an agent → PRD-07
- Running the verification checks the rules require → PRD-13

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | Both rule files load and validate at startup; a malformed rule fails with a path | Data model §8 |
| FR-2 | Gating discipline is enforced at load: no `ENGINEERING` rule and no `INFERRED` rule may gate | Extraction prompt v2 §3 |
| FR-3 | `derivedFrom` must resolve to a real standards rule; a dangling reference fails the load | Execution prompt §3 |
| FR-4 | Every subtype used must be declared in the `subtypes:` taxonomy | Execution prompt §8 trap 4 |
| FR-5 | `when` clauses evaluate by suffix convention, so adding a rule needs no evaluator change | — engineering |
| FR-6 | A rule never fires on a fact the engine does not hold | Spec §46 |
| FR-7 | Families with documented precedence evaluate in that order; a rule with no precedence decision fails startup | Execution ruleset §9 |
| FR-8 | Failure classification returns `null` rather than guessing when nothing matches | Spec §29, `EXEC-DIAG-008` |
| FR-9 | A prohibition contributes even where compliance is not statically verifiable | — see §10 |

## 5. Data model

**Collections touched** — none. The engine is pure; callers persist.

**Schema changes** — added `schema/src/rules.ts`: `StandardsRuleset`, `ExecutionRuleset`,
`ProhibitedAction`, and the Zod refinements that enforce FR-2 and FR-3.

## 6. Interfaces

**API** — none.

**Events emitted** — none.

**Agent involvement** — none. Deterministic by definition; the agent architecture places
this outside the agents deliberately.

**Rules consumed** — all 110, by family.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | 40 standards + 70 execution rules load | `rules.test.ts` |
| AC-2 | The reference scenario's ten findings each resolve to the disposition the UX shows | `rules.test.ts` |
| AC-3 | Exactly f1 and f2 reach `AUTONOMOUS_MIGRATION` | `rules.test.ts` |
| AC-4 | Three recommendations, distinct dispositions, each with an owner | `rules.test.ts` |
| AC-5 | Five reference failures classify to the expected rule id | `rules.test.ts` |
| AC-6 | The same failure classifies identically across 20 runs | `rules.test.ts` |
| AC-7 | An unmatched failure returns `null` | `rules.test.ts` |
| AC-8 | Signature usage prohibits `REPLACE_ALGORITHM`; ML-KEM does not prohibit `GENERATE_KEY` | `rules.test.ts` |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution |
|---|---|---|---|
| 1 | `when` vocabulary grew to ~60 keys; the closed-vocabulary check only ever ran on the standards file | Execution rules can invent condition keys nothing produces | Suffix-convention evaluator absorbs new keys; PRD-12 adds a fact-coverage check |
| 2 | `machineEvaluable` conflates "condition matchable" with "compliance verifiable" | A prohibition could decline to fire | Resolved — see §10 |
| 3 | Precedence lives in rule prose as well as the code table | Two sources could disagree | `assertPrecedenceCoverage` fails startup on a gap; prose is documentation only |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified — 30 tests
- [x] Typecheck and tests pass
- [x] Sources in §2 unchanged by this increment
- [x] §10 records what was built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-28 | `schema/src/rules.ts`, `core/rules/{predicates,precedence,loader,engine,assess}.ts` | Increment delivered |
| 2026-08-28 | Reference-scenario fixture derived from UX v1.1 | Gives the rules an executable definition of correct |

**Deviations from plan**

- **`AllIn` and `None` operators added.** `documentDeclaresNone` needed negated
  membership and `referencingFilesAllIn` a universal quantifier. `.some()` where
  `.every()` was meant would have classified a failure as `MOCK_INCOMPATIBILITY` when
  only one referencing file was a test — authorising a mock edit that should not happen.
- **Fact resolution falls back from stem to literal key.** The suffix convention collides
  with English: `failureOriginatesIn` reads as "originates in", not "is a member of".
  Renaming 70 rules to suit a parser was the worse trade.
- **Prohibitions exempted from the `machineEvaluable` filter** (FR-9, risk 2).
  `machineEvaluable: false` means compliance cannot be *verified* statically, not that the
  condition cannot be *matched*. For `PROHIB-003` those come apart. A rail that declines
  to fire because verification is hard is not a rail.

**Deferred** — nothing.
