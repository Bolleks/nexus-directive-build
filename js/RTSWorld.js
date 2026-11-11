// RTSWorld.js — the simulation master: economy, construction, production, orders, movement,
// local separation, combat, towers, victory/defeat and the opponent controller.
// No DOM and no Babylon: RTSView draws the state, RTSInput converts input into orders,
// RTSHUD shows the numbers. main.js calls update(dt) once per frame before the render.

class RTSWorld {
    /** @param {{ location: Location3D, camera: CameraController }} app
     *  @param {{ mapSize?: number }} [options] */
    constructor(app, options = {}) {
        this.app = app;
        this.map = new RTSMap({ size: options.mapSize });
        this.log('Map seed ' + this.map.seed + ': ' + this.map.size + ' × ' + this.map.size +
            ' units, ' + this.map.resourceSites.length + ' crystal fields.');
        const mapWorld = this.map.size * this.map.scale;
        if (app.location && (mapWorld > app.location.width + 0.5 || mapWorld > app.location.height + 0.5)) {
            console.warn('[RTS] map ' + mapWorld + ' px exceeds location ' +
                app.location.width + ' × ' + app.location.height + ' px; raise LOCATION_WIDTH/HEIGHT.');
        }
        this.steering = new RTSSteering(this);
        this.combat = new RTSCombat(this);
        this.units = [];
        this.buildings = [];
        this.resources = [];
        this.wrecks = [];
        this.selected = [];
        this.followSelection = false;   // camera follows the centre of the selected units
        this._followTarget = { x: 0, y: 0 };
        this.nextId = 1;
        this.time = 0;
        this.running = true;
        this.result = '';
        this.debug = false;
        this.teams = {
            player: { credits: RTS_START_CREDITS },
            enemy: { credits: RTS_START_CREDITS }
        };

        this._makeResources();
        this._makeWreck();
        this._makeStartingBases();
        this.map.ensureBasesConnected(this.resources, []);
        if (this.map.relief && app.location && typeof app.location.applyRelief === 'function') {
            app.location.applyRelief(this.map.relief, this.map.scale);
        }
        this.vision = new RTSVision(this);
        const reveal = Math.max(0, typeof RTS_START_EXPLORED_RADIUS !== 'undefined' ? RTS_START_EXPLORED_RADIUS : 70);
        if (reveal > 0) {
            const radius = reveal;
            this.vision.explore('player', this.map.playerBase.x, this.map.playerBase.y, radius);
            this.vision.explore('enemy', this.map.enemyBase.x, this.map.enemyBase.y, radius);
        }
        this.vision.update(RTS_VISION_UPDATE_SEC);

        this.audio = new RTSAudio(this);
        this.audio.musicStart();
        this.view = new RTSView(app.location, this.map, this);
        for (const r of this.resources) this.view.addResource(r);
        for (const w of this.wrecks) this.view.addWreck(w);
        for (const b of this.buildings) this.view.addBuilding(b);
        for (const u of this.units) this.view.addUnit(u);

        this.map.rebuildGrid(this.resources, this.buildings);
        this.hud = new RTSHUD(this);
        this.minimap = new RTSMinimap(this);
        this.input = new RTSInput(this, app);
        this.squads = new RTSSquadManager(this);
        this.ai = new RTSAIDirector(this);
        this._setupCamera();
        this._autoGather('player');
        this._autoGather('enemy');
        const startHQ = this.buildings.find(b => b.isAlive && b.team === 'player' && b.type === 'hq');
        if (startHQ) this.select([startHQ], false);
        else this.hud.refreshCommands();
        this.hud.update(0);
        this.log('Match started: ' + this.units.length + ' units, ' + this.buildings.length + ' buildings, ' +
            this.resources.length + ' crystal fields.');
        this.hud.toast('Штаб развёрнут. Сборщики уже добывают кристаллы.', 5);
    }

    // --- Setup -------------------------------------------------------------------

    _makeResources() {
        for (const site of this.map.resourceSites) {
            this.resources.push(new RTSResource(this.nextId++, site.x, site.y, site.amount));
        }
    }

    _makeWreck() {
        const w = this.map.wreck;
        if (!w) return;
        this.wrecks.push(new RTSWreck(this.nextId++, w.x, w.y, w.heading, w.reward));
    }

    _makeStartingBases() {
        for (const b of this.map.playerStart) this._makeBuilding('player', b.type, b.x, b.y, true);
        for (const b of this.map.enemyStart) this._makeBuilding('enemy', b.type, b.x, b.y, true);

        // Rebuild the walkability grid first: spawnPoint then avoids the HQs and crystals.
        this.map.rebuildGrid(this.resources, this.buildings);
        this._makeStartingUnits('player');
        this._makeStartingUnits('enemy');
    }

    _makeStartingUnits(team) {
        const hq = this.buildings.find(b => b.team === team && b.type === 'hq');
        if (!hq) return;
        const types = [];
        for (let i = 0; i < RTS_START_WORKERS; i++) types.push('worker');
        for (let i = 0; i < RTS_START_INFANTRY; i++) types.push('infantry');
        for (const type of types) {
            const p = this.map.spawnPoint(hq, this);
            this._makeUnit(team, type, p.x, p.y);
        }
    }

    _makeUnit(team, type, x, y) {
        const u = new RTSUnit(this.nextId++, team, type, x, y);
        this.units.push(u);
        return u;
    }

    _makeBuilding(team, type, x, y, built) {
        const b = new RTSBuilding(this.nextId++, team, type, x, y);
        b.isBuilt = !!built;
        b.buildProgress = built ? 1 : 0;
        this.buildings.push(b);
        return b;
    }

    _setupCamera() {
        const c = this.app.camera;
        if (!c) return;
        const p = this.map.playerBase;
        c.zoomTarget = 1.0;
        c.zoom = c.zoomTarget;
        c.lookAt(this.map.px(p.x), this.map.px(p.y - 5));
        c.update(0);
    }

    _autoGather(team) {
        for (const u of this.units) {
            if (u.team !== team || u.role !== 'worker' || !u.isAlive) continue;
            if (u.orders.length) continue;
            const r = this.findNearestResource(u.x, u.y);
            if (r) this._assignGather(u, r);
        }
    }

    // --- Frame --------------------------------------------------------------------

