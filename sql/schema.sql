-- ============================================================================
-- BATARDAS — Gestão de Encomendas, Produção e Stock
-- Schema Supabase (Postgres) — corre este ficheiro inteiro no SQL Editor
-- do teu projecto Supabase (Database → SQL Editor → New query → colar → Run)
-- ============================================================================

create extension if not exists "uuid-ossp";

-- Garante as permissões de base que o Supabase normalmente já configura
-- sozinho. Só é preciso repetir isto explicitamente se alguma vez tiveres
-- de limpar o schema com DROP SCHEMA public CASCADE — esse comando apaga
-- estas permissões junto com as tabelas, e sem elas a RLS não chega a ser
-- avaliada: o Postgres bloqueia antes, com "permission denied".
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;

-- ============================================================================
-- PERFIS E PAPÉIS DE ACESSO
-- ============================================================================
-- Usa-se uma tabela `perfis` ligada a auth.users em vez de meter o "role"
-- directamente no auth.users, porque o Supabase Auth não deixa adicionar
-- colunas customizadas a essa tabela — é o padrão recomendado pela própria
-- Supabase para dados de perfil/role.
create type user_role as enum ('admin', 'producao', 'armazem', 'consulta', 'qualidade');

create table public.perfis (
    id uuid primary key references auth.users(id) on delete cascade,
    nome text not null,
    role user_role not null default 'consulta',
    criado_em timestamptz not null default now()
);

comment on table public.perfis is
    'admin = Francisco/Mónica (tudo) | producao = Nuno | armazem = Fernando | consulta = Maria/Gonçalo (só leitura)';

-- Função auxiliar: devolve o role do utilizador autenticado. Fica logo
-- aqui no topo (não junto às políticas RLS lá mais abaixo) porque várias
-- políticas ao longo do ficheiro precisam dela, e uma função tem de existir
-- antes de qualquer coisa que a use.
create or replace function public.meu_role()
returns user_role as $$
    select role from public.perfis where id = auth.uid();
$$ language sql stable security definer set search_path = public;

revoke execute on function public.meu_role() from public;
grant execute on function public.meu_role() to authenticated;

-- Tipo usado em linhas_encomenda e movimentos_stock — definido aqui em cima
-- porque linhas_encomenda (mais abaixo, na Fase 1) já precisa dele.
create type unidade_movimentacao as enum ('un', 'pack', 'caixa', 'palete');

-- ============================================================================
-- FASE 1 — ENCOMENDAS
-- ============================================================================
create table public.clientes (
    cliente_id uuid primary key default uuid_generate_v4(),
    nome text not null,
    contacto text
);

-- Estados alargados para reflectir os 3 intervenientes reais:
-- Nuno produz -> Fernando prepara/faz picking -> Francisco/Mónica carrega
create type estado_encomenda as enum (
    'Registada', 'Em Produção', 'Em Preparação', 'Pronta', 'Carregada'
);
create type canal_encomenda as enum ('Email', 'Telefone', 'Presencial');

create table public.encomendas (
    encomenda_id uuid primary key default uuid_generate_v4(),
    cliente_id uuid references public.clientes(cliente_id),
    canal canal_encomenda not null default 'Telefone',
    data_pedido timestamptz not null default now(),
    data_entrega_pretendida date not null,
    estado estado_encomenda not null default 'Registada',
    data_conclusao_producao timestamptz,
    concluido_producao_por uuid references public.perfis(id),
    data_conclusao_preparacao timestamptz,
    preparado_por uuid references public.perfis(id),
    data_hora_carregamento timestamptz,
    carregado_por uuid references public.perfis(id),
    observacoes text,
    criado_por uuid references public.perfis(id) default auth.uid(),
    criado_em timestamptz not null default now()
);

-- artigo_id liga a linha ao stock de produto acabado (artigos) — a foreign
-- key só é adicionada mais abaixo, depois de a tabela artigos ser criada
-- (Postgres não permite referenciar uma tabela que ainda não existe).
-- Fica nullable porque nem toda a gente regista sempre por artigo.
-- unidade_movimentacao/quantidade_base: a encomenda é feita na unidade que
-- fizer sentido para o cliente (pack, caixa, palete), mas o stock é sempre
-- controlado em unidade base — quantidade_base é o valor já convertido,
-- calculado no momento da inserção (ver trigger calcular_quantidade_base),
-- para o planeamento semanal poder comparar sem ter de reconverter sempre.
create table public.linhas_encomenda (
    linha_id uuid primary key default uuid_generate_v4(),
    encomenda_id uuid not null references public.encomendas(encomenda_id) on delete cascade,
    produto text not null,
    artigo_id uuid,
    unidade_movimentacao unidade_movimentacao not null default 'un',
    quantidade_pedida numeric not null check (quantidade_pedida > 0),
    quantidade_base numeric
);

-- categoria/data_producao/validade replicam a folha "Gerador lotes" que já
-- usavas em Excel — o código do lote passa a ser calculado pela app com a
-- mesma fórmula (ano+categoria+dia da semana+nº produção+dia juliano), em
-- vez de precisares de manter as duas coisas sincronizadas à mão.
-- custo_total/custo_medio_unitario ficam GRAVADOS no momento da criação do
-- lote (ver trigger calcular_custo_lote mais abaixo) — não recalculados
-- sempre que alguém consulta. Isto é deliberado: se importares um custo
-- novo do Primavera a semana seguinte, os lotes já produzidos não podem
-- mudar de custo com efeitos retroactivos.
create table public.lotes_producao (
    lote_id uuid primary key default uuid_generate_v4(),
    produto text not null,
    artigo_id uuid,
    numero_lote text not null,
    categoria text check (categoria in ('P', 'R', 'S')),
    data_producao date,
    validade date,
    quantidade_produzida numeric,
    -- quantidade_produzida é sempre o que ficou BOM (vendável/utilizável).
    -- quebras é o que se perdeu na mesma produção — juntas dão o total
    -- tentado, que é o que realmente gastou matéria-prima (ver trigger
    -- calcular_custo_lote: o custo total reflecte o tentado, mas o custo
    -- médio por unidade divide-se só pelo que ficou bom).
    quebras numeric not null default 0 check (quebras >= 0),
    motivo_quebra text,
    custo_total numeric,
    custo_medio_unitario numeric,
    data_criacao timestamptz not null default now()
);

-- Junção muitos-para-muitos: um lote pode servir várias encomendas
create table public.encomenda_lote (
    encomenda_id uuid references public.encomendas(encomenda_id) on delete cascade,
    lote_id uuid references public.lotes_producao(lote_id) on delete cascade,
    quantidade_alocada numeric not null check (quantidade_alocada > 0),
    primary key (encomenda_id, lote_id)
);

create index idx_encomendas_estado on public.encomendas(estado);
create index idx_encomendas_data_entrega on public.encomendas(data_entrega_pretendida);
create index idx_linhas_encomenda_encomenda on public.linhas_encomenda(encomenda_id);
create index idx_linhas_encomenda_artigo on public.linhas_encomenda(artigo_id);

