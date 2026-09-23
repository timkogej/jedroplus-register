import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const N8N_WEBHOOK = 'https://n8n.jedroplus.com/webhook/client-registration'

// The form is public by design (clients are not logged in), so the guards here
// are about abuse, not authentication:
//  - the company comes from the link (slug), never from the request body, so
//    nobody can write into another company by editing the payload
//  - a hidden field ("website") that only bots fill in
//  - a small per-IP rate limit
const RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 }
const hits = new Map<string, number[]>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs)
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 5000) {
    // keep the map from growing without bound on a long-lived instance
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_LIMIT.windowMs)) hits.delete(key)
    }
  }
  return recent.length > RATE_LIMIT.max
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for')
  return (fwd ? fwd.split(',')[0] : null)?.trim() || req.headers.get('x-real-ip') || 'unknown'
}

function str(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // Honeypot: real people never see this field.
  if (str(body.website)) {
    return NextResponse.json({ success: true }, { status: 200 })
  }

  if (rateLimited(clientIp(req))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
  }

  const slug = str(body.slug, 120)
  if (!slug) {
    return NextResponse.json({ error: 'missing_slug' }, { status: 400 })
  }

  const email = str(body.email)
  const ime = str(body.ime, 80)
  const priimek = str(body.priimek, 80)
  const telefon = str(body.telefon, 40)
  if (!ime || !priimek || !email || !telefon) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 })
  }
  if (body.gdpr !== true) {
    return NextResponse.json({ error: 'gdpr_required' }, { status: 400 })
  }

  // Company from the link, not from the payload.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { data: company } = await supabase
    .from('companies')
    .select('company_id')
    .eq('slug', slug)
    .single()

  if (!company?.company_id) {
    return NextResponse.json({ error: 'unknown_company' }, { status: 404 })
  }

  try {
    const res = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company_id: company.company_id,
        slug,
        ime,
        priimek,
        email,
        telefon,
        spol: str(body.spol, 30),
        opombe: str(body.opombe, 1000),
        gdpr: true,
        marketing_consent: body.marketing_consent === true,
      }),
    })

    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'upstream_error' }, { status: 502 })
  }
}
