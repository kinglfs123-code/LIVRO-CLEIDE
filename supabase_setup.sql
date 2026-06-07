-- =========================================================
-- Manuscrito — banco de dados (Supabase / PostgreSQL)
-- Rode TUDO de uma vez no SQL Editor do Supabase.
-- É idempotente: pode rodar de novo sem quebrar nada.
-- =========================================================

-- ---------- 1) Tabela de livros ----------
create table if not exists public.books (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null default 'Sem título',
  description text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 2) Tabela de capítulos ----------
create table if not exists public.chapters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  book_id     uuid not null references public.books(id) on delete cascade,
  title       text not null default 'Novo capítulo',
  content     text not null default '',
  order_index integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 3) Índices (deixam as buscas rápidas) ----------
create index if not exists books_user_id_idx     on public.books(user_id);
create index if not exists chapters_book_id_idx   on public.chapters(book_id);
create index if not exists chapters_user_id_idx    on public.chapters(user_id);

-- ---------- 4) updated_at automático ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''   -- evita sequestro de search_path (boa prática + linter do Supabase)
as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists trg_books_updated_at on public.books;
create trigger trg_books_updated_at
  before update on public.books
  for each row execute function public.set_updated_at();

drop trigger if exists trg_chapters_updated_at on public.chapters;
create trigger trg_chapters_updated_at
  before update on public.chapters
  for each row execute function public.set_updated_at();

-- ---------- 5) Escrever num capítulo "atualiza" a data do livro ----------
-- (assim a biblioteca mostra os livros mexidos por último no topo)
create or replace function public.touch_book_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare target_book uuid;
begin
  target_book := coalesce(new.book_id, old.book_id);
  update public.books set updated_at = now() where id = target_book;
  return coalesce(new, old);
end; $$;

drop trigger if exists trg_chapters_touch_book on public.chapters;
create trigger trg_chapters_touch_book
  after insert or update or delete on public.chapters
  for each row execute function public.touch_book_updated_at();

-- ---------- 6) Liga o Row Level Security ----------
alter table public.books    enable row level security;
alter table public.chapters enable row level security;

-- ---------- 7) Políticas: cada usuário só acessa o que é dele ----------
-- LIVROS
drop policy if exists "books_select_own" on public.books;
create policy "books_select_own" on public.books
  for select using (auth.uid() = user_id);

drop policy if exists "books_insert_own" on public.books;
create policy "books_insert_own" on public.books
  for insert with check (auth.uid() = user_id);

drop policy if exists "books_update_own" on public.books;
create policy "books_update_own" on public.books
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "books_delete_own" on public.books;
create policy "books_delete_own" on public.books
  for delete using (auth.uid() = user_id);

-- CAPÍTULOS
drop policy if exists "chapters_select_own" on public.chapters;
create policy "chapters_select_own" on public.chapters
  for select using (auth.uid() = user_id);

-- além de ser dono do capítulo, o book_id PRECISA ser de um livro seu.
-- (sem isso, dava pra "pendurar" um capítulo no livro de outra pessoa)
drop policy if exists "chapters_insert_own" on public.chapters;
create policy "chapters_insert_own" on public.chapters
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.books b
      where b.id = book_id and b.user_id = auth.uid()
    )
  );

drop policy if exists "chapters_update_own" on public.chapters;
create policy "chapters_update_own" on public.chapters
  for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.books b
      where b.id = book_id and b.user_id = auth.uid()
    )
  );

drop policy if exists "chapters_delete_own" on public.chapters;
create policy "chapters_delete_own" on public.chapters
  for delete using (auth.uid() = user_id);

-- Pronto. As tabelas estão protegidas: sem login válido, ninguém lê nada.
