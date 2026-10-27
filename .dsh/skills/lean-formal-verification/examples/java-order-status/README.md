# Worked example — Java state machine → Lean proofs → audit

A complete, compilable example of the skill on a small Java-style order status machine. It shows the whole chain: source → model → theorem statements → proofs → non-vacuity witnesses → axiom audit → metrics.

## The implementation (Java)

```java
public enum Status { NEW, PAID, SHIPPED, CANCELLED, REFUNDED }

public Status transition(Status from, Status to) {
    if (from == to) throw new IllegalStateException("no-op");
    if (from == Status.CANCELLED || from == Status.REFUNDED) throw new IllegalStateException("terminal");
    return switch (to) {
        case PAID     -> from == Status.NEW  ? to : reject();
        case SHIPPED  -> from == Status.PAID ? to : reject();
        case CANCELLED-> from == Status.NEW || from == Status.PAID ? to : reject();
        case REFUNDED -> from == Status.SHIPPED ? to : reject();
        default       -> reject();   // NEW is not a valid target
    };
}
```

## The model (`Specs/Model.lean`)

```lean
inductive Status where
  | NEW | PAID | SHIPPED | CANCELLED | REFUNDED
  deriving DecidableEq, Repr

def allowed : Status → Status → Bool
  | .NEW, .PAID => true
  | .PAID, .SHIPPED => true
  | .NEW, .CANCELLED => true
  | .PAID, .CANCELLED => true
  | .SHIPPED, .REFUNDED => true
  | _, _ => false
```

Mapping: target-`NEW` and same-state rejections fall out of the `_, _ => false` default (audited against the Java `default -> reject()` and the explicit same-state guard). `Status` is the Java enum verbatim. No fields are dropped because the rule is only about transitions; persistence and concurrency are out of scope for this example.

## The theorems (`Specs/Proofs.lean`, excerpt)

```lean
theorem same_state_rejected (s : Status) : allowed s s = false
theorem cancelled_is_terminal (s : Status) : allowed .CANCELLED s = false
theorem refunded_is_terminal (s : Status) : allowed .REFUNDED s = false
theorem cancel_sources (s : Status) :
    allowed s .CANCELLED = true ↔ (s = .NEW ∨ s = .PAID)
theorem no_backwards : allowed .PAID .NEW = false
theorem closures (s t : Status) : allowed s t = true ↔
    (s = .NEW ∧ t = .PAID) ∨ (s = .PAID ∧ t = .SHIPPED) ∨
    (s = .NEW ∧ t = .CANCELLED) ∨ (s = .PAID ∧ t = .CANCELLED) ∨
    (s = .SHIPPED ∧ t = .REFUNDED)
```

The `closures` theorem is the read-it-against-the-switch theorem: a human can compare the five allowed pairs with the Java cases and see they match. `cancel_sources` and the terminal theorems are the business rules; `same_state_rejected` and `no_backwards` are the negative examples from `RULES.md`.

## What the rules would look like (`RULES.md`, excerpt)

| Rule | Statement | Negative example |
|---|---|---|
| R1 | A new order starts `NEW`; target `NEW` is never accepted. | `transition(PAID, NEW)` → rejected |
| R2 | Forward path advances one step: `NEW→PAID→SHIPPED→REFUNDED`. | `transition(NEW, SHIPPED)` → rejected |
| R3 | Cancellation only from `NEW`/`PAID`. | `transition(SHIPPED, CANCELLED)` → rejected |
| R4 | `CANCELLED`/`REFUNDED` are terminal. | `transition(CANCELLED, PAID)` → rejected |

## Run it

```bash
cd examples/java-order-status
export PATH="$HOME/.elan/bin:$PATH"
lake build
lake env lean Audit.lean
bash ~/.agents/skills/lean-formal-verification/scripts/verify-lean.sh \
  --dir . --main Specs/Proofs.lean --audit Audit.lean --theorems headline-theorems.txt
```

Expected: build green; every headline theorem `does not depend on any axioms` (or `[propext]` only); dashboard with 6 public theorems. The non-vacuity witnesses in `Specs/Examples.lean` show the relation is inhabited and the negative cases really fail.

## What this example does *not* cover

- Optimistic locking / concurrent writers (see the discussion of versioned models in `references/porting.md`; the production example is the order-lifecycle verification).
- Persistence, events, caches, retries, performance.
- `MODEL-MAP.md` here is abbreviated; a real one records the verified commit, every theorem's source `file:line`, witnesses, review log, and the explicit not-covered list.

## Template project vs this example

`templates/` is a skeleton to copy. This directory is the "one excellent example" — adapt its shape, not its names.
