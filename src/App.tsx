import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CSSProperties } from 'react'
import { removeImageBackground } from './removeImageBackground'
import './App.css'

type Image = { id: number; url: string; originalUrl?: string; originalName: string; backgroundRemoved?: boolean }
type Extra = { id: number; name: string; priceCents: number; stock: number }
type Product = { id: number; name: string; description: string; priceCents: number; stock: number; status: 'active' | 'unlisted'; customizable?: boolean; extraOptions?: Extra[]; extraIds?: number[]; searchTerms?: string[]; categoryIds?: string[]; images: Image[]; updatedAt: string }
type CategoryDesignSettings = { width: number; height: number; borderWidth: number; borderColor: string; backgroundColor: string; textColor: string }
type Category = { id: string; name: string; sortOrder: number; design: string; designSettings: CategoryDesignSettings; previewMode: 'products' | 'upload'; previewImageUrl: string | null; productIds: number[] }
type CartItem = { productId: number; quantity: number; extraIds: number[] }
type Order = { createdAt: string; fulfilledAt: string | null; items: { productId: number; name: string; priceCents: number; quantity: number; extras?: { id: number; name: string; priceCents: number }[] }[] }

const currency = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
const emptyForm = { name: '', description: '', price: '', stock: '', status: 'active' as 'active' | 'unlisted', searchTerms: '' }
const apiBaseUrl = import.meta.env.VITE_API_URL || 'https://shop-api-c4sq.onrender.com'
const publicProductsCacheKey = `shop:public-products:${apiBaseUrl}`
const cartStorageKey = 'amspind:cart'
const cartLineKey = (productId: number, extraIds: number[] = []) => `${productId}:${[...extraIds].sort((a, b) => a - b).join(',')}`
const defaultCategoryDesignSettings: CategoryDesignSettings = { width: 340, height: 465, borderWidth: 1, borderColor: '#d9e1e7', backgroundColor: '#f7f9fa', textColor: '#172a3c' }
const categoryCardStyle = (settings: CategoryDesignSettings): CSSProperties => ({
  '--category-width': `${settings.width}px`,
  '--category-height': `${settings.height}px`,
  '--category-border-width': `${settings.borderWidth}px`,
  '--category-border-color': defaultCategoryDesignSettings.borderColor,
  '--category-background': defaultCategoryDesignSettings.backgroundColor,
  '--category-text': defaultCategoryDesignSettings.textColor,
} as CSSProperties)
const allProductsCategory: Category = { id: 'all-products', name: 'Alle Produkte', sortOrder: 0, design: 'Kachel', designSettings: defaultCategoryDesignSettings, previewMode: 'products', previewImageUrl: null, productIds: [] }
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

const isStoredCartItem = (item: unknown): item is { productId: number; quantity: number; extraIds?: number[] } =>
  isRecord(item) &&
  typeof item.productId === 'number' &&
  Number.isSafeInteger(item.productId) &&
  item.productId > 0 &&
  typeof item.quantity === 'number' &&
  Number.isInteger(item.quantity) &&
  item.quantity > 0 &&
  item.quantity <= 99 &&
  (item.extraIds === undefined || (Array.isArray(item.extraIds) && item.extraIds.every((id) => Number.isSafeInteger(id) && id > 0)))

