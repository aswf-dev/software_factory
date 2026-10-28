-- Placeholder model so the template project builds as-is.
-- Replace with the abstraction of the real code (see examples/ for a worked example).
inductive Status where
  | initial
  | done
  deriving DecidableEq, Repr

/-- The transition relation as implemented by the real code. -/
def allowed : Status → Status → Bool
  | .initial, .done => true
  | _, _ => false

theorem initial_can_finish : allowed .initial .done = true := by decide
