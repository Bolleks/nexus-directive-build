// RTSView.js — the Babylon presentation of the RTS world. It owns only meshes, materials,
// selection rings, health bars, ground markers, tracers and short-lived effects; the truth
// lives in RTSWorld. No input and no game rules here.
//
// Positions are converted from map units to world px by RTS_WORLD_SCALE. Health bars and
// markers use rendering group OVERLAY and a material depth test of ALWAYS, so terrain and
// units never cut them. Selection rings are OVERLAY too but keep the depth test: a unit or
// a building hides the arc behind it instead of the ring painting over it. Every temporary
// mesh is disposed when its effect ends.

class RTSView {
    /** @param {Location3D} location @param {RTSMap} map @param {RTSWorld} world */
    constructor(location, map, world) {
        this.location = location;
        this.scene = location.view.scene;
        this.terrain = location.terrain;
        this.map = map;
        this.world = world;
        this.scale = map.scale;

        this.materials = new Map();      // colour key -> StandardMaterial
        this.unlit = new Map();          // colour key -> unlit material (bars, markers)
        this.unitVisuals = new Map();    // id -> { root, bar, turret?, upper?, legL?, … }
        this.buildingVisuals = new Map();
        this.resourceVisuals = new Map();
        this.wreckVisuals = new Map();
        this.waterMeshes = [];
        /** @type {Map<number, { mesh: BABYLON.Mesh, base: Float32Array, positions: Float32Array, x: number, y: number }>} */
        this.selectionRings = new Map();
        /** @type {Map<string, number>} */
        this.selectionRadii = new Map();   // type -> half the model's horizontal diagonal
        this.debugCircles = [];
        this.effects = [];
        this.scenery = [];
        this.selectedIds = new Set();
        /** @type {RTSFog | null} */
        this.fog = null;

        this._barBg = this._barMaterial('bar-bg', '#07121a', 0.78);
        this._barGreen = this._barMaterial('bar-green', '#6ef28b', 0.95);
        this._barYellow = this._barMaterial('bar-yellow', '#ffd15a', 0.95);
        this._barRed = this._barMaterial('bar-red', '#ff625c', 0.95);
        this._barBlue = this._barMaterial('bar-blue', '#4fc8ff', 0.95);
        this._ghostValid = this._ghostMaterial('ghost-valid', '#67ff9a');
        this._ghostInvalid = this._ghostMaterial('ghost-invalid', '#ff5757');

        this.ghost = null;
        this.ghostType = '';
        this.ghostTeam = '';
        this.ghostValid = true;

        this._buildWater();
        this._buildScenery();
        this._buildBorder();
        try {
            this.fog = new RTSFog(this.scene, this.map, this.world);
        } catch (err) {
            this.fog = null;
            console.warn('[RTS] fog of war is disabled:', err);
        }
    }

    /**
     * Text and percentage shown above a producing building.
     * @param {{type:string, remaining:number, total:number}[]} queue
     */
    static productionSummary(queue) {
        const list = queue || [];
        if (!list.length) return { current: '', percent: 0, queueText: '' };
        const first = RTS_DATA.UNITS[list[0].type];
        const total = Math.max(0.01, list[0].total || 0);
        const percent = Math.round(Math.max(0, Math.min(1, 1 - list[0].remaining / total)) * 100);
        const groups = [];
        const index = new Map();
        for (const q of list) {
            const def = RTS_DATA.UNITS[q.type];
            if (!def) continue;
            let group = index.get(q.type);
            if (!group) {
                group = { name: def.name, count: 0 };
                index.set(q.type, group);
                groups.push(group);
            }
            group.count++;
        }
        return {
            current: first ? first.name : '',
            percent,
            queueText: groups.map(g => g.name + ' ×' + g.count).join(', ')
        };
    }

    // --- Materials ---------------------------------------------------------------

    _mat(color, glow) {
        const key = color + (glow ? '|glow' : '');
        let m = this.materials.get(key);
        if (m) return m;
        m = new BABYLON.StandardMaterial('rts-mat-' + key, this.scene);
        m.diffuseColor = BABYLON.Color3.FromHexString(color);
        m.specularColor = new BABYLON.Color3(0, 0, 0);
        m.specularPower = 24;
        if (glow) {
            m.emissiveColor = BABYLON.Color3.FromHexString(color).scale(0.35);
        }
        this.materials.set(key, m);
        return m;
    }

    // A saturated screen (gate strips, beacons): black diffuse with a full emissive colour,
    // so the toon bands do not wash it out.
    _emissive(key, color) {
        const cacheKey = 'emissive|' + key;
        let m = this.materials.get(cacheKey);
        if (m) return m;
        m = new BABYLON.StandardMaterial('rts-emissive-' + key, this.scene);
        m.diffuseColor = new BABYLON.Color3(0, 0, 0);
        m.emissiveColor = BABYLON.Color3.FromHexString(color);
        m.specularColor = new BABYLON.Color3(0, 0, 0);
        this.materials.set(cacheKey, m);
        return m;
    }

    /** @param {string} color @param {number} [alpha] @param {boolean} [testDepth] */
    _unlitMaterial(color, alpha, testDepth) {
        const key = color + '|' + (alpha == null ? 1 : alpha) + (testDepth ? '|depth' : '');
        let m = this.unlit.get(key);
        if (m) return m;
        m = new BABYLON.StandardMaterial('rts-unlit-' + key, this.scene);
        m.disableLighting = true;
        m.diffuseColor = new BABYLON.Color3(0, 0, 0);
        m.emissiveColor = BABYLON.Color3.FromHexString(color);
        m.alpha = alpha == null ? 1 : alpha;
        m.disableDepthWrite = true;
        m.depthFunction = testDepth ? BABYLON.Engine.LEQUAL : BABYLON.Engine.ALWAYS;
        m.backFaceCulling = false;
        this.unlit.set(key, m);
        return m;
    }

    _barMaterial(name, color, alpha) {
        const m = new BABYLON.StandardMaterial('rts-' + name, this.scene);
        m.disableLighting = true;
        m.diffuseColor = new BABYLON.Color3(0, 0, 0);
        m.emissiveColor = BABYLON.Color3.FromHexString(color);
        m.alpha = alpha;
        m.disableDepthWrite = true;
        m.depthFunction = BABYLON.Engine.ALWAYS;
        m.backFaceCulling = false;
        return m;
    }

    _ghostMaterial(name, color) {
        const m = new BABYLON.StandardMaterial('rts-' + name, this.scene);
        m.disableLighting = true;
        m.diffuseColor = new BABYLON.Color3(0, 0, 0);
        m.emissiveColor = BABYLON.Color3.FromHexString(color);
        m.alpha = 0.36;
        m.disableDepthWrite = true;
        m.depthFunction = BABYLON.Engine.ALWAYS;
        m.backFaceCulling = false;
        return m;
    }

    _box(root, name, w, h, d, x, y, z, mat) {
        const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
        m.material = mat;
        m.parent = root;
        m.position.set(x, y, z);
        return m;
    }

    _cyl(root, name, height, top, bottom, x, y, z, mat, tess) {
        const m = BABYLON.MeshBuilder.CreateCylinder(name, {
            height, diameterTop: top, diameterBottom: bottom, tessellation: tess || 10
        }, this.scene);
        m.material = mat;
        m.parent = root;
        m.position.set(x, y, z);
        return m;
    }

    _sphere(root, name, diameter, x, y, z, mat, segments) {
        const m = BABYLON.MeshBuilder.CreateSphere(name, { diameter, segments: segments || 8 }, this.scene);
        m.material = mat;
        m.parent = root;
        m.position.set(x, y, z);
        return m;
    }

    _torus(root, name, diameter, thickness, x, y, z, mat, tess) {
        const m = BABYLON.MeshBuilder.CreateTorus(name, {
            diameter, thickness, tessellation: tess || 14
        }, this.scene);
        m.material = mat;
        m.parent = root;
        m.position.set(x, y, z);
        return m;
    }

    _poly(root, name, type, size, x, y, z, mat, sy) {
        const m = BABYLON.MeshBuilder.CreatePolyhedron(name, { type, size }, this.scene);
        m.material = mat;
        m.parent = root;
        m.position.set(x, y, z);
        if (sy) m.scaling.y = sy;
        return m;
    }

    // A faceted boulder: an icosphere with flat normals, squashed and turned by the caller.
    _rock(root, name, size, x, y, z, mat, sx, sy, sz, rotY, rotZ) {
        const m = BABYLON.MeshBuilder.CreateIcoSphere(name, {
            radius: size, subdivisions: 1
        }, this.scene);
        m.material = mat;
        m.parent = root;
        m.position.set(x, y, z);
        m.scaling.set(sx, sy, sz);
        m.rotation.set(0, rotY || 0, rotZ || 0);
        m.convertToFlatShadedMesh();
        return m;
    }

    // One faceted crystal: a base ring, a shoulder ring and a pyramid apex. Every triangle
    // is emitted with its own vertices and an outward normal, so the facets stay flat.
    // Winding is counter-clockwise from outside; the material flag is set on the mesh.
    _crystalShard(parent, name, o) {
        const sides = o.sides || 6;
        const radius = o.radius;
        const bodyH = o.bodyH;
        const shoulder = o.shoulder != null ? o.shoulder : radius * 0.72;
        const tipH = o.tipH;
        const shard = new BABYLON.Mesh(name, this.scene);
        shard.parent = parent;
        shard.position.set(o.x || 0, o.y || 0, o.z || 0);
        shard.rotation.set(o.rotX || 0, o.rotY || 0, o.rotZ || 0);

        const base = [], shoulderRing = [];
        for (let i = 0; i < sides; i++) {
            const a = Math.PI * 2 * i / sides + (o.twist || 0);
            const w = 1 + (o.wobble || 0) * Math.sin(i * 2.3 + (o.seed || 0));
            base.push([Math.cos(a) * radius * w, 0, Math.sin(a) * radius * w]);
            const w2 = 1 + (o.wobble || 0) * 0.5 * Math.sin(i * 1.7 + 1.3 + (o.seed || 0));
            shoulderRing.push([Math.cos(a) * shoulder * w2, bodyH, Math.sin(a) * shoulder * w2]);
        }
        const apex = [o.apexX || 0, bodyH + tipH, o.apexZ || 0];

        const bodyPos = [], bodyNrm = [], bodyIdx = [];
        const tipPos = [], tipNrm = [], tipIdx = [];
        const add = (pos, nrm, idx, a, b, c) => {
            const ab = new BABYLON.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            const ac = new BABYLON.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
            const n = BABYLON.Vector3.Cross(ab, ac).normalize();
            const at = pos.length / 3;
            pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
            nrm.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
            idx.push(at, at + 1, at + 2);
        };
        for (let i = 0; i < sides; i++) {
            const j = (i + 1) % sides;
            add(bodyPos, bodyNrm, bodyIdx, base[i], shoulderRing[j], base[j]);
            add(bodyPos, bodyNrm, bodyIdx, base[i], shoulderRing[i], shoulderRing[j]);
            add(tipPos, tipNrm, tipIdx, shoulderRing[i], apex, shoulderRing[j]);
            add(bodyPos, bodyNrm, bodyIdx, [0, 0, 0], base[i], base[j]);
        }

        const facet = (suffix, pos, nrm, idx, mat) => {
            const m = new BABYLON.Mesh(name + suffix, this.scene);
            const vd = new BABYLON.VertexData();
            vd.positions = pos;
            vd.normals = nrm;
            vd.indices = idx;
            vd.applyToMesh(m);
            m.material = mat;
            m.parent = shard;
            m.sideOrientation = BABYLON.Material.CounterClockWiseSideOrientation;
            return m;
        };
        facet('-body', bodyPos, bodyNrm, bodyIdx, o.mat);
        facet('-tip', tipPos, tipNrm, tipIdx, o.tipMat);
        return shard;
    }

