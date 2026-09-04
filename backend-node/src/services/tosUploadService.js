const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { TosClient, TosServerError } = require('@volcengine/tos-sdk');

const DEFAULT_BUCKET = 'seedance-manager';
const DEFAULT_REGION = 'cn-beijing';
const DEFAULT_ENDPOINT = 'tos-cn-beijing.volces.com';
const DEFAULT_PREFIX = 'references/local-mini-drama';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 2 * 60 * 60;

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = value == null ? '' : String(value).trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function parseEnvFile(filePath) {
  if (!filePath) return {};
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`TOS 凭证文件不存在：${resolved}`);
  }
  const result = {};
  const raw = fs.readFileSync(resolved, 'utf8');
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    result[key] = value;
  }
  return result;
}

function normalizeEndpoint(value) {
  return String(value || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function normalizePrefix(value) {
  const parts = String(value || '').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('TOS object_prefix 不能包含 . 或 .. 路径段');
  }
  return parts.join('/');
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function getTosUploadSettings(configOverride, runtimeEnv = process.env) {
  const config = configOverride || require('../config').loadConfig();
  const tos = config?.tos || {};
  const proxy = config?.image_proxy || {};
  const credentialsFile = firstNonEmpty(runtimeEnv.TOS_CREDENTIALS_FILE, tos.credentials_file);
  const fileEnv = credentialsFile ? parseEnvFile(credentialsFile) : {};
  const envValue = (...names) => {
    for (const name of names) {
      const value = firstNonEmpty(runtimeEnv[name], fileEnv[name]);
      if (value) return value;
    }
    return undefined;
  };

  const accessKeyId = envValue('TOS_ACCESS_KEY', 'TOS_ACCESS_KEY_ID', 'VOLCENGINE_ACCESS_KEY_ID');
  const accessKeySecret = envValue(
    'TOS_SECRET_KEY',
    'TOS_SECRET_ACCESS_KEY',
    'VOLCENGINE_ACCESS_KEY_SECRET',
    'VOLCENGINE_SECRET_ACCESS_KEY'
  );
  if (!accessKeyId || !accessKeySecret) {
    throw new Error(
      '尚未配置 TOS 凭证：请设置 TOS_ACCESS_KEY 和 TOS_SECRET_KEY，或配置 tos.credentials_file'
    );
  }

  const endpoint = normalizeEndpoint(firstNonEmpty(runtimeEnv.TOS_ENDPOINT, tos.endpoint, fileEnv.TOS_ENDPOINT, DEFAULT_ENDPOINT));
  const prefix = normalizePrefix(
    firstNonEmpty(runtimeEnv.TOS_REFERENCE_PREFIX, tos.object_prefix, fileEnv.TOS_REFERENCE_PREFIX, DEFAULT_PREFIX)
  );
  if (!endpoint) throw new Error('TOS endpoint 不能为空');
  if (!prefix) throw new Error('TOS object_prefix 不能为空');

  return {
    accessKeyId,
    accessKeySecret,
    stsToken: envValue('TOS_STS_TOKEN', 'VOLCENGINE_TOKEN', 'VOLCENGINE_SESSION_TOKEN'),
    bucket: firstNonEmpty(runtimeEnv.TOS_BUCKET, tos.bucket, fileEnv.TOS_BUCKET, DEFAULT_BUCKET),
    region: firstNonEmpty(runtimeEnv.TOS_REGION, tos.region, fileEnv.TOS_REGION, DEFAULT_REGION),
    endpoint,
    prefix,
    signedUrlTtlSeconds: clampNumber(
      firstNonEmpty(runtimeEnv.TOS_SIGNED_URL_TTL_SECONDS, tos.signed_url_ttl_seconds, fileEnv.TOS_SIGNED_URL_TTL_SECONDS),
      DEFAULT_SIGNED_URL_TTL_SECONDS,
      5 * 60,
      24 * 60 * 60
    ),
    requestTimeoutMs: clampNumber(tos.request_timeout_seconds ?? proxy.upload_timeout_seconds, 120, 5, 600) * 1000,
    maxRetryCount: clampNumber(tos.max_retry_count ?? proxy.upload_max_attempts, 2, 0, 5),
    credentialsFile: credentialsFile ? path.resolve(credentialsFile) : null,
  };
}

function createTosClient(settings) {
  return new TosClient({
    accessKeyId: settings.accessKeyId,
    accessKeySecret: settings.accessKeySecret,
    ...(settings.stsToken ? { stsToken: settings.stsToken } : {}),
    region: settings.region,
    endpoint: settings.endpoint,
    connectionTimeout: 15_000,
    requestTimeout: settings.requestTimeoutMs,
    maxRetryCount: settings.maxRetryCount,
  });
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const extension = extensions[normalized];
  if (!extension) throw new Error(`TOS 不支持上传该图片类型：${normalized || '(empty)'}`);
  return { mimeType: normalized, extension };
}

function errorStatus(error) {
  return Number(error?.statusCode || error?.response?.status || 0) || undefined;
}

function tosError(action, error) {
  if (error instanceof TosServerError || errorStatus(error)) {
    const status = errorStatus(error);
    const code = error?.code || error?.message || 'UnknownError';
    const requestId = error?.requestId ? `（Request ID: ${error.requestId}）` : '';
    return new Error(`TOS ${action}失败：${status ? `HTTP ${status} ` : ''}${code}${requestId}`);
  }
  return error instanceof Error ? error : new Error(`TOS ${action}失败`);
}

function responseHeader(response, name) {
  const headers = response?.headers || {};
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

async function uploadImageBufferToTos(imageBuffer, mimeType, options = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error('TOS 上传内容不能为空');
  }
  const settings = options.settings || getTosUploadSettings(options.config, options.env);
  const client = options.client || createTosClient(settings);
  const normalized = extensionForMimeType(mimeType);
  const sha256 = createHash('sha256').update(imageBuffer).digest('hex');
  const key = `${settings.prefix}/${sha256.slice(0, 2)}/${sha256}.${normalized.extension}`;

  let etag;
  try {
    const uploaded = await client.putObject({
      bucket: settings.bucket,
      key,
      body: imageBuffer,
      contentLength: imageBuffer.length,
      contentType: normalized.mimeType,
      forbidOverwrite: true,
      meta: { sha256 },
    });
    etag = responseHeader(uploaded, 'etag');
  } catch (error) {
    if (![409, 412].includes(errorStatus(error) || 0)) throw tosError('上传对象', error);
  }

  try {
    const verified = await client.headObject({ bucket: settings.bucket, key });
    const remoteBytes = Number(verified?.data?.['content-length']);
    if (remoteBytes !== imageBuffer.length) {
      throw new Error(`TOS 上传校验失败：远端 ${remoteBytes} 字节，本地 ${imageBuffer.length} 字节`);
    }
    etag = verified?.data?.etag || etag;
  } catch (error) {
    throw tosError('校验对象', error);
  }

  const url = client.getPreSignedUrl({
    bucket: settings.bucket,
    key,
    method: 'GET',
    expires: settings.signedUrlTtlSeconds,
  });
  return {
    provider: 'tos',
    bucket: settings.bucket,
    key,
    endpoint: settings.endpoint,
    region: settings.region,
    sha256,
    bytes: imageBuffer.length,
    contentType: normalized.mimeType,
    etag,
    url,
  };
}

async function verifyTosBucket(configOverride, runtimeEnv = process.env) {
  const settings = getTosUploadSettings(configOverride, runtimeEnv);
  const client = createTosClient(settings);
  try {
    const response = await client.headBucket(settings.bucket);
    return { bucket: settings.bucket, endpoint: settings.endpoint, requestId: response.requestId };
  } catch (error) {
    throw tosError('访问 Bucket', error);
  }
}

module.exports = {
  getTosUploadSettings,
  createTosClient,
  uploadImageBufferToTos,
  verifyTosBucket,
};
