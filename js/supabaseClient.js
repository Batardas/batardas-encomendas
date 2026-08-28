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
    producao: "nuno.html",
    armazem: "fernando.html",
    consulta: "consulta.html",
};

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
    return data;
}

/** Confirma que o perfil actual tem um dos roles esperados nesta página; caso
 *  contrário devolve-o à sua própria página, para evitar acesso cruzado. */
async function exigirRole(rolesPermitidos) {
    const session = await exigirSessao();
    if (!session) return null;
    const perfil = await obterPerfil(session.user.id);
    if (!perfil || !rolesPermitidos.includes(perfil.role)) {
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
 * Partilhada entre admin.html (Criar lote) e nuno.html (Produção diária)
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
