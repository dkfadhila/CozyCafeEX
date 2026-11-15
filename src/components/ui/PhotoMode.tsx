import { useCallback, useEffect, useState } from 'react'
import type { CafeScene } from '../../scenes/CafeScene'
import './photo.css'

interface Props {
  scene: CafeScene
  onExit: () => void
}

const stamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Photo mode panel: chef pose picker, freeze, hide UI, take photo. Key handling lives here so H works while hidden. */
export function PhotoMode({ scene, onExit }: Props) {
  const poses = scene.photoPoses
  const [pose, setPose] = useState(() => scene.photoPose)
  const [frozen, setFrozen] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [note, setNote] = useState('')

  const pick = useCallback(
    (i: number) => {
      const p = scene.photoPoses[i]
      if (!p) return
      scene.setPhotoPose(p.clip)
      setPose(p.clip)
      setFrozen(false)
    },
    [scene],
  )

  const toggleFreeze = useCallback(() => {
    setFrozen((f) => !f)
  }, [])

  useEffect(() => {
    scene.setPhotoFrozen(frozen)
  }, [scene, frozen])

  const shoot = useCallback(async () => {
    const blob = await scene.capturePhoto()
    if (!blob) {
      setNote('Could not capture the photo')
      return
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cozy-cafe-${stamp()}.png`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    setNote('Photo saved')
  }, [scene])

  useEffect(() => {
    if (!note) return
    const t = window.setTimeout(() => setNote(''), 1800)
    return () => window.clearTimeout(t)
  }, [note])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const digit = /^(Digit|Numpad)([1-9])$/.exec(e.code)
      if (digit) pick(Number(digit[2]) - 1)
      else if (e.code === 'KeyH') setHidden((h) => !h)
      else if (e.code === 'KeyP') void shoot()
      else if (e.code === 'KeyG') scene.focusChef()
      else if (e.code === 'KeyT') toggleFreeze()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pick, shoot, toggleFreeze, scene])

  if (hidden) return null
  return (
    <div className="photo-panel" role="region" aria-label="Photo mode">
      <h2>Photo Mode</h2>
      <div className="photo-poses">
        {poses.map((p, i) => (
          <button key={p.clip} className={pose === p.clip ? 'on' : ''} onClick={() => pick(i)}>
            <kbd>{i + 1}</kbd> {p.label}
          </button>
        ))}
      </div>
      <div className="photo-actions">
        <button className={frozen ? 'on' : ''} onClick={toggleFreeze}>
          <kbd>T</kbd> Freeze pose
        </button>
        <button onClick={() => scene.focusChef()}>
          <kbd>G</kbd> Focus chef
        </button>
        <button onClick={() => setHidden(true)}>
          <kbd>H</kbd> Hide UI
        </button>
        <button className="shoot" onClick={() => void shoot()}>
          <kbd>P</kbd> Take photo
        </button>
        <button onClick={onExit}>
          <kbd>Esc</kbd> Exit
        </button>
      </div>
      <p className="photo-hint">WASD move · Q/E down/up · drag orbit · Shift+drag pan · wheel zoom · H hides this panel</p>
      {note && <p className="photo-note">{note}</p>}
    </div>
  )
}
