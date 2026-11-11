// RTSSquads.js — tactical GOAP squads of the RTS opponent. The manager groups combat
// units by role and hands out missions from RTSAIDirector; each squad plans its own actions
// and issues existing RTSWorld orders. No Babylon and no DOM.

class RTSSquadManager {
    /** @param {RTSWorld} world */
    constructor(world) {
        this.world = world;
        this.list = [];
        this.byUnit = new Map();
        this.claims = new Map();
        this.nextId = 1;
        this.refresh = 0;
    }

    /** @param {number} dt */
    update(dt) {
        const T = RTS_DATA.AI.SQUAD_THRESHOLDS;
        if (!this.world.running) return;
        this.refresh -= dt;
        if (this.refresh <= 0) {
            this.refresh = T.rebuildSec;
            this._rebuild();
        }
        const now = this.world.time || 0;
        for (const [id, rec] of this.claims) {
            if (rec.until <= now) this.claims.delete(id);
        }
        for (const squad of this.list.slice()) squad.update(dt);
    }

    _rebuild() {
        const T = RTS_DATA.AI.SQUAD_THRESHOLDS;
        for (const squad of this.list.slice()) {
            squad.units = squad.units.filter(u => u.isAlive && u.team === 'enemy' && u.role !== 'worker');
            if (!squad.units.length) {
                const i = this.list.indexOf(squad);
                if (i >= 0) {
                    this.list.splice(i, 1);
                    this.release(squad);
                }
            }
        }
        this.byUnit.clear();
        for (const squad of this.list) for (const u of squad.units) this.byUnit.set(u, squad);

        const free = this.world.units.filter(u => u.isAlive && u.team === 'enemy' &&
            u.role !== 'worker' && !this.byUnit.has(u));
        const take = (pred) => {
            const u = free.find(pred);
            if (u) free.splice(free.indexOf(u), 1);
            return u || null;
        };
        const fast = (u) => u.role === 'scout' || u.role === 'infantry';

        // Scout first: an existing harass squad must not consume the only free scout.
        if (!this.byRole('scout').length) {
            let u = take(u => u.role === 'scout');
            if (!u) {
                for (const squad of this.list) {
                    if (squad.role === 'scout') continue;
                    const i = squad.units.findIndex(x => x.role === 'scout');
                    if (i >= 0) {
                        u = squad.units.splice(i, 1)[0];
                        this.byUnit.delete(u);
                        break;
                    }
                }
            }
            if (u) {
                const s = this._newSquad('scout');
                this._attach(s, u);
            }
        }

        // Harass next: free fast units first, then fill the raid from assault squads.
        if (!this.byRole('harass').length) {
            const group = [];
            for (let i = 0; i < RTS_SQUAD_HARASS_SIZE; i++) {
                const u = take(fast);
                if (!u) break;
                group.push(u);
            }
            let missing = RTS_SQUAD_HARASS_SIZE - group.length;
            for (const squad of this.list) {
                if (missing <= 0) break;
                if (squad.role !== 'assault') continue;
                while (missing > 0 && squad.units.length) {
                    const i = squad.units.findIndex(fast);
                    if (i < 0) break;
                    const u = squad.units.splice(i, 1)[0];
                    this.byUnit.delete(u);
                    group.push(u);
                    missing--;
                }
            }
            if (group.length >= RTS_SQUAD_HARASS_SIZE) {
                const s = this._newSquad('harass');
                for (const u of group) this._attach(s, u);
            } else {
                for (const u of group) free.push(u);
            }
        }

        if (!this.byRole('siege').length) {
            const siege = take(u => u.role === 'siege');
            if (siege) {
                const s = this._newSquad('siege');
                this._attach(s, siege);
                for (let i = 0; i < 2; i++) {
                    const u = take(x => x.role === 'infantry' || x.role === 'grenadier');
                    if (u) this._attach(s, u);
                }
            }
        }

        for (const squad of this.list) {
            if (squad.role === 'scout' && squad.units.length < 1) {
                const u = take(u => u.role === 'scout');
                if (u) this._attach(squad, u);
            } else if (squad.role === 'harass' && squad.units.length < RTS_SQUAD_HARASS_SIZE) {
                const u = take(fast);
                if (u) this._attach(squad, u);
            } else if (squad.role === 'siege' && squad.units.length < T.siegeSize) {
                const u = take(u => u.role === 'infantry' || u.role === 'grenadier' || u.role === 'siege');
                if (u) this._attach(squad, u);
            } else if (squad.role === 'assault' && squad.units.length < RTS_SQUAD_SIZE) {
                const u = take(u => u.role === 'infantry' || u.role === 'scout' || u.role === 'grenadier');
                if (u) this._attach(squad, u);
            }
        }

        for (const u of free) {
            let squad = this.byRole('assault').find(s => s.units.length < RTS_SQUAD_SIZE);
            if (!squad) squad = this._newSquad('assault');
            this._attach(squad, u);
        }
    }

