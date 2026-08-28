// ============================================================================
// Ligação ao Supabase — substitui os dois valores abaixo pelos do teu projecto
// (Supabase → Project Settings → API → Project URL / anon public key)
// A anon key é pública por definição (fica exposta no código do browser);
// a segurança real vem das políticas RLS definidas no schema.sql, não daqui.
// ============================================================================
const SUPABASE_URL = "https://iayebkcqvfbzyvlhwfei.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlheWVia2NxdmZienl2bGh3ZmVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NjE4MjcsImV4cCI6MjEwMzMzNzgyN30.JZVSXjYaMstt6qxbemF6Ig-TMR8FBTbxl9jYX9NmZJg";

const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ROTA_POR_ROLE = {
    admin: "admin.html",
    producao: "producao.html",
    armazem: "armazem.html",
    consulta: "consulta.html",
    qualidade: "qualidade.html",
};

const NOME_ROLE_PARTILHADO = { admin: "Admin", producao: "Produção", armazem: "Armazém", consulta: "Consulta", qualidade: "Qualidade" };

/** Mostra um pequeno bloco de atalhos, junto ao sino, para os módulos
 *  extra a que a pessoa tem acesso (multi-perfil) — a versão completa
 *  disto (dropdown do menu hambúrguer) fica para mais tarde, mas sem
 *  algo aqui a funcionalidade não era utilizável já. */
function renderizarAcessosExtra(perfil) {
    if (!perfil?.acessosExtra?.length) return;
    const container = document.querySelector(".bloco-sino");
    if (!container) return;
    const links = perfil.acessosExtra
        .filter((r) => ROTA_POR_ROLE[r])
        .map((r) => `<a href="${ROTA_POR_ROLE[r]}" style="display:block; padding:4px 0; color:var(--ink-suave); text-decoration:none; font-size:13px;">${escaparHtml(NOME_ROLE_PARTILHADO[r] ?? r)}</a>`)
        .join("");
    if (!links) return;
    const bloco = document.createElement("span");
    bloco.style.cssText = "position:relative; display:inline-block; margin-right:10px;";
    bloco.innerHTML = `
        <button class="secundario" style="padding:6px 12px;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'block' ? 'none' : 'block';">Outros acessos</button>
        <div style="display:none; position:absolute; top:calc(100% + 6px); right:0; background:var(--surface); border:1px solid var(--linha); border-radius:var(--raio-peq); box-shadow:var(--sombra); padding:8px 14px; min-width:140px; z-index:100;">${links}</div>
    `;
    container.parentElement.insertBefore(bloco, container);
}

// Nomes de classe CSS não podem ter espaços/acentos — este mapa liga cada
// estado ao respectivo badge definido em css/style.css
const CLASSE_ESTADO = {
    "Registada": "Registada",
    "Em Produção": "Em-Producao",
    "Em Preparação": "Em-Preparacao",
    "Pronta": "Pronta",
    "Carregada": "Carregada",
};

function formatarData(valor) {
    if (!valor) return "—";
    return new Date(valor).toLocaleDateString("pt-PT");
}

/**
 * Escapa HTML antes de inserir texto de utilizador em innerHTML — sem
 * isto, alguém escrever "<script>...</script>" num campo livre (nome de
 * cliente, observações) executava no ecrã de outra pessoa. Cobre & < > "
 * e ' explicitamente (não só < > &), para ser seguro tanto dentro de
 * texto entre tags como dentro de atributos tipo value="...".
 */
function escaparHtml(texto) {
    return String(texto ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

/**
 * Confirma que há sessão activa; se não houver, manda para o login.
 * Chamar no topo de cada página protegida.
 */
async function exigirSessao() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
        window.location.href = "index.html";
        return null;
    }
    return session;
}

/** Obtém nome + role do perfil do utilizador autenticado. */
async function obterPerfil(userId) {
    const { data, error } = await supabaseClient
        .from("perfis")
        .select("nome, role")
        .eq("id", userId)
        .single();
    if (error) {
        console.error("Erro ao obter perfil:", error);
        return null;
    }
    // Acessos extra (multi-perfil) — além do role principal, esta pessoa
    // pode ter direito a entrar noutros módulos (ex. Consulta + Qualidade).
    const { data: extras } = await supabaseClient.from("acessos_extra").select("role").eq("perfil_id", userId);
    data.acessosExtra = (extras ?? []).map((e) => e.role);
    return data;
}

