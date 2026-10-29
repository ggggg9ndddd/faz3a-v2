-- =====================================================================
--  صندوق فزعة — قاعدة البيانات (Supabase / PostgreSQL)
--  الصق هذا الملف كامل في: Supabase → SQL Editor → New query → Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- الجداول ----------

create table if not exists public.items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text not null default '',
  icon          text not null default '📦',
  price_per_day numeric(10,3) not null default 0 check (price_per_day >= 0),
  deposit       numeric(10,3) not null default 0 check (deposit >= 0),
  total_qty     int not null default 1 check (total_qty >= 0),
  active        boolean not null default true,
  sort          int not null default 0,
  created_at    timestamptz not null default now()
);

create table if not exists public.bookings (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,
  item_id       uuid not null references public.items(id) on delete restrict,
  qty           int not null default 1 check (qty > 0),
  start_date    date not null,
  end_date      date not null,
  student_name  text not null,
  student_id    text not null,
  phone         text not null,
  notes         text not null default '',
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','delivered','returned','cancelled')),
  total_price   numeric(10,3) not null default 0,
  admin_note    text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists bookings_item_dates on public.bookings(item_id, start_date, end_date);
create index if not exists bookings_status on public.bookings(status);

-- المشرفين: أي إيميل هنا يقدر يدخل لوحة التحكم
create table if not exists public.admins (
  email text primary key
);

-- ---------- دوال مساعدة ----------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where lower(email) = lower(coalesce(auth.jwt()->>'email','')));
$$;

-- كم قطعة محجوزة من أداة خلال فترة (الأداة المسلّمة تبقى محسوبة لين ترجع حتى لو تأخرت)
create or replace function public.booked_qty(p_item uuid, p_start date, p_end date)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(sum(qty),0)::int
  from bookings
  where item_id = p_item
    and status in ('pending','approved','delivered')
    and start_date <= p_end
    and (end_date >= p_start or status = 'delivered');
$$;

-- الأدوات مع المتوفر لفترة معيّنة (للطلاب)
create or replace function public.items_availability(p_start date default current_date, p_end date default current_date)
returns table (id uuid, name text, description text, icon text, price_per_day numeric,
               deposit numeric, total_qty int, available int)
language sql stable security definer set search_path = public as $$
  select i.id, i.name, i.description, i.icon, i.price_per_day, i.deposit, i.total_qty,
         greatest(i.total_qty - booked_qty(i.id, p_start, p_end), 0)
  from items i
  where i.active
  order by i.sort, i.name;
$$;

-- إنشاء حجز (يتحقق من التوفر ويحسب السعر في السيرفر)
create or replace function public.create_booking(
  p_item uuid, p_qty int, p_start date, p_end date,
  p_name text, p_student_id text, p_phone text, p_notes text default '')
returns json language plpgsql security definer set search_path = public as $$
declare
  v_item  items;
  v_avail int;
  v_total numeric;
  v_code  text;
begin
  select * into v_item from items where id = p_item and active;
  if not found then raise exception 'الأداة غير متوفرة'; end if;
  if p_start < current_date then raise exception 'تاريخ الاستلام لازم يكون اليوم أو بعده'; end if;
  if p_end < p_start then raise exception 'تاريخ الإرجاع قبل تاريخ الاستلام'; end if;
  if p_end - p_start >= 30 then raise exception 'أقصى مدة للحجز 30 يوم'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 5 then raise exception 'الكمية لازم تكون من 1 إلى 5'; end if;
  if coalesce(trim(p_name),'') = '' or coalesce(trim(p_student_id),'') = '' or coalesce(trim(p_phone),'') = '' then
    raise exception 'عبّ الاسم والرقم الجامعي ورقم الهاتف';
  end if;

  -- قفل عشان ما يصير حجزين على نفس آخر قطعة بنفس اللحظة
  perform pg_advisory_xact_lock(hashtext(p_item::text));

  v_avail := v_item.total_qty - booked_qty(p_item, p_start, p_end);
  if v_avail < p_qty then
    raise exception 'الكمية المطلوبة غير متوفرة في هذي الفترة (المتوفر: %)', greatest(v_avail,0);
  end if;

  v_total := v_item.price_per_day * ((p_end - p_start) + 1) * p_qty;

  loop
    v_code := substr(translate(upper(encode(gen_random_bytes(12),'base64')),'+/=0O1IL',''),1,6);
    exit when length(v_code) = 6 and not exists (select 1 from bookings where code = v_code);
  end loop;

  insert into bookings (code, item_id, qty, start_date, end_date, student_name, student_id, phone, notes, total_price)
  values (v_code, p_item, p_qty, p_start, p_end, trim(p_name), trim(p_student_id), trim(p_phone), coalesce(trim(p_notes),''), v_total);

  return json_build_object('code', v_code, 'total', v_total);
