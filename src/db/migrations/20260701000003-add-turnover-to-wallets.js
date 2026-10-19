'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wallets', 'required_turnover', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });
    await queryInterface.addColumn('wallets', 'accrued_turnover', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('wallets', 'required_turnover');
    await queryInterface.removeColumn('wallets', 'accrued_turnover');
  },
};