/** Confirma que o perfil actual tem um dos roles esperados nesta página
 *  — pelo principal OU por um acesso extra (multi-perfil) — caso
 *  contrário devolve-o à sua própria página, para evitar acesso cruzado. */
async function exigirRole(rolesPermitidos) {
    const session = await exigirSessao();
    if (!session) return null;
    const perfil = await obterPerfil(session.user.id);
    const temAcesso = perfil && (rolesPermitidos.includes(perfil.role) || perfil.acessosExtra.some((r) => rolesPermitidos.includes(r)));
    if (!temAcesso) {
        window.location.href = ROTA_POR_ROLE[perfil?.role] ?? "index.html";
        return null;
    }
    return { session, perfil };
}

/**
 * Torna a mensagem de erro do Supabase/Postgres compreensível, para os
 * erros mais prováveis de aparecer no uso normal. Erros não mapeados
 * aqui continuam a aparecer tal como o Postgres os devolve — melhor
 * teres alguma informação técnica do que nenhuma.
 */
function traduzirErro(mensagem) {
    if (!mensagem) return "Erro desconhecido.";
    if (mensagem.includes("quantidade_nao_negativa")) {
        return "Não há stock suficiente para esta saída — confirma a quantidade disponível antes de tentares outra vez.";
    }
    if (mensagem.includes("duplicate key value")) {
        return "Já existe um registo igual a este — confirma se não estás a repetir algo já criado.";
    }
    if (mensagem.includes("permission denied") || mensagem.includes("new row violates row-level security")) {
        return "O teu perfil não tem permissão para esta acção.";
    }
    if (mensagem.includes("violates foreign key constraint")) {
        return "Este registo está ligado a outro que ainda existe — não é possível remover/alterar assim.";
    }
    return mensagem;
}

let _cacheArtigos = null;

/** Vai buscar todos os artigos uma única vez por sessão de página (guarda
 *  em cache) — com muitos artigos, filtrar do lado do browser é instantâneo
 *  e evita um pedido à base de dados a cada letra escrita. */
async function obterTodosArtigos() {
    if (_cacheArtigos) return _cacheArtigos;
    const { data, error } = await supabaseClient
        .from("artigos")
        .select("artigo_id, ref_primavera, designacao")
        .order("designacao");
    if (error) { console.error(error); return []; }
    _cacheArtigos = data;
    return data;
}

/**
 * Transforma um par (input de texto + input escondido) numa pesquisa de
 * artigo por código Primavera ou nome — usar em vez de <select> quando há
 * demasiados artigos para um dropdown fazer sentido.
 *   idTexto      — id do <input type="text"> visível, onde a pessoa escreve
 *   idOculto     — id do <input type="hidden"> que fica com o artigo_id
 *   idResultados — id do <div> onde a lista de sugestões aparece
 *   onSelect     — chamado com (artigoId, artigo) sempre que se escolhe um
 */
