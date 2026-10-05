# Ajustes pendentes (juntar e executar de uma vez)

Lista do Lucas a partir do uso real. Não executar item por item: quando ele mandar, fazer todos juntos, testar e subir
numa versão só (depois, no servidor: `oneup atualizar`).

## 1. Cardápio digital — filtro de categorias (anotado em 04/10) — ✅ FEITO na 3.3.1 (05/10)

**O que acontece:** ao tocar em "Espetos", a lista para em "Espeto de Coração"; os primeiros (Contra-filé, Frango,
Medalhão) ficam escondidos atrás do topo, e o botão "Espetos" não fica marcado.

**Causa encontrada:** o salto usa uma distância fixa (`scroll-margin-top: 170px` em `.pub-cat-title`), menor que o
topo fixo de verdade (logotipo + "Aberto agora" + "Baixar o app" + faixa de categorias, cerca de 270 px no celular).
Além disso, nenhuma categoria fica marcada como ativa.

**Solução proposta (melhor experiência de app de delivery):**
- medir a altura real do topo na hora e rolar até o título da categoria com essa folga (vale para qualquer
  logotipo ou celular);
- marcar a categoria em que a pessoa está (destaque no botão), atualizando enquanto ela rola a lista;
- deslizar a faixa de categorias para o botão ativo ficar sempre visível (ex.: Bebidas no fim);
- topo compacto ao rolar: o logotipo e o botão "Baixar o app" encolhem e sobra mais espaço para os produtos;
- testar no celular (Android e iPhone) com todas as categorias, inclusive a última.

**Como ficou (3.3.1):** só a faixa de categorias gruda no topo (o logotipo e os avisos rolam e liberam espaço); a altura
da faixa é medida na hora; o toque leva o título da categoria para logo abaixo da faixa (Espetos começa no Contra-filé);
o botão da categoria em que a pessoa está fica destacado e a faixa desliza para ele ficar à vista; no fim da página a
última categoria fica marcada. Conferido no tamanho de um iPhone com todas as categorias.
