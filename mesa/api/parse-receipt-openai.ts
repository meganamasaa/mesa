// api/parse-receipt-openai.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import formidable from 'formidable'
import fs from 'node:fs'

// Required for multipart/form-data
export const config = { api: { bodyParser: false } }

// Parse a single "file" field from multipart/form-data into /tmp
async function parseForm(req: VercelRequest): Promise<{ filepath: string, mimetype: string, originalFilename?: string, size: number }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      uploadDir: '/tmp',
      keepExtensions: true,
      filter: p => p.mimetype?.startsWith('image/') ?? false,
    })
    form.parse(req as any, (err, _fields, files) => {
      if (err) return reject(err)
      const f = files?.file as formidable.File | undefined
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Use POST with multipart/form-data (field name: file)' })
    }

    const { filepath, mimetype, originalFilename, size } = await parseForm(req)

    // Sanity check: ensure the file is readable
    const exists = fs.existsSync(filepath)
    if (!exists) return res.status(500).json({ error: 'Upload failed (no tmp file)' })

    // For now we just echo back metadata. Next step we’ll call OpenAI.
    return res.status(200).json({
      ok: true,
      message: 'Upload received',
      file: {
        originalFilename: originalFilename ?? 'unknown',
        mimetype,
        sizeBytes: size,
        tmpPath: filepath, // lives only during the request lifecycle on Vercel
      },
    })
  } catch (e: any) {
    console.error(e)
    return res.status(500).json({ error: e?.message ?? 'Unexpected error' })
  }
}
