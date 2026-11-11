// RTSMap.js — the RTS board: procedurally generated bases, crystal fields, hills,
// depressions, ponds, a starship wreck, trees, rocks, the walkability grid and A* pathfinding.
// Coordinates are map units.
// The 3D view gets the same data and multiplies positions by RTS_WORLD_SCALE.
//
// Static blockers (trees, rocks, crystal fields) and dynamic blockers (buildings under
// construction, finished buildings, depleted fields) are merged into one Uint8Array grid.
// Units do not enter the grid themselves: they path around it and separate locally.

class RTSMap {
    /** @param {{ seed?: number, size?: number }} [options] */
    constructor(options = {}) {
        const U = 'undefined';
        const size = options.size != null ? options.size : (typeof RTS_MAP_SIZE !== U ? RTS_MAP_SIZE : 600);
        this.size = Math.max(40, Math.round(size));
        this.scale = Math.max(1, typeof RTS_WORLD_SCALE !== U ? RTS_WORLD_SCALE : 8);
        const fixed = typeof RTS_MAP_SEED !== U ? RTS_MAP_SEED : 0;
        this.seed = options.seed != null ? (options.seed | 0) : (fixed > 0 ? fixed : RTSMap.randomSeed());
        this._rng = RTSMap.rng(this.seed);

        this._placeBases();
        this._makeRelief();
        this._makeResources();
        this._makeWreck();
        this._makeBuildPlan();

        this.playerStart = [{ type: 'hq', x: this.playerBase.x, y: this.playerBase.y }];
        this.enemyStart = [{ type: 'hq', x: this.enemyBase.x, y: this.enemyBase.y }];

        const enemyBlock = typeof RTS_ENEMY_BASE_BLOCK_RADIUS !== U ? RTS_ENEMY_BASE_BLOCK_RADIUS : 0.16;
        this.forbidden = [
            { x: this.enemyBase.x, y: this.enemyBase.y, radius: this.size * enemyBlock, team: 'player' }
        ];

        this.obstacles = [];
        this._buildScenery();

        this.grid = new Uint8Array(this.size * this.size);
        this.pathLight = new Uint8Array(this.size * this.size);
        this.pathHeavy = new Uint8Array(this.size * this.size);
        this._g = new Float32Array(this.size * this.size);
        this._came = new Int32Array(this.size * this.size);
        this._gMark = new Int32Array(this.size * this.size);
        this._closedMark = new Int32Array(this.size * this.size);
        this._search = 0;
        this._heap = [];

        const requestedCoarse = typeof RTS_PATH_COARSE_CELL !== U ? RTS_PATH_COARSE_CELL : 16;
        this._coarseCell = requestedCoarse > 0
            ? Math.max(2, Math.min(requestedCoarse, Math.max(2, Math.round(this.size / 64))))
            : 0;
        this._coarseSize = this._coarseCell ? Math.ceil(this.size / this._coarseCell) : 0;
        const coarseCells = this._coarseSize * this._coarseSize;
        this.pathCoarseLight = new Uint8Array(coarseCells);
        this.pathCoarseHeavy = new Uint8Array(coarseCells);
        this._coarseG = new Float32Array(coarseCells);
        this._coarseCame = new Int32Array(coarseCells);
        this._coarseClosed = new Uint8Array(coarseCells);
        this._coarseHeap = [];
        this.rebuildGrid([], []);
    }

    // Small deterministic PRNG. A fixed seed keeps the level readable between runs.
    static rng(seed) {
        let s = (seed | 0) >>> 0;
        if (!s) s = 0x9e3779b9;
        return () => {
            s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
            return ((s >>> 0) % 100000) / 100000;
        };
    }

    static randomSeed() {
        return ((Math.random() * 0x7ffffffe) | 0) + 1;
    }

    /** @param {number} size @returns {number} */
    static resourceCountForSize(size) {
        const U = 'undefined';
        const small = typeof RTS_MAP_SIZE_SMALL !== U ? RTS_MAP_SIZE_SMALL : 200;
        const medium = typeof RTS_MAP_SIZE_MEDIUM !== U ? RTS_MAP_SIZE_MEDIUM : 400;
        const nSmall = typeof RTS_RESOURCE_COUNT_SMALL !== U ? RTS_RESOURCE_COUNT_SMALL : 6;
        const nMedium = typeof RTS_RESOURCE_COUNT_MEDIUM !== U ? RTS_RESOURCE_COUNT_MEDIUM : 12;
        const nLarge = typeof RTS_RESOURCE_COUNT_LARGE !== U ? RTS_RESOURCE_COUNT_LARGE : 18;
        if (size <= small) return nSmall;
        if (size <= medium) return nMedium;
        return nLarge;
    }

    /** @param {number} size @returns {{ hills: number, depressions: number, water: number }} */
    static terrainCountsForSize(size) {
        const U = 'undefined';
        const small = typeof RTS_MAP_SIZE_SMALL !== U ? RTS_MAP_SIZE_SMALL : 200;
        const medium = typeof RTS_MAP_SIZE_MEDIUM !== U ? RTS_MAP_SIZE_MEDIUM : 400;
        const pick = (a, b, c) => (size <= small ? a : size <= medium ? b : c);
        return {
            hills: pick(
                typeof RTS_TERRAIN_HILLS_SMALL !== U ? RTS_TERRAIN_HILLS_SMALL : 3,
                typeof RTS_TERRAIN_HILLS_MEDIUM !== U ? RTS_TERRAIN_HILLS_MEDIUM : 5,
                typeof RTS_TERRAIN_HILLS_LARGE !== U ? RTS_TERRAIN_HILLS_LARGE : 7
            ),
            depressions: pick(
                typeof RTS_TERRAIN_DEPRESSIONS_SMALL !== U ? RTS_TERRAIN_DEPRESSIONS_SMALL : 2,
                typeof RTS_TERRAIN_DEPRESSIONS_MEDIUM !== U ? RTS_TERRAIN_DEPRESSIONS_MEDIUM : 3,
                typeof RTS_TERRAIN_DEPRESSIONS_LARGE !== U ? RTS_TERRAIN_DEPRESSIONS_LARGE : 4
            ),
            water: pick(
                typeof RTS_TERRAIN_WATER_SMALL !== U ? RTS_TERRAIN_WATER_SMALL : 1,
                typeof RTS_TERRAIN_WATER_MEDIUM !== U ? RTS_TERRAIN_WATER_MEDIUM : 2,
                typeof RTS_TERRAIN_WATER_LARGE !== U ? RTS_TERRAIN_WATER_LARGE : 3
            )
        };
    }

