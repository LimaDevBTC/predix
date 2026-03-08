/**
 * Next.js Instrumentation — runs once on server startup.
 *
 * Monitors round transitions and captures the BTC open price from Pyth
 * directly on the server. This guarantees ALL clients see the exact same
 * open price, with zero dependency on any client being online.
 *
 * Stores open price in Upstash Redis (via pool-store) so all Vercel
 * serverless instances share the same value.
 */

export async function register() {
  // Only run on the Node.js server runtime (not edge, not client)
  if (typeof window !== 'undefined') return

  const { setOpenPrice } = await import('@/lib/pool-store')

  const HERMES_URL = 'https://hermes.pyth.network'
  const PYTH_BTC_USD_FEED = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'

  // Start with previous round so we capture the CURRENT round's open price
  // immediately on startup (covers server restart / HMR reload scenarios).
  let lastRoundId = Math.floor(Date.now() / 60000) - 1

  // Check every second for round transitions
  setInterval(async () => {
    const currentRoundId = Math.floor(Date.now() / 60000)
    if (currentRoundId === lastRoundId) return

    lastRoundId = currentRoundId

    try {
      const url = `${HERMES_URL}/v2/updates/price/latest?ids[]=${PYTH_BTC_USD_FEED}&encoding=base64&parsed=true`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Pyth HTTP ${res.status}`)

      const data = await res.json()
      const priceData = data.parsed?.[0]?.price
      if (!priceData) throw new Error('No price data')

      const price = Number(priceData.price) * Math.pow(10, priceData.expo)
      if (!price || price <= 0) throw new Error(`Invalid price: ${price}`)

      const accepted = await setOpenPrice(currentRoundId, price)
      if (accepted) {
        console.log(`[OpenPrice] Round ${currentRoundId} open price set: $${price.toFixed(2)}`)
      }
    } catch (e) {
      console.error(`[OpenPrice] Failed to capture price for round ${currentRoundId}:`, e)
    }
  }, 1000)

  console.log('[Instrumentation] Open price monitor started')
}