-- ============================================================================
-- FASE 2 — ARTIGOS E STOCK (lotes com validade)
-- ============================================================================
-- Carga inicial: importar da tua exportação regular do Primavera
-- (ver scripts/importar_artigos.py). Depois desta carga, a app é que
-- passa a manter a quantidade_atual — ver nota de reconciliação no README.
-- Catálogo fixo de zonas de armazém — ligado por FK em vez de texto livre,
-- para dares consistência aos relatórios por zona.
create table public.localizacoes (
    localizacao_id uuid primary key default uuid_generate_v4(),
    nome text unique not null
);

-- Conversões de unidade por artigo: cada artigo tem sempre a mesma caixa
-- (por isso é um campo aqui, não uma tabela à parte), mas os factores de
-- conversão (quantas unidades cabem num pack/caixa/palete) variam de
-- artigo para artigo. Ficam nullable porque nem todo artigo se vende em
-- todas as unidades (ex. um artigo pode nunca sair à palete).
create table public.artigos (
    artigo_id uuid primary key default uuid_generate_v4(),
    ref_primavera text unique not null,
    designacao text not null,
    unidade text not null default 'un',
    tipo_caixa text check (tipo_caixa in ('Caixa A', 'Caixa B')),
    unidades_por_pack numeric,
    unidades_por_caixa numeric,
    unidades_por_palete numeric,
    -- Decide o que acontece quando o Nuno termina uma produção deste
    -- artigo: 'pa' recebe o código de lote oficial (fórmula ano+categoria+
    -- dia+nº+juliano) e fica em lotes_producao; 'intermedio' (ex. massa,
    -- recheio) recebe um lote interno simples e entra directamente em
    -- stock (lotes_artigo), pronto a ser consumido como matéria-prima
    -- noutra receita; 'materia_prima' nunca é "produzido" pelo Nuno, só
    -- entra por compra/importação.
    tipo_produto text not null default 'materia_prima' check (tipo_produto in ('materia_prima', 'intermedio', 'pa'))
);

-- Só agora a tabela artigos existe, por isso é aqui que as ligações
-- pendentes (linhas_encomenda e lotes_producao) são finalmente adicionadas.
alter table public.lotes_producao
    add constraint lotes_producao_artigo_id_fkey
    foreign key (artigo_id) references public.artigos(artigo_id);

-- Só agora a tabela artigos existe, por isso é aqui que a ligação de
-- linhas_encomenda para artigos é finalmente adicionada.
alter table public.linhas_encomenda
    add constraint linhas_encomenda_artigo_id_fkey
    foreign key (artigo_id) references public.artigos(artigo_id);

create table public.lotes_artigo (
    lote_artigo_id uuid primary key default uuid_generate_v4(),
    artigo_id uuid not null references public.artigos(artigo_id),
    numero_lote text not null,
    validade date,
    quantidade_atual numeric not null default 0,
    localizacao_id uuid references public.localizacoes(localizacao_id),
    -- Usado para decidir a ordem de consumo FIFO (mais antigo primeiro) na
    -- genealogia de lotes — sem esta data não há forma de saber qual lote
    -- entrou primeiro quando há vários do mesmo artigo em stock.
    criado_em timestamptz not null default now(),
    unique (artigo_id, numero_lote)
);

create index idx_lotes_artigo_artigo on public.lotes_artigo(artigo_id);

-- Impede stock negativo silencioso: se alguém tentar dar saída de mais do
-- que existe (erro de digitação, duas pessoas a registar o mesmo movimento
-- em simultâneo), o INSERT falha com um erro claro em vez de deixar o
-- stock ficar negativo sem ninguém reparar.
alter table public.lotes_artigo
    add constraint quantidade_nao_negativa check (quantidade_atual >= 0);

create type tipo_movimento as enum ('Entrada', 'Saída', 'Transferência');
create type estado_registo_primavera as enum ('Pendente', 'Registado');

-- "Transferência" cobre os 3 casos que o Fernando pratica: entre zonas do
-- armazém, entre lotes do mesmo artigo, ou entre artigos diferentes
-- (ex. granel -> embalado). Por isso tem origem E destino; Entrada/Saída
-- só preenchem um dos lados (lote_artigo_id) e deixam o outro a null.
-- unidade_movimentacao/quantidade_base seguem a mesma lógica de
-- linhas_encomenda: regista-se na unidade prática (ex. "3 caixas"), mas o
-- trigger converte para unidade base antes de tocar em quantidade_atual.
-- estado: o Primavera é sempre a fonte da verdade do stock — este campo
-- não é um "stock paralelo", é uma caixa de entrada de pedidos de registo.
-- O Fernando preenche aqui em vez de preencher papel; fica "Pendente" até
-- o Francisco o passar manualmente para o Primavera e o marcar "Registado".
create table public.movimentos_stock (
    movimento_id uuid primary key default uuid_generate_v4(),
    tipo tipo_movimento not null,
    estado estado_registo_primavera not null default 'Pendente',
    registado_por uuid references public.perfis(id),
    data_registo timestamptz,
    lote_artigo_id uuid references public.lotes_artigo(lote_artigo_id),
    lote_artigo_destino_id uuid references public.lotes_artigo(lote_artigo_id),
    unidade_movimentacao unidade_movimentacao not null default 'un',
    quantidade numeric not null check (quantidade > 0),
    quantidade_destino numeric,
    quantidade_base numeric,
    quantidade_destino_base numeric,
    localizacao_origem_id uuid references public.localizacoes(localizacao_id),
    localizacao_destino_id uuid references public.localizacoes(localizacao_id),
    data_movimento timestamptz not null default now(),
    responsavel uuid references public.perfis(id) default auth.uid(),
    encomenda_id uuid references public.encomendas(encomenda_id),
    observacoes text,
    preco_unitario numeric, -- só em Entradas com preço pago; alimenta o custo médio ponderado do artigo (ver trigger mais abaixo)
    constraint movimento_tem_lote_valido check (
        (tipo in ('Entrada', 'Saída') and lote_artigo_id is not null)
        or (tipo = 'Transferência' and lote_artigo_id is not null and lote_artigo_destino_id is not null)
    )
);

create index idx_movimentos_lote_origem on public.movimentos_stock(lote_artigo_id);
create index idx_movimentos_estado on public.movimentos_stock(estado);

-- Converte uma quantidade numa unidade de movimentação (un/pack/caixa/
-- palete) para unidade base, usando os factores de conversão do artigo
-- indicado. Sem factor definido para essa unidade, assume 1:1 (fica em
-- unidade base tal como está) em vez de rebentar com erro — mais seguro
-- para artigos que ainda não têm todas as conversões carregadas.
create or replace function public.converter_para_base(p_artigo_id uuid, p_unidade unidade_movimentacao, p_quantidade numeric)
returns numeric as $$
declare
    v_factor numeric;
begin
    if p_unidade = 'un' then
        return p_quantidade;
    end if;

    select case p_unidade
        when 'pack' then unidades_por_pack
        when 'caixa' then unidades_por_caixa
        when 'palete' then unidades_por_palete
    end into v_factor
    from public.artigos where artigo_id = p_artigo_id;

    return p_quantidade * coalesce(v_factor, 1);
end;
$$ language plpgsql stable security definer set search_path = public;

revoke execute on function public.converter_para_base(uuid, unidade_movimentacao, numeric) from public;
grant execute on function public.converter_para_base(uuid, unidade_movimentacao, numeric) to authenticated;

