const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const {
  getTosUploadSettings,
  uploadImageBufferToTos,
} = require('../src/services/tosUploadService');
const { getImageProxyUploadSettings } = require('../src/services/uploadService');

test('TOS settings can reuse a protected env file without putting credentials in YAML', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-tos-'));
  const credentialsFile = path.join(tempDir, '.env.local');
  fs.writeFileSync(
    credentialsFile,
    [
      'TOS_ACCESS_KEY=file-ak',
      'TOS_SECRET_KEY="file-sk"',
      'TOS_BUCKET=file-bucket',
      'TOS_REGION=cn-beijing',
      'TOS_ENDPOINT=https://tos-cn-beijing.volces.com/',
      'TOS_REFERENCE_PREFIX=references',
    ].join('\n'),
    { mode: 0o600 }
  );

  try {
    const settings = getTosUploadSettings(
      {
        image_proxy: { upload_timeout_seconds: 180, upload_max_attempts: 2 },
        tos: { credentials_file: credentialsFile, signed_url_ttl_seconds: 7200 },
      },
      {}
    );
    assert.equal(settings.accessKeyId, 'file-ak');
    assert.equal(settings.accessKeySecret, 'file-sk');
    assert.equal(settings.bucket, 'file-bucket');
    assert.equal(settings.endpoint, 'tos-cn-beijing.volces.com');
    assert.equal(settings.prefix, 'references');
    assert.equal(settings.signedUrlTtlSeconds, 7200);
    assert.equal(settings.requestTimeoutMs, 180000);
    assert.equal(settings.credentialsFile, credentialsFile);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('process environment overrides the credentials file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-tos-'));
  const credentialsFile = path.join(tempDir, '.env.local');
  fs.writeFileSync(credentialsFile, 'TOS_ACCESS_KEY=file-ak\nTOS_SECRET_KEY=file-sk\n', { mode: 0o600 });
  try {
    const settings = getTosUploadSettings(
      { tos: { credentials_file: credentialsFile } },
      { TOS_ACCESS_KEY: 'runtime-ak', TOS_SECRET_KEY: 'runtime-sk' }
    );
    assert.equal(settings.accessKeyId, 'runtime-ak');
    assert.equal(settings.accessKeySecret, 'runtime-sk');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('TOS image upload uses a content-addressed key, verifies bytes, and returns a signed URL', async () => {
  const body = Buffer.from('test-image-bytes');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const calls = [];
  const fakeClient = {
    async putObject(input) {
      calls.push(['put', input]);
      return { headers: { ETag: 'put-etag' } };
    },
    async headObject(input) {
      calls.push(['head', input]);
      return { data: { 'content-length': String(body.length), etag: 'head-etag' } };
    },
    getPreSignedUrl(input) {
      calls.push(['sign', input]);
      return `https://seedance-manager.tos-cn-beijing.volces.com/${input.key}?signed=1`;
    },
  };
  const settings = {
    accessKeyId: 'test-ak',
    accessKeySecret: 'test-sk',
    bucket: 'seedance-manager',
    region: 'cn-beijing',
    endpoint: 'tos-cn-beijing.volces.com',
    prefix: 'references/local-mini-drama',
    signedUrlTtlSeconds: 7200,
    requestTimeoutMs: 120000,
    maxRetryCount: 2,
  };

  const result = await uploadImageBufferToTos(body, 'image/png', { settings, client: fakeClient });
  const expectedKey = `references/local-mini-drama/${sha256.slice(0, 2)}/${sha256}.png`;
  assert.equal(result.key, expectedKey);
  assert.equal(result.url, `https://seedance-manager.tos-cn-beijing.volces.com/${expectedKey}?signed=1`);
  assert.equal(result.etag, 'head-etag');
  assert.equal(calls[0][1].body, body);
  assert.equal(calls[0][1].forbidOverwrite, true);
  assert.deepEqual(calls[1][1], { bucket: 'seedance-manager', key: expectedKey });
  assert.equal(calls[2][1].expires, 7200);
});

test('an existing content-addressed TOS object is reused after overwrite conflict', async () => {
  const body = Buffer.from('same-image');
  let verified = false;
  const fakeClient = {
    async putObject() {
      throw { statusCode: 409, code: 'KeyAlreadyExists' };
    },
    async headObject() {
      verified = true;
      return { data: { 'content-length': String(body.length), etag: 'existing' } };
    },
    getPreSignedUrl() {
      return 'https://example.invalid/signed';
    },
  };
  const settings = {
    bucket: 'seedance-manager',
    region: 'cn-beijing',
    endpoint: 'tos-cn-beijing.volces.com',
    prefix: 'references',
    signedUrlTtlSeconds: 7200,
  };

  const result = await uploadImageBufferToTos(body, 'image/jpeg', { settings, client: fakeClient });
  assert.equal(verified, true);
  assert.equal(result.etag, 'existing');
});

test('image upload has no implicit third-party HTTP fallback', () => {
  assert.deepEqual(getImageProxyUploadSettings({ image_proxy: {} }), {
    provider: 'disabled',
    uploadUrl: '',
    timeoutMs: 45000,
    maxAttempts: 2,
  });
  assert.equal(getImageProxyUploadSettings({ image_proxy: { provider: 'tos' } }).provider, 'tos');
  assert.equal(
    getImageProxyUploadSettings({ image_proxy: { upload_url: 'https://explicit.example/upload' } }).provider,
    'http'
  );
});
