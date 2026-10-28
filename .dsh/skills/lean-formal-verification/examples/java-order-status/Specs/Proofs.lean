import Specs.Model

namespace OrderStatus

/-- R5: a state never transitions to itself (Java: `from == to` rejects). -/
theorem same_state_rejected (s : Status) : allowed s s = false := by
  cases s <;> rfl

/-- R4: CANCELLED is terminal (no outgoing transition). -/
theorem cancelled_is_terminal (s : Status) : allowed .CANCELLED s = false := by
  cases s <;> rfl

/-- R4: REFUNDED is terminal (no outgoing transition). -/
theorem refunded_is_terminal (s : Status) : allowed .REFUNDED s = false := by
  cases s <;> rfl

/-- R3: cancellation is only possible from NEW or PAID. -/
theorem cancel_sources (s : Status) :
    allowed s .CANCELLED = true ↔ (s = .NEW ∨ s = .PAID) := by
  cases s <;> simp [allowed]

/-- R2: no backwards step. -/
theorem no_backwards : allowed .PAID .NEW = false := by
  rfl

/-- R1: NEW is never a valid target. -/
theorem new_is_never_a_target (s : Status) : allowed s .NEW = false := by
  cases s <;> rfl

/-- R2 + R3 + R4: full characterization of the transition relation (read against the Java switch). -/
theorem closures (s t : Status) : allowed s t = true ↔
    (s = .NEW ∧ t = .PAID)
  ∨ (s = .PAID ∧ t = .SHIPPED)
  ∨ (s = .NEW ∧ t = .CANCELLED)
  ∨ (s = .PAID ∧ t = .CANCELLED)
  ∨ (s = .SHIPPED ∧ t = .REFUNDED) := by
  cases s <;> cases t <;> simp [allowed]

end OrderStatus
