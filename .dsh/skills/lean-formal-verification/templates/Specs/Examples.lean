import Specs.Model

-- Non-vacuity witnesses: at least one concrete instantiation per headline theorem
-- (especially those with hypotheses). Keep demonstrations here; never in proof modules.
example : allowed .initial .done = true := by decide
example : allowed .done .initial = false := by decide
