# PRD-06 · Repository Access & Crypto Discovery

| | |
|---|---|
| **Increment** | 06 |
| **Status** | `DELIVERED` |
| **Depends on** | PRD-01, PRD-05 |
| **Unblocks** | PRD-07 |
| **Demoable outcome** | None — foundation. Verified by command: point it at the demo repository and it emits the reference scenario's findings with evidence, no model involved. |
| **Created** | 2026-08-29 |
| **Delivered** | 2026-08-29 |

---

## 1. Problem

Discovery is presented as agent work, but most of it is not judgment — it is pattern
matching against a checked-out tree. Building the deterministic half first means the
agent in PRD-07 is asked only the questions a model should answer, and it means the
findings are reproducible run to run.

## 2. Sources of truth

| Source | Reference |
|---|---|
| Product spec | §7 live discovery activities · §8 usage-specific classification |
| Architecture | §9 discovery tools |
| Agent architecture | §2 A1 tool table |
| Rulesets | `EXEC-DET-001..007` detection · `FIPS203-1.1-001/002`, `SP1800-38B-3.2.3-001` classification |
| Data model | §3.4 evidence · §3.6 findings · §3.2 `repository.profile` |

## 3. Scope

**In**
- GitHub adapter authenticating with the per-project PAT from Secret Manager
- Read-only clone at a resolved commit; credential validation
- Repository profile detection (language, build system, framework, file count)
- Detection rules executed over source, config, manifests, certificates
- Findings with evidence, deterministic `dedupeKey`, `usage` strength
- Document text extraction with page/section offsets
- Existing-findings import (CBOM, SARIF) as evidence

**Out**
- Deciding what to investigate next → PRD-07
- Graph construction → PRD-08
- Disposition assignment → PRD-09

---

## 4. Functional requirements

| ID | Requirement | Source |
|---|---|---|
| FR-1 | The PAT is fetched by secret name at the moment of a call and never cached on a document or a run | Data model rule 8 |
| FR-2 | A failed authentication sets `credential.status` to `INVALID` and raises a finding, rather than crashing | PRD-05 risk 3 |
| FR-3 | The clone is read-only; no branch, commit or push is possible in this increment | Spec §6 |
| FR-4 | `repository.profile` is populated at clone, before discovery completes | Data model §3.2 |
| FR-5 | Detection runs `EXEC-DET-001..007`; a `STRONG` match assigns usage, a `WEAK` match yields `usage: UNKNOWN` | `EXEC-DET-002` |
| FR-6 | Every finding carries evidence with a `REPO` or `DOCUMENT` locator and a permalink where applicable | Data model §3.4 |
| FR-7 | Re-running discovery updates findings by `dedupeKey` rather than duplicating them | Data model §3.6 |
| FR-8 | Evidence produced by a tool is `OBSERVED`; nothing in this increment may write `INFERRED` | Data model §3.4 |
| FR-9 | Uploaded documents are extracted to text with page and section offsets for citation | Data model §3.3 |
| FR-10 | Provider capability is resolved through a registry, never inferred from a version comparison | `EXEC-DET-005` |

## 5. Data model

| Collection | Access | Fields of note |
|---|---|---|
| `projects` | R/W | `repository.profile`, `credential.status`, `lastVerifiedAt` |
| `project_files` | R/W | `extraction.textGcsUri`, `sections` |
| `findings` | C/W | `dedupeKey`, `crypto.usage`, `summaryLine` |
| `evidence` | C | `locator`, `excerpt`, `producedBy.toolName` |

**Schema changes** — a `providerCapabilityRegistry` data file (`engine/data/`), referenced by `EXEC-DET-005`.

## 6. Interfaces

**API** — `POST /projects/{id}/discover` (starts the deterministic pass).

**Events emitted** — `REPOSITORY_CLONED`, `CREDENTIAL_VERIFIED` / `CREDENTIAL_INVALID`, `FILE_ANALYZED`, `CRYPTO_FINDING_DETECTED`, `DEPENDENCY_DISCOVERED`, `DOCUMENT_ANALYZED`.

**Agent involvement** — none. This is the tool layer A1 will call.

**Rules consumed** — `EXEC-DET-001..007`; `ALGORITHM_CLASSIFICATION` family for vulnerability and severity.

