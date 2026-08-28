# Ruleset Extraction Prompt — v1

**Purpose.** Convert the five standards documents in `knowledge/` into machine-evaluable
rules that the Proteus assessment engine applies deterministically, without a model in
the loop.

**When this runs.** Once, at build time, as a Claude Code session with read access to
`knowledge/`. The output is committed to the repository. It is *not* invoked at runtime:
the assessment engine loads the committed JSON and evaluates it in code.

**Why it exists.** `docs/pqc_migration_data_model_v1.md` §8 states that deterministic
verification needs a machine-readable definition of "migrated" — a rule with an id that
can be re-run, diffed and cited, rather than a model opinion. This prompt produces those
rules, and binds each one to a verbatim quotation from a named standard.

---

## 1. Role

You are a standards analyst producing an executable rule base. You are not summarising
the documents and not advising on migration. Every unit of output is a rule that code
can evaluate against a fact the engine actually holds, or it is not output at all.

Two failure modes matter more than incompleteness:

1. **A rule that cannot be evaluated by code.** It will be silently skipped by the engine
   or, worse, quietly turned back into a prompt.
2. **A rule that is not in the documents.** You know a great deal about post-quantum
   cryptography from training. None of it may enter the output. The rule base's entire
   value is that every entry is traceable to a named standard, section and page.

When in doubt, emit fewer rules and record the omission in `gaps.md`.

---

## 2. The corpus

Read every page of all five documents. Page counts are given so you can validate your own
citations — a rule citing a page outside the document's range is a fabricated rule.

| # | File (in `knowledge/`) | Pages | Publisher · Status | Authority tier |
|---|---|---|---|---|
| 1 | `NIST.FIPS.203.pdf` — *Module-Lattice-Based Key-Encapsulation Mechanism Standard* | 56 | NIST · **Final**, Aug 2024 | **A — Normative, final** |
| 2 | `NIST.SP.800-227.pdf` — *Recommendations for Key-Encapsulation Mechanisms* | 64 | NIST · **Final**, Sep 2025 | **A — Normative, final** |
| 3 | `NIST.IR.8547.ipd.pdf` — *Transition to Post-Quantum Cryptography Standards* | 29 | NIST · **Initial Public Draft**, Nov 2024 | **B — Draft** |
| 4 | `pqc-migration-nist-sp-1800-38b-preliminary-draft.pdf` — *Quantum Readiness: Cryptographic Discovery, Vol. B* | 68 | NIST NCCoE · **Preliminary draft** | **C — Informative practice guide** |
| 5 | `Strategy-for-Migrating-to-Automated-PQC-Discovery-and-Inventory-Tools.pdf` | 10 | **CISA** (not NIST) · Aug 2024 | **C — Informative agency guidance** |

**Authority governs what a rule may do, not merely how it is labelled:**

- **Tier A** may produce `gating: true` rules — rules that can fail a deterministic
  verification check and block a migration from being marked VERIFIED.
- **Tier B and C may never produce `gating: true`.** A draft's transition dates and a
  practice guide's recommendations inform severity, ordering, and report text. They do not
  block. Setting `gating: true` on a tier B or C rule is an error, not a judgment call.

Extraction is per-document and independent. Reconcile across documents only in the merge
step (§8), never by silently blending two sources into one rule.

---

## 3. What "deterministic" means here — the binding constraint

A rule is admissible only if its condition can be evaluated by ordinary code against
facts the engine already holds at assessment time. That set is closed. It is:

```text
FROM A DETECTED CRYPTOGRAPHIC USE
  algorithm            string      "RSA-2048", "ECDH-P256", "AES-256-GCM"
  keySize              integer     2048
  curve                string      "P-256"
  usage                enum        CryptoUsage (see the schema module)
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

FROM THE DEPENDENCY GRAPH
  nodeType             enum        NodeType (HSM, OT_DEVICE, VENDOR_DEPENDENCY, …)
  vendor               string
  model                string
  firmwareVersion      string

FROM UPLOADED DOCUMENTS
  documentText         string      extracted text of a spec the user supplied
  documentDeclaresAlgorithms  string[]   algorithms a device spec explicitly lists

FROM THE ENVIRONMENT
  currentDate          date        for transition-timeline rules
  protectionLifetime   integer     years, if the user supplied one in instructions
```

