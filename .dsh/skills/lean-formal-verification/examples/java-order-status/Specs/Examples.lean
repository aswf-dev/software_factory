import Specs.Proofs

-- Non-vacuity witnesses: the relation is inhabited and the negative cases really fail.
open OrderStatus

example : allowed .NEW .PAID = true := by decide
example : allowed .PAID .SHIPPED = true := by decide
example : allowed .SHIPPED .REFUNDED = true := by decide
example : allowed .SHIPPED .CANCELLED = false := by decide
example : allowed .CANCELLED .PAID = false := by decide
example : allowed .PAID .PAID = false := by decide
