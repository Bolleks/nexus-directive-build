// RTSCombat.js — combat decisions for the RTS simulation: target scoring, focus fire with
// damage reservation, standoff and kiting, turret tracking and firing. No Babylon and no DOM:
// RTSWorld owns the entities, RTSSteering moves them, this module only decides and fires.

class RTSCombat {
    // Damage formula: D is the shot damage with multipliers, A the target armor, P the
    // attacker's penetration. Any shot still deals at least RTS_DAMAGE_MIN_FRACTION of D.
    /** @param {number} damage @param {number} armor @param {number} penetration @param {number} [multiplier] */
    static effectiveDamage(damage, armor, penetration, multiplier) {
        const D = (damage || 0) * (multiplier || 1);
        const reduction = Math.max(0, (armor || 0) - (penetration || 0));
        const minFraction = typeof RTS_DAMAGE_MIN_FRACTION !== 'undefined' ? RTS_DAMAGE_MIN_FRACTION : 0.25;
        return Math.max(D - reduction, minFraction * D);
    }

    /** @param {RTSWorld} world */
    constructor(world) {
        this.world = world;
        this.think = 0;
        /** @type {Map<number, number>} */
        this.reserved = new Map();
    }

    /** @param {number} dt */
    updateIntents(dt) {
        this.think -= dt;
        if (this.think > 0) return;
        this.think = RTS_COMBAT_THINK_SEC;
        this.reserved.clear();
        this._updateWorkers();
        this._assignTeam('player');
        this._assignTeam('enemy');
    }

    _updateWorkers() {
        for (const u of this.world.units) {
            if (!u.isAlive || u.role !== 'worker' || u.team !== 'enemy') continue;
            const order = u.orders[0];
            if (order && order.type === 'attack') continue;
            let best = null, bd = RTS_FLEE_RADIUS;
            for (const e of this.world.units) {
                if (!e.isAlive || e.team === u.team) continue;
                const d = Math.hypot(e.x - u.x, e.y - u.y) - (e.radius || 0);
                if (d < bd) { bd = d; best = e; }
            }
            u.fleeFrom = best;
        }
    }

    /** @param {string} team */
    _assignTeam(team) {
        const enemies = [];
        for (const e of this.world.units) {
            if (e.isAlive && e.team !== team) enemies.push(e);
        }
        for (const e of this.world.buildings) {
            if (e.isAlive && e.team !== team) enemies.push(e);
        }
        if (!enemies.length) return;

        for (const u of this.world.units) {
            if (!u.isAlive || u.team !== team) continue;
            const order = u.orders[0] || null;
            if (order && (order.type === 'move' || order.type === 'gather')) continue;
            if (u.role === 'worker' && (!order || order.type !== 'attack')) continue;

            const explicit = order && order.type === 'attack' && !order.auto;
            if (explicit && order.target && order.target.isAlive) {
                u.target = order.target;
                this._reserve(u, order.target);
                continue;
            }
            if (explicit) continue;

            // Attack range may exceed sight (the siege tank): the team vision grid is the
            // visibility check, so an ally-spotted target can be acquired at full range.
            let range = Math.max(u.sightRange, u.attackRange);
            if (order && order.type === 'hold') range = u.attackRange + u.radius + 0.5;
            if (order && order.type === 'attackMove') range = Math.max(range, u.sightRange * 1.3);
            const best = this._bestTarget(u, enemies, range);
            if (best) {
                if (u.target !== best) {
                    u.target = best;
                    u.path = [];
                    u.pathIndex = 0;
                    u.repathTimer = 0;
                    u.moveGoal = null;
                }
                if (order && order.type === 'attack' && order.auto) order.target = best;
                this._reserve(u, best);
            } else if (order && order.type === 'attack' && order.auto) {
                u.target = null;
                order.target = null;
            } else if (order && order.type === 'attackMove') {
                u.target = null;
            }
        }
    }

    /** @param {string} team @param {any} entity */
    _visible(team, entity) {
        const vision = this.world.vision;
        if (!vision || typeof vision.isVisible !== 'function') return true;
        return vision.isVisible(team, entity.x, entity.y);
    }

    /** @param {RTSUnit} u @param {any[]} enemies @param {number} range */
    _bestTarget(u, enemies, range) {
        let best = null, bestScore = -Infinity;
        for (const e of enemies) {
            if (!e.isAlive) continue;
            const d = this.world.distanceTo(u, e);
            if (d > range) continue;
            if (u.deadZone && d < u.deadZone) continue;
            if (!this._visible(u.team, e)) continue;
            const reserved = this.reserved.get(e.id) || 0;
            if (reserved >= e.health * 1.05) continue;
            const score = this._score(u, e, d);
            if (score > bestScore) { bestScore = score; best = e; }
        }
        return best;
    }

