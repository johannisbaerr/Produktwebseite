import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Image = { id: number; url: string; originalName: string }
type Product = { id: number; name: string; description: string; priceCents: number; stock: number; status: 'active' | 'unlisted'; images: Image[]; updatedAt: string }

const currency = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
const emptyForm = { name: '', description: '', price: '', stock: '', status: 'active' as 'active' | 'unlisted' }
const apiBaseUrl = import.meta.env.VITE_API_URL || 'https://shop-api-c4sq.onrender.com'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${url}`, { ...options, credentials: 'include' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Etwas ist schiefgelaufen.')
  return data
}

function Gallery({ product, admin = false, onDeleteImage }: { product: Product; admin?: boolean; onDeleteImage?: (imageId: number) => void }) {
  const [selected, setSelected] = useState(0)
  const startX = useRef<number | null>(null)
  const image = product.images[selected]
  const move = (direction: number) => setSelected((current) => (current + direction + product.images.length) % product.images.length)
  return <div className="gallery"><div className="gallery-main" onTouchStart={(event) => { startX.current = event.touches[0].clientX }} onTouchEnd={(event) => { if (startX.current === null) return; const distance = event.changedTouches[0].clientX - startX.current; if (Math.abs(distance) > 35) move(distance > 0 ? -1 : 1); startX.current = null }}>
    {image ? <img src={image.url} alt={product.name} /> : <div className="image-placeholder">Kein Bild</div>}
    {product.images.length > 1 && <><button className="gallery-arrow left" aria-label="Vorheriges Bild" onClick={() => move(-1)}>←</button><button className="gallery-arrow right" aria-label="Nächstes Bild" onClick={() => move(1)}>→</button></>}
    <span className="image-count">{product.images.length ? `${selected + 1} / ${product.images.length}` : '0 Bilder'}</span>
  </div>{product.images.length > 1 && <div className="thumbnails">{product.images.map((item, index) => <div className={`thumbnail-wrap ${index === selected ? 'selected' : ''}`} key={item.id}><button className="thumbnail" onClick={() => setSelected(index)}><img src={item.url} alt={`${product.name} Ansicht ${index + 1}`} /></button>{admin && onDeleteImage && <button className="thumbnail-remove" onClick={() => onDeleteImage(item.id)} aria-label="Bild entfernen">×</button>}</div>)}</div>}</div>
}

function PublicView({ onAdmin }: { onAdmin: () => void }) {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let mounted = true
    const loadProducts = () => request<Product[]>('/api/products').then((nextProducts) => { if (mounted) setProducts(nextProducts) }).finally(() => { if (mounted) setLoading(false) })
    loadProducts()
    const refresh = window.setInterval(loadProducts, 5000)
    return () => { mounted = false; window.clearInterval(refresh) }
  }, [])
  return <div className="public-shell"><header className="site-header"><a className="brand" href="/">shop</a><nav><button className="admin-link" onClick={onAdmin}>Admin <span>↗</span></button></nav></header><main>
    <section className="collection" id="collection"><div className="section-heading"><div><p className="eyebrow">Die aktuelle Auswahl</p><h2>Produkte</h2></div><span className="product-total">{products.length.toString().padStart(2, '0')} Artikel</span></div>{loading ? <div className="loading">Produkte werden geladen ...</div> : products.length === 0 ? <div className="empty-public"><span>○</span><h3>Demnächst hier</h3><p>Unsere aktuelle Auswahl wird gerade vorbereitet.</p></div> : <div className="product-grid">{products.map((product, index) => <article className="product-card" key={product.id} style={{ animationDelay: `${index * 80}ms` }}><Gallery product={product} /><div className="product-info"><div><h3>{product.name}</h3><p>{product.description}</p></div><div className="product-price"><strong>{currency.format(product.priceCents / 100)}</strong><span className="stock-indicator">{product.stock} auf Lager</span></div></div></article>)}</div>}</section>
    </main><footer><span>shop <small>Eine Auswahl mit Haltung.</small></span><span>© {new Date().getFullYear()}</span></footer></div>
}

function ProductForm({ product, onSaved, onCancel }: { product?: Product; onSaved: () => void; onCancel?: () => void }) {
  const [form, setForm] = useState(product ? { name: product.name, description: product.description, price: (product.priceCents / 100).toFixed(2).replace('.', ','), stock: String(product.stock), status: product.status } : emptyForm)
  const [files, setFiles] = useState<FileList | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); const stockValue = Number(form.stock); if (form.status === 'active' && stockValue <= 0) { setError('Für eine aktive Anzeige muss der Lagerbestand größer als 0 sein.'); return; } setSaving(true); const data = new FormData(); data.append('name', form.name); data.append('description', form.description); data.append('priceCents', String(Math.round(Number(form.price.replace(',', '.')) * 100))); data.append('stock', form.stock); data.append('status', form.status); if (files) Array.from(files).forEach((file) => data.append('images', file)); try { await request(product ? `/api/admin/products/${product.id}` : '/api/admin/products', { method: product ? 'PATCH' : 'POST', body: data }); onSaved() } catch (e) { setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.') } finally { setSaving(false) } }
  return <form className="product-form" onSubmit={submit}><div className="form-header"><div><p className="eyebrow">{product ? 'Produkt bearbeiten' : 'Neues Produkt'}</p><h2>{product ? product.name : 'Artikel anlegen'}</h2></div>{onCancel && <button type="button" className="icon-button" onClick={onCancel} aria-label="Schließen">×</button>}</div><label>Produktname<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="z. B. Keramik Vase" /></label><label>Beschreibung<textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Was macht dieses Produkt besonders? (optional)" /></label><div className="form-row"><label>Preis in EUR<input required inputMode="decimal" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0,00" /></label><label>Lagerbestand<input required type="number" min="0" step="1" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} placeholder="0" /></label></div><label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'unlisted' })}><option value="active">Aktiv gelistet</option><option value="unlisted">Nicht gelistet</option></select></label><label className="file-drop">Produktbilder{product && <small>Bestehende Bilder bleiben erhalten. Neue Dateien werden ergänzt.</small>}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple required={!product} onChange={(e) => setFiles(e.target.files)} /><span>{files?.length ? `${files.length} Bild(er) ausgewählt` : 'Bilder auswählen oder hierher ziehen'}</span></label>{error && <div className="form-error">{error}</div>}<button className="primary-button" disabled={saving}>{saving ? 'Wird gespeichert ...' : product ? 'Änderungen speichern' : 'Produkt veröffentlichen'}</button></form>
}

function AdminView({ onExit }: { onExit: () => void }) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [loginError, setLoginError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  useEffect(() => { request('/api/auth/me').then(() => setLoggedIn(true)).catch(() => setLoggedIn(false)) }, [])
  const load = () => request<Product[]>(`/api/admin/products?search=${encodeURIComponent(search)}`).then(setProducts)
  useEffect(() => { if (loggedIn) request<Product[]>(`/api/admin/products?search=${encodeURIComponent(search)}`).then(setProducts) }, [loggedIn, search])
  if (loggedIn === null) return <div className="admin-loading">Lade ...</div>
  if (!loggedIn) return <div className="login-page"><button className="back-link" onClick={onExit}>← Zur öffentlichen Seite</button><div className="login-box"><span className="login-symbol">shop</span><p className="eyebrow">Produktverwaltung</p><h1>Admin-Anmeldung</h1><p className="login-intro">Melde dich an, um Produkte und Lagerbestand zu verwalten.</p><form onSubmit={async (event) => { event.preventDefault(); const target = event.currentTarget; const form = new FormData(target); try { await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }); setLoggedIn(true) } catch (e) { setLoginError(e instanceof Error ? e.message : 'Login fehlgeschlagen.') } }}><label>Benutzername<input name="username" required defaultValue="admin" /></label><label className="password-field">Passwort<div className="password-input-wrap"><input name="password" type={showPassword ? 'text' : 'password'} required /><button type="button" className="password-toggle" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}>{showPassword ? '🙈' : '👁'}</button></div></label>{loginError && <div className="form-error">{loginError}</div>}<button className="primary-button">Anmelden <span>↗</span></button></form><p className="login-note">Nur für den internen Gebrauch.</p></div></div>
  return <div className="admin-shell"><header className="admin-header"><a className="brand" href="#">shop</a><div className="admin-title"><strong>Produktverwaltung</strong></div><div className="admin-actions"><button className="text-button" onClick={onExit}>Öffentliche Seite</button><button className="logout" onClick={async () => { await request('/api/auth/logout', { method: 'POST' }); setLoggedIn(false) }}>Abmelden</button></div></header><main className="admin-main"><div className="admin-intro"><div><p className="eyebrow">Übersicht</p><h1>Alle Produkte</h1><p className="muted">Verwalte deine Auswahl und halte sie aktuell.</p></div><button className="primary-button compact" onClick={() => setEditing('new')}>+ Produkt hinzufügen</button></div><div className="admin-toolbar"><label className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nach Produkt suchen ..." /></label><span>{products.length} Produkte</span></div><div className="admin-list">{products.map((product) => <article className="admin-product" key={product.id}><div className="admin-thumb">{product.images[0] && <img src={product.images[0].url} alt="" />}</div><div className="admin-product-main"><div className="admin-product-title"><h3>{product.name}</h3><span className={`status ${product.status}`}>{product.status === 'active' && product.stock > 0 ? 'Aktiv' : 'Nicht gelistet'}</span></div><p>{product.description}</p><span className="admin-meta">{currency.format(product.priceCents / 100)} · {product.stock} auf Lager · {product.images.length} Bilder</span></div><div className="admin-product-actions"><button className="edit-button" onClick={() => setEditing(product)}>Bearbeiten <span>↗</span></button><button className="delete-button" onClick={async () => { if (!window.confirm(`„${product.name}“ wirklich endgültig löschen? Dieser Vorgang kann nicht rückgängig gemacht werden.`)) return; await request(`/api/admin/products/${product.id}`, { method: 'DELETE' }); load() }}>Löschen</button></div></article>)}{products.length === 0 && <div className="admin-empty">Keine Produkte gefunden.</div>}</div></main>{editing && <div className="modal-backdrop"><div className="modal"><ProductForm product={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />{editing !== 'new' && <div className="existing-images"><p className="eyebrow">Bilder verwalten</p><Gallery product={editing} admin onDeleteImage={async (imageId) => { await request(`/api/admin/products/${editing.id}/images/${imageId}`, { method: 'DELETE' }); const updated = await request<Product[]>(`/api/admin/products?search=${encodeURIComponent(editing.name)}`); setEditing(updated.find((item) => item.id === editing.id) || editing) }} /></div>}</div></div>}</div>
}

function App() { const [admin, setAdmin] = useState(window.location.hash === '#admin'); useEffect(() => { const onHash = () => setAdmin(window.location.hash === '#admin'); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash) }, []); return admin ? <AdminView onExit={() => { window.location.hash = ''; setAdmin(false) }} /> : <PublicView onAdmin={() => { window.location.hash = 'admin'; setAdmin(true) }} /> }

export default App
