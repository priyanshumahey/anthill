alter table public.documents
  add column if not exists yjs_state text;

alter table public.documents
  add column if not exists plain_text text;
