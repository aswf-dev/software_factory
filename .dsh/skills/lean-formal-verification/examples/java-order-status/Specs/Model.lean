/-
Model of the Java `Status` transitions (see README.md).

Mapping: target-NEW and same-state rejections are the `_, _ => false` default,
which in the Java code are the explicit `from == to` guard and the `default` case.
-/
inductive Status where
  | NEW | PAID | SHIPPED | CANCELLED | REFUNDED
  deriving DecidableEq, Repr

/-- The transition relation as implemented by `OrderService.transition`. -/
def allowed : Status → Status → Bool
  | .NEW, .PAID => true
  | .PAID, .SHIPPED => true
  | .NEW, .CANCELLED => true
  | .PAID, .CANCELLED => true
  | .SHIPPED, .REFUNDED => true
  | _, _ => false
