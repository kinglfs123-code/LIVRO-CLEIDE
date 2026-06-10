/* =========================================================
   Manuscrito — app.js
   HTML + CSS + JS puro, com Supabase (Auth + Database).

   Organização do arquivo:
     1. CONFIG        -> cole sua URL e a chave anon do Supabase
     2. ESTADO        -> dados em memória durante o uso
     3. CAMADA DB     -> única parte que conversa com o Supabase
     4. UTILITÁRIOS   -> helpers de DOM, datas, toast, modal
     5. ROTEAMENTO    -> troca entre as 3 telas
     6. LOGIN
     7. BIBLIOTECA
     8. EDITOR + AUTOSAVE
     9. BOOT          -> liga tudo ao carregar a página

   Segurança: aqui só entra a chave ANON (pública). Quem protege os
   dados é o Row Level Security do Supabase — cada usuário só enxerga
   o que é dele. Nunca use a chave service_role no frontend.
   ========================================================= */

/* ===================== 1. CONFIG ===================== */
/* Pegue em: Supabase -> Project Settings -> API
   - SUPABASE_URL  = "Project URL"
   - SUPABASE_ANON_KEY = chave "anon public" */
const SUPABASE_URL = "https://sigmwtkrtboaovibbgjy.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_vmrpf_9lB_ZF81M7UicusA_nCdXxtUO";

/* Se ainda não configurou, mostra um aviso claro em vez de quebrar. */
const NOT_CONFIGURED = SUPABASE_URL.startsWith("COLE_AQUI") || SUPABASE_ANON_KEY.startsWith("COLE_AQUI");

let supabaseClient = null;
if (!NOT_CONFIGURED) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/* ===================== 2. ESTADO ===================== */
/* ÍCONES — SVG em vez de emoji: editar e excluir ficam exatamente do mesmo
   tamanho, herdam a cor do botão e respondem ao hover (inclusive o vermelho). */
const ICON = {
  edit:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19.5 3 20.5 4 16.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  plus:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};

const state = {
  user: null,
  books: [],
  currentBook: null,
  chapters: [],
  currentChapter: null,
  dirty: false,        // existe alteração não salva?
  saving: false,       // está salvando agora?
  resaveQueued: false, // digitou DURANTE um save? salva de novo ao terminar
  autosaveTimer: null, // timer do autosave (debounce)
  retryTimer: null,    // timer da retentativa após erro
  retryDelay: 0,       // backoff atual da retentativa (ms)
  savedAt: null,       // quando salvou pela última vez (timestamp)
  online: typeof navigator !== "undefined" ? navigator.onLine : true, // tem conexão?
  syncing: false,      // está drenando a fila pro servidor agora?
  authMode: "login",   // "login" ou "signup"
};
const AUTOSAVE_MS = 1500;  // salva 0,9s depois que você para de digitar
const RETRY_MIN_MS = 3000; // 1ª retentativa após erro
const RETRY_MAX_MS = 30000;// teto do backoff

/* ===================== 3. CAMADA DB (offline-first) =====================
   Estratégia:
   - Leituras: online → busca no Supabase e atualiza o espelho local;
     offline → devolve o espelho local.
   - Escritas: aplica no espelho local NA HORA (otimista), enfileira a operação
     e tenta sincronizar. Offline, a operação fica na fila até a conexão voltar.
   - IDs gerados no cliente (UUID) → linha criada offline já nasce com o id final.
   - Um usuário só → conflito resolvido por "última escrita vence".
   A API de `db` é a mesma de antes; o resto do app não muda.
   (As funções de espelho/fila/sync ficam na seção 4 pra sobreviverem ao preview.) */

// chamadas cruas ao Supabase (usadas só quando online)
const remote = {
  listBooks: () =>
    supabaseClient.from("books").select("*").order("updated_at", { ascending: false }),
  listChapters: (bookId) =>
    supabaseClient.from("chapters").select("*").eq("book_id", bookId)
      .order("order_index", { ascending: true }).order("created_at", { ascending: true }),
  listAllChapters: () => supabaseClient.from("chapters").select("*"),
};

