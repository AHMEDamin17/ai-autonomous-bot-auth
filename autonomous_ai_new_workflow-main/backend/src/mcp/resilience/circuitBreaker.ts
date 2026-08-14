export interface CircuitState {
  failures: number;
  successes: number;
  status: 'closed' | 'open' | 'half-open';
  openedAt: number | null;
  lastFailureAt: number | null;
  failureThreshold: number;
  successThreshold: number;
  cooldownMs: number;
  failureDecayMs: number;
  halfOpenInFlight?: boolean;
  lastHalfOpenAt?: number | null;
}

export interface BreakerDefaults {
  failureThreshold?: number;
  successThreshold?: number;
  cooldownMs?: number;
  failureDecayMs?: number;
}

export interface CanExecuteResult {
  allowed: boolean;
  status: 'closed' | 'open' | 'half-open';
  retryAfterMs?: number;
}

const breakers = new Map<string, CircuitState>();

const GLOBAL_DEFAULTS = {
  failureThreshold: Number(process.env.CIRCUIT_FAILURE_THRESHOLD) || 2,
  successThreshold: Number(process.env.CIRCUIT_SUCCESS_THRESHOLD) || 3,
  cooldownMs: Number(process.env.CIRCUIT_COOLDOWN_MS) || 15000,
  failureDecayMs: Number(process.env.CIRCUIT_DECAY_MS) || 60000,
};

export function getCircuitState(connectionKey: string, defaults?: BreakerDefaults): CircuitState {
  const existing = breakers.get(connectionKey);
  if (existing) return existing;
  // Always create-and-set so the returned object IS the one in the Map
  const state: CircuitState = {
    failures: 0,
    successes: 0,
    status: 'closed',
    openedAt: null,
    lastFailureAt: null,
    failureThreshold: defaults?.failureThreshold ?? GLOBAL_DEFAULTS.failureThreshold,
    successThreshold: defaults?.successThreshold ?? GLOBAL_DEFAULTS.successThreshold,
    cooldownMs: defaults?.cooldownMs ?? GLOBAL_DEFAULTS.cooldownMs,
    failureDecayMs: defaults?.failureDecayMs ?? GLOBAL_DEFAULTS.failureDecayMs,
    lastHalfOpenAt: null,
  };
  breakers.set(connectionKey, state);
  return state;
}

function tryClaim(state: CircuitState): boolean {
  if (state.status !== 'half-open') return false;
  if (state.halfOpenInFlight) {
    if (state.lastHalfOpenAt && Date.now() - state.lastHalfOpenAt > 30000) {
      state.halfOpenInFlight = false;
    } else {
      return false;
    }
  }
  state.halfOpenInFlight = true;
  state.lastHalfOpenAt = Date.now();
  return true;
}

export function canExecute(connectionKey: string, defaults?: BreakerDefaults): CanExecuteResult {
  const state = getCircuitState(connectionKey, defaults);
  const now = Date.now();

  if (state.status === 'closed') {
    if (state.failures > 0 && state.lastFailureAt) {
      const elapsed = now - state.lastFailureAt;
      if (elapsed < 0) {
        state.lastFailureAt = now;
      } else if (elapsed > state.failureDecayMs) {
        state.failures = 0;
      }
    }
    return { allowed: true, status: 'closed' };
  }

  if (state.status === 'open') {
    if (state.openedAt && now - state.openedAt > state.cooldownMs) {
      // Transition to half-open AND immediately claim the probe.
      state.status = 'half-open';
      state.successes = 0;
      state.halfOpenInFlight = true;
      state.lastHalfOpenAt = now;
      return { allowed: true, status: 'half-open' };
    }
    
    // Still in cooldown
    const retryAfterMs = state.openedAt ? Math.max(0, state.cooldownMs - (now - state.openedAt)) : state.cooldownMs;
    return { allowed: false, status: 'open', retryAfterMs };
  }

  // half-open: allow exactly one execution to test the waters
  if (tryClaim(state)) return { allowed: true, status: 'half-open' };
  return { allowed: false, status: 'half-open' };
}

export function recordSuccess(connectionKey: string, defaults?: BreakerDefaults): void {
  const state = breakers.get(connectionKey);
  if (!state) {
    return;
  }

  state.halfOpenInFlight = false;
  state.lastHalfOpenAt = null;

  if (state.status === 'half-open') {
    state.successes += 1;
    if (state.successes >= state.successThreshold) {
      state.status = 'closed';
      state.failures = 0;
      state.successes = 0;
      state.openedAt = null;
    }
  } else if (state.status === 'closed') {
    state.failures = 0;
  }
}

export function recordFailure(connectionKey: string, defaults?: BreakerDefaults): CircuitState {
  let state = breakers.get(connectionKey);
  if (!state) {
    state = getCircuitState(connectionKey, defaults);
    breakers.set(connectionKey, state);
  }

  state.halfOpenInFlight = false;
  state.lastHalfOpenAt = null;
  state.lastFailureAt = Date.now();
  
  if (state.status === 'half-open') {
    // Any failure in half-open immediately sends it back to open and resets success count
    state.status = 'open';
    state.openedAt = Date.now();
    state.successes = 0;
    // Keep failures at threshold so it doesn't immediately close on a fluke
    state.failures = state.failureThreshold;
  } else {
    state.failures += 1;
    if (state.failures >= state.failureThreshold) {
      state.status = 'open';
      state.openedAt = Date.now();
      state.successes = 0;
    }
  }
  
  return state;
}
