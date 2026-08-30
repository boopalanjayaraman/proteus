# Fixes worth remembering

Defects found in Proteus that were **not** typos — each one had a cause worth
understanding, and most would recur in a rebuild unless the same decision is made
deliberately. Grouped by the mistake rather than by the file, because the file is
never the interesting part.

Every entry says what broke, why it survived, and what would have caught it
earlier. The last column is the one to read when writing new code.

Companion: `decisions/decisions.md` for the choices that were deliberate.

---

## 1. A default that only applies on the way in

**`Project.lifecycle` was `undefined` on every existing document.**

Zod's `.default('ACTIVE')` runs during `parse`. `Repository.findOne` returns the raw
Mongo document and never parses it, so the default applied to writes and never to
reads. Every project written before the field existed came back without it.

Two consequences, and the smaller one was the crash:

- `canTransitionLifecycle` threw `Cannot read properties of undefined (reading 'includes')`.
- `assertMutable` compared `lifecycle === 'ACTIVE'`, so `undefined` read as *not*
  active — **the entire product went read-only for every project that predated the
  field.** Nothing reported that; a write just started returning 409.

**Why it survived every test.** Fixtures are created through `repos.projects.create`,
which goes through `insert` → `prepare` → Zod parse. A test can never produce the
broken shape by accident; only a raw `$unset` reproduces it.

> **Adding a defaulted field to an existing collection is three tasks, not one:**
> the schema default, a backfill for stored documents, and a read path that treats
> absence as the default. Write the test with a raw driver write, or it proves
> nothing. See `src/backend/src/core/db/migrations.ts`.

---

## 2. Faking a value the layer cannot know

**`locator: { …, commitSha: '' }`** in the discovery agent.

The agent assembles an evidence record but has no access to the checkout, so it
filled a required field with a placeholder. `EvidenceLocator` requires `min(7)`, so
the insert failed — three layers away from the code that faked it, with a message
naming a field the reader has to trace back by hand.

**Why it survived.** The model path only runs for candidates classified `WEAK` or
`UNKNOWN`; everything else is settled deterministically. Every earlier run either
classified everything strongly or died at the model call, so this line had never
executed against a real model.

The fix was to make `commitSha` a **required parameter**, not an optional one. The
compiler then named all five call sites immediately.

> A placeholder for a fact the current layer cannot establish is a deferred crash.
> Pass the fact in and make the parameter required — an optional parameter with a
> fallback is the same bug with better manners.

---

## 3. Guards that can be forgotten, and guards that cannot

Three of these, all the same shape.

| Guard | Wrong way | Right way |
|---|---|---|
| Archived projects are read-only | A check in each of ten mutating routes | One check in `loadOwnedProject`, inferred from the HTTP method |
| Denied access is recorded | A `record()` call at each ownership check | One recorder inside `loadOwnedProject` |
| Page visits are recorded | A beacon each screen must remember to send | One header set in the single `fetch` wrapper |

Eight project-scoped mutating endpoints go through that guard, plus two lifecycle
actions deliberately exempt from it — and adding a ninth is a two-line change. A guard that must be remembered is a guard that will
eventually be forgotten — and a disabled button in the UI does nothing for a stale
tab.

> Put the check where the data is loaded, not where it is used.

---

## 4. Silent failures

Four, all of which made a real error invisible.

**`onClick={() => void signIn()}`** — `void` discards the rejection, so Firebase's
precise `auth/configuration-not-found` became an unhandled promise rejection in a
console nobody was looking at. The user saw a popup open and close with no
explanation. Every one of those codes names a console setting that fixes it.

**`.catch(() => undefined)`** on a guarded transition — `discovery.fail` called
`transition(projectId, 'ANALYZING', 'FAILED')`, which no-ops when the project never
reached `ANALYZING`. The swallowed `StaleProjectError` meant a project whose clone
failed sat in `CREATED` forever, looking like it was still working.

**`GET /projects/:id/evidence` was never registered.** The frontend called it and
both call sites had `.catch(() => undefined)`, so the graph inspector silently
showed no evidence through six increments.

