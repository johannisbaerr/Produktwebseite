import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_USERNAME, ensureDefaultAdmin } from './admin.ts'

const app = express()
const port = Number(process.env.PORT || 3001)
const supabaseUrl = process.env.SUPABASE_URL || 'https://kwuqirvctvhzkepssnee.supabase.co'
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || 'product-images'
if (!supabaseServiceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY fehlt. Hinterlege den geheimen Supabase Service Role Key als Umgebungsvariable.')
const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } })

const initializeDefaultAdmin = async () => {
  try {
    await ensureDefaultAdmin(supabase, {
      username: DEFAULT_ADMIN_USERNAME,
      password: DEFAULT_ADMIN_PASSWORD,
      passwordHash: process.env.ADMIN_PASSWORD_HASH,
    })
    console.log('Default admin ensured successfully.')
  } catch (error) {
    console.error('Default admin setup failed:', error)
  }
}

const startServer = async () => {
  await initializeDefaultAdmin()
  app.listen(port, '0.0.0.0', () => console.log(`Product API running on http://0.0.0.0:${port}`))
}

app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
})

type ImageRow = { id: number; filename: string; original_name: string; sort_order: number }
type ProductRow = { id: number; name: string; description: string; price_cents: number; stock: number; status: 'active' | 'unlisted'; created_at: string; updated_at: string; product_images?: ImageRow[] }
type SessionRow = { admin_id: number; expires_at: string }
const productSelect = 'id,name,description,price_cents,stock,status,created_at,updated_at,product_images(id,filename,original_name,sort_order)'
const imagePayload = (image: ImageRow) => ({ id: image.id, url: supabase.storage.from(storageBucket).getPublicUrl(image.filename).data.publicUrl, originalName: image.original_name })
const productPayload = (row: ProductRow) => ({ id: row.id, name: row.name, description: row.description || '', priceCents: row.price_cents, stock: row.stock, status: row.stock > 0 && row.status === 'active' ? 'active' : 'unlisted', createdAt: row.created_at, updatedAt: row.updated_at, images: (row.product_images || []).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(imagePayload) })

const auth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const token = req.cookies.admin_session
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet' })
  const { data: session } = await supabase.from('sessions').select('admin_id,expires_at').eq('token', token).gt('expires_at', new Date().toISOString()).maybeSingle<SessionRow>()
  if (!session) return res.status(401).json({ error: 'Nicht angemeldet' })
  next()
}

app.get('/api/products', async (_req, res) => {
  const { data, error } = await supabase.from('products').select(productSelect).eq('status', 'active').gt('stock', 0).order('updated_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'Produkte konnten nicht geladen werden.' })
  res.json((data as ProductRow[]).map(productPayload))
})

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const { data: admin, error: adminError } = await supabase.from('admins').select('id,password_hash').eq('username', username).maybeSingle<{ id: number; password_hash: string }>()
  if (adminError) {
    console.error('Admin lookup failed:', adminError.message)
    return res.status(500).json({ error: 'Anmeldung ist momentan nicht verfügbar.' })
  }
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) return res.status(401).json({ error: 'Benutzername oder Passwort ist falsch' })
  const token = crypto.randomBytes(32).toString('hex')
  const { error } = await supabase.from('sessions').insert({ token, admin_id: admin.id, expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() })
  if (error) return res.status(500).json({ error: 'Anmeldung konnte nicht gestartet werden.' })
  res.cookie('admin_session', token, { httpOnly: true, sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 })
  res.json({ username })
})
app.post('/api/auth/logout', async (req, res) => { if (req.cookies.admin_session) await supabase.from('sessions').delete().eq('token', req.cookies.admin_session); res.clearCookie('admin_session').json({ ok: true }) })
app.get('/api/auth/me', auth, (_req, res) => res.json({ username: 'admin' }))

app.get('/api/admin/products', auth, async (req, res) => {
  const search = String(req.query.search || '').trim()
  let query = supabase.from('products').select(productSelect).order('updated_at', { ascending: false })
  if (search) query = query.ilike('name', `%${search}%`)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: 'Produkte konnten nicht geladen werden.' })
  res.json((data as ProductRow[]).map(productPayload))
})