    update(dt) {
        dt = Math.max(0, Math.min(0.1, dt || 0));
        this.view.update(dt, this);
        if (this.minimap) this.minimap.update(dt);
        if (!this.running) {
            this.hud.update(dt);
            return;
        }
        this.time += dt;
        if (this.audio.update) this.audio.update(dt);
        if (this.time >= RTS_MATCH_LIMIT_SEC) {
            this.endGame('draw');
            this.hud.update(dt);
            return;
        }

        this._updateConstruction(dt);
        this._updateDemolition(dt);
        this._updateProduction(dt);
        this.vision.update(dt);
        const selectedBefore = this.selected.length;
        this.selected = this.selected.filter(e => e && e.isAlive && this.vision.canSelect('player', e));
        if (this.selected.length !== selectedBefore) {
            this.view.setSelection(this.selected);
            this.hud.refreshCommands();
        }
        this.ai.update(dt);
        this.squads.update(dt);
        this._updateUnits(dt);
        this.combat.updateIntents(dt);
        this.combat.applyMovement(dt);
        this.steering.update(dt);
        this.combat.resolve(dt);
        this._updateTowers(dt);
        this._cleanup();
        this._updateFollowSelection();
        this._checkVictory();
        this.hud.update(dt);
    }

    endGame(winner) {
        if (!this.running) return;
        this.running = false;
        this.result = winner;
        this.selected = [];
        this.view.setSelection([]);
        this.view.setDebugSelection([], false);
        if (this.input) { this.input.abort(); this.input.enabled = false; }
        this.followSelection = false;
        this.app.camera.follow(null);
        this.hud.refreshCommands();
        this.hud.showEnd(winner);
        this.audio.stopVoice();
        this.audio.musicStop();
        this.audio.end(winner);
        this.log('Match ended: ' + winner + '.');
    }

    log(text) {
        console.info('[RTS] ' + text);
    }

    toast(text, seconds) {
        if (this.hud) this.hud.toast(text, seconds);
    }

    // --- Selection ---------------------------------------------------------------

    select(list, additive) {
        const valid = (list || []).filter(e => e && e.isAlive && e.isSelectable &&
            (!this.vision || this.vision.canSelect('player', e)));
        if (!valid.length && !additive) {
            this.clearSelection();
            return;
        }
        if (additive) {
            for (const e of valid) {
                const i = this.selected.indexOf(e);
                if (i >= 0) this.selected.splice(i, 1);
                else this.selected.push(e);
            }
        } else {
            this.selected = valid.slice();
        }
        if (!this.selected.length) {
            this.clearSelection();
            return;
        }
        this.view.setSelection(this.selected);
        this.view.setDebugSelection(this.debug ? this.selected : [], this.debug);
        this.hud.refreshCommands();
        this.audio.select();
        const lead = this.selected.find(e => e && e.kind === 'unit' && e.team === 'player');
        if (lead) this.audio.unitSelect(lead.type);
    }

    clearSelection() {
        this.selected = [];
        if (this.followSelection) this.setFollowSelection(false);
        this.view.setSelection([]);
        this.view.setDebugSelection([], false);
        this.hud.refreshCommands();
    }

    // Double-click selection: every one of the player's units of the same type that inView
    // accepts (RTSInput passes an on-screen test). Returns the chosen units.
    /** @param {RTSUnit} entity @param {(unit: RTSUnit) => boolean} [inView] */
    selectSameType(entity, inView) {
        if (!entity || entity.kind !== 'unit' || entity.team !== 'player') return [];
        const list = this.units.filter(u => u && u.isAlive && u.isSelectable &&
            u.team === 'player' && u.type === entity.type &&
            (!this.vision || this.vision.canSelect('player', u)) &&
            (!inView || inView(u)));
        if (!list.length) return [];
        this.select(list, false);
        return list;
    }

    // Camera follow: the look-at point tracks the centre of the selected units. Manual
    // panning or flight clears camera.followObj — the mode notices it and turns itself off.
    toggleFollowSelection() {
        this.setFollowSelection(!this.followSelection);
    }

    setFollowSelection(on) {
        const camera = this.app && this.app.camera;
        const goal = on ? this._selectionGoal() : null;
        this.followSelection = !!on && !!goal;
        if (this.followSelection) {
            this._followTarget.x = goal.x;
            this._followTarget.y = goal.y;
            if (camera) {
                camera.lookAt(goal.x, goal.y);
                camera.follow(this._followTarget);
            }
        } else if (camera) {
            camera.follow(null);
        }
        if (this.hud) this.hud.refreshSelection();
    }

    // Average position of the player's selected units in world px, or null.
    _selectionGoal() {
        const units = this.selectedUnits();
        if (!units.length) return null;
        let x = 0, y = 0;
        for (const u of units) { x += u.x; y += u.y; }
        const s = this.map.scale;
        return { x: x / units.length * s, y: y / units.length * s };
    }

    _updateFollowSelection() {
        if (!this.followSelection) return;
        const camera = this.app && this.app.camera;
        if (camera && camera.followObj !== this._followTarget) {
            this.followSelection = false;
            if (this.hud) this.hud.refreshSelection();
            return;
        }
        const goal = this._selectionGoal();
        if (!goal) {
            this.followSelection = false;
            if (camera) camera.follow(null);
            if (this.hud) this.hud.refreshSelection();
            return;
        }
        this._followTarget.x = goal.x;
        this._followTarget.y = goal.y;
    }

    selectedUnits() {
        return this.selected.filter(e => e.kind === 'unit' && e.isAlive && e.team === 'player');
    }

    selectedEnemyUnit() {
        return this.selected.find(e => e.kind === 'unit' && e.isAlive && e.team !== 'player') || null;
    }

    selectedBuilding() {
        return this.selected.find(e => e.kind === 'building' && e.isAlive) || null;
    }

    selectedResource() {
        return this.selected.find(e => e.kind === 'resource' && e.isAlive) || null;
    }

    selectedWreck() {
        return this.selected.find(e => e.kind === 'wreck' && e.isAlive) || null;
    }

    // --- Orders ------------------------------------------------------------------

    _cancelSearch(unit) {
        if (!unit || !unit.searchWreck) return;
        const wreck = unit.searchWreck;
        if (wreck.searchingUnit === unit) {
            wreck.searchingUnit = null;
            wreck.searchProgress = 0;
        }
        unit.searchWreck = null;
    }

    _setOrder(unit, order, queue) {
        if (!unit || !unit.isAlive) return;
        this._cancelSearch(unit);
        if (queue && unit.orders.length < 8) {
            unit.orders.push(order);
            return;
        }
        unit.orders = [order];
        unit.path = [];
        unit.pathIndex = 0;
        unit.repathTimer = 0;
        unit.gatherState = '';
        unit.target = order.target || null;
        unit.attackTimer = 0;
        unit.moveGoal = null;
        unit.bestGoalDist = Infinity;
    }

    _popOrder(unit) {
        this._cancelSearch(unit);
        unit.orders.shift();
        unit.path = [];
        unit.pathIndex = 0;
        unit.repathTimer = 0;
        unit.target = null;
        unit.gatherState = '';
        unit.moveGoal = null;
        unit.bestGoalDist = Infinity;
    }

