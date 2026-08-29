# PRD-NN · <Feature name>

> Copy this file to `PRD-NN-<kebab-name>.md`. Delete the guidance in blockquotes.
> A PRD is the source of truth for what an increment delivers. It is written before
> implementation and amended after, so that six weeks later the question "why is it
> like that?" has an answer that is not a git blame.

| | |
|---|---|
| **Increment** | NN |
| **Status** | `PLANNED` · `IN PROGRESS` · `DELIVERED` · `SUPERSEDED` |
| **Depends on** | PRD-NN, PRD-NN — increments that must be delivered first |
| **Unblocks** | PRD-NN — what this makes possible |
| **Demoable outcome** | One sentence a non-engineer can verify on screen. If there isn't one, this is a foundation increment — say so. |
| **Created** | YYYY-MM-DD |
| **Delivered** | YYYY-MM-DD |

---

## 1. Problem

> Two or three sentences. What cannot be done today, and what breaks or stays manual
> until this exists. Not a restatement of the title.

## 2. Sources of truth

> Every requirement below must trace to one of these. If something has no source,
> it belongs in §8 as an open question, not in §4 as a requirement.

| Source | Reference |
|---|---|
| Product spec | §N — <section title> |
| UX design | `requirements/ux design/v1.2/` — <screen>, <element> |
| Data model | §N — <collection or rule> |
| Architecture | §N |
| Agent architecture | §N — <agent> |
| Rulesets | `RULE-ID`, `RULE-ID` |
| Deployment | §N |

## 3. Scope

**In**
- …

**Out** — and where it lands instead
- … → PRD-NN

> The "out" list matters more than the "in" list. It is what stops an increment
> growing until it never ships.

---

## 4. Functional requirements

> Numbered, individually testable, each traceable to §2. Written as behaviour, not
> implementation. Anything that cannot be verified by a test or by looking at a
> screen is not a requirement — it is a note.

| ID | Requirement | Source |
|---|---|---|
| FR-1 | … | Spec §N |
| FR-2 | … | UX v1.2 |

## 5. Data model

**Collections touched** — read `R`, write `W`, create `C`

| Collection | Access | Fields of note |
|---|---|---|
| … | … | … |

**Schema changes required** — new fields, enum values, or migrations. State `none` if none.

## 6. Interfaces

**API**

| Method | Path | Notes |
|---|---|---|
| … | … | … |

**Events emitted** — `EventType` values, with the `level` each is emitted at.

**Agent involvement** — which agent, which tools, or `none — deterministic`.

**Rules consumed** — rule ids this increment evaluates, and what it does with each.

## 7. Acceptance criteria

> Binary. Each one is a thing that either happens or does not. "Works well" is not
> an acceptance criterion; "returns 403 when the caller does not own the project" is.

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | … | test / screen / command |

## 8. Risks and open questions

| # | Risk or question | Impact | Resolution or owner |
|---|---|---|---|
| 1 | … | … | … |

> Open questions are allowed. Unrecorded open questions are not.

## 9. Definition of done

- [ ] All FRs implemented
- [ ] All ACs verified
- [ ] Typecheck and tests pass
- [ ] Documents in §2 updated where this increment changed them
- [ ] §10 records what was actually built, including deviations

## 10. Delivery log

> Filled in as the increment is built. This is the half that makes the PRD a source
> of truth rather than a plan — a deviation recorded here is information, a deviation
> discovered later in the code is an archaeology problem.

| Date | Change | Why |
|---|---|---|
| YYYY-MM-DD | … | … |

**Deviations from plan** — what was built differently from §4, and the reason.

**Deferred** — what moved to a later increment, and which one.
