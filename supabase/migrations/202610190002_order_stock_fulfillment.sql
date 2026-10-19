alter table public.orders
  add column if not exists fulfilled_at timestamptz;

create or replace function public.fulfill_order(order_token text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_order public.orders%rowtype;
  order_product record;
  item_product_id bigint;
  item_quantity integer;
  current_stock integer;
begin
  select *
    into saved_order
    from public.orders
   where token = order_token
   for update;

  if not found then
    return 'not_found';
  end if;

  if saved_order.fulfilled_at is not null then
    return 'already_fulfilled';
  end if;

  if jsonb_typeof(saved_order.items) <> 'array' or jsonb_array_length(saved_order.items) = 0 then
    return 'invalid_order';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(saved_order.items) as order_items(value)
     where jsonb_typeof(value) <> 'object'
        or coalesce(value ->> 'productId', '') !~ '^[1-9][0-9]*$'
        or coalesce(value ->> 'quantity', '') !~ '^[1-9][0-9]*$'
  ) then
    return 'invalid_order';
  end if;

  for order_product in
    select (value ->> 'productId')::bigint as product_id, sum((value ->> 'quantity')::integer)::integer as quantity
      from jsonb_array_elements(saved_order.items) as order_items(value)
     group by (value ->> 'productId')::bigint
     order by (value ->> 'productId')::bigint
  loop
    item_product_id := order_product.product_id;
    item_quantity := order_product.quantity;

    select stock
      into current_stock
      from public.products
     where id = item_product_id
     for update;

    if not found then
      return 'product_missing';
    end if;

    if current_stock is null or current_stock < item_quantity then
      return 'insufficient_stock';
    end if;
  end loop;

  for order_product in
    select (value ->> 'productId')::bigint as product_id, sum((value ->> 'quantity')::integer)::integer as quantity
      from jsonb_array_elements(saved_order.items) as order_items(value)
     group by (value ->> 'productId')::bigint
     order by (value ->> 'productId')::bigint
  loop
    item_product_id := order_product.product_id;
    item_quantity := order_product.quantity;

    update public.products
       set stock = stock - item_quantity
     where id = item_product_id;
  end loop;

  update public.orders
     set fulfilled_at = now()
   where token = order_token;

  return 'fulfilled';
end;
$$;

revoke all on function public.fulfill_order(text) from public, anon, authenticated;
grant execute on function public.fulfill_order(text) to service_role;
