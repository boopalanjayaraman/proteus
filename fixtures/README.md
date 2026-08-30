# Fixtures

`payments-api/` is the application Proteus migrates. It is **not** part of Proteus — it is
the subject, authored here so it is reviewable alongside the work, and published as a
standalone GitHub repository because that is what Proteus operates on.

Written against `docs/migration_test_fixture_repo_requirements.md`.

---

## Why it cannot live inside this repository

Proteus clones by URL and pushes `agent/pqc/{projectId}`. As a subdirectory it would be
pushing branches to itself. PRD-05 also collects a PAT scoped to one repository.

## Publishing

    scripts/publish-fixture.sh <owner>/<repo>

Builds a clean history from `payments-api/` in a temp directory and pushes, so the
fixture's git log stays free of Proteus's. Re-running publishes a new commit; tests that
pin a base commit need its sha updating.

**Publish `payments-api/` only.** This file must never travel with it — it explains which
test is rigged, which is the one thing an audience should not read.

---

## Design principles

### 1. The rules came first; the fixture validates them

All 110 rules were extracted from NIST documents and the product spec **before this
repository existed**. Four have been added since (`EXEC-DISP-010`, `-011`, `-012`,
`EXEC-DIAG-013`), each derived from the spec or a standard rather than from anything
here — which is the same ordering, held to.

`EXEC-DET-001` says "RSA cipher in wrap or unwrap mode is key transport" because that is
a fact about the Java crypto API, not because of a file here.

If the fixture had come first and the patterns had been written to match it, the tests
would prove only that a regex still matches the file it was derived from. Keep that
ordering. Anything special-cased for this repository is a bug.

### 2. Most findings must need no fixing

Fifteen findings, five of them actionable. The other ten exist to prove the agent
discriminates — that it leaves three RSA signature usages, an HMAC, a SHA-256 digest,
AES at rest and a TLS 1.3 config alone while migrating the key transport beside them.

An analysis that flags everything containing "RSA" is a scanner. The no-change findings
are what make it something else, and they cost nothing at migration time.

### 3. It has to look like code someone wrote under deadline

Crypto in one tidy package makes discovery trivial and the demo dishonest. So:

- `CryptoUtils` is a static grab-bag with a 2021 `TODO` admitting most of it belongs in
  `CryptoService`, and it carries **a second RSA wrap** because the nightly export runs
  outside the Spring context. The migration is therefore two files, not one.
- A commented-out `PKCS1Padding` variant sits under it, which naive text scanning trips over.
- `LegacySettlementExporter` is `@Deprecated` and still wired, because reconciliation was
  never moved to the API.
- `MerchantDirectory` exposes both `lookup()` and `getMerchant()` — "older callers still
  use this name."
- `LedgerRepository` is in-memory with a note that the ledger-db migration was descoped in 1.3.
- `SettlementService` settles unknown merchants anyway, because onboarding lags the
  directory refresh.

None of this obstructs the migration. All of it makes finding the crypto real work.

### 4. Two things are rigged to fail; about nine are placed to be found

Worth keeping separate, because they carry different risk.

**Rigged to fail** — this breaks the build after a correct migration, and exists so the
repair loop has something to work on. There is now exactly **one**:
`PartnerHandshakeMock` rejects any key type but `RSA_PUBLIC_KEY`, so
`completesTheHandshakeWithTheAcquirer` throws once the migration lands. The repair is a
single constant in a single file whose name ends in `Mock` — the cleanest possible
`MOCK_INCOMPATIBILITY` signal for `EXEC-DIAG-004`.

There were two. The second was `assertEquals(256, wrapped.length)`, repaired under
`EXEC-DIAG-013` once the baseline invariant was classified `EXPECTED_TO_CHANGE` — and that
classification runs a **regex over prose a model wrote**. One unanticipated phrasing and a
correct migration ends at a human gate; that is precisely what happened, repeatedly, and it
cost several demo runs. The rule and the exception both still exist and are still tested.
They are simply no longer the thing a live demo depends on.

The remaining failure was chosen because its classifier keys off *where* the legacy name
appears — test and mock files only — which is a structural fact, not a phrasing. The
assertion that replaced the length check compares against `acquirer.presentedKeyType()`
rather than restating the literal, so the accepted key type lives in one place and the
repair stays one edit.

**Placed to be found** — deliberate, but nothing fails because of them. The coverage gap
in `CryptoServiceTest`, the pinned `bcprov 1.72`, the second RSA wrap in `CryptoUtils`,
the commented-out `PKCS1Padding`, three RSA signature usages, the deprecated-but-wired
exporter, the duplicate `lookup()`/`getMerchant()`, unknown merchants settling anyway,
and the absent HSM. Nine or so. They make discovery real work; they cost nothing at
migration time.

Only the first group can break a live demo, which is why it is small and why both members
of it are verified.

### 5. Nothing published reveals the game

No mention of Proteus, PQC, post-quantum or ML-KEM anywhere in `payments-api/`. A
`pom.xml` comment that read "this version predates the stabilised ML-KEM provider" was
removed for exactly this reason.

---

## Shape

40 files · 20 main classes · 13 test classes · 34 unit + 2 integration tests