    // --- Generation ---------------------------------------------------------------

    _placeBases() {
        const U = 'undefined';
        const N = this.size, R = this._rng;
        const minDist = N * (typeof RTS_BASE_MIN_DISTANCE !== U ? RTS_BASE_MIN_DISTANCE : 0.6);
        const margin = N * 0.12;
        const maxR = Math.max(1, N / 2 - margin);
        const minR = Math.min(maxR, minDist / 2);
        const radius = Math.max(minR, Math.min(maxR, minR + N * (0.02 + R() * 0.04)));
        const angle = R() * Math.PI * 2;
        const dx = Math.cos(angle) * radius, dy = Math.sin(angle) * radius;
        this.playerBase = { x: N / 2 + dx, y: N / 2 + dy };
        this.enemyBase = { x: N / 2 - dx, y: N / 2 - dy };
        if (Math.hypot(dx * 2, dy * 2) < minDist - 1e-6) {
            console.warn('[RTS] map is too small for RTS_BASE_MIN_DISTANCE');
        }
    }

    _rand(min, max) {
        return min + this._rng() * (max - min);
    }

    _inside(x, y, radius, margin) {
        return x - radius >= margin && y - radius >= margin &&
            x + radius <= this.size - margin && y + radius <= this.size - margin;
    }

    _clearOfBases(x, y, gap) {
        return !this._nearBase(x, y, gap);
    }

    _inWater(x, y, pad = 0) {
        for (const w of this.relief ? this.relief.water : []) {
            if (Math.hypot(x - w.x, y - w.y) < w.radius + pad) return true;
        }
        return false;
    }

    _makeRelief() {
        const U = 'undefined';
        const N = this.size, R = this._rng;
        const counts = RTSMap.terrainCountsForSize(N);
        const baseClear = typeof RTS_TERRAIN_BASE_CLEARANCE !== U ? RTS_TERRAIN_BASE_CLEARANCE : 24;
        const margin = typeof RTS_TERRAIN_BORDER_MARGIN !== U ? RTS_TERRAIN_BORDER_MARGIN : 8;
        const waterGap = typeof RTS_TERRAIN_WATER_SPACING !== U ? RTS_TERRAIN_WATER_SPACING : 8;
        const water = [], hills = [], depressions = [];

        const free = (x, y, radius, list, gap) => {
            if (!this._inside(x, y, radius, margin)) return false;
            if (!this._clearOfBases(x, y, baseClear + radius)) return false;
            for (const f of list) {
                if (Math.hypot(x - f.x, y - f.y) < radius + f.radius + gap) return false;
            }
            return true;
        };

        for (let i = 0; i < counts.water; i++) {
            for (let attempt = 0; attempt < 2000; attempt++) {
                const radius = this._rand(
                    typeof RTS_TERRAIN_WATER_RADIUS_MIN !== U ? RTS_TERRAIN_WATER_RADIUS_MIN : 8,
                    typeof RTS_TERRAIN_WATER_RADIUS_MAX !== U ? RTS_TERRAIN_WATER_RADIUS_MAX : 16
                );
                const x = margin + radius + R() * (N - margin * 2 - radius * 2);
                const y = margin + radius + R() * (N - margin * 2 - radius * 2);
                if (!free(x, y, radius, water, waterGap)) continue;
                water.push({
                    x, y, radius,
                    depth: this._rand(
                        typeof RTS_TERRAIN_WATER_DEPTH_MIN !== U ? RTS_TERRAIN_WATER_DEPTH_MIN : 12,
                        typeof RTS_TERRAIN_WATER_DEPTH_MAX !== U ? RTS_TERRAIN_WATER_DEPTH_MAX : 24
                    )
                });
                break;
            }
        }

        for (let i = 0; i < counts.hills; i++) {
            for (let attempt = 0; attempt < 2000; attempt++) {
                const radius = this._rand(
                    typeof RTS_TERRAIN_HILL_RADIUS_MIN !== U ? RTS_TERRAIN_HILL_RADIUS_MIN : 18,
                    typeof RTS_TERRAIN_HILL_RADIUS_MAX !== U ? RTS_TERRAIN_HILL_RADIUS_MAX : 34
                );
                const x = margin + radius + R() * (N - margin * 2 - radius * 2);
                const y = margin + radius + R() * (N - margin * 2 - radius * 2);
                if (!free(x, y, radius, water, 4) || !free(x, y, radius, hills, 4)) continue;
                hills.push({
                    x, y, radius,
                    height: this._rand(
                        typeof RTS_TERRAIN_HILL_HEIGHT_MIN !== U ? RTS_TERRAIN_HILL_HEIGHT_MIN : 24,
                        typeof RTS_TERRAIN_HILL_HEIGHT_MAX !== U ? RTS_TERRAIN_HILL_HEIGHT_MAX : 48
                    )
                });
                break;
            }
        }

        for (let i = 0; i < counts.depressions; i++) {
            for (let attempt = 0; attempt < 2000; attempt++) {
                const radius = this._rand(
                    typeof RTS_TERRAIN_DEPRESSION_RADIUS_MIN !== U ? RTS_TERRAIN_DEPRESSION_RADIUS_MIN : 12,
                    typeof RTS_TERRAIN_DEPRESSION_RADIUS_MAX !== U ? RTS_TERRAIN_DEPRESSION_RADIUS_MAX : 26
                );
                const x = margin + radius + R() * (N - margin * 2 - radius * 2);
                const y = margin + radius + R() * (N - margin * 2 - radius * 2);
                if (!free(x, y, radius, water, 4) || !free(x, y, radius, depressions, 4)) continue;
                depressions.push({
                    x, y, radius,
                    depth: this._rand(
                        typeof RTS_TERRAIN_DEPRESSION_DEPTH_MIN !== U ? RTS_TERRAIN_DEPRESSION_DEPTH_MIN : 16,
                        typeof RTS_TERRAIN_DEPRESSION_DEPTH_MAX !== U ? RTS_TERRAIN_DEPRESSION_DEPTH_MAX : 32
                    )
                });
                break;
            }
        }

        this.relief = { hills, depressions, water };
    }

