// RTSEntities.js — the plain simulation records of the RTS demo. No Babylon here: the view
// reads these fields, the simulation writes them. Positions are map units, times seconds.
//
// Unit fields follow the usual RTS slice: id, team, type, position, rotation, health, speed,
// sight/damage/range/cooldown, current order queue, target, path and alive/selectable flags.
// A building has a footprint, construction progress, a production queue and a rally point.

class RTSUnit {
    /** @param {number} id @param {string} team @param {string} type @param {number} x @param {number} y */
    constructor(id, team, type, x, y) {
        const d = RTS_DATA.UNITS[type];
        this.kind = 'unit';
        this.id = id;
        this.team = team;
        this.type = type;
        this.name = d.name;
        this.x = x;
        this.y = y;
        this.heading = 0;
        this.radius = d.radius;
        this.health = d.hp;
        this.maxHealth = d.hp;
        this.speed = d.speed;
        this.sightRange = d.sight;
        const move = d.move || { accel: 20, decel: 24, turnRate: 6, mass: 1, clearance: d.radius };
        this.accel = move.accel;
        this.decel = move.decel;
        this.turnRate = move.turnRate;
        this.mass = move.mass;
        this.clearance = move.clearance;
        this.vx = 0;
        this.vy = 0;
        this.desiredSpeed = 0;
        this._steerDirX = 0;
        this._steerDirY = 0;
        /** @type {{ x: number, y: number, stopDist: number } | null} */
        this.moveGoal = null;
        this.pathBlocked = false;
        this.pathBlockedTimer = 0;
        this.fleeFrom = null;
        this.damage = d.damage;
        this.attackRange = d.range;
        this.attackCooldown = d.cooldown;
        this.armor = d.armor;
        this.penetration = d.penetration || 0;
        this.buildingMultiplier = d.buildingMultiplier || 1;
        this.deadZone = d.deadZone || 0;
        this.splash = d.splash || null;
        this.supply = d.supply;
        this.role = d.role;
        const turret = d.turret || { turnRate: 10, arc: Math.PI, fireOnMove: false };
        this.turretHeading = 0;
        this.turretTurnRate = turret.turnRate;
        this.turretArc = turret.arc;
        this.fireOnMove = !!turret.fireOnMove;
        this.preferredRangeMin = d.preferredRange ? d.preferredRange[0] : 0;
        this.preferredRangeMax = d.preferredRange ? d.preferredRange[1] : this.attackRange;
        this.kite = !!d.kite;
        this.combatState = 'idle';
        this.combatTimer = 0;
        this.leash = 0;
        this.isSelectable = true;
        this.isAlive = true;

        /** @type {RTSUnit | RTSBuilding | null} */
        this.target = null;
        /** @type {any[]} */
        this.orders = [];
        /** @type {{x:number, y:number}[]} */
        this.path = [];
        this.pathIndex = 0;
        this.repathTimer = 0;
        this.attackTimer = 0;
        this.stuckTimer = 0;
        this.needsPath = false;
        this.crowdTimer = 0;
        this.bestGoalDist = Infinity;
        this.lastX = x;
        this.lastY = y;

        // Gather cycle.
        this.gatherState = '';
        /** @type {RTSResource | null} */
        this.resource = null;
        /** @type {RTSBuilding | null} */
        this.dropoff = null;
        this.carrying = 0;
        this.gatherTimer = 0;
        /** @type {RTSWreck | null} */
        this.searchWreck = null;

        // Small guard leash: auto-acquired targets do not pull a unit across the map.
        this.guardX = x;
        this.guardY = y;
        this.commandLabel = 'Ожидание';
        this.moving = false;
        this.movingPhase = 0;
    }
}

class RTSBuilding {
    /** @param {number} id @param {string} team @param {string} type @param {number} x @param {number} y */
    constructor(id, team, type, x, y) {
        const d = RTS_DATA.BUILDINGS[type];
        this.kind = 'building';
        this.id = id;
        this.team = team;
        this.type = type;
        this.name = d.name;
        this.x = x;
        this.y = y;
        this.footprint = d.footprint.slice();
        this.radius = d.radius;
        this.health = d.hp;
        this.maxHealth = d.hp;
        this.armor = d.armor;
        this.sightRange = d.sight || 8;
        this.supply = d.supply || 0;
        this.dropoff = !!d.dropoff;
        this.train = d.train ? d.train.slice() : [];
        this.tower = type === 'tower';
        this.damage = d.damage || 0;
        this.attackRange = d.range || 0;
        this.attackCooldown = d.cooldown || 1;
        this.penetration = d.penetration || 0;
        this.buildingMultiplier = d.buildingMultiplier || 1;
        this.deadZone = d.deadZone || 0;
        this.splash = d.splash || null;
        this.attackTimer = 0;
        this.isSelectable = true;
        this.isAlive = true;
        this.isBuilt = false;
        this.buildProgress = 0;
        this.buildTime = d.time || 0;
        this.demolishing = false;
        this.demolishProgress = 0;
        this.demolishTotal = 0;
        /** @type {{type:string, remaining:number, total:number}[]} */
        this.productionQueue = [];
        /** @type {{x:number, y:number} | null} */
        this.rallyPoint = null;
        this.commandLabel = '';
    }
}

class RTSResource {
    /** @param {number} id @param {number} x @param {number} y @param {number} [amount] */
    constructor(id, x, y, amount) {
        this.kind = 'resource';
        this.id = id;
        this.team = '';
        this.type = 'crystal';
        this.name = 'Кристальная жила';
        this.x = x;
        this.y = y;
        this.radius = 2.2;
        const fallback = typeof RTS_RESOURCE_AMOUNT_MIN !== 'undefined' ? RTS_RESOURCE_AMOUNT_MIN : 500;
        this.amount = amount > 0 ? amount : fallback;
        this.maxAmount = this.amount;
        this.isSelectable = true;
        this.isAlive = true;
        this.commandLabel = 'Ресурс';
    }
}

class RTSWreck {
    /** @param {number} id @param {number} x @param {number} y @param {number} heading @param {number} reward */
    constructor(id, x, y, heading, reward) {
        this.kind = 'wreck';
        this.id = id;
        this.team = '';
        this.type = 'wreck';
        this.name = 'Обломки звездолёта';
        this.x = x;
        this.y = y;
        this.heading = heading || 0;
        this.radius = typeof RTS_WRECK_RADIUS !== 'undefined' ? RTS_WRECK_RADIUS : 3.5;
        this.reward = reward > 0 ? reward : 100;
        this.searched = false;
        /** @type {RTSUnit | null} */
        this.searchingUnit = null;
        this.searchProgress = 0;
        this.isSelectable = true;
        this.isAlive = true;
        this.commandLabel = 'Обломки';
    }
}
