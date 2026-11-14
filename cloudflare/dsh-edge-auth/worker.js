/**
 * dsh-edge-auth — Cloudflare Worker in front of https://dsh.aswf.dev/
 * (Cloudflare Tunnel → DSH web on 127.0.0.1:7800).
 *
 * Replaces DSH's per-process launch token with Cloudflare Access:
 *   - The request carries a valid Access JWT (`Cf-Access-Jwt-Assertion`, verified
 *     against the team's JWKS, issuer, this application's AUD, expiry, and the
 *     optional email allowlist) → forward it with DSH's long-lived session cookie
 *     injected, so the browser never sees a token.
 *   - Anything else → forward untouched, so DSH's own token/cookie auth still applies.
 *
 * Fails closed: until ACCESS_TEAM_DOMAIN, ACCESS_AUD, and DSH_COOKIE are all set,
 * nothing is injected. Deploying before Access exists therefore opens nothing.
 *
 * Why a Worker and not a Transform Rule: Request Header Transform Rules cannot
 * set or modify the `cookie` request header (only remove it).
 * https://developers.cloudflare.com/rules/transform/request-header-modification/
 *
 * Configuration (see wrangler.toml):
 *   ACCESS_TEAM_DOMAIN  e.g. yourteam.cloudflareaccess.com
 *   ACCESS_AUD          Application Audience (AUD) tag of the dsh.aswf.dev Access app
 *   ALLOWED_EMAILS      optional, comma/space separated; empty = any Access-approved identity
 *   DSH_COOKIE          secret: `dsh-auth-…=v1.…` from `./start.sh --mint-cookie`
 */

const JWKS_TTL_MS = 10 * 60 * 1000
let jwksCache = { url: '', at: 0, keys: [] }

export default {
  async fetch(request, env) {
    const identity = await verifyAccess(request, env).catch(() => null)
    if (!identity || !env.DSH_COOKIE) return fetch(request)

    // Replace the whole Cookie header: DSH only needs its own cookie, and a stale
    // browser-held dsh-auth cookie must not shadow the injected one.
    const headers = new Headers(request.headers)
    headers.set('Cookie', env.DSH_COOKIE)
    return fetch(new Request(request, { headers }))
  },
}

/**
 * Verify the Cloudflare Access JWT on this request.
 * @returns the JWT payload when every check passes, otherwise null.
 */
export async function verifyAccess(request, env) {
  const team = normalizeTeam(env.ACCESS_TEAM_DOMAIN)
  const aud = (env.ACCESS_AUD || '').trim()
  if (!team || !aud) return null

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!jwt) return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts

  const header = JSON.parse(b64urlText(h))
  const payload = JSON.parse(b64urlText(p))
  if (header.alg !== 'RS256' || !header.kid) return null

  let jwk = (await getKeys(team, false)).find(k => k.kid === header.kid)
  if (!jwk) jwk = (await getKeys(team, true)).find(k => k.kid === header.kid) // key rotation
  if (!jwk) return null

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const signed = new TextEncoder().encode(`${h}.${p}`)
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), signed))) return null

  const now = Date.now() / 1000
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!auds.includes(aud)) return null
  if (payload.iss !== `https://${team}`) return null
  if (typeof payload.exp !== 'number' || payload.exp < now) return null
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null

  const allowed = (env.ALLOWED_EMAILS || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(e => e.toLowerCase())
  if (allowed.length > 0 && !allowed.includes(String(payload.email || '').toLowerCase())) return null

  return payload
}

async function getKeys(team, force) {
  const url = `https://${team}/cdn-cgi/access/certs`
  if (!force && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys
  const res = await fetch(url)
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
  const { keys = [] } = await res.json()
  jwksCache = { url, at: Date.now(), keys }
  return keys
}

function normalizeTeam(value) {
  return (value || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

function b64urlBytes(s) {
  let b = s.replace(/-/g, '+').replace(/_/g, '/')
  b += '='.repeat((4 - (b.length % 4)) % 4)
  return Uint8Array.from(atob(b), c => c.charCodeAt(0))
}

function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s))
}
