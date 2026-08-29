# Decisions

Open questions that need a call, in one place, so they can be reviewed periodically
instead of being rediscovered in the middle of an increment.

`decisions.md` is the list — YAML inside a fenced block, edited in place. Each entry carries a `comment` and `decision` field that
are yours to fill; everything above them is context I supply.

## Workflow

1. Read the entry — `context`, `options`, `recommendation`, `impact_if_unresolved`.
2. Write your `comment`. Disagreement is more useful than agreement here.
3. Set `decision` and move `status` to `ACCEPTED`, `REJECTED` or `DEFERRED`.
4. Set `decided_on`.

Entries stay in the file once closed. A decision whose reasoning is deleted becomes a
mystery six weeks later, which is the thing this file exists to prevent.

## Status values

| Status        | Meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `NEEDS_INPUT` | Blocked on you. I will not proceed past what it blocks.                        |
| `OPEN`        | I can proceed under the stated recommendation; your input can still change it. |
| `ACCEPTED`    | Decided. `decision` records what and why.                                      |
| `REJECTED`    | Decided against. The alternative taken is in `decision`.                       |
| `DEFERRED`    | Deliberately postponed; `revisit_at` says when or what triggers it.            |
| `CLOSED`      | No longer applicable — the thing it concerned changed.                         |

## Fields

| Field | Who writes it |
|---|---|
| `id`, `title`, `category`, `raised`, `blocks` | me |
| `context`, `options`, `recommendation`, `impact_if_unresolved` | me |
| `comment`, `decision`, `decided_on` | you |
| `status` | me until you decide, then you |

## Priority

`blocks` names the PRDs that cannot start until the entry is resolved. Three entries
block work today: **D-001**, **D-002**, **D-003**.
