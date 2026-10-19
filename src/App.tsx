import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import './App.css'

type Image = { id: number; url: string; originalName: string }
type Product = { id: number; name: string; description: string; priceCents: number; stock: number; status: 'active' | 'unlisted'; searchTerms?: string[]; categoryIds?: string[]; images: Image[]; updatedAt: string }
type Category = { id: string; name: string; sortOrder: number; design: string; previewMode: 'products' | 'upload'; previewImageUrl: string | null; productIds: number[] }
type CartItem = { productId: number; quantity: number }
type Order = { createdAt: string; fulfilledAt: string | null; items: { productId: number; name: string; priceCents: number; quantity: number }[] }

const currency = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
const emptyForm = { name: '', description: '', price: '', stock: '', status: 'active' as 'active' | 'unlisted', searchTerms: '' }
const apiBaseUrl = import.meta.env.VITE_API_URL || 'https://shop-api-c4sq.onrender.com'
const publicProductsCacheKey = `shop:public-products:${apiBaseUrl}`
const cartStorageKey = 'amspind:cart'
const allProductsCategory: Category = { id: 'all-products', name: 'Alle Produkte', sortOrder: 0, design: 'Kachel', previewMode: 'products', previewImageUrl: null, productIds: [] }
const categoryDesigns = ['Kachel', 'Panorama', 'Kompakt']
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function readPublicProductsCache(): Product[] {
  try {
    const cached = localStorage.getItem(publicProductsCacheKey)
    if (!cached) return []
    const products: unknown = JSON.parse(cached)
    if (!Array.isArray(products)) return []
    return products.filter((product): product is Product =>
      isRecord(product) &&
      typeof product.id === 'number' &&
      typeof product.name === 'string' &&
      typeof product.description === 'string' &&
      typeof product.priceCents === 'number' &&
      typeof product.stock === 'number' &&
      (product.status === 'active' || product.status === 'unlisted') &&
      typeof product.updatedAt === 'string' &&
      Array.isArray(product.images) &&
      product.images.every((image: unknown) =>
        isRecord(image) &&
        typeof image.id === 'number' &&
        typeof image.url === 'string' &&
        typeof image.originalName === 'string',
      ),
    )
  } catch {
    return []
  }
}

function cachePublicProducts(products: Product[]) {
  try {
    localStorage.setItem(publicProductsCacheKey, JSON.stringify(products))
  } catch {
    // The catalog remains usable when browser storage is unavailable or full.
  }
}

