create table if not exists public.category_product_order (
  category_id text not null references public.categories(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (category_id, product_id)
);

insert into public.category_product_order (category_id, product_id, sort_order)
select
  pc.category_id,
  pc.product_id,
  row_number() over (
    partition by pc.category_id
    order by p.updated_at desc, p.id asc
  )::integer - 1
from public.product_categories pc
join public.products p on p.id = pc.product_id
on conflict (category_id, product_id) do nothing;

insert into public.category_product_order (category_id, product_id, sort_order)
select 'all-products', p.id,
  row_number() over (order by p.updated_at desc, p.id asc)::integer - 1
from public.products p
on conflict (category_id, product_id) do nothing;

alter table public.category_product_order enable row level security;
revoke all on public.category_product_order from anon, authenticated;
grant all on public.category_product_order to service_role;
