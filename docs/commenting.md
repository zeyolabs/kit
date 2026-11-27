# Commenting

Code says what it does. A comment is only for what the code cannot say: why.

## Default: no comment

Make the code carry the meaning before reaching for a comment:

- Rename the thing (`days` → `trialLengthDays`).
- Extract a named function or constant (`const MAX_D1_PARAMS = 100`).
- Put the rule in a type (`type Pence = number` beats "amount in pence").

If a comment explains confusing code, fix the code, then delete the comment. Deleting without fixing
loses the explanation.

## Write a comment when

- There is a constraint or limit the code can't show: an API quirk, a platform limit, a rate limit.
- A line looks wrong or wasteful but is deliberate: a workaround, an ordering requirement, a
  fail-closed choice.
- The reason is a security or data-safety rule.
- A unit, format or invariant isn't in the type.

One line. Two at most. If it needs more, put it in a doc and link it.

```ts
// D1 allows 100 bound parameters per query: chunk instead of inArray.
// Fail closed: an unreachable limiter blocks the request.
```

## Never

- Restate the code or the name below it (`/** Returns the user */ function getUser`).
- Label a section (`// Header`, `<!-- Footer -->`). If a block needs a name, make it a component.
- Leave commented-out code. Git has it.
- Write history: "was", "previously", "an earlier version", incident or PR numbers. That goes in
  the commit message.
- Leave a TODO with no owner or tracker.
- Write an essay. A paragraph above a function means the function does too much.

## Exported API

In packages other apps import (kit, ui, shopping):

- Add a one-line doc comment on an export only when its name and types don't say enough.
- Document a parameter only when its unit or meaning isn't obvious (`ttlSeconds`, `since` inclusive).
- Mark replaced exports `@deprecated Use X.`, with the replacement.
- Apps and workers: no doc comments on internal functions.

## Directives

- `eslint-disable` and `@ts-expect-error` always carry a reason: `// eslint-disable-next-line rule -- why`.
- No comments in `wrangler.jsonc`.

## Before you delete a comment

1. Does it give a reason the code can't? Keep it, shorter.
2. Is the reason still true? If not, delete it.
3. Can a better name, constant or type say it instead? Do that, then delete it.

## Review checklist

- Every new comment answers "why", not "what".
- No section labels, commented-out code or history.
- No comment longer than two lines.
- Every directive has a reason.