const validateProduct = (body: Record<string, unknown>) => {
  const name = String(body.name || '').trim()
  const description = String(body.description || '').trim()
  const priceCents = Number(body.priceCents)
  const stock = Number(body.stock)
  const status = body.status === 'active' ? 'active' : 'unlisted'
  if (!name || name.length > 160) return 'Bitte einen gültigen Produktnamen eingeben.'
  if (description.length > 5000) return 'Die Beschreibung darf höchstens 5000 Zeichen enthalten.'
  if (!Number.isInteger(priceCents) || priceCents < 0) return 'Der Preis muss ein gültiger Betrag sein.'
  if (!Number.isInteger(stock) || stock < 0) return 'Der Lagerbestand muss eine ganze Zahl ab 0 sein.'
  return { name, description, priceCents, stock, status }
}

const uploadImages = async (productId: number, files: Express.Multer.File[], startOrder = 0) => {
  const rows: { product_id: number; filename: string; original_name: string; sort_order: number }[] = []
  for (const [index, file] of files.entries()) {
    const filename = `${productId}/${crypto.randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { error: uploadError } = await supabase.storage.from(storageBucket).upload(filename, file.buffer, { contentType: file.mimetype, upsert: false })
    if (uploadError) throw uploadError
    rows.push({ product_id: productId, filename, original_name: file.originalname, sort_order: startOrder + index })
  }
  if (rows.length) { const { error } = await supabase.from('product_images').insert(rows); if (error) throw error }
}

app.post('/api/admin/products', auth, upload.array('images', 8), async (req, res) => {
  const data = validateProduct(req.body)
  if (typeof data === 'string') return res.status(400).json({ error: data })
  const files = (req.files as Express.Multer.File[]) || []
  if (!files.length) return res.status(400).json({ error: 'Mindestens ein Produktbild ist erforderlich.' })
  const { data: product, error } = await supabase.from('products').insert({ name: data.name, description: data.description, price_cents: data.priceCents, stock: data.stock, status: data.status }).select('id').single<{ id: number }>()
  if (error || !product) return res.status(500).json({ error: 'Produkt konnte nicht gespeichert werden.' })
  try { await uploadImages(product.id, files) } catch { await supabase.from('products').delete().eq('id', product.id); return res.status(500).json({ error: 'Produktbilder konnten nicht gespeichert werden.' }) }
  res.status(201).json({ ok: true })
})

app.patch('/api/admin/products/:id', auth, upload.array('images', 8), async (req, res) => {
  const id = Number(req.params.id)
  const data = validateProduct(req.body)
  if (typeof data === 'string') return res.status(400).json({ error: data })
  const { data: current } = await supabase.from('products').select('id').eq('id', id).maybeSingle()
  if (!current) return res.status(404).json({ error: 'Produkt nicht gefunden.' })
  const { error } = await supabase.from('products').update({ name: data.name, description: data.description, price_cents: data.priceCents, stock: data.stock, status: data.status, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) return res.status(500).json({ error: 'Produkt konnte nicht gespeichert werden.' })
  const files = (req.files as Express.Multer.File[]) || []
  if (files.length) { const { data: last } = await supabase.from('product_images').select('sort_order').eq('product_id', id).order('sort_order', { ascending: false }).limit(1).maybeSingle<{ sort_order: number }>(); try { await uploadImages(id, files, (last?.sort_order ?? -1) + 1) } catch { return res.status(500).json({ error: 'Neue Produktbilder konnten nicht gespeichert werden.' }) } }
  res.json({ ok: true })
})

app.delete('/api/admin/products/:id/images/:imageId', auth, async (req, res) => {
  const id = Number(req.params.id)
  const imageId = Number(req.params.imageId)
  const { data: image } = await supabase.from('product_images').select('filename').eq('id', imageId).eq('product_id', id).maybeSingle<{ filename: string }>()
  if (!image) return res.status(404).json({ error: 'Bild nicht gefunden.' })
  await supabase.storage.from(storageBucket).remove([image.filename])
  await supabase.from('product_images').delete().eq('id', imageId)
  res.json({ ok: true })
})

app.delete('/api/admin/products/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  const { data: images } = await supabase.from('product_images').select('filename').eq('product_id', id)
  if (images?.length) await supabase.storage.from(storageBucket).remove(images.map((image) => image.filename))
  const { error } = await supabase.from('products').delete().eq('id', id)
  if (error) return res.status(500).json({ error: 'Produkt konnte nicht gelöscht werden.' })
  res.json({ ok: true })
})

void startServer()
