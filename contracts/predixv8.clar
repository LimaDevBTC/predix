;; ============================================================================
;; PREDIX v8 - Prediction Market (Gateway-Only, Price Bounds, Timelocks)
;; ============================================================================
;; Changes from predixv7:
;; - PRICE_BOUND_BPS increased from u100 (1%) to u200 (2%)
;; - New admin function: admin-set-price (deployer-only, resets last-known-price)
;; - Fixes deadlock where stale last-known-price blocks all settlements
;; ============================================================================

;; ----------------------------------------------------------------------------
;; CONSTANTS
;; ----------------------------------------------------------------------------

(define-constant CONTRACT_OWNER tx-sender)
(define-constant SELF 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv8)
(define-constant DEPLOYER 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK)

;; Errors
(define-constant ERR_UNAUTHORIZED (err u1000))
(define-constant ERR_ROUND_NOT_ENDED (err u1001))
(define-constant ERR_NO_BET (err u1002))
(define-constant ERR_ALREADY_CLAIMED (err u1003))
(define-constant ERR_INVALID_SIDE (err u1004))
(define-constant ERR_INVALID_AMOUNT (err u1005))
(define-constant ERR_TRADING_CLOSED (err u1006))
(define-constant ERR_TRANSFER_FAILED (err u1007))
(define-constant ERR_INVALID_PRICES (err u1009))
(define-constant ERR_ALREADY_RESOLVED (err u1012))
(define-constant ERR_NOT_RESOLVED (err u1014))
(define-constant ERR_ROUND_NOT_FOUND (err u1015))
(define-constant ERR_PAUSED (err u1016))
(define-constant ERR_PRICE_OUT_OF_BOUNDS (err u1017))
(define-constant ERR_NOT_INITIALIZED (err u1018))
(define-constant ERR_ALREADY_INITIALIZED (err u1019))
(define-constant ERR_TIMELOCK_NOT_EXPIRED (err u1020))
(define-constant ERR_NO_PENDING (err u1021))
(define-constant ERR_WITHDRAW_COOLDOWN (err u1022))
(define-constant ERR_NOT_PAUSED (err u1023))

;; Timing (seconds)
(define-constant ROUND_DURATION u60)
(define-constant TRADING_WINDOW u50)         ;; 50s trading, 10s pre-settlement

;; Financial
(define-constant MIN_BET u1000000)           ;; 1 USDCx (6 decimals)
(define-constant FEE_BPS u300)               ;; 3% fee total (300 basis points)
(define-constant FEE_OPS_BPS u200)           ;; 2% to fee-recipient (operations)
(define-constant FEE_JACKPOT_BPS u100)       ;; 1% stays in contract (jackpot treasury)

;; Timelocks
(define-constant TIMELOCK_BLOCKS u144)       ;; ~24h at ~10s blocks (Nakamoto)
(define-constant WITHDRAW_COOLDOWN u200)     ;; ~33 min between emergency withdraws

;; Price bounds (defense-in-depth)
(define-constant PRICE_BOUND_BPS u200)       ;; 2% = 200 BPS (increased from 1%)

;; ----------------------------------------------------------------------------
;; DATA MAPS
;; ----------------------------------------------------------------------------

;; Round data (created on first bet)
(define-map rounds
  { round-id: uint }
  {
    total-up: uint,
    total-down: uint,
    price-start: uint,
    price-end: uint,
    resolved: bool
  }
)

;; Individual bets - side is part of key (allows UP and DOWN per user)
(define-map bets
  { round-id: uint, user: principal, side: (string-ascii 4) }
  { amount: uint, claimed: bool }
)

;; Bettors per round (for auto-settlement)
(define-map round-bettors
  { round-id: uint }
  { bettors: (list 200 principal) }
)

;; ----------------------------------------------------------------------------
;; STATE VARIABLES
;; ----------------------------------------------------------------------------

;; Gateway contract (updatable via timelock)
;; Initialized to DEPLOYER -- must call set-gateway-bootstrap after gateway is deployed
(define-data-var gateway principal DEPLOYER)

;; Fee recipient (updatable by deployer)
(define-data-var fee-recipient principal 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK)

;; Price bounds (defense-in-depth)
(define-data-var last-known-price uint u0)

;; Timelocks - gateway
(define-data-var pending-gateway (optional principal) none)
(define-data-var gateway-activation-block uint u0)

;; Timelocks - sponsor (stored in gateway, but predixv8 tracks for auditability)
(define-data-var pending-sponsor (optional principal) none)
(define-data-var sponsor-activation-block uint u0)

