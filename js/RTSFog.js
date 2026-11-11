// RTSFog.js — the visual fog-of-war layer. It samples the player's visibility grid into a
// DynamicTexture and darkens the frame with a post-process. The world position of every pixel
// is found by intersecting the camera ray with the ground plane; the sky is left untouched.

class RTSFog {
    /** @param {BABYLON.Scene} scene @param {RTSMap} map @param {RTSWorld} world */
    constructor(scene, map, world) {
        this.scene = scene;
        this.map = map;
        this.world = world;
        this.size = map.size;
        const resolution = typeof RTS_FOG_RESOLUTION !== 'undefined' ? RTS_FOG_RESOLUTION : 256;
        this.fogSize = Math.max(32, Math.min(this.size, Math.round(resolution)));
        this.worldSize = map.size * map.scale;
        this.color = World3D.hexColor3(RTS_FOG_COLOR);
        this.timer = 0;
        this.camera = scene.activeCamera;

        RTSFog._registerShader();
        this.texture = new BABYLON.DynamicTexture(
            'rts-fog-texture', { width: this.fogSize, height: this.fogSize }, scene, false,
            BABYLON.Texture.BILINEAR_SAMPLINGMODE, BABYLON.Engine.TEXTUREFORMAT_RGBA, false
        );
        this.texture.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
        this.texture.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
        this.texture.hasAlpha = true;
        this.ctx = /** @type {any} */ (this.texture.getContext());
        this.image = this.ctx.createImageData(this.fogSize, this.fogSize);
        this.alpha = new Float32Array(this.fogSize * this.fogSize);
        this.blur = new Float32Array(this.fogSize * this.fogSize);
        this._fill();

        this.post = new BABYLON.PostProcess(
            'rtsFog', 'rtsFog',
            ['invView', 'invProjection', 'cameraPosition', 'worldSize', 'fogColor'],
            ['fogTexture'], 1.0, this.camera
        );
        this.post.onApply = (effect) => {
            const cam = this.camera;
            if (!cam) return;
            effect.setTexture('fogTexture', this.texture);
            effect.setMatrix('invView', cam.getViewMatrix().clone().invert());
            effect.setMatrix('invProjection', cam.getProjectionMatrix().clone().invert());
            effect.setVector3('cameraPosition', cam.globalPosition);
            effect.setFloat('worldSize', this.worldSize);
            effect.setColor3('fogColor', this.color);
        };
        if (this.camera) this.camera.attachPostProcess(this.post);
    }

    static _registerShader() {
        if (BABYLON.Effect.ShadersStore['rtsFogFragmentShader']) return;
        BABYLON.Effect.ShadersStore['rtsFogFragmentShader'] = `
            precision highp float;
            varying vec2 vUV;
            uniform sampler2D textureSampler;
            uniform sampler2D fogTexture;
            uniform mat4 invView;
            uniform mat4 invProjection;
            uniform vec3 cameraPosition;
            uniform float worldSize;
            uniform vec3 fogColor;

            void main(void) {
                vec4 color = texture2D(textureSampler, vUV);
                vec4 ndc = vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
                vec4 view = invProjection * ndc;
                view /= view.w;
                vec3 dir = normalize((invView * vec4(view.xyz, 0.0)).xyz);
                if (dir.y >= -0.0001) {
                    gl_FragColor = color;
                    return;
                }
                float t = -cameraPosition.y / dir.y;
                if (t <= 0.0) {
                    gl_FragColor = color;
                    return;
                }
                vec3 world = cameraPosition + dir * t;
                vec2 uv = clamp(world.xz / worldSize, vec2(0.0), vec2(1.0));
                float alpha = texture2D(fogTexture, uv).a;
                gl_FragColor = vec4(mix(color.rgb, fogColor, alpha), color.a);
            }
        `;
    }

    _fill() {
        this.alpha.fill(RTS_FOG_UNEXPLORED_ALPHA);
        this._writeTexture();
    }

    _writeTexture() {
        const data = this.image.data;
        const r = Math.round(this.color.r * 255);
        const g = Math.round(this.color.g * 255);
        const b = Math.round(this.color.b * 255);
        for (let i = 0; i < this.alpha.length; i++) {
            const o = i * 4;
            data[o] = r;
            data[o + 1] = g;
            data[o + 2] = b;
            data[o + 3] = Math.round(Math.max(0, Math.min(1, this.alpha[i])) * 255);
        }
        this.ctx.putImageData(this.image, 0, 0);
        this.texture.update(false);
    }

    _blurAlpha() {
        const n = this.fogSize;
        const src = this.alpha;
        const dst = this.blur;
        for (let pass = 0; pass < 2; pass++) {
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    let sum = 0, count = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        const yy = y + dy;
                        if (yy < 0 || yy >= n) continue;
                        for (let dx = -1; dx <= 1; dx++) {
                            const xx = x + dx;
                            if (xx < 0 || xx >= n) continue;
                            sum += src[yy * n + xx];
                            count++;
                        }
                    }
                    dst[y * n + x] = sum / count;
                }
            }
            this.alpha.set(dst);
        }
    }

    /** @param {number} dt @param {RTSVision} vision */
    update(dt, vision) {
        if (!vision) return;
        this.timer -= dt;
        if (this.timer > 0) return;
        this.timer = RTS_FOG_UPDATE_SEC;
        const n = this.size;
        const f = this.fogSize;
        const step = n / f;
        const vis = vision.visible.player;
        const exp = vision.explored.player;
        for (let y = 0; y < f; y++) {
            const sy = Math.min(n - 1, Math.floor((y + 0.5) * step));
            for (let x = 0; x < f; x++) {
                const sx = Math.min(n - 1, Math.floor((x + 0.5) * step));
                const i = sy * n + sx;
                this.alpha[y * f + x] = vis[i] ? 0 : (exp[i] ? RTS_FOG_EXPLORED_ALPHA : RTS_FOG_UNEXPLORED_ALPHA);
            }
        }
        this._blurAlpha();
        this._writeTexture();
    }

    dispose() {
        if (this.camera && this.post) this.camera.detachPostProcess(this.post);
        if (this.post) this.post.dispose();
        if (this.texture) this.texture.dispose();
        this.post = null;
        this.texture = null;
    }
}
