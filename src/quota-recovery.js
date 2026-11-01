const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ACCOUNT_INTERVAL = 15 * MINUTE;
const MAX_ACCOUNTS = 2048;
const MAX_TIME = Number.MAX_SAFE_INTEGER - HOUR;
const RESULTS = new Set([
  'observed', 'no-quota', 'rate-limit', 'authentication', 'forbidden',
  'transport-error', 'aborted', 'persistence-failed', 'identity-changed',
  'interrupted', 'unknown',
]);
const FAULTS = new Set(['invalid-state', 'clock-rollback', 'clock-unavailable']);

function hash(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : null;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function sameLease(left, right) {
  try {
    return left !== null && right !== null && typeof right === 'object'
      && left.id === right.id && left.accountHash === right.accountHash
      && left.identityHash === right.identityHash && left.startedAt === right.startedAt;
  } catch {
    return false;
  }
}

/** Pure, synchronous admission budget. A reservation is spent even if its work fails. */
export class QuotaRecovery {
  #now;
  #lastSeenAt = null;
  #fault = null;
  #sequence = 0;
  #poolLastStartedAt = null;
  #restoredPoolNotBefore = null;
  #pending = null;
  #accounts = new Map();

  constructor({ now = Date.now } = {}) {
    this.#now = now;
    this.#readNow();
  }

  #readNow() {
    if (this.#fault && this.#fault !== 'clock-rollback') return null;
    try {
      const current = this.#now();
      if (!timestamp(current)) {
        this.#fault = 'clock-unavailable';
        return null;
      }
      if (this.#lastSeenAt !== null && current < this.#lastSeenAt) {
        this.#fault = 'clock-rollback';
        // Keep response bookkeeping possible while new reservations wait.
        return this.#lastSeenAt;
      }
      this.#fault = null;
      this.#lastSeenAt = current;
      return current;
    } catch {
      this.#fault = 'clock-unavailable';
      return null;
    }
  }

  #inspectAt(accountHash, identityHash, current) {
    const account = this.#accounts.get(accountHash);
    const response = {
      probeReady: false,
      inFlight: this.#pending !== null,
      nextAllowedAt: null,
      reason: 'ready',
      lastResult: account?.lastResult ?? null,
    };
    if (this.#fault && this.#fault !== 'clock-rollback') return { ...response, reason: this.#fault };
    if (!accountHash || !identityHash) return { ...response, reason: 'invalid-input' };
    if (!this.#fault && account?.deniedIdentity === identityHash) return { ...response, reason: 'identity-denied' };
    let next = current;
    let reason = 'ready';
    const limits = [
      [this.#poolLastStartedAt === null ? 0 : this.#poolLastStartedAt + MINUTE, 'pool-interval'],
      [this.#restoredPoolNotBefore ?? 0, 'pool-interval'],
    ];
    if (account) {
      const starts = account.starts.filter(start => start > current - HOUR);
      limits.push([starts.length ? starts.at(-1) + ACCOUNT_INTERVAL : 0, 'account-interval']);
      limits.push([account.blockedUntil ?? 0, 'rate-limit']);
      limits.push([starts.length >= 2 ? starts[0] + HOUR : 0, 'hourly-limit']);
    }
    for (const [at, label] of limits) {
      if (at > current && at >= next) {
        next = at;
        reason = label;
      }
    }
    response.nextAllowedAt = next > current ? next : null;
    if (this.#fault === 'clock-rollback') return { ...response, nextAllowedAt: next, reason: this.#fault };
    if (account?.unresolved === true) return { ...response, reason: 'outcome-unknown' };
    if (this.#pending) return { ...response, reason: 'pool-in-flight' };
    if (!account && this.#accounts.size >= MAX_ACCOUNTS) return { ...response, reason: 'capacity', nextAllowedAt: null };
    if (this.#sequence >= Number.MAX_SAFE_INTEGER) return { ...response, reason: 'sequence-exhausted', nextAllowedAt: null };
    return { ...response, probeReady: next === current, reason };
  }

  inspect(accountHash, identityHash) {
    const current = this.#readNow();
    return this.#inspectAt(hash(accountHash), hash(identityHash), current);
  }

  referenceTime() {
    return this.#readNow();
  }

  isHeld(accountHash) {
    const account = this.#accounts.get(hash(accountHash));
    if (!account) return false;
    if (account.unresolved === true) return true;
    if (account.blockedUntil === null) return false;
    const current = this.#readNow();
    return current === null || this.#fault === 'clock-rollback' || account.blockedUntil > current;
  }

  reserve(accountHash, identityHash) {
    const current = this.#readNow();
    const accountKey = hash(accountHash);
    const identityKey = hash(identityHash);
    if (!this.#inspectAt(accountKey, identityKey, current).probeReady) return null;
    let account = this.#accounts.get(accountKey);
    if (!account) {
      account = { accountHash: accountKey, starts: [], blockedUntil: null, lastResult: null, deniedIdentity: null };
      this.#accounts.set(accountKey, account);
    }
    account.starts = account.starts.filter(start => start > current - HOUR);
    account.starts.push(current);
    this.#poolLastStartedAt = current;
    this.#pending = { id: ++this.#sequence, accountHash: accountKey, identityHash: identityKey, startedAt: current };
    return { ...this.#pending };
  }

  isCurrent(lease) {
    this.#readNow();
    return (!this.#fault || this.#fault === 'clock-rollback') && sameLease(this.#pending, lease);
  }

  settle(lease, outcome = {}) {
    const current = this.#readNow();
    if ((this.#fault && this.#fault !== 'clock-rollback') || !sameLease(this.#pending, lease)) return false;
    let result = 'unknown';
    let status = null;
    let notBefore = null;
    try {
      const reportedResult = outcome?.result;
      result = RESULTS.has(reportedResult) ? reportedResult : 'unknown';
      status = outcome?.status;
      notBefore = outcome?.notBefore;
    } catch {
      // Unreadable outcomes still spend their reservation.
    }
    const account = this.#accounts.get(this.#pending.accountHash);
    // Keep the spent slot, but use completion as a conservative send-time bound.
    const completedAt = Math.max(this.#pending.startedAt, current);
    account.starts[account.starts.length - 1] = completedAt;
    this.#poolLastStartedAt = completedAt;
    account.lastResult = result;
    if (status === 401 || status === 403 || result === 'authentication' || result === 'forbidden') {
      account.deniedIdentity = this.#pending.identityHash;
    }
    if (status === 429 || result === 'rate-limit') {
      const deadline = timestamp(notBefore) ? notBefore : current + HOUR;
      account.blockedUntil = Math.max(account.blockedUntil ?? 0, deadline);
    }
    this.#pending = null;
    return true;
  }

  exportState() {
    this.#readNow();
    return {
      schemaVersion: 1,
      sequence: this.#sequence,
      lastSeenAt: this.#lastSeenAt ?? 0,
      fault: this.#fault,
      poolLastStartedAt: this.#poolLastStartedAt,
      pending: this.#pending ? { ...this.#pending } : null,
      accounts: [...this.#accounts.values()].map(account => ({ ...account, starts: [...account.starts] })),
    };
  }

  restoreState(value) {
    if (this.#fault && this.#fault !== 'clock-rollback') return;
    this.#readNow();
    if (this.#fault && this.#fault !== 'clock-rollback') return;
    // Restoration is an initialization operation, never a way to refund reservations.
    if (this.#sequence !== 0 || this.#accounts.size !== 0) {
      this.#fault = 'invalid-state';
      return;
    }
    if (value === undefined || value === null) return;
    try {
      const restored = this.#validateState(value);
      if (!restored) {
        this.#fault = 'invalid-state';
        return;
      }
      this.#sequence = value.sequence;
      this.#poolLastStartedAt = value.poolLastStartedAt;
      this.#accounts = restored;
      this.#lastSeenAt = Math.max(this.#lastSeenAt ?? 0, value.lastSeenAt);
      this.#fault = value.fault === 'clock-rollback' ? null : value.fault;
      if (value.pending) {
        const account = this.#accounts.get(value.pending.accountHash);
        account.lastResult = 'interrupted';
        account.unresolved = true;
      }
      this.#pending = null;
      const restoredAt = this.#readNow();
      if (restoredAt !== null && [...this.#accounts.values()].some(account => account.unresolved === true)) {
        // Rebuild this wait after each restore without changing the saved format.
        this.#restoredPoolNotBefore = restoredAt + MINUTE;
      }
    } catch {
      this.#fault = 'invalid-state';
    }
  }

  #validateState(value) {
    if (!exactKeys(value, ['schemaVersion', 'sequence', 'lastSeenAt', 'fault', 'poolLastStartedAt', 'pending', 'accounts'])
      || value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || !timestamp(value.lastSeenAt)
      || (value.fault !== null && !FAULTS.has(value.fault))
      || (value.poolLastStartedAt !== null && (!timestamp(value.poolLastStartedAt) || value.poolLastStartedAt > value.lastSeenAt))
      || !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS) return null;
    const accounts = new Map();
    const allStarts = [];
    let totalStarts = 0;
    for (const account of value.accounts) {
      const unresolved = Object.hasOwn(account, 'unresolved');
      if (!exactKeys(account, ['accountHash', 'starts', 'blockedUntil', 'lastResult', 'deniedIdentity',
        ...(unresolved ? ['unresolved'] : [])])
        || (unresolved && account.unresolved !== true)
        || hash(account.accountHash) !== account.accountHash || !hash(account.accountHash)
        || accounts.has(account.accountHash) || !Array.isArray(account.starts) || account.starts.length < 1 || account.starts.length > 2
        || (account.lastResult !== null && !RESULTS.has(account.lastResult))
        || (account.deniedIdentity !== null && (!hash(account.deniedIdentity) || hash(account.deniedIdentity) !== account.deniedIdentity))
        || (account.blockedUntil !== null && !timestamp(account.blockedUntil))) return null;
      let previous = null;
      for (const start of account.starts) {
        if (!timestamp(start) || value.poolLastStartedAt === null || start > value.poolLastStartedAt
          || (previous !== null && start - previous < ACCOUNT_INTERVAL)) return null;
        previous = start;
        allStarts.push(start);
      }
      totalStarts += account.starts.length;
      accounts.set(account.accountHash, { ...account, starts: [...account.starts] });
    }
    if (totalStarts > value.sequence || (value.sequence === 0 && (value.accounts.length !== 0 || value.poolLastStartedAt !== null))
      || (value.sequence > 0 && (value.accounts.length === 0 || value.poolLastStartedAt === null))) return null;
    allStarts.sort((left, right) => left - right);
    if (allStarts.length && allStarts.at(-1) !== value.poolLastStartedAt) return null;
    for (let index = 1; index < allStarts.length; index++) {
      if (allStarts[index] - allStarts[index - 1] < MINUTE) return null;
    }
    if (value.pending !== null) {
      const pending = value.pending;
      if (!exactKeys(pending, ['id', 'accountHash', 'identityHash', 'startedAt'])
        || pending.id !== value.sequence || !Number.isSafeInteger(pending.id) || pending.id <= 0
        || !hash(pending.identityHash) || hash(pending.identityHash) !== pending.identityHash
        || !timestamp(pending.startedAt) || pending.startedAt !== value.poolLastStartedAt
        || accounts.get(pending.accountHash)?.starts.at(-1) !== pending.startedAt
        || accounts.get(pending.accountHash)?.unresolved === true
        || accounts.get(pending.accountHash)?.deniedIdentity === pending.identityHash) return null;
    }
    for (const account of accounts.values()) {
      if (account.lastResult === null && value.pending?.accountHash !== account.accountHash) return null;
    }
    return accounts;
  }
}
