/*
  GesPul - index.js
  Rebuilt from scratch incorporating:
  - Robust schedule parsing and timestamp storage (scheduleTs)
  - Improved manager dashboard rendering (sorting, expired highlights)
  - Enhanced WhatsApp integration (using employee phone if available)
  - "Undo" functionality for schedule removal
  - Consolidated and cleaned-up core application logic
  - Improved login experience (error messages, button states)
*/

// --- CONFIGURAÇÃO E ESTADO ---
const SYSTEM_PASSWORD = "1234"; // Senha padrão — usada apenas se appState.systemPassword ainda não existir
const STORAGE_KEY = "pulso_app_v1"; // Chave para dados antigos em localStorage (para migração)

// --- INDEXEDDB (idb UMD - Biblioteca externa) ---
const DB_NAME = "pulso_db";
const DB_VERSION = 1;
const DB_STORE = "appState";
let db = null; // A instância do banco de dados IndexedDB

// Estado central da aplicação
let appState = {
  centralStock: 0, // Estoque de pulseiras de venda
  stockOwner: 0, // Estoque de pulseiras de proprietário
  stockDayUser: 0, // Estoque de pulseiras de day user
  totalCash: 0, // Dinheiro acumulado de acertos passados (caixa bruto)
  pricePerUnit: 15.0, // Preço de venda por unidade (dinâmico)
  currentSettleId: null, // ID do funcionário sendo acertado no momento
  pendingDistribute: null, // Dados temporários para o modal de distribuição/entrega
  currentScheduleId: null, // ID do funcionário sendo agendado no momento
  employees: [], // Lista de funcionários
  bandConfig: null, // Configuração de nomes e cores das pulseiras
  stockLogs: [], // Histórico de movimentação do estoque central
  history: [], // Logs de acertos financeiros
  cashWithdrawals: [], // Retiradas registradas do caixa
  stockAlertThreshold: 20, // Limite para alerta visual de estoque baixo
};

// Variáveis de Paginação (para o histórico)
let currentPage = 1;
const ITEMS_PER_PAGE = 15;

// Instâncias dos gráficos Chart.js (necessário para destruir antes de recriar)
let chartInstances = {};

// Mapa temporário para agendamentos removidos (para a função "Desfazer")
const pendingScheduleRemovals = new Map();

// --- PROTEÇÃO CONTRA DUPLO CLIQUE / OPERAÇÕES CONCORRENTES ---
let _operationInProgress = false;
function _acquireLock() {
  if (_operationInProgress) return false;
  _operationInProgress = true;
  return true;
}
function _releaseLock() {
  _operationInProgress = false;
}

// --- PROTEÇÃO CONTRA MÚLTIPLAS ABAS ---
// Duas abas abertas simultâneas corrompem o estado: cada aba tem seu próprio
// appState em memória e a última a salvar sobrescreve a outra silenciosamente.
// Esta função bloqueia a segunda aba antes que qualquer operação seja realizada.

const _TAB_LS_KEY       = "pulso_active_tab";
const _TAB_HEARTBEAT_MS = 2000;  // atualiza presença a cada 2s
const _TAB_STALE_MS     = 5000;  // aba é considerada encerrada após 5s sem heartbeat

let _myTabId       = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
let _heartbeatTimer = null;
let _tabChannel     = null;

function _readTabRecord() {
  try { return JSON.parse(localStorage.getItem(_TAB_LS_KEY)); }
  catch (_) { return null; }
}

function _writeTabRecord() {
  localStorage.setItem(_TAB_LS_KEY, JSON.stringify({ id: _myTabId, ts: Date.now() }));
}

