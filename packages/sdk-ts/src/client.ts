/**
 * PredixClient — main entry point for the Predix SDK.
 */

import type {
  PredixClientConfig,
  MarketData,
  OpportunitiesData,
  PositionsData,
  HistoryData,
  BetResult,
  TxResult,
  ResolutionResult,
} from './types.js'
import { PredixError, TradingClosedError, RateLimitError, AuthenticationError } from './errors.js'
import { getPublicKey, getAddress, signTransaction, signMessage } from './signer.js'

const DEFAULT_BASE_URL = 'https://www.predix.live'

export class PredixClient {
  private apiKey: string
  private privateKey?: string
  private baseUrl: string
  private network: 'testnet' | 'mainnet'
  private _address?: string
  private _autoRegistered = false

  constructor(config: PredixClientConfig) {
    this.apiKey = config.apiKey || ''
    this.privateKey = config.privateKey
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL
    this.network = config.network || 'testnet'
  }

  /** Stacks address derived from the configured private key */
  get address(): string {
    if (!this._address) {
      if (!this.privateKey) throw new PredixError('privateKey required to derive address')
      this._address = getAddress(this.privateKey, this.network)
    }
    return this._address
  }

  // ---- Auto-registration ----

  /**
   * Auto-register: if no API key but private key is available,
   * sign a registration message and get a key automatically.
   */
  async register(name?: string): Promise<string> {
    const pk = this.requirePrivateKey()
    const timestamp = Math.floor(Date.now() / 1000)
    const message = `Predix Agent Registration ${timestamp}`
    const signature = signMessage(message, pk)

    const url = `${this.baseUrl}/api/agent/register`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: this.address, signature, message, name: name || 'SDK Agent' }),
    })
    const data = await res.json() as Record<string, unknown>
    if (!data.ok || !data.apiKey) throw new PredixError('Auto-registration failed: ' + (data.error || 'no key returned'))

    this.apiKey = data.apiKey as string
    return this.apiKey
  }

  private async ensureApiKey(): Promise<void> {
    if (this.apiKey) return
    if (!this.privateKey) throw new AuthenticationError('No apiKey or privateKey configured')
    if (this._autoRegistered) throw new AuthenticationError('Auto-registration already attempted — check your private key')
    this._autoRegistered = true
    await this.register()
  }

  // ---- HTTP ----

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    await this.ensureApiKey()

    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Predix-Key': this.apiKey,
      ...(options?.headers as Record<string, string> || {}),
    }

    const res = await fetch(url, { ...options, headers })
    const data = await res.json() as Record<string, unknown>

    if (res.status === 401) throw new AuthenticationError(data.error as string)
    if (res.status === 429) throw new RateLimitError()
    if (!res.ok || data.error) throw new PredixError((data.error as string) || `API error: ${res.status}`, res.status)

    return data as T
  }

  // ---- Read (no privateKey needed) ----

  async market(): Promise<MarketData> {
    return this.fetch<MarketData>('/api/agent/market')
  }

  async opportunities(): Promise<OpportunitiesData> {
    return this.fetch<OpportunitiesData>('/api/agent/opportunities')
  }

  async positions(): Promise<PositionsData> {
    return this.fetch<PositionsData>(`/api/agent/positions?address=${this.address}`)
  }

  async history(opts?: { page?: number; pageSize?: number }): Promise<HistoryData> {
    const page = opts?.page || 1
    const pageSize = opts?.pageSize || 20
    return this.fetch<HistoryData>(`/api/agent/history?address=${this.address}&page=${page}&pageSize=${pageSize}`)
  }

  // ---- Write (requires privateKey) ----

  private requirePrivateKey(): string {
    if (!this.privateKey) throw new PredixError('privateKey required for write operations')
    return this.privateKey
  }

  async bet(side: 'UP' | 'DOWN', amountUsd: number): Promise<BetResult> {
    const pk = this.requirePrivateKey()
    const publicKey = getPublicKey(pk)

    // Check market state
    const mkt = await this.market()
    if (!mkt.round.tradingOpen) throw new TradingClosedError()

    // Build unsigned tx
    const buildRes = await this.fetch<{ ok: boolean; txHex: string; details: Record<string, unknown> }>('/api/agent/build-tx', {
      method: 'POST',
      body: JSON.stringify({ action: 'place-bet', publicKey, params: { side, amount: amountUsd } }),
    })

    // Sign locally
    const signedHex = signTransaction(buildRes.txHex, pk)

    // Sponsor + broadcast
    const sponsorRes = await this.fetch<{ txid: string }>('/api/sponsor', {
      method: 'POST',
      body: JSON.stringify({ txHex: signedHex }),
    })

    return {
      txid: sponsorRes.txid,
      roundId: buildRes.details.roundId as number,
      side,
      amount: amountUsd,
      estimatedPayout: buildRes.details.estimatedPayout as number | undefined,
    }
  }

  async mint(): Promise<TxResult> {
    return this.executeAction('mint')
  }

  async approve(): Promise<TxResult> {
    return this.executeAction('approve')
  }

  private async executeAction(action: 'approve' | 'mint'): Promise<TxResult> {
    const pk = this.requirePrivateKey()
    const publicKey = getPublicKey(pk)

    const buildRes = await this.fetch<{ ok: boolean; txHex: string }>('/api/agent/build-tx', {
      method: 'POST',
      body: JSON.stringify({ action, publicKey, params: {} }),
    })

    const signedHex = signTransaction(buildRes.txHex, pk)

    const sponsorRes = await this.fetch<{ txid: string }>('/api/sponsor', {
      method: 'POST',
      body: JSON.stringify({ txHex: signedHex }),
    })

    return { txid: sponsorRes.txid }
  }

  // ---- Utilities ----

  /**
   * Poll positions until a specific round is resolved or timeout.
   */
  async waitForResolution(
    roundId: number,
    opts?: { timeout?: number; pollInterval?: number },
  ): Promise<ResolutionResult> {
    const timeout = opts?.timeout || 90_000
    const pollInterval = opts?.pollInterval || 2000
    const start = Date.now()

    while (Date.now() - start < timeout) {
      const pos = await this.positions()
      const round = pos.pendingRounds.find(r => r.roundId === roundId)
      if (round?.resolved && round.outcome) {
        // Calculate P&L
        const betAmount = (round.up?.amount || 0) + (round.down?.amount || 0)
        const pnl = round.won ? (round.estimatedPayout || 0) - betAmount : -betAmount
        return {
          outcome: round.outcome,
          priceStart: 0, // Not available from positions endpoint
          priceEnd: 0,
          pnl,
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    throw new PredixError('Timeout waiting for round resolution')
  }

  /**
   * Async iterator that yields market state at the specified interval.
   */
  async *stream(opts?: { interval?: number }): AsyncGenerator<MarketData> {
    const interval = opts?.interval || 2000
    while (true) {
      yield await this.market()
      await new Promise(resolve => setTimeout(resolve, interval))
    }
  }
}
