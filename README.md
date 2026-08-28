# Batardas — Gestão de Encomendas

Fase 1 completa e funcional: encomendas, 4 perfis de acesso, PDF semanal.
Fases 2 (stock/lotes) e 3 (pedidos de armazém) já têm tabelas criadas no
schema — faltam só os ecrãs, para quando decidires avançar.

## 1. Criar o projecto Supabase

1. Vai a [supabase.com](https://supabase.com) → cria conta (grátis, sem cartão) → **New project**.
2. Anota a **Project URL** e a **anon public key** (Project Settings → API).
3. Anota também a **service_role key** (mesma página) — só é usada no script Python, nunca no site.

## 2. Correr o schema

1. No Supabase: **Database → SQL Editor → New query**.
2. Copia todo o conteúdo de `sql/schema.sql`, cola, **Run**.
3. Confirma em **Table Editor** que apareceram as tabelas (`encomendas`, `perfis`, `artigos`, etc.).

## 3. Criar a tua própria conta (só esta é manual)

Todas as contas seguintes (Mónica, Nuno, Fernando, Maria, Gonçalo) vais
criá-las depois dentro da própria app, no ecrã "Utilizadores e acessos" —
mas a tua primeira conta admin tem de existir antes de conseguires entrar,
por isso esta é a única que crias aqui manualmente:

1. **Authentication → Users → Add user** → o teu email + uma password.
2. **Table Editor → perfis → Insert row**:
   - `id` = o UUID que acabaste de criar (copia de Authentication → Users)
   - `nome` = o teu nome
   - `role` = `admin`

## 4. Ligar o site ao teu projecto

Abre `js/supabaseClient.js` e substitui:
```js
const SUPABASE_URL = "https://SEU-PROJETO.supabase.co";
const SUPABASE_ANON_KEY = "SUA-CHAVE-ANONIMA-PUBLICA";
```
pelos valores do passo 1.

## 5. Publicar no GitHub Pages

1. Cria um repositório novo no teu GitHub (ex. `batardas-encomendas`).
2. Sobe todos estes ficheiros para o repositório (podes arrastar para a interface web do GitHub, não precisas de git na linha de comandos).
3. **Settings → Pages → Source: Deploy from a branch → Branch: main → / (root)**.
4. Ao fim de ~1 minuto o site fica disponível em `https://o-teu-utilizador.github.io/batardas-encomendas/`.
5. Cria um atalho a esse link no ambiente de trabalho de cada PC (Nuno, Fernando) e nos favoritos do teu browser e do da Mónica.

## 6. Carregar os artigos do Primavera (quando avançares para a Fase 2)

```bash
pip install supabase python-dotenv
python scripts/importar_artigos.py carregar exportacao_primavera.csv
```

Depois, periodicamente (sugestão: semanal), corre a reconciliação para
apanhares desvios entre o Primavera e a app — nunca sobrepõe automaticamente,
só assinala diferenças para reveres:
```bash
python scripts/importar_artigos.py reconciliar exportacao_primavera.csv
```

## Configurar a gestão de utilizadores (criar contas + repor passwords)

1. No Supabase: **Edge Functions → Deploy a new function** → nome `gerir-utilizadores` → cola o conteúdo de `supabase/functions/gerir-utilizadores/index.ts`.
   - Via CLI: `supabase functions deploy gerir-utilizadores`.
2. Não precisas de configurar segredos aqui — `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` já vêm automaticamente disponíveis em toda a Edge Function.
3. Confirma em **Edge Functions → gerir-utilizadores → Invocations** que aparece um pedido bem-sucedido depois de testares no ecrã "Utilizadores e acessos".

A partir daqui, criar contas e repor passwords passa a fazer-se inteiramente
dentro da tua página — nunca mais precisas de abrir o painel do Supabase
para isto. A password é sempre gerada automaticamente (não escolhes tu) e
mostrada uma única vez, para partilhares de imediato — não fica guardada
em lado nenhum, nem na base de dados nem no ecrã depois de fechares o aviso.

## Configurar alertas por email (pedidos, atendimentos e movimentos)

Isto avisa por email, mesmo com a app fechada:
- **Ti/Mónica** — quando o Nuno cria um pedido de armazém, e quando o Fernando regista um movimento de stock.
- **Fernando** — quando o Nuno cria um pedido de armazém (para saberes que tens algo para atender).
- **Nuno** — quando o Fernando atende um pedido teu.

Os emails do Fernando e do Nuno não ficam em nenhum secret — a função vai
buscá-los directamente aos perfis (`armazem`/`producao`) já criados na app,
por isso não precisas de repetir nada aqui se um dia mudares o email de
alguém em "Utilizadores".

O badge vermelho no teu ecrã (contagem de pendentes) já funciona sem nada
disto — isto é só o email adicional.

1. Cria conta grátis em [resend.com](https://resend.com) (100 emails/dia grátis, sem cartão).
2. **API Keys → Create API Key** → copia a chave.
3. No Supabase: **Edge Functions → Deploy a new function** → nome `notificar-alerta` → cola o conteúdo de `supabase/functions/notificar-alerta/index.ts`.
   - Se preferires a linha de comandos: `supabase functions deploy notificar-alerta` (precisa do [Supabase CLI](https://supabase.com/docs/guides/cli) instalado).
4. **Edge Functions → Secrets** (nível do projecto, partilhado por todas as funções), adiciona:
   - `RESEND_API_KEY` = a chave do passo 2
   - `EMAIL_ALERTA_DESTINO` = o teu email e o da Mónica, separados por vírgula (ex. `francisco.sena@batardas.pt, monica.martins@batardas.pt`)
   - `WEBHOOK_SECRET` = uma frase à tua escolha, só tua (ex. gera uma em [1password.com/password-generator](https://1password.com/password-generator/)) — é o que impede alguém de descobrir o URL da função e enviar-te emails falsos.
5. **Database → Webhooks → Create a new webhook** — precisas de **três** (um por evento):
   - `alerta-pedido-criado` · Tabela: `pedidos_armazem` · Evento: `Insert` · Tipo: `Supabase Edge Function` · Função: `notificar-alerta`
   - `alerta-pedido-atendido` · Tabela: `pedidos_armazem` · Evento: `Update` · Tipo: `Supabase Edge Function` · Função: `notificar-alerta`
   - `alerta-movimento-stock` · Tabela: `movimentos_stock` · Evento: `Insert` · Tipo: `Supabase Edge Function` · Função: `notificar-alerta`
   - Em cada um, na secção **HTTP Headers**, adiciona um cabeçalho `x-webhook-secret` com o mesmo valor que puseste em `WEBHOOK_SECRET` no passo 4.
6. Testa: cria um pedido de armazém no ecrã do Nuno → tu e o Fernando devem receber email. Marca-o como atendido no ecrã do Fernando → o Nuno deve receber email.

## Fluxo de estados das encomendas

```
Registada → Em Produção → Em Preparação → Pronta → Carregada
   (tu)         (Nuno)        (Fernando)    (Fernando)   (tu/Mónica)
```

## Estrutura do repositório

```
├── index.html          Login, encaminha por perfil
├── nuno.html            Produção — marca "Em Produção" concluída
├── fernando.html         Preparação/armazém — picking
├── admin.html            Francisco/Mónica — regista, carrega, gera PDF
├── consulta.html         Maria/Gonçalo — só leitura
├── css/style.css
├── js/supabaseClient.js
├── sql/schema.sql        Corre isto no Supabase
├── scripts/importar_artigos.py   Carga inicial + reconciliação Primavera
└── supabase/functions/notificar-alerta/   Envia o email de alerta ao Francisco
```