**`failureReason` existed in the schema and nothing ever wrote it.** The reason only
reached the discovery run's `error` field, which the project list cannot read.

> `.catch(() => undefined)` is a decision that the error does not matter. Write the
> reason next to it, or handle the error. An empty catch on a *write* is usually
> right; on a *state transition* it is usually a bug.

---

## 5. Tests that cannot see the bug

**The Zod 4 schema never reached Gemini.** Genkit 1.41 is built against Zod 3. Passing
a Zod 4 schema does not throw — it converts to nothing, so the model received no
response schema and answered with field names it invented (`key_size_bits`,
`security_strength_equivalent_bits`) against a three-field schema.

The whole suite passed throughout, because every test uses `ScriptedModel`. Structured
output had **never once** been exercised against a real model.

The fix is `z.toJSONSchema(schema, { target: 'draft-7' })` passed as
`output.jsonSchema`. The post-parse against the original schema stays: the conversion
makes the model likely to comply, it does not make it trustworthy.

> An interface with a scripted implementation tests the surrounding logic and
> nothing about the boundary itself. Where the real implementation talks to a
> third party, one opt-in smoke test against the real thing is worth more than any
> number of scripted ones. **Still missing here.**

---

## 6. Configuration that validates a choice and then ignores it

**`GOOGLE_GENAI_USE_VERTEXAI`** had never done anything. The config's `superRefine`
carefully enforced "exactly one of Vertex or an API key must be configured" — and
then `server.ts` passed the API key regardless. A deployment asking for Vertex called
the API-key endpoint and failed on a key it was not trying to use.

The fix made the backend a **discriminated union**, so a key cannot reach the Vertex
branch at all, and logged the resolved choice at startup.

> Validating a setting is not honouring it. If a flag chooses between two code paths,
> the type should make the wrong combination unrepresentable — and the startup banner
> should say which path was taken.

---

## 7. Recursion without a cycle guard, and rebuilding objects that must not be rebuilt

**The logger crashed the process on the first real request.** Its `scrub` function
walked objects recursively to redact credentials, with no cycle detection. Fastify
logs its request object, whose `raw.socket.server` chain refers back to itself.

The same function had a second, quieter bug: it rebuilt every object with
`Object.entries`, and **`Object.entries(new Error('x'))` is `{}`** — `message` and
`stack` are not enumerable. Every error logged had been flattened to an empty object.

> A recursive walk over untrusted shapes needs a cycle guard **and** a depth limit,
> and must only rebuild plain objects and arrays. Errors, Dates and Buffers are not
> bags of properties. `redactTokens` already had this right; `scrub` was written
> later and did not.

---

## 8. Two copies of one truth

**The legacy-algorithm regex existed twice**, and the copies diverged. The loop's
copy lacked `RSA_PUBLIC_KEY`, and `\bRSA\b` does not match inside it because `_` is
a word character — so `EXEC-DIAG-004` silently stopped matching. Now one exported
constant, `LEGACY_ALGORITHM`.

**Compiled `.js` files sat beside their TypeScript sources** in `schema/src/`. Vite
resolves `.js` before `.ts`, so every workspace imported stale build output and a new
export was `undefined` at runtime. Fixed by deleting them, gitignoring them, and
adding an architecture test that fails if they return — which it did, once, when a
later `tsc` invocation re-emitted them.

**The mock guard's regex was `[^)\n]{0,80}`**, which stops at the first `)` and so
missed `doReturn(x).when(mock).decapsulate()`.

> Anything a second file needs is an export, not a copy. And a build artifact that
> can shadow a source file needs a test, not a convention.

---

## 9. Destructive operations

**`ProjectService.delete` removed 3 of the model's 23 project-scoped collections** — plus the
credential and the blobs — and never tore down the sandbox. Twenty collections were
left pointing at a `projectId` that no longer resolved.

The sandbox leak was worse than the orphaned rows and asymmetric:
`SandboxCapacityService.state()` counts live deployments **globally** for the platform
total but attributes them per-user by joining back through `projects`. A deleted
project's deployment therefore consumed one of thirty platform slots **permanently**,
while counting against nobody's three. Thirty deletions and the platform silently
stops retaining sandboxes with no project on any screen to explain why.

