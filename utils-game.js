import { ColorDef } from "./color.js";
import { EM } from "./entity-manager.js";
import { PositionDef } from "./physics/transform.js";
import { RenderableConstructDef } from "./render/renderer.js";
// TODO(@darzu): move this helper elsewhere?
// TODO(@darzu): would be dope to support thickness;
//    probably needs some shader work + a post pass
export function drawLine(start, end, color) {
    const { id } = EM.newEntity();
    EM.addComponent(id, ColorDef, color);
    const m = {
        pos: [start, end],
        tri: [],
        colors: [],
        lines: [[0, 1]],
        usesProvoking: true,
    };
    EM.addComponent(id, RenderableConstructDef, m);
    EM.addComponent(id, PositionDef);
}