function readCart(): CartItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(cartStorageKey) || '[]')
    return Array.isArray(value)
      ? value.filter(isStoredCartItem).map(({ productId, quantity, extraIds }) => ({ productId, quantity, extraIds: [...new Set(extraIds || [])] }))
      : []
  } catch {
    return []
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${url}`, { ...options, credentials: 'include' })
  const responseText = await response.text()
  let data: unknown = {}
  try {
    data = JSON.parse(responseText)
  } catch {
    if (!response.ok && responseText.trim()) throw new Error(`Serverfehler (${response.status}): ${responseText.slice(0, 240)}`)
  }
  if (!response.ok) throw new Error(isRecord(data) && typeof data.error === 'string' ? data.error : `Anfrage fehlgeschlagen (${response.status}).`)
  return data as T
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

function Gallery({ product, admin = false, priority = false, onDeleteImage, deletingImageId }: { product: Product; admin?: boolean; priority?: boolean; onDeleteImage?: (imageId: number) => void; deletingImageId?: number | null }) {
  const [selected, setSelected] = useState(0)
  const [direction, setDirection] = useState(1)
  const startTouch = useRef<{ x: number; y: number } | null>(null)
  const image = product.images[selected]
  const move = (nextDirection: number) => {
    setDirection(nextDirection)
    setSelected((current) => (current + nextDirection + product.images.length) % product.images.length)
  }
  useEffect(() => setSelected((current) => Math.min(current, Math.max(0, product.images.length - 1))), [product.images.length])
  return <div className="gallery"><div className="gallery-main" onTouchStart={(event) => { startTouch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY } }} onTouchEnd={(event) => { if (startTouch.current === null) return; const distanceX = event.changedTouches[0].clientX - startTouch.current.x; const distanceY = event.changedTouches[0].clientY - startTouch.current.y; if (Math.abs(distanceX) > 35 && Math.abs(distanceX) > Math.abs(distanceY)) move(distanceX > 0 ? -1 : 1); startTouch.current = null }}>
    {image ? <img key={image.url} className="gallery-current-image" style={{ '--slide-offset': direction > 0 ? '28px' : '-28px' } as CSSProperties} src={image.url} alt={product.name} loading={priority ? 'eager' : 'lazy'} decoding="async" fetchPriority={priority ? 'high' : 'auto'} /> : <div className="image-placeholder">Kein Bild</div>}
    {admin && image?.backgroundRemoved && <span className="background-removed-badge">✓ Freigestellt</span>}
    {admin && image && onDeleteImage && <button type="button" className="gallery-image-delete" disabled={deletingImageId === image.id} aria-busy={deletingImageId === image.id} onClick={() => onDeleteImage(image.id)} aria-label={deletingImageId === image.id ? 'Bild wird gelöscht' : `${image.originalName} löschen`} title="Dieses Bild löschen">{deletingImageId === image.id && <span className="button-spinner" aria-hidden="true" />} {deletingImageId === image.id ? 'Wird gelöscht ...' : 'Bild löschen'}</button>}
    {product.images.length > 1 && <><button className="gallery-arrow left" aria-label="Vorheriges Bild" onClick={() => move(-1)}>←</button><button className="gallery-arrow right" aria-label="Nächstes Bild" onClick={() => move(1)}>→</button></>}
    <span className="image-count">{product.images.length ? `${selected + 1} / ${product.images.length}` : '0 Bilder'}</span>
  </div>{product.images.length > 1 && <div className="thumbnails">{product.images.map((item, index) => <div className={`thumbnail-wrap ${index === selected ? 'selected' : ''}`} key={item.id}><button className="thumbnail" onClick={() => setSelected(index)}><img src={item.url} alt={`${product.name} Ansicht ${index + 1}`} loading="lazy" decoding="async" /></button>{admin && onDeleteImage && <button className="thumbnail-remove" disabled={deletingImageId === item.id} onClick={() => onDeleteImage(item.id)} aria-label={deletingImageId === item.id ? 'Bild wird gelöscht' : 'Bild entfernen'}>{deletingImageId === item.id ? '…' : '×'}</button>}</div>)}</div>}</div>
}

function CategoryFallbackLogo() {
  return <span className="category-fallback-mark" aria-label="Amspind"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M10 24h23m-10-11 11 11-11 11" /></svg></span>
}

function CategoryPreview({ category, products }: { category: Category; products: Product[] }) {
  const images = [...new Set(products.flatMap((product) => product.images.map((image) => image.url)))]
  const [active, setActive] = useState(0)
  const [direction, setDirection] = useState(1)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const didSwipe = useRef(false)
  const moveImage = (direction: number) => {
    if (images.length > 1) {
      setDirection(direction)
      setActive((current) => (current + direction + images.length) % images.length)
    }
  }
  useEffect(() => {
    setActive(0)
    if (category.previewMode !== 'products' || images.length < 2) return
    const timer = window.setInterval(() => moveImage(1), 3500)
    return () => window.clearInterval(timer)
  }, [category.id, category.previewMode, images.length])
  if (category.previewMode === 'upload') return category.previewImageUrl
    ? <div className={`category-preview single-image ${category.design.toLowerCase()}`}><img className="preview-active" src={category.previewImageUrl} alt="" /></div>
    : <div className={`category-preview category-preview-empty ${category.design.toLowerCase()}`}><CategoryFallbackLogo /></div>
  if (!images.length) return <div className={`category-preview category-preview-empty ${category.design.toLowerCase()}`}><CategoryFallbackLogo /></div>
  return <div className={`category-preview single-image ${category.design.toLowerCase()}`}
    onTouchStart={(event) => { didSwipe.current = false; touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY } }}
    onTouchEnd={(event) => {
      if (touchStart.current === null) return
      const distanceX = event.changedTouches[0].clientX - touchStart.current.x
      const distanceY = event.changedTouches[0].clientY - touchStart.current.y
      if (Math.abs(distanceX) > 35 && Math.abs(distanceX) > Math.abs(distanceY)) {
        didSwipe.current = true
        moveImage(distanceX > 0 ? -1 : 1)
      }
      touchStart.current = null
    }}
    onClick={(event) => {
      if (didSwipe.current) {
        event.preventDefault()
        event.stopPropagation()
        didSwipe.current = false
      }
    }}>
    <img key={images[active % images.length]} className="preview-active" style={{ '--slide-offset': direction > 0 ? '28px' : '-28px' } as CSSProperties} src={images[active % images.length]} alt="" />
    {images.length > 1 && <span className="category-image-count">{active + 1} / {images.length}</span>}
  </div>
}

function CategoryDesignPreview({ category, products }: { category: Category; products: Product[] }) {
  return <div className="category-design-preview">
    <p className="category-preview-heading">Vorschau der Kategorie</p>
    <div className="category-promo-card" style={categoryCardStyle(category.designSettings)}>
      <CategoryPreview category={category} products={products} />
      <div className="category-promo-copy"><h2>{category.name || 'Kategoriename'}</h2></div>
    </div>
    <span className="category-preview-design-label">Design: {category.design}</span>
  </div>
}

function StorefrontHeader({ cartCount, search, onSearchChange, onSearch, onSearchBack, showSearchBack, onCart, onAdmin }: {
  cartCount: number
  search: string
  onSearchChange: (value: string) => void
  onSearch: () => void
  onSearchBack: () => void
  showSearchBack: boolean
  onCart: () => void
  onAdmin: () => void
}) {
  return <header className="site-header">
    <a className="brand" href="/"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M10 24h23m-10-11 11 11-11 11" /></svg></span>Amspind</a>
    <form className="shop-search" onSubmit={(event) => { event.preventDefault(); onSearch() }}>
      {showSearchBack && <button className="search-back-button" type="button" aria-label="Zur vorherigen Seite" title="Zur vorherigen Seite" onClick={onSearchBack}>←</button>}
      <input aria-label="Produkte suchen" value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Wonach suchst du?" />
      <button aria-label="Suchen">⌕</button>
    </form>
    <nav>
      <button className="cart-button" onClick={onCart} aria-label={`Warenkorb, ${cartCount} Artikel`}>
        <span className="cart-icon-wrap"><svg className="cart-icon" viewBox="0 0 32 30" aria-hidden="true"><path d="M2 3h4l3.2 16.1a3 3 0 0 0 3 2.4h12.5a3 3 0 0 0 2.9-2.2L30 9H8" /><circle cx="13" cy="26" r="1.8" /><circle cx="24" cy="26" r="1.8" /></svg><span className="cart-count">{cartCount}</span></span>
        <span className="cart-label">Warenkorb</span>
      </button>
      <button className="admin-link profile-link" onClick={onAdmin} aria-label="Admin-Anmeldung" title="Admin-Anmeldung">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M4.8 20c.7-3.4 3.3-5.2 7.2-5.2s6.5 1.8 7.2 5.2" /></svg>
      </button>
    </nav>
  </header>
}

function BrandLoader({ message }: { message: string }) {
  return <div className="public-shell brand-loader-page">
    <header className="site-header brand-loader-header">
      <a className="brand" href="/" aria-label="Amspind Startseite"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M10 24h23m-10-11 11 11-11 11" /></svg></span>Amspind</a>
      <div className="shop-search brand-loader-search"><input aria-label="Produkte suchen" placeholder="Wonach suchst du?" disabled /><button type="button" aria-label="Suche" disabled>⌕</button></div>
      <nav aria-label="Shop-Navigation">
        <button className="cart-button" type="button" disabled aria-label="Warenkorb, 0 Artikel"><span className="cart-icon-wrap"><svg className="cart-icon" viewBox="0 0 32 30" aria-hidden="true"><path d="M2 3h4l3.2 16.1a3 3 0 0 0 3 2.4h12.5a3 3 0 0 0 2.9-2.2L30 9H8" /><circle cx="13" cy="26" r="1.8" /><circle cx="24" cy="26" r="1.8" /></svg><span className="cart-count">0</span></span><span className="cart-label">Warenkorb</span></button>
        <button className="admin-link profile-link" type="button" disabled aria-label="Admin-Anmeldung"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M4.8 20c.7-3.4 3.3-5.2 7.2-5.2s6.5 1.8 7.2 5.2" /></svg></button>
      </nav>
    </header>
    <main className="brand-loader" role="status" aria-live="polite">
      <div className="brand-loader-content">
        <span className="brand-loader-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M10 24h23m-10-11 11 11-11 11" /></svg></span>
        <strong>Amspind</strong>
        <span className="brand-loader-progress" aria-hidden="true"><span /></span>
        <span className="brand-loader-message">{message}</span>
      </div>
    </main>
  </div>
}

function PublicView({ onAdmin }: { onAdmin: () => void }) {
  const [products, setProducts] = useState<Product[]>(readPublicProductsCache)
  const [categories, setCategories] = useState<Category[]>([allProductsCategory])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [cart, setCart] = useState<CartItem[]>(readCart)
  const [customizingProduct, setCustomizingProduct] = useState<Product | null>(null)
  const [selectedExtraIds, setSelectedExtraIds] = useState<number[]>([])
  const [addedProductId, setAddedProductId] = useState<number | null>(null)
  const [cartOpen, setCartOpen] = useState(false)
  const [cartClosing, setCartClosing] = useState(false)
  const [removingCartProductIds, setRemovingCartProductIds] = useState<string[]>([])
  const [clearCartPrompt, setClearCartPrompt] = useState(false)
  const [shareLink, setShareLink] = useState('')
  const [cartError, setCartError] = useState('')
  const categoryCardsRef = useRef<HTMLDivElement>(null)
  const addedProductTimer = useRef<number | null>(null)
  const cartCloseTimer = useRef<number | null>(null)
  const cartOpenRef = useRef(cartOpen)
  const removalTimers = useRef(new Map<string, number>())
  const isFullCatalog = selectedCategory === 'all-products'
  const sortedCategories = useMemo(() => {
    const withAllProducts = categories.some((category) => category.id === 'all-products') ? categories : [...categories, allProductsCategory]
    return [...withAllProducts].sort((a, b) => a.sortOrder - b.sortOrder)
  }, [categories])
  const displayCategories = sortedCategories
  const categoriesForProduct = (product: Product) => sortedCategories.filter((category) => category.id !== 'all-products' && category.productIds.includes(product.id)).map((category) => category.name)
  const visibleProducts = useMemo(() => {
    const selectedOrder = sortedCategories.find((category) => category.id === selectedCategory)?.productIds || []
    const positions = new Map(selectedOrder.map((id, index) => [id, index]))
    return products.filter((product) => {
    const inCategory = !selectedCategory || selectedCategory === 'all-products' || sortedCategories.find((category) => category.id === selectedCategory)?.productIds.includes(product.id)
    return inCategory && matchesSearch(product, categoriesForProduct(product), search)
    }).sort((left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER))
  }, [products, search, selectedCategory, sortedCategories])
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0)
  const cartTotal = cart.reduce((total, item) => {
    const product = products.find((entry) => entry.id === item.productId)
    const extrasTotal = item.extraIds.reduce((sum, id) => sum + (product?.extraOptions?.find((extra) => extra.id === id)?.priceCents || 0), 0)
    return total + item.quantity * ((product?.priceCents || 0) + extrasTotal)
  }, 0)
  const isCartHistoryEntry = () => isRecord(window.history.state) && window.history.state.amspindCart === true
  const currentHistoryState = () => isRecord(window.history.state) ? window.history.state : {}
  const saveCurrentViewToHistory = (view: { search: string; category: string; cart: boolean }) => {
    window.history.replaceState({
      ...currentHistoryState(),
      amspindNavigation: true,
      amspindSearch: view.search,
      amspindCategory: view.category,
      amspindCart: view.cart,
    }, '', window.location.href)
  }
  const navigateToSearch = () => {
    const query = searchInput.trim()
    saveCurrentViewToHistory({ search, category: selectedCategory, cart: cartOpen })
    window.history.pushState({
      ...currentHistoryState(),
      amspindNavigation: true,
      amspindSearch: query,
      amspindCategory: query ? 'all-products' : '',
      amspindCart: false,
    }, '', window.location.href)
    setSearch(query)
    setSearchInput(query)
    setSelectedCategory(query ? 'all-products' : '')
    setCartOpen(false)
    setCartClosing(false)
    setCartError('')
  }
  const goBackFromSearch = () => {
    if (isRecord(window.history.state) && window.history.state.amspindNavigation === true) {
      window.history.back()
      return
    }
    setSearch('')
    setSearchInput('')
    setSelectedCategory('')
  }
  const selectCategory = (category: string) => {
    saveCurrentViewToHistory({ search, category, cart: false })
    setSearch('')
    setSearchInput('')
    setSelectedCategory(category)
  }
  const animateCartClose = useCallback(() => {
    setCartClosing(true)
    if (cartCloseTimer.current !== null) window.clearTimeout(cartCloseTimer.current)
    cartCloseTimer.current = window.setTimeout(() => {
      setCartOpen(false)
      setCartClosing(false)
      cartCloseTimer.current = null
    }, 240)
  }, [])
  const animateCartCloseRef = useRef(animateCartClose)
  useEffect(() => {
    cartOpenRef.current = cartOpen
    animateCartCloseRef.current = animateCartClose
  }, [cartOpen, animateCartClose])
  const openCart = () => {
    if (cartCloseTimer.current !== null) window.clearTimeout(cartCloseTimer.current)
    cartCloseTimer.current = null
    setCartClosing(false)
    if (!isCartHistoryEntry()) {
      saveCurrentViewToHistory({ search, category: selectedCategory, cart: false })
      window.history.pushState({ ...currentHistoryState(), amspindNavigation: true, amspindCart: true }, '', window.location.href)
    }
    setCartOpen(true)
  }
  const closeCart = () => {
    if (isCartHistoryEntry()) window.history.back()
    else animateCartClose()
  }
  const openAdminFromCart = () => {
    if (isCartHistoryEntry()) window.history.replaceState({ ...(isRecord(window.history.state) ? window.history.state : {}), amspindCart: false }, '', window.location.href)
    setCartOpen(false)
    onAdmin()
  }

  useEffect(() => {
    const syncCartWithHistory = () => {
      const state = currentHistoryState()
      if (state.amspindNavigation === true) {
        const previousSearch = typeof state.amspindSearch === 'string' ? state.amspindSearch : ''
        const previousCategory = typeof state.amspindCategory === 'string' ? state.amspindCategory : ''
        setSearch(previousSearch)
        setSearchInput(previousSearch)
        setSelectedCategory(previousCategory)
      } else {
        setSearch('')
        setSearchInput('')
        setSelectedCategory('')
      }
      if (state.amspindCart === true) {
        if (cartCloseTimer.current !== null) window.clearTimeout(cartCloseTimer.current)
        cartCloseTimer.current = null
        setCartClosing(false)
        setCartOpen(true)
      } else if (cartOpenRef.current) {
        animateCartCloseRef.current()
      } else {
        setCartOpen(false)
      }
    }
    window.addEventListener('popstate', syncCartWithHistory)
    return () => window.removeEventListener('popstate', syncCartWithHistory)
  }, [])

  useEffect(() => {
    if (selectedCategory) document.getElementById('collection')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedCategory])

  useEffect(() => {
    if (!cartOpen) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isCartHistoryEntry()) window.history.back()
        else animateCartCloseRef.current()
      }
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
      Promise.allSettled([request<Product[]>('/api/products'), request<Category[]>('/api/categories')])
        .then(([productsResult, categoriesResult]) => {
          if (!mounted) return
          if (productsResult.status === 'fulfilled') {
            cachePublicProducts(productsResult.value)
            setProducts(productsResult.value)
            setLoadError('')
          } else {
            setLoadError(productsResult.reason instanceof Error ? productsResult.reason.message : 'Produkte konnten gerade nicht geladen werden.')
          }
          if (categoriesResult.status === 'fulfilled') {
            setCategories(categoriesResult.value)
          }
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
  useEffect(() => () => {
    if (addedProductTimer.current !== null) window.clearTimeout(addedProductTimer.current)
    if (cartCloseTimer.current !== null) window.clearTimeout(cartCloseTimer.current)
    for (const timer of removalTimers.current.values()) window.clearTimeout(timer)
  }, [])

  const addToCart = (product: Product, selectedExtras: number[] = []) => {
    const extraIds = [...new Set(selectedExtras)].sort((a, b) => a - b)
    const currentProductQuantity = cart.filter((item) => item.productId === product.id).reduce((total, item) => total + item.quantity, 0)
    if (currentProductQuantity >= product.stock) {
      return false
    }
    const extra = extraIds.map((id) => product.extraOptions?.find((entry) => entry.id === id)).find((entry) => !entry || entry.stock < cart.filter((item) => item.extraIds.includes(entry.id)).reduce((total, item) => total + item.quantity, 0) + 1)
    if (extra !== undefined || extraIds.some((id) => !product.extraOptions?.some((entry) => entry.id === id))) {
      setCartError(!extra ? 'Ein ausgewähltes Extra ist nicht mehr verfügbar.' : extra.stock <= 0 ? `„${extra.name}“ ist derzeit nicht verfügbar.` : `Nicht genug „${extra.name}“ auf Lager.`)
      return false
    }
    setCartError('')
    setShareLink('')
    setCart((items) => {
      if (items.filter((item) => item.productId === product.id).reduce((total, item) => total + item.quantity, 0) >= product.stock) return items
      const existing = items.find((item) => cartLineKey(item.productId, item.extraIds) === cartLineKey(product.id, extraIds))
      return existing
        ? items.map((item) => cartLineKey(item.productId, item.extraIds) === cartLineKey(product.id, extraIds) ? { ...item, quantity: item.quantity + 1 } : item)
        : [...items, { productId: product.id, quantity: 1, extraIds }]
    })
    setAddedProductId(product.id)
    if (addedProductTimer.current !== null) window.clearTimeout(addedProductTimer.current)
    addedProductTimer.current = window.setTimeout(() => setAddedProductId(null), 700)
    return true
  }

  const addWithoutExtras = (product: Product) => {
    if (!addToCart(product)) return
    setSelectedExtraIds([])
    setCustomizingProduct(null)
  }

  const changeQuantity = (productId: number, extraIds: number[], quantity: number) => {
    const lineId = cartLineKey(productId, extraIds)
    const product = products.find((item) => item.id === productId)
    if (quantity < 1) {
      setCartError('')
      setShareLink('')
      if (removalTimers.current.has(lineId)) window.clearTimeout(removalTimers.current.get(lineId))
      setRemovingCartProductIds((current) => current.includes(lineId) ? current : [...current, lineId])
      removalTimers.current.set(lineId, window.setTimeout(() => {
        setCart((items) => items.filter((item) => cartLineKey(item.productId, item.extraIds) !== lineId))
        setRemovingCartProductIds((current) => current.filter((id) => id !== lineId))
        removalTimers.current.delete(lineId)
      }, 220))
      return
    }
    const otherProductQuantity = cart.filter((item) => item.productId === productId && cartLineKey(item.productId, item.extraIds) !== lineId).reduce((total, item) => total + item.quantity, 0)
    if (!product || quantity + otherProductQuantity > product.stock) {
      setCartError('Die verfügbare Stückzahl wurde erreicht.')
      return
    }
    for (const id of extraIds) {
      const extra = product.extraOptions?.find((entry) => entry.id === id)
      const otherExtraQuantity = cart.filter((item) => item.extraIds.includes(id) && cartLineKey(item.productId, item.extraIds) !== lineId).reduce((total, item) => total + item.quantity, 0)
      if (!extra || quantity + otherExtraQuantity > extra.stock) {
        setCartError(`Der Bestand von „${extra?.name || 'einem Extra'}“ reicht nicht aus.`)
        return
      }
    }
    setCartError('')
    setShareLink('')
    setCart((items) => items.map((item) => cartLineKey(item.productId, item.extraIds) === lineId ? { ...item, quantity } : item))
  }

  const createShareableOrder = async () => {
    setCartError('')
    if (cart.length === 0) {
      setCartError('Dein Warenkorb ist leer.')
      return
    }
    try {
      let link = shareLink
      if (!link) {
        const result = await request<{ token: string }>('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: cart.map(({ productId, quantity, extraIds }) => ({ productId, quantity, extraIds })) }) })
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

  if (loading) return <BrandLoader message="Sortiment wird geladen" />

  const cartHeader = <StorefrontHeader
    cartCount={cartCount}
    search={searchInput}
    onSearchChange={setSearchInput}
    onSearch={navigateToSearch}
    onSearchBack={goBackFromSearch}
    showSearchBack={Boolean(search)}
    onCart={() => { if (cartOpen) closeCart(); else openCart() }}
    onAdmin={openAdminFromCart}
  />
  return <div className="public-shell">
    {!cartOpen && cartHeader}
    <main className="shop-main">
      {!isFullCatalog && !search && <section className="category-navigation" aria-label="Entdecke Kategorien">
        {loading ? <div className="loading">Kategorien werden geladen ...</div> : <>{loadError && <div className="loading" role="alert">{loadError}</div>}{displayCategories.length ? <><div className="category-track-controls">{displayCategories.length > 3 && <div className="promo-arrows"><button aria-label="Kategorien nach links" onClick={() => categoryCardsRef.current?.scrollBy({ left: -380, behavior: 'smooth' })}>‹</button><button aria-label="Kategorien nach rechts" onClick={() => categoryCardsRef.current?.scrollBy({ left: 380, behavior: 'smooth' })}>›</button></div>}</div><div className="category-promo-track" ref={categoryCardsRef}>{displayCategories.map((category) => {
          const categoryProducts = category.id === 'all-products' ? products : products.filter((product) => category.productIds.includes(product.id))
          return <button key={category.id} className={`category-promo-card ${category.id === 'all-products' ? 'all-products-category' : ''}`} style={categoryCardStyle(category.designSettings || defaultCategoryDesignSettings)} onClick={() => selectCategory(category.id)}>
            <CategoryPreview category={category} products={categoryProducts} />
            <div className="category-promo-copy"><h2>{category.name}</h2></div>
          </button>
        })}</div></> : <div className="category-empty"><strong>Deine Auswahl wird vorbereitet</strong><span>Bald findest du hier die Kategorien aus dem Spind.</span></div>}</>}
      </section>}
      {(selectedCategory || search) && <section className={`collection ${isFullCatalog ? 'full-catalog' : ''}`} id="collection">      <div className="section-heading"><div><p className="eyebrow">{search ? 'Suchergebnisse' : 'Die aktuelle Auswahl'}</p><h2>{search ? `Suche: ${search}` : sortedCategories.find((category) => category.id === selectedCategory)?.name || 'Alle Produkte'}</h2></div><button className="back-to-categories" onClick={() => { saveCurrentViewToHistory({ search: '', category: '', cart: false }); setSelectedCategory(''); setSearch(''); setSearchInput(''); setCartError(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>← Kategorien</button><span className="product-total">{visibleProducts.length.toString().padStart(2, '0')} Artikel</span></div>
        {loading ? <div className="loading">Produkte werden geladen ...</div> : loadError ? <div className="loading" role="alert">{loadError}</div> : visibleProducts.length === 0 ? <div className="empty-public"><span>○</span><h3>{search ? 'Keine passenden Produkte gefunden' : 'Demnächst hier'}</h3><p>{search ? 'Versuche einen anderen Suchbegriff.' : 'Diese Auswahl wird gerade vorbereitet.'}</p></div> : <div className="product-grid">{visibleProducts.map((product, index) => <article className="product-card" key={product.id} style={{ animationDelay: `${Math.min(index * 35, 105)}ms` }}>
          <Gallery product={product} priority={index < 2} /><div className="product-info"><div><h3>{product.name}</h3><p>{product.description}</p></div><div className="product-price"><strong>{currency.format(product.priceCents / 100)}</strong><span className="stock-indicator">{product.stock} auf Lager</span></div></div>
          {(() => {
            const quantity = cart.filter((item) => item.productId === product.id).reduce((total, item) => total + item.quantity, 0)
            const atStockLimit = quantity >= product.stock
            const defaultLineId = cartLineKey(product.id)
            if (product.customizable) return <div className="customizable-product-action">
              <button className="add-cart-button" disabled={atStockLimit} onClick={() => { setCartError(''); setSelectedExtraIds([]); setCustomizingProduct(product) }}>{atStockLimit ? 'Nicht genug auf Lager' : 'Anpassen'}</button>
              {quantity > 0 && <small>Im Warenkorb: {quantity}{atStockLimit ? ' · Bestand erreicht' : ''}</small>}
            </div>
            return quantity > 0
              ? <div className={`product-cart-actions ${addedProductId === product.id ? 'just-added' : ''} ${removingCartProductIds.includes(defaultLineId) ? 'is-removing' : ''}`} aria-live="polite">
                <span className="add-cart-button in-cart" role="status">Im Warenkorb{quantity > 1 ? ` · ${quantity}` : ''} ✓</span>
                <button className="product-cart-icon-button remove-from-cart" title={quantity > 1 ? 'Ein Stück entfernen' : 'Aus dem Warenkorb entfernen'} aria-label={quantity > 1 ? 'Ein Stück entfernen' : 'Aus dem Warenkorb entfernen'} onClick={() => changeQuantity(product.id, [], quantity > 1 ? quantity - 1 : 0)}>
                  {quantity > 1 ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>}
                </button>
                <button className="product-cart-icon-button" disabled={atStockLimit} title={atStockLimit ? 'Nicht genug auf Lager' : 'Weiteres Produkt hinzufügen'} aria-label={atStockLimit ? 'Nicht genug auf Lager' : 'Weiteres Produkt hinzufügen'} onClick={() => addToCart(product)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                </button>
                {atStockLimit && <span className="stock-limit-hint" role="status">Nicht genug auf Lager</span>}
              </div>
              : <button className={`add-cart-button ${addedProductId === product.id ? 'just-added' : ''}`} disabled={product.stock <= 0} title={product.stock <= 0 ? 'Nicht genug auf Lager' : undefined} onClick={() => addToCart(product)}>{product.stock > 0 ? 'In den Warenkorb' : 'Nicht genug auf Lager'}</button>
          })()}
        </article>)}</div>}
      </section>}
    </main>
    {!isFullCatalog && <footer><span>Amspind</span><span>© {new Date().getFullYear()}</span></footer>}
    {cartOpen && <div className={`cart-backdrop ${cartClosing ? 'closing' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) closeCart() }}>{cartHeader}<section className={`cart-panel ${cartClosing ? 'closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="cart-title">
      <div className="cart-page-title"><p className="eyebrow">Deine Auswahl</p><h2 id="cart-title">Warenkorb <span>({cartCount} Artikel)</span></h2></div>
      <div className="cart-page-content">
      <div className="cart-page-items">
      {cart.length === 0 ? <p className="muted">Dein Warenkorb ist noch leer.</p> : <div className="cart-items">{cart.map((item) => {
        const product = products.find((entry) => entry.id === item.productId)
        const lineId = cartLineKey(item.productId, item.extraIds)
        const selectedExtras = item.extraIds.map((id) => product?.extraOptions?.find((extra) => extra.id === id)).filter((extra): extra is Extra => Boolean(extra))
        const unitPrice = (product?.priceCents || 0) + selectedExtras.reduce((sum, extra) => sum + extra.priceCents, 0)
        return <article className={`cart-item cart-page-item ${removingCartProductIds.includes(lineId) ? 'is-removing' : ''}`} key={lineId}>
          <div className="cart-product-image">{product?.images[0] && <img src={product.images[0].url} alt="" />}</div>
          <div className="cart-product-details"><strong>{product?.name || 'Produkt nicht mehr verfügbar'}</strong><small>{product ? currency.format(product.priceCents / 100) : 'Nicht verfügbar'}</small>{selectedExtras.length > 0 && <ul className="cart-extra-list">{selectedExtras.map((extra) => <li key={extra.id}>+ {extra.name} · {currency.format(extra.priceCents / 100)}</li>)}</ul>}<span>{product ? `${product.stock} auf Lager` : 'Nicht mehr im Sortiment'}</span><div className="cart-item-actions"><div className="quantity-control"><button onClick={() => changeQuantity(item.productId, item.extraIds, item.quantity - 1)} aria-label="Menge verringern">−</button><span>{item.quantity}</span><button disabled={!product || cart.filter((entry) => entry.productId === item.productId).reduce((total, entry) => total + entry.quantity, 0) >= product.stock || selectedExtras.some((extra) => cart.filter((entry) => entry.extraIds.includes(extra.id)).reduce((total, entry) => total + entry.quantity, 0) >= extra.stock)} onClick={() => product && changeQuantity(item.productId, item.extraIds, item.quantity + 1)} aria-label="Menge erhöhen">+</button></div><button className="delete-button" onClick={() => changeQuantity(item.productId, item.extraIds, 0)}>Entfernen</button></div></div>
          <strong className="cart-line-total">{product ? currency.format(unitPrice * item.quantity / 100) : '—'}</strong>
        </article>
      })}</div>}
      </div>
      <aside className="cart-summary"><div className="cart-total"><strong>Zwischensumme ({cartCount} Artikel)</strong><strong>{currency.format(cartTotal / 100)}</strong></div>
      {shareLink && <label className="share-link-field">Bestelllink<input readOnly value={shareLink} onFocus={(event) => event.currentTarget.select()} /></label>}
      {cartError && cart.length > 0 && <div className="form-error" role="alert">{cartError}</div>}
      <button className="primary-button" disabled={!cart.length} onClick={() => { void createShareableOrder() }}>{shareLink ? 'Bestelllink kopieren / teilen' : 'Bestellung teilen'}</button>
      <p className="cart-note">Die Bestelldetails sind nur für Admins sichtbar.</p>
      </aside>
      </div>
    </section></div>}
    {clearCartPrompt && <div className="modal-backdrop"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-cart-title"><h2 id="clear-cart-title">Möchtest du deinen Warenkorb leeren?</h2><div><button className="primary-button" onClick={() => { setCart([]); setCartError(''); setShareLink(''); setClearCartPrompt(false) }}>Ja</button><button className="secondary-button" onClick={() => setClearCartPrompt(false)}>Nein</button></div></section></div>}
    {customizingProduct && <div className="modal-backdrop customization-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCustomizingProduct(null) }}><section className="customization-dialog" role="dialog" aria-modal="true" aria-labelledby="customization-title"><button type="button" className="icon-button customization-close" aria-label="Schließen" onClick={() => setCustomizingProduct(null)}>×</button><p className="eyebrow">Deine Auswahl</p><h2 id="customization-title">{customizingProduct.name} anpassen</h2><p className="muted">Möchtest du Extras dazunehmen?</p><div className="customization-options">{(customizingProduct.extraOptions || []).map((extra) => <label className={`customization-option ${extra.stock <= 0 ? 'unavailable' : ''}`} key={extra.id}><input type="checkbox" checked={selectedExtraIds.includes(extra.id)} disabled={extra.stock <= 0} onChange={(event) => setSelectedExtraIds((current) => event.target.checked ? [...current, extra.id] : current.filter((id) => id !== extra.id))} /><span><strong>{extra.name}</strong><small>{extra.stock > 0 ? `${extra.stock} verfügbar` : 'Derzeit nicht verfügbar'}</small></span><b>{currency.format(extra.priceCents / 100)}</b></label>)}</div><div className="customization-actions"><button className="secondary-button" onClick={() => addWithoutExtras(customizingProduct)}>Nein danke</button><button className="primary-button" disabled={selectedExtraIds.length === 0 || selectedExtraIds.some((id) => !(customizingProduct.extraOptions || []).some((extra) => extra.id === id && extra.stock > 0))} onClick={() => { if (addToCart(customizingProduct, selectedExtraIds)) setCustomizingProduct(null) }}>Mit Extras hinzufügen</button></div></section></div>}
  </div>
}

function ProductForm({ product, extras, onSaved, onCancel, onRefreshBackground, backgroundBusy = false }: { product?: Product; extras: Extra[]; onSaved: () => void; onCancel?: () => void; onRefreshBackground?: (product: Product) => Promise<void>; backgroundBusy?: boolean }) {
  const [form, setForm] = useState(product ? { name: product.name, description: product.description, price: (product.priceCents / 100).toFixed(2).replace('.', ','), stock: String(product.stock), status: product.status, searchTerms: (product.searchTerms || []).join(', '), customizable: product.customizable === true } : { ...emptyForm, customizable: false })
  const [selectedExtraIds, setSelectedExtraIds] = useState<number[]>(product?.extraIds || [])
  const [files, setFiles] = useState<FileList | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [processingStatus, setProcessingStatus] = useState('')
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
    data.append('customizable', String(form.customizable))
    data.append('extraIds', JSON.stringify(form.customizable ? selectedExtraIds : []))
    try {
      if (files) {
        const selectedFiles = Array.from(files)
        for (const [index, file] of selectedFiles.entries()) {
          setProcessingStatus(`Hintergrund entfernen (${index + 1}/${selectedFiles.length}) ...`)
          const processedFile = await removeImageBackground(file)
          data.append('originalImages', file, `amspind-original-${file.name}`)
          data.append('images', new File([processedFile], `amspind-freigestellt-${processedFile.name}`, { type: processedFile.type, lastModified: processedFile.lastModified }))
        }
      }
      setProcessingStatus('Produkt wird gespeichert ...')
      await request(product ? `/api/admin/products/${product.id}` : '/api/admin/products', { method: product ? 'PATCH' : 'POST', body: data })
      onSaved()
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.') }
    finally { setSaving(false); setProcessingStatus('') }
  }
  return <form className="product-form" onSubmit={(event) => { void submit(event) }}>
    <div className="form-header"><div><p className="eyebrow">{product ? 'Produkt bearbeiten' : 'Neues Produkt'}</p><h2>{product ? product.name : 'Artikel anlegen'}</h2></div>{onCancel && <button type="button" className="icon-button" onClick={onCancel} aria-label="Schließen">×</button>}</div>
    <label>Produktname<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="z. B. Apfelschorle" /></label>
    <label>Beschreibung<textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Produktbeschreibung" /></label>
    <label>Zusätzliche Suchbegriffe<input value={form.searchTerms} onChange={(e) => setForm({ ...form, searchTerms: e.target.value })} placeholder="z. B. süß, Getränk, Apfel" /><small>Kommagetrennte Begriffe helfen bei Synonymen und Schreibvarianten. Sie sind direkt am Produkt gespeichert.</small></label>
    <div className="form-row"><label>Preis in EUR<input required inputMode="decimal" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0,00" /></label><label>Lagerbestand<input required type="number" min="0" step="1" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} placeholder="0" /></label></div>
    <label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'unlisted' })}><option value="active">Aktiv gelistet</option><option value="unlisted">Nicht gelistet</option></select></label>
    <section className="product-customization-settings"><label className="toggle-option"><input type="checkbox" checked={form.customizable} onChange={(event) => setForm((current) => ({ ...current, customizable: event.target.checked }))} /><span><strong>Anpassungen anbieten</strong><small>Besucher können vor dem Hinzufügen Extras auswählen.</small></span></label>{form.customizable && <fieldset className="product-extra-picker"><legend>Wählbare Extras</legend>{extras.length ? extras.map((extra) => <label className={`product-choice ${extra.stock <= 0 ? 'extra-out-of-stock' : ''}`} key={extra.id}><input type="checkbox" checked={selectedExtraIds.includes(extra.id)} onChange={(event) => setSelectedExtraIds((current) => event.target.checked ? [...current, extra.id] : current.filter((id) => id !== extra.id))} /><span>{extra.name} <small>· {currency.format(extra.priceCents / 100)} · {extra.stock} auf Lager</small></span></label>) : <p className="muted">Lege zuerst im Admin-Bereich unter „Extras“ mindestens ein Extra an.</p>}</fieldset>}</section>
    <label className="file-drop">Produktbilder{product && <small>Bestehende Bilder bleiben erhalten. Neue Dateien werden ergänzt.</small>}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple required={!product} onChange={(e) => setFiles(e.target.files)} /><span>{files?.length ? `${files.length} Bild(er) ausgewählt` : 'Bilder auswählen oder hierher ziehen'}</span><small className="background-removal-note">Das Original bleibt dauerhaft erhalten; die Freistellung wird als Shop-Bild gespeichert. Beim ersten Mal wird das KI-Modell (ca. 46 MB) geladen.</small></label>
    {product && onRefreshBackground && <button type="button" className="secondary-button" disabled={saving || backgroundBusy} onClick={() => { void onRefreshBackground(product) }}>{backgroundBusy ? 'Freistellung wird aktualisiert ...' : 'Bilder-Freistellung aktualisieren'}</button>}
    {error && <div className="form-error">{error}</div>}<button className="primary-button" disabled={saving} aria-busy={saving}>{saving && <span className="button-spinner" aria-hidden="true" />} {saving ? processingStatus || 'Wird gespeichert ...' : product ? 'Änderungen speichern' : 'Produkt veröffentlichen'}</button>
  </form>
}

function ExtraAdminRow({ extra, onSaved, onDeleted }: { extra: Extra; onSaved: (extra: Extra) => void; onDeleted: (id: number) => void }) {
  const [name, setName] = useState(extra.name)
  const [price, setPrice] = useState((extra.priceCents / 100).toFixed(2).replace('.', ','))
  const [stock, setStock] = useState(String(extra.stock))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const priceValue = Number(price.replace(',', '.'))
    const stockValue = Number(stock)
    if (!name.trim() || !Number.isFinite(priceValue) || priceValue < 0 || !Number.isInteger(stockValue) || stockValue < 0) {
      setError('Bitte Name, gültigen Preis und Lagerbestand eingeben.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const updated = await request<Extra>(`/api/admin/extras/${extra.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), priceCents: Math.round(priceValue * 100), stock: stockValue }) })
      onSaved(updated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Extra konnte nicht gespeichert werden.')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!window.confirm(`Extra „${extra.name}“ löschen? Es wird auch aus den Produkt-Anpassungen entfernt.`)) return
    setBusy(true)
    setError('')
    try {
      await request(`/api/admin/extras/${extra.id}`, { method: 'DELETE' })
      onDeleted(extra.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Extra konnte nicht gelöscht werden.')
      setBusy(false)
    }
  }
  return <form className="extra-admin-row" onSubmit={(event) => { void save(event) }}>
    <label>Extra-Name<input value={name} disabled={busy} maxLength={160} onChange={(event) => setName(event.target.value)} /></label>
    <label>Preis (EUR)<input inputMode="decimal" value={price} disabled={busy} onChange={(event) => setPrice(event.target.value)} /></label>
    <label>Lagerbestand<input type="number" min="0" step="1" value={stock} disabled={busy} onChange={(event) => setStock(event.target.value)} /></label>
    <div className="extra-admin-actions"><button className="secondary-button" disabled={busy} aria-busy={busy}>{busy && <span className="button-spinner" aria-hidden="true" />} Speichern</button><button type="button" className="delete-button" disabled={busy} onClick={() => { void remove() }}>{busy ? 'Wird verarbeitet ...' : 'Löschen'}</button></div>
    {error && <div className="form-error" role="alert">{error}</div>}
  </form>
}

