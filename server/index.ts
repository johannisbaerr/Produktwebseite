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
type ProductRow = { id: number; name: string; description: string; price_cents: number; stock: number; status: 'active' | 'unlisted'; search_terms?: string[]; created_at: string; updated_at: string; product_images?: ImageRow[]; product_categories?: { category_id: string }[] }
type SessionRow = { admin_id: number; expires_at: string }
const productSelect = 'id,name,description,price_cents,stock,status,search_terms,created_at,updated_at,product_images(id,filename,original_name,sort_order),product_categories(category_id)'
const imagePayload = (image: ImageRow) => ({ id: image.id, url: supabase.storage.from(storageBucket).getPublicUrl(image.filename).data.publicUrl, originalName: image.original_name })
const productPayload = (row: ProductRow) => ({ id: row.id, name: row.name, description: row.description || '', priceCents: row.price_cents, stock: row.stock, status: row.stock > 0 && row.status === 'active' ? 'active' : 'unlisted', searchTerms: row.search_terms || [], categoryIds: (row.product_categories || []).map(({ category_id }) => category_id), createdAt: row.created_at, updatedAt: row.updated_at, images: (row.product_images || []).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(imagePayload) })

const categoryDesigns = ['Kachel', 'Panorama', 'Kompakt'] as const
const categoryPayload = (row: { id: string; name: string; sort_order: number; design: string; preview_mode: 'products' | 'upload'; preview_image: string | null }, productIds: string[]) => ({
  id: row.id,
  name: row.name,
  sortOrder: row.sort_order,
  design: row.design,
  previewMode: row.preview_mode,
  previewImageUrl: row.preview_image ? supabase.storage.from(storageBucket).getPublicUrl(row.preview_image).data.publicUrl : null,
  productIds,
})

const auth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const token = req.cookies.admin_session
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet' })
  const { data: session, error } = await supabase.from('sessions').select('admin_id,expires_at').eq('token', token).gt('expires_at', new Date().toISOString()).maybeSingle<SessionRow>()
  if (error) {
    console.error('Admin session lookup failed:', error.message)
    return res.status(500).json({ error: 'Anmeldung ist momentan nicht verfügbar.' })
  }
  if (!session) return res.status(401).json({ error: 'Nicht angemeldet' })
  next()
}

app.get('/api/categories', async (_req, res) => {
  const { data: categories, error } = await supabase.from('categories').select('id,name,sort_order,design,preview_mode,preview_image').order('sort_order', { ascending: true })
  if (error) return res.status(500).json({ error: 'Kategorien konnten nicht geladen werden.' })
  const { data: memberships, error: membershipError } = await supabase.from('product_categories').select('category_id,product_id')
  if (membershipError) return res.status(500).json({ error: 'Kategoriezuordnungen konnten nicht geladen werden.' })
  res.json((categories || []).map((category) => categoryPayload(
    category,
    (memberships || []).filter((membership) => membership.category_id === category.id).map((membership) => membership.product_id),
  )))
})

app.get('/api/products', async (_req, res) => {
  const { data, error } = await supabase.from('products').select(productSelect).eq('status', 'active').gt('stock', 0).order('updated_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'Produkte konnten nicht geladen werden.' })
  res.json((data as ProductRow[]).map(productPayload))
})

app.post('/api/orders', async (req, res) => {
  const items = req.body?.items
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) return res.status(400).json({ error: 'Der Warenkorb ist leer oder ungültig.' })
  const requested = new Map<number, number>()
  for (const item of items) {
    if (!Number.isSafeInteger(item?.productId) || item.productId < 1 || !Number.isInteger(item?.quantity) || item.quantity < 1 || item.quantity > 99) {
      return res.status(400).json({ error: 'Ungültige Artikel im Warenkorb.' })
    }
    const quantity = (requested.get(item.productId) || 0) + item.quantity
    if (quantity > 99) return res.status(400).json({ error: 'Pro Produkt sind höchstens 99 Stück pro Bestellung erlaubt.' })
    requested.set(item.productId, quantity)
  }
  const { data: products, error } = await supabase.from('products').select('id,name,price_cents,stock,status').in('id', [...requested.keys()])
  if (error) return res.status(500).json({ error: 'Bestellung konnte nicht erstellt werden.' })
  if (!products || products.length !== requested.size || products.some((product) => product.status !== 'active' || product.stock < (requested.get(product.id) || 0))) {
    return res.status(409).json({ error: 'Ein Artikel ist inzwischen nicht mehr verfügbar oder der Bestand hat sich geändert.' })
  }
  const orderItems = products.map((product) => ({ productId: product.id, name: product.name, priceCents: product.price_cents, quantity: requested.get(product.id) || 0 }))
  const token = crypto.randomBytes(24).toString('hex')
  const { error: insertError } = await supabase.from('orders').insert({ token, items: orderItems })
  if (insertError) return res.status(500).json({ error: 'Bestellung konnte nicht gespeichert werden.' })
  res.status(201).json({ token })
})

