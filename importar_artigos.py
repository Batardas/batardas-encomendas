"""
Importação, actualização semanal e reconciliação de artigos/stock a partir
da exportação do Primavera.

Uso:
    python importar_artigos.py carregar   ficheiro_primavera.csv
    python importar_artigos.py reconciliar ficheiro_primavera.csv

- "carregar"    -> cria OU actualiza artigos (upsert por referência). Usa
                   isto tanto na carga inicial como toda vez que quiseres
                   refrescar preços — por exemplo, todas as segundas de
                   manhã. Actualizar o custo_unitario aqui só afecta as
                   PRÓXIMAS produções: os lotes já criados guardam o custo
                   gravado no momento em que foram feitos (ver trigger
                   calcular_custo_lote no schema.sql) e nunca mudam
                   retroactivamente com uma importação posterior.
- "reconciliar" -> comparações periódicas: lê o saldo actual do Primavera e
                   compara com o saldo calculado na app (Primavera - movimentos
                   próprios). Mostra as diferenças num relatório e pergunta se
                   queres aplicá-las — nunca aplica sozinho sem confirmares.
                   Cada correcção aplicada fica registada como um MOVIMENTO
                   DE AJUSTE (não como um número reescrito por cima), com o
                   motivo nas observações — para nunca perderes o rasto de
                   porque o stock mudou.

Formato esperado do CSV exportado do Primavera (ajusta os nomes de coluna ao
teu mapa real de exportação):
    Referencia;Designacao;Unidade;QuantidadeAtual;CustoUnitario;TipoCaixa;UnidadesPorPack;UnidadesPorCaixa;UnidadesPorPalete

TipoCaixa deve ser "Caixa A", "Caixa B" ou vazio. CustoUnitario e os três
campos de conversão podem ficar vazios se não se aplicarem a esse artigo —
o cálculo de stock assume 1:1 sem factor definido, e o custo do lote fica
em branco sem custo_unitario carregado.

Dependências:
    pip install supabase python-dotenv
"""

import csv
import sys
from datetime import date

from supabase import create_client

# ============================================================================
# Configuração — usa a SERVICE ROLE KEY aqui (não a anon key), porque este
# script corre do teu lado, fora do browser, e precisa de contornar a RLS
# para escrever em nome do sistema. NUNCA coloques a service role key no
# código do frontend/GitHub Pages — só aqui, num script que corres localmente.
# ============================================================================
SUPABASE_URL = "https://iayebkcqvfbzyvlhwfei.supabase.co"
SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlheWVia2NxdmZienl2bGh3ZmVpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Nzc2MTgyNywiZXhwIjoyMTAzMzM3ODI3fQ.-oWGlU9kmfYB-D4uEyCMBafpwjowEjHnkiPpkhfpP54"  # Project Settings → API → service_role

cliente = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def ler_csv_primavera(caminho: str) -> list[dict]:
    with open(caminho, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f, delimiter=";"))


def carregar(caminho_csv: str) -> None:
    linhas = ler_csv_primavera(caminho_csv)
    print(f"A carregar/actualizar {len(linhas)} artigos de {caminho_csv}...")

    for linha in linhas:
        ref = linha["Referencia"].strip()
        designacao = linha["Designacao"].strip()
        unidade = linha.get("Unidade", "un").strip() or "un"
        quantidade = float(linha.get("QuantidadeAtual", 0) or 0)
        custo_unitario = float(linha["CustoUnitario"]) if linha.get("CustoUnitario", "").strip() else None
        tipo_caixa = (linha.get("TipoCaixa", "") or "").strip() or None
        unidades_por_pack = float(linha["UnidadesPorPack"]) if linha.get("UnidadesPorPack", "").strip() else None
        unidades_por_caixa = float(linha["UnidadesPorCaixa"]) if linha.get("UnidadesPorCaixa", "").strip() else None
        unidades_por_palete = float(linha["UnidadesPorPalete"]) if linha.get("UnidadesPorPalete", "").strip() else None

        # upsert por ref_primavera — reexecutar este script não duplica
        # artigos. Se já tiveres criado o mesmo artigo no site com o mesmo
        # código antes do Primavera o ter, esta linha só o actualiza com
        # os dados do Primavera (fica igual nos dois sítios, sem duplicar).
        resultado = (
            cliente.table("artigos")
            .upsert(
                {
                    "ref_primavera": ref,
                    "designacao": designacao,
                    "unidade": unidade,
                    "tipo_caixa": tipo_caixa,
                    "unidades_por_pack": unidades_por_pack,
                    "unidades_por_caixa": unidades_por_caixa,
                    "unidades_por_palete": unidades_por_palete,
                },
                on_conflict="ref_primavera",
            )
            .execute()
        )
        artigo_id = resultado.data[0]["artigo_id"]

        # Custo vive em custos_artigo, à parte — é informação de gestão que
        # o Nuno e o Fernando não devem ver, por isso não está na mesma
        # tabela que eles consultam para os menus.
        if custo_unitario is not None:
            cliente.table("custos_artigo").upsert(
                {"artigo_id": artigo_id, "custo_unitario": custo_unitario},
                on_conflict="artigo_id",
            ).execute()

        # Lote inicial "INICIAL" sem validade — só é criado UMA vez, na
        # primeira carga. Numa reexecução semanal (para refrescar custos),
        # se já existir, não se toca na quantidade: a partir daí é a app
        # que mantém o stock actualizado através dos movimentos reais do
        # Fernando/Nuno, e uma importação do Primavera não pode sobrepor-se
        # a isso sem passar pelo fluxo de reconciliação.
        existe = (
            cliente.table("lotes_artigo")
            .select("lote_artigo_id")
            .eq("artigo_id", artigo_id)
            .eq("numero_lote", "INICIAL")
            .maybe_single()
            .execute()
        )
        if not existe or not existe.data:
            cliente.table("lotes_artigo").insert(
                {
                    "artigo_id": artigo_id,
                    "numero_lote": "INICIAL",
                    "quantidade_atual": quantidade,
                }
            ).execute()

    print("Carga inicial concluída.")