If a rule's condition needs anything outside that list — intent, criticality, business
context, "whether the system is externally facing", a human's risk appetite — it is **not
machine-evaluable**. Emit it with `machineEvaluable: false` and `gating: false`. Such rules
are retained: the assessment report cites them as considerations, and they document why
the engine deliberately does not decide. They simply never gate anything.

**Do not invent an input to make a rule fit.** If a standard's requirement depends on a
fact the engine cannot observe, that is a finding about the engine's limits, and belongs
in `gaps.md`.

---

## 4. Rule families

Every rule belongs to exactly one family. The family determines the shape of `then`.

| Family | Answers | Feeds |
|---|---|---|
| `ALGORITHM_CLASSIFICATION` | Is this algorithm, in this usage, quantum-vulnerable? | finding severity, `impact` |
| `MIGRATION_TARGET` | What replaces it? | `MigrationPolicyRule`, plan items |
| `PARAMETER_SELECTION` | Which parameter set of the target? | plan item detail, verification |
| `DETECTION_SIGNATURE` | How is it found in source, config, manifest or certificate? | `scan_crypto`, `PROHIBITED_CRYPTO_ABSENT` |
| `USAGE_CONSTRAINT` | What must hold for the replacement to be used correctly? | generated tests, `REQUIRED_PQC_PRESENT` |
| `TRANSITION_TIMELINE` | By when is it deprecated or disallowed? | severity, ordering |
| `HYBRID_CONSTRUCTION` | When is a PQ/T hybrid permitted, and how combined? | plan items, external-interface findings |
| `DISPOSITION` | Is this inside the autonomy boundary? | `Disposition`, recommendations |
| `INVENTORY_FIELD` | What must the crypto inventory record? | discovery completeness |
| `VERIFICATION_ASSERTION` | What must be true after migration? | deterministic verification checks |

---

## 5. Output schema

One JSON object per rule. Field order as shown, so re-runs diff cleanly.

```jsonc
{
  "ruleId": "FIPS203-8.1-001",        // {DOC_TAG}-{SECTION}-{3-digit seq}, stable
  "family": "PARAMETER_SELECTION",
  "title": "ML-KEM-768 targets security category 3",

  "authority": "NORMATIVE_FINAL",     // NORMATIVE_FINAL | NORMATIVE_DRAFT | INFORMATIVE
  "normativeStrength": "SHALL",       // SHALL | SHALL_NOT | SHOULD | SHOULD_NOT | MAY | STATEMENT
  "machineEvaluable": true,
  "gating": false,                    // true only when authority is NORMATIVE_FINAL

  "when": { /* §6 predicate — omit or {} for an unconditional statement */ },
  "then": { /* family-specific outcome — see §6 */ },

  "quote": "…verbatim, ≤ 300 characters, copied exactly from the document…",
  "source": {
    "document": "NIST.FIPS.203.pdf",
    "section": "8.1",
    "page": 43                        // the PDF page the quote appears on
  },
  "evidenceClass": "OBSERVED",        // OBSERVED when the document states it directly;
                                      // INFERRED when you derived it — see §9
  "confidence": 1.0,                  // 1.0 only for OBSERVED
  "supersedes": [],                   // ruleIds this overrides after merge (§8)
  "notes": ""                         // why it is not machine-evaluable, caveats, scope limits
}
```

`ruleId` must be reproducible: derive `DOC_TAG` from the table in §2 (`FIPS203`, `SP800-227`,
`IR8547`, `SP1800-38B`, `CISA-ACDI`), use the document's own section number, and number
sequentially within that section in reading order. A second run over an unchanged corpus
must produce identical ids.

