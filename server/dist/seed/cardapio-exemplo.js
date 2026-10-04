import { db } from '../db/index.js';
import { semearCardapio } from './menu.js';
/**
 * CARDÁPIO DE EXEMPLO GENÉRICO para restaurante novo (restaurante fictício, sem produto, nome ou marca de cliente).
 * Serve para o Dono ver o sistema funcionando no primeiro dia e trocar pelos próprios produtos e preços.
 * Preços plausíveis de um restaurante de bairro; custos não informados. Usado por `setup.js --cardapio=exemplo`
 * e pela tela "Novo restaurante" da Plataforma ONE UP.
 */
export const CARDAPIO_EXEMPLO = [
    {
        name: 'Porções', kitchen: true, products: [
            { name: 'Batata frita', priceCents: 2800, description: 'Porção para 2 pessoas' },
            { name: 'Batata com cheddar e bacon', priceCents: 3600 },
            { name: 'Mandioca frita', priceCents: 2600 },
            { name: 'Isca de frango empanada', priceCents: 4200 },
            { name: 'Linguiça na chapa com cebola', priceCents: 3800 },
            {
                name: 'Pastéis (8 unidades)', priceCents: 3400,
                groups: [{ name: 'Sabor', required: true, options: [{ name: 'Carne', delta: 0 }, { name: 'Queijo', delta: 0 }, { name: 'Misto (carne e queijo)', delta: 0 }] }],
            },
        ],
    },
    {
        name: 'Pratos', kitchen: true, products: [
            {
                name: 'Prato do dia', priceCents: 2990, description: 'Arroz, feijão, salada, farofa e uma carne à escolha',
                groups: [{ name: 'Carne', required: true, options: [{ name: 'Bife acebolado', delta: 0 }, { name: 'Frango grelhado', delta: 0 }, { name: 'Linguiça', delta: 0 }] }],
            },
            { name: 'Frango grelhado com legumes', priceCents: 3490, description: 'Com arroz e salada' },
            { name: 'Parmegiana de frango', priceCents: 4290, description: 'Com arroz e fritas' },
            {
                name: 'Strogonoff de carne', priceCents: 3990,
                groups: [{ name: 'Acompanhamento', required: true, options: [{ name: 'Batata palha', delta: 0 }, { name: 'Batata frita', delta: 400 }] }],
            },
            { name: 'Peixe grelhado', priceCents: 4490, description: 'Com arroz, legumes e pirão' },
            { name: 'Carne na chapa (para 2)', priceCents: 10990, description: 'Com arroz, feijão, fritas e vinagrete' },
        ],
    },
    {
        name: 'Lanches', kitchen: true, products: [
            { name: 'Hambúrguer da casa', priceCents: 2990, groups: [{ name: 'Acompanhamento', required: false, options: [{ name: '+ Batata frita', delta: 800 }] }] },
            { name: 'X-salada', priceCents: 2200 },
            { name: 'Misto quente', priceCents: 1400 },
        ],
    },
    {
        name: 'Bebidas', kitchen: false, products: [
            { name: 'Refrigerante lata', priceCents: 650, trackStock: true },
            { name: 'Refrigerante lata zero', priceCents: 650, trackStock: true },
            { name: 'Água mineral sem gás', priceCents: 450, trackStock: true },
            { name: 'Água mineral com gás', priceCents: 500, trackStock: true },
            {
                name: 'Suco natural 400 ml', priceCents: 990,
                groups: [{ name: 'Sabor', required: true, options: [{ name: 'Laranja', delta: 0 }, { name: 'Limão', delta: 0 }, { name: 'Maracujá', delta: 0 }, { name: 'Abacaxi com hortelã', delta: 0 }] }],
            },
            { name: 'Cerveja long neck', priceCents: 1190, trackStock: true },
            { name: 'Cerveja 600 ml', priceCents: 1690, trackStock: true },
            { name: 'Chope claro 300 ml', priceCents: 990 },
            { name: 'Chope claro 500 ml', priceCents: 1490 },
            {
                name: 'Caipirinha da casa', priceCents: 2200,
                groups: [{ name: 'Sabor', required: true, options: [{ name: 'Limão', delta: 0 }, { name: 'Morango', delta: 0 }, { name: 'Maracujá', delta: 0 }] }],
            },
        ],
    },
    {
        name: 'Sobremesas', kitchen: false, products: [
            { name: 'Pudim de leite', priceCents: 1290 },
            { name: 'Mousse de maracujá', priceCents: 1190 },
            { name: 'Sorvete (2 bolas)', priceCents: 1400 },
            { name: 'Petit gâteau com sorvete', priceCents: 2490, kitchen: true },
        ],
    },
    { name: 'Outros', kitchen: false, products: [] },
];
/** Cadastra o cardápio de exemplo genérico (só o que falta, por nome). */
export const seedCardapioExemplo = (tx = db) => semearCardapio(CARDAPIO_EXEMPLO, tx);
