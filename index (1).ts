// Supabase Edge Function — envia alertas por email sempre que um Database
// Webhook dispara esta função (ver README, secção "Configurar alertas por
// email"). Trata três eventos diferentes, cada um com destinatários próprios:
//   1. Novo pedido de armazém (INSERT, estado=Pendente) -> admin + Fernando
//   2. Pedido atendido (UPDATE, estado passa a Atendido) -> Nuno
//   3. Novo movimento de stock (INSERT) -> admin
//
// Recebe o payload padrão de um Database Webhook do Supabase:
//   { type: "INSERT" | "UPDATE", table: "...", record: {...}, old_record?: {...} }
//
// Usa a API da Resend (https://resend.com) para enviar o email — free tier
// de 100 emails/dia é muito acima do que este volume precisa. Não é preciso
// servidor de email próprio nem SMTP.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
// Aceita um ou vários emails no mesmo secret, separados por vírgula — ex.
// "francisco@batardas.pt, monica@batardas.pt". A API do Resend precisa de
// uma lista (array), não de uma string com vírgulas, por isso convertemos
// aqui antes de enviar.
const EMAILS_ADMIN = Deno.env.get("EMAIL_ALERTA_DESTINO")!
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
const EMAIL_REMETENTE = Deno.env.get("EMAIL_ALERTA_REMETENTE") ?? "alertas@resend.dev";
const SEGREDO_WEBHOOK = Deno.env.get("WEBHOOK_SECRET")!;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/**
 * Vai buscar os emails de quem tem um determinado perfil (role) — em vez
 * de guardar o email do Fernando/Nuno num secret à parte, lê-se sempre o
 * que já está registado como utilizador da app. Assim, se um dia mudares
 * o email de alguém em "Utilizadores", os alertas seguem sozinhos, sem
 * teres de mexer em nenhum secret.
 */
async function obterEmailsPorRole(role: string): Promise<string[]> {
    const { data: perfis } = await adminClient.from("perfis").select("id").eq("role", role);
    if (!perfis?.length) return [];
    const emails = await Promise.all(
        perfis.map(async (p) => {
            const { data } = await adminClient.auth.admin.getUserById(p.id);
            return data.user?.email ?? null;
        }),
    );
    return emails.filter((e): e is string => !!e);
}

async function enviarEmail(destinatarios: string[], assunto: string, corpo: string) {
    if (!destinatarios.length) {
        console.error("Sem destinatários para:", assunto);
        return;
    }
    const resposta = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            from: EMAIL_REMETENTE,
            to: destinatarios,
            subject: assunto,
            html: corpo,
        }),
    });
    if (!resposta.ok) {
        console.error("Falha ao enviar email:", await resposta.text());
    }
}

async function montarMensagemPedido(pedido: Record<string, unknown>): Promise<{ assunto: string; corpo: string }> {
    let descricaoArtigo = "—";
    if (pedido.artigo_id) {
        const { data } = await adminClient.from("artigos").select("designacao").eq("artigo_id", pedido.artigo_id as string).maybeSingle();
        if (data) descricaoArtigo = data.designacao;
    }
    return {
        assunto: "Novo pedido de armazém do Nuno",
        corpo: `
            <p>O Nuno criou um novo pedido de armazém.</p>
            <p><strong>Artigo:</strong> ${descricaoArtigo}</p>
            <p><strong>Quantidade:</strong> ${pedido.quantidade}</p>
            <p><strong>Data:</strong> ${new Date(pedido.data_pedido as string).toLocaleString("pt-PT")}</p>
            <p>Abre a app para veres os detalhes e atenderes.</p>
        `,
    };
}

async function montarMensagemPedidoAtendido(pedido: Record<string, unknown>): Promise<{ assunto: string; corpo: string }> {
    let descricaoArtigo = "—";
    if (pedido.artigo_id) {
        const { data } = await adminClient.from("artigos").select("designacao").eq("artigo_id", pedido.artigo_id as string).maybeSingle();
        if (data) descricaoArtigo = data.designacao;
    }
    return {
        assunto: "O teu pedido de armazém foi atendido",
        corpo: `
            <p>O Fernando atendeu o pedido de armazém que fizeste.</p>
            <p><strong>Artigo:</strong> ${descricaoArtigo}</p>
            <p><strong>Quantidade:</strong> ${pedido.quantidade}</p>
        `,
    };
}