---

## 6. Predicate and outcome vocabulary — closed sets

### `when`

Every key is optional; all present keys are ANDed. Only these keys exist:

```jsonc
{
  "algorithmMatches": "^RSA($|-)",         // regex, case-insensitive, anchored by you
  "usage": "KEY_TRANSPORT",                 // a single CryptoUsage value
  "usageIn": ["KEY_TRANSPORT", "KEY_ESTABLISHMENT"],
  "keySize": { "op": "lt", "value": 3072 }, // op: lt | lte | eq | gte | gt
  "curveMatches": "^P-(256|384)$",
  "modeMatches": "OAEP",
  "fileKind": "MANIFEST",
  "filePathMatches": "\\.(java|kt)$",
  "dependencyMatches": "^bcprov",
  "dependencyVersion": { "op": "lt", "value": "1.78" },
  "nodeType": "HSM",
  "documentDeclaresNone": ["ML-KEM", "ML-DSA"],  // spec lists none of these
  "dateAfter": "2030-12-31",               // compared against currentDate
  "securityCategory": 3
}
```

Anything else is out of vocabulary. If a condition cannot be written with these keys,
the rule is not machine-evaluable — say so rather than inventing a key.

### `then`, by family

```jsonc
// ALGORITHM_CLASSIFICATION
{ "quantumVulnerable": true, "severity": "CRITICAL", "impact": "MIGRATION_REQUIRED" }

// MIGRATION_TARGET
{ "target": "ML-KEM", "targetFamily": "KEM", "requiresParameterSelection": true }

// PARAMETER_SELECTION
{ "parameterSet": "ML-KEM-768", "securityCategory": 3 }

// DETECTION_SIGNATURE
{ "patterns": ["Cipher\\.getInstance\\(\"RSA/[^\"]*\"\\)"],
  "patternType": "REGEX", "appliesTo": "SOURCE", "language": "Java",
  "impliesUsage": "KEY_TRANSPORT", "impliesUsageConfidence": "STRONG" }

// USAGE_CONSTRAINT
{ "requirement": "SHARED_SECRET_MUST_BE_POST_PROCESSED",
  "verifiableBy": "REQUIRED_PATTERN", "patterns": ["KDF|HKDF|deriveKey"] }

// TRANSITION_TIMELINE
{ "deprecatedAfter": "2030-12-31", "disallowedAfter": "2035-12-31" }

// HYBRID_CONSTRUCTION
{ "hybridPermitted": true, "approvedCombiner": "…", "componentsRequired": ["ML-KEM", "ECDH"] }

// DISPOSITION
{ "disposition": "VENDOR_DEPENDENCY",
  "recommendationDisposition": "HARDWARE_REPLACEMENT",
  "autonomyBoundary": "OUTSIDE", "suggestedOwner": "…" }

// INVENTORY_FIELD
{ "field": "…", "required": true, "appliesTo": "…" }

// VERIFICATION_ASSERTION
{ "check": "PROHIBITED_CRYPTO_ABSENT",       // a VerificationCheck value
  "assertion": "ABSENT" | "PRESENT",
  "patterns": ["…"] }
```

`VerificationCheck`, `CryptoUsage`, `Disposition`, `RecommendationDisposition`, `NodeType`
and `MigrationImpact` values must come verbatim from `schema/src/enums.ts`. Read that file
before you emit a single rule. Any value not in those enums is invalid output.

---

## 7. Extraction protocol

Work one document at a time, front to back. Do not begin the merge until all five are done.

For each document:

1. **Map it first.** Record the section structure and mark each section as *normative*,
   *informative*, or *illustrative*. NIST documents are explicit about this; honour it.
   Pseudocode listings, worked examples and glossaries are not rule sources.
2. **Read every page.** Not a skim, and not a search for keywords. A single sentence in a
   requirements subsection is worth more than an entire example chapter.
