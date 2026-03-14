#!/usr/bin/env node
/**
 * Benchmark Hiro API — tests rate limits, latency, and throughput
 * with and without API key.
 *
 * Usage:
 *   node scripts/hiro-benchmark.mjs
 */

const HIRO_API = 'https://api.testnet.hiro.so'
const API_KEY = process.env.HIRO_API_KEY || ''

const CONTRACT_ADDRESS = 'ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK'
const CONTRACT_NAME = 'predixv2'
const ADDRESS = CONTRACT_ADDRESS

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json', ...extra }
  if (API_KEY) h['x-api-key'] = API_KEY
  return h
}

// ---------------------------------------------------------------------------
// Test endpoints (mix of what Predix uses)
// ---------------------------------------------------------------------------

const endpoints = [
  {
    name: 'GET /v2/info',
    fn: () => fetch(`${HIRO_API}/v2/info`, { headers: headers() }),
  },
  {
    name: 'GET nonces',
    fn: () => fetch(`${HIRO_API}/extended/v1/address/${ADDRESS}/nonces`, { headers: headers() }),
  },
  {
    name: 'POST map_entry (rounds)',
    fn: () => {
      // Read round map for a recent round
      const roundId = Math.floor(Date.now() / 60000) - 1
      return fetch(`${HIRO_API}/v2/map_entry/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/rounds?proof=0`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(`0x0c00000001${Buffer.from('round-id').toString('hex')}0100000000000000000000000001c39503`),
      })
    },
  },
  {
    name: 'POST call-read (get-jackpot-balance)',
    fn: () => fetch(`${HIRO_API}/v2/contracts/call-read/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/get-jackpot-balance`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ sender: CONTRACT_ADDRESS, arguments: [] }),
    }),
  },
]

// ---------------------------------------------------------------------------
// Benchmark: sequential latency
// ---------------------------------------------------------------------------

async function benchLatency(endpoint, count = 10) {
  const times = []
  let errors = 0
  let status429 = 0

  for (let i = 0; i < count; i++) {
    const start = performance.now()
    try {
      const res = await endpoint.fn()
      times.push(performance.now() - start)
      if (res.status === 429) status429++
      if (!res.ok && res.status !== 429) errors++
    } catch (e) {
      times.push(performance.now() - start)
      errors++
    }
  }

  const sorted = times.sort((a, b) => a - b)
  return {
    name: endpoint.name,
    count,
    errors,
    status429,
    min: sorted[0],
    p50: sorted[Math.floor(count * 0.5)],
    p95: sorted[Math.floor(count * 0.95)],
    max: sorted[sorted.length - 1],
    avg: times.reduce((a, b) => a + b, 0) / times.length,
  }
}

// ---------------------------------------------------------------------------
// Benchmark: burst throughput (parallel requests)
// ---------------------------------------------------------------------------

async function benchBurst(endpoint, concurrency) {
  const start = performance.now()
  let ok = 0
  let status429 = 0
  let errors = 0

  const promises = Array.from({ length: concurrency }, async () => {
    try {
      const res = await endpoint.fn()
      if (res.status === 429) status429++
      else if (res.ok) ok++
      else errors++
    } catch {
      errors++
    }
  })

  await Promise.all(promises)
  const elapsed = performance.now() - start

  return { concurrency, ok, status429, errors, elapsed }
}

// ---------------------------------------------------------------------------
// Benchmark: sustained throughput (requests per second)
// ---------------------------------------------------------------------------

