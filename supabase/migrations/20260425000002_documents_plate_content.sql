-- Add JSON content column for the Plate editor (Slate value).
-- Drop Proof-specific columns; we now own content directly.

alter table public.documents
  add column if not exists content jsonb not null default '[]'::jsonb;

-- The view references proof_slug; drop it first so the column drops succeed.
drop view if exists public.documents_public;

alter table public.documents
  drop column if exists proof_slug,
  drop column if exists proof_doc_id,
  drop column if exists owner_secret,
  drop column if exists access_token,
  drop column if exists proof_url;
create view public.documents_public as
  select id, title, created_by, created_at, updated_at
  from public.documents;
grant select on public.documents_public to anon, authenticated;

-- Enable Realtime broadcast for the documents table.
alter publication supabase_realtime add table public.documents;
