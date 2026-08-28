# Ruleset Extraction Prompt — v2

Supersedes v0 and v1. v1 contributed the machine-evaluability spine — a closed input
set, authority tiers that bind what a rule may *do*, verbatim citations, and binding to
the codebase's own enums. v0 contributed the things that make the output useful rather
than merely valid — prohibitions as first-class rules, a bounded rule budget, and a
demo-scoped subset. Both are here.

**Purpose.** Convert the standards documents in `knowledge/` into machine-evaluable rules
that the Proteus assessment engine applies deterministically, without a model in the loop.

**When this runs.** Once, at build time, as a Claude Code session with read access to
`knowledge/`. Output is committed to the repository. It is *not* invoked at runtime: the
engine loads the committed JSON and evaluates it in code.

**Why it exists.** `docs/pqc_migration_data_model_v1.md` §8 states that deterministic
verification needs a machine-readable definition of "migrated" — a rule with an id that
can be re-run, diffed and cited, rather than a model opinion. This prompt produces those
rules and binds each one to a verbatim quotation from a named standard.

---

## 1. Role, and the three failure modes

You are a standards analyst producing an executable rule base. You are not summarising the
documents and not advising on migration.

Three failures matter more than incompleteness. In order of severity:

1. **A rule that licenses a wrong migration.** The agent acts autonomously after one
   approval. A rule that lets it replace an RSA *signature* with a KEM is worse than no
   rule at all — see §8.
2. **A rule that is not in the documents.** You know a great deal about post-quantum
   cryptography from training. None of it may enter the rule base. The base's entire value
   is that every entry traces to a named standard, section and page.
3. **A rule that cannot be evaluated by code.** It will be silently skipped by the engine
   or, worse, quietly turned back into a prompt.

When in doubt: emit fewer rules, and record what you left out (§12).

---

## 2. Scope and budget

This extraction serves one product with one reference scenario. It is not a general
survey of the PQC literature.

**Reference scenario:** a Java / Spring Boot application using RSA-2048 for key transport,
migrating to ML-KEM-768, with a Bouncy Castle dependency, a partner handshake mock, an
HSM holding signing keys, and an OT gateway with firmware-fixed cryptography.

**Prioritise, in this order:** RSA in key-establishment and key-transport usage · ML-KEM
and its parameter selection · shared-secret handling · crypto library and dependency
constraints · TLS and protocol-managed cryptography · HSM, hardware and vendor-controlled
cryptography · certificates · discovery and inventory · verification of migrated
implementations · crypto agility.

**Signatures:** identify and classify them, and write the prohibitions that keep them out
of KEM migration (§8). Do not build out a signature-migration rule set unless the corpus
directly supports it.

### The necessity test

Every rule admitted to `ruleset.json` must answer **yes** to at least one:

1. Does the reference scenario touch it?
2. Does it prevent a wrong or unsafe migration?
3. Does it gate a deterministic verification check?
4. Does it define what the cryptographic inventory must record?

A rule that fails all four is real, sourced, and out of scope. It goes to
`coverage.md` under "extracted, out of scope" — not into the ruleset.

**Target: 25–40 rules.** This corpus can yield several hundred if you transcribe every
table row; that is not the goal and it degrades the engine. Do not inflate the count, and
do not pad with near-duplicates that differ only in a parameter value — one rule with a
`keySize` predicate beats six rules for six key sizes. Equally, do not suppress a rule that
passes the necessity test to stay under a number.

---

## 3. The corpus

Read every page of all five documents. Page counts let you validate your own citations: a
rule citing a page outside its document's range is a fabricated rule.

