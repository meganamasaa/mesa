// api/parse-receipt-openai.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import formidable from 'formidable'
import fs from 'node:fs'
import OpenAI from 'openai'

export const config = { api: { bodyParser: false } }

const MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const MODEL = 'gpt-4o-mini'

type ParsedFile = {
  filepath: string
  mimetype: string
  originalFilename?: string
  size: number
}

async function parseForm(req: VercelRequest): Promise<ParsedFile> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      uploadDir: '/tmp',
      keepExtensions: true,
      maxFileSize: MAX_BYTES,
      filter: p => p.mimetype?.startsWith('image/') ?? false,
    })
    form.parse(req as any, (err, _fields, files) => {
      if (err) return reject(err)
      const raw = files?.file
      const f = (Array.isArray(raw) ? raw[0] : raw) as formidable.File | undefined
      if (!f?.filepath || !f.mimetype) return reject(new Error('No image uploaded as "file".'))
      resolve({
        filepath: f.filepath,
        mimetype: f.mimetype,
        originalFilename: (f as any).originalFilename,
        size: f.size ?? fs.statSync(f.filepath).size,
      })
    })
  })
}

const RECEIPT_SCHEMA = {
  name: 'receipt_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            unit_price: { type: 'number' },
            quantity: { type: 'integer' },
          },
          required: ['name', 'unit_price', 'quantity'],
        },
      },
      detected_tax: { type: ['number', 'null'] },
      detected_tip: { type: ['number', 'null'] },
      detected_currency: {
        type: ['string', 'null'],
        enum: ['EUR', 'USD', 'GBP', 'MXN', null],
      },
    },
    required: ['items', 'detected_tax', 'detected_tip', 'detected_currency'],
  },
} as const

const SYSTEM_PROMPT = `You extract line items from a photo of a restaurant receipt.

Rules:
- Return one entry per line item (food or drink). Ignore subtotal, tax, tip, service, gratuity, and total rows.
- "unit_price" is the price of a single unit, not the line total. If the receipt only shows a line total, divide by the quantity.
- "quantity" is the number ordered. Default to 1 if not shown. Lines like "2x Pizza 20.00" mean quantity=2, unit_price=10.00.
- "name" should be the human-readable dish/drink name as printed, trimmed.
- If the receipt shows tax or tip as an explicit line, return its numeric amount in detected_tax / detected_tip. Otherwise return null.
- detected_currency: return the ISO code only if you are confident (visible currency symbol or code). Otherwise null.
- If you cannot read the receipt, return an empty items array rather than guessing.`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let tmpPath: string | undefined

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Use POST with multipart/form-data (field name: file)' })
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured on the server' })
    }

    const { filepath, mimetype, size } = await parseForm(req)
    tmpPath = filepath

    if (!fs.existsSync(filepath)) {
      return res.status(500).json({ error: 'Upload failed (no tmp file)' })
    }
    if (size > MAX_BYTES) {
      return res.status(413).json({ error: `Image too large (${size} bytes); max ${MAX_BYTES}` })
    }

    const buf = fs.readFileSync(filepath)
    const dataUrl = `data:${mimetype};base64,${buf.toString('base64')}`

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the line items from this receipt.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: RECEIPT_SCHEMA },
      temperature: 0,
    })

    const raw = completion.choices[0]?.message?.content
    if (!raw) return res.status(502).json({ error: 'Empty response from model' })

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      return res.status(502).json({ error: 'Model returned invalid JSON' })
    }

    const items = Array.isArray(parsed.items) ? parsed.items : []
    const cleanItems = items
      .map((it: any) => ({
        name: typeof it?.name === 'string' ? it.name.trim() : '',
        price: Number(it?.unit_price),
        quantity: Math.max(1, Math.floor(Number(it?.quantity) || 1)),
      }))
      .filter((it: any) => it.name && Number.isFinite(it.price) && it.price >= 0)

    return res.status(200).json({
      ok: true,
      items: cleanItems,
      detected_tax: numOrNull(parsed.detected_tax),
      detected_tip: numOrNull(parsed.detected_tip),
      detected_currency:
        typeof parsed.detected_currency === 'string' &&
        ['EUR', 'USD', 'GBP', 'MXN'].includes(parsed.detected_currency)
          ? parsed.detected_currency
          : null,
      dropped: items.length - cleanItems.length,
    })
  } catch (e: any) {
    console.error(e)
    const msg = e?.message ?? 'Unexpected error'
    const status = /maxFileSize/i.test(msg) ? 413 : 500
    return res.status(status).json({ error: msg })
  } finally {
    if (tmpPath) {
      fs.promises.unlink(tmpPath).catch(() => {})
    }
  }
}

function numOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}