;; Emergency pause
(define-data-var contract-paused bool false)
(define-data-var paused-at-block uint u0)

;; Emergency withdraw tracking
(define-data-var last-withdraw-block uint u0)

;; Jackpot treasury (on-chain)
;; Tracks how much of the contract's token balance is jackpot funds
;; Accumulates 1% of volume from each valid round (= 1/3 of total fee)
(define-data-var jackpot-balance uint u0)

;; Helper for bettor iteration in resolve-and-distribute
(define-data-var current-resolve-round uint u0)
(define-data-var current-resolve-outcome (string-ascii 4) "")
(define-data-var current-resolve-total-pool uint u0)
(define-data-var current-resolve-winning-pool uint u0)
(define-data-var current-resolve-is-tie bool false)
(define-data-var current-resolve-fee-recipient principal 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK)

;; ----------------------------------------------------------------------------
;; PRIVATE FUNCTIONS
;; ----------------------------------------------------------------------------

;; Add bettor to round list (for settlement iteration)
(define-private (add-bettor-to-round (round-id uint) (bettor principal))
  (let (
    (current-data (default-to { bettors: (list ) } (map-get? round-bettors { round-id: round-id })))
    (current-list (get bettors current-data))
  )
    (if (is-some (index-of? current-list bettor))
      true
      (match (as-max-len? (append current-list bettor) u200)
        new-list (begin
          (map-set round-bettors { round-id: round-id } { bettors: new-list })
          true)
        true
      )
    )
  )
)

;; Validate price is within bounds of last-known-price
;; |price - last-known| <= last-known * PRICE_BOUND_BPS / 10000
(define-private (is-price-in-bounds (price uint))
  (let (
    (last-price (var-get last-known-price))
    (max-delta (/ (* last-price PRICE_BOUND_BPS) u10000))
  )
    (and
      (>= price (if (> max-delta last-price) u0 (- last-price max-delta)))
      (<= price (+ last-price max-delta))
    )
  )
)

;; Process payout for a single bettor during resolve-and-distribute
;; Uses current-resolve-* data vars set by the caller
(define-private (process-bettor-payout (bettor principal))
  (let (
    (round-id (var-get current-resolve-round))
    (outcome (var-get current-resolve-outcome))
    (total-pool (var-get current-resolve-total-pool))
    (winning-pool (var-get current-resolve-winning-pool))
    (is-tie (var-get current-resolve-is-tie))
    (the-fee-recipient (var-get current-resolve-fee-recipient))
    (bet-up (map-get? bets { round-id: round-id, user: bettor, side: "UP" }))
    (bet-down (map-get? bets { round-id: round-id, user: bettor, side: "DOWN" }))
  )
    ;; Process UP bet
    (match bet-up up-data
      (if (get claimed up-data)
        true
        (begin
          (map-set bets { round-id: round-id, user: bettor, side: "UP" }
            (merge up-data { claimed: true }))
          (if is-tie
            ;; TIE: refund full amount, no fee
            (match (contract-call? .test-usdcx transfer-from SELF bettor (get amount up-data) none)
              success true
              error true)
            (if (is-eq outcome "UP")
              ;; Winner
              (if (> winning-pool u0)
                (let (
                  (gross (/ (* (get amount up-data) total-pool) winning-pool))
                  (fee (/ (* gross FEE_BPS) u10000))
                  (ops-fee (/ (* gross FEE_OPS_BPS) u10000))
                  (jackpot-fee (- fee ops-fee))
                  (net (- gross fee))
                )
                  (match (contract-call? .test-usdcx transfer-from SELF bettor net none)
                    success true
                    error true)
                  ;; 2% ops fee -> fee-recipient
                  (if (> ops-fee u0)
                    (match (contract-call? .test-usdcx transfer-from SELF the-fee-recipient ops-fee none)
                      success true
                      error true)
                    true
                  )
                  ;; 1% jackpot fee stays in contract (just increment tracker)
                  (if (> jackpot-fee u0)
                    (begin
                      (var-set jackpot-balance (+ (var-get jackpot-balance) jackpot-fee))
                      true)
                    true
                  )
                )
                ;; winning-pool = 0: refund
                (match (contract-call? .test-usdcx transfer-from SELF bettor (get amount up-data) none)
                  success true
                  error true)
              )
              ;; Loser or no counterparty handled separately
              (if (is-eq winning-pool u0)
                ;; No counterparty: refund without fee
                (match (contract-call? .test-usdcx transfer-from SELF bettor (get amount up-data) none)
                  success true
                  error true)
                ;; Lost: nothing
                true
              )
            )
          )
        )
      )
      true ;; no UP bet
    )
    ;; Process DOWN bet
    (match bet-down down-data
      (if (get claimed down-data)
        true
        (begin
          (map-set bets { round-id: round-id, user: bettor, side: "DOWN" }
            (merge down-data { claimed: true }))
          (if is-tie
            (match (contract-call? .test-usdcx transfer-from SELF bettor (get amount down-data) none)
              success true
              error true)
            (if (is-eq outcome "DOWN")
              (if (> winning-pool u0)
                (let (
                  (gross (/ (* (get amount down-data) total-pool) winning-pool))
                  (fee (/ (* gross FEE_BPS) u10000))
                  (ops-fee (/ (* gross FEE_OPS_BPS) u10000))
                  (jackpot-fee (- fee ops-fee))
                  (net (- gross fee))
                )
                  (match (contract-call? .test-usdcx transfer-from SELF bettor net none)
                    success true
                    error true)
                  ;; 2% ops fee -> fee-recipient
                  (if (> ops-fee u0)
                    (match (contract-call? .test-usdcx transfer-from SELF the-fee-recipient ops-fee none)
                      success true
                      error true)
                    true
                  )
                  ;; 1% jackpot fee stays in contract (just increment tracker)
                  (if (> jackpot-fee u0)
                    (begin
                      (var-set jackpot-balance (+ (var-get jackpot-balance) jackpot-fee))
                      true)
                    true
                  )
                )
                (match (contract-call? .test-usdcx transfer-from SELF bettor (get amount down-data) none)
                  success true
                  error true)
              )
              (if (is-eq winning-pool u0)
                (match (contract-call? .test-usdcx transfer-from SELF bettor (get amount down-data) none)
                  success true
                  error true)
                true
              )
            )
          )
        )
      )
      true ;; no DOWN bet
    )
    true
  )
)

