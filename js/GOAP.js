// GOAP.js — a small goal-oriented action planner for real-time agents. No Babylon, no DOM
// and no RTS knowledge: states are flat objects, actions declare preconditions, effects and
// a cost, goals are partial states. GOAPAgent executes a plan and replans on failure.

/**
 * @typedef {Object} GOAPAction
 * @property {string} id
 * @property {Record<string, any> | ((state: Record<string, any>, ctx: any) => boolean)} [pre]
 * @property {Record<string, any> | ((state: Record<string, any>, ctx: any) => Record<string, any>)} [effects]
 * @property {number | ((state: Record<string, any>, ctx: any) => number)} [cost]
 * @property {(agent: GOAPAgent) => string} [start]
 * @property {(agent: GOAPAgent, dt: number) => string} [update]
 */

/**
 * @typedef {Object} GOAPGoal
 * @property {string} id
 * @property {number} priority
 * @property {Record<string, any>} desired
 */

class GOAPPlanner {
    /**
     * @param {Record<string, any>} state
     * @returns {string}
     */
    static signature(state) {
        const keys = Object.keys(state).sort();
        const parts = keys.map(key => [key, typeof state[key], state[key]]);
        return JSON.stringify(parts);
    }

    /**
     * @param {Record<string, any>} state
     * @param {Record<string, any>} goal
     * @returns {boolean}
     */
    static satisfies(state, goal) {
        if (!goal) return true;
        for (const key of Object.keys(goal)) {
            if (state[key] !== goal[key]) return false;
        }
        return true;
    }

    /**
     * @param {Record<string, any>} state
     * @param {Record<string, any>} goal
     * @returns {number}
     */
    static unmet(state, goal) {
        let n = 0;
        for (const key of Object.keys(goal)) {
            if (state[key] !== goal[key]) n++;
        }
        return n;
    }

    /**
     * @param {any} action
     * @param {Record<string, any>} state
     * @param {any} ctx
     * @returns {boolean}
     */
    static allows(action, state, ctx) {
        if (!action || !action.pre) return true;
        if (typeof action.pre === 'function') return !!action.pre(state, ctx);
        return GOAPPlanner.satisfies(state, action.pre);
    }

    /**
     * @param {Record<string, any>} state
     * @param {any} effects
     * @param {any} ctx
     * @returns {Record<string, any>}
     */
    static apply(state, effects, ctx) {
        const delta = typeof effects === 'function' ? effects(state, ctx) : effects;
        if (!delta) return state;
        const next = Object.assign({}, state);
        for (const key of Object.keys(delta)) next[key] = delta[key];
        return next;
    }

    /**
     * @param {Record<string, any>} start
     * @param {Record<string, any>} goal
     * @param {any[]} actions
     * @param {{ maxExpansions?: number, ctx?: any }} [options]
     * @returns {{ ok: boolean, plan: any[], cost: number, expansions: number }}
     */
    static plan(start, goal, actions, options = {}) {
        const maxExpansions = Math.max(1, options.maxExpansions || 400);
        const ctx = options.ctx || null;
        const open = [{ state: start, g: 0, steps: [] }];
        const seen = new Map();
        let expansions = 0;
        while (open.length && expansions < maxExpansions) {
            open.sort((a, b) =>
                (a.g - b.g) ||
                (GOAPPlanner.unmet(a.state, goal) - GOAPPlanner.unmet(b.state, goal)));
            const node = open.shift();
            expansions++;
            if (GOAPPlanner.satisfies(node.state, goal)) {
                return { ok: true, plan: node.steps, cost: node.g, expansions };
            }
            const sig = GOAPPlanner.signature(node.state);
            if (seen.has(sig) && seen.get(sig) <= node.g) continue;
            seen.set(sig, node.g);
            for (const action of actions) {
                if (!action) continue;
                if (!GOAPPlanner.allows(action, node.state, ctx)) continue;
                const raw = action.cost == null ? 1 :
                    typeof action.cost === 'function' ? action.cost(node.state, ctx) : action.cost;
                const cost = Number(raw);
                if (!Number.isFinite(cost) || cost < 0) {
                    throw new Error('GOAP action "' + action.id + '" has invalid cost: ' + raw);
                }
                const next = GOAPPlanner.apply(node.state, action.effects, ctx);
                const nextSig = GOAPPlanner.signature(next);
                const g = node.g + cost;
                if (seen.has(nextSig) && seen.get(nextSig) <= g) continue;
                open.push({ state: next, g, steps: node.steps.concat(action) });
            }
        }
        return { ok: false, plan: [], cost: Infinity, expansions };
    }
}

