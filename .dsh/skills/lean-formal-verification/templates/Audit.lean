/-
Axiom audit for the headline theorems (Rule 3 guardrail).

Run from the Lean project directory:

    export PATH="$HOME/.elan/bin:$PATH"
    lake env lean Audit.lean

One #print axioms line per theorem listed in headline-theorems.txt. Use
namespace-qualified names. Expected output per theorem is one of:

    'thm' does not depend on any axioms                    (PASS)
    'thm' depends on axioms: [propext, Classical.choice, Quot.sound]  (PASS if allowlisted)
    'thm' depends on axioms: [sorryAx]                     (FAIL)
    'thm' depends on axioms: [..._native.native_decide...] (FAIL)

Allowed axioms: propext, Classical.choice, Quot.sound. Anything else is a
guardrail failure; a missing line is a completion failure.
-/
import Specs

-- One line per headline theorem, e.g.:
#print axioms initial_can_finish