    _newSquad(role) {
        const squad = new RTSSquad(this, this.nextId++, role);
        squad.setMission('hold', null, this.world.map.enemyBase);
        this.list.push(squad);
        return squad;
    }

    _attach(squad, unit) {
        if (!unit || squad.units.indexOf(unit) >= 0) return;
        squad.units.push(unit);
        this.byUnit.set(unit, squad);
        squad.initialStrength = Math.max(squad.initialStrength, squad.units.length);
        if (squad.units.length > 1) squad._forceReplan();
    }

    /** @returns {RTSSquad[]} */
    byRole(role) {
        return this.list.filter(s => s.role === role && s.units.length);
    }

    /** @param {any} threat @returns {RTSSquad | null} */
    assignDefense(threat) {
        let list = this.list.filter(s => s.units.length &&
            s.role !== 'scout' && s.mission !== 'harass');
        if (!list.length) list = this.list.filter(s => s.units.length && s.role !== 'scout');
        list.sort((a, b) => {
            const ca = a.center(), cb = b.center();
            return Math.hypot(ca.x - threat.x, ca.y - threat.y) -
                Math.hypot(cb.x - threat.x, cb.y - threat.y);
        });
        const squad = list[0] || null;
        if (!squad) return null;
        squad.setMission('defend', threat, { x: threat.x, y: threat.y });
        return squad;
    }

    /** @param {any} target @param {any} [staging] @returns {RTSSquad[]} */
    assignAttack(target, staging) {
        const list = this.list.filter(s => s.units.length &&
            (s.role === 'assault' || s.role === 'siege'));
        for (const s of list) s.setMission('attack', target || null, staging || target);
        return list;
    }

    /** @param {{x: number, y: number}} point @returns {RTSSquad | null} */
    assignHarass(point) {
        const squad = this.byRole('harass')[0] || null;
        if (!squad) return null;
        squad.setMission('harass', null, { x: point.x, y: point.y });
        return squad;
    }

    /** @param {{x: number, y: number}} point @returns {RTSSquad | null} */
    assignScout(point) {
        const squad = this.byRole('scout')[0] || null;
        if (!squad) return null;
        squad.setMission('scout', null, { x: point.x, y: point.y });
        return squad;
    }

    /** @param {{x: number, y: number}} point */
    assignRegroup(point) {
        for (const s of this.list) {
            if (s.mission === 'attack' || s.mission === 'harass' ||
                s.mission === 'defend' || s.mission === 'siege') {
                s.setMission('regroup', null, { x: point.x, y: point.y });
            }
        }
    }

    /** @param {RTSSquad} squad @param {any} entity @returns {boolean} */
    claim(squad, entity) {
        const now = this.world.time || 0;
        const rec = this.claims.get(entity.id);
        if (rec && rec.squadId !== squad.id && rec.until > now) return false;
        this.claims.set(entity.id, { squadId: squad.id, until: now + RTS_SQUAD_CLAIM_SEC });
        return true;
    }

    /** @param {RTSSquad} squad */
    release(squad) {
        for (const [id, rec] of this.claims) {
            if (rec.squadId === squad.id) this.claims.delete(id);
        }
    }

    /** @returns {string} */
    summary() {
        const list = this.list.filter(s => s.units.length);
        if (!list.length) return '—';
        return list.map(s => s.role + ':' + s.mission + '(' + s.units.length + ')').join(' · ');
    }
}