async function benchSustained(endpoint, durationMs = 5000, concurrency = 5) {
  const start = performance.now()
  let total = 0
  let ok = 0
  let status429 = 0
  let errors = 0
  let running = true

  setTimeout(() => { running = false }, durationMs)

  const worker = async () => {
    while (running) {
      try {
        const res = await endpoint.fn()
        total++
        if (res.status === 429) status429++
        else if (res.ok) ok++
        else errors++
      } catch {
        total++
        errors++
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  const elapsed = performance.now() - start

  return {
    total,
    ok,
    status429,
    errors,
    elapsed,
    rps: (total / elapsed) * 1000,
    effectiveRps: (ok / elapsed) * 1000,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70))
  console.log('HIRO API BENCHMARK')
  console.log('='.repeat(70))
  console.log(`API Key: ${API_KEY ? API_KEY.slice(0, 8) + '...' : 'NONE'}`)
  console.log(`Endpoint: ${HIRO_API}`)
  console.log(`Time: ${new Date().toISOString()}`)
  console.log()

  // 1. Sequential latency
  console.log('-'.repeat(70))
  console.log('1. SEQUENTIAL LATENCY (10 requests each)')
  console.log('-'.repeat(70))
  for (const ep of endpoints) {
    const r = await benchLatency(ep, 10)
    console.log(`  ${r.name}`)
    console.log(`    avg=${r.avg.toFixed(0)}ms  p50=${r.p50.toFixed(0)}ms  p95=${r.p95.toFixed(0)}ms  min=${r.min.toFixed(0)}ms  max=${r.max.toFixed(0)}ms  429s=${r.status429}  errors=${r.errors}`)
  }

  // 2. Burst test — increasing concurrency
  console.log()
  console.log('-'.repeat(70))
  console.log('2. BURST TEST (parallel requests, GET /v2/info)')
  console.log('-'.repeat(70))
  const burstEndpoint = endpoints[0]
  for (const n of [5, 10, 20, 50, 100]) {
    const r = await benchBurst(burstEndpoint, n)
    console.log(`  ${n} parallel: ${r.ok} ok, ${r.status429} 429s, ${r.errors} errors in ${r.elapsed.toFixed(0)}ms`)
    // Small gap between burst tests
    await new Promise(r => setTimeout(r, 1000))
  }

  // 3. Sustained throughput
  console.log()
  console.log('-'.repeat(70))
  console.log('3. SUSTAINED THROUGHPUT (5s, 5 workers, GET nonces)')
  console.log('-'.repeat(70))
  const sustEndpoint = endpoints[1]
  const s = await benchSustained(sustEndpoint, 5000, 5)
  console.log(`  Total: ${s.total} requests in ${(s.elapsed / 1000).toFixed(1)}s`)
  console.log(`  RPS: ${s.rps.toFixed(1)} total, ${s.effectiveRps.toFixed(1)} effective (excl. 429s)`)
  console.log(`  429s: ${s.status429} (${((s.status429 / s.total) * 100).toFixed(1)}%)`)
  console.log(`  Errors: ${s.errors}`)

  // 4. Sustained with higher concurrency
  console.log()
  console.log('-'.repeat(70))
  console.log('4. SUSTAINED THROUGHPUT (5s, 10 workers, POST map_entry)')
  console.log('-'.repeat(70))
  await new Promise(r => setTimeout(r, 2000)) // cool down
  const s2 = await benchSustained(endpoints[2], 5000, 10)
  console.log(`  Total: ${s2.total} requests in ${(s2.elapsed / 1000).toFixed(1)}s`)
  console.log(`  RPS: ${s2.rps.toFixed(1)} total, ${s2.effectiveRps.toFixed(1)} effective`)
  console.log(`  429s: ${s2.status429} (${((s2.status429 / s2.total) * 100).toFixed(1)}%)`)
  console.log(`  Errors: ${s2.errors}`)

  // 5. Rate limit header check
  console.log()
  console.log('-'.repeat(70))
  console.log('5. RATE LIMIT HEADERS')
  console.log('-'.repeat(70))
  try {
    const res = await fetch(`${HIRO_API}/v2/info`, { headers: headers() })
    const relevant = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
      'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'ratelimit-policy',
      'retry-after', 'x-ratelimit-policy']
    for (const [key, value] of res.headers.entries()) {
      if (relevant.some(r => key.toLowerCase().includes(r.replace('x-', '')) || key.toLowerCase().includes('rate'))) {
        console.log(`  ${key}: ${value}`)
      }
    }
    // Also check all headers for anything rate-related
    let found = false
    for (const [key, value] of res.headers.entries()) {
      if (key.toLowerCase().includes('limit') || key.toLowerCase().includes('rate') || key.toLowerCase().includes('quota')) {
        if (!found) found = true
        console.log(`  ${key}: ${value}`)
      }
    }
    if (!found) console.log('  (no rate limit headers found in response)')
  } catch (e) {
    console.log(`  Error: ${e.message}`)
  }

  console.log()
  console.log('='.repeat(70))
  console.log('DONE')
  console.log('='.repeat(70))
}

main().catch(e => { console.error(e); process.exit(1) })
