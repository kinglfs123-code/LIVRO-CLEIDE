# Manuscrito

Caderno privado para escrever um livro, capítulo por capítulo. Um único usuário acessa por um link, escreve no navegador (desktop ou celular), e tudo salva sozinho — **inclusive offline**.

Stack: **HTML + CSS + JavaScript puro**, **Supabase** (Auth + Postgres), deploy na **Vercel** via interface web do GitHub. É um **PWA offline-first** (instalável, abre sem internet).

---

## Sumário

- [Arquivos e onde cada um vai](#arquivos-e-onde-cada-um-vai)
- [O que o app faz](#o-que-o-app-faz)
- [Como colocar no ar (passo a passo)](#como-colocar-no-ar-passo-a-passo)
- [As duas edições manuais](#as-duas-edições-manuais)
- [Autosave](#autosave)
- [Offline e PWA](#offline-e-pwa)
- [Segurança](#segurança)
- [Banco de dados](#banco-de-dados)
- [Decisões tomadas](#decisões-tomadas)
- [Fora do escopo (por enquanto)](#fora-do-escopo-por-enquanto)
- [Próximo passo opcional](#próximo-passo-opcional)

---

## Arquivos e onde cada um vai

**Vão para a raiz do repositório no GitHub** (são o app que a Vercel publica):

| Arquivo | O que é |
|---|---|
| `index.html` | As três telas: login, biblioteca e editor. |
| `app.css` | Tema "papel quente" (claro, acento terracota, fontes Newsreader + Hanken Grotesk). |
| `app.js` | Toda a lógica: auth, CRUD, editor, autosave e o motor offline. **Receba as credenciais aqui.** |
| `vercel.json` | Cabeçalhos de segurança + CSP. **Troque a origem do Supabase aqui.** |
| `service-worker.js` | Faz o app abrir offline (cacheia o "casco", fontes e a lib). |
| `manifest.webmanifest` | Torna o app instalável (ícone na tela inicial). |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Ícones do PWA. |

**Roda uma vez no Supabase (NÃO vai para o repo):**

| Arquivo | O que é |
|---|---|
| `supabase_setup.sql` | Cria as tabelas, gatilhos e as políticas de segurança (RLS). Idempotente: pode rodar de novo sem quebrar. |

**Só para você visualizar (NÃO vai para lugar nenhum):**

| Arquivo | O que é |
|---|---|
| `preview.html` | Versão self-contained com banco fake em memória, para conferir o visual e o fluxo. Não simula offline nem sincronização. |

---

## O que o app faz

- **Login** por e-mail e senha (Supabase Auth), com a sessão lembrada ao voltar.
- **Biblioteca**: lista seus livros; criar, renomear e excluir livro.
- **Capítulos**: criar, renomear, excluir; abrir com um clique.
- **Editor** amplo, com fonte serifada confortável.
- **Autosave** robusto, com indicador de estado (Salvo / Salvando… / Não salvo / Erro).
- **Offline**: escreve sem internet e sincroniza quando a conexão volta.
- **PWA**: instalável no celular e no desktop.

---

## Como colocar no ar (passo a passo)

1. **Crie um projeto no Supabase.**
2. No **SQL Editor**, cole e rode o `supabase_setup.sql`. Isso cria as tabelas `books` e `chapters`, os gatilhos de `updated_at` e as 8 políticas de RLS.
3. Em **Authentication → Users**, crie o seu usuário (e-mail + senha).
   - *Dica:* em **Authentication → Providers → Email**, desligue **"Confirm email"** para logar na hora sem precisar confirmar.
4. **Desligue o cadastro público** (importante — veja [Segurança](#segurança)): em **Authentication → Providers → Email** (ou **Settings**), desative **"Enable signups" / "Allow new users to sign up"**. Como é um app de um usuário só, ninguém mais deve conseguir criar conta no seu projeto.
5. Em **Authentication → URL Configuration**, defina o **Site URL** (sua URL da Vercel) e remova `localhost` dos Redirect URLs em produção.
6. Em **Project Settings → API**, copie a **Project URL** e a chave **anon public**.
7. Cole as duas no topo do `app.js` (campos `SUPABASE_URL` e `SUPABASE_ANON_KEY`).
8. No `vercel.json`, troque `SEU-PROJETO.supabase.co` pela sua origem real — **em 2 lugares**, dentro do `connect-src`.
9. Suba os arquivos do app para a **raiz do repo** no GitHub e conecte o repo à **Vercel**.

> Se algo der errado no login após o deploy, o suspeito nº 1 é o CSP: a origem do Supabase precisa estar certa no `connect-src` do `vercel.json` (passo 8).

---

## As duas edições manuais

Só existem dois lugares que você edita à mão:

1. **`app.js`** — as credenciais do Supabase (`SUPABASE_URL` e `SUPABASE_ANON_KEY`). Se esquecer, o app mostra uma tela avisando o que falta.
2. **`vercel.json`** — a origem do Supabase no `connect-src` (os 2 `SEU-PROJETO.supabase.co`).

---

## Autosave

Pensado para **nunca perder uma palavra**:

- **Debounce**: salva 1,5s depois que você para de digitar (no corpo e no título).
- **Rede de segurança local**: a cada tecla, o texto é espelhado no `localStorage` (operação síncrona e instantânea). Se a rede cair, o navegador fechar ou faltar luz, o rascunho sobrevive e é **recuperado automaticamente** ao reabrir o capítulo.
- **Save coalescente**: se você digita enquanto um salvamento está em andamento, ele guarda e salva de novo a versão mais recente ao terminar — sem o "Salvo" mentindo com texto por gravar.
- **Retry automático**: se um salvamento falha, ele tenta sozinho com backoff (3s, 6s, 12s… até 30s) até a conexão voltar.
- **Flush ao navegar/sair**: trocar de capítulo, voltar para a biblioteca, sair ou minimizar a aba (`visibilitychange`) força o salvamento do que estiver pendente. Há também aviso do navegador (`beforeunload`) se houver algo não salvo.

---

## Offline e PWA

O app funciona offline em **três camadas**:

1. **Abre offline** — o Service Worker pré-cacheia o "casco" (HTML/CSS/JS) e cacheia fontes e a lib em tempo de execução. Navegação cai para o `index.html` em cache quando não há rede.
2. **Dados disponíveis offline** — um **espelho local** (no `localStorage`) guarda todos os livros e capítulos, atualizado a cada sincronização.
3. **Escrever offline e sincronizar depois** — toda escrita é aplicada no espelho local na hora (otimista) e entra numa **fila**. Quando a conexão volta, a fila é drenada para o Supabase, em ordem. Os **IDs são gerados no cliente** (UUID), então um capítulo criado offline já nasce com o ID final — sem reconciliação. Como é um usuário só, conflito é resolvido por **"última escrita vence"**.

Uma **pílula no canto** mostra o estado: `Offline · N aguardando` ou `Sincronizando…`.

### Como testar o offline (no app publicado, não no preview)

1. Abra o app **uma vez online** (é quando o casco é cacheado e os dados baixam para o espelho).
2. DevTools → aba **Network** → **Offline** (ou modo avião no celular).
3. Recarregue: o app abre, você escreve, e a pílula mostra `Offline · N aguardando`.
4. Volte para online: ele sincroniza e a pílula some.

### ⚠️ Dois pontos operacionais

1. **O primeiro acesso precisa ser online.** É nele que o casco é cacheado e os dados baixam. Depois disso, offline funciona.
2. **A cada deploy com mudança, suba a versão do cache.** No `service-worker.js`, troque `"manuscrito-v1"` por `v2`, `v3`, e assim por diante. Isso força o Service Worker a reinstalar e descartar o cache antigo — **sem isso, o usuário fica preso na versão anterior.**

---

## Segurança

Resumo da revisão feita (com olhos de atacante). A base é sólida; o que importava foi endurecido.

**Já corrigido no código:**
- **RLS é a fronteira de segurança.** A chave `anon` fica no front (correto — ela é pública por design), então **toda** a proteção dos dados está nas políticas de RLS. Elas cobrem as 4 operações (select/insert/update/delete) nas duas tabelas, e o `user_id` é preenchido pelo banco (`default auth.uid()`), nunca pelo cliente.
- **Capítulo só entra em livro seu.** As políticas de `insert`/`update` de capítulo verificam, via `EXISTS`, que o `book_id` pertence ao usuário (bloqueia "pendurar" capítulo no livro de outra pessoa).
- **Funções com `search_path` fixo** (`security invoker` + `set search_path = ''`) — boa prática e some o alerta do Security Advisor.
- **Cabeçalhos de segurança + CSP** no `vercel.json`: anti-clickjacking (`X-Frame-Options: DENY`), `nosniff`, HSTS, Referrer-Policy e um CSP que **permite o Supabase, as fontes e a lib** (e libera o Service Worker a cacheá-los).
- **Sem `service_role` no front**, sem injeção de SQL (o supabase-js parametriza tudo), sem XSS (todo dado de usuário vai via `textContent`/`.value`, e os modais passam por escape).

**Você faz no painel do Supabase (não dá para pôr em código):**
- **Desligar o cadastro público** (passo 4 do deploy). Sem isso, qualquer pessoa com a chave `anon` cria conta no seu projeto e consome sua cota.
- **Definir Site URL / allowlist de redirect** (passo 5).

**Pendência opcional (cadeia de suprimentos):** o supabase-js vem do `cdn.jsdelivr.net` sem versão fixa nem SRI. Ver [Próximo passo opcional](#próximo-passo-opcional).

---

## Banco de dados

Duas tabelas, com RLS ligada e o usuário só enxergando o que é dele.

**`books`**: `id` (uuid, PK), `user_id` (default `auth.uid()`), `title`, `description`, `created_at`, `updated_at`.

**`chapters`**: `id` (uuid, PK), `user_id` (default `auth.uid()`), `book_id` (FK → books, `on delete cascade`), `title`, `content`, `order_index`, `created_at`, `updated_at`.

**Gatilhos:** `set_updated_at` mantém `updated_at` nas duas tabelas; `touch_book_updated_at` atualiza o `updated_at` do livro quando um capítulo muda (a biblioteca ordena por escrita mais recente).

**RLS:** 8 políticas (select/insert/update/delete por tabela). As de capítulo também exigem que o `book_id` seja de um livro do próprio usuário.

> O `supabase_setup.sql` é idempotente — roda de novo sem quebrar.

---

## Decisões tomadas

- **Nome:** "Manuscrito" (fácil de renomear).
- **Visual:** tema único claro "papel quente" — acento terracota (`#9c4a2f`), serifa **Newsreader** para títulos e corpo, **Hanken Grotesk** para a interface. Sem modo escuro (para manter simples).
- **Arquitetura:** toda conversa com o Supabase isolada numa camada `db` — o resto do app não sabe que é Supabase. Isso também torna o preview trivial.
- **Storage offline:** **`localStorage`** em vez de IndexedDB (mais simples, e o texto de um livro cabe folgado). Dá para migrar a mesma lógica para IndexedDB se os dados crescerem muito.
- **Logout não apaga o espelho local** — para nunca perder algo ainda não sincronizado.
- **Recuperação de rascunho é automática** (restaura e sincroniza sem perguntar). Dá para trocar por um "Recuperar / Descartar" se você preferir.

---

## Fora do escopo (por enquanto)

Decididos como **não agora**: IA, templates, colaboração/comentários, marketplace, assinatura, painel complexo, multiusuário avançado, editor rich-text, reordenação de capítulos por arrastar.

---

## Próximo passo opcional

**Auto-hospedar o supabase-js** no repo (em vez de carregar do jsdelivr). Isso:
- torna o cache offline 100% confiável (a lib passa a ser do mesmo domínio);
- fecha o item de cadeia de suprimentos da revisão de segurança (sem dependência de CDN externo, sem versão flutuante).

É a única coisa pendente para deixar o projeto "redondo".