async function activarPesquisaArtigo(idTexto, idOculto, idResultados, onSelect) {
    const inputTexto = document.getElementById(idTexto);
    const inputOculto = document.getElementById(idOculto);
    const listaResultados = document.getElementById(idResultados);
    const artigos = await obterTodosArtigos();

    let filtradosActuais = [];
    let indiceActivo = -1;

    function realcarItem() {
        listaResultados.querySelectorAll(".sugestao-item").forEach((el, i) => {
            el.classList.toggle("sugestao-activa", i === indiceActivo);
            if (i === indiceActivo) el.scrollIntoView({ block: "nearest" });
        });
    }

    function mostrarResultados(filtro) {
        const termo = filtro.trim().toLowerCase();
        filtradosActuais = termo
            ? artigos.filter((a) =>
                a.ref_primavera.toLowerCase().includes(termo) || a.designacao.toLowerCase().includes(termo)
              ).slice(0, 8)
            : artigos.slice(0, 8);
        indiceActivo = -1;
        listaResultados.innerHTML = filtradosActuais.length
            ? filtradosActuais.map((a) =>
                `<div class="sugestao-item" data-id="${a.artigo_id}">${escaparHtml(a.ref_primavera)} — ${escaparHtml(a.designacao)}</div>`
              ).join("")
            : `<div class="sugestao-vazia">Sem resultados</div>`;
        listaResultados.style.display = "block";
    }

    function seleccionar(artigo) {
        if (!artigo) return;
        inputOculto.value = artigo.artigo_id;
        inputTexto.value = `${artigo.ref_primavera} — ${artigo.designacao}`;
        listaResultados.style.display = "none";
        if (onSelect) onSelect(artigo.artigo_id, artigo);
    }

    inputTexto.addEventListener("focus", () => mostrarResultados(inputTexto.value));
    inputTexto.addEventListener("input", () => {
        inputOculto.value = "";
        mostrarResultados(inputTexto.value);
    });
    // O blur corre antes do click na sugestão — o pequeno atraso deixa o
    // click acontecer primeiro, senão a lista desaparecia sem seleccionar nada.
    inputTexto.addEventListener("blur", () => {
        setTimeout(() => { listaResultados.style.display = "none"; }, 150);
    });
    // Setas para percorrer a lista, Enter para escolher o realçado (ou o
    // primeiro resultado, se ainda não tiveres usado as setas) — sem isto
    // tinhas sempre de tirar a mão do teclado para clicar com o rato.
    inputTexto.addEventListener("keydown", (e) => {
        if (listaResultados.style.display === "none" || !filtradosActuais.length) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            indiceActivo = Math.min(indiceActivo + 1, filtradosActuais.length - 1);
            realcarItem();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            indiceActivo = Math.max(indiceActivo - 1, 0);
            realcarItem();
        } else if (e.key === "Enter") {
            e.preventDefault();
            seleccionar(filtradosActuais[indiceActivo] ?? filtradosActuais[0]);
        } else if (e.key === "Escape") {
            listaResultados.style.display = "none";
        }
    });
    listaResultados.addEventListener("click", (e) => {
        const item = e.target.closest(".sugestao-item");
        if (!item) return;
        seleccionar(artigos.find((a) => a.artigo_id === item.dataset.id));
    });
}

/** Procura um artigo já carregado em cache pelo id — útil depois de a
 *  pessoa escolher um resultado da pesquisa, quando só temos o artigo_id
 *  guardado no input escondido e precisamos do nome para gravar. */
async function obterArtigoPorId(artigoId) {
    const artigos = await obterTodosArtigos();
    return artigos.find((a) => a.artigo_id === artigoId) ?? null;
}

/**
 * Pares de unidades convertíveis entre si (métrico, factor fixo) — usado
 * para deixar escrever "500" + "g" em vez de teres de calcular "0.5" de
 * cabeça quando a unidade base do artigo é "kg". Fora destes pares (ex.
 * "un"), não há conversão — o valor entra tal como escrito.
 */
const PARES_UNIDADE = {
    kg: { g: 1000 },
    g: { kg: 0.001 },
    l: { ml: 1000 },
    ml: { l: 0.001 },
};

/** Opções de unidade a oferecer para uma dada unidade base — a própria
 *  unidade base primeiro (valor 1:1, sem conversão), mais a sua par
 *  métrica se existir (ex. base "kg" -> oferece "kg" e "g"). */
function opcoesUnidadePara(unidadeBase) {
    const base = (unidadeBase ?? "un").toLowerCase();
    const opcoes = [{ valor: base, factor: 1, rotulo: base.toUpperCase() }];
    const par = PARES_UNIDADE[base];
    if (par) {
        for (const [unidade, factor] of Object.entries(par)) {
            opcoes.push({ valor: unidade, factor, rotulo: unidade.toUpperCase() });
        }
    }
    return opcoes;
}

/** Converte um valor escrito numa unidade escolhida para a unidade base
 *  do artigo — ex. converterParaUnidadeBase(500, "g", "kg") -> 0.5. */
function converterParaUnidadeBase(valor, unidadeEscolhida, unidadeBase) {
    const base = (unidadeBase ?? "un").toLowerCase();
    const escolhida = (unidadeEscolhida ?? base).toLowerCase();
    if (escolhida === base) return valor;
    const factor = PARES_UNIDADE[base]?.[escolhida];
    return factor ? valor * factor : valor;
}

/**
 * Gera o código de lote pela fórmula do Excel "Gerador lotes":
 * AA + Categoria + DiaSemanaISO + NºProdução + DiaJuliano(3dig)
 * Partilhada entre admin.html (Criar lote) e producao.html (Produção diária)
 * — é a mesma fórmula, não pode divergir entre os dois ecrãs.
 *
 * Trabalha sempre em UTC a partir dos números (ano/mês/dia), nunca com
 * `new Date(...).getDay()` em hora local — Portugal muda a hora duas
 * vezes por ano, e isso desalinhava o dia juliano em 1 dia sempre que a
 * data de produção caía depois da mudança de Março (hora de Verão).
 */