end $$;

-- متابعة حجز بالرمز + رقم الهاتف (الطالب يشوف حالة حجزه بس)
create or replace function public.track_booking(p_code text, p_phone text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'code', b.code, 'status', b.status, 'item', i.name, 'icon', i.icon, 'qty', b.qty,
    'start_date', b.start_date, 'end_date', b.end_date, 'total', b.total_price, 'admin_note', b.admin_note)
  from bookings b join items i on i.id = b.item_id
  where upper(b.code) = upper(trim(p_code))
    and right(regexp_replace(b.phone,'\D','','g'), 8) = right(regexp_replace(p_phone,'\D','','g'), 8)
  limit 1;
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists bookings_touch on public.bookings;
create trigger bookings_touch before update on public.bookings
for each row execute function public.touch_updated_at();

-- ---------- الصلاحيات (RLS) ----------

alter table public.items    enable row level security;
alter table public.bookings enable row level security;
alter table public.admins   enable row level security;

drop policy if exists items_read        on public.items;
drop policy if exists items_admin_write on public.items;
drop policy if exists bookings_admin    on public.bookings;
drop policy if exists admins_read       on public.admins;

create policy items_read        on public.items    for select using (active or public.is_admin());
create policy items_admin_write on public.items    for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy bookings_admin    on public.bookings for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admins_read       on public.admins   for select to authenticated using (public.is_admin());

-- الطلاب (anon) ما يقدرون يقرون الحجوزات مباشرة — بس عبر الدوال
revoke all on function public.booked_qty(uuid,date,date) from public, anon;
grant execute on function public.items_availability(date,date) to anon, authenticated;
grant execute on function public.create_booking(uuid,int,date,date,text,text,text,text) to anon, authenticated;
grant execute on function public.track_booking(text,text) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------- أدوات مبدئية (عدّل الأسعار من لوحة التحكم) ----------

insert into public.items (name, description, icon, price_per_day, deposit, total_qty, sort)
select * from (values
  ('آلة حاسبة علمية',   'Casio fx-991 — مسموحة في أغلب الامتحانات', '🧮', 0.200, 1.000, 5, 1),
  ('كيبل Type-C',       'كيبل شحن سريع 1 متر',                       '🔌', 0.100, 0.500, 6, 2),
  ('شاحن جوال',          'رأس شاحن 20W مع كيبل',                      '⚡', 0.200, 1.000, 4, 3),
  ('باور بانك',          '10,000 mAh',                                '🔋', 0.300, 2.000, 3, 4),
  ('سماعات',             'سماعات سلكية للمحاضرات المسجّلة',          '🎧', 0.200, 1.000, 3, 5),
  ('أدوات هندسية',       'مسطرة + فرجار + منقلة',                    '📐', 0.100, 0.500, 4, 6),
  ('كيبل HDMI',          'للعروض والبريزنتيشن',                       '🖥️', 0.200, 1.000, 2, 7)
) as v(name, description, icon, price_per_day, deposit, total_qty, sort)
where not exists (select 1 from public.items);

-- =====================================================================
--  آخر خطوة: أضف إيميلات المشرفين (غيّرها لإيميلاتكم)
-- =====================================================================
-- insert into public.admins (email) values ('supervisor1@example.com'), ('supervisor2@example.com');
