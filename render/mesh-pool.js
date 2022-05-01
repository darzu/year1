import { computeTriangleNormal, vec3Mid } from "../utils-3d.js";
import { mat4, vec2, vec3 } from "../gl-matrix.js";
import { align, sum } from "../math.js";
import { getAABBFromPositions } from "../physics/broadphase.js";
import { MeshUniformMod } from "./shader_obj.js";
// TODO(@darzu): abstraction refinement:
//  [ ] how do we handle multiple shaders with different mesh
//    uniforms? e.g. water, noodles, cloth, regular objects, grass
const vertsPerTri = 3;
const bytesPerTri = Uint16Array.BYTES_PER_ELEMENT * vertsPerTri;
const linesPerTri = 6;
const bytesPerLine = Uint16Array.BYTES_PER_ELEMENT * 2;
const bytesPerMat4 = 4 * 4 /*4x4 mat*/ * 4; /*f32*/
const bytesPerVec3 = 3 /*vec3*/ * 4; /*f32*/
const bytesPerVec2 = 2 /*vec3*/ * 4; /*f32*/
const bytesPerFloat = Float32Array.BYTES_PER_ELEMENT;
const bytesPerUint16 = Uint16Array.BYTES_PER_ELEMENT;
const bytesPerUint32 = Uint32Array.BYTES_PER_ELEMENT;
const MAX_INDICES = 65535; // Since we're using u16 index type, this is our max indices count
const DEFAULT_VERT_COLOR = [0.0, 0.0, 0.0];
const formatToWgslType = {
    float16x2: "vec2<f16>",
    float16x4: "vec2<f16>",
    float32: "f32",
    float32x2: "vec2<f32>",
    float32x3: "vec3<f32>",
    float32x4: "vec4<f32>",
    uint32: "u32",
    sint32: "i32",
};
// Everything to do with our vertex format must be in this module (minus downstream
//  places that should get type errors when this module changes.)
// TODO(@darzu): code gen some of this so code changes are less error prone.
export var Vertex;
(function (Vertex) {
    let Kind;
    (function (Kind) {
        Kind[Kind["normal"] = 0] = "normal";
        Kind[Kind["water"] = 1] = "water";
    })(Kind = Vertex.Kind || (Vertex.Kind = {}));
    // define the format of our vertices (this needs to agree with the inputs to the vertex shaders)
    Vertex.WebGPUFormat = [
        { shaderLocation: 0, offset: bytesPerVec3 * 0, format: "float32x3" },
        { shaderLocation: 1, offset: bytesPerVec3 * 1, format: "float32x3" },
        { shaderLocation: 2, offset: bytesPerVec3 * 2, format: "float32x3" }, // normals
    ];
    const names = ["position", "color", "normal"];
    function GenerateWGSLVertexInputStruct(terminator) {
        // Example output:
        // `
        // @location(0) position : vec3<f32>,
        // @location(1) color : vec3<f32>,
        // @location(2) normal : vec3<f32>,
        // @location(3) kind : u32,
        // `
        let res = ``;
        if (Vertex.WebGPUFormat.length !== names.length)
            throw `mismatch between vertex format specifiers and names`;
        for (let i = 0; i < Vertex.WebGPUFormat.length; i++) {
            const f = Vertex.WebGPUFormat[i];
            const t = formatToWgslType[f.format];
            const n = names[i];
            if (!t)
                throw `Unknown vertex type -> wgls type '${f.format}'`;
            res += `@location(${f.shaderLocation}) ${n} : ${t}${terminator}\n`;
        }
        return res;
    }
    Vertex.GenerateWGSLVertexInputStruct = GenerateWGSLVertexInputStruct;
    // these help us pack and use vertices in that format
    Vertex.ByteSize = bytesPerVec3 /*pos*/ + bytesPerVec3 /*color*/ + bytesPerVec3; /*normal*/
    // for performance reasons, we keep scratch buffers around
    const scratch_f32 = new Float32Array(3 + 3 + 3);
    const scratch_f32_as_u8 = new Uint8Array(scratch_f32.buffer);
    const scratch_u32 = new Uint32Array(1);
    const scratch_u32_as_u8 = new Uint8Array(scratch_u32.buffer);
    function serialize(buffer, byteOffset, pos, color, normal) {
        scratch_f32[0] = pos[0];
        scratch_f32[1] = pos[1];
        scratch_f32[2] = pos[2];
        scratch_f32[3] = color[0];
        scratch_f32[4] = color[1];
        scratch_f32[5] = color[2];
        scratch_f32[6] = normal[0];
        scratch_f32[7] = normal[1];
        scratch_f32[8] = normal[2];
        buffer.set(scratch_f32_as_u8, byteOffset);
    }
    Vertex.serialize = serialize;
    // for WebGL: deserialize whole array?
    function Deserialize(buffer, vertexCount, positions, colors, normals) {
        if (false ||
            buffer.length < vertexCount * Vertex.ByteSize ||
            positions.length < vertexCount * 3 ||
            colors.length < vertexCount * 3 ||
            normals.length < vertexCount * 3)
            throw "buffer too short!";
        // TODO(@darzu): This only works because they have the same element size. Not sure what to do if that changes.
        const f32View = new Float32Array(buffer.buffer);
        const u32View = new Uint32Array(buffer.buffer);
        for (let i = 0; i < vertexCount; i++) {
            const u8_i = i * Vertex.ByteSize;
            const f32_i = u8_i / Float32Array.BYTES_PER_ELEMENT;
            const u32_i = u8_i / Uint32Array.BYTES_PER_ELEMENT;
            positions[i * 3 + 0] = f32View[f32_i + 0];
            positions[i * 3 + 1] = f32View[f32_i + 1];
            positions[i * 3 + 2] = f32View[f32_i + 2];
            colors[i * 3 + 0] = f32View[f32_i + 3];
            colors[i * 3 + 1] = f32View[f32_i + 4];
            colors[i * 3 + 2] = f32View[f32_i + 5];
            normals[i * 3 + 0] = f32View[f32_i + 6];
            normals[i * 3 + 1] = f32View[f32_i + 7];
            normals[i * 3 + 2] = f32View[f32_i + 8];
        }
    }
    Vertex.Deserialize = Deserialize;
})(Vertex || (Vertex = {}));
export var SceneUniform;
(function (SceneUniform) {
    const _counts = [
        4 * 4,
        3,
        3,
        3,
        1,
        2,
        3, // camera pos
    ];
    const _offsets = _counts.reduce((p, n) => [...p, p[p.length - 1] + n], [0]);
    // TODO(@darzu): SCENE FORMAT
    // defines the format of our scene's uniform data
    SceneUniform.ByteSizeExact = sum(_counts) * Float32Array.BYTES_PER_ELEMENT;
    SceneUniform.ByteSizeAligned = align(SceneUniform.ByteSizeExact, 256); // uniform objects must be 256 byte aligned
    function generateWGSLUniformStruct() {
        // TODO(@darzu): enforce agreement w/ Scene interface
        return `
            cameraViewProjMatrix : mat4x4<f32>,
            // lightViewProjMatrix : mat4x4<f32>,
            light1Dir : vec3<f32>,
            light2Dir : vec3<f32>,
            light3Dir : vec3<f32>,
            time : f32,
            playerPos: vec2<f32>,
            cameraPos : vec3<f32>,
        `;
    }
    SceneUniform.generateWGSLUniformStruct = generateWGSLUniformStruct;
    const scratch_f32 = new Float32Array(sum(_counts));
    const scratch_f32_as_u8 = new Uint8Array(scratch_f32.buffer);
    function serialize(buffer, byteOffset, data) {
        scratch_f32.set(data.cameraViewProjMatrix, _offsets[0]);
        // scratch_f32.set(data.lightViewProjMatrix, _offsets[1]);
        scratch_f32.set(data.light1Dir, _offsets[1]);
        scratch_f32.set(data.light2Dir, _offsets[2]);
        scratch_f32.set(data.light3Dir, _offsets[3]);
        scratch_f32[_offsets[4]] = data.time;
        scratch_f32.set(data.playerPos, _offsets[5]);
        scratch_f32.set(data.cameraPos, _offsets[6]);
        buffer.set(scratch_f32_as_u8, byteOffset);
    }
    SceneUniform.serialize = serialize;
})(SceneUniform || (SceneUniform = {}));
export const MeshUniform = MeshUniformMod;
export function isMeshHandle(m) {
    return "mId" in m;
}
export function unshareVertices(input) {
    const pos = [];
    const tri = [];
    input.tri.forEach(([i0, i1, i2], i) => {
        pos.push(input.pos[i0]);
        pos.push(input.pos[i1]);
        pos.push(input.pos[i2]);
        tri.push([i * 3 + 0, i * 3 + 1, i * 3 + 2]);
    });
    return { ...input, pos, tri, verticesUnshared: true };
}
export function unshareProvokingVertices(input) {
    const pos = [...input.pos];
    const tri = [];
    const provoking = {};
    input.tri.forEach(([i0, i1, i2], triI) => {
        if (!provoking[i0]) {
            // First vertex is unused as a provoking vertex, so we'll use it for this triangle.
            provoking[i0] = true;
            tri.push([i0, i1, i2]);
        }
        else if (!provoking[i1]) {
            // First vertex was taken, so let's see if we can rotate the indices to get an unused
            // provoking vertex.
            provoking[i1] = true;
            tri.push([i1, i2, i0]);
        }
        else if (!provoking[i2]) {
            // ditto
            provoking[i2] = true;
            tri.push([i2, i0, i1]);
        }
        else {
            // All vertices are taken, so create a new one
            const i3 = pos.length;
            pos.push(input.pos[i0]);
            provoking[i3] = true;
            tri.push([i3, i1, i2]);
        }
    });
    return { ...input, pos, tri, usesProvoking: true };
}
export function createMeshPool_WebGPU(device, opts) {
    const { maxMeshes, maxTris, maxVerts, maxLines } = opts;
    // console.log(`maxMeshes: ${maxMeshes}, maxTris: ${maxTris}, maxVerts: ${maxVerts}`)
    // create our mesh buffers (vertex, index, uniform)
    const verticesBuffer = device.createBuffer({
        size: maxVerts * Vertex.ByteSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        // NOTE(@darzu): with WebGPU we have the option to modify the full buffers in memory before
        //  handing them over to the GPU. This could be good for large initial sets of data, instead of
        //  sending that over later via the queues. See commit 4862a7c and it's successors. Pre those
        //  commits, we had a way to add mesh data to either via initial memory maps or queues. The
        //  memory mapped way was removed to simplify the abstractions since we weren't noticing speed
        //  benefits at the time.
        mappedAtCreation: false,
    });
    const triIndicesBuffer = device.createBuffer({
        size: maxTris * bytesPerTri,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: false,
    });
    // TODO(@darzu): make creating this buffer optional on whether we're using line indices or not
    const lineIndicesBuffer = device.createBuffer({
        size: maxLines * bytesPerLine,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: false,
    });
    const uniformBuffer = device.createBuffer({
        size: MeshUniformMod.byteSizeAligned * maxMeshes,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: false,
    });
    function updateBuf(buffer, offset, data) {
        device.queue.writeBuffer(buffer, offset, data);
    }
    const queues = {
        updateTriIndices: (offset, data) => updateBuf(triIndicesBuffer, offset, data),
        updateLineIndices: (offset, data) => updateBuf(lineIndicesBuffer, offset, data),
        updateVertices: (offset, data) => updateBuf(verticesBuffer, offset, data),
        updateUniform: (offset, data) => updateBuf(uniformBuffer, offset, data),
    };
    const buffers = {
        device,
        verticesBuffer,
        triIndicesBuffer,
        lineIndicesBuffer,
        uniformBuffer,
    };
    const pool = createMeshPool(opts, queues);
    const pool_webgpu = { ...pool, ...buffers };
    return pool_webgpu;
}
export function createMeshPool_WebGL(gl, opts) {
    const { maxMeshes, maxTris, maxVerts, maxLines } = opts;
    // TODO(@darzu): we shouldn't need to preallocate all this
    const scratchPositions = new Float32Array(maxVerts * 3);
    const scratchNormals = new Float32Array(maxVerts * 3);
    const scratchColors = new Float32Array(maxVerts * 3);
    const scratchTriIndices = new Uint16Array(maxTris * 3);
    const scratchLineIndices = new Uint16Array(maxLines * 2);
    // vertex buffers
    const positionsBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionsBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scratchPositions, gl.DYNAMIC_DRAW); // TODO(@darzu): sometimes we might want STATIC_DRAW
    const normalsBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalsBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scratchNormals, gl.DYNAMIC_DRAW);
    const colorsBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorsBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scratchColors, gl.DYNAMIC_DRAW);
    // index buffers
    const triIndicesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triIndicesBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scratchTriIndices, gl.DYNAMIC_DRAW);
    const lineIndicesBuffer = gl.createBuffer();
    // TODO(@darzu): line indices don't work right. they interfere with regular tri indices.
    // gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIndicesBuffer);
    // gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scratchLineIndices, gl.DYNAMIC_DRAW);
    // our in-memory reflections of the buffers used during the initial build phase
    // TODO(@darzu): this is too much duplicate data
    // let verticesMap = new Uint8Array(maxVerts * Vertex.ByteSize);
    // let triIndicesMap = new Uint16Array(maxTris * 3);
    // let lineIndicesMap = new Uint16Array(maxLines * 2);
    let uniformMap = new Uint8Array(maxMeshes * MeshUniformMod.byteSizeAligned);
    function updateVertices(offset, data) {
        // TODO(@darzu): this is a strange way to compute this, but seems to work conservatively
        // const numVerts = Math.min(data.length / Vertex.ByteSize, Math.max(builder.numVerts, builder.poolHandle.numVerts))
        const numVerts = data.length / Vertex.ByteSize;
        const positions = new Float32Array(numVerts * 3);
        const colors = new Float32Array(numVerts * 3);
        const normals = new Float32Array(numVerts * 3);
        Vertex.Deserialize(data, numVerts, positions, colors, normals);
        const vNumOffset = offset / Vertex.ByteSize;
        // TODO(@darzu): debug logging
        // console.log(`positions: #${vNumOffset}: ${positions.slice(0, numVerts * 3).join(',')}`)
        gl.bindBuffer(gl.ARRAY_BUFFER, positionsBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, vNumOffset * bytesPerVec3, positions);
        gl.bindBuffer(gl.ARRAY_BUFFER, normalsBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, vNumOffset * bytesPerVec3, normals);
        gl.bindBuffer(gl.ARRAY_BUFFER, colorsBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, vNumOffset * bytesPerVec3, colors);
    }
    function updateTriIndices(offset, data) {
        // TODO(@darzu): again, strange but a useful optimization
        // const numInd = Math.min(data.length / 2, Math.max(builder.numTris, builder.poolHandle.numTris) * 3)
        // TODO(@darzu): debug logging
        // console.log(`indices: #${offset / 2}: ${new Uint16Array(data.buffer).slice(0, numInd).join(',')}`)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triIndicesBuffer);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset, data);
    }
    function updateLineIndices(offset, data) {
        // TODO(@darzu): line indices don't work right. they interfere with regular tri indices.
        // gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIndicesBuffer);
        // gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset, data);
    }
    function updateUniform(offset, data) {
        uniformMap.set(data, offset);
    }
    const queues = {
        updateTriIndices,
        updateLineIndices,
        updateVertices,
        updateUniform,
    };
    const buffers = {
        gl,
        positionsBuffer,
        normalsBuffer,
        colorsBuffer,
        // other buffers
        triIndicesBuffer,
        lineIndicesBuffer,
    };
    const pool = createMeshPool(opts, queues);
    const pool_webgl = { ...pool, ...buffers };
    return pool_webgl;
}
const scratch_uniform_u8 = new Uint8Array(MeshUniformMod.byteSizeAligned);
function createMeshPool(opts, queues) {
    const { maxMeshes, maxTris, maxVerts, maxLines } = opts;
    if (MAX_INDICES < maxVerts)
        throw `Too many vertices (${maxVerts})! W/ Uint16, we can only support '${maxVerts}' verts`;
    // log our estimated space usage stats
    console.log(`Mesh space usage for up to ${maxMeshes} meshes, ${maxTris} tris, ${maxVerts} verts:`);
    console.log(`   ${((maxVerts * Vertex.ByteSize) / 1024).toFixed(1)} KB for verts`);
    console.log(`   ${((maxTris * bytesPerTri) / 1024).toFixed(1)} KB for tri indices`);
    console.log(`   ${((maxLines * bytesPerLine) / 1024).toFixed(1)} KB for line indices`);
    console.log(`   ${((maxMeshes * MeshUniformMod.byteSizeAligned) / 1024).toFixed(1)} KB for object uniform data`);
    const unusedBytesPerModel = MeshUniformMod.byteSizeAligned - MeshUniformMod.byteSizeExact;
    console.log(`   Unused ${unusedBytesPerModel} bytes in uniform buffer per object (${((unusedBytesPerModel * maxMeshes) /
        1024).toFixed(1)} KB total waste)`);
    const totalReservedBytes = maxVerts * Vertex.ByteSize +
        maxTris * bytesPerTri +
        maxLines * bytesPerLine +
        maxMeshes * MeshUniformMod.byteSizeAligned;
    console.log(`Total space reserved for objects: ${(totalReservedBytes / 1024).toFixed(1)} KB`);
    const allMeshes = [];
    const pool = {
        opts,
        allMeshes,
        numTris: 0,
        numVerts: 0,
        numLines: 0,
        updateUniform,
        addMesh,
        addMeshInstance,
        updateMeshVertices,
    };
    function addMesh(m) {
        var _a, _b, _c, _d;
        if (pool.allMeshes.length + 1 > maxMeshes)
            throw "Too many meshes!";
        if (pool.numVerts + m.pos.length > maxVerts)
            throw "Too many vertices!";
        if (pool.numTris + m.tri.length > maxTris)
            throw "Too many triangles!";
        if (pool.numLines + ((_b = (_a = m.lines) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) > maxLines)
            throw "Too many lines!";
        // console.log(`QUEUE builder.allMeshes.length: ${builder.allMeshes.length}, builder.numTris: ${builder.numTris}, builder.numVerts: ${builder.numVerts}`)
        // console.log(`QUEUE pool.allMeshes.length: ${pool.allMeshes.length}, pool.numTris: ${pool.numTris}, pool.numVerts: ${pool.numVerts}`)
        const data = {
            // TODO(@darzu): use scratch arrays
            verticesMap: new Uint8Array(m.pos.length * Vertex.ByteSize),
            // pad triangles array to make sure it's a multiple of 4 *bytes*
            triIndicesMap: new Uint16Array(align(m.tri.length * 3, 2)),
            lineIndicesMap: new Uint16Array(((_d = (_c = m.lines) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 2) * 2),
            uniformMap: new Uint8Array(MeshUniformMod.byteSizeAligned),
        };
        const b = createMeshBuilder(data, opts.shiftMeshIndices ? pool.numVerts : 0, m);
        m.pos.forEach((pos, i) => {
            // this is placeholder vert data which will be updated later by serializeMeshVertices
            b.addVertex(pos, DEFAULT_VERT_COLOR, [1.0, 0.0, 0.0]);
        });
        m.tri.forEach((triInd, i) => {
            b.addTri(triInd);
        });
        if (m.lines) {
            m.lines.forEach((inds, i) => {
                b.addLine(inds);
            });
        }
        // initial uniform data
        const { min, max } = getAABBFromMesh(m);
        b.setUniform(mat4.create(), min, max, vec3.create());
        const idx = {
            pool,
            vertNumOffset: pool.numVerts,
            triIndicesNumOffset: pool.numTris * 3,
            lineIndicesNumOffset: pool.numLines * 2,
            modelUniByteOffset: allMeshes.length * MeshUniformMod.byteSizeAligned,
        };
        const handle = b.finish(idx);
        // update vertex data
        serializeMeshVertices(m, data.verticesMap);
        queues.updateTriIndices(idx.triIndicesNumOffset * 2, new Uint8Array(data.triIndicesMap.buffer)); // TODO(@darzu): this view shouldn't be necessary
        queues.updateLineIndices(idx.lineIndicesNumOffset * 2, new Uint8Array(data.lineIndicesMap.buffer)); // TODO(@darzu): this view shouldn't be necessary
        queues.updateVertices(idx.vertNumOffset * Vertex.ByteSize, data.verticesMap);
        queues.updateUniform(idx.modelUniByteOffset, data.uniformMap);
        pool.numTris += handle.numTris;
        // See the comment over the similar lign in mappedAddMesh--a
        // mesh's triangles need to be 4-byte aligned.
        pool.numTris = align(pool.numTris, 2);
        pool.numLines += handle.numLines;
        pool.numVerts += handle.numVerts;
        pool.allMeshes.push(handle);
        return handle;
    }
    function addMeshInstance(m, d) {
        if (pool.allMeshes.length + 1 > maxMeshes)
            throw "Too many meshes!";
        const uniOffset = allMeshes.length * MeshUniformMod.byteSizeAligned;
        const newHandle = {
            ...m,
            mId: nextMeshId++,
            shaderData: d,
            modelUniByteOffset: uniOffset,
        };
        allMeshes.push(newHandle);
        updateUniform(newHandle);
        return newHandle;
    }
    function updateMeshVertices(handle, newMesh) {
        // TODO(@darzu): use scratch array
        const verticesMap = new Uint8Array(newMesh.pos.length * Vertex.ByteSize);
        serializeMeshVertices(newMesh, verticesMap);
        queues.updateVertices(handle.vertNumOffset * Vertex.ByteSize, verticesMap);
    }
    function updateUniform(m) {
        MeshUniformMod.serialize(scratch_uniform_u8, 0, m.shaderData);
        queues.updateUniform(m.modelUniByteOffset, scratch_uniform_u8);
    }
    return pool;
}
function serializeMeshVertices(m, verticesMap) {
    if (!m.usesProvoking)
        throw `mesh must use provoking vertices`;
    m.pos.forEach((pos, i) => {
        const vOff = i * Vertex.ByteSize;
        Vertex.serialize(verticesMap, vOff, pos, DEFAULT_VERT_COLOR, [1.0, 0.0, 0.0]);
    });
    m.tri.forEach((triInd, i) => {
        // set provoking vertex data
        // TODO(@darzu): add support for writting to all three vertices (for non-provoking vertex setups)
        const vOff = triInd[0] * Vertex.ByteSize;
        const normal = computeTriangleNormal(m.pos[triInd[0]], m.pos[triInd[1]], m.pos[triInd[2]]);
        Vertex.serialize(verticesMap, vOff, m.pos[triInd[0]], m.colors[i], normal);
    });
}
// TODO(@darzu): not totally sure we want this state
let nextMeshId = 0;
function createMeshBuilder(maps, indicesShift, mesh) {
    // TODO(@darzu): these used to be parameters and can be again if we want to
    //  work inside some bigger array
    const uByteOff = 0;
    const vByteOff = 0;
    const iByteOff = 0;
    const lByteOff = 0;
    let meshFinished = false;
    let numVerts = 0;
    let numTris = 0;
    let numLines = 0;
    // TODO(@darzu): VERTEX FORMAT
    function addVertex(pos, color, normal) {
        if (meshFinished)
            throw "trying to use finished MeshBuilder";
        const vOff = vByteOff + numVerts * Vertex.ByteSize;
        Vertex.serialize(maps.verticesMap, vOff, pos, color, normal);
        numVerts += 1;
    }
    let _scratchTri = vec3.create();
    function addTri(triInd) {
        if (meshFinished)
            throw "trying to use finished MeshBuilder";
        const currIByteOff = iByteOff + numTris * bytesPerTri;
        const currI = currIByteOff / 2;
        if (indicesShift) {
            _scratchTri[0] = triInd[0] + indicesShift;
            _scratchTri[1] = triInd[1] + indicesShift;
            _scratchTri[2] = triInd[2] + indicesShift;
        }
        maps.triIndicesMap.set(indicesShift ? _scratchTri : triInd, currI); // TODO(@darzu): it's kinda weird indices map uses uint16 vs the rest us u8
        numTris += 1;
    }
    let _scratchLine = vec2.create();
    function addLine(lineInd) {
        if (meshFinished)
            throw "trying to use finished MeshBuilder";
        const currLByteOff = lByteOff + numLines * bytesPerLine;
        const currL = currLByteOff / 2;
        if (indicesShift) {
            _scratchLine[0] = lineInd[0] + indicesShift;
            _scratchLine[1] = lineInd[1] + indicesShift;
        }
        maps.lineIndicesMap.set(indicesShift ? _scratchLine : lineInd, currL); // TODO(@darzu): it's kinda weird indices map uses uint16 vs the rest us u8
        numLines += 1;
    }
    let _transform = undefined;
    let _aabbMin = undefined;
    let _aabbMax = undefined;
    let _tint = undefined;
    function setUniform(transform, aabbMin, aabbMax, tint) {
        if (meshFinished)
            throw "trying to use finished MeshBuilder";
        _transform = transform;
        _aabbMin = aabbMin;
        _aabbMax = aabbMax;
        _tint = tint;
        MeshUniformMod.serialize(maps.uniformMap, uByteOff, {
            transform,
            aabbMin,
            aabbMax,
            tint,
        });
    }
    function finish(idx) {
        if (meshFinished)
            throw "trying to use finished MeshBuilder";
        if (!_transform)
            throw "uniform never set for this mesh!";
        meshFinished = true;
        const res = {
            ...idx,
            mId: nextMeshId++,
            shaderData: {
                transform: _transform,
                aabbMin: _aabbMin,
                aabbMax: _aabbMax,
                tint: _tint,
            },
            numTris,
            numVerts,
            numLines,
            readonlyMesh: mesh,
        };
        return res;
    }
    return {
        addVertex,
        addTri,
        addLine,
        setUniform,
        finish,
    };
}
// utils
export function getAABBFromMesh(m) {
    return getAABBFromPositions(m.pos);
}
export function getCenterFromAABB(aabb) {
    return vec3Mid(vec3.create(), aabb.min, aabb.max);
}
export function getHalfsizeFromAABB(aabb) {
    const out = vec3.create();
    const a = aabb.max;
    const b = aabb.min;
    out[0] = (a[0] - b[0]) * 0.5;
    out[1] = (a[1] - b[1]) * 0.5;
    out[2] = (a[2] - b[2]) * 0.5;
    return out;
}
export function mapMeshPositions(m, map) {
    let pos = m.pos.map(map);
    return { ...m, pos };
}
export function scaleMesh(m, by) {
    return mapMeshPositions(m, (p) => vec3.scale(vec3.create(), p, by));
}
export function scaleMesh3(m, by) {
    return mapMeshPositions(m, (p) => vec3.multiply(vec3.create(), p, by));
}
export function transformMesh(m, t) {
    return mapMeshPositions(m, (p) => vec3.transformMat4(vec3.create(), p, t));
}
export function cloneMesh(m) {
    return {
        ...m,
        pos: m.pos.map((p) => vec3.clone(p)),
        tri: m.tri.map((p) => vec3.clone(p)),
        colors: m.colors.map((p) => vec3.clone(p)),
        lines: m.lines ? m.lines.map((p) => vec2.clone(p)) : undefined,
    };
}
// split mesh by connectivity
// TODO(@darzu): actually, we probably don't need this function
export function splitMesh(m) {
    // each vertex is a seperate island
    let vertIslands = [];
    for (let i = 0; i < m.pos.length; i++)
        vertIslands[i] = new Set([i]);
    // tris and lines define connectivity, so
    //    merge together islands
    for (let tri of m.tri) {
        mergeIslands(tri[0], tri[1]);
        mergeIslands(tri[0], tri[2]);
    }
    if (m.lines)
        for (let line of m.lines) {
            mergeIslands(line[0], line[1]);
        }
    const uniqueIslands = uniqueRefs(vertIslands);
    console.dir(uniqueIslands);
    // TODO(@darzu): FINISH IMPL
    return [m];
    function mergeIslands(idx0, idx1) {
        const s0 = vertIslands[idx0];
        const s1 = vertIslands[idx1];
        if (s0 !== s1) {
            // merge s0 and s1
            for (let i of s1)
                s0.add(i);
            vertIslands[idx1] = s0;
        }
    }
}
function uniqueRefs(ts) {
    const res = [];
    for (let t1 of ts) {
        if (res.every((t2) => t2 !== t1))
            res.push(t1);
    }
    return res;
}
 