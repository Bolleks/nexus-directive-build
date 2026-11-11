// RTSVision.js — per-team visibility and intel for the RTS simulation. Two grids per team:
// `visible` is what the team sees now, `explored` is everything it has ever seen. The intel
// map remembers enemy entities by id with a last-seen position and an expiry time. No Babylon
// and no DOM: RTSView draws the player grid, RTSAIDirector thinks with the enemy intel.

class RTSVision {
    /** @param {RTSWorld} world */
    constructor(world) {
        this.world = world;
        this.size = world.map.size;
        const cells = this.size * this.size;
        /** @type {{player: Uint8Array, enemy: Uint8Array}} */
        this.visible = { player: new Uint8Array(cells), enemy: new Uint8Array(cells) };
        /** @type {{player: Uint8Array, enemy: Uint8Array}} */
        this.explored = { player: new Uint8Array(cells), enemy: new Uint8Array(cells) };
        /** @type {{player: Map<number, any>, enemy: Map<number, any>}} */
        this.intel = { player: new Map(), enemy: new Map() };
        this.timer = 0;
        this.version = 0;
        this._teams = ['player', 'enemy'];
    }

    /** @param {number} dt */
    update(dt) {
        this.timer -= dt;
        if (this.timer > 0) return;
        this.timer = RTS_VISION_UPDATE_SEC;
        for (const team of this._teams) {
            const vis = this.visible[team];
            const exp = this.explored[team];
            vis.fill(0);
            for (const u of this.world.units) {
                if (u.isAlive && u.team === team) this._stamp(team, u.x, u.y, u.sightRange);
            }
            for (const b of this.world.buildings) {
                if (b.isAlive && b.team === team) this._stamp(team, b.x, b.y, b.sightRange);
            }
            for (let i = 0; i < vis.length; i++) if (vis[i]) exp[i] = 1;
        }
        for (const team of this._teams) this._updateIntel(team);
        this.version++;
    }

    /** @param {string} team @param {number} x @param {number} y @param {number} radius */
    _stamp(team, x, y, radius) {
        const n = this.size;
        const vis = this.visible[team];
        const r = Math.max(0.5, radius);
        const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(n - 1, Math.ceil(x + r));
        const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(n - 1, Math.ceil(y + r));
        const r2 = r * r;
        for (let cy = y0; cy <= y1; cy++) {
            for (let cx = x0; cx <= x1; cx++) {
                const dx = cx + 0.5 - x, dy = cy + 0.5 - y;
                if (dx * dx + dy * dy <= r2) vis[cy * n + cx] = 1;
            }
        }
    }

    // Permanent explored circle: the starting area around a base is known before the first frame.
    /** @param {string} team @param {number} x @param {number} y @param {number} radius */
    explore(team, x, y, radius) {
        const n = this.size;
        const exp = this.explored[team];
        const r = Math.max(0.5, radius);
        const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(n - 1, Math.ceil(x + r));
        const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(n - 1, Math.ceil(y + r));
        const r2 = r * r;
        for (let cy = y0; cy <= y1; cy++) {
            for (let cx = x0; cx <= x1; cx++) {
                const dx = cx + 0.5 - x, dy = cy + 0.5 - y;
                if (dx * dx + dy * dy <= r2) exp[cy * n + cx] = 1;
            }
        }
    }

    /** @param {string} team */
    _updateIntel(team) {
        const now = this.world.time || 0;
        const memory = this.intel[team];
        for (const rec of memory.values()) rec.visible = false;
        const seen = new Set();
        const consider = (e) => {
            if (!e.isAlive || e.team === team) return;
            if (!this.isVisible(team, e.x, e.y)) return;
            seen.add(e.id);
            const rec = memory.get(e.id) || { id: e.id };
            rec.kind = e.kind;
            rec.type = e.type;
            rec.team = e.team;
            rec.x = e.x;
            rec.y = e.y;
            rec.health = e.health;
            rec.maxHealth = e.maxHealth;
            rec.lastSeen = now;
            rec.visible = true;
            memory.set(e.id, rec);
        };
        for (const u of this.world.units) consider(u);
        for (const b of this.world.buildings) consider(b);
        for (const [id, rec] of memory) {
            const ttl = rec.kind === 'building' ? RTS_INTEL_BUILDING_TTL : RTS_INTEL_UNIT_TTL;
            if (!seen.has(id) && now - (rec.lastSeen || 0) > ttl) memory.delete(id);
        }
    }

    /** @param {string} team @param {number} x @param {number} y */
    isVisible(team, x, y) {
        const n = this.size;
        const cx = Math.floor(x), cy = Math.floor(y);
        if (cx < 0 || cy < 0 || cx >= n || cy >= n) return false;
        return this.visible[team][cy * n + cx] === 1;
    }

    /** @param {string} team @param {number} x @param {number} y */
    isExplored(team, x, y) {
        const n = this.size;
        const cx = Math.floor(x), cy = Math.floor(y);
        if (cx < 0 || cy < 0 || cx >= n || cy >= n) return false;
        return this.explored[team][cy * n + cx] === 1;
    }

    /** @param {string} team @param {any} entity */
    canSelect(team, entity) {
        if (!entity || !entity.isAlive) return false;
        if (entity.kind === 'resource' || entity.kind === 'wreck') return this.isExplored(team, entity.x, entity.y);
        if (entity.team === team) return true;
        return this.isExplored(team, entity.x, entity.y);
    }

    /** @param {string} team */
    visibleEnemies(team) {
        const out = [];
        for (const rec of this.intel[team].values()) if (rec.visible) out.push(rec);
        return out;
    }

    /** @param {string} team */
    summary(team) {
        let units = 0, buildings = 0, armyValue = 0;
        for (const rec of this.intel[team].values()) {
            if (rec.kind === 'building') buildings++;
            else {
                units++;
                const def = RTS_DATA.UNITS[rec.type];
                if (def) armyValue += def.cost;
            }
        }
        return { units, buildings, armyValue };
    }
}