;; ----------------------------------------------------------------------------
;; PUBLIC FUNCTIONS
;; ----------------------------------------------------------------------------

;; Place a bet on a round
;; GATEWAY-ONLY: only callable via the gateway contract
(define-public (place-bet (round-id uint) (side (string-ascii 4)) (amount uint))
  (let (
    (round-start-time (* round-id ROUND_DURATION))
    (trading-close-time (+ round-start-time TRADING_WINDOW))
    (current-time (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
    (current-round-data (default-to
      { total-up: u0, total-down: u0, price-start: u0, price-end: u0, resolved: false }
      (map-get? rounds { round-id: round-id })))
    (existing-bet (map-get? bets { round-id: round-id, user: tx-sender, side: side }))
    (current-amount (default-to u0 (get amount existing-bet)))
  )
    ;; Emergency pause check
    (asserts! (not (var-get contract-paused)) ERR_PAUSED)
    ;; GATEWAY CHECK: only the gateway contract can call place-bet
    (asserts! (is-eq contract-caller (var-get gateway)) ERR_UNAUTHORIZED)

    ;; Validations
    (asserts! (or (is-eq side "UP") (is-eq side "DOWN")) ERR_INVALID_SIDE)
    (asserts! (>= amount MIN_BET) ERR_INVALID_AMOUNT)
    ;; On-chain timing safety net (sponsor validates with real clock)
    (asserts! (< current-time trading-close-time) ERR_TRADING_CLOSED)
    ;; Prevents bets on already resolved rounds
    (asserts! (not (get resolved current-round-data)) ERR_TRADING_CLOSED)

    ;; Transfer tokens from user to contract
    (try! (contract-call? .test-usdcx transfer-from tx-sender SELF amount none))

    ;; Update round totals
    (map-set rounds { round-id: round-id }
      {
        total-up: (if (is-eq side "UP")
          (+ (get total-up current-round-data) amount)
          (get total-up current-round-data)),
        total-down: (if (is-eq side "DOWN")
          (+ (get total-down current-round-data) amount)
          (get total-down current-round-data)),
        price-start: (get price-start current-round-data),
        price-end: (get price-end current-round-data),
        resolved: (get resolved current-round-data)
      }
    )

    ;; Record/accumulate user bet
    (map-set bets { round-id: round-id, user: tx-sender, side: side }
      {
        amount: (+ current-amount amount),
        claimed: false
      }
    )

    ;; Add bettor to round list (for settlement)
    (add-bettor-to-round round-id tx-sender)

    (ok {
      round-id: round-id,
      side: side,
      amount: amount
    })
  )
)

;; Resolve a round and distribute all payouts atomically
;; GATEWAY-ONLY: only callable via the gateway (which restricts to sponsor)
;; Price bounds: rejects prices diverging >2% from last-known-price
;; Counterparty check: if only one side has bets, refund without fee
(define-public (resolve-and-distribute (round-id uint) (price-start uint) (price-end uint))
  (let (
    (round-end-time (* (+ round-id u1) ROUND_DURATION))
    (current-time (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
    (round-data (default-to
      { total-up: u0, total-down: u0, price-start: u0, price-end: u0, resolved: false }
      (map-get? rounds { round-id: round-id })))
    (bettors-data (default-to { bettors: (list ) } (map-get? round-bettors { round-id: round-id })))
    (bettor-list (get bettors bettors-data))
    (total-up (get total-up round-data))
    (total-down (get total-down round-data))
    (total-pool (+ total-up total-down))
    (is-tie (is-eq price-end price-start))
    (outcome (if (> price-end price-start)
      "UP"
      (if (< price-end price-start)
        "DOWN"
        "TIE")))
    (has-counterparty (and (> total-up u0) (> total-down u0)))
    (winning-pool (if is-tie
      u0
      (if (not has-counterparty)
        u0
        (if (is-eq outcome "UP") total-up total-down))))
  )
    ;; Gateway check
    (asserts! (is-eq contract-caller (var-get gateway)) ERR_UNAUTHORIZED)
    ;; Round must have ended
    (asserts! (> current-time round-end-time) ERR_ROUND_NOT_ENDED)
    ;; Not already resolved
    (asserts! (not (get resolved round-data)) ERR_ALREADY_RESOLVED)
    ;; Price validation
    (asserts! (> price-start u0) ERR_INVALID_PRICES)
    (asserts! (> price-end u0) ERR_INVALID_PRICES)
    ;; Price bounds: last-known-price must be initialized
    (asserts! (> (var-get last-known-price) u0) ERR_NOT_INITIALIZED)
    ;; Price bounds: both prices must be within 2% of last-known
    (asserts! (is-price-in-bounds price-start) ERR_PRICE_OUT_OF_BOUNDS)
    (asserts! (is-price-in-bounds price-end) ERR_PRICE_OUT_OF_BOUNDS)

    ;; Mark round as resolved with prices
    (map-set rounds { round-id: round-id }
      (merge round-data { price-start: price-start, price-end: price-end, resolved: true }))

    ;; Update last-known-price to price-end for next round's bounds
    (var-set last-known-price price-end)

    ;; Set resolve context for process-bettor-payout
    (var-set current-resolve-round round-id)
    (var-set current-resolve-outcome outcome)
    (var-set current-resolve-total-pool total-pool)
    (var-set current-resolve-is-tie is-tie)
    (var-set current-resolve-fee-recipient (var-get fee-recipient))

    ;; If no counterparty, set winning-pool to 0 to trigger refund path
    (var-set current-resolve-winning-pool
      (if has-counterparty winning-pool u0))

    ;; Distribute payouts to all bettors
    (map process-bettor-payout bettor-list)

    ;; Emit event for off-chain tracking
    (print {
      event: "round-resolved",
      round-id: round-id,
      outcome: outcome,
      price-start: price-start,
      price-end: price-end,
      total-up: total-up,
      total-down: total-down,
      has-counterparty: has-counterparty
    })

    (ok {
      round-id: round-id,
      outcome: outcome,
      price-start: price-start,
      price-end: price-end
    })
  )
)

;; ----------------------------------------------------------------------------
;; ADMIN FUNCTIONS (deployer-only)
;; ----------------------------------------------------------------------------

;; Set gateway contract address (one-shot bootstrap, no timelock)
;; Only works when gateway == DEPLOYER (never been configured)
;; After this, gateway changes require schedule-gateway + activate-gateway (144-block timelock)
(define-public (set-gateway-bootstrap (new-gateway principal))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (asserts! (is-eq (var-get gateway) DEPLOYER) ERR_ALREADY_INITIALIZED)
    (var-set gateway new-gateway)
    (print { event: "gateway-bootstrap", new-gateway: new-gateway })
    (ok new-gateway)
  )
)

;; Set initial BTC price for price bounds bootstrap
;; One-shot: only works if last-known-price == 0
(define-public (set-initial-price (price uint))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (asserts! (is-eq (var-get last-known-price) u0) ERR_ALREADY_INITIALIZED)
    (asserts! (> price u0) ERR_INVALID_PRICES)
    (var-set last-known-price price)
    (print { event: "initial-price-set", price: price })
    (ok price)
  )
)

;; Admin reset of last-known-price (escape hatch for stale price deadlock)
;; Deployer-only, no timelock (time-critical recovery operation)
(define-public (admin-set-price (price uint))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (asserts! (> price u0) ERR_INVALID_PRICES)
    (var-set last-known-price price)
    (print { event: "admin-price-reset", price: price, block: stacks-block-height })
    (ok price)
  )
)

;; Set fee recipient (immediate, low risk)
(define-public (set-fee-recipient (new-recipient principal))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (var-set fee-recipient new-recipient)
    (print { event: "fee-recipient-changed", new-recipient: new-recipient })
    (ok new-recipient)
  )
)

