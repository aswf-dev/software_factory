/-
Axiom audit for the headline theorems. See templates/Audit.lean for the contract.
-/
import Specs

#print axioms OrderStatus.same_state_rejected
#print axioms OrderStatus.cancelled_is_terminal
#print axioms OrderStatus.refunded_is_terminal
#print axioms OrderStatus.cancel_sources
#print axioms OrderStatus.no_backwards
#print axioms OrderStatus.new_is_never_a_target
#print axioms OrderStatus.closures