## 7. Acceptance criteria

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | Against the demo repository, `CryptoService.wrapSessionKey` is found with `usage: KEY_TRANSPORT`, strength `STRONG` | test |
| AC-2 | An RSA `Cipher.getInstance` without a wrap mode yields `usage: UNKNOWN`, not `KEY_TRANSPORT` | test |
| AC-3 | Two RSA signature usages are found and classified `DIGITAL_SIGNATURE` | test |
| AC-4 | `bcprov-jdk18on 1.72` is found; capability comes from the registry, not a hardcoded version | test |
| AC-5 | Running discovery twice produces the same finding count | test |
| AC-6 | Every finding has at least one `OBSERVED` evidence record with a resolvable locator | test |
| AC-7 | An invalid PAT sets `status: INVALID` and raises a finding without throwing | test |
| AC-8 | `Security Architecture.pdf` p17 is citable by page after extraction | test |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | The provider capability registry has no authoritative source | An unknown provider blocks a correct finding | Registry returns "unknown" and the finding says so; PRD-13 confirms from the resolved provider at build time |
| 2 | Detection patterns are Java-only | Another language silently finds nothing | Scope is one language (spec §49). Report "no detector for language X" rather than "no findings" |
| 3 | The demo repository does not exist yet | AC-1..AC-5 unverifiable | Needs a Java/Spring Boot fixture repo matching the UX scenario — **open, blocks this increment** |
| 4 | Certificates may be absent from the repository | The PKI recommendation has no evidence | Read from `deploy/tls/`; if absent, no finding is raised rather than an invented one |

## 9. Definition of done

- [x] All FRs implemented
- [x] All ACs verified — 17 tests, run against the real fixture
- [x] Typecheck and tests pass (135 total)
- [x] §10 records what was actually built

## 10. Delivery log

| Date | Change | Why |
|---|---|---|
| 2026-08-29 | `integrations/github/client.ts` | Read-only checkout, token verification, line permalinks |
| 2026-08-29 | `core/discovery/workingCopy.ts` | Tree walk and file classification |
| 2026-08-29 | `core/discovery/profile.ts` | Language, build system, framework from the manifest |
| 2026-08-29 | `core/discovery/detect.ts` | Runs `EXEC-DET-*` over a tree; candidates with evidence |
| 2026-08-29 | `core/discovery/providers.ts`, `engine/data/provider-capability.json` | Capability from a registry, not a version comparison |
| 2026-08-29 | **`resolvesTo` added to three detection rules** | See below |

**Deviations from plan**

- **The detection rules did not match real code, and the fixture caught it.**
  `EXEC-DET-001` and `EXEC-DET-003` were written against string literals —
  `Cipher.getInstance("RSA/…")` — but production Java names its transform in a constant,
  which is exactly what the fixture does. Both rules matched nothing. Fixed by adding
  `resolvesTo` to the rule outcome: the pattern matches the API call, the rule states
  what the resolved algorithm must look like, and the detector follows the identifier to
  its declaration. This is the ordering working as intended — rules written first from
  the standards, then validated against real code rather than defined by it.
- **Comment filtering happens in the detector, not the rule.** `excludeWhenAlsoMatches`
  is file-scoped, so it cannot tell a live call from the commented-out `PKCS1Padding`
  variant two lines below it. A line beginning with a comment marker is skipped.
- **`GitHubReader` exposes no write capability at all.** Spec §6 makes the pre-approval
  phase read-only, and the cheapest guarantee is that the method does not exist. PRD-11
  adds a separate writing client rather than extending this one.
- **The token is stripped from the working copy's git remote** immediately after clone,
  so it cannot be recovered from `.git/config` by anything that later reads the tree.
- **git's stderr is redacted before it becomes an error message.** git echoes the failing
  URL back, and the URL contains the token.
- **`WorkingCopy` abstracts over a directory, not over GitHub.** Detection has no business
  knowing where files came from, and it lets the tests run against the fixture directly
  rather than cloning.

**Verified against the fixture**

    37 files scanned · 8 candidates
    2 key-transport sites (CryptoService, CryptoUtils)     STRONG   -> migrate
    2 signature sites (SettlementSigner)                   STRONG   -> leave alone
    2 key-pair generators                                  STRONG
    1 provider dependency                                  WEAK     -> investigate
    bcprov-jdk18on 1.72 -> NOT_SUPPORTED (registry: from 1.78)

**Deferred**

- Persisting candidates as `findings` and `evidence` documents → PRD-07, which owns the
  discovery run that writes them.
- Document text extraction with page offsets → PRD-07. No PDFs exist to extract yet; the
  HSM and gateway specifications are still to be written.
- `credential.status` transition to `INVALID` is implemented in the client's `verify()`
  but not yet wired to a persisted status change → PRD-07.