| # | File (in `knowledge/`) | Pages | Publisher · Status | Tier |
|---|---|---|---|---|
| 1 | `NIST.FIPS.203.pdf` — *Module-Lattice-Based Key-Encapsulation Mechanism Standard* | 56 | NIST · **Final**, Aug 2024 | **A** |
| 2 | `NIST.SP.800-227.pdf` — *Recommendations for Key-Encapsulation Mechanisms* | 64 | NIST · **Final**, Sep 2025 | **A** |
| 3 | `NIST.IR.8547.ipd.pdf` — *Transition to Post-Quantum Cryptography Standards* | 29 | NIST · **Initial Public Draft**, Nov 2024 | **B** |
| 4 | `pqc-migration-nist-sp-1800-38b-preliminary-draft.pdf` — *Quantum Readiness: Cryptographic Discovery, Vol. B* | 68 | NIST NCCoE · **Preliminary draft** | **C** |
| 5 | `Strategy-for-Migrating-to-Automated-PQC-Discovery-and-Inventory-Tools.pdf` | 10 | **CISA** (not NIST) · Aug 2024 | **C** |

**Tier governs what a rule may do, not merely how it is labelled:**

- **Tier A — normative, final.** May set `gating: true`: the rule can fail a deterministic
  verification check and block a migration from being marked VERIFIED.
- **Tier B — draft.** Never gating. A draft's transition dates inform severity, ordering
  and report text. They do not block.
- **Tier C — informative.** Never gating. Practice guidance and agency strategy.

Setting `gating: true` on a tier B or C rule is an error, not a judgment call. This is the
rule most likely to be violated in practice, because the draft (IR 8547) holds the most
quotable content in the corpus — the 2030/2035 dates.

If further documents are added later, place them by this hierarchy: final FIPS → final NIST
SP → NIST NCCoE → IETF RFC → CISA/NSA/NIST joint guidance → draft NIST → government
memoranda. Only the first two tiers may gate.

Extract per-document and independently. Reconcile only in the merge step (§10), never by
silently blending two sources into one rule.

---

## 4. What "deterministic" means — the binding constraint

A rule is admissible only if its condition can be evaluated by ordinary code against facts
the engine already holds at assessment time. That set is closed:

```text
FROM A DETECTED CRYPTOGRAPHIC USE
  algorithm            string      "RSA-2048", "ECDH-P256", "AES-256-GCM"
  keySize              integer     2048
  curve                string      "P-256"
  usage                enum        CryptoUsage
  mode                 string      "OAEP", "GCM", "CBC"

FROM THE REPOSITORY
  filePath             string
  fileContent          string      full text of a source, config or manifest file
  fileKind             enum        SOURCE | CONFIG | MANIFEST | TEST | CERTIFICATE
  dependencyName       string      "bcprov-jdk18on"
  dependencyVersion    string      "1.72"       (semver-comparable where parseable)
  language             string      "Java"
  buildSystem          string      "Maven"

FROM CERTIFICATES AND KEYS
  signatureAlgorithm   string
  publicKeyAlgorithm   string
  keyLength            integer
  keyStorageLocation   enum        SOURCE | CONFIG | KEYSTORE | HSM | UNKNOWN

FROM THE DEPENDENCY GRAPH
  nodeType             enum        NodeType (HSM, OT_DEVICE, VENDOR_DEPENDENCY, …)
  vendor               string
  model                string
  firmwareVersion      string
  protocolManaged      boolean     crypto negotiated by a protocol stack, not app code

FROM UPLOADED DOCUMENTS
  documentText                string
  documentDeclaresAlgorithms  string[]   algorithms a device spec explicitly lists

FROM THE ENVIRONMENT
  currentDate          date        for transition-timeline rules
  protectionLifetime   integer     years, only if the user supplied one in instructions
```

If a rule's condition needs anything outside that list — intent, business criticality,
whether a system is externally facing, a human's risk appetite — it is **not
machine-evaluable**. Emit it with `machineEvaluable: false` and `gating: false`. Such rules
are kept: the assessment report cites them as considerations, and they document where the
engine deliberately declines to decide. They never gate.

**Do not invent an input to make a rule fit.** If a requirement depends on a fact the
engine cannot observe, that is a finding about the engine's limits and belongs in
`gaps.md`.

---

## 5. Rule families

Every rule belongs to exactly one family.

