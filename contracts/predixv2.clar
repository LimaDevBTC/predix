;; ============================================================================
;; PREDIX v2 - Prediction Market with Velocity Jackpot (Beta/Testnet)
;; ============================================================================
;; Based on predixv1 with the following changes:
;; - Velocity Jackpot: 1% of volume accumulates and distributes to early bettors
;; - Fee split: 2% protocol + 1% jackpot (total 3% unchanged)
;; - Early window: first 20s of round = jackpot eligible
;; - Bets map: early + early-amount fields added
;; - round-jackpot map: snapshot, early pools, distributed counter, lock flag
;; - Gateway pattern: place-bet restricted to gateway contract (sponsor-only)
;; - process-claim: defensive resolved check + snapshot isolation
;; - Jackpot bonus calculated on early-amount only (not total position)
;; - Jackpot distribution capped by (snapshot - already_distributed) per round
;; - jackpot-fee calculated directly (avoids rounding from subtraction)
;; - TIE handling: price-start == price-end refunds all bettors (no fee)
;; - claim-round-side requires round-end-time check (prevents premature claims)
;; - Emergency pause: deployer can halt place-bet via set-paused
;; - ERR_ROUND_NOT_FOUND (u1015) for missing round data in process-claim
;; ============================================================================

;; ----------------------------------------------------------------------------
;; CONSTANTES
;; ----------------------------------------------------------------------------

(define-constant CONTRACT_OWNER tx-sender)
(define-constant SELF 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv2)
(define-constant DEPLOYER 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK)
(define-constant GATEWAY 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv2-gateway)

;; Erros
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
(define-constant ERR_JACKPOT_UNDERFLOW (err u1013))
(define-constant ERR_NOT_RESOLVED (err u1014))
(define-constant ERR_ROUND_NOT_FOUND (err u1015))
(define-constant ERR_PAUSED (err u1016))

;; Configuracao de tempo (em segundos)
(define-constant ROUND_DURATION u60)        ;; 60 segundos por round
(define-constant TRADING_WINDOW u55)        ;; Cutoff 5s -- trading fecha 5s antes do fim do round

;; Configuracao financeira
(define-constant MIN_BET u1000000)          ;; 1 USDCx minimo (6 decimais)
(define-constant FEE_BPS u300)              ;; 3% fee total (300 basis points)
(define-constant PROTOCOL_FEE_BPS u200)     ;; 2% protocol
(define-constant JACKPOT_FEE_BPS u100)      ;; 1% goes to jackpot fund
(define-constant FEE_RECIPIENT 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK)

;; ----------------------------------------------------------------------------
;; DATA MAPS
;; ----------------------------------------------------------------------------

;; Informacoes do round (criado quando primeira aposta acontece)
(define-map rounds
  { round-id: uint }
  {
    total-up: uint,         ;; Total apostado em UP
    total-down: uint,       ;; Total apostado em DOWN
    price-start: uint,      ;; Preco de abertura (centavos, 2 decimais)
    price-end: uint,        ;; Preco de fechamento (centavos, 2 decimais)
    resolved: bool          ;; Se ja foi resolvido
  }
)

;; Apostas individuais - side faz parte da key (permite UP e DOWN por usuario)
;; early: true se a primeira aposta neste side foi nos primeiros 20s
;; early-amount: total apostado durante janela early (para calculo de jackpot)
(define-map bets
  { round-id: uint, user: principal, side: (string-ascii 4) }
  { amount: uint, early-amount: uint, claimed: bool, early: bool }
)

;; Lista de rounds pendentes por usuario (para o botao CLAIM)
;; Maximo de 50 rounds pendentes por usuario
(define-map user-pending-rounds
  { user: principal }
  { round-ids: (list 50 uint) }
)

;; Lista de apostadores por round (para backend auto-claim)
(define-map round-bettors
  { round-id: uint }
  { bettors: (list 200 principal) }
)

;; Jackpot data per round -- eligibility tracking and snapshot
(define-map round-jackpot
  { round-id: uint }
  {
    snapshot: uint,       ;; jackpot balance frozen on first claim of this round
    early-up: uint,       ;; total bet on UP in first 20s (micro-units)
    early-down: uint,     ;; total bet on DOWN in first 20s (micro-units)
    distributed: uint,    ;; total bonus already distributed from snapshot (prevents over-distribution)
    locked: bool          ;; true after first claim (prevents re-snapshot)
  }
)

