/** Centralized Hiro API config — URL + authenticated headers */

export const HIRO_API = 'https://api.testnet.hiro.so'

const API_KEY = process.env.HIRO_API_KEY

export function hiroHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  }
  if (API_KEY) {
    headers['x-api-key'] = API_KEY
  }
  return headers
}

/** Convenience fetch wrapper that injects the API key */
export async function hiroFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${HIRO_API}${path}`
  return fetch(url, {
    ...init,
    headers: {
      ...hiroHeaders(),
      ...(init?.headers as Record<string, string>),
    },
  })
}