function _showDuplicateTabOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "duplicate-tab-overlay";
  overlay.style.cssText = [
    "position:fixed;inset:0;z-index:9999;",
    "background:#0f172a;display:flex;align-items:center;justify-content:center;padding:1.5rem;",
  ].join("");
  overlay.innerHTML = `
    <div style="text-align:center;color:#f8fafc;max-width:420px;">
      <div style="font-size:2.5rem;margin-bottom:1rem;color:#f59e0b;">&#9888;</div>
      <h2 style="font-size:1.125rem;font-weight:700;margin-bottom:0.5rem;">
        Sistema já está aberto em outra aba
      </h2>
      <p style="color:#94a3b8;line-height:1.6;margin-bottom:0.5rem;font-size:0.875rem;">
        Manter duas abas abertas simultaneamente pode causar
        <strong style="color:#f87171;">perda de dados e inconsistência no estoque</strong>.
      </p>
      <p style="color:#64748b;font-size:0.75rem;margin-bottom:1.5rem;">
        Feche a outra aba e recarregue esta página para continuar.
      </p>
      <button
        onclick="location.reload()"
        style="background:#4f46e5;color:white;padding:0.625rem 1.5rem;border-radius:0.5rem;border:none;cursor:pointer;font-size:0.875rem;font-weight:600;"
      >
        Usar esta aba
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function initTabGuard() {
  // 1. Verifica se já existe outra aba com heartbeat recente
  const existing = _readTabRecord();
  if (existing && existing.id !== _myTabId && Date.now() - existing.ts < _TAB_STALE_MS) {
    _showDuplicateTabOverlay();
    return; // não registra heartbeat — esta aba está bloqueada
  }

  // 2. Registra presença e inicia heartbeat
  _writeTabRecord();
  _heartbeatTimer = setInterval(_writeTabRecord, _TAB_HEARTBEAT_MS);

  // 3. BroadcastChannel: detecta outra aba abrindo APÓS esta
  if (window.BroadcastChannel) {
    _tabChannel = new BroadcastChannel("pulso_v1");
    // Anuncia presença para abas já abertas
    _tabChannel.postMessage({ type: "tab_opened", id: _myTabId });
    _tabChannel.onmessage = (e) => {
      if (e.data.type === "tab_opened" && e.data.id !== _myTabId) {
        // Outra aba acabou de abrir — avisa, mas não bloqueia (a outra aba se bloqueará)
        showToast(
          "Atenção: o sistema foi aberto em outra aba. Feche-a imediatamente para evitar perda de dados.",
          "warning"
        );
      }
    };
  }

  // 4. StorageEvent: fallback para navegadores sem BroadcastChannel
  window.addEventListener("storage", (e) => {
    if (e.key !== _TAB_LS_KEY || !e.newValue) return;
    try {
      const d = JSON.parse(e.newValue);
      if (d.id !== _myTabId) {
        showToast(
          "Atenção: o sistema foi aberto em outra aba. Feche-a para evitar inconsistências.",
          "warning"
        );
      }
    } catch (_) {}
  });

  // 5. Libera o lock ao fechar a aba
  window.addEventListener("beforeunload", () => {
    clearInterval(_heartbeatTimer);
    _tabChannel?.close();
    const current = _readTabRecord();
    if (current?.id === _myTabId) localStorage.removeItem(_TAB_LS_KEY);
  });
}

// --- IDs ÚNICOS PARA LOGS ---
// Combina timestamp com sequencial para evitar colisão em operações no mesmo ms
let _logSeq = 0;
function nextLogId() {
  return Date.now() * 1000 + (_logSeq++ % 1000);
}

// --- ACESSORES DE ESTOQUE E SALDO DE OPERADOR ---
// Centralizam o mapeamento tipo → campo, eliminando blocos if/else repetidos.
// Retrocompatíveis: leem/escrevem nos mesmos campos do appState de sempre.

const STOCK_FIELD   = { sales: "centralStock", owner: "stockOwner",    dayUser: "stockDayUser"   };
const BALANCE_FIELD = { sales: "received",     owner: "receivedOwner", dayUser: "receivedDayUser" };

function getStockByType(type)         { return appState[STOCK_FIELD[type]] ?? 0; }
function setStockByType(type, value)  { appState[STOCK_FIELD[type]] = value; }
function addStockByType(type, delta)  { setStockByType(type, getStockByType(type) + delta); }

function getEmpBalance(emp, type)         { return emp[BALANCE_FIELD[type]] ?? 0; }
function setEmpBalance(emp, type, value)  { emp[BALANCE_FIELD[type]] = value; }
function addEmpBalance(emp, type, delta)  { setEmpBalance(emp, type, getEmpBalance(emp, type) + delta); }

// --- CAMADA DE VALIDAÇÃO ---
// Funções puras que retornam null (ok) ou string de erro. Sem efeitos colaterais.

const Validation = {
  canAdjust(type, delta) {
    if (!Number.isInteger(delta) || delta === 0)   return "Informe uma quantidade válida.";
    if (!appState.bandConfig[type])                return "Tipo de pulseira inválido.";
    if (getStockByType(type) + delta < 0)          return "A correção não pode deixar o estoque negativo.";
    return null;
  },

  canDistribute(type, amount, empId) {
    if (!Number.isInteger(amount) || amount <= 0)  return "Quantidade inválida.";
    if (!appState.bandConfig[type])                return "Tipo de pulseira inválido.";
    if (!appState.employees.find(e => e.id === empId)) return "Funcionário não encontrado.";
    if (getStockByType(type) < amount)
      return `Estoque de ${appState.bandConfig[type].name} insuficiente (disponível: ${getStockByType(type)}).`;
    return null;
  },

  canSettle(snapshot, returns) {
    for (const type of ["sales", "owner", "dayUser"]) {
      const ret = returns[type] ?? 0;
      if (!Number.isInteger(ret) || ret < 0)       return "Quantidade de devolução inválida.";
      if (ret > snapshot[type])                    return "Verifique as quantidades de devolução. Não podem ser maiores que o recebido.";
    }
    return null;
  },
};

// --- SERVIÇO DE ESTOQUE ---
// Toda a lógica de negócio fica aqui: sem DOM, sem UI, sem salvar.
// Os handlers chamam o serviço e tratam erros com showToast.

const StockService = {

  adjust(type, delta) {
    const error = Validation.canAdjust(type, delta);
    if (error) throw new Error(error);
    addStockByType(type, delta);
    addStockLog(type, delta, delta > 0 ? "Entrada Manual" : "Ajuste Manual", "Via Configurações");
  },

  distribute(type, empId, amount) {
    const error = Validation.canDistribute(type, amount, empId);
    if (error) throw new Error(error);
    const employee = appState.employees.find(e => e.id === empId);
    addStockByType(type, -amount);
    addEmpBalance(employee, type, amount);
    addStockLog(type, -amount, "Distribuição", `Entregue para ${employee.name}`, empId);
    return employee;
  },

  collect(empId) {
    const employee = appState.employees.find(e => e.id === empId);
    if (!employee) throw new Error("Funcionário não encontrado.");
    for (const type of ["sales", "owner", "dayUser"]) {
      const qty = getEmpBalance(employee, type);
      if (qty > 0) {
        addStockByType(type, qty);
        setEmpBalance(employee, type, 0);
        addStockLog(type, qty, "Recolhimento", `Devolvido por ${employee.name}`, empId);
      }
    }
    return employee;
  },

  settle(employee, snapshot, returns) {
    // Rejeita se o saldo mudou desde a abertura do modal (distribuição concorrente)
    for (const type of ["sales", "owner", "dayUser"]) {
      if (getEmpBalance(employee, type) !== snapshot[type]) {
        throw new Error(
          "O saldo deste funcionário foi alterado desde a abertura do acerto. Feche e reabra o modal."
        );
      }
    }

    const error = Validation.canSettle(snapshot, returns);
    if (error) throw new Error(error);

    const soldCount = snapshot.sales - returns.sales;
    const moneyDue  = soldCount * appState.pricePerUnit;

    appState.totalCash = (appState.totalCash || 0) + moneyDue;
    setEmpBalance(employee, "sales",   returns.sales);
    setEmpBalance(employee, "owner",   returns.owner);
    setEmpBalance(employee, "dayUser", returns.dayUser);

    return { soldCount, moneyDue };
  },
};

// --- VERIFICAÇÃO DE INTEGRIDADE ---
// Detecta saldos negativos no startup e loga no console. Não altera dados.

function verifyStockIntegrity() {
  const issues = [];
  for (const type of ["sales", "owner", "dayUser"]) {
    const qty = getStockByType(type);
    if (qty < 0) issues.push(`Estoque central de "${appState.bandConfig[type]?.name}" negativo: ${qty}`);
  }
  for (const emp of appState.employees) {
    for (const type of ["sales", "owner", "dayUser"]) {
      const bal = getEmpBalance(emp, type);
      if (bal < 0) issues.push(`Saldo negativo: ${emp.name} / ${appState.bandConfig[type]?.name}: ${bal}`);
    }
  }
  if (issues.length > 0) {
    console.warn("[Pulso] Inconsistências detectadas:\n" + issues.join("\n"));
  }
  return issues;
}

// --- CAMADA DE ACESSO AO INDEXEDDB (utiliza a biblioteca idb) ---

/**
 * Abre (ou cria) o banco IndexedDB.
 * Chamada uma única vez no init().
 */
async function initDB() {
  try {
    db = await idb.openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(DB_STORE)) {
          database.createObjectStore(DB_STORE);
        }
      },
    });
  } catch (err) {
    console.error("[IndexedDB] Falha ao abrir o banco:", err);
    db = null; // Garante que db é null se a abertura falhar
  }
}

/**
 * Carrega o appState salvo no IndexedDB.
 * Retorna o objeto ou null se não houver dados.
 */
async function loadFromDB() {
  if (!db) return null;
  try {
    return (await db.get(DB_STORE, "current")) ?? null;
  } catch (err) {
    console.error("[IndexedDB] Falha ao carregar dados:", err);
    return null;
  }
}

/**
 * Persiste o appState atual no IndexedDB.
 * É um método "fire-and-forget" — não bloqueia a UI.
 */
async function saveToDB() {
  if (!db) return;
  try {
    await db.put(DB_STORE, appState, "current");
  } catch (err) {
    console.error("[IndexedDB] Falha ao salvar dados:", err);
    // Fallback de emergência: tenta localStorage e avisa o usuário
    try {
      localStorage.setItem(STORAGE_KEY + "_emergency", JSON.stringify(appState));
      // Avisa visualmente — o usuário precisa saber que o armazenamento principal falhou
      showToast(
        "Falha no armazenamento principal (IndexedDB). Dados salvos temporariamente. Faça um backup agora.",
        "warning"
      );
    } catch (e) {
      console.error("[IndexedDB] Falha TOTAL — nenhum armazenamento disponível:", e);
      // Re-lança para que os handlers (confirmSettle, etc.) possam capturar e informar o usuário
      throw new Error(
        "Falha crítica ao salvar dados: armazenamento indisponível. Faça um backup e recarregue a página."
      );
    }
  }
}

/**
 * Migração única: se existir dados no localStorage (versão antiga),
 * importa para o IndexedDB e apaga a entrada legada do localStorage.
 */
async function migrateFromLocalStorage() {
  const legacy = localStorage.getItem(STORAGE_KEY);
  if (!legacy) return null;
  try {
    const parsed = JSON.parse(legacy);
    await db.put(DB_STORE, parsed, "current");
    localStorage.removeItem(STORAGE_KEY);
    console.info("[Migração] Dados do localStorage migrados para IndexedDB.");
    return parsed;
  } catch (err) {
    console.error("[Migração] Falha ao migrar dados:", err);
    return null;
  }
}

// --- UTILITÁRIOS DE DATA ---

/**
 * Converte timestamp (ms) para o formato "YYYY-MM-DDTHH:MM" do datetime-local.
 * Elimina a necessidade de armazenar scheduleDate junto com scheduleTs.
 */
function tsToDatetimeLocal(ts) {
  if (!ts) return "";
  const d   = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Faz parsing robusto de uma string vinda de <input type="datetime-local"> ("YYYY-MM-DDTHH:MM").
 * Retorna um objeto { dateObj: Date, ts: number (timestamp) } ou null caso inválido.
 */
function parseDatetimeLocal(val) {
  if (!val || typeof val !== "string") return null;
  // Espera o formato "YYYY-MM-DDTHH:MM" ou "YYYY-MM-DDTHH:MM:ss"
  const parts = val.split("T");
  if (parts.length < 2) return null;

  const datePart = parts[0];
  const timePart = parts[1].split(".")[0]; // Remove possíveis segundos fracionados

  const d = datePart.split("-").map((n) => parseInt(n, 10));
  const t = timePart.split(":").map((n) => parseInt(n, 10));

  if (d.length !== 3 || t.length < 2) return null;

  const [year, month, day] = d;
  const [hour, minute] = t;

  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  )
    return null;

  // month - 1 porque o mês em Date é 0-indexed
  const dateObj = new Date(year, month - 1, day, hour, minute);
  // Se o Date objeto for inválido (e.g. data inexistente), getTime() retorna NaN
  if (isNaN(dateObj.getTime())) return null;

  return { dateObj: dateObj, ts: dateObj.getTime() };
}

// --- INICIALIZAÇÃO DA APLICAÇÃO ---
async function init() {
  await initDB(); // 1. Abre o banco IndexedDB
  let savedData = await loadFromDB(); // 2. Tenta carregar dados do IndexedDB

  // 3. Se não há dados no IDB, verifica se existe legado no localStorage
  if (!savedData) {
    savedData = await migrateFromLocalStorage();
  }

  // 4. Aplica os dados carregados ao appState
  if (savedData) {
    appState = savedData;
  }

  // 5. Migração/inicialização de novos campos para garantir compatibilidade
  if (!Array.isArray(appState.employees)) appState.employees = [];
  if (!appState.history) appState.history = [];
  if (!appState.stockLogs) appState.stockLogs = [];
  if (!appState.cashWithdrawals) appState.cashWithdrawals = [];
  if (appState.pricePerUnit === undefined) appState.pricePerUnit = 15.0;
  if (appState.stockOwner === undefined) appState.stockOwner = 0;
  if (appState.stockDayUser === undefined) appState.stockDayUser = 0;
  if (appState.stockAlertThreshold === undefined) appState.stockAlertThreshold = 20;
  if (!appState.systemPassword) appState.systemPassword = SYSTEM_PASSWORD;

  // Garante a configuração de bandas, caso não exista
  if (!appState.bandConfig) {
    appState.bandConfig = {
      sales: { name: "Venda", color: "blue", label: "Azul" },
      owner: { name: "Proprietário", color: "yellow", label: "Amarela" },
      dayUser: { name: "Day User", color: "purple", label: "Roxa" },
    };
  }

  // Migração: garante que todos os campos dos funcionários existam,
  // inclusive em backups gerados por versões anteriores do sistema.
  appState.employees.forEach((emp) => {
    if (emp && emp.scheduleDate && !emp.scheduleTs) {
      const dtParsed = parseDatetimeLocal(emp.scheduleDate);
      if (dtParsed) emp.scheduleTs = dtParsed.ts;
    }
    if (emp && emp.phone === undefined) emp.phone = "";
    // Garante saldo de pulseiras zerado para tipos adicionados após o cadastro
    if (emp && emp.receivedOwner  === undefined) emp.receivedOwner  = 0;
    if (emp && emp.receivedDayUser === undefined) emp.receivedDayUser = 0;
  });

  // Configurar event listeners
  const loginInput = document.getElementById("login-password");
  if (loginInput) {
    loginInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") attemptLogin();
    });
    loginInput.addEventListener("input", () => {
      const errorEl = document.getElementById("login-error");
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
      }
    });
  }

  const loginButton =
    document.getElementById("login-submit") || document.getElementById("login-btn");
  if (loginButton) {
    loginButton.addEventListener("click", attemptLogin);
  }

  const toggleBtn = document.getElementById("toggle-password-visibility");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const p = document.getElementById("login-password");
      if (!p) return;
      if (p.type === "password") {
        p.type = "text";
        toggleBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
        toggleBtn.setAttribute("aria-label", "Ocultar senha");
      } else {
        p.type = "password";
        toggleBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
        toggleBtn.setAttribute("aria-label", "Mostrar senha");
      }
    });
  }

  const loginToggleBtn = document.getElementById("login-toggle-password");
  if (loginToggleBtn) {
    loginToggleBtn.addEventListener("click", () => {
      const p = document.getElementById("login-password");
      if (!p) return;
      const icon = loginToggleBtn.querySelector("i");
      if (p.type === "password") {
        p.type = "text";
        icon.className = "fa-solid fa-eye-slash";
      } else {
        p.type = "password";
        icon.className = "fa-solid fa-eye";
      }
    });
  }

  const empNameInput = document.getElementById("new-emp-name");
  if (empNameInput) {
    empNameInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") addEmployee();
    });
  }

  const distAmountInput = document.getElementById("distribute-amount");
  if (distAmountInput) {
    distAmountInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") openDistributeModal();
    });
  }

  const stockInput = document.getElementById("add-stock-input");
  if (stockInput) {
    stockInput.addEventListener("keydown", (e) => {
      if (
        e.key.length === 1 &&
        /[a-zA-Z]/.test(e.key) &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
      }
    });
  }

  // Carregar Tema Salvo
  if (localStorage.getItem("theme") === "dark") {
    document.body.classList.add("dark-mode");
    updateThemeIcon();
  }

  // Verificar se já está logado (Sessão)
  if (sessionStorage.getItem("isLoggedIn") === "true") {
    showManagerView();
  } else {
    showLoginView();
  }

  // Inicializar input de threshold de alerta de estoque
  const thresholdInput = document.getElementById("stock-alert-threshold");
  if (thresholdInput) thresholdInput.value = appState.stockAlertThreshold;

  // Atualizar ano do rodapé automaticamente
  const yearSpan = document.getElementById("current-year");
  if (yearSpan) yearSpan.innerText = new Date().getFullYear();

  initTabGuard();        // Bloqueia segunda aba antes de qualquer operação
  verifyStockIntegrity(); // Detecta saldos negativos após migração; loga no console
  renderAll();
}

// --- TEMA (DARK MODE) ---
function toggleTheme() {
  document.body.classList.toggle("dark-mode");
  const isDark = document.body.classList.contains("dark-mode");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  updateThemeIcon();
}

function updateThemeIcon() {
  const icon = document.getElementById("theme-icon");
  if (!icon) return;
  if (document.body.classList.contains("dark-mode")) {
    icon.className = "fa-solid fa-sun text-xl text-yellow-300";
  } else {
    icon.className = "fa-solid fa-moon text-xl";
  }
}

// --- AUTENTICAÇÃO ---

// Controle de tentativas de login (lockout progressivo)
const _MAX_LOGIN_ATTEMPTS = 5;
const _LOCKOUT_MS = 30000; // 30 segundos

function _getLoginAttempts() {
  return parseInt(sessionStorage.getItem("_la") || "0", 10);
}
function _getLockoutEnd() {
  return parseInt(sessionStorage.getItem("_le") || "0", 10);
}
function _recordFailedLogin() {
  const n = _getLoginAttempts() + 1;
  sessionStorage.setItem("_la", String(n));
  if (n >= _MAX_LOGIN_ATTEMPTS) {
    sessionStorage.setItem("_le", String(Date.now() + _LOCKOUT_MS));
  }
}
function _resetLoginAttempts() {
  sessionStorage.removeItem("_la");
  sessionStorage.removeItem("_le");
}

/**
 * Tenta fazer login com a senha fornecida.
 * Exibe feedback visual e de texto para senha incorreta.
 * Bloqueia por 30s após 5 tentativas erradas consecutivas.
 */
function attemptLogin() {
  const input = document.getElementById("login-password");
  const btn =
    document.getElementById("login-submit") || // ID atual
    document.getElementById("login-btn"); // ID para compatibilidade antiga
  const errorEl = document.getElementById("login-error");
  if (!input || !btn) return;

  // Verifica lockout ativo antes de qualquer processamento
  const lockoutEnd = _getLockoutEnd();
  if (lockoutEnd > Date.now()) {
    const secsLeft = Math.ceil((lockoutEnd - Date.now()) / 1000);
    if (errorEl) {
      errorEl.textContent = `Muitas tentativas incorretas. Aguarde ${secsLeft}s para tentar novamente.`;
      errorEl.classList.remove("hidden");
    }
    input.classList.add("shake");
    setTimeout(() => input.classList.remove("shake"), 300);
    return;
  }

  // Campo vazio não conta como tentativa — apenas avisa o usuário
  if (!input.value) {
    if (errorEl) {
      errorEl.textContent = "Digite a senha para continuar.";
      errorEl.classList.remove("hidden");
      setTimeout(() => {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
      }, 3000);
    }
    input.focus();
    return;
  }

  if (btn.disabled) return; // Impede envios múltiplos
  btn.disabled = true;
  btn.classList.add("opacity-50", "cursor-not-allowed");
  const prevText = btn.innerHTML; // Salva o texto original do botão
  btn.innerHTML = "Entrando...";

  // Pequeno delay para que o estado do botão seja renderizado antes da checagem
  setTimeout(() => {
    if (input.value === (appState.systemPassword || SYSTEM_PASSWORD)) {
      _resetLoginAttempts(); // Limpa contador de falhas ao acertar
      sessionStorage.setItem("isLoggedIn", "true");
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
      }
      input.value = ""; // Limpa o campo de senha
      showManagerView();
    } else {
      _recordFailedLogin();
      const attemptsUsed = _getLoginAttempts();
      const remaining = _MAX_LOGIN_ATTEMPTS - attemptsUsed;
      const isLocked = remaining <= 0;

      const msg = isLocked
        ? `Acesso bloqueado por ${_LOCKOUT_MS / 1000}s após ${_MAX_LOGIN_ATTEMPTS} tentativas incorretas.`
        : `Senha incorreta. ${remaining} tentativa(s) restante(s).`;

      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.classList.remove("hidden");
      }
      input.classList.add("shake"); // Animação de "tremida"
      setTimeout(() => input.classList.remove("shake"), 300);

      input.value = ""; // Limpa o campo de senha
      input.focus(); // Retorna o foco para o campo de senha

      // Limpa a mensagem de erro após alguns segundos (apenas se não for lockout)
      if (!isLocked) {
        setTimeout(() => {
          if (errorEl) {
            errorEl.textContent = "";
            errorEl.classList.add("hidden");
          }
        }, 3000);
      }
    }

    // Restaura o botão ao estado original
    btn.disabled = false;
    btn.classList.remove("opacity-50", "cursor-not-allowed");
    btn.innerHTML = prevText;
  }, 220); // Pequeno atraso para a UX
}

function logout() {
  sessionStorage.removeItem("isLoggedIn");
  // Os contadores de tentativa de login (_la, _le) são preservados intencionalmente.
  // Removê-los aqui permitiria resetar o lockout via logout — o que anularia a proteção.
  showLoginView();
}

function showManagerView() {
  const vLogin = document.getElementById("view-login");
  const vManager = document.getElementById("view-manager");
  const navLogout = document.getElementById("nav-logout-btn");
  if (vLogin) vLogin.classList.add("hidden");
  if (vManager) vManager.classList.remove("hidden");
  if (navLogout) navLogout.classList.remove("hidden");
  showTab("dashboard"); // Sempre retorna ao Dashboard ao logar
  // Avisa sobre backup atrasado uma vez por sessão (com delay para a UI estar pronta)
  setTimeout(checkBackupWarning, 800);
}

/**
 * Exibe aviso de backup se o último backup foi há mais de 3 dias (ou nunca foi feito).
 * Mostra apenas uma vez por sessão para não ser invasivo.
 */
function checkBackupWarning() {
  if (sessionStorage.getItem("_bwShown")) return; // Já mostrou nesta sessão

  const hasData = appState.history.length > 0 || appState.employees.length > 0;
  if (!hasData) return; // Sem dados, sem aviso

  const lastBackup = parseInt(localStorage.getItem("lastBackup") || "0", 10);
  const THREE_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // Avisa após 7 dias sem backup

  if (lastBackup > 0 && (Date.now() - lastBackup) < THREE_DAYS_MS) return; // Backup recente

  sessionStorage.setItem("_bwShown", "1"); // Marca como mostrado nesta sessão

  const diasStr = lastBackup === 0
    ? "Nenhum backup realizado ainda"
    : `Último backup há ${Math.floor((Date.now() - lastBackup) / 86400000)} dia(s)`;

  showToast(`${diasStr}. Recomendamos salvar seus dados.`, "warning", "Fazer Backup", exportData);
}

function showLoginView() {
  const vLogin = document.getElementById("view-login");
  const vManager = document.getElementById("view-manager");
  const navLogout = document.getElementById("nav-logout-btn");
  if (vManager) vManager.classList.add("hidden");
  if (vLogin) vLogin.classList.remove("hidden");
  if (navLogout) navLogout.classList.add("hidden");
}

/**
 * Persiste o estado e atualiza a UI.
 * @param {Function} [renderFn] - Função de render específica. Se omitida, chama renderAll().
 */
async function saveData(renderFn) {
  if (typeof renderFn === "function") renderFn();
  else renderAll();
  // Aguarda confirmação do IndexedDB antes de retornar.
  // Callers críticos (confirmSettle, confirmDistribute, confirmCashWithdrawal)
  // devem usar "await saveData(...)" para garantir persistência antes do feedback de sucesso.
  await saveToDB();
}

// --- LÓGICA DE NEGÓCIO ---

/**
 * Atualiza o preço unitário das pulseiras de venda.
 */
function updatePrice() {
  const input = document.getElementById("config-price-input");
  const newPrice = parseFloat(input.value);
  if (newPrice > 0) {
    appState.pricePerUnit = newPrice;
    saveData(() => { renderManagerDashboard(); });
    showToast(
      `Preço unitário atualizado para ${formatCurrency(newPrice)}`,
      "success",
    );
  } else {
    showToast("O preço deve ser um valor maior que zero.", "error");
  }
}

/**
 * Adiciona um registro de movimentação ao histórico de estoque.
 * @param {string} typeKey - Chave do tipo de pulseira (ex: 'sales', 'owner', 'dayUser').
 * @param {number} amount - Quantidade movimentada.
 * @param {string} action - Descrição da ação (ex: "Compra", "Distribuição").
 * @param {string} details - Detalhes adicionais.
 */
function addStockLog(typeKey, amount, action, details, empId = null) {
  const config = appState.bandConfig[typeKey];
  appState.stockLogs.unshift({
    id: nextLogId(), // ID único: timestamp × 1000 + seq (não usar para filtro de data)
    ts: Date.now(),  // Timestamp puro para filtros de data — retrocompatível com logs antigos
    date: new Date().toLocaleString("pt-BR"),
    item: config.name,
    amount: amount,
    action: action,
    details: details,
    empId: empId,    // ID do operador envolvido; null em ajustes manuais
  });
}

/**
 * Adiciona ou corrige o estoque central de pulseiras.
 */
function addToStock() {
  const input = document.getElementById("add-stock-input");
  const typeSelect = document.getElementById("add-stock-type");
  const amount = parseInt(input.value, 10);
  const type = typeSelect.value;

  if (isNaN(amount) || amount === 0) {
    showToast("Informe uma quantidade válida para adicionar/remover.", "warning");
    return;
  }

  try {
    StockService.adjust(type, amount);
    const config = appState.bandConfig[type];
    showToast(
      `${amount > 0 ? "Adicionado" : "Corrigido/Removido"} ${Math.abs(amount)} pulseiras de ${config.name} (${config.label}).`,
      "success",
    );
    input.value = "";
    saveData(() => { renderStockInfo(); });
  } catch (err) {
    showToast(err.message, "error");
  }
}

/**
 * Adiciona um novo funcionário.
 */
function addEmployee() {
  const input = document.getElementById("new-emp-name");
  const phoneInput = document.getElementById("new-emp-phone");
  const name = input.value.trim();

  if (!name) {
    showToast("O nome do funcionário não pode ser vazio.", "warning");
    return;
  }

  // Validação de duplicidade (case-insensitive)
  const exists = appState.employees.some(
    (e) => e.name.toLowerCase() === name.toLowerCase(),
  );
  if (exists) {
    showToast("Já existe um funcionário cadastrado com este nome.", "error");
    return;
  }

  // Telefone: opcional — se preenchido, exige mínimo 8 dígitos numéricos
  const rawPhone = phoneInput ? phoneInput.value.trim() : "";
  if (rawPhone && rawPhone.replace(/\D/g, "").length < 8) {
    showToast("Telefone inválido. Informe ao menos 8 dígitos ou deixe em branco.", "warning");
    return;
  }

  const newId =
    appState.employees.length > 0
      ? Math.max(...appState.employees.map((e) => e.id)) + 1
      : 1;

  appState.employees.push({
    id: newId,
    name: name,
    phone: rawPhone,
    received: 0,        // saldo Venda
    receivedOwner: 0,   // saldo Proprietário
    receivedDayUser: 0, // saldo Day User
    scheduleDate: undefined,
    scheduleTs: undefined,
  });

  input.value = "";
  if (phoneInput) phoneInput.value = "";
  saveData(() => { renderManagerDashboard(); renderEmployeeSelects(); renderEmployeeSummary(); });
  showToast(`Funcionário "${name}" adicionado com sucesso!`, "success");
}

/**
 * Abre o modal de distribuição, com validação prévia de inputs e estoque.
 */
function openDistributeModal() {
  const select = document.getElementById("distribute-select");
  const input = document.getElementById("distribute-amount");
  const typeSelect = document.getElementById("distribute-type");

  const empId = parseInt(select.value, 10);
  const amount = parseInt(input.value, 10);
  const type = typeSelect.value;

  if (isNaN(empId) || !empId || isNaN(amount) || amount <= 0) {
    showToast("Selecione um funcionário e uma quantidade válida para distribuir.", "warning");
    return;
  }

  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  // Validação de negócio feita pelo StockService dentro de confirmDistribute()
  appState.pendingDistribute = { empId, amount, type, empName: employee.name };
  confirmDistribute();
}

function closeDistributeModal() {
  document.getElementById("distribute-modal").classList.add("hidden");
  appState.pendingDistribute = null; // Limpa o estado temporário
}

/**
 * Confirma a distribuição de pulseiras, debitando do estoque central e creditando ao funcionário.
 */
async function confirmDistribute() {
  if (!appState.pendingDistribute) return;
  if (!_acquireLock()) {
    showToast("Operação em andamento, aguarde.", "warning");
    return;
  }
  const { empId, amount, type } = appState.pendingDistribute;
  const config = appState.bandConfig[type];

  try {
    const employee = StockService.distribute(type, empId, amount);

    const distAmountEl = document.getElementById("distribute-amount");
    const distSelectEl = document.getElementById("distribute-select");
    if (distAmountEl) distAmountEl.value = "";
    if (distSelectEl) distSelectEl.value = "";

    appState.pendingDistribute = null;
    await saveData(() => { renderManagerDashboard(); renderEmployeeSummary(); });
    showToast(`${amount} pulseiras de ${config.name} distribuídas para ${employee.name}.`, "success");
  } catch (err) {
    appState.pendingDistribute = null;
    console.error("[confirmDistribute]", err);
    showToast(err.message || "Erro ao registrar a distribuição. Recarregue a página.", "error");
  } finally {
    _releaseLock();
  }
}

// --- LÓGICA DO MODAL DE ACERTO ---

/**
 * Abre o modal de acerto para um funcionário específico, preenchendo seus dados atuais.
 */
function openSettleModal(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  const recSales = employee.received || 0;
  const recOwner = employee.receivedOwner || 0;
  const recDay = employee.receivedDayUser || 0;

  if (recSales === 0 && recOwner === 0 && recDay === 0) {
    showToast("Este funcionário não tem pulseiras para acertar.", "warning");
    return;
  }

  appState.currentSettleId = empId;

  // Snapshot imutável do saldo no momento da abertura do modal.
  // Usado em confirmSettle() para detectar distribuições concorrentes.
  appState.currentSettleSnapshot = { sales: recSales, owner: recOwner, dayUser: recDay };

  document.getElementById("modal-emp-name").innerText = employee.name;
  document.getElementById("modal-got-sales").innerText = recSales;
  document.getElementById("modal-got-owner").innerText = recOwner;
  document.getElementById("modal-got-day").innerText = recDay;

  // Reseta os inputs de devolução e prévias
  document.getElementById("modal-ret-sales").value = "";
  document.getElementById("modal-ret-owner").value = "";
  document.getElementById("modal-ret-day").value = "";
  document.getElementById("modal-sold-preview").innerText = "0";
  document.getElementById("modal-pay-preview").innerText = "R$ 0,00";

  // Oculta colunas de tipos onde o funcionário não recebeu nenhuma pulseira
  const colSales = document.getElementById("settle-col-sales");
  const colOwner = document.getElementById("settle-col-owner");
  const colDay   = document.getElementById("settle-col-day");
  const colGrid  = document.getElementById("settle-cols-grid");
  if (colSales) colSales.classList.toggle("hidden", recSales === 0);
  if (colOwner) colOwner.classList.toggle("hidden", recOwner === 0);
  if (colDay)   colDay.classList.toggle("hidden", recDay === 0);
  if (colGrid) {
    const visible = [recSales > 0, recOwner > 0, recDay > 0].filter(Boolean).length;
    colGrid.className = colGrid.className.replace(/grid-cols-\d/, `grid-cols-${Math.max(1, visible)}`);
  }

  // Lógica de Agendamento no Acerto: mostra/oculta opção de "marcar como concluído"
  const scheduleOption = document.getElementById("modal-settle-schedule-option");
  const scheduleCheckbox = document.getElementById("modal-settle-schedule-check");

  if (employee.scheduleDate || employee.scheduleTs) {
    scheduleOption.classList.remove("hidden");
    if (scheduleCheckbox) scheduleCheckbox.checked = true; // Marcado por padrão para facilitar
  } else {
    scheduleOption.classList.add("hidden");
    if (scheduleCheckbox) scheduleCheckbox.checked = false;
  }

  document.getElementById("settle-modal").classList.remove("hidden");
}

function closeSettleModal() {
  document.getElementById("settle-modal").classList.add("hidden");
  appState.currentSettleId = null;
  appState.currentSettleSnapshot = null;
}

/**
 * Calcula e exibe os totais no modal de acerto com base nas devoluções.
 */
function calculateModalTotals() {
  const empId = appState.currentSettleId;
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  const retSalesInput = document.getElementById("modal-ret-sales").value;
  const retOwnerInput = document.getElementById("modal-ret-owner").value;
  const retDayInput = document.getElementById("modal-ret-day").value;

  const returnedSales = retSalesInput === "" ? 0 : parseInt(retSalesInput, 10);
  const returnedOwner = retOwnerInput === "" ? 0 : parseInt(retOwnerInput, 10);
  const returnedDay = retDayInput === "" ? 0 : parseInt(retDayInput, 10);

  const recSales = employee.received || 0;
  const recOwner = employee.receivedOwner || 0;
  const recDay = employee.receivedDayUser || 0;

  // Validação visual para todos os tipos (não permite devolver mais do que pegou ou valores negativos)
  if (
    returnedSales < 0 ||
    returnedSales > recSales ||
    returnedOwner < 0 ||
    returnedOwner > recOwner ||
    returnedDay < 0 ||
    returnedDay > recDay
  ) {
    document.getElementById("modal-pay-preview").innerText = "Valor Inválido";
    document.getElementById("modal-sold-preview").innerText = "-";
    return;
  }

  const sold = recSales - returnedSales;
  const totalPay = sold * appState.pricePerUnit;

  document.getElementById("modal-sold-preview").innerText = sold;
  document.getElementById("modal-pay-preview").innerText =
    formatCurrency(totalPay);
}

/**
 * Confirma o acerto de contas com o funcionário, atualizando saldos e histórico.
 */
async function confirmSettle() {
  if (!_acquireLock()) {
    showToast("Operação em andamento, aguarde.", "warning");
    return;
  }
  try {
    const empId = appState.currentSettleId;
    const employee = appState.employees.find((e) => e.id === empId);
    if (!employee) return; // finally libera o lock

    const retSales = parseInt(document.getElementById("modal-ret-sales").value, 10) || 0;
    const retOwner = parseInt(document.getElementById("modal-ret-owner").value, 10) || 0;
    const retDay   = parseInt(document.getElementById("modal-ret-day").value, 10)   || 0;

    const snapshot = appState.currentSettleSnapshot ?? {
      sales:   getEmpBalance(employee, "sales"),
      owner:   getEmpBalance(employee, "owner"),
      dayUser: getEmpBalance(employee, "dayUser"),
    };
    const returns = { sales: retSales, owner: retOwner, dayUser: retDay };

    let result;
    try {
      result = StockService.settle(employee, snapshot, returns);
    } catch (err) {
      showToast(err.message, err.message.includes("alterado") ? "warning" : "error");
      return; // finally libera o lock
    }

    const { soldCount, moneyDue } = result;
    const recSales  = snapshot.sales;
    const recOwner  = snapshot.owner;
    const recDay    = snapshot.dayUser;
    const usedOwner = recOwner - retOwner;
    const usedDay   = recDay   - retDay;

    appState.history.unshift({
      id: nextLogId(),
      date: new Date().toLocaleString("pt-BR"),
      empName: employee.name,
      sold: soldCount,
      details: `Venda: ${soldCount} | Prop: ${usedOwner} | Day: ${usedDay}`,
      total: moneyDue,
      recSales, retSales, soldCount,
      recOwner, retOwner, usedOwner,
      recDay,   retDay,   usedDay,
      pricePerUnit: appState.pricePerUnit,
    });

    const scheduleCheckbox = document.getElementById("modal-settle-schedule-check");
    if ((employee.scheduleDate || employee.scheduleTs) && scheduleCheckbox && scheduleCheckbox.checked) {
      delete employee.scheduleDate;
      delete employee.scheduleTs;
    }

    // await garante que o IndexedDB confirmou a escrita ANTES de fechar o modal e mostrar sucesso.
    // Se saveData() lançar (falha total de armazenamento), o catch externo captura e informa o usuário.
    await saveData(() => { renderManagerDashboard(); renderHistory(); renderEmployeeSummary(); });
    closeSettleModal();
    showToast(
      moneyDue > 0
        ? `Acerto realizado — cobrar ${formatCurrency(moneyDue)}`
        : `Acerto com ${employee.name} concluído.`,
      "success"
    );
  } catch (err) {
    console.error("[confirmSettle] Erro inesperado:", err);
    showToast(
      err.message || "Erro ao salvar o acerto. Recarregue a página para restaurar o estado anterior.",
      "error"
    );
  } finally {
    _releaseLock(); // SEMPRE libera — independente de sucesso, falha ou exceção inesperada
  }
}

/**
 * Remove um funcionário, após validação e confirmação.
 */
async function removeEmployee(empId) {
  const emp = appState.employees.find((e) => e.id === empId);
  if (!emp) return;

  const totalPending =
    (emp.received || 0) + (emp.receivedOwner || 0) + (emp.receivedDayUser || 0);

  if (totalPending > 0) {
    showToast(
      `Não é possível remover ${emp.name} pois ele(a) ainda possui ${totalPending} pulseiras em mãos. Faça o acerto ou recolha as pulseiras antes de excluir.`,
      "error",
    );
    return;
  }

  if (
    await showConfirm("Tem certeza que deseja remover este funcionário?", {
      type: "danger",
      title: "Remover Funcionário",
      confirmText: "Sim, remover",
    })
  ) {
    appState.employees = appState.employees.filter((e) => e.id !== empId);
    saveData(() => { renderManagerDashboard(); renderEmployeeSelects(); renderEmployeeSummary(); });
    showToast("Funcionário removido com sucesso.", "success");
  }
}

/**
 * Recolhe todas as pulseiras de um funcionário para o estoque central.
 * Esta ação não gera registro financeiro.
 */
async function collectAllFromEmployee(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  const totalToCollect = ["sales", "owner", "dayUser"]
    .reduce((sum, type) => sum + getEmpBalance(employee, type), 0);

  if (totalToCollect === 0) {
    showToast(`${employee.name} não possui nenhuma pulseira para recolher.`, "warning");
    return;
  }

  if (
    await showConfirm(
      `Tem certeza que deseja recolher TODAS as ${totalToCollect} pulseiras de ${employee.name} e devolvê-las ao Estoque Central? Esta ação não gera registro financeiro.`,
      { type: "warning", title: "Recolher Pulseiras" },
    )
  ) {
    try {
      StockService.collect(empId);
      showToast("Pulseiras recolhidas com sucesso!", "success");
      saveData(() => { renderManagerDashboard(); renderEmployeeSummary(); });
    } catch (err) {
      showToast(err.message, "error");
    }
  }
}

// --- AGENDAMENTO E NOTIFICAÇÃO ---

/**
 * Abre o modal de agendamento para um funcionário, preenchendo o input se já houver um agendamento.
 */
function openScheduleModal(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) return;

  appState.currentScheduleId = empId;
  document.getElementById("modal-sched-name").innerText = employee.name;

  const datetimeInput = document.getElementById("schedule-datetime");
  // Usa scheduleTs como fonte de verdade; scheduleDate mantido apenas para compat. legada
  datetimeInput.value = employee.scheduleTs
    ? tsToDatetimeLocal(employee.scheduleTs)
    : (employee.scheduleDate || "");

  // Preenche o telefone atual do funcionário para edição
  const phoneInput = document.getElementById("schedule-phone");
  if (phoneInput) phoneInput.value = employee.phone || "";

  document.getElementById("schedule-modal").classList.remove("hidden");
}

/**
 * Fecha o modal de agendamento.
 */
function closeScheduleModal() {
  document.getElementById("schedule-modal").classList.add("hidden");
  appState.currentScheduleId = null;
}

/**
 * Salva o agendamento para um funcionário. Armazena a string original e um timestamp.
 */
function saveSchedule() {
  const empId = appState.currentScheduleId;
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee) { closeScheduleModal(); return; }

  const dateVal = document.getElementById("schedule-datetime").value;
  const phoneInput = document.getElementById("schedule-phone");
  const rawPhone = phoneInput ? phoneInput.value.trim() : "";

  // Valida telefone se preenchido
  if (rawPhone && rawPhone.replace(/\D/g, "").length < 8) {
    showToast("Telefone inválido. Informe ao menos 8 dígitos ou deixe em branco.", "warning");
    return;
  }

  // Persiste o telefone se foi alterado no modal
  employee.phone = rawPhone;

  if (dateVal) {
    const parsed = parseDatetimeLocal(dateVal);
    if (!parsed) {
      showToast("Formato de data/hora inválido. Verifique se está completo.", "error");
      return;
    }
    employee.scheduleTs = parsed.ts;
    delete employee.scheduleDate; // Não persiste mais scheduleDate — scheduleTs é suficiente
    showToast(`Agendamento salvo para ${employee.name}.`, "success");
  } else {
    delete employee.scheduleDate;
    delete employee.scheduleTs;
    showToast(`Agendamento para ${employee.name} removido.`, "success");
  }

  saveData(() => { renderManagerDashboard(); renderEmployeeSummary(); });
  closeScheduleModal();
}

/**
 * Envia uma mensagem de agendamento via WhatsApp.
 * Tenta usar o número de telefone do funcionário se disponível.
 */
function sendWhatsApp(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee || (!employee.scheduleTs && !employee.scheduleDate)) {
    showToast("Agendamento ou funcionário não encontrado para enviar WhatsApp.", "warning");
    return;
  }

  // Usa scheduleTs como fonte primária; scheduleDate mantido apenas para compat. legada
  const ts = employee.scheduleTs || (employee.scheduleDate ? parseDatetimeLocal(employee.scheduleDate)?.ts : null);
  let dateStr = "data não definida";
  let timeStr = "";

  if (ts) {
    const d = new Date(ts);
    dateStr = d.toLocaleDateString("pt-BR");
    timeStr = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  const message = `Olá ${employee.name}, favor comparecer para acerto de pulseiras dia *${dateStr}* às *${timeStr}*.`;
  const encodedMsg = encodeURIComponent(message);

  if (employee.phone && typeof employee.phone === "string" && employee.phone.trim() !== "") {
    // Sanitiza o número de telefone (remove caracteres não-numéricos)
    const digits = employee.phone.replace(/\D/g, "");
    if (digits.length >= 8) { // Considera um número válido se tiver pelo menos 8 dígitos (excluindo DDI, incluindo DDD)
      window.open(`https://wa.me/${digits}?text=${encodedMsg}`, "_blank", "noopener,noreferrer");
      return;
    }
  }
  // Fallback: abre o composer do WhatsApp sem um número específico
  window.open(`https://wa.me/?text=${encodedMsg}`, "_blank", "noopener,noreferrer");
  showToast("Abriu o WhatsApp. Lembre-se de selecionar o contato do funcionário.", "info");
}

