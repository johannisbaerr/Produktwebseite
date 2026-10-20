alter table public.categories
  add column if not exists design_settings jsonb not null default
  '{"width":340,"height":465,"borderWidth":1,"borderColor":"#d9e1e7","backgroundColor":"#f7f9fa","textColor":"#172a3c"}'::jsonb;