-- Trigger: calcula quantidade_base em linhas_encomenda no momento da
-- inserção, para o planeamento semanal poder comparar procura vs. stock
-- sem reconverter em cada consulta.
create or replace function public.calcular_quantidade_base_linha()
returns trigger as $$
begin
    if new.artigo_id is not null then
        new.quantidade_base := public.converter_para_base(new.artigo_id, new.unidade_movimentacao, new.quantidade_pedida);
    end if;
    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.calcular_quantidade_base_linha() from public;

create trigger trg_calcular_quantidade_base_linha
before insert or update on public.linhas_encomenda
for each row execute function public.calcular_quantidade_base_linha();

-- Trigger: mantém quantidade_atual dos lotes sempre sincronizada com os
-- movimentos, sem teres de recalcular manualmente em cada ecrã. Converte
-- sempre para unidade base antes de tocar no stock — é isso que garante
-- que "2 caixas" e "24 unidades" do mesmo artigo actualizam o stock
-- exactamente da mesma forma.
create or replace function public.atualizar_stock_lote()
returns trigger as $$
declare
    v_artigo_origem uuid;
    v_artigo_destino uuid;
begin
    select artigo_id into v_artigo_origem from public.lotes_artigo where lote_artigo_id = new.lote_artigo_id;
    new.quantidade_base := public.converter_para_base(v_artigo_origem, new.unidade_movimentacao, new.quantidade);

    if new.tipo = 'Entrada' then
        update public.lotes_artigo
        set quantidade_atual = quantidade_atual + new.quantidade_base
        where lote_artigo_id = new.lote_artigo_id;
        if new.localizacao_destino_id is not null then
            update public.lotes_artigo set localizacao_id = new.localizacao_destino_id where lote_artigo_id = new.lote_artigo_id;
        end if;
    elsif new.tipo = 'Saída' then
        update public.lotes_artigo
        set quantidade_atual = quantidade_atual - new.quantidade_base
        where lote_artigo_id = new.lote_artigo_id;
    else
        select artigo_id into v_artigo_destino from public.lotes_artigo where lote_artigo_id = new.lote_artigo_destino_id;
        new.quantidade_destino_base := public.converter_para_base(
            v_artigo_destino, new.unidade_movimentacao, coalesce(new.quantidade_destino, new.quantidade)
        );

        update public.lotes_artigo
        set quantidade_atual = quantidade_atual - new.quantidade_base
        where lote_artigo_id = new.lote_artigo_id;
        update public.lotes_artigo
        set quantidade_atual = quantidade_atual + new.quantidade_destino_base,
            localizacao_id = coalesce(new.localizacao_destino_id, localizacao_id)
        where lote_artigo_id = new.lote_artigo_destino_id;
    end if;
    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.atualizar_stock_lote() from public;

create trigger trg_atualizar_stock
before insert on public.movimentos_stock
for each row execute function public.atualizar_stock_lote();

-- Corrigir quantidade/unidade de um movimento DEPOIS de criado (ex. o
-- Fernando enganou-se a escrever a quantidade) — só permitido enquanto o
-- movimento ainda estiver "Pendente" (antes de passares para o Primavera).
-- Recalcula o stock do(s) lote(s) envolvido(s) a partir da diferença entre
-- o valor antigo e o novo, em vez de assumires que o valor novo substitui
-- o antigo directamente (o stock já reflectia o antigo).
create or replace function public.editar_movimento_recalcular_stock()
returns trigger as $$
declare
    v_artigo_id uuid;
    v_qtd_base_antiga numeric;
    v_qtd_base_nova numeric;
begin
    if old.estado = 'Registado' then
        raise exception 'Não é possível editar um movimento já registado no Primavera.';
    end if;

    if new.quantidade = old.quantidade and new.unidade_movimentacao = old.unidade_movimentacao then
        return new;
    end if;

    select artigo_id into v_artigo_id from public.lotes_artigo where lote_artigo_id = old.lote_artigo_id;
    v_qtd_base_antiga := public.converter_para_base(v_artigo_id, old.unidade_movimentacao, old.quantidade);
    v_qtd_base_nova := public.converter_para_base(v_artigo_id, new.unidade_movimentacao, new.quantidade);
    new.quantidade_base := v_qtd_base_nova;

    if old.tipo = 'Entrada' then
        update public.lotes_artigo set quantidade_atual = quantidade_atual - v_qtd_base_antiga + v_qtd_base_nova
        where lote_artigo_id = old.lote_artigo_id;
    elsif old.tipo = 'Saída' then
        update public.lotes_artigo set quantidade_atual = quantidade_atual + v_qtd_base_antiga - v_qtd_base_nova
        where lote_artigo_id = old.lote_artigo_id;
    elsif old.tipo = 'Transferência' then
        update public.lotes_artigo set quantidade_atual = quantidade_atual + v_qtd_base_antiga - v_qtd_base_nova
        where lote_artigo_id = old.lote_artigo_id;
        update public.lotes_artigo set quantidade_atual = quantidade_atual - v_qtd_base_antiga + v_qtd_base_nova
        where lote_artigo_id = old.lote_artigo_destino_id;
    end if;

    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.editar_movimento_recalcular_stock() from public;

create trigger trg_editar_movimento_stock
before update of quantidade, unidade_movimentacao on public.movimentos_stock
for each row execute function public.editar_movimento_recalcular_stock();

-- ============================================================================
-- FASE 4 — BOM E CUSTO MÉDIO DE PRODUÇÃO
-- ============================================================================
-- Custo unitário em tabela própria (não em `artigos`) — a leitura de
-- `artigos` é aberta a todos os perfis autenticados, porque o Nuno e o
-- Fernando precisam de ver designações/unidades nos seus formulários. O
-- custo é informação de gestão sensível, por isso vive à parte, com a sua
-- própria política (só admin e consulta).
create table public.custos_artigo (
    artigo_id uuid primary key references public.artigos(artigo_id),
    custo_unitario numeric,
    actualizado_em timestamptz not null default now()
);

-- Custo médio ponderado ao dar entrada com preço pago — corre do lado do
-- servidor (security definer), para o Fernando/Nuno poderem alimentar o
-- custo médio SEM alguma vez precisarem de permissão para LER custos_artigo
-- (essa tabela continua restrita a admin/consulta; ver política mais
-- abaixo — isto é o que permite escrever sem ler).
-- Guarda o preço pago à parte, restrita a admin/consulta — o
-- preco_unitario nunca fica gravado em movimentos_stock (essa tabela é
-- lida por todos os perfis autenticados, para o Nuno/Fernando verem os
-- seus próprios movimentos). A função abaixo grava aqui e depois apaga
-- o valor da linha original, no mesmo passo.
create table public.precos_movimento (
    movimento_id uuid primary key references public.movimentos_stock(movimento_id),
    preco_unitario numeric not null,
    registado_em timestamptz not null default now()
);

alter table public.precos_movimento enable row level security;
create policy "leitura de precos_movimento admin e consulta" on public.precos_movimento
    for select using (public.meu_role() in ('admin', 'consulta'));

