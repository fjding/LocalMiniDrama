import test from 'node:test'
import assert from 'node:assert/strict'

import { VIDEO_CLIP_DURATION_OPTIONS } from '../src/constants/videoClipDurations.js'

test('one-click pipeline exposes 30 seconds per segment', () => {
  assert.deepEqual(VIDEO_CLIP_DURATION_OPTIONS, [4, 5, 8, 10, 12, 15, 30])
})