const db = {
  // -- Auth (precisa de rede; offline o supabase-js devolve a sessão guardada) --
  async getSession() {
    const { data } = await supabaseClient.auth.getSession();
    return data.session;
  },
  signIn(email, password) { return supabaseClient.auth.signInWithPassword({ email, password }); },
  signUp(email, password) { return supabaseClient.auth.signUp({ email, password }); },
  signOut() { return supabaseClient.auth.signOut(); },
  onAuthChange(cb) { return supabaseClient.auth.onAuthStateChange(cb); },

  // drena a fila e (se deu) recarrega o espelho. Chamado ao logar/voltar a ficar online.
  async syncNow() {
    await flushQueue();
  },

  // -- Livros --
  async listBooks() {
    if (state.online) {
      try {
        const { data, error } = await remote.listBooks();
        if (!error && data) { setLocalBooks(data); return { data, error: null }; }
      } catch (_) {}
    }
    const data = localBooks().slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    return { data, error: null };
  },
  async createBook(title, description) {
    const nowIso = new Date().toISOString();
    const row = { id: newId(), user_id: currentUid(), title, description: description || "",
                  created_at: nowIso, updated_at: nowIso };
    setLocalBooks([row, ...localBooks()]);
    enqueue({ op: "insert", table: "books", id: row.id, payload: { id: row.id, title, description: description || "" } });
    flushQueue();
    return { data: row, error: null };
  },
  async updateBook(id, fields) {
    const books = localBooks();
    const i = books.findIndex((b) => b.id === id);
    let row = null;
    if (i >= 0) { row = { ...books[i], ...fields, updated_at: new Date().toISOString() }; books[i] = row; setLocalBooks(books); }
    enqueue({ op: "update", table: "books", id, payload: fields });
    flushQueue();
    return { data: row, error: null };
  },
  async deleteBook(id) {
    setLocalBooks(localBooks().filter((b) => b.id !== id));
    setLocalChapters(localChapters().filter((c) => c.book_id !== id));
    enqueue({ op: "delete", table: "books", id });
    flushQueue();
    return { error: null };
  },

  // -- Capítulos --
  async listChapters(bookId) {
    if (state.online) {
      try {
        const { data, error } = await remote.listChapters(bookId);
        if (!error && data) {
          const others = localChapters().filter((c) => c.book_id !== bookId);
          setLocalChapters([...others, ...data]);
          return { data, error: null };
        }
      } catch (_) {}
    }
    const data = localChapters().filter((c) => c.book_id === bookId)
      .sort((a, b) => (a.order_index - b.order_index) || (new Date(a.created_at) - new Date(b.created_at)));
    return { data, error: null };
  },
  async createChapter(bookId, title, orderIndex) {
    const nowIso = new Date().toISOString();
    const row = { id: newId(), user_id: currentUid(), book_id: bookId, title, content: "",
                  order_index: orderIndex, created_at: nowIso, updated_at: nowIso };
    setLocalChapters([...localChapters(), row]);
    touchLocalBook(bookId);
    enqueue({ op: "insert", table: "chapters", id: row.id,
              payload: { id: row.id, book_id: bookId, title, order_index: orderIndex } });
    flushQueue();
    return { data: row, error: null };
  },
  async updateChapter(id, fields) {
    const chs = localChapters();
    const i = chs.findIndex((c) => c.id === id);
    let row = null;
    if (i >= 0) { row = { ...chs[i], ...fields, updated_at: new Date().toISOString() }; chs[i] = row; setLocalChapters(chs); touchLocalBook(row.book_id); }
    enqueue({ op: "update", table: "chapters", id, payload: fields });
    flushQueue();
    return { data: row, error: null };
  },
  async deleteChapter(id) {
    const chs = localChapters();
    const row = chs.find((c) => c.id === id);
    setLocalChapters(chs.filter((c) => c.id !== id));
    if (row) touchLocalBook(row.book_id);
    enqueue({ op: "delete", table: "chapters", id });
    flushQueue();
    return { error: null };
  },
};

/* ===================== 4. UTILITÁRIOS ===================== */
const $ = (sel) => document.querySelector(sel);

/* ---------- offline-first: espelho local + fila + sincronização ----------
   Fica aqui (e não na seção 3) de propósito: a seção 3 é trocada por um mock
   no preview, mas estas funções precisam continuar existindo. */
const HAS_LS = (() => {
  try { const k = "__ms_test__"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; }
  catch (_) { return false; }
})();
function lsGet(key, fallback) {
  if (!HAS_LS) return fallback;
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch (_) { return fallback; }
}
function lsSet(key, val) { if (!HAS_LS) return; try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }
function lsDel(key) { if (!HAS_LS) return; try { localStorage.removeItem(key); } catch (_) {} }

function currentUid() { return (state.user && state.user.id) || "anon"; }
function nsKey(suffix) { return "manuscrito:" + currentUid() + ":" + suffix; }