function readCart(): CartItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(cartStorageKey) || '[]')
    return Array.isArray(value) ? value.filter((item): item is CartItem =>
      isRecord(item) &&
      typeof item.productId === 'number' &&
      Number.isSafeInteger(item.productId) &&
      item.productId > 0 &&
      typeof item.quantity === 'number' &&
      Number.isInteger(item.quantity) &&
      item.quantity > 0 &&
      item.quantity <= 99,
    ) : []
  } catch {
    return []
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${url}`, { ...options, credentials: 'include' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Etwas ist schiefgelaufen.')
  return data
}

function normalize(value: string) {
  return value.toLocaleLowerCase('de-DE').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim()
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j]
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return previous[right.length]
}

function isAdjacentTranspose(left: string, right: string) {
  if (left.length !== right.length) return false
  const mismatches: number[] = []
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) mismatches.push(index)
    if (mismatches.length > 2) return false
  }
  return mismatches.length === 2 &&
    mismatches[1] === mismatches[0] + 1 &&
    left[mismatches[0]] === right[mismatches[1]] &&
    left[mismatches[1]] === right[mismatches[0]]
}

function matchesSearch(product: Product, categoryNames: string[], search: string) {
  const queryWords = normalize(search).split(/\s+/).filter(Boolean)
  if (!queryWords.length) return true
  const words = normalize([product.name, product.description, ...(product.searchTerms || []), ...categoryNames].join(' ')).split(/\s+/)
  return queryWords.every((query) => words.some((word) =>
    word.includes(query) || query.includes(word) || isAdjacentTranspose(query, word) || editDistance(query, word) <= (query.length > 7 ? 2 : 1),
  ))
}

function Gallery({ product, admin = false, priority = false, onDeleteImage }: { product: Product; admin?: boolean; priority?: boolean; onDeleteImage?: (imageId: number) => void }) {
  const [selected, setSelected] = useState(0)
  const startX = useRef<number | null>(null)
  const image = product.images[selected]
  const move = (direction: number) => setSelected((current) => (current + direction + product.images.length) % product.images.length)
  useEffect(() => setSelected((current) => Math.min(current, Math.max(0, product.images.length - 1))), [product.images.length])
  return <div className="gallery"><div className="gallery-main" onTouchStart={(event) => { startX.current = event.touches[0].clientX }} onTouchEnd={(event) => { if (startX.current === null) return; const distance = event.changedTouches[0].clientX - startX.current; if (Math.abs(distance) > 35) move(distance > 0 ? -1 : 1); startX.current = null }}>
    {image ? <img src={image.url} alt={product.name} loading={priority ? 'eager' : 'lazy'} decoding="async" fetchPriority={priority ? 'high' : 'auto'} /> : <div className="image-placeholder">Kein Bild</div>}
    {product.images.length > 1 && <><button className="gallery-arrow left" aria-label="Vorheriges Bild" onClick={() => move(-1)}>←</button><button className="gallery-arrow right" aria-label="Nächstes Bild" onClick={() => move(1)}>→</button></>}
    <span className="image-count">{product.images.length ? `${selected + 1} / ${product.images.length}` : '0 Bilder'}</span>
  </div>{product.images.length > 1 && <div className="thumbnails">{product.images.map((item, index) => <div className={`thumbnail-wrap ${index === selected ? 'selected' : ''}`} key={item.id}><button className="thumbnail" onClick={() => setSelected(index)}><img src={item.url} alt={`${product.name} Ansicht ${index + 1}`} loading="lazy" decoding="async" /></button>{admin && onDeleteImage && <button className="thumbnail-remove" onClick={() => onDeleteImage(item.id)} aria-label="Bild entfernen">×</button>}</div>)}</div>}</div>
}

function CategoryPreview({ category, products }: { category: Category; products: Product[] }) {
  const images = [...new Set(products.flatMap((product) => product.images.map((image) => image.url)))]
  const [active, setActive] = useState(0)
  const touchStart = useRef<number | null>(null)
  const moveImage = (direction: number) => {
    if (images.length > 1) setActive((current) => (current + direction + images.length) % images.length)
  }
  useEffect(() => {
    setActive(0)
    if (category.previewMode !== 'products' || images.length < 2) return
    const timer = window.setInterval(() => moveImage(1), 3500)
    return () => window.clearInterval(timer)
  }, [category.id, category.previewMode, images.length])
  if (category.previewMode === 'upload') return <div className={`category-preview single-image ${category.design.toLowerCase()}`}>{category.previewImageUrl ? <img className="preview-active" src={category.previewImageUrl} alt="" /> : <span className="category-preview-empty">Bild auswählen</span>}</div>
  if (!images.length) return <div className={`category-preview category-preview-empty ${category.design.toLowerCase()}`}>Amspind</div>
  return <div className={`category-preview single-image ${category.design.toLowerCase()}`}
    onTouchStart={(event) => { touchStart.current = event.touches[0].clientX }}
    onTouchEnd={(event) => {
      if (touchStart.current === null) return
      const distance = event.changedTouches[0].clientX - touchStart.current
      if (Math.abs(distance) > 35) {
        event.preventDefault()
        moveImage(distance > 0 ? -1 : 1)
      }
      touchStart.current = null
    }}>
    <img key={images[active % images.length]} className="preview-active" src={images[active % images.length]} alt="" />
    {images.length > 1 && <span className="category-image-count">{active + 1} / {images.length}</span>}
  </div>
}

function PublicView({ onAdmin }: { onAdmin: () => void }) {
  const [products, setProducts] = useState<Product[]>(readPublicProductsCache)
  const [categories, setCategories] = useState<Category[]>([allProductsCategory])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [cart, setCart] = useState<CartItem[]>(readCart)
  const [cartOpen, setCartOpen] = useState(false)
  const [clearCartPrompt, setClearCartPrompt] = useState(false)
  const [shareLink, setShareLink] = useState('')
  const [cartError, setCartError] = useState('')
  const hasCatalogRef = useRef(false)
  const categoryCardsRef = useRef<HTMLDivElement>(null)
  const sortedCategories = useMemo(() => [allProductsCategory, ...categories.filter((category) => category.id !== 'all-products').sort((a, b) => a.sortOrder - b.sortOrder)], [categories])
  const displayCategories = sortedCategories
  const categoriesForProduct = (product: Product) => sortedCategories.filter((category) => category.id !== 'all-products' && category.productIds.includes(product.id)).map((category) => category.name)
  const visibleProducts = useMemo(() => products.filter((product) => {
    const inCategory = !selectedCategory || selectedCategory === 'all-products' || sortedCategories.find((category) => category.id === selectedCategory)?.productIds.includes(product.id)
    return inCategory && matchesSearch(product, categoriesForProduct(product), search)
  }), [products, search, selectedCategory, sortedCategories])
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0)
  const cartTotal = cart.reduce((total, item) => total + item.quantity * (products.find((product) => product.id === item.productId)?.priceCents || 0), 0)

  useEffect(() => {
    if (selectedCategory) document.getElementById('collection')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedCategory])

  useEffect(() => {
    if (!cartOpen) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCartOpen(false)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [cartOpen])

  useEffect(() => {
    if (selectedCategory && selectedCategory !== 'all-products' && categories.length > 1 && !categories.some((category) => category.id === selectedCategory)) {
      setSelectedCategory('')
    }
  }, [categories, selectedCategory])

  useEffect(() => {
    let mounted = true
    let loadingProducts = false
    const loadProducts = () => {
      if (loadingProducts || document.visibilityState === 'hidden') return
      loadingProducts = true
      Promise.all([request<Product[]>('/api/products'), request<Category[]>('/api/categories')])
        .then(([nextProducts, nextCategories]) => {
          cachePublicProducts(nextProducts)
          if (mounted) {
            setProducts(nextProducts)
            setCategories(nextCategories)
            hasCatalogRef.current = true
            setLoadError('')
          }
        })
        .catch(() => {
          if (mounted && !hasCatalogRef.current) setLoadError('Produkte oder Kategorien konnten gerade nicht geladen werden. Bitte versuche es erneut.')
        })
        .finally(() => {
          loadingProducts = false
          if (mounted) setLoading(false)
        })
    }
    loadProducts()
    const refresh = window.setInterval(loadProducts, 30000)
    window.addEventListener('focus', loadProducts)
    document.addEventListener('visibilitychange', loadProducts)
    return () => {
      mounted = false
      window.clearInterval(refresh)
      window.removeEventListener('focus', loadProducts)
      document.removeEventListener('visibilitychange', loadProducts)
    }
  }, [])

  useEffect(() => {
    try { localStorage.setItem(cartStorageKey, JSON.stringify(cart)) } catch { setCartError('Der Warenkorb kann in diesem Browser nicht gespeichert werden.') }
  }, [cart])

  const addToCart = (product: Product) => {
    setCart((items) => {
      const existing = items.find((item) => item.productId === product.id)
      if ((existing?.quantity || 0) >= product.stock) {
        setCartError('Die verfügbare Stückzahl liegt bereits im Warenkorb.')
        return items
      }
      setCartError('')
      return existing
        ? items.map((item) => item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item)
        : [...items, { productId: product.id, quantity: 1 }]
    })
  }

  const changeQuantity = (productId: number, quantity: number) => {
    const product = products.find((item) => item.id === productId)
    if (quantity < 1) {
      setCart((items) => items.filter((item) => item.productId !== productId))
      return
    }
    if (!product || quantity > product.stock) {
      setCartError('Die verfügbare Stückzahl wurde erreicht.')
      return
    }
    setCartError('')
    setCart((items) => items.map((item) => item.productId === productId ? { ...item, quantity } : item))
  }

  const createShareableOrder = async () => {
    setCartError('')
    try {
      let link = shareLink
      if (!link) {
        const result = await request<{ token: string }>('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: cart.map(({ productId, quantity }) => ({ productId, quantity })) }) })
        const url = new URL(window.location.href)
        url.search = `?order=${encodeURIComponent(result.token)}`
        url.hash = ''
        link = url.toString()
      }
      setShareLink(link)
      if (navigator.share) {
        await navigator.share({ title: 'Amspind Bestellung', url: link })
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link)
      } else {
        setCartError('Der Bestelllink wurde erstellt. Bitte markiere und kopiere ihn aus dem Feld unten.')
        return
      }
      setClearCartPrompt(true)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      setCartError(error instanceof Error ? error.message : 'Bestelllink konnte nicht erstellt oder geteilt werden.')
    }
  }

  return <div className="public-shell">
    <header className="site-header"><a className="brand" href="/">Amspind<span className="brand-mark">›</span></a>
      <form className="shop-search" onSubmit={(event) => { event.preventDefault(); setSelectedCategory('all-products') }}><input aria-label="Produkte suchen" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Wonach suchst du?" /><button aria-label="Suchen">⌕</button></form>
      <nav><button className="cart-button" onClick={() => setCartOpen(true)} aria-label={`Warenkorb, ${cartCount} Artikel`}>
        <span className="cart-icon-wrap"><svg className="cart-icon" viewBox="0 0 32 30" aria-hidden="true"><path d="M2 3h4l3.2 16.1a3 3 0 0 0 3 2.4h12.5a3 3 0 0 0 2.9-2.2L30 9H8" /><circle cx="13" cy="26" r="1.8" /><circle cx="24" cy="26" r="1.8" /></svg><span className="cart-count">{cartCount}</span></span>
        <span className="cart-label">Warenkorb</span>
      </button><button className="admin-link" onClick={onAdmin}>Admin-Anmeldung <span>↗</span></button></nav>
    </header>
    <main className="shop-main">
      <section className="category-navigation" aria-label="Entdecke Kategorien">
        {loading ? <div className="loading">Kategorien werden geladen ...</div> : loadError && !hasCatalogRef.current ? <div className="loading" role="alert">{loadError}</div> : displayCategories.length ? <><div className="category-track-controls">{displayCategories.length > 3 && <div className="promo-arrows"><button aria-label="Kategorien nach links" onClick={() => categoryCardsRef.current?.scrollBy({ left: -380, behavior: 'smooth' })}>‹</button><button aria-label="Kategorien nach rechts" onClick={() => categoryCardsRef.current?.scrollBy({ left: 380, behavior: 'smooth' })}>›</button></div>}</div><div className="category-promo-track" ref={categoryCardsRef}>{displayCategories.map((category) => {
          const categoryProducts = category.id === 'all-products' ? products : products.filter((product) => category.productIds.includes(product.id))
          return <button key={category.id} className="category-promo-card" onClick={() => setSelectedCategory(category.id)}>
            <CategoryPreview category={category} products={categoryProducts} />
            <div className="category-promo-copy"><span className="category-promo-kicker">Amspind Auswahl</span><h2>{category.name}</h2><p>{categoryProducts.length} {categoryProducts.length === 1 ? 'Produkt' : 'Produkte'} für deine Pause</p><span className="category-promo-link">Jetzt entdecken <span aria-hidden="true">→</span></span></div>
          </button>
        })}</div></> : <div className="category-empty"><strong>Deine Auswahl wird vorbereitet</strong><span>Bald findest du hier die Kategorien aus dem Spind.</span></div>}
      </section>
      {(selectedCategory || search) && <section className="collection" id="collection"><div className="section-heading"><div><p className="eyebrow">{search ? 'Suchergebnisse' : 'Die aktuelle Auswahl'}</p><h2>{sortedCategories.find((category) => category.id === selectedCategory)?.name || 'Alle Produkte'}</h2></div><button className="back-to-categories" onClick={() => { setSelectedCategory(''); setSearch(''); setCartError(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>← Kategorien</button><span className="product-total">{visibleProducts.length.toString().padStart(2, '0')} Artikel</span></div>
        {loading ? <div className="loading">Produkte werden geladen ...</div> : loadError ? <div className="loading" role="alert">{loadError}</div> : visibleProducts.length === 0 ? <div className="empty-public"><span>○</span><h3>{search ? 'Keine passenden Produkte gefunden' : 'Demnächst hier'}</h3><p>{search ? 'Versuche einen anderen Suchbegriff.' : 'Diese Auswahl wird gerade vorbereitet.'}</p></div> : <div className="product-grid">{visibleProducts.map((product, index) => <article className="product-card" key={product.id} style={{ animationDelay: `${Math.min(index * 35, 105)}ms` }}>
          <Gallery product={product} priority={index < 2} /><div className="product-info"><div><h3>{product.name}</h3><p>{product.description}</p></div><div className="product-price"><strong>{currency.format(product.priceCents / 100)}</strong><span className="stock-indicator">{product.stock} auf Lager</span></div></div>
          <button className="add-cart-button" onClick={() => addToCart(product)}>In den Warenkorb</button>
        </article>)}</div>}
      </section>}
    </main>
    <footer><span>Amspind <small>Dein Spind, deine Auswahl.</small></span><span>© {new Date().getFullYear()}</span></footer>
    {cartOpen && <div className="cart-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCartOpen(false) }}><section className="cart-panel" role="dialog" aria-modal="true" aria-labelledby="cart-title"><header className="cart-panel-header"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); setCartOpen(false) }}>Amspind<span className="brand-mark">›</span></a><div className="cart-panel-heading"><p className="eyebrow">Deine Auswahl</p><h2 id="cart-title">Warenkorb <span>({cartCount} Artikel)</span></h2></div><button className="icon-button" onClick={() => setCartOpen(false)} aria-label="Warenkorb schließen">×</button></header>
      <div className="cart-page-content">
      <div className="cart-page-items">
      {cart.length === 0 ? <p className="muted">Dein Warenkorb ist noch leer.</p> : <div className="cart-items">{cart.map((item) => {
        const product = products.find((entry) => entry.id === item.productId)
        return <article className="cart-item cart-page-item" key={item.productId}>
          <div className="cart-product-image">{product?.images[0] && <img src={product.images[0].url} alt="" />}</div>
          <div className="cart-product-details"><strong>{product?.name || 'Produkt nicht mehr verfügbar'}</strong><small>{product ? currency.format(product.priceCents / 100) : 'Nicht verfügbar'}</small><span>{product ? `${product.stock} auf Lager` : 'Nicht mehr im Sortiment'}</span><div className="cart-item-actions"><div className="quantity-control"><button onClick={() => changeQuantity(item.productId, item.quantity - 1)} aria-label="Menge verringern">−</button><span>{item.quantity}</span><button disabled={!product || item.quantity >= product.stock} onClick={() => product && changeQuantity(item.productId, item.quantity + 1)} aria-label="Menge erhöhen">+</button></div><button className="delete-button" onClick={() => changeQuantity(item.productId, 0)}>Entfernen</button></div></div>
          <strong className="cart-line-total">{product ? currency.format(product.priceCents * item.quantity / 100) : '—'}</strong>
        </article>
      })}</div>}
      </div>
      <aside className="cart-summary"><div className="cart-total"><strong>Zwischensumme ({cartCount} Artikel)</strong><strong>{currency.format(cartTotal / 100)}</strong></div>
      {shareLink && <label className="share-link-field">Bestelllink<input readOnly value={shareLink} onFocus={(event) => event.currentTarget.select()} /></label>}
      {cartError && <div className="form-error" role="alert">{cartError}</div>}
      <button className="primary-button" disabled={!cart.length} onClick={() => { void createShareableOrder() }}>{shareLink ? 'Bestelllink kopieren / teilen' : 'Bestellung teilen'}</button>
      <p className="cart-note">Die Bestelldetails sind nur nach Admin-Anmeldung sichtbar.</p>
      </aside>
      </div>
    </section></div>}
    {clearCartPrompt && <div className="modal-backdrop"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-cart-title"><h2 id="clear-cart-title">Möchtest du deinen Warenkorb leeren?</h2><div><button className="primary-button" onClick={() => { setCart([]); setShareLink(''); setClearCartPrompt(false) }}>Ja</button><button className="secondary-button" onClick={() => setClearCartPrompt(false)}>Nein</button></div></section></div>}
  </div>
}

function ProductForm({ product, onSaved, onCancel }: { product?: Product; onSaved: () => void; onCancel?: () => void }) {
  const [form, setForm] = useState(product ? { name: product.name, description: product.description, price: (product.priceCents / 100).toFixed(2).replace('.', ','), stock: String(product.stock), status: product.status, searchTerms: (product.searchTerms || []).join(', ') } : emptyForm)
  const [files, setFiles] = useState<FileList | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    const priceValue = Number(form.price.replace(',', '.'))
    const stockValue = Number(form.stock)
    if (!Number.isFinite(priceValue) || priceValue < 0) { setError('Bitte gib einen gültigen Preis ab 0 EUR ein.'); return }
    if (!Number.isInteger(stockValue) || stockValue < 0) { setError('Bitte gib einen ganzzahligen Lagerbestand ab 0 ein.'); return }
    if (form.status === 'active' && stockValue <= 0) { setError('Für eine aktive Anzeige muss der Lagerbestand größer als 0 sein.'); return }
    setSaving(true)
    const data = new FormData()
    data.append('name', form.name)
    data.append('description', form.description)
    data.append('searchTerms', form.searchTerms)
    data.append('priceCents', String(Math.round(priceValue * 100)))
    data.append('stock', form.stock)
    data.append('status', form.status)
    if (files) Array.from(files).forEach((file) => data.append('images', file))
    try { await request(product ? `/api/admin/products/${product.id}` : '/api/admin/products', { method: product ? 'PATCH' : 'POST', body: data }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.') }
    finally { setSaving(false) }
  }
  return <form className="product-form" onSubmit={(event) => { void submit(event) }}>
    <div className="form-header"><div><p className="eyebrow">{product ? 'Produkt bearbeiten' : 'Neues Produkt'}</p><h2>{product ? product.name : 'Artikel anlegen'}</h2></div>{onCancel && <button type="button" className="icon-button" onClick={onCancel} aria-label="Schließen">×</button>}</div>
    <label>Produktname<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="z. B. Apfelschorle" /></label>
    <label>Beschreibung<textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Produktbeschreibung" /></label>
    <label>Zusätzliche Suchbegriffe<input value={form.searchTerms} onChange={(e) => setForm({ ...form, searchTerms: e.target.value })} placeholder="z. B. süß, Getränk, Apfel" /><small>Kommagetrennte Begriffe helfen bei Synonymen und Schreibvarianten. Sie sind direkt am Produkt gespeichert.</small></label>
    <div className="form-row"><label>Preis in EUR<input required inputMode="decimal" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0,00" /></label><label>Lagerbestand<input required type="number" min="0" step="1" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} placeholder="0" /></label></div>
    <label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'unlisted' })}><option value="active">Aktiv gelistet</option><option value="unlisted">Nicht gelistet</option></select></label>
    <label className="file-drop">Produktbilder{product && <small>Bestehende Bilder bleiben erhalten. Neue Dateien werden ergänzt.</small>}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple required={!product} onChange={(e) => setFiles(e.target.files)} /><span>{files?.length ? `${files.length} Bild(er) ausgewählt` : 'Bilder auswählen oder hierher ziehen'}</span></label>
    {error && <div className="form-error">{error}</div>}<button className="primary-button" disabled={saving}>{saving ? 'Wird gespeichert ...' : product ? 'Änderungen speichern' : 'Produkt veröffentlichen'}</button>
  </form>
}

function SortableProduct({ product, disabled, onEdit, onDelete }: { product: Product; disabled: boolean; onEdit: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: product.id, disabled })
  return <article ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`admin-product ${isDragging ? 'is-dragging' : ''} ${isOver ? 'is-drop-target' : ''}`}>
    <button className="drag-handle" type="button" disabled={disabled} aria-label={`${product.name} ziehen, um die Position zu ändern`} {...attributes} {...listeners}>⠿</button>
    <div className="admin-thumb">{product.images[0] && <img src={product.images[0].url} alt="" />}</div>
    <div className="admin-product-main"><div className="admin-product-title"><h3>{product.name}</h3><span className={`status ${product.status}`}>{product.status === 'active' && product.stock > 0 ? 'Aktiv' : 'Nicht gelistet'}</span></div><p>{product.description}</p><span className="admin-meta">{currency.format(product.priceCents / 100)} · {product.stock} auf Lager · {product.images.length} Bilder</span></div>
    <div className="admin-product-actions"><button className="edit-button" onClick={onEdit}>Bearbeiten <span>↗</span></button><button className="delete-button" onClick={onDelete}>Löschen</button></div>
  </article>
}

function CategoryManager({ products }: { products: Product[] }) {
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [newCategoryName, setNewCategoryName] = useState('')
  const [design, setDesign] = useState(categoryDesigns[0])
  const [previewMode, setPreviewMode] = useState<'products' | 'upload'>('products')
  const [selectedProducts, setSelectedProducts] = useState<number[]>([])
  const [previewFile, setPreviewFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const next = await request<Category[]>('/api/admin/categories')
    setCategories(next.filter((category) => category.id !== 'all-products'))
    if (selectedId && !next.some((category) => category.id === selectedId)) setSelectedId('')
  }
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Kategorien konnten nicht geladen werden.')) }, [])
  const selected = categories.find((category) => category.id === selectedId)
  useEffect(() => {
    setName(selected?.name || '')
    setDesign(selected?.design || categoryDesigns[0])
    setPreviewMode(selected?.previewMode || 'products')
    setSelectedProducts(selected?.productIds || [])
    setPreviewFile(null)
  }, [selected])
  const create = async () => {
    if (!newCategoryName.trim()) { setError('Bitte gib einen Kategorienamen ein.'); return }
    try {
      const created = await request<Category>('/api/admin/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newCategoryName.trim(), design }) })
      await load()
      setSelectedId(created.id)
      setNewCategoryName('')
      setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Kategorie konnte nicht erstellt werden.') }
  }
  const save = async () => {
    if (!selected) return
    setBusy(true)
    setError('')
    const data = new FormData()
    data.append('name', name)
    data.append('design', design)
    data.append('previewMode', previewMode)
    data.append('productIds', JSON.stringify(selectedProducts))
    if (previewFile) data.append('previewImage', previewFile)
    try { await request(`/api/admin/categories/${selected.id}`, { method: 'PATCH', body: data }); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Kategorie konnte nicht gespeichert werden.') }
    finally { setBusy(false) }
  }
  const move = async (index: number, direction: number) => {
    const next = [...categories]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    const reordered = arrayMove(next, index, target)
    setCategories(reordered)
    try { await request('/api/admin/categories/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderedIds: reordered.map((category) => category.id) }) }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Reihenfolge konnte nicht gespeichert werden.'); await load() }
  }
  const remove = async () => {
    if (!selected || !window.confirm(`Kategorie „${selected.name}“ löschen? Die Produkte selbst bleiben erhalten.`)) return
    try { await request(`/api/admin/categories/${selected.id}`, { method: 'DELETE' }); setSelectedId(''); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Kategorie konnte nicht gelöscht werden.') }
  }
  return <section className="admin-section category-manager"><div className="section-heading"><div><p className="eyebrow">Startseite gestalten</p><h2>Kategorien</h2></div><span className="admin-meta">„Alle Produkte“ ist immer sichtbar.</span></div>
    <div className="category-admin-layout"><div className="category-admin-list"><div className="fixed-category">Alle Produkte <span>Fest</span></div>{categories.map((category, index) => <div className={`category-admin-row ${category.id === selectedId ? 'selected' : ''}`} key={category.id}><button className="category-select" onClick={() => setSelectedId(category.id)}>{category.name}</button><div><button disabled={index === 0} onClick={() => { void move(index, -1) }} aria-label="Kategorie nach oben">↑</button><button disabled={index === categories.length - 1} onClick={() => { void move(index, 1) }} aria-label="Kategorie nach unten">↓</button></div></div>)}<div className="category-create"><input value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="Neue Kategorie" /><button className="secondary-button" onClick={() => { void create() }}>Hinzufügen</button></div></div>
      <div className="category-editor">{selected ? <>
        <label>Kategoriename<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></label>
        <label>Design<select value={design} onChange={(event) => setDesign(event.target.value)}>{categoryDesigns.map((option) => <option key={option} value={option}>{option}</option>)}</select><small>Die auswählbaren Designs werden später visuell ausgestaltet.</small></label>
        <label>Vorschaubild<select value={previewMode} onChange={(event) => setPreviewMode(event.target.value as 'products' | 'upload')}><option value="products">Aus Produktbildern wechseln</option><option value="upload">Eigenes Bild hochladen</option></select></label>
        {previewMode === 'upload' && <label className="file-drop">Kategorie-Bild<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => setPreviewFile(event.target.files?.[0] || null)} /><span>{previewFile?.name || (selected.previewImageUrl ? 'Bild vorhanden – neues Bild auswählen zum Ersetzen' : 'Bild auswählen')}</span></label>}
        <fieldset className="product-picker"><legend>Produkte dieser Kategorie</legend>{products.length ? products.map((product) => <label key={product.id} className="product-choice"><input type="checkbox" checked={selectedProducts.includes(product.id)} onChange={(event) => setSelectedProducts((current) => event.target.checked ? [...current, product.id] : current.filter((id) => id !== product.id))} /><span>{product.name} <small>{product.status === 'unlisted' ? '· Nicht gelistet (öffentlich ausgeblendet)' : ''}</small></span></label>) : <p className="muted">Noch keine Produkte angelegt.</p>}</fieldset>
        <div className="category-editor-actions"><button className="primary-button" disabled={busy} onClick={() => { void save() }}>{busy ? 'Wird gespeichert ...' : 'Kategorie speichern'}</button><button className="delete-button" onClick={() => { void remove() }}>Kategorie löschen</button></div>
      </> : <p className="muted">Wähle eine Kategorie aus oder erstelle eine neue.</p>}</div></div>
    {error && <div className="form-error" role="alert">{error}</div>}
  </section>
}

function ChangeNotes() {
  const [open, setOpen] = useState(false)
  const entries = [
    { date: '2026-10-19', title: 'Warenkorb auf Vollbild umgestellt', details: 'Der Warenkorb öffnet jetzt als vollständige, bildschirmfüllende Ansicht mit Produktliste und separater Zwischensumme. Die Artikelanzahl sitzt direkt über dem Warenkorb-Symbol.' },
    { date: '2026-10-19', title: 'Bestellmengen im Admin vom Bestand abbuchen', details: 'Die Admin-Bestellansicht fragt vor dem Abziehen der bestellten Mengen nach. Die Abbuchung läuft atomar und kann pro Bestellung nur einmal erfolgen.' },
    { date: '2026-10-19', title: 'Alle Produkte als Kategorie-Karte', details: 'Die kleine Kategorie-Leiste unter der Suche entfernt. „Alle Produkte“ ist jetzt eine große Karte in der Kategorie-Reihe und zeigt ebenfalls wechselnde, per Wischgeste bedienbare Produktbilder.' },
    { date: '2026-10-19', title: 'Startseiten-Überschrift entfernt', details: 'Die zusätzliche Überschrift über den Kategorie-Karten entfernt, damit die Startseite direkt mit den Kategorien beginnt.' },
    { date: '2026-10-19', title: 'Öffentliche Kategorienansicht überarbeitet', details: 'Kategorie-Karten vergrößert und neu gestaltet. Pro Karte erscheint ein einzelnes, proportional skaliertes Produktbild mit weichem Bildwechsel.' },
    { date: '2026-10-19', title: 'Startseite auf Kategorien fokussiert', details: 'Die Startseite zeigt jetzt nur die einzelnen Kategorien. Produkte erscheinen erst nach Auswahl oder Suche; Kategorie-Bilder wechseln einzeln, größer und ohne Verzerrung.' },
    { date: '2026-10-19', title: 'Amspind-Shopfunktionen', details: 'Kategorien auf der Startseite, Kategorie-Designauswahl, Produktzuordnung und Vorschauoptionen. Warenkorb mit teilbaren, nur für Admins lesbaren Bestellungen; fehlertolerante Suche und pflegbare Produktsuchbegriffe.' },
    { date: '2026-09-28', title: 'Versionsstände 1.1 bis 1.4', details: 'Weitere Versionsstände des Shops wurden im Repository festgehalten.' },
    { date: '2026-09-25', title: 'Produktreihenfolge beim Bearbeiten erhalten', details: 'Die bestehende Reihenfolge der Produkte bleibt beim Bearbeiten erhalten.' },
    { date: '2026-09-22', title: 'Produktreihenfolge verbessert', details: 'Drag-and-drop-Sortierung in der Verwaltung ergänzt und zuverlässiger gemacht.' },
    { date: '2026-09-22', title: 'Admin-Anmeldung überarbeitet', details: 'Anmeldeformular, Hinweise und Darstellung des Admin-Logins angepasst.' },
    { date: '2026-09-22', title: 'Öffentlichen Produktkatalog gestaltet', details: 'Startseite, Produktkarten, Farben und Lagerbestandsanzeige überarbeitet.' },
    { date: '2026-09-22', title: 'Supabase und Produktions-API eingebunden', details: 'Dauerhafte Produkt- und Bildspeicherung mit Supabase sowie CORS- und API-Konfiguration für Hosting ergänzt.' },
  ].sort((a, b) => b.date.localeCompare(a.date))
  return <div className="change-notes"><button className="change-notes-toggle" onClick={() => setOpen((current) => !current)}>Codeänderungen {open ? '−' : '+'}</button>{open && <section className="change-notes-panel"><h2>Änderungen am Code</h2>{entries.map((entry) => <article key={`${entry.date}-${entry.title}`}><h3>{entry.title}</h3><time dateTime={entry.date}>{new Date(`${entry.date}T12:00:00`).toLocaleDateString('de-DE')}</time><p>{entry.details}</p></article>)}</section>}</div>
}

function OrderDetails({ token }: { token: string }) {
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState('')
  const [confirmDeduction, setConfirmDeduction] = useState(false)
  const [deducting, setDeducting] = useState(false)
  const [hasAnswered, setHasAnswered] = useState(false)
  useEffect(() => {
    let mounted = true
    request<Order>(`/api/admin/orders/${encodeURIComponent(token)}`)
      .then((nextOrder) => {
        if (!mounted) return
        setOrder(nextOrder)
        setConfirmDeduction(!nextOrder.fulfilledAt)
      })
      .catch((reason) => {
        if (mounted) setError(reason instanceof Error ? reason.message : 'Bestellung konnte nicht geladen werden.')
      })
    return () => { mounted = false }
  }, [token])
  const deductStock = async () => {
    setDeducting(true)
    setError('')
    try {
      await request(`/api/admin/orders/${encodeURIComponent(token)}/fulfill`, { method: 'POST' })
      setOrder((current) => current ? { ...current, fulfilledAt: new Date().toISOString() } : current)
      setConfirmDeduction(false)
      setHasAnswered(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Bestand konnte nicht abgebucht werden.')
      setConfirmDeduction(true)
    } finally {
      setDeducting(false)
    }
  }
  if (error && !order) return <div className="admin-empty" role="alert">{error}</div>
  if (!order) return <div className="admin-loading">Bestellung wird geladen ...</div>
  return <section className="order-details"><p className="eyebrow">Geteilte Bestellung</p><h1>Bestellung ansehen</h1><p className="muted">{new Date(order.createdAt).toLocaleString('de-DE')}</p>{order.items.map((item) => <div className="cart-item" key={item.productId}><strong>{item.name}</strong><span>{item.quantity} × {currency.format(item.priceCents / 100)}</span><strong>{currency.format(item.quantity * item.priceCents / 100)}</strong></div>)}<div className="cart-total"><strong>Gesamt</strong><strong>{currency.format(order.items.reduce((total, item) => total + item.quantity * item.priceCents, 0) / 100)}</strong></div>
    {order.fulfilledAt
      ? <p className="order-stock-status" role="status">Bestand wurde am {new Date(order.fulfilledAt).toLocaleString('de-DE')} abgezogen.</p>
      : <div className="order-stock-actions">{error && !confirmDeduction && <div className="form-error" role="alert">{error}</div>}<p className="muted">{hasAnswered ? 'Der Lagerbestand wurde nicht verändert.' : 'Der Lagerbestand wurde noch nicht verändert.'}</p><button className="primary-button" disabled={deducting} onClick={() => { setError(''); setConfirmDeduction(true) }}>Bestand jetzt abziehen</button></div>}
    {confirmDeduction && <div className="modal-backdrop"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="deduct-stock-title"><h2 id="deduct-stock-title">Bestellte Artikel vom Lagerbestand abziehen?</h2><p className="muted">Die Mengen dieser Bestellung werden einmalig vom Bestand abgezogen.</p>{error && <div className="form-error" role="alert">{error}</div>}<div><button className="primary-button" disabled={deducting} onClick={() => { void deductStock() }}>{deducting ? 'Bestand wird aktualisiert ...' : 'Ja'}</button><button className="secondary-button" disabled={deducting} onClick={() => { setConfirmDeduction(false); setHasAnswered(true) }}>Nein</button></div></section></div>}
  </section>
}

function AdminView({ onExit, orderToken }: { onExit: () => void; orderToken: string | null }) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [allProducts, setAllProducts] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [loginError, setLoginError] = useState('')
  const [reorderError, setReorderError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [draggingProductId, setDraggingProductId] = useState<number | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const productsRef = useRef(products)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  useEffect(() => {
    request('/api/auth/me')
      .then(() => setLoggedIn(true))
      .catch((reason) => {
        setLoggedIn(false)
        if (!(reason instanceof Error && reason.message === 'Nicht angemeldet')) {
          setLoginError(reason instanceof Error ? reason.message : 'Anmeldestatus konnte nicht geprüft werden.')
        }
      })
  }, [])
  const setProductList = (nextProducts: Product[]) => { productsRef.current = nextProducts; setProducts(nextProducts) }
  const load = () => request<Product[]>(`/api/admin/products?search=${encodeURIComponent(search)}`).then(setProductList)
  const loadAllProducts = () => request<Product[]>('/api/admin/products')
    .then(setAllProducts)
    .catch((reason) => setLoadError(reason instanceof Error ? reason.message : 'Produkte konnten nicht geladen werden.'))
  const saveProductOrder = async ({ active, over }: DragEndEvent) => {
    setDraggingProductId(null)
    if (!over || active.id === over.id) return
    const previous = productsRef.current
    const oldIndex = previous.findIndex((product) => product.id === active.id)
    const newIndex = previous.findIndex((product) => product.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const reordered = arrayMove(previous, oldIndex, newIndex)
    setProductList(reordered)
    setReorderError('')
    try { await request('/api/admin/products/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderedIds: reordered.map((product) => product.id) }) }) }
    catch (error) { setReorderError(error instanceof Error ? error.message : 'Reihenfolge konnte nicht gespeichert werden.'); setProductList(previous) }
  }
  useEffect(() => {
    if (!loggedIn) return
    setLoadError('')
    void load().catch((reason) => setLoadError(reason instanceof Error ? reason.message : 'Produkte konnten nicht geladen werden.'))
    void loadAllProducts()
  }, [loggedIn, search])
  if (loggedIn === null) return <div className="admin-loading">Lade ...</div>
  if (!loggedIn) return <div className="login-page"><button className="back-link" onClick={onExit}>← Zur öffentlichen Seite</button><div className="login-box"><span className="login-symbol">Amspind</span><p className="eyebrow">Produktverwaltung</p><h1>Admin-Anmeldung</h1><p className="login-intro">{orderToken ? 'Diese Bestellung ist nur nach Admin-Anmeldung sichtbar.' : 'Melde dich an, um Produkte und Kategorien zu verwalten.'}</p><form onSubmit={async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }); setLoggedIn(true) } catch (e) { setLoginError(e instanceof Error ? e.message : 'Login fehlgeschlagen.') } }}><label>Benutzername<input name="username" required defaultValue="admin" /></label><label className="password-field">Passwort<div className="password-input-wrap"><input name="password" type={showPassword ? 'text' : 'password'} required /><button type="button" className="password-toggle" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}>{showPassword ? '🙈' : '👁'}</button></div></label>{loginError && <div className="form-error">{loginError}</div>}<button className="primary-button">Anmelden <span>↗</span></button></form><p className="login-note">Nur für den internen Gebrauch.</p></div></div>
  const activeProduct = products.find((product) => product.id === draggingProductId)
  const deleteProduct = async (product: Product) => {
    if (!window.confirm(`„${product.name}“ wirklich endgültig löschen? Dieser Vorgang kann nicht rückgängig gemacht werden.`)) return
    try { await request(`/api/admin/products/${product.id}`, { method: 'DELETE' }); await load() }
    catch (reason) { setLoadError(reason instanceof Error ? reason.message : 'Produkt konnte nicht gelöscht werden.') }
  }
  return <div className="admin-shell">
    <header className="admin-header"><a className="brand admin-brand" href="#">Amspind<span className="brand-mark">›</span></a><div className="admin-title"><strong>Produktverwaltung</strong><span>Amspind</span></div><div className="admin-actions"><button className="text-button" onClick={onExit}>Öffentliche Seite</button><button className="logout" onClick={async () => { await request('/api/auth/logout', { method: 'POST' }); setLoggedIn(false) }}>Abmelden</button></div></header>
    <main className="admin-main">
      {orderToken ? <OrderDetails token={orderToken} /> : <>
        <div className="admin-intro"><div><p className="eyebrow">Übersicht</p><h1>Alle Produkte</h1><p className="muted">Verwalte deine Auswahl und halte sie aktuell.</p></div><button className="primary-button compact" onClick={() => setEditing('new')}>+ Produkt hinzufügen</button></div>
        <CategoryManager products={allProducts} />
        <section className="admin-section"><div className="admin-toolbar"><label className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nach Produkt suchen ..." /></label><span>{products.length} Produkte</span></div>
          <p className="reorder-hint">{search ? 'Suche leeren, um die Artikelreihenfolge zu ändern.' : 'Artikel am Griffpunkt ziehen, um sie anzuordnen.'}</p>
          {reorderError && <div className="form-error">{reorderError}</div>}{loadError && <div className="form-error" role="alert">{loadError}</div>}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={({ active }) => setDraggingProductId(Number(active.id))} onDragCancel={() => setDraggingProductId(null)} onDragEnd={(event) => { void saveProductOrder(event) }}>
            <SortableContext items={products.map((product) => product.id)} strategy={verticalListSortingStrategy}><div className="admin-list">
              {products.map((product) => <SortableProduct key={product.id} product={product} disabled={Boolean(search)} onEdit={() => setEditing(product)} onDelete={() => { void deleteProduct(product) }} />)}
              {products.length === 0 && <div className="admin-empty">Keine Produkte gefunden.</div>}
            </div></SortableContext>
            <DragOverlay>{activeProduct && <article className="admin-product admin-product-overlay"><div className="drag-handle" aria-hidden="true">⠿</div><div className="admin-thumb">{activeProduct.images[0] && <img src={activeProduct.images[0].url} alt="" />}</div><div className="admin-product-main"><div className="admin-product-title"><h3>{activeProduct.name}</h3><span className={`status ${activeProduct.status}`}>{activeProduct.status === 'active' && activeProduct.stock > 0 ? 'Aktiv' : 'Nicht gelistet'}</span></div><p>{activeProduct.description}</p><span className="admin-meta">{currency.format(activeProduct.priceCents / 100)} · {activeProduct.stock} auf Lager · {activeProduct.images.length} Bilder</span></div></article>}</DragOverlay>
          </DndContext>
        </section>
      </>}
    </main>
    <ChangeNotes />
    {editing && <div className="modal-backdrop"><div className="modal"><ProductForm product={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); void loadAllProducts() }} />{editing !== 'new' && <div className="existing-images"><p className="eyebrow">Bilder verwalten</p><Gallery product={editing} admin onDeleteImage={async (imageId) => { try { await request(`/api/admin/products/${editing.id}/images/${imageId}`, { method: 'DELETE' }); const updated = await request<Product[]>(`/api/admin/products?search=${encodeURIComponent(editing.name)}`); setEditing(updated.find((item) => item.id === editing.id) || editing); void loadAllProducts() } catch (reason) { setLoadError(reason instanceof Error ? reason.message : 'Produktbild konnte nicht gelöscht werden.') } }} /></div>}</div></div>}
  </div>
}

function App() {
  const orderToken = new URLSearchParams(window.location.search).get('order')
  const [admin, setAdmin] = useState(window.location.hash === '#admin' || Boolean(orderToken))
  useEffect(() => { const onHash = () => setAdmin(window.location.hash === '#admin' || Boolean(new URLSearchParams(window.location.search).get('order'))); window.addEventListener('hashchange', onHash); window.addEventListener('popstate', onHash); return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash) } }, [])
  return admin ? <AdminView orderToken={orderToken} onExit={() => { window.history.replaceState(null, '', window.location.pathname); window.location.hash = ''; setAdmin(false) }} /> : <PublicView onAdmin={() => { window.location.hash = 'admin'; setAdmin(true) }} />
}

export default App
