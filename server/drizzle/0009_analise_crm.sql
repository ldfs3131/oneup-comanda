-- ONE UP Comanda 3.1 — Central de Análise e Recuperação de vendas (só o acesso ONE UP usa; o Dono não vê).

-- Relatório mensal da ONE UP: parecer do consultor, plano de ação e retrato congelado dos números ao finalizar.
CREATE TABLE IF NOT EXISTS analise_relatorios (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  mes text NOT NULL CHECK (mes ~ '^\d{4}-\d{2}$'),
  status text NOT NULL DEFAULT 'RASCUNHO' CHECK (status IN ('RASCUNHO', 'REVISAO', 'FINALIZADO')),
  parecer text NOT NULL DEFAULT '',
  acoes jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrato jsonb,
  finalizado_em timestamptz,
  user_id integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, mes)
);
--> statement-breakpoint
-- Recuperação de vendas: uma ficha por conta pendente (fiado) que entrou na régua de cobrança.
CREATE TABLE IF NOT EXISTS crm_cobrancas (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  account_id integer NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'NOVO' CHECK (status IN ('NOVO','CONTATADO','SEM_RESPOSTA','PROMETEU','PAGO_AGUARDANDO_BAIXA','RECUPERADO','PAGO_SEM_CONTATO','CONTESTADO','NUMERO_ERRADO','PAUSADO','PERDIDO','NAO_COBRAR')),
  entrada_em timestamptz NOT NULL DEFAULT now(),
  pendente_desde timestamptz NOT NULL,
  valor_entrada_cents integer NOT NULL CHECK (valor_entrada_cents >= 0),
  dias_atraso_entrada integer NOT NULL DEFAULT 0,
  percentual_bp integer NOT NULL DEFAULT 0 CHECK (percentual_bp BETWEEN 0 AND 5000),
  proximo_contato date,
  prometido_para date,
  tentativas integer NOT NULL DEFAULT 0,
  promessas_quebradas integer NOT NULL DEFAULT 0,
  recuperado_cents integer NOT NULL DEFAULT 0,
  comissao_cents integer NOT NULL DEFAULT 0,
  recuperado_em timestamptz,
  encerrado_em timestamptz,
  nao_cobrar_motivo text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, account_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS crm_cobrancas_status_idx ON crm_cobrancas (empresa_id, status, proximo_contato);
--> statement-breakpoint
-- Linha do tempo de cada cobrança (contato, resultado, nota). Nunca se edita nem se apaga.
CREATE TABLE IF NOT EXISTS crm_eventos (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  cobranca_id integer NOT NULL REFERENCES crm_cobrancas(id),
  tipo text NOT NULL CHECK (tipo IN ('CONTATO','RESULTADO','NOTA','SISTEMA')),
  canal text CHECK (canal IN ('WHATSAPP','LIGACAO','PESSOAL')),
  resultado text CHECK (resultado IN ('SEM_RESPOSTA','VAI_PAGAR','PAGOU','PARCELAR','CONTESTOU','NUMERO_ERRADO','NAO_VAI_PAGAR')),
  data_prometida date,
  nota text,
  user_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS crm_eventos_cobranca_idx ON crm_eventos (empresa_id, cobranca_id, id);
--> statement-breakpoint
-- Régua, percentuais e mensagens por restaurante (contrato).
CREATE TABLE IF NOT EXISTS crm_config (
  empresa_id integer PRIMARY KEY DEFAULT app_empresa() REFERENCES empresas(id),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['analise_relatorios', 'crm_cobrancas', 'crm_eventos', 'crm_config'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'isolamento_empresa') THEN
      EXECUTE format('CREATE POLICY isolamento_empresa ON %I USING (empresa_id = app_empresa()) WITH CHECK (empresa_id = app_empresa())', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON analise_relatorios, crm_cobrancas, crm_config TO oneup_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON crm_eventos TO oneup_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON analise_relatorios, crm_cobrancas, crm_config, crm_eventos FROM oneup_app;
--> statement-breakpoint
REVOKE UPDATE ON crm_eventos FROM oneup_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE analise_relatorios_id_seq, crm_cobrancas_id_seq, crm_eventos_id_seq TO oneup_app;
--> statement-breakpoint
CREATE TRIGGER no_update_crm_eventos BEFORE UPDATE ON crm_eventos FOR EACH ROW EXECUTE FUNCTION ha_block_update();
--> statement-breakpoint
CREATE TRIGGER no_delete_crm_eventos BEFORE DELETE ON crm_eventos FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
-- vínculo sempre com registro da mesma empresa (a chave estrangeira não olha o RLS)
CREATE TRIGGER ref_crm_cobrancas BEFORE INSERT ON crm_cobrancas FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('account_id', 'accounts');
--> statement-breakpoint
CREATE TRIGGER ref_crm_eventos BEFORE INSERT ON crm_eventos FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('cobranca_id', 'crm_cobrancas');
