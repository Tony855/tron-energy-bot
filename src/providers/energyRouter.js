'use strict';

function validAdapter(provider) {
  return provider && provider.enabled === true &&
    /^[a-zA-Z0-9_.-]{1,80}$/.test(String(provider.name || '')) &&
    ['getQuote', 'createOrder', 'getOrderStatus'].every(name => typeof provider[name] === 'function');
}

function createEnergyProviderRouter({
  providers = [], failureThreshold = 3, cooldownMs = 30000, now = Date.now
} = {}) {
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new TypeError('Invalid failure threshold');
  const states = new Map();
  const active = providers.filter(validAdapter);
  for (const provider of active) states.set(provider.name, { failures: 0, openUntil: 0 });

  function available(provider) {
    const state = states.get(provider.name);
    return state && state.openUntil <= now();
  }
  function failure(provider) {
    const state = states.get(provider.name);
    state.failures++;
    if (state.failures >= failureThreshold) state.openUntil = now() + cooldownMs;
  }
  function success(provider) {
    const state = states.get(provider.name);
    state.failures = 0;
    state.openUntil = 0;
  }

  async function quotes(request) {
    const candidates = active.filter(available);
    const settled = await Promise.allSettled(candidates.map(async provider => {
      const quote = await provider.getQuote(request);
      const price = String(quote?.price ?? '');
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(price) || Number(price) <= 0) {
        throw Object.assign(new Error('INVALID_PROVIDER_QUOTE'), { code: 'INVALID_PROVIDER_QUOTE' });
      }
      if (!quote.validUntil || Date.parse(quote.validUntil) <= now()) {
        throw Object.assign(new Error('PROVIDER_QUOTE_EXPIRED'), { code: 'PROVIDER_QUOTE_EXPIRED' });
      }
      return { provider: provider.name, price, currency: String(quote.currency || 'USDT'), validUntil: quote.validUntil, raw: quote };
    }));
    const results = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        success(candidates[i]);
        results.push(result.value);
      } else failure(candidates[i]);
    }
    return results.sort((a, b) => Number(a.price) - Number(b.price));
  }

  // Fallback is allowed only when the adapter explicitly proves that no order
  // was accepted. Timeouts, connection resets and unknown outcomes stop routing.
  async function submitWithSafeFailover(candidates, request) {
    for (const candidate of candidates) {
      const provider = active.find(item => item.name === candidate.provider);
      if (!provider || !available(provider)) continue;
      try {
        const result = await provider.createOrder({ ...request, quote: candidate.raw });
        if (!result || result.accepted !== true || !result.orderId) {
          throw Object.assign(new Error('PROVIDER_SUBMISSION_UNCONFIRMED'), { code: 'PROVIDER_SUBMISSION_UNCONFIRMED' });
        }
        success(provider);
        return { provider: provider.name, orderId: String(result.orderId), status: result.status || 'processing' };
      } catch (error) {
        failure(provider);
        if (error?.definitive !== true) {
          return { provider: provider.name, status: 'submission_unknown', errorCode: 'SUBMISSION_OUTCOME_UNKNOWN' };
        }
      }
    }
    return { status: 'failed', errorCode: 'NO_PROVIDER_ACCEPTED_ORDER' };
  }

  async function getOrderStatus(providerName, orderId) {
    const provider = active.find(item => item.name === providerName);
    if (!provider || !available(provider)) throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE' });
    try {
      const result = await provider.getOrderStatus(orderId);
      success(provider);
      return result;
    } catch (error) {
      failure(provider);
      throw error;
    }
  }

  return Object.freeze({
    quotes, submitWithSafeFailover, getOrderStatus,
    getProviderHealth: () => Object.fromEntries([...states].map(([name, state]) => [name, {
      failures: state.failures, circuitOpen: state.openUntil > now()
    }]))
  });
}

module.exports = { createEnergyProviderRouter, validAdapter };