| Family | Answers | Feeds |
|---|---|---|
| `ALGORITHM_CLASSIFICATION` | Is this algorithm, in this usage, quantum-vulnerable? | finding severity, `impact` |
| `USAGE_CLASSIFICATION` | How do we tell key establishment from signature from transport? | `CryptoUsage` assignment |
| `MIGRATION_TARGET` | What replaces it? | `MigrationPolicyRule`, plan items |
| `PARAMETER_SELECTION` | Which parameter set of the target? | plan detail, verification |
| `PROHIBITION` | What must the agent **not** do here? | plan-item suppression, gates |
| `DETECTION_SIGNATURE` | How is it found in source, config, manifest, certificate? | `scan_crypto`, `PROHIBITED_CRYPTO_ABSENT` |
| `USAGE_CONSTRAINT` | What must hold for the replacement to be used correctly? | generated tests, `REQUIRED_PQC_PRESENT` |
| `TRANSITION_TIMELINE` | By when is it deprecated or disallowed? | severity, ordering |
| `HYBRID_CONSTRUCTION` | When is a PQ/T hybrid permitted, and how combined? | plan items, external interfaces |
| `DISPOSITION` | Is this inside the autonomy boundary? Who owns it? | `Disposition`, recommendations |
| `INVENTORY_FIELD` | What must the cryptographic inventory record? | discovery completeness |
| `VERIFICATION_ASSERTION` | What must be true after migration? | deterministic verification |

`USAGE_CLASSIFICATION` and `PROHIBITION` exist because of §8. They are not optional.

---

## 6. Output schema

One JSON object per rule. Field order as shown, so re-runs diff cleanly.

```jsonc
{
  "ruleId": "FIPS203-8.1-001",        // {DOC_TAG}-{SECTION}-{3-digit seq}, reproducible
  "family": "PARAMETER_SELECTION",
  "title": "ML-KEM-768 provides security category 3",

  "authority": "NORMATIVE_FINAL",     // NORMATIVE_FINAL | NORMATIVE_DRAFT | INFORMATIVE
                                      // — what the DOCUMENT is
  "evidenceClass": "OBSERVED",        // OBSERVED | INFERRED
                                      // — whether YOU derived it (§11)
  "normativeStrength": "SHALL",       // SHALL | SHALL_NOT | SHOULD | SHOULD_NOT | MAY | STATEMENT
  "confidence": 1.0,                  // 1.0 only when OBSERVED
  "machineEvaluable": true,
  "gating": false,                    // true requires NORMATIVE_FINAL + OBSERVED
  "inDemoScope": true,                // reachable from the §2 reference scenario

  "when": { /* §7 predicate — omit or {} for an unconditional statement */ },
  "then": { /* family-specific outcome — §7 */ },

  "prohibitedActions": [],            // §7 action vocabulary; actions the agent must NOT
                                      // take when this rule matches. Any family may use it.

  "quote": "…verbatim, ≤ 300 characters, copied exactly from the document…",
  "source": {
    "document": "NIST.FIPS.203.pdf",
    "section": "8",
    "page": 43                        // PDF page number, not printed page number
  },
  "supersedes": [],                   // ruleIds this overrides after merge (§10)
  "notes": ""                         // scope qualifiers, draft caveats, why not evaluable
}
```

`ruleId` must be reproducible: `DOC_TAG` from §3 (`FIPS203`, `SP800-227`, `IR8547`,
`SP1800-38B`, `CISA-ACDI`), the document's own section number, then sequential numbering
within that section in reading order. A second run over an unchanged corpus produces
identical ids.

**Rules are atomic.** "Detect RSA usage", "classify the usage as key transport", "RSA key
transport is quantum-vulnerable", "the replacement family is a KEM", "ML-KEM-768 is a valid
parameter set", "RSA signature usage must not migrate to a KEM" are six rules, not one.
A rule whose `notes` field is doing the real work has been written at the wrong grain.

---

## 7. Closed vocabularies

### `when`

All present keys are ANDed. Only these keys exist:

```jsonc
{
  "algorithmMatches": "^RSA($|-)",          // regex, case-insensitive, you anchor it
  "usage": "KEY_TRANSPORT",                  // one CryptoUsage value
  "usageIn": ["KEY_TRANSPORT", "KEY_ESTABLISHMENT"],
  "usageUnknown": true,                      // usage not yet classified
  "keySize": { "op": "lt", "value": 3072 },  // op: lt | lte | eq | gte | gt
  "securityStrengthBits": { "op": "eq", "value": 112 },
  "curveMatches": "^P-(256|384)$",
  "modeMatches": "OAEP",
  "fileKind": "MANIFEST",
  "filePathMatches": "\\.(java|kt)$",
  "dependencyMatches": "^bcprov",
  "dependencyVersion": { "op": "lt", "value": "1.78" },
  "nodeType": "HSM",
  "keyStorageLocation": "HSM",
  "protocolManaged": true,
  "documentDeclaresNone": ["ML-KEM", "ML-DSA"],   // spec lists none of these
  "dateAfter": "2030-12-31",                 // compared against currentDate
  "securityCategory": 3
}
```

Anything else is out of vocabulary. If a condition cannot be written with these keys, the
rule is not machine-evaluable — say so rather than inventing a key.

### `then`, by family

```jsonc
// ALGORITHM_CLASSIFICATION
{ "quantumVulnerable": true, "severity": "CRITICAL", "impact": "MIGRATION_REQUIRED" }

// USAGE_CLASSIFICATION
{ "impliesUsage": "KEY_TRANSPORT", "strength": "STRONG" }   // STRONG | WEAK
                                                            // WEAK never auto-assigns usage

// MIGRATION_TARGET
{ "target": "ML-KEM", "targetFamily": "KEM", "requiresParameterSelection": true }

// PARAMETER_SELECTION
{ "parameterSet": "ML-KEM-768", "securityCategory": 3, "securityStrengthBits": 192 }

// PROHIBITION
{ "prohibits": "MIGRATE_TO_KEM",
  "engineBehaviour": "SUPPRESS_PLAN_ITEM",   // SUPPRESS_PLAN_ITEM | FORCE_DISPOSITION | RAISE_GATE
  "forcedDisposition": "NEEDS_FURTHER_INVESTIGATION",   // when FORCE_DISPOSITION
  "reason": "…" }

// DETECTION_SIGNATURE
{ "patterns": ["Cipher\\.getInstance\\(\"RSA/[^\"]*\"\\)"],
  "patternType": "REGEX", "appliesTo": "SOURCE", "language": "Java",
  "impliesUsage": "KEY_TRANSPORT", "strength": "STRONG" }

// USAGE_CONSTRAINT
{ "requirement": "SHARED_SECRET_MUST_BE_POST_PROCESSED",
  "verifiableBy": "REQUIRED_PATTERN", "patterns": ["KDF|HKDF|deriveKey"] }

// TRANSITION_TIMELINE
{ "status": "DEPRECATED", "deprecatedAfter": "2030-12-31", "disallowedAfter": "2035-12-31" }

// HYBRID_CONSTRUCTION
{ "hybridPermitted": true, "combinerSpec": "…", "componentsRequired": ["ML-KEM", "ECDH"] }

// DISPOSITION
{ "disposition": "VENDOR_DEPENDENCY",
  "recommendationDisposition": "HARDWARE_REPLACEMENT",
  "autonomyBoundary": "OUTSIDE", "suggestedOwner": "…" }

// INVENTORY_FIELD
{ "field": "…", "required": true, "automatable": true, "appliesTo": "…" }

// VERIFICATION_ASSERTION
{ "check": "PROHIBITED_CRYPTO_ABSENT",     // a VerificationCheck value
  "assertion": "ABSENT",                    // ABSENT | PRESENT
  "patterns": ["…"] }
```

### `prohibitedActions`

Closed set. These are the agent's action types:

```text
REPLACE_ALGORITHM · MODIFY_SOURCE · UPGRADE_DEPENDENCY · MODIFY_CONFIGURATION
GENERATE_KEY · REUSE_EXISTING_KEY_MATERIAL · CREATE_TEST · MODIFY_TEST · MODIFY_MOCK
REMOVE_LEGACY_ALGORITHM · DEPLOY_SANDBOX · ASSUME_CAPABILITY
```