function calcularCodigoLote(dataProducaoISO, categoria, numeroProducao) {
    const [ano4, mes, dia] = dataProducaoISO.split("-").map(Number);
    const dataUTC = Date.UTC(ano4, mes - 1, dia);
    const diaSemanaISO = new Date(dataUTC).getUTCDay() || 7; // 0 (domingo) → 7
    const inicioAnoUTC = Date.UTC(ano4, 0, 1);
    const diaJuliano = String(Math.round((dataUTC - inicioAnoUTC) / 86400000) + 1).padStart(3, "0");
    const ano = String(ano4 % 100).padStart(2, "0");
    return `${ano}${categoria}${diaSemanaISO}${numeroProducao}${diaJuliano}`;
}

/**
 * Validade sugerida = produção + 365 dias, tal como o Excel "Gerador
 * lotes". Também em UTC puro, pela mesma razão do de cima — sem isso, o
 * toISOString() podia "recuar" um dia sempre que a meia-noite local caía
 * em hora de Verão (GMT+1), porque converte para UTC antes de cortar a
 * data.
 */
function calcularValidadePadrao(dataProducaoISO) {
    const [ano4, mes, dia] = dataProducaoISO.split("-").map(Number);
    const dataUTC = new Date(Date.UTC(ano4, mes - 1, dia));
    dataUTC.setUTCDate(dataUTC.getUTCDate() + 365);
    return dataUTC.toISOString().slice(0, 10);
}

/**
 * A partir de uma lista de produção planeada [{artigo_id, quantidade}],
 * calcula quanto de cada matéria-prima é necessário (explosão de BOM,
 * somada entre todos os produtos do plano) e compara com o stock actual.
 * Devolve [{ artigo_id, designacao, necessario, stock, em_falta }],
 * ordenado por em_falta decrescente (o mais urgente primeiro).
 */
async function calcularNecessidadesMateriais(itensPlano) {
    if (!itensPlano.length) return [];

    const idsProdutos = itensPlano.map((i) => i.artigo_id);
    const { data: bom } = await supabaseClient
        .from("bom_componentes")
        .select("produto_id, componente_id, quantidade_por_unidade, componente:componente_id(designacao)")
        .in("produto_id", idsProdutos);

    const necessidadePorComponente = {};
    (bom ?? []).forEach((linha) => {
        const itemPlano = itensPlano.find((i) => i.artigo_id === linha.produto_id);
        if (!itemPlano) return;
        const necessario = linha.quantidade_por_unidade * itemPlano.quantidade;
        if (!necessidadePorComponente[linha.componente_id]) {
            necessidadePorComponente[linha.componente_id] = {
                artigo_id: linha.componente_id,
                designacao: linha.componente?.designacao ?? "—",
                necessario: 0,
            };
        }
        necessidadePorComponente[linha.componente_id].necessario += necessario;
    });

    const idsComponentes = Object.keys(necessidadePorComponente);
    if (!idsComponentes.length) return [];

    const { data: lotes } = await supabaseClient
        .from("lotes_artigo")
        .select("artigo_id, quantidade_atual")
        .in("artigo_id", idsComponentes);
    const stockPorArtigo = {};
    (lotes ?? []).forEach((l) => {
        stockPorArtigo[l.artigo_id] = (stockPorArtigo[l.artigo_id] || 0) + Number(l.quantidade_atual);
    });

    return Object.values(necessidadePorComponente)
        .map((n) => {
            const stock = stockPorArtigo[n.artigo_id] || 0;
            return { ...n, stock, em_falta: Math.max(0, n.necessario - stock) };
        })
        .sort((a, b) => b.em_falta - a.em_falta);
}

/**
 * Leva sempre ao ecrã inicial do PERFIL REAL de quem está logado — não da
 * página onde estás neste momento. Isto importa quando o admin está a
 * "visitar" o ecrã do Nuno/Fernando/Consulta: clicar no logótipo devolve-o
 * ao admin.html, não fica preso no ecrã que estava a visitar.
 */
