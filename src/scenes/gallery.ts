// Dev-only model gallery: open the app with ?gallery to inspect every Meshy prop.
import * as THREE from 'three'
import { createGLTFLoader, setMaxAnisotropy, sharpenTextures } from '../assets/loader'
import { PROPS } from '../assets/manifest'

export async function runGallery(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy())
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#f3e7d6')
  scene.add(new THREE.HemisphereLight('#ffffff', '#c9b39a', 1.4))
  const sun = new THREE.DirectionalLight('#ffffff', 2)
  sun.position.set(-4, 9, 5)
  scene.add(sun)

  const names = Object.keys(PROPS)
  const cols = 6
  const cell = 2
  const loader = createGLTFLoader()
  const sizes: Record<string, number[]> = {}
  const params = new URLSearchParams(location.search)
  const only = params.get('only')

  await Promise.all(
    names.map(async (name, i) => {
      if (only && !name.includes(only)) return
      const gltf = await loader.loadAsync(PROPS[name].url)
      const obj = gltf.scene
      sharpenTextures(obj)
      const box = new THREE.Box3().setFromObject(obj)
      const size = box.getSize(new THREE.Vector3())
      sizes[name] = size.toArray().map((n) => +n.toFixed(3))
      const s = 1.5 / Math.max(size.x, size.y, size.z)
      const c = box.getCenter(new THREE.Vector3())
      obj.scale.setScalar(s)
      obj.position.set(-c.x * s, -box.min.y * s, -c.z * s)
      const g = new THREE.Group()
      g.add(obj)
      // +Z marker (red) so the model's front can be read off the screenshot.
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.02, 0), 1, 0xff3333)
      g.add(arrow)
      const idx = only ? 0 : i
      g.position.set((idx % cols) * cell, 0, Math.floor(idx / cols) * cell * 1.2)
      scene.add(g)
    }),
  )

  const rows = only ? 1 : Math.ceil(names.length / cols)
  const cx = only ? 0 : ((cols - 1) * cell) / 2
  const cz = ((rows - 1) * cell * 1.2) / 2
  const view = only ? 3 : 8.5
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
  const yaw = Number(params.get('yaw') ?? 35) * (Math.PI / 180)
  cam.position.set(cx + Math.sin(yaw) * 14, 9, cz + Math.cos(yaw) * 14)
  cam.lookAt(cx, 0.5, cz)

  const resize = () => {
    const w = window.innerWidth
    const h = window.innerHeight
    const a = w / h
    cam.left = (-view * a) / 2
    cam.right = (view * a) / 2
    cam.top = view / 2
    cam.bottom = -view / 2
    cam.updateProjectionMatrix()
    renderer.setSize(w, h, false)
    renderer.render(scene, cam)
  }
  window.addEventListener('resize', resize)
  resize()
  ;(window as unknown as { __sizes: unknown }).__sizes = sizes
}
