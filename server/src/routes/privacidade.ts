/**
 * Política de privacidade de 1 página, gerada com o nome e o WhatsApp do restaurante (controlador dos dados).
 * A ONE UP aparece como operadora (sistema). Rota pública: a tela /privacidade do web mostra este texto.
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { restaurantSettings } from '../db/schema.js';
import { config } from '../config.js';
import { formatarTelefone } from '../lib/telefone.js';
import { RETENCAO_MESES } from '../services/clientes.js';
import { ACOMPANHAMENTO_HORAS } from './public.js';

export function politicaDePrivacidade(restaurante: string, whatsapp: string | null) {
  const zap = whatsapp ? formatarTelefone(whatsapp) : null;
  const falar = zap ? `pelo WhatsApp ${zap} ou no balcão` : 'no balcão do restaurante';
  return {
    titulo: `Privacidade — ${restaurante}`,
    restaurante, whatsapp: zap, operadora: 'ONE UP', retencaoMeses: RETENCAO_MESES, acompanhamentoHoras: ACOMPANHAMENTO_HORAS,
    secoes: [
      { titulo: 'Quem cuida dos seus dados', texto: `O restaurante ${restaurante} é o responsável pelos seus dados (controlador). Contato: ${falar}.` },
      { titulo: 'Quem opera o sistema', texto: `O sistema de pedidos (${config.productName}) é da ONE UP, que guarda os dados em nome do restaurante e só os usa para manter o sistema funcionando (operadora). A ONE UP não vende nem usa os seus dados para outra finalidade.` },
      { titulo: 'Que dados pedimos', texto: 'Nome e WhatsApp, os itens do pedido e, na entrega, o endereço. Se você marcar a caixinha de ofertas, guardamos também quando e com qual texto aceitou.' },
      { titulo: 'Para quê', texto: `Para preparar e entregar o seu pedido, chamar você quando estiver pronto e, se houver conta a pagar depois, para combinar o pagamento. Ofertas e novidades pelo WhatsApp só se você aceitar — e você pode pedir para parar quando quiser.` },
      { titulo: 'Por quanto tempo', texto: `O link para acompanhar o pedido para de funcionar ${ACOMPANHAMENTO_HORAS} horas depois de o pedido ser entregue. Se você ficar ${RETENCAO_MESES} meses sem pedir, apagamos o seu nome e telefone automaticamente. As vendas continuam registradas sem identificar você, porque a lei exige guardar o registro das vendas.` },
      { titulo: 'Seus direitos', texto: `Você pode pedir para ver, corrigir ou apagar os seus dados, ou para parar de receber ofertas. É só falar com o restaurante ${restaurante} ${falar}. Se houver conta em aberto, o nome fica até ela ser paga.` },
      { titulo: 'Neste aparelho', texto: 'O cardápio só guarda o seu nome e WhatsApp neste celular/tablet se você marcar "Lembrar meus dados neste aparelho". Em aparelho compartilhado, deixe desmarcado.' },
    ],
  };
}

export async function privacidadeRoutes(app: FastifyInstance) {
  app.get('/api/public/privacidade', async (_req, reply) => {
    const [r] = await db.select({ name: restaurantSettings.name, whatsapp: restaurantSettings.whatsappNumber }).from(restaurantSettings).limit(1);
    reply.header('Cache-Control', 'public, max-age=300');
    return politicaDePrivacidade(r?.name ?? 'restaurante', r?.whatsapp ?? null);
  });
}
