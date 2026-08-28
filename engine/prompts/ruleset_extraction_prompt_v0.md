You are preparing a deterministic knowledge base for an Autonomous Post-Quantum Cryptography (PQC) Migration Agent.

## Objective

Read all PQC-related PDFs/documents in the provided folder and convert the authoritative guidance into a **machine-usable deterministic migration rule set**.

The rules will be used by an autonomous migration agent during:

1. Cryptographic discovery
2. Classification
3. Risk/prioritization
4. Migration decision-making
5. Code/config/dependency migration
6. Blocker identification
7. Verification
8. Evidence/report generation

Do NOT merely summarize the PDFs.

---

## Scope

For the current prototype, prioritize:

* RSA
* DH / ECDH where relevant
* RSA-based encryption / key establishment
* Migration toward ML-KEM, especially ML-KEM-768
* Java / Spring Boot applications
* Crypto libraries and dependencies
* TLS/protocol-managed cryptography
* HSM / hardware / external-system dependencies
* Cryptographic agility
* Verification of migrated implementations

Signature migration may be identified, but if ML-DSA/SLH-DSA source material is not present, classify it as a separate migration category rather than inventing rules.

---

## Source hierarchy

Treat authoritative standards differently.

Prefer rules in this order:

1. Final NIST standards such as FIPS
2. Final NIST Special Publications
3. NIST NCCoE publications
4. IETF RFCs
5. CISA/NSA/NIST joint guidance
6. Draft NIST documents
7. Government policy/memoranda

If two documents conflict, prefer the higher-authority/final source and explicitly record the conflict.

Never invent a rule unsupported by a source.

---

## Required output

Create:

`knowledge/pqc-migration-rules.yaml`

Also create:

`knowledge/pqc-rule-review.md`

---

# YAML rule format

Every rule should use this structure:

```yaml
- id: PQC-XXX-001

  title: Short human-readable title

  category:
    # discovery | classification | migration |
    # dependency | protocol | hardware |
    # verification | security | prioritization

  applies_when:
    description: >
      Precise deterministic condition under which this rule applies.

    conditions:
      - field: algorithm
        operator: equals
        value: RSA

  required_checks:
    - check: crypto_purpose
      values:
        - key_establishment
        - encryption
        - signature
        - authentication
        - unknown

  decision:
    status:
      # migrate | no_migration_required |
      # investigate | blocked |
      # human_decision_required

    reason: >

  actions:
    - type:
      # replace_algorithm | modify_code |
      # upgrade_dependency | modify_config |
      # generate_key | create_test |
      # run_verification | raise_blocker

      description: >

  prohibited_actions:
    - >

  blocker:
    type:
      # none | hardware | protocol |
      # external_dependency | unsupported_library |
      # interoperability | business_decision

    condition: >

  verification:
    required:
      - >

  severity:
    # critical | high | medium | low | informational

  source:
    document:
    section:
    page:
    quote_or_paraphrase: >

  confidence:
    # normative | strongly_supported | guidance | inferred

  notes: >
```

---

# Important rule-authoring requirements

### 1. Rules must be atomic

Do not create large narrative rules covering many situations.

Prefer:

* detect RSA usage
* determine crypto purpose
* RSA used for signature
* RSA used for key establishment
* RSA encrypts application payload
* RSA controlled by TLS library
* RSA private key stored in HSM

as separate rules.

---

### 2. Separate detection from migration

The presence of RSA must NOT automatically mean:

`replace RSA with ML-KEM`.

First establish the cryptographic purpose.

For example:

RSA signature usage must NOT be migrated to ML-KEM.

Create an explicit prohibition rule for this.

---

### 3. Encode negative rules

Rules preventing incorrect migrations are as important as migration rules.

Examples:

* ML-KEM must not be used for signatures.
* ML-KEM should not be treated as direct arbitrary-message encryption.
* Existing RSA/ECC keys cannot simply be reused as ML-KEM key material.
* Protocol-managed crypto must not be rewritten independently without checking protocol interoperability.
* HSM-backed crypto must not be assumed to support PQC.
* Do not silently remove an interoperability-required classical algorithm.

Extract similar prohibitions from the source documents.

---

### 4. Distinguish facts from interpretation

Use:

`confidence: normative`

only when directly specified by a standard.

Use:

`strongly_supported`

when the rule is an obvious engineering consequence of authoritative guidance.

Use:

`guidance`

for recommendations.

Use:

`inferred`

only where absolutely necessary.

Minimize inferred rules.

---

### 5. Capture exact source traceability

Every rule MUST contain:

* document
* section
* page
* a short supporting paraphrase

Do not create rules without traceability.

If page numbering in the PDF differs from printed page numbering, record the PDF page number.

---

# Areas to specifically extract

Look for deterministic knowledge covering:

## Discovery

* Algorithms to inventory
* key sizes
* parameter sets
* crypto libraries/providers
* certificates
* TLS
* APIs
* dependencies
* key storage
* HSM/KMS
* external integrations
* data-protection lifetime
* crypto purpose
* protocol dependency
* software/vendor ownership

## Classification

Determine whether crypto usage is:

* key establishment
* encryption
* digital signature
* authentication
* certificate-related
* protocol-controlled
* dependency-controlled
* hardware-controlled

## Migration

Extract rules for:

* ML-KEM applicability
* ML-KEM parameter selection
* key generation
* encapsulation
* decapsulation
* shared-secret handling
* symmetric encryption integration
* dependency upgrades
* configuration changes
* protocol migration
* crypto agility

## Blockers

Explicitly model:

* HSM does not support PQC
* external peer/protocol incompatible
* third-party library lacks support
* certificate ecosystem dependency
* vendor-controlled component
* unsupported runtime/provider
* business/protocol architecture decision needed

## Verification

Extract requirements or strong recommendations for:

* successful key generation
* successful encapsulation/decapsulation
* shared-secret equality
* invalid-input handling
* existing regression tests
* build success
* dependency/version verification
* removal or controlled retention of vulnerable crypto
* interoperability
* key lifecycle
* secure randomness
* error handling

---

# Prototype-specific interpretation

The current hackathon scenario is roughly:

`Java/Spring Boot application using RSA-2048 → migrate appropriate key-establishment/encryption usage toward ML-KEM-768`

Therefore:

Prioritize rules useful to this scenario first.

Do NOT artificially generate dozens of irrelevant rules merely to increase rule count.

A useful target is approximately **20–30 high-quality atomic rules**, but quality and traceability matter more than quantity.

---

# Review file

Create `knowledge/pqc-rule-review.md` containing:

## 1. Documents processed

For each PDF:

* filename
* authority/body
* publication status
* areas used

## 2. Rules generated

Table:

| Rule ID | Rule | Source | Confidence |
| ------- | ---- | ------ | ---------- |

## 3. Conflicts / ambiguity

List anything where:

* documents disagree
* guidance is ambiguous
* implementation requires human judgment

## 4. Missing knowledge

Identify important areas for which the supplied PDFs do not provide enough authoritative guidance.

## 5. Prototype subset

Provide the rule IDs that should actually be enabled for the current RSA → ML-KEM-768 demo.

---

# Critical constraint

Do not use the LLM's general cryptography knowledge as an undocumented source.

The purpose of this exercise is to create an **auditable deterministic knowledge layer derived from the supplied authoritative documents**.

If a useful rule appears correct but cannot be traced to the supplied source documents, put it under:

`Potential additional rules requiring source`

in the review file rather than adding it to the production YAML.