    // A context order at a map point: enemy -> attack, crystal -> gather, ground -> move;
    // with no units a selected production building gets a rally point. Shared by RTSInput
    // (screen picking) and RTSMinimap (map picking).
    contextOrder(units, entity, x, y, shift) {
        const list = (units || []).filter(u => u && u.kind === 'unit' && u.isAlive);
        if (list.length) {
            if (entity && entity.kind !== 'resource' && entity.team && entity.team !== 'player') {
                this.issueAttack(list, entity, shift);
                return true;
            }
            if (entity && entity.kind === 'wreck') {
                this.issueSearch(list, entity, shift);
                return true;
            }
            if (entity && entity.kind === 'resource') {
                this.issueGather(list, entity, shift);
                return true;
            }
            this.issueMove(list, x, y, shift);
            return true;
        }
        const building = this.selectedBuilding();
        if (building && building.team === 'player' && building.train.length && building.isBuilt) {
            this.setRallyPoint(building, x, y);
            return true;
        }
        return false;
    }

    issueMove(units, x, y, queue) {
        const list = (units || []).filter(u => u && u.kind === 'unit' && u.isAlive);
        if (!list.length) return;
        const points = this.map.formation(list.length, x, y, this, RTS_MOVE_SPACING);
        const order = list.slice().sort((a, b) =>
            Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
        order.forEach((u, i) => {
            const p = points[i] || { x, y };
            this._setOrder(u, { type: 'move', x: p.x, y: p.y }, queue);
            u.commandLabel = 'Движение';
        });
        this._playerOrderFeedback(list[0], 'move', x, y);
        this.hud.refreshCommands();
    }

    // A ground marker, a confirmation tick and a unit reply belong to the player's own orders
    // only: the enemy commander moves in the fog, and nothing may announce those orders.
    /** @param {any} unit @param {'move' | 'attack' | 'gather'} kind @param {number} x @param {number} y */
    _playerOrderFeedback(unit, kind, x, y) {
        if (!unit || unit.team !== 'player') return;
        this.view.marker(x, y, kind);
        this.audio.order(kind, x, y);
        this.audio.unitOrder(unit.type, x, y);
    }

    issueAttack(units, target, queue) {
        if (!target || !target.isAlive) return;
        const list = (units || []).filter(u => u && u.kind === 'unit' && u.isAlive && u.team !== target.team);
        if (!list.length) return;
        for (const u of list) {
            this._setOrder(u, { type: 'attack', target: target }, queue);
            u.commandLabel = 'Атака';
        }
        this._playerOrderFeedback(list[0], 'attack', target.x, target.y);
        this.hud.refreshCommands();
    }

    issueAttackMove(units, x, y, queue) {
        const list = (units || []).filter(u => u && u.kind === 'unit' && u.isAlive);
        if (!list.length) return;
        const points = this.map.formation(list.length, x, y, this, RTS_MOVE_SPACING);
        const order = list.slice().sort((a, b) =>
            Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
        order.forEach((u, i) => {
            const p = points[i] || { x, y };
            this._setOrder(u, { type: 'attackMove', x: p.x, y: p.y }, queue);
            u.commandLabel = 'Атака по площади';
        });
        this._playerOrderFeedback(list[0], 'attack', x, y);
        this.hud.refreshCommands();
    }

    issueGather(units, node, queue) {
        if (!node || node.kind !== 'resource' || !node.isAlive || node.amount <= 0) return false;
        const workers = (units || []).filter(u => u && u.kind === 'unit' && u.isAlive && u.role === 'worker');
        if (!workers.length) {
            this.issueMove(units, node.x, node.y, queue);
            return false;
        }
        for (const w of workers) this._assignGather(w, node);
        this._playerOrderFeedback(workers[0], 'gather', node.x, node.y);
        if (workers[0].team === 'player') this.hud.toast('Сборщики направлены к месторождению.', 2.3);
        this.hud.refreshCommands();
        return true;
    }

    // Any unit can search the wreck; only the nearest selected unit runs the search, the
    // rest walk to the site. A second search is refused once the wreck is empty.
    issueSearch(units, wreck, queue) {
        if (!wreck || wreck.kind !== 'wreck' || !wreck.isAlive || wreck.searched) return false;
        const list = (units || []).filter(u => u && u.kind === 'unit' && u.isAlive);
        if (!list.length) return false;
        const sorted = list.slice().sort((a, b) =>
            Math.hypot(a.x - wreck.x, a.y - wreck.y) - Math.hypot(b.x - wreck.x, b.y - wreck.y));
        const lead = sorted[0];
        for (const u of list) {
            if (u === lead) {
                this._setOrder(u, { type: 'search', wreck }, queue);
                u.commandLabel = 'Обыск';
            } else {
                this._setOrder(u, { type: 'move', x: wreck.x, y: wreck.y }, queue);
                u.commandLabel = 'Движение';
            }
        }
        this._playerOrderFeedback(lead, 'move', wreck.x, wreck.y);
        this.hud.refreshCommands();
        return true;
    }

    _resourceWorkerCount(node, team, except) {
        let n = 0;
        for (const u of this.units) {
            if (!u.isAlive || u.team !== team || u.role !== 'worker' || u === except) continue;
            const order = u.orders && u.orders[0];
            if (order && order.type === 'gather' && order.resource === node) n++;
        }
        return n;
    }

    // Assumption: a field keeps at most RTS_RESOURCE_WORKERS_PER_FIELD assigned workers;
    // a request for a full field is redirected to the nearest field with a free slot, and
    // only when every field is full does it fall back to the nearest one anyway.
    _findFreeResource(x, y, team, except) {
        const cap = typeof RTS_RESOURCE_WORKERS_PER_FIELD !== 'undefined' ? RTS_RESOURCE_WORKERS_PER_FIELD : 2;
        let best = null, bestD = Infinity;
        let fallback = null, fallbackD = Infinity;
        for (const r of this.resources) {
            if (!r.isAlive || r.amount <= 0) continue;
            const d = Math.hypot(r.x - x, r.y - y);
            if (d < fallbackD) { fallbackD = d; fallback = r; }
            if (this._resourceWorkerCount(r, team, except) >= cap) continue;
            if (d < bestD) { bestD = d; best = r; }
        }
        return best || fallback;
    }

    _assignGather(worker, node) {
        const target = this._findFreeResource(node.x, node.y, worker.team, worker) || node;
        worker.orders = [{ type: 'gather', resource: target }];
        worker.resource = target;
        worker.target = null;
        worker.path = [];
        worker.pathIndex = 0;
        worker.repathTimer = 0;
        worker.gatherState = worker.carrying > 0 ? 'toDropoff' : 'toResource';
        worker.commandLabel = 'Добыча';
        worker.moveGoal = null;
    }

    stopSelected() {
        const units = this.selectedUnits();
        for (const u of units) {
            this._cancelSearch(u);
            u.orders = [];
            u.path = [];
            u.pathIndex = 0;
            u.target = null;
            u.gatherState = '';
            u.carrying = 0;
            u.resource = null;
            u.commandLabel = 'Стоп';
            u.moving = false;
            u.moveGoal = null;
            u.vx = 0;
            u.vy = 0;
        }
        this.hud.refreshCommands();
    }

    issueHold(units) {
        const list = (units || []).filter(u => u && u.kind === 'unit' && u.isAlive);
        for (const u of list) {
            this._setOrder(u, { type: 'hold' }, false);
            u.commandLabel = 'Удержание';
        }
    }

    holdSelected() {
        this.issueHold(this.selectedUnits());
        this.hud.refreshCommands();
    }

    setRallyPoint(building, x, y) {
        if (!building || building.kind !== 'building' || building.team !== 'player' ||
            !building.train.length || !building.isBuilt) return;
        building.rallyPoint = { x, y };
        this.view.marker(x, y, 'move');
        this.audio.order('move', x, y);
        this.hud.toast('Точка сбора установлена.', 2);
        this.hud.refreshCommands();
    }

    // --- Economy -----------------------------------------------------------------

    addCredits(team, amount) {
        const t = this.teams[team];
        if (!t || amount <= 0) return;
        t.credits = Math.min(RTS_CREDIT_CAP, t.credits + amount);
    }

    findNearestResource(x, y) {
        let best = null, bd = Infinity;
        for (const r of this.resources) {
            if (!r.isAlive || r.amount <= 0) continue;
            const d = Math.hypot(r.x - x, r.y - y);
            if (d < bd) { bd = d; best = r; }
        }
        return best;
    }

    findDropoff(team, x, y) {
        let best = null, bd = Infinity;
        for (const b of this.buildings) {
            if (!b.isAlive || b.team !== team || !b.isBuilt || !b.dropoff) continue;
            const d = Math.hypot(b.x - x, b.y - y);
            if (d < bd) { bd = d; best = b; }
        }
        return best;
    }

    supplyUsed(team) {
        let n = 0;
        for (const u of this.units) if (u.isAlive && u.team === team) n += u.supply;
        return n;
    }

    supplyQueued(team) {
        let n = 0;
        for (const b of this.buildings) {
            if (!b.isAlive || b.team !== team) continue;
            for (const q of b.productionQueue) {
                const d = RTS_DATA.UNITS[q.type];
                if (d) n += d.supply;
            }
        }
        return n;
    }

    supplyCap(team) {
        let n = 0;
        for (const b of this.buildings) {
            if (b.isAlive && b.team === team && b.isBuilt) n += b.supply;
        }
        const cap = typeof RTS_SUPPLY_CAP !== 'undefined' ? RTS_SUPPLY_CAP : 100;
        return Math.min(cap, n);
    }

    incomeWorkers(team) {
        let n = 0;
        for (const u of this.units) {
            if (!u.isAlive || u.team !== team || u.role !== 'worker') continue;
            if (u.orders && u.orders[0] && u.orders[0].type === 'gather') n++;
        }
        return n;
    }

    // --- Construction and production ---------------------------------------------

    canPlaceBuilding(team, type, x, y) {
        return this.map.canBuild(team, type, x, y, this);
    }

    // A dependency is satisfied by at least one FINISHED building of the required type.
    missingRequirements(team, type) {
        const def = RTS_DATA.BUILDINGS[type];
        if (!def) return [];
        const out = [];
        for (const req of def.requires || []) {
            const ok = this.buildings.some(b =>
                b.isAlive && b.isBuilt && b.team === team && b.type === req);
            if (!ok) out.push(req);
        }
        return out;
    }

    requirementsMet(team, type) {
        return this.missingRequirements(team, type).length === 0;
    }

    placeBuilding(team, type, x, y) {
        const def = RTS_DATA.BUILDINGS[type];
        if (!def) return null;
        const missing = this.missingRequirements(team, type);
        if (missing.length) {
            if (team === 'player') {
                this.audio.error();
                this.toast('Нужно: ' + missing.map(t => RTS_DATA.BUILDINGS[t].name).join(' и ') + '.', 3);
            }
            return null;
        }
        if (!this.canPlaceBuilding(team, type, x, y)) return null;
        const credits = this.teams[team].credits;
        if (credits < def.cost) {
            if (team === 'player') {
                this.audio.error();
                this.toast('Недостаточно кристаллов: нужно ' + def.cost + '.', 3);
            }
            return null;
        }
        this.teams[team].credits -= def.cost;
        const b = this._makeBuilding(team, type, x, y, false);
        this.view.addBuilding(b);
        this.map.rebuildGrid(this.resources, this.buildings);
        this.audio.buildStart(b.x, b.y);
        if (team === 'player') {
            this.audio.announce('buildStart');
            this.toast('Строительство начато: ' + def.name + '.', 2.6);
            this.hud.refreshCommands();
        }
        this.log(type + ' construction started for ' + team + ' at ' + x.toFixed(1) + ',' + y.toFixed(1) + '.');
        return b;
    }

    queueUnit(building, type) {
        if (!building || !building.isAlive || !building.isBuilt || building.demolishing) return false;
        const def = RTS_DATA.UNITS[type];
        if (!def || building.train.indexOf(type) < 0) return false;
        const team = building.team;
        if (this.teams[team].credits < def.cost) {
            if (team === 'player') {
                this.audio.error();
                this.toast('Недостаточно кристаллов: нужно ' + def.cost + '.', 3);
            }
            return false;
        }
        const used = this.supplyUsed(team) + this.supplyQueued(team);
        if (used + def.supply > this.supplyCap(team)) {
            if (team === 'player') {
                this.audio.error();
                this.toast('Лимит снабжения. Постройте генератор.', 3);
            }
            return false;
        }
        this.teams[team].credits -= def.cost;
        building.productionQueue.push({ type, remaining: def.time, total: def.time });
        if (team === 'player') {
            this.toast('В очередь: ' + def.name + '.', 2);
            this.hud.refreshCommands();
        }
        this.log(def.name + ' queued at ' + building.name + ' (' + team + ').');
        return true;
    }

    // Cancel a queued unit (default: the last one) and refund its full cost.
    cancelQueuedUnit(building, index) {
        if (!building || !building.isAlive || !building.productionQueue || !building.productionQueue.length) return false;
        const i = index == null ? building.productionQueue.length - 1 : index;
        const q = building.productionQueue[i];
        if (!q) return false;
        const def = RTS_DATA.UNITS[q.type];
        building.productionQueue.splice(i, 1);
        if (def) {
            // Full refund, even past the normal stockpile cap: the rule says "полностью".
            const team = this.teams[building.team];
            if (team) team.credits += def.cost;
            if (building.team === 'player') {
                this.toast('Производство отменено: ' + def.name + '.', 2.2);
                this.hud.refreshCommands();
            }
            this.log(def.name + ' cancelled at ' + building.name + ' (' + building.team + ').');
        }
        return true;
    }

    // The built building of the team that trains the type and has the shortest queue.
    trainBuildingFor(team, type) {
        let best = null, bestLoad = Infinity;
        for (const b of this.buildings) {
            if (!b.isAlive || !b.isBuilt || b.demolishing || b.team !== team || b.train.indexOf(type) < 0) continue;
            let load = 0;
            for (const q of b.productionQueue) load += q.remaining;
            if (load < bestLoad - 1e-6 ||
                (Math.abs(load - bestLoad) <= 1e-6 && (!best || b.id < best.id))) {
                best = b;
                bestLoad = load;
            }
        }
        return best;
    }

    trainingBuildingName(type) {
        const short = { hq: 'Штаб', barracks: 'Казармы', factory: 'Завод' };
        for (const key of Object.keys(RTS_DATA.BUILDINGS)) {
            const train = RTS_DATA.BUILDINGS[key].train;
            if (train && train.indexOf(type) >= 0) return short[key] || RTS_DATA.BUILDINGS[key].name;
        }
        return '';
    }

    // Whether a unit can be queued right now and which building will take it.
    unitOrderStatus(type, team) {
        team = team || 'player';
        const def = RTS_DATA.UNITS[type];
        if (!def) return { ok: false, reason: 'неизвестный юнит', building: null };
        const building = this.trainBuildingFor(team, type);
        if (!building) {
            const source = this.trainingBuildingName(type);
            return { ok: false, reason: source ? 'нужно: ' + source : 'нет производства', building: null };
        }
        if (this.teams[team].credits < def.cost) {
            return { ok: false, reason: 'мало кристаллов', building };
        }
        const used = this.supplyUsed(team) + this.supplyQueued(team);
        if (used + def.supply > this.supplyCap(team)) {
            return { ok: false, reason: 'лимит снабжения', building };
        }
        return { ok: true, reason: '', building };
    }

    // Queue a unit at the best built training building, without selecting it.
    queueUnitAny(type, team) {
        team = team || 'player';
        const status = this.unitOrderStatus(type, team);
        if (!status.ok) {
            if (team === 'player') {
                this.audio.error();
                this.toast(status.reason + '.', 3);
            }
            return false;
        }
        return this.queueUnit(status.building, type);
    }

    // Whether a building can be started right now. Free space is checked on placement.
    buildingOrderStatus(type, team) {
        team = team || 'player';
        const def = RTS_DATA.BUILDINGS[type];
        if (!def || type === 'hq') return { ok: false, reason: 'нельзя строить' };
        if (this.teams[team].credits < def.cost) return { ok: false, reason: 'мало кристаллов' };
        const missing = this.missingRequirements(team, type);
        if (missing.length) {
            return { ok: false, reason: 'нужно: ' + missing.map(t => RTS_DATA.BUILDINGS[t].name).join(' и ') };
        }
        return { ok: true, reason: '' };
    }

    _updateConstruction(dt) {
        for (const b of this.buildings) {
            if (!b.isAlive || b.isBuilt) continue;
            const total = Math.max(0.01, b.buildTime);
            b.buildProgress = Math.min(1, b.buildProgress + dt / total);
            if (b.buildProgress >= 1) {
                b.isBuilt = true;
                this.map.rebuildGrid(this.resources, this.buildings);
                this.view.completeBuilding(b);
                if (b.team === 'player') {
                    this.audio.buildDone(b.x, b.y);
                    this.audio.announce('buildDone');
                    this.toast(b.name + ' построен.', 3);
                }
                this.log(b.name + ' construction complete (' + b.team + ').');
            }
        }
    }

    // A player's finished building is dismantled over RTS_DEMOLISH_TIME_SEC; the refund comes
    // only when it is gone. The HQ is permanent, and production has to be cancelled first.
    /** @param {RTSBuilding} b */
    startDemolition(b) {
        if (!b || b.kind !== 'building' || !b.isAlive) return false;
        if (b.team !== 'player') return false;
        if (b.type === 'hq') {
            this.audio.error();
            this.toast('Штаб разобрать нельзя.', 3);
            return false;
        }
        if (!b.isBuilt) {
            this.audio.error();
            this.toast('Здание ещё строится.', 2.5);
            return false;
        }
        if (b.productionQueue.length) {
            this.audio.error();
            this.toast('Сначала отмените производство.', 3);
            return false;
        }
        if (b.demolishing) return false;
        b.demolishing = true;
        b.demolishProgress = 0;
        b.demolishTotal = typeof RTS_DEMOLISH_TIME_SEC !== 'undefined' ? RTS_DEMOLISH_TIME_SEC : 8;
        this.audio.announce('demolishStart');
        this.toast('Демонтаж начат: ' + b.name + '.', 2.6);
        this.hud.refreshCommands();
        this.log(b.name + ' demolition started (' + b.team + ').');
        return true;
    }

    /** @param {RTSBuilding} b */
    cancelDemolition(b) {
        if (!b || !b.demolishing) return false;
        b.demolishing = false;
        b.demolishProgress = 0;
        b.demolishTotal = 0;
        this.toast('Демонтаж отменён: ' + b.name + '.', 2.4);
        this.hud.refreshCommands();
        this.log(b.name + ' demolition cancelled (' + b.team + ').');
        return true;
    }

    /** @param {number} dt */
    _updateDemolition(dt) {
        for (const b of this.buildings) {
            if (!b.isAlive || !b.demolishing) continue;
            const total = Math.max(0.01, b.demolishTotal);
            b.demolishProgress = Math.min(1, b.demolishProgress + dt / total);
            if (b.demolishProgress >= 1) this._completeDemolition(b);
        }
    }

    /** @param {RTSBuilding} b */
    _completeDemolition(b) {
        if (!b || !b.isAlive) return;
        const def = RTS_DATA.BUILDINGS[b.type];
        const refund = Math.floor((def ? def.cost : 0) * (typeof RTS_DEMOLISH_REFUND !== 'undefined' ? RTS_DEMOLISH_REFUND : 0.5));
        const team = this.teams[b.team];
        if (team) {
            const cap = typeof RTS_CREDIT_CAP !== 'undefined' ? RTS_CREDIT_CAP : Infinity;
            team.credits = Math.min(cap, team.credits + refund);
        }
        b.isAlive = false;
        b.demolishing = false;
        b.productionQueue = [];
        const idx = this.selected.indexOf(b);
        if (idx >= 0) this.selected.splice(idx, 1);
        this.view.removeBuilding(b);
        this.map.rebuildGrid(this.resources, this.buildings);
        if (this.selected.length) this.view.setSelection(this.selected);
        this.hud.refreshCommands();
        this.toast(b.name + ' разобран. Возврат: ' + refund + '.', 3);
        this.audio.announce('demolishDone');
        this.log(b.name + ' demolished (' + b.team + '), refund ' + refund + '.');
    }

    _updateProduction(dt) {
        for (const b of this.buildings) {
            if (!b.isAlive || !b.isBuilt || !b.productionQueue.length) continue;
            const q = b.productionQueue[0];
            q.remaining -= dt;
            if (q.remaining > 0) continue;
            const def = RTS_DATA.UNITS[q.type];
            if (!def) { b.productionQueue.shift(); continue; }
            const spot = this.map.spawnPoint(b, this);
            const u = this._makeUnit(b.team, q.type, spot.x, spot.y);
            this.view.addUnit(u);
            b.productionQueue.shift();
            if (b.rallyPoint) {
                const p = this.map.formation(1, b.rallyPoint.x, b.rallyPoint.y, this)[0] || b.rallyPoint;
                this._setOrder(u, { type: 'move', x: p.x, y: p.y }, false);
                u.commandLabel = 'Движение';
            }
            if (b.team === 'player') {
                this.audio.ready(b.x, b.y);
                this.audio.announce('unitReady');
                this.toast(def.name + ' готов.', 3);
                this.hud.refreshCommands();
            }
            this.log(def.name + ' produced by ' + b.name + ' (' + b.team + ').');
        }
    }

    // --- Units -------------------------------------------------------------------

    _updateUnits(dt) {
        for (const u of this.units) {
            if (!u.isAlive) continue;
            u.moving = false;
            if (u.attackTimer > 0) u.attackTimer -= dt;
            u.repathTimer -= dt;
            const order = u.orders[0] || null;
            if (!order) {
                u.commandLabel = 'Ожидание';
                u.moveGoal = null;
                if (u.role !== 'worker') {
                    const t = this.findNearestEnemy(u, u.sightRange, true);
                    if (t) {
                        this._setOrder(u, { type: 'attack', target: t, auto: true }, false);
                        u.guardX = u.x;
                        u.guardY = u.y;
                    }
                }
                continue;
            }
            if (order.type === 'move') this._updateMove(u, order, dt);
            else if (order.type === 'attack') this._updateAttack(u, order, dt);
            else if (order.type === 'attackMove') this._updateAttackMove(u, order, dt);
            else if (order.type === 'hold') this._updateHold(u, dt);
            else if (order.type === 'gather') this._updateGather(u, dt);
            else if (order.type === 'search') this._updateSearch(u, order, dt);
            else this._popOrder(u);
        }
    }

    _updateMove(u, order, dt) {
        u.commandLabel = 'Движение';
        const d = Math.hypot(order.x - u.x, order.y - u.y);
        if (d <= RTS_MOVE_ARRIVE_RADIUS) {
            u.moving = false;
            this._popOrder(u);
            return;
        }
        this._moveToPoint(u, order.x, order.y, dt, RTS_MOVE_ARRIVE_RADIUS);
    }

    _updateAttack(u, order, dt) {
        const t = order.target;
        if (!t || !t.isAlive) {
            this._popOrder(u);
            return;
        }
        const center = Math.hypot(t.x - u.x, t.y - u.y);
        const edge = center - (t.radius || 0);
        if (order.auto && edge > u.sightRange * RTS_COMBAT_LEASH) {
            this._popOrder(u);
            return;
        }
        if (edge <= u.attackRange) {
            u.path = [];
            u.moving = false;
            u.moveGoal = null;
            u.target = t;
            u.commandLabel = 'Атака: ' + t.name;
        } else {
            u.commandLabel = 'Атака: ' + t.name;
            this._chase(u, t, dt, Math.max(0.5, u.attackRange - 0.4));
        }
    }

    _updateAttackMove(u, order, dt) {
        if (!u.target || !u.target.isAlive) u.target = this.findNearestEnemy(u, u.sightRange, true);
        if (u.target && u.target.isAlive) {
            const edge = Math.hypot(u.target.x - u.x, u.target.y - u.y) - (u.target.radius || 0);
            if (edge <= u.attackRange) {
                u.path = [];
                u.moving = false;
                u.moveGoal = null;
                u.commandLabel = 'Атака: ' + u.target.name;
                return;
            }
            if (edge <= u.sightRange * 1.3) {
                u.commandLabel = 'Атака: ' + u.target.name;
                this._chase(u, u.target, dt, Math.max(0.5, u.attackRange - 0.4));
                return;
            }
            u.target = null;
        }
        u.commandLabel = 'Атака по площади';
        const d = Math.hypot(order.x - u.x, order.y - u.y);
        if (d <= RTS_MOVE_ARRIVE_RADIUS) {
            this._popOrder(u);
            return;
        }
        this._moveToPoint(u, order.x, order.y, dt, RTS_MOVE_ARRIVE_RADIUS);
    }

    _updateHold(u, dt) {
        u.path = [];
        u.moving = false;
        u.moveGoal = null;
        u.commandLabel = 'Удержание';
        const t = this.findNearestEnemy(u, u.attackRange + u.radius, true);
        if (t) u.target = t;
    }

    _updateGather(u, dt) {
        const workerCap = typeof RTS_RESOURCE_WORKERS_PER_FIELD !== 'undefined' ? RTS_RESOURCE_WORKERS_PER_FIELD : 2;
        let node = u.resource;
        if (!node || !node.isAlive || node.amount <= 0) {
            node = this._findFreeResource(u.x, u.y, u.team, u);
            if (!node) {
                u.orders = [];
                u.gatherState = '';
                u.commandLabel = 'Нет ресурса';
                u.moving = false;
                u.moveGoal = null;
                return;
            }
            u.resource = node;
            if (u.orders[0] && u.orders[0].type === 'gather') u.orders[0].resource = node;
            u.gatherState = u.carrying > 0 ? 'toDropoff' : 'toResource';
            u.path = [];
        }
        if ((u.gatherState === 'toResource' || u.gatherState === 'gathering') &&
            this._resourceWorkerCount(node, u.team, u) >= workerCap) {
            const free = this._findFreeResource(u.x, u.y, u.team, u);
            if (free && free !== node) {
                node = free;
                u.resource = node;
                if (u.orders[0] && u.orders[0].type === 'gather') u.orders[0].resource = node;
                u.gatherState = u.carrying > 0 ? 'toDropoff' : 'toResource';
                u.path = [];
                u.pathIndex = 0;
                u.repathTimer = 0;
                u.moveGoal = null;
            }
        }
        u.commandLabel = u.gatherState === 'unloading' ? 'Разгрузка'
            : u.carrying > 0 ? 'Доставка' : 'Добыча';

        if (u.carrying >= RTS_GATHER_CAPACITY && u.gatherState !== 'unloading') u.gatherState = 'toDropoff';

        if (u.gatherState === 'toResource') {
            const d = Math.hypot(node.x - u.x, node.y - u.y) - node.radius;
            if (d <= u.radius + 0.9) {
                u.gatherState = 'gathering';
                u.gatherTimer = typeof RTS_GATHER_TIME !== 'undefined' ? RTS_GATHER_TIME : 4;
                u.path = [];
                u.moving = false;
                u.moveGoal = null;
            } else {
                this._moveToPoint(u, node.x, node.y, dt, node.radius + u.radius + 0.7);
            }
            return;
        }

        if (u.gatherState === 'gathering') {
            u.moving = false;
            u.path = [];
            u.moveGoal = null;
            u.gatherTimer -= dt;
            if (u.gatherTimer <= 0) {
                const take = Math.min(RTS_GATHER_CAPACITY - u.carrying, node.amount);
                u.carrying += take;
                node.amount -= take;
                this.view.updateResource(node);
                if (node.amount <= 0) this._depleteResource(node);
                u.gatherState = u.carrying >= RTS_GATHER_CAPACITY ? 'toDropoff' : 'toResource';
                u.path = [];
                u.repathTimer = 0;
            }
            return;
        }

        if (u.gatherState === 'toDropoff') {
            const dnode = this.findDropoff(u.team, u.x, u.y);
            if (!dnode) {
                u.orders = [];
                u.gatherState = '';
                u.commandLabel = 'Нет приёмника';
                u.moving = false;
                u.moveGoal = null;
                return;
            }
            u.dropoff = dnode;
            const d = Math.hypot(dnode.x - u.x, dnode.y - u.y) - dnode.radius;
            if (d <= u.radius + 1.2) {
                u.gatherState = 'unloading';
                u.gatherTimer = typeof RTS_GATHER_UNLOAD_TIME !== 'undefined' ? RTS_GATHER_UNLOAD_TIME : 1;
                u.path = [];
                u.repathTimer = 0;
                u.moveGoal = null;
                u.commandLabel = 'Разгрузка';
            } else {
                this._moveToPoint(u, dnode.x, dnode.y, dt, dnode.radius + u.radius + 1.0);
            }
            return;
        }

        if (u.gatherState === 'unloading') {
            u.moving = false;
            u.path = [];
            u.moveGoal = null;
            u.gatherTimer -= dt;
            if (u.gatherTimer <= 0) {
                this.addCredits(u.team, u.carrying);
                u.carrying = 0;
                u.gatherState = 'toResource';
                u.path = [];
                u.repathTimer = 0;
                u.commandLabel = 'Добыча';
            }
        }
    }

    _updateSearch(u, order, dt) {
        const wreck = order.wreck;
        if (!wreck || !wreck.isAlive || wreck.searched) {
            this._popOrder(u);
            return;
        }
        if (wreck.searchingUnit && wreck.searchingUnit !== u) {
            u.commandLabel = 'Обыск занят';
            this._popOrder(u);
            return;
        }
        const d = Math.hypot(wreck.x - u.x, wreck.y - u.y) - wreck.radius;
        if (d > u.radius + 0.9) {
            u.commandLabel = 'К обломкам';
            this._moveToPoint(u, wreck.x, wreck.y, dt, wreck.radius + u.radius + 0.7);
            return;
        }
        u.moving = false;
        u.path = [];
        u.moveGoal = null;
        if (u.searchWreck !== wreck) {
            this._cancelSearch(u);
            u.searchWreck = wreck;
            wreck.searchingUnit = u;
            wreck.searchProgress = 0;
        }
        const total = typeof RTS_WRECK_SEARCH_SEC !== 'undefined' ? RTS_WRECK_SEARCH_SEC : 15;
        wreck.searchProgress = Math.min(total, wreck.searchProgress + dt);
        u.commandLabel = 'Обыск: ' + Math.round(wreck.searchProgress / total * 100) + '%';
        if (wreck.searchProgress < total) return;

        const reward = wreck.reward;
        wreck.searched = true;
        wreck.searchingUnit = null;
        u.searchWreck = null;
        this.addCredits(u.team, reward);
        if (u.team === 'player') {
            this.toast('Обломки обысканы: +' + reward + ' кристаллов.', 3);
            this.audio.ready(wreck.x, wreck.y);
        }
        this._popOrder(u);
        this.hud.refreshCommands();
    }

    _depleteResource(node) {
        if (!node.isAlive) return;
        node.isAlive = false;
        node.amount = 0;
        this.view.removeResource(node);
        this.map.rebuildGrid(this.resources, this.buildings);
        const i = this.selected.indexOf(node);
        if (i >= 0) {
            this.selected.splice(i, 1);
            this.view.setSelection(this.selected);
        }
        const playerUsing = this.units.some(u => u.isAlive && u.team === 'player' && u.resource === node);
        if (playerUsing) this.toast('Кристальная жила истощена.', 2.6);
        this.log('Crystal field depleted at ' + node.x + ',' + node.y + '.');
    }

    // --- Movement ----------------------------------------------------------------

    _moveToPoint(u, x, y, dt, stopDist) {
        if (!u.moveGoal || Math.hypot(u.moveGoal.x - x, u.moveGoal.y - y) > 0.25 ||
            u.moveGoal.stopDist !== stopDist) {
            u.moveGoal = { x, y, stopDist };
            u.path = [];
            u.pathIndex = 0;
            u.repathTimer = 0;
            u.bestGoalDist = Infinity;
        }
        return false;
    }

    _chase(u, target, dt, stopDist) {
        const d = Math.hypot(target.x - u.x, target.y - u.y) - (target.radius || 0);
        if (d <= stopDist) {
            u.path = [];
            u.moving = false;
            u.moveGoal = null;
            return;
        }
        u.moveGoal = { x: target.x, y: target.y, stopDist };
    }

    // --- Combat ------------------------------------------------------------------

    distanceTo(unit, target) {
        return Math.hypot(target.x - unit.x, target.y - unit.y) - (target.radius || 0);
    }

    // Only a target the team can currently see may be attacked (fog of war rule).
    isTargetVisible(team, target) {
        if (!this.vision || typeof this.vision.isVisible !== 'function') return true;
        return this.vision.isVisible(team, target.x, target.y);
    }

    findNearestEnemy(unit, range, includeBuildings) {
        let best = null, bd = range;
        for (const e of this.units) {
            if (!e.isAlive || e.team === unit.team) continue;
            if (!this.isTargetVisible(unit.team, e)) continue;
            const d = this.distanceTo(unit, e);
            if (d < bd) { bd = d; best = e; }
        }
        if (includeBuildings) {
            for (const e of this.buildings) {
                if (!e.isAlive || e.team === unit.team) continue;
                if (!this.isTargetVisible(unit.team, e)) continue;
                const d = this.distanceTo(unit, e);
                if (d < bd) { bd = d; best = e; }
            }
        }
        return best;
    }

    _damageMultiplier(attacker, target) {
        if (target.kind !== 'building') return 1;
        return attacker.buildingMultiplier || 1;
    }

    _attackUnit(u, target) {
        if (!target || !target.isAlive) return;
        u.attackTimer = Math.max(0.15, u.attackCooldown);
        if (u.type === 'grenadier' && this.view.unitAttack) this.view.unitAttack(u, target);
        if (u.splash) {
            this._splashDamage(u, target);
        } else {
            const mult = this._damageMultiplier(u, target);
            const amount = RTSCombat.effectiveDamage(u.damage, target.armor, u.penetration, mult);
            this._damage(target, amount, u);
        }
        if (u.type !== 'grenadier') {
            this.view.tracer(u, target, u.team);
            this.view.impact(target.x, target.y, RTS_DATA.VISUAL_HEIGHT[target.type] || 20, u.team);
        }
        this.audio.shot(u, target);
        this.audio.impact(target, u.type);
    }

    // Siege splash: full damage inside innerRadius, outerFactor inside outerRadius. Friendly
    // fire is intentional: every live unit and building around the impact point is hit.
    _splashDamage(attacker, target) {
        const splash = attacker.splash;
        if (!splash) return;
        const impactX = target.x, impactY = target.y;
        const all = this.units.concat(this.buildings);
        for (const e of all) {
            if (!e.isAlive) continue;
            const d = Math.hypot(e.x - impactX, e.y - impactY);
            if (d > splash.outerRadius) continue;
            const factor = d <= splash.innerRadius ? 1 : splash.outerFactor;
            const mult = this._damageMultiplier(attacker, e);
            const amount = RTSCombat.effectiveDamage(attacker.damage, e.armor, attacker.penetration, mult) * factor;
            this._damage(e, amount, attacker);
        }
    }

    _updateTowers(dt) {
        for (const b of this.buildings) {
            if (!b.isAlive || !b.isBuilt || !b.tower) continue;
            if (b.attackTimer > 0) b.attackTimer -= dt;
            if (b.attackTimer > 0) continue;
            const target = this.findNearestEnemy(b, b.attackRange, true);
            if (!target) continue;
            b.attackTimer = Math.max(0.2, b.attackCooldown);
            const mult = this._damageMultiplier(b, target);
            const amount = RTSCombat.effectiveDamage(b.damage, target.armor, b.penetration, mult);
            this._damage(target, amount, b);
            this.view.tracer(b, target, b.team);
            this.view.impact(target.x, target.y, RTS_DATA.VISUAL_HEIGHT[target.type] || 20, b.team);
            this.audio.shot(b, target);
            this.audio.impact(target);
        }
    }

    _damage(target, amount, source) {
        if (!target || !target.isAlive || !(amount > 0)) return;
        target.health -= amount;
        if (target.kind === 'unit' && target.team === 'player') this.audio.unitHurt(target);
        if (target.health > 0 && target.kind === 'building' && target.team === 'player' &&
            source && source.team && source.team !== target.team) {
            this.audio.announce(target.type === 'hq' ? 'hqAttack' : 'buildingAttack');
        }
        if (target.health <= 0) this._kill(target, source);
    }

    _kill(target, source) {
        if (!target || !target.isAlive) return;
        target.isAlive = false;
        if (!this.vision || this.vision.isExplored('player', target.x, target.y)) {
            this.audio.explode(target);
        }
        const idx = this.selected.indexOf(target);
        if (idx >= 0) this.selected.splice(idx, 1);
        if (target.kind === 'unit') {
            this._cancelSearch(target);
            target.orders = [];
            this.view.explode(target);
            this.view.removeUnit(target);
            this.log(target.name + ' destroyed (' + target.team + ').');
            if (this.selected.length) this.view.setSelection(this.selected);
            this.hud.refreshCommands();
        } else if (target.kind === 'building') {
            target.productionQueue = [];
            this.view.explode(target);
            this.view.removeBuilding(target);
            this.map.rebuildGrid(this.resources, this.buildings);
            this.log(target.name + ' destroyed (' + target.team + ').');
            if (target.team === 'player') {
                this.toast(target.name + ' разрушен.', 3.2);
                if (target.type !== 'hq') this.audio.announce('buildingLost');
            }
            else if (target.type === 'hq') this.toast('Штаб противника уничтожен!', 4);
            if (this.selected.length) this.view.setSelection(this.selected);
            this.hud.refreshCommands();
            this.app.camera.shake(260, 0.008);
        }
    }

    _cleanup() {
        this.units = this.units.filter(u => u.isAlive);
        this.buildings = this.buildings.filter(b => b.isAlive);
        this.resources = this.resources.filter(r => r.isAlive);
        this.selected = this.selected.filter(e => e.isAlive);
    }

    _checkVictory() {
        const playerHQ = this.buildings.find(b => b.isAlive && b.team === 'player' && b.type === 'hq');
        const enemyHQ = this.buildings.find(b => b.isAlive && b.team === 'enemy' && b.type === 'hq');
        if (!enemyHQ) this.endGame('player');
        else if (!playerHQ) this.endGame('enemy');
    }

    // --- Debug -------------------------------------------------------------------

    toggleDebug() {
        this.debug = !this.debug;
        this.view.setDebugSelection(this.debug ? this.selected : [], this.debug);
        this.hud.setDebug(this.debug);
        this.log('Debug ' + (this.debug ? 'on' : 'off') + '.');
    }

    selectedCommandText() {
        const units = this.selectedUnits();
        if (units.length) {
            if (units.length === 1) return units[0].commandLabel || 'Ожидание';
            return 'Отряд: ' + units.length + ' · ' + (units[0].commandLabel || 'Ожидание');
        }
        const b = this.selectedBuilding();
        if (b) return b.demolishing ? 'Демонтаж' : b.isBuilt ? (b.productionQueue.length ? 'Производство' : 'Готов') : 'Строится';
        if (this.selectedResource()) return 'Кристаллы: ' + Math.ceil(this.selectedResource().amount);
        const wreck = this.selectedWreck();
        if (wreck) return wreck.searched ? 'Обломки обысканы'
            : wreck.searchingUnit ? 'Обыск: ' + Math.round(wreck.searchProgress / RTS_WRECK_SEARCH_SEC * 100) + '%'
                : 'Можно обыскать';
        return '—';
    }
}