    // A box stretched between two points: limbs keep their length whatever the pose.
    _limb(root, name, a, b, w, d, mat) {
        const from = new BABYLON.Vector3(a[0], a[1], a[2]);
        const to = new BABYLON.Vector3(b[0], b[1], b[2]);
        const dir = to.subtract(from);
        const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: dir.length(), depth: d }, this.scene);
        m.material = mat;
        m.parent = root;
        m.position.copyFrom(from.add(to).scale(0.5));
        const q = new BABYLON.Quaternion();
        BABYLON.Quaternion.FromUnitVectorsToRef(BABYLON.Axis.Y, dir.normalize(), q);
        m.rotationQuaternion = q;
        return m;
    }

    // One draw call per material instead of one per part: the infantryman is built from
    // dozens of boxes and would otherwise cost a draw call and an ink pass for each.
    _mergeParts(root) {
        const groups = new Map();
        for (const m of root.getChildMeshes()) {
            if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
            const mat = m.material;
            if (!groups.has(mat)) groups.set(mat, []);
            groups.get(mat).push(m);
        }
        for (const [mat, list] of groups) {
            const merged = BABYLON.Mesh.MergeMeshes(/** @type {BABYLON.Mesh[]} */ (list), true, true);
            if (!merged) continue;
            merged.material = mat;
            merged.setParent(root);
        }
        for (const m of root.getChildMeshes()) {
            if (!m.getTotalVertices || m.getTotalVertices() === 0) m.dispose();
        }
    }

    // A movable part group: build the boxes in a scratch root at standing coordinates, merge
    // them by material, then re-anchor the merged meshes to a pivot node. `pivot` is in root
    // space; `parentPivot` is the absolute pivot of the parent group (the knee inside the hip),
    // so a child pivot's local offset stays correct. The view rotates the node for the run
    // cycle — without groups the whole soldier would be one static pile of material buckets.
    _buildGroup(parent, name, pivot, parentPivot, build) {
        const scratch = new BABYLON.Mesh(name + '-build', this.scene);
        build(scratch);
        this._mergeParts(scratch);

        const pp = parentPivot || [0, 0, 0];
        const node = new BABYLON.Mesh(name, this.scene);
        node.parent = parent;
        node.position.set(pivot[0] - pp[0], pivot[1] - pp[1], pivot[2] - pp[2]);
        for (const m of scratch.getChildMeshes()) {
            m.parent = node;
            m.position.set(-pivot[0], -pivot[1], -pivot[2]);
        }
        scratch.dispose();
        return node;
    }

    // --- Static scenery ----------------------------------------------------------

    _height(x, y) {
        return this.terrain ? this.terrain.heightAt(x, y) : 0;
    }

    _px(v) { return v * this.scale; }

    _buildWater() {
        const water = this.map.relief ? this.map.relief.water : [];
        if (!water.length) return;
        const mat = new BABYLON.StandardMaterial('rts-water', this.scene);
        mat.diffuseColor = BABYLON.Color3.FromHexString('#2b7dff');
        mat.emissiveColor = BABYLON.Color3.FromHexString('#2b7dff').scale(0.18);
        mat.specularColor = new BABYLON.Color3(0.5, 0.7, 0.9);
        mat.specularPower = 64;
        mat.alpha = 0.62;
        mat.backFaceCulling = false;
        mat.metadata = { toon: false };
        const offset = typeof RTS_WATER_SURFACE_OFFSET !== 'undefined' ? RTS_WATER_SURFACE_OFFSET : 2;
        for (let i = 0; i < water.length; i++) {
            const w = water[i];
            const x = this._px(w.x), y = this._px(w.y);
            const bottom = this._height(x, y);
            const height = Math.max(2, w.depth - offset);
            const mesh = BABYLON.MeshBuilder.CreateCylinder('rts-water-' + i, {
                height,
                diameterTop: w.radius * 2 * this.scale,
                diameterBottom: w.radius * 2 * this.scale,
                tessellation: 24
            }, this.scene);
            mesh.material = mat;
            mesh.position.set(x, bottom + height / 2, y);
            mesh.isPickable = false;
            mesh.receiveShadows = false;
            this.waterMeshes.push(mesh);
        }
    }

    _buildScenery() {
        const c = RTS_DATA.COLORS;
        const trees = [], rocks = [];
        for (const o of this.map.obstacles) {
            const item = {
                x: this._px(o.x), y: this._px(o.y),
                h: this._height(this._px(o.x), this._px(o.y)),
                heading: (o.x * 1.71 + o.y * 0.37) % (Math.PI * 2),
                scale: Math.max(0.55, o.radius / 1.65)
            };
            if (o.kind === 'tree') trees.push(item);
            else rocks.push(item);
        }

        if (trees.length) {
            const root = new BABYLON.Mesh('rts-tree-source', this.scene);
            this._cyl(root, 'trunk', 24, 4, 6, 0, 12, 0, this._mat(c.treeTrunk), 6);
            this._cyl(root, 'crown-low', 28, 9, 26, 0, 30, 0, this._mat(c.treeCrown), 6);
            this._cyl(root, 'crown-high', 26, 0, 18, 0, 48, 0, this._mat(c.treeCrownLight), 6);
            root.getChildMeshes().forEach(m => { m.isPickable = false; });
            this.scenery.push(World3D.addInstances(this.location.view, root, 'prop', trees));
        }
        if (rocks.length) {
            const root = new BABYLON.Mesh('rts-rock-source', this.scene);
            this._poly(root, 'rock', 2, 9, 0, 6, 0, this._mat(c.rock), 0.7);
            this._poly(root, 'rock2', 1, 5, 6, 3, 2, this._mat(c.rockDark), 0.8);
            root.getChildMeshes().forEach(m => { m.isPickable = false; });
            this.scenery.push(World3D.addInstances(this.location.view, root, 'prop', rocks));
        }
    }


    _buildBorder() {
        const m = 2, n = this.map.size, pts = [];
        const push = (x, y) => {
            const wx = this._px(x), wy = this._px(y);
            pts.push(new BABYLON.Vector3(wx, this._height(wx, wy) + 1.6, wy));
        };
        for (let x = m; x <= n - m; x += 4) push(x, m);
        for (let y = m; y <= n - m; y += 4) push(n - m, y);
        for (let x = n - m; x >= m; x -= 4) push(x, n - m);
        for (let y = n - m; y >= m; y -= 4) push(m, y);
        const line = BABYLON.MeshBuilder.CreateLines('rts-border', { points: pts }, this.scene);
        line.color = BABYLON.Color3.FromHexString('#d9e6b0');
        line.alpha = 0.32;
        line.isPickable = false;
    }

    // The reference cluster: seven blue shards rising from a low mound of cool grey boulders.
    _buildCrystalShards(root, m) {
        const shard = (name, x, z, height, radius, leanX, leanZ, mat, tipMat, seed) => {
            const bodyH = height * 0.72;
            return this._crystalShard(root, name, {
                x, z, y: 0, radius, bodyH, tipH: height - bodyH,
                shoulder: radius * 0.84, sides: 6, wobble: 0.06, seed,
                rotX: leanX, rotZ: leanZ, rotY: (seed % 3) * 0.35,
                apexX: radius * 0.08, apexZ: -radius * 0.05,
                mat, tipMat
            });
        };
        shard('shard-core', 0, 0, 42, 6.2, 0.02, -0.03, m.body, m.tip, 1);
        shard('shard-left', -10, 0, 31, 4.6, 0.00, 0.22, m.deep, m.tip, 2);
        shard('shard-right', 10, 0, 28, 4.3, 0.00, -0.22, m.light, m.tip, 3);
        shard('shard-back-left', -5.5, 9, 21, 3.3, 0.12, 0.12, m.light, m.tip, 4);
        shard('shard-back-right', 5.5, 9, 19, 3.1, 0.12, -0.12, m.body, m.tip, 5);
        shard('shard-front-left', -5.5, -9, 17, 3.0, -0.14, 0.12, m.deep, m.tip, 6);
        shard('shard-front-right', 5.5, -9, 14, 2.8, -0.14, -0.12, m.light, m.tip, 7);
    }

    _buildCrystalRocks(root, m) {
        const rocks = [
            [-10, -3, 8.5, 1.3, 0.90, 1.1, 0.4, 0.10, m.rock],
            [9, -6, 7.5, 1.2, 0.85, 1.2, 1.2, -0.10, m.rockDark],
            [11, 5, 6.5, 1.1, 0.90, 1.0, 2.0, 0.20, m.rock],
            [-11, 7, 6.0, 1.0, 0.80, 1.1, 0.8, -0.20, m.rockLight],
            [0, 8, 7.0, 1.3, 0.80, 0.9, 1.7, 0.15, m.rockDark],
            [-4, -10, 6.0, 1.2, 0.80, 0.9, 2.4, 0.05, m.rock],
            [5, -11, 5.0, 1.1, 0.75, 0.9, 0.2, -0.10, m.rockLight],
            [14, 0, 4.5, 1.0, 0.80, 0.9, 1.0, 0.20, m.rockDark],
            [-14, 0, 4.2, 1.0, 0.75, 1.0, 0.5, -0.10, m.rock],
            [9, 10, 4.0, 1.0, 0.70, 0.9, 2.2, 0.10, m.rockDark],
            [-8, -9, 3.6, 1.1, 0.70, 0.9, 1.5, -0.15, m.rockLight],
            [0, -4, 9.0, 1.5, 0.75, 1.2, 0.9, 0.00, m.rockDark],
            [-5, 2, 8.0, 1.4, 0.80, 1.0, 1.9, 0.10, m.rock],
            [5, 3, 8.0, 1.4, 0.80, 1.0, 2.6, 0.05, m.rock],
            [-1, 10, 5.0, 1.1, 0.80, 0.8, 0.7, 0.20, m.rockLight]
        ];
        for (let i = 0; i < rocks.length; i++) {
            const r = rocks[i];
            this._rock(root, 'crystal-rock-' + i, r[2], r[0], r[2] * r[4] * 0.55, r[1], r[8], r[3], r[4], r[5], r[6], r[7]);
        }
    }

    // --- Resource fields ---------------------------------------------------------

    addResource(node) {
        const c = RTS_DATA.COLORS;
        const root = new BABYLON.Mesh('rts-resource-' + node.id, this.scene);
        this._buildGroup(root, 'rts-crystal-rocks', [0, 0, 0], null, g => {
            this._buildCrystalRocks(g, {
                rock: this._mat(c.crystalRock),
                rockDark: this._mat(c.crystalRockDark),
                rockLight: this._mat(c.crystalRockLight)
            });
        });
        const crystals = this._buildGroup(root, 'rts-crystal-crystals', [0, 0, 0], null, g => {
            this._buildCrystalShards(g, {
                deep: this._mat(c.crystalDeep),
                body: this._mat(c.crystalBody, true),
                light: this._mat(c.crystalLight, true),
                tip: this._mat(c.crystalTip, true)
            });
        });
        for (const m of crystals.getChildMeshes()) {
            /** @type {BABYLON.Mesh} */ (m).sideOrientation = BABYLON.Material.CounterClockWiseSideOrientation;
        }
        crystals.rotation.y = (node.id * 2.399963) % (Math.PI * 2);
        World3D.addObject(this.location.view, root, 'prop', { ink: false });
        this.resourceVisuals.set(node.id, { root, crystals });
        this._placeResource(node);
    }

    _placeResource(node) {
        const v = this.resourceVisuals.get(node.id);
        if (!v) return;
        const x = this._px(node.x), y = this._px(node.y);
        v.root.position.set(x, this._height(x, y), y);
        const ratio = Math.max(0.05, node.amount / Math.max(1, node.maxAmount));
        v.crystals.scaling.set(0.6 + ratio * 0.4, 0.3 + ratio * 0.7, 0.6 + ratio * 0.4);
    }

    updateResource(node) {
        this._placeResource(node);
    }

    removeResource(node) {
        const v = this.resourceVisuals.get(node.id);
        if (v) {
            World3D.removeObject(this.location.view, v.root);
            this.resourceVisuals.delete(node.id);
        }
        this._removeRing(node.id);
    }

    // --- Wreck -------------------------------------------------------------------

    addWreck(node) {
        const c = RTS_DATA.COLORS;
        const root = new BABYLON.Mesh('rts-wreck-' + node.id, this.scene);
        const hull = this._mat(c.wreckHull);
        const dark = this._mat(c.wreckDark);
        const metal = this._mat(c.metalDark);
        const glow = this._emissive('wreck-glow', c.wreckGlow);
        this._box(root, 'wreck-hull', 30, 8, 12, 0, 7, 0, hull);
        this._box(root, 'wreck-nose', 12, 7, 10, 18, 6, 0, dark);
        const wing = this._box(root, 'wreck-wing', 22, 2, 8, -5, 10, 9, dark);
        wing.rotation.z = 0.6;
        wing.rotation.y = 0.3;
        const wing2 = this._box(root, 'wreck-wing-broken', 10, 2, 6, -11, 9, -8, dark);
        wing2.rotation.z = -0.8;
        this._box(root, 'wreck-tail', 8, 13, 3, -16, 12, 0, hull);
        this._box(root, 'wreck-tail-fin', 3, 10, 8, -16, 18, 0, dark);
        const engine = this._cyl(root, 'wreck-engine', 8, 5, 5, -9, 7, 0, metal, 8);
        engine.rotation.z = Math.PI / 2;
        this._box(root, 'wreck-strut-l', 2, 8, 2, 8, 3, -7, metal);
        this._box(root, 'wreck-strut-r', 2, 8, 2, 8, 3, 7, metal);
        this._box(root, 'wreck-scorch', 18, 1, 8, 2, 11.5, 0, dark);
        this._sphere(root, 'wreck-ember-a', 2.4, 6, 10, 3, glow);
        this._sphere(root, 'wreck-ember-b', 1.6, -2, 11, -2, glow);
        World3D.addObject(this.location.view, root, 'prop');
        const bar = this._makeBar(Math.max(36, node.radius * this.scale * 2), 4, 30);
        this.wreckVisuals.set(node.id, { root, bar });
        this._placeWreck(node);
    }

    _placeWreck(node) {
        const v = this.wreckVisuals.get(node.id);
        if (!v) return;
        const x = this._px(node.x), y = this._px(node.y);
        v.root.position.set(x, this._height(x, y), y);
        v.root.rotation.y = -node.heading;
    }

    updateWreck(node) {
        this._placeWreck(node);
    }

    removeWreck(node) {
        const v = this.wreckVisuals.get(node.id);
        if (!v) return;
        World3D.removeObject(this.location.view, v.root);
        this._disposeBar(v.bar);
        this.wreckVisuals.delete(node.id);
        this._removeRing(node.id);
    }

    // --- Units and buildings -----------------------------------------------------

    _buildUnitMesh(type, team) {
        const c = RTS_DATA.COLORS;
        const body = this._mat(team === 'player' ? c.player : c.enemy);
        const dark = this._mat(team === 'player' ? c.playerDark : c.enemyDark);
        const metal = this._mat(c.metal);
        const metalDark = this._mat(c.metalDark);
        const glow = this._mat(c.glow, true);
        const root = new BABYLON.Mesh('rts-unit-' + type, this.scene);

        if (type === 'worker') {
            this._buildWorker(root, {
                body,
                dark,
                metal,
                metalDark,
                hull: this._mat(c.workerHull),
                hullShade: this._mat(c.workerHullShade),
                charcoal: this._mat(c.workerCharcoal),
                charcoalLight: this._mat(c.workerCharcoalLight),
                tire: this._mat(c.workerTire),
                tireLight: this._mat(c.workerTireLight),
                glass: this._mat(c.workerGlass),
                hazard: this._mat(c.workerHazard),
                light: this._emissive('worker-light', c.workerGlow)
            });
            this._mergeParts(root);
        } else if (type === 'infantry') {
            this._buildInfantry(root, { body, dark, metal, metalDark, glow });
        } else if (type === 'grenadier') {
            this._buildGrenadier(root, {
                body, dark, metal, metalDark, glow,
                ammo: this._mat(c.grenadierAmmo),
                hazard: this._mat(c.grenadierHazard)
            });
        } else if (type === 'scout') {
            let dish = this.materials.get('scout-dish');
            if (!dish) {
                dish = new BABYLON.StandardMaterial('rts-scout-dish', this.scene);
                dish.diffuseColor = BABYLON.Color3.FromHexString(c.scoutHull);
                dish.emissiveColor = BABYLON.Color3.FromHexString(c.scoutHull).scale(0.18);
                dish.specularColor = new BABYLON.Color3(0, 0, 0);
                this.materials.set('scout-dish', dish);
            }
            this._buildScout(root, {
                body,
                dark,
                glow,
                metal,
                metalDark,
                hull: this._mat(c.scoutHull),
                hullShade: this._mat(c.scoutHullShade),
                charcoal: this._mat(c.scoutCharcoal),
                charcoalLight: this._mat(c.scoutCharcoalLight),
                tire: this._mat(c.scoutTire),
                tireLight: this._mat(c.scoutTireLight),
                glass: this._mat(c.scoutGlass),
                dish,
                light: this._emissive('scout-light', c.scoutGlow)
            });
        } else {
            this._buildSiege(root, {
                teamGlow: this._emissive('siege-team-' + team,
                    team === 'player' ? c.player : c.enemy),
                hull: this._mat(c.siegeHull),
                hullShade: this._mat(c.siegeHullShade),
                charcoal: this._mat(c.siegeCharcoal),
                charcoalLight: this._mat(c.siegeCharcoalLight),
                tire: this._mat(c.siegeTire),
                tireLight: this._mat(c.siegeTireLight),
                bore: this._mat(c.siegeBore),
                metal: this._mat(c.metal),
                metalDark: this._mat(c.metalDark)
            });
        }
        return root;
    }

    // The scout from the reference: a six-wheeled rover. Neutral white faceted hull over a
    // charcoal chassis, dark windshield, chunky dark tyres with team-coloured hub rings, a
    // cyan light bar in the front bumper, team stripes and a side badge, a dish on the
    // rotating turret mount and a tall antenna with a glowing tip. Team colour is the trim
    // only — the hull, tyres, metal and lights stay neutral. Faces +X; the vehicle's left is
    // +Z. Base on Y = 0, antenna top at ~34 px.
    _buildScout(root, m) {
        const team = m.body, teamDark = m.dark;
        const hull = m.hull, hullShade = m.hullShade;
        const charcoal = m.charcoal, charcoalLight = m.charcoalLight;
        const tire = m.tire, tireLight = m.tireLight;
        const glass = m.glass, dishMat = m.dish, light = m.light, glow = m.glow;
        const metal = m.metal, metalDark = m.metalDark;

        // Chassis: a dark tub with a lighter skirt and the white hull above it.
        this._box(root, 'scout-under', 24, 2.8, 10.6, 0, 7.0, 0, charcoal);
        this._box(root, 'scout-skirt', 22, 2.2, 12.8, 0, 9.0, 0, charcoalLight);
        this._box(root, 'scout-hull', 23, 4.4, 12.2, 0, 11.7, 0, hull);
        this._box(root, 'scout-hull-band', 23.2, 1.2, 12.4, 0, 13.0, 0, hullShade);

        // Rear deck and cabin; the hood slopes down toward the nose.
        this._box(root, 'scout-deck', 9.5, 3.6, 11.2, -7.6, 14.2, 0, hull);
        this._box(root, 'scout-deck-trim', 9.7, 0.8, 11.4, -7.6, 16.2, 0, hullShade);
        this._box(root, 'scout-cabin', 8.5, 4.2, 11.0, -0.4, 15.7, 0, hull);
        this._box(root, 'scout-roof', 8.7, 0.8, 11.2, -0.4, 17.9, 0, hullShade);
        const hood = this._box(root, 'scout-hood', 9.0, 4.0, 12.2, 8.3, 13.1, 0, hull);
        hood.rotation.z = -0.3;
        const hoodTeam = this._box(root, 'scout-hood-team', 7.0, 0.35, 3.0, 8.85, 15.08, 0, team);
        hoodTeam.rotation.z = -0.3;

        // Windshield: a charcoal frame and a wide dark glass pane, proud of the cabin front.
        const frame = this._box(root, 'scout-window-frame', 0.9, 6.0, 9.6, 4.55, 16.1, 0, charcoal);
        frame.rotation.z = 0.5;
        const pane = this._box(root, 'scout-window', 0.5, 5.2, 8.4, 4.85, 16.2, 0, glass);
        pane.rotation.z = 0.5;

        // Nose, bumper, light bar and corner lamps.
        const nose = this._box(root, 'scout-nose', 4.2, 3.2, 11.6, 10.7, 11.4, 0, hull);
        nose.rotation.z = -0.22;
        this._box(root, 'scout-bumper', 2.4, 4.0, 13.6, 12.9, 8.4, 0, charcoal);
        this._box(root, 'scout-bumper-top', 2.6, 0.8, 13.8, 12.9, 10.8, 0, charcoalLight);
        this._box(root, 'scout-grille', 0.4, 1.2, 10.8, 14.15, 8.0, 0, metalDark);
        this._box(root, 'scout-light-frame', 0.5, 1.8, 9.4, 14.2, 9.6, 0, charcoal);
        this._box(root, 'scout-lightbar', 0.5, 1.0, 8.0, 14.45, 9.6, 0, light);
        for (const sz of [-1, 1]) {
            this._box(root, 'scout-lamp-frame', 0.5, 2.0, 2.4, 14.2, 9.6, 5.2 * sz, charcoal);
            this._box(root, 'scout-lamp', 0.5, 1.2, 1.5, 14.45, 9.6, 5.2 * sz, light);
        }

        // Rear bumper, tail lamps and the engine module on the deck.
        this._box(root, 'scout-rear-bumper', 2.0, 3.6, 13.0, -12.0, 8.4, 0, charcoal);
        for (const sz of [-1, 1]) {
            this._box(root, 'scout-tail', 0.4, 1.0, 1.6, -13.05, 9.6, 4.8 * sz, light);
        }
        this._box(root, 'scout-module', 5.2, 2.2, 6.0, -8.0, 17.2, 1.6, charcoal);
        this._box(root, 'scout-module-top', 4.6, 0.5, 5.4, -8.0, 18.5, 1.6, charcoalLight);
        for (let i = 0; i < 3; i++) {
            this._box(root, 'scout-module-slat', 0.5, 0.5, 4.6, -10.65, 16.9 + i * 0.7, 1.6, metalDark);
        }

        // Team trim on both flanks: a front stripe, a rear stripe and the two-bar badge.
        for (const sz of [-1, 1]) {
            const front = this._box(root, 'scout-side-team', 5.0, 2.2, 0.4, 5.6, 11.7, 6.35 * sz, team);
            front.rotation.z = -0.08;
            const rear = this._box(root, 'scout-side-team', 5.4, 2.0, 0.4, -7.0, 11.9, 6.35 * sz, team);
            rear.rotation.z = 0.1;
            this._box(root, 'scout-badge-frame', 5.8, 4.8, 0.35, 0.2, 12.3, 6.3 * sz, teamDark);
            this._box(root, 'scout-badge', 4.9, 3.9, 0.4, 0.2, 12.3, 6.5 * sz, team);
            for (const dy of [-0.75, 0.75]) {
                this._box(root, 'scout-badge-bar', 3.5, 0.6, 0.35, 0.2, 12.3 + dy, 6.72 * sz, glow);
            }
        }

        // Six chunky wheels: dark tyres, faceted treads and a team-coloured hub ring.
        const wheel = (name, x, z) => {
            const side = z > 0 ? 1 : -1;
            const tyre = this._cyl(root, name + '-tyre', 4.2, 10.4, 10.4, x, 5.2, z, tire, 12);
            tyre.rotation.x = Math.PI / 2;
            tyre.convertToFlatShadedMesh();
            for (let i = 0; i < 8; i++) {
                const a = Math.PI * 2 * i / 8;
                const tread = this._box(root, name + '-tread', 2.1, 1.2, 4.2,
                    x + Math.cos(a) * 5.15, 5.2 + Math.sin(a) * 5.15, z, tireLight);
                tread.rotation.z = a - Math.PI / 2;
            }
            const face = z + side * 2.16;
            const hub = this._cyl(root, name + '-hub', 0.5, 6.6, 6.6, x, 5.2, face + side * 0.15, charcoal, 12);
            hub.rotation.x = Math.PI / 2;
            const ring = this._torus(root, name + '-ring', 5.6, 1.2, x, 5.2, face + side * 0.35, team);
            ring.rotation.x = Math.PI / 2;
            const cap = this._cyl(root, name + '-cap', 0.5, 3.8, 3.8, x, 5.2, face + side * 0.35, tire, 10);
            cap.rotation.x = Math.PI / 2;
            this._box(root, name + '-axle', 1.2, 1.2, 13.5, x, 5.2, 0, metalDark);
            this._limb(root, name + '-arm-a', [x - 1.2, 8.8, side * 3.0], [x - 0.4, 5.2, side * 6.4], 1.1, 1.1, metalDark);
            this._limb(root, name + '-arm-b', [x + 1.2, 8.8, side * 3.0], [x + 0.4, 5.2, side * 6.4], 1.1, 1.1, metalDark);
        };
        for (const sz of [-1, 1]) {
            wheel('scout-wheel-front-' + (sz > 0 ? 'l' : 'r'), 8.5, 7.35 * sz);
            wheel('scout-wheel-mid-' + (sz > 0 ? 'l' : 'r'), 0, 7.35 * sz);
            wheel('scout-wheel-rear-' + (sz > 0 ? 'l' : 'r'), -8.5, 7.35 * sz);
        }

        // Dish mount on the roof and the tall antenna on the rear deck. The base and the mast
        // are neutral; the dish itself becomes the rotating turret group.
        this._box(root, 'scout-dish-base', 4.2, 1.6, 4.2, -1.5, 17.4, 2.4, charcoal);
        this._cyl(root, 'scout-dish-collar', 1.4, 3.0, 3.4, -1.5, 18.6, 2.4, charcoalLight, 8);
        this._box(root, 'scout-mast-base', 3.8, 2.2, 3.8, -6.8, 17.1, -3.4, charcoal);
        this._box(root, 'scout-mast-base-top', 3.0, 0.8, 3.0, -6.8, 18.4, -3.4, charcoalLight);
        this._cyl(root, 'scout-mast-collar', 1.2, 2.2, 2.6, -6.8, 19.2, -3.4, metalDark, 8);
        this._cyl(root, 'scout-mast', 12.0, 1.0, 1.5, -6.8, 25.8, -3.4, metal, 8);
        this._box(root, 'scout-mast-tip', 1.8, 2.2, 1.8, -6.8, 32.2, -3.4, light);

        // Merge the static hull and wheels by material (a draw call per colour, not per box).
        this._mergeParts(root);

        // The dish: a tilted faceted bowl on a short neck. Named rts-turret-pivot, so the
        // view aims it at the target with the other turrets.
        this._buildGroup(root, 'rts-turret-pivot', [-1.5, 19.0, 2.4], null, g => {
            this._cyl(g, 'scout-dish-neck', 1.8, 1.5, 1.8, -1.5, 19.6, 2.4, metalDark, 8);
            const dish = new BABYLON.Mesh('scout-dish-tilt', this.scene);
            dish.parent = g;
            dish.position.set(-1.5, 21.4, 2.4);
            dish.rotation.set(0.22, 0, -0.2);
            const bowl = this._cyl(dish, 'scout-dish', 1.8, 12.0, 4.0, 0, 0, 0, dishMat, 12);
            bowl.convertToFlatShadedMesh();
            const inner = this._cyl(dish, 'scout-dish-inner', 0.5, 10.0, 3.5, 0, 1.35, 0, dishMat, 12);
            inner.convertToFlatShadedMesh();
            this._torus(dish, 'scout-dish-rim', 12.4, 1.0, 0, 0.85, 0, metalDark, 14);
            this._limb(dish, 'scout-dish-feed', [0, 0.6, 0], [0, 6.2, 0], 1.1, 1.1, metalDark);
            this._poly(dish, 'scout-dish-tip', 1, 1.5, 0, 6.8, 0, light);
        });
    }

    // The siege tank from the reference: a low faceted hull on four separate track pods,
    // a sloped turret and a heavy octagonal cannon. The hull, tracks, cannon and metal are
    // neutral; only the light strips take the team colour. Faces +X, the vehicle's left is
    // +Z, the tracks stand on Y = 0.
    _buildSiege(root, m) {
        const teamGlow = m.teamGlow;
        const hull = m.hull, hullShade = m.hullShade;
        const charcoal = m.charcoal, charcoalLight = m.charcoalLight;
        const tire = m.tire, tireLight = m.tireLight;
        const metal = m.metal, metalDark = m.metalDark, boreMat = m.bore;

        // Lower tub, wide upper hull and the nose plate leaning down toward the front.
        this._box(root, 'siege-under', 27, 4.2, 17, 0, 7.4, 0, charcoal);
        this._box(root, 'siege-hull-lower', 28, 2.6, 19, 0, 9.4, 0, charcoalLight);
        this._box(root, 'siege-hull', 26, 7.0, 18, 0, 12.8, 0, hull);
        for (const sz of [-1, 1]) {
            this._box(root, 'siege-skirt', 27.6, 3.4, 1.3, 0, 9.0, 9.4 * sz, charcoal);
        }
        const glacis = this._box(root, 'siege-glacis', 8.5, 5.4, 17.6, 12.6, 12.9, 0, hullShade);
        glacis.rotation.z = -0.42;
        const nose = this._box(root, 'siege-nose', 4.0, 3.2, 15.6, 14.4, 10.9, 0, hull);
        nose.rotation.z = -0.24;
        this._box(root, 'siege-rear', 3.2, 6.4, 17.0, -14.6, 13.0, 0, hullShade);
        this._box(root, 'siege-deck-front', 12.5, 1.6, 11.5, 4.2, 17.6, 0, hullShade);
        this._box(root, 'siege-deck-rear', 10.5, 1.4, 13.0, -8.2, 17.4, 0, hull);
        for (const sz of [-1, 1]) {
            this._box(root, 'siege-vent', 5.0, 0.6, 3.2, -10.5, 18.1, 4.2 * sz, charcoal);
            this._box(root, 'siege-fender-frame', 4.6, 1.7, 0.6, 11.4, 13.1, 9.7 * sz, charcoal);
            this._box(root, 'siege-fender-glow', 3.7, 1.0, 0.45, 11.4, 13.1, 10.0 * sz, teamGlow);
        }

        // Four separate track pods: an octagonal dark tyre, a lighter wheel, a hub and
        // chunky treads. They stick out past the hull like the reference's corner units.
        const pod = (name, x, z) => {
            const side = z > 0 ? 1 : -1;
            const tyre = this._cyl(root, name + '-tyre', 6.2, 11.4, 11.4, x, 5.4, z, tire, 8);
            tyre.rotation.x = Math.PI / 2;
            tyre.convertToFlatShadedMesh();
            const wheel = this._cyl(root, name + '-wheel', 6.6, 8.2, 8.2, x, 5.4, z, tireLight, 8);
            wheel.rotation.x = Math.PI / 2;
            wheel.convertToFlatShadedMesh();
            const hub = this._cyl(root, name + '-hub', 7.0, 4.4, 4.4, x, 5.4, z, charcoal, 8);
            hub.rotation.x = Math.PI / 2;
            hub.convertToFlatShadedMesh();
            const cap = this._cyl(root, name + '-cap', 7.4, 2.2, 2.2, x, 5.4, z, metalDark, 8);
            cap.rotation.x = Math.PI / 2;
            for (let i = 0; i < 8; i++) {
                const a = Math.PI * 2 * i / 8;
                const tread = this._box(root, name + '-tread', 2.0, 1.2, 6.8,
                    x + Math.cos(a) * 5.5, 5.4 + Math.sin(a) * 5.5, z, tireLight);
                tread.rotation.z = a;
            }
            const ring = this._torus(root, name + '-ring', 11.8, 1.1,
                x, 5.4, z + side * 3.2, charcoal, 8);
            ring.rotation.x = Math.PI / 2;
        };
        for (const sz of [-1, 1]) {
            pod('siege-pod-front-' + (sz > 0 ? 'l' : 'r'), 8.8, 8.9 * sz);
            pod('siege-pod-rear-' + (sz > 0 ? 'l' : 'r'), -8.8, 8.9 * sz);
        }

        // Static hull and tracks: one draw call per material.
        this._mergeParts(root);

        // Turret: an octagonal base, sloped cheeks, a top plate, the rear bustle and an
        // antenna. The view rotates this whole group toward the target.
        this._buildGroup(root, 'rts-turret-pivot', [0, 18.0, 0], null, g => {
            const base = this._cyl(g, 'siege-turret-base', 4.2, 17.4, 19.2, 0, 19.4, 0, hullShade, 8);
            base.convertToFlatShadedMesh();
            const turretCollar = this._cyl(g, 'siege-turret-collar', 2.2, 16.0, 17.0, 0, 22.2, 0, charcoalLight, 8);
            turretCollar.convertToFlatShadedMesh();
            this._box(g, 'siege-turret-core', 14.5, 6.2, 15.5, 0, 25.4, 0, hull);
            const brow = this._box(g, 'siege-turret-brow', 8.0, 5.2, 14.5, 6.6, 25.2, 0, hull);
            brow.rotation.z = -0.48;
            this._box(g, 'siege-turret-top', 15.0, 1.6, 15.0, -0.8, 29.2, 0, hullShade);
            this._box(g, 'siege-turret-bustle', 7.0, 5.0, 12.5, -8.2, 25.6, 0, hull);
            this._box(g, 'siege-turret-bustle-top', 7.4, 1.2, 13.0, -8.2, 28.4, 0, hullShade);
            this._box(g, 'siege-turret-back', 1.2, 4.2, 11.0, -11.9, 25.4, 0, charcoal);
            for (const sz of [-1, 1]) {
                const cheek = this._box(g, 'siege-turret-cheek', 8.6, 4.8, 2.2, 2.0, 25.4, 8.0 * sz, hull);
                cheek.rotation.x = -0.26 * sz;
                this._box(g, 'siege-turret-glow-frame', 4.2, 1.7, 0.5, 4.6, 25.1, 9.1 * sz, charcoal);
                this._box(g, 'siege-turret-glow', 3.4, 1.0, 0.4, 4.6, 25.1, 9.35 * sz, teamGlow);
            }
            this._box(g, 'siege-hatch-base', 6.0, 1.0, 5.0, -0.5, 30.2, 0, charcoal);
            this._box(g, 'siege-hatch', 5.2, 1.0, 4.2, -0.5, 30.9, 0, hullShade);
            this._box(g, 'siege-hatch-glow', 0.65, 0.5, 3.0, 2.2, 31.2, 0, teamGlow);
            this._box(g, 'siege-antenna-base', 2.4, 2.0, 2.4, -6.4, 29.8, -4.9, charcoal);
            this._cyl(g, 'siege-antenna', 10.0, 1.1, 1.4, -6.4, 35.6, -4.9, metalDark, 8);
            this._box(g, 'siege-antenna-tip', 1.4, 1.6, 1.4, -6.4, 41.2, -4.9, metal);

            // Heavy octagonal cannon along +X: mantlet, collar, barrel, pale band,
            // muzzle and a dark bore. Team strips run along both sides and the top.
            this._box(g, 'siege-mantlet', 6.0, 7.0, 8.5, 9.2, 25.0, 0, hullShade);
            const collar = this._cyl(g, 'siege-barrel-collar', 5.5, 7.0, 7.6, 13.6, 25.0, 0, charcoal, 8);
            collar.rotation.z = Math.PI / 2;
            collar.convertToFlatShadedMesh();
            const barrel = this._cyl(g, 'siege-barrel', 7.2, 6.0, 6.4, 18.6, 25.0, 0, charcoalLight, 8);
            barrel.rotation.z = Math.PI / 2;
            barrel.convertToFlatShadedMesh();
            const band = this._cyl(g, 'siege-barrel-band', 1.2, 7.0, 7.0, 20.6, 25.0, 0, hullShade, 8);
            band.rotation.z = Math.PI / 2;
            band.convertToFlatShadedMesh();
            const muzzle = this._cyl(g, 'siege-muzzle', 3.4, 8.2, 7.4, 23.8, 25.0, 0, charcoal, 8);
            muzzle.rotation.z = Math.PI / 2;
            muzzle.convertToFlatShadedMesh();
            const bore = this._cyl(g, 'siege-bore', 0.8, 5.0, 5.0, 25.7, 25.0, 0, boreMat, 8);
            bore.rotation.z = Math.PI / 2;
            for (const sz of [-1, 1]) {
                this._box(g, 'siege-barrel-glow', 5.6, 0.8, 0.45, 18.6, 25.0, 3.15 * sz, teamGlow);
            }
            this._box(g, 'siege-barrel-glow-top', 5.6, 0.45, 1.0, 18.6, 28.05, 0, teamGlow);
        });
    }

    // The collector from the reference: a wheeled harvester. White cab with a dark
    // windshield and a cyan roof light, an open team-coloured hopper over the rear axle,
    // a charcoal chassis and a wide front scoop with hazard stripes. Four chunky tyres
    // with team-coloured hub rings. Faces +X; the vehicle's left is +Z. Base on Y = 0,
    // the antenna tip sits at ~34 px. Team colour is the hopper, the hub rings and the cab
    // trim; the hull, scoop, tyres, hazard stripes and lights stay neutral.
    _buildWorker(root, m) {
        const team = m.body, teamDark = m.dark;
        const hull = m.hull, hullShade = m.hullShade;
        const charcoal = m.charcoal, charcoalLight = m.charcoalLight;
        const tire = m.tire, tireLight = m.tireLight;
        const glass = m.glass, hazard = m.hazard, light = m.light;
        const metal = m.metal, metalDark = m.metalDark;

        // Chassis: a dark tub under a lighter skirt, with the white cab above the front axle.
        this._box(root, 'worker-under', 26, 3, 10, 0, 6.8, 0, charcoal);
        this._box(root, 'worker-skirt', 24, 2.4, 12, -1, 9.0, 0, charcoalLight);
        this._box(root, 'worker-cab-base', 12.5, 3.2, 11.5, 1.8, 11.5, 0, hull);
        this._box(root, 'worker-cab', 10.5, 7.6, 10.5, 1.2, 16.0, 0, hull);
        this._box(root, 'worker-roof', 11.2, 1.4, 10.8, 0.8, 20.0, 0, hullShade);

        // Windshield in a charcoal frame, plus a side window on each flank.
        const frame = this._box(root, 'worker-window-frame', 0.9, 6.6, 9.6, 6.35, 16.1, 0, charcoal);
        frame.rotation.z = 0.5;
        const pane = this._box(root, 'worker-window', 0.5, 5.8, 8.4, 6.65, 16.2, 0, glass);
        pane.rotation.z = 0.5;
        for (const sz of [-1, 1]) {
            this._box(root, 'worker-side-window', 3.4, 2.8, 0.4, 3.0, 16.9, 5.3 * sz, glass);
        }

        // Nose, headlights and the team trim strips along the cab flanks and fenders.
        const nose = this._box(root, 'worker-nose', 4.0, 3.4, 10.6, 7.0, 11.6, 0, hull);
        nose.rotation.z = -0.2;
        this._box(root, 'worker-light-frame', 0.5, 1.8, 7.4, 8.9, 10.6, 0, charcoal);
        this._box(root, 'worker-lightbar', 0.5, 1.0, 6.2, 9.15, 10.6, 0, light);
        for (const sz of [-1, 1]) {
            this._box(root, 'worker-team-trim', 4.4, 1.4, 0.5, -1.4, 12.2, 5.75 * sz, team);
            this._box(root, 'worker-fender-trim', 3.2, 1.2, 0.6, 5.6, 11.2, 6.2 * sz, team);
        }

        // Roof beacon on a charcoal base, and the tall antenna on the hopper's rear corner.
        this._box(root, 'worker-beacon-base', 4.6, 1.2, 3.6, 2.2, 21.0, -2.4, charcoal);
        this._box(root, 'worker-beacon', 3.6, 0.6, 2.6, 2.2, 21.7, -2.4, light);
        this._box(root, 'worker-mast-base', 2.4, 2.0, 2.4, -13.0, 21.2, -5.6, charcoal);
        this._cyl(root, 'worker-mast', 10.0, 1.2, 1.6, -13.0, 27.2, -5.6, metalDark, 8);
        this._box(root, 'worker-mast-tip', 1.6, 2.0, 1.6, -13.0, 32.7, -5.6, light);

        // The open hopper: a team-coloured trapezoid bin with a dark floor and a darker rim,
        // its side walls leaning outward so the top is wider than the base.
        this._box(root, 'worker-hopper-floor', 9.0, 1.2, 10.6, -9.9, 12.4, 0, team);
        this._box(root, 'worker-hopper-back', 1.2, 8.6, 13.2, -14.4, 16.4, 0, team);
        this._box(root, 'worker-hopper-front', 1.2, 7.4, 11.6, -4.8, 16.0, 0, team);
        for (const sz of [-1, 1]) {
            const wall = this._box(root, 'worker-hopper-side', 9.6, 7.8, 1.2, -9.6, 16.0, 6.1 * sz, team);
            wall.rotation.x = 0.14 * sz;
            this._box(root, 'worker-hopper-rim', 10.0, 1.2, 0.5, -9.4, 20.0, 6.5 * sz, teamDark);
            this._limb(root, 'worker-hopper-support', [-5.4, 10.0, 4.0 * sz], [-11.0, 12.0, 4.6 * sz], 1.4, 1.4, charcoalLight);
        }
        this._box(root, 'worker-hopper-rim-back', 0.4, 1.2, 13.0, -14.6, 20.1, 0, teamDark);
        this._box(root, 'worker-hopper-inner', 8.4, 0.6, 9.4, -9.8, 13.4, 0, charcoal);
        this._box(root, 'worker-hopper-inner-back', 0.6, 4.0, 9.4, -13.4, 15.4, 0, charcoal);

        // Front loader: two arms and pistons from the chassis to the wide scoop, hazard
        // stripes on the scoop sides and two prongs at the lip.
        for (const sz of [-1, 1]) {
            this._limb(root, 'worker-arm', [6.0, 9.8, 3.6 * sz], [14.0, 7.2, 5.4 * sz], 2.2, 2.2, charcoal);
            this._limb(root, 'worker-piston', [8.0, 9.2, 3.6 * sz], [13.2, 8.2, 5.0 * sz], 1.0, 1.0, metal);
        }
        this._box(root, 'worker-scoop-floor', 8.0, 1.6, 17.0, 17.0, 4.0, 0, charcoal);
        this._box(root, 'worker-scoop-back', 2.0, 6.2, 17.0, 13.6, 7.0, 0, charcoal);
        this._box(root, 'worker-scoop-lip', 0.8, 1.0, 17.2, 20.9, 8.6, 0, charcoalLight);
        for (const sz of [-1, 1]) {
            this._box(root, 'worker-scoop-side', 8.4, 6.2, 1.6, 17.2, 7.0, 8.1 * sz, charcoal);
            this._box(root, 'worker-prong', 4.0, 3.2, 2.4, 21.0, 5.0, 5.2 * sz, charcoal);
            for (const dx of [-1.2, 1.6]) {
                const stripe = this._box(root, 'worker-hazard', 1.0, 4.6, 0.35, 17.0 + dx, 6.8, 9.0 * sz, hazard);
                stripe.rotation.z = -0.7;
            }
        }

        // Four chunky wheels: dark flat-shaded tyres with treads and a team hub ring.
        const wheel = (name, x, z) => {
            const side = z > 0 ? 1 : -1;
            const tyre = this._cyl(root, name + '-tyre', 4.4, 10.4, 10.4, x, 5.2, z, tire, 12);
            tyre.rotation.x = Math.PI / 2;
            tyre.convertToFlatShadedMesh();
            for (let i = 0; i < 8; i++) {
                const a = Math.PI * 2 * i / 8;
                const tread = this._box(root, name + '-tread', 2.1, 1.2, 4.4,
                    x + Math.cos(a) * 5.15, 5.2 + Math.sin(a) * 5.15, z, tireLight);
                tread.rotation.z = a - Math.PI / 2;
            }
            const face = z + side * 2.26;
            const hub = this._cyl(root, name + '-hub', 0.5, 6.6, 6.6, x, 5.2, face + side * 0.1, charcoal, 12);
            hub.rotation.x = Math.PI / 2;
            const ring = this._torus(root, name + '-ring', 5.6, 1.0, x, 5.2, face + side * 0.3, team);
            ring.rotation.x = Math.PI / 2;
            const cap = this._cyl(root, name + '-cap', 0.5, 3.8, 3.8, x, 5.2, face + side * 0.3, tire, 10);
            cap.rotation.x = Math.PI / 2;
        };
        for (const sz of [-1, 1]) {
            wheel('worker-wheel-front-' + (sz > 0 ? 'l' : 'r'), 5.6, 7.3 * sz);
            wheel('worker-wheel-rear-' + (sz > 0 ? 'l' : 'r'), -7.4, 7.3 * sz);
        }
        this._box(root, 'worker-axle-front', 1.0, 1.0, 15.0, 5.6, 5.2, 0, metalDark);
        this._box(root, 'worker-axle-rear', 1.0, 1.0, 15.0, -7.4, 5.2, 0, metalDark);
    }

    // Trooper body shared by the rifle infantryman and the grenadier. Faces +X; the soldier's
    // right is +Z. The grenadier variant adds heavier armour, an ammunition bandolier and a
    // forward-pointing grenade launcher in its own pivot group, so the view can animate recoil
    // without melting the weapon into the merged upper body.
    _buildInfantry(root, mats) { this._buildTrooper(root, mats, false); }

    _buildGrenadier(root, mats) { this._buildTrooper(root, mats, true); }

    _buildTrooper(root, mats, grenadier) {
        const body = mats.body, dark = mats.dark;
        const metal = mats.metal, metalDark = mats.metalDark, glow = mats.glow;
        const ammo = mats.ammo || dark, hazard = mats.hazard || metal;
        const gloves = this._mat('#5a646c');

        // The visor, scope lens and accent lights are a saturated cyan screen, not a lit
        // surface: a black diffuse with a full emissive keeps the reference's glow.
        let visor = this.materials.get('visor');
        if (!visor) {
            visor = new BABYLON.StandardMaterial('rts-visor', this.scene);
            visor.diffuseColor = new BABYLON.Color3(0, 0, 0);
            visor.emissiveColor = BABYLON.Color3.FromHexString('#2fd0ec');
            visor.specularColor = new BABYLON.Color3(0, 0, 0);
            this.materials.set('visor', visor);
        }

        const hipY = 14.2, kneeY = 9.1;
        const grenadeAt = [4.2, 15.7, 0];

        // Legs: the thigh group hangs from the hip, the shin group from the knee.
        for (const k of [-1, 1]) {
            const side = k < 0 ? 'l' : 'r';
            const z = 2.3 * k;
            const hip = [0.2, hipY, z];

            const leg = this._buildGroup(root, 'rts-infantry-leg-' + side, hip, null, g => {
                this._box(g, 'thigh', 4.0, 4.6, 3.8, 0.2, 11.7, z, body);
                this._box(g, 'thigh-plate', 3.8, 1.6, 4.0, 0.4, 12.6, z, dark);
                this._sphere(g, 'hip', 2.7, 0.2, 14.2, z, metalDark, 6).convertToFlatShadedMesh();
                const knee = this._cyl(g, 'knee', 2.8, 2.3, 2.3, 0.2, 9.1, z, metalDark, 8);
                knee.rotation.x = Math.PI / 2;
                const pad = this._sphere(g, 'knee-pad', 3.1, 0.8, 9.1, z, body, 6);
                pad.scaling.y = 0.9;
                pad.convertToFlatShadedMesh();
                if (grenadier) {
                    this._box(g, 'thigh-armor', 4.4, 2.2, 4.2, 0.5, 11.8, z, dark);
                    this._box(g, 'thigh-strap', 4.6, 0.6, 4.4, 0.3, 10.4, z, ammo);
                }
            });

            this._buildGroup(leg, 'rts-infantry-shin-' + side, [0.2, kneeY, z], hip, g => {
                this._box(g, 'shin', 3.6, 4.6, 3.4, 0.15, 5.8, z, body);
                this._box(g, 'shin-ridge', 0.5, 4.0, 1.8, 1.9, 5.9, z, body);
                this._box(g, 'ankle', 2.8, 1.2, 3.2, 0.2, 3.3, z, metalDark);
                this._box(g, 'boot', 4.6, 2.2, 3.5, 0.7, 2.1, z, body);
                this._box(g, 'sole', 5.0, 0.9, 3.8, 0.8, 0.45, z, metalDark);
                this._box(g, 'toe', 1.2, 1.1, 3.5, 2.9, 1.3, z, metalDark);
                if (grenadier) {
                    this._box(g, 'shin-armor', 4.0, 2.4, 3.8, 0.4, 6.0, z, metalDark);
                    this._box(g, 'shin-strap', 3.8, 0.6, 4.0, 0.3, 4.8, z, ammo);
                }
            });
        }

        const upperPivot = [0.2, 14.6, 0];
        const upper = this._buildGroup(root, 'rts-infantry-upper', upperPivot, null, g => {
            // Pelvis, belt and hip plates.
            this._box(g, 'pelvis', 5.2, 2.6, 7.2, 0.2, 14.8, 0, body);
            this._box(g, 'belt', 5.6, 0.9, 7.6, 0.2, 15.7, 0, dark);
            this._box(g, 'crotch', 2.6, 1.4, 2.8, 1.6, 14.2, 0, dark);
            for (const k of [-1, 1]) this._box(g, 'hip-plate', 1.2, 2.4, 1.2, 0.2, 14.8, 3.75 * k, dark);

            // Segmented waist, chest plate, collar and the octagon badge.
            this._cyl(g, 'waist', 2.2, 5.8, 5.4, 0.2, 16.6, 0, metalDark, 10);
            this._cyl(g, 'waist-ring', 0.35, 6.1, 6.1, 0.2, 15.8, 0, metal, 10);
            this._cyl(g, 'waist-ring', 0.35, 6.0, 6.0, 0.2, 16.9, 0, metal, 10);
            this._box(g, 'chest', 5.6, 4.8, 7.6, 0.5, 19.2, 0, body);
            this._box(g, 'chest-front', 0.9, 4.0, 6.6, 3.2, 19.1, 0, body);
            this._box(g, 'chest-top', 5.0, 1.2, 7.0, 0.4, 21.2, 0, body);
            this._box(g, 'chest-seam', 0.35, 0.35, 6.8, 3.7, 17.8, 0, metalDark);
            this._box(g, 'chest-seam', 0.35, 0.3, 6.8, 3.7, 20.7, 0, metalDark);
            this._box(g, 'collar', 4.2, 1.0, 5.8, 0.3, 21.9, 0, dark);
            for (const k of [-1, 1]) {
                this._box(g, 'chest-trim', 1.2, 3.4, 0.8, 2.6, 19.2, 3.6 * k, dark);
                this._box(g, 'strap', 3.8, 0.6, 1.0, 0.0, 21.9, 2.6 * k, dark);
            }
            const badge = this._cyl(g, 'badge', 0.5, 2.8, 2.8, 3.7, 19.2, 0, metalDark, 8);
            badge.rotation.z = Math.PI / 2;
            const badgeInner = this._cyl(g, 'badge-inner', 0.55, 2.2, 2.2, 3.8, 19.2, 0, body, 8);
            badgeInner.rotation.z = Math.PI / 2;

            if (grenadier) {
                // Blast plate, diagonal bandolier and three fat grenade canisters.
                this._box(g, 'blast-plate', 1.2, 4.4, 6.6, 4.0, 19.1, 0, metalDark);
                const strap = this._box(g, 'bandolier', 1.0, 0.9, 7.4, 4.1, 19.4, 0, ammo);
                strap.rotation.x = 0.42;
                for (let i = -1; i <= 1; i++) {
                    const can = this._cyl(g, 'grenade-canister', 1.4, 1.8, 1.8, 4.4, 19.2 + i * 1.5, -1.9 + i * 0.6, hazard, 8);
                    can.rotation.z = Math.PI / 2;
                }
            }

            // Round pauldrons and arms bent to the rifle's grip and handguard. The hand points
            // are taken from the rifle's own transform, so the gloves stay on the weapon when
            // its tilt or height is tuned.
            for (const k of [-1, 1]) {
                this._sphere(g, 'shoulder-joint', 2.8, 0, 19.8, 4.3 * k, metalDark, 6).convertToFlatShadedMesh();
                const pauldron = this._sphere(g, 'pauldron', 4.8, 0, 20.4, 4.5 * k, body, 8);
                pauldron.scaling.y = 0.9;
                pauldron.convertToFlatShadedMesh();
                this._box(g, 'pauldron-trim', 3.6, 0.5, 1.0, 0, 22.0, 4.5 * k, dark);
                if (grenadier && k > 0) {
                    const heavy = this._sphere(g, 'heavy-pauldron', 6.0, 0, 20.7, 4.7, body, 8);
                    heavy.scaling.y = 0.85;
                    heavy.convertToFlatShadedMesh();
                    this._box(g, 'heavy-pauldron-plate', 4.6, 0.7, 1.0, 0, 22.4, 4.8, metalDark);
                }
            }
            const rifleAt = [5.0, 15.4, -0.4];
            const rifleTilt = -0.35;
            const riflePoint = (x, y, z) => {
                const c = Math.cos(rifleTilt), s = Math.sin(rifleTilt);
                return [rifleAt[0] + x, rifleAt[1] + y * c - z * s, rifleAt[2] + y * s + z * c];
            };
            const rightHand = grenadier ? [5.2, 14.8, 1.8] : riflePoint(0.25, -0.75, 1.7);
            const leftHand = grenadier ? [5.8, 15.1, -1.8] : riflePoint(0.25, -0.75, -2.5);
            const arms = [
                [[0, 19.8, 4.3], [1.9, 16.0, 4.0], rightHand],
                [[0, 19.8, -4.3], [1.9, 15.8, -4.3], leftHand]
            ];
            for (const arm of arms) {
                this._limb(g, 'upper-arm', arm[0], arm[1], 2.4, 2.4, body);
                this._limb(g, 'forearm', arm[1], arm[2], 2.2, 2.3, body);
                const elbow = this._sphere(g, 'elbow-pad', 2.8, arm[1][0], arm[1][1], arm[1][2], body, 6);
                elbow.convertToFlatShadedMesh();
                this._box(g, 'cuff', 2.3, 0.6, 2.3, arm[2][0], arm[2][1], arm[2][2], dark);
                this._box(g, 'glove', 2.3, 2.0, 2.3, arm[2][0], arm[2][1], arm[2][2], gloves);
            }

            // Neck and helmet: faceted crown, jaw, ear modules, framed visor.
            this._cyl(g, 'neck', 1.8, 2.4, 2.4, 0.2, 21.6, 0, metalDark, 10);
            this._cyl(g, 'neck-ring', 0.35, 2.8, 2.8, 0.2, 22.3, 0, metal, 10);
            this._box(g, 'helmet-jaw', 4.6, 2.4, 4.8, 0.2, 23.2, 0, body);
            this._sphere(g, 'helmet', 4.8, 0, 23.9, 0, body, 8).convertToFlatShadedMesh();
            this._box(g, 'helmet-back', 3.2, 2.8, 4.0, -1.0, 23.4, 0, body);
            this._box(g, 'visor-frame', 0.8, 1.9, 4.2, 2.75, 23.5, 0, metalDark);
            this._box(g, 'visor', 0.5, 1.3, 3.6, 3.1, 23.5, 0, visor);
            this._box(g, 'chin', 0.6, 1.0, 3.2, 2.6, 22.5, 0, metalDark);
            for (const k of [-1, 1]) this._box(g, 'ear', 1.6, 1.6, 0.9, -0.1, 23.3, 2.65 * k, metal);
            if (grenadier) {
                this._box(g, 'helmet-brow', 1.0, 1.5, 4.4, 2.7, 24.4, 0, dark);
                this._box(g, 'helmet-ridge', 3.8, 0.7, 0.8, 0.1, 25.0, 0, metalDark);
                for (const k of [-1, 1]) this._box(g, 'cheek-plate', 2.0, 2.0, 0.8, 1.8, 23.3, 2.7 * k, metalDark);
            }

            // Backpack, side module and the two antennas.
            this._box(g, 'pack', 2.6, 5.2, 5.2, -2.6, 19.2, 0, dark);
            this._box(g, 'pack-top', 2.2, 1.0, 4.4, -2.6, 22.0, 0, metalDark);
            if (grenadier) {
                this._box(g, 'pack-rack', 2.6, 1.2, 5.6, -2.8, 22.4, 0, ammo);
                for (let i = -1; i <= 1; i++) {
                    this._cyl(g, 'ammo-tube', 3.2, 1.5, 1.5, -3.1, 24.2, i * 1.6, metalDark, 8);
                    this._box(g, 'ammo-tip', 0.4, 0.5, 0.5, -4.7, 24.2, i * 1.6, hazard);
                }
            }
            this._box(g, 'pack-module', 2.0, 3.0, 2.2, -2.4, 21.6, -3.0, dark);
            this._box(g, 'pack-light', 0.3, 0.6, 1.0, -3.95, 21.6, -3.0, glow);
            this._cyl(g, 'antenna', 5.5, 0.4, 0.4, -2.5, 26.0, -2.7, metalDark, 6);
            this._cyl(g, 'antenna', 4.6, 0.4, 0.4, -2.5, 25.6, -3.7, metalDark, 6);
            this._box(g, 'antenna-tip', 0.6, 0.5, 0.6, -2.5, 28.8, -2.7, metal);
            this._box(g, 'antenna-tip', 0.6, 0.5, 0.6, -2.5, 27.9, -3.7, metal);

            if (!grenadier) {
                // Rifle: receiver, barrel, stock, magazine, grip and a scoped rail with a cyan lens.
                const rifle = new BABYLON.Mesh('rifle', this.scene);
                rifle.parent = g;
                rifle.position.set(rifleAt[0], rifleAt[1], rifleAt[2]);
                rifle.rotation.x = rifleTilt;
                this._box(rifle, 'receiver', 1.3, 1.3, 5.4, 0, 0, 0, metalDark);
                this._box(rifle, 'rail', 0.7, 0.3, 4.6, 0, 0.8, 0, metal);
                const barrel = this._cyl(rifle, 'barrel', 4.8, 0.5, 0.5, 0, 0.15, -4.6, metalDark, 8);
                barrel.rotation.x = Math.PI / 2;
                const muzzle = this._cyl(rifle, 'muzzle', 1.0, 0.85, 0.85, 0, 0.15, -7.4, metal, 8);
                muzzle.rotation.x = Math.PI / 2;
                this._box(rifle, 'stock', 1.1, 1.4, 2.4, 0, -0.05, 3.9, metalDark);
                this._box(rifle, 'stock-butt', 1.2, 1.8, 0.35, 0, -0.15, 5.2, metalDark);
                const mag = this._box(rifle, 'magazine', 0.9, 1.9, 1.2, 0, -1.35, 0.5, metalDark);
                mag.rotation.x = 0.24;
                const grip = this._box(rifle, 'grip', 0.85, 1.7, 0.9, 0, -1.1, 1.8, metalDark);
                grip.rotation.x = -0.3;
                this._box(rifle, 'scope', 1.1, 0.9, 2.4, 0, 1.35, -0.3, metalDark);
                const lens = this._cyl(rifle, 'lens', 0.3, 0.8, 0.8, 0, 1.35, -1.55, visor, 8);
                lens.rotation.x = Math.PI / 2;
                this._box(rifle, 'accent', 0.15, 0.3, 1.2, 0.7, 0.2, -1.2, visor);
                this._box(rifle, 'sight', 0.45, 0.5, 0.45, 0, 0.9, -3.2, metal);
            }
        });

        if (grenadier) {
            // Stubby grenade launcher pointing along +X. It is its own pivot group, created
            // after the upper body has been merged, so the view can kick it on every shot.
            this._buildGroup(upper, 'rts-grenadier-launcher', grenadeAt, upperPivot, g => {
                const at = grenadeAt;
                this._box(g, 'launcher-receiver', 2.4, 2.4, 3.6, at[0] + 0.2, at[1], at[2], metalDark);
                const barrel = this._cyl(g, 'launcher-barrel', 4.6, 1.9, 2.1, at[0] + 3.4, at[1], at[2], metal, 10);
                barrel.rotation.z = Math.PI / 2;
                const muzzle = this._cyl(g, 'launcher-muzzle', 1.4, 3.9, 2.7, at[0] + 6.1, at[1], at[2], metalDark, 10);
                muzzle.rotation.z = Math.PI / 2;
                const bore = this._cyl(g, 'launcher-bore', 0.7, 2.4, 2.4, at[0] + 6.7, at[1], at[2], metalDark, 10);
                bore.rotation.z = Math.PI / 2;
                const drum = this._cyl(g, 'launcher-drum', 2.0, 3.8, 3.8, at[0] - 0.1, at[1] - 1.9, at[2], ammo, 10);
                drum.rotation.x = Math.PI / 2;
                this._box(g, 'launcher-stock', 2.8, 1.6, 1.8, at[0] - 2.9, at[1] - 0.1, at[2], metalDark);
                this._box(g, 'launcher-rail', 3.2, 0.4, 0.8, at[0] + 0.5, at[1] + 1.5, at[2], metal);
                this._box(g, 'launcher-accent', 0.8, 0.5, 0.5, at[0] + 1.9, at[1] + 0.9, at[2], glow);
                for (let i = -1; i <= 1; i++) {
                    this._box(g, 'launcher-vent', 0.4, 0.6, 1.6, at[0] + 2.4, at[1] + 0.4, at[2] + i * 0.6, hazard);
                }
            });
        }
    }

    addUnit(u) {
        const root = this._buildUnitMesh(u.type, u.team);
        this._selectionRadiusFor(root, u.type);
        World3D.addObject(this.location.view, root, 'actor');
        const width = u.type === 'siege' ? 26 : u.type === 'worker' ? 18 : 14;
        const bar = this._makeBar(width, 3, 24);
        const part = (name) => root.getChildMeshes().find(m => m.name === name) || null;
        const launcher = part('rts-grenadier-launcher');
        this.unitVisuals.set(u.id, {
            root, bar,
            turret: part('rts-turret-pivot'),
            upper: part('rts-infantry-upper'),
            legL: part('rts-infantry-leg-l'),
            legR: part('rts-infantry-leg-r'),
            shinL: part('rts-infantry-shin-l'),
            shinR: part('rts-infantry-shin-r'),
            launcher,
            launcherX: launcher ? launcher.position.x : 0,
            stride: 0,
            lean: 0,
            attacking: false,
            attackT: 0,
            attackDur: 0.5
        });
        this._placeUnit(u);
    }

    _placeUnit(u, dt) {
        const v = this.unitVisuals.get(u.id);
        if (!v) return;
        const x = this._px(u.x), y = this._px(u.y);
        const ground = this._height(x, y);
        if (v.upper) {
            const k = dt > 0 ? Math.min(1, dt * 12) : 0;
            v.stride += ((u.moving ? 1 : 0) - v.stride) * k;
            v.lean += ((u.moving ? 0.14 : 0) - v.lean) * k;
        }
        const bob = v.upper
            ? Math.abs(Math.sin(u.movingPhase * 1.3)) * 1.4 * v.stride
            : (u.moving ? Math.abs(Math.sin(u.movingPhase * 0.55)) * 1.2 : 0);
        v.root.position.set(x, ground + bob, y);
        v.root.rotation.y = -u.heading;
        if (v.turret) v.turret.rotation.y = u.heading - u.turretHeading;

        // A simple run cycle: the hips swing in antiphase, the knee bends on the forward
        // swing so the foot clears the ground, and the torso leans into the run.
        if (v.upper) {
            const p = u.movingPhase * 1.3;
            const s = Math.sin(p), c = Math.cos(p);
            const swing = 0.55 * v.stride;
            v.legR.rotation.z = swing * s;
            v.legL.rotation.z = -swing * s;
            v.shinR.rotation.z = -0.8 * v.stride * Math.max(0, c);
            v.shinL.rotation.z = -0.8 * v.stride * Math.max(0, -c);
            v.upper.rotation.z = -v.lean;
            v.upper.rotation.x = 0.06 * v.stride * s;
            v.upper.rotation.y = 0.05 * v.stride * s;
        }

        // The grenadier's launcher kicks up and back for half a second, and the torso takes
        // the recoil. The pose is additive over the walk cycle.
        if (v.attacking) {
            const step = dt > 0 ? dt : 0;
            v.attackT += step;
            const t = Math.min(1, v.attackT / v.attackDur);
            const kick = Math.sin(t * Math.PI);
            if (v.launcher) {
                v.launcher.rotation.z = 0.34 * kick;
                v.launcher.position.x = v.launcherX - 1.4 * kick;
            }
            if (v.upper) {
                v.upper.rotation.z -= 0.12 * kick;
                v.upper.rotation.x += 0.05 * kick;
                v.upper.rotation.y += 0.06 * kick;
            }
            if (v.attackT >= v.attackDur) {
                v.attacking = false;
                v.attackT = 0;
                if (v.launcher) {
                    v.launcher.rotation.z = 0;
                    v.launcher.position.x = v.launcherX;
                }
            }
        } else if (v.launcher) {
            v.launcher.rotation.z = 0;
            v.launcher.position.x = v.launcherX;
        }
    }

    unitAttack(u, target) {
        const v = this.unitVisuals.get(u.id);
        if (!v) return;
        v.attacking = true;
        v.attackT = 0;
        if (u.type === 'grenadier') this.grenade(u, target || u.target || u, u.team);
    }

    removeUnit(u) {
        const v = this.unitVisuals.get(u.id);
        if (v) {
            World3D.removeObject(this.location.view, v.root);
            this._disposeBar(v.bar);
            this.unitVisuals.delete(u.id);
        }
        this._removeRing(u.id);
        this._removeDebugFor(u);
    }

    _buildBuildingMesh(type, team) {
        const c = RTS_DATA.COLORS;
        const body = this._mat(team === 'player' ? c.player : c.enemy);
        const dark = this._mat(team === 'player' ? c.playerDark : c.enemyDark);
        const metal = this._mat(c.metal);
        const metalDark = this._mat(c.metalDark);
        const glow = this._mat(c.glow, true);
        const root = new BABYLON.Mesh('rts-building-' + type, this.scene);

        if (type === 'hq') {
            this._buildHQ(root, {
                team: body,
                hull: this._mat(c.hqHull),
                hullShade: this._mat(c.hqHullShade),
                charcoal: this._mat(c.hqCharcoal),
                charcoalLight: this._mat(c.hqCharcoalLight),
                glow: this._emissive('hq-glow', c.hqGlow),
                beacon: this._emissive('hq-beacon', c.hqBeacon),
                metal,
                metalDark
            });
            this._mergeParts(root);
        } else if (type === 'generator') {
            this._buildGenerator(root, {
                team: body,
                teamDark: dark,
                hull: this._mat(c.generatorHull),
                hullShade: this._mat(c.generatorHullShade),
                charcoal: this._mat(c.generatorCharcoal),
                charcoalLight: this._mat(c.generatorCharcoalLight),
                glow: this._emissive('generator-glow', c.generatorGlow),
                metal,
                metalDark
            });
            this._mergeParts(root);
        } else if (type === 'depot') {
            this._buildDepot(root, {
                team: body,
                teamDark: dark,
                hull: this._mat(c.depotHull),
                hullShade: this._mat(c.depotHullShade),
                charcoal: this._mat(c.depotCharcoal),
                charcoalLight: this._mat(c.depotCharcoalLight),
                glow: this._emissive('depot-glow', c.depotGlow),
                beacon: this._emissive('depot-beacon', c.depotBeacon),
                metal,
                metalDark,
                hazard: this._mat(c.depotHazard),
                crate: this._mat(c.depotCrate),
                crateDark: this._mat(c.depotCrateDark)
            });
            this._mergeParts(root);
        } else if (type === 'barracks') {
            const shape = new BABYLON.Mesh('barracks-shape', this.scene);
            shape.parent = root;
            this._buildBarracks(shape, {
                team: body,
                hull: this._mat(c.hqHull),
                hullShade: this._mat(c.hqHullShade),
                charcoal: this._mat(c.hqCharcoal),
                charcoalLight: this._mat(c.hqCharcoalLight),
                glow: this._emissive('hq-glow', c.hqGlow),
                metal,
                metalDark
            });
            this._mergeParts(shape);
            shape.scaling.y = 0.84;
        } else if (type === 'factory') {
            this._buildFactory(root, {
                team: body,
                hull: this._mat(c.factoryHull),
                hullShade: this._mat(c.factoryHullShade),
                charcoal: this._mat(c.factoryCharcoal),
                charcoalLight: this._mat(c.factoryCharcoalLight),
                glow: this._emissive('factory-glow', c.factoryGlow),
                hazard: this._mat(c.factoryHazard),
                metalDark
            });
            this._mergeParts(root);
        } else if (type === 'tower') {
            this._buildTurret(root, {
                team: body,
                hull: this._mat(c.towerHull),
                hullShade: this._mat(c.towerHullShade),
                charcoal: this._mat(c.towerCharcoal),
                charcoalLight: this._mat(c.towerCharcoalLight),
                glow: this._emissive('tower-glow', c.towerGlow),
                metal: this._mat(c.metal),
                metalDark: this._mat(c.metalDark)
            });
            this._mergeParts(root);
        } else {
            this._cyl(root, 'base', 8, 20, 20, 0, 4, 0, dark, 10);
            this._cyl(root, 'tower', 36, 15, 15, 0, 26, 0, body, 8);
            this._box(root, 'cap', 18, 6, 18, 0, 47, 0, dark);
            this._box(root, 'gun', 22, 3, 3, 10, 47, 0, metalDark);
            this._sphere(root, 'lamp', 5, 0, 49, 0, glow);
        }
        return root;
    }

    // The headquarters from the reference: a stepped low-poly bunker. Neutral white hull,
    // charcoal plinth and gate, cyan light strips; only the belt, side plates and dish tip
    // take the team colour. Faces +Z, base on Y = 0, top of the beacon at ~100 px.
    _buildHQ(root, m) {
        const team = m.team;
        const hull = m.hull, hullShade = m.hullShade;
        const charcoal = m.charcoal, charcoalLight = m.charcoalLight;
        const glow = m.glow, beacon = m.beacon;
        const metal = m.metal, metalDark = m.metalDark;
        const octa = Math.PI / 8;          // a flat octagon face toward +Z
        const square = Math.PI / 4;        // a corner foot points along the diagonals

        // Plinth, corner feet and the front braces beside the stairs.
        const plinth = this._cyl(root, 'hq-plinth', 8, 52, 56, 0, 4, 0, charcoal, 8);
        plinth.rotation.y = octa;
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                const foot = this._cyl(root, 'hq-foot', 8, 9, 13, 22 * sx, 4, 19 * sz, charcoal, 4);
                foot.rotation.y = square;
            }
            const brace = this._cyl(root, 'hq-brace', 9, 8, 12, 19 * sx, 4.5, 21, charcoalLight, 4);
            brace.rotation.y = square;
        }
        const deck = this._cyl(root, 'hq-deck', 6, 46, 48, 0, 11, 0, charcoalLight, 8);
        deck.rotation.y = octa;

        // Lower wings and rear shoulder blocks. The team colour is a trim, never the hull.
        for (const sx of [-1, 1]) {
            this._box(root, 'hq-wing-foot', 18, 10, 22, 19 * sx, 13, 12, charcoal);
            this._box(root, 'hq-wing', 16, 14, 20, 19 * sx, 25, 12, hull);
            this._box(root, 'hq-wing-cap', 14, 3, 18, 19 * sx, 33.5, 12, hullShade);
            this._box(root, 'hq-wing-trim', 15, 1.2, 19, 19 * sx, 31.6, 12, charcoalLight);
            this._box(root, 'hq-wing-glow', 9, 2, 0.9, 19 * sx, 20, 22.4, glow);
            this._box(root, 'hq-wing-team', 0.9, 8, 6, 27.3 * sx, 25, 12, team);
            this._box(root, 'hq-wing-hatch', 8, 2, 10, 19 * sx, 35.9, 12, charcoal);

            this._box(root, 'hq-shoulder-foot', 16, 10, 18, 20 * sx, 13, -10, charcoal);
            this._box(root, 'hq-shoulder', 16, 16, 16, 20 * sx, 26, -10, hull);
            this._box(root, 'hq-shoulder-cap', 14, 2.5, 14, 20 * sx, 35.2, -10, hullShade);
            this._box(root, 'hq-shoulder-trim', 15, 1.2, 15, 20 * sx, 33.8, -10, charcoalLight);
            this._box(root, 'hq-shoulder-glow', 0.9, 2, 8, 27.9 * sx, 27, -10, glow);
            this._box(root, 'hq-shoulder-team', 0.9, 3, 10, 27.9 * sx, 21, -10, team);
            this._box(root, 'hq-shoulder-vent', 6, 2, 6, 20 * sx, 36.8, -10, charcoalLight);
        }

        // Main mass: an octagonal body with sloped shoulders and a team-coloured belt.
        const waist = this._cyl(root, 'hq-waist', 4, 48, 48, 0, 16, 0, charcoalLight, 8);
        waist.rotation.y = octa;
        const body = this._cyl(root, 'hq-body', 32, 40, 48, 0, 33, 0, hull, 8);
        body.rotation.y = octa;
        body.convertToFlatShadedMesh();
        const shoulders = this._cyl(root, 'hq-shoulders', 9, 30, 40, 0, 53.5, 0, hull, 8);
        shoulders.rotation.y = octa;
        shoulders.convertToFlatShadedMesh();
        const shoulderTrim = this._cyl(root, 'hq-shoulders-trim', 2.5, 41, 41, 0, 49.5, 0, charcoal, 8);
        shoulderTrim.rotation.y = octa;
        const belt = this._cyl(root, 'hq-belt', 3.5, 44, 44, 0, 43, 0, team, 8);
        belt.rotation.y = octa;

        // The belt breaks over the gate as a shallow chevron.
        for (const sx of [-1, 1]) {
            const chevron = this._box(root, 'hq-chevron', 11, 3.2, 1, 5.5 * sx, 40.8, 21, team);
            chevron.rotation.z = 0.32 * sx;
        }

        // Gate: porch, stairs, dark recessed portal and cyan strips.
        this._box(root, 'hq-porch', 30, 5, 9, 0, 11, 19.5, charcoalLight);
        for (const sx of [-1, 1]) {
            this._box(root, 'hq-porch-rail', 2, 6, 11, 13 * sx, 16.5, 20, hull);
            this._box(root, 'hq-porch-rail-top', 2.2, 0.8, 11.2, 13 * sx, 19.9, 20, hullShade);
        }
        for (let i = 0; i < 5; i++) {
            const height = 8 - i * 1.5;
            this._box(root, 'hq-step', 18, height, 1.5, 0, height / 2, 23.75 + i * 1.5, hullShade);
        }
        for (const sx of [-1, 1]) {
            this._limb(root, 'hq-stair-rail',
                [9.5 * sx, 8.2, 22.5], [9.5 * sx, 1.6, 29.4], 1.3, 1.3, hull);
        }
        this._box(root, 'hq-portal', 22, 20, 2, 0, 24, 18.2, charcoal);
        this._box(root, 'hq-door', 14, 17, 1, 0, 21.5, 19, metalDark);
        for (const sx of [-1, 1]) {
            this._box(root, 'hq-jamb', 2, 18, 3, 11 * sx, 23, 19.2, charcoal);
            this._box(root, 'hq-door-side', 1.2, 8, 0.8, 6.5 * sx, 23, 20.3, glow);
        }
        this._box(root, 'hq-lintel', 24, 3, 3, 0, 33.5, 19.2, charcoal);
        this._box(root, 'hq-door-top', 10, 1.6, 0.8, 0, 30.5, 20.3, glow);
        this._box(root, 'hq-hood', 26, 5, 6, 0, 36.5, 19, charcoal);
        for (const sx of [-1, 1]) {
            const brow = this._box(root, 'hq-hood-brow', 6, 4, 5.5, 12 * sx, 36, 19, charcoal);
            brow.rotation.z = 0.5 * sx;
        }

        // Upper tower: dark pedestal, faceted body, window, glowing sign, team stripe.
        const pedestal = this._cyl(root, 'hq-pedestal', 4, 30, 32, 0, 60, 0, charcoal, 8);
        pedestal.rotation.y = octa;
        const tower = this._cyl(root, 'hq-tower', 12, 22, 28, 0, 68, 0, hull, 8);
        tower.rotation.y = octa;
        tower.convertToFlatShadedMesh();
        this._box(root, 'hq-window-frame', 12, 9, 1, 0, 69, 11.4, charcoal);
        this._box(root, 'hq-window', 9, 6, 1.2, 0, 68.8, 12.1, metalDark);
        this._box(root, 'hq-sign-frame', 18, 5, 1.2, 0, 62.5, 12.7, charcoal);
        this._box(root, 'hq-sign', 14, 1.8, 0.7, 0, 62.5, 13.5, glow);
        this._box(root, 'hq-tower-team', 1, 8, 12, 12.4, 67, 0, team);
        const crown = this._cyl(root, 'hq-crown', 2, 23, 23, 0, 74, 0, charcoal, 8);
        crown.rotation.y = octa;
        const cap = this._cyl(root, 'hq-cap', 6, 12, 22, 0, 77, 0, hullShade, 8);
        cap.rotation.y = octa;
        cap.convertToFlatShadedMesh();

        // Antenna mast with a dark collar and the red beacon. The mast is thicker than the
        // reference's needle: the ink outline swallows anything thinner at RTS zoom.
        this._box(root, 'hq-mast-base', 8, 4, 8, 0, 82, 0, charcoal);
        this._cyl(root, 'hq-mast', 14, 2.4, 3.8, 0, 90, 0, hullShade, 8);
        this._box(root, 'hq-mast-collar', 5, 2, 5, 0, 85.5, 0, charcoal);
        this._cyl(root, 'hq-beacon-base', 2, 6, 6, 0, 96.5, 0, charcoalLight, 8);
        this._cyl(root, 'hq-beacon', 5, 5, 5, 0, 98.5, 0, beacon, 10);
        this._sphere(root, 'hq-beacon-cap', 4.6, 0, 100.8, 0, beacon, 8);

        // Satellite dish on its own right-side deck, tilted toward the camera.
        this._box(root, 'hq-dish-platform', 11, 2, 12, 21, 57, -7, charcoalLight);
        this._limb(root, 'hq-dish-support', [20, 38, -9], [21, 56, -7], 4, 4, charcoal);
        this._box(root, 'hq-dish-base', 6, 2, 6, 21, 58.5, -7, charcoal);
        this._limb(root, 'hq-dish-mount', [21, 59, -7], [21, 66, -7], 3.2, 3.2, charcoal);
        const dish = new BABYLON.Mesh('hq-dish-pivot', this.scene);
        dish.parent = root;
        dish.position.set(21, 68, -7);
        dish.rotation.set(0.75, 0, -0.35);
        this._cyl(dish, 'hq-dish', 2.2, 15, 8, 0, 0, 0, hull, 12);
        this._cyl(dish, 'hq-dish-inner', 0.6, 12, 6, 0, 0.6, 0, hullShade, 12);
        const rim = BABYLON.MeshBuilder.CreateTorus('hq-dish-rim', {
            diameter: 15.5, thickness: 1.2, tessellation: 18
        }, this.scene);
        rim.material = metal;
        rim.parent = dish;
        rim.position.y = 1.1;
        this._box(dish, 'hq-feed', 1.8, 9, 1.8, 0, 5.5, 0, metalDark);
        this._box(dish, 'hq-feed-tip', 3.2, 2.4, 3.2, 0, 10.4, 0, team);
    }

    // The barracks: a squat low-poly bunker next to the HQ. The hull, roof and gate are
    // neutral; the entrance band, corner plates, side panels, stair ramp and vent skirt
    // take the team colour. Faces +Z, base on Y = 0, antenna top at ~52 px.
    _buildBarracks(root, m) {
        const team = m.team;
        const hull = m.hull, hullShade = m.hullShade;
        const charcoal = m.charcoal, charcoalLight = m.charcoalLight;
        const glow = m.glow, metal = m.metal, metalDark = m.metalDark;
        const octa = Math.PI / 8;
        const square = Math.PI / 4;

        const plinth = this._cyl(root, 'barracks-plinth', 5, 38, 42, 0, 2.5, 0, charcoal, 8);
        plinth.rotation.y = octa;
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                const foot = this._cyl(root, 'barracks-foot', 6, 9, 12, 17.5 * sx, 3, 16.5 * sz, charcoal, 4);
                foot.rotation.y = square;
            }
        }
        const deck = this._cyl(root, 'barracks-deck', 3, 36, 38, 0, 5.5, 0, charcoalLight, 8);
        deck.rotation.y = octa;

        this._box(root, 'barracks-body', 32, 22, 32, 0, 17, 0, hull);
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                this._box(root, 'barracks-corner', 8, 24, 8, 15 * sx, 18, 15 * sz, hull);
                this._box(root, 'barracks-corner-cap', 8.6, 1.4, 8.6, 15 * sx, 30.7, 15 * sz, hullShade);
                this._limb(root, 'barracks-brace',
                    [15 * sx, 29.5, 15 * sz], [10.2 * sx, 39.2, 10.2 * sz], 2.6, 2.6, hullShade);
            }
        }
        this._box(root, 'barracks-upper', 30, 10, 30, 0, 33, 0, hull);
        this._box(root, 'barracks-roof-trim', 30.8, 1.2, 30.8, 0, 38.4, 0, hullShade);
        this._box(root, 'barracks-roof', 29, 4, 29, 0, 40.6, 0, hull);
        this._box(root, 'barracks-roof-cap', 25, 1.4, 25, 0, 43.2, 0, hullShade);

        this._box(root, 'barracks-portal', 20, 17, 1.4, 0, 14.5, 16.4, charcoal);
        this._box(root, 'barracks-door-l', 7.6, 15, 1, -4, 13.5, 17.2, charcoalLight);
        this._box(root, 'barracks-door-r', 7.6, 15, 1, 4, 13.5, 17.2, charcoalLight);
        for (let i = 0; i < 3; i++) {
            this._box(root, 'barracks-door-line', 15.4, 0.35, 0.4, 0, 10 + i * 4, 17.8, charcoal);
        }
        for (const sx of [-1, 1]) {
            this._box(root, 'barracks-portal-jamb', 1, 17, 2, 10.2 * sx, 14.5, 16.8, charcoal);
        }

        this._box(root, 'barracks-lintel', 22, 2.2, 2.6, 0, 24.1, 16.9, charcoal);
        this._box(root, 'barracks-canopy', 26, 4.5, 7.5, 0, 27.35, 18.8, charcoalLight);
        this._box(root, 'barracks-canopy-lip', 27, 1, 1.2, 0, 24.8, 22.3, charcoal);
        this._box(root, 'barracks-canopy-light', 14, 0.45, 0.6, 0, 24.3, 22.35, glow);

        this._box(root, 'barracks-band-frame', 27, 9.4, 1, 0, 33.6, 15.2, hullShade);
        this._box(root, 'barracks-band', 25, 7.2, 1.4, 0, 33.6, 15.7, team);
        for (let i = -1; i <= 1; i++) {
            this._box(root, 'barracks-band-light', 3, 1.2, 0.5, i * 6.5, 33.6, 16.5, glow);
        }

        for (const sx of [-1, 1]) {
            this._box(root, 'barracks-corner-frame', 6.8, 10.5, 0.5, 15 * sx, 19.5, 19.05, hullShade);
            this._box(root, 'barracks-corner-panel', 5.4, 8.8, 0.7, 15 * sx, 19.5, 19.45, team);
            this._box(root, 'barracks-corner-side-frame', 0.5, 10.5, 6.8, 19.05 * sx, 19.5, 15, hullShade);
            this._box(root, 'barracks-corner-side-panel', 0.7, 8.8, 5.4, 19.45 * sx, 19.5, 15, team);

            this._box(root, 'barracks-side-frame', 0.7, 14, 18, 16.2 * sx, 19, -1, hullShade);
            this._box(root, 'barracks-side-panel', 0.7, 12, 16, 16.65 * sx, 19, -1, team);
            for (let i = 0; i < 3; i++) {
                const stripe = this._box(root, 'barracks-side-stripe', 0.35, 1.1, 4, 17.05 * sx, 15.6 + i * 3.4, -1, hull);
                stripe.rotation.x = 0.45;
            }
            for (let i = 0; i < 3; i++) {
                this._box(root, 'barracks-side-vent', 0.5, 1.5, 4.4, 15.25 * sx, 31.5, -6 + i * 5, metalDark);
            }
        }

        const ventSkirt = this._cyl(root, 'barracks-vent-skirt', 2.8, 18, 20, 0, 44.4, 0, team, 8);
        ventSkirt.rotation.y = octa;
        ventSkirt.convertToFlatShadedMesh();
        const ventDrum = this._cyl(root, 'barracks-vent-drum', 3.6, 13, 14, 0, 47.6, 0, charcoal, 8);
        ventDrum.rotation.y = octa;
        ventDrum.convertToFlatShadedMesh();
        const ventRing = this._cyl(root, 'barracks-vent-ring', 1, 15.4, 15.4, 0, 49.9, 0, metal, 8);
        ventRing.rotation.y = octa;
        const ventTop = this._cyl(root, 'barracks-vent-top', 0.9, 11.5, 11.5, 0, 50.6, 0, charcoalLight, 8);
        ventTop.rotation.y = octa;
        for (let i = -2; i <= 2; i++) {
            this._box(root, 'barracks-vent-slat', 8.5, 0.45, 1, 0, 51.2, i * 1.8, charcoal);
        }

        this._box(root, 'barracks-hatch', 14, 3, 9, 0, 44.8, -8, hullShade);
        this._box(root, 'barracks-hatch-top', 11, 1, 6.5, 0, 46.1, -8, hull);
        this._box(root, 'barracks-gear', 8, 5, 7, 9.5, 45.5, -9.5, charcoalLight);
        this._box(root, 'barracks-gear-top', 6, 1, 5, 9.5, 48, -9.5, charcoal);
        this._box(root, 'barracks-mast-base', 4.2, 2.6, 4.2, 9.5, 49.2, -9.5, charcoal);
        this._box(root, 'barracks-mast-collar', 3, 1.6, 3, 9.5, 51.2, -9.5, metal);
        this._cyl(root, 'barracks-mast', 9, 1.4, 2.2, 9.5, 56.2, -9.5, hullShade, 8);
        this._box(root, 'barracks-mast-tip', 1.4, 1, 1.4, 9.5, 61.2, -9.5, metalDark);
        this._box(root, 'barracks-mast-light', 1.6, 2.6, 1.2, 9.5, 53.2, -9.5, team);

        this._box(root, 'barracks-rear-portal', 12, 15, 1.2, 0, 13.5, -16.4, charcoal);
        this._box(root, 'barracks-rear-door', 9, 13, 0.8, 0, 13, -17, metalDark);
        this._box(root, 'barracks-rear-hood', 14, 2, 3.5, 0, 22, -17, charcoalLight);
        for (const sx of [-1, 1]) {
            this._cyl(root, 'barracks-rear-pipe', 14, 1.8, 1.8, 8 * sx, 14, -16.2, metalDark, 8);
            this._box(root, 'barracks-rear-vent', 5, 1.6, 0.6, 4 * sx, 31, -15.25, charcoal);
        }

        this._box(root, 'barracks-porch', 24, 4, 7, 0, 2, 20, hullShade);
        for (let i = 0; i < 4; i++) {
            const height = 6 - i * 1.5;
            this._box(root, 'barracks-step', 20, height, 1.8, 0, height / 2, 18.2 + i * 1.8, hullShade);
        }
        for (const sx of [-1, 1]) {
            this._box(root, 'barracks-stair-wall', 3, 7.2, 8.6, 11.5 * sx, 3.6, 21.2, hullShade);
            this._box(root, 'barracks-stair-wall-cap', 3.2, 1, 8.8, 11.5 * sx, 7.4, 21.2, hull);
        }
        const ramp = this._box(root, 'barracks-ramp', 6.4, 0.6, 9.6, 0, 3.2, 21, team);
        ramp.rotation.x = 0.68;
        for (const sx of [-1, 1]) {
            const edge = this._box(root, 'barracks-ramp-edge', 0.8, 0.7, 9.6, 3.6 * sx, 3.2, 21, hull);
            edge.rotation.x = 0.68;
        }
    }

    // The receiving point from the reference: a stepped bunker — a low wing on the left and a
    // taller block on the right. The tall block's front wall carries a shutter door inside a
    // chamfered team-coloured arch with a hazard-striped sill; the wing has a cyan strip and
    // a louvred vent panel; the right wall has a vertical cyan window and a team band; the
    // roof carries a louvred module and an antenna mast with the red beacon. Crates with team
    // straps stand by the wing. The hull, the plinth, the door slats, the hazard band, the
    // cyan strips and the beacon are neutral. Faces +Z, base on Y = 0, beacon top at ~51 px.
    _buildDepot(root, m) {
        const team = m.team;
        const hull = m.hull, hullShade = m.hullShade;
        const charcoal = m.charcoal, charcoalLight = m.charcoalLight;
        const glow = m.glow, beacon = m.beacon;
        const metal = m.metal, metalDark = m.metalDark;
        const hazard = m.hazard, crate = m.crate, crateDark = m.crateDark;

        // Plinth and feet.
        this._box(root, 'depot-plinth', 46, 4, 32, 0, 2, 0, charcoal);
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                this._box(root, 'depot-foot', 7, 4, 7, 17 * sx, 2, 11 * sz, charcoalLight);
            }
        }

        // The tall right block: a darker lower band, a light upper band, a roof plate.
        this._box(root, 'depot-lower', 30, 8, 28, 7, 8, 0, hullShade);
        this._box(root, 'depot-upper', 30, 16, 28, 7, 20, 0, hull);
        this._box(root, 'depot-roof', 31, 3, 29, 7, 29.5, 0, hullShade);

        // The low left wing, one step down, with a team fascia along its roof edge.
        this._box(root, 'depot-wing-lower', 14, 8, 30, -15, 8, 0, hullShade);
        this._box(root, 'depot-wing-upper', 14, 8, 30, -15, 16, 0, hull);
        this._box(root, 'depot-wing-cap', 15, 2.5, 31, -15, 21.25, 0, hullShade);
        this._box(root, 'depot-wing-trim', 14, 1.6, 1.6, -15, 21.6, 15.9, team);

        // Front wall of the wing: a cyan strip and a louvred vent panel.
        this._box(root, 'depot-wing-light', 9, 1.6, 0.8, -15, 16.5, 15.6, glow);
        this._box(root, 'depot-vent', 8, 5, 0.8, -15, 9, 15.5, charcoal);
        for (let i = 0; i < 4; i++) {
            this._box(root, 'depot-vent-slat', 7, 0.7, 0.5, -15, 7.4 + i * 1.1, 16.1, charcoalLight);
        }

        // Right wall: a vertical cyan window and a team band along the bottom.
        this._box(root, 'depot-window-frame', 0.8, 12, 5, 22.3, 17, -4, charcoal);
        this._box(root, 'depot-window', 0.6, 10, 3.6, 22.7, 17, -4, glow);
        this._box(root, 'depot-side-band', 0.8, 3, 20, 22.3, 6.5, -3, team);

        // Shutter door: a dark bay, horizontal slats and a hazard-striped sill.
        this._box(root, 'depot-door', 22, 20, 0.8, 8, 14, 14.4, charcoal);
        for (let i = 0; i < 6; i++) {
            this._box(root, 'depot-door-slat', 20, 1.4, 0.4, 8, 9 + i * 2.6, 15.1, charcoalLight);
        }
        this._box(root, 'depot-door-sill', 22, 3, 0.6, 8, 5.5, 15.15, metalDark);
        for (let i = 0; i < 5; i++) {
            const stripe = this._box(root, 'depot-hazard', 3.8, 3.8, 0.4, -0.6 + i * 4.3, 5.5, 15.75, hazard);
            stripe.rotation.z = 0.72;
        }

        // The team arch around the door: two posts, two chamfered shoulders and a lintel —
        // the octagonal outline of the reference.
        this._box(root, 'depot-frame-l', 2.4, 17, 1, -4.2, 12, 15.3, team);
        this._box(root, 'depot-frame-r', 2.4, 17, 1, 20.2, 12, 15.3, team);
        const shoulderL = this._box(root, 'depot-frame-sh-l', 5.4, 2.4, 1, -1.2, 22.3, 15.3, team);
        shoulderL.rotation.z = 0.785;
        const shoulderR = this._box(root, 'depot-frame-sh-r', 5.4, 2.4, 1, 17.2, 22.3, 15.3, team);
        shoulderR.rotation.z = -0.785;
        this._box(root, 'depot-frame-top', 16, 2.4, 1, 8, 25.3, 15.3, team);

        // Cyan bar on the wall above the arch.
        this._box(root, 'depot-door-light', 12, 1.4, 0.8, 8, 27.2, 14.4, glow);

        // Roof module with a louvre slot facing the front.
        this._box(root, 'depot-module', 16, 7, 13, -1, 34.5, -2, hullShade);
        this._box(root, 'depot-module-cap', 16.6, 1, 13.6, -1, 38.5, -2, hull);
        this._box(root, 'depot-module-louvre', 11, 3.4, 0.9, -1, 34.5, 4.6, charcoal);
        for (let i = 0; i < 3; i++) {
            this._box(root, 'depot-module-slat', 10, 0.6, 0.5, -1, 33.3 + i * 1.2, 5.2, charcoalLight);
        }

        // Antenna mast with the red beacon on its own block.
        this._box(root, 'depot-mast-base', 6, 4, 6, 17, 33, -6, hullShade);
        this._box(root, 'depot-mast-collar', 3, 1.6, 3, 17, 35.8, -6, charcoal);
        this._box(root, 'depot-mast', 1.2, 10, 1.2, 17, 41.5, -6, metal);
        this._box(root, 'depot-beacon', 2, 3, 2, 17, 48.3, -6, beacon);
        this._box(root, 'depot-beacon-cap', 2.4, 0.8, 2.4, 17, 50.1, -6, beacon);

        // Receiving apron in front of the door.
        this._box(root, 'depot-apron', 22, 1.5, 6, 8, 0.75, 17, hullShade);
        this._box(root, 'depot-apron-edge', 22, 0.5, 0.8, 8, 1.6, 19.9, metal);

        // Strapped crates by the wing.
        this._box(root, 'depot-crate-low', 10, 9, 9, -16, 4.5, 18, crate);
        this._box(root, 'depot-crate-strap-h', 10.6, 1.5, 9.6, -16, 4.5, 18, team);
        this._box(root, 'depot-crate-strap-v', 1.5, 9.6, 9.6, -19, 4.5, 18, team);
        this._box(root, 'depot-crate-high', 8.5, 8, 8.5, -16, 13.5, 18, crate);
        this._box(root, 'depot-crate-high-lid', 8.9, 1, 8.9, -16, 17.5, 18, crateDark);
        this._box(root, 'depot-crate-high-strap', 9.1, 1.4, 9.1, -16, 13.5, 18, team);
        this._box(root, 'depot-crate-small', 7, 6.5, 7, -6.5, 3.25, 21, crate);
        this._box(root, 'depot-crate-small-strap', 7.5, 1.2, 7.5, -6.5, 3.25, 21, team);
    }

    // The military factory from the reference: a wide hall with a sloped team-coloured front
    // panel and a white gear emblem, a low wing with cyan strips, a round storage tank with
    // team bands, two tapered chimneys, a railed roof hatch and a striped entry ramp. Team
    // colour fills the front panel, the roof stripe, the tank and chimney bands, the wing
    // fascia, the hall side plate and the side trim; the hull, plinth, gate, hazard stripes,
    // cyan lights and the gear stay neutral. Faces +Z, base on Y = 0, chimney tops at ~70 px.
    _buildFactory(root, m) {
        const team = m.team;
        const hull = m.hull, hullShade = m.hullShade;
        const charcoal = m.charcoal, charcoalLight = m.charcoalLight;
        const glow = m.glow, hazard = m.hazard;
        const metalDark = m.metalDark;

        // Plinth, deck and corner feet.
        this._box(root, 'factory-plinth', 52, 4, 44, 0, 2, 0, charcoal);
        this._box(root, 'factory-deck', 46, 2.4, 38, 0, 5.2, -1, charcoalLight);
        for (const sx of [-1, 1]) {
            this._box(root, 'factory-foot', 7, 4, 7, 22 * sx, 2, 18, charcoalLight);
            this._box(root, 'factory-foot-back', 7, 4, 7, 22 * sx, 2, -17, charcoalLight);
        }

        // Main hall: a charcoal base band, the lower white body and the recessed upper mass
        // that leaves the front for the big sloped roof panel.
        this._box(root, 'factory-base-band', 34, 5, 34, 7, 8.5, 0, charcoal);
        this._box(root, 'factory-body', 32, 20, 32, 7, 16, 0, hull);
        this._box(root, 'factory-body-shade', 33, 5, 33, 7, 10.5, 0, hullShade);
        this._box(root, 'factory-upper', 32, 9, 23, 7, 30.5, -4.5, hull);
        this._box(root, 'factory-roof', 33, 2.0, 24, 7, 35.4, -4.5, hullShade);
        this._box(root, 'factory-parapet-back', 33, 1.8, 1.4, 7, 36.0, -15.6, charcoalLight);
        for (const sx of [-1, 1]) {
            this._box(root, 'factory-parapet-side', 1.4, 1.8, 23, 7 + 15.8 * sx, 36.0, -4.5, charcoalLight);
        }

        // Stepped side gussets hide the triangular gap under the sloped panel without a
        // hand-made triangular mesh: four short walls of falling height along the slope.
        for (const sx of [-1, 1]) {
            for (let i = 0; i < 4; i++) {
                const z = 8.1 + i * 2.25;
                const h = 8.2 - i * 2.1;
                this._box(root, 'factory-gusset', 0.9, h, 2.3, 16.2 * sx, 26 + h / 2, z, hull);
            }
        }

        // The sloped front panel: a light frame, the team face and the white gear emblem.
        const slope = -Math.PI / 4;
        const facadeY = 30.5, facadeZ = 11.5;
        const frame = this._box(root, 'factory-facade-frame', 34, 14.4, 1.0, 7, facadeY, facadeZ, hullShade);
        frame.rotation.x = slope;
        const panel = this._box(root, 'factory-facade', 30, 12.2, 1.6, 7, facadeY + 0.2, facadeZ + 0.5, team);
        panel.rotation.x = slope;

        const gear = new BABYLON.Mesh('factory-gear-pivot', this.scene);
        gear.parent = root;
        gear.position.set(7, facadeY + 0.2 + 0.707 * 1.1, facadeZ + 0.5 + 0.707 * 1.1);
        gear.rotation.x = slope;
        const gearRing = this._torus(gear, 'factory-gear', 9.4, 2.0, 0, 0, 0, hull, 18);
        gearRing.rotation.x = Math.PI / 2;
        for (let i = 0; i < 8; i++) {
            const a = Math.PI * 2 * i / 8;
            const tooth = this._box(gear, 'factory-gear-tooth', 2.2, 2.6, 1.4,
                Math.cos(a) * 5.3, Math.sin(a) * 5.3, 0, hull);
            tooth.rotation.z = a - Math.PI / 2;
        }

        // Gate: the dark portal, a hazard bar on each side, the cyan lintel and the opening.
        this._box(root, 'factory-gate-frame', 24, 20, 2.4, 7, 14, 16.9, charcoal);
        this._box(root, 'factory-gate-cap', 26, 2.2, 3, 7, 24.4, 16.7, charcoalLight);
        this._box(root, 'factory-gate-back', 18, 17, 1.2, 7, 13.5, 18.2, metalDark);
        this._box(root, 'factory-gate-inner', 15, 15, 0.8, 7, 13, 18.8, metalDark);
        this._box(root, 'factory-gate-side', 1.6, 12, 0.7, 13, 12.5, 19.3, hazard);
        this._box(root, 'factory-gate-light', 12, 1.2, 0.8, 7, 22.3, 18.4, glow);
        for (const sx of [-1, 1]) {
            this._box(root, 'factory-gate-bar', 1.8, 12, 1.4, 7 + 8.5 * sx, 12.5, 18.5, hazard);
        }

        // The entry ramp with two hazard stripes.
        const ramp = new BABYLON.Mesh('factory-ramp-pivot', this.scene);
        ramp.parent = root;
        ramp.position.set(7, 3.2, 23.2);
        ramp.rotation.x = 0.43;
        this._box(ramp, 'factory-ramp', 17, 0.8, 14, 0, 0, 0, hullShade);
        for (const sx of [-1, 1]) {
            this._box(ramp, 'factory-ramp-rail', 1.0, 1.4, 14, 8.5 * sx, 0.7, 0, hull);
            this._box(ramp, 'factory-ramp-stripe', 1.8, 0.2, 10.5, 3.6 * sx, 0.5, 0.6, hazard);
        }

        // Low wing on the left: cyan strips, the team fascia and the yellow side door.
        this._box(root, 'factory-wing-base', 18, 4, 26, -11, 8, 4, hullShade);
        this._box(root, 'factory-wing-body', 16, 18, 24, -11, 19, 4, hull);
        this._box(root, 'factory-wing-roof', 17, 2, 25, -11, 28.8, 4, hullShade);
        this._box(root, 'factory-wing-roof-trim', 17.4, 1, 25.4, -11, 29.8, 4, charcoalLight);
        this._box(root, 'factory-wing-team', 15, 1.6, 1.0, -11, 27.1, 16.3, team);
        this._box(root, 'factory-wing-light', 9, 1.2, 0.8, -12, 22, 16.5, glow);
        this._box(root, 'factory-wing-light-2', 9, 1.2, 0.8, -12, 19.5, 16.5, glow);
        this._box(root, 'factory-wing-door-frame', 6.4, 8.4, 1.0, -7.5, 12.5, 16.4, charcoal);
        this._box(root, 'factory-wing-door', 4.6, 6.8, 0.8, -7.5, 12, 16.9, hazard);
        this._box(root, 'factory-wing-door-line', 4.8, 0.5, 0.5, -7.5, 15, 17.35, charcoal);
        for (let i = 0; i < 3; i++) {
            this._box(root, 'factory-wing-vent', 0.8, 1.2, 6, -19.2, 14 + i * 3, 7, charcoal);
        }
        this._box(root, 'factory-wing-side', 0.8, 8, 12, -19.2, 21, 2, hullShade);
        this._box(root, 'factory-wing-side-team', 0.9, 2, 10, -19.4, 20, 2, team);

        // Hall side plate and the right wall detail.
        this._box(root, 'factory-side-frame', 1.0, 14, 12, -9.2, 22, 4, charcoal);
        this._box(root, 'factory-side-panel', 0.9, 12, 10, -9.4, 22, 4, team);
        this._box(root, 'factory-side-light', 0.8, 1.2, 8, -9.6, 28, 4, glow);
        this._box(root, 'factory-right-panel', 0.8, 10, 8, 23.2, 22, -2, hullShade);
        this._box(root, 'factory-right-team', 0.8, 2.4, 10, 23.4, 15, -2, team);
        this._box(root, 'factory-right-vent', 0.8, 1.2, 6, 23.4, 24, -8, charcoal);

        // Dark service pipe at the wing/hall seam with its hazard clamp.
        const pipe = this._cyl(root, 'factory-pipe', 23, 3.4, 3.8, -5, 15.5, 18.2, metalDark, 10);
        pipe.convertToFlatShadedMesh();
        this._box(root, 'factory-pipe-clamp', 4.4, 1.6, 4.4, -5, 19, 18.2, hazard);
        this._limb(root, 'factory-pipe-foot', [-5, 4, 18.2], [-12, 4, 11], 3.4, 3.4, metalDark);
        this._limb(root, 'factory-pipe-top', [-5, 27.2, 18.2], [-5, 27.2, 9], 3.4, 3.4, metalDark);

        // Round storage tank on the left: dark base ring, two team bands, the domed cap.
        this._box(root, 'factory-tank-platform', 16, 2.4, 16, -21.5, 5.2, -9, charcoalLight);
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                this._box(root, 'factory-tank-leg', 2.4, 5, 2.4, -21.5 + 5.2 * sx, 8, -9 + 5.2 * sz, charcoal);
            }
        }
        const tankBase = this._cyl(root, 'factory-tank-base', 2, 15, 13, -21.5, 10.5, -9, charcoalLight, 12);
        tankBase.convertToFlatShadedMesh();
        const tankBody = this._cyl(root, 'factory-tank-body', 24, 13, 13, -21.5, 23.5, -9, hull, 12);
        tankBody.convertToFlatShadedMesh();
        const tankBandA = this._cyl(root, 'factory-tank-band-a', 3.4, 13.4, 13.4, -21.5, 20, -9, team, 12);
        tankBandA.convertToFlatShadedMesh();
        const tankBandB = this._cyl(root, 'factory-tank-band-b', 3.4, 13.4, 13.4, -21.5, 27, -9, team, 12);
        tankBandB.convertToFlatShadedMesh();
        this._cyl(root, 'factory-tank-rim', 2, 13, 12, -21.5, 36.5, -9, charcoalLight, 12);
        const tankDome = this._cyl(root, 'factory-tank-dome', 4, 8, 12, -21.5, 39.5, -9, hullShade, 12);
        tankDome.convertToFlatShadedMesh();
        this._cyl(root, 'factory-tank-knob', 2.4, 4, 6, -21.5, 42.7, -9, charcoalLight, 10);
        this._cyl(root, 'factory-tank-cap', 1.0, 4, 4, -21.5, 44.4, -9, hullShade, 10);
        this._limb(root, 'factory-tank-pipe', [-14, 26, -7], [-9, 22, -1], 3.0, 3.0, metalDark);

        // Two tapered chimneys with team bands and dark caps.
        this._box(root, 'factory-chimney-base-a', 10, 3.4, 10, 6, 36.2, -12, charcoalLight);
        const chimneyA = this._cyl(root, 'factory-chimney-a', 30, 5.8, 9, 6, 52, -12, hull, 8);
        chimneyA.convertToFlatShadedMesh();
        const chimneyABand = this._cyl(root, 'factory-chimney-band-a', 3.2, 6.6, 7.0, 6, 61.2, -12, team, 8);
        chimneyABand.convertToFlatShadedMesh();
        const chimneyACap = this._cyl(root, 'factory-chimney-cap-a', 3.6, 4.8, 6.2, 6, 68.3, -12, charcoal, 8);
        chimneyACap.convertToFlatShadedMesh();
        const chimneyAHole = this._cyl(root, 'factory-chimney-hole-a', 3.4, 3.2, 3.6, 6, 68.6, -12, metalDark, 8);
        chimneyAHole.convertToFlatShadedMesh();

        this._box(root, 'factory-chimney-base-b', 9, 3, 9, 15.5, 36, -13, charcoalLight);
        const chimneyB = this._cyl(root, 'factory-chimney-b', 26, 5.2, 8, 15.5, 50, -13, hull, 8);
        chimneyB.convertToFlatShadedMesh();
        const chimneyBBand = this._cyl(root, 'factory-chimney-band-b', 3.0, 6.2, 5.8, 15.5, 57.5, -13, team, 8);
        chimneyBBand.convertToFlatShadedMesh();
        const chimneyBCap = this._cyl(root, 'factory-chimney-cap-b', 3.4, 4.2, 5.6, 15.5, 64.2, -13, charcoal, 8);
        chimneyBCap.convertToFlatShadedMesh();
        const chimneyBHole = this._cyl(root, 'factory-chimney-hole-b', 3.2, 2.8, 3.2, 15.5, 64.5, -13, metalDark, 8);
        chimneyBHole.convertToFlatShadedMesh();

        // Roof hatch under the yellow railing, the team roof stripe and the vent blocks.
        this._box(root, 'factory-hatch-base', 15, 2, 12, -1, 36.4, 0, hullShade);
        const hatchDome = this._cyl(root, 'factory-hatch-dome', 4, 8, 12, -1, 39.4, 0, hullShade, 8);
        hatchDome.convertToFlatShadedMesh();
        this._box(root, 'factory-roof-team', 6.5, 0.8, 22, 7, 36.8, -5, team);
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                this._box(root, 'factory-rail-post', 1.1, 6, 1.1, -1 + 7 * sx, 40.2, 5 * sz, hazard);
            }
        }
        for (const sz of [-1, 1]) {
            this._box(root, 'factory-rail-front', 15, 0.9, 0.9, -1, 42.8, 5 * sz, hazard);
            this._box(root, 'factory-rail-lower', 15, 0.7, 0.7, -1, 40.8, 5 * sz, hazard);
        }
        for (const sx of [-1, 1]) {
            this._box(root, 'factory-rail-side', 0.9, 0.9, 10.9, -1 + 7 * sx, 42.8, 0, hazard);
            this._box(root, 'factory-rail-side-lower', 0.7, 0.7, 10.9, -1 + 7 * sx, 40.8, 0, hazard);
        }
        this._box(root, 'factory-roof-vent-a', 8, 3.4, 8, 17, 37.3, 2, charcoal);
        this._box(root, 'factory-roof-vent-b', 6, 2.4, 6, 18, 37.8, 5, charcoalLight);
        this._limb(root, 'factory-roof-pipe', [10, 36.5, -8], [2, 40, -2], 2.4, 2.4, metalDark);
    }

    // The defence turret from the reference: four armoured feet under an octagonal skirt,
    // a dark collar with a cyan light ring, and a blocky head carrying a faceted cannon.
    // The hull, frame and cyan lights stay neutral; the team colour is the foot plates, the
    // skirt belt, the cheek panels, the rear stripe and the support-arm bar. Faces +Z,
    // base on Y = 0, top at ~43 px.
    _buildTurret(root, m) {
        const team = m.team;
        const hull = m.hull, hullShade = m.hullShade;
        const charcoal = m.charcoal, charcoalLight = m.charcoalLight;
        const glow = m.glow;
        const metalDark = m.metalDark;
        const octa = Math.PI / 8;
        const cardinal = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
        const at = (radius, phi) => [Math.sin(phi) * radius, Math.cos(phi) * radius];

        // Four broad feet around the base: a tapered charcoal block, a pale cap, a team
        // plate on the outer face and a cyan slit below it.
        for (const phi of cardinal) {
            const [fx, fz] = at(12.5, phi);
            const foot = this._cyl(root, 'turret-foot', 5, 9, 12, fx, 2.5, fz, charcoal, 4);
            foot.rotation.y = Math.PI / 4;
            foot.convertToFlatShadedMesh();
            const cap = this._box(root, 'turret-foot-cap', 8, 1, 8, fx, 5.2, fz, hullShade);
            cap.rotation.y = phi;
            const [tx, tz] = at(17.6, phi);
            const plate = this._box(root, 'turret-foot-team', 4.6, 1.4, 0.6, tx, 3.3, tz, team);
            plate.rotation.y = phi;
            const [gx, gz] = at(18.0, phi);
            const slit = this._box(root, 'turret-foot-glow', 3.2, 0.7, 0.5, gx, 1.9, gz, glow);
            slit.rotation.y = phi;
        }

        // Octagonal plinth and the sloped armoured skirt.
        const plinth = this._cyl(root, 'turret-plinth', 3, 33, 34, 0, 1.5, 0, charcoal, 8);
        plinth.rotation.y = octa;
        plinth.convertToFlatShadedMesh();
        const skirt = this._cyl(root, 'turret-skirt', 10, 30, 38, 0, 8, 0, hull, 8);
        skirt.rotation.y = octa;
        skirt.convertToFlatShadedMesh();
        const belt = this._cyl(root, 'turret-belt', 1.6, 31.2, 31.2, 0, 12.2, 0, team, 8);
        belt.rotation.y = octa;
        const rim = this._cyl(root, 'turret-rim', 1.8, 30.4, 30.4, 0, 14.1, 0, hullShade, 8);
        rim.rotation.y = octa;
        rim.convertToFlatShadedMesh();

        // Dark collar with a cyan light ring and the small notch on the front.
        const collar = this._cyl(root, 'turret-collar', 4, 22, 25, 0, 17, 0, charcoal, 8);
        collar.rotation.y = octa;
        collar.convertToFlatShadedMesh();
        const ring = this._cyl(root, 'turret-glow-ring', 1.0, 24.6, 24.6, 0, 16.4, 0, glow, 8);
        ring.rotation.y = octa;
        this._box(root, 'turret-ring-notch', 2.2, 1.2, 1.0, 0, 16.4, 12.3, charcoal);
        const collarCap = this._cyl(root, 'turret-collar-cap', 1.2, 22, 22, 0, 19.1, 0, charcoalLight, 8);
        collarCap.rotation.y = octa;

        // Neck and head base.
        const neck = this._cyl(root, 'turret-neck', 4.5, 16, 18, 0, 21.5, 0, charcoal, 8);
        neck.rotation.y = octa;
        neck.convertToFlatShadedMesh();
        const neckRing = this._cyl(root, 'turret-neck-ring', 1.0, 19, 19, 0, 19.8, 0, charcoalLight, 8);
        neckRing.rotation.y = octa;
        const headBase = this._cyl(root, 'turret-head-base', 3, 20, 19, 0, 25.5, 0, charcoalLight, 8);
        headBase.rotation.y = octa;
        headBase.convertToFlatShadedMesh();

        // Head: a charcoal core with pale armour on the sides and back.
        this._box(root, 'turret-core', 15, 10, 13, 0, 31.5, 0, charcoal);
        this._box(root, 'turret-top', 16, 3, 14, 0, 38, -0.5, hull);
        this._box(root, 'turret-back', 14, 9, 7, 0, 33, -8.5, hull);
        this._box(root, 'turret-back-team', 9, 2, 0.6, 0, 33.5, -12.3, team);
        for (const sx of [-1, 1]) {
            this._box(root, 'turret-cheek', 3, 9, 12, 8.6 * sx, 32, 1.5, hull);
            this._box(root, 'turret-cheek-team', 0.6, 2.4, 6.5, 10.25 * sx, 33, 1.5, team);
        }
        this._box(root, 'turret-brow', 13, 4.5, 6, 0, 36.5, 4.5, hull);
        this._box(root, 'turret-mantlet', 12, 7, 3, 0, 31.5, 7.8, hullShade);
        this._box(root, 'turret-mantlet-slot', 8, 4, 1, 0, 31.5, 9.4, charcoal);
        this._box(root, 'turret-screen-frame', 4.4, 3.2, 0.8, 8.4, 33.5, 7.8, charcoal);
        this._box(root, 'turret-screen', 3.4, 2.2, 0.6, 8.4, 33.5, 8.25, glow);
        this._box(root, 'turret-top-block', 7, 3, 7, 0, 40.5, -5, hull);
        this._box(root, 'turret-top-cap', 8, 1, 8, 0, 42.5, -5, hullShade);

        // The cannon along +Z: faceted dark barrel with a pale band, a heavy muzzle ring
        // and the cyan lens. Side and top strips keep the reference's glowing accents.
        const barrel = (name, height, top, bottom, z, mat) => {
            const part = this._cyl(root, name, height, top, bottom, 0, 31.5, z, mat, 8);
            part.rotation.x = Math.PI / 2;
            part.convertToFlatShadedMesh();
            return part;
        };
        barrel('turret-barrel-collar', 5, 11, 12, 9.8, charcoal);
        barrel('turret-barrel', 8, 8.4, 8.4, 14.5, charcoalLight);
        barrel('turret-barrel-band', 2.6, 9.2, 9.2, 18, hull);
        barrel('turret-barrel-front', 6, 8.2, 8.2, 21.5, charcoal);
        barrel('turret-muzzle', 3, 11, 11, 25.5, charcoalLight);
        barrel('turret-muzzle-inner', 0.6, 8.2, 8.2, 27.1, charcoal);
        barrel('turret-lens', 0.5, 5.6, 5.6, 27.5, glow);
        for (const sx of [-1, 1]) {
            this._box(root, 'turret-barrel-glow', 0.7, 1.2, 7.5, 4.25 * sx, 31.5, 14.5, glow);
        }
        this._box(root, 'turret-barrel-top-glow', 1.2, 0.6, 7.5, 0, 35.9, 14.5, glow);

        // Right support arm with its dark hub, plus a small hub on the left.
        this._limb(root, 'turret-arm', [8.5, 35, 3.5], [12, 27, 4.5], 5, 7.5, hull);
        this._limb(root, 'turret-arm-team', [10.08, 31.4, 3.95], [10.6, 30.2, 4.1], 5.6, 8.1, team);
        const hub = this._cyl(root, 'turret-hub', 3, 9, 9, 12.8, 27, 4.5, charcoal, 10);
        hub.rotation.z = Math.PI / 2;
        hub.convertToFlatShadedMesh();
        const hubCap = this._cyl(root, 'turret-hub-cap', 0.9, 6.6, 6.6, 14.5, 27, 4.5, charcoalLight, 10);
        hubCap.rotation.z = Math.PI / 2;
        const leftHub = this._cyl(root, 'turret-left-hub', 2.5, 6, 6, -10.4, 28, 3, charcoal, 10);
        leftHub.rotation.z = Math.PI / 2;
        leftHub.convertToFlatShadedMesh();
        this._box(root, 'turret-left-pin', 0.8, 2.2, 2.2, -11.9, 28, 3, metalDark);
    }

    // The generator from the reference: an octagonal reactor tower on four corner feet.
    // Neutral grey hull and charcoal frame around the cyan reactor; the team colour is the
    // four buttress panels on the plinth and the four strips on the head. Faces +Z, base on
    // Y = 0, antenna top at ~46 px.
    _buildGenerator(root, m) {
        const team = m.team;
        const hull = m.hull, hullShade = m.hullShade;
        const charcoal = m.charcoal, charcoalLight = m.charcoalLight;
        const glow = m.glow;
        const metal = m.metal, metalDark = m.metalDark;
        const octa = Math.PI / 8;
        const flat = Math.cos(octa);
        const cardinal = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
        const diagonal = [Math.PI / 4, Math.PI * 3 / 4, Math.PI * 5 / 4, Math.PI * 7 / 4];
        const at = (radius, phi) => [Math.sin(phi) * radius, Math.cos(phi) * radius];

        // Four corner feet: a tapered square block with a cap and a cyan light on the outer
        // face. Broad faces point along the axes, so the front foot reads as a wide block.
        for (const phi of cardinal) {
            const [fx, fz] = at(10.8, phi);
            const foot = this._cyl(root, 'gen-foot', 6, 12, 15, fx, 3, fz, charcoal, 4);
            foot.rotation.y = Math.PI / 4;
            foot.convertToFlatShadedMesh();
            this._box(root, 'gen-foot-cap', 8.0, 0.9, 8.0, fx, 6.1, fz, hullShade);
            const [lx, lz] = at(15.55, phi);
            const light = this._box(root, 'gen-foot-light', 4.4, 1.3, 0.6, lx, 4.2, lz, glow);
            light.rotation.y = phi;
        }

        // Stepped octagonal plinth, the sloped base and the central pedestal.
        const plinth = this._cyl(root, 'gen-plinth', 2.6, 25, 27, 0, 1.3, 0, charcoal, 8);
        plinth.rotation.y = octa;
        plinth.convertToFlatShadedMesh();
        const skirt = this._cyl(root, 'gen-skirt', 2.0, 22, 24, 0, 3.6, 0, charcoalLight, 8);
        skirt.rotation.y = octa;
        skirt.convertToFlatShadedMesh();
        const slope = this._cyl(root, 'gen-slope', 5.9, 14.5, 22, 0, 7.55, 0, hull, 8);
        slope.rotation.y = octa;
        slope.convertToFlatShadedMesh();
        const pedestal = this._cyl(root, 'gen-pedestal', 6, 12.2, 14, 0, 13.5, 0, hullShade, 8);
        pedestal.rotation.y = octa;
        pedestal.convertToFlatShadedMesh();

        // Four slanted buttresses from the feet to the lower collar, between the team panels.
        for (const phi of cardinal) {
            const [ax, az] = at(11.2, phi);
            const [bx, bz] = at(8.8, phi);
            this._limb(root, 'gen-buttress', [ax, 4.8, az], [bx, 16.8, bz], 2.4, 2.4, hullShade);
        }

        // The team-coloured panels on the diagonal faces of the pedestal, in dark frames.
        for (const phi of diagonal) {
            const [bx, bz] = at(5.95, phi);
            const frame = this._box(root, 'gen-panel-frame', 4.9, 5.4, 0.6, bx, 13.7, bz, charcoal);
            frame.rotation.x = -0.11;
            frame.rotation.y = phi;
            const [px, pz] = at(6.2, phi);
            const panel = this._box(root, 'gen-panel', 4.3, 4.8, 0.7, px, 13.7, pz, team);
            panel.rotation.x = -0.11;
            panel.rotation.y = phi;
        }

        // Lower collar: a dark underside, the grey ring, a light rim and cyan face strips.
        const lowUnder = this._cyl(root, 'gen-collar-under', 0.8, 20.8, 20.8, 0, 16.6, 0, charcoal, 8);
        lowUnder.rotation.y = octa;
        const lowRing = this._cyl(root, 'gen-collar', 3.0, 20, 20, 0, 18.4, 0, hull, 8);
        lowRing.rotation.y = octa;
        lowRing.convertToFlatShadedMesh();
        const lowRim = this._cyl(root, 'gen-collar-rim', 0.8, 21, 21, 0, 20.3, 0, hullShade, 8);
        lowRim.rotation.y = octa;
        for (const phi of diagonal) {
            const [sx, sz] = at(10 * flat + 0.3, phi);
            const strip = this._box(root, 'gen-collar-light', 3.6, 1.0, 0.6, sx, 17.6, sz, glow);
            strip.rotation.y = phi;
        }

        // Reactor: a charcoal drum, four glowing panels on the axes and dark corner posts.
        const core = this._cyl(root, 'gen-core', 6.4, 11, 11, 0, 23.5, 0, charcoal, 8);
        core.rotation.y = octa;
        core.convertToFlatShadedMesh();
        for (const phi of cardinal) {
            const [px, pz] = at(5.5 * flat + 0.3, phi);
            const panel = this._box(root, 'gen-core-light', 3.4, 5.8, 0.6, px, 23.5, pz, glow);
            panel.rotation.y = phi;
        }
        for (const phi of diagonal) {
            const [px, pz] = at(5.4, phi);
            const post = this._box(root, 'gen-core-post', 1.5, 7.4, 1.5, px, 23.5, pz, charcoalLight);
            post.rotation.y = phi;
        }

        // Upper collar, a narrower copy of the lower one.
        const upUnder = this._cyl(root, 'gen-upper-under', 0.8, 18.8, 18.8, 0, 26.7, 0, charcoal, 8);
        upUnder.rotation.y = octa;
        const upRing = this._cyl(root, 'gen-upper', 3.0, 18, 18, 0, 28.5, 0, hull, 8);
        upRing.rotation.y = octa;
        upRing.convertToFlatShadedMesh();
        const upRim = this._cyl(root, 'gen-upper-rim', 0.8, 19, 19, 0, 30.4, 0, hullShade, 8);
        upRim.rotation.y = octa;
        for (const phi of diagonal) {
            const [sx, sz] = at(9 * flat + 0.3, phi);
            const strip = this._box(root, 'gen-upper-light', 3.2, 0.9, 0.6, sx, 27.7, sz, glow);
            strip.rotation.y = phi;
        }

        // Head: a flared grey cap with team strips, then the dark block carrying the screen.
        const cap = this._cyl(root, 'gen-cap', 2.8, 12.0, 15.2, 0, 32.2, 0, hull, 8);
        cap.rotation.y = octa;
        cap.convertToFlatShadedMesh();
        const capRim = this._cyl(root, 'gen-cap-rim', 0.7, 12.4, 12.4, 0, 33.8, 0, hullShade, 8);
        capRim.rotation.y = octa;
        const head = this._cyl(root, 'gen-head', 3.2, 8.4, 11.0, 0, 35.7, 0, charcoal, 8);
        head.rotation.y = octa;
        head.convertToFlatShadedMesh();
        for (const phi of diagonal) {
            const [px, pz] = at(4.6, phi);
            const strip = this._box(root, 'gen-head-team', 1.8, 2.2, 0.5, px, 35.7, pz, team);
            strip.rotation.x = -0.34;
            strip.rotation.y = phi;
        }
        const screenFrame = this._box(root, 'gen-screen-frame', 3.8, 2.3, 0.5, 0, 35.4, 4.55, charcoalLight);
        screenFrame.rotation.x = -0.3;
        const screen = this._box(root, 'gen-screen', 3.2, 1.8, 0.5, 0, 35.4, 4.78, glow);
        screen.rotation.x = -0.3;

        // Antenna: a dark base, a thin mast and the glowing tip.
        this._box(root, 'gen-top-base', 4.0, 1.4, 4.0, 0, 38.0, 0, charcoalLight);
        const collar = this._cyl(root, 'gen-mast-collar', 0.9, 2.2, 2.8, 0, 39.15, 0, metalDark, 8);
        collar.rotation.y = octa;
        const mast = this._cyl(root, 'gen-mast', 3.8, 0.9, 1.1, 0, 41.5, 0, metal, 8);
        mast.rotation.y = octa;
        const tip = this._cyl(root, 'gen-mast-glow', 2.4, 1.6, 1.2, 0, 44.6, 0, glow, 8);
        tip.rotation.y = octa;
    }

    addBuilding(b) {
        const root = this._buildBuildingMesh(b.type, b.team);
        this._selectionRadiusFor(root, b.type);
        World3D.addObject(this.location.view, root, 'actor');
        const fp = b.footprint;
        const bar = this._makeBar(Math.max(32, Math.max(fp[0], fp[1]) * this.scale * 0.85), 6, 60);
        this.buildingVisuals.set(b.id, { root, bar });
        this._placeBuilding(b);
    }

    _placeBuilding(b) {
        const v = this.buildingVisuals.get(b.id);
        if (!v) return;
        const x = this._px(b.x), y = this._px(b.y);
        v.root.position.set(x, this._height(x, y), y);
        const demolish = b.demolishing ? Math.max(0.15, 1 - 0.85 * Math.max(0, Math.min(1, b.demolishProgress))) : 1;
        v.root.scaling.y = (b.isBuilt ? 1 : 0.2 + 0.8 * Math.max(0, Math.min(1, b.buildProgress))) * demolish;
    }

    completeBuilding(b) {
        this._placeBuilding(b);
        if (b.team === 'player') this.marker(b.x, b.y, 'move');
    }

    removeBuilding(b) {
        const v = this.buildingVisuals.get(b.id);
        if (v) {
            World3D.removeObject(this.location.view, v.root);
            this._disposeProduction(v);
            this._disposeBar(v.bar);
            this.buildingVisuals.delete(b.id);
        }
        this._removeRing(b.id);
        this._removeDebugFor(b);
    }

    // --- Health bars -------------------------------------------------------------

    _makeBar(width, height, top) {
        const bg = BABYLON.MeshBuilder.CreatePlane('rts-bar-bg', { width, height }, this.scene);
        bg.material = this._barBg;
        bg.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        bg.isPickable = false;
        bg.renderingGroupId = World3D.LAYER.OVERLAY;
        bg.alphaIndex = 0;
        bg.sideOrientation = BABYLON.Material.CounterClockWiseSideOrientation;
        const fill = BABYLON.MeshBuilder.CreatePlane('rts-bar-fill', { width, height }, this.scene);
        fill.material = this._barGreen;
        fill.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        fill.isPickable = false;
        fill.renderingGroupId = World3D.LAYER.OVERLAY;
        fill.alphaIndex = 1;
        fill.sideOrientation = BABYLON.Material.CounterClockWiseSideOrientation;
        bg.setEnabled(false);
        fill.setEnabled(false);
        return { bg, fill, width, height, top };
    }

    _setBar(bar, x, y, top, ratio, show, building, color, yOffset) {
        if (!bar || !bar.bg) return;
        bar.bg.setEnabled(show);
        bar.fill.setEnabled(show);
        if (!show) return;
        const r = Math.max(0, Math.min(1, ratio));
        const cam = this.scene.activeCamera;
        const right = cam ? cam.getDirection(BABYLON.Axis.X) : new BABYLON.Vector3(1, 0, 0);
        const offset = -bar.width * (1 - r) / 2;
        const barY = top + (yOffset == null ? 12 : yOffset);
        bar.bg.position.set(x, barY, y);
        bar.fill.position.set(x + right.x * offset, barY, y + right.z * offset);
        bar.fill.scaling.x = r;
        bar.fill.material = color || (r > 0.55 ? this._barGreen : r > 0.28 ? this._barYellow : this._barRed);
    }

    _disposeBar(bar) {
        if (!bar) return;
        if (bar.fill) bar.fill.dispose();
        if (bar.bg) bar.bg.dispose();
    }

    // --- Production overlay -------------------------------------------------------

    _labelMaterial(name, texture, color) {
        const material = new BABYLON.StandardMaterial(name, this.scene);
        material.disableLighting = true;
        material.diffuseColor = new BABYLON.Color3(0, 0, 0);
        material.emissiveColor = BABYLON.Color3.FromHexString(color);
        material.emissiveTexture = texture;
        material.opacityTexture = texture;
        material.disableDepthWrite = true;
        material.depthFunction = BABYLON.Engine.ALWAYS;
        material.backFaceCulling = false;
        return material;
    }

    _labelMesh(name, material, alphaIndex) {
        const mesh = BABYLON.MeshBuilder.CreatePlane(name, { width: 62, height: 19.5 }, this.scene);
        mesh.material = material;
        mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        mesh.isPickable = false;
        mesh.renderingGroupId = World3D.LAYER.OVERLAY;
        mesh.alphaIndex = alphaIndex;
        mesh.sideOrientation = BABYLON.Material.CounterClockWiseSideOrientation;
        mesh.setEnabled(false);
        return mesh;
    }

    // Two unlit billboards: a dark plate and the blue content. Both textures are BLACK
    // with alpha; the colour comes from the material's emissiveColor. A platform that
    // swaps the red and blue channels of a DynamicTexture therefore cannot turn the
    // blue label yellow: black stays black and the tint is a material uniform.
    _makeProductionLabel() {
        const plateTexture = new BABYLON.DynamicTexture('rts-prod-plate', { width: 512, height: 160 }, this.scene, true);
        plateTexture.hasAlpha = true;
        const plateMaterial = this._labelMaterial('rts-prod-plate-mat', plateTexture, '#0b1a24');
        const plate = this._labelMesh('rts-prod-plate', plateMaterial, 1);
        const pctx = plateTexture.getContext();
        pctx.clearRect(0, 0, 512, 160);
        this._roundedRect(pctx, 2, 2, 508, 156, 16);
        pctx.fillStyle = '#000000';
        pctx.fill();
        plateTexture.update();

        const contentTexture = new BABYLON.DynamicTexture('rts-prod-content', { width: 512, height: 160 }, this.scene, true);
        contentTexture.hasAlpha = true;
        const contentMaterial = this._labelMaterial('rts-prod-content-mat', contentTexture, '#4fc8ff');
        const content = this._labelMesh('rts-prod-content', contentMaterial, 2);
        return { plate, content, plateTexture, contentTexture, plateMaterial, contentMaterial, text: '' };
    }

    _roundedRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    _drawProductionLabel(label, summary) {
        const ctx = label.contentTexture.getContext();
        const w = 512, h = 160;
        ctx.clearRect(0, 0, w, h);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fit = (text, start, weight) => {
            let size = start;
            ctx.font = weight + ' ' + size + 'px Arial, sans-serif';
            while (size > 12 && ctx.measureText(text).width > w - 32) {
                size -= 2;
                ctx.font = weight + ' ' + size + 'px Arial, sans-serif';
            }
        };
        const line1 = summary.current + ' · ' + summary.percent + '%';
        const line2 = 'Очередь: ' + summary.queueText;
        this._roundedRect(ctx, 2, 2, w - 4, h - 4, 16);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.62)';
        ctx.lineWidth = 3;
        ctx.stroke();
        fit(line1, 38, '700');
        ctx.fillStyle = '#000000';
        ctx.fillText(line1, w / 2, 42);
        fit(line2, 26, '500');
        ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
        ctx.fillText(line2, w / 2, 84);
        const barX = 24, barY = 112, barW = w - 48, barH = 28;
        this._roundedRect(ctx, barX, barY, barW, barH, 9);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
        const fill = Math.max(0, Math.min(1, summary.percent / 100)) * (barW - 8);
        if (fill > 0) {
            ctx.save();
            this._roundedRect(ctx, barX, barY, barW, barH, 9);
            ctx.clip();
            ctx.fillStyle = '#000000';
            ctx.fillRect(barX + 4, barY + 4, fill, barH - 8);
            ctx.restore();
        }
        label.contentTexture.update();
    }

    _showProduction(v, x, y, top, summary) {
        if (!v.prodLabel) v.prodLabel = this._makeProductionLabel();
        const text = summary.current + '|' + summary.percent + '|' + summary.queueText;
        if (v.prodLabel.text !== text) {
            v.prodLabel.text = text;
            this._drawProductionLabel(v.prodLabel, summary);
        }
        v.prodLabel.plate.setEnabled(true);
        v.prodLabel.content.setEnabled(true);
        v.prodLabel.plate.position.set(x, top + 28, y);
        v.prodLabel.content.position.set(x, top + 28, y);
    }

    _hideProduction(v) {
        if (!v.prodLabel) return;
        v.prodLabel.plate.setEnabled(false);
        v.prodLabel.content.setEnabled(false);
    }

    _disposeProduction(v) {
        if (!v.prodLabel) return;
        const label = v.prodLabel;
        if (label.plate) label.plate.dispose();
        if (label.content) label.content.dispose();
        if (label.plateMaterial) label.plateMaterial.dispose();
        if (label.contentMaterial) label.contentMaterial.dispose();
        if (label.plateTexture) label.plateTexture.dispose();
        if (label.contentTexture) label.contentTexture.dispose();
        v.prodLabel = null;
    }

    // --- Selection ---------------------------------------------------------------

    _ringMaterial(team) {
        const color = team === 'enemy' ? '#ff6a6a' : team === 'resource' ? '#ffcf5a' : '#74ff9a';
        return this._unlitMaterial(color, 0.9, true);
    }

    // The radius of a circle around the entity origin that covers the model at any heading:
    // the farthest horizontal corner of its bounds plus a small margin. Cached per type — the
    // geometry is the same for every copy and every team. 0 — no usable bounds.
    /** @param {BABYLON.Mesh} root @param {string} type */
    _selectionRadiusFor(root, type) {
        const cached = this.selectionRadii.get(type);
        if (cached != null) return cached;
        const bounds = root.getHierarchyBoundingVectors(true);
        const dx = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x));
        const dz = Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z));
        const radius = isFinite(dx) && isFinite(dz) ? Math.hypot(dx, dz) + 2 : 0;
        this.selectionRadii.set(type, radius);
        return radius;
    }

    // A flat ring that follows the ground. The depth test (unlike bars and markers) hides the
    // arc behind a unit or a building; sampling the terrain per vertex keeps the terrain from
    // cutting a ring on a slope.
    /** @param {string} name @param {number} radius */
    _makeSelectionRing(name, radius) {
        const width = 0.8, segments = 32;
        const inner = Math.max(0.05, radius - width * 0.5);
        const outer = radius + width * 0.5;
        const positions = [], indices = [], normals = [];
        for (let i = 0; i <= segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            const cos = Math.cos(a), sin = Math.sin(a);
            positions.push(cos * inner, 0, sin * inner);
            positions.push(cos * outer, 0, sin * outer);
            normals.push(0, 1, 0, 0, 1, 0);
        }
        for (let i = 0; i < segments; i++) {
            const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
            indices.push(a, c, b, b, c, d);
        }
        const data = new BABYLON.VertexData();
        data.positions = positions;
        data.indices = indices;
        data.normals = normals;
        const mesh = new BABYLON.Mesh(name, this.scene);
        data.applyToMesh(mesh, true);
        mesh.isPickable = false;
        mesh.renderingGroupId = World3D.LAYER.OVERLAY;
        mesh.alwaysSelectAsActiveMesh = true;
        return {
            mesh,
            base: new Float32Array(positions),
            positions: new Float32Array(positions),
            x: NaN,
            y: NaN
        };
    }

    _removeRing(id) {
        const rec = this.selectionRings.get(id);
        if (rec) {
            rec.mesh.dispose();
            this.selectionRings.delete(id);
        }
    }

    setSelection(list) {
        for (const id of [...this.selectionRings.keys()]) this._removeRing(id);
        this.selectedIds = new Set(list.map(e => e.id));
        for (const e of list) {
            if (!e.isAlive) continue;
            let diameter;
            const visual = this.selectionRadii.get(e.type);
            if (visual > 0) diameter = visual * 2;
            else if (e.kind === 'unit') diameter = (e.radius * 2 + 0.6) * this.scale;
            else if (e.kind === 'building') diameter = Math.max(e.footprint[0], e.footprint[1]) * this.scale + 10;
            else diameter = e.radius * 2 * this.scale + 8;
            const rec = this._makeSelectionRing('rts-ring-' + e.id, diameter / 2);
            rec.mesh.material = this._ringMaterial(e.kind === 'resource' || e.kind === 'wreck' ? 'resource' : e.team);
            this.selectionRings.set(e.id, rec);
        }
        this._placeSelection();
    }

    _placeSelection() {
        for (const e of this.world.selected) {
            const rec = this.selectionRings.get(e.id);
            if (!rec) continue;
            const x = this._px(e.x), y = this._px(e.y);
            if (rec.x === x && rec.y === y) continue;
            rec.x = x;
            rec.y = y;
            const base = rec.base, pos = rec.positions;
            for (let i = 0; i < base.length; i += 3) {
                pos[i] = base[i];
                pos[i + 1] = this._height(x + base[i], y + base[i + 2]) + 0.8;
                pos[i + 2] = base[i + 2];
            }
            rec.mesh.position.set(x, 0, y);
            rec.mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, pos);
        }
    }

    // --- Debug ranges ------------------------------------------------------------

    _circlePoints(radius, ground) {
        const pts = [], n = 48;
        for (let i = 0; i <= n; i++) {
            const a = (i / n) * Math.PI * 2;
            pts.push(new BABYLON.Vector3(Math.cos(a) * radius, ground, Math.sin(a) * radius));
        }
        return pts;
    }

    setDebugSelection(list, on) {
        for (const d of this.debugCircles) if (d.mesh) d.mesh.dispose();
        this.debugCircles = [];
        if (!on) return;
        for (const e of list) {
            if (!e || !e.isAlive) continue;
            const sight = e.sightRange || 0;
            const attack = e.attackRange || 0;
            if (attack > 0) {
                const line = BABYLON.MeshBuilder.CreateLines('rts-dbg-attack', { points: this._circlePoints(attack * this.scale, 1.5) }, this.scene);
                line.color = BABYLON.Color3.FromHexString('#ff625c');
                line.alpha = 0.7;
                line.isPickable = false;
                line.renderingGroupId = World3D.LAYER.OVERLAY;
                this.debugCircles.push({ entity: e, mesh: line });
            }
            if (sight > 0) {
                const line = BABYLON.MeshBuilder.CreateLines('rts-dbg-sight', { points: this._circlePoints(sight * this.scale, 1.3) }, this.scene);
                line.color = BABYLON.Color3.FromHexString('#74d7ff');
                line.alpha = 0.45;
                line.isPickable = false;
                line.renderingGroupId = World3D.LAYER.OVERLAY;
                this.debugCircles.push({ entity: e, mesh: line });
            }
        }
    }

    _removeDebugFor(entity) {
        for (let i = this.debugCircles.length - 1; i >= 0; i--) {
            if (this.debugCircles[i].entity === entity) {
                this.debugCircles[i].mesh.dispose();
                this.debugCircles.splice(i, 1);
            }
        }
    }

    // --- Effects and markers -----------------------------------------------------

    marker(x, y, type) {
        const color = type === 'attack' ? '#ff5757' : type === 'gather' ? '#ffcf5a' : '#74ff9a';
        const ring = BABYLON.MeshBuilder.CreateTorus('rts-marker', {
            diameter: 18, thickness: 2.6, tessellation: 24
        }, this.scene);
        ring.material = this._unlitMaterial(color, 0.85);
        ring.isPickable = false;
        ring.renderingGroupId = World3D.LAYER.OVERLAY;
        const wx = this._px(x), wy = this._px(y);
        ring.position.set(wx, this._height(wx, wy) + 1.5, wy);
        ring.scaling.setAll(0.65);
        this.effects.push({ mesh: ring, ttl: 0.85, total: 0.85, kind: 'marker' });
    }

    tracer(from, to, team) {
        if (this.world.vision &&
            (!this.world.vision.isExplored('player', from.x, from.y) ||
             !this.world.vision.isExplored('player', to.x, to.y))) return;
        const color = team === 'player' ? '#74d7ff' : '#ff8a66';
        const a = this._aimPoint(from), b = this._aimPoint(to);
        const line = BABYLON.MeshBuilder.CreateLines('rts-tracer', {
            points: [new BABYLON.Vector3(a.x, a.y, a.z), new BABYLON.Vector3(b.x, b.y, b.z)]
        }, this.scene);
        line.color = BABYLON.Color3.FromHexString(color);
        line.alpha = 0.95;
        line.isPickable = false;
        line.renderingGroupId = World3D.LAYER.OVERLAY;
        this.effects.push({ mesh: line, ttl: 0.12, total: 0.12, kind: 'line' });
    }

    impact(x, y, height, team) {
        if (this.world.vision && !this.world.vision.isExplored('player', x, y)) return;
        const color = team === 'player' ? '#9de8ff' : '#ffaa77';
        const s = BABYLON.MeshBuilder.CreateSphere('rts-impact', { diameter: 7, segments: 6 }, this.scene);
        s.material = this._unlitMaterial(color, 0.85);
        s.isPickable = false;
        s.renderingGroupId = World3D.LAYER.OVERLAY;
        const wx = this._px(x), wy = this._px(y);
        s.position.set(wx, this._height(wx, wy) + (height || 20) * 0.55, wy);
        s.scaling.setAll(0.6);
        this.effects.push({ mesh: s, ttl: 0.28, total: 0.28, kind: 'impact' });
    }

    _aimPoint(e) {
        const type = e.type || '';
        const h = (RTS_DATA.VISUAL_HEIGHT[type] || 20) * (e.kind === 'building' ? 0.7 : 0.6);
        const x = this._px(e.x), y = this._px(e.y);
        return { x, y: this._height(x, y) + h, z: y };
    }

    // A lobbed grenade: presentation only. Damage is already applied by RTSWorld; the mesh
    // arcs to the target and bursts into a flash, a ground ring and a puff of smoke.
    grenade(from, to, team) {
        if (this.world.vision &&
            (!this.world.vision.isExplored('player', from.x, from.y) ||
             !this.world.vision.isExplored('player', to.x, to.y))) return;
        const start = this._aimPoint(from);
        const end = this._aimPoint(to);
        const heading = from.heading || 0;
        start.x += Math.cos(heading) * 11;
        start.z += Math.sin(heading) * 11;
        start.y += 3;
        const color = team === 'player' ? '#9de8ff' : '#ffaa77';
        const mesh = BABYLON.MeshBuilder.CreateSphere('rts-grenade', { diameter: 2.2, segments: 6 }, this.scene);
        mesh.material = this._unlitMaterial(color, 0.95);
        mesh.isPickable = false;
        mesh.renderingGroupId = World3D.LAYER.OVERLAY;
        mesh.position.set(start.x, start.y, start.z);
        const flight = typeof RTS_GRENADE_FLIGHT_SEC !== 'undefined' ? RTS_GRENADE_FLIGHT_SEC : 0.42;
        this.effects.push({ mesh, ttl: flight, total: flight, kind: 'grenade', start, end });
    }

    _grenadeBlast(point) {
        const flash = BABYLON.MeshBuilder.CreateSphere('rts-grenade-flash', { diameter: 9, segments: 8 }, this.scene);
        flash.material = this._unlitMaterial('#ffd27a', 0.95);
        flash.isPickable = false;
        flash.renderingGroupId = World3D.LAYER.OVERLAY;
        flash.position.set(point.x, point.y, point.z);
        flash.scaling.setAll(0.45);
        this.effects.push({ mesh: flash, ttl: 0.24, total: 0.24, kind: 'blast' });

        const ground = this._height(point.x, point.z);
        const ring = BABYLON.MeshBuilder.CreateTorus('rts-grenade-ring', {
            diameter: 8, thickness: 1.6, tessellation: 20
        }, this.scene);
        ring.material = this._unlitMaterial('#ff9a4a', 0.85);
        ring.isPickable = false;
        ring.renderingGroupId = World3D.LAYER.OVERLAY;
        ring.position.set(point.x, ground + 1.6, point.z);
        ring.scaling.setAll(0.5);
        this.effects.push({ mesh: ring, ttl: 0.38, total: 0.38, kind: 'ring' });

        const smoke = BABYLON.MeshBuilder.CreateSphere('rts-grenade-smoke', { diameter: 6, segments: 6 }, this.scene);
        smoke.material = this._unlitMaterial('#5a5148', 0.55);
        smoke.isPickable = false;
        smoke.renderingGroupId = World3D.LAYER.OVERLAY;
        smoke.position.set(point.x, point.y + 1, point.z);
        this.effects.push({ mesh: smoke, ttl: 0.6, total: 0.6, kind: 'smoke', vy: 9 });
    }

    explode(entity) {
        if (this.world.vision && !this.world.vision.isExplored('player', entity.x, entity.y)) return;
        const x = this._px(entity.x), y = this._px(entity.y);
        const ground = this._height(x, y);
        const color = entity.team === 'player' ? RTS_DATA.COLORS.playerDark : RTS_DATA.COLORS.enemyDark;
        const mat = this._mat(color);
        const count = entity.kind === 'building' ? 10 : 6;
        for (let i = 0; i < count; i++) {
            const s = 2.5 + Math.random() * 4;
            const mesh = BABYLON.MeshBuilder.CreateBox('rts-debris', { size: s }, this.scene);
            mesh.material = mat;
            mesh.isPickable = false;
            mesh.position.set(x + (Math.random() - 0.5) * 14, ground + 6 + Math.random() * 20, y + (Math.random() - 0.5) * 14);
            this.effects.push({
                mesh, ttl: 0.55, total: 0.55, kind: 'debris',
                vx: (Math.random() - 0.5) * 48,
                vy: 22 + Math.random() * 42,
                vz: (Math.random() - 0.5) * 48
            });
        }
        this.impact(entity.x, entity.y, (RTS_DATA.VISUAL_HEIGHT[entity.type] || 20) * 0.6, entity.team);
    }

    _updateEffects(dt) {
        for (let i = this.effects.length - 1; i >= 0; i--) {
            const e = this.effects[i];
            e.ttl -= dt;
            if (e.ttl <= 0) {
                if (e.kind === 'grenade') this._grenadeBlast(e.end);
                if (e.mesh) e.mesh.dispose();
                this.effects.splice(i, 1);
                continue;
            }
            if (e.kind === 'grenade') {
                const k = 1 - e.ttl / e.total;
                const arc = typeof RTS_GRENADE_ARC_HEIGHT !== 'undefined' ? RTS_GRENADE_ARC_HEIGHT : 18;
                e.mesh.position.x = e.start.x + (e.end.x - e.start.x) * k;
                e.mesh.position.z = e.start.z + (e.end.z - e.start.z) * k;
                e.mesh.position.y = e.start.y + (e.end.y - e.start.y) * k + Math.sin(Math.PI * k) * arc;
                e.mesh.rotation.x += dt * 9;
                e.mesh.rotation.z += dt * 7;
            } else if (e.kind === 'blast') {
                const k = 1 - e.ttl / e.total;
                e.mesh.scaling.setAll(0.45 + k * 1.7);
            } else if (e.kind === 'ring') {
                const k = 1 - e.ttl / e.total;
                e.mesh.scaling.setAll(0.5 + k * 1.8);
            } else if (e.kind === 'smoke') {
                const k = 1 - e.ttl / e.total;
                e.mesh.scaling.setAll(1 + k * 1.5);
                e.mesh.position.y += (e.vy || 0) * dt;
            } else if (e.kind === 'debris') {
                e.vy -= 120 * dt;
                e.mesh.position.x += e.vx * dt;
                e.mesh.position.y += e.vy * dt;
                e.mesh.position.z += e.vz * dt;
                if (e.mesh.position.y < 2) e.mesh.position.y = 2;
                e.mesh.rotation.x += dt * 4;
                e.mesh.rotation.z += dt * 3;
            } else if (e.kind === 'marker') {
                const k = 1 - e.ttl / e.total;
                e.mesh.scaling.setAll(0.65 + k * 0.7);
            } else if (e.kind === 'impact') {
                const k = 1 - e.ttl / e.total;
                e.mesh.scaling.setAll(0.6 + k * 1.2);
            }
        }
    }

    // --- Build ghost -------------------------------------------------------------

    beginGhost(type, team) {
        this.endGhost();
        const def = RTS_DATA.BUILDINGS[type];
        if (!def) return;
        this.ghostType = type;
        const x = 0, y = 0;
        const mesh = BABYLON.MeshBuilder.CreateBox('rts-ghost', {
            width: def.footprint[0] * this.scale,
            height: 12,
            depth: def.footprint[1] * this.scale
        }, this.scene);
        mesh.material = this._ghostValid;
        mesh.isPickable = false;
        mesh.renderingGroupId = World3D.LAYER.OVERLAY;
        mesh.position.set(x, 6, y);
        this.ghost = mesh;
        this.ghostValid = true;
        this.ghostTeam = team;
    }

    moveGhost(x, y, valid) {
        if (!this.ghost) return;
        const wx = this._px(x), wy = this._px(y);
        this.ghost.position.set(wx, this._height(wx, wy) + 6.2, wy);
        this.ghost.material = valid ? this._ghostValid : this._ghostInvalid;
        this.ghostValid = !!valid;
    }

    endGhost() {
        if (this.ghost) this.ghost.dispose();
        this.ghost = null;
        this.ghostType = '';
    }

    // --- Frame -------------------------------------------------------------------

    update(dt, world) {
        for (const u of world.units) {
            if (!u.isAlive) continue;
            this._placeUnit(u, dt);
            const v = this.unitVisuals.get(u.id);
            if (!v) continue;
            const visible = u.team === 'player' || !world.vision || world.vision.isExplored('player', u.x, u.y);
            v.root.setEnabled(visible);
            const x = this._px(u.x), y = this._px(u.y);
            const ground = this._height(x, y);
            const top = ground + (RTS_DATA.VISUAL_HEIGHT[u.type] || 24);
            const show = visible && (this.selectedIds.has(u.id) || u.health < u.maxHealth);
            this._setBar(v.bar, x, y, top, u.health / u.maxHealth, show, false);
        }
        for (const b of world.buildings) {
            if (!b.isAlive) continue;
            this._placeBuilding(b);
            const v = this.buildingVisuals.get(b.id);
            if (!v) continue;
            const visible = b.team === 'player' || !world.vision || world.vision.isExplored('player', b.x, b.y);
            v.root.setEnabled(visible);
            const x = this._px(b.x), y = this._px(b.y);
            const ground = this._height(x, y);
            const grow = b.isBuilt ? 1 : 0.2 + 0.8 * Math.max(0, Math.min(1, b.buildProgress));
            const top = ground + (RTS_DATA.VISUAL_HEIGHT[b.type] || 40) * grow;
            if (!b.isBuilt) {
                this._setBar(v.bar, x, y, top, b.buildProgress, visible, false, this._barBlue);
            } else {
                const show = visible && (this.selectedIds.has(b.id) || b.health < b.maxHealth);
                this._setBar(v.bar, x, y, top, b.health / b.maxHealth, show, false);
            }
            if (visible && b.team === 'player' && b.isBuilt && !b.demolishing && b.productionQueue.length) {
                this._showProduction(v, x, y, top, RTSView.productionSummary(b.productionQueue));
            } else {
                this._hideProduction(v);
            }
        }
        for (const r of world.resources) {
            if (!r.isAlive) continue;
            this._placeResource(r);
            const v = this.resourceVisuals.get(r.id);
            if (v) v.root.setEnabled(!world.vision || world.vision.isExplored('player', r.x, r.y));
        }
        for (const w of world.wrecks || []) {
            if (!w.isAlive) continue;
            this._placeWreck(w);
            const v = this.wreckVisuals.get(w.id);
            if (!v) continue;
            const visible = !world.vision || world.vision.isExplored('player', w.x, w.y);
            v.root.setEnabled(visible);
            const x = this._px(w.x), y = this._px(w.y);
            const top = this._height(x, y) + (RTS_DATA.VISUAL_HEIGHT.wreck || 30);
            const total = typeof RTS_WRECK_SEARCH_SEC !== 'undefined' ? RTS_WRECK_SEARCH_SEC : 15;
            const show = visible && !!w.searchingUnit;
            this._setBar(v.bar, x, y, top, Math.min(1, w.searchProgress / total), show, false);
        }

        this._placeSelection();
        for (const d of this.debugCircles) {
            if (!d.entity || !d.entity.isAlive) continue;
            const x = this._px(d.entity.x), y = this._px(d.entity.y);
            d.mesh.position.set(x, this._height(x, y), y);
        }
        this._updateEffects(dt);
        if (this.fog && world.vision) this.fog.update(dt, world.vision);
    }
}
