// RTSSteering.js — local movement for the RTS simulation. Reynolds-style behaviors
// (seek, arrival, flee, separation, obstacle avoidance) are summed into one direction;
// a spatial hash, direct movement, a rare A* fallback and hard depenetration keep the
// crowd readable. No Babylon and no DOM: RTSWorld owns the truth, this module only moves
// records.

class RTSBehaviors {
    /** @param {number} x @param {number} y */
    static normalize(x, y) {
        const d = Math.hypot(x, y);
        return d < 1e-6 ? { x: 0, y: 0, d: 0 } : { x: x / d, y: y / d, d };
    }

    /** @param {RTSUnit} unit @param {{x:number,y:number}} point */
    static seek(unit, point) {
        return RTSBehaviors.normalize(point.x - unit.x, point.y - unit.y);
    }

    /** @param {RTSUnit} unit @param {{x:number,y:number}} point @param {number} slowRadius */
    static arrival(unit, point, slowRadius) {
        const dx = point.x - unit.x, dy = point.y - unit.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-6) return { x: 0, y: 0, speed: 0, distance: 0 };
        const speed = unit.speed * Math.max(0, Math.min(1, d / Math.max(0.01, slowRadius)));
        return { x: dx / d, y: dy / d, speed, distance: d };
    }

    /** @param {RTSUnit} unit @param {{x:number,y:number}} point @param {number} radius */
    static flee(unit, point, radius) {
        const dx = unit.x - point.x, dy = unit.y - point.y;
        const d = Math.hypot(dx, dy);
        if (d >= radius || d < 1e-6) return { x: 0, y: 0, active: false };
        return { x: dx / d, y: dy / d, active: true };
    }

    /**
     * Soft separation: a vector away from every close neighbour, weighted by distance
     * and by the neighbour's mass relative to ours.
     * @param {RTSUnit} unit @param {RTSUnit[]} neighbors @param {number} radius
     */
    static separation(unit, neighbors, radius) {
        let x = 0, y = 0;
        for (const n of neighbors) {
            if (!n || n === unit || !n.isAlive) continue;
            let dx = unit.x - n.x, dy = unit.y - n.y;
            let d = Math.hypot(dx, dy);
            const range = radius + unit.radius + n.radius;
            if (d >= range) continue;
            if (d < 1e-4) { dx = 1; dy = 0; d = 1; }
            const weight = (1 - d / range) * (n.mass / Math.max(0.5, unit.mass));
            x += (dx / d) * weight;
            y += (dy / d) * weight;
        }
        return { x, y };
    }

    /**
     * Static avoidance: rocks, crystal fields, buildings and the map border.
     * Returns a vector away from the nearest danger.
     * @param {RTSUnit} unit @param {any} world
     */
    static obstacleAvoidance(unit, world) {
        let x = 0, y = 0;
        const add = (dx, dy, d, range) => {
            if (d >= range) return;
            if (d < 1e-4) { x += 1; return; }
            const w = 1 - d / range;
            x += (dx / d) * w;
            y += (dy / d) * w;
        };
        for (const o of world.map.obstacles) {
            add(unit.x - o.x, unit.y - o.y, Math.hypot(unit.x - o.x, unit.y - o.y),
                o.radius + unit.radius + RTS_OBSTACLE_RADIUS);
        }
        for (const w of world.map.relief ? world.map.relief.water : []) {
            add(unit.x - w.x, unit.y - w.y, Math.hypot(unit.x - w.x, unit.y - w.y),
                w.radius + unit.radius + RTS_OBSTACLE_RADIUS);
        }
        for (const r of world.resources) {
            if (!r.isAlive || r.amount <= 0) continue;
            add(unit.x - r.x, unit.y - r.y, Math.hypot(unit.x - r.x, unit.y - r.y),
                r.radius + unit.radius + RTS_OBSTACLE_RADIUS);
        }
        for (const b of world.buildings) {
            if (!b.isAlive) continue;
            const hw = b.footprint[0] / 2, hh = b.footprint[1] / 2;
            const nx = Math.max(b.x - hw, Math.min(unit.x, b.x + hw));
            const ny = Math.max(b.y - hh, Math.min(unit.y, b.y + hh));
            add(unit.x - nx, unit.y - ny, Math.hypot(unit.x - nx, unit.y - ny),
                unit.radius + RTS_OBSTACLE_RADIUS);
        }
        const m = RTS_STEER_BOUNDS + unit.radius;
        if (unit.x < m) add(1, 0, 0, m - unit.x + 1);
        if (unit.x > world.map.size - m) add(-1, 0, 0, unit.x - (world.map.size - m) + 1);
        if (unit.y < m) add(0, 1, 0, m - unit.y + 1);
        if (unit.y > world.map.size - m) add(0, -1, 0, unit.y - (world.map.size - m) + 1);
        return { x, y };
    }

    /** @param {number} angle @param {number} target @param {number} maxStep */
    static turnToward(angle, target, maxStep) {
        let delta = target - angle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        if (Math.abs(delta) <= maxStep) return target;
        return angle + Math.sign(delta) * maxStep;
    }
}

