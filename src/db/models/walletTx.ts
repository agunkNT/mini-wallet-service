import { DataTypes, Model, Sequelize } from 'sequelize';

export type WalletTxType = 'credit' | 'debit';

export class WalletTx extends Model {
  declare id: string;
  declare walletId: string;
  declare referenceId: string | null;
  declare referenceType: string;
  declare type: WalletTxType;
  declare amount: string;
  declare balanceBefore: string;
  declare balanceAfter: string;
  declare createdAt: Date;
}

export function initWalletTx(sequelize: Sequelize): void {
  WalletTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      referenceId: { type: DataTypes.UUID, allowNull: true },
      referenceType: { type: DataTypes.STRING(50), allowNull: false },
      type: { type: DataTypes.ENUM('credit', 'debit'), allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      balanceBefore: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      balanceAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
    },
    { sequelize, tableName: 'wallet_txs', underscored: true, updatedAt: false },
  );
}