/**
 * Remove o agendamento de um funcionário com opção de "Desfazer".
 * Remove imediatamente da UI/estado e mostra um toast interativo.
 */
async function removeSchedule(empId) {
  const employee = appState.employees.find((e) => e.id === empId);
  if (!employee || (!employee.scheduleDate && !employee.scheduleTs)) return;

  const confirmed = await showConfirm(
    `Tem certeza que deseja remover o agendamento de ${employee.name}?`,
    {
      type: "warning",
      title: "Remover Agendamento",
      confirmText: "Sim, remover",
      cancelText: "Manter Agendamento",
    },
  );

  if (!confirmed) return;

  // Salva o estado anterior do agendamento para a função "Desfazer"
  const previous = {
    scheduleDate: employee.scheduleDate,
    scheduleTs: employee.scheduleTs,
  };

  // Remove imediatamente o agendamento do funcionário e salva o estado
  delete employee.scheduleDate;
  delete employee.scheduleTs;
  saveData(() => { renderManagerDashboard(); renderEmployeeSummary(); });

  // Gera uma chave única para este evento de remoção para o "Desfazer"
  const undoKey = Date.now() + "_" + empId;
  let undone = false; // Flag para controlar se o "Desfazer" já foi acionado

  // Callback para a ação de "Desfazer"
  const undoCallback = () => {
    // Verifica se o agendamento ainda está "pendente de remoção" (não foi desfeito ainda)
    const pending = pendingScheduleRemovals.get(undoKey);
    if (!pending) return; // Se já não está no mapa, ou já foi desfeito/finalizado

    const emp = appState.employees.find((e) => e.id === empId);
    if (!emp) return;

    // Restaura os dados do agendamento
    emp.scheduleDate = previous.scheduleDate;
    emp.scheduleTs = previous.scheduleTs;
    saveData(() => { renderManagerDashboard(); renderEmployeeSummary(); }); // reaparece o agendamento
    undone = true; // Marca como desfeito
    pendingScheduleRemovals.delete(undoKey); // Limpa do mapa
    showToast(`Agendamento restaurado para ${emp.name}.`, "success");
  };

  // Armazena o evento de remoção no mapa e define um timeout para limpar
  // O timeout chama uma função que apenas limpa o `pendingScheduleRemovals`
  // se a ação de "Desfazer" não tiver sido feita.
  const timeoutId = setTimeout(() => {
    if (!undone) {
      pendingScheduleRemovals.delete(undoKey);
    }
  }, 5000); // 5 segundos para o "Desfazer"

  pendingScheduleRemovals.set(undoKey, { empId, previous, timeoutId });

  // Exibe o toast com o botão "Desfazer"
  showToast(
    `Agendamento removido para ${employee.name}.`,
    "info",
    "Desfazer",
    undoCallback,
  );
}