class RTSSquad extends GOAPAgent {
    /**
     * @param {RTSSquadManager} manager
     * @param {number} id
     * @param {string} role
     */
    constructor(manager, id, role) {
        super({
            interval: RTS_GOAP_SQUAD_SEC,
            maxExpansions: RTS_GOAP_SQUAD_EXPANSIONS,
            maxSteps: RTS_GOAP_SQUAD_STEPS,
            planTtl: RTS_GOAP_PLAN_TTL_SEC,
            actionTimeout: RTS_GOAP_ACTION_TIMEOUT_SEC,
            sticky: RTS_GOAP_GOAL_STICKY,
            retry: RTS_GOAP_SQUAD_SEC
        });
        this.manager = manager;
        this.world = manager.world;
        this.id = id;
        this.role = role;
        this.units = [];
        this.mission = 'hold';
        this.target = null;
        this.anchor = null;
        this.initialStrength = 0;
        this.ecoDamage = false;
        this.buildingDestroyed = false;
        this.safeDistance = false;
        this.flanked = false;
        this.outOfTowerRange = false;
        this.stuckTime = 0;
        this.lastCenter = { x: 0, y: 0 };
        this.movePoint = null;
        this.think = (id % 9) * 0.09;
        this.actionsList = this._makeActions();
    }

    /** @param {string} mission @param {any} target @param {any} anchor */
    setMission(mission, target, anchor) {
        const sameMission = this.mission === mission;
        if (sameMission && !target) target = this.target;
        const sameTarget = this.target === target ||
            (this.target && target && this.target.id === target.id);
        const sameAnchor = this.anchor === anchor ||
            (this.anchor && anchor && this.anchor.x === anchor.x && this.anchor.y === anchor.y);
        if (sameMission && sameTarget && sameAnchor) return;
        this.manager.release(this);
        this.mission = mission;
        this.target = target || null;
        this.anchor = anchor || null;
        if (!sameMission) {
            this.initialStrength = this.units.length;
            this.ecoDamage = false;
            this.buildingDestroyed = false;
            this.safeDistance = false;
            this.flanked = false;
            this.outOfTowerRange = false;
        }
        this.resetPlan();
        this.think = 0;
        this.world.log('Squad ' + this.id + ' (' + this.role + ') mission: ' + mission + '.');
    }