class GOAPAgent {
    /**
     * @param {{ interval?: number, maxExpansions?: number, maxSteps?: number,
     *           planTtl?: number, actionTimeout?: number, retry?: number,
     *           sticky?: number, cacheLimit?: number }} [options]
     */
    constructor(options = {}) {
        this.interval = Math.max(0.05, options.interval || 1);
        this.maxExpansions = Math.max(1, options.maxExpansions || 400);
        this.maxSteps = Math.max(1, options.maxSteps || 1);
        this.planTtl = Math.max(0.1, options.planTtl || 10);
        this.actionTimeout = Math.max(0.1, options.actionTimeout || 12);
        this.retry = Math.max(0, options.retry || 0);
        this.sticky = Math.max(0, options.sticky == null ? 10 : options.sticky);
        this.cacheLimit = Math.max(1, options.cacheLimit || 64);
        this.think = 0;
        this.clock = 0;
        this.planTime = 0;
        this.plan = [];
        this.index = 0;
        this.goal = null;
        this.running = null;
        this.cache = new Map();
        this.stats = { plans: 0, expansions: 0, cacheHits: 0 };
    }

    /** @returns {Record<string, any>} */
    facts() { return {}; }

    /** @param {Record<string, any>} state @returns {any[]} */
    goals(state) { return []; }

    /** @returns {any[]} */
    actions() { return []; }

    /** @param {Record<string, any>} state @returns {string} */
    cacheKey(state) { return GOAPPlanner.signature(state); }

    /** @param {any} goal @param {any[]} plan */
    onGoalChanged(goal, plan) {}

    resetPlan() {
        this.plan = [];
        this.index = 0;
        this.running = null;
        this.planTime = 0;
    }

    /** @param {number} dt */
    update(dt) {
        this.clock += dt;
        this.planTime += dt;
        if (this.running) {
            this.running.time += dt;
            const result = this.running.action.update
                ? this.running.action.update(this, dt)
                : 'running';
            if (result === 'done') {
                this.running = null;
                this.index++;
            } else if (result === 'failed' ||
                this.running.time > (this.running.action.timeout || this.actionTimeout)) {
                this.running = null;
                this._forceReplan();
                return;
            }
        }
        this.think -= dt;
        if (this.think > 0) return;
        this.think = this.interval;
        this._reconsider();
        let steps = this.maxSteps;
        while (steps-- > 0 && !this.running && this.index < this.plan.length) {
            const action = this.plan[this.index];
            const state = this.facts();
            if (!GOAPPlanner.allows(action, state, this)) {
                this._forceReplan();
                break;
            }
            this.running = { action, time: 0 };
            const result = action.start ? action.start(this) : 'done';
            if (result === 'done') {
                this.running = null;
                this.index++;
            } else if (result === 'failed') {
                this.running = null;
                this._forceReplan();
                break;
            }
        }
    }

    _forceReplan() {
        this.resetPlan();
        this.think = Math.max(0, this.retry);
        this.planTime = this.planTtl + 1;
    }

    _reconsider() {
        const state = this.facts();
        const base = this.goals(state) || [];
        const actions = this.actions() || [];
        const actionKey = actions.filter(Boolean).map(action => action.id).join(',');
        const goals = base.map(goal => {
            const sticky = this.goal && this.goal.id === goal.id &&
                this.planTime < this.planTtl && this.index < this.plan.length;
            return {
                id: goal.id,
                desired: goal.desired,
                priority: goal.priority + (sticky ? this.sticky : 0)
            };
        });
        goals.sort((a, b) => b.priority - a.priority);
        for (const goal of goals) {
            if (this.goal && this.goal.id === goal.id && this.running) {
                return;
            }
            if (this.goal && this.goal.id === goal.id &&
                this.index < this.plan.length && this.planTime < this.planTtl) {
                return;
            }
            const key = goal.id + '|' + GOAPPlanner.signature(goal.desired) + '|' +
                actionKey + '|' + this.cacheKey(state);
            const cached = this.cache.get(key);
            let result = null;
            if (cached && this.clock - cached.at < this.planTtl) {
                result = cached.result;
                this.stats.cacheHits++;
            } else {
                result = GOAPPlanner.plan(state, goal.desired, actions, {
                    maxExpansions: this.maxExpansions,
                    ctx: this
                });
                for (const [entryKey, record] of this.cache) {
                    if (this.clock - record.at >= this.planTtl) this.cache.delete(entryKey);
                }
                this.cache.set(key, { at: this.clock, result });
                while (this.cache.size > this.cacheLimit) {
                    const oldest = this.cache.keys().next();
                    if (oldest.done) break;
                    this.cache.delete(oldest.value);
                }
            }
            if (!result.ok) continue;
            if (!result.plan.length) {
                if (this.goal && this.goal.id === goal.id && !this.plan.length) return;
                this.goal = { id: goal.id, priority: goal.priority, desired: goal.desired };
                this.plan = [];
                this.index = 0;
                this.running = null;
                this.planTime = 0;
                this.stats.plans++;
                this.stats.expansions += result.expansions || 0;
                this.onGoalChanged(this.goal, this.plan);
                return;
            }
            const changed = !this.goal || this.goal.id !== goal.id ||
                this.index >= this.plan.length || this.planTime >= this.planTtl;
            if (changed) {
                this.goal = { id: goal.id, priority: goal.priority, desired: goal.desired };
                this.plan = result.plan;
                this.index = 0;
                this.running = null;
                this.planTime = 0;
                this.stats.plans++;
                this.stats.expansions += result.expansions || 0;
                this.onGoalChanged(this.goal, this.plan);
            }
            return;
        }
    }
}