3. **Flag requirement language as you go.** "shall", "shall not", "is approved",
   "is not approved", "must", "required", "should", "may", and any table of permitted
   parameters or deprecation dates. Tables are the densest rule source in this corpus and
   the easiest to skip.
4. **Draft a rule per requirement.** Then apply §3: can code evaluate it? If not, keep it
   with `machineEvaluable: false` and say why in `notes`.
5. **Quote before you write the rule.** Copy the sentence verbatim first, then write
   `when`/`then` to match it. Writing the rule first and hunting for support afterwards is
   how fabricated citations happen.
6. **Record coverage.** For every section, note whether it yielded rules, and if not, why
   ("mathematical specification, no engine-evaluable requirement").

### Where the rules actually are

Guidance, not a substitute for reading:

- **FIPS 203** — §3.3 *Requirements for ML-KEM Implementations* and the parameter-set
  tables (approved sets, security categories, key and ciphertext sizes) are the primary
  yield. §4–§7 are algorithm specification: read for definitions, expect few rules.
  This is the authority for what a valid ML-KEM target is.
- **SP 800-227** — the highest-yield document for `USAGE_CONSTRAINT`. §1.3 *Requirements*,
  §3 *Requirements for Secure KEM Implementations*, §4.2 *Conditions for Using KEMs
  Securely*, §4.3 *Post Processing of the Shared Secret Key*, §4.4 *Key Confirmation*,
  §4.5 *Proof of Possession*, and §4.6 *Multi-Algorithm KEMs and PQ/T Hybrids* — including
  §4.6.2 *Approved Key Combiners*. §5 is examples: illustrative, not normative. Note §5.1.2
  *A KEM From RSA Secret-Value Encapsulation* — it explains the exact construction Proteus
  migrates away from, and is valuable for detection signatures even though it is not a rule
  source.
- **IR 8547 ipd** — §4 *Towards a PQC Standards Transition Timeline*, especially §4.1.2
  *Key Establishment* and §4.1.1 *Digital Signatures*, is the source for every
  `TRANSITION_TIMELINE` rule. §3.2 covers hybrids. **Draft: tier B, never gating.** Every
  rule from this document must carry a `notes` entry recording that its dates are from an
  initial public draft and may change.
- **SP 1800-38B** — §3.2.3 *Vulnerable Cryptographic Algorithms* and §4.1.4 *Common Output
  Elements* (with §4.1.4.1 *Network Discovery Analysis* and §4.1.4.2 *Static Analysis*) are
  the source for `DETECTION_SIGNATURE` and discovery scope. §3.4 risk methodologies,
  including Mosca's theorem, are mostly not machine-evaluable — capture them, mark them
  so, and note which input they would need.
- **CISA ACDI strategy** — §2 *Inventory Data Items for Reporting* is essentially a list of
  `INVENTORY_FIELD` rules. Short document, high density. Note the publisher is CISA, not
  NIST, in every rule's `notes`.

---

## 8. Merge and conflict resolution

After all five documents are extracted, merge into one ruleset.

Two rules **conflict** when their `when` clauses can both match the same input and their
`then` outcomes are incompatible. Overlapping conditions with compatible outcomes are not a
conflict — both apply.

Resolution, in order:

1. **Higher authority tier wins.** A > B > C. Record the loser's id in the winner's
   `supersedes` and keep both rules in the file.
2. **Same tier: the more specific `when` wins** — more keys, or a narrower regex.
3. **Same tier, same specificity: the later publication date wins.**
4. **Still unresolved: neither gates.** Set `gating: false` on both and record the conflict
   in `conflicts.md` with the two quotations side by side, for a human to settle.

Never resolve a conflict by editing a quotation, widening a regex, or merging two sources
into a single synthesised rule.

---

## 9. Fabrication controls

These are hard constraints, not preferences.

- **Every rule carries a verbatim `quote`** that appears in the document, and a `page`
  within that document's range (§2). Before writing a rule, confirm the quote is copied,
  not reconstructed.
