/**
 * Tipos do Bitpredix - Prediction Market para o preço do Bitcoin no próximo minuto
 */

export type MarketSide = 'UP' | 'DOWN'

export type RoundStatus = 'TRADING' | 'RESOLVING' | 'RESOLVED'

/** Estado do pool LMSR. qUp/qDown = net shares vendidas; volumeTraded = USD acumulado no round. */
export interface PoolState {
  qUp: number
  qDown: number
  volumeTraded: number
}

export interface Round {
  id: string
  /** Timestamp de início da rodada (início do minuto) */
  startAt: number
  /** Timestamp de fim (fim do minuto, quando resolve) */
  endsAt: number
  /** Timestamp em que as apostas travam (aleatório entre 10 e 14s antes de endsAt). Se ausente, usa endsAt. */
  tradingClosesAt?: number
  /** Preço do BTC no início da rodada (em USD) */
  priceAtStart: number
  /** Preço do BTC no fim (preenchido quando resolved) */
  priceAtEnd?: number
  /** Resultado: UP se priceAtEnd > priceAtStart, DOWN caso contrário */
  outcome?: MarketSide
  status: RoundStatus
  pool: PoolState
}

export interface Trade {
  roundId: string
  side: MarketSide
  /** Valor em USD (ou sBTC) pago */
  amountUsd: number
  /** Número de shares recebidas */
  sharesReceived: number
  /** Preço efetivo por share (amountUsd / sharesReceived) */
  pricePerShare: number
  timestamp: number
}

export interface JackpotState {
  balance: number     // Saldo atual do jackpot em USD
  earlyUp: number     // Early bets em UP neste round (USD)
  earlyDown: number   // Early bets em DOWN neste round (USD)
}

/** Resposta da API de preço do Bitcoin */
export interface BtcPriceResponse {
  usd: number
  usd_24h_change?: number
  last_updated_at?: number
}
