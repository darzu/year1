import { PositionDef, } from "../physics/transform.js";
import { RenderableConstructDef } from "../render/renderer.js";
import { AssetsDef } from "./assets.js";
import { ColorDef } from "../color.js";
const DBG_GRAPPLE = false;
export function registerGrappleDbgSystems(em) {
    if (!DBG_GRAPPLE)
        return;
    em.registerOneShotSystem(null, [AssetsDef], (_, res) => {
        const h = em.newEntity();
        em.ensureComponentOn(h, PositionDef, [0, 0, 0]);
        em.ensureComponentOn(h, ColorDef, [0.1, 0.1, 0.1]);
        em.ensureComponentOn(h, RenderableConstructDef, res.assets.grappleHook.proto);
        const g = em.newEntity();
        em.ensureComponentOn(g, PositionDef, [0, 0, 0]);
        em.ensureComponentOn(g, ColorDef, [0.1, 0.1, 0.1]);
        em.ensureComponentOn(g, RenderableConstructDef, res.assets.grappleGun.proto);
    });
}
 