    _makeResources() {
        const U = 'undefined';
        const N = this.size, R = this._rng;
        const clearance = typeof RTS_RESOURCE_BASE_CLEARANCE !== U ? RTS_RESOURCE_BASE_CLEARANCE : 20;
        const spacing = typeof RTS_RESOURCE_SPACING !== U ? RTS_RESOURCE_SPACING : 20;
        const count = RTSMap.resourceCountForSize(N);
        const minAmount = typeof RTS_RESOURCE_AMOUNT_MIN !== U ? RTS_RESOURCE_AMOUNT_MIN : 500;
        const maxAmount = typeof RTS_RESOURCE_AMOUNT_MAX !== U ? RTS_RESOURCE_AMOUNT_MAX : 1000;
        const amountStep = typeof RTS_RESOURCE_AMOUNT_STEP !== U ? RTS_RESOURCE_AMOUNT_STEP : 10;
        const margin = 8;
        const sites = [];

        const ok = (x, y) => {
            if (x < margin || y < margin || x > N - margin || y > N - margin) return false;
            if (Math.hypot(x - this.playerBase.x, y - this.playerBase.y) < clearance) return false;
            if (Math.hypot(x - this.enemyBase.x, y - this.enemyBase.y) < clearance) return false;
            if (this._inWater(x, y, 2)) return false;
            for (const s of sites) if (Math.hypot(x - s.x, y - s.y) < spacing) return false;
            return true;
        };

        for (let attempt = 0; attempt < count * 4000 && sites.length < count; attempt++) {
            const x = margin + R() * (N - margin * 2);
            const y = margin + R() * (N - margin * 2);
            if (ok(x, y)) sites.push({ x, y });
        }
        if (sites.length < count) {
            console.warn('[RTS] placed only ' + sites.length + ' of ' + count + ' crystal fields');
        }

        const steps = Math.max(0, Math.floor((maxAmount - minAmount) / amountStep));
        for (const s of sites) {
            s.amount = minAmount + Math.floor(R() * (steps + 1)) * amountStep;
        }
        this.resourceSites = sites;
    }

    _makeWreck() {
        const U = 'undefined';
        const N = this.size, R = this._rng;
        const clearance = typeof RTS_WRECK_BASE_CLEARANCE !== U ? RTS_WRECK_BASE_CLEARANCE : 24;
        const radius = typeof RTS_WRECK_RADIUS !== U ? RTS_WRECK_RADIUS : 3.5;
        const margin = 10;
        const rewardMin = typeof RTS_WRECK_REWARD_MIN !== U ? RTS_WRECK_REWARD_MIN : 50;
        const rewardMax = typeof RTS_WRECK_REWARD_MAX !== U ? RTS_WRECK_REWARD_MAX : 200;
        const ok = (x, y) => {
            if (x < margin || y < margin || x > N - margin || y > N - margin) return false;
            if (!this._clearOfBases(x, y, clearance)) return false;
            if (this._inWater(x, y, radius)) return false;
            for (const r of this.resourceSites) {
                if (Math.hypot(x - r.x, y - r.y) < radius + 2.2 + 2) return false;
            }
            return true;
        };
        let x = N / 2, y = N / 2;
        for (let attempt = 0; attempt < 4000; attempt++) {
            const px = margin + R() * (N - margin * 2);
            const py = margin + R() * (N - margin * 2);
            if (ok(px, py)) { x = px; y = py; break; }
        }
        this.wreck = {
            x, y, radius,
            heading: R() * Math.PI * 2,
            reward: rewardMin + Math.floor(R() * (rewardMax - rewardMin + 1))
        };
    }

    _makeBuildPlan() {
        const base = this.enemyBase;
        const facing = Math.atan2(this.playerBase.y - base.y, this.playerBase.x - base.x);
        const cos = Math.cos(facing), sin = Math.sin(facing);
        const offsets = [
            { type: 'barracks', x: -10, y: -8 },
            { type: 'generator', x: 10, y: 8 },
            { type: 'depot', x: -10, y: 8 },
            { type: 'factory', x: 11, y: -7 },
            { type: 'tower', x: 0, y: 10 }
        ];
        this.enemyBuildPlan = offsets.map(o => ({
            type: o.type,
            x: base.x + o.x * cos - o.y * sin,
            y: base.y + o.x * sin + o.y * cos
        }));
    }