Replaced with a soft delete: one field, which cannot partially fail. The credential
and the sandbox are still destroyed, because a hidden project must not leave a live
token or a public URL behind.

> A partial delete that looks total is worse than no delete. Enumerate the
> collections **from `COLLECTIONS`** rather than by hand, so a collection added later
> is covered without anyone remembering. Order external resources before the
> database: an orphaned row is visible and recoverable, an orphaned Cloud Run service
> is neither. And `ProjectService.delete` was **removed**, not deprecated — leaving
> it callable is how it gets called.

---

## 10. A verdict that could be reached by not trying

**Sandbox checks returned `NOT_APPLICABLE` before deployment.** Spec §35 counts
`NOT_APPLICABLE` as satisfied, so a run that never deployed a sandbox could report
`VERIFIED`. Two of the tests written for it contradicted each other, which is how it
surfaced.

Changed to `FAIL`. The circularity — deployment requires verification, verification
requires deployment — is resolved in `mayDeploy()`, which excludes exactly those two
checks and nothing else.

> When a state means "we did not check", it must not be spelled the same as "there
> was nothing to check". If two tests you wrote disagree, one of them is describing
> a bug.

---

## 11. Routing to a screen that has nothing to show

**`destinationFor` sent a `FAILED` project to `/sandbox`** via a `default` branch —
the least useful of four screens for a project that produced nothing. Every screen
behind that tile reads state a failure means was never produced, so it renders as a
broken screen rather than as what happened.

Now returns `null`, the tile is disabled, and the failure reason renders on the tile
itself — because a tile you cannot open has to say why on its face.

> A `default:` branch in a routing switch is a decision about every value you have
> not thought about yet. Terminal states usually need naming explicitly.

---

## 12. UI drift from the design

Less consequential than the rest, but it accumulated the same way: the earliest
screens were built from the PRDs and the later ones from the canvas, so `.primary`
was `600 14px` at a 10px radius while `.ghost` was `10.5px` with letter-spacing at an
8px radius — three button languages on one page. The native file input had no styling
at all, which made it the one control that looked like a different application.

Fonts were the largest single deviation: the canvas makes 249 font declarations, every one of them
IBM Plex, and the app was falling back to system fonts.

> Define the shared primitives — a button, a field, a section header, a panel — once,
> before the second screen. `::file-selector-button` is part of that set. And check
> the design's actual typefaces before assuming a system stack will do.

---

## 13. One truth written twice — the CORS header list

The SSE client sends its resume cursor as a **`last-event-id` header**. The CORS allowlist
named three headers and not that one, so the browser blocked the preflight and the stream
never opened.

The shape of the failure is what made it hard to see: **every other screen worked.**
`last-event-id` is sent on exactly one request — the live feed, which is the one thing the
product exists to show. The backend was writing events correctly the whole time.

Now a single `CLIENT_HEADERS` constant in the shared schema, which the CORS config spreads
and a test iterates.

> Same lesson as §8, in a place that does not look like duplication: an allowlist is a
> second copy of whatever it lists.

---

## 14. A human decision behind a bookkeeping flag

Approval required `stage === 'AWAITING_APPROVAL'` — a stage the assessment job sets in the
same breath as opening the gate. When an unrelated blob write failed two lines earlier, the
project sat at `ASSESSMENT_READY` with a complete assessment, a proposed plan, and **no way
for a human to authorise any of it.**

Two things were wrong, and only one was the ordering. The report was written before the
gate, so an artifact could block the product's whole purpose — fixed by opening the gate
first and downgrading a report failure to an event. But the deeper error was tying the one
human decision to a single transition that can fail independently of the thing it describes.
`APPROVABLE_STAGES` now names both stages that mean "finished, waiting on you".

> When a product's core claim is "a human decides", the offer must follow the *state the
> human cares about*, not an internal marker that happens to correlate with it. Ask what
> happens to the control if the transition that sets it never runs.

