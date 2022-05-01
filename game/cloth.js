import { EM } from "../entity-manager.js";
import { vec3 } from "../gl-matrix.js";
import { RenderableDef } from "../renderer.js";
import { PositionDef } from "../physics/transform.js";
import { ColorDef } from "./game.js";
import { SyncDef, AuthorityDef, MeDef } from "../net/components.js";
import { FinishedDef } from "../build.js";
import { AssetsDef } from "./assets.js";
import { isMeshHandle, MeshHandleDef, unshareProvokingVertices, } from "../mesh-pool.js";
import { SpringType, SpringGridDef, ForceDef } from "./spring.js";
import { RendererDef } from "../render_init.js";
export const ClothConstructDef = EM.defineComponent("clothConstruct", (location, color, rows, columns, distance) => ({
    location: location !== null && location !== void 0 ? location : vec3.fromValues(0, 0, 0),
    color: color !== null && color !== void 0 ? color : vec3.fromValues(0, 0, 0),
    rows: rows !== null && rows !== void 0 ? rows : 2,
    columns: columns !== null && columns !== void 0 ? columns : 2,
    distance: distance !== null && distance !== void 0 ? distance : 1,
}));
EM.registerSerializerPair(ClothConstructDef, (clothConstruct, buf) => {
    buf.writeVec3(clothConstruct.location);
    buf.writeVec3(clothConstruct.color);
    buf.writeUint16(clothConstruct.rows);
    buf.writeUint16(clothConstruct.columns);
    buf.writeFloat32(clothConstruct.distance);
}, (clothConstruct, buf) => {
    buf.readVec3(clothConstruct.location);
    buf.readVec3(clothConstruct.color);
    clothConstruct.rows = buf.readUint16();
    clothConstruct.columns = buf.readUint16();
    clothConstruct.distance = buf.readFloat32();
});
function clothMesh(cloth) {
    let x = 0;
    let y = 0;
    let i = 0;
    const pos = [];
    const tri = [];
    const colors = [];
    const lines = [];
    while (y < cloth.rows) {
        if (x == cloth.columns) {
            x = 0;
            y = y + 1;
            continue;
        }
        pos.push(vec3.fromValues(x * cloth.distance, y * cloth.distance, 0));
        // add triangles
        if (y > 0) {
            if (x > 0) {
                // front
                tri.push(vec3.fromValues(i, i - 1, i - cloth.columns));
                colors.push(vec3.fromValues(0, 0, 0));
                // back
                tri.push(vec3.fromValues(i - cloth.columns, i - 1, i));
                colors.push(vec3.fromValues(0, 0, 0));
            }
            if (x < cloth.columns - 1) {
                // front
                tri.push(vec3.fromValues(i, i - cloth.columns, i - cloth.columns + 1));
                colors.push(vec3.fromValues(0, 0, 0));
                // back
                tri.push(vec3.fromValues(i - cloth.columns + 1, i - cloth.columns, i));
                colors.push(vec3.fromValues(0, 0, 0));
            }
        }
        // add lines
        if (x > 0) {
            lines.push([i - 1, i]);
        }
        if (y > 0) {
            lines.push([i - cloth.columns, i]);
        }
        x = x + 1;
        i = i + 1;
    }
    return unshareProvokingVertices({ pos, tri, colors, lines });
}
export function registerBuildClothsSystem(em) {
    function buildCloths(cloths, { me: { pid }, assets }) {
        for (let cloth of cloths) {
            if (FinishedDef.isOn(cloth))
                continue;
            em.ensureComponent(cloth.id, PositionDef, cloth.clothConstruct.location);
            em.ensureComponent(cloth.id, ColorDef, cloth.clothConstruct.color);
            em.ensureComponent(cloth.id, RenderableDef, clothMesh(cloth.clothConstruct));
            em.ensureComponent(cloth.id, SpringGridDef, SpringType.SimpleDistance, cloth.clothConstruct.rows, cloth.clothConstruct.columns, [
                0,
                cloth.clothConstruct.columns - 1,
                cloth.clothConstruct.rows * (cloth.clothConstruct.columns - 1),
                cloth.clothConstruct.rows * cloth.clothConstruct.columns - 1,
            ], cloth.clothConstruct.distance);
            em.ensureComponent(cloth.id, ForceDef);
            em.ensureComponent(cloth.id, AuthorityDef, pid);
            em.ensureComponent(cloth.id, SyncDef, [ClothConstructDef.id], [PositionDef.id, ForceDef.id]);
            em.ensureComponent(cloth.id, FinishedDef);
        }
    }
    em.registerSystem([ClothConstructDef], [MeDef, AssetsDef], buildCloths);
}
export function registerUpdateClothMeshSystem(em) {
    em.registerSystem([ClothConstructDef, SpringGridDef, RenderableDef, MeshHandleDef], [RendererDef], (cloths, { renderer }) => {
        for (let cloth of cloths) {
            if (isMeshHandle(cloth.renderable.meshOrProto)) {
                throw "Instancing not supported for cloth";
            }
            for (let i = 0; i < cloth.renderable.meshOrProto.pos.length; i++) {
                const originalIndex = cloth.renderable.meshOrProto.posMap.get(i);
                vec3.copy(cloth.renderable.meshOrProto.pos[i], cloth.springGrid.positions[originalIndex]);
            }
            renderer.renderer.updateMesh(cloth.meshHandle, cloth.renderable.meshOrProto);
        }
    }, "updateClothMesh");
}
 