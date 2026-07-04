import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { TopupModule } from '../topup/topup.module';
import { BackpackService } from './backpack.service';
import { BackpackController } from './backpack.controller';
import { AdminBackpackController } from './admin-backpack.controller';

/**
 * Web upgrades for the in-game VaultBackpack plugin (sv_vault_players.height).
 * Prices (coins / meowcoins per level) are admin-set in sv_backpack_upgrade_config.
 */
@Module({
  imports: [UsersModule, TopupModule],
  controllers: [BackpackController, AdminBackpackController],
  providers: [BackpackService],
})
export class BackpackModule {}
