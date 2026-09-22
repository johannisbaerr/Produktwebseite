import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'
import multer from 'multer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const app = express()
const port = Number(process.env.PORT || 3001)
const root = process.cwd()
const dataDir = path.join(root, 'data')
const uploadDir = path.join(dataDir, 'uploads')
fs.mkdirSync(uploadDir, { recursive: true })

const db = new Database(path.join(dataDir, 'catalog.sqlite'))
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, admin_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL, price_cents INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'unlisted', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS product_images (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, filename TEXT NOT NULL, original_name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
`)

const existingAdmin = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin')
if (!existingAdmin) {
  const initialPasswordHash = process.env.ADMIN_PASSWORD_HASH || '$2b$12$qXEm3m4ye.HSA9upOQN.A.5JqeE/JxPga8QO9Cy74Gkj2wj/EITBK'
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('admin', initialPasswordHash)
}

app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use('/uploads', express.static(uploadDir, { maxAge: '1d' }))

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
})

type ProductRow = { id: number; name: string; description: string; price_cents: number; stock: number; status: 'active' | 'unlisted'; created_at: string; updated_at: string }
const productPayload = (row: ProductRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  priceCents: row.price_cents,
  stock: row.stock,
  status: row.stock > 0 && row.status === 'active' ? 'active' : 'unlisted',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  images: db.prepare('SELECT id, \'/uploads/\' || filename AS url, original_name AS originalName FROM product_images WHERE product_id = ? ORDER BY sort_order, id').all(row.id),
})

const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const token = req.cookies.admin_session
  const session = token && db.prepare('SELECT admin_id FROM sessions WHERE token = ? AND expires_at > ?').get(token, Date.now())
  if (!session) return res.status(401).json({ error: 'Nicht angemeldet' })
  next()
}

app.get('/api/products', (_req, res) => {
  const rows = db.prepare("SELECT * FROM products WHERE status = 'active' AND stock > 0 ORDER BY updated_at DESC").all() as ProductRow[]
  res.json(rows.map(productPayload))
})

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as { id: number; password_hash: string } | undefined
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) return res.status(401).json({ error: 'Benutzername oder Passwort ist falsch' })
  const token = crypto.randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(token, admin.id, Date.now() + 8 * 60 * 60 * 1000)
  res.cookie('admin_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 })
  res.json({ username })
})

app.post('/api/auth/logout', (req, res) => {
  if (req.cookies.admin_session) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.admin_session)
  res.clearCookie('admin_session').json({ ok: true })
})

app.get('/api/auth/me', auth, (_req, res) => res.json({ username: 'admin' }))

app.get('/api/admin/products', auth, (req, res) => {
  const search = String(req.query.search || '').trim()
  const rows = (search ? db.prepare('SELECT * FROM products WHERE name LIKE ? ORDER BY updated_at DESC').all(`%${search}%`) : db.prepare('SELECT * FROM products ORDER BY updated_at DESC').all()) as ProductRow[]
  res.json(rows.map(productPayload))
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

app.post('/api/admin/products', auth, upload.array('images', 8), (req, res) => {
  const data = validateProduct(req.body)
  if (typeof data === 'string') return res.status(400).json({ error: data })
  const files = (req.files as Express.Multer.File[]) || []
  if (!files.length) return res.status(400).json({ error: 'Mindestens ein Produktbild ist erforderlich.' })
  const now = new Date().toISOString()
  const result = db.prepare('INSERT INTO products (name, description, price_cents, stock, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(data.name, data.description, data.priceCents, data.stock, data.status, now, now)
  const insertImage = db.prepare('INSERT INTO product_images (product_id, filename, original_name, sort_order) VALUES (?, ?, ?, ?)')
  files.forEach((file, index) => insertImage.run(result.lastInsertRowid, file.filename, file.originalname, index))
  res.status(201).json({ ok: true })
})

app.patch('/api/admin/products/:id', auth, upload.array('images', 8), (req, res) => {
  const id = Number(req.params.id)
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined
  if (!current) return res.status(404).json({ error: 'Produkt nicht gefunden.' })
  const data = validateProduct(req.body)
  if (typeof data === 'string') return res.status(400).json({ error: data })
  const now = new Date().toISOString()
  db.prepare('UPDATE products SET name = ?, description = ?, price_cents = ?, stock = ?, status = ?, updated_at = ? WHERE id = ?').run(data.name, data.description, data.priceCents, data.stock, data.status, now, id)
  const files = (req.files as Express.Multer.File[]) || []
  const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) as value FROM product_images WHERE product_id = ?').get(id) as { value: number }).value
  const insertImage = db.prepare('INSERT INTO product_images (product_id, filename, original_name, sort_order) VALUES (?, ?, ?, ?)')
  files.forEach((file, index) => insertImage.run(id, file.filename, file.originalname, maxOrder + index + 1))
  res.json({ ok: true })
})

app.delete('/api/admin/products/:id/images/:imageId', auth, (req, res) => {
  const image = db.prepare('SELECT filename FROM product_images WHERE id = ? AND product_id = ?').get(Number(req.params.imageId), Number(req.params.id)) as { filename: string } | undefined
  if (!image) return res.status(404).json({ error: 'Bild nicht gefunden.' })
  db.prepare('DELETE FROM product_images WHERE id = ?').run(Number(req.params.imageId))
  fs.rmSync(path.join(uploadDir, image.filename), { force: true })
  res.json({ ok: true })
})

app.delete('/api/admin/products/:id', auth, (req, res) => {
  const id = Number(req.params.id)
  const images = db.prepare('SELECT filename FROM product_images WHERE product_id = ?').all(id) as { filename: string }[]
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM product_images WHERE product_id = ?').run(id)
    db.prepare('DELETE FROM products WHERE id = ?').run(id)
  })
  transaction()
  images.forEach((image) => fs.rmSync(path.join(uploadDir, image.filename), { force: true }))
  res.json({ ok: true })
})

app.listen(port, '0.0.0.0', () => console.log(`Product API running on http://0.0.0.0:${port}`))