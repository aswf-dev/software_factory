// 計分邏輯的 Quint 模型（docs/06-human-oversight-policy.md §3–§4）。
//
// 對應 src/scoring/score.ts 的純函式。本模型由人類撰寫，是規格書的
// 機器可讀形式；Task 18 的神諭 harness 以本模型為 oracle 比對 TS 實作。
//
// 編碼約定：軸值 0=tactical/low, 1=operational/medium, 2=strategic/high；
// tier 0=on-loop, 1=review, 2=in-loop。
//
// 語法註記（quint 0.32.0 實測）：
// - primed 變數（x'）只能出現在指派左側，不可在右側表達式（含函式參數）。
//   故 step 以 nondet 繫結未 primed 的 s，全部計算用 s 而非 primed 值。
// - 整數除法為 infix `/`（或 a.idiv(b)）；範圍用 a.to(b)。
module scoring {
  var bc: int
  var rp: int
  var cx: int
  var total: int
  var tier: int
  var auto: bool

  // --- fail-safe：缺值/非法值一律得 2（docs/06 §3）---
  pure def axisScore(raw: int, valid: Set[int]): int =
    if (raw.in(valid)) raw else 2

  // --- 三軸總分 ---
  pure def totalScore(b: int, r: int, c: int): int = b + r + c

  // --- tier：總分 0–1 → on-loop；2–4 → review；5–6 → in-loop（docs/06 §4）---
  pure def tierForTotal(t: int): int = if (t <= 1) 0 else if (t <= 4) 1 else 2

  // --- 自動合併條件（docs/06 §4.1；第 1 期由 CI 一律改為人審，此模型仍建模原規則）---
  pure def automergeAllowed(t: int, vetoed: bool, hardRules: bool, changedLines: int): bool =
    t == 0 and not(vetoed) and not(hardRules) and changedLines <= 200

  action init = all {
    bc' = 0, rp' = 0, cx' = 0,
    total' = 0, tier' = 0, auto' = true,
  }

  // step 以 nondet s ∈ 0..26 窮舉 27 種 (bc, rp, cx) 組合：
  //   bc = s % 3, rp = (s / 3) % 3, cx = (s / 9) % 3
  // 全部計算使用未 primed 的 s（primed 值不可作為表達式操作數）。
  action step = nondet s = oneOf(0.to(26)) {
    all {
      bc' = s % 3,
      rp' = (s / 3) % 3,
      cx' = (s / 9) % 3,
      total' = totalScore(s % 3, (s / 3) % 3, (s / 9) % 3),
      tier' = tierForTotal(totalScore(s % 3, (s / 3) % 3, (s / 9) % 3)),
      auto' = automergeAllowed(tierForTotal(totalScore(s % 3, (s / 3) % 3, (s / 9) % 3)), false, false, 10),
    }
  }

  // --- 不變量（quint run --invariant <name> / quint verify --invariant <name> 檢查）---
  // Quint 0.32.0：不變量即具名定義，以 --invariant 旗標引用。

  // I1: fail-safe —— 任一軸非法/缺值時該軸必得 2（docs/06 §3）
  val failSafe = axisScore(99, Set(0, 1, 2)) == 2

  // I1b: fail-safe 的監督後果 —— 任一軸非法 → 總分 ≥ 2 → 永不落入 on-loop
  val failSafeNotOnLoop =
    tierForTotal(totalScore(axisScore(99, Set(0, 1, 2)), axisScore(0, Set(0, 1, 2)), axisScore(0, Set(0, 1, 2)))) != 0

  // I2: 總分恆在 0..6
  val totalInRange = total >= 0 and total <= 6

  // I3: 硬性規則觸發時永不 automerge
  val hardRuleBlocks = not(automergeAllowed(tierForTotal(totalScore(0, 2, 0)), false, true, 10))

  // I4: on-loop 且無任何阻擋 → automerge 可放行
  val onLoopAllows = automergeAllowed(tierForTotal(0), false, false, 10)

  // I5: 超過 200 行永不 automerge
  val lineCeiling = not(automergeAllowed(tierForTotal(0), false, false, 201))
}
