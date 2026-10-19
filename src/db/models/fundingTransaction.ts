import { DataTypes, Model, Sequelize } from 'sequelize';

export type FundingTransactionType = 'deposit' | 'withdrawal';
export type FundingTransactionStatus = 'pending' | 'completed' | 'failed';

export class FundingTransaction extends Model {
  declare id: string;
  declare memberId: string;
  declare walletId: string;
  declare type: FundingTransactionType;
  declare amount: string;
  declare turnoverMultiplier: number;
  declare status: FundingTransactionStatus;
  declare pspRef: string;
  declare rawCallbackPayload: any;
  declare createdAt: Date;
  declare updatedAt: Date;
}

export function initFundingTransaction(sequelize: Sequelize): void {
  FundingTransaction.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      walletId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.ENUM('deposit', 'withdrawal'), allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      turnoverMultiplier: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      status: { type: DataTypes.ENUM('pending', 'completed', 'failed'), allowNull: false, defaultValue: 'pending' },
      pspRef: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      rawCallbackPayload: { type: DataTypes.JSONB, allowNull: true },
    },
    { sequelize, tableName: 'funding_transactions', underscored: true },
  );
}