function ExtrasManager({ extras, onChange }: { extras: Extra[]; onChange: (extras: Extra[]) => void }) {
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [stock, setStock] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const create = async (event: FormEvent) => {
    event.preventDefault()
    const priceValue = Number(price.replace(',', '.'))
    const stockValue = Number(stock)
    if (!name.trim() || !Number.isFinite(priceValue) || priceValue < 0 || !Number.isInteger(stockValue) || stockValue < 0) {
      setError('Bitte Name, gültigen Preis und Lagerbestand eingeben.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const extra = await request<Extra>('/api/admin/extras', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), priceCents: Math.round(priceValue * 100), stock: stockValue }) })
      onChange([...extras, extra].sort((left, right) => left.name.localeCompare(right.name, 'de')))
      setName('')
      setPrice('')
      setStock('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Extra konnte nicht angelegt werden.')
    } finally {
      setBusy(false)
    }
  }
  return <section className="admin-section extras-manager">
    <p className="reorder-hint">Extras sind nicht einzeln im Shop sichtbar. Sie erscheinen nur bei Produkten, für die du „Anpassungen anbieten“ aktivierst.</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    <form className="extra-create-form" onSubmit={(event) => { void create(event) }}>
      <label>Extra-Name<input value={name} disabled={busy} maxLength={160} required placeholder="z. B. Knoblauchpulver" onChange={(event) => setName(event.target.value)} /></label>
      <label>Preis (EUR)<input inputMode="decimal" value={price} disabled={busy} required placeholder="0,50" onChange={(event) => setPrice(event.target.value)} /></label>
      <label>Lagerbestand<input type="number" min="0" step="1" value={stock} disabled={busy} required placeholder="20" onChange={(event) => setStock(event.target.value)} /></label>
      <button className="primary-button" disabled={busy} aria-busy={busy}>{busy && <span className="button-spinner" aria-hidden="true" />} {busy ? 'Wird angelegt ...' : 'Extra hinzufügen'}</button>
    </form>
    <div className="extras-admin-list">{extras.map((extra) => <ExtraAdminRow key={extra.id} extra={extra} onSaved={(updated) => onChange(extras.map((entry) => entry.id === updated.id ? updated : entry).sort((left, right) => left.name.localeCompare(right.name, 'de')))} onDeleted={(id) => onChange(extras.filter((entry) => entry.id !== id))} />)}{extras.length === 0 && <div className="admin-empty">Noch keine Extras angelegt.</div>}</div>
  </section>
}

function SortableProduct({ product, disabled, onEdit, onDelete, showDragHandle = true, deleting = false }: { product: Product; disabled: boolean; onEdit?: () => void; onDelete?: () => void; showDragHandle?: boolean; deleting?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: product.id, disabled })
  return <article ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`admin-product ${isDragging ? 'is-dragging' : ''} ${isOver ? 'is-drop-target' : ''}`}>
    {showDragHandle && <button className="drag-handle" type="button" disabled={disabled} aria-label={`${product.name} ziehen, um die Position zu ändern`} {...attributes} {...listeners}>⠿</button>}
    <div className="admin-thumb">{product.images[0] && <img src={product.images[0].url} alt="" />}</div>
    <div className="admin-product-main"><div className="admin-product-title"><h3>{product.name}</h3><span className={`status ${product.status}`}>{product.status === 'active' && product.stock > 0 ? 'Aktiv' : 'Nicht gelistet'}</span></div><p>{product.description}</p><span className="admin-meta">{currency.format(product.priceCents / 100)} · {product.stock} auf Lager · {product.images.length} Bilder{product.customizable ? ' · Anpassungen' : ''}</span></div>
    {onEdit && onDelete && <div className="admin-product-actions"><button className="edit-button" disabled={deleting} onClick={onEdit}>Bearbeiten <span>↗</span></button><button className="delete-button" disabled={deleting} aria-busy={deleting} onClick={onDelete}>{deleting && <span className="button-spinner" aria-hidden="true" />} {deleting ? 'Wird gelöscht ...' : 'Löschen'}</button></div>}
  </article>
}

