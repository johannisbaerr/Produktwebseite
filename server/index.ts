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
const originalStorageBucket = 'product-originals'
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
const configuredFrontendOrigin = process.env.FRONTEND_URL || 'http://localhost:5173'
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === configuredFrontendOrigin || /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin)) callback(null, true)
    else callback(new Error('Origin not allowed'))
  },
  credentials: true,
}))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 16 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
})

type ImageRow = { id: number; filename: string; original_name: string; sort_order: number }
type ExtraRow = { id: number; name: string; price_cents: number; stock: number }
type ProductRow = { id: number; name: string; description: string; price_cents: number; stock: number; status: 'active' | 'unlisted'; search_terms?: string[]; customizable?: boolean; created_at: string; updated_at: string; product_images?: ImageRow[]; product_categories?: { category_id: string }[] }
type SessionRow = { admin_id: number; expires_at: string }
const productSelect = 'id,name,description,price_cents,stock,status,search_terms,customizable,created_at,updated_at,product_images(id,filename,original_name,sort_order),product_categories(category_id)'
const legacyProductSelect = 'id,name,description,price_cents,stock,status,created_at,updated_at,product_images(id,filename,original_name,sort_order)'
const originalImagePath = (productId: number, image: Pick<ImageRow, 'filename' | 'original_name'>) => {
  const assetId = image.filename.match(/\/(?:bg-removed-)?([a-f0-9-]{36})-/i)?.[1]
  if (!assetId) return null
  const safeName = image.original_name.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${productId}/original-${assetId}-${safeName}`
}
const imagePayload = (image: ImageRow) => ({
  id: image.id,
  url: supabase.storage.from(storageBucket).getPublicUrl(image.filename).data.publicUrl,
  originalName: image.original_name,
  backgroundRemoved: /\/bg-removed-/.test(image.filename),
})
const productPayload = (row: ProductRow) => ({ id: row.id, name: row.name, description: row.description || '', priceCents: row.price_cents, stock: row.stock, status: row.stock > 0 && row.status === 'active' ? 'active' : 'unlisted', searchTerms: row.search_terms || [], customizable: row.customizable === true, categoryIds: (row.product_categories || []).map(({ category_id }) => category_id), createdAt: row.created_at, updatedAt: row.updated_at, images: (row.product_images || []).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(imagePayload) })
const adminProductPayload = async (row: ProductRow) => {
  const product = productPayload(row)
  const sortedImages = [...(row.product_images || [])].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
  const images = await Promise.all(sortedImages.map(async (image) => {
    const payload = imagePayload(image)
    const originalPath = originalImagePath(row.id, image)
    if (!originalPath) return payload
    const { data, error } = await supabase.storage.from(originalStorageBucket).createSignedUrl(originalPath, 24 * 60 * 60)
    if (error) {
      console.warn(`Stored original unavailable for product image ${image.id}:`, error.message)
      return payload
    }
    return { ...payload, originalUrl: data.signedUrl }
  }))
  return { ...product, images }
}
const attachProductExtras = async (rows: ProductRow[], includeExtraIds = false) => {
  if (rows.length === 0) return { data: [], error: null }
  const { data: links, error } = await supabase
    .from('product_extras')
    .select('product_id,extra_id,extras(id,name,price_cents,stock)')
    .in('product_id', rows.map(({ id }) => id))
  if (error) return { data: null, error }
  const extrasByProduct = new Map<number, { ids: number[]; extras: { id: number; name: string; priceCents: number; stock: number }[] }>()
  for (const link of links || []) {
    const entry = extrasByProduct.get(link.product_id) || { ids: [], extras: [] }
    entry.ids.push(link.extra_id)
    const extra = Array.isArray(link.extras) ? link.extras[0] : link.extras
    if (extra) entry.extras.push({ id: extra.id, name: extra.name, priceCents: extra.price_cents, stock: extra.stock })
    extrasByProduct.set(link.product_id, entry)
  }
  return {
    data: rows.map((row) => {
      const linked = extrasByProduct.get(row.id) || { ids: [], extras: [] }
      return { ...row, ...(includeExtraIds ? { extraIds: linked.ids } : { extraOptions: linked.extras }) }
    }),
    error: null,
  }
}
const parseExtraIds = (value: unknown): number[] | null => {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return null }
  }
  if (!Array.isArray(parsed) || parsed.some((id) => !Number.isSafeInteger(id) || id < 1)) return null
  return [...new Set(parsed as number[])]
}
const saveProductExtras = async (productId: number, extraIds: number[], customizable: boolean) => {
  const { data, error } = await supabase.rpc('set_product_extras', {
    target_product_id: productId,
    target_extra_ids: extraIds,
    enable_customization: customizable,
  })
  if (error) return { error }
  if (data !== 'saved') return { error: new Error(data === 'invalid_extras' ? 'Bitte wähle nur vorhandene Extras aus.' : 'Produkt wurde nicht gefunden.') }
  return { error: null }
}
const isMissingShopSchema = (error: { code?: string; message: string }) =>
  ['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'].includes(error.code || '') ||
  /could not find the table|could not find a relationship|column .* does not exist|relation .* does not exist/i.test(error.message)
const shopMigrationMessage = 'Die Shop-Datenbank ist noch nicht vollständig eingerichtet. Bitte führe die SQL-Dateien in supabase/migrations/ der Reihe nach im Supabase SQL Editor aus.'
const categoryDesignMigrationMessage = 'Kategorie-Designs benötigen die Migration 202610200001_category_design_settings.sql. Die Kategorien selbst bleiben verfügbar.'
const isMissingCategoryDesignSettings = (error: { code?: string; message: string }) =>
  ['42703', 'PGRST204'].includes(error.code || '') && /design_settings/i.test(error.message)

const categoryDesigns = ['Kachel', 'Panorama', 'Kompakt'] as const
type CategoryDesignSettings = { width: number; height: number; borderWidth: number; borderColor: string; backgroundColor: string; textColor: string }
type CategoryRow = { id: string; name: string; sort_order: number; design: string; design_settings?: unknown; preview_mode: 'products' | 'upload'; preview_image: string | null }
type CategoryProductOrderRow = { category_id: string; product_id: number; sort_order: number }
const defaultCategoryDesignSettings: CategoryDesignSettings = { width: 340, height: 465, borderWidth: 1, borderColor: '#d9e1e7', backgroundColor: '#f7f9fa', textColor: '#172a3c' }
const categorySelect = 'id,name,sort_order,design,design_settings,preview_mode,preview_image'
const legacyCategorySelect = 'id,name,sort_order,design,preview_mode,preview_image'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)
const parseCategoryDesignSettings = (value: unknown): CategoryDesignSettings | null => {
  if (!isRecord(value)) return null
  const { width, height, borderWidth, borderColor, backgroundColor, textColor } = value
  if (!Number.isInteger(width) || Number(width) < 280 || Number(width) > 500) return null
  if (!Number.isInteger(height) || Number(height) < 350 || Number(height) > 600) return null
  if (!Number.isInteger(borderWidth) || Number(borderWidth) < 0 || Number(borderWidth) > 8) return null
  if (!isHexColor(borderColor) || !isHexColor(backgroundColor) || !isHexColor(textColor)) return null
  return { width: Number(width), height: Number(height), borderWidth: Number(borderWidth), borderColor, backgroundColor, textColor }
}
const categoryPayload = (row: CategoryRow, productIds: number[]) => ({
  id: row.id,
  name: row.name,
  sortOrder: row.sort_order,
  design: row.design,
  designSettings: {
    ...(parseCategoryDesignSettings(row.design_settings) || defaultCategoryDesignSettings),
    borderColor: defaultCategoryDesignSettings.borderColor,
    backgroundColor: defaultCategoryDesignSettings.backgroundColor,
    textColor: defaultCategoryDesignSettings.textColor,
  },
  previewMode: row.preview_mode,
  previewImageUrl: row.preview_image ? supabase.storage.from(storageBucket).getPublicUrl(row.preview_image).data.publicUrl : null,
  productIds,
})
const loadCategories = async () => {
  const result = await supabase.from('categories').select(categorySelect).order('sort_order', { ascending: true })
  if (!result.error || !isMissingCategoryDesignSettings(result.error)) return result

  console.warn('Category design migration is not applied; loading categories with default design settings:', result.error.message)
  return supabase.from('categories').select(legacyCategorySelect).order('sort_order', { ascending: true })
}
const loadCategoryProductOrders = () => supabase.from('category_product_order').select('category_id,product_id,sort_order').order('sort_order', { ascending: true })
const orderCategoryProductIds = (categoryId: string, productIds: number[], orderRows: CategoryProductOrderRow[]) => {
  const order = new Map(orderRows.filter((row) => row.category_id === categoryId).map((row) => [row.product_id, row.sort_order]))
  const uniqueProductIds = [...new Set(productIds)]
  return uniqueProductIds.sort((left, right) => {
    const leftOrder = order.get(left)
    const rightOrder = order.get(right)
    if (leftOrder === undefined && rightOrder === undefined) return 0
    if (leftOrder === undefined) return 1
    if (rightOrder === undefined) return -1
    return leftOrder - rightOrder
  })
}

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
  const { data: categories, error } = await loadCategories()
  if (error) {
    console.error('Category query failed:', error.code, error.message)
    return res.status(isMissingShopSchema(error) ? 503 : 500).json({ error: 'Kategorien sind derzeit nicht verfügbar.' })
  }
  const { data: memberships, error: membershipError } = await supabase.from('product_categories').select('category_id,product_id')
  if (membershipError) {
    console.error('Category membership query failed:', membershipError.code, membershipError.message)
    return res.status(isMissingShopSchema(membershipError) ? 503 : 500).json({ error: 'Kategorien sind derzeit nicht verfügbar.' })
  }
  const { data: orderRows, error: orderError } = await loadCategoryProductOrders()
  if (orderError && !isMissingShopSchema(orderError)) {
    console.error('Category product order query failed:', orderError.code, orderError.message)
    return res.status(500).json({ error: 'Kategorie-Reihenfolgen sind derzeit nicht verfügbar.' })
  }
  if (orderError) console.warn('Category product order migration is not applied; using the default product order:', orderError.message)
  const { data: products, error: productsError } = await supabase.from('products').select('id').eq('status', 'active').gt('stock', 0).order('updated_at', { ascending: false }).order('id', { ascending: true })
  if (productsError) return res.status(500).json({ error: 'Kategorie-Produkte konnten nicht geladen werden.' })
  res.json((categories || []).map((category) => categoryPayload(
    category,
    orderCategoryProductIds(
      category.id,
      category.id === 'all-products'
        ? (products || []).map((product) => product.id)
        : (memberships || []).filter((membership) => membership.category_id === category.id).map((membership) => membership.product_id),
      orderRows || [],
    ),
  )))
})

app.get('/api/products', async (_req, res) => {
  let { data, error } = await supabase.from('products').select(productSelect).eq('status', 'active').gt('stock', 0).order('updated_at', { ascending: false })
  if (error && isMissingShopSchema(error)) {
    console.error('Product query requires the shop migration; using the legacy product fields:', error.code, error.message)
    const legacyResult = await supabase.from('products').select(legacyProductSelect).eq('status', 'active').gt('stock', 0).order('updated_at', { ascending: false })
    data = legacyResult.data
    error = legacyResult.error
  }
  if (error) {
    console.error('Product query failed:', error.code, error.message)
    return res.status(isMissingShopSchema(error) ? 503 : 500).json({ error: 'Produkte sind derzeit nicht verfügbar.' })
  }
  const extrasResult = await attachProductExtras(data as ProductRow[])
  if (extrasResult.error) {
    console.error('Product extras query failed:', extrasResult.error.message)
    return res.status(isMissingShopSchema(extrasResult.error) ? 503 : 500).json({ error: 'Produktanpassungen sind derzeit nicht verfügbar. Bitte prüfe die Extras-Migration.' })
  }
  res.json((extrasResult.data || []).map((row) => ({ ...productPayload(row), extraOptions: row.extraOptions })))
})

app.post('/api/orders', async (req, res) => {
  const items = req.body?.items
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) return res.status(400).json({ error: 'Der Warenkorb ist leer oder ungültig.' })
  const requested = new Map<number, number>()
  const requestedLines: { productId: number; quantity: number; extraIds: number[] }[] = []
  for (const item of items) {
    if (!Number.isSafeInteger(item?.productId) || item.productId < 1 || !Number.isInteger(item?.quantity) || item.quantity < 1 || item.quantity > 99) {
      return res.status(400).json({ error: 'Ungültige Artikel im Warenkorb.' })
    }
    const extraIds = parseExtraIds(item.extraIds ?? [])
    if (!extraIds || extraIds.length > 20) return res.status(400).json({ error: 'Ungültige Extras in der Bestellung.' })
    requestedLines.push({ productId: item.productId, quantity: item.quantity, extraIds })
    const quantity = (requested.get(item.productId) || 0) + item.quantity
    if (quantity > 99) return res.status(400).json({ error: 'Pro Produkt sind höchstens 99 Stück pro Bestellung erlaubt.' })
    requested.set(item.productId, quantity)
  }
  const { data: products, error } = await supabase.from('products').select('id,name,price_cents,stock,status,customizable').in('id', [...requested.keys()])
  if (error) return res.status(500).json({ error: 'Bestellung konnte nicht erstellt werden.' })
  if (!products || products.length !== requested.size || products.some((product) => product.status !== 'active' || product.stock < (requested.get(product.id) || 0))) {
    return res.status(409).json({ error: 'Ein Artikel ist inzwischen nicht mehr verfügbar oder der Bestand hat sich geändert.' })
  }
  const productById = new Map(products.map((product) => [product.id, product]))
  if (requestedLines.some((line) => line.extraIds.length > 0 && !productById.get(line.productId)?.customizable)) {
    return res.status(400).json({ error: 'Für dieses Produkt sind keine Anpassungen verfügbar.' })
  }
  const { data: linkedExtras, error: extraLookupError } = await supabase
    .from('product_extras')
    .select('product_id,extra_id,extras(id,name,price_cents,stock)')
    .in('product_id', [...requested.keys()])
  if (extraLookupError) return res.status(500).json({ error: 'Extras konnten nicht geprüft werden.' })
  const extraByProduct = new Map<number, Map<number, ExtraRow>>()
  for (const link of linkedExtras || []) {
    const extra = Array.isArray(link.extras) ? link.extras[0] : link.extras
    if (!extra) continue
    const productExtras = extraByProduct.get(link.product_id) || new Map<number, ExtraRow>()
    productExtras.set(link.extra_id, extra)
    extraByProduct.set(link.product_id, productExtras)
  }
  for (const line of requestedLines) {
    if (line.extraIds.some((id) => !extraByProduct.get(line.productId)?.has(id))) {
      return res.status(400).json({ error: 'Ein ausgewähltes Extra gehört nicht zu diesem Produkt.' })
    }
  }
  const extraQuantities = new Map<number, number>()
  for (const line of requestedLines) {
    for (const extraId of line.extraIds) extraQuantities.set(extraId, (extraQuantities.get(extraId) || 0) + line.quantity)
  }
  for (const [extraId, quantity] of extraQuantities) {
    const extra = [...extraByProduct.values()].map((entries) => entries.get(extraId)).find(Boolean)
    if (!extra || extra.stock < quantity) return res.status(409).json({ error: 'Der Bestand eines ausgewählten Extras reicht nicht mehr aus.' })
  }
  const orderItems = requestedLines.map((line) => {
    const product = productById.get(line.productId)!
    return {
      productId: product.id,
      name: product.name,
      priceCents: product.price_cents,
      quantity: line.quantity,
      extras: line.extraIds.map((id) => {
        const extra = extraByProduct.get(line.productId)!.get(id)!
        return { id: extra.id, name: extra.name, priceCents: extra.price_cents }
      }),
    }
  })
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
  if (data === 'extra_missing') return res.status(409).json({ error: 'Ein Extra aus dieser Bestellung wurde inzwischen gelöscht. Es wurde nichts abgebucht.' })
  if (data === 'insufficient_extra_stock') return res.status(409).json({ error: 'Der aktuelle Lagerbestand eines Extras reicht für diese Bestellung nicht aus. Es wurde nichts abgebucht.' })
  if (data === 'invalid_order') return res.status(409).json({ error: 'Die gespeicherten Bestelldaten sind ungültig. Es wurde nichts abgebucht.' })
  if (data !== 'fulfilled' && data !== 'already_fulfilled') return res.status(500).json({ error: 'Der Lagerbestand konnte nicht sicher aktualisiert werden.' })
  res.json({ fulfilled: true, alreadyFulfilled: data === 'already_fulfilled' })
})

app.get('/api/admin/categories', auth, async (_req, res) => {
  let { data: categories, error } = await loadCategories()
  if (error) {
    console.error('Admin category query failed:', error.code, error.message)
    return res.status(isMissingShopSchema(error) ? 503 : 500).json({ error: isMissingShopSchema(error) ? shopMigrationMessage : 'Kategorien konnten nicht geladen werden.' })
  }
  if (!(categories || []).some((category) => category.id === 'all-products')) {
    const { error: insertError } = await supabase.from('categories').upsert(
      { id: 'all-products', name: 'Alle Produkte', sort_order: 0, design: 'Kachel' },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    if (insertError) {
      console.error('Fixed all-products category could not be restored:', insertError.code, insertError.message)
      return res.status(500).json({ error: 'Die feste Kategorie „Alle Produkte“ konnte nicht wiederhergestellt werden.' })
    }
    const refreshed = await loadCategories()
    if (refreshed.error) {
      console.error('Categories failed to reload after restoring all-products:', refreshed.error.code, refreshed.error.message)
      return res.status(500).json({ error: 'Die Kategorien konnten nach dem Wiederherstellen nicht geladen werden.' })
    }
    categories = refreshed.data
  }
  const { data: memberships, error: membershipError } = await supabase.from('product_categories').select('category_id,product_id')
  if (membershipError) {
    console.error('Admin category membership query failed:', membershipError.code, membershipError.message)
    return res.status(isMissingShopSchema(membershipError) ? 503 : 500).json({ error: isMissingShopSchema(membershipError) ? shopMigrationMessage : 'Kategoriezuordnungen konnten nicht geladen werden.' })
  }
  const { data: orderRows, error: orderError } = await loadCategoryProductOrders()
  if (orderError && !isMissingShopSchema(orderError)) {
    console.error('Admin category product order query failed:', orderError.code, orderError.message)
    return res.status(500).json({ error: 'Kategorie-Produktsortierungen konnten nicht geladen werden.' })
  }
  if (orderError) console.warn('Category product order migration is not applied; using the default product order:', orderError.message)
  const { data: products, error: productsError } = await supabase.from('products').select('id').order('updated_at', { ascending: false }).order('id', { ascending: true })
  if (productsError) return res.status(500).json({ error: 'Kategorie-Produkte konnten nicht geladen werden.' })
  res.json((categories || []).map((category) => categoryPayload(
    category,
    orderCategoryProductIds(
      category.id,
      category.id === 'all-products'
        ? (products || []).map((product) => product.id)
        : (memberships || []).filter((membership) => membership.category_id === category.id).map((membership) => membership.product_id),
      orderRows || [],
    ),
  )))
})

app.post('/api/admin/categories', auth, async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const design = String(req.body?.design || categoryDesigns[0])
  if (!name || name.length > 80) return res.status(400).json({ error: 'Bitte einen Kategorienamen mit höchstens 80 Zeichen eingeben.' })
  if (name.toLocaleLowerCase('de-DE') === 'alle produkte') return res.status(400).json({ error: '„Alle Produkte“ ist bereits als feste Kategorie vorhanden.' })
  if (!categoryDesigns.includes(design as typeof categoryDesigns[number])) return res.status(400).json({ error: 'Ungültiges Kategorie-Design.' })
  const { data: last, error: lookupError } = await supabase.from('categories').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle()
  if (lookupError) {
    console.error('Category create order lookup failed:', lookupError.code, lookupError.message)
    return res.status(isMissingShopSchema(lookupError) ? 503 : 500).json({ error: isMissingShopSchema(lookupError) ? shopMigrationMessage : 'Kategorie-Reihenfolge konnte nicht geladen werden.' })
  }
  const { data, error } = await supabase.from('categories').insert({ name, design, sort_order: (last?.sort_order ?? 0) + 1 }).select('id,name,sort_order,design,preview_mode,preview_image').single()
  if (error) {
    console.error('Category create failed:', error.code, error.message)
    return res.status(isMissingShopSchema(error) ? 503 : 500).json({ error: isMissingShopSchema(error) ? shopMigrationMessage : 'Kategorie konnte nicht erstellt werden.' })
  }
  res.status(201).json(categoryPayload(data, []))
})

app.patch('/api/admin/categories/:id', auth, upload.single('previewImage'), async (req, res) => {
  const id = String(req.params.id)
  let hasDesignSettingsColumn = true
  let { data: current, error: lookupError } = await supabase.from('categories').select(categorySelect).eq('id', id).maybeSingle()
  if (lookupError && isMissingCategoryDesignSettings(lookupError)) {
    hasDesignSettingsColumn = false
    console.warn('Category design migration is not applied; category updates will use default design settings:', lookupError.message)
    const legacyResult = await supabase.from('categories').select(legacyCategorySelect).eq('id', id).maybeSingle()
    current = legacyResult.data
    lookupError = legacyResult.error
  }
  if (lookupError) return res.status(500).json({ error: 'Kategorie konnte nicht geladen werden.' })
  if (!current) return res.status(404).json({ error: 'Kategorie nicht gefunden.' })
  let submittedDesignSettings: unknown
  try {
    submittedDesignSettings = typeof req.body?.designSettings === 'string' ? JSON.parse(req.body.designSettings) : req.body?.designSettings
  } catch {
    return res.status(400).json({ error: 'Ungültige Design-Einstellungen.' })
  }
  const designSettings = submittedDesignSettings === undefined
    ? parseCategoryDesignSettings(current.design_settings) || defaultCategoryDesignSettings
    : parseCategoryDesignSettings(submittedDesignSettings)
  if (!designSettings) return res.status(400).json({ error: 'Ungültige Kategorie-Design-Einstellungen.' })
  const hasCustomDesignSettings = JSON.stringify(designSettings) !== JSON.stringify(defaultCategoryDesignSettings)
  if (!hasDesignSettingsColumn && hasCustomDesignSettings) return res.status(503).json({ error: categoryDesignMigrationMessage })
  if (id === 'all-products') {
    const design = String(req.body?.design ?? current.design)
    if (!categoryDesigns.includes(design as typeof categoryDesigns[number])) return res.status(400).json({ error: 'Ungültiges Kategorie-Design.' })
    const updates = hasDesignSettingsColumn ? { design, design_settings: designSettings } : { design }
    const { error } = await supabase.from('categories').update(updates).eq('id', id)
    if (error) return res.status(500).json({ error: 'Design für „Alle Produkte“ konnte nicht gespeichert werden.' })
    return res.json({ ok: true })
  }
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
  const updates = {
    name,
    design,
    ...(hasDesignSettingsColumn ? { design_settings: designSettings } : {}),
    preview_mode: previewMode,
    preview_image: previewMode === 'upload' ? previewImage : null,
  }
  const { error: updateError } = await supabase.from('categories').update(updates).eq('id', id)
  if (updateError) return res.status(500).json({ error: 'Kategorie konnte nicht gespeichert werden.' })
  const { error: deleteError } = await supabase.from('product_categories').delete().eq('category_id', id)
  if (deleteError) return res.status(500).json({ error: 'Produktzuordnungen konnten nicht aktualisiert werden.' })
  if (productIds.length) {
    const { error: insertError } = await supabase.from('product_categories').insert(productIds.map((product_id) => ({ category_id: id, product_id })))
    if (insertError) return res.status(500).json({ error: 'Produktzuordnungen konnten nicht gespeichert werden.' })
  }
  const { error: orderDeleteError } = await supabase.from('category_product_order').delete().eq('category_id', id)
  if (orderDeleteError) {
    console.error('Category product order reset failed:', orderDeleteError.code, orderDeleteError.message)
    return res.status(isMissingShopSchema(orderDeleteError) ? 503 : 500).json({ error: isMissingShopSchema(orderDeleteError) ? 'Für die Produktsortierung fehlt die Migration 202610200002_category_product_order.sql.' : 'Produktsortierung konnte nicht aktualisiert werden.' })
  }
  if (productIds.length) {
    const orderRows = productIds.map((product_id, sort_order) => ({ category_id: id, product_id, sort_order }))
    const { error: orderInsertError } = await supabase.from('category_product_order').insert(orderRows)
    if (orderInsertError) {
      console.error('Category product order reset failed:', orderInsertError.code, orderInsertError.message)
      return res.status(500).json({ error: 'Produktsortierung konnte nicht gespeichert werden.' })
    }
  }
  if (current.preview_image && (file || previewMode !== 'upload')) await supabase.storage.from(storageBucket).remove([current.preview_image])
  res.json({ ok: true })
})

app.post('/api/admin/categories/reorder', auth, async (req, res) => {
  const orderedIds = req.body?.orderedIds
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string') || new Set(orderedIds).size !== orderedIds.length) {
    return res.status(400).json({ error: 'Ungültige Kategorienreihenfolge.' })
  }
  const { data: categories, error } = await supabase.from('categories').select('id')
  if (error) return res.status(500).json({ error: 'Kategorien konnten nicht geladen werden.' })
  const currentIds = (categories || []).map((category) => category.id)
  if (orderedIds.length !== currentIds.length || orderedIds.some((id) => !currentIds.includes(id))) return res.status(400).json({ error: 'Ungültige Kategorienreihenfolge.' })
  const updates = await Promise.all(orderedIds.map((id, index) => supabase.from('categories').update({ sort_order: index }).eq('id', id)))
  if (updates.some(({ error: updateError }) => updateError)) return res.status(500).json({ error: 'Kategorienreihenfolge konnte nicht gespeichert werden.' })
  res.json({ ok: true })
})

app.post('/api/admin/categories/:id/products/reorder', auth, async (req, res) => {
  const categoryId = String(req.params.id)
  const orderedIds = req.body?.orderedIds
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => !Number.isSafeInteger(id)) || new Set(orderedIds).size !== orderedIds.length) {
    return res.status(400).json({ error: 'Ungültige Produktsortierung.' })
  }
  const { data: category, error: categoryError } = await supabase.from('categories').select('id').eq('id', categoryId).maybeSingle()
  if (categoryError) return res.status(500).json({ error: 'Kategorie konnte nicht geladen werden.' })
  if (!category) return res.status(404).json({ error: 'Kategorie nicht gefunden.' })
  let currentIds: number[]
  if (categoryId === 'all-products') {
    const { data: products, error: productsError } = await supabase.from('products').select('id')
    if (productsError) return res.status(500).json({ error: 'Kategorie-Produkte konnten nicht geladen werden.' })
    currentIds = (products || []).map((product: { id: number }) => product.id)
  } else {
    const { data: memberships, error: membershipError } = await supabase.from('product_categories').select('product_id').eq('category_id', categoryId)
    if (membershipError) return res.status(500).json({ error: 'Kategorie-Produkte konnten nicht geladen werden.' })
    currentIds = (memberships || []).map((membership: { product_id: number }) => membership.product_id)
  }
  const requestedIds = orderedIds as number[]
  if (requestedIds.length !== currentIds.length || requestedIds.some((id) => !currentIds.includes(id))) {
    return res.status(400).json({ error: 'Die Reihenfolge muss alle Produkte dieser Kategorie genau einmal enthalten.' })
  }
  const { error } = await supabase.from('category_product_order').upsert(
    requestedIds.map((product_id, sort_order) => ({ category_id: categoryId, product_id, sort_order })),
    { onConflict: 'category_id,product_id' },
  )
  if (error) {
    console.error('Category product reorder failed:', error.code, error.message)
    return res.status(isMissingShopSchema(error) ? 503 : 500).json({ error: isMissingShopSchema(error) ? 'Für die Produktsortierung fehlt die Migration 202610200002_category_product_order.sql.' : 'Produktsortierung konnte nicht gespeichert werden.' })
  }
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
  let { data, error } = await query
  if (error && isMissingShopSchema(error)) {
    console.error('Admin product query requires the shop migration; using the legacy product fields:', error.code, error.message)
    let legacyQuery = supabase.from('products').select(legacyProductSelect).order('updated_at', { ascending: false }).order('id', { ascending: true })
    if (search) legacyQuery = legacyQuery.ilike('name', `%${search}%`)
    const legacyResult = await legacyQuery
    data = legacyResult.data
    error = legacyResult.error
  }
  if (error) {
    console.error('Admin product query failed:', error.code, error.message)
    return res.status(isMissingShopSchema(error) ? 503 : 500).json({ error: isMissingShopSchema(error) ? shopMigrationMessage : 'Produkte konnten nicht geladen werden.' })
  }
  try {
    const productsWithExtras = await attachProductExtras(data as ProductRow[], true)
    if (productsWithExtras.error) {
      console.error('Admin product extras query failed:', productsWithExtras.error.message)
      return res.status(isMissingShopSchema(productsWithExtras.error) ? 503 : 500).json({ error: 'Produkt-Extras konnten nicht geladen werden. Bitte prüfe die Extras-Migration.' })
    }
    res.json(await Promise.all((productsWithExtras.data || []).map(async (row) => ({
      ...await adminProductPayload(row),
      customizable: row.customizable === true,
      extraIds: row.extraIds || [],
    }))))
  } catch (error) {
    console.error('Admin original image links could not be created:', error instanceof Error ? error.message : error)
    res.status(500).json({ error: 'Produktbilder konnten nicht vollständig geladen werden.' })
  }
})

app.get('/api/admin/extras', auth, async (_req, res) => {
  const { data, error } = await supabase.from('extras').select('id,name,price_cents,stock').order('name', { ascending: true })
  if (error) {
    console.error('Admin extras query failed:', error.message)
    return res.status(isMissingShopSchema(error) ? 503 : 500).json({ error: 'Extras konnten nicht geladen werden. Bitte führe die Extras-Migration aus.' })
  }
  res.json((data || []).map((extra) => ({ id: extra.id, name: extra.name, priceCents: extra.price_cents, stock: extra.stock })))
})

const validateExtra = (body: Record<string, unknown>) => {
  const name = String(body.name || '').trim()
  const priceCents = Number(body.priceCents)
  const stock = Number(body.stock)
  if (!name || name.length > 160) return 'Bitte einen Namen mit höchstens 160 Zeichen eingeben.'
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) return 'Der Extra-Preis muss ein gültiger Betrag sein.'
  if (!Number.isSafeInteger(stock) || stock < 0) return 'Der Extra-Lagerbestand muss eine ganze Zahl ab 0 sein.'
  return { name, price_cents: priceCents, stock }
}

app.post('/api/admin/extras', auth, async (req, res) => {
  const extra = validateExtra(req.body || {})
  if (typeof extra === 'string') return res.status(400).json({ error: extra })
  const { data, error } = await supabase.from('extras').insert(extra).select('id,name,price_cents,stock').single()
  if (error || !data) {
    console.error('Extra create failed:', error?.message)
    return res.status(500).json({ error: 'Extra konnte nicht gespeichert werden.' })
  }
  res.status(201).json({ id: data.id, name: data.name, priceCents: data.price_cents, stock: data.stock })
})

app.patch('/api/admin/extras/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Extra-ID.' })
  const extra = validateExtra(req.body || {})
  if (typeof extra === 'string') return res.status(400).json({ error: extra })
  const { data, error } = await supabase.from('extras').update({ ...extra, updated_at: new Date().toISOString() }).eq('id', id).select('id,name,price_cents,stock').maybeSingle()
  if (error) return res.status(500).json({ error: 'Extra konnte nicht aktualisiert werden.' })
  if (!data) return res.status(404).json({ error: 'Extra nicht gefunden.' })
  res.json({ id: data.id, name: data.name, priceCents: data.price_cents, stock: data.stock })
})

app.delete('/api/admin/extras/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Ungültige Extra-ID.' })
  const { error } = await supabase.from('extras').delete().eq('id', id)
  if (error) {
    console.error('Extra delete failed:', error.message)
    return res.status(500).json({ error: 'Extra konnte nicht gelöscht werden.' })
  }
  res.json({ ok: true })
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
  const customizable = body.customizable === true || body.customizable === 'true'
  const extraIds = parseExtraIds(body.extraIds ?? '[]')
  if (!name || name.length > 160) return 'Bitte einen gültigen Produktnamen eingeben.'
  if (description.length > 5000) return 'Die Beschreibung darf höchstens 5000 Zeichen enthalten.'
  if (searchTerms.some((term) => term.length > 80) || searchTerms.length > 30) return 'Es sind höchstens 30 Suchbegriffe mit jeweils maximal 80 Zeichen erlaubt.'
  if (!Number.isInteger(priceCents) || priceCents < 0) return 'Der Preis muss ein gültiger Betrag sein.'
  if (!Number.isInteger(stock) || stock < 0) return 'Der Lagerbestand muss eine ganze Zahl ab 0 sein.'
  if (!extraIds || extraIds.length > 50) return 'Die gewählten Produkt-Extras sind ungültig.'
  if (!customizable && extraIds.length > 0) return 'Extras können nur bei aktivierten Anpassungen ausgewählt werden.'
  const status = stock > 0 && body.status === 'active' ? 'active' : 'unlisted'
  return { name, description, searchTerms: [...new Set(searchTerms)], priceCents, stock, status, customizable, extraIds }
}

const uploadImages = async (productId: number, files: Express.Multer.File[], originalFiles: Express.Multer.File[], startOrder = 0) => {
  const rows: { product_id: number; filename: string; original_name: string; sort_order: number }[] = []
  const uploadedShopPaths: string[] = []
  const uploadedOriginalPaths: string[] = []
  if (originalFiles.length !== files.length) throw new Error('Für jedes Shop-Bild muss genau ein Originalbild mitgesendet werden.')
  try {
    for (const [index, file] of files.entries()) {
      const isBackgroundRemoved = file.originalname.startsWith('amspind-freigestellt-')
      const uploadedName = isBackgroundRemoved ? file.originalname.slice('amspind-freigestellt-'.length) : file.originalname
      const originalName = uploadedName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'produktbild'
      const assetId = crypto.randomUUID()
      const extension = file.originalname.match(/\.[^.]+$/)?.[0].replace(/[^a-zA-Z0-9.]/g, '') || '.webp'
      const filename = `${productId}/${isBackgroundRemoved ? 'bg-removed-' : ''}${assetId}-${originalName}${extension}`
      const originalFile = originalFiles[index]
      if (originalFile) {
        const originalPath = `${productId}/original-${assetId}-${originalName}`
        const { error: originalUploadError } = await supabase.storage.from(originalStorageBucket).upload(originalPath, originalFile.buffer, { contentType: originalFile.mimetype, upsert: false })
        if (originalUploadError) throw originalUploadError
        uploadedOriginalPaths.push(originalPath)
      }
      const { error: uploadError } = await supabase.storage.from(storageBucket).upload(filename, file.buffer, { contentType: file.mimetype, upsert: false })
      if (uploadError) throw uploadError
      uploadedShopPaths.push(filename)
      rows.push({ product_id: productId, filename, original_name: originalName, sort_order: startOrder + index })
    }
    if (rows.length) {
      const { error } = await supabase.from('product_images').insert(rows)
      if (error) throw error
    }
  } catch (error) {
    if (uploadedShopPaths.length) {
      const { error: cleanupError } = await supabase.storage.from(storageBucket).remove(uploadedShopPaths)
      if (cleanupError) console.error('Product image upload cleanup failed:', cleanupError.message)
    }
    if (uploadedOriginalPaths.length) {
      const { error: cleanupError } = await supabase.storage.from(originalStorageBucket).remove(uploadedOriginalPaths)
      if (cleanupError) console.error('Product original image cleanup failed:', cleanupError.message)
    }
    throw error
  }
}

app.post('/api/admin/products', auth, upload.fields([{ name: 'images', maxCount: 8 }, { name: 'originalImages', maxCount: 8 }]), async (req, res) => {
  const data = validateProduct(req.body)
  if (typeof data === 'string') return res.status(400).json({ error: data })
  const uploadedFiles = req.files as Record<string, Express.Multer.File[]> | undefined
  const files = uploadedFiles?.images || []
  const originalFiles = uploadedFiles?.originalImages || []
  if (!files.length) return res.status(400).json({ error: 'Mindestens ein Produktbild ist erforderlich.' })
  if (files.length !== originalFiles.length) return res.status(400).json({ error: 'Für jedes Produktbild wird auch das Original benötigt.' })
  const { data: product, error } = await supabase.from('products').insert({ name: data.name, description: data.description, search_terms: data.searchTerms, price_cents: data.priceCents, stock: data.stock, status: data.status, customizable: data.customizable }).select('id').single<{ id: number }>()
  if (error || !product) return res.status(500).json({ error: 'Produkt konnte nicht gespeichert werden.' })
  const extraSave = await saveProductExtras(product.id, data.extraIds, data.customizable)
  if (extraSave.error) {
    await supabase.from('products').delete().eq('id', product.id)
    return res.status(400).json({ error: extraSave.error.message })
  }
  try { await uploadImages(product.id, files, originalFiles) } catch (error) { await supabase.from('products').delete().eq('id', product.id); console.error('Product image upload failed:', error instanceof Error ? error.message : error); return res.status(500).json({ error: error instanceof Error ? error.message : 'Produktbilder konnten nicht gespeichert werden.' }) }
  res.status(201).json({ ok: true })
})

app.patch('/api/admin/products/:id', auth, upload.fields([{ name: 'images', maxCount: 8 }, { name: 'originalImages', maxCount: 8 }]), async (req, res) => {
  const id = Number(req.params.id)
  const data = validateProduct(req.body)
  if (typeof data === 'string') return res.status(400).json({ error: data })
  const uploadedFiles = req.files as Record<string, Express.Multer.File[]> | undefined
  const files = uploadedFiles?.images || []
  const originalFiles = uploadedFiles?.originalImages || []
  if (files.length !== originalFiles.length) return res.status(400).json({ error: 'Für jedes neue Produktbild wird auch das Original benötigt.' })
  const { data: current, error: lookupError } = await supabase.from('products').select('id').eq('id', id).maybeSingle()
  if (lookupError) return res.status(500).json({ error: 'Produkt konnte nicht geladen werden.' })
  if (!current) return res.status(404).json({ error: 'Produkt nicht gefunden.' })
  const { error } = await supabase.from('products').update({ name: data.name, description: data.description, search_terms: data.searchTerms, price_cents: data.priceCents, stock: data.stock, status: data.status, customizable: data.customizable }).eq('id', id)
  if (error) return res.status(500).json({ error: 'Produkt konnte nicht gespeichert werden.' })
  const extraSave = await saveProductExtras(id, data.extraIds, data.customizable)
  if (extraSave.error) return res.status(400).json({ error: extraSave.error.message })
  if (files.length) { const { data: last } = await supabase.from('product_images').select('sort_order').eq('product_id', id).order('sort_order', { ascending: false }).limit(1).maybeSingle<{ sort_order: number }>(); try { await uploadImages(id, files, originalFiles, (last?.sort_order ?? -1) + 1) } catch (error) { console.error('Additional product image upload failed:', error instanceof Error ? error.message : error); return res.status(500).json({ error: error instanceof Error ? error.message : 'Neue Produktbilder konnten nicht gespeichert werden.' }) } }
  res.json({ ok: true })
})

app.post('/api/admin/products/:id/images/:imageId/background-removal', auth, upload.single('image'), async (req, res) => {
  const productId = Number(req.params.id)
  const imageId = Number(req.params.imageId)
  const file = req.file
  if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isSafeInteger(imageId) || imageId < 1) return res.status(400).json({ error: 'Ungültige Produkt- oder Bild-ID.' })
  if (!file || (file.mimetype !== 'image/webp' && file.mimetype !== 'image/png')) return res.status(400).json({ error: 'Das freigestellte Bild muss als PNG oder WebP übertragen werden.' })
  const { data: image, error: lookupError } = await supabase.from('product_images').select('filename,original_name').eq('id', imageId).eq('product_id', productId).maybeSingle<ImageRow>()
  if (lookupError) return res.status(500).json({ error: 'Produktbild konnte nicht geladen werden.' })
  if (!image) return res.status(404).json({ error: 'Bild nicht gefunden.' })

  const assetId = image.filename.match(/\/(?:bg-removed-)?([a-f0-9-]{36})-/i)?.[1]
  if (!assetId) return res.status(409).json({ error: 'Für dieses Produktbild ist keine gespeicherte Originaldatei zugeordnet.' })
  const baseName = image.original_name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'produktbild'
  const filename = `${productId}/bg-removed-${assetId}-${crypto.randomUUID()}-${baseName}.${file.mimetype === 'image/webp' ? 'webp' : 'png'}`
  const { error: uploadError } = await supabase.storage.from(storageBucket).upload(filename, file.buffer, { contentType: file.mimetype, upsert: false })
  if (uploadError) return res.status(500).json({ error: 'Freigestelltes Bild konnte nicht hochgeladen werden.' })

  const { error: updateError } = await supabase.from('product_images').update({ filename }).eq('id', imageId).eq('product_id', productId)
  if (updateError) {
    const { error: cleanupError } = await supabase.storage.from(storageBucket).remove([filename])
    if (cleanupError) console.error('Background removal rollback failed:', cleanupError.message)
    return res.status(500).json({ error: 'Freigestelltes Bild konnte nicht mit dem Produkt verknüpft werden.' })
  }

  const { error: removeError } = await supabase.storage.from(storageBucket).remove([image.filename])
  if (removeError) console.error('Previous shop image cleanup failed after background removal:', removeError.message)
  res.json({ ok: true })
})

app.delete('/api/admin/products/:id/images/:imageId', auth, async (req, res) => {
  const id = Number(req.params.id)
  const imageId = Number(req.params.imageId)
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(imageId) || imageId < 1) return res.status(400).json({ error: 'Ungültige Produkt- oder Bild-ID.' })
  const { data: image, error: lookupError } = await supabase.from('product_images').select('filename,original_name').eq('id', imageId).eq('product_id', id).maybeSingle<ImageRow>()
  if (lookupError) return res.status(500).json({ error: 'Produktbild konnte nicht geladen werden.' })
  if (!image) return res.status(404).json({ error: 'Bild nicht gefunden.' })
  const { error: storageError } = await supabase.storage.from(storageBucket).remove([image.filename])
  if (storageError) return res.status(500).json({ error: 'Produktbild konnte nicht aus dem Speicher gelöscht werden.' })
  const originalPath = originalImagePath(id, image)
  if (originalPath) {
    const { error: originalStorageError } = await supabase.storage.from(originalStorageBucket).remove([originalPath])
    if (originalStorageError) return res.status(500).json({ error: 'Originalbild konnte nicht aus dem Speicher gelöscht werden.' })
  }
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
  const { data: images, error: imageLookupError } = await supabase.from('product_images').select('filename,original_name').eq('product_id', id)
  if (imageLookupError) return res.status(500).json({ error: 'Produktbilder konnten nicht geladen werden.' })
  if (images?.length) {
    const { error: storageError } = await supabase.storage.from(storageBucket).remove(images.map((image) => image.filename))
    if (storageError) return res.status(500).json({ error: 'Produktbilder konnten nicht aus dem Speicher gelöscht werden.' })
    const originalPaths = images.map((image) => originalImagePath(id, image)).filter((path): path is string => Boolean(path))
    if (originalPaths.length) {
      const { error: originalStorageError } = await supabase.storage.from(originalStorageBucket).remove(originalPaths)
      if (originalStorageError) return res.status(500).json({ error: 'Originalbilder konnten nicht aus dem Speicher gelöscht werden.' })
    }
  }
  const { error } = await supabase.from('products').delete().eq('id', id)
  if (error) return res.status(500).json({ error: 'Produkt konnte nicht gelöscht werden.' })
  res.json({ ok: true })
})

void startServer()
