// RTSIcons.js — vector icons for the RTS HUD, drawn on 2D canvases (no DOM, no Babylon).
// Units and buildings are drawn in a 64 × 64 box and scaled to the requested rectangle;
// the HUD decides where the box goes. Colors come from RTS_DATA.COLORS.

/** @typedef {{ color?: string, dim?: boolean, team?: string }} IconOptions */

/** @satisfies {Record<string, any>} */
const RTSIcons = {
    FONT: 'system-ui, "Segoe UI", Roboto, sans-serif',

    // A uniform grid of cells inside a canvas of w × h.
    grid(w, h, cols, rows, opt) {
        const o = opt || {};
        const padX = o.padX || 0, padY = o.padY || 0;
        const gapX = o.gapX || 0, gapY = o.gapY || 0;
        const cw = (w - padX * 2 - gapX * (cols - 1)) / cols;
        const ch = (h - padY * 2 - gapY * (rows - 1)) / rows;
        const out = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                out.push({ x: padX + c * (cw + gapX), y: padY + r * (ch + gapY), w: cw, h: ch });
            }
        }
        return out;
    },

    // Index of the cell under (x, y); -1 outside.
    hit(rects, x, y) {
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return i;
        }
        return -1;
    },

    roundRect(ctx, x, y, w, h, r) {
        const k = Math.max(0, Math.min(r || 0, Math.min(w, h) / 2));
        ctx.beginPath();
        ctx.moveTo(x + k, y);
        ctx.lineTo(x + w - k, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + k);
        ctx.lineTo(x + w, y + h - k);
        ctx.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
        ctx.lineTo(x + k, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - k);
        ctx.lineTo(x, y + k);
        ctx.quadraticCurveTo(x, y, x + k, y);
        ctx.closePath();
    },

    slot(ctx, r, active) {
        this.roundRect(ctx, r.x, r.y, r.w, r.h, 6);
        ctx.fillStyle = active ? '#10202c' : '#0a1620';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = active ? '#2a5c78' : '#1b3546';
        ctx.stroke();
    },

    bar(ctx, x, y, w, h, value, color, bg) {
        const v = Math.max(0, Math.min(1, Number(value) || 0));
        ctx.fillStyle = bg || '#10202c';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = color || '#6ef28b';
        ctx.fillRect(x, y, w * v, h);
    },

    text(ctx, text, x, y, size, color, align) {
        const font = typeof UI !== 'undefined' ? UI.FONT : this.FONT;
        ctx.font = '600 ' + (size || 10) + 'px ' + font;
        ctx.fillStyle = color || '#e8f4ff';
        ctx.textAlign = align || 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(String(text == null ? '' : text), x, y);
    },

    // Draws up to `lines` wrapped lines; the last one is cut with an ellipsis.
    wrap(ctx, text, x, y, w, size, lines, color, align) {
        const max = Math.max(1, Math.floor(w / ((size || 10) * 0.58)));
        const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
        const out = [];
        let line = '';
        for (const word of words) {
            const test = line ? line + ' ' + word : word;
            if (test.length <= max) line = test;
            else { if (line) out.push(line); line = word; }
        }
        if (line) out.push(line);
        const limit = Math.max(1, lines || 1);
        if (out.length > limit) {
            out.length = limit;
            const last = out[limit - 1];
            out[limit - 1] = (last.length > max - 1 ? last.slice(0, Math.max(1, max - 1)) : last) + '…';
        }
        for (let i = 0; i < out.length; i++) {
            this.text(ctx, out[i], x, y + i * ((size || 10) + 1), size, color, align);
        }
    },

    _teamColor(opts) {
        const o = opts || {};
        /** @type {Record<string, string>} */
        const c = (typeof RTS_DATA !== 'undefined' && RTS_DATA.COLORS) || {};
        if (o.color) return o.color;
        if (o.team === 'enemy') return c.enemy || '#ff5a5a';
        if (o.team === 'neutral') return c.neutral || '#ffcf5a';
        return c.player || '#3f8cff';
    },

    /** @type {Record<string, { player: string, enemy: string }>} */
    UNIT_ICONS: {
        worker: {
            player: 'assets/icons/worker.png',
            enemy: 'assets/icons/worker_enemy.png'
        },
        infantry: {
            player: 'assets/icons/infantry.png',
            enemy: 'assets/icons/infantry_enemy.png'
        },
        scout: {
            player: 'assets/icons/scout.png',
            enemy: 'assets/icons/scout_enemy.png'
        },
        grenadier: {
            player: 'assets/icons/grenadier.png',
            enemy: 'assets/icons/grenadier_enemy.png'
        },
        siege: {
            player: 'assets/icons/siege.png',
            enemy: 'assets/icons/siege_enemy.png'
        }
    },

    /** @type {Record<string, { player: string, enemy: string }>} */
    BUILDING_ICONS: {
        hq: {
            player: 'assets/icons/hq.png',
            enemy: 'assets/icons/hq_enemy.png'
        },
        generator: {
            player: 'assets/icons/generator.png',
            enemy: 'assets/icons/generator_enemy.png'
        },
        depot: {
            player: 'assets/icons/depot.png',
            enemy: 'assets/icons/depot_enemy.png'
        },
        barracks: {
            player: 'assets/icons/barracks.png',
            enemy: 'assets/icons/barracks_enemy.png'
        },
        factory: {
            player: 'assets/icons/factory.png',
            enemy: 'assets/icons/factory_enemy.png'
        },
        tower: {
            player: 'assets/icons/tower.png',
            enemy: 'assets/icons/tower_enemy.png'
        }
    },

    /** @type {Map<string, { img: HTMLImageElement, ready: boolean }>} */
    _iconCache: new Map(),

    // The asset path for a type and team; '' when the type stays vector-only.
    _iconSource(defs, type, opts) {
        const entry = defs[type];
        if (!entry) return '';
        const o = opts || {};
        return o.team === 'enemy' ? entry.enemy : entry.player;
    },

    // The decoded image, or null while it loads / when the environment has no DOM images.
    _icon(defs, type, opts) {
        const src = this._iconSource(defs, type, opts);
        if (!src || typeof Image === 'undefined') return null;
        let rec = this._iconCache.get(src);
        if (!rec) {
            const img = new Image();
            rec = { img, ready: false };
            img.onload = () => { rec.ready = true; };
            img.onerror = () => { rec.ready = false; };
            img.src = src;
            this._iconCache.set(src, rec);
        }
        return rec.ready && rec.img.naturalWidth > 0 ? rec.img : null;
    },

    // Draws the raster icon if it is ready; false means the caller keeps its vector drawing.
    _drawRasterIcon(ctx, defs, type, x, y, w, h, opts) {
        const icon = this._icon(defs, type, opts);
        if (!icon) return false;
        const o = opts || {};
        const size = Math.min(w, h);
        ctx.save();
        ctx.globalAlpha = o.dim ? 0.3 : 1;
        ctx.drawImage(icon, x + (w - size) / 2, y + (h - size) / 2, size, size);
        ctx.restore();
        return true;
    },

    _begin(ctx, x, y, w, h, opts, color) {
        const o = opts || {};
        ctx.save();
        ctx.globalAlpha = o.dim ? 0.3 : 1;
        ctx.translate(x, y);
        ctx.scale(w / 64, h / 64);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
    },

    _end(ctx) { ctx.restore(); },

    drawUnit(ctx, type, x, y, w, h, opts) {
        if (!ctx) return;
        if (this._drawRasterIcon(ctx, this.UNIT_ICONS, type, x, y, w, h, opts)) return;
        const color = this._teamColor(opts);
        this._begin(ctx, x, y, w, h, opts, color);
        if (type === 'worker') {
            // Wheeled harvester in side view: rear hopper, cab with a windshield, front scoop.
            ctx.beginPath(); ctx.moveTo(8, 32); ctx.lineTo(26, 29); ctx.lineTo(26, 43);
            ctx.lineTo(10, 43); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(9, 32); ctx.lineTo(27, 29); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(26, 43); ctx.lineTo(26, 28); ctx.lineTo(36, 26);
            ctx.lineTo(43, 30); ctx.lineTo(43, 43); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(34, 27); ctx.lineTo(40, 30); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(28, 24); ctx.lineTo(34, 23); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(43, 43); ctx.lineTo(43, 35); ctx.lineTo(53, 34);
            ctx.lineTo(57, 38); ctx.lineTo(57, 44); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(50, 44); ctx.lineTo(50, 38); ctx.stroke();
            for (const cx of [20, 44]) {
                ctx.beginPath(); ctx.arc(cx, 49, 6.5, 0, Math.PI * 2); ctx.stroke();
            }
        } else if (type === 'infantry') {
            ctx.beginPath(); ctx.arc(32, 17, 8, Math.PI, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(20, 28); ctx.lineTo(44, 28); ctx.lineTo(42, 48); ctx.lineTo(22, 48); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(24, 48); ctx.lineTo(20, 58); ctx.moveTo(40, 48); ctx.lineTo(44, 58); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(12, 36); ctx.lineTo(56, 30); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(50, 28); ctx.lineTo(56, 30); ctx.lineTo(50, 34); ctx.stroke();
        } else if (type === 'grenadier') {
            // Bulky trooper with a stubby wide-muzzle launcher and a grenade canister.
            ctx.beginPath(); ctx.arc(32, 16, 9, Math.PI, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(18, 27); ctx.lineTo(46, 27); ctx.lineTo(44, 48); ctx.lineTo(20, 48); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(23, 26); ctx.lineTo(23, 19); ctx.lineTo(41, 19); ctx.lineTo(41, 26); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(24, 48); ctx.lineTo(20, 58); ctx.moveTo(40, 48); ctx.lineTo(44, 58); ctx.stroke();
            this.roundRect(ctx, 17, 33, 30, 6, 3); ctx.stroke();
            ctx.beginPath(); ctx.arc(50, 36, 4.5, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(17, 36); ctx.lineTo(10, 39); ctx.stroke();
            ctx.beginPath(); ctx.arc(12, 46, 3, 0, Math.PI * 2); ctx.stroke();
        } else if (type === 'scout') {
            // Six-wheeled rover in side view: low hull, three wheels, radar dish and antenna.
            ctx.beginPath(); ctx.moveTo(8, 42); ctx.lineTo(13, 30); ctx.lineTo(38, 27);
            ctx.lineTo(47, 31); ctx.lineTo(56, 33); ctx.lineTo(56, 43); ctx.lineTo(8, 43);
            ctx.closePath(); ctx.stroke();
            for (const cx of [15, 32, 49]) {
                ctx.beginPath(); ctx.arc(cx, 49, 6.5, 0, Math.PI * 2); ctx.stroke();
            }
            ctx.beginPath(); ctx.ellipse(23, 18, 8, 3.5, -0.4, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(23, 20); ctx.lineTo(23, 27); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(45, 31); ctx.lineTo(45, 10); ctx.stroke();
            ctx.beginPath(); ctx.arc(45, 8, 2.5, 0, Math.PI * 2); ctx.fill();
        } else if (type === 'siege') {
            this.roundRect(ctx, 8, 32, 48, 18, 4); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(20, 32); ctx.lineTo(24, 20); ctx.lineTo(44, 20); ctx.lineTo(48, 32); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(44, 24); ctx.lineTo(60, 20); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(8, 44); ctx.lineTo(56, 44); ctx.stroke();
            ctx.beginPath(); ctx.arc(16, 52, 4, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(48, 52, 4, 0, Math.PI * 2); ctx.stroke();
        }
        this._end(ctx);
    },

    drawBuilding(ctx, type, x, y, w, h, opts) {
        if (!ctx) return;
        if (this._drawRasterIcon(ctx, this.BUILDING_ICONS, type, x, y, w, h, opts)) return;
        const color = this._teamColor(opts);
        this._begin(ctx, x, y, w, h, opts, color);
        if (type === 'hq') {
            ctx.beginPath(); ctx.moveTo(8, 52); ctx.lineTo(56, 52); ctx.stroke();
            ctx.beginPath(); ctx.arc(32, 40, 18, Math.PI, Math.PI * 2); ctx.lineTo(50, 52); ctx.lineTo(14, 52); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(32, 22); ctx.lineTo(32, 8); ctx.stroke();
            ctx.beginPath(); ctx.arc(32, 8, 3, 0, Math.PI * 2); ctx.fill();
        } else if (type === 'generator') {
            // Octagonal reactor tower: flared base, two collars, a glowing core and a tall antenna.
            ctx.beginPath();
            ctx.moveTo(8, 55); ctx.lineTo(56, 55); ctx.lineTo(48, 44); ctx.lineTo(16, 44); ctx.closePath(); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(18, 44); ctx.lineTo(46, 44); ctx.lineTo(44, 34); ctx.lineTo(20, 34); ctx.closePath(); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(14, 34); ctx.lineTo(50, 34); ctx.lineTo(46, 28); ctx.lineTo(18, 28); ctx.closePath(); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(22, 28); ctx.lineTo(42, 28); ctx.lineTo(42, 21); ctx.lineTo(22, 21); ctx.closePath(); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(17, 21); ctx.lineTo(47, 21); ctx.lineTo(43, 15); ctx.lineTo(21, 15); ctx.closePath(); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(24, 15); ctx.lineTo(40, 15); ctx.lineTo(37, 8); ctx.lineTo(27, 8); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(32, 8); ctx.lineTo(32, 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(32, 2, 2.5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.moveTo(26, 27); ctx.lineTo(26, 22); ctx.moveTo(38, 27); ctx.lineTo(38, 22); ctx.stroke();
        } else if (type === 'depot') {
            // A stepped bunker with a shutter door on the right and a low wing on the left.
            ctx.beginPath(); ctx.moveTo(6, 54); ctx.lineTo(20, 54); ctx.lineTo(20, 30);
            ctx.lineTo(34, 30); ctx.lineTo(34, 20); ctx.lineTo(58, 20); ctx.lineTo(58, 54);
            ctx.closePath(); ctx.stroke();
            this.roundRect(ctx, 38, 28, 16, 26, 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(12, 26); ctx.lineTo(12, 18); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(30, 20); ctx.lineTo(30, 8); ctx.stroke();
            ctx.beginPath(); ctx.arc(30, 6, 3, 0, Math.PI * 2); ctx.fill();
        } else if (type === 'barracks') {
            ctx.beginPath(); ctx.moveTo(10, 54); ctx.lineTo(54, 54); ctx.lineTo(54, 28); ctx.lineTo(32, 14); ctx.lineTo(10, 28); ctx.closePath(); ctx.stroke();
            this.roundRect(ctx, 24, 40, 16, 14, 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(32, 14); ctx.lineTo(32, 6); ctx.stroke();
        } else if (type === 'factory') {
            // Two-storey hall with two tapered chimneys, a gated ramp and a round tank on the left.
            ctx.beginPath(); ctx.moveTo(6, 55); ctx.lineTo(58, 55); ctx.stroke();
            ctx.beginPath(); ctx.arc(13, 31, 6.5, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(7, 29); ctx.lineTo(19, 29); ctx.moveTo(7, 34); ctx.lineTo(19, 34); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(10, 48); ctx.lineTo(27, 48); ctx.lineTo(27, 55); ctx.lineTo(10, 55); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(25, 55); ctx.lineTo(25, 36); ctx.lineTo(30, 26); ctx.lineTo(55, 26); ctx.lineTo(57, 36); ctx.lineTo(57, 55); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(30, 26); ctx.lineTo(34, 35); ctx.moveTo(55, 26); ctx.lineTo(52, 35); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(34, 26); ctx.lineTo(34, 9); ctx.lineTo(40, 9); ctx.lineTo(40, 26); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(44, 26); ctx.lineTo(44, 15); ctx.lineTo(49, 15); ctx.lineTo(49, 26); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(34, 13); ctx.lineTo(40, 13); ctx.moveTo(44, 19); ctx.lineTo(49, 19); ctx.stroke();
            this.roundRect(ctx, 38, 40, 11, 15, 1.5); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(38, 55); ctx.lineTo(34, 62); ctx.moveTo(49, 55); ctx.lineTo(53, 62); ctx.stroke();
        } else if (type === 'tower') {
            // Four-legged base, glowing collar, angular head and a cannon pointing left.
            ctx.beginPath();
            ctx.moveTo(12, 54); ctx.lineTo(20, 54); ctx.lineTo(23, 44); ctx.lineTo(14, 42); ctx.closePath();
            ctx.moveTo(44, 54); ctx.lineTo(52, 54); ctx.lineTo(50, 42); ctx.lineTo(41, 44); ctx.closePath();
            ctx.moveTo(28, 57); ctx.lineTo(37, 57); ctx.lineTo(37, 46); ctx.lineTo(28, 46); ctx.closePath();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(10, 44); ctx.lineTo(17, 36); ctx.lineTo(47, 36); ctx.lineTo(54, 44); ctx.closePath();
            ctx.stroke();
            ctx.beginPath(); ctx.moveTo(18, 38); ctx.lineTo(46, 38); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(22, 33); ctx.lineTo(42, 33); ctx.lineTo(39, 27); ctx.lineTo(25, 27); ctx.closePath();
            ctx.stroke();
            ctx.beginPath(); ctx.moveTo(24, 30); ctx.lineTo(40, 30); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(18, 27); ctx.lineTo(18, 14); ctx.lineTo(26, 8); ctx.lineTo(46, 8); ctx.lineTo(50, 15); ctx.lineTo(50, 27); ctx.closePath();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(18, 20); ctx.lineTo(4, 20); ctx.lineTo(4, 14); ctx.lineTo(18, 14); ctx.closePath();
            ctx.stroke();
            ctx.beginPath(); ctx.moveTo(13, 14); ctx.lineTo(13, 20); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(5, 15); ctx.lineTo(5, 19); ctx.stroke();
            this.roundRect(ctx, 38, 15, 9, 6, 1.5); ctx.stroke();
            ctx.beginPath(); ctx.arc(45, 25, 4, 0, Math.PI * 2); ctx.stroke();
            this.roundRect(ctx, 28, 4, 12, 5, 2); ctx.stroke();
        }
        this._end(ctx);
    },

    drawOrder(ctx, id, x, y, w, h, opts) {
        if (!ctx) return;
        const color = this._teamColor(opts);
        this._begin(ctx, x, y, w, h, opts, color);
        if (id === 'stop') {
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
                const a = Math.PI / 8 + i * Math.PI / 4;
                const px = 32 + Math.cos(a) * 22, py = 32 + Math.sin(a) * 22;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath(); ctx.stroke();
            this.roundRect(ctx, 24, 24, 16, 16, 2); ctx.stroke();
        } else if (id === 'hold') {
            ctx.beginPath(); ctx.moveTo(32, 8); ctx.lineTo(52, 18); ctx.lineTo(50, 40); ctx.lineTo(32, 56); ctx.lineTo(14, 40); ctx.lineTo(12, 18); ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(22, 32); ctx.lineTo(30, 40); ctx.lineTo(44, 22); ctx.stroke();
        } else if (id === 'move') {
            ctx.beginPath(); ctx.moveTo(32, 10); ctx.lineTo(32, 54); ctx.moveTo(10, 32); ctx.lineTo(54, 32); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(32, 6); ctx.lineTo(27, 16); ctx.lineTo(37, 16); ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.moveTo(32, 58); ctx.lineTo(27, 48); ctx.lineTo(37, 48); ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.moveTo(6, 32); ctx.lineTo(16, 27); ctx.lineTo(16, 37); ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.moveTo(58, 32); ctx.lineTo(48, 27); ctx.lineTo(48, 37); ctx.closePath(); ctx.fill();
        } else if (id === 'attack') {
            ctx.beginPath(); ctx.arc(32, 32, 20, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(32, 32, 8, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(32, 4); ctx.lineTo(32, 16); ctx.moveTo(32, 48); ctx.lineTo(32, 60);
            ctx.moveTo(4, 32); ctx.lineTo(16, 32); ctx.moveTo(48, 32); ctx.lineTo(60, 32); ctx.stroke();
        } else if (id === 'cancel') {
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
                const a = Math.PI / 8 + i * Math.PI / 4;
                const px = 32 + Math.cos(a) * 22, py = 32 + Math.sin(a) * 22;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(22, 22); ctx.lineTo(42, 42); ctx.moveTo(42, 22); ctx.lineTo(22, 42); ctx.stroke();
        } else if (id === 'demolish') {
            ctx.beginPath(); ctx.moveTo(20, 54); ctx.lineTo(42, 18); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(34, 12); ctx.lineTo(54, 22); ctx.lineTo(50, 29); ctx.lineTo(30, 19);
            ctx.closePath(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(14, 48); ctx.lineTo(22, 60); ctx.stroke();
        }
        this._end(ctx);
    },

    drawCrystal(ctx, x, y, w, h, opts) {
        if (!ctx) return;
        const color = this._teamColor(opts);
        this._begin(ctx, x, y, w, h, opts, color);
        ctx.beginPath(); ctx.moveTo(32, 6); ctx.lineTo(52, 26); ctx.lineTo(32, 58); ctx.lineTo(12, 26); ctx.closePath(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(12, 26); ctx.lineTo(52, 26); ctx.moveTo(32, 6); ctx.lineTo(32, 58); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(22, 36); ctx.lineTo(32, 46); ctx.lineTo(42, 36); ctx.stroke();
        this._end(ctx);
    },

    drawSupply(ctx, x, y, w, h, opts) {
        if (!ctx) return;
        const color = this._teamColor(opts);
        this._begin(ctx, x, y, w, h, opts, color);
        for (const dx of [-14, 0, 14]) {
            ctx.beginPath(); ctx.arc(32 + dx, 22, 6, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(32 + dx, 44, 10, Math.PI, Math.PI * 2); ctx.stroke();
        }
        this._end(ctx);
    },

    drawGroup(ctx, x, y, w, h, opts) {
        this.drawUnit(ctx, 'infantry', x, y, w, h, opts);
        const o = Object.assign({}, opts || {}, { dim: true });
        this._begin(ctx, x, y, w, h, o, this._teamColor(opts));
        ctx.beginPath(); ctx.arc(14, 22, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(50, 22, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(6, 40); ctx.lineTo(22, 40); ctx.moveTo(42, 40); ctx.lineTo(58, 40); ctx.stroke();
        this._end(ctx);
    },

    drawWreck(ctx, x, y, w, h, opts) {
        if (!ctx) return;
        const color = this._teamColor(opts);
        this._begin(ctx, x, y, w, h, opts, color);
        ctx.save();
        ctx.rotate(-0.16);
        ctx.beginPath();
        ctx.moveTo(8, 38); ctx.lineTo(26, 30); ctx.lineTo(46, 32); ctx.lineTo(58, 40);
        ctx.lineTo(48, 48); ctx.lineTo(16, 48); ctx.closePath(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(26, 30); ctx.lineTo(20, 18); ctx.lineTo(36, 22); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(46, 32); ctx.lineTo(52, 20); ctx.lineTo(40, 24); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(16, 48); ctx.lineTo(12, 58); ctx.moveTo(48, 48); ctx.lineTo(52, 58); ctx.stroke();
        ctx.beginPath(); ctx.arc(34, 40, 3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        this._end(ctx);
    },

    drawCrystalField(ctx, x, y, w, h, opts) {
        this.drawCrystal(ctx, x, y, w, h, opts);
        this._begin(ctx, x, y, w, h, opts, this._teamColor(opts));
        ctx.beginPath(); ctx.moveTo(10, 46); ctx.lineTo(18, 38); ctx.lineTo(26, 46); ctx.lineTo(18, 56); ctx.closePath(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(44, 44); ctx.lineTo(52, 36); ctx.lineTo(60, 44); ctx.lineTo(52, 54); ctx.closePath(); ctx.stroke();
        this._end(ctx);
    },
};