    /** @returns {{x: number, y: number}} */
    center() {
        if (!this.units.length) return { x: 0, y: 0 };
        let x = 0, y = 0;
        for (const u of this.units) { x += u.x; y += u.y; }
        return { x: x / this.units.length, y: y / this.units.length };
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.world.running || !this.units.length) return;
        const c = this.center();
        const moved = Math.hypot(c.x - this.lastCenter.x, c.y - this.lastCenter.y);
        const moving = this.running && [
            'move_to', 'attack_move_to', 'flank', 'withdraw',
            'regroup', 'explore', 'kite', 'avoid_tower'
        ].indexOf(this.running.action.id) >= 0;
        if (moving && moved < RTS_SQUAD_STUCK_DIST * Math.min(dt, 0.2)) {
            this.stuckTime += dt;
        } else {
            this.stuckTime = 0;
            this.lastCenter = c;
        }
        if (this.stuckTime > RTS_SQUAD_STUCK_SEC) {
            this.stuckTime = 0;
            this._forceReplan();
        }
        if (this.target && !this.target.isAlive) this.target = null;
        if (!this.running && !this.target && (this.mission === 'attack' || this.mission === 'siege')) {
            const building = this._nearestVisible(e => e.kind === 'building');
            if (building) {
                this.target = building;
                this.buildingDestroyed = false;
            }
        }
        super.update(dt);
    }

    /** @returns {Record<string, any>} */
    facts() {
        const T = RTS_DATA.AI.SQUAD_THRESHOLDS;
        const c = this.center();
        const health = this.units.reduce((sum, u) => sum + u.health, 0);
        const maxHealth = this.units.reduce((sum, u) => sum + u.maxHealth, 0);
        const healthPct = maxHealth ? health / maxHealth : 0;
        const loss = this.initialStrength ? 1 - this.units.length / this.initialStrength : 0;
        const enemies = this._visibleEnemies();
        const combat = enemies.filter(e => e.kind === 'unit' && e.type !== 'worker');
        const workers = enemies.filter(e => e.kind === 'unit' && e.type === 'worker');
        const towers = enemies.filter(e => e.kind === 'building' && e.type === 'tower');
        const target = this.target && this.target.isAlive ? this.target : null;
        const targetVisible = !!(target && this.world.vision &&
            this.world.vision.isVisible('enemy', target.x, target.y));
        const base = this._basePoint();
        const anchor = this.anchor || base;
        const near = (p, r) => Math.hypot(c.x - p.x, c.y - p.y) < r;
        const enemyNear = combat.some(e => near(e, T.enemyNearRadius)) ||
            towers.some(e => near(e, T.enemyNearRadius));
        const enemyArmyNear = combat.some(e => near(e, T.enemyArmyRadius));
        const enemyWorkersNear = workers.some(e => near(e, T.enemyWorkersRadius));
        const enemyTowerNear = towers.some(e => near(e, T.enemyTowerRadius));
        const atRally = near(base, T.rallyRadius);
        const atTarget = near(anchor, T.targetRadius);
        const squadSafe = atRally || (!enemyNear && healthPct >= RTS_SQUAD_RETREAT_HEALTH);
        const retreat = healthPct < RTS_SQUAD_RETREAT_HEALTH || loss > RTS_SQUAD_RETREAT_LOSS;
        return {
            mission: this.mission,
            strength: this.units.length,
            healthPct,
            outnumbered: combat.filter(e => near(e, T.enemyArmyRadius)).length >
                Math.max(1, this.units.length) * T.outnumberFactor,
            enemyNear,
            enemyArmyNear,
            enemyWorkersNear,
            enemyTowerNear,
            targetVisible: !!targetVisible,
            targetAlive: !!target,
            targetDead: !!(this.target && !this.target.isAlive),
            atRally,
            atTarget,
            underFire: false,
            stuck: this.stuckTime > RTS_SQUAD_STUCK_SEC,
            hasSiege: this.units.some(u => u.role === 'siege'),
            canFlank: !this.units.some(u => u.role === 'siege') && this.units.length >= 2,
            canKite: this.units.some(u => u.role === 'scout'),
            retreatThreshold: retreat,
            squadSafe,
            squadAtRally: atRally,
            pointHeld: atTarget && !enemyNear,
            positionHeld: atTarget && !enemyNear,
            threatGone: !enemyNear,
            enemyEcoDamaged: this.ecoDamage,
            areaScouted: this.mission === 'scout' && atTarget,
            buildingDestroyed: this.buildingDestroyed,
            safeDistance: this.safeDistance,
            flanked: this.flanked,
            outOfTowerRange: this.outOfTowerRange,
            waiting: false
        };
    }

    /** @param {Record<string, any>} state @returns {any[]} */
    goals(state) {
        const P = RTS_DATA.AI.SQUAD_GOAL_PRIORITY;
        const target = this._target();
        const unitTarget = target && target.kind !== 'building'
            ? target
            : this._nearestVisible(e => e.kind === 'unit' && e.type !== 'worker');
        const out = [];
        const add = (id, cond, desired) => {
            if (cond) out.push({ id, priority: P[id] || 0, desired });
        };
        add('survive', state.retreatThreshold, { squadSafe: true });
        add('regroup', this.mission === 'regroup', { squadAtRally: true });
        add('defend_point', this.mission === 'defend', { threatGone: true, pointHeld: true });
        add('raid_economy', this.mission === 'harass', { enemyEcoDamaged: true, squadSafe: true });
        add('siege_building', (this.mission === 'siege' || this.mission === 'attack') &&
            !!target && target.kind === 'building', { buildingDestroyed: true });
        add('eliminate_target', this.mission === 'attack' && !!unitTarget, { targetDead: true });
        add('scout_area', this.mission === 'scout', { areaScouted: true, squadSafe: true });
        add('hold_position', true, { atTarget: true, positionHeld: true });
        return out;
    }

    /** @returns {any[]} */
    actions() { return this.actionsList; }

    /** @param {any} goal @param {any[]} plan */
    onGoalChanged(goal, plan) {
        this.world.log('Squad ' + this.id + ' goal: ' + goal.id +
            ' [' + plan.map(a => a.id).join(' -> ') + '].');
    }

    _visibleEnemies() {
        const out = [];
        const intel = this.world.vision ? this.world.vision.intel.enemy : null;
        if (!intel) return out;
        for (const rec of intel.values()) {
            if (!rec.visible) continue;
            const e = this.world.units.find(u => u.id === rec.id) ||
                this.world.buildings.find(b => b.id === rec.id);
            if (e && e.isAlive) out.push(e);
        }
        return out;
    }

    _nearestVisible(pred) {
        const c = this.center();
        let best = null, bd = Infinity;
        for (const e of this._visibleEnemies()) {
            if (!pred(e)) continue;
            const claim = this.manager.claims.get(e.id);
            if (claim && claim.squadId !== this.id && claim.until > (this.world.time || 0)) continue;
            const d = Math.hypot(e.x - c.x, e.y - c.y);
            if (d < bd) { bd = d; best = e; }
        }
        return best;
    }

    _target() {
        const claim = this.target ? this.manager.claims.get(this.target.id) : null;
        const claimed = !!(claim && claim.squadId !== this.id &&
            claim.until > (this.world.time || 0));
        if (this.target && this.target.isAlive && !claimed &&
            (!this.world.vision || this.world.vision.isVisible('enemy', this.target.x, this.target.y))) {
            return this.target;
        }
        if (this.mission === 'harass') {
            return this._nearestVisible(e => e.kind === 'unit' && e.type === 'worker');
        }
        if (this.mission === 'defend') {
            return this._nearestVisible(e =>
                (e.kind === 'unit' && e.type !== 'worker') ||
                (e.kind === 'building' && e.type === 'tower'));
        }
        if (this.mission === 'attack' || this.mission === 'siege') {
            return this._nearestVisible(e => e.kind === 'building') ||
                this._nearestVisible(e => e.kind === 'unit' && e.type !== 'worker');
        }
        return null;
    }

    _basePoint() {
        return this.world.map.enemyBase;
    }

    _movePoint() {
        if (this.anchor) return this.anchor;
        const t = this._target();
        if (t) return { x: t.x, y: t.y };
        return this._basePoint();
    }

    _makeActions() {
        const T = RTS_DATA.AI.SQUAD_THRESHOLDS;
        const cost = (id) => RTS_DATA.AI.SQUAD_ACTION_COST[id] || 1;
        return [
            {
                id: 'move_to',
                // Attack/siege prefer attack_move_to: plain move_to costs more for them.
                cost: (state, squad) =>
                    (squad.mission === 'attack' || squad.mission === 'siege') ? 4 : cost('move_to'),
                pre: () => !!this._movePoint(),
                effects: { atTarget: true },
                start: () => {
                    const p = this._movePoint();
                    if (!p) return 'failed';
                    this.world.issueMove(this.units, p.x, p.y);
                    this.movePoint = p;
                    return 'running';
                },
                update: () => {
                    const c = this.center();
                    return this.movePoint &&
                        Math.hypot(c.x - this.movePoint.x, c.y - this.movePoint.y) < T.targetRadius
                        ? 'done' : 'running';
                }
            },
            {
                id: 'attack_move_to', cost: cost('attack_move_to'),
                pre: (state) => !!this._movePoint() && !state.enemyTowerNear,
                effects: { atTarget: true },
                start: () => {
                    const p = this._movePoint();
                    if (!p) return 'failed';
                    this.world.issueAttackMove(this.units, p.x, p.y);
                    this.movePoint = p;
                    return 'running';
                },
                update: () => {
                    const c = this.center();
                    return this.movePoint &&
                        Math.hypot(c.x - this.movePoint.x, c.y - this.movePoint.y) < T.targetRadius
                        ? 'done' : 'running';
                }
            },
            {
                id: 'hold', cost: cost('hold'),
                pre: (state) => !!this._movePoint() && state.atTarget,
                effects: { pointHeld: true, positionHeld: true },
                start: () => {
                    this.world.issueHold(this.units);
                    return 'running';
                },
                update: () => this.facts().threatGone ? 'running' : 'done'
            },
            {
                id: 'explore', cost: cost('explore'),
                pre: () => this.mission === 'scout' && !!this.anchor,
                effects: { areaScouted: true },
                start: () => {
                    if (!this.anchor) return 'failed';
                    this.world.issueMove(this.units, this.anchor.x, this.anchor.y);
                    this.movePoint = this.anchor;
                    return 'running';
                },
                update: () => {
                    const c = this.center();
                    return this.movePoint &&
                        Math.hypot(c.x - this.movePoint.x, c.y - this.movePoint.y) < T.targetRadius
                        ? 'done' : 'running';
                }
            },
            {
                id: 'focus', cost: cost('focus'),
                pre: (state) => {
                    const t = this._target();
                    return !!t && t.kind !== 'building' &&
                        (state.hasSiege || !state.outnumbered || state.safeDistance || state.flanked);
                },
                effects: { targetDead: true },
                start: () => {
                    const t = this._target();
                    if (!t || t.kind === 'building') return 'failed';
                    if (!this.manager.claim(this, t)) return 'failed';
                    this.world.issueAttack(this.units, t);
                    this.target = t;
                    return 'running';
                },
                update: () => {
                    const t = this.target;
                    if (!t || !t.isAlive) return 'done';
                    if (this.world.vision && !this.world.vision.isVisible('enemy', t.x, t.y)) {
                        this.target = null;
                        return 'failed';
                    }
                    return 'running';
                }
            },
            {
                id: 'destroy_building', cost: cost('destroy_building'),
                pre: () => {
                    const t = this._target();
                    return !!t && t.kind === 'building';
                },
                effects: { buildingDestroyed: true, targetDead: true },
                start: () => {
                    const t = this._target();
                    if (!t || t.kind !== 'building') return 'failed';
                    if (!this.manager.claim(this, t)) return 'failed';
                    this.world.issueAttack(this.units, t);
                    this.target = t;
                    return 'running';
                },
                update: () => {
                    const t = this.target;
                    if (!t || !t.isAlive) {
                        this.buildingDestroyed = true;
                        return 'done';
                    }
                    return 'running';
                }
            },
            {
                id: 'engage_nearest', cost: cost('engage_nearest'),
                pre: (state) => state.enemyNear,
                // targetDead lets eliminate_target be planned when no explicit unit target exists.
                effects: { threatGone: true, targetDead: true },
                start: () => {
                    const t = this._nearestVisible(e => e.kind === 'unit' && e.type !== 'worker') ||
                        this._target();
                    if (!t) return 'failed';
                    this.world.issueAttackMove(this.units, t.x, t.y);
                    return 'running';
                },
                update: () => this.facts().enemyNear ? 'running' : 'done'
            },
            {
                id: 'withdraw', cost: cost('withdraw'),
                pre: () => !!this._basePoint(),
                effects: { squadSafe: true },
                start: () => {
                    const p = this._basePoint();
                    this.world.issueMove(this.units, p.x, p.y);
                    this.target = null;
                    this.movePoint = p;
                    return 'running';
                },
                update: () => {
                    const c = this.center();
                    return this.movePoint &&
                        Math.hypot(c.x - this.movePoint.x, c.y - this.movePoint.y) < T.rallyRadius
                        ? 'done' : 'running';
                }
            },
            {
                id: 'flank', cost: cost('flank'),
                pre: (state) => {
                    const t = this._target();
                    return !!t && state.canFlank && state.outnumbered;
                },
                effects: { flanked: true },
                start: () => {
                    const t = this._target();
                    if (!t) return 'failed';
                    const c = this.center();
                    const dx = t.x - c.x, dy = t.y - c.y;
                    const d = Math.max(1, Math.hypot(dx, dy));
                    const side = this.id % 2 === 0 ? 1 : -1;
                    const p = {
                        x: t.x - (dx / d) * T.flankBack + (-dy / d) * side * T.flankSide,
                        y: t.y - (dy / d) * T.flankBack + (dx / d) * side * T.flankSide
                    };
                    this.world.issueMove(this.units, p.x, p.y);
                    this.movePoint = p;
                    return 'running';
                },
                update: () => {
                    const c = this.center();
                    if (this.movePoint &&
                        Math.hypot(c.x - this.movePoint.x, c.y - this.movePoint.y) < T.targetRadius) {
                        this.flanked = true;
                        return 'done';
                    }
                    return 'running';
                }
            },
            {
                id: 'kite', cost: cost('kite'),
                pre: (state) => {
                    const t = this._target();
                    return !!t && !state.hasSiege && state.outnumbered && state.canKite;
                },
                effects: { safeDistance: true },
                start: () => {
                    const t = this._target();
                    if (!t) return 'failed';
                    const c = this.center();
                    const dx = c.x - t.x, dy = c.y - t.y;
                    const d = Math.max(1, Math.hypot(dx, dy));
                    const p = { x: c.x + (dx / d) * T.kiteBack, y: c.y + (dy / d) * T.kiteBack };
                    this.world.issueMove(this.units, p.x, p.y);
                    this.movePoint = p;
                    return 'running';
                },
                update: () => {
                    const t = this._target();
                    if (!t) {
                        this.safeDistance = true;
                        return 'done';
                    }
                    const c = this.center();
                    if (Math.hypot(c.x - t.x, c.y - t.y) > T.kiteDone) {
                        this.safeDistance = true;
                        return 'done';
                    }
                    return 'running';
                }
            },
            // Tower actions are enablers: enemyTowerNear gates attack_move_to, but no goal
            // currently requires outOfTowerRange/towerDestroyed, so the planner picks them
            // only through future goals or their state effects.
            {
                id: 'avoid_tower', cost: cost('avoid_tower'),
                pre: (state) => state.enemyTowerNear && !state.hasSiege,
                effects: { outOfTowerRange: true, enemyTowerNear: false },
                start: () => {
                    const tower = this._nearestVisible(e => e.kind === 'building' && e.type === 'tower');
                    if (!tower) return 'done';
                    const c = this.center();
                    const dx = c.x - tower.x, dy = c.y - tower.y;
                    const d = Math.max(1, Math.hypot(dx, dy));
                    const p = {
                        x: tower.x + (dx / d) * (tower.attackRange + T.towerMarginSafe),
                        y: tower.y + (dy / d) * (tower.attackRange + T.towerMarginSafe)
                    };
                    this.world.issueMove(this.units, p.x, p.y);
                    this.movePoint = p;
                    return 'running';
                },
                update: () => {
                    const c = this.center();
                    if (this.movePoint &&
                        Math.hypot(c.x - this.movePoint.x, c.y - this.movePoint.y) < T.targetRadius) {
                        this.outOfTowerRange = true;
                        return 'done';
                    }
                    return 'running';
                }
            },
            {
                id: 'destroy_tower', cost: cost('destroy_tower'),
                pre: (state) => {
                    const tower = this._nearestVisible(e => e.kind === 'building' && e.type === 'tower');
                    return !!tower && (state.hasSiege || this.units.length >= 3);
                },
                effects: { towerDestroyed: true, enemyTowerNear: false },
                start: () => {
                    const tower = this._nearestVisible(e => e.kind === 'building' && e.type === 'tower');
                    if (!tower) return 'failed';
                    if (!this.manager.claim(this, tower)) return 'failed';
                    this.world.issueAttack(this.units, tower);
                    this.target = tower;
                    return 'running';
                },
                update: () => {
                    const t = this.target;
                    return !t || !t.isAlive ? 'done' : 'running';
                }
            },
            {
                id: 'raid_workers', cost: cost('raid_workers'),
                pre: (state) => state.enemyWorkersNear,
                effects: { enemyEcoDamaged: true },
                start: () => {
                    const worker = this._nearestVisible(e => e.kind === 'unit' && e.type === 'worker');
                    if (!worker) return 'failed';
                    this.world.issueAttack(this.units, worker);
                    this.target = worker;
                    return 'running';
                },
                update: () => {
                    const t = this.target;
                    if (!t || !t.isAlive) {
                        this.ecoDamage = true;
                        return 'done';
                    }
                    if (this.world.vision && !this.world.vision.isVisible('enemy', t.x, t.y)) {
                        this.target = null;
                        return 'failed';
                    }
                    return 'running';
                }
            },
            {
                id: 'regroup', cost: cost('regroup'),
                pre: () => !!this._basePoint(),
                effects: { squadAtRally: true, squadSafe: true },
                start: () => {
                    const p = this._basePoint();
                    this.world.issueMove(this.units, p.x, p.y);
                    this.movePoint = p;
                    return 'running';
                },
                update: () => {
                    const c = this.center();
                    return this.movePoint &&
                        Math.hypot(c.x - this.movePoint.x, c.y - this.movePoint.y) < T.rallyRadius
                        ? 'done' : 'running';
                }
            },
            {
                id: 'wait', cost: cost('wait'),
                pre: () => true,
                effects: { waiting: true },
                start: () => 'done'
            }
        ];
    }
}
