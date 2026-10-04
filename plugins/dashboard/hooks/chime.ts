/*
 * MIT License
 *
 * Copyright (c) 2026 isr431
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// After desk-pet's hooks/chime.ts (MIT): a short chime synthesized as WAV bytes, so the plugin ships no audio file.

const RATE = 22050

function wav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))

  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true))

  return bytes
}

function toBase64(bytes: Uint8Array): string {
  let s = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(s)
}

/** Sine notes `gap` seconds apart, each with a soft overtone, fading over `ring` seconds. */
function render(notes: readonly number[], gap: number, ring: number): string {
  const length = Math.ceil((gap * (notes.length - 1) + ring) * RATE)
  const out = new Float32Array(length)

  notes.forEach((hz, n) => {
    const start = Math.floor(n * gap * RATE)

    for (let i = 0; start + i < length && i < ring * RATE; i += 1) {
      const t = i / RATE
      const env = Math.min(1, t / 0.008) * Math.exp(-t * 6)

      out[start + i]! += 0.16 * env * (Math.sin(2 * Math.PI * hz * t) + 0.25 * Math.sin(4 * Math.PI * hz * t))
    }
  })

  return toBase64(wav(out))
}

let attention: string | undefined

/** Two rising notes, base64 WAV: another session waits on you. */
export function attentionChime(): string {
  attention ??= render([880, 1174.66], 0.14, 0.7)

  return attention
}