;; Schedule gateway change (timelock: activates after 144 blocks)
(define-public (schedule-gateway (new-gateway principal))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (var-set pending-gateway (some new-gateway))
    (var-set gateway-activation-block (+ stacks-block-height TIMELOCK_BLOCKS))
    (print {
      event: "gateway-scheduled",
      new-gateway: new-gateway,
      activation-block: (+ stacks-block-height TIMELOCK_BLOCKS)
    })
    (ok true)
  )
)

;; Activate scheduled gateway change (after timelock expires)
(define-public (activate-gateway)
  (let (
    (new-gw (unwrap! (var-get pending-gateway) ERR_NO_PENDING))
  )
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (asserts! (>= stacks-block-height (var-get gateway-activation-block)) ERR_TIMELOCK_NOT_EXPIRED)
    (var-set gateway new-gw)
    (var-set pending-gateway none)
    (print { event: "gateway-activated", new-gateway: new-gw })
    (ok new-gw)
  )
)

;; Schedule sponsor change (timelock: activates after 144 blocks)
;; Note: sponsor is enforced in the gateway, not here. This is for auditability.
(define-public (schedule-sponsor (new-sponsor principal))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (var-set pending-sponsor (some new-sponsor))
    (var-set sponsor-activation-block (+ stacks-block-height TIMELOCK_BLOCKS))
    (print {
      event: "sponsor-scheduled",
      new-sponsor: new-sponsor,
      activation-block: (+ stacks-block-height TIMELOCK_BLOCKS)
    })
    (ok true)
  )
)