---

## An EventEmitter nobody listened to

`EventsRepository.watch` attached a `'change'` handler and nothing else. A `ChangeStream`
is an `EventEmitter`, and an `EventEmitter` that emits `'error'` with no listener does not
return a rejected promise or hand the caller anything to catch — **it throws, out of band,
from the driver's own tick.** In a Node process that is not a degraded subscriber. It is
`uncaughtException`, and every migration running in that process dies with it.

It surfaced as a red test suite: 478 tests passed and `npm test` still exited 1, because
closing the client during teardown killed a live tail. That is the same event as a
replica-set failover or a rolling restart in production.

The stream now always listens, whether or not the caller passes a handler, closes itself,
and reports. The SSE endpoint ends the response on it, so the browser reconnects with
`Last-Event-ID` and resumes from `lastSent` — machinery that already existed. Holding a
dead tail open would have been the worse failure: a screen that looks connected and
silently stops updating.

> An `'error'` event is not an error value. Every `EventEmitter` a long-lived process
> holds needs a listener on it, and the cost of the missing one is never local.

---

## A question with no honest answer

The loop applied one plan item, built, and treated a failing suite as a defect to diagnose
and repair. For a cryptographic primitive swap that is not a defect — it is the middle of
the change.

`PartnerKeyProvider` generates the acquirer key pair; `CryptoService.wrapSessionKey` and
`CryptoUtils.wrapKey` both wrap under it. Migrate the provider first and the wrappers get a
key type their RSA transform rejects. Migrate a wrapper first and it gets an RSA key its KEM
cannot use. **No order leaves the suite green after each single file.**

So after every item, the loop asked the repair agent to make a correct-in-progress build
green while the rest of the change set was still unapplied. Exactly one kind of edit does
that: undoing the migration. Every RSA fallback, every mangled mock, every stacked partial
fix traced back to this — not a confused model, but a loop asking a question with no honest
answer, then punishing the model for answering it.

The tell was sitting in `detect.ts` the whole time. Its comment described the identical
hazard one stage earlier — a plan "internally valid and jointly impossible" — and I fixed it
*for the plan* without asking whether execution had the same shape. It did.

`changeSetsOf` groups items that must land together; only the set's last build is a verdict.

> When a model keeps producing the same wrong answer, check what it is being asked. A
> repair loop cannot distinguish "this is broken" from "this is unfinished" unless
> something tells it which one it is looking at — and that something is not the model.

---

## A safety net that missed by one word

`CRYPTO_OUTCOME_EXCEPTIONS` exists for exactly one job: stop `assertEquals(256,
wrapped.length)` being read as a regression when ML-KEM-768 makes it 1128. Its comment says
so. Without it the invariant stays `MUST_PRESERVE`, `EXEC-DIAG-005` outranks
`EXEC-DIAG-004`, and a correct migration ends at a human gate.

It read `wrapped\s*(key\s*)?(length|size|bytes)`. The fixture's assertion message is
**"wrapped session key length on the wire"**. One unanticipated word in the gap, and the net
did not catch the only thing it was built to catch.

There was a test. It asserted `'Ciphertext length is 256 bytes'` and `'The wrapped session
key is 256 bytes'` — phrasings invented while writing the test, both of which matched. The
fixture's real string was never in it. So the test passed for years while the feature it
covered did not work on the one input that mattered.

> A regex over prose is a guess about phrasing. Test it against the string the system will
> really see — copied, not paraphrased — or the test is only checking that you can write a
> regex matching your own example.

---

## Cross-cutting

Three habits that would have caught most of the above:

1. **Ask what would make this fail silently.** Half the entries here produced no
   error at all — a swallowed rejection, an unregistered route, a schema that
   converted to nothing, a default that never applied.
2. **Ask what the test cannot see.** Scripted implementations, fixtures built through
   the write path, and fresh databases all hide whole classes of defect.
3. **Prefer making a mistake unrepresentable to remembering not to make it.** A
   required parameter, a discriminated union, a guard at the load point, an
   architecture test.
