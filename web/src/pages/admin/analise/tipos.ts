/** Formato do pacote da Central de Análise (calculado no servidor; aqui só se desenha). */
export type Confianca = 'BAIXA' | 'MEDIA' | 'ALTA';
export type Horizonte = 'CURTO' | 'MEDIO' | 'LONGO';
export type Impacto = { centsMes: number; premissa: string; estimativa: true; tipo: 'LUCRO' | 'CAIXA'; grupo: string };
export type Achado = {
  id: string; codigo: string; pilar: string; sentido: 'NEGATIVO' | 'POSITIVO' | 'OPORTUNIDADE'; comparativo?: boolean; variacao?: number;
  gravidade: number; titulo: string; frase: string; numero: string; amostra: string; amostraN: number; confianca: Confianca;
  acao: string | null; dono: string | null; impacto: Impacto | null; limiar: string; horizonte: Horizonte | null;
  esforco: 'BAIXO' | 'MEDIO' | 'ALTO' | null; tecnicas: string[]; meta?: string;
};
export type Metrica = { chave: string; antes: number | Record<string, number> | null; unidade: string } | null;
export type AcaoPlano = {
  id: string; texto: string; meta: string; semana: number; esperadoCents: number | null; premissa: string | null; dono: string | null;
  metrica: Metrica; status: 'PENDENTE' | 'FEITO' | 'NAO_FEITO';
};
export type Destrava = { achadoId: string; codigo: string; acao: string; porque: string; impacto: Impacto | null; confianca: Confianca; esforco: string | null; dono: string | null };
export type Pilar = { id: string; nome: string; nota: number | null; numero: string; comoSubir: string; anterior: number | null; variacao: number | null };
export type ItemCardapio = { id: number; name: string; cat: string; qtd: number; preco: number; custo: number; margem: number; lucro: number; quadrante: Quadrante; acao: string };
export type Quadrante = 'ESTRELA' | 'BURRO_DE_CARGA' | 'QUEBRA_CABECA' | 'ABACAXI';
export type Relatorio = { mes: string; salvo: boolean; status: 'RASCUNHO' | 'REVISAO' | 'FINALIZADO'; parecer: string; acoes: AcaoPlano[]; finalizadoEm: string | null; atualizadoEm: string | null };

export type Pacote = {
  mes: string; nome: string; emCurso: boolean; diaCorte: number; diasNoMes: number; periodo: { from: string; to: string }; geradoEm: string; congelado?: boolean;
  resumo: string[];
  nota: { valor: number | null; anterior: number | null; variacao: number | null; pilaresComNota: number; pilares: Pilar[]; regra: string };
  dinheiroNaMesa: {
    lucroMesCents: number; caixaCents: number; premissa: string;
    itens: { id: string; codigo: string; titulo: string; centsMes: number; considerado: number; confianca: Confianca; premissa: string; grupo: string }[];
    caixaItens: { id: string; titulo: string; cents: number; premissa: string }[];
  };
  gargalos: Achado[]; comparativo: Achado[]; positivos: Achado[]; negativos: Achado[];
  avisosSecoes: Record<'gargalos' | 'comparativo' | 'positivos' | 'negativos', string | null>;
  destravas: Record<Horizonte, Destrava[]>;
  tecnicas: { id: string; nome: string; para: string; passos: string[]; achados: { id: string; codigo: string; titulo: string }[] }[];
  maisVende: { name: string; qtd: number; receita: number; quadrante: Quadrante | null; leitura: string }[];
  maisLucra: { name: string; qtd: number; lucro: number; margem: number; quadrante: Quadrante | null; leitura: string }[];
  cardapio: { corteQtd: number | null; metaMargem: number; itens: ItemCardapio[]; semCusto: { name: string; qtd: number }[]; regra: string };
  estoque: {
    controlados: number;
    cobertura: { name: string; qtd: number; porDia: number; dias: number | null; meta: number; situacao: string }[];
    rupturas: { id: number; name: string; diasZero: number; dias: number }[];
    perdasPorMotivo: { motivo: string; cents: number; qtd: number }[]; perdasCents: number;
    divergencias: { id: number; name: string; vezes: number; faltou: number }[];
    custoFornecedor: { produto: string; fornecedor: string; primeiro: number; ultimo: number; variacao: number; entradas: number }[];
    compraSugerida: { name: string; comprar: number; conta: string }[];
  };
  clientesFiado: {
    clientes: { identificados: number; novos: number; recorrentes: number; comConsentimento: number };
    fiado: { totalCents: number; vencidoCents: number; contas: number; vencidas: number; inadimplenciaPct: number | null; prazoMedioDias: number | null; concentracao80: number | null; clientesComFiado: number; aging: { faixa: string; contas: number; cents: number }[]; promessasVencidas: number };
    recuperacao: string[]; aviso: string;
  };
  plano: AcaoPlano[];
  resultadoPlanoAnterior: { existe: boolean; statusRelatorio: string | null; texto: string; itens: { id: string; texto: string; meta: string; status: string; efeito: string }[] };
  previsao: { ok: true; nome: string; vendasCents: number; faixa: [number, number]; lucroCents: number | null; conta: string; confianca: Confianca; aviso: string } | { ok: false; nome: string; motivo: string };
  serie12: { mes: string; receita: number | null; lucro: number | null; margem: number | null }[];
  numeros: { nome: string; atual: number | null; anterior: number | null; tipo: 'BRL' | 'PCT' | 'UN' }[];
  confianca: { nivel: Confianca; motivos: string[]; nivelTempos: Confianca; motivosTempos: string[]; diasHistorico: number; pedidos: number; pctHorarios: number | null; coberturaCusto: number; comoMelhorar: string[]; primeirosMeses: boolean; aviso: string | null };
  metodologia: string[];
  achados: Achado[];
  detectores: { id: string; nome: string; pilar: string; limiar: string; amostraMin: string; status: 'DISPAROU' | 'NAO_DISPAROU' | 'AMOSTRA' | 'SEM_DADOS'; achados: number }[];
};
export type RespostaAnalise = Pacote & { relatorio: Relatorio };
