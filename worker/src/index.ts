// Cloudflare Worker — CORS proxy for WSDOT API
// Only proxies requests to wsdot.wa.gov and images.wsdot.wa.gov

const ALLOWED_ORIGINS = new Set([
  'https://wsdot.wa.gov',
  'https://images.wsdot.wa.gov',
])

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
  async fetch(request: Request): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // Only allow GET
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS })
    }

    // Extract the target URL from the path: /proxy?url=<encoded-url>
    const { searchParams } = new URL(request.url)
    const targetURL = searchParams.get('url')

    if (!targetURL) {
      return new Response('Missing ?url= parameter', { status: 400, headers: CORS_HEADERS })
    }

    // Validate the target is an allowed origin
    let parsed: URL
    try {
      parsed = new URL(targetURL)
    } catch {
      return new Response('Invalid URL', { status: 400, headers: CORS_HEADERS })
    }

    if (!ALLOWED_ORIGINS.has(parsed.origin)) {
      return new Response(`Origin not allowed: ${parsed.origin}`, { status: 403, headers: CORS_HEADERS })
    }

    // Forward the request to WSDOT
    const upstream = await fetch(targetURL, {
      headers: {
        'User-Agent': 'RoadView/1.0',
      },
    })

    // Clone the response and add CORS headers
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    })

    // Add CORS headers (overwrites if present)
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      response.headers.set(key, value)
    }

    return response
  },
}
