/**
 * Energy provider adapter contract.
 *
 * No supplier API is configured in V1.3. This module intentionally fails closed:
 * it never reports success, never debits a user's balance, and never submits a
 * TRON transaction until a real supplier-specific implementation is added.
 */
class EnergyProvider {
  constructor() {
    this.name = 'disabled';
    this.enabled = false;
  }

  async getQuote() {
    throw new Error('ENERGY_PROVIDER_NOT_CONFIGURED');
  }

  async createOrder() {
    throw new Error('ENERGY_PROVIDER_NOT_CONFIGURED');
  }

  async getOrderStatus() {
    throw new Error('ENERGY_PROVIDER_NOT_CONFIGURED');
  }

  async cancelOrder() {
    throw new Error('ENERGY_PROVIDER_NOT_CONFIGURED');
  }
}

function getEnergyProvider() {
  // Intentionally no generic fake provider. Supplier APIs have different
  // authentication, quote units, order semantics and callback verification.
  return new EnergyProvider();
}

module.exports = { EnergyProvider, getEnergyProvider };
