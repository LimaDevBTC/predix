;; ============================================================================
;; GATEWAY v7 - Thin proxy for predixv8 (sponsor-only entry point)
;; ============================================================================
;; Changes from gatewayv6:
;; - Points to predixv8 (not predixv7)
;; ============================================================================

(define-constant DEPLOYER 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK)
(define-constant ROUND_DURATION u60)
(define-constant ERR_UNAUTHORIZED (err u2000))
(define-constant ERR_GATEWAY_PAUSED (err u2001))
(define-constant ERR_ROUND_NOT_ACTIVE (err u2002))
(define-constant ERR_NOT_SPONSOR (err u2003))

;; Emergency pause
(define-data-var gateway-paused bool false)

;; Sponsor address (deployer can change)
(define-data-var sponsor principal DEPLOYER)

;; Deployer-only: pause/unpause the gateway
(define-public (set-paused (paused bool))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (var-set gateway-paused paused)
    (ok paused)
  )
)

;; Deployer-only: set sponsor address
(define-public (set-sponsor (new-sponsor principal))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (var-set sponsor new-sponsor)
    (print { event: "sponsor-changed", new-sponsor: new-sponsor })
    (ok new-sponsor)
  )
)

;; Gateway entry point for place-bet
;; Any user (via sponsor), round sanity check, not paused
(define-public (place-bet (round-id uint) (side (string-ascii 4)) (amount uint))
  (begin
    (asserts! (not (var-get gateway-paused)) ERR_GATEWAY_PAUSED)

    ;; Round sanity: must be current round +/- 1 (block time can lag)
    (let (
      (current-time (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
      (current-round (/ current-time ROUND_DURATION))
    )
      (asserts! (or
        (is-eq round-id current-round)
        (is-eq round-id (+ current-round u1))
        (and (> current-round u0) (is-eq round-id (- current-round u1)))
      ) ERR_ROUND_NOT_ACTIVE)
    )

    (contract-call? .predixv8 place-bet round-id side amount)
  )
)

;; Gateway entry point for resolve-and-distribute
;; SPONSOR-ONLY: only the sponsor wallet can settle rounds
(define-public (resolve-and-distribute (round-id uint) (price-start uint) (price-end uint))
  (begin
    (asserts! (not (var-get gateway-paused)) ERR_GATEWAY_PAUSED)
    (asserts! (is-eq tx-sender (var-get sponsor)) ERR_NOT_SPONSOR)

    (contract-call? .predixv8 resolve-and-distribute round-id price-start price-end)
  )
)

;; Gateway entry point for pay-jackpot-winner
;; SPONSOR-ONLY: only the sponsor wallet can pay jackpot prizes
(define-public (pay-jackpot-winner (winner principal) (amount uint))
  (begin
    (asserts! (not (var-get gateway-paused)) ERR_GATEWAY_PAUSED)
    (asserts! (is-eq tx-sender (var-get sponsor)) ERR_NOT_SPONSOR)

    (contract-call? .predixv8 pay-jackpot-winner winner amount)
  )
)

;; Read-only: check if gateway is paused
(define-read-only (is-paused)
  (var-get gateway-paused)
)

;; Read-only: get current sponsor
(define-read-only (get-sponsor)
  (var-get sponsor)
)
