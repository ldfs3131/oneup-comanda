import { eq } from 'drizzle-orm';
import { empresaAtual } from '../db/index.js';
import { restaurantSettings, statusEvents } from '../db/schema.js';
import { audit } from '../lib/audit.js';
/** Estado único do estabelecimento (aberto/fechado). Toda mudança fica na linha do tempo e na auditoria. */
export async function setEstablishmentOpen(tx, user, isOpen, context) {
    const [s] = await tx.select().from(restaurantSettings).where(eq(restaurantSettings.id, empresaAtual())).for('update');
    if (s.isOpen === isOpen)
        return false;
    await tx.update(restaurantSettings).set({ isOpen, updatedAt: new Date() }).where(eq(restaurantSettings.id, empresaAtual()));
    await tx.insert(statusEvents).values({ isOpen, userId: user?.id ?? null });
    await audit(tx, {
        userId: user?.id ?? null, action: isOpen ? 'establishment.open' : 'establishment.close', entityType: 'settings', entityId: 1,
        message: `${user?.name ?? 'Sistema'} ${isOpen ? 'ABRIU' : 'FECHOU'} o estabelecimento (${context}).`,
    });
    return true;
}