    /** @param {RTSUnit} u @param {any} target @param {number} d */
    _score(u, target, d) {
        const priority = RTS_DATA.TARGET_PRIORITY[u.type] || {};
        const roleKey = target.kind === 'building'
            ? (target.type === 'tower' ? 'tower' : 'building')
            : target.role;
        let score = (priority[roleKey] || 0) * 10;
        const dps = (target.damage || 0) / Math.max(0.1, target.attackCooldown || 1);
        score += RTS_COMBAT_THREAT * dps;
        const def = RTS_DATA.UNITS[target.type] || RTS_DATA.BUILDINGS[target.type];
        score += RTS_COMBAT_VALUE * ((def && def.cost) || 0);
        score += RTS_COMBAT_KILL * (1 - target.health / Math.max(1, target.maxHealth));
        score -= RTS_COMBAT_DISTANCE * d;
        if (u.target === target) score += RTS_COMBAT_STICKY;
        const reserved = this.reserved.get(target.id) || 0;
        score -= RTS_COMBAT_OVERKILL * reserved;
        if (this._underTower(u.team, target)) score -= RTS_COMBAT_TOWER;
        const mult = target.kind === 'building' ? (u.buildingMultiplier || 1) : 1;
        const damage = RTSCombat.effectiveDamage(u.damage, target.armor, u.penetration, mult);
        score += 2 * (damage / Math.max(0.1, u.attackCooldown));
        return score;
    }

    /** @param {string} team @param {any} target */
    _underTower(team, target) {
        for (const b of this.world.buildings) {
            if (!b.isAlive || b.team === team || !b.tower) continue;
            const d = Math.hypot(target.x - b.x, target.y - b.y) - (target.radius || 0);
            if (d <= b.attackRange && target !== b) return true;
        }
        return false;
    }

    /** @param {RTSUnit} u @param {any} target */
    _reserve(u, target) {
        const mult = target.kind === 'building' ? (u.buildingMultiplier || 1) : 1;
        const damage = RTSCombat.effectiveDamage(u.damage, target.armor, u.penetration, mult);
        const amount = Math.max(1, damage * RTS_COMBAT_RESERVE);
        this.reserved.set(target.id, (this.reserved.get(target.id) || 0) + amount);
    }

    /** @param {number} dt */
    applyMovement(dt) {
        for (const u of this.world.units) {
            if (!u.isAlive) continue;
            if (u.role === 'worker' && u.fleeFrom && u.fleeFrom.isAlive) {
                const d = Math.hypot(u.fleeFrom.x - u.x, u.fleeFrom.y - u.y);
                if (d < RTS_FLEE_RADIUS) {
                    this._backOff(u, u.fleeFrom);
                    continue;
                }
            }
            if (!u.target || !u.target.isAlive) continue;
            const order = u.orders[0];
            if (order && (order.type === 'move' || order.type === 'gather' || order.type === 'hold')) continue;
            const edge = this.world.distanceTo(u, u.target);
            if (u.preferredRangeMin > 0 && edge < u.preferredRangeMin - 0.4) {
                this._backOff(u, u.target);
                continue;
            }
            if (u.kite && edge < u.preferredRangeMax && u.attackTimer > 0.15) {
                this._backOff(u, u.target);
                continue;
            }
            if (!order && edge > u.attackRange) {
                u.moveGoal = { x: u.target.x, y: u.target.y, stopDist: Math.max(0.5, u.attackRange - 0.4) };
            }
        }
    }

    /** @param {RTSUnit} u @param {any} target */
    _backOff(u, target) {
        const dx = u.x - target.x, dy = u.y - target.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-4) return;
        u.moveGoal = {
            x: u.x + (dx / d) * RTS_STANDOFF_BACKOFF,
            y: u.y + (dy / d) * RTS_STANDOFF_BACKOFF,
            stopDist: 0.25
        };
        u.path = [];
        u.pathIndex = 0;
        u.repathTimer = 0;
    }

    /** @param {number} dt */
    resolve(dt) {
        for (const u of this.world.units) {
            if (!u.isAlive) continue;
            const target = u.target;
            if (!target || !target.isAlive) {
                u.target = null;
                u.combatState = 'idle';
                continue;
            }
            const order = u.orders[0];
            if (order && (order.type === 'move' || order.type === 'gather')) continue;
            const angle = Math.atan2(target.y - u.y, target.x - u.x);
            u.turretHeading = RTSBehaviors.turnToward(u.turretHeading, angle, u.turretTurnRate * dt);
            const speed = Math.hypot(u.vx, u.vy);
            if (speed < 1.0) u.heading = RTSBehaviors.turnToward(u.heading, angle, u.turnRate * dt);
            const edge = this.world.distanceTo(u, target);
            if (!this._visible(u.team, target)) {
                u.combatState = 'hidden';
                continue;
            }
            if (u.deadZone && edge < u.deadZone) {
                u.combatState = 'tooClose';
                continue;
            }
            if (edge > u.attackRange + 0.05) {
                u.combatState = 'chase';
                continue;
            }
            if (u.turretArc < Math.PI) {
                let diff = angle - u.turretHeading;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                if (Math.abs(diff) > u.turretArc) {
                    u.combatState = 'aim';
                    continue;
                }
            }
            if (!u.fireOnMove && speed > RTS_COMBAT_FIRE_SPEED) {
                u.combatState = 'moving';
                continue;
            }
            if (u.attackTimer <= 0) {
                u.combatState = 'fire';
                this.world._attackUnit(u, target);
            } else {
                u.combatState = 'ready';
            }
        }
    }
}
