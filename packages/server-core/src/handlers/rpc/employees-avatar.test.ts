import { describe, expect, it } from 'bun:test'
import type { ImageProcessor } from '../../runtime/platform'
import { normalizeEmployeeAvatar } from './employees'

function pngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
}

describe('employee avatar normalization', () => {
  it('uses the injected platform image processor instead of a packaged native dependency', async () => {
    const output = Buffer.from('normalized-png')
    const calls: unknown[] = []
    const processor: ImageProcessor = {
      async getMetadata(input) {
        calls.push(['metadata', input])
        return { width: 450, height: 450 }
      },
      async process(input, options) {
        calls.push(['process', input, options])
        return output
      },
    }

    await expect(normalizeEmployeeAvatar(pngBuffer(), processor)).resolves.toBe(output)
    expect(calls[1]).toEqual([
      'process',
      pngBuffer(),
      { resize: { width: 256, height: 256 }, fit: 'cover', format: 'png' },
    ])
  })

  it('rejects unsupported signatures and oversized pixel dimensions', async () => {
    const processor: ImageProcessor = {
      async getMetadata() { return { width: 10_000, height: 10_000 } },
      async process() { throw new Error('should not process') },
    }

    await expect(normalizeEmployeeAvatar(Buffer.from('not an image'), processor))
      .rejects.toThrow('Unsupported employee avatar format')
    await expect(normalizeEmployeeAvatar(pngBuffer(), processor))
      .rejects.toThrow('Invalid employee avatar dimensions')
  })
})