class RTSSpatialHash {
    /** @param {number} cellSize */
    constructor(cellSize) {
        this.cellSize = Math.max(0.5, cellSize);
        /** @type {Map<string, any[]>} */
        this.cells = new Map();
    }

    /** @param {number} cx @param {number} cy */
    _key(cx, cy) {
        return cx + ',' + cy;
    }

    clear() {
        this.cells.clear();
    }

    /** @param {{x:number,y:number}} entity */
    insert(entity) {
        const cx = Math.floor(entity.x / this.cellSize);
        const cy = Math.floor(entity.y / this.cellSize);
        const key = this._key(cx, cy);
        let list = this.cells.get(key);
        if (!list) {
            list = [];
            this.cells.set(key, list);
        }
        list.push(entity);
    }

    /**
     * Every entity in the cells touched by the query circle. The caller filters the
     * exact distance; the hash only avoids the all-pairs scan.
     * @param {number} x @param {number} y @param {number} radius @param {any[]} [out]
     */
    query(x, y, radius, out = []) {
        out.length = 0;
        const s = this.cellSize;
        const x0 = Math.floor((x - radius) / s), x1 = Math.floor((x + radius) / s);
        const y0 = Math.floor((y - radius) / s), y1 = Math.floor((y + radius) / s);
        for (let cy = y0; cy <= y1; cy++) {
            for (let cx = x0; cx <= x1; cx++) {
                const list = this.cells.get(this._key(cx, cy));
                if (!list) continue;
                for (const e of list) out.push(e);
            }
        }
        return out;
    }
}

class RTSSteering {
    /** @param {RTSWorld} world */
    constructor(world) {
        this.world = world;
        this.hash = new RTSSpatialHash(RTS_STEER_CELL);
        /** @type {any[]} */
        this._neighbors = [];
        this._pathBudget = RTS_PATH_BUDGET;
    }

    /** @param {number} dt */
    update(dt) {
        if (!dt || dt <= 0) return;
        this._pathBudget = RTS_PATH_BUDGET;
        this._rebuildHash();
        for (const u of this.world.units) {
            if (u.isAlive) this._prepare(u, dt);
        }
        for (const u of this.world.units) {
            if (u.isAlive) this._integrate(u, dt);
        }
        for (let pass = 0; pass < RTS_DEPENETRATION_PASSES; pass++) {
            this._rebuildHash();
            this._resolveUnits();
            for (const u of this.world.units) if (u.isAlive) this._resolveStatic(u);
        }
        for (const u of this.world.units) {
            if (!u.isAlive) continue;
            this._trackStuck(u, dt);
            u.lastX = u.x;
            u.lastY = u.y;
        }
    }

