-- Sistem Akuntansi Arus Kas Annisa Beno Cafe
-- Jalankan seluruh skrip ini di Supabase Dashboard > SQL Editor.
create extension if not exists pgcrypto;
create extension if not exists pg_cron;

create table if not exists public.kas (
  id uuid primary key default gen_random_uuid(),
  nama text not null unique check (char_length(trim(nama)) between 2 and 60),
  deskripsi text not null default '',
  warna text not null default '#8b5144' check (warna ~ '^#[0-9A-Fa-f]{6}$'),
  induk_kas_id uuid references public.kas(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.kas add column if not exists induk_kas_id uuid references public.kas(id) on delete set null;

create table if not exists public.kategori (
  id uuid primary key default gen_random_uuid(),
  nama text not null unique check (char_length(trim(nama)) between 2 and 60),
  jenis text not null check (jenis in ('masuk', 'keluar')),
  warna text not null default '#9a7551' check (warna ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transaksi (
  id uuid primary key default gen_random_uuid(),
  tanggal date not null default current_date,
  jenis text not null check (jenis in ('masuk', 'keluar', 'transfer')),
  catatan text not null check (char_length(trim(catatan)) between 2 and 180),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.transaksi drop column if exists created_by;
alter table public.transaksi drop constraint if exists transaksi_jenis_check;
alter table public.transaksi add constraint transaksi_jenis_check check (jenis in ('masuk', 'keluar', 'transfer'));

create table if not exists public.detail_transaksi (
  id uuid primary key default gen_random_uuid(),
  transaksi_id uuid not null references public.transaksi(id) on delete cascade,
  kas_id uuid not null references public.kas(id) on delete restrict,
  kategori_id uuid references public.kategori(id) on delete restrict,
  arah text check (arah in ('masuk', 'keluar')),
  nominal numeric(14, 2) not null check (nominal > 0),
  catatan text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.detail_transaksi alter column kategori_id drop not null;
alter table public.detail_transaksi add column if not exists arah text check (arah in ('masuk', 'keluar'));

create or replace function public.simpan_transfer_kas(
  p_transaksi_id uuid,
  p_tanggal date,
  p_catatan text,
  p_kas_sumber_id uuid,
  p_kas_tujuan_id uuid,
  p_nominal numeric
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_transaksi_id uuid := coalesce(p_transaksi_id, gen_random_uuid());
begin
  if p_kas_sumber_id = p_kas_tujuan_id then
    raise exception 'Kas sumber dan kas tujuan harus berbeda.';
  end if;
  if p_nominal is null or p_nominal <= 0 then
    raise exception 'Nominal transfer harus lebih besar dari nol.';
  end if;

  if p_transaksi_id is null then
    insert into public.transaksi (id, tanggal, jenis, catatan)
    values (v_transaksi_id, p_tanggal, 'transfer', trim(p_catatan));
  else
    update public.transaksi
    set tanggal = p_tanggal, catatan = trim(p_catatan), jenis = 'transfer'
    where id = v_transaksi_id;
    if not found then
      raise exception 'Transaksi transfer tidak ditemukan.';
    end if;
    delete from public.detail_transaksi where transaksi_id = v_transaksi_id;
  end if;

  insert into public.detail_transaksi (transaksi_id, kas_id, kategori_id, arah, nominal, catatan)
  values
    (v_transaksi_id, p_kas_sumber_id, null, 'keluar', p_nominal, 'Transfer keluar'),
    (v_transaksi_id, p_kas_tujuan_id, null, 'masuk', p_nominal, 'Transfer masuk');

  return v_transaksi_id;
end;
$$;

drop function if exists public.simpan_transfer_kas(uuid, date, text, uuid, uuid, numeric, uuid);

create or replace function public.transfer_saldo_kasir_harian()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_kasir_id uuid;
  v_kas_utama_id uuid;
  v_saldo numeric(14, 2);
  v_tanggal date;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('annisa-kasir-ke-kas-utama'));

  select id into v_kasir_id from public.kas where nama = 'Kasir';
  select id into v_kas_utama_id from public.kas where nama = 'Kas Utama';
  if v_kasir_id is null or v_kas_utama_id is null then
    raise exception 'Akun Kasir dan Kas Utama harus tersedia.';
  end if;
  if v_kasir_id = v_kas_utama_id then
    raise exception 'Akun Kasir dan Kas Utama harus berbeda.';
  end if;

  select coalesce(sum(
    case
      when t.jenis = 'transfer' then
        case d.arah when 'masuk' then d.nominal when 'keluar' then -d.nominal else 0 end
      when t.jenis = 'masuk' then d.nominal
      when t.jenis = 'keluar' then -d.nominal
      else 0
    end
  ), 0)::numeric(14, 2)
  into v_saldo
  from public.detail_transaksi d
  join public.transaksi t on t.id = d.transaksi_id
  where d.kas_id = v_kasir_id;

  if v_saldo <= 0 then
    return null;
  end if;

  v_tanggal := (pg_catalog.now() at time zone 'Asia/Jakarta')::date;
  return public.simpan_transfer_kas(
    null,
    v_tanggal,
    'Setoran kasir otomatis ke Kas Utama',
    v_kasir_id,
    v_kas_utama_id,
    v_saldo
  );
end;
$$;

revoke all on function public.transfer_saldo_kasir_harian() from public, anon, authenticated;

create index if not exists transaksi_tanggal_idx on public.transaksi (tanggal desc);
create index if not exists kas_induk_kas_idx on public.kas (induk_kas_id);
create index if not exists transaksi_jenis_tanggal_idx on public.transaksi (jenis, tanggal desc);
create index if not exists detail_transaksi_transaksi_idx on public.detail_transaksi (transaksi_id);
create index if not exists detail_transaksi_kas_idx on public.detail_transaksi (kas_id);
create index if not exists detail_transaksi_kategori_idx on public.detail_transaksi (kategori_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists kas_set_updated_at on public.kas;
create trigger kas_set_updated_at before update on public.kas for each row execute function public.set_updated_at();
drop trigger if exists kategori_set_updated_at on public.kategori;
create trigger kategori_set_updated_at before update on public.kategori for each row execute function public.set_updated_at();
drop trigger if exists transaksi_set_updated_at on public.transaksi;
create trigger transaksi_set_updated_at before update on public.transaksi for each row execute function public.set_updated_at();
drop trigger if exists detail_transaksi_set_updated_at on public.detail_transaksi;
create trigger detail_transaksi_set_updated_at before update on public.detail_transaksi for each row execute function public.set_updated_at();

alter table public.kas enable row level security;
alter table public.kategori enable row level security;
alter table public.transaksi enable row level security;
alter table public.detail_transaksi enable row level security;

drop policy if exists "authenticated users manage kas" on public.kas;
create policy "authenticated users manage kas" on public.kas for all to authenticated using (true) with check (true);
drop policy if exists "authenticated users manage kategori" on public.kategori;
create policy "authenticated users manage kategori" on public.kategori for all to authenticated using (true) with check (true);
drop policy if exists "authenticated users manage transaksi" on public.transaksi;
create policy "authenticated users manage transaksi" on public.transaksi for all to authenticated using (true) with check (true);
drop policy if exists "authenticated users manage detail transaksi" on public.detail_transaksi;
create policy "authenticated users manage detail transaksi" on public.detail_transaksi for all to authenticated using (true) with check (true);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.kas, public.kategori, public.transaksi, public.detail_transaksi to authenticated;
revoke all on function public.simpan_transfer_kas(uuid, date, text, uuid, uuid, numeric) from public, anon;
grant execute on function public.simpan_transfer_kas(uuid, date, text, uuid, uuid, numeric) to authenticated, service_role;

insert into public.kas (nama, deskripsi, warna, induk_kas_id) values
  ('Kas Utama', 'Saldo gabungan seluruh akun kas cafe.', '#79504a', null)
on conflict (nama) do update set induk_kas_id = null;

insert into public.kas (nama, deskripsi, warna, induk_kas_id) values
  ('Kasir', 'Penerimaan dan pembayaran harian di meja kasir.', '#a65f4d', (select id from public.kas where nama = 'Kas Utama')),
  ('Kas Operasional', 'Kebutuhan operasional rutin cafe.', '#9a7551', (select id from public.kas where nama = 'Kas Utama')),
  ('Kas Cadangan', 'Dana cadangan untuk kebutuhan mendesak.', '#667b67', (select id from public.kas where nama = 'Kas Utama'))
on conflict (nama) do update set induk_kas_id = excluded.induk_kas_id;

insert into public.kategori (nama, jenis, warna) values
  ('Penjualan', 'masuk', '#66816b'),
  ('Modal', 'masuk', '#9a7551'),
  ('Bahan baku', 'keluar', '#aa715d'),
  ('Operasional', 'keluar', '#9a7551'),
  ('Gaji', 'keluar', '#7a5960'),
  ('Lain-lain', 'keluar', '#7d817b')
on conflict (nama) do nothing;

select cron.unschedule(jobid)
from cron.job
where jobname = 'annisa-transfer-kasir-ke-utama-2359-wib';

select cron.schedule(
  'annisa-transfer-kasir-ke-utama-2359-wib',
  '59 16 * * *',
  'select public.transfer_saldo_kasir_harian();'
);
