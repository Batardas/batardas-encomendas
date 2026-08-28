// Supabase Edge Function — gestão de utilizadores (criar + repor password)
//
// Corre do lado do servidor porque estas acções exigem a service role key,
// que nunca pode estar no código do browser (dava acesso total à base de
// dados a qualquer pessoa que abrisse "ver código-fonte" na página).
//
// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY são injectadas
// automaticamente pelo Supabase em toda a Edge Function — não precisas de
// as configurar à mão como fizeste para a RESEND_API_KEY.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(corpo: unknown, status = 200) {
    return new Response(JSON.stringify(corpo), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

function gerarPassword(): string {
    // Legível o suficiente para comunicar por telefone/papel, mas com
    // entropia real: 6 dígitos (1M combinações) em vez de 4 — com o
    // Attack Protection do Supabase sem CAPTCHA activo, 4 dígitos (9000
    // hipóteses) era adivinhável por tentativa e erro.
    const digitos = Math.floor(100000 + Math.random() * 900000);
    return `Batardas-${digitos}`;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Não autenticado" }, 401);

    // Verifica QUEM está a chamar isto, usando o próprio token dele — nunca
    // confiar cegamente num "sou admin" vindo do corpo do pedido.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: erroUtilizador } = await userClient.auth.getUser();
    if (erroUtilizador || !user) return json({ error: "Sessão inválida" }, 401);

    const { data: perfil } = await adminClient.from("perfis").select("role").eq("id", user.id).single();
    if (perfil?.role !== "admin") {
        return json({ error: "Só administradores podem gerir utilizadores" }, 403);
    }

    const { acao, ...corpo } = await req.json();

    if (acao === "listar_utilizadores") {
        const { data: perfis, error } = await adminClient.from("perfis").select("id, nome, role");
        if (error) return json({ error: error.message }, 400);

        const comEmail = await Promise.all(
            perfis.map(async (p) => {
                const { data } = await adminClient.auth.admin.getUserById(p.id);
                return { ...p, email: data.user?.email ?? "—" };
            }),
        );
        return json({ utilizadores: comEmail });
    }

    if (acao === "criar_utilizador") {
        const { email, nome, role } = corpo;
        if (!email || !nome || !role) return json({ error: "Faltam dados" }, 400);

        const passwordInicial = gerarPassword();
        const { data: novoUtilizador, error: erroCriar } = await adminClient.auth.admin.createUser({
            email,
            password: passwordInicial,
            email_confirm: true,
        });
        if (erroCriar) return json({ error: erroCriar.message }, 400);

        const { error: erroPerfil } = await adminClient
            .from("perfis")
            .insert({ id: novoUtilizador.user.id, nome, role });
        if (erroPerfil) return json({ error: erroPerfil.message }, 400);

        return json({ ok: true, password: passwordInicial });
    }

    if (acao === "repor_password") {
        const { userId } = corpo;
        if (!userId) return json({ error: "Falta o utilizador" }, 400);

        const novaPassword = gerarPassword();
        const { error } = await adminClient.auth.admin.updateUserById(userId, { password: novaPassword });
        if (error) return json({ error: error.message }, 400);

        return json({ ok: true, password: novaPassword });
    }

    return json({ error: "Acção desconhecida" }, 400);
});
