const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getSeedreamCapabilities } = require('../src/services/imageClient');
const {
  applyVolcengineVideoModelOptions,
  normalizeVolcengineDuration,
} = require('../src/services/videoClient');

describe('Seedream 5.0 capabilities', () => {
  it('recognizes the current full and lite model IDs', () => {
    assert.deepEqual(getSeedreamCapabilities('doubao-seedream-5-0-pro-260628'), {
      isSeedream5: true,
      supportsSequentialControl: false,
    });
    assert.deepEqual(getSeedreamCapabilities('doubao-seedream-5-0-260128'), {
      isSeedream5: true,
      supportsSequentialControl: false,
    });
    assert.deepEqual(getSeedreamCapabilities('doubao-seedream-5-0-lite-260128'), {
      isSeedream5: true,
      supportsSequentialControl: true,
    });
  });
});

describe('Seedance 2.0 request options', () => {
  it('enables synchronized audio from settings and omits unsupported camera_fixed', () => {
    const body = { camera_fixed: false, duration: 8 };
    applyVolcengineVideoModelOptions(
      { settings: JSON.stringify({ generate_audio: true }) },
      body,
      'doubao-seedance-2-0-260128'
    );
    assert.equal(body.generate_audio, true);
    assert.equal('camera_fixed' in body, false);
  });

  it('applies the same 2.x compatibility rules to Seedance 2.5', () => {
    const body = { camera_fixed: true, duration: 12 };
    applyVolcengineVideoModelOptions(
      { settings: { generate_audio: true } },
      body,
      'doubao-seedance-2-5-260628'
    );
    assert.equal(body.generate_audio, true);
    assert.equal('camera_fixed' in body, false);
  });

  it('keeps Seedance 2.0 duration inside the 4-15 second range', () => {
    assert.equal(normalizeVolcengineDuration('doubao-seedance-2-0-fast-260128', 2), 4);
    assert.equal(normalizeVolcengineDuration('doubao-seedance-2-0-260128', 20), 15);
  });

  it('supports 30-second clips with Seedance 2.5 without changing older 2.0 limits', () => {
    assert.equal(normalizeVolcengineDuration('doubao-seedance-2-5-260628', 30), 30);
    assert.equal(normalizeVolcengineDuration('doubao-seedance-2-5-260628', 60), 30);
    assert.equal(normalizeVolcengineDuration('doubao-seedance-2-0-260528', 30), 15);
  });
});
