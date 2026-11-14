import fs from 'node:fs'
import { blit, decodePNG, drawText, encodePNG, newImage } from './render_lib.mjs'
const [a, b, out] = process.argv.slice(2)
const A = decodePNG(fs.readFileSync(a)), B = decodePNG(fs.readFileSync(b))
const crop = (t, x0, y0, w, h) => { const c = newImage(w, h, [0, 0, 0]); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) c.data[(y * w + x) * 4 + k] = t.data[((y0 + y) * t.w + x0 + x) * 4 + k]; return c }
const regions = [[1050, 520, 512, 512], [330, 440, 512, 512]]
const img = newImage(1024 + 10, 2 * 512 + 3 * 30, [30, 30, 30])
regions.forEach(([x, y, w, h], r) => {
  const oy = 30 + r * (512 + 30)
  drawText(img, `BEFORE  X${x} Y${y} 100%`, 4, oy - 24, 2, [255, 255, 255])
  drawText(img, `AFTER`, 522, oy - 24, 2, [255, 255, 255])
  blit(img, crop(A, x, y, w, h), 0, oy)
  blit(img, crop(B, x, y, w, h), 522, oy)
})
fs.writeFileSync(out, encodePNG(img.w, img.h, img.data))
