// RTSGame.js — the top-level RTS demo object created by Game.js. It owns the simulation
// and exposes it as app.game.world for the console (window.app.game.world).
class RTSGame {
    /** @param {{ location: Location3D, camera: CameraController }} app
     *  @param {{ mapSize?: number }} [options] */
    constructor(app, options = {}) {
        this.app = app;
        this.world = new RTSWorld(app, options);
    }

    update(dt) {
        this.world.update(dt);
    }
}