;; ----------------------------------------------------------------------------
;; VARIAVEIS DE ESTADO
;; ----------------------------------------------------------------------------

;; Variavel auxiliar para filtrar rounds (usada em remove-user-pending-round)
(define-data-var filter-target-round uint u0)

;; Accumulated jackpot balance (in micro-units, 6 decimals)
;; Starts at zero. Accumulates 1% of volume from each valid round.
(define-data-var jackpot-balance uint u0)

;; Emergency pause -- deployer can halt place-bet and claims
(define-data-var contract-paused bool false)

;; ----------------------------------------------------------------------------
;; FUNCOES PRIVADAS
;; ----------------------------------------------------------------------------

;; Helper para filter - verifica se o round NAO e o target
(define-private (is-not-target-round (id uint))
  (not (is-eq id (var-get filter-target-round)))
)

;; Adiciona um round a lista de pendentes do usuario
(define-private (add-user-pending-round (user principal) (round-id uint))
  (let (
    (current-data (default-to { round-ids: (list ) } (map-get? user-pending-rounds { user: user })))
    (current-list (get round-ids current-data))
  )
    ;; Verifica se ja nao esta na lista
    (if (is-some (index-of? current-list round-id))
      (ok true)
      ;; Adiciona a lista (maximo 50)
      (match (as-max-len? (append current-list round-id) u50)
        new-list (begin
          (map-set user-pending-rounds { user: user } { round-ids: new-list })
          (ok true)
        )
        ;; Lista cheia - usuario precisa fazer claim primeiro
        (err u1010)
      )
    )
  )
)

;; Remove um round da lista de pendentes do usuario
(define-private (remove-user-pending-round (user principal) (round-id uint))
  (let (
    (current-data (default-to { round-ids: (list ) } (map-get? user-pending-rounds { user: user })))
    (current-list (get round-ids current-data))
  )
    ;; Seta o target antes de filtrar
    (var-set filter-target-round round-id)
    (let ((filtered-list (filter is-not-target-round current-list)))
      (map-set user-pending-rounds { user: user } { round-ids: filtered-list })
      true
    )
  )
)

;; Adiciona apostador a lista do round (para auto-claim pelo backend)
;; Retorna bool, nunca falha -- se lista cheia, retorna true silenciosamente
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

