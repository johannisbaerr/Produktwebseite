insert into storage.buckets (id, name, public)
values ('product-originals', 'product-originals', false)
on conflict (id) do update set public = false;
