create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  proof_slug    text not null unique,
  proof_doc_id  uuid,
  title         text not null default 'Untitled',
  owner_secret  text,
  access_token  text,
  proof_url     text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists documents_created_at_idx
  on public.documents (created_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists set_updated_at on public.documents;
create trigger set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

alter table public.documents enable row level security;

drop policy if exists "documents_select_all_authenticated" on public.documents;
create policy "documents_select_all_authenticated"
  on public.documents for select
  to authenticated
  using (true);

drop policy if exists "documents_insert_authenticated" on public.documents;
create policy "documents_insert_authenticated"
  on public.documents for insert
  to authenticated
  with check (true);

drop policy if exists "documents_update_authenticated" on public.documents;
create policy "documents_update_authenticated"
  on public.documents for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "documents_delete_authenticated" on public.documents;
create policy "documents_delete_authenticated"
  on public.documents for delete
  to authenticated
  using (true);

create or replace view public.documents_public as
  select id, proof_slug, proof_doc_id, title, proof_url, created_by, created_at, updated_at
  from public.documents;

grant select on public.documents_public to anon, authenticated;