// --- RENDERIZAÇÃO (UI) ---

/**
 * Renderiza todos os componentes da UI que precisam ser atualizados.
 */
function renderAll() {
  renderBandOptions();
  renderManagerDashboard();
  renderEmployeeSelects();
  renderHistory();
  renderEmployeeSummary();
  const priceInput = document.getElementById("config-price-input");
  if (priceInput) priceInput.value = appState.pricePerUnit;
}

/**
 * Renderiza o painel principal do gerente, incluindo resumo financeiro e tabela de funcionários.
 */
function renderManagerDashboard() {
  renderStockInfo(); // Atualiza Card de Estoque (Dinâmico)

  // Resumo financeiro
  const totalGross = appState.totalCash || 0;
  const totalWithdrawn = (appState.cashWithdrawals || [])
    .filter(w => !w.isDeleted)
    .reduce((acc, w) => acc + w.amount, 0);
  const balance = totalGross - totalWithdrawn;

  document.getElementById("total-money-display").innerText =
    formatCurrency(balance);
  document.getElementById("total-gross-display").innerText =
    formatCurrency(totalGross);
  document.getElementById("total-withdrawn-display").innerText =
    formatCurrency(totalWithdrawn);

  const tbody = document.getElementById("manager-table-body");
  tbody.innerHTML = "";

  const filterScheduledEl = document.getElementById("filter-scheduled");
  const filterScheduled = filterScheduledEl && filterScheduledEl.checked;
  let employeesToRender = [...appState.employees];

  if (filterScheduled) {
    employeesToRender = employeesToRender.filter(
      (e) => e.scheduleTs || e.scheduleDate,
    );
  }

  // Ordena por prioridade operacional:
  // 1. Com pulseiras pendentes — maior quantidade primeiro
  // 2. Agendados (sem pendência) — mais próximos primeiro
  // 3. Acertados — ordem alfabética
  employeesToRender.sort((a, b) => {
    const aPending = (a.received || 0) + (a.receivedOwner || 0) + (a.receivedDayUser || 0);
    const bPending = (b.received || 0) + (b.receivedOwner || 0) + (b.receivedDayUser || 0);

    if (aPending > 0 && bPending > 0) return bPending - aPending; // mais pulseiras primeiro
    if (aPending > 0) return -1;
    if (bPending > 0) return 1;

    const aTs = a.scheduleTs || (a.scheduleDate ? parseDatetimeLocal(a.scheduleDate)?.ts : null);
    const bTs = b.scheduleTs || (b.scheduleDate ? parseDatetimeLocal(b.scheduleDate)?.ts : null);

    if (aTs && bTs) return aTs - bTs;
    if (aTs) return -1;
    if (bTs) return 1;

    return a.name.localeCompare(b.name);
  });


  if (employeesToRender.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="3" class="text-center py-8 text-gray-400">Nenhum funcionário encontrado.</td></tr>';
    return;
  }

  employeesToRender.forEach((emp) => {
    const sales = emp.received || 0;
    const owner = emp.receivedOwner || 0;
    const day = emp.receivedDayUser || 0;

    const cSales = getColorClass(appState.bandConfig.sales.color);
    const cOwner = getColorClass(appState.bandConfig.owner.color);
    const cDay = getColorClass(appState.bandConfig.dayUser.color);

    let scheduleHtml = "";
    if (emp.scheduleDate || emp.scheduleTs) {
      // Prioriza o timestamp para garantir que a data seja sempre válida
      const ts = emp.scheduleTs || (emp.scheduleDate ? parseDatetimeLocal(emp.scheduleDate)?.ts : null);
      let d = null;
      if (ts) d = new Date(ts);
      else if (emp.scheduleDate) d = parseDatetimeLocal(emp.scheduleDate)?.dateObj;

      if (d) {
        const dateStr = d.toLocaleDateString("pt-BR");
        const timeStr = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        const isExpired = d.getTime() < Date.now(); // Verifica se o agendamento já passou

        const badgeClass = isExpired
          ? "bg-red-50 text-red-700 border-red-200" // Estilo para agendamento vencido
          : "bg-orange-50 text-orange-700 border-orange-200"; // Estilo para agendamento futuro
        const icon = isExpired
          ? "fa-solid fa-clock-exclamation" // Ícone para agendamento vencido
          : "fa-regular fa-clock"; // Ícone para agendamento futuro

        scheduleHtml = `
          <div class="mt-1 flex items-center justify-center gap-2 text-xs ${badgeClass} py-1 px-2 rounded border">
            <i class="${icon}"></i> ${dateStr} às ${timeStr}
            <div class="flex items-center gap-2">
              <button onclick="sendWhatsApp(${emp.id})" class="bg-green-500 text-white px-2 py-0.5 rounded hover:bg-green-600 transition" title="Enviar no WhatsApp">
                <i class="fa-brands fa-whatsapp"></i>
              </button>
              <button onclick="removeSchedule(${emp.id})" class="bg-red-500 text-white px-2 py-0.5 rounded hover:bg-red-600 transition" title="Remover Agendamento">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </div>
        `;
      }
    }

    // Telefone sob o nome (se cadastrado)
    const phoneHtml = emp.phone
      ? `<div class="text-xs text-gray-400 font-normal mt-0.5"><i class="fa-brands fa-whatsapp text-green-500 mr-1"></i>${escapeHtml(emp.phone)}</div>`
      : "";

    // Valor estimado de cobrança (pulseiras de venda × preço unitário)
    const estimatedValue = sales * appState.pricePerUnit;
    const estimatedHtml = estimatedValue > 0
      ? `<div class="text-xs font-bold text-green-600 mt-1" title="Estimativa de cobrança (pulseiras de venda)">≈ ${formatCurrency(estimatedValue)}</div>`
      : "";

    const tr = document.createElement("tr");
    tr.className = "hover:bg-gray-50 transition";
    tr.innerHTML = `
      <td class="px-4 md:px-6 py-4 font-medium text-gray-900">
        ${escapeHtml(emp.name)}${phoneHtml}
      </td>
      <td class="px-4 md:px-6 py-4 text-center text-gray-600 text-sm">
        <div>
          <span class="${cSales} font-bold" title="${appState.bandConfig.sales.name}">V: ${sales}</span> |
          <span class="${cOwner} font-bold" title="${appState.bandConfig.owner.name}">P: ${owner}</span> |
          <span class="${cDay} font-bold" title="${appState.bandConfig.dayUser.name}">D: ${day}</span>
        </div>
        ${estimatedHtml}
        ${scheduleHtml}
      </td>
      <td class="px-3 md:px-6 py-3 md:py-4">
        <div class="flex flex-wrap justify-center items-center gap-1">
          ${sales === 0 && owner === 0 && day === 0
            ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-bold bg-green-50 text-green-600 border border-green-200" title="Sem pulseiras pendentes">
                <i class="fa-solid fa-circle-check"></i> Acertado
               </span>`
            : `<button onclick="openSettleModal(${emp.id})" class="bg-green-600 text-white hover:bg-green-700 px-3 py-1.5 rounded shadow text-sm font-bold transition" title="Realizar Acerto">
                <i class="fa-solid fa-hand-holding-dollar"></i>
               </button>`
          }
          <button onclick="collectAllFromEmployee(${emp.id})" class="text-orange-500 hover:text-orange-700 p-1.5 rounded hover:bg-orange-50 transition" title="Recolher Todas as Pulseiras">
            <i class="fa-solid fa-box-archive"></i>
          </button>
          <button onclick="removeEmployee(${emp.id})" class="text-red-400 hover:text-red-600 p-1.5 rounded hover:bg-red-50 transition" title="Remover Funcionário">
            <i class="fa-solid fa-trash"></i>
          </button>
          <button onclick="openScheduleModal(${emp.id})" class="text-blue-400 hover:text-blue-600 p-1.5 rounded hover:bg-blue-50 transition" title="Agendar Acerto">
            <i class="fa-regular fa-calendar-check"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

/**
 * Renderiza as informações de estoque nos cards de resumo.
 */
function renderStockInfo() {
  const threshold = appState.stockAlertThreshold || 0;

  const createRow = (key, count, icon) => {
    const conf = appState.bandConfig[key];
    const colorClass = getColorClass(conf.color);
    const isLow = threshold > 0 && count <= threshold;
    const alertBadge = isLow
      ? `<span class="pulse-warning ml-1" title="Estoque baixo!"><i class="fa-solid fa-triangle-exclamation text-sm"></i></span>`
      : "";
    return `
      <div class="flex justify-between items-center gap-4">
        <span class="text-sm font-bold ${colorClass}"><i class="fa-solid ${icon} mr-1"></i>${conf.name}:</span>
        <span class="text-lg font-bold ${isLow ? "text-red-500" : "text-gray-800"}">${count}${alertBadge}</span>
      </div>
    `;
  };

  const html =
    createRow("sales", appState.centralStock, "fa-ticket") +
    createRow("owner", appState.stockOwner || 0, "fa-crown") +
    createRow("dayUser", appState.stockDayUser || 0, "fa-umbrella-beach");

  const dashContainer = document.getElementById("stock-info-container");
  if (dashContainer) dashContainer.innerHTML = html;

  const settingsContainer = document.getElementById("settings-stock-summary");
  if (settingsContainer) settingsContainer.innerHTML = html;
}

/**
 * Renderiza as opções dos selects para tipos de pulseira (em distribuição/adição de estoque).
 */
function renderBandOptions() {
  const typeSelect = document.getElementById("distribute-type");
  const addStockSelect = document.getElementById("add-stock-type");

  const createOpts = () => `
    <option value="sales">${escapeHtml(appState.bandConfig.sales.name)} (${escapeHtml(appState.bandConfig.sales.label)})</option>
    <option value="owner">${escapeHtml(appState.bandConfig.owner.name)} (${escapeHtml(appState.bandConfig.owner.label)})</option>
    <option value="dayUser">${escapeHtml(appState.bandConfig.dayUser.name)} (${escapeHtml(appState.bandConfig.dayUser.label)})</option>
  `;

  const html = createOpts();
  if (typeSelect) typeSelect.innerHTML = html;
  if (addStockSelect) addStockSelect.innerHTML = html;
}

/**
 * Renderiza a lista de funcionários nos selects (ex: para distribuição).
 */
function renderEmployeeSelects() {
  const managerSelect = document.getElementById("distribute-select");
  if (!managerSelect) return;

  const currentManagerSel = managerSelect.value; // Salva a seleção atual para não perder

  const optionsHTML = appState.employees
    .map((emp) => `<option value="${emp.id}">${escapeHtml(emp.name)}</option>`)
    .join("");

  managerSelect.innerHTML = '<option value="">Selecione...</option>' + optionsHTML;
  if (currentManagerSel) managerSelect.value = currentManagerSel; // Restaura a seleção
}


// --- HISTÓRICO DE ACERTOS (COM PAGINAÇÃO E BUSCA) ---

/**
 * Função wrapper para busca (reseta a página para 1).
 */
function searchHistory() {
  currentPage = 1;
  renderHistory();
}

/**
 * Navega entre as páginas do histórico.
 * @param {number} step - O passo da navegação (-1 para anterior, 1 para próxima).
 */
function changePage(step) {
  currentPage += step;
  renderHistory();
}

/**
 * Renderiza a tabela de histórico de acertos com paginação e filtro.
 */
function renderHistory() {
  const tbody = document.getElementById("history-table-body");
  const searchTermInput = document.getElementById("history-search");
  const searchTerm = searchTermInput ? searchTermInput.value.toLowerCase() : "";
  tbody.innerHTML = "";

  const filteredHistory = appState.history.filter((log) =>
    log.empName.toLowerCase().includes(searchTerm),
  );

  if (filteredHistory.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="text-center py-4 text-gray-400 text-sm">Nenhum registro encontrado.</td></tr>';
    document.getElementById("page-indicator").innerText = "Página 0 de 0";
    document.getElementById("btn-prev").disabled = true;
    document.getElementById("btn-next").disabled = true;
    return;
  }

  const totalPages = Math.ceil(filteredHistory.length / ITEMS_PER_PAGE);

  if (currentPage < 1) currentPage = 1;
  if (currentPage > totalPages) currentPage = totalPages;

  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedItems = filteredHistory.slice(startIndex, endIndex);

  paginatedItems.forEach((log) => {
    const tr = document.createElement("tr");
    tr.className = "text-sm text-gray-600 border-b";
    const detailsText = log.details
      ? `<div class="text-xs text-gray-400">${escapeHtml(log.details)}</div>`
      : "";
    tr.innerHTML = `
      <td class="px-4 py-3">${escapeHtml(log.date)}</td>
      <td class="px-4 py-3 font-medium">${escapeHtml(log.empName)}</td>
      <td class="px-4 py-3 text-center">${log.sold} ${detailsText}</td>
      <td class="px-4 py-3 text-right">
        <span class="text-green-600 font-bold">${formatCurrency(log.total)}</span>
        <button onclick="printReceipt(${log.id})" class="ml-2 text-gray-300 hover:text-gray-600 transition" title="Imprimir Recibo">
          <i class="fa-solid fa-print text-xs"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("page-indicator").innerText =
    `Página ${currentPage} de ${totalPages}`;
  document.getElementById("btn-prev").disabled = currentPage === 1;
  document.getElementById("btn-next").disabled = currentPage === totalPages;
}

// --- RELATÓRIOS E IMPRESSÃO ---

/**
 * Gera e imprime um relatório de fechamento geral.
 */
function printReport() {
  document.getElementById("print-title").innerText =
    "Relatório de Fechamento Geral";
  document.getElementById("print-date").innerText = new Date().toLocaleString(
    "pt-BR",
  );

  const totalGross = appState.totalCash || 0;
  const totalWithdrawn = (appState.cashWithdrawals || [])
    .filter(w => !w.isDeleted)
    .reduce((acc, w) => acc + w.amount, 0);
  const balance = totalGross - totalWithdrawn;

  const pendingSales = appState.employees.reduce(
    (acc, emp) => acc + (emp.received || 0),
    0,
  );
  const pendingOwner = appState.employees.reduce(
    (acc, emp) => acc + (emp.receivedOwner || 0),
    0,
  );
  const pendingDay = appState.employees.reduce(
    (acc, emp) => acc + (emp.receivedDayUser || 0),
    0,
  );

  const nSales = appState.bandConfig.sales.name;
  const nOwner = appState.bandConfig.owner.name;
  const nDay = appState.bandConfig.dayUser.name;

  const withdrawalRows =
    (appState.cashWithdrawals || []).length === 0
      ? `<tr><td colspan="3" class="p-2 text-center text-gray-400 text-xs">Nenhuma retirada registrada.</td></tr>`
      : [...(appState.cashWithdrawals || [])]
          .reverse()
          .map(
            (w) => `
        <tr>
          <td class="p-2 border text-xs">${escapeHtml(w.date)}</td>
          <td class="p-2 border text-xs">${escapeHtml(w.description)}</td>
          <td class="p-2 border text-right font-bold text-xs">${formatCurrency(w.amount)}</td>
        </tr>`,
          )
          .join("");

  const employeeRows =
    appState.employees.length === 0
      ? `<tr><td colspan="5" class="p-2 text-center text-gray-400 text-xs">Nenhum funcionário cadastrado.</td></tr>`
      : appState.employees
          .map((emp) => {
            const s = emp.received || 0;
            const o = emp.receivedOwner || 0;
            const d = emp.receivedDayUser || 0;
            const total = s + o + d;
            const status =
              total === 0
                ? `<span style="color:#16a34a;font-weight:bold;">✔ Acertado</span>`
                : `<span style="color:#dc2626;font-weight:bold;">⚠ Pendente</span>`;
            return `
          <tr>
            <td class="p-2 border text-xs">${escapeHtml(emp.name)}</td>
            <td class="p-2 border text-center text-xs">${s}</td>
            <td class="p-2 border text-center text-xs">${o}</td>
            <td class="p-2 border text-center text-xs">${d}</td>
            <td class="p-2 border text-center text-xs">${status}</td>
          </tr>`;
          })
          .join("");

  const htmlContent = `
    <div class="mb-8">
      <h2 class="text-xl font-bold border-b border-gray-400 mb-3">1. Resumo Financeiro</h2>
      <table class="w-full text-sm text-left border border-gray-300 mb-3">
        <tbody>
          <tr class="bg-gray-50">
            <td class="p-2 border text-gray-500">Caixa Bruto (acertos realizados)</td>
            <td class="p-2 border text-right font-bold">${formatCurrency(totalGross)}</td>
          </tr>
          <tr>
            <td class="p-2 border text-gray-500">Total de Retiradas</td>
            <td class="p-2 border text-right font-bold text-red-600">- ${formatCurrency(totalWithdrawn)}</td>
          </tr>
          <tr style="background:#f0fdf4;">
            <td class="p-2 border font-bold">Saldo em Caixa</td>
            <td class="p-2 border text-right font-bold text-green-700" style="font-size:1.2rem;">${formatCurrency(balance)}</td>
          </tr>
          <tr class="bg-gray-50">
            <td class="p-2 border text-gray-500">Preço Unitário (Venda)</td>
            <td class="p-2 border text-right">${formatCurrency(appState.pricePerUnit)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="mb-8">
      <h2 class="text-xl font-bold border-b border-gray-400 mb-3">2. Retiradas do Caixa</h2>
      <table class="w-full text-sm text-left border border-gray-300">
        <thead class="bg-gray-100">
          <tr>
            <th class="p-2 border">Data</th>
            <th class="p-2 border">Descrição</th>
            <th class="p-2 border text-right">Valor</th>
          </tr>
        </thead>
        <tbody>${withdrawalRows}</tbody>
      </table>
    </div>

    <div class="mb-8">
      <h2 class="text-xl font-bold border-b border-gray-400 mb-3">3. Posição de Estoque Central</h2>
      <table class="w-full text-sm text-left border border-gray-300">
        <thead class="bg-gray-100">
          <tr>
            <th class="p-2 border">Local</th>
            <th class="p-2 border text-right">Quantidade</th>
          </tr>
        </thead>
        <tbody>
          <tr><td class="p-2 border">Estoque Central — ${nSales}</td><td class="p-2 border text-right font-bold">${appState.centralStock}</td></tr>
          <tr><td class="p-2 border">Estoque Central — ${nOwner}</td><td class="p-2 border text-right font-bold">${appState.stockOwner || 0}</td></tr>
          <tr><td class="p-2 border">Estoque Central — ${nDay}</td><td class="p-2 border text-right font-bold">${appState.stockDayUser || 0}</td></tr>
          <tr class="bg-gray-50"><td class="p-2 border">Com funcionários — ${nSales}</td><td class="p-2 border text-right font-bold">${pendingSales}</td></tr>
          <tr class="bg-gray-50"><td class="p-2 border">Com funcionários — ${nOwner}</td><td class="p-2 border text-right font-bold">${pendingOwner}</td></tr>
          <tr class="bg-gray-50"><td class="p-2 border">Com funcionários — ${nDay}</td><td class="p-2 border text-right font-bold">${pendingDay}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="mb-8">
      <h2 class="text-xl font-bold border-b border-gray-400 mb-3">4. Situação dos Funcionários</h2>
      <table class="w-full text-sm text-left border border-gray-300">
        <thead class="bg-gray-100">
          <tr>
            <th class="p-2 border">Funcionário</th>
            <th class="p-2 border text-center">${nSales}</th>
            <th class="p-2 border text-center">${nOwner}</th>
            <th class="p-2 border text-center">${nDay}</th>
            <th class="p-2 border text-center">Status</th>
          </tr>
        </thead>
        <tbody>${employeeRows}</tbody>
      </table>
    </div>
  `;

  document.getElementById("print-content").innerHTML = htmlContent;
  window.print();
}

/**
 * Abre o modal de histórico de estoque.
 */
function openStockHistoryModal() {
  document.getElementById("stock-history-start").value = "";
  document.getElementById("stock-history-end").value = "";
  renderStockHistoryTable();
  document.getElementById("stock-history-modal").classList.remove("hidden");
}

/**
 * Fecha o modal de histórico de estoque.
 */
function closeStockHistoryModal() {
  document.getElementById("stock-history-modal").classList.add("hidden");
}

/**
 * Limpa os filtros de data no histórico de estoque e re-renderiza.
 */
function clearStockHistoryFilter() {
  document.getElementById("stock-history-start").value = "";
  document.getElementById("stock-history-end").value = "";
  renderStockHistoryTable();
}

/**
 * Renderiza a tabela do histórico de estoque com filtros de data.
 */
function renderStockHistoryTable() {
  const tbody = document.getElementById("stock-history-table-body");
  tbody.innerHTML = "";

  const startInput = document.getElementById("stock-history-start").value;
  const endInput = document.getElementById("stock-history-end").value;

  let filteredLogs = appState.stockLogs;

  if (startInput || endInput) {
    const startDate = startInput
      ? new Date(startInput + "T00:00:00").getTime()
      : 0;
    const endDate = endInput
      ? new Date(endInput + "T23:59:59").getTime()
      : Date.now();

    filteredLogs = appState.stockLogs.filter((log) => {
      // log.ts existe em logs novos; log.id era o timestamp nos logs antigos
      const t = log.ts ?? log.id;
      return t >= startDate && t <= endDate;
    });
  }

  if (!filteredLogs || filteredLogs.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="text-center py-4 text-gray-400">Nenhum registro encontrado para o filtro aplicado.</td></tr>';
  } else {
    filteredLogs.forEach((log) => {
      const colorClass = log.amount > 0 ? "text-green-600" : "text-red-600";
      const icon = log.amount > 0 ? "+" : "";

      // Badge do operador: resolve nome pelo empId se disponível (logs novos),
      // mostrando o nome atual do funcionário. Logs antigos exibem apenas details.
      const empName = log.empId
        ? (appState.employees.find((e) => e.id === log.empId)?.name ?? null)
        : null;
      const empBadge = empName
        ? `<span class="inline-flex items-center gap-1 text-[10px] font-medium text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100 mt-1">
             <i class="fa-solid fa-user text-[9px]" aria-hidden="true"></i>${escapeHtml(empName)}
           </span>`
        : "";

      const tr = document.createElement("tr");
      tr.className = "hover:bg-gray-50 border-b last:border-0";
      tr.innerHTML = `
        <td class="px-4 py-3 text-gray-600 text-sm">${escapeHtml(log.date)}</td>
        <td class="px-4 py-3 font-bold text-gray-800 text-sm">${escapeHtml(log.item)}</td>
        <td class="px-4 py-3 text-gray-600 text-sm">${escapeHtml(log.action)}</td>
        <td class="px-4 py-3 text-gray-500 text-xs">
          ${escapeHtml(log.details)}
          ${empBadge ? `<div>${empBadge}</div>` : ""}
        </td>
        <td class="px-4 py-3 text-right font-bold ${colorClass} text-sm">${icon}${log.amount}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

/**
 * Imprime o histórico de movimentação de estoque com filtros de data.
 */
function printStockHistory() {
  document.getElementById("print-title").innerText =
    "Extrato de Movimentação de Estoque";
  document.getElementById("print-date").innerText = new Date().toLocaleString(
    "pt-BR",
  );

  const startInput = document.getElementById("stock-history-start").value;
  const endInput = document.getElementById("stock-history-end").value;

  let filteredLogs = appState.stockLogs;
  let periodText = "Completo";

  if (startInput || endInput) {
    const startDate = startInput
      ? new Date(startInput + "T00:00:00").getTime()
      : 0;
    const endDate = endInput
      ? new Date(endInput + "T23:59:59").getTime()
      : Date.now();

    filteredLogs = appState.stockLogs.filter((log) => {
      const t = log.ts ?? log.id;
      return t >= startDate && t <= endDate;
    });

    const startFormatted = startInput
      ? startInput.split("-").reverse().join("/")
      : "Início";
    const endFormatted = endInput
      ? endInput.split("-").reverse().join("/")
      : "Hoje";
    periodText = `${startFormatted} a ${endFormatted}`;
  }

  if (!filteredLogs || filteredLogs.length === 0) {
    showToast(
      "Não há movimentações para imprimir no período selecionado.",
      "warning",
    );
    return;
  }

  let rowsHtml = filteredLogs
    .map((log) => {
      const colorClass = log.amount > 0 ? "text-green-600" : "text-red-600";
      const icon = log.amount > 0 ? "+" : "";
      return `
        <tr>
            <td class="p-2 border text-xs">${log.date}</td>
            <td class="p-2 border font-bold">${log.item}</td>
            <td class="p-2 border">${log.action}</td>
            <td class="p-2 border text-gray-500 text-xs">${log.details}</td>
            <td class="p-2 border text-right font-bold ${colorClass}">${icon}${log.amount}</td>
        </tr>
        `;
    })
    .join("");

  const htmlContent = `
        <div class="mb-4">
            <h3 class="font-bold mb-2 text-gray-700">Movimentações do Cofre</h3>
            <p class="text-sm"><strong>Período do Filtro:</strong> ${periodText}</p>
        </div>
        <table class="w-full text-sm text-left border border-gray-300">
            <thead class="bg-gray-200">
                <tr><th class="p-2 border">Data</th><th class="p-2 border">Item</th><th class="p-2 border">Ação</th><th class="p-2 border">Detalhes</th><th class="p-2 border text-right">Qtd.</th></tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    `;

  document.getElementById("print-content").innerHTML = htmlContent;
  window.print();
}

/**
 * Gera e imprime um relatório de acertos por período.
 */
function printPeriodReport() {
  const startInput = document.getElementById("report-start").value;
  const endInput = document.getElementById("report-end").value;

  if (!startInput || !endInput) {
    showToast("Selecione as datas de início e fim para o relatório.", "warning");
    return;
  }

  const startDate = new Date(startInput + "T00:00:00").getTime();
  const endDate = new Date(endInput + "T23:59:59").getTime();

  const filteredLogs = appState.history.filter(
    (log) => log.id >= startDate && log.id <= endDate,
  );

  // Prévia antes de abrir impressão — evita surpresas com período vazio
  if (filteredLogs.length === 0) {
    showToast("Nenhum acerto encontrado no período selecionado.", "warning");
    return;
  }

  const totalSoldPeriod = filteredLogs.reduce((acc, log) => acc + log.sold, 0);
  const totalCashPeriod = filteredLogs.reduce((acc, log) => acc + log.total, 0);

  showToast(
    `${filteredLogs.length} acerto(s) — ${totalSoldPeriod} pulseiras — ${formatCurrency(totalCashPeriod)}. Abrindo impressão...`,
    "info",
  );

  document.getElementById("print-title").innerText = "Relatório por Período";
  document.getElementById("print-date").innerText = new Date().toLocaleString(
    "pt-BR",
  );

  const rowsHtml = filteredLogs
    .map(
      (log) => `
        <tr>
            <td class="p-2 border">${escapeHtml(log.date)}</td>
            <td class="p-2 border">${escapeHtml(log.empName)}</td>
            <td class="p-2 border text-center">${log.sold}</td>
            <td class="p-2 border text-right">${formatCurrency(log.total)}</td>
        </tr>
    `,
    )
    .join("");

  const htmlContent = `
        <div class="mb-6 bg-gray-100 p-4 rounded border border-gray-300">
            <p class="text-sm"><strong>Período:</strong> ${startInput.split("-").reverse().join("/")} até ${endInput.split("-").reverse().join("/")}</p>
            <p class="text-sm mt-1"><strong>Total Vendido:</strong> ${totalSoldPeriod} pulseiras</p>
            <p class="text-xl font-bold mt-2 text-green-700">Total Arrecadado: ${formatCurrency(totalCashPeriod)}</p>
        </div>

        <h3 class="font-bold mb-2">Detalhamento das Transações</h3>
        <table class="w-full text-sm text-left border border-gray-300">
            <thead class="bg-gray-200">
                <tr><th class="p-2 border">Data/Hora</th><th class="p-2 border">Funcionário</th><th class="p-2 border text-center">Qtd.</th><th class="p-2 border text-right">Valor</th></tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    `;

  document.getElementById("print-content").innerHTML = htmlContent;
  window.print();
}

/** Dispara download de um CSV via Blob URL. */
function _downloadCSV(csvContent, filename) {
  var blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  var url  = URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Exporta o histórico de acertos para CSV.
 */
function exportHistoryToCSV() {
  if (appState.history.length === 0) {
    showToast("Não há dados no histórico para exportar.", "warning");
    return;
  }
  var csv = "﻿Data/Hora;Funcionário;Qtd Vendida;Detalhes;Total (R$)\n";
  appState.history.forEach(function(log) {
    var det = log.details ? log.details.replace(/\|/g, "-").replace(/\\n/g, " ") : "";
    csv += log.date + ";" + '"' + log.empName + '"' + ";" + log.sold + ";" + '"' + det + '"' + ";" + log.total.toFixed(2).replace(".", ",") + "\n";
  });
  _downloadCSV(csv, "acertos_" + new Date().toISOString().slice(0, 10) + ".csv");
  showToast("Histórico de acertos exportado!", "success");
}

/**
 * Exporta o histórico de retiradas para CSV.
 */
function exportWithdrawalsToCSV() {
  var list = (appState.cashWithdrawals || []).filter(w => !w.isDeleted);
  if (list.length === 0) {
    showToast("Não há retiradas ativas para exportar.", "warning");
    return;
  }
  var csv = "﻿Data/Hora;Descrição;Valor (R$)\n";
  list.slice().reverse().forEach(function(w) {
    csv += w.date + ";" + '"' + (w.description || "").replace(/"/g, '""') + '"' + ";" + w.amount.toFixed(2).replace(".", ",") + "\n";
  });
  _downloadCSV(csv, "retiradas_" + new Date().toISOString().slice(0, 10) + ".csv");
  showToast("Histórico de retiradas exportado!", "success");
}

/**
 * Exporta o extrato de movimentações de estoque para CSV.
 */
function exportStockLogsToCSV() {
  var list = appState.stockLogs || [];
  if (list.length === 0) {
    showToast("Não há movimentações de estoque para exportar.", "warning");
    return;
  }
  var csv = "﻿Data/Hora;Item;Ação;Detalhes;Quantidade\n";
  list.forEach(function(log) {
    csv += log.date + ";" + '"' + log.item + '"' + ";" + '"' + log.action + '"' + ";" + '"' + (log.details || "").replace(/"/g, '""') + '"' + ";" + log.amount + "\n";
  });
  _downloadCSV(csv, "estoque_" + new Date().toISOString().slice(0, 10) + ".csv");
  showToast("Movimentações de estoque exportadas!", "success");
}

/**
 * Exporta a lista de funcionários com situação atual para CSV.
 */
function exportEmployeesToCSV() {
  if (appState.employees.length === 0) {
    showToast("Nenhum funcionário cadastrado para exportar.", "warning");
    return;
  }
  var nS = appState.bandConfig.sales.name;
  var nO = appState.bandConfig.owner.name;
  var nD = appState.bandConfig.dayUser.name;
  var csv = "﻿Nome;Telefone;" + nS + " (em mãos);" + nO + " (em mãos);" + nD + " (em mãos);Status\n";
  appState.employees.forEach(function(emp) {
    var s = emp.received || 0;
    var o = emp.receivedOwner || 0;
    var d = emp.receivedDayUser || 0;
    var status = (s + o + d) === 0 ? "Acertado" : "Pendente";
    csv += '"' + emp.name + '"' + ";" + '"' + (emp.phone || "") + '"' + ";" + s + ";" + o + ";" + d + ";" + status + "\n";
  });
  _downloadCSV(csv, "funcionarios_" + new Date().toISOString().slice(0, 10) + ".csv");
  showToast("Lista de funcionários exportada!", "success");
}
// --- BACKUP E DADOS ---

/**
 * Exporta todos os dados do aplicativo para um arquivo JSON de backup.
 */
function exportData() {
  const dataStr = JSON.stringify(appState, null, 2);
  const blob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `pulso_backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  localStorage.setItem("lastBackup", String(Date.now())); // Registra data do último backup
  sessionStorage.removeItem("_bwShown"); // Permite que o aviso reapareça na próxima sessão se necessário
  showToast("Backup dos dados realizado com sucesso!", "success");
}

/**
 * Importa dados de um arquivo JSON de backup, substituindo o estado atual.
 */
function importData(input) {
  const file = input.files[0];
  if (!file) {
    showToast("Nenhum arquivo selecionado para importação.", "warning");
    return;
  }

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const data = JSON.parse(e.target.result);
      // Validação de estrutura e tipos para evitar corrupção de estado ou injeção
      if (data.centralStock !== undefined && Array.isArray(data.employees) && data.bandConfig) {
        // Reconstrói o objeto restaurando TODOS os campos do backup
        appState.centralStock        = Number(data.centralStock)        || 0;
        appState.stockOwner          = Number(data.stockOwner)          || 0;
        appState.stockDayUser        = Number(data.stockDayUser)        || 0;
        appState.totalCash           = Number(data.totalCash)           || 0;
        appState.pricePerUnit        = Number(data.pricePerUnit)        || 15.0;
        appState.stockAlertThreshold = Number(data.stockAlertThreshold) >= 0
                                         ? Number(data.stockAlertThreshold) : 20;
        appState.employees    = data.employees.map(emp => ({
          ...emp,
          name: String(emp.name || "").trim(),
        }));
        appState.history         = Array.isArray(data.history)         ? data.history         : [];
        appState.stockLogs       = Array.isArray(data.stockLogs)       ? data.stockLogs       : [];
        appState.cashWithdrawals = Array.isArray(data.cashWithdrawals) ? data.cashWithdrawals : [];
        appState.bandConfig      = data.bandConfig;
        // Preserva senha salva — não sobrescreve com valor do backup externo
        if (data.systemPassword) appState.systemPassword = data.systemPassword;

        // Migração de timestamps e campos opcionais
        appState.employees.forEach((emp) => {
          if (emp && emp.scheduleDate && !emp.scheduleTs) {
            const dtParsed = parseDatetimeLocal(emp.scheduleDate);
            if (dtParsed) emp.scheduleTs = dtParsed.ts;
          }
          if (emp && emp.phone === undefined) emp.phone = "";
        });

        await saveToDB();
        showToast("Backup restaurado com sucesso! Recarregando a página...", "success");
        setTimeout(() => location.reload(), 1500);
      } else {
        showToast("Arquivo de backup inválido. Formato inesperado.", "error");
      }
    } catch (err) {
      console.error("Erro ao ler/parsear arquivo de backup:", err);
      showToast("Erro ao processar o arquivo de backup. Verifique o formato.", "error");
    }
  };
  reader.readAsText(file);
  input.value = ""; // Limpa o input para permitir selecionar o mesmo arquivo novamente
}

/**
 * Reseta o sistema, apagando todos os dados. Requer confirmação.
 */
async function resetSystem() {
  const hasData = appState.history.length > 0 || appState.employees.length > 0 ||
    appState.centralStock > 0 || appState.totalCash > 0;

  // Se há dados sem backup recente, oferece baixar antes de destruir
  if (hasData) {
    const lastBackup = parseInt(localStorage.getItem("lastBackup") || "0", 10);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const backupRecente = lastBackup > 0 && (Date.now() - lastBackup) < ONE_DAY_MS;

    if (!backupRecente) {
      const baixar = await showConfirm(
        "Você não tem um backup recente. Recomendamos salvar os dados antes de zerar. Deseja baixar o backup agora?",
        {
          type: "warning",
          title: "Backup Recomendado",
          confirmText: "Baixar Backup",
          cancelText: "Zerar sem backup",
        },
      );
      if (baixar) {
        exportData();
        return; // O gerente pode clicar em "Zerar Tudo" novamente após o download
      }
    }
  }

  if (
    await showConfirm(
      "ATENÇÃO: Isso apagará TODOS os dados do sistema e o histórico! Esta ação é irreversível. Tem certeza?",
      {
        type: "danger",
        title: "Zerar Sistema",
        confirmText: "Sim, apagar tudo permanentemente",
        cancelText: "Cancelar",
      },
    )
  ) {
    if (db) {
      try {
        await db.clear(DB_STORE);
      } catch (err) {
        console.error("[IndexedDB] Falha ao apagar dados:", err);
      }
    }
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY + "_emergency");
    localStorage.removeItem("lastBackup"); // Limpa o registro de backup junto com os dados
    location.reload();
  }
}

// --- UTILITÁRIOS & UI HELPERS ---

/**
 * Exibe uma notificação toast estilizada que desaparece automaticamente.
 * Pode incluir um botão de ação "Desfazer".
 * @param {string} message - Mensagem a exibir.
 * @param {'success'|'error'|'warning'|'info'} [type='info'] - Tipo do toast.
 * @param {string} [actionText=null] - Texto do botão de ação (ex: "Desfazer").
 * @param {Function} [actionCallback=null] - Função a ser chamada ao clicar no botão de ação.
 */
function showToast(
  message,
  type = "info",
  actionText = null,
  actionCallback = null,
) {
  const container = document.getElementById("toast-container");
  if (!container) {
    console.warn("Toast container not found. Message:", message);
    return;
  }

  const toast = document.createElement("div");
  toast.className =
    "toast-item pointer-events-auto bg-white rounded-lg shadow-lg p-3 border-l-4 flex items-center justify-between gap-3";

  const colors = {
    success: {
      border: "border-green-500",
      bg: "bg-green-100",
      icon: "fa-circle-check text-green-600",
    },
    error: {
      border: "border-red-500",
      bg: "bg-red-100",
      icon: "fa-circle-xmark text-red-600",
    },
    warning: {
      border: "border-yellow-500",
      bg: "bg-yellow-100",
      icon: "fa-triangle-exclamation text-yellow-600",
    },
    info: {
      border: "border-blue-500",
      bg: "bg-blue-100",
      icon: "fa-circle-info text-blue-600",
    },
  };

  const config = colors[type] || colors.info;
  toast.classList.add(config.border);

  let actionHtml = "";
  if (actionText && typeof actionCallback === "function") {
    actionHtml = `<button class="toast-action-btn ml-2 text-sm px-2 py-1 bg-gray-100 rounded hover:bg-gray-200">${escapeHtml(actionText)}</button>`;
  }

  toast.innerHTML = `
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-full ${config.bg} flex items-center justify-center">
        <i class="fa-solid ${config.icon}"></i>
      </div>
      <p class="text-sm text-gray-700 flex-1 leading-relaxed">${escapeHtml(message)}</p>
    </div>
    ${actionHtml}
  `;

  container.appendChild(toast);

  if (actionText && typeof actionCallback === "function") {
    const btn = toast.querySelector(".toast-action-btn");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // Previne que o clique feche outros toasts
        try {
          actionCallback();
        } catch (err) {
          console.error("Erro ao executar ação do toast:", err);
        }
        toast.remove(); // Remove o toast imediatamente após a ação
      });
    }
  }

  // Animação de entrada
  setTimeout(() => toast.classList.add("toast-visible"), 10);

  // Auto-esconder após 5 segundos (se não houver um botão de ação clicado)
  const AUTO_HIDE_MS = 5000;
  setTimeout(() => {
    if (!toast.parentElement) return; // Garante que o toast ainda está no DOM
    toast.classList.add("toast-hiding");
    setTimeout(() => {
      try {
        toast.remove();
      } catch (e) {
        console.warn("Erro ao remover toast já desaparecido:", e);
      }
    }, 300); // Tempo da transição CSS
  }, AUTO_HIDE_MS);
}

/**
 * Exibe um modal de confirmação customizado.
 * @param {string} message - Mensagem principal.
 * @param {object} options - { title, type: 'danger'|'warning'|'info', confirmText, cancelText }.
 * @returns {Promise<boolean>} - true se confirmado, false se cancelado.
 */
function showConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const title = document.getElementById("confirm-modal-title");
    const messageEl = document.getElementById("confirm-modal-message");
    const iconWrap = document.getElementById("confirm-icon-wrap");
    const iconI = document.getElementById("confirm-icon-i");
    const okBtn = document.getElementById("confirm-ok-btn");
    const cancelBtn = document.getElementById("confirm-cancel-btn");
    const closeBtn = modal.querySelector(".fa-xmark"); // Botão de fechar (X)

    if (!modal || !title || !messageEl || !iconWrap || !iconI || !okBtn || !cancelBtn) {
      console.error("Elementos do modal de confirmação não encontrados.");
      resolve(false);
      return;
    }

    const type = options.type || "warning";
    const configs = {
      danger: {
        wrapBg: "bg-red-100",
        icon: "fa-triangle-exclamation text-red-600",
        btnBg: "bg-red-600 hover:bg-red-700",
      },
      warning: {
        wrapBg: "bg-yellow-100",
        icon: "fa-exclamation-circle text-yellow-600",
        btnBg: "bg-yellow-600 hover:bg-yellow-700",
      },
      info: {
        wrapBg: "bg-blue-100",
        icon: "fa-circle-info text-blue-600",
        btnBg: "bg-blue-600 hover:bg-blue-700",
      },
    };

    const config = configs[type] || configs.warning;

    title.textContent = options.title || "Confirmação";
    messageEl.textContent = message;
    okBtn.textContent = options.confirmText || "Confirmar";
    cancelBtn.textContent = options.cancelText || "Cancelar";

    iconWrap.className = `mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-3 ${config.wrapBg}`;
    iconI.className = `fa-solid text-xl ${config.icon}`;
    okBtn.className = `flex-1 px-4 py-2 text-white rounded-lg font-bold shadow transition ${config.btnBg}`;
    cancelBtn.className = `flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-bold transition`; // Garante classes padrão

    const cleanup = () => {
      modal.classList.add("hidden");
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      if (closeBtn) closeBtn.onclick = null; // Limpa o handler do botão de fechar
    };

    okBtn.onclick = () => {
      cleanup();
      resolve(true);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };

    if (closeBtn) {
      closeBtn.onclick = () => {
        cleanup();
        resolve(false); // Fechar também resolve como false (cancelado)
      };
    }

    modal.classList.remove("hidden");
  });
}

/**
 * Escapa caracteres HTML para evitar XSS.
 * @param {string} str - A string a ser escapada.
 * @returns {string} - A string escapada.
 */
function escapeHtml(str) {
  if (typeof str !== "string") return String(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Formata um valor numérico para a moeda brasileira (BRL).
 * @param {number} value - O valor a ser formatado.
 * @returns {string} - O valor formatado como moeda.
 */
function formatCurrency(value) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Retorna a classe CSS de cor para um nome de cor (compatível com Tailwind).
 * @param {string} colorName - O nome da cor (ex: 'blue', 'azul').
 * @returns {string} - A classe CSS correspondente.
 */
function getColorClass(colorName) {
  const map = {
    blue: "text-blue-600",
    red: "text-red-600",
    green: "text-green-600",
    yellow: "text-yellow-600",
    purple: "text-purple-600",
    orange: "text-orange-600",
    pink: "text-pink-600",
    gray: "text-gray-600",
    // Português e Novas Cores
    azul: "text-blue-600",
    vermelho: "text-red-600",
    verde: "text-green-600",
    amarelo: "text-yellow-600",
    roxo: "text-purple-600",
    laranja: "text-orange-600",
    rosa: "text-pink-600",
    cinza: "text-gray-600",
    preto: "text-gray-900",
  };
  return map[colorName] || map.azul; // Padrão 'azul' se a cor não for encontrada
}

// --- CONFIGURAÇÃO DE CORES DAS PULSEIRAS ---

/**
 * Abre o modal de configuração de nomes e cores das pulseiras.
 */
function openConfigModal() {
  const container = document.getElementById("config-rows");
  container.innerHTML = ""; // Limpa para reconstruir

  const colors = [
    "azul", "vermelho", "verde", "amarelo", "roxo",
    "laranja", "rosa", "cinza", "preto",
  ];

  const legacyMap = { // Para compatibilidade com cores salvas em inglês
    blue: "azul", red: "vermelho", green: "verde", yellow: "amarelo",
    purple: "roxo", orange: "laranja", pink: "rosa", gray: "cinza",
  };

  const types = [
    { key: "sales", title: "Tipo 1 (Padrão: Venda)" },
    { key: "owner", title: "Tipo 2 (Padrão: Proprietário)" },
    { key: "dayUser", title: "Tipo 3 (Padrão: Day User)" },
  ];

  types.forEach((t) => {
    const conf = appState.bandConfig[t.key];

    let currentColor = conf.color;
    if (legacyMap[currentColor]) currentColor = legacyMap[currentColor]; // Converte legado

    const colorOptions = colors
      .map(
        (c) =>
          `<option value="${c}" ${currentColor === c ? "selected" : ""}>${c.toUpperCase()}</option>`,
      )
      .join("");

    const row = document.createElement("div");
    row.className = "bg-gray-50 p-3 rounded border";
    row.innerHTML = `
            <p class="text-xs font-bold text-gray-500 uppercase mb-2">${t.title}</p>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                    <label for="cfg-name-${t.key}" class="block text-xs text-gray-400">Nome (Ex: Venda)</label>
                    <input type="text" id="cfg-name-${t.key}" value="${escapeHtml(conf.name)}" class="w-full border rounded px-2 py-1 text-sm">
                </div>
                <div>
                    <label for="cfg-label-${t.key}" class="block text-xs text-gray-400">Rótulo (Ex: Azul)</label>
                    <input type="text" id="cfg-label-${t.key}" value="${escapeHtml(conf.label)}" class="w-full border rounded px-2 py-1 text-sm">
                </div>
                <div>
                    <label for="cfg-color-${t.key}" class="block text-xs text-gray-400">Cor do Ícone</label>
                    <select id="cfg-color-${t.key}" class="w-full border rounded px-2 py-1 text-sm bg-white">
                        ${colorOptions}
                    </select>
                </div>
            </div>
        `;
    container.appendChild(row);
  });

  document.getElementById("config-modal").classList.remove("hidden");
}

function closeConfigModal() {
  document.getElementById("config-modal").classList.add("hidden");
}

/**
 * Altera a senha do sistema. Valida senha atual, nova senha e confirmação.
 */
async function changePassword() {
  const current  = document.getElementById("pwd-current").value;
  const next     = document.getElementById("pwd-new").value.trim();
  const confirm  = document.getElementById("pwd-confirm").value.trim();

  if (current !== (appState.systemPassword || SYSTEM_PASSWORD)) {
    showToast("Senha atual incorreta.", "error");
    return;
  }
  if (!next || next.length < 4) {
    showToast("A nova senha deve ter ao menos 4 caracteres.", "warning");
    return;
  }
  if (next !== confirm) {
    showToast("Confirmação não coincide com a nova senha.", "error");
    return;
  }

  appState.systemPassword = next;
  await saveToDB();
  document.getElementById("pwd-current").value = "";
  document.getElementById("pwd-new").value     = "";
  document.getElementById("pwd-confirm").value = "";
  showToast("Senha alterada com sucesso!", "success");
}

function saveConfig() {
  const keys = ["sales", "owner", "dayUser"];

  // Valida todos os campos antes de salvar qualquer coisa
  for (const key of keys) {
    const name = document.getElementById(`cfg-name-${key}`).value.trim();
    const label = document.getElementById(`cfg-label-${key}`).value.trim();
    if (!name || !label) {
      showToast("Nome e rótulo de cada tipo de pulseira não podem ser vazios.", "error");
      return;
    }
  }

  // Aplica após validação completa
  keys.forEach((key) => {
    appState.bandConfig[key].name  = document.getElementById(`cfg-name-${key}`).value.trim();
    appState.bandConfig[key].label = document.getElementById(`cfg-label-${key}`).value.trim();
    appState.bandConfig[key].color = document.getElementById(`cfg-color-${key}`).value;
  });

  saveData();
  closeConfigModal();
  showToast("Configurações de pulseira salvas com sucesso!", "success");
}

// --- FECHAR CAIXA (RETIRADAS) ---

/**
 * Abre o modal para registrar uma retirada do caixa.
 */
function openCashWithdrawalModal() {
  document.getElementById("withdrawal-amount").value = "";
  document.getElementById("withdrawal-desc").value = "";
  document.getElementById("cash-withdrawal-modal").classList.remove("hidden");
}

/**
 * Fecha o modal de retirada do caixa.
 */
function closeCashWithdrawalModal() {
  document.getElementById("cash-withdrawal-modal").classList.add("hidden");
}

// --- HISTÓRICO DE RETIRADAS ---

/**
 * Abre o modal de histórico de retiradas do caixa.
 */
function openWithdrawalHistoryModal() {
  renderWithdrawalHistory();
  document.getElementById("withdrawal-history-modal").classList.remove("hidden");
}

/**
 * Fecha o modal de histórico de retiradas.
 */
function closeWithdrawalHistoryModal() {
  document.getElementById("withdrawal-history-modal").classList.add("hidden");
}

/**
 * Renderiza a tabela do histórico de retiradas.
 */
function renderWithdrawalHistory() {
  const tbody = document.getElementById("withdrawal-history-tbody");
  const all = appState.cashWithdrawals || [];
  tbody.innerHTML = "";

  const active  = all.filter(w => !w.isDeleted);
  const deleted = all.filter(w =>  w.isDeleted);

  if (all.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="text-center py-8 text-gray-400 text-sm">' +
      '<i class="fa-solid fa-inbox text-2xl block mb-2 mx-auto"></i>' +
      "Nenhuma retirada registrada.</td></tr>";
    document.getElementById("withdrawal-total-display").innerText = formatCurrency(0);
    return;
  }

  // Entradas ativas — mais recentes primeiro
  const activeRows = [...active].reverse().map((w) => `
    <tr class="hover:bg-gray-50 border-b text-sm transition">
      <td class="px-4 py-3 text-gray-500 whitespace-nowrap">${escapeHtml(w.date)}</td>
      <td class="px-4 py-3 text-gray-700">${escapeHtml(w.description)}</td>
      <td class="px-4 py-3 text-right font-bold text-red-600 whitespace-nowrap">${formatCurrency(w.amount)}</td>
      <td class="px-3 py-3 text-center">
        <button
          onclick="deleteWithdrawal(${w.id})"
          class="text-gray-300 hover:text-red-500 transition"
          title="Estornar esta retirada"
        >
          <i class="fa-solid fa-trash text-xs"></i>
        </button>
      </td>
    </tr>`).join("");

  // Entradas estornadas — trilha de auditoria
  const deletedRows = [...deleted].reverse().map((w) => `
    <tr class="border-b text-sm bg-gray-50/80">
      <td class="px-4 py-3 text-gray-400 whitespace-nowrap line-through">${escapeHtml(w.date)}</td>
      <td class="px-4 py-3 text-gray-400 line-through">${escapeHtml(w.description)}</td>
      <td class="px-4 py-3 text-right text-gray-400 line-through whitespace-nowrap">${formatCurrency(w.amount)}</td>
      <td class="px-3 py-3 text-center">
        <span class="inline-flex items-center gap-1 text-[10px] text-gray-400 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded whitespace-nowrap">
          <i class="fa-solid fa-rotate-left text-[9px]"></i>
          Estornado em ${escapeHtml(w.deletedAt ?? "—")}
        </span>
      </td>
    </tr>`).join("");

  tbody.innerHTML = activeRows + deletedRows;

  // Total considera apenas entradas ativas
  const total = active.reduce((acc, w) => acc + w.amount, 0);
  document.getElementById("withdrawal-total-display").innerText = formatCurrency(total);
}

/**
 * Exclui uma retirada do caixa após confirmação.
 */
async function deleteWithdrawal(id) {
  const w = (appState.cashWithdrawals || []).find((w) => w.id === id && !w.isDeleted);
  if (!w) return;

  if (
    !(await showConfirm(
      `Estornar a retirada de ${formatCurrency(w.amount)} (${escapeHtml(w.description)})? O registro ficará visível no histórico como estornado para fins de auditoria.`,
      { type: "warning", title: "Estornar Retirada" },
    ))
  )
    return;

  // Soft delete: preserva o registro original para auditoria.
  // O cálculo de saldo exclui entradas com isDeleted = true.
  appState.cashWithdrawals = appState.cashWithdrawals.map((withdrawal) =>
    withdrawal.id === id
      ? { ...withdrawal, isDeleted: true, deletedAt: new Date().toLocaleString("pt-BR") }
      : withdrawal
  );

  await saveData(() => { renderManagerDashboard(); });
  renderWithdrawalHistory();
  showToast("Retirada estornada. Registro mantido no histórico para auditoria.", "success");
}

/**
 * Confirma e registra uma nova retirada do caixa.
 */
async function confirmCashWithdrawal() {
  if (!_acquireLock()) {
    showToast("Operação em andamento, aguarde.", "warning");
    return;
  }
  try {
    const amount = parseFloat(document.getElementById("withdrawal-amount").value);
    const desc = document.getElementById("withdrawal-desc").value.trim();

    if (isNaN(amount) || amount <= 0) {
      showToast("Informe um valor válido e positivo para a retirada.", "error");
      return; // finally libera o lock
    }

    // Exclui entradas marcadas como deletadas do cálculo de saldo (BUG-006)
    const totalWithdrawn = (appState.cashWithdrawals || [])
      .filter(w => !w.isDeleted)
      .reduce((acc, w) => acc + w.amount, 0);
    const balance = (appState.totalCash || 0) - totalWithdrawn;

    if (amount > balance) {
      showToast(
        `O valor da retirada (${formatCurrency(amount)}) não pode ser maior que o saldo disponível (${formatCurrency(balance)}).`,
        "error",
      );
      return; // finally libera o lock
    }

    if (!appState.cashWithdrawals) appState.cashWithdrawals = [];
    appState.cashWithdrawals.push({
      id: nextLogId(),
      date: new Date().toLocaleString("pt-BR"),
      amount: amount,
      description: desc || "Retirada",
    });

    closeCashWithdrawalModal();
    await saveData(() => { renderManagerDashboard(); });
    showToast(`Retirada de ${formatCurrency(amount)} registrada com sucesso!`, "success");
  } catch (err) {
    console.error("[confirmCashWithdrawal] Erro inesperado:", err);
    showToast(err.message || "Erro ao registrar retirada. Recarregue a página.", "error");
  } finally {
    _releaseLock();
  }
}

// --- RECIBO INDIVIDUAL POR ACERTO ---

/**
 * Prepara e imprime um recibo individual de acerto.
 */
function printReceipt(historyId) {
  const log = appState.history.find((h) => h.id === historyId);
  if (!log) {
    showToast("Detalhes do acerto não encontrados para o recibo.", "error");
    return;
  }

  document.getElementById("print-title").innerText = "Recibo de Acerto";
  document.getElementById("print-date").innerText = log.date;

  const nSales = appState.bandConfig.sales.name;
  const nOwner = appState.bandConfig.owner.name;
  const nDay = appState.bandConfig.dayUser.name;
  const price =
    log.pricePerUnit !== undefined ? log.pricePerUnit : appState.pricePerUnit;

  let tableRows = "";
  if (log.recSales !== undefined) {
    tableRows = `
      <tr>
        <td class="p-2 border">${escapeHtml(nSales)}</td>
        <td class="p-2 border text-center">${log.recSales}</td>
        <td class="p-2 border text-center">${log.retSales}</td>
        <td class="p-2 border text-center font-bold">${log.soldCount}</td>
        <td class="p-2 border text-right font-bold">${formatCurrency(log.soldCount * price)}</td>
      </tr>
      <tr>
        <td class="p-2 border">${escapeHtml(nOwner)}</td>
        <td class="p-2 border text-center">${log.recOwner}</td>
        <td class="p-2 border text-center">${log.retOwner}</td>
        <td class="p-2 border text-center">${log.usedOwner}</td>
        <td class="p-2 border text-right text-gray-400">—</td>
      </tr>
      <tr>
        <td class="p-2 border">${escapeHtml(nDay)}</td>
        <td class="p-2 border text-center">${log.recDay}</td>
        <td class="p-2 border text-center">${log.retDay}</td>
        <td class="p-2 border text-center">${log.usedDay}</td>
        <td class="p-2 border text-right text-gray-400">—</td>
      </tr>`;
  } else {
    tableRows = `<tr><td colspan="5" class="p-3 text-center text-gray-500 text-sm">Detalhes: ${escapeHtml(log.details || "N/A")}</td></tr>`;
  }

  const htmlContent = `
    <div class="border-2 border-gray-300 rounded p-6 mb-6">
      <div class="grid grid-cols-2 gap-3 text-sm mb-5 pb-4 border-b border-gray-200">
        <div><strong>Funcionário:</strong> ${escapeHtml(log.empName)}</div>
        <div><strong>Data / Hora:</strong> ${escapeHtml(log.date)}</div>
        <div><strong>Preço Unit. (Venda):</strong> ${formatCurrency(price)}</div>
      </div>
      <table class="w-full text-sm text-left border border-gray-300 mb-5">
        <thead class="bg-gray-200">
          <tr>
            <th class="p-2 border">Tipo</th>
            <th class="p-2 border text-center">Recebeu</th>
            <th class="p-2 border text-center">Devolveu</th>
            <th class="p-2 border text-center">Usado</th>
            <th class="p-2 border text-right">Valor</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div class="flex justify-between items-center border-t-2 border-gray-800 pt-4">
        <span class="text-xl font-bold">TOTAL A PAGAR:</span>
        <span class="text-4xl font-bold text-green-700">${formatCurrency(log.total)}</span>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-16 mt-16">
      <div class="border-t border-black pt-3 text-center text-sm text-gray-600">Assinatura do Funcionário</div>
      <div class="border-t border-black pt-3 text-center text-sm text-gray-600">Assinatura do Responsável</div>
    </div>`;

  document.getElementById("print-content").innerHTML = htmlContent;
  window.print();
}

// --- GRÁFICOS ---

/**
 * Renderiza os gráficos de ranking de vendas e evolução do caixa.
 */
function renderCharts() {
  // Destrói instâncias anteriores para evitar erro "canvas already in use"
  Object.values(chartInstances).forEach((c) => c.destroy());
  chartInstances = {};

  const chartSection = document.getElementById("charts-section");
  if (!chartSection) return;

  if (appState.history.length === 0) {
    chartSection.classList.add("hidden");
    return;
  }
  chartSection.classList.remove("hidden");

  // --- Gráfico 1: Ranking de vendas por funcionário ---
  const empSalesMap = {};
  appState.history.forEach((log) => {
    empSalesMap[log.empName] = (empSalesMap[log.empName] || 0) + log.sold;
  });
  const sortedEntries = Object.entries(empSalesMap).sort(
    ([, a], [, b]) => b - a,
  );
  const empLabels = sortedEntries.map(([name]) => name);
  const empData = sortedEntries.map(([, val]) => val);

  const ctxEmp = document.getElementById("chart-employees");
  if (ctxEmp) {
    chartInstances.employees = new Chart(ctxEmp, {
      type: "bar",
      data: {
        labels: empLabels,
        datasets: [
          {
            label: "Pulseiras Vendidas",
            data: empData,
            backgroundColor: "rgba(79, 70, 229, 0.7)",
            borderColor: "rgba(79, 70, 229, 1)",
            borderWidth: 1,
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
      },
    });
  }

  // --- Gráfico 2: Saldo real do caixa ao longo do tempo (acertos − retiradas) ---
  // Constrói linha do tempo unificada de acertos (+ receita) e retiradas (- saída)
  const cashEvents = [
    ...appState.history.map(h => ({ ts: h.id, amount: h.total, label: h.date.split(",")[0] })),
    ...(appState.cashWithdrawals || []).map(w => ({ ts: w.id, amount: -w.amount, label: w.date.split(",")[0] })),
  ].sort((a, b) => a.ts - b.ts); // cronológico

  let running = 0;
  const cashPoints = cashEvents.map(e => {
    running += e.amount;
    return parseFloat(running.toFixed(2));
  });
  const cashLabels = cashEvents.map(e => e.label);

  const ctxCash = document.getElementById("chart-cash");
  if (ctxCash) {
    chartInstances.cash = new Chart(ctxCash, {
      type: "line",
      data: {
        labels: cashLabels,
        datasets: [
          {
            label: "Caixa Acumulado (R$)",
            data: cashPoints,
            borderColor: "rgba(22, 163, 74, 1)",
            backgroundColor: "rgba(22, 163, 74, 0.1)",
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 7,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (val) =>
                `R$ ${val.toLocaleString("pt-BR", { minimumFractionDigits: 0 })}`,
            },
          },
        },
      },
    });
  }
}

// --- ALERTA DE ESTOQUE ---

// Timer para debounce do alerta de estoque (evita save a cada tecla)
let _stockThresholdTimer = null;

/**
 * Atualiza o limite de alerta de estoque.
 * Salva apenas 600ms após o último keystroke (debounce).
 */
function updateStockAlertThreshold() {
  clearTimeout(_stockThresholdTimer);
  _stockThresholdTimer = setTimeout(() => {
    const input = document.getElementById("stock-alert-threshold");
    const val = parseInt(input.value, 10);
    if (!isNaN(val) && val >= 0) {
      appState.stockAlertThreshold = val;
      saveData(() => renderStockInfo());
      showToast("Limite de alerta de estoque atualizado!", "success");
    } else {
      showToast("Informe um valor numérico positivo para o limite de alerta.", "error");
    }
  }, 600);
}

// Iniciar App: Adicionamos um listener para garantir que o DOM carregou antes de rodar
document.addEventListener("DOMContentLoaded", init);

// =====================================================================
// NAVEGAÇÃO POR ABAS
// =====================================================================

/**
 * Exibe a aba selecionada e oculta as demais.
 * @param {string} name - 'dashboard' | 'reports' | 'settings'
 */
/**
 * Atalho contextual do card "Estoque Central" no Dashboard.
 * Abre a aba Configurações e rola até a seção de estoque,
 * evitando que o usuário precise procurar o campo na página.
 */
function goToStockSettings() {
  showTab("settings");
  // requestAnimationFrame garante que a aba já está visível antes do scroll
  requestAnimationFrame(() => {
    const section = document.getElementById("settings-stock-section");
    if (section) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
      // Destaque visual temporário para orientar o olhar do usuário
      section.style.transition = "box-shadow 0.3s ease";
      section.style.boxShadow  = "0 0 0 2px #818cf8";
      setTimeout(() => { section.style.boxShadow = ""; }, 1800);
    }
  });
}

function showTab(name) {
  // Oculta todos os conteúdos de aba
  document.querySelectorAll(".tab-content").forEach(function(el) {
    el.classList.add("hidden");
  });

  // Remove estado ativo de todos os botões de aba
  document.querySelectorAll(".tab-nav-btn").forEach(function(btn) {
    btn.classList.remove("tab-active");
    btn.setAttribute("aria-selected", "false");
  });

  // Exibe a aba solicitada
  var tab = document.getElementById("tab-" + name);
  if (tab) tab.classList.remove("hidden");

  // Ativa o botão correspondente
  var btn = document.querySelector(".tab-nav-btn[data-tab=\"" + name + "\"]");
  if (btn) {
    btn.classList.add("tab-active");
    btn.setAttribute("aria-selected", "true");
  }

  // Ao entrar em Relatórios, renderiza os gráficos com dimensões corretas
  if (name === "reports") {
    renderCharts();
    renderHistory();
  }

  // Ao entrar em Configurações, garante que os inputs reflitam o estado atual
  if (name === "settings") {
    var priceInput = document.getElementById("config-price-input");
    if (priceInput) priceInput.value = appState.pricePerUnit;
    var thresholdInput = document.getElementById("stock-alert-threshold");
    if (thresholdInput) thresholdInput.value = appState.stockAlertThreshold;
    renderStockInfo();
    renderBandOptions();
  }
}

// =====================================================================
// MODAL — ADICIONAR FUNCIONÁRIO
// =====================================================================

/**
 * Abre o modal de adição de funcionário com os campos limpos.
 */
function openAddEmployeeModal() {
  var nameInput = document.getElementById("new-emp-name");
  var phoneInput = document.getElementById("new-emp-phone");
  if (nameInput) nameInput.value = "";
  if (phoneInput) phoneInput.value = "";
  var modal = document.getElementById("add-employee-modal");
  if (modal) modal.classList.remove("hidden");
  if (nameInput) setTimeout(function() { nameInput.focus(); }, 50);
}

/**
 * Fecha o modal de adição de funcionário.
 */
function closeAddEmployeeModal() {
  var modal = document.getElementById("add-employee-modal");
  if (modal) modal.classList.add("hidden");
}

/**
 * Adiciona o funcionário e fecha o modal apenas em caso de sucesso.
 * Verifica se um novo funcionário foi de fato inserido antes de fechar.
 */
function addEmployeeFromModal() {
  var prevCount = appState.employees.length;
  addEmployee();
  if (appState.employees.length > prevCount) {
    closeAddEmployeeModal();
  }
}

// =====================================================================
// CARD DE EQUIPE — contagem dinâmica
// =====================================================================

/**
 * Atualiza os contadores do card "Equipe" no Dashboard.
 */
function renderEmployeeSummary() {
  var countEl     = document.getElementById("employee-count-display");
  var pendingEl   = document.getElementById("employee-pending-display");
  var scheduledEl = document.getElementById("employee-scheduled-display");

  if (countEl) countEl.textContent = appState.employees.length;

  if (pendingEl) {
    var pendingCount = appState.employees.filter(function(e) {
      return (e.received || 0) + (e.receivedOwner || 0) + (e.receivedDayUser || 0) > 0;
    }).length;
    pendingEl.textContent = pendingCount;
  }

  if (scheduledEl) {
    var scheduledCount = appState.employees.filter(function(e) {
      return e.scheduleDate || e.scheduleTs;
    }).length;
    scheduledEl.textContent = scheduledCount;
  }
}