def reconciliar(caminho_csv: str) -> None:
    linhas = ler_csv_primavera(caminho_csv)
    print(f"A reconciliar {len(linhas)} artigos com o saldo do Primavera...\n")

    divergencias = []
    for linha in linhas:
        ref = linha["Referencia"].strip()
        saldo_primavera = float(linha.get("QuantidadeAtual", 0) or 0)

        artigo = (
            cliente.table("artigos").select("artigo_id, designacao")
            .eq("ref_primavera", ref).maybe_single().execute()
        )
        if not artigo or not artigo.data:
            divergencias.append({"ref": ref, "designacao": "— (não existe na app)", "saldo_primavera": saldo_primavera, "saldo_app": "novo artigo", "artigo_id": None, "lote_artigo_id": None})
            continue

        lotes = (
            cliente.table("lotes_artigo").select("lote_artigo_id, numero_lote, quantidade_atual")
            .eq("artigo_id", artigo.data["artigo_id"]).execute()
        )
        saldo_app = sum(l["quantidade_atual"] for l in lotes.data)

        if abs(saldo_app - saldo_primavera) > 0.001:
            # Aplica-se o ajuste ao lote "INICIAL" quando existir; senão, ao
            # primeiro lote encontrado. Com vários lotes reais em uso, o
            # ajuste fica atribuído a um deles — revê manualmente se isso
            # não fizer sentido para artigos com muitos lotes distintos.
            lote_alvo = next((l for l in lotes.data if l["numero_lote"] == "INICIAL"), None) or (lotes.data[0] if lotes.data else None)
            divergencias.append({
                "ref": ref, "designacao": artigo.data["designacao"],
                "saldo_primavera": saldo_primavera, "saldo_app": saldo_app,
                "artigo_id": artigo.data["artigo_id"],
                "lote_artigo_id": lote_alvo["lote_artigo_id"] if lote_alvo else None,
            })

    if not divergencias:
        print("Sem divergências — Primavera e app estão alinhados.")
        return

    print(f"{len(divergencias)} divergência(s) encontrada(s):\n")
    print(f"{'Referência':<15}{'Designação':<30}{'Primavera':>12}{'App':>12}")
    for d in divergencias:
        print(f"{d['ref']:<15}{d['designacao'][:28]:<30}{d['saldo_primavera']:>12}{str(d['saldo_app']):>12}")

    nome_relatorio = f"reconciliacao_{date.today().isoformat()}.csv"
    with open(nome_relatorio, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, delimiter=";")
        writer.writerow(["Referencia", "Designacao", "SaldoPrimavera", "SaldoApp"])
        writer.writerows([(d["ref"], d["designacao"], d["saldo_primavera"], d["saldo_app"]) for d in divergencias])
    print(f"\nRelatório guardado em {nome_relatorio}.")

    aplicaveis = [d for d in divergencias if d["lote_artigo_id"] is not None]
    if not aplicaveis:
        return

    resposta = input(f"\nAplicar as {len(aplicaveis)} correcções agora, como movimentos de ajuste? (s/N): ").strip().lower()
    if resposta != "s":
        print("Nada aplicado — revê o relatório e corre novamente quando quiseres aplicar.")
        return

    for d in aplicaveis:
        diferenca = round(d["saldo_primavera"] - d["saldo_app"], 4)
        if diferenca == 0:
            continue
        tipo = "Entrada" if diferenca > 0 else "Saída"
        cliente.table("movimentos_stock").insert({
            "tipo": tipo,
            "lote_artigo_id": d["lote_artigo_id"],
            "unidade_movimentacao": "un",
            "quantidade": abs(diferenca),
            "observacoes": f"Ajuste de reconciliação com o Primavera em {date.today().isoformat()} (era {d['saldo_app']}, passou a {d['saldo_primavera']})",
        }).execute()
    print(f"Aplicadas {len(aplicaveis)} correcções — cada uma ficou registada como movimento de ajuste, com o motivo nas observações.")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("carregar", "reconciliar"):
        print(__doc__)
        sys.exit(1)

    comando, caminho = sys.argv[1], sys.argv[2]
    if comando == "carregar":
        carregar(caminho)
    else:
        reconciliar(caminho)