- **No rule may rest on outside knowledge.** If you know ML-KEM-768 is the common choice
  for TLS but no document in this corpus says so, it does not become a rule. Log it in
  `gaps.md`.
- **`evidenceClass: "OBSERVED"`** requires the document to state the rule directly.
  If you combined two statements — a parameter table plus a category definition — the rule
  is `INFERRED`, `confidence` must be below 1.0, both sources go in `notes`, and it may not
  gate. This mirrors the same distinction the product makes in its dependency graph.
- **No rule for an algorithm a document does not name.** Absence of a prohibition is not a
  prohibition; absence of an endorsement is not an endorsement.
- **Never widen a regex to catch cases you expect but the document does not describe.**
  A `DETECTION_SIGNATURE` derived from an example in SP 1800-38B covers what that example
  covers; note the limit rather than generalising it.
- **Preserve the document's own scope qualifiers.** "For federal systems", "when used with
  approved key derivation", "in FIPS mode" belong in `when` if expressible and in `notes`
  if not. Stripping a qualifier turns a narrow requirement into a false universal.

---

## 10. Outputs

Write exactly these files. No timestamps or run ids anywhere in them — a re-run over an
unchanged corpus must produce a byte-identical diff of zero.

```text
engine/rulesets/
├── fips-203.rules.json           per-document extractions, rules sorted by ruleId
├── sp-800-227.rules.json
├── ir-8547.rules.json
├── sp-1800-38b.rules.json
├── cisa-acdi.rules.json
├── ruleset.json                  the merged, conflict-resolved rule base the engine loads
├── coverage.md                   every section of every document → rules yielded, or why none
├── conflicts.md                  unresolved conflicts, quotations side by side
└── gaps.md                       what the engine needs that this corpus does not establish
```

`ruleset.json` is the only file the engine reads:

```jsonc
{
  "schemaVersion": 1,
  "corpus": [ { "document": "…", "pages": 56, "authority": "NORMATIVE_FINAL" } ],
  "rules": [ /* every rule, sorted by ruleId */ ],
  "conflictsUnresolved": [ "IR8547-4.1.2-003", "SP1800-38B-3.2.3-011" ]
}
```

`gaps.md` is not a leftovers file — it is a deliverable. Anything the assessment engine
needs and this corpus does not settle belongs there, each entry naming the decision, why
the corpus does not answer it, and who would have to decide. Expect entries for
organisation-specific protection lifetimes, vendor capability, and anything requiring
business context.

---

## 11. Self-checks before you finish

Run all of these and report the results. Fix what fails; report honestly what you cannot.

1. **Citations resolve.** Every `page` is within its document's range, and every `quote`
   is found verbatim in that document. Report the count checked.
2. **Enums are valid.** Every enum-typed value in every `then` exists in
   `schema/src/enums.ts`. Any that does not is listed explicitly.
3. **Vocabulary is closed.** No `when` uses a key outside §6.
4. **Authority is respected.** No rule from IR 8547, SP 1800-38B or the CISA strategy has
   `gating: true`. No `INFERRED` rule has `gating: true` or `confidence` of 1.0.
5. **Ids are unique and reproducible**, and the file is sorted by `ruleId`.
6. **The primary scenario is supported.** The product's reference migration is RSA-based
   key transport → ML-KEM-768. Name the exact rules that establish (a) RSA in key-transport
   usage is quantum-vulnerable, (b) a KEM is the correct replacement family, (c) ML-KEM-768
   is a valid parameter set, and (d) what must hold for the resulting shared secret to be
   used correctly. **If any of the four is not supported by a rule with a verbatim
   quotation, say so plainly** — do not manufacture the rule to close the gap. A missing
   link here is exactly the kind of thing this whole exercise exists to surface.
7. **Determinism.** State the rule count per document and per family, so a second run can
   be compared against it.

Finish with a short summary: rules by family, rules by authority tier, how many gate, how
many are not machine-evaluable, unresolved conflicts, and the three most consequential
entries in `gaps.md`.