function localBooks() { return lsGet(nsKey("books"), []); }
function setLocalBooks(arr) { lsSet(nsKey("books"), arr); }
function localChapters() { return lsGet(nsKey("chapters"), []); }
function setLocalChapters(arr) { lsSet(nsKey("chapters"), arr); }
function queueGet() { return lsGet(nsKey("queue"), []); }
function queueSet(arr) { lsSet(nsKey("queue"), arr); }

function touchLocalBook(bookId) {
  const books = localBooks();
  const i = books.findIndex((b) => b.id === bookId);
  if (i >= 0) { books[i] = { ...books[i], updated_at: new Date().toISOString() }; setLocalBooks(books); }
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/* Enfileira uma operação, COALESCENDO pra fila ficar mínima:
   - delete cancela ops pendentes do mesmo id (e nem precisa ir ao servidor se a linha nunca subiu)
   - update funde com um insert pendente, ou com o último update pendente do mesmo id */
function enqueue(op) {
  let q = queueGet();
  if (op.op === "delete") {
    const hadPendingInsert = q.some((o) => o.id === op.id && o.op === "insert");
    q = q.filter((o) => o.id !== op.id);
    if (!hadPendingInsert) q.push(op);
    queueSet(q); updateSyncIndicator(); return;
  }
  if (op.op === "update") {
    const ins = q.find((o) => o.id === op.id && o.op === "insert");
    if (ins) { ins.payload = { ...ins.payload, ...op.payload }; queueSet(q); updateSyncIndicator(); return; }
    const last = [...q].reverse().find((o) => o.id === op.id);
    if (last && last.op === "update") { last.payload = { ...last.payload, ...op.payload }; queueSet(q); updateSyncIndicator(); return; }
  }
  q.push(op); queueSet(q); updateSyncIndicator();
}

// aplica UMA operação no Supabase (upsert no insert = replay idempotente)
function applyOp(op) {
  const t = supabaseClient.from(op.table);
  if (op.op === "insert") return t.upsert(op.payload);
  if (op.op === "update") return t.update(op.payload).eq("id", op.id);
  if (op.op === "delete") return t.delete().eq("id", op.id);
}

// drena a fila pro servidor, em ordem. Para no 1º erro e tenta depois.
let _flushing = false;
async function flushQueue() {
  if (typeof supabaseClient === "undefined" || !supabaseClient) return; // preview / não configurado
  if (!state.online || _flushing) return;
  if (!queueGet().length) { updateSyncIndicator(); return; }

  _flushing = true; state.syncing = true; updateSyncIndicator();
  try {
    await supabaseClient.auth.getSession(); // cutuca o refresh do token, se preciso
    let q = queueGet();
    while (q.length) {
      const op = q[0];
      let res;
      try { res = await applyOp(op); } catch (e) { res = { error: e }; }
      if (res && res.error) break; // rede caiu (ou erro) → para e tenta na próxima
      q = q.slice(1); queueSet(q);
    }
  } finally {
    _flushing = false; state.syncing = false;
    updateSyncIndicator();
  }
  if (state.online && !queueGet().length) { try { await refreshSnapshot(); } catch (_) {} }
}

// recarrega TODO o espelho local a partir do servidor (livros + todos os capítulos do usuário)
async function refreshSnapshot() {
  if (typeof supabaseClient === "undefined" || !supabaseClient || !state.online) return;
  try {
    const { data: books } = await remote.listBooks();
    if (books) setLocalBooks(books);
    const { data: chapters } = await remote.listAllChapters();
    if (chapters) setLocalChapters(chapters);
  } catch (_) {}
}

// pílula de status de conexão/sincronização (canto da tela)
function updateSyncIndicator() {
  const el = $("#net-status");
  if (!el) return;
  const pending = queueGet().length;
  if (!state.online) {
    el.hidden = false; el.dataset.kind = "offline";
    el.textContent = pending
      ? "Offline · " + pending + " alteração(ões) aguardando sincronizar"
      : "Offline · suas alterações ficam salvas neste aparelho";
  } else if (state.syncing) {
    el.hidden = false; el.dataset.kind = "syncing";
    el.textContent = "Sincronizando…";
  } else {
    el.hidden = true; el.dataset.kind = "";
  }
}

// liga os ouvintes de conexão (chamado em wireEvents)
function initOffline() {
  state.online = (typeof navigator !== "undefined") ? navigator.onLine : true;
  window.addEventListener("online", () => { state.online = true; updateSyncIndicator(); flushQueue(); });
  window.addEventListener("offline", () => { state.online = false; updateSyncIndicator(); });
  // rede de segurança: tenta drenar a fila de tempos em tempos
  setInterval(() => { if (state.online && queueGet().length) flushQueue(); }, 20000);
  updateSyncIndicator();
}

// data amigável: "hoje", "ontem" ou "12 mar 2025"
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const dia = 86400000;
  const diff = Math.floor((now.setHours(0,0,0,0) - new Date(iso).setHours(0,0,0,0)) / dia);
  if (diff === 0) return "hoje";
  if (diff === 1) return "ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

let toastTimer = null;
function toast(message, isError = false) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

/* Modal de formulário (criar/editar). Campos = [{name,label,value,placeholder,textarea}] */
function openFormModal({ title, fields, confirmText = "Salvar", onConfirm }) {
  const root = $("#modal-root");
  const fieldsHtml = fields.map((f) => {
    const id = "mf-" + f.name;
    const input = f.textarea
      ? `<textarea class="input" id="${id}" placeholder="${escapeAttr(f.placeholder || "")}">${escapeHtml(f.value || "")}</textarea>`
      : `<input class="input" id="${id}" type="text" value="${escapeAttr(f.value || "")}" placeholder="${escapeAttr(f.placeholder || "")}" />`;
    return `<div class="field"><label for="${id}">${escapeHtml(f.label)}</label>${input}</div>`;
  }).join("");

  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <form id="modal-form">
          ${fieldsHtml}
          <div class="modal-actions">
            <button type="button" class="btn-ghost" id="modal-cancel">Cancelar</button>
            <button type="submit" class="btn-primary">${escapeHtml(confirmText)}</button>
          </div>
        </form>
      </div>
    </div>`;

  const close = () => { root.innerHTML = ""; };
  const first = root.querySelector(".input");
  if (first) { first.focus(); if (first.select) first.select(); }

  root.querySelector("#modal-cancel").onclick = close;
  root.querySelector(".modal-backdrop").onclick = (e) => { if (e.target.classList.contains("modal-backdrop")) close(); };
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });
  root.querySelector("#modal-form").onsubmit = (e) => {
    e.preventDefault();
    const values = {};
    fields.forEach((f) => { values[f.name] = root.querySelector("#mf-" + f.name).value.trim(); });
    close();
    onConfirm(values);
  };
}

/* Modal de confirmação (excluir) */
function openConfirm({ title, message, confirmText = "Excluir", onConfirm }) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <p class="modal-msg">${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" id="modal-cancel">Cancelar</button>
          <button type="button" class="btn-danger" id="modal-confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ""; };
  root.querySelector("#modal-cancel").onclick = close;
  root.querySelector(".modal-backdrop").onclick = (e) => { if (e.target.classList.contains("modal-backdrop")) close(); };
  root.querySelector("#modal-confirm").onclick = () => { close(); onConfirm(); };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

/* ===================== 5. ROTEAMENTO ===================== */
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("#view-" + name).classList.add("active");
}

/* ===================== 6. LOGIN ===================== */
function setAuthMessage(text, type) {
  const el = $("#auth-msg");
  el.textContent = text || "";
  el.className = "auth-msg" + (type ? " " + type : "");
}

function toggleAuthMode() {
  state.authMode = state.authMode === "login" ? "signup" : "login";
  const isLogin = state.authMode === "login";
  $("#auth-submit").textContent = isLogin ? "Entrar" : "Criar conta";
  $("#auth-toggle-text").textContent = isLogin ? "Ainda não tem conta?" : "Já tem conta?";
  $("#auth-toggle-link").textContent = isLogin ? "Criar conta" : "Entrar";
  setAuthMessage("");
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!email || !password) return;

  const btn = $("#auth-submit");
  btn.disabled = true;
  setAuthMessage(state.authMode === "login" ? "Entrando…" : "Criando conta…", "info");

  try {
    if (state.authMode === "login") {
      const { error } = await db.signIn(email, password);
      if (error) throw error;
      // o onAuthStateChange cuida de abrir a biblioteca
    } else {
      const { data, error } = await db.signUp(email, password);
      if (error) throw error;
      if (data.session) {
        setAuthMessage("Conta criada! Entrando…", "info");
      } else {
        // confirmação de e-mail provavelmente está ativa
        setAuthMessage("Conta criada. Se houver confirmação por e-mail, confirme pelo link enviado e depois entre.", "info");
        toggleAuthMode();
      }
    }
  } catch (err) {
    setAuthMessage(traduzErroAuth(err), "error");
  } finally {
    btn.disabled = false;
  }
}

function traduzErroAuth(err) {
  const m = (err && err.message ? err.message : "").toLowerCase();
  if (m.includes("invalid login")) return "E-mail ou senha incorretos.";
  if (m.includes("email not confirmed")) return "E-mail ainda não confirmado. Verifique sua caixa de entrada.";
  if (m.includes("already registered") || m.includes("already been registered")) return "Esse e-mail já tem conta. Tente entrar.";
  if (m.includes("password should be")) return "A senha precisa ter pelo menos 6 caracteres.";
  return err && err.message ? err.message : "Algo deu errado. Tente de novo.";
}

async function handleLogout() {
  await flushSave(); // garante que o capítulo atual foi salvo localmente
  if (state.online) { try { await db.syncNow(); } catch (_) {} } // empurra a fila pendente
  clearTimeout(state.autosaveTimer);
  clearTimeout(state.retryTimer);
  await db.signOut();
  // limpa estado (o espelho local NÃO é apagado, pra nunca perder algo não sincronizado)
  Object.assign(state, {
    user: null, books: [], currentBook: null, chapters: [], currentChapter: null,
    dirty: false, saving: false, resaveQueued: false, retryDelay: 0,
  });
  showView("auth");
}

/* ===================== 7. BIBLIOTECA ===================== */
async function loadLibrary() {
  showView("library");
  $("#library-greeting").textContent = state.user ? state.user.email : "";
  const { data, error } = await db.listBooks();
  if (error) { toast("Não consegui carregar seus livros.", true); return; }
  state.books = data || [];
  renderBooks();
}

function renderBooks() {
  const grid = $("#books-grid");
  const empty = $("#books-empty");
  grid.innerHTML = "";

  if (state.books.length === 0) {
    grid.hidden = true; empty.hidden = false; return;
  }
  grid.hidden = false; empty.hidden = true;

  state.books.forEach((book) => {
    const card = document.createElement("article");
    card.className = "book-card";
    card.innerHTML = `
      <span class="spine"></span>
      <div class="card-actions">
        <button class="btn-icon" data-act="edit" title="Editar" aria-label="Editar">${ICON.edit}</button>
        <button class="btn-icon danger" data-act="del" title="Excluir" aria-label="Excluir">${ICON.trash}</button>
      </div>
      <h3></h3>
      <div class="desc"></div>
      <div class="meta"></div>`;

    card.querySelector("h3").textContent = book.title || "Sem título";
    const desc = card.querySelector(".desc");
    if (book.description) { desc.textContent = book.description; }
    else { desc.textContent = "Sem descrição"; desc.classList.add("empty"); }
    card.querySelector(".meta").textContent = "Atualizado " + formatDate(book.updated_at);

    // abrir o livro ao clicar no corpo do cartão
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return; // clicou num botão de ação
      openBook(book);
    });
    card.querySelector('[data-act="edit"]').onclick = () => onEditBook(book);
    card.querySelector('[data-act="del"]').onclick = () => onDeleteBook(book);

    grid.appendChild(card);
  });
}

function onNewBook() {
  openFormModal({
    title: "Novo livro",
    fields: [
      { name: "title", label: "Título", value: "", placeholder: "Ex: O Caminho Suave" },
      { name: "description", label: "Descrição (opcional)", value: "", placeholder: "Sobre o que é o livro?", textarea: true },
    ],
    confirmText: "Criar livro",
    onConfirm: async (v) => {
      const title = v.title || "Sem título";
      const { data, error } = await db.createBook(title, v.description || "");
      if (error) { toast("Não consegui criar o livro.", true); return; }
      state.books.unshift(data);
      renderBooks();
      openBook(data); // já entra no livro recém-criado
    },
  });
}

function onEditBook(book) {
  openFormModal({
    title: "Editar livro",
    fields: [
      { name: "title", label: "Título", value: book.title || "" },
      { name: "description", label: "Descrição", value: book.description || "", placeholder: "Sobre o que é o livro?", textarea: true },
    ],
    onConfirm: async (v) => {
      const { data, error } = await db.updateBook(book.id, { title: v.title || "Sem título", description: v.description || "" });
      if (error) { toast("Não consegui salvar as alterações.", true); return; }
      // atualiza na lista e, se for o livro aberto, no editor
      const i = state.books.findIndex((b) => b.id === book.id);
      if (i >= 0) state.books[i] = data;
      if (state.currentBook && state.currentBook.id === book.id) {
        state.currentBook = data;
        $("#book-title").textContent = data.title;
      }
      renderBooks();
    },
  });
}

function onDeleteBook(book) {
  openConfirm({
    title: "Excluir livro?",
    message: `“${book.title || "Sem título"}” e todos os capítulos dele serão apagados. Essa ação não pode ser desfeita.`,
    onConfirm: async () => {
      const { error } = await db.deleteBook(book.id);
      if (error) { toast("Não consegui excluir o livro.", true); return; }
      state.books = state.books.filter((b) => b.id !== book.id);
      renderBooks();
    },
  });
}

/* ===================== 8. EDITOR + AUTOSAVE ===================== */
async function openBook(book) {
  state.currentBook = book;
  state.currentChapter = null;
  $("#book-title").textContent = book.title || "Sem título";
  showView("editor");
  showEditorEmpty(); // até escolher um capítulo

  const { data, error } = await db.listChapters(book.id);
  if (error) { toast("Não consegui carregar os capítulos.", true); return; }
  state.chapters = data || [];
  renderChapters();

  // abre o primeiro capítulo automaticamente, se houver
  if (state.chapters.length > 0) selectChapter(state.chapters[0]);
}

function renderChapters() {
  const list = $("#chapters-list");
  const empty = $("#chapters-empty");
  list.innerHTML = "";

  empty.hidden = state.chapters.length > 0;

  state.chapters.forEach((ch) => {
    const li = document.createElement("li");
    li.className = "chapter-item" + (state.currentChapter && state.currentChapter.id === ch.id ? " active" : "");
    li.dataset.id = ch.id;
    li.innerHTML = `
      <span class="ch-title"></span>
      <span class="ch-actions">
        <button class="btn-icon" data-act="edit" title="Renomear" aria-label="Renomear">${ICON.edit}</button>
        <button class="btn-icon danger" data-act="del" title="Excluir" aria-label="Excluir">${ICON.trash}</button>
      </span>`;
    li.querySelector(".ch-title").textContent = ch.title || "Sem título";

    // um clique em qualquer lugar da linha abre o capítulo
    li.addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return; // exceto nos botões de ação
      selectChapter(ch);
    });
    li.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); onRenameChapter(ch); };
    li.querySelector('[data-act="del"]').onclick = (e) => { e.stopPropagation(); onDeleteChapter(ch); };

    list.appendChild(li);
  });
}

/* Atualiza só o destaque "active" sem reconstruir a lista (evita rebuild no clique). */
function markActiveChapter() {
  const id = state.currentChapter ? String(state.currentChapter.id) : null;
  document.querySelectorAll("#chapters-list .chapter-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });
}

async function selectChapter(ch) {
  // antes de trocar, salva o que estiver pendente do capítulo atual
  await flushSave();
  clearTimeout(state.retryTimer); // cancela retry do capítulo anterior

  state.currentChapter = ch;
  markActiveChapter(); // atualiza só o destaque, sem reconstruir a lista

  // se existe rascunho local não sincronizado deste capítulo, recupera ele
  const draft = readDraft(ch.id);
  const draftIsNewer = draft &&
    ((draft.content || "") !== (ch.content || "") || (draft.title || "") !== (ch.title || ""));

  $("#chapter-title").value = draftIsNewer ? (draft.title || "")   : (ch.title || "");
  $("#editor-area").value   = draftIsNewer ? (draft.content || "") : (ch.content || "");
  showEditorActive();

  if (draftIsNewer) {
    state.dirty = true;
    setStatus("dirty");
    toast("Recuperei um rascunho não salvo deste capítulo. Sincronizando…");
    saveCurrentChapter(); // manda pro servidor já
  } else {
    state.dirty = false;
    setStatus("saved");
  }

  // foca no fim do texto
  const area = $("#editor-area");
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

function showEditorActive() {
  $("#editor-placeholder").hidden = true;
  $("#editor-top").hidden = false;
  $("#editor-body").hidden = false;
}
function showEditorEmpty() {
  $("#editor-placeholder").hidden = false;
  $("#editor-top").hidden = true;
  $("#editor-body").hidden = true;
}

async function onNewChapter() {
  if (!state.currentBook) return;
  const n = state.chapters.length + 1;
  const { data, error } = await db.createChapter(state.currentBook.id, "Capítulo " + n, state.chapters.length);
  if (error) { toast("Não consegui criar o capítulo.", true); return; }
  state.chapters.push(data);
  renderChapters();
  selectChapter(data);
}

function onRenameChapter(ch) {
  openFormModal({
    title: "Renomear capítulo",
    fields: [{ name: "title", label: "Título do capítulo", value: ch.title || "" }],
    onConfirm: async (v) => {
      const title = v.title || "Sem título";
      const { data, error } = await db.updateChapter(ch.id, { title });
      if (error) { toast("Não consegui renomear.", true); return; }
      const i = state.chapters.findIndex((c) => c.id === ch.id);
      if (i >= 0) state.chapters[i] = data;
      if (state.currentChapter && state.currentChapter.id === ch.id) {
        state.currentChapter = data;
        $("#chapter-title").value = data.title;
      }
      renderChapters();
    },
  });
}

function onDeleteChapter(ch) {
  openConfirm({
    title: "Excluir capítulo?",
    message: `“${ch.title || "Sem título"}” será apagado. Essa ação não pode ser desfeita.`,
    onConfirm: async () => {
      const { error } = await db.deleteChapter(ch.id);
      if (error) { toast("Não consegui excluir o capítulo.", true); return; }
      clearDraft(ch.id);
      state.chapters = state.chapters.filter((c) => c.id !== ch.id);
      if (state.currentChapter && state.currentChapter.id === ch.id) {
        state.currentChapter = null;
        if (state.chapters.length > 0) selectChapter(state.chapters[0]);
        else { showEditorEmpty(); renderChapters(); }
      } else {
        renderChapters();
      }
    },
  });
}

/* ---- indicador de salvamento ---- */
function setStatus(stateName) {
  const el = $("#save-status");
  const label = el.querySelector(".save-label");
  el.dataset.state = stateName;
  label.textContent = {
    saved:  "Salvo",
    dirty:  "Não salvo",
    saving: "Salvando…",
    error:  "Erro ao salvar",
  }[stateName] || "";
}

/* ---- rascunho local (rede de segurança extra, por capítulo) ----
   Espelha o texto a cada tecla. Mesmo que tudo falhe, o rascunho sobrevive
   e é recuperado ao reabrir o capítulo. Usa os helpers de storage da seção 4. */
const DRAFT_PREFIX = "manuscrito:draft:";
function saveDraft(id, fields) { lsSet(DRAFT_PREFIX + id, { ...fields, ts: Date.now() }); }
function clearDraft(id) { lsDel(DRAFT_PREFIX + id); }
function readDraft(id) { return lsGet(DRAFT_PREFIX + id, null); }

/* ---- autosave (debounce) ---- */
function onEditorInput() {
  if (!state.currentChapter) return;
  state.dirty = true;
  setStatus("dirty");
  // espelho local instantâneo (síncrono): nada se perde mesmo se fechar agora
  saveDraft(state.currentChapter.id, {
    title: $("#chapter-title").value,
    content: $("#editor-area").value,
  });
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(saveCurrentChapter, AUTOSAVE_MS);
}

async function saveCurrentChapter() {
  if (!state.currentChapter) return;
  // já está salvando? não perca o que foi digitado: marca pra salvar de novo ao terminar
  if (state.saving) { state.resaveQueued = true; return; }
  if (!state.dirty) return;

  clearTimeout(state.autosaveTimer);
  clearTimeout(state.retryTimer);
  state.saving = true;
  state.resaveQueued = false;
  setStatus("saving");

  const id = state.currentChapter.id;
  const fields = { title: $("#chapter-title").value.trim() || "Sem título", content: $("#editor-area").value };

  let result;
  try {
    result = await db.updateChapter(id, fields);
  } catch (e) {
    result = { error: e };
  }
  state.saving = false;

  if (result.error) {
    // não limpa "dirty" nem o rascunho local: tenta de novo sozinho
    setStatus("error");
    toast("Sem conexão para salvar. Suas alterações estão guardadas e vou tentar de novo.", true);
    scheduleRetry();
    return;
  }

  // sucesso: zera o backoff de retry
  state.retryDelay = 0;

  // atualiza estado/lista SEM mexer no que você está vendo no editor
  const data = result.data;
  const i = state.chapters.findIndex((c) => c.id === id);
  if (i >= 0) state.chapters[i] = data;
  const activeTitle = document.querySelector(".chapter-item.active .ch-title");
  if (activeTitle) activeTitle.textContent = data.title;

  // só considera "salvo" se nada novo entrou durante o save
  if (state.resaveQueued) {
    // digitou enquanto salvava → salva de novo a versão mais recente
    state.resaveQueued = false;
    return saveCurrentChapter();
  }
  if (state.currentChapter && state.currentChapter.id === id) state.currentChapter = data;
  state.dirty = false;
  state.savedAt = Date.now();
  clearDraft(id);            // a rede confirmou: pode descartar o rascunho local
  setStatus("saved");
}

/* Retentativa automática com backoff (3s, 6s, 12s, 24s, 30s…) enquanto a rede não volta. */
function scheduleRetry() {
  state.retryDelay = Math.min(state.retryDelay ? state.retryDelay * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => {
    if (state.dirty && state.currentChapter && !state.saving) saveCurrentChapter();
  }, state.retryDelay);
}

/* Salva imediatamente o que estiver pendente e ESPERA terminar
   (ao trocar de capítulo, voltar, sair). Aguarda inclusive um save já em andamento. */
async function flushSave() {
  // espera um save em andamento concluir (com teto de segurança ~5s)
  for (let i = 0; i < 100 && state.saving; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (state.dirty && state.currentChapter) {
    await saveCurrentChapter();
  }
}

async function backToLibrary() {
  await flushSave();
  state.currentBook = null;
  state.currentChapter = null;
  await loadLibrary();
}

/* ===================== 9. BOOT ===================== */
function wireEvents() {
  initOffline(); // ouvintes de online/offline + indicador de conexão

  // login
  $("#auth-form").addEventListener("submit", handleAuthSubmit);
  $("#auth-toggle-link").addEventListener("click", toggleAuthMode);
  $("#logout-btn").addEventListener("click", handleLogout);

  // biblioteca
  $("#new-book-btn").addEventListener("click", onNewBook);
  $("#empty-new-book-btn").addEventListener("click", onNewBook);

  // editor
  $("#back-btn").addEventListener("click", backToLibrary);
  $("#book-rename").addEventListener("click", () => { if (state.currentBook) onEditBook(state.currentBook); });
  $("#new-chapter-btn").addEventListener("click", onNewChapter);
  $("#placeholder-new-chapter-btn").addEventListener("click", onNewChapter);
  $("#save-btn").addEventListener("click", () => { state.dirty = true; saveCurrentChapter(); });

  // autosave: digitação no corpo e no título do capítulo
  $("#editor-area").addEventListener("input", onEditorInput);
  $("#chapter-title").addEventListener("input", onEditorInput);
  // ao sair do campo, salva na hora
  $("#editor-area").addEventListener("blur", flushSave);
  $("#chapter-title").addEventListener("blur", flushSave);

  // aviso antes de fechar/recarregar com alterações não salvas
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });
  // ao minimizar/trocar de aba (e no celular ao sair do app), tenta salvar
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.dirty) flushSave();
  });
}

async function boot() {
  // se não configurou o Supabase, avisa de forma clara
  if (NOT_CONFIGURED) {
    document.body.innerHTML = `
      <div style="max-width:520px;margin:14vh auto;padding:28px;font-family:system-ui,sans-serif;
                  background:#fbf8f1;border:1px solid #e4ded0;border-radius:12px;line-height:1.6;color:#221f1a">
        <h2 style="margin:0 0 10px">Falta configurar o Supabase</h2>
        <p>Abra o arquivo <strong>app.js</strong> e preencha, no topo:</p>
        <ul>
          <li><code>SUPABASE_URL</code> — o <em>Project URL</em></li>
          <li><code>SUPABASE_ANON_KEY</code> — a chave <em>anon public</em></li>
        </ul>
        <p style="color:#5b5549">Os dois ficam em: Supabase → Project Settings → API.</p>
      </div>`;
    return;
  }

  wireEvents();

  // entra no app: drena a fila pendente e aquece o espelho local (quando online)
  async function enterApp(user) {
    state.user = user;
    if (state.online) { try { await flushQueue(); await refreshSnapshot(); } catch (_) {} }
    await loadLibrary();
  }

  // reage a login/logout (inclusive renovação de sessão)
  db.onAuthChange((event, session) => {
    if (session && session.user) {
      const inApp = $("#view-library").classList.contains("active") ||
                    $("#view-editor").classList.contains("active");
      state.user = session.user;
      if (!inApp) enterApp(session.user); // não recarrega a cada refresh de token
    } else {
      state.user = null;
      showView("auth");
    }
  });

  // checa se já existe sessão salva (offline, o supabase-js devolve a sessão guardada)
  const session = await db.getSession();
  if (session && session.user) {
    enterApp(session.user);
  } else {
    showView("auth");
  }

  // registra o Service Worker (só em produção; ignorado no preview/sem config)
  if (typeof supabaseClient !== "undefined" && supabaseClient && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", boot);