app.get('/api/admin/orders/:token', auth, async (req, res) => {
  const token = String(req.params.token)
  if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).json({ error: 'Bestellung nicht gefunden.' })
  const { data, error } = await supabase.from('orders').select('created_at,items,fulfilled_at').eq('token', token).maybeSingle()
  if (error) return res.status(500).json({ error: 'Bestellung konnte nicht geladen werden.' })
  if (!data) return res.status(404).json({ error: 'Bestellung nicht gefunden.' })
  res.json({ createdAt: data.created_at, items: data.items, fulfilledAt: data.fulfilled_at })
})

app.post('/api/admin/orders/:token/fulfill', auth, async (req, res) => {
  const token = String(req.params.token)
  if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).json({ error: 'Bestellung nicht gefunden.' })
  const { data, error } = await supabase.rpc('fulfill_order', { order_token: token })
  if (error) {
    console.error('Order fulfillment failed:', error.message)
    return res.status(500).json({ error: 'Bestand konnte nicht abgebucht werden. Prüfe, ob die neueste Supabase-Migration ausgeführt wurde.' })
  }
  if (data === 'not_found') return res.status(404).json({ error: 'Bestellung nicht gefunden.' })
  if (data === 'product_missing') return res.status(409).json({ error: 'Ein Produkt aus dieser Bestellung wurde inzwischen gelöscht. Es wurde nichts abgebucht.' })
  if (data === 'insufficient_stock') return res.status(409).json({ error: 'Der aktuelle Lagerbestand reicht für diese Bestellung nicht aus. Es wurde nichts abgebucht.' })
  if (data === 'invalid_order') return res.status(409).json({ error: 'Die gespeicherten Bestelldaten sind ungültig. Es wurde nichts abgebucht.' })
  if (data !== 'fulfilled' && data !== 'already_fulfilled') return res.status(500).json({ error: 'Der Lagerbestand konnte nicht sicher aktualisiert werden.' })
  res.json({ fulfilled: true, alreadyFulfilled: data === 'already_fulfilled' })
})

app.get('/api/admin/categories', auth, async (_req, res) => {
  const { data: categories, error } = await supabase.from('categories').select('id,name,sort_order,design,preview_mode,preview_image').order('sort_order', { ascending: true })
  if (error) return res.status(500).json({ error: 'Kategorien konnten nicht geladen werden.' })
  const { data: memberships, error: membershipError } = await supabase.from('product_categories').select('category_id,product_id')
  if (membershipError) return res.status(500).json({ error: 'Kategoriezuordnungen konnten nicht geladen werden.' })
  res.json((categories || []).map((category) => categoryPayload(
    category,
    (memberships || []).filter((membership) => membership.category_id === category.id).map((membership) => membership.product_id),
  )))
})

app.post('/api/admin/categories', auth, async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const design = String(req.body?.design || categoryDesigns[0])
  if (!name || name.length > 80) return res.status(400).json({ error: 'Bitte einen Kategorienamen mit höchstens 80 Zeichen eingeben.' })
  if (name.toLocaleLowerCase('de-DE') === 'alle produkte') return res.status(400).json({ error: '„Alle Produkte“ ist bereits als feste Kategorie vorhanden.' })
  if (!categoryDesigns.includes(design as typeof categoryDesigns[number])) return res.status(400).json({ error: 'Ungültiges Kategorie-Design.' })
  const { data: last, error: lookupError } = await supabase.from('categories').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle()
  if (lookupError) return res.status(500).json({ error: 'Kategorie-Reihenfolge konnte nicht geladen werden.' })
  const { data, error } = await supabase.from('categories').insert({ name, design, sort_order: (last?.sort_order ?? 0) + 1 }).select('id,name,sort_order,design,preview_mode,preview_image').single()
  if (error) return res.status(500).json({ error: 'Kategorie konnte nicht erstellt werden.' })
  res.status(201).json(categoryPayload(data, []))
})