create or replace function public.actualizar_custo_medio_entrada()
returns trigger as $$
declare
    v_artigo_id uuid;
    v_stock_depois numeric;
    v_stock_antes numeric;
    v_custo_antigo numeric;
    v_custo_novo numeric;
begin
    if new.tipo <> 'Entrada' or new.preco_unitario is null then
        return new;
    end if;

    select artigo_id into v_artigo_id from public.lotes_artigo where lote_artigo_id = new.lote_artigo_id;
    if v_artigo_id is null then
        return new;
    end if;

    -- O trigger de stock (trg_atualizar_stock) já correu antes deste, por
    -- ser BEFORE INSERT — a quantidade desta entrada já está reflectida no
    -- stock actual; subtrai-se para saber quanto havia ANTES desta entrada.
    select coalesce(sum(quantidade_atual), 0) into v_stock_depois
    from public.lotes_artigo where artigo_id = v_artigo_id;
    v_stock_antes := v_stock_depois - new.quantidade;

    select custo_unitario into v_custo_antigo from public.custos_artigo where artigo_id = v_artigo_id;

    if v_custo_antigo is null or v_stock_antes <= 0 then
        v_custo_novo := new.preco_unitario;
    else
        v_custo_novo := (v_stock_antes * v_custo_antigo + new.quantidade * new.preco_unitario)
                         / (v_stock_antes + new.quantidade);
    end if;

    insert into public.custos_artigo (artigo_id, custo_unitario)
    values (v_artigo_id, v_custo_novo)
    on conflict (artigo_id) do update set custo_unitario = excluded.custo_unitario;

    -- Guarda o preço numa tabela restrita, e apaga-o da linha visível a
    -- todos — feito por último, depois de já ter servido para o cálculo.
    insert into public.precos_movimento (movimento_id, preco_unitario)
    values (new.movimento_id, new.preco_unitario);
    update public.movimentos_stock set preco_unitario = null where movimento_id = new.movimento_id;

    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.actualizar_custo_medio_entrada() from public;

create trigger trg_actualizar_custo_medio_entrada
after insert on public.movimentos_stock
for each row execute function public.actualizar_custo_medio_entrada();

-- BOM de um único nível (produto acabado -> componentes directos), sem
-- rendimento/quebra nem explosão multi-nível — cobre o pedido concreto
-- ("custo médio de cada produção") sem sobre-engenhar antes de validares
-- os custos unitários carregados nos artigos.
create table public.bom_componentes (
    bom_id uuid primary key default uuid_generate_v4(),
    produto_id uuid not null references public.artigos(artigo_id),
    componente_id uuid not null references public.artigos(artigo_id),
    quantidade_por_unidade numeric not null check (quantidade_por_unidade > 0),
    unique (produto_id, componente_id)
);

-- Trigger: grava o custo do lote no momento da criação (fotografia), a
-- partir da BOM e dos custos unitários dos componentes NESSE momento. Uma
-- importação semanal de custos do Primavera só afecta lotes criados DEPOIS
-- da importação — nunca reescreve o custo de produções já feitas. Sem BOM
-- definida para o produto, ou sem custo_unitario em algum componente, o
-- custo fica null — nunca 0 disfarçado de real.
create or replace function public.calcular_custo_lote()
returns trigger as $$
declare
    v_custo_total numeric;
    v_tem_bom boolean;
    v_todos_com_custo boolean;
    v_quantidade_tentada numeric;
begin
    if new.artigo_id is null then
        return new;
    end if;

    -- O total tentado (bom + quebra) é o que realmente gastou matéria-
    -- prima — se produziste 100 e perdeste 5, gastaste ingredientes para
    -- 105, não para 100.
    v_quantidade_tentada := coalesce(new.quantidade_produzida, 0) + coalesce(new.quebras, 0);

    -- LEFT JOIN propositado: se um componente ainda não tiver nenhuma linha
    -- em custos_artigo (nunca lhe puseste custo), tem de continuar a
    -- "contar" como sem custo — um INNER JOIN silenciosamente ignorava
    -- esse componente em vez de bloquear o cálculo, o que dava um custo
    -- errado (a menos) sem nenhum aviso.
    select count(*) > 0, bool_and(ca.custo_unitario is not null)
    into v_tem_bom, v_todos_com_custo
    from public.bom_componentes bc
    left join public.custos_artigo ca on ca.artigo_id = bc.componente_id
    where bc.produto_id = new.artigo_id;

    if v_tem_bom and v_todos_com_custo then
        select sum(bc.quantidade_por_unidade * v_quantidade_tentada * ca.custo_unitario)
        into v_custo_total
        from public.bom_componentes bc
        left join public.custos_artigo ca on ca.artigo_id = bc.componente_id
        where bc.produto_id = new.artigo_id;

        new.custo_total := v_custo_total;
        -- Divide-se só pelo que ficou BOM — é isso que sobe o custo
        -- unitário quando há quebras, correctamente.
        new.custo_medio_unitario := case when coalesce(new.quantidade_produzida, 0) > 0
            then v_custo_total / new.quantidade_produzida else null end;
    end if;

    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.calcular_custo_lote() from public;

create trigger trg_calcular_custo_lote
before insert on public.lotes_producao
for each row execute function public.calcular_custo_lote();

-- Mesmo cálculo, agora também ao ACTUALIZAR a quantidade — é o que
-- acontece quando o Nuno soma uma 2ª produção do dia ao mesmo lote em vez
-- de criar um novo (a função já lê new.quantidade_produzida, por isso
-- recalcula certo para o total novo, não só para o que foi inserido).
create trigger trg_recalcular_custo_lote
before update of quantidade_produzida, quebras on public.lotes_producao
for each row execute function public.calcular_custo_lote();

-- Produtos INTERMÉDIOS (massa, recheio) precisam de ficar disponíveis como
-- stock consumível por outras receitas — ao contrário do PA, cuja
-- "produção" é só um registo (o stock de PA não vive em lotes_artigo, vive
-- na quantidade_produzida do próprio lote). Este trigger só actua quando o
-- artigo produzido é do tipo 'intermedio': cria (ou soma a) uma linha em
-- lotes_artigo com o mesmo número de lote, e actualiza o custo médio do
-- artigo com o custo desta produção (ponderado pelo que já havia em
-- stock) — assim, quando esse intermédio for usado na receita de outro
-- produto (ex. empadas), o custo já reflecte o que custou fazê-lo.
create or replace function public.criar_stock_intermedio()
returns trigger as $$
declare
    v_tipo_produto text;
    v_stock_antes numeric;
    v_custo_antigo numeric;
    v_custo_novo numeric;
    v_lote_existente uuid;
    v_quantidade_a_somar numeric;
