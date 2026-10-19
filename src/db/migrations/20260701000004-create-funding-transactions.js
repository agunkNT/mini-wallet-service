'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('funding_transactions', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      member_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'members', key: 'id' },
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      type: {
        type: Sequelize.ENUM('deposit', 'withdrawal'),
        allowNull: false,
      },
      amount: {
        type: Sequelize.DECIMAL(36, 18),
        allowNull: false,
      },
      turnover_multiplier: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      status: {
        type: Sequelize.ENUM('pending', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
      },
      psp_ref: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true,
      },
      raw_callback_payload: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('now()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('now()'),
      },
    });

    await queryInterface.addIndex('funding_transactions', ['psp_ref'], {
      unique: true,
      name: 'funding_transactions_psp_ref_unique',
    });
    await queryInterface.addIndex('funding_transactions', ['member_id'], {
      name: 'funding_transactions_member_id_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('funding_transactions');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_funding_transactions_type";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_funding_transactions_status";');
  },
};
