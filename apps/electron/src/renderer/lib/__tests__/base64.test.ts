import { describe, expect, it } from 'bun:test'
import { bytesToBase64 } from '../base64'

describe('bytesToBase64', () => {
  it('encodes files larger than the JavaScript argument limit', () => {
    const bytes = new Uint8Array(1024 * 1024)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251

    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})