begin
    select tipo_produto into v_tipo_produto from public.artigos where artigo_id = new.artigo_id;
    if v_tipo_produto <> 'intermedio' or new.artigo_id is null then
        return new;
    end if;

    -- Em INSERT, quantidade_produzida é o valor todo (produção nova). Em
    -- UPDATE (quando o Nuno soma uma 2ª produção ao mesmo lote no mesmo
    -- dia), quantidade_produzida já vem como o TOTAL novo, não o
    -- incremento — só a diferença face ao valor antigo é que deve entrar
    -- em stock outra vez, senão duplicava a primeira produção.
    if TG_OP = 'INSERT' then
        v_quantidade_a_somar := coalesce(new.quantidade_produzida, 0);
    else
        v_quantidade_a_somar := coalesce(new.quantidade_produzida, 0) - coalesce(old.quantidade_produzida, 0);
    end if;
    if v_quantidade_a_somar = 0 then
        return new;
    end if;

    select lote_artigo_id into v_lote_existente
    from public.lotes_artigo where artigo_id = new.artigo_id and numero_lote = new.numero_lote;

    if v_lote_existente is not null then
        update public.lotes_artigo set quantidade_atual = quantidade_atual + v_quantidade_a_somar
        where lote_artigo_id = v_lote_existente;
    else
        insert into public.lotes_artigo (artigo_id, numero_lote, quantidade_atual, validade)
        values (new.artigo_id, new.numero_lote, v_quantidade_a_somar, new.validade);
    end if;

    if new.custo_medio_unitario is not null then
        select coalesce(sum(quantidade_atual), 0) into v_stock_antes
        from public.lotes_artigo where artigo_id = new.artigo_id;
        v_stock_antes := v_stock_antes - v_quantidade_a_somar;

        select custo_unitario into v_custo_antigo from public.custos_artigo where artigo_id = new.artigo_id;

        if v_custo_antigo is null or v_stock_antes <= 0 then
            v_custo_novo := new.custo_medio_unitario;
        else
            v_custo_novo := (v_stock_antes * v_custo_antigo + v_quantidade_a_somar * new.custo_medio_unitario)
                             / (v_stock_antes + v_quantidade_a_somar);
        end if;

        insert into public.custos_artigo (artigo_id, custo_unitario)
        values (new.artigo_id, v_custo_novo)
        on conflict (artigo_id) do update set custo_unitario = excluded.custo_unitario;
    end if;

    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.criar_stock_intermedio() from public;

create trigger trg_criar_stock_intermedio
after insert on public.lotes_producao
for each row execute function public.criar_stock_intermedio();

create trigger trg_actualizar_stock_intermedio
after update of quantidade_produzida on public.lotes_producao
for each row execute function public.criar_stock_intermedio();

-- ============================================================================
-- GENEALOGIA DE LOTES — rastreabilidade real (para trás e para a frente)
-- ============================================================================
-- Sem isto, o custo era calculado por rácio da receita × custo médio
-- corrente, sem saber QUAIS lotes concretos de matéria-prima entraram
-- nesta produção específica — o que impede responder "que produtos usaram
-- este lote de farinha?" num recall. Este trigger consome automaticamente
-- por FIFO (o lote mais antigo em stock primeiro) sempre que uma produção
-- é criada ou aumentada, e grava exactamente de onde veio cada quantidade.
create table public.consumo_lotes (
    id uuid primary key default uuid_generate_v4(),
    lote_producao_id uuid not null references public.lotes_producao(lote_id) on delete cascade,
    lote_artigo_consumido_id uuid not null references public.lotes_artigo(lote_artigo_id),
    quantidade numeric not null check (quantidade > 0),
    criado_em timestamptz not null default now()
);

create index idx_consumo_lotes_producao on public.consumo_lotes(lote_producao_id);
create index idx_consumo_lotes_artigo on public.consumo_lotes(lote_artigo_consumido_id);

alter table public.consumo_lotes enable row level security;
create policy "leitura de consumo_lotes para autenticados" on public.consumo_lotes
    for select using (auth.role() = 'authenticated');
-- Sem política de insert/update/delete para utilizadores — só o trigger
-- (security definer) escreve aqui, nunca directamente da app.

create or replace function public.consumir_materia_prima_fifo()
returns trigger as $$
declare
    v_componente record;
    v_quantidade_delta numeric;
    v_total_necessario numeric;
    v_restante numeric;
    v_lote record;
    v_a_tirar numeric;
begin
    if new.artigo_id is null then
        return new;
    end if;

    -- Em INSERT, o delta é a produção toda (bom+quebra); em UPDATE (somar
    -- 2ª produção ao mesmo lote), só a diferença face ao que já lá estava
    -- — senão consumia matéria-prima em dobro para a mesma quantidade.
    if TG_OP = 'INSERT' then
        v_quantidade_delta := coalesce(new.quantidade_produzida, 0) + coalesce(new.quebras, 0);
    else
        v_quantidade_delta := (coalesce(new.quantidade_produzida, 0) + coalesce(new.quebras, 0))
                             - (coalesce(old.quantidade_produzida, 0) + coalesce(old.quebras, 0));
    end if;
    if v_quantidade_delta <= 0 then
        return new;
    end if;

    for v_componente in
        select bc.componente_id, bc.quantidade_por_unidade
        from public.bom_componentes bc
        where bc.produto_id = new.artigo_id
    loop
        v_total_necessario := v_componente.quantidade_por_unidade * v_quantidade_delta;
        v_restante := v_total_necessario;

        for v_lote in
            select lote_artigo_id, quantidade_atual
            from public.lotes_artigo
            where artigo_id = v_componente.componente_id and quantidade_atual > 0
            order by criado_em asc
        loop
            exit when v_restante <= 0;
            v_a_tirar := least(v_lote.quantidade_atual, v_restante);

            insert into public.consumo_lotes (lote_producao_id, lote_artigo_consumido_id, quantidade)
            values (new.lote_id, v_lote.lote_artigo_id, v_a_tirar);

            update public.lotes_artigo set quantidade_atual = quantidade_atual - v_a_tirar
            where lote_artigo_id = v_lote.lote_artigo_id;

            v_restante := v_restante - v_a_tirar;
        end loop;
        -- Se v_restante > 0 aqui, não havia stock suficiente registado
        -- para explicar a quantidade usada — fica por explicar em vez de
        -- bloquear o registo da produção (que já aconteceu na realidade),
        -- ou de forçar algum lote a ficar negativo.
    end loop;

    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.consumir_materia_prima_fifo() from public;

create trigger trg_consumir_fifo_insert
after insert on public.lotes_producao
for each row execute function public.consumir_materia_prima_fifo();

create trigger trg_consumir_fifo_update
after update of quantidade_produzida, quebras on public.lotes_producao
for each row execute function public.consumir_materia_prima_fifo();

-- ============================================================================
-- FASE 3 — PEDIDOS DE ARMAZÉM (Nuno pede, Fernando atende)
-- ============================================================================
create type estado_pedido as enum ('Pendente', 'Atendido');

create table public.pedidos_armazem (
    pedido_id uuid primary key default uuid_generate_v4(),
    solicitado_por uuid references public.perfis(id) default auth.uid(),
    artigo_id uuid references public.artigos(artigo_id),
    quantidade numeric not null check (quantidade > 0),
    estado estado_pedido not null default 'Pendente',
    atendido_por uuid references public.perfis(id),
    data_pedido timestamptz not null default now(),
    data_atendimento timestamptz
);

create index idx_pedidos_armazem_estado on public.pedidos_armazem(estado);

