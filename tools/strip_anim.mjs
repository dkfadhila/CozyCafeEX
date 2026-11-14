// Strip a Meshy "withSkin" animation GLB down to skeleton + animation tracks, and rename its clips.
// usage: node strip_anim.mjs <in.glb> <out.glb> [oldName=newName ...]   ("*=name" renames a single clip)
import fs from 'node:fs'

const [, , src, dst, ...renames] = process.argv
const buf = fs.readFileSync(src)
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB')
let off = 12
let json, bin
while (off < buf.length) {
  const len = buf.readUInt32LE(off)
  const type = buf.readUInt32LE(off + 4)
  const data = buf.subarray(off + 8, off + 8 + len)
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
  else if (type === 0x004e4942) bin = data
  off += 8 + len
}

// Keep only the accessors the animations use; repack their bytes into a new buffer.
const keep = new Map() // old accessor index -> new index
const accessors = []
const bufferViews = []
const chunks = []
let size = 0
const use = (i) => {
  if (keep.has(i)) return keep.get(i)
  const a = { ...json.accessors[i] }
  const bv = json.bufferViews[a.bufferView]
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const comp = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType]
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type]
  const bytes = a.count * comp * n
  const pad = (4 - (size % 4)) % 4
  if (pad) {
    chunks.push(Buffer.alloc(pad))
    size += pad
  }
  bufferViews.push({ buffer: 0, byteOffset: size, byteLength: bytes })
  chunks.push(bin.subarray(start, start + bytes))
  size += bytes
  delete a.byteOffset
  a.bufferView = bufferViews.length - 1
  accessors.push(a)
  keep.set(i, accessors.length - 1)
  return accessors.length - 1
}

const map = Object.fromEntries(renames.map((r) => r.split('=')))
const animations = json.animations.map((an) => ({
  ...an,
  name: map[an.name] ?? (json.animations.length === 1 && map['*']) ?? an.name,
  samplers: an.samplers.map((s) => ({ ...s, input: use(s.input), output: use(s.output) })),
}))

const out = {
  asset: json.asset,
  scene: json.scene ?? 0,
  scenes: json.scenes,
  nodes: json.nodes.map((n) => {
    const { mesh, skin, ...rest } = n
    return rest
  }),
  animations,
  accessors,
  bufferViews,
  buffers: [{ byteLength: size }],
}
const pad4 = (b, fill) => {
  const p = (4 - (b.length % 4)) % 4
  return p ? Buffer.concat([b, Buffer.alloc(p, fill)]) : b
}
const j = pad4(Buffer.from(JSON.stringify(out), 'utf8'), 0x20)
const b = pad4(Buffer.concat(chunks), 0)
const head = Buffer.alloc(12)
head.writeUInt32LE(0x46546c67, 0)
head.writeUInt32LE(2, 4)
head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8)
const jh = Buffer.alloc(8)
jh.writeUInt32LE(j.length, 0)
jh.writeUInt32LE(0x4e4f534a, 4)
const bh = Buffer.alloc(8)
bh.writeUInt32LE(b.length, 0)
bh.writeUInt32LE(0x004e4942, 4)
fs.writeFileSync(dst, Buffer.concat([head, jh, j, bh, b]))
console.log(`${dst}: ${(fs.statSync(dst).size / 1024).toFixed(0)} KB, clips: ${animations.map((a) => a.name).join(', ')}`)