`CryptoUsage`, `Disposition`, `RecommendationDisposition`, `NodeType`, `MigrationImpact`,
`Severity` and `VerificationCheck` values must come verbatim from `schema/src/enums.ts`.
**Read that file before emitting a single rule.** Any value not in those enums is invalid
output.

---

## 8. Detection is not migration — the rule that protects everything else

Product Spec §8 is explicit: the prototype must not imply that every RSA occurrence maps
to ML-KEM. Encode that structurally, in three separated steps:

```text
1. DETECTION_SIGNATURE      RSA is present at this location
2. USAGE_CLASSIFICATION     the usage is key transport / signature / unknown
3. MIGRATION_TARGET         key transport → KEM        (and ONLY key establishment usages)
   PROHIBITION              signature → not a KEM
```

No `MIGRATION_TARGET` rule may fire on algorithm alone. Every one carries a `usage` or
`usageIn` predicate. A detection rule may *suggest* a usage via `impliesUsage`, but a
`strength: "WEAK"` suggestion must never auto-assign usage — it produces a finding with
`usage: "UNKNOWN"` for investigation.

### Prohibitions to look for

Negative rules are as valuable as positive ones and are systematically under-extracted,
because standards state them as scope limits rather than warnings. Search deliberately for
support for each of these. **Write the rule only where the corpus supports it**; where it
does not, the candidate goes to `requires-source.md` (§12) — never into the ruleset on
your own authority:

- A KEM must not be used for digital signatures.
- ML-KEM must not be treated as general-purpose encryption of arbitrary messages.
- Existing RSA or ECC key material must not be reused as ML-KEM key material.
- Protocol-managed cryptography (TLS, IKE) must not be rewritten in application code
  without regard to interoperability with the peer.
- HSM, secure-element or firmware-controlled cryptography must not be assumed to support
  PQC absent a declaration in the supplied specification.
- A classical algorithm required for interoperability must not be silently removed.
- A KEM shared secret must not be used directly as keying material where the standard
  requires post-processing.
- Deprecated is not disallowed: a deprecated algorithm must not be treated as a failure
  condition before its disallowance date.

The last one matters for the demo: under IR 8547 the reference scenario's RSA is
*deprecated after 2030*, not currently disallowed. A rule that treats it as prohibited
today would misreport severity — and IR 8547 is a draft, so it cannot gate regardless.

---

## 9. Extraction protocol

One document at a time, front to back. No merging until all five are done.

1. **Map it first.** Record the section structure; mark each section *normative*,
   *informative*, or *illustrative*. NIST documents are explicit about this; honour it.
   Pseudocode, worked examples and glossaries are not rule sources.
2. **Read every page.** Not a skim, not a keyword search. One sentence in a requirements
   subsection outweighs an entire example chapter.
3. **Flag requirement language.** "shall", "shall not", "is approved", "is not approved",
   "must", "required", "should", "may — and every table of parameters, security
   categories or transition dates. Tables are the densest rule source here and the easiest
   to skip.
4. **Quote before you write the rule.** Copy the sentence verbatim first, then write
   `when`/`then` to match it. Writing the rule first and hunting for support afterwards is
   how fabricated citations happen.
5. **Apply the necessity test (§2)** before admitting the rule. Then check §4: can code
   evaluate it? If not, keep it with `machineEvaluable: false`.
6. **Record coverage.** Every section: rules yielded, or why none.

### Where the rules actually are

Guidance, not a substitute for reading.

- **FIPS 203** — §3.3 *Requirements for ML-KEM Implementations* and the parameter-set
  tables (approved sets, security categories, key and ciphertext sizes) are the primary
  yield, along with the scope statement in §1 that establishes what ML-KEM is *for* — which
  is the likeliest source for the signature prohibition. §4–§7 are algorithm specification:
  read for definitions, expect few rules. Tier A: this is the only document that can
  authoritatively define a valid ML-KEM target.