-- ============================================================================
-- PLANEAMENTO SEMANAL — produção extra planeada só para stock
-- ============================================================================
-- As tarefas de "produção por falta de stock face a encomendas" NÃO ficam
-- guardadas aqui — são calculadas em tempo real (procura da semana vs.
-- lotes_artigo). Esta tabela é só para produção que decides fazer por
-- antecipação, sem estar ligada a nenhuma encomenda concreta.
create table public.producao_extra_planeada (
    id uuid primary key default uuid_generate_v4(),
    artigo_id uuid references public.artigos(artigo_id),
    produto text not null,
    quantidade numeric not null check (quantidade > 0),
    semana_inicio date not null,
    motivo text,
    criado_por uuid references public.perfis(id) default auth.uid(),
    criado_em timestamptz not null default now()
);

alter table public.producao_extra_planeada enable row level security;
create policy "leitura de producao_extra para autenticados" on public.producao_extra_planeada
    for select using (auth.role() = 'authenticated');
create policy "gerir producao_extra so admin" on public.producao_extra_planeada
    for insert with check (public.meu_role() = 'admin');
create policy "eliminar producao_extra so admin" on public.producao_extra_planeada
    for delete using (public.meu_role() = 'admin');

-- Plano de produção por dia (ex. "o que vou produzir amanhã") — diferente
-- de producao_extra_planeada (que é por semana e só admin gere). Aqui é o
-- Nuno que constrói o plano dia a dia, para depois ver de que matérias-
-- primas precisa (explosão de BOM) e exportar para as compras/o armazém.
create table public.plano_producao (
    id uuid primary key default uuid_generate_v4(),
    artigo_id uuid not null references public.artigos(artigo_id),
    quantidade numeric not null check (quantidade > 0),
    data_planeada date not null,
    criado_por uuid references public.perfis(id) default auth.uid(),
    criado_em timestamptz not null default now()
);

create index idx_plano_producao_data on public.plano_producao(data_planeada);

alter table public.plano_producao enable row level security;
create policy "leitura de plano_producao para autenticados" on public.plano_producao
    for select using (auth.role() = 'authenticated');
create policy "gerir plano_producao admin ou producao" on public.plano_producao
    for insert with check (public.meu_role() in ('admin', 'producao'));
create policy "eliminar plano_producao admin ou producao" on public.plano_producao
    for delete using (public.meu_role() in ('admin', 'producao'));

-- ============================================================================
-- ROW LEVEL SECURITY — controlo de acesso por perfil
-- ============================================================================
alter table public.perfis enable row level security;
alter table public.clientes enable row level security;
alter table public.encomendas enable row level security;
alter table public.linhas_encomenda enable row level security;
alter table public.lotes_producao enable row level security;
alter table public.encomenda_lote enable row level security;
alter table public.artigos enable row level security;
alter table public.lotes_artigo enable row level security;
alter table public.movimentos_stock enable row level security;
alter table public.pedidos_armazem enable row level security;

create policy "ver o próprio perfil ou todos se admin" on public.perfis
    for select using (auth.uid() = id or public.meu_role() = 'admin');

-- Encomendas e clientes: leitura para qualquer utilizador autenticado
-- (todos os perfis precisam de ver o estado geral, incluindo consulta)
create policy "leitura de encomendas para autenticados" on public.encomendas
    for select using (auth.role() = 'authenticated');
create policy "leitura de clientes para autenticados" on public.clientes
    for select using (auth.role() = 'authenticated');
create policy "leitura de linhas para autenticados" on public.linhas_encomenda
    for select using (auth.role() = 'authenticated');

-- Criação de encomendas: só admin (Francisco/Mónica)
create policy "criar encomendas so admin" on public.encomendas
    for insert with check (public.meu_role() = 'admin');
create policy "criar clientes so admin" on public.clientes
    for insert with check (public.meu_role() = 'admin');
create policy "criar linhas so admin" on public.linhas_encomenda
    for insert with check (public.meu_role() = 'admin');

-- Actualização de encomendas: cada perfil só pode mover o estado que lhe compete
-- (regra simplificada: admin actualiza tudo; producao e armazem actualizam
-- estado — a validação de QUAL transição é permitida fica no frontend,
-- reforçada aqui de forma geral)
create policy "actualizar encomendas admin producao armazem" on public.encomendas
    for update using (public.meu_role() in ('admin', 'producao', 'armazem'));

-- Stock e artigos: leitura geral, escrita só armazem (Fernando) e admin
create policy "leitura de artigos para autenticados" on public.artigos
    for select using (auth.role() = 'authenticated');
create policy "leitura de lotes_artigo para autenticados" on public.lotes_artigo
    for select using (auth.role() = 'authenticated');
alter table public.localizacoes enable row level security;
create policy "leitura de localizacoes para autenticados" on public.localizacoes
    for select using (auth.role() = 'authenticated');
create policy "gerir localizacoes admin ou armazem" on public.localizacoes
    for insert with check (public.meu_role() in ('admin', 'armazem'));

alter table public.bom_componentes enable row level security;
create policy "leitura de bom para autenticados" on public.bom_componentes
    for select using (auth.role() = 'authenticated');
create policy "gerir bom so admin" on public.bom_componentes
    for insert with check (public.meu_role() = 'admin');
create policy "eliminar bom so admin" on public.bom_componentes
    for delete using (public.meu_role() = 'admin');

-- custos_artigo: leitura restrita a admin/consulta (é a peça que faltava
-- para o Nuno/Fernando deixarem de ver custos de matéria-prima).
alter table public.custos_artigo enable row level security;
create policy "leitura de custos_artigo admin e consulta" on public.custos_artigo
    for select using (public.meu_role() in ('admin', 'consulta'));
create policy "criar custos_artigo so admin" on public.custos_artigo
    for insert with check (public.meu_role() = 'admin');
create policy "actualizar custos_artigo so admin" on public.custos_artigo
    for update using (public.meu_role() = 'admin');

create policy "leitura de movimentos para autenticados" on public.movimentos_stock
    for select using (auth.role() = 'authenticated');
create policy "criar movimentos armazem producao ou admin" on public.movimentos_stock
    for insert with check (public.meu_role() in ('armazem', 'producao', 'admin'));
create policy "marcar movimentos registados so admin" on public.movimentos_stock
    for update using (public.meu_role() = 'admin');
create policy "gerir artigos so admin" on public.artigos
    for insert with check (public.meu_role() = 'admin');
create policy "actualizar artigos so admin" on public.artigos
    for update using (public.meu_role() = 'admin');
create policy "gerir lotes_artigo armazem ou admin" on public.lotes_artigo
    for insert with check (public.meu_role() in ('armazem', 'admin'));

-- Pedidos de armazém: Nuno cria, Fernando/admin atende
create policy "leitura de pedidos para autenticados" on public.pedidos_armazem
    for select using (auth.role() = 'authenticated');
create policy "criar pedidos producao ou admin" on public.pedidos_armazem
    for insert with check (public.meu_role() in ('producao', 'admin'));
create policy "atender pedidos armazem ou admin" on public.pedidos_armazem
    for update using (public.meu_role() in ('armazem', 'admin'));

