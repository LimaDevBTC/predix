;; ============================================================================
;; PREDIX v2 GATEWAY - Thin proxy for place-bet (sponsor-only entry point)
;; ============================================================================
;; This contract is the ONLY allowed caller of predixv2.place-bet.
;;
;; SECURITY LAYERS:
;; 1. Gateway pattern: predixv2.place-bet rejects calls not from this contract
;; 2. On-chain timing: predixv2 checks TRADING_WINDOW (55s safety net)
;; 3. Sponsor (off-chain): validates real clock timing (10s cutoff) and early flag
;;
;; KNOWN LIMITATION: Clarity cannot distinguish sponsored vs non-sponsored txs
;; on-chain. A user with STX could call this gateway directly, bypassing the
;; sponsor's real-clock timing validation. The on-chain TRADING_WINDOW (55s)
;; in predixv2 serves as the safety net. The early flag could be spoofed by
;; direct callers, but this only benefits them marginally (jackpot eligibility)
;; and the sponsor validates it for all normal (sponsored) flows.
;;
;; For mainnet, consider adding a deployer-signed nonce or authorization token
;; to cryptographically prove sponsor approval on-chain.
;; ============================================================================

(define-constant DEPLOYER 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK)
(define-constant ROUND_DURATION u60)
(define-constant ERR_UNAUTHORIZED (err u2000))
(define-constant ERR_GATEWAY_PAUSED (err u2001))
(define-constant ERR_ROUND_NOT_ACTIVE (err u2002))

;; Emergency pause -- deployer can disable the gateway to stop all new bets
(define-data-var gateway-paused bool false)

;; Deployer-only: pause/unpause the gateway
(define-public (set-paused (paused bool))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (var-set gateway-paused paused)
    (ok paused)
  )
)

;; Gateway entry point for place-bet
;; Forwards the call to predixv2.place-bet with contract-caller = this gateway
;; The sponsor validates timing and early flag before broadcasting the tx that calls this function
(define-public (place-bet (round-id uint) (side (string-ascii 4)) (amount uint) (early bool))
  (begin
    ;; Emergency pause check
    (asserts! (not (var-get gateway-paused)) ERR_GATEWAY_PAUSED)

    ;; Basic round sanity check: round-id must be plausible (within last 2 minutes)
    ;; This prevents bets on ancient or far-future rounds via direct gateway calls
    (let (
      (current-time (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
      (current-round (/ current-time ROUND_DURATION))
    )
      ;; Allow current round, previous round, and next round (block time can lag 30-60s behind real clock)
      ;; Without (+ u1), frontend's round-id (real clock) can be 1 ahead of block time -> rejected
      (asserts! (or
        (is-eq round-id current-round)
        (is-eq round-id (+ current-round u1))
        (and (> current-round u0) (is-eq round-id (- current-round u1)))
      ) ERR_ROUND_NOT_ACTIVE)
    )

    (contract-call? .predixv2 place-bet round-id side amount early)
  )
)

;; Read-only: check if gateway is paused
(define-read-only (is-paused)
  (var-get gateway-paused)
)
