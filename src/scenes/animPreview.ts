// Dev-only: open the app with ?anim=<glb name> to see every clip in that file side by side.
// window.__animT(f) poses all clips at fraction f (0..1) of their length and re-renders.
import * as THREE from 'three'
import { createGLTFLoader, setMaxAnisotropy, sharpenTextures } from '../assets/loader'
import { clone } from 'three/addons/utils/SkeletonUtils.js'

export async function runAnimPreview(canvas: HTMLCanvasElement, file: string) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy())
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#f3e7d6')
  scene.add(new THREE.HemisphereLight('#ffffff', '#c9b39a', 1.5))
  const sun = new THREE.DirectionalLight('#ffffff', 1.8)
  sun.position.set(3, 6, 5)
  scene.add(sun)
  const floor = new THREE.GridHelper(30, 30, '#c9b8a2', '#ddd0bd')
  scene.add(floor)

  const gltf = await createGLTFLoader().loadAsync(`/assets/models/${file}.glb`)
  sharpenTextures(gltf.scene)
  const box = new THREE.Box3().setFromObject(gltf.scene)
  const h = box.max.y - box.min.y
  const spacing = h * 1.15
  const clips = gltf.animations
  const mixers = clips.map((clip, i) => {
    const copy = clone(gltf.scene)
    copy.traverse((o) => ((o as THREE.Mesh).frustumCulled = false))
    copy.position.x = (i - (clips.length - 1) / 2) * spacing
    scene.add(copy)
    const mixer = new THREE.AnimationMixer(copy)
    mixer.clipAction(clip).play()
    return { mixer, clip }
  })

  const yaw = Number(new URLSearchParams(location.search).get('yaw') ?? 30) * (Math.PI / 180)
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  cam.position.set(Math.sin(yaw) * 10 * h, 2.2 * h, Math.cos(yaw) * 10 * h)
  cam.lookAt(0, h * 0.5, 0)
  const view = h * 1.7
  const render = () => {
    const w = window.innerWidth
    const hh = window.innerHeight
    const needW = spacing * clips.length + h
    const v = Math.max(view, needW / (w / hh))
    cam.left = (-v * (w / hh)) / 2
    cam.right = (v * (w / hh)) / 2
    cam.top = v / 2
    cam.bottom = -v / 2
    cam.updateProjectionMatrix()
    renderer.setSize(w, hh, false)
    renderer.render(scene, cam)
  }
  const setT = (f: number) => {
    for (const m of mixers) m.mixer.setTime(m.clip.duration * f)
    render()
  }
  setT(0)
  window.addEventListener('resize', render)
  Object.assign(window, {
    __animT: setT,
    __clips: clips.map((c) => ({ name: c.name, duration: +c.duration.toFixed(2), tracks: c.tracks.length })),
  })
}