-- ============================================================================
-- FASE 5 — PREÇOS DE CONTRATO, HISTÓRICO DE CUSTOS E UTILITÁRIOS
-- ============================================================================
-- Preço acordado por cliente e por artigo (produto acabado) — é o que
-- permite calcular "quanto vale este stock para este cliente", já que cada
-- cliente pode ter um preço diferente para o mesmo produto. Sem preço
-- carregado para um par cliente/artigo, esse cliente simplesmente não
-- aparece no relatório de valor potencial — nunca se assume um preço.
create table public.precos_cliente (
    preco_id uuid primary key default uuid_generate_v4(),
    cliente_id uuid not null references public.clientes(cliente_id),
    artigo_id uuid not null references public.artigos(artigo_id),
    preco_unitario numeric not null check (preco_unitario > 0),
    data_inicio date not null default current_date,
    criado_por uuid references public.perfis(id) default auth.uid(),
    criado_em timestamptz not null default now(),
    unique (cliente_id, artigo_id)
);

-- Histórico de custo: guarda o valor ANTERIOR sempre que custo_unitario
-- muda, antes de o novo valor ser aplicado — é o que dá o gráfico de
-- evolução de preços de matérias-primas, sem teres de fazer nada extra
-- quando actualizas um custo (nem à mão, nem via importação semanal).
create table public.historico_custos_artigo (
    id uuid primary key default uuid_generate_v4(),
    artigo_id uuid not null references public.artigos(artigo_id),
    custo_unitario numeric,
    registado_em timestamptz not null default now()
);

create or replace function public.registar_historico_custo()
returns trigger as $$
begin
    if old.custo_unitario is distinct from new.custo_unitario then
        insert into public.historico_custos_artigo (artigo_id, custo_unitario, registado_em)
        values (old.artigo_id, old.custo_unitario, now());
    end if;
    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.registar_historico_custo() from public;

-- Antes era "before update of custo_unitario on artigos" — passa a ser em
-- custos_artigo, agora que o custo vive lá. Só dispara em UPDATE (não na
-- primeira vez que um custo é criado), porque nesse caso não há valor
-- anterior nenhum para guardar.
create trigger trg_registar_historico_custo
before update of custo_unitario on public.custos_artigo
for each row execute function public.registar_historico_custo();

-- Custos de utilitários (electricidade, água, gás...) — não são artigos do
-- Primavera, por isso ficam numa tabela própria, simples, só para
-- acompanhares a evolução no relatório de gestão.
create table public.utilitarios_custos (
    id uuid primary key default uuid_generate_v4(),
    utilitario text not null,
    custo numeric not null check (custo > 0),
    periodo date not null,
    criado_por uuid references public.perfis(id) default auth.uid(),
    criado_em timestamptz not null default now()
);

alter table public.precos_cliente enable row level security;
create policy "leitura de precos_cliente admin e consulta" on public.precos_cliente
    for select using (public.meu_role() in ('admin', 'consulta'));
create policy "gerir precos_cliente so admin" on public.precos_cliente
    for insert with check (public.meu_role() = 'admin');
create policy "actualizar precos_cliente so admin" on public.precos_cliente
    for update using (public.meu_role() = 'admin');
create policy "eliminar precos_cliente so admin" on public.precos_cliente
    for delete using (public.meu_role() = 'admin');

alter table public.historico_custos_artigo enable row level security;
create policy "leitura de historico_custos admin e consulta" on public.historico_custos_artigo
    for select using (public.meu_role() in ('admin', 'consulta'));

alter table public.utilitarios_custos enable row level security;
create policy "leitura de utilitarios admin e consulta" on public.utilitarios_custos
    for select using (public.meu_role() in ('admin', 'consulta'));
create policy "gerir utilitarios so admin" on public.utilitarios_custos
    for insert with check (public.meu_role() = 'admin');

-- ============================================================================
-- SISTEMA DE NOTIFICAÇÕES (sino) — central para toda a app, substitui a
-- necessidade de ires ao email para saberes que algo precisa da tua atenção.
-- Um alerta é dirigido a um ROLE (não a uma pessoa) — numa equipa pequena,
-- várias pessoas do mesmo perfil partilham a mesma caixa de alertas; marcar
-- como lido por uma pessoa marca para todas as do mesmo perfil. É uma
-- escolha deliberada de simplicidade, não um esquecimento.
-- ============================================================================
create table public.alertas (
    id uuid primary key default uuid_generate_v4(),
    tipo text not null,
    titulo text not null,
    corpo text,
    destinatario_role text not null check (destinatario_role in ('admin', 'producao', 'armazem', 'consulta', 'qualidade')),
    link_secao text,
    link_id uuid,
    lido boolean not null default false,
    criado_por uuid references public.perfis(id) default auth.uid(),
    criado_em timestamptz not null default now()
);

create index idx_alertas_destinatario on public.alertas(destinatario_role, lido);

alter table public.alertas enable row level security;
create policy "leitura de alertas pelo destinatario" on public.alertas
    for select using (destinatario_role = public.meu_role()::text);
create policy "marcar alertas como lidos pelo destinatario" on public.alertas
    for update using (destinatario_role = public.meu_role()::text);
create policy "criar alertas autenticados" on public.alertas
    for insert with check (auth.role() = 'authenticated');

-- Os três triggers seguintes substituem a necessidade de cada ecrã se
-- lembrar de criar o alerta — corre sempre, do lado do servidor, mesmo que
-- a acção venha de um sítio diferente da app no futuro (ex. importações).

create or replace function public.criar_alerta_pedido_armazem()
returns trigger as $$
declare
    v_designacao text;
begin
    select designacao into v_designacao from public.artigos where artigo_id = new.artigo_id;
    insert into public.alertas (tipo, titulo, corpo, destinatario_role, link_secao, link_id) values
        ('pedido_armazem', 'Novo pedido de armazém', coalesce(v_designacao, '—') || ' — ' || new.quantidade, 'armazem', 'pedidos', new.pedido_id),
        ('pedido_armazem', 'Novo pedido de armazém', coalesce(v_designacao, '—') || ' — ' || new.quantidade, 'admin', 'stock', new.pedido_id);
    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.criar_alerta_pedido_armazem() from public;

create trigger trg_alerta_pedido_armazem
after insert on public.pedidos_armazem
for each row execute function public.criar_alerta_pedido_armazem();

create or replace function public.criar_alerta_pedido_atendido()
returns trigger as $$
declare
    v_designacao text;
begin
    if new.estado = 'Atendido' and old.estado is distinct from 'Atendido' then
        select designacao into v_designacao from public.artigos where artigo_id = new.artigo_id;
        insert into public.alertas (tipo, titulo, corpo, destinatario_role, link_secao, link_id)
        values ('pedido_atendido', 'Pedido atendido', coalesce(v_designacao, '—'), 'producao', 'pedidos', new.pedido_id);
    end if;
    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.criar_alerta_pedido_atendido() from public;

create trigger trg_alerta_pedido_atendido
after update on public.pedidos_armazem
for each row execute function public.criar_alerta_pedido_atendido();

create or replace function public.criar_alerta_movimento()
returns trigger as $$
begin
    insert into public.alertas (tipo, titulo, corpo, destinatario_role, link_secao, link_id)
    values ('movimento_stock', 'Movimento por registar no Primavera', new.tipo, 'admin', 'stock', new.movimento_id);
    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.criar_alerta_movimento() from public;