;; Activate scheduled sponsor change
(define-public (activate-sponsor)
  (let (
    (new-sp (unwrap! (var-get pending-sponsor) ERR_NO_PENDING))
  )
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (asserts! (>= stacks-block-height (var-get sponsor-activation-block)) ERR_TIMELOCK_NOT_EXPIRED)
    (var-set pending-sponsor none)
    (print { event: "sponsor-activated", new-sponsor: new-sp })
    (ok new-sp)
  )
)

;; Emergency pause/unpause
(define-public (set-paused (paused bool))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (var-set contract-paused paused)
    (if paused
      (var-set paused-at-block stacks-block-height)
      true
    )
    (print { event: "paused-changed", paused: paused, block: stacks-block-height })
    (ok paused)
  )
)

;; Emergency withdraw -- max 50% of contract token balance per execution
;; Requires: contract paused for 200+ blocks, 200 blocks between withdrawals
(define-public (emergency-withdraw)
  (let (
    (balance (unwrap-panic (contract-call? .test-usdcx get-balance SELF)))
    (max-withdraw (/ balance u2))
  )
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    ;; Must be paused
    (asserts! (var-get contract-paused) ERR_NOT_PAUSED)
    ;; Must have been paused for 200+ blocks
    (asserts! (>= (- stacks-block-height (var-get paused-at-block)) WITHDRAW_COOLDOWN) ERR_WITHDRAW_COOLDOWN)
    ;; Cooldown between withdrawals (200 blocks)
    (asserts! (>= (- stacks-block-height (var-get last-withdraw-block)) WITHDRAW_COOLDOWN) ERR_WITHDRAW_COOLDOWN)

    (var-set last-withdraw-block stacks-block-height)

    (if (> max-withdraw u0)
      (begin
        (try! (contract-call? .test-usdcx transfer-from SELF DEPLOYER max-withdraw none))
        (print {
          event: "emergency-withdraw",
          amount: max-withdraw,
          remaining: (- balance max-withdraw),
          block: stacks-block-height
        })
        (ok max-withdraw)
      )
      (ok u0)
    )
  )
)