async function irParaInicio() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) { window.location.href = "index.html"; return; }
    const perfil = await obterPerfil(session.user.id);
    window.location.href = ROTA_POR_ROLE[perfil?.role] ?? "index.html";
}

let _cacheClientes = null;

/** Equivalente a obterTodosArtigos(), mas para clientes — usado pela
 *  pesquisa de cliente na Nova encomenda. */
async function obterTodosClientes() {
    if (_cacheClientes) return _cacheClientes;
    const { data, error } = await supabaseClient.from("clientes").select("cliente_id, nome").order("nome");
    if (error) { console.error(error); return []; }
    _cacheClientes = data;
    return data;
}

/**
 * Pesquisa de cliente por nome, com o mesmo padrão da pesquisa de artigo
 * (setas + Enter para escolher). Ao contrário da de artigo, permite
 * escrever um nome que ainda não existe — fica sem nada seleccionado no
 * campo escondido, e quem chama decide se cria um cliente novo com esse
 * nome (ver "Nova encomenda" no admin.html).
 */
async function activarPesquisaCliente(idTexto, idOculto, idResultados, onSelect) {
    const inputTexto = document.getElementById(idTexto);
    const inputOculto = document.getElementById(idOculto);
    const listaResultados = document.getElementById(idResultados);
    const clientes = await obterTodosClientes();

    let filtradosActuais = [];
    let indiceActivo = -1;

    function realcarItem() {
        listaResultados.querySelectorAll(".sugestao-item").forEach((el, i) => {
            el.classList.toggle("sugestao-activa", i === indiceActivo);
            if (i === indiceActivo) el.scrollIntoView({ block: "nearest" });
        });
    }

    function mostrarResultados(filtro) {
        const termo = filtro.trim().toLowerCase();
        filtradosActuais = termo
            ? clientes.filter((c) => c.nome.toLowerCase().includes(termo)).slice(0, 8)
            : clientes.slice(0, 8);
        indiceActivo = -1;
        listaResultados.innerHTML = filtradosActuais.length
            ? filtradosActuais.map((c) => `<div class="sugestao-item" data-id="${c.cliente_id}">${escaparHtml(c.nome)}</div>`).join("")
            : `<div class="sugestao-vazia">Sem clientes existentes com esse nome — fica por criar um novo</div>`;
        listaResultados.style.display = "block";
    }

    function seleccionar(cliente) {
        if (!cliente) return;
        inputOculto.value = cliente.cliente_id;
        inputTexto.value = cliente.nome;
        listaResultados.style.display = "none";
        if (onSelect) onSelect(cliente.cliente_id, cliente);
    }

    inputTexto.addEventListener("focus", () => mostrarResultados(inputTexto.value));
    inputTexto.addEventListener("input", () => {
        inputOculto.value = ""; // pode ser um nome novo — decide-se no submit
        mostrarResultados(inputTexto.value);
    });
    inputTexto.addEventListener("blur", () => {
        setTimeout(() => { listaResultados.style.display = "none"; }, 150);
    });
    inputTexto.addEventListener("keydown", (e) => {
        if (listaResultados.style.display === "none" || !filtradosActuais.length) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            indiceActivo = Math.min(indiceActivo + 1, filtradosActuais.length - 1);
            realcarItem();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            indiceActivo = Math.max(indiceActivo - 1, 0);
            realcarItem();
        } else if (e.key === "Enter") {
            if (indiceActivo >= 0) {
                e.preventDefault();
                seleccionar(filtradosActuais[indiceActivo]);
            } // sem item realçado, deixa o Enter seguir para submeter o formulário
        } else if (e.key === "Escape") {
            listaResultados.style.display = "none";
        }
    });
    listaResultados.addEventListener("click", (e) => {
        const item = e.target.closest(".sugestao-item");
        if (!item) return;
        seleccionar(clientes.find((c) => c.cliente_id === item.dataset.id));
    });
}

// --- Sistema de notificações (sino) -----------------------------------------
/** Corre uma vez ao carregar a página protegida — mostra o contador e
 *  actualiza-o periodicamente, sem precisares de recarregar a página. */
async function inicializarAlertas() {
    await actualizarContadorAlertas();
    setInterval(actualizarContadorAlertas, 45000);
}

async function actualizarContadorAlertas() {
    const badge = document.getElementById("badgeAlertasSino");
    if (!badge) return;
    const { count } = await supabaseClient.from("alertas").select("id", { count: "exact", head: true }).eq("lido", false);
    if (count) {
        badge.textContent = count > 9 ? "9+" : String(count);
        badge.style.display = "flex";
    } else {
        badge.style.display = "none";
    }
}

