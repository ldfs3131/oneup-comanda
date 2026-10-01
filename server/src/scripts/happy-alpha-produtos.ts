import { eq } from 'drizzle-orm';
import { closePools, db, runAsEmpresa, runAsSystem } from '../db/index.js';
import { empresas, categories, products } from '../db/schema.js';

/**
 * Adiciona produtos e custos específicos do Happy Alpha (restaurante do Rafa).
 * Execução: node dist/scripts/happy-alpha-produtos.js
 */
async function main() {
  // 1) Encontra a empresa Happy Alpha
  const [empresa] = await runAsSystem(async () => {
    return db.select().from(empresas).where(eq(empresas.slug, 'happy-alpha'));
  });

  if (!empresa) {
    console.error('❌ Empresa "happy-alpha" não encontrada. Execute setup.js antes.');
    process.exit(1);
  }

  console.log(`\n=== Happy Alpha (${empresa.id}) — Produtos e Custos ===\n`);

  await runAsEmpresa(empresa.id, async () => {
    // 2) Garante categoria "Bebidas"
    const [catBebidas] = await db.select().from(categories).where(eq(categories.name, 'Bebidas'));
    const categoryId = catBebidas ? catBebidas.id : (
      await db.insert(categories)
        .values({ name: 'Bebidas', sortOrder: 1, sendsToKitchen: false })
        .returning()
    )[0].id;

    // 3) Lista de produtos com custos (em centavos)
    const produtos = [
      { name: 'Refrigerante', costCents: 299 },
      { name: 'H2O', costCents: 420 },
      { name: 'Água', costCents: 130 },
      { name: 'Água com gás', costCents: 170 },
      { name: 'Suco lata', costCents: 440 },
      { name: 'Água de coco caixinha', costCents: 200 },
      { name: 'Heineken', costCents: 583 },
      { name: 'Stella', costCents: 599 },
      { name: 'Corona', costCents: 625 },
      { name: 'Baden Baden', costCents: 545 },
      { name: 'Coca zero zero + zero', costCents: 335 },
    ];

    // 4) Insere ou atualiza cada produto
    for (const prod of produtos) {
      const [existing] = await db.select().from(products).where(eq(products.name, prod.name));

      if (existing) {
        if (existing.costCents !== prod.costCents) {
          await db.update(products)
            .set({ costCents: prod.costCents, updatedAt: new Date() })
            .where(eq(products.id, existing.id));
          console.log(`✏️  ${prod.name}: R$ ${(prod.costCents / 100).toFixed(2)} (atualizado)`);
        } else {
          console.log(`✔️  ${prod.name}: R$ ${(prod.costCents / 100).toFixed(2)} (já existe)`);
        }
      } else {
        await db.insert(products).values({
          categoryId,
          name: prod.name,
          description: '',
          priceCents: 0, // preço será definido no painel
          costCents: prod.costCents,
          available: true,
          sendsToKitchen: false,
          trackStock: false,
        });
        console.log(`✨ ${prod.name}: R$ ${(prod.costCents / 100).toFixed(2)} (novo)`);
      }
    }

    console.log(`\n✅ Produtos do Happy Alpha atualizados.\n`);
  });

  await closePools();
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});
