alter table public.products
  add column if not exists search_terms text[] not null default '{}';

create table if not exists public.categories (
  id text primary key default gen_random_uuid()::text,
  name text not null check (char_length(name) between 1 and 80),
  sort_order integer not null default 0,
  design text not null default 'Kachel' check (design in ('Kachel', 'Panorama', 'Kompakt')),
  preview_mode text not null default 'products' check (preview_mode in ('products', 'upload')),
  preview_image text
);

insert into public.categories (id, name, sort_order, design)
values ('all-products', 'Alle Produkte', 0, 'Kachel')
on conflict (id) do nothing;

create table if not exists public.product_categories (
  category_id text not null references public.categories(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  primary key (category_id, product_id)
);

create table if not exists public.orders (
  token text primary key check (token ~ '^[a-f0-9]{48}$'),
  created_at timestamptz not null default now(),
  items jsonb not null check (jsonb_typeof(items) = 'array')
);

alter table public.categories enable row level security;
alter table public.product_categories enable row level security;
alter table public.orders enable row level security;

revoke all on public.categories, public.product_categories, public.orders from anon, authenticated;
grant all on public.categories, public.product_categories, public.orders to service_role;
grant select, update on public.products to service_role;
