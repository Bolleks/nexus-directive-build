// RTSAIDirector.js — the strategic GOAP commander of the RTS demo. It reads its own
// economy directly and the player only through RTSVision intel. The planner picks a goal;
// actions place buildings, queue units and assign missions to squads. No Babylon and no DOM.

class RTSAIDirector extends GOAPAgent {
    /** @param {RTSWorld} world */
    constructor(world) {
        super({
            interval: RTS_GOAP_DIRECTOR_SEC,
            maxExpansions: RTS_GOAP_MAX_EXPANSIONS,
            maxSteps: RTS_GOAP_DIRECTOR_STEPS,
            planTtl: RTS_GOAP_PLAN_TTL_SEC,
            actionTimeout: RTS_GOAP_ACTION_TIMEOUT_SEC,
            retry: RTS_GOAP_RETRY_SEC,
            sticky: RTS_GOAP_GOAL_STICKY
        });
        this.world = world;
        this.waveTimer = RTS_AI_FIRST_WAVE_SEC;
        this.scoutTimer = 0;
        this.harassTimer = 0;
        this.toastTimer = 0;
        this.staging = null;
        this.attacking = false;
        this.defendTimer = 0;
        this.armyAtPush = 0;
        this.attackingSquads = [];
        this.exploredCache = { version: -1, value: 0 };
        this.loggedGoal = '';
        this.actionsList = this._makeActions();
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.world.running) return;
        this.waveTimer = Math.max(0, this.waveTimer - dt);
        this.scoutTimer = Math.max(0, this.scoutTimer - dt);
        this.harassTimer = Math.max(0, this.harassTimer - dt);
        this.toastTimer = Math.max(0, this.toastTimer - dt);
        this.defendTimer = Math.max(0, this.defendTimer - dt);
        super.update(dt);
    }

    /** @returns {Record<string, any>} */
    facts() {
        const w = this.world;
        const ownUnits = w.units.filter(u => u.isAlive && u.team === 'enemy');
        const workers = ownUnits.filter(u => u.role === 'worker');
        const combat = ownUnits.filter(u => u.role !== 'worker');
        const buildings = w.buildings.filter(b => b.isAlive && b.team === 'enemy');
        const hq = buildings.find(b => b.type === 'hq' && b.isBuilt) || null;
        const exists = (type) => buildings.some(b => b.type === type);
        const intel = w.vision ? w.vision.intel.enemy : new Map();
        const visible = [];
        for (const rec of intel.values()) if (rec.visible) visible.push(rec);
        const enemyUnits = visible.filter(r => r.kind === 'unit');
        const enemyBuildings = visible.filter(r => r.kind === 'building');
        const credits = w.teams.enemy ? w.teams.enemy.credits : 0;
        const supplyUsed = w.supplyUsed('enemy');
        const supplyCap = w.supplyCap('enemy');
        const threat = this._threatNearBase(hq);
        const armyTarget = RTS_AI_INFANTRY_TARGET + RTS_AI_SIEGE_TARGET;
        const T = RTS_DATA.AI.THRESHOLDS;
        const armyHealth = combat.length
            ? combat.reduce((sum, u) => sum + u.health / Math.max(1, u.maxHealth), 0) / combat.length
            : 1;
        const squads = /** @type {any} */ (w).squads;
        const attackSquads = this.attackingSquads && this.attackingSquads.length
            ? this.attackingSquads
            : (squads ? squads.list.filter(s => s.units.length &&
                (s.role === 'assault' || s.role === 'siege')) : []);
        const attackUnits = [];
        for (const s of attackSquads) for (const u of s.units) if (u.isAlive) attackUnits.push(u);
        const staging = this.staging;
        const atStaging = staging
            ? attackUnits.filter(u => Math.hypot(u.x - staging.x, u.y - staging.y) < T.stagingRadius).length
            : 0;
        const enemyBase = w.map.enemyBase;
        const playerBase = w.map.playerBase;
        const towerCount = buildings.filter(b => b.type === 'tower').length;
        const baseKnown = this._enemyBaseKnown();
        return {
            workers: workers.length,
            idleWorkers: workers.filter(u => !u.orders.length).length,
            credits,
            creditsLow: credits < T.creditsLow,
            creditsHigh: credits > T.creditsHigh,
            supplyUsed,
            supplyCap,
            supplyPressure: supplyCap > 0 && supplyUsed >= supplyCap * T.supplyPressure,
            supplyOk: supplyCap <= 0 || supplyUsed < supplyCap * T.supplyOk,
            income: workers.some(u => u.orders[0] && u.orders[0].type === 'gather'),
            hq: !!hq,
            barracks: exists('barracks'),
            factory: exists('factory'),
            generator: exists('generator'),
            depot: exists('depot'),
            dropoff: exists('depot'),
            towerCount,
            workersEnough: workers.length >= RTS_AI_WORKER_TARGET,
            army: combat.length,
            infantry: combat.filter(u => u.role === 'infantry').length,
            grenadier: combat.filter(u => u.role === 'grenadier').length,
            scouts: combat.filter(u => u.role === 'scout').length,
            siege: combat.filter(u => u.role === 'siege').length,
            armyHealth,
            attackArmy: attackUnits.length,
            attackHealth: attackUnits.length
                ? attackUnits.reduce((sum, u) => sum + u.health / Math.max(1, u.maxHealth), 0) / attackUnits.length
                : 1,
            armyReady: combat.length >= armyTarget && attackUnits.length >= RTS_AI_WAVE_SIZE,
            armyAtStaging: staging
                ? atStaging >= Math.max(1, Math.ceil(attackUnits.length * T.stagingRatio))
                : false,
            armyAtBase: combat.filter(u =>
                Math.hypot(u.x - enemyBase.x, u.y - enemyBase.y) < T.baseRadius).length >= Math.max(1, combat.length * T.stagingRatio),
            enemyBaseKnown: baseKnown,
            enemyHeavySeen: enemyUnits.some(r => r.type === 'siege'),
            enemyLightSeen: enemyUnits.some(r => r.type === 'infantry' || r.type === 'scout'),
            enemyWorkersSeen: enemyUnits.some(r => r.type === 'worker'),
            enemyTowersSeen: enemyBuildings.some(r => r.type === 'tower'),
            exploredRatio: this._exploredRatio(),
            playerArmyNearBase: visible.some(r => r.kind === 'unit' && r.team === 'player' &&
                r.type !== 'worker' && Math.hypot(r.x - enemyBase.x, r.y - enemyBase.y) < RTS_AI_DEFENSE_RADIUS),
            playerArmyAway: this._playerArmyAway(visible),
            threatNearBase: !!threat,
            baseUnderAttack: !hq || (!!threat &&
                Math.hypot(threat.x - hq.x, threat.y - hq.y) < RTS_AI_DEFENSE_RADIUS * T.hqDanger),
            baseSafe: !!hq && !threat,
            waveReady: this.waveTimer <= 0,
            armySuperior: combat.length >= RTS_AI_WAVE_SIZE &&
                enemyUnits.filter(r => r.type !== 'worker').length <= combat.length,
            attacking: this.attacking,
            harassReady: this.harassTimer <= 0 && this.byRole('harass').length > 0,
            scoutReady: this.scoutTimer <= 0 && this.byRole('scout').length > 0,
            armyRegrouped: !this.attacking && !threat && !!hq,
            towersBuilt: towerCount >= RTS_AI_TOWER_TARGET,
            mapExplored: this._exploredRatio() >= RTS_AI_SCOUT_RATIO,
            enemyEcoDisrupted: this.harassTimer > 0,
            // Match-end signal only: the player's HQ is read directly, not as planning intel.
            enemyHQDown: !w.buildings.some(b => b.isAlive && b.team === 'player' && b.type === 'hq'),
            waiting: false
        };
    }

    /** @param {Record<string, any>} state @returns {any[]} */
    goals(state) {
        const P = RTS_DATA.AI.GOAL_PRIORITY;
        const T = RTS_DATA.AI.THRESHOLDS;
        const list = [];
        const add = (id, cond, desired) => {
            if (!cond) return;
            let priority = P[id] || 0;
            if (id === 'economy' && state.workers < RTS_AI_WORKER_TARGET) priority += T.economyBonus;
            if (id === 'army' && state.army < 3) priority += T.armyBonus;
            if (id === 'defenses' && state.baseUnderAttack) priority += T.defenseBonus;
            if (id === 'attack' && state.armySuperior) priority += T.attackBonus;
            list.push({ id, priority, desired });
        };
        add('survive', state.baseUnderAttack, { baseSafe: true });
        add('regroup', state.attacking &&
            (state.attackArmy < this.armyAtPush * RTS_AI_RETREAT_RATIO ||
             state.attackHealth < RTS_AI_REGROUP_HEALTH), { armyRegrouped: true });
        add('defend', state.threatNearBase, { threatNearBase: false });
        add('attack', state.enemyBaseKnown &&
            (state.attacking ||
             (state.attackArmy >= RTS_AI_WAVE_SIZE && state.waveReady)),
            { enemyHQDown: true });
        add('harass', state.harassReady && (state.enemyWorkersSeen || state.playerArmyAway), { enemyEcoDisrupted: true });
        add('defenses', state.towerCount < RTS_AI_TOWER_TARGET &&
            (state.threatNearBase || state.baseUnderAttack), { towersBuilt: true });
        add('tech', !state.barracks || !state.factory,
            state.barracks ? { factory: true } : { barracks: true });
        add('army', !state.armyReady, { armyReady: true });
        add('economy', !state.workersEnough || !state.income || !state.supplyOk || !state.dropoff ||
            !state.generator, { workersEnough: true, income: true, supplyOk: true, dropoff: true, generator: true });
        add('scout', state.exploredRatio < RTS_AI_SCOUT_RATIO, { mapExplored: true });
        list.push({ id: 'idle', priority: P.idle || 0, desired: { waiting: true } });
        return list;
    }

    /** @returns {any[]} */
    actions() { return this.actionsList; }

    /** @param {any} goal @param {any[]} plan */
    onGoalChanged(goal, plan) {
        if (this.loggedGoal === goal.id) return;
        this.loggedGoal = goal.id;
        this.world.log('AI goal: ' + goal.id + ' [' + plan.map(a => a.id).join(' -> ') + '].');
    }

    byRole(role) {
        const squads = /** @type {any} */ (this.world).squads;
        return squads ? squads.list.filter(s => s.role === role && s.units.length) : [];
    }

    _squadManager() { return /** @type {any} */ (this.world).squads || null; }

    _hq() {
        return this.world.buildings.find(b => b.isAlive && b.team === 'enemy' && b.type === 'hq') || null;
    }

    _visibleEnemies() {
        if (!this.world.vision) return [];
        const out = [];
        for (const rec of this.world.vision.intel.enemy.values()) if (rec.visible) out.push(rec);
        return out;
    }

    _threatNearBase(hq) {
        if (!hq) return null;
        let best = null, bd = RTS_AI_DEFENSE_RADIUS;
        for (const rec of this._visibleEnemies()) {
            if (rec.kind !== 'unit' || rec.type === 'worker') continue;
            const d = Math.hypot(rec.x - hq.x, rec.y - hq.y);
            if (d >= bd) continue;
            const entity = this.world.units.find(u => u.id === rec.id);
            bd = d;
            best = entity && entity.isAlive ? entity : rec;
        }
        return best;
    }

    _exploredRatio() {
        const v = this.world.vision;
        if (!v || !v.explored || !v.explored.enemy) return 0;
        if (this.exploredCache.version === v.version) return this.exploredCache.value;
        const grid = v.explored.enemy;
        let n = 0;
        for (let i = 0; i < grid.length; i++) if (grid[i]) n++;
        const value = grid.length ? n / grid.length : 0;
        this.exploredCache = { version: v.version, value };
        return value;
    }

    _enemyBaseKnown() {
        const v = this.world.vision;
        if (!v) return true;
        const base = this.world.map.playerBase;
        if (v.isExplored('enemy', base.x, base.y)) return true;
        for (const rec of v.intel.enemy.values()) {
            if (rec.kind === 'building' && rec.team === 'player') return true;
        }
        return false;
    }

    _playerArmyAway(visible) {
        if (!this._enemyBaseKnown()) return false;
        const base = this.world.map.playerBase;
        const near = visible.some(r => r.kind === 'unit' && r.team === 'player' &&
            r.type !== 'worker' && Math.hypot(r.x - base.x, r.y - base.y) < RTS_AI_DEFENSE_RADIUS * 2);
        return !near && (this.world.time || 0) > RTS_AI_FIRST_WAVE_SEC;
    }

    _anchor(type) {
        const plan = this.world.map.enemyBuildPlan || [];
        const item = plan.find(p => p.type === type);
        return item ? { x: item.x, y: item.y } : this.world.map.enemyBase;
    }

    _trainBuilding(type) {
        const T = RTS_DATA.AI.THRESHOLDS;
        const list = this.world.buildings.filter(b => b.isAlive && b.team === 'enemy' && b.isBuilt &&
            b.train && b.train.indexOf(type) >= 0 && b.productionQueue.length < T.queueMax);
        list.sort((a, b) => a.productionQueue.length - b.productionQueue.length);
        return list[0] || null;
    }

    _queued(type) {
        let n = 0;
        for (const b of this.world.buildings) {
            if (!b.isAlive || b.team !== 'enemy') continue;
            for (const q of b.productionQueue || []) if (q.type === type) n++;
        }
        return n;
    }

    _ecoPoint() {
        const visible = this._visibleEnemies().filter(r => r.kind === 'unit' && r.type === 'worker');
        if (visible.length) return { x: visible[0].x, y: visible[0].y };
        return { x: this.world.map.playerBase.x, y: this.world.map.playerBase.y };
    }

    _scoutPoint() {
        const base = this.world.map.enemyBase;
        const vision = this.world.vision;
        let best = null, bestD = -Infinity;
        for (const site of this.world.map.resourceSites) {
            if (vision && vision.isExplored('enemy', site.x, site.y)) continue;
            const d = Math.hypot(site.x - base.x, site.y - base.y);
            if (d > bestD) { bestD = d; best = site; }
        }
        return best || this.world.map.playerBase;
    }

    _toast(text) {
        if (this.toastTimer > 0) return;
        this.toastTimer = RTS_AI_TOAST_SEC;
        this.world.toast(text, RTS_DATA.AI.THRESHOLDS.toastSec);
    }

    _buildAction(id, type, cost, effects) {
        return {
            id, cost, effects,
            pre: (state) => {
                const def = RTS_DATA.BUILDINGS[type];
                if (!def) return false;
                if (!this.world.teams.enemy || this.world.teams.enemy.credits < def.cost) return false;
                if (type === 'depot' && state.workers <= 0) return false;
                if (type === 'factory' && !this.world.buildings.some(b =>
                    b.isAlive && b.team === 'enemy' && b.type === 'barracks' && b.isBuilt)) return false;
                if (type !== 'tower' && state[type]) return false;
                const anchor = this._anchor(type);
                return !!this.world.map.findBuildSpot('enemy', type, anchor.x, anchor.y, this.world);
            },
            start: () => {
                const anchor = this._anchor(type);
                const spot = this.world.map.findBuildSpot('enemy', type, anchor.x, anchor.y, this.world);
                if (!spot) return 'failed';
                return this.world.placeBuilding('enemy', type, spot.x, spot.y) ? 'done' : 'failed';
            }
        };
    }

    _trainAction(id, type, cost, effects) {
        return {
            id, cost, effects,
            pre: (state) => {
                const def = RTS_DATA.UNITS[type];
                if (!def) return false;
                if (type === 'worker' && state.workers + this._queued('worker') >= RTS_AI_WORKER_TARGET) return false;
                if (type === 'scout' && state.scouts + this._queued('scout') >= RTS_AI_MAX_SCOUTS) return false;
                const grenadierTarget = typeof RTS_AI_GRENADIER_TARGET !== 'undefined' ? RTS_AI_GRENADIER_TARGET : 1;
                if (type === 'grenadier' && (state.grenadier || 0) + this._queued('grenadier') >= grenadierTarget) return false;
                if (type === 'infantry' && (state.infantry || 0) + this._queued('infantry') >=
                    Math.max(0, RTS_AI_INFANTRY_TARGET - grenadierTarget)) return false;
                if (!this.world.teams.enemy || this.world.teams.enemy.credits < def.cost) return false;
                if (this.world.supplyUsed('enemy') + this.world.supplyQueued('enemy') + def.supply >
                    this.world.supplyCap('enemy')) return false;
                return !!this._trainBuilding(type);
            },
            start: () => {
                const b = this._trainBuilding(type);
                if (!b) return 'failed';
                return this.world.queueUnit(b, type) ? 'done' : 'failed';
            }
        };
    }

    _towerAction() {
        return {
            id: 'build_tower',
            cost: RTS_DATA.AI.ACTION_COST.build_tower,
            pre: (state) => {
                const def = RTS_DATA.BUILDINGS.tower;
                if (!def) return false;
                if (!this.world.teams.enemy || this.world.teams.enemy.credits < def.cost) return false;
                if (state.towerCount >= RTS_AI_TOWER_TARGET) return false;
                const anchor = this._anchor('tower');
                return !!this.world.map.findBuildSpot('enemy', 'tower', anchor.x, anchor.y, this.world);
            },
            effects: (state) => ({
                towerCount: state.towerCount + 1,
                towersBuilt: state.towerCount + 1 >= RTS_AI_TOWER_TARGET
            }),
            start: () => {
                const anchor = this._anchor('tower');
                const spot = this.world.map.findBuildSpot('enemy', 'tower', anchor.x, anchor.y, this.world);
                if (!spot) return 'failed';
                return this.world.placeBuilding('enemy', 'tower', spot.x, spot.y) ? 'done' : 'failed';
            }
        };
    }

    _defendAction() {
        return {
            id: 'defend_base',
            cost: RTS_DATA.AI.ACTION_COST.defend_base,
            pre: (state) => state.threatNearBase && this._squadManager() &&
                this._squadManager().list.some(s => s.units.length),
            effects: { baseSafe: true, threatNearBase: false },
            start: () => {
                const threat = this._threatNearBase(this._hq());
                if (!threat) return 'done';
                if (!this._squadManager().assignDefense(threat)) return 'failed';
                this.world.log('AI defence assigned.');
                return 'running';
            },
            update: () => {
                if (!this.facts().threatNearBase) return 'done';
                if (this.defendTimer <= 0) {
                    this.defendTimer = RTS_DATA.AI.THRESHOLDS.defendReassignSec;
                    const threat = this._threatNearBase(this._hq());
                    if (threat && !this._squadManager().assignDefense(threat)) return 'failed';
                    if (threat) this.world.log('AI defence assigned.');
                }
                return 'running';
            }
        };
    }

    _stageAction() {
        return {
            id: 'stage_army',
            cost: RTS_DATA.AI.ACTION_COST.stage_army,
            timeout: RTS_AI_ATTACK_WAIT_SEC,
            pre: (state) => state.attackArmy >= RTS_AI_WAVE_SIZE && !state.attacking,
            effects: { armyAtStaging: true },
            start: () => {
                const target = this.world.map.playerBase;
                const own = this.world.map.enemyBase;
                const dx = target.x - own.x, dy = target.y - own.y;
                const d = Math.max(1, Math.hypot(dx, dy));
                this.staging = {
                    x: target.x - (dx / d) * RTS_AI_STAGING_DISTANCE,
                    y: target.y - (dy / d) * RTS_AI_STAGING_DISTANCE
                };
                const squads = this._squadManager();
                if (!squads) return 'failed';
                this.attackingSquads = squads.list.filter(s => s.units.length &&
                    (s.role === 'assault' || s.role === 'siege'));
                for (const s of this.attackingSquads) s.setMission('attack', null, this.staging);
                if (!this.attackingSquads.length) return 'failed';
                this.world.log('AI staging started.');
                return 'running';
            },
            update: () => this.facts().armyAtStaging ? 'done' : 'running'
        };
    }

    _launchAction() {
        return {
            id: 'launch_attack',
            cost: RTS_DATA.AI.ACTION_COST.launch_attack,
            pre: (state) => state.armyAtStaging && state.enemyBaseKnown,
            effects: { attacking: true, waveReady: false },
            start: () => {
                this.attacking = true;
                this.armyAtPush = this.attackingSquads.reduce((n, s) =>
                    n + s.units.filter(u => u.isAlive).length, 0) || this.facts().attackArmy;
                this.waveTimer = RTS_AI_WAVE_INTERVAL_SEC;
                const target = this.world.map.playerBase;
                for (const s of this.attackingSquads) {
                    if (s.units.length) s.setMission('attack', null, target);
                }
                this.world.log('AI attack launched.');
                return 'done';
            }
        };
    }

    _pressAction() {
        return {
            id: 'press_attack',
            cost: RTS_DATA.AI.ACTION_COST.press_attack,
            timeout: RTS_AI_WAVE_INTERVAL_SEC,
            pre: (state) => state.attacking && state.enemyBaseKnown,
            effects: { enemyHQDown: true },
            start: () => {
                const target = this.world.map.playerBase;
                for (const s of this.attackingSquads) {
                    if (s.units.length) s.setMission('attack', null, target);
                }
                return 'running';
            },
            update: () => {
                if (!this.facts().attacking) return 'failed';
                if (this.facts().enemyHQDown) return 'done';
                return 'running';
            }
        };
    }

    _harassAction() {
        return {
            id: 'harass',
            cost: RTS_DATA.AI.ACTION_COST.harass,
            pre: (state) => state.harassReady && (state.enemyWorkersSeen || state.playerArmyAway),
            effects: { enemyEcoDisrupted: true },
            start: () => {
                const squads = this._squadManager();
                const squad = squads ? squads.assignHarass(this._ecoPoint()) : null;
                if (!squad) return 'failed';
                this.harassTimer = RTS_AI_HARASS_SEC;
                this.world.log('AI harass started.');
                return 'done';
            }
        };
    }

    _regroupAction() {
        return {
            id: 'regroup',
            cost: RTS_DATA.AI.ACTION_COST.regroup,
            pre: (state) => state.attacking ||
                state.attackArmy < Math.max(1, this.armyAtPush * RTS_AI_RETREAT_RATIO),
            effects: { attacking: false, armyRegrouped: true },
            start: () => {
                this.attacking = false;
                this.staging = null;
                this.attackingSquads = [];
                this.waveTimer = RTS_AI_WAVE_INTERVAL_SEC;
                if (this._squadManager()) this._squadManager().assignRegroup(this.world.map.enemyBase);
                this.world.log('AI regroup started.');
                return 'done';
            }
        };
    }

    _scoutAction() {
        return {
            id: 'scout',
            cost: RTS_DATA.AI.ACTION_COST.scout,
            pre: (state) => state.scoutReady,
            effects: { mapExplored: true },
            start: () => {
                const squads = this._squadManager();
                const squad = squads ? squads.assignScout(this._scoutPoint()) : null;
                if (!squad) return 'failed';
                this.scoutTimer = RTS_AI_SCOUT_SEC;
                this.world.log('AI scout started.');
                return 'done';
            }
        };
    }

    _makeActions() {
        return [
            {
                id: 'assign_workers',
                cost: RTS_DATA.AI.ACTION_COST.assign_workers,
                pre: (state) => state.idleWorkers > 0 && this.world.units.some(u =>
                    u.isAlive && u.team === 'enemy' && u.role === 'worker' && !u.orders.length &&
                    !!this.world.findNearestResource(u.x, u.y)),
                effects: { idleWorkers: false, income: true },
                start: () => {
                    let any = false;
                    for (const u of this.world.units) {
                        if (!u.isAlive || u.team !== 'enemy' || u.role !== 'worker' || u.orders.length) continue;
                        const r = this.world.findNearestResource(u.x, u.y);
                        if (!r) continue;
                        this.world._assignGather(u, r);
                        any = true;
                    }
                    return any ? 'done' : 'failed';
                }
            },
            this._trainAction('train_worker', 'worker', RTS_DATA.AI.ACTION_COST.train_worker, (state) => ({
                workers: state.workers + 1,
                workersEnough: state.workers + 1 >= RTS_AI_WORKER_TARGET
            })),
            this._buildAction('build_generator', 'generator', RTS_DATA.AI.ACTION_COST.build_generator,
                { generator: true, supplyOk: true }),
            this._buildAction('build_depot', 'depot', RTS_DATA.AI.ACTION_COST.build_depot,
                { depot: true, dropoff: true }),
            this._buildAction('build_barracks', 'barracks', RTS_DATA.AI.ACTION_COST.build_barracks,
                { barracks: true }),
            this._buildAction('build_factory', 'factory', RTS_DATA.AI.ACTION_COST.build_factory,
                { factory: true }),
            this._trainAction('train_infantry', 'infantry', RTS_DATA.AI.ACTION_COST.train_infantry, (state) => ({
                army: state.army + 1,
                armyReady: state.army + 1 >= RTS_AI_INFANTRY_TARGET + RTS_AI_SIEGE_TARGET
            })),
            this._trainAction('train_grenadier', 'grenadier', RTS_DATA.AI.ACTION_COST.train_grenadier, (state) => ({
                army: state.army + 1,
                grenadier: state.grenadier + 1,
                armyReady: state.army + 1 >= RTS_AI_INFANTRY_TARGET + RTS_AI_SIEGE_TARGET
            })),
            this._trainAction('train_scout', 'scout',
                (state) => state.enemyLightSeen ? RTS_DATA.AI.THRESHOLDS.counterCost : RTS_DATA.AI.ACTION_COST.train_scout, (state) => ({
                    army: state.army + 1,
                    scouts: state.scouts + 1,
                    scoutReady: true,
                    armyReady: state.army + 1 >= RTS_AI_INFANTRY_TARGET + RTS_AI_SIEGE_TARGET
                })),
            this._trainAction('train_siege', 'siege',
                (state) => state.enemyHeavySeen ? RTS_DATA.AI.THRESHOLDS.counterCost : RTS_DATA.AI.ACTION_COST.train_siege, (state) => ({
                    army: state.army + 1,
                    siege: state.siege + 1,
                    armyReady: state.army + 1 >= RTS_AI_INFANTRY_TARGET + RTS_AI_SIEGE_TARGET
                })),
            this._towerAction(),
            this._defendAction(),
            this._stageAction(),
            this._launchAction(),
            this._pressAction(),
            this._harassAction(),
            this._regroupAction(),
            this._scoutAction(),
            {
                id: 'wait',
                cost: RTS_DATA.AI.ACTION_COST.wait,
                pre: () => true,
                effects: { waiting: true },
                start: () => 'done'
            }
        ];
    }
}