async function alternarPainelAlertas() {
    const painel = document.getElementById("painelAlertas");
    if (!painel) return;
    if (painel.style.display === "block") {
        painel.style.display = "none";
        return;
    }

    const { data, error } = await supabaseClient
        .from("alertas").select("*").order("criado_em", { ascending: false }).limit(30);
    if (error) { console.error(error); return; }

    painel.innerHTML = data.length ? "" : `<p class="sem-alertas">Sem alertas.</p>`;
    data.forEach((a) => {
        const item = document.createElement("div");
        item.className = `item-alerta ${a.lido ? "lido" : "nao-lido"}`;
        item.innerHTML = `
            <strong>${escaparHtml(a.titulo)}</strong>
            <p>${escaparHtml(a.corpo ?? "")}</p>
            <span class="data-alerta">${new Date(a.criado_em).toLocaleString("pt-PT")}</span>
        `;
        item.addEventListener("click", async () => {
            if (!a.lido) {
                await supabaseClient.from("alertas").update({ lido: true }).eq("id", a.id);
            }
            // Cada página resolve a navegação à sua maneira: admin.html tem
            // separadores (mudarSecao), as restantes são de scroll único —
            // tenta a navegação por separador primeiro, senão desliza até
            // ao elemento com esse id.
            if (a.link_secao) {
                if (typeof mudarSecao === "function" && document.querySelector(`.nav-item[data-secao="${a.link_secao}"]`)) {
                    mudarSecao(a.link_secao);
                } else {
                    document.getElementById(a.link_secao)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }
            }
            painel.style.display = "none";
            actualizarContadorAlertas();
        });
        painel.appendChild(item);
    });
    painel.style.display = "block";
}

document.addEventListener("click", (e) => {
    const painel = document.getElementById("painelAlertas");
    const sino = document.getElementById("botaoSino");
    if (painel && painel.style.display === "block" && !painel.contains(e.target) && e.target !== sino && !sino?.contains(e.target)) {
        painel.style.display = "none";
    }
});

// --- Não-conformidades atribuídas a mim (widget partilhado por vários
// ecrãs — Produção, Armazém, Consulta, Admin, além do próprio Qualidade) —
// agora um separador permanente, com provas/soluções anexáveis. ----------
async function carregarMinhasNcPartilhado(meuId) {
    const cartao = document.getElementById("cartaoMinhasNc");
    if (!cartao) return;
    const { data, error } = await supabaseClient
        .from("nc_responsaveis")
        .select("nao_conformidades(id, descricao, gravidade, prazo, estado, accao_correctiva)")
        .eq("perfil_id", meuId);
    if (error) { console.error(error); return; }

    const ncs = (data ?? []).map((d) => d.nao_conformidades).filter((nc) => nc && nc.estado !== "Resolvida");
    const corpo = document.getElementById("corpoMinhasNc");
    corpo.innerHTML = ncs.length ? "" : `<p style="font-size:13px; color:var(--ink-suave);">Sem não-conformidades atribuídas a ti neste momento.</p>`;

    for (const nc of ncs) {
        corpo.appendChild(await construirCartaoNc(nc));
    }
}

/** Constrói o bloco de uma não-conformidade — descrição, acção correctiva,
 *  anexos já existentes (provas/soluções), e os controlos para carregares
 *  mais (foto ou documento, incluindo a partir da câmara do telemóvel). */