    px(x) { return x * this.scale; }

    // Distance from a point to a static rock/tree or an active crystal field.
    _blockedByScenery(x, y) {
        for (const o of this.obstacles) {
            if (Math.hypot(x - o.x, y - o.y) < o.radius * 0.55) return true;
        }
        return false;
    }

    _nearResource(x, y, gap) {
        for (const r of this.resourceSites) if (Math.hypot(x - r.x, y - r.y) < gap) return true;
        return false;
    }

    _nearBase(x, y, gap) {
        return Math.hypot(x - this.playerBase.x, y - this.playerBase.y) < gap ||
            Math.hypot(x - this.enemyBase.x, y - this.enemyBase.y) < gap;
    }

    _buildScenery() {
        const R = this._rng, N = this.size;

        // Rock ridges make readable lanes; a gap in the middle keeps A* a way through.
        const ridges = Math.max(2, Math.round(N / 250));
        for (let i = 0; i < ridges; i++) {
            const cx = N * (0.15 + R() * 0.7), cy = N * (0.15 + R() * 0.7);
            const angle = R() * Math.PI * 2;
            const length = N * (0.12 + R() * 0.18);
            const steps = Math.max(3, Math.round(length / (N * 0.04)));
            for (let j = 0; j < steps; j++) {
                const t = (j / (steps - 1) - 0.5) * length;
                if (Math.abs(t) < N * 0.03) continue;
                const x = cx + Math.cos(angle) * t + (R() - 0.5) * N * 0.01;
                const y = cy + Math.sin(angle) * t + (R() - 0.5) * N * 0.01;
                this._tryScenery(x, y, N * 0.0015 + R() * N * 0.0015, 'rock');
            }
        }

        // Forest pockets break sight lines and hide paths between the bases.
        const pockets = Math.max(6, Math.round(N / 35));
        for (let i = 0; i < pockets; i++) {
            const cx = N * (0.08 + R() * 0.84), cy = N * (0.08 + R() * 0.84);
            const radius = N * (0.025 + R() * 0.035);
            const count = Math.round(8 + R() * 16);
            for (let j = 0; j < count; j++) {
                const a = R() * Math.PI * 2, d = Math.sqrt(R()) * radius;
                this._tryScenery(cx + Math.cos(a) * d, cy + Math.sin(a) * d,
                    N * 0.0012 + R() * N * 0.0008, 'tree');
            }
        }

        // Edge belts: a dense frame keeps units inside the board visually.
        const edges = Math.round(N / 5);
        for (let i = 0; i < edges; i++) {
            const edge = i % 4;
            let x = N * (0.04 + R() * 0.92), y = N * (0.04 + R() * 0.92);
            if (edge === 0) x = N * (0.03 + R() * 0.1);
            else if (edge === 1) x = N * (0.87 + R() * 0.1);
            else if (edge === 2) y = N * (0.03 + R() * 0.1);
            else y = N * (0.87 + R() * 0.1);
            this._tryScenery(x, y, N * 0.0012 + R() * N * 0.0012, R() < 0.25 ? 'rock' : 'tree');
        }

        const rocks = Math.round(N / 6);
        for (let i = 0; i < rocks; i++) {
            this._tryScenery(N * (0.08 + R() * 0.84), N * (0.08 + R() * 0.84),
                N * 0.0015 + R() * N * 0.0015, 'rock');
        }

        this._baseOutskirts();
    }

    // A readable ring of props around each base: the starting camera is close, and the fog
    // reveal is small, so the base must not sit in an empty clearing.
    _baseOutskirts() {
        const U = 'undefined';
        const N = this.size, R = this._rng;
        const baseClear = typeof RTS_SCENERY_BASE_CLEARANCE !== U ? RTS_SCENERY_BASE_CLEARANCE : 24;
        const ring = Math.max(4, N * 0.02);
        for (const base of [this.playerBase, this.enemyBase]) {
            for (let i = 0; i < 20; i++) {
                const angle = R() * Math.PI * 2;
                const distance = baseClear + R() * ring;
                const kind = R() < 0.72 ? 'tree' : 'rock';
                this._tryScenery(
                    base.x + Math.cos(angle) * distance,
                    base.y + Math.sin(angle) * distance,
                    N * 0.0012 + R() * N * 0.0012,
                    kind
                );
            }
        }
    }

    _tryScenery(x, y, radius, kind) {
        const U = 'undefined';
        const N = this.size;
        const border = typeof RTS_SCENERY_BORDER_MARGIN !== U ? RTS_SCENERY_BORDER_MARGIN : 8;
        if (x - radius < border || y - radius < border || x + radius > N - border || y + radius > N - border) return;
        const baseClear = typeof RTS_SCENERY_BASE_CLEARANCE !== U ? RTS_SCENERY_BASE_CLEARANCE : 24;
        const resourceClear = typeof RTS_SCENERY_RESOURCE_CLEARANCE !== U ? RTS_SCENERY_RESOURCE_CLEARANCE : 6;
        if (this._nearBase(x, y, baseClear + radius)) return;
        if (this._nearResource(x, y, radius + resourceClear)) return;
        if (this._inWater(x, y, radius + 2)) return;
        if (this.wreck && Math.hypot(x - this.wreck.x, y - this.wreck.y) < radius + this.wreck.radius + 2) return;
        const gap = Math.max(1.3, N * 0.002);
        for (const o of this.obstacles) if (Math.hypot(x - o.x, y - o.y) < radius + o.radius + gap) return;
        this.obstacles.push({ x, y, radius, kind });
    }