app.patch('/api/admin/categories/:id', auth, upload.single('previewImage'), async (req, res) => {
  const id = String(req.params.id)
  const { data: current, error: lookupError } = await supabase.from('categories').select('id,name,sort_order,design,preview_mode,preview_image').eq('id', id).maybeSingle()
  if (lookupError) return res.status(500).json({ error: 'Kategorie konnte nicht geladen werden.' })
  if (!current) return res.status(404).json({ error: 'Kategorie nicht gefunden.' })
  if (id === 'all-products') return res.status(400).json({ error: '„Alle Produkte“ kann nicht bearbeitet werden.' })
  const name = String(req.body?.name ?? current.name).trim()
  const design = String(req.body?.design ?? current.design)
  const previewMode = String(req.body?.previewMode ?? current.preview_mode)
  let submittedProductIds: unknown
  try {
    submittedProductIds = JSON.parse(String(req.body?.productIds || '[]'))
  } catch {
    return res.status(400).json({ error: 'Ungültige Produktauswahl.' })
  }
  if (!name || name.length > 80) return res.status(400).json({ error: 'Bitte einen Kategorienamen mit höchstens 80 Zeichen eingeben.' })
  if (name.toLocaleLowerCase('de-DE') === 'alle produkte') return res.status(400).json({ error: '„Alle Produkte“ ist bereits als feste Kategorie vorhanden.' })
  if (!categoryDesigns.includes(design as typeof categoryDesigns[number])) return res.status(400).json({ error: 'Ungültiges Kategorie-Design.' })
  if (previewMode !== 'products' && previewMode !== 'upload') return res.status(400).json({ error: 'Ungültige Kategorie-Vorschau.' })
  if (!Array.isArray(submittedProductIds) || submittedProductIds.some((productId) => !Number.isInteger(productId))) return res.status(400).json({ error: 'Ungültige Produktauswahl.' })
  const productIds = [...new Set(submittedProductIds)]
  if (productIds.length) {
    const { data: existingProducts, error: productLookupError } = await supabase.from('products').select('id').in('id', productIds)
    if (productLookupError) return res.status(500).json({ error: 'Produktauswahl konnte nicht geprüft werden.' })
    if (!existingProducts || existingProducts.length !== productIds.length) return res.status(400).json({ error: 'Die Produktauswahl enthält unbekannte Produkte.' })
  }
  let previewImage = current.preview_image as string | null
  const file = previewMode === 'upload' ? req.file : undefined
  if (file) {
    previewImage = `${id}/${crypto.randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { error } = await supabase.storage.from(storageBucket).upload(previewImage, file.buffer, { contentType: file.mimetype, upsert: false })
    if (error) return res.status(500).json({ error: 'Kategorie-Bild konnte nicht gespeichert werden.' })
  }
  const { error: updateError } = await supabase.from('categories').update({ name, design, preview_mode: previewMode, preview_image: previewMode === 'upload' ? previewImage : null }).eq('id', id)
  if (updateError) return res.status(500).json({ error: 'Kategorie konnte nicht gespeichert werden.' })
  const { error: deleteError } = await supabase.from('product_categories').delete().eq('category_id', id)
  if (deleteError) return res.status(500).json({ error: 'Produktzuordnungen konnten nicht aktualisiert werden.' })
  if (productIds.length) {
    const { error: insertError } = await supabase.from('product_categories').insert(productIds.map((product_id) => ({ category_id: id, product_id })))
    if (insertError) return res.status(500).json({ error: 'Produktzuordnungen konnten nicht gespeichert werden.' })
  }
  if (current.preview_image && (file || previewMode !== 'upload')) await supabase.storage.from(storageBucket).remove([current.preview_image])
  res.json({ ok: true })
})

app.post('/api/admin/categories/reorder', auth, async (req, res) => {
  const orderedIds = req.body?.orderedIds
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string') || new Set(orderedIds).size !== orderedIds.length) {
    return res.status(400).json({ error: 'Ungültige Kategorienreihenfolge.' })
  }
  const { data: categories, error } = await supabase.from('categories').select('id').neq('id', 'all-products')
  if (error) return res.status(500).json({ error: 'Kategorien konnten nicht geladen werden.' })
  const currentIds = (categories || []).map((category) => category.id)
  if (orderedIds.length !== currentIds.length || orderedIds.some((id) => !currentIds.includes(id))) return res.status(400).json({ error: 'Ungültige Kategorienreihenfolge.' })
  const updates = await Promise.all(orderedIds.map((id, index) => supabase.from('categories').update({ sort_order: index + 1 }).eq('id', id)))
  if (updates.some(({ error: updateError }) => updateError)) return res.status(500).json({ error: 'Kategorienreihenfolge konnte nicht gespeichert werden.' })
  res.json({ ok: true })
})

app.delete('/api/admin/categories/:id', auth, async (req, res) => {
  const id = String(req.params.id)
  if (id === 'all-products') return res.status(400).json({ error: '„Alle Produkte“ kann nicht gelöscht werden.' })
  const { data: category, error: lookupError } = await supabase.from('categories').select('preview_image').eq('id', id).maybeSingle()
  if (lookupError) return res.status(500).json({ error: 'Kategorie konnte nicht geladen werden.' })
  if (!category) return res.status(404).json({ error: 'Kategorie nicht gefunden.' })
  const { error } = await supabase.from('categories').delete().eq('id', id)
  if (error) return res.status(500).json({ error: 'Kategorie konnte nicht gelöscht werden.' })
  if (category.preview_image) await supabase.storage.from(storageBucket).remove([category.preview_image])
  res.json({ ok: true })
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
  let query = supabase.from('products').select(productSelect).order('updated_at', { ascending: false }).order('id', { ascending: true })
  if (search) query = query.ilike('name', `%${search}%`)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: 'Produkte konnten nicht geladen werden.' })
  res.json((data as ProductRow[]).map(productPayload))
})

app.post('/api/admin/products/reorder', auth, async (req, res) => {
  const orderedIds = req.body?.orderedIds
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'Ungültige Produktreihenfolge.' })
  }
  const { data: products, error: lookupError } = await supabase.from('products').select('id,updated_at').order('updated_at', { ascending: false }).order('id', { ascending: true })
  if (lookupError) return res.status(500).json({ error: 'Reihenfolge konnte nicht geladen werden.' })
  const currentIds = (products || []).map((product) => product.id)
  const requestedIds = orderedIds as number[]
  if (requestedIds.length !== currentIds.length || new Set(requestedIds).size !== requestedIds.length || requestedIds.some((id) => !currentIds.includes(id))) {
    return res.status(400).json({ error: 'Ungültige Produktreihenfolge.' })
  }
  if (requestedIds.every((id, index) => id === currentIds[index])) return res.json({ ok: true })
  const baseTime = Date.now() + requestedIds.length * 1000
  const updates = await Promise.all(requestedIds.map((id, index) => supabase.from('products').update({ updated_at: new Date(baseTime - index * 1000).toISOString() }).eq('id', id)))
  if (updates.some(({ error }) => error)) return res.status(500).json({ error: 'Reihenfolge konnte nicht gespeichert werden.' })
  res.json({ ok: true })
})

const validateProduct = (body: Record<string, unknown>) => {
  const name = String(body.name || '').trim()
  const description = String(body.description || '').trim()
  const searchTerms = Array.isArray(body.searchTerms)
    ? body.searchTerms.map((term) => String(term).trim()).filter(Boolean)
    : String(body.searchTerms || '').split(',').map((term) => term.trim()).filter(Boolean)
  const priceCents = Number(body.priceCents)
  const stock = Number(body.stock)
  if (!name || name.length > 160) return 'Bitte einen gültigen Produktnamen eingeben.'
  if (description.length > 5000) return 'Die Beschreibung darf höchstens 5000 Zeichen enthalten.'
  if (searchTerms.some((term) => term.length > 80) || searchTerms.length > 30) return 'Es sind höchstens 30 Suchbegriffe mit jeweils maximal 80 Zeichen erlaubt.'
  if (!Number.isInteger(priceCents) || priceCents < 0) return 'Der Preis muss ein gültiger Betrag sein.'
  if (!Number.isInteger(stock) || stock < 0) return 'Der Lagerbestand muss eine ganze Zahl ab 0 sein.'
  const status = stock > 0 && body.status === 'active' ? 'active' : 'unlisted'
  return { name, description, searchTerms: [...new Set(searchTerms)], priceCents, stock, status }
}

const uploadImages = async (productId: number, files: Express.Multer.File[], startOrder = 0) => {
  const rows: { product_id: number; filename: string; original_name: string; sort_order: number }[] = []
  try {
    for (const [index, file] of files.entries()) {
      const filename = `${productId}/${crypto.randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const { error: uploadError } = await supabase.storage.from(storageBucket).upload(filename, file.buffer, { contentType: file.mimetype, upsert: false })
      if (uploadError) throw uploadError
      rows.push({ product_id: productId, filename, original_name: file.originalname, sort_order: startOrder + index })
    }
    if (rows.length) {
      const { error } = await supabase.from('product_images').insert(rows)
      if (error) throw error
    }
  } catch (error) {
    if (rows.length) {
      const { error: cleanupError } = await supabase.storage.from(storageBucket).remove(rows.map(({ filename }) => filename))
      if (cleanupError) console.error('Product image upload cleanup failed:', cleanupError.message)
    }
    throw error
  }
}

app.post('/api/admin/products', auth, upload.array('images', 8), async (req, res) => {
  const data = validateProduct(req.body)
  if (typeof data === 'string') return res.status(400).json({ error: data })
  const files = (req.files as Express.Multer.File[]) || []
  if (!files.length) return res.status(400).json({ error: 'Mindestens ein Produktbild ist erforderlich.' })
  const { data: product, error } = await supabase.from('products').insert({ name: data.name, description: data.description, search_terms: data.searchTerms, price_cents: data.priceCents, stock: data.stock, status: data.status }).select('id').single<{ id: number }>()
  if (error || !product) return res.status(500).json({ error: 'Produkt konnte nicht gespeichert werden.' })
  try { await uploadImages(product.id, files) } catch { await supabase.from('products').delete().eq('id', product.id); return res.status(500).json({ error: 'Produktbilder konnten nicht gespeichert werden.' }) }
  res.status(201).json({ ok: true })
})

app.patch('/api/admin/products/:id', auth, upload.array('images', 8), async (req, res) => {
  const id = Number(req.params.id)
  const data = validateProduct(req.body)
  if (typeof data === 'string') return res.status(400).json({ error: data })
  const { data: current, error: lookupError } = await supabase.from('products').select('id').eq('id', id).maybeSingle()
  if (lookupError) return res.status(500).json({ error: 'Produkt konnte nicht geladen werden.' })
  if (!current) return res.status(404).json({ error: 'Produkt nicht gefunden.' })
  const { error } = await supabase.from('products').update({ name: data.name, description: data.description, search_terms: data.searchTerms, price_cents: data.priceCents, stock: data.stock, status: data.status }).eq('id', id)
  if (error) return res.status(500).json({ error: 'Produkt konnte nicht gespeichert werden.' })
  const files = (req.files as Express.Multer.File[]) || []
  if (files.length) { const { data: last } = await supabase.from('product_images').select('sort_order').eq('product_id', id).order('sort_order', { ascending: false }).limit(1).maybeSingle<{ sort_order: number }>(); try { await uploadImages(id, files, (last?.sort_order ?? -1) + 1) } catch { return res.status(500).json({ error: 'Neue Produktbilder konnten nicht gespeichert werden.' }) } }
  res.json({ ok: true })
})

app.delete('/api/admin/products/:id/images/:imageId', auth, async (req, res) => {
  const id = Number(req.params.id)
  const imageId = Number(req.params.imageId)
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(imageId) || imageId < 1) return res.status(400).json({ error: 'Ungültige Produkt- oder Bild-ID.' })
  const { data: image, error: lookupError } = await supabase.from('product_images').select('filename').eq('id', imageId).eq('product_id', id).maybeSingle<{ filename: string }>()
  if (lookupError) return res.status(500).json({ error: 'Produktbild konnte nicht geladen werden.' })
  if (!image) return res.status(404).json({ error: 'Bild nicht gefunden.' })
  const { error: storageError } = await supabase.storage.from(storageBucket).remove([image.filename])
  if (storageError) return res.status(500).json({ error: 'Produktbild konnte nicht aus dem Speicher gelöscht werden.' })
  const { error: deleteError } = await supabase.from('product_images').delete().eq('id', imageId)
  if (deleteError) return res.status(500).json({ error: 'Produktbild konnte nicht aus der Datenbank gelöscht werden.' })
  res.json({ ok: true })
})

app.delete('/api/admin/products/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Produkt-ID.' })
  const { data: product, error: productLookupError } = await supabase.from('products').select('id').eq('id', id).maybeSingle()
  if (productLookupError) return res.status(500).json({ error: 'Produkt konnte nicht geladen werden.' })
  if (!product) return res.status(404).json({ error: 'Produkt nicht gefunden.' })
  const { data: images, error: imageLookupError } = await supabase.from('product_images').select('filename').eq('product_id', id)
  if (imageLookupError) return res.status(500).json({ error: 'Produktbilder konnten nicht geladen werden.' })
  if (images?.length) {
    const { error: storageError } = await supabase.storage.from(storageBucket).remove(images.map((image) => image.filename))
    if (storageError) return res.status(500).json({ error: 'Produktbilder konnten nicht aus dem Speicher gelöscht werden.' })
  }
  const { error } = await supabase.from('products').delete().eq('id', id)
  if (error) return res.status(500).json({ error: 'Produkt konnte nicht gelöscht werden.' })
  res.json({ ok: true })
})

void startServer()