async function montarMensagemMovimento(mov: Record<string, unknown>): Promise<{ assunto: string; corpo: string }> {
    const tipo = mov.tipo as string;

    // Vai buscar os nomes reais (artigo, lote) em vez de mostrar só UUIDs —
    // é o que torna o email suficiente para passar directo para o Primavera,
    // sem teres de abrir a app para veres a que é que o movimento se refere.
    let descricaoOrigem = "—";
    if (mov.lote_artigo_id) {
        const { data } = await adminClient
            .from("lotes_artigo")
            .select("numero_lote, artigos(designacao)")
            .eq("lote_artigo_id", mov.lote_artigo_id as string)
            .maybeSingle();
        if (data) descricaoOrigem = `${(data.artigos as { designacao?: string } | null)?.designacao ?? "—"} · lote ${data.numero_lote}`;
    }

    let descricaoDestino = "";
    if (mov.lote_artigo_destino_id) {
        const { data } = await adminClient
            .from("lotes_artigo")
            .select("numero_lote, artigos(designacao)")
            .eq("lote_artigo_id", mov.lote_artigo_destino_id as string)
            .maybeSingle();
        if (data) descricaoDestino = `${(data.artigos as { designacao?: string } | null)?.designacao ?? "—"} · lote ${data.numero_lote}`;
    }

    let nomeResponsavel = "—";
    if (mov.responsavel) {
        const { data } = await adminClient
            .from("perfis")
            .select("nome")
            .eq("id", mov.responsavel as string)
            .maybeSingle();
        if (data) nomeResponsavel = data.nome;
    }

    return {
        assunto: `Movimento por registar no Primavera — ${tipo} (${nomeResponsavel})`,
        corpo: `
            <p><strong>${nomeResponsavel}</strong> preencheu um movimento de stock no site — falta passares isto para o Primavera.</p>
            <p><strong>Tipo:</strong> ${tipo}</p>
            <p><strong>Artigo/Lote:</strong> ${descricaoOrigem}</p>
            ${descricaoDestino ? `<p><strong>Destino:</strong> ${descricaoDestino}</p>` : ""}
            <p><strong>Quantidade:</strong> ${mov.quantidade} ${mov.unidade_movimentacao ?? "un"}</p>
            <p><strong>Data:</strong> ${new Date(mov.data_movimento as string).toLocaleString("pt-PT")}</p>
            ${mov.observacoes ? `<p><strong>Observações:</strong> ${mov.observacoes}</p>` : ""}
            <p>Depois de o passares, marca "Registado" na secção "Movimentos por registar no Primavera" do teu ecrã.</p>
        `,
    };
}

serve(async (req) => {
    if (req.method !== "POST") {
        return new Response("Método não permitido", { status: 405 });
    }

    // Sem isto, qualquer pessoa que soubesse o URL desta função podia enviar
    // pedidos falsos e fazer-te chegar emails fabricados. O Database Webhook
    // do Supabase permite configurar um cabeçalho customizado — é aí que
    // defines este segredo (ver README).
    const segredoRecebido = req.headers.get("x-webhook-secret");
    if (segredoRecebido !== SEGREDO_WEBHOOK) {
        return new Response("Não autorizado", { status: 401 });
    }

    const payload = await req.json();
    const { type, table, record, old_record } = payload;

    if (table === "pedidos_armazem" && type === "INSERT" && record.estado === "Pendente") {
        const mensagem = await montarMensagemPedido(record);
        const emailsFernando = await obterEmailsPorRole("armazem");
        await enviarEmail([...EMAILS_ADMIN, ...emailsFernando], mensagem.assunto, mensagem.corpo);
    } else if (table === "pedidos_armazem" && type === "UPDATE" && record.estado === "Atendido" && old_record?.estado !== "Atendido") {
        const mensagem = await montarMensagemPedidoAtendido(record);
        const emailsNuno = await obterEmailsPorRole("producao");
        await enviarEmail(emailsNuno, mensagem.assunto, mensagem.corpo);
    } else if (table === "movimentos_stock" && type === "INSERT") {
        const mensagem = await montarMensagemMovimento(record);
        await enviarEmail(EMAILS_ADMIN, mensagem.assunto, mensagem.corpo);
    }

    return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
    });
});
