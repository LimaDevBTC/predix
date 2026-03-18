export interface PredixClientConfig {
  /** API key (pk_live_...). If omitted and privateKey is set, auto-registers on first call. */
  apiKey?: string
  /** Stacks private key hex. Required for trading. Enables auto-registration if no apiKey. */
  privateKey?: string
  baseUrl?: string
  network?: 'testnet' | 'mainnet'
}

export interface MarketData {
  ok: boolean
  timestamp: number
  round: {
    id: number
    startAt: number
    endsAt: number
    secondsRemaining: number
    tradingOpen: boolean
    status: string
    openPrice: number | null
    currentPrice: number | null
    priceChangePct: number | null
    pool: {
      totalUp: number
      totalDown: number
      totalVolume: number
      oddsUp: number
      oddsDown: number
    }
    effectivePayoutUp: number
    effectivePayoutDown: number
    recentTrades: unknown[]
    hasCounterparty: boolean
    uniqueWallets: number
    jackpot: { balance: number; earlyUp: number; earlyDown: number }
  }
  contract: {
    id: string
    gateway: string
    token: string
    minBetUsd: number
    feeBps: number
    roundDurationSec: number
    network: string
  }
}

export interface OpportunitiesData {
  ok: boolean
  round: { id: number; tradingOpen: boolean; secondsRemaining: number }
  signals: {
    poolImbalance: {
      favoredSide: string | null
      imbalanceRatio: number
      payoutUp: number
      payoutDown: number
      description: string
    }
    priceDirection: {
      side: string | null
      changePct: number | null
      openPrice: number | null
      currentPrice: number | null
      description: string
    }
    volume: { totalUsd: number; level: string; uniqueWallets: number; hasCounterparty: boolean }
    jackpot: { balanceUsd: number; earlyWindowOpen: boolean }
  }
  recentOutcomes: string[]
  streak: { side: string | null; length: number }
}

export interface PositionsData {
  ok: boolean
  address: string
  balanceUsd: number
  pendingRounds: Array<{
    roundId: number
    up: { amount: number } | null
    down: { amount: number } | null
    resolved: boolean
    outcome: string | null
    estimatedPayout: number | null
    won: boolean
  }>
  activeRound: { roundId: number; up: { amount: number } | null; down: { amount: number } | null } | null
}

export interface HistoryData {
  ok: boolean
  address: string
  stats: {
    totalBets: number
    wins: number
    losses: number
    pending: number
    winRate: number
    totalVolumeUsd: number
    totalPnlUsd: number
    roi: number
    bestWin: number
    worstLoss: number
    avgBetSize: number
    currentStreak: { type: string; count: number }
  }
  bets: Array<{
    roundId: number
    side: string
    amountUsd: number
    outcome: string | null
    resolved: boolean
    pnl: number
    timestamp: number
    txId: string
  }>
  totalBetRecords: number
  page: number
  pageSize: number
}

export interface BetResult {
  txid: string
  roundId: number
  side: string
  amount: number
  estimatedPayout?: number
}

export interface TxResult {
  txid: string
}

export interface ResolutionResult {
  outcome: string
  priceStart: number
  priceEnd: number
  pnl: number
}