function CategoryProductOrderManager({ category, products, onReorder }: { category: Category; products: Product[]; onReorder: (categoryId: string, orderedIds: number[]) => Promise<void> }) {
  const initialOrder = category.productIds
  const [orderedProducts, setOrderedProducts] = useState(() => {
    const byId = new Map(products.map((product) => [product.id, product]))
    return [...initialOrder.map((id) => byId.get(id)).filter((product): product is Product => Boolean(product)), ...products.filter((product) => !initialOrder.includes(product.id))]
  })
  const [error, setError] = useState('')
  const [draggingProductId, setDraggingProductId] = useState<number | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const saveOrder = async ({ active, over }: DragEndEvent) => {
    setDraggingProductId(null)
    if (!over || active.id === over.id) return
    const oldIndex = orderedProducts.findIndex((product) => product.id === active.id)
    const newIndex = orderedProducts.findIndex((product) => product.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const previous = orderedProducts
    const reordered = arrayMove(previous, oldIndex, newIndex)
    setOrderedProducts(reordered)
    setError('')
    try {
      await onReorder(category.id, reordered.map((product) => product.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Reihenfolge konnte nicht gespeichert werden.')
      setOrderedProducts(previous)
    }
  }
  const activeProduct = orderedProducts.find((product) => product.id === draggingProductId)
  return <section className="category-product-order">
    <p className="reorder-hint">Artikel am Griffpunkt ziehen, um ihre Reihenfolge im Shop zu ändern.</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    {orderedProducts.length === 0 ? <div className="admin-empty">Noch keine Produkte vorhanden.</div> : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={({ active }) => setDraggingProductId(Number(active.id))} onDragCancel={() => setDraggingProductId(null)} onDragEnd={(event) => { void saveOrder(event) }}>
      <SortableContext items={orderedProducts.map((product) => product.id)} strategy={verticalListSortingStrategy}>
        <div className="admin-list">{orderedProducts.map((product) => <SortableProduct key={product.id} product={product} disabled={false} />)}</div>
      </SortableContext>
      <DragOverlay>{activeProduct && <article className="admin-product admin-product-overlay"><div className="drag-handle" aria-hidden="true">⠿</div><div className="admin-thumb">{activeProduct.images[0] && <img src={activeProduct.images[0].url} alt="" />}</div><div className="admin-product-main"><div className="admin-product-title"><h3>{activeProduct.name}</h3><span className={`status ${activeProduct.status}`}>{activeProduct.status === 'active' && activeProduct.stock > 0 ? 'Aktiv' : 'Nicht gelistet'}</span></div><p>{activeProduct.description}</p><span className="admin-meta">{currency.format(activeProduct.priceCents / 100)} · {activeProduct.stock} auf Lager · {activeProduct.images.length} Bilder</span></div></article>}</DragOverlay>
    </DndContext>}
  </section>
}

function SortableCategory({ category, selected, onSelect }: { category: Category; selected: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: category.id })
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`category-admin-row ${selected ? 'selected' : ''} ${isDragging ? 'is-dragging' : ''} ${isOver ? 'is-drop-target' : ''}`}>
    <button className="drag-handle category-drag-handle" type="button" aria-label={`${category.name} ziehen, um die Position zu ändern`} {...attributes} {...listeners}>⠿</button>
    {category.id === 'all-products'
      ? <><button className="category-select category-fixed-name" type="button" onClick={onSelect}>{category.name}</button><span className="category-fixed-label">Fest</span></>
      : <button className="category-select" type="button" onClick={onSelect}>{category.name}</button>}
  </div>
}

function CategoryManager({ products, onReorderProducts }: { products: Product[]; onReorderProducts: (categoryId: string, orderedIds: number[]) => Promise<void> }) {
  const [categories, setCategories] = useState<Category[]>([allProductsCategory])
  const [selectedId, setSelectedId] = useState('all-products')
  const [name, setName] = useState('')
  const [newCategoryName, setNewCategoryName] = useState('')
  const [design, setDesign] = useState(categoryDesigns[0])
  const [designSettings, setDesignSettings] = useState(defaultCategoryDesignSettings)
  const [previewMode, setPreviewMode] = useState<'products' | 'upload'>('products')
  const [selectedProducts, setSelectedProducts] = useState<number[]>([])
  const [previewFile, setPreviewFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [draggingCategoryId, setDraggingCategoryId] = useState<string | null>(null)
  const [previewImageUrl, setPreviewImageUrl] = useState('')
  const categoriesRef = useRef<Category[]>([allProductsCategory])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  useEffect(() => {
    if (!previewFile) { setPreviewImageUrl(''); return }
    const objectUrl = URL.createObjectURL(previewFile)
    setPreviewImageUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [previewFile])
  const load = async () => {
    const next = await request<Category[]>('/api/admin/categories')
    const loadedCategories = [...(next.some((category) => category.id === 'all-products') ? next : [...next, allProductsCategory])].sort((a, b) => a.sortOrder - b.sortOrder)
    categoriesRef.current = loadedCategories
    setCategories(loadedCategories)
    if (selectedId && !loadedCategories.some((category) => category.id === selectedId)) setSelectedId('')
  }
  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Kategorien konnten nicht geladen werden.')) }, [])
  const selected = categories.find((category) => category.id === selectedId)
  useEffect(() => {
    setName(selected?.name || '')
    setDesign(selected?.design || categoryDesigns[0])
    setDesignSettings(selected?.designSettings || defaultCategoryDesignSettings)
    setPreviewMode(selected?.previewMode || 'products')
    setSelectedProducts(selected?.productIds || [])
    setPreviewFile(null)
  }, [selected])
  const create = async () => {
    if (!newCategoryName.trim()) { setError('Bitte gib einen Kategorienamen ein.'); return }
    setCreating(true)
    setError('')
    try {
      const created = await request<Category>('/api/admin/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newCategoryName.trim(), design }) })
      const nextCategories = [...categoriesRef.current, created].sort((a, b) => a.sortOrder - b.sortOrder)
      categoriesRef.current = nextCategories
      setCategories(nextCategories)
      setSelectedId(created.id)
      setNewCategoryName('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Kategorie konnte nicht erstellt werden.') }
    finally { setCreating(false) }
  }
  const reorderCategoryProducts = async (categoryId: string, orderedIds: number[]) => {
    await onReorderProducts(categoryId, orderedIds)
    await load()
  }
  const save = async () => {
    if (!selected) return
    setBusy(true)
    setError('')
    const data = new FormData()
    data.append('design', design)
    if (selected.id === 'all-products') {
      try { await request(`/api/admin/categories/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ design, designSettings }) }); await load() }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Design für „Alle Produkte“ konnte nicht gespeichert werden.') }
      finally { setBusy(false) }
      return
    }
    data.append('name', name)
    data.append('designSettings', JSON.stringify(designSettings))
    data.append('previewMode', previewMode)
    data.append('productIds', JSON.stringify(selectedProducts))
    if (previewFile) data.append('previewImage', previewFile)
    try { await request(`/api/admin/categories/${selected.id}`, { method: 'PATCH', body: data }); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Kategorie konnte nicht gespeichert werden.') }
    finally { setBusy(false) }
  }
  const saveCategoryOrder = async ({ active, over }: DragEndEvent) => {
    setDraggingCategoryId(null)
    if (!over || active.id === over.id) return
    const previous = categoriesRef.current
    const oldIndex = previous.findIndex((category) => category.id === active.id)
    const newIndex = previous.findIndex((category) => category.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const reordered = arrayMove(previous, oldIndex, newIndex)
    categoriesRef.current = reordered
    setCategories(reordered)
    setError('')
    try { await request('/api/admin/categories/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderedIds: reordered.map((category) => category.id) }) }) }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Reihenfolge konnte nicht gespeichert werden.')
      categoriesRef.current = previous
      setCategories(previous)
    }
  }
  const remove = async () => {
    if (!selected || !window.confirm(`Kategorie „${selected.name}“ löschen? Die Produkte selbst bleiben erhalten.`)) return
    setDeleting(true)
    setError('')
    try { await request(`/api/admin/categories/${selected.id}`, { method: 'DELETE' }); setSelectedId(''); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Kategorie konnte nicht gelöscht werden.') }
    finally { setDeleting(false) }
  }
  const previewCategory: Category = {
    id: selected?.id || 'category-preview',
    name,
    sortOrder: selected?.sortOrder ?? categories.length,
    design,
    designSettings,
    previewMode,
    previewImageUrl: previewFile ? previewImageUrl || selected?.previewImageUrl || null : selected?.previewImageUrl || null,
    productIds: selectedProducts,
  }
  const previewProducts = selectedId === 'all-products' ? products : products.filter((product) => selectedProducts.includes(product.id))
  return <section className="admin-section category-manager">
    <div className="category-admin-layout"><div className="category-admin-list"><div className="category-list-heading"><strong>Kategorien</strong><span>{Math.max(0, categories.length - 1)} Kategorien</span></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <p className="reorder-hint">Alle Kategorien einschließlich „Alle Produkte“ am Griffpunkt ziehen, um sie anzuordnen.</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={({ active }) => setDraggingCategoryId(String(active.id))} onDragCancel={() => setDraggingCategoryId(null)} onDragEnd={(event) => { void saveCategoryOrder(event) }}>
        <SortableContext items={categories.map((category) => category.id)} strategy={verticalListSortingStrategy}>
          <div className="category-sortable-list">{categories.map((category) => <SortableCategory key={category.id} category={category} selected={category.id === selectedId} onSelect={() => setSelectedId(category.id)} />)}</div>
        </SortableContext>
        <DragOverlay>{categories.find((category) => category.id === draggingCategoryId) && <div className="category-admin-row category-admin-row-overlay"><span className="drag-handle category-drag-handle" aria-hidden="true">⠿</span><span className="category-select">{categories.find((category) => category.id === draggingCategoryId)?.name}</span></div>}</DragOverlay>
      </DndContext>
      <form className="category-create" onSubmit={(event) => { event.preventDefault(); void create() }}><label htmlFor="new-category-name">Neue Kategorie</label><input id="new-category-name" value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="Kategoriename" aria-label="Name der neuen Kategorie" maxLength={80} /><button className="primary-button" type="submit" disabled={creating} aria-busy={creating}>{creating && <span className="button-spinner" aria-hidden="true" />} {creating ? 'Wird hinzugefügt ...' : '+ Kategorie hinzufügen'}</button></form>
    </div>
      <div className={`category-editor ${selected?.id === 'all-products' ? 'all-products-editor' : ''}`}>{selected ? <>
        {selected.id === 'all-products' && <div className="fixed-category-note">„Alle Produkte“ bleibt eine feste Kategorie. Alle Kategorien nutzen das einheitliche Farbschema; du kannst hier nur das Kartenlayout ändern.</div>}
        <label className={selected.id === 'all-products' ? 'disabled-category-setting' : ''}>Kategoriename<input value={name} disabled={selected.id === 'all-products'} onChange={(event) => setName(event.target.value)} maxLength={80} /></label>
        <label>Design<select value={design} onChange={(event) => setDesign(event.target.value)}>{categoryDesigns.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <CategoryDesignPreview category={previewCategory} products={previewProducts} />
        <label className={selected.id === 'all-products' ? 'disabled-category-setting' : ''}>Vorschaubild<select disabled={selected.id === 'all-products'} value={previewMode} onChange={(event) => setPreviewMode(event.target.value as 'products' | 'upload')}><option value="products">Aus Produktbildern wechseln</option><option value="upload">Eigenes Bild hochladen</option></select></label>
        {previewMode === 'upload' && <label className={`file-drop ${selected.id === 'all-products' ? 'disabled-category-setting' : ''}`}>Kategorie-Bild<input disabled={selected.id === 'all-products'} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => setPreviewFile(event.target.files?.[0] || null)} /><span>{previewFile?.name || (selected.previewImageUrl ? 'Bild vorhanden – neues Bild auswählen zum Ersetzen' : 'Bild auswählen')}</span></label>}
        <fieldset className={`product-picker ${selected.id === 'all-products' ? 'disabled-category-setting' : ''}`} disabled={selected.id === 'all-products'}><legend>Produkte dieser Kategorie</legend>{products.length ? products.map((product) => <label key={product.id} className="product-choice"><input type="checkbox" checked={selected.id === 'all-products' || selectedProducts.includes(product.id)} onChange={(event) => setSelectedProducts((current) => event.target.checked ? [...current, product.id] : current.filter((id) => id !== product.id))} /><span>{product.name} <small>{product.status === 'unlisted' ? '· Nicht gelistet (öffentlich ausgeblendet)' : ''}</small></span></label>) : <p className="muted">Noch keine Produkte angelegt.</p>}</fieldset>
        <details className="category-product-order-accordion" key={`${selected.id}:${selected.productIds.join(',')}`}>
          <summary>Produktsortierung</summary>
          <CategoryProductOrderManager category={selected} products={selected.id === 'all-products' ? products : products.filter((product) => selected.productIds.includes(product.id))} onReorder={reorderCategoryProducts} />
        </details>
        <div className="category-editor-actions"><button className="primary-button" disabled={busy || deleting} aria-busy={busy} onClick={() => { void save() }}>{busy && <span className="button-spinner" aria-hidden="true" />} {busy ? 'Wird gespeichert ...' : selected.id === 'all-products' ? 'Design speichern' : 'Kategorie speichern'}</button>{selected.id !== 'all-products' && <button className="delete-button" disabled={deleting || busy} aria-busy={deleting} onClick={() => { void remove() }}>{deleting && <span className="button-spinner" aria-hidden="true" />} {deleting ? 'Kategorie wird gelöscht ...' : 'Kategorie löschen'}</button>}</div>
      </> : <div className="category-editor-empty"><span aria-hidden="true">↖</span><p className="muted">Wähle links eine Kategorie aus, um sie zu öffnen und zu bearbeiten.</p></div>}</div></div>
  </section>
}

function ChangeNotes() {
  const entries = [
    { date: '2026-10-20', title: 'Produkte mit Extras anpassbar machen', details: 'Extras werden im Admin-Bereich separat verwaltet und bleiben aus dem öffentlichen Katalog ausgeblendet. Für ausgewählte Produkte können Extras angeboten werden; Käufer fügen diese über „Anpassen“ optional hinzu. Extra-Preise, Warenkorb und Lagerabbuchung werden bei Bestellungen berücksichtigt.' },
    { date: '2026-10-20', title: 'Originalbilder und Admin-Rückmeldungen verbessert', details: 'Neue Produkt-Originale werden privat gespeichert und bei jeder Freistellung erneut als Quelle verwendet. Lösch- und Speicheraktionen zeigen jetzt direkt im jeweiligen Button, wenn sie noch laufen. Alle Kategorien verwenden jetzt das einheitliche Farbschema von „Alle Produkte“.' },
    { date: '2026-10-20', title: 'Kategorieverwaltung und Produktbilder verbessert', details: 'Der Kategorienfehler wurde in der API korrigiert. Produktsortierungen werden je Kategorie verwaltet, Bilder lassen sich einzeln löschen und die Freistellung läuft im Hintergrund, damit die Seite bedienbar bleibt. Die Warenkorb-Minus- und Plus-Buttons sind getauscht; Kategoriegrößen und Rahmenoptionen sind aus der Verwaltung entfernt.' },
    { date: '2026-10-20', title: 'Warenkorb und Suche flüssiger bedienbar', details: 'Der Warenkorb öffnet und schließt jetzt mit einem sanften Übergang. Suchergebnisse und Warenkorb-Schaltflächen erscheinen ruhiger; entfernte Artikel blenden sich kurz aus. Die Animationen respektieren die reduzierte Bewegung des Geräts.' },
    { date: '2026-10-20', title: 'Startseite und Warenkorb auf dem Handy verbessert', details: 'Kategorie-Karten stehen auf kleinen Displays zweispaltig und lassen sich vertikal durchscrollen. Produktbilder wechseln mit einer seitlichen Animation. Produkte können direkt in der Liste erhöht oder vollständig aus dem Warenkorb entfernt werden; nicht verfügbare weitere Stücke werden markiert.' },
    { date: '2026-10-20', title: 'Kategorie-Designs individuell anpassen', details: 'Die Kategorie-Vorschau zeigt Design- und Farbänderungen direkt. Produkte lassen sich einer Kategorie zuordnen und je Kategorie separat sortieren.' },
    { date: '2026-10-20', title: 'Produktbilder gesammelt freistellen', details: 'Im Produktbereich können alle vorhandenen Produktbilder nacheinander lokal im Browser freigestellt werden. Erfolgreich bearbeitete Shop-Bilder werden ersetzt; Fehler einzelner Bilder bleiben sichtbar.' },
    { date: '2026-10-20', title: '„Alle Produkte“ im Admin bearbeiten', details: '„Alle Produkte“ kann jetzt im Kategorie-Editor ausgewählt und im Design geändert werden. Einstellungen, die für die feste Kategorie nicht verfügbar sind, werden deaktiviert angezeigt.' },
    { date: '2026-10-20', title: 'Kategorien sortieren und Designs vorab ansehen', details: '„Alle Produkte“ kann jetzt zusammen mit den übrigen Kategorien per Drag-and-drop sortiert werden. Der Kategorieneditor zeigt eine Live-Vorschau für Kachel, Panorama und Kompakt; Admin-Interaktionen erhielten dezente Hover- und Fokus-Effekte.' },
    { date: '2026-10-19', title: 'Zurücknavigation und Admin-Bereiche verbessert', details: 'Der Handy-Zurückknopf schließt den Warenkorb und stellt die vorherige Ansicht wieder her. Die öffentliche Startseite blendet keine Kategorien-Warnung mehr ein, solange die vorhandene Kategorieansicht weiter nutzbar ist. Admin-Bereiche sind jetzt aufklappbar strukturiert.' },
    { date: '2026-10-19', title: 'Kategorien im Admin zuverlässiger anlegen', details: 'Beim Erstellen einer Kategorie werden Datenbankfehler jetzt protokolliert und fehlende Shop-Migrationen verständlich gemeldet. Nach erfolgreichem Anlegen erscheint die Kategorie direkt in der Liste.' },
    { date: '2026-10-19', title: 'Produktliste und Logo überarbeitet', details: 'Produktauflistungen sind jetzt klare, breite Zeilen mit Bild links, gut lesbaren Produktdetails und eigener Warenkorb-Schaltfläche. „Alle Produkte“ öffnet eine vollständige Ansicht statt die Liste unter den Kategorien auszuklappen. Das Logo zeigt nun den orangefarbenen Pfeil auf Dunkelblau.' },
    { date: '2026-10-19', title: 'Ladefehler und Kopfzeilen behoben', details: 'Produkte und Kategorien laden unabhängig voneinander. Vorhandene Produkte bleiben bei fehlender Shop-Migration sichtbar, und Datenbankfehler nennen jetzt den nötigen Einrichtungsschritt. Der Warenkorb nutzt dieselbe Kopfzeile wie die Startseite; der Admin-Zugang ist ein zugängliches Profilsymbol.' },
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
  return <details className="admin-accordion change-notes"><summary><span className="accordion-summary-copy"><strong>Codeänderungen</strong><small>Was sich an der Webseite geändert hat</small></span></summary><section className="change-notes-panel"><h2>Änderungen am Code</h2>{entries.map((entry) => <article key={`${entry.date}-${entry.title}`}><h3>{entry.title}</h3><time dateTime={entry.date}>{new Date(`${entry.date}T12:00:00`).toLocaleDateString('de-DE')}</time><p>{entry.details}</p></article>)}</section></details>
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
  if (!order) return <BrandLoader message="Bestellung wird geladen ..." />
  return <section className="order-details"><p className="eyebrow">Geteilte Bestellung</p><h1>Bestellung ansehen</h1><p className="muted">{new Date(order.createdAt).toLocaleString('de-DE')}</p>{order.items.map((item, index) => { const unitPrice = item.priceCents + (item.extras || []).reduce((sum, extra) => sum + extra.priceCents, 0); return <div className="cart-item" key={`${item.productId}:${index}`}><div><strong>{item.name}</strong>{(item.extras || []).map((extra) => <small key={extra.id}>+ {extra.name} · {currency.format(extra.priceCents / 100)}</small>)}</div><span>{item.quantity} × {currency.format(unitPrice / 100)}</span><strong>{currency.format(item.quantity * unitPrice / 100)}</strong></div> })}<div className="cart-total"><strong>Gesamt</strong><strong>{currency.format(order.items.reduce((total, item) => total + item.quantity * (item.priceCents + (item.extras || []).reduce((sum, extra) => sum + extra.priceCents, 0)), 0) / 100)}</strong></div>
    {order.fulfilledAt
      ? <p className="order-stock-status" role="status">Bestand wurde am {new Date(order.fulfilledAt).toLocaleString('de-DE')} abgezogen.</p>
      : <div className="order-stock-actions">{error && !confirmDeduction && <div className="form-error" role="alert">{error}</div>}<p className="muted">{hasAnswered ? 'Der Lagerbestand wurde nicht verändert.' : 'Der Lagerbestand wurde noch nicht verändert.'}</p><button className="primary-button" disabled={deducting} onClick={() => { setError(''); setConfirmDeduction(true) }}>Bestand jetzt abziehen</button></div>}
    {confirmDeduction && <div className="modal-backdrop"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="deduct-stock-title"><h2 id="deduct-stock-title">Bestellte Artikel vom Lagerbestand abziehen?</h2><p className="muted">Die Mengen dieser Bestellung werden einmalig vom Bestand abgezogen.</p>{error && <div className="form-error" role="alert">{error}</div>}<div><button className="primary-button" disabled={deducting} aria-busy={deducting} onClick={() => { void deductStock() }}>{deducting && <span className="button-spinner" aria-hidden="true" />} {deducting ? 'Bestand wird aktualisiert ...' : 'Ja'}</button><button className="secondary-button" disabled={deducting} onClick={() => { setConfirmDeduction(false); setHasAnswered(true) }}>Nein</button></div></section></div>}
  </section>
}

function AdminView({ onExit, orderToken }: { onExit: () => void; orderToken: string | null }) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [allProducts, setAllProducts] = useState<Product[]>([])
  const [extras, setExtras] = useState<Extra[]>([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [loginError, setLoginError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [backgroundJob, setBackgroundJob] = useState<{ running: boolean; completed: number; total: number; errors: string[] } | null>(null)
  const [deletingProductId, setDeletingProductId] = useState<number | null>(null)
  const [deletingImageId, setDeletingImageId] = useState<number | null>(null)
  const [imageActionError, setImageActionError] = useState('')
  const productsRef = useRef(products)
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
  useEffect(() => {
    if (!loggedIn) return
    setLoadError('')
    void load().catch((reason) => setLoadError(reason instanceof Error ? reason.message : 'Produkte konnten nicht geladen werden.'))
    void loadAllProducts()
  }, [loggedIn, search])
  useEffect(() => {
    if (!loggedIn) return
    request<Extra[]>('/api/admin/extras')
      .then(setExtras)
      .catch((reason) => setLoadError(reason instanceof Error ? reason.message : 'Extras konnten nicht geladen werden.'))
  }, [loggedIn])
  if (loggedIn === null) return <BrandLoader message="Verwaltung wird geladen ..." />
  if (!loggedIn) return <div className="login-page"><button className="back-link" onClick={onExit}>← Zur öffentlichen Seite</button><div className="login-box"><span className="login-symbol">Amspind</span><p className="eyebrow">Produktverwaltung</p><h1>Admin-Anmeldung</h1><p className="login-intro">{orderToken ? 'Diese Bestellung ist nur nach Admin-Anmeldung sichtbar.' : 'Melde dich an, um Produkte und Kategorien zu verwalten.'}</p><form onSubmit={async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }); setLoggedIn(true) } catch (e) { setLoginError(e instanceof Error ? e.message : 'Login fehlgeschlagen.') } }}><label>Benutzername<input name="username" required defaultValue="admin" /></label><label className="password-field">Passwort<div className="password-input-wrap"><input name="password" type={showPassword ? 'text' : 'password'} required /><button type="button" className="password-toggle" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}>{showPassword ? '🙈' : '👁'}</button></div></label>{loginError && <div className="form-error">{loginError}</div>}<button className="primary-button">Anmelden <span>↗</span></button></form><p className="login-note">Nur für den internen Gebrauch.</p></div></div>
  const deleteProduct = async (product: Product) => {
    if (!window.confirm(`„${product.name}“ wirklich endgültig löschen? Dieser Vorgang kann nicht rückgängig gemacht werden.`)) return
    setDeletingProductId(product.id)
    setLoadError('')
    try { await request(`/api/admin/products/${product.id}`, { method: 'DELETE' }); await load() }
    catch (reason) { setLoadError(reason instanceof Error ? reason.message : 'Produkt konnte nicht gelöscht werden.') }
    finally { setDeletingProductId(null) }
  }
  const deleteProductImage = async (imageId: number) => {
    if (typeof editing === 'string' || !editing) return
    const product = editing
    const image = product.images.find((entry) => entry.id === imageId)
    if (!image || !window.confirm(`Bild „${image.originalName}“ löschen?`)) return
    setDeletingImageId(imageId)
    setImageActionError('')
    try {
      await request(`/api/admin/products/${product.id}/images/${imageId}`, { method: 'DELETE' })
      const updated = await request<Product[]>(`/api/admin/products?search=${encodeURIComponent(product.name)}`)
      setEditing(updated.find((item) => item.id === product.id) || product)
      void loadAllProducts()
    } catch (reason) {
      setImageActionError(reason instanceof Error ? reason.message : 'Produktbild konnte nicht gelöscht werden.')
    } finally {
      setDeletingImageId(null)
    }
  }
  const processBackgroundImage = async (product: Product, image: Image) => {
    if (!image.originalUrl) throw new Error('Für dieses ältere Bild ist kein gespeichertes Original vorhanden. Neue Produktbilder bewahren das Original automatisch auf.')
    const response = await fetch(image.originalUrl)
    if (!response.ok) throw new Error(`Bild konnte nicht geladen werden (HTTP ${response.status}).`)
    const sourceBlob = await response.blob()
    const sourceFile = new File([sourceBlob], image.originalName || `produkt-${product.id}-${image.id}`, { type: sourceBlob.type || 'image/png' })
    const processedFile = await removeImageBackground(sourceFile)
    const data = new FormData()
    data.append('image', processedFile)
    await request(`/api/admin/products/${product.id}/images/${image.id}/background-removal`, { method: 'POST', body: data })
  }
  const processBackgroundImages = async (images: { product: Product; image: Image }[], confirmMessage: string) => {
    if (!images.length) {
      setLoadError('Es wurden keine noch nicht freigestellten Produktbilder gefunden.')
      return
    }
    if (!window.confirm(confirmMessage)) return

    setLoadError('')
    setBackgroundJob({ running: true, completed: 0, total: images.length, errors: [] })
    const errors: string[] = []
    for (const [index, { product, image }] of images.entries()) {
      setBackgroundJob({ running: true, completed: index, total: images.length, errors: [...errors] })
      try {
        await processBackgroundImage(product, image)
      } catch (reason) {
        errors.push(`${product.name} — ${image.originalName}: ${reason instanceof Error ? reason.message : 'Freistellen fehlgeschlagen.'}`)
      }
      setBackgroundJob({ running: true, completed: index + 1, total: images.length, errors: [...errors] })
    }

    setBackgroundJob({ running: false, completed: images.length, total: images.length, errors })
    await Promise.all([loadAllProducts(), load()]).catch((reason) => setLoadError(reason instanceof Error ? reason.message : 'Produktbilder wurden verarbeitet, aber die aktualisierte Liste konnte nicht geladen werden.'))
  }
  const removeBackgroundFromAllImages = () => {
    const images = allProducts.flatMap((product) => product.images.filter((image) => !image.backgroundRemoved).map((image) => ({ product, image })))
    return processBackgroundImages(images, `Die Hintergründe der ${images.length} noch nicht freigestellten Produktbilder werden entfernt. Bereits freigestellte Bilder bleiben unverändert. Fortfahren?`)
  }
  const refreshProductBackground = async (product: Product) => {
    await processBackgroundImages(
      product.images.map((image) => ({ product, image })),
      `Die Freistellung aller ${product.images.length} Bilder von „${product.name}“ wird anhand der gespeicherten Originale aktualisiert. Fortfahren?`,
    )
    const refreshedProducts = await request<Product[]>(`/api/admin/products?search=${encodeURIComponent(product.name)}`)
    setEditing(refreshedProducts.find((entry) => entry.id === product.id) || product)
  }
  const saveProductOrder = async (categoryId: string, orderedIds: number[]) => {
    await request(`/api/admin/categories/${encodeURIComponent(categoryId)}/products/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderedIds }) })
  }
  const pendingBackgroundImageCount = allProducts.reduce((total, product) => total + product.images.filter((image) => !image.backgroundRemoved).length, 0)
  return <div className="admin-shell">
    <header className="admin-header"><a className="brand admin-brand" href="#"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M10 24h23m-10-11 11 11-11 11" /></svg></span>Amspind</a><div className="admin-title"><strong>Produktverwaltung</strong><span>Amspind</span></div><div className="admin-actions"><button className="text-button" onClick={onExit}>Öffentliche Seite</button><button className="logout" onClick={async () => { await request('/api/auth/logout', { method: 'POST' }); setLoggedIn(false) }}>Abmelden</button></div></header>
    <main className="admin-main">
      {orderToken ? <OrderDetails token={orderToken} /> : <>
        <div className="admin-intro"><div><p className="eyebrow">Übersicht</p><h1>Verwaltung</h1><p className="muted">Produkte und Startseite an einem Ort verwalten.</p></div></div>
        <details className="admin-accordion category-accordion">
          <summary><span className="accordion-summary-copy"><strong>Startseite & Kategorien</strong><small>Kategorien erstellen, sortieren und Produkte zuordnen</small></span></summary>
          <CategoryManager products={allProducts} onReorderProducts={saveProductOrder} />
        </details>
          <details className="admin-accordion products-accordion">
            <summary><span className="accordion-summary-copy"><strong>Produkte</strong><small>{products.length} Produkte · suchen und bearbeiten</small></span></summary>
          <section className="admin-section product-management-panel"><div className="admin-panel-actions"><p className="reorder-hint">Produkte verwalten und Bilder bearbeiten.</p><div className="product-toolbar-actions"><button className="secondary-button" disabled={Boolean(backgroundJob?.running) || pendingBackgroundImageCount === 0} onClick={() => { void removeBackgroundFromAllImages() }}>{backgroundJob?.running ? `Freigestellt (${backgroundJob.completed}/${backgroundJob.total})` : `Bilder-Freistellung aktualisieren · ${pendingBackgroundImageCount}`}</button><button className="primary-button compact" onClick={() => setEditing('new')}>+ Produkt hinzufügen</button></div></div>
          {backgroundJob && <div className={`background-job-status ${backgroundJob.errors.length ? 'has-errors' : ''}`} role={backgroundJob.running ? 'status' : 'region'} aria-live="polite"><strong>{backgroundJob.running ? `Bilder werden freigestellt: ${backgroundJob.completed} von ${backgroundJob.total}` : backgroundJob.errors.length ? `Freistellen abgeschlossen: ${backgroundJob.completed - backgroundJob.errors.length} von ${backgroundJob.total} erfolgreich` : `Alle ${backgroundJob.total} Bilder wurden freigestellt.`}</strong>{backgroundJob.running && <progress max={backgroundJob.total} value={backgroundJob.completed} />}{Boolean(backgroundJob.errors.length) && <details><summary>{backgroundJob.errors.length} Bild(er) konnten nicht freigestellt werden</summary><ul>{backgroundJob.errors.slice(0, 20).map((message) => <li key={message}>{message}</li>)}</ul>{backgroundJob.errors.length > 20 && <p>Weitere {backgroundJob.errors.length - 20} Fehler ausgeblendet.</p>}</details>}</div>}
          <div className="admin-toolbar"><label className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nach Produkt suchen ..." /></label><span>{products.length} Produkte</span></div>
          {loadError && <div className="form-error" role="alert">{loadError}</div>}
          <DndContext>
            <SortableContext items={products.map((product) => product.id)} strategy={verticalListSortingStrategy}>
              <div className="admin-list">
                {products.map((product) => <SortableProduct key={product.id} product={product} disabled showDragHandle={false} deleting={deletingProductId === product.id} onEdit={() => setEditing(product)} onDelete={() => { void deleteProduct(product) }} />)}
                {products.length === 0 && !loadError && <div className="admin-empty">{search ? 'Keine Produkte für diese Suche gefunden.' : 'Noch keine Produkte vorhanden.'}</div>}
              </div>
            </SortableContext>
          </DndContext>
        </section>
        </details>
        <details className="admin-accordion extras-accordion">
          <summary><span className="accordion-summary-copy"><strong>Extras</strong><small>{extras.length} Extras · nur als Produkt-Anpassung im Shop verfügbar</small></span></summary>
          <ExtrasManager extras={extras} onChange={setExtras} />
        </details>
        <ChangeNotes />
      </>}
    </main>
    {editing && <div className="modal-backdrop"><div className="modal"><ProductForm key={editing === 'new' ? 'new' : editing.id} product={editing === 'new' ? undefined : editing} extras={extras} onCancel={() => setEditing(null)} onRefreshBackground={refreshProductBackground} backgroundBusy={Boolean(backgroundJob?.running)} onSaved={() => { setEditing(null); void load(); void loadAllProducts() }} />{editing !== 'new' && <div className="existing-images"><p className="eyebrow">Bilder verwalten</p>{imageActionError && <div className="form-error" role="alert">{imageActionError}</div>}<Gallery product={editing} admin deletingImageId={deletingImageId} onDeleteImage={(imageId) => { void deleteProductImage(imageId) }} /></div>}</div></div>}
  </div>
}

function App() {
  const orderToken = new URLSearchParams(window.location.search).get('order')
  const [admin, setAdmin] = useState(window.location.hash === '#admin' || Boolean(orderToken))
  useEffect(() => { const onHash = () => setAdmin(window.location.hash === '#admin' || Boolean(new URLSearchParams(window.location.search).get('order'))); window.addEventListener('hashchange', onHash); window.addEventListener('popstate', onHash); return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash) } }, [])
  return admin ? <AdminView orderToken={orderToken} onExit={() => { window.history.replaceState(null, '', window.location.pathname); window.location.hash = ''; setAdmin(false) }} /> : <PublicView onAdmin={() => { window.location.hash = 'admin'; setAdmin(true) }} />
}

export default App
