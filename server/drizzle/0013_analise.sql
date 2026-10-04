-- ONE UP Comanda 3.3 — Central de Análise: consulta do relatório por mês (a tabela veio na 0009).
CREATE INDEX IF NOT EXISTS analise_relatorios_mes_idx ON analise_relatorios (empresa_id, mes);