```
src/main/java/pay/
  ApiApplication  SettlementController  WebhookController  SettlementService
  security/   CryptoService  SettlementSigner  SigningKeyProvider
              PartnerKeyProvider  WebhookVerifier  ApiTokenService
  util/       CryptoUtils
  legacy/     LegacySettlementExporter
  store/      IdempotencyStore  LedgerRepository
  merchant/   MerchantDirectory  Merchant
  model/      SettlementRequest  SettlementResponse  WebhookEvent
src/main/resources/
  application.yml           TLS 1.3, AES-256-GCM at rest, acquirer handshake key type
  templates/index.html      operator console
deploy/tls/pay-api.crt.md   certificate description; no PEM is committed
```

## What each element is there to exercise

| Property | Where | Why |
|---|---|---|
| RSA key transport | `CryptoService.wrapSessionKey` — `Cipher.WRAP_MODE` | The migration target. `EXEC-DET-001` needs wrap mode to classify it `STRONG`. |
| A **second** key transport site | `CryptoUtils.wrapKey` | Migration is not single-file. |
| Ambiguous RSA | commented-out `PKCS1Padding` | `EXEC-DET-002` must not treat it as a usage. |
| RSA **signature** ×2 | `SettlementSigner` — `SHA256withRSA` | Must not migrate. Proves `PROHIB-001`. |
| RSA signature ×3 | `ApiTokenService` — RS256 JWT | One instance of restraint is an accident; three is a policy. |
| Provider predating ML-KEM | `pom.xml` — `bcprov-jdk18on 1.72` | The dependency finding. |
| A **second** crypto library | `nimbus-jose-jwt` | Only one needs upgrading. More discrimination. |
| HMAC | `WebhookVerifier` — `HmacSHA256` | Symmetric, no change. |
| Hashing | `CryptoUtils.sha256Hex` | No change. |
| Symmetric at rest | `application.yml` — AES-256-GCM | No change (`IR8547-4.1.3-001`). |
| Protocol-managed | `application.yml` — TLS 1.3 | No change; `PROHIB-002` forbids rewriting it. |
| Certificate | `deploy/tls/` | The PKI `FOLLOW_ON_WORKSTREAM` recommendation. |
| Two external boundaries | `AcquirerClient` out, `WebhookController` in | Somewhere for mocks to stand in. |
| Fixed contract | 201 accepted, 400 malformed | Baseline invariants that must survive. |
| No crypto coverage | `CryptoServiceTest` | Forces characterization tests before any change. |
| No HSM | — | So the migration completes autonomously. |

The HSM, the OT gateway and the vendor firmware are deliberately **absent**. In the UX
those come from uploaded documents, not from source — spec §5 exists for dependencies
that cannot be inferred from code. Their nodes appear only when those documents are
supplied at project creation.

---

## The two rigged failures

Both live in `PartnerHandshakeIntegrationTest`, in separate methods, and they are
different *classes* of problem — which is the point. A migration that only ever produces
one kind of failure does not demonstrate that the agent can tell them apart.

**1 · `completesTheHandshakeWithTheAcquirer` — a mock incompatibility.**
The mock asserts the acquirer presents `RSA_PUBLIC_KEY`. After migration it does not, and
the mock throws. Verified:

    34 unit tests pass · 1 of 2 integration tests fails · BUILD FAILURE
    java.lang.IllegalArgumentException: Unsupported key exchange ML_KEM_PUBLIC_KEY
                                        (expected RSA_PUBLIC_KEY)

No unit test breaks, so the agent gets a clean `MOCK_INCOMPATIBILITY` signal
(`EXEC-DIAG-004`) rather than a broken build. This is the failure a real project will not
produce on cue.

**2 · `transportsASessionKeyToTheAcquirer` — an expected behavioural change.**
RSA-2048 wraps to 256 bytes; ML-KEM-768 produces 1088. `assertEquals(256, wrapped.length)`
is an `EXPECTED_TO_CHANGE` observation, not a regression.

**Why they are in separate methods.** They were originally one test, where the handshake
threw before the length assertion was reached — so the second failure stayed masked until
the first was repaired, and the agent would meet them one at a time in an order it did not
choose. Split, both surface in the same run and each is classified on its own evidence.

**This one depends on decision D-003.** If the wire-format observation is classified
`MUST_PRESERVE`, verification raises a `BASELINE_CONTRACT_CHANGE` gate and the run ends
with **one** human engineering action — not the zero the UX outcome tile claims. If it is
classified `EXPECTED_TO_CHANGE`, the agent updates the assertion autonomously and the
claim holds. The fixture makes D-003 load-bearing for the demo's headline number rather
than a theoretical schema concern.

## The UI

The console displays the negotiated key establishment mechanism: `RSA-2048` before
migration, `ML-KEM-768` after. That turns the sandbox link from "the app still starts"
into "you can see the cryptography changed", which is the point of Screen 4's completion
artifact.

## Verified

Built and run in `maven:3.9-eclipse-temurin-17`:

    mvn verify        34 unit + 2 integration, BUILD SUCCESS
    docker build      image builds
    docker run        starts in ~4s
    GET  /            console renders RSA-2048 / SHA256withRSA
    POST /settlements 201, {"keyEstablishment":"RSA-2048","wrappedKeyBytes":256}
                      400 on a malformed advice
