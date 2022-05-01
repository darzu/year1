import { FinishedDef } from "../build.js";
import { ColliderDef } from "../physics/collider.js";
import { EM } from "../entity-manager.js";
import { vec3 } from "../gl-matrix.js";
import { HAT_OBJ, importObj, isParseError } from "../import_obj.js";
import { getAABBFromMesh, unshareProvokingVertices, } from "../render/mesh-pool.js";
import { AuthorityDef, MeDef, SyncDef } from "../net/components.js";
import { RenderableConstructDef } from "../render/renderer.js";
import { PhysicsParentDef, PositionDef, RotationDef, } from "../physics/transform.js";
import { ColorDef } from "./game.js";
import { registerEventHandler, DetectedEventsDef } from "../net/events.js";
import { LocalPlayerDef, PlayerEntDef } from "./player.js";
import { InteractableDef, InRangeDef } from "./interact.js";
export const HatDef = EM.defineComponent("hat", () => true);
export const HatConstructDef = EM.defineComponent("hatConstruct", (loc) => {
    return {
        loc: loc !== null && loc !== void 0 ? loc : vec3.create(),
    };
});
EM.registerSerializerPair(HatConstructDef, (c, buf) => {
    buf.writeVec3(c.loc);
}, (c, buf) => {
    buf.readVec3(c.loc);
});
let _hatMesh = undefined;
function getHatMesh() {
    if (!_hatMesh) {
        const hatRaw = importObj(HAT_OBJ);
        if (isParseError(hatRaw))
            throw hatRaw;
        const hat = unshareProvokingVertices(hatRaw[0]);
        _hatMesh = hat;
    }
    return _hatMesh;
}
let _hatAABB = undefined;
function getHatAABB() {
    if (!_hatAABB) {
        _hatAABB = getAABBFromMesh(getHatMesh());
    }
    return _hatAABB;
}
function createHat(em, e, pid) {
    if (FinishedDef.isOn(e))
        return;
    const props = e.hatConstruct;
    if (!PositionDef.isOn(e))
        em.addComponent(e.id, PositionDef, props.loc);
    if (!RotationDef.isOn(e))
        em.addComponent(e.id, RotationDef);
    if (!ColorDef.isOn(e))
        em.addComponent(e.id, ColorDef, [0.4, 0.1, 0.1]);
    if (!PhysicsParentDef.isOn(e))
        em.addComponent(e.id, PhysicsParentDef);
    if (!RenderableConstructDef.isOn(e))
        em.addComponent(e.id, RenderableConstructDef, getHatMesh());
    if (!ColliderDef.isOn(e)) {
        const collider = em.addComponent(e.id, ColliderDef);
        collider.shape = "AABB";
        collider.solid = false;
        collider.aabb = getHatAABB();
    }
    if (!AuthorityDef.isOn(e))
        em.addComponent(e.id, AuthorityDef, pid);
    if (!SyncDef.isOn(e)) {
        const sync = em.addComponent(e.id, SyncDef);
        sync.fullComponents.push(HatConstructDef.id);
    }
    if (!HatDef.isOn(e)) {
        em.addComponent(e.id, HatDef);
    }
    // TODO(@darzu): add interact box
    // em.ensureComponent(e.id, InteractableDef);
    em.addComponent(e.id, FinishedDef);
}
export function registerBuildHatSystem(em) {
    em.registerSystem([HatConstructDef], [MeDef], (hats, res) => {
        for (let s of hats)
            createHat(em, s, res.me.pid);
    }, "buildHats");
}
export function registerHatPickupSystem(em) {
    em.registerSystem([HatDef, InRangeDef], [DetectedEventsDef, LocalPlayerDef], (hats, resources) => {
        for (let { id } of hats) {
            let player = EM.findEntity(resources.localPlayer.playerId, [
                PlayerEntDef,
            ]);
            if (player.player.hat === 0 && player.player.interacting) {
                console.log("detecting pickup");
                resources.detectedEvents.raise({
                    type: "hat-pickup",
                    entities: [player.id, id],
                    extra: null,
                });
            }
        }
    }, "hatPickup");
}
export function registerHatDropSystem(em) {
    em.registerSystem([PlayerEntDef, PositionDef, RotationDef], [DetectedEventsDef], (players, { detectedEvents }) => {
        for (let { player, id, position, rotation } of players) {
            // only drop a hat if we don't have a tool
            if (player.dropping && player.hat > 0 && player.tool === 0) {
                let dropLocation = vec3.fromValues(0, 0, -5);
                vec3.transformQuat(dropLocation, dropLocation, rotation);
                vec3.add(dropLocation, dropLocation, position);
                detectedEvents.raise({
                    type: "hat-drop",
                    entities: [id, player.hat],
                    extra: dropLocation,
                });
            }
        }
    }, "hatDrop");
}
registerEventHandler("hat-pickup", {
    entities: [
        [PlayerEntDef],
        [PositionDef, PhysicsParentDef, InteractableDef],
    ],
    eventAuthorityEntity: ([playerId, hatId]) => playerId,
    legalEvent: (em, [player, hat]) => player.player.hat === 0,
    runEvent: (em, [player, hat]) => {
        hat.physicsParent.id = player.id;
        // TODO(@darzu): add interact box
        // em.removeComponent(hat.id, InteractableDef);
        vec3.set(hat.position, 0, 1, 0);
        player.player.hat = hat.id;
    },
});
registerEventHandler("hat-drop", {
    entities: [[PlayerEntDef], [PositionDef, PhysicsParentDef]],
    eventAuthorityEntity: ([playerId, hatId]) => playerId,
    legalEvent: (em, [player, hat]) => {
        return player.player.hat === hat.id;
    },
    runEvent: (em, [player, hat], location) => {
        hat.physicsParent.id = 0;
        // TODO(@darzu): add interact box
        // em.addComponent(hat.id, InteractableDef);
        vec3.copy(hat.position, location);
        player.player.hat = 0;
    },
    serializeExtra: (buf, location) => {
        buf.writeVec3(location);
    },
    deserializeExtra: (buf) => {
        return buf.readVec3();
    },
});
 