    _rebuildHash() {
        this.hash.clear();
        for (const u of this.world.units) {
            if (u.isAlive) this.hash.insert(u);
        }
    }

    /** @param {RTSUnit} unit */
    _neighborsOf(unit) {
        const radius = RTS_SEPARATION_RADIUS + unit.radius + 2.2;
        const found = this.hash.query(unit.x, unit.y, radius, this._neighbors);
        const out = [];
        for (const n of found) {
            if (!n || n === unit || !n.isAlive) continue;
            const d = Math.hypot(n.x - unit.x, n.y - unit.y);
            if (d <= radius) out.push({ unit: n, d });
        }
        out.sort((a, b) => a.d - b.d);
        return out.slice(0, RTS_STEER_NEIGHBORS).map(p => p.unit);
    }

    /** @param {RTSUnit} u @param {number} dt */
    _prepare(u, dt) {
        u.repathTimer -= dt;
        u.crowdTimer = Math.max(0, (u.crowdTimer || 0) - dt);
        const goal = u.moveGoal;
        if (!goal) {
            u.desiredSpeed = 0;
            u._steerDirX = Math.cos(u.heading);
            u._steerDirY = Math.sin(u.heading);
            return;
        }
        const stop = Math.max(0.05, goal.stopDist || RTS_MOVE_ARRIVE_RADIUS);
        if (Math.hypot(goal.x - u.x, goal.y - u.y) <= stop) {
            u.path = [];
            u.pathIndex = 0;
            u.desiredSpeed = 0;
            u._steerDirX = 0;
            u._steerDirY = 0;
            return;
        }
        if (u.pathBlocked) {
            u.pathBlockedTimer -= dt;
            if (u.pathBlockedTimer > 0) {
                u.desiredSpeed = 0;
                u._steerDirX = 0;
                u._steerDirY = 0;
                return;
            }
            u.pathBlocked = false;
            u.repathTimer = 0;
        }

        const heavy = u.radius > RTS_PATH_LIGHT_RADIUS;
        const gdx = u.x - goal.x, gdy = u.y - goal.y;
        const gd = Math.hypot(gdx, gdy);
        const approach = gd > stop
            ? { x: goal.x + (gdx / gd) * stop, y: goal.y + (gdy / gd) * stop }
            : { x: u.x, y: u.y };

        if (!u.path.length && u.repathTimer <= 0 &&
            !this.world.map.lineFreeFor(u.x, u.y, approach.x, approach.y, heavy)) {
            u.needsPath = true;
        }

        if (u.needsPath && u.repathTimer <= 0 && this._pathBudget > 0) {
            this._pathBudget--;
            u.needsPath = false;
            u.repathTimer = RTS_PATH_REPATH_SEC;
            // Approach the target from the near side: a resource or a building is a
            // blocker, so a path to its centre would send the unit around the far edge.
            const path = this.world.map.findPath(u.x, u.y, approach.x, approach.y, heavy);
            if (path.length) {
                u.path = path;
                u.pathIndex = 0;
            } else if (!this.world.map.lineFreeFor(u.x, u.y, approach.x, approach.y, heavy)) {
                u.pathBlocked = true;
                u.pathBlockedTimer = RTS_PATH_BLOCKED_SEC;
            }
        }

        let target = { x: goal.x, y: goal.y };
        if (u.path.length) {
            let wp = u.path[u.pathIndex];
            while (wp && Math.hypot(wp.x - u.x, wp.y - u.y) < RTS_STEER_ARRIVE) {
                u.pathIndex++;
                wp = u.path[u.pathIndex];
            }
            if (u.pathIndex >= u.path.length) {
                u.path = [];
                u.pathIndex = 0;
            } else {
                const next = u.path[u.pathIndex + 1];
                target = next && Math.hypot(next.x - u.x, next.y - u.y) < RTS_STEER_LOOKAHEAD
                    ? next
                    : u.path[u.pathIndex];
            }
        }
        const arr = RTSBehaviors.arrival(u, target, RTS_ARRIVAL_RADIUS);
        u.desiredSpeed = arr.speed;
        u._steerDirX = arr.x;
        u._steerDirY = arr.y;
    }

    /** @param {RTSUnit} u @param {number} dt */
    _integrate(u, dt) {
        const neighbors = this._neighborsOf(u);
        const dirX = u._steerDirX || 0, dirY = u._steerDirY || 0;
        const desiredSpeed = u.desiredSpeed || 0;
        let chosenX = dirX, chosenY = dirY;

        if (desiredSpeed > 0.01 && (dirX || dirY)) {
            const sep = RTSBehaviors.separation(u, neighbors, RTS_SEPARATION_RADIUS);
            const obs = RTSBehaviors.obstacleAvoidance(u, this.world);
            const flee = u.fleeFrom ? RTSBehaviors.flee(u, u.fleeFrom, RTS_FLEE_RADIUS) : null;
            const nearGoal = u.moveGoal
                ? Math.hypot(u.moveGoal.x - u.x, u.moveGoal.y - u.y) < RTS_MOVE_SPACING * 4
                : false;
            const sepScale = nearGoal || u.path.length || (u.crowdTimer || 0) > 0 ? 0 : 1;
            const obsScale = u.path.length ? 0 : 1;
            let ax = dirX + sep.x * RTS_SEPARATION_WEIGHT * sepScale + obs.x * RTS_OBSTACLE_WEIGHT * obsScale;
            let ay = dirY + sep.y * RTS_SEPARATION_WEIGHT * sepScale + obs.y * RTS_OBSTACLE_WEIGHT * obsScale;
            if (flee && flee.active) {
                ax += flee.x * RTS_FLEE_WEIGHT;
                ay += flee.y * RTS_FLEE_WEIGHT;
            }
            const len = Math.hypot(ax, ay);
            if (len > 1e-6) {
                chosenX = ax / len;
                chosenY = ay / len;
            }
        }

        const currentSpeed = Math.hypot(u.vx, u.vy);
        let newAngle = u.heading;
        if (currentSpeed > 0.05) newAngle = Math.atan2(u.vy, u.vx);
        if (desiredSpeed > 0.01 && (chosenX || chosenY)) {
            const targetAngle = Math.atan2(chosenY, chosenX);
            newAngle = RTSBehaviors.turnToward(newAngle, targetAngle, u.turnRate * dt);
        }

        let speed = currentSpeed;
        if (desiredSpeed > speed) speed = Math.min(desiredSpeed, speed + u.accel * dt);
        else speed = Math.max(desiredSpeed, speed - u.decel * dt);
        if (desiredSpeed <= 0.01) speed = Math.max(0, speed - u.decel * dt);

        u.vx = Math.cos(newAngle) * speed;
        u.vy = Math.sin(newAngle) * speed;
        u.x += u.vx * dt;
        u.y += u.vy * dt;
        if (speed > 0.05) u.heading = newAngle;
        u.moving = speed > 0.05;
        u.movingPhase += speed * dt;
        this._resolveStatic(u);
    }

    _resolveUnits() {
        const units = this.world.units;
        for (let i = 0; i < units.length; i++) {
            const a = units[i];
            if (!a.isAlive) continue;
            const found = this.hash.query(a.x, a.y, a.radius + 2.2, this._neighbors);
            for (const b of found) {
                if (!b || b === a || !b.isAlive || b.id <= a.id) continue;
                let dx = b.x - a.x, dy = b.y - a.y;
                let d = Math.hypot(dx, dy);
                const min = a.radius + b.radius + 0.08;
                if (d >= min) continue;
                if (d < 1e-4) { dx = 0.1; dy = 0; d = 0.1; }
                const push = min - d;
                const invA = 1 / Math.max(0.2, a.mass);
                const invB = 1 / Math.max(0.2, b.mass);
                const total = invA + invB;
                a.x -= (dx / d) * push * (invA / total);
                a.y -= (dy / d) * push * (invA / total);
                b.x += (dx / d) * push * (invB / total);
                b.y += (dy / d) * push * (invB / total);
            }
        }
    }

    /** @param {RTSUnit} u */
    _resolveStatic(u) {
        const map = this.world.map;
        const m = Math.max(RTS_STEER_BOUNDS, u.radius + 0.35);
        u.x = Math.max(m, Math.min(map.size - m, u.x));
        u.y = Math.max(m, Math.min(map.size - m, u.y));
        for (const o of map.obstacles) this._pushCircle(u, o.x, o.y, o.radius + u.radius);
        for (const w of map.relief ? map.relief.water : []) {
            this._pushCircle(u, w.x, w.y, w.radius + u.radius);
        }
        for (const r of this.world.resources) {
            if (r.isAlive && r.amount > 0) this._pushCircle(u, r.x, r.y, r.radius + u.radius);
        }
        for (const b of this.world.buildings) {
            if (!b.isAlive) continue;
            const hw = b.footprint[0] / 2 + u.radius, hh = b.footprint[1] / 2 + u.radius;
            const dx = u.x - b.x, dy = u.y - b.y;
            if (Math.abs(dx) < hw && Math.abs(dy) < hh) {
                const ox = hw - Math.abs(dx), oy = hh - Math.abs(dy);
                if (ox < oy) u.x += dx >= 0 ? ox : -ox;
                else u.y += dy >= 0 ? oy : -oy;
            }
        }
        u.x = Math.max(m, Math.min(map.size - m, u.x));
        u.y = Math.max(m, Math.min(map.size - m, u.y));
    }

    /** @param {RTSUnit} u @param {number} cx @param {number} cy @param {number} r */
    _pushCircle(u, cx, cy, r) {
        const dx = u.x - cx, dy = u.y - cy;
        const d = Math.hypot(dx, dy);
        if (d >= r) return;
        if (d < 1e-4) { u.x += r; return; }
        u.x = cx + (dx / d) * r;
        u.y = cy + (dy / d) * r;
    }

    /** @param {RTSUnit} u @param {number} dt */
    _trackStuck(u, dt) {
        const goal = u.moveGoal;
        const wanted = goal && (u.desiredSpeed || 0) > 0.01;
        if (!wanted) {
            u.stuckTimer = 0;
            return;
        }
        const distance = Math.hypot(goal.x - u.x, goal.y - u.y);
        if (u.path.length) {
            u.bestGoalDist = distance;
            u.stuckTimer = 0;
            return;
        }
        if (distance < (u.bestGoalDist || Infinity) - RTS_MOVE_ARRIVE_RADIUS) {
            u.bestGoalDist = distance;
            u.stuckTimer = 0;
            return;
        }
        u.stuckTimer += dt;
        if (u.stuckTimer >= RTS_PATH_FALLBACK_SEC) {
            u.stuckTimer = 0;
            u.crowdTimer = RTS_PATH_FALLBACK_SEC;
            u.bestGoalDist = distance;
            const stop = Math.max(0.05, goal.stopDist || RTS_MOVE_ARRIVE_RADIUS);
            const gdx = u.x - goal.x, gdy = u.y - goal.y;
            const gd = Math.hypot(gdx, gdy);
            const approach = gd > stop
                ? { x: goal.x + (gdx / gd) * stop, y: goal.y + (gdy / gd) * stop }
                : { x: u.x, y: u.y };
            const heavy = u.radius > RTS_PATH_LIGHT_RADIUS;
            if (!this.world.map.lineFreeFor(u.x, u.y, approach.x, approach.y, heavy)) {
                u.needsPath = true;
            }
        }
    }
}
