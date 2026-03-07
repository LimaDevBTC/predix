/**
 * Server-side pub/sub for real-time pool updates via SSE.
 *
 * When a client places a bet, the server broadcasts the updated pool
 * totals to ALL connected SSE clients, so every user sees the pool
 * change instantly — no polling delay.
 *
 * All listener Sets are stored on globalThis to survive Next.js HMR reloads.
 * Without this, hot reloads create new module-level Sets, breaking the bridge
 * between SSE connections (subscribed on the old Set) and POST handlers
 * (broadcasting on the new Set).
 */

export interface PoolUpdate {
  roundId: number
  side: 'UP' | 'DOWN'
  amountMicro: number
  totalUp: number   // cumulative optimistic total (micro-units)
  totalDown: number // cumulative optimistic total (micro-units)
  clientId?: string // originating client — receivers skip their own echo
  tradeId: string   // unique trade ID for deduplication
}

export interface OpenPriceUpdate {
  roundId: number
  price: number
}

type PoolUpdateCallback = (data: PoolUpdate) => void
type OpenPriceCallback = (data: OpenPriceUpdate) => void

const g = globalThis as unknown as {
  __poolListeners?: Set<PoolUpdateCallback>
  __openPriceListeners?: Set<OpenPriceCallback>
}
g.__poolListeners ??= new Set<PoolUpdateCallback>()
g.__openPriceListeners ??= new Set<OpenPriceCallback>()

const listeners = g.__poolListeners
const openPriceListeners = g.__openPriceListeners

export function subscribePoolUpdates(cb: PoolUpdateCallback): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function broadcastPoolUpdate(data: PoolUpdate) {
  for (const cb of listeners) {
    try { cb(data) } catch {}
  }
}

export function subscribeOpenPrice(cb: OpenPriceCallback): () => void {
  openPriceListeners.add(cb)
  return () => { openPriceListeners.delete(cb) }
}

export function broadcastOpenPrice(data: OpenPriceUpdate) {
  for (const cb of openPriceListeners) {
    try { cb(data) } catch {}
  }
}