- **SP 800-227** — highest yield for `USAGE_CONSTRAINT` and for prohibitions. §1.3
  *Requirements*, §3 *Requirements for Secure KEM Implementations*, §4.2 *Conditions for
  Using KEMs Securely*, §4.3 *Post Processing of the Shared Secret Key*, §4.4 *Key
  Confirmation*, §4.5 *Proof of Possession*, §4.6 *Multi-Algorithm KEMs and PQ/T Hybrids*
  including §4.6.2 *Approved Key Combiners*. §5 is examples — illustrative, not normative —
  but note §5.1.2 *A KEM From RSA Secret-Value Encapsulation*: it describes the exact
  construction the reference scenario migrates away from, and is valuable for detection
  signatures even though it is not a rule source.
- **IR 8547 ipd** — §4 *Towards a PQC Standards Transition Timeline* is the source for
  every `TRANSITION_TIMELINE` rule: §4.1 (the acceptable / deprecated / disallowed / legacy
  definitions and the security-category table), §4.1.1 *Digital Signatures*, §4.1.2 *Key
  Establishment*, §4.1.3 *Symmetric Cryptography*. §3.2 covers hybrids. **Tier B: never
  gating,** and every rule from it must carry a `notes` entry recording that its dates come
  from an initial public draft and may change. Transcribe its tables exactly as printed,
  including any apparent error — flag discrepancies in `conflicts.md` and let the tier A
  document settle the fact. Do not silently correct a table.
- **SP 1800-38B** — §3.2.3 *Vulnerable Cryptographic Algorithms* and §4.1.4 *Common Output
  Elements* (with §4.1.4.1 *Network Discovery Analysis*, §4.1.4.2 *Static Analysis*) are
  the source for `DETECTION_SIGNATURE` and discovery scope. §3.4's risk methodologies,
  Mosca's theorem included, are mostly not machine-evaluable: capture them, mark them so,
  and note which input they would need.
- **CISA ACDI strategy** — §2 *Inventory Data Items for Reporting* is essentially a list of
  `INVENTORY_FIELD` rules, and it distinguishes automatable items from manual ones — carry
  that distinction into `automatable`. Short, dense. Note the publisher is CISA, not NIST,
  in every rule's `notes`.

---

## 10. Merge and conflict resolution

Two rules **conflict** when their `when` clauses can both match the same input and their
`then` outcomes are incompatible. Overlapping conditions with compatible outcomes are not
a conflict — both apply.

Resolution, in order:

1. **Higher tier wins.** A > B > C. Record the loser in the winner's `supersedes`; keep
   both rules in the file.
2. **Same tier: the more specific `when` wins** — more keys, or a narrower regex.
3. **Same tier and specificity: later publication date wins.**
4. **Still unresolved: neither gates.** Set `gating: false` on both and record the conflict
   in `conflicts.md` with both quotations side by side, for a human to settle.

A `PROHIBITION` always outranks a `MIGRATION_TARGET` it contradicts, regardless of tier.
The engine must be able to stop; a prohibition losing a tie is the one outcome this rule
base cannot afford.

Never resolve a conflict by editing a quotation, widening a regex, or merging two sources
into a synthesised rule.

---

## 11. Fabrication controls

Hard constraints, not preferences.

- **Every rule carries a verbatim `quote`** that appears in the document, and a `page`
  within that document's range (§3). Confirm the quote is copied, not reconstructed.
- **No rule may rest on outside knowledge.** If you know ML-KEM-768 is the common TLS
  choice but no document here says so, it is not a rule. It goes to `requires-source.md`.
- **`evidenceClass: "OBSERVED"`** requires the document to state the rule directly. If you
  combined two statements — a parameter table plus a category definition — the rule is
  `INFERRED`, `confidence` is below 1.0, both sources go in `notes`, and it cannot gate.
  This is the same OBSERVED/INFERRED distinction the product makes in its dependency graph,
  and it is deliberately separate from `authority`: a final standard can still yield an
  inferred rule, and an inferred rule never gates no matter how authoritative its source.
- **No rule for an algorithm a document does not name.** Absence of a prohibition is not a
  prohibition; absence of an endorsement is not an endorsement.
- **Never widen a regex** to catch cases you expect but the document does not describe. A
  signature derived from an SP 1800-38B example covers what that example covers; note the
  limit rather than generalising.