async function construirCartaoNc(nc) {
    const div = document.createElement("div");
    div.style.cssText = "border:1px solid var(--linha); border-radius:var(--raio-peq); padding:14px; margin-bottom:12px;";

    const acaoEstado = nc.estado === "Por confirmar"
        ? `<span class="badge Carregada">Aguarda confirmação</span>`
        : `<button onclick="marcarNcPorConfirmarPartilhado('${nc.id}')">Marcar resolvida</button>`;

    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
            <div>
                <strong>${escaparHtml(nc.descricao)}</strong>
                <p style="font-size:12px; color:var(--ink-suave); margin:2px 0 0;">
                    ${escaparHtml(nc.gravidade)} · ${nc.prazo ? "Prazo: " + formatarData(nc.prazo) : "sem prazo"} · ${escaparHtml(nc.estado)}
                </p>
                ${nc.accao_correctiva ? `<p style="font-size:13px; margin:6px 0 0;">${escaparHtml(nc.accao_correctiva)}</p>` : ""}
            </div>
            <div>${acaoEstado}</div>
        </div>
        <div id="anexos-nc-${nc.id}" style="margin-top:10px;"></div>
        <div class="linha-form" style="margin-top:10px;">
            <label class="secundario" style="text-align:center; cursor:pointer; display:block;">
                Anexar prova
                <input type="file" accept="image/*,application/pdf,.doc,.docx" capture="environment" style="display:none;" onchange="carregarAnexoNc('${nc.id}', 'prova', this)">
            </label>
            <label class="secundario" style="text-align:center; cursor:pointer; display:block;">
                Anexar solução
                <input type="file" accept="image/*,application/pdf,.doc,.docx" capture="environment" style="display:none;" onchange="carregarAnexoNc('${nc.id}', 'solucao', this)">
            </label>
        </div>
    `;
    renderizarAnexosNc(nc.id, div.querySelector(`#anexos-nc-${nc.id}`));
    return div;
}

async function renderizarAnexosNc(ncId, container) {
    const { data, error } = await supabaseClient
        .from("nc_anexos")
        .select("id, tipo, caminho_ficheiro, nome_original, perfis(nome)")
        .eq("nao_conformidade_id", ncId)
        .order("carregado_em", { ascending: true });
    if (error) { console.error(error); return; }
    if (!data.length) { container.innerHTML = ""; return; }

    const provas = data.filter((a) => a.tipo === "prova");
    const solucoes = data.filter((a) => a.tipo === "solucao");
    const listaHtml = (itens) => itens.map((a) =>
        `<a href="#" onclick="abrirAnexoNc('${a.caminho_ficheiro}'); return false;" style="display:block; font-size:13px; color:var(--accent-forte);">
            <i class="ti ti-paperclip" style="font-size:13px; vertical-align:-1px;" aria-hidden="true"></i>
            ${escaparHtml(a.nome_original ?? "ficheiro")} <span style="color:var(--ink-suave);">— ${escaparHtml(a.perfis?.nome ?? "—")}</span>
        </a>`
    ).join("");

    container.innerHTML = `
        ${provas.length ? `<p style="font-size:12px; font-weight:600; margin:8px 0 2px;">Provas</p>${listaHtml(provas)}` : ""}
        ${solucoes.length ? `<p style="font-size:12px; font-weight:600; margin:8px 0 2px;">Soluções</p>${listaHtml(solucoes)}` : ""}
    `;
}

async function carregarAnexoNc(ncId, tipo, inputEl) {
    const ficheiro = inputEl.files[0];
    if (!ficheiro) return;
    if (ficheiro.size > 15 * 1024 * 1024) { toast("Ficheiro demasiado grande (máx. 15MB).", "erro"); inputEl.value = ""; return; }

    const caminho = `${ncId}/${Date.now()}_${ficheiro.name}`;
    const { error: erroUpload } = await supabaseClient.storage.from("nc-anexos").upload(caminho, ficheiro);
    if (erroUpload) { toast("Erro ao carregar: " + erroUpload.message, "erro"); return; }

    const { error: erroRegisto } = await supabaseClient.from("nc_anexos").insert({
        nao_conformidade_id: ncId, tipo, caminho_ficheiro: caminho, nome_original: ficheiro.name, tipo_mime: ficheiro.type,
    });
    if (erroRegisto) { toast("Erro ao registar anexo: " + erroRegisto.message, "erro"); return; }

    toast("Anexo carregado.", "sucesso");
    inputEl.value = "";
    renderizarAnexosNc(ncId, document.getElementById(`anexos-nc-${ncId}`));
}

async function abrirAnexoNc(caminho) {
    const { data, error } = await supabaseClient.storage.from("nc-anexos").createSignedUrl(caminho, 300);
    if (error) { toast("Não foi possível abrir o ficheiro: " + error.message, "erro"); return; }
    window.open(data.signedUrl, "_blank");
}

