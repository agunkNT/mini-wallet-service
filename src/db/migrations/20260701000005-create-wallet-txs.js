'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wallet_txs', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      reference_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      reference_type: {
        type: Sequelize.STRING(50),
        allowNull: false, // e.g. 'deposit', 'withdrawal', 'wager'
      },
      type: {
        type: Sequelize.ENUM('credit', 'debit'),
        allowNull: false,
      },
      amount: {
        type: Sequelize.DECIMAL(36, 18),
        allowNull: false,
      },
      balance_before: {
        type: Sequelize.DECIMAL(36, 18),
        allowNull: false,
      },
      balance_after: {
        type: Sequelize.DECIMAL(36, 18),
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('now()'),
      },
    });

    await queryInterface.addIndex('wallet_txs', ['wallet_id'], {
      name: 'wallet_txs_wallet_id_idx',
    });
    await queryInterface.addIndex('wallet_txs', ['reference_id'], {
      name: 'wallet_txs_reference_id_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wallet_txs');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_wallet_txs_type";');
  },
};