;; ----------------------------------------------------------------------------
;; JACKPOT FUNCTIONS
;; ----------------------------------------------------------------------------

;; Pay jackpot winner -- transfers tokens from contract treasury to winner
;; GATEWAY-ONLY (gateway restricts to sponsor)
;; Amount must not exceed current jackpot-balance
(define-public (pay-jackpot-winner (winner principal) (amount uint))
  (let (
    (current-jackpot (var-get jackpot-balance))
  )
    ;; Gateway check (sponsor-only via gateway)
    (asserts! (is-eq contract-caller (var-get gateway)) ERR_UNAUTHORIZED)
    ;; Must not be paused
    (asserts! (not (var-get contract-paused)) ERR_PAUSED)
    ;; Amount must be positive and within jackpot balance
    (asserts! (> amount u0) ERR_INVALID_AMOUNT)
    (asserts! (<= amount current-jackpot) ERR_INVALID_AMOUNT)

    ;; Transfer tokens from contract to winner
    (try! (contract-call? .test-usdcx transfer-from SELF winner amount none))

    ;; Decrement jackpot balance
    (var-set jackpot-balance (- current-jackpot amount))

    (print {
      event: "jackpot-paid",
      winner: winner,
      amount: amount,
      jackpot-remaining: (- current-jackpot amount)
    })

    (ok { winner: winner, amount: amount, remaining: (- current-jackpot amount) })
  )
)

;; Seed jackpot treasury -- deployer deposits tokens into jackpot fund
;; Deployer-only, transfers tokens from deployer to contract and increments jackpot-balance
(define-public (seed-jackpot (amount uint))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (asserts! (> amount u0) ERR_INVALID_AMOUNT)

    ;; Transfer tokens from deployer to contract
    (try! (contract-call? .test-usdcx transfer-from tx-sender SELF amount none))

    ;; Increment jackpot balance
    (var-set jackpot-balance (+ (var-get jackpot-balance) amount))

    (print { event: "jackpot-seeded", amount: amount, new-balance: (+ (var-get jackpot-balance) amount) })
    (ok (var-get jackpot-balance))
  )
)

;; ----------------------------------------------------------------------------
;; READ-ONLY FUNCTIONS
;; ----------------------------------------------------------------------------

(define-read-only (get-current-round-id)
  (/ (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))) u60)
)

(define-read-only (get-round (round-id uint))
  (map-get? rounds { round-id: round-id })
)

(define-read-only (get-bet (round-id uint) (user principal) (side (string-ascii 4)))
  (map-get? bets { round-id: round-id, user: user, side: side })
)

(define-read-only (get-user-bets (round-id uint) (user principal))
  {
    up: (map-get? bets { round-id: round-id, user: user, side: "UP" }),
    down: (map-get? bets { round-id: round-id, user: user, side: "DOWN" })
  }
)

(define-read-only (get-round-bettors (round-id uint))
  (default-to { bettors: (list ) }
    (map-get? round-bettors { round-id: round-id }))
)

(define-read-only (is-round-ended (round-id uint))
  (let ((round-end-time (* (+ round-id u1) ROUND_DURATION)))
    (> (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))) round-end-time)
  )
)

(define-read-only (is-trading-open (round-id uint))
  (let (
    (round-start-time (* round-id ROUND_DURATION))
    (trading-close-time (+ round-start-time TRADING_WINDOW))
    (current-time (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
  )
    (and
      (>= current-time round-start-time)
      (< current-time trading-close-time)
    )
  )
)

(define-read-only (get-last-known-price)
  (var-get last-known-price)
)

(define-read-only (get-gateway)
  (var-get gateway)
)

(define-read-only (get-fee-recipient)
  (var-get fee-recipient)
)

(define-read-only (get-pending-gateway)
  {
    pending: (var-get pending-gateway),
    activation-block: (var-get gateway-activation-block)
  }
)

(define-read-only (get-pending-sponsor)
  {
    pending: (var-get pending-sponsor),
    activation-block: (var-get sponsor-activation-block)
  }
)

(define-read-only (is-contract-paused)
  (var-get contract-paused)
)

(define-read-only (get-paused-at-block)
  (var-get paused-at-block)
)

(define-read-only (get-jackpot-balance)
  (var-get jackpot-balance)
)