async function marcarNcPorConfirmarPartilhado(ncId) {
    const { error } = await supabaseClient.from("nao_conformidades")
        .update({ estado: "Por confirmar", resolvido_em: new Date().toISOString() })
        .eq("id", ncId);
    if (error) { toast("Erro: " + error.message, "erro"); return; }
    toast("Marcado como resolvido — a Qualidade vai confirmar.", "sucesso");
    const { data: { session } } = await supabaseClient.auth.getSession();
    carregarMinhasNcPartilhado(session.user.id);
    actualizarContadorAlertas();
}

// --- Cabeçalho comum para todos os PDFs do site — logótipo + cores da
// marca, em vez de cada exportação desenhar o seu próprio título a preto
// e branco. ------------------------------------------------------------
let _logoBase64Cache = null;

async function obterLogoBase64() {
    if (_logoBase64Cache) return _logoBase64Cache;
    const resposta = await fetch("img/logo.png");
    const blob = await resposta.blob();
    _logoBase64Cache = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
    return _logoBase64Cache;
}

/** Desenha o logótipo + título + subtítulo no topo de um PDF já criado
 *  (new jsPDF()) — devolve o Y a partir do qual a tabela pode começar,
 *  para não sobrepor o cabeçalho. */
async function iniciarPdfComMarca(doc, titulo, subtitulo) {
    try {
        const logo = await obterLogoBase64();
        doc.addImage(logo, "PNG", 14, 10, 30, 13);
    } catch (erro) {
        console.error("Logótipo não carregou no PDF:", erro);
    }
    doc.setTextColor(34, 63, 56); // var(--accent-forte)
    doc.setFontSize(16);
    doc.text(titulo, 50, 18);
    if (subtitulo) {
        doc.setFontSize(10);
        doc.setTextColor(100, 100, 100);
        doc.text(subtitulo, 50, 24);
    }
    doc.setTextColor(0, 0, 0);
    return 34;
}

// Estilo de cabeçalho de tabela a passar em headStyles nas chamadas a
// doc.autoTable(...) — cor da marca em vez do cinzento por defeito.
const ESTILO_CABECALHO_TABELA_PDF = { fillColor: [34, 63, 56] };

async function terminarSessao() {
    await supabaseClient.auth.signOut();
    window.location.href = "index.html";
}

/**
 * Notificação discreta no canto do ecrã, em vez do alert() nativo do
 * browser — usa tipo "sucesso" ou "erro" para dar cor semântica.
 * Cria a zona de toasts sozinha se ainda não existir na página.
 */
function toast(mensagem, tipo = "info") {
    let zona = document.getElementById("zona-toasts");
    if (!zona) {
        zona = document.createElement("div");
        zona.id = "zona-toasts";
        document.body.appendChild(zona);
    }
    const el = document.createElement("div");
    el.className = `toast ${tipo}`;
    el.textContent = mensagem;
    zona.appendChild(el);
    setTimeout(() => el.remove(), 5000);
}

/**
 * Janela persistente para mostrar uma password gerada — não some sozinha
 * como o toast, porque a pessoa precisa de tempo para a copiar e partilhar.
 */
function mostrarModalPassword(titulo, password) {
    const fundo = document.createElement("div");
    fundo.style.cssText = "position:fixed; inset:0; background:rgba(32,31,28,0.5); display:flex; align-items:center; justify-content:center; z-index:2000;";
    fundo.innerHTML = `
        <div style="background:var(--surface); border-radius:14px; padding:28px; max-width:360px; width:90%; box-shadow:0 12px 40px rgba(0,0,0,0.25);">
            <h2 style="margin:0 0 6px; font-size:17px;">${escaparHtml(titulo)}</h2>
            <p style="font-size:13px; color:var(--ink-suave); margin:0 0 16px;">Partilha isto agora — não fica guardado em lado nenhum.</p>
            <div style="display:flex; gap:8px; align-items:center; background:var(--surface-recuado); border-radius:8px; padding:12px 14px; margin-bottom:16px;">
                <code class="mono" style="font-size:16px; flex:1;">${escaparHtml(password)}</code>
                <button class="secundario" id="btnCopiarPassword" style="padding:6px 12px; font-size:13px;">Copiar</button>
            </div>
            <button id="btnFecharModalPassword" style="width:100%;">Fechar</button>
        </div>
    `;
    document.body.appendChild(fundo);
    document.getElementById("btnCopiarPassword").addEventListener("click", async () => {
        await navigator.clipboard.writeText(password);
        toast("Password copiada.", "sucesso");
    });
    document.getElementById("btnFecharModalPassword").addEventListener("click", () => fundo.remove());
}