- **Preserve scope qualifiers.** "For federal systems", "when used with approved key
  derivation", "in FIPS mode" belong in `when` if expressible and in `notes` if not.
  Stripping a qualifier turns a narrow requirement into a false universal.

---

## 12. Outputs

Write exactly these files. No timestamps or run ids anywhere — a re-run over an unchanged
corpus must produce a zero diff.

```text
engine/rulesets/
├── fips-203.rules.json          per-document extractions, sorted by ruleId
├── sp-800-227.rules.json
├── ir-8547.rules.json
├── sp-1800-38b.rules.json
├── cisa-acdi.rules.json
├── ruleset.json                 the merged, conflict-resolved base the engine loads
├── coverage.md                  every section → rules yielded, or why none;
│                                plus "extracted, out of scope" (§2 necessity test)
├── conflicts.md                 unresolved conflicts, quotations side by side
├── gaps.md                      what the engine needs that this corpus does not establish
└── requires-source.md           rules that look correct but cannot be traced here
```

Output goes to `engine/rulesets/`, never to `knowledge/` — that folder is the input corpus,
and writing generated files into it destroys the distinction between source and derived.

`ruleset.json` is the only file the engine reads:

```jsonc
{
  "schemaVersion": 1,
  "corpus": [ { "document": "…", "pages": 56, "authority": "NORMATIVE_FINAL" } ],
  "rules": [ /* every rule, sorted by ruleId */ ],
  "demoSubset": [ /* ruleIds with inDemoScope: true — what to enable for the demo */ ],
  "conflictsUnresolved": [ "IR8547-4.1.2-003", "SP1800-38B-3.2.3-011" ]
}
```

**`gaps.md` and `requires-source.md` are different files and the distinction matters.**
`gaps.md` holds decisions the corpus does not settle — organisation-specific protection
lifetimes, vendor capability, anything needing business context — each entry naming the
decision, why the corpus is silent, and who would have to decide. `requires-source.md`
holds rules you believe are correct and could write, but cannot cite from these five
documents; each entry names the rule and what document would settle it. The first is about
the world; the second is about this corpus. Both are deliverables, not leftovers.

---

## 13. Self-checks before finishing

Run all of these and report results. Fix what fails; state honestly what you cannot.

1. **Citations resolve.** Every `page` is within its document's range, and every `quote`
   appears verbatim in that document. Report the count checked — programmatically, not by
   recollection.
2. **Enums are valid.** Every enum-typed value exists in `schema/src/enums.ts`. List any
   that do not.
3. **Vocabulary is closed.** No `when` key outside §7; no `prohibitedActions` entry outside
   the §7 action set.
4. **Authority is respected.** No tier B or C rule has `gating: true`. No `INFERRED` rule
   gates or carries confidence 1.0.
5. **Detection is separated from migration.** No `MIGRATION_TARGET` rule fires on algorithm
   alone — every one carries `usage` or `usageIn`. Confirm a prohibition exists covering
   signature usage, or state plainly that the corpus does not support one.
6. **Budget and necessity.** Report the rule count. If it exceeds 40, name the rules you
   would cut first and why they survived. Every rule passes at least one necessity test.
7. **Ids are unique, reproducible, and the file is sorted by `ruleId`.**
8. **The reference scenario is supported end to end.** Name the exact rules establishing:
   (a) RSA in key-transport usage is quantum-vulnerable; (b) a KEM is the correct
   replacement family; (c) ML-KEM-768 is a valid parameter set; (d) what must hold for the
   resulting shared secret to be used correctly; (e) that RSA *signature* usage is excluded
   from this migration. **If any of the five lacks a rule with a verbatim quotation, say so
   plainly** — do not manufacture the rule to close the gap. A missing link here is exactly
   what this exercise exists to surface.
9. **Determinism.** State rule counts per document and per family, so a second run can be
   compared against them.

Finish with a short summary: rules by family, by tier, how many gate, how many are not
machine-evaluable, how many are in the demo subset, unresolved conflicts, and the three
most consequential entries across `gaps.md` and `requires-source.md`.