    /** @param {Uint8Array} g */
    _markBorder(g) {
        const n = this.size;
        for (let i = 0; i < n; i++) {
            for (let k = 0; k < 2; k++) {
                g[i * n + k] = 1; g[i * n + (n - 1 - k)] = 1;
                g[k * n + i] = 1; g[(n - 1 - k) * n + i] = 1;
            }
        }
    }

    /** @param {Uint8Array} g @param {number} cx @param {number} cy @param {number} r */
    _markCircle(g, cx, cy, r) {
        const n = this.size;
        const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(n - 1, Math.ceil(cx + r));
        const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(n - 1, Math.ceil(cy + r));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) g[y * n + x] = 1;
            }
        }
    }

    /** @param {Uint8Array} g @param {number} cx @param {number} cy @param {number} w @param {number} h @param {number} pad */
    _markRect(g, cx, cy, w, h, pad) {
        const n = this.size;
        const hw = w / 2 + pad, hh = h / 2 + pad;
        const x0 = Math.max(0, Math.floor(cx - hw)), x1 = Math.min(n - 1, Math.ceil(cx + hw));
        const y0 = Math.max(0, Math.floor(cy - hh)), y1 = Math.min(n - 1, Math.ceil(cy + hh));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if (Math.abs(x + 0.5 - cx) <= hw && Math.abs(y + 0.5 - cy) <= hh) g[y * n + x] = 1;
            }
        }
    }

    /** @param {Uint8Array} g @param {number} obstaclePad @param {number} resourcePad @param {number} buildingPad @param {any[]} resources @param {any[]} buildings */
    _rebuildOne(g, obstaclePad, resourcePad, buildingPad, resources, buildings) {
        g.fill(0);
        this._markBorder(g);
        for (const o of this.obstacles) this._markCircle(g, o.x, o.y, o.radius + obstaclePad);
        for (const w of this.relief ? this.relief.water : []) this._markCircle(g, w.x, w.y, w.radius + obstaclePad);
        for (const r of resources || []) if (r.amount > 0) this._markCircle(g, r.x, r.y, r.radius + resourcePad);
        for (const b of buildings || []) {
            if (!b.isAlive) continue;
            const fp = RTS_DATA.BUILDINGS[b.type] ? RTS_DATA.BUILDINGS[b.type].footprint : [2, 2];
            this._markRect(g, b.x, b.y, fp[0], fp[1], buildingPad);
        }
    }

    // Recompute the walkability grids. The base grid is the building/spawn rule; the two path
    // grids inflate every blocker by the clearance of a light or a heavy unit.
    // resources — live RTSResource nodes; buildings — live RTSBuilding records (a footprint
    // blocks even while the building is under construction).
    rebuildGrid(resources, buildings) {
        this._rebuildOne(this.grid, 0.8, 0.8, RTS_BUILD_CLEARANCE, resources, buildings);
        this._rebuildOne(this.pathLight, RTS_PATH_LIGHT_RADIUS, RTS_PATH_LIGHT_RADIUS, RTS_PATH_LIGHT_RADIUS, resources, buildings);
        this._rebuildOne(this.pathHeavy, RTS_PATH_HEAVY_RADIUS, RTS_PATH_HEAVY_RADIUS, RTS_PATH_HEAVY_RADIUS, resources, buildings);
        if (this._coarseCell) {
            this._rebuildCoarse(this.pathLight, this.pathCoarseLight);
            this._rebuildCoarse(this.pathHeavy, this.pathCoarseHeavy);
        }
    }

    // Water must not cut the board in two. Rebuild the grids with the live blockers and drop
    // the last pond until the bases are connected again.
    /** @param {any[]} resources @param {any[]} buildings */
    ensureBasesConnected(resources, buildings) {
        const water = this.relief ? this.relief.water : [];
        for (let guard = 0; guard <= water.length; guard++) {
            this.rebuildGrid(resources || [], buildings || []);
            const path = this.findPath(this.playerBase.x, this.playerBase.y,
                this.enemyBase.x, this.enemyBase.y, false);
            if (path.length || !water.length) return path.length > 0;
            water.pop();
        }
        return false;
    }

    /** @param {Uint8Array} fine @param {Uint8Array} coarse */
    _rebuildCoarse(fine, coarse) {
        const n = this.size, cell = this._coarseCell, cn = this._coarseSize;
        for (let cy = 0; cy < cn; cy++) {
            for (let cx = 0; cx < cn; cx++) {
                const x0 = cx * cell, y0 = cy * cell;
                const x1 = Math.min(n, x0 + cell), y1 = Math.min(n, y0 + cell);
                let blocked = 0;
                for (let y = y0; y < y1 && !blocked; y++) {
                    for (let x = x0; x < x1; x++) {
                        if (fine[y * n + x]) { blocked = 1; break; }
                    }
                }
                coarse[cy * cn + cx] = blocked;
            }
        }
    }

    cellFree(cx, cy) {
        const n = this.size;
        return cx >= 0 && cy >= 0 && cx < n && cy < n && this.grid[cy * n + cx] === 0;
    }

    freePoint(x, y) {
        return this.cellFree(Math.floor(x), Math.floor(y));
    }

    // Nearest free cell centre; the search is bounded, so a unit near a wall still gets a
    // sensible fallback instead of a path that starts inside a rock.
    nearestFreeCell(cx, cy, maxRadius = 10) {
        const n = this.size;
        cx = Math.max(0, Math.min(n - 1, Math.floor(cx)));
        cy = Math.max(0, Math.min(n - 1, Math.floor(cy)));
        if (this.cellFree(cx, cy)) return { x: cx, y: cy };
        for (let r = 1; r <= maxRadius; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                    const x = cx + dx, y = cy + dy;
                    if (this.cellFree(x, y)) return { x, y };
                }
            }
        }
        return null;
    }

    nearestFreePoint(x, y, maxRadius = 10) {
        const c = this.nearestFreeCell(x, y, maxRadius);
        return c ? { x: c.x + 0.5, y: c.y + 0.5 } : null;
    }

    // Straight walkability test between two points (used to smooth A* corners).
    lineFree(x0, y0, x1, y1) {
        const d = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.ceil(d / 0.45));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            if (!this.cellFree(Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t))) return false;
        }
        return true;
    }

    /** @param {number} cx @param {number} cy @param {boolean} heavy */
    cellFreeFor(cx, cy, heavy) {
        const n = this.size;
        const g = heavy ? this.pathHeavy : this.pathLight;
        return cx >= 0 && cy >= 0 && cx < n && cy < n && g[cy * n + cx] === 0;
    }

    /** @param {number} cx @param {number} cy @param {number} maxRadius @param {boolean} heavy */
    nearestFreeCellFor(cx, cy, maxRadius, heavy) {
        const n = this.size;
        cx = Math.max(0, Math.min(n - 1, Math.floor(cx)));
        cy = Math.max(0, Math.min(n - 1, Math.floor(cy)));
        if (this.cellFreeFor(cx, cy, heavy)) return { x: cx, y: cy };
        for (let r = 1; r <= maxRadius; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                    const x = cx + dx, y = cy + dy;
                    if (this.cellFreeFor(x, y, heavy)) return { x, y };
                }
            }
        }
        return null;
    }

    /** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {boolean} heavy */
    lineFreeFor(x0, y0, x1, y1, heavy) {
        const d = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.ceil(d / 0.45));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            if (!this.cellFreeFor(Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t), heavy)) return false;
        }
        return true;
    }

    /** @param {number} x @param {number} y @param {Uint8Array} blocked @returns {{x:number,y:number}|null} */
    _nearestCoarseCell(x, y, blocked) {
        const cn = this._coarseSize, cell = this._coarseCell;
        const cx = Math.max(0, Math.min(cn - 1, Math.floor(x / cell)));
        const cy = Math.max(0, Math.min(cn - 1, Math.floor(y / cell)));
        if (!blocked[cy * cn + cx]) return { x: cx, y: cy };
        for (let r = 1; r <= 6; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                    const nx = cx + dx, ny = cy + dy;
                    if (nx >= 0 && ny >= 0 && nx < cn && ny < cn && !blocked[ny * cn + nx]) {
                        return { x: nx, y: ny };
                    }
                }
            }
        }
        return null;
    }

    // Long paths go through a coarse grid first: on the default 600 x 600 board the fine A* expands
    // hundreds of thousands of cells across the map. The coarse cells are conservative (a
    // cell is blocked when ANY fine cell inside it is blocked), so the result is safe for the
    // unit's clearance; the fine line-of-sight pass turns it into smooth waypoints.
    /** @param {number} sx @param {number} sy @param {number} tx @param {number} ty @param {boolean} heavy @returns {{x:number,y:number}[]} */
    _findPathCoarse(sx, sy, tx, ty, heavy) {
        const cell = this._coarseCell, cn = this._coarseSize;
        if (!cell || !cn) return [];
        const blocked = heavy ? this.pathCoarseHeavy : this.pathCoarseLight;
        const start = this._nearestCoarseCell(sx, sy, blocked);
        const goal = this._nearestCoarseCell(tx, ty, blocked);
        if (!start || !goal) return [];
        const s = start.y * cn + start.x, goalIdx = goal.y * cn + goal.x;
        if (s === goalIdx) return [{ x: tx, y: ty }];

        const total = cn * cn;
        const g = this._coarseG, came = this._coarseCame, closed = this._coarseClosed;
        g.fill(Infinity); came.fill(-1); closed.fill(0);
        const heap = this._coarseHeap;
        heap.length = 0;
        const push = (idx, f) => {
            heap.push({ idx, f });
            let i = heap.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (heap[p].f <= heap[i].f) break;
                const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
            }
        };
        const pop = () => {
            const top = heap[0], last = heap.pop();
            if (heap.length && last) {
                heap[0] = last;
                let i = 0;
                for (;;) {
                    const l = i * 2 + 1, r = l + 1;
                    let best = i;
                    if (l < heap.length && heap[l].f < heap[best].f) best = l;
                    if (r < heap.length && heap[r].f < heap[best].f) best = r;
                    if (best === i) break;
                    const t = heap[i]; heap[i] = heap[best]; heap[best] = t; i = best;
                }
            }
            return top;
        };
        const h = (x, y) => {
            const dx = Math.abs(x - goal.x), dy = Math.abs(y - goal.y);
            return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
        };
        const dirs = [
            [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
            [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]
        ];
        g[s] = 0;
        push(s, h(start.x, start.y));
        let found = false, guard = 0;
        while (heap.length && guard++ < total * 4) {
            const cur = pop();
            if (!cur) break;
            const ci = cur.idx;
            if (closed[ci]) continue;
            closed[ci] = 1;
            if (ci === goalIdx) { found = true; break; }
            const cx = ci % cn, cy = (ci / cn) | 0;
            for (const [dx, dy, cost] of dirs) {
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= cn || ny >= cn || blocked[ny * cn + nx]) continue;
                if (dx && dy && (blocked[cy * cn + nx] || blocked[ny * cn + cx])) continue;
                const ni = ny * cn + nx;
                if (closed[ni]) continue;
                const ng = g[ci] + cost;
                if (ng < g[ni]) {
                    g[ni] = ng;
                    came[ni] = ci;
                    push(ni, ng + h(nx, ny));
                }
            }
        }
        if (!found) return [];

        const raw = [];
        for (let i = goalIdx; i >= 0; i = came[i]) {
            raw.push({ x: (i % cn) * cell + cell / 2, y: ((i / cn) | 0) * cell + cell / 2 });
            if (i === s) break;
        }
        raw.reverse();

        // Drop collinear cells: the coarse path is a chain of cell centres and the steering
        // only needs the corners. Coarse cells are conservative (blocked when ANY fine cell
        // inside is blocked), so the segments stay clear of the fine grid.
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            if (i > 0 && i < raw.length - 1) {
                const a = raw[i - 1], b = raw[i], c = raw[i + 1];
                const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
                if (Math.abs(cross) < 1e-6) continue;
            }
            out.push(raw[i]);
        }
        out.push({ x: tx, y: ty });
        // Only the first and last hops leave the coarse cells; verify them on the fine grid.
        if (!this.lineFreeFor(sx, sy, out[0].x, out[0].y, heavy)) return [];
        if (!this.lineFreeFor(out[out.length - 2].x, out[out.length - 2].y, tx, ty, heavy)) return [];
        return out;
    }

    // Search stamps: a path request marks the cells it touches instead of clearing the whole
    // grid. On the default 600 x 600 board the old fill() of three arrays cost millions of writes
    // per request.
    _nextSearch() {
        this._search = (this._search + 1) | 0;
        if (this._search <= 0) {
            this._gMark.fill(0);
            this._closedMark.fill(0);
            this._search = 1;
        }
        return this._search;
    }

    // A* over the 8-neighbour grid. Returns smoothed waypoints in map units; [] — no route.
    // heavy selects the clearance grid of a large unit.
    findPath(sx, sy, tx, ty, heavy = false) {
        const n = this.size, total = n * n;
        // The unit may stand inside the inflated clearance of a nearby blocker (it is still
        // outside the real obstacle). Starting the search from its own cell avoids a long
        // detour to the nearest free cell on the far side of that blocker.
        const start = {
            x: Math.max(0, Math.min(n - 1, Math.floor(sx))),
            y: Math.max(0, Math.min(n - 1, Math.floor(sy)))
        };
        const goal = this.nearestFreeCellFor(tx, ty, 10, heavy);
        if (!goal) return [];
        const s = start.y * n + start.x, goalIdx = goal.y * n + goal.x;
        if (s === goalIdx) return [{ x: goal.x + 0.5, y: goal.y + 0.5 }];

        // A clear straight line is the common case on an open board; no search is needed.
        if (this.lineFreeFor(sx, sy, tx, ty, heavy)) return [{ x: tx, y: ty }];
        const distance = Math.hypot(tx - sx, ty - sy);
        const coarseMin = typeof RTS_PATH_COARSE_MIN !== 'undefined' ? RTS_PATH_COARSE_MIN : 40;
        if (this._coarseCell && distance >= coarseMin) {
            const coarse = this._findPathCoarse(sx, sy, tx, ty, heavy);
            if (coarse.length) return coarse;
        }

        const g = this._g, came = this._came;
        const gMark = this._gMark, closedMark = this._closedMark;
        const search = this._nextSearch();
        const heap = this._heap;
        heap.length = 0;
        const push = (idx, f) => {
            heap.push({ idx, f });
            let i = heap.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (heap[p].f <= heap[i].f) break;
                const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
            }
        };
        const pop = () => {
            const top = heap[0], last = heap.pop();
            if (heap.length && last) {
                heap[0] = last;
                let i = 0;
                for (;;) {
                    const l = i * 2 + 1, r = l + 1;
                    let best = i;
                    if (l < heap.length && heap[l].f < heap[best].f) best = l;
                    if (r < heap.length && heap[r].f < heap[best].f) best = r;
                    if (best === i) break;
                    const t = heap[i]; heap[i] = heap[best]; heap[best] = t; i = best;
                }
            }
            return top;
        };
        const hx = goal.x, hy = goal.y;
        const h = (x, y) => {
            const dx = Math.abs(x - hx), dy = Math.abs(y - hy);
            return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
        };
        const dirs = [
            [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
            [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]
        ];
        g[s] = 0;
        gMark[s] = search;
        push(s, h(start.x, start.y));
        let found = false, guard = 0;
        while (heap.length && guard++ < total * 4) {
            const cur = pop();
            if (!cur) break;
            const ci = cur.idx;
            if (closedMark[ci] === search) continue;
            closedMark[ci] = search;
            if (ci === goalIdx) { found = true; break; }
            const cx = ci % n, cy = (ci / n) | 0;
            for (const [dx, dy, cost] of dirs) {
                const nx = cx + dx, ny = cy + dy;
                if (!this.cellFreeFor(nx, ny, heavy)) continue;
                // No diagonal cuts through the corner of a blocked cell.
                if (dx && dy && (!this.cellFreeFor(cx + dx, cy, heavy) || !this.cellFreeFor(cx, cy + dy, heavy))) continue;
                const ni = ny * n + nx;
                if (closedMark[ni] === search) continue;
                const ng = g[ci] + cost;
                if (gMark[ni] !== search || ng < g[ni]) {
                    g[ni] = ng;
                    gMark[ni] = search;
                    came[ni] = ci;
                    push(ni, ng + h(nx, ny));
                }
            }
        }
        if (!found) return [];
        const raw = [];
        for (let i = goalIdx; i >= 0; i = came[i]) {
            raw.push({ x: (i % n) + 0.5, y: ((i / n) | 0) + 0.5 });
            if (i === s) break;
        }
        raw.reverse();
        if (this.cellFreeFor(Math.floor(tx), Math.floor(ty), heavy)) raw.push({ x: tx, y: ty });

        // Smooth: keep a waypoint only when the straight line to the next one is blocked.
        const out = [];
        let anchor = { x: sx, y: sy };
        for (let i = 0; i < raw.length; i++) {
            const p = raw[i];
            if (this.lineFreeFor(anchor.x, anchor.y, p.x, p.y, heavy)) {
                if (i === raw.length - 1) out.push(p);
            } else {
                const prev = raw[Math.max(0, i - 1)];
                out.push(prev);
                anchor = prev;
                if (!this.lineFreeFor(anchor.x, anchor.y, p.x, p.y, heavy)) out.push(p);
            }
        }
        if (!out.length) out.push(raw[raw.length - 1]);
        return out;
    }

    // --- Building placement -------------------------------------------------------

    static rectCircle(x, y, w, h, cx, cy, r) {
        const nx = Math.max(x - w / 2, Math.min(cx, x + w / 2));
        const ny = Math.max(y - h / 2, Math.min(cy, y + h / 2));
        return Math.hypot(cx - nx, cy - ny) < r;
    }

    static rectRect(ax, ay, aw, ah, bx, by, bw, bh) {
        return Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh;
    }

    // team — the builder; world — RTSWorld (resources, buildings, units).
    canBuild(team, type, x, y, world) {
        const def = RTS_DATA.BUILDINGS[type];
        if (!def) return false;
        const w = def.footprint[0], h = def.footprint[1];
        const m = RTS_BUILD_MARGIN + Math.max(w, h) / 2;
        if (x < m || y < m || x > this.size - m || y > this.size - m) return false;
        for (const z of this.forbidden) {
            if (z.team && z.team !== team) continue;
            if (RTSMap.rectCircle(x, y, w, h, z.x, z.y, z.radius)) return false;
        }
        for (const o of this.obstacles) {
            if (RTSMap.rectCircle(x, y, w, h, o.x, o.y, o.radius + RTS_BUILD_CLEARANCE)) return false;
        }
        for (const water of this.relief ? this.relief.water : []) {
            if (RTSMap.rectCircle(x, y, w, h, water.x, water.y, water.radius + RTS_BUILD_CLEARANCE)) return false;
        }
        for (const r of world.resources) {
            if (r.amount > 0 && RTSMap.rectCircle(x, y, w, h, r.x, r.y, r.radius + RTS_BUILD_CLEARANCE)) return false;
        }
        for (const b of world.buildings) {
            const fp = RTS_DATA.BUILDINGS[b.type].footprint;
            if (RTSMap.rectRect(x, y, w + RTS_BUILD_CLEARANCE * 2, h + RTS_BUILD_CLEARANCE * 2,
                b.x, b.y, fp[0], fp[1])) return false;
        }
        for (const u of world.units) {
            if (!u.isAlive) continue;
            if (RTSMap.rectCircle(x, y, w, h, u.x, u.y, u.radius + 0.4)) return false;
        }
        return true;
    }

    // Nearest free spot for a building around the planned point. The same canBuild rules as
    // the player: nothing is bypassed, the search only moves the building a little.
    findBuildSpot(team, type, x, y, world, maxRadius = 10) {
        if (this.canBuild(team, type, x, y, world)) return { x, y };
        for (let r = 2; r <= maxRadius; r += 2) {
            for (let i = 0; i < 16; i++) {
                const a = (i / 16) * Math.PI * 2;
                const px = x + Math.cos(a) * r;
                const py = y + Math.sin(a) * r;
                if (this.canBuild(team, type, px, py, world)) return { x: px, y: py };
            }
        }
        return null;
    }

    // A free spot around a building for a freshly produced unit.
    spawnPoint(building, world) {
        const def = RTS_DATA.BUILDINGS[building.type];
        const reach = Math.max(def.footprint[0], def.footprint[1]) / 2 + 2.2;
        for (let ring = 0; ring < 4; ring++) {
            for (let i = 0; i < 12; i++) {
                const a = (i / 12) * Math.PI * 2 + ring * 0.26;
                const x = building.x + Math.cos(a) * (reach + ring * 1.4);
                const y = building.y + Math.sin(a) * (reach + ring * 1.4);
                if (x < 3 || y < 3 || x > this.size - 3 || y > this.size - 3) continue;
                if (!this.freePoint(x, y)) continue;
                let busy = false;
                for (const u of world.units) {
                    if (u.isAlive && Math.hypot(u.x - x, u.y - y) < u.radius + 1.1) { busy = true; break; }
                }
                if (!busy) return { x, y };
            }
        }
        return this.nearestFreePoint(building.x, building.y, 12) || { x: building.x, y: building.y + 3 };
    }

    // Landing points around a ground point: a compact grid, each safe spot nudged out of
    // rocks, water and buildings. Points are returned in distance order.
    formation(n, x, y, world, gap = RTS_MOVE_SPACING) {
        const out = [];
        if (n <= 0) return out;
        const snap = (px, py) => {
            const fx = Math.max(3, Math.min(this.size - 3, px));
            const fy = Math.max(3, Math.min(this.size - 3, py));
            if (this.freePoint(fx, fy)) return { x: fx, y: fy };
            // A click in a pond or on a rock must still give a reachable point: search far
            // enough to cross the largest water circle (radius up to 16 map units).
            return this.nearestFreePoint(fx, fy, 32) || { x: fx, y: fy };
        };
        if (n === 1) return [snap(x, y)];
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        let i = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols && i < n; c++, i++) {
                const px = x + (c - (cols - 1) / 2) * gap;
                const py = y + (r - (rows - 1) / 2) * gap;
                out.push(snap(px, py));
            }
        }
        out.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
        return out;
    }
}