;; Shared payout + jackpot logic, used by claim-round-side and claim-on-behalf.
;; Assumes: round is already resolved, bet exists and is not claimed.
;; Marks bet as claimed, removes from pending, calculates payout + jackpot bonus.
;;
;; NOTE ON JACKPOT OPERATION SEQUENCE:
;; 1. Snapshot: freezes jackpot-balance on first claim (locked=false -> true)
;; 2. Calculates bonus capped by (snapshot - already_distributed) to prevent
;;    cross-claim contamination from fees accumulated between claims
;; 3. Updates distributed counter in round-jackpot (tracks total bonus paid out)
;; 4. Deducts bonus from global jackpot-balance (with underflow guard)
;; 5. Accumulates jackpot-fee (1%) -- goes to NEXT round's snapshot
;;
;; JACKPOT BONUS: calculated on early-amount only, not total position.
;; This prevents the exploit of betting MIN_BET early to activate jackpot on full position.
;;
;; TIE HANDLING: if price-start == price-end, all bettors get full refund (no fee, no jackpot).
(define-private (process-claim (user principal) (round-id uint) (side (string-ascii 4)))
  (let (
    (final-round (unwrap! (map-get? rounds { round-id: round-id }) ERR_ROUND_NOT_FOUND))
    (bet-data (unwrap! (map-get? bets { round-id: round-id, user: user, side: side }) ERR_NO_BET))
    (final-price-start (get price-start final-round))
    (final-price-end (get price-end final-round))
    (is-tie (is-eq final-price-end final-price-start))
    (outcome (if (> final-price-end final-price-start)
      "UP"
      (if (< final-price-end final-price-start)
        "DOWN"
        "TIE")))
    (user-won (and (not is-tie) (is-eq side outcome)))
    (total-pool (+ (get total-up final-round) (get total-down final-round)))
    (winning-pool (if is-tie
      u0
      (if (is-eq outcome "UP")
        (get total-up final-round)
        (get total-down final-round))))
    (user-amount (get amount bet-data))
    (user-early-amount (get early-amount bet-data))
  )
    ;; Defensive: ensure round is resolved before processing claim
    (asserts! (get resolved final-round) ERR_NOT_RESOLVED)

    ;; Mark bet as claimed (preserves early flag via merge)
    (map-set bets { round-id: round-id, user: user, side: side }
      (merge bet-data { claimed: true }))

    ;; Remove from pending list ONLY if both sides have been claimed
    (let (
      (other-side (if (is-eq side "UP") "DOWN" "UP"))
      (other-bet (map-get? bets { round-id: round-id, user: user, side: other-side }))
      (other-claimed (match other-bet ob (get claimed ob) true))
    )
      (if other-claimed
        (begin (remove-user-pending-round user round-id) true)
        true
      )
    )

    ;; TIE: refund full amount to all bettors, no fee, no jackpot
    (if is-tie
      (begin
        (try! (contract-call? .test-usdcx transfer-from SELF user user-amount none))
        (ok {
          won: true,
          payout: user-amount,
          outcome: outcome,
          price-start: final-price-start,
          price-end: final-price-end
        })
      )
      ;; Not a tie: normal payout with jackpot
      (if user-won
        (if (> winning-pool u0)
          (let (
            ;; Proportional payout: (user_amount / winning_pool) * total_pool
            (gross-payout (/ (* user-amount total-pool) winning-pool))
            (total-fee (/ (* gross-payout FEE_BPS) u10000))
            ;; Calculate jackpot-fee directly (avoids rounding error from subtraction)
            (jackpot-fee (/ (* gross-payout JACKPOT_FEE_BPS) u10000))
            (protocol-fee (- total-fee jackpot-fee))
            (net-payout (- gross-payout total-fee))

            ;; Jackpot: snapshot on first claim, distribute bonus capped by snapshot
            (jp-data (default-to
              { snapshot: u0, early-up: u0, early-down: u0, distributed: u0, locked: false }
              (map-get? round-jackpot { round-id: round-id })))
            (jp-snapshot (if (get locked jp-data)
              (get snapshot jp-data)
              (var-get jackpot-balance)))
            ;; How much of the snapshot is still available for distribution?
            (jp-already-distributed (get distributed jp-data))
            (jp-remaining (if (> jp-snapshot jp-already-distributed)
              (- jp-snapshot jp-already-distributed)
              u0))
            (winning-early-pool (if (is-eq outcome "UP")
              (get early-up jp-data)
              (get early-down jp-data)))
            (user-early (get early bet-data))
            ;; Calculate raw bonus using EARLY-AMOUNT only (not total position)
            (raw-jackpot-bonus (if (and user-early (> winning-early-pool u0) (> jp-snapshot u0))
              (/ (* user-early-amount jp-snapshot) winning-early-pool)
              u0))
            ;; Cap bonus by remaining snapshot (prevents over-distribution from rounding + cross-claim fees)
            (jackpot-bonus (if (> raw-jackpot-bonus jp-remaining)
              jp-remaining
              raw-jackpot-bonus))
          )
            ;; 1. Snapshot: freeze jackpot-balance on first claim of this round
            (if (not (get locked jp-data))
              (map-set round-jackpot { round-id: round-id }
                (merge jp-data { snapshot: (var-get jackpot-balance), locked: true, distributed: u0 }))
              true
            )

            ;; 2. Update distributed counter and deduct bonus from global fund
            (if (> jackpot-bonus u0)
              (let (
                (current-jp (default-to
                  { snapshot: u0, early-up: u0, early-down: u0, distributed: u0, locked: false }
                  (map-get? round-jackpot { round-id: round-id })))
              )
                ;; Track how much of snapshot has been paid out
                (map-set round-jackpot { round-id: round-id }
                  (merge current-jp { distributed: (+ (get distributed current-jp) jackpot-bonus) }))
                ;; Deduct from global fund (with underflow guard)
                (var-set jackpot-balance
                  (if (> jackpot-bonus (var-get jackpot-balance))
                    u0
                    (- (var-get jackpot-balance) jackpot-bonus)))
              )
              true
            )

            ;; 3. Accumulate jackpot-fee (1%) in the fund -- goes to NEXT round
            ;;    Done AFTER snapshot and deduction, so it does not contaminate this round's distribution.
            (var-set jackpot-balance (+ (var-get jackpot-balance) jackpot-fee))

            ;; Transfer prize + bonus to user (SELF -> user)
            (try! (contract-call? .test-usdcx transfer-from SELF user (+ net-payout jackpot-bonus) none))
            ;; Transfer protocol fee (SELF -> FEE_RECIPIENT)
            (if (> protocol-fee u0)
              (try! (contract-call? .test-usdcx transfer-from SELF FEE_RECIPIENT protocol-fee none))
              true
            )
            (ok {
              won: true,
              payout: (+ net-payout jackpot-bonus),
              outcome: outcome,
              price-start: final-price-start,
              price-end: final-price-end
            })
          )
          ;; Edge case: winning pool = 0 (nobody bet on the winning side)
          ;; User gets back what they bet -- no fee, no jackpot
          (begin
            (try! (contract-call? .test-usdcx transfer-from SELF user user-amount none))
            (ok {
              won: true,
              payout: user-amount,
              outcome: outcome,
              price-start: final-price-start,
              price-end: final-price-end
            })
          )
        )
        ;; Lost - receives nothing
        (ok {
          won: false,
          payout: u0,
          outcome: outcome,
          price-start: final-price-start,
          price-end: final-price-end
        })
      )
    )
  )
)

