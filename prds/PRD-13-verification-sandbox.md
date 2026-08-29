# PRD-13 · Deterministic Verification & Sandbox

| | |
|---|---|
| **Increment** | 13 |
| **Status** | `PLANNED` |
| **Depends on** | PRD-12 |
| **Unblocks** | PRD-14 |
| **Demoable outcome** | Nine checks turn green, then the migrated application deploys to an isolated sandbox and passes an end-to-end settlement scenario against a live URL. |
| **Created** | 2026-08-29 |
| **Delivered** | |

---

## 1. Problem

The product must not equate "tests pass" with "migration verified". Verification is the
only thing standing between a plausible-looking diff and a claim that the cryptography
actually changed — and it has to be computed from tool evidence, never asserted by a model.

The subtlety that decides whether it works: the absence check must be scoped to the
approved usage. A global "no RSA anywhere" check fails the *correct* migration, because
two signature usages and an RSA-signed certificate are deliberately left in place.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §34 deterministic verification · §35 completion rule · §36 sandbox deployment · §37 sandbox link |
| UX design | v1.2 — DETERMINISTIC VERIFICATION list, CRYPTO VERIFICATION with a NOTED row, sandbox card |
| Data model | §3.15 verification results · §3.16 sandbox deployments |
| Rulesets | `EXEC-VER-001..013` · `PROHIB-001` · `FIPS203-8-003` |

## 3. Scope

**In**
- All nine `VerificationCheck` values evaluated from tool evidence
- `cryptoAssertions` as a separate narrative list carrying `NOTED`
- Verdict computed by `computeOverallVerdict()`, excluding `cryptoAssertions`
- Scope conformance: the diff checked against `PlanItem.expectedChanges`
- Image build → Artifact Registry → Cloud Run sandbox
- Startup probe, then E2E against the deployed URL
- Sandbox card with URL and the not-production label

**Out**
- Reports and evidence package → PRD-14
- Sandbox teardown scheduling → PRD-14

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | All nine checks are evaluated; `overall` is computed from them in code | Spec §35 |
| FR-2 | No model output may set `overall`; `cryptoAssertions` is excluded from it | `EXEC-VER-012` |
| FR-3 | A check cannot be `PASS` without an `executionRunId` or evidence | Data model §3.15 |
| FR-4 | `PROHIBITED_CRYPTO_ABSENT` is scoped to the approved plan items' algorithm-and-usage pairs | `EXEC-VER-008` |
| FR-5 | Residual crypto outside scope is reported as `NOTED`, never as a failure | `EXEC-VER-008` |
| FR-6 | `BASELINE_INVARIANTS_PRESERVED` re-runs only `MUST_PRESERVE` invariants; `EXPECTED_TO_CHANGE` are reported before-and-after | `EXEC-VER-005` |
| FR-7 | `REQUIRED_TESTS_PASSED` is a subset relation over the baseline passing set, not a count | `EXEC-VER-004` |
| FR-8 | A real ML-KEM round trip executes against the resolved provider with `mockedPrimitive: false` | `EXEC-VER-006` |
| FR-9 | Changed paths must fall within `expectedChanges`; a breach raises a gate | `EXEC-VER-001` |
| FR-10 | Sandbox deployment is refused unless `overall` is `VERIFIED` | `EXEC-REP-004` |
| FR-11 | The sandbox starts, passes a startup probe, then runs E2E against its URL | Spec §36 |
| FR-12 | `isProduction` is the literal `false` and every surface labels from it | Data model §3.16 |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `verification_results` | C | `checks`, `cryptoAssertions`, `residualLegacyCrypto`, `overall` |
| `sandbox_deployments` | C/W | `service.url`, `startupCheck`, `e2e`, `isProduction` |
| `execution_runs` | C | `CRYPTO_VERIFY`, `IMAGE_BUILD`, `DEPLOY`, `E2E_TEST` |
| `migration_runs` | W | `outcome`, `stage`, `completedAt` |
| `projects` | W | `stage: SANDBOX_READY`, `summary.sandboxUrl`, `autonomy` |

**Schema changes** — none.

## 6. Interfaces

**API** — `GET /projects/{id}/verification`, `GET /projects/{id}/sandbox`.

**Events emitted** — `CRYPTO_VERIFICATION_STARTED/PASSED/FAILED`, `SANDBOX_DEPLOYMENT_STARTED/READY`, `E2E_TEST_PASSED/FAILED`, `MIGRATION_COMPLETED`.

**Agent involvement** — none for the verdict. A3 triggers deploy tools; the verification service is pure code and cannot import `agent/`.

**Rules consumed** — `EXEC-VER-001..013`.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | With eight of nine checks passing, `overall` is `NOT_VERIFIED` | test |
| AC-2 | A `NOTED` crypto assertion does not affect `overall` | test |
| AC-3 | The two RSA signature usages and the RSA-signed certificate do not fail `PROHIBITED_CRYPTO_ABSENT` | test |
| AC-4 | A `PASS` written without provenance is rejected | test |
| AC-5 | Four new tests passing while four baseline tests break yields `NOT_VERIFIED` | test |
| AC-6 | A mocked KEM primitive fails `REQUIRED_PQC_PRESENT` | test |
| AC-7 | A file changed outside `expectedChanges` raises a gate | test |
| AC-8 | Deployment is refused while `overall` is `NOT_VERIFIED` | test |
| AC-9 | The sandbox URL responds and E2E passes; the card says not production | screen |
| AC-10 | Reference scenario ends `VERIFIED`, 100% autonomous completion, zero human engineering actions | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | Crypto verification greps source; a provider could resolve differently at runtime | Static pass, runtime failure | FR-8 requires a real round trip. Static and runtime evidence together, neither alone |
| 2 | The E2E scenario is not yet defined | AC-9 unverifiable | `POST /settlements → 201` with a negotiated ML-KEM-768 suite — **needs the demo repo to expose it** |
| 3 | Sandbox services persist and cost money | Drift and spend | Deployment §8 sweep; expiry recorded on the deployment |
| 4 | `expectedChanges` may be narrower than a correct migration needs | A correct migration raises a scope gate | Path patterns rather than exact files; a gate is the right outcome — the human approved a scope |

## 9. Definition of done

- [ ] All FRs implemented
- [ ] All ACs verified
- [ ] Typecheck and tests pass
- [ ] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|

**Deviations from plan** —

**Deferred** —