create trigger trg_alerta_movimento
after insert on public.movimentos_stock
for each row execute function public.criar_alerta_movimento();

-- ============================================================================
-- ALERTAS PARA O ADMIN — pedidos do Nuno e movimentos do Fernando
-- ============================================================================
-- O envio de email em si NÃO é feito aqui em SQL — é feito por uma Supabase
-- Edge Function (supabase/functions/notificar-alerta) accionada por um
-- Database Webhook configurado no Dashboard (Database → Webhooks), porque
-- SQL/Postgres não faz pedidos HTTP de forma nativa e fiável. Ver README,
-- secção "Configurar alertas por email".
--
-- Esta view só serve para o badge/contador dentro da app (admin.html) —
-- não depende do webhook, funciona mesmo que o email falhe.
-- security_invoker = true faz a view correr com as permissões de quem a
-- consulta, não de quem a criou — sem isto, o Postgres corre views com o
-- privilégio do criador por defeito, o que o Security Advisor do Supabase
-- assinala como "Security Definer View". Aqui não havia exposição real
-- (pedidos_armazem já é lido por todos os autenticados), mas é boa prática
-- de qualquer forma.
create view public.alertas_pendentes
with (security_invoker = true) as
    select count(*) filter (where estado = 'Pendente') as pedidos_pendentes
    from public.pedidos_armazem;

-- Lotes de produção: leitura geral, escrita admin OU producao — decisão
-- revertida (era exclusiva do admin, "para mim exclusivamente"); o Nuno
-- passou a poder criar e alimentar as produções diárias sozinho. A
-- ATRIBUIÇÃO de um lote a uma encomenda (encomenda_lote, mais abaixo)
-- continua exclusiva do admin — são decisões diferentes.
alter table public.lotes_producao enable row level security;
create policy "leitura de lotes_producao para autenticados" on public.lotes_producao
    for select using (auth.role() = 'authenticated');
create policy "criar lotes_producao admin ou producao" on public.lotes_producao
    for insert with check (public.meu_role() in ('admin', 'producao'));
create policy "actualizar lotes_producao admin ou producao" on public.lotes_producao
    for update using (public.meu_role() in ('admin', 'producao'));

create policy "leitura de encomenda_lote para autenticados" on public.encomenda_lote
    for select using (auth.role() = 'authenticated');
create policy "gerir encomenda_lote so admin" on public.encomenda_lote
    for insert with check (public.meu_role() = 'admin');

-- ============================================================================
-- QUALIDADE — auditorias e não-conformidades
-- ============================================================================
create type tipo_auditoria as enum ('higiene', 'temperaturas', 'rastreabilidade', 'pragas', 'rotulos_embalagem', 'alergenios', 'outro');
create type gravidade_nc as enum ('Minor', 'Major', 'Crítica');
create type estado_nc as enum ('Pendente', 'Em resolução', 'Por confirmar', 'Resolvida');

create table public.auditorias (
    id uuid primary key default uuid_generate_v4(),
    tipo tipo_auditoria not null,
    data_auditoria date not null default current_date,
    -- Reaproveita a mesma tabela de zonas do armazém — é só um catálogo de
    -- nomes geridos por ti, não há nada de específico do armazém na
    -- estrutura em si; podes acrescentar zonas de produção à mesma lista.
    zona_id uuid references public.localizacoes(localizacao_id),
    lote_artigo_id uuid references public.lotes_artigo(lote_artigo_id),
    lote_producao_id uuid references public.lotes_producao(lote_id),
    observacoes text,
    criado_por uuid references public.perfis(id) default auth.uid(),
    criado_em timestamptz not null default now()
);

alter table public.auditorias enable row level security;
create policy "leitura de auditorias para autenticados" on public.auditorias
    for select using (auth.role() = 'authenticated');
create policy "criar auditorias qualidade ou admin" on public.auditorias
    for insert with check (public.meu_role() in ('qualidade', 'admin'));

create table public.nao_conformidades (
    id uuid primary key default uuid_generate_v4(),
    auditoria_id uuid references public.auditorias(id) on delete cascade,
    descricao text not null,
    gravidade gravidade_nc not null,
    accao_correctiva text,
    prazo date,
    responsavel_id uuid references public.perfis(id),
    estado estado_nc not null default 'Pendente',
    criado_por uuid references public.perfis(id) default auth.uid(),
    criado_em timestamptz not null default now(),
    resolvido_em timestamptz,
    confirmado_por uuid references public.perfis(id),
    confirmado_em timestamptz
);

alter table public.nao_conformidades enable row level security;
create policy "leitura de nao_conformidades para autenticados" on public.nao_conformidades
    for select using (auth.role() = 'authenticated');
create policy "criar nao_conformidades qualidade ou admin" on public.nao_conformidades
    for insert with check (public.meu_role() in ('qualidade', 'admin'));
-- Update aberto a qualquer autenticado: o RESPONSÁVEL (que pode ser de
-- qualquer perfil) precisa de poder marcar "Por confirmar" quando resolve
-- a sua parte — restringir por perfil aqui excluía, por exemplo, o
-- Fernando de fechar uma não-conformidade de higiene atribuída a ele. A
-- acção sensível (confirmar como Resolvida) fica controlada pela app, só
-- mostrando esse botão a quem é Qualidade/admin.
create policy "actualizar nao_conformidades autenticados" on public.nao_conformidades
    for update using (auth.role() = 'authenticated');

-- Alerta ao responsável quando lhe atribuis uma não-conformidade nova —
-- vai para todos os do MESMO perfil dele (ver nota sobre alertas serem
-- por perfil partilhado, não por pessoa).
create or replace function public.alertar_nova_nao_conformidade()
returns trigger as $$
declare
    v_role_responsavel text;
begin
    if new.responsavel_id is null then
        return new;
    end if;
    select role into v_role_responsavel from public.perfis where id = new.responsavel_id;
    if v_role_responsavel is null then
        return new;
    end if;
    insert into public.alertas (tipo, titulo, corpo, destinatario_role, link_secao, link_id)
    values ('nao_conformidade', 'Nova não-conformidade atribuída', left(new.descricao, 140), v_role_responsavel, 'qualidade', new.id);
    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.alertar_nova_nao_conformidade() from public;

create trigger trg_alertar_nova_nc
after insert on public.nao_conformidades
for each row execute function public.alertar_nova_nao_conformidade();

-- Alerta à Qualidade quando o responsável marca "Por confirmar" — fecha o
-- ciclo: quem cria a não-conformidade é quem confirma que ficou mesmo
-- resolvida, o responsável não fecha sozinho.
create or replace function public.alertar_nc_por_confirmar()
returns trigger as $$
begin
    if new.estado = 'Por confirmar' and old.estado is distinct from 'Por confirmar' then
        insert into public.alertas (tipo, titulo, corpo, destinatario_role, link_secao, link_id)
        values ('nao_conformidade_confirmar', 'Não-conformidade pronta a confirmar', left(new.descricao, 140), 'qualidade', 'qualidade', new.id);
    end if;
    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke execute on function public.alertar_nc_por_confirmar() from public;

create trigger trg_alertar_nc_confirmar
after update of estado on public.nao_conformidades
for each row execute function public.alertar_nc_por_confirmar();