;; ----------------------------------------------------------------------------
;; FUNCOES PUBLICAS
;; ----------------------------------------------------------------------------

;; Place a bet on a round
;; @param round-id: Round ID (start timestamp / 60)
;; @param side: "UP" or "DOWN"
;; @param amount: amount in USDCx (6 decimals)
;; @param early: true if bet placed in first 20s (determined by frontend, validated by sponsor)
;; Allows multiple bets: same side accumulates, opposite sides coexist
;;
;; GATEWAY PATTERN: Only callable via the gateway contract (predixv2-gateway).
;; This ensures all bets pass through the sponsor, which validates timing with real clock.
;; Direct calls to this function will be rejected.
(define-public (place-bet (round-id uint) (side (string-ascii 4)) (amount uint) (early bool))
  (let (
    (round-start-time (* round-id ROUND_DURATION))
    (trading-close-time (+ round-start-time TRADING_WINDOW))
    (current-time (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
    (current-round-data (default-to
      { total-up: u0, total-down: u0, price-start: u0, price-end: u0, resolved: false }
      (map-get? rounds { round-id: round-id })))
    (existing-bet (map-get? bets { round-id: round-id, user: tx-sender, side: side }))
    (current-amount (default-to u0 (get amount existing-bet)))
    (current-early-amount (default-to u0 (get early-amount existing-bet)))
    (existing-early (default-to false (get early existing-bet)))
  )
    ;; Emergency pause check
    (asserts! (not (var-get contract-paused)) ERR_PAUSED)
    ;; GATEWAY CHECK: only the gateway contract can call place-bet
    (asserts! (is-eq contract-caller GATEWAY) ERR_UNAUTHORIZED)

    ;; Validations
    (asserts! (or (is-eq side "UP") (is-eq side "DOWN")) ERR_INVALID_SIDE)
    (asserts! (>= amount MIN_BET) ERR_INVALID_AMOUNT)
    ;; On-chain validation: prevents bets on already ended rounds
    ;; Safety net -- sponsor already validates with real clock (10s cutoff)
    (asserts! (< current-time trading-close-time) ERR_TRADING_CLOSED)
    ;; Prevents bets on already resolved rounds (closes residual block delay window)
    (asserts! (not (get resolved current-round-data)) ERR_TRADING_CLOSED)

    ;; Transfer tokens from user to contract (requires prior approve)
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

    ;; Record/accumulate user bet with early flag and early-amount
    ;; If already bet early on this side, keep early=true (rewards initial entry)
    ;; early-amount: only accumulates the portion bet during the early window
    (map-set bets { round-id: round-id, user: tx-sender, side: side }
      {
        amount: (+ current-amount amount),
        early-amount: (if early (+ current-early-amount amount) current-early-amount),
        claimed: false,
        early: (or existing-early early)
      }
    )

    ;; Update early totals in round-jackpot (only if this bet is early)
    (if early
      (let (
        (jp-data (default-to
          { snapshot: u0, early-up: u0, early-down: u0, distributed: u0, locked: false }
          (map-get? round-jackpot { round-id: round-id })))
      )
        (map-set round-jackpot { round-id: round-id }
          (merge jp-data {
            early-up: (if (is-eq side "UP")
              (+ (get early-up jp-data) amount)
              (get early-up jp-data)),
            early-down: (if (is-eq side "DOWN")
              (+ (get early-down jp-data) amount)
              (get early-down jp-data))
          })
        )
      )
      true
    )

    ;; Add round to user's pending list
    (try! (add-user-pending-round tx-sender round-id))

    ;; Add bettor to round list (for auto-claim)
    (add-bettor-to-round round-id tx-sender)

    (ok {
      round-id: round-id,
      side: side,
      amount: amount
    })
  )
)

;; Claim a round by side (manual fallback -- user pays gas)
;; SECURITY: Requires round to have ended (prevents premature claims with fake prices)
(define-public (claim-round-side (round-id uint) (side (string-ascii 4)) (price-start uint) (price-end uint))
  (let (
    (round-end-time (* (+ round-id u1) ROUND_DURATION))
    (current-time (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
    (round-data (default-to
      { total-up: u0, total-down: u0, price-start: u0, price-end: u0, resolved: false }
      (map-get? rounds { round-id: round-id })))
    (bet-data (unwrap! (map-get? bets { round-id: round-id, user: tx-sender, side: side }) ERR_NO_BET))
  )
    ;; Validations
    (asserts! (or (is-eq side "UP") (is-eq side "DOWN")) ERR_INVALID_SIDE)
    (asserts! (not (get claimed bet-data)) ERR_ALREADY_CLAIMED)
    ;; CRITICAL: Round must have ended before anyone can claim (prevents premature resolution with fake prices)
    (asserts! (> current-time round-end-time) ERR_ROUND_NOT_ENDED)
    (asserts! (> price-start u0) ERR_INVALID_PRICES)
    (asserts! (> price-end u0) ERR_INVALID_PRICES)

    ;; Resolve round if not yet resolved
    (if (not (get resolved round-data))
      (map-set rounds { round-id: round-id }
        (merge round-data { price-start: price-start, price-end: price-end, resolved: true }))
      true
    )

    ;; Delegate payout + jackpot logic to process-claim
    (process-claim tx-sender round-id side)
  )
)

;; Resolve um round (seta precos e marca como resolvido)
;; Apenas deployer ou apostador do round pode chamar
(define-public (resolve-round (round-id uint) (price-start uint) (price-end uint))
  (let (
    (round-end-time (* (+ round-id u1) ROUND_DURATION))
    (current-time (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
    (round-data (default-to
      { total-up: u0, total-down: u0, price-start: u0, price-end: u0, resolved: false }
      (map-get? rounds { round-id: round-id })))
  )
    ;; Apenas deployer ou apostador pode resolver
    (asserts! (or
      (is-eq tx-sender DEPLOYER)
      (is-some (map-get? bets { round-id: round-id, user: tx-sender, side: "UP" }))
      (is-some (map-get? bets { round-id: round-id, user: tx-sender, side: "DOWN" }))
    ) ERR_UNAUTHORIZED)
    ;; Round deve ter terminado
    (asserts! (> current-time round-end-time) ERR_ROUND_NOT_ENDED)
    ;; Precos validos
    (asserts! (> price-start u0) ERR_INVALID_PRICES)
    (asserts! (> price-end u0) ERR_INVALID_PRICES)
    ;; Nao pode resolver duas vezes
    (asserts! (not (get resolved round-data)) ERR_ALREADY_RESOLVED)

    ;; Seta precos e marca como resolvido
    (map-set rounds { round-id: round-id }
      (merge round-data { price-start: price-start, price-end: price-end, resolved: true }))

    (ok { round-id: round-id,
          outcome: (if (> price-end price-start) "UP" (if (< price-end price-start) "DOWN" "TIE")),
          price-start: price-start,
          price-end: price-end })
  )
)

;; Claim on behalf of a user (called by backend/deployer)
;; Only DEPLOYER can call. Payout goes to the user, deployer pays gas.
(define-public (claim-on-behalf (user principal) (round-id uint) (side (string-ascii 4)) (price-start uint) (price-end uint))
  (let (
    (round-end-time (* (+ round-id u1) ROUND_DURATION))
    (current-time (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))))
    (round-data (default-to
      { total-up: u0, total-down: u0, price-start: u0, price-end: u0, resolved: false }
      (map-get? rounds { round-id: round-id })))
    (bet-data (unwrap! (map-get? bets { round-id: round-id, user: user, side: side }) ERR_NO_BET))
  )
    ;; Only deployer can call
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    ;; Validations
    (asserts! (or (is-eq side "UP") (is-eq side "DOWN")) ERR_INVALID_SIDE)
    (asserts! (not (get claimed bet-data)) ERR_ALREADY_CLAIMED)
    ;; Round must have ended before claiming (prevents premature resolution)
    (asserts! (> current-time round-end-time) ERR_ROUND_NOT_ENDED)
    (asserts! (> price-start u0) ERR_INVALID_PRICES)
    (asserts! (> price-end u0) ERR_INVALID_PRICES)

    ;; Resolve round if not yet resolved (safety net)
    (if (not (get resolved round-data))
      (map-set rounds { round-id: round-id }
        (merge round-data { price-start: price-start, price-end: price-end, resolved: true }))
      true
    )

    ;; Delegate payout + jackpot logic to process-claim
    (process-claim user round-id side)
  )
)

;; Deployer-only: pause/unpause the contract (emergency stop)
;; When paused, place-bet is blocked. Claims remain functional so users can withdraw.
(define-public (set-paused (paused bool))
  (begin
    (asserts! (is-eq tx-sender DEPLOYER) ERR_UNAUTHORIZED)
    (var-set contract-paused paused)
    (ok paused)
  )
)

;; ----------------------------------------------------------------------------
;; FUNCOES READ-ONLY
;; ----------------------------------------------------------------------------

;; Retorna o round-id atual baseado no timestamp
(define-read-only (get-current-round-id)
  (/ (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))) u60)
)

;; Retorna dados de um round
(define-read-only (get-round (round-id uint))
  (map-get? rounds { round-id: round-id })
)

;; Retorna aposta de um usuario em um round para um side especifico
(define-read-only (get-bet (round-id uint) (user principal) (side (string-ascii 4)))
  (map-get? bets { round-id: round-id, user: user, side: side })
)

;; Retorna ambos os lados de aposta de um usuario em um round
(define-read-only (get-user-bets (round-id uint) (user principal))
  {
    up: (map-get? bets { round-id: round-id, user: user, side: "UP" }),
    down: (map-get? bets { round-id: round-id, user: user, side: "DOWN" })
  }
)

;; Retorna lista de rounds pendentes de um usuario
(define-read-only (get-user-pending-rounds (user principal))
  (default-to
    { round-ids: (list ) }
    (map-get? user-pending-rounds { user: user })
  )
)

;; Retorna quantidade de rounds pendentes
(define-read-only (get-pending-count (user principal))
  (len (get round-ids (get-user-pending-rounds user)))
)

;; Verifica se um round ja terminou
(define-read-only (is-round-ended (round-id uint))
  (let ((round-end-time (* (+ round-id u1) ROUND_DURATION)))
    (> (unwrap-panic (get-stacks-block-info? time (- stacks-block-height u1))) round-end-time)
  )
)

;; Verifica se trading ainda esta aberto para um round
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

;; Retorna lista de apostadores de um round
(define-read-only (get-round-bettors (round-id uint))
  (default-to { bettors: (list ) }
    (map-get? round-bettors { round-id: round-id }))
)

;; Returns current jackpot balance (in micro-units, 6 decimals)
(define-read-only (get-jackpot-balance)
  (var-get jackpot-balance)
)

;; Returns jackpot data for a specific round
(define-read-only (get-round-jackpot (round-id uint))
  (default-to
    { snapshot: u0, early-up: u0, early-down: u0, distributed: u0, locked: false }
    (map-get? round-jackpot { round-id: round-id })
  )
)

;; Returns whether the contract is paused
(define-read-only (is-contract-paused)
  (var-get contract-paused)